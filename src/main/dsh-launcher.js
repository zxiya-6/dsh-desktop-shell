/**
 * dsh child-process lifecycle.
 *
 * dsh runs as a *separate process* rather than being required into the Electron
 * main process. An agent runtime loads Cordis plugins, drives LLM loops and
 * touches the filesystem; an uncaught throw inside it should cost you one failed
 * request, not the whole application.
 *
 * It runs on Electron's bundled Node via ELECTRON_RUN_AS_NODE, which is why
 * Electron >= 44 matters: dsh's bin.js ends with `if (import.meta.main)`, and
 * that property only exists from Node 24. On older Node the process exits
 * silently with code 0 and no output at all — hence the explicit timeout and
 * the version check below, instead of letting the UI spin forever.
 */
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const http = require('node:http')
const net = require('node:net')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const { paths } = require('./paths')
const { buildDshEnv } = require('./env')
const { KernelError } = require('./plugins/backup-roll/kernel-registry')

const isWindows = process.platform === 'win32'

/** Ask the OS for a free port instead of hardcoding 3080. */
function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

/**
 * Confirm the server really answers before handing the URL to a window.
 *
 * dsh prints its URL before the HTTP listener is guaranteed to accept
 * connections, and — before the HMR flag was fixed — could print the URL and
 * then crash while loading plugins. Loading on the printed URL alone produced
 * ERR_CONNECTION_REFUSED. Any HTTP response (including the 401/303 we expect
 * without a session cookie) proves the listener is up.
 */
function probe(url) {
  return new Promise((resolve) => {
    let req
    try {
      req = http.get(url, { timeout: 2000 }, (res) => {
        res.resume()
        resolve(true)
      })
    } catch {
      resolve(false)
      return
    }
    req.on('error', () => resolve(false))
    req.on('timeout', () => {
      req.destroy()
      resolve(false)
    })
  })
}

/**
 * 异步、带超时的进程树终止（Windows）。
 *
 * 旧实现用 `execSync('taskkill …')` 同步阻塞事件循环：一旦某个子进程不肯退出，
 * 主线程（含 IPC、定时器、渲染进程通信）会被永久卡死——这正是「切换内核时
 * 界面卡死然后崩溃」的直接原因。这里改成 spawn 异步执行并设硬超时，绝不阻塞
 * 事件循环；即便 taskkill 一直没回，也只是让返回的 Promise 在超时后落定，
 * 不会拖住任何其它工作。
 */
function killTreeAsync(child, timeoutMs = 8000) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null) return resolve(true)
    const pid = child.pid
    if (!pid) return resolve(false)
    let done = false
    const finish = (ok) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(ok)
    }
    let timer
    if (isWindows) {
      const p = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      p.on('exit', () => finish(true))
      p.on('error', () => finish(false))
      timer = setTimeout(() => {
        try {
          p.kill('SIGKILL')
        } catch {
          /* ignore */
        }
        finish(false)
      }, timeoutMs)
    } else {
      // POSIX（Linux / macOS）：dsh 会派生插件子进程，必须杀整棵树。
      // 启动子进程时设了 detached:true，使其成为独立进程组（pgid === pid），
      // 所以向 -pid 发信号即可连插件孙进程一起带走；直接 child.kill 只会杀
      // 第一个进程，其余进程会变成僵尸残留、继续占着端口和文件锁。
      const pgid = pid
      const signalGroup = (sig) => {
        try {
          process.kill(-pgid, sig)
        } catch {
          /* 进程组已不存在（或已退出） */
        }
      }
      signalGroup('SIGTERM')
      child.on('exit', () => finish(true))
      timer = setTimeout(() => {
        signalGroup('SIGKILL')
        finish(false)
      }, timeoutMs)
    }
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitUntilServing(url, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await probe(url)) return true
    await sleep(300)
  }
  return false
}

/** dsh prints: `dsh web: http://127.0.0.1:3080/?token=...` */
const URL_PATTERN = /(https?:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_.-]+)/

class DshLauncher extends EventEmitter {
  // 串行化会改变内核进程生命周期的操作（切换 / 重启）。见 #exclusive。
  #opRunning = false

  /**
   * @param {object} [opts]
   * @param {import('./plugins/backup-roll/kernel-registry').KernelRegistry} [opts.registry]
   *        Resolves which kernel version to run. Injected so the launcher
   *        stays testable and so it never reaches into config itself.
   */
  constructor({ registry } = {}) {
    super()
    this.child = null
    this.url = null
    this.port = null
    this.logStream = null
    this.starting = null
    this.registry = registry || null
    this.kernel = null
  }

  #openLog() {
    // Close the previous stream first. On Windows an open write handle keeps
    // the file locked, so repeatedly restarting dsh would leak handles until
    // the process runs out of them (EMFILE) and the log stops rotating.
    this.#closeLog()
    fs.mkdirSync(paths.logs(), { recursive: true })
    // Truncate each run: a growing log inside %APPDATA% is a slow leak.
    this.logStream = fs.createWriteStream(paths.logFile(), { flags: 'w' })
  }

  #closeLog() {
    if (!this.logStream) return
    const stream = this.logStream
    this.logStream = null
    try {
      stream.end()
    } catch {
      /* already closed */
    }
  }

  #writeLog(chunk) {
    const text = chunk.toString()
    if (this.logStream) this.logStream.write(text)
    this.emit('log', text)
  }

  /**
   * Ensure the bundled Node satisfies dsh.
   *
   * dsh needs Node >= 24 for import.meta.main. Failing early with a readable
   * message beats debugging a child process that exits 0 and says nothing.
   */
  #checkNodeVersion() {
    const [major] = process.versions.node.split('.').map(Number)
    if (major < 24) {
      throw new Error(
        `Bundled Node is ${process.versions.node}, but dsh requires Node >= 24 ` +
          `(its launcher relies on import.meta.main). Use Electron >= 44, which ships Node 24.18.x.`
      )
    }
  }

  /**
   * @param {object} [kernelOverride] boot this snapshot instead of resolving
   *        one from the registry. Used by switchTo(): the new kernel has to be
   *        proven working *before* config is pointed at it.
   */
  async start(kernelOverride = null) {
    if (this.child) return this.url
    if (this.starting) return this.starting

    this.starting = this.#startInternal(kernelOverride)
    try {
      return await this.starting
    } catch (err) {
      // A half-started child must not survive. `start()` bails out on
      // `this.child`, so leaving one behind would make the launcher
      // permanently unstartable and have the UI load `null` as a URL.
      await this.stop()
      throw err
    } finally {
      this.starting = null
    }
  }

  /**
   * Resolve the kernel to launch.
   *
   * This replaces the old hard-coded app-bundled path. dsh is no longer
   * shipped inside the installer; it lives in userData/core/snapshots/<ver>
   * so it can be updated and rolled back independently of the app. Everything
   * downstream (args, token parsing, readiness probe, process-tree kill) is
   * untouched — only the entry file changed.
   */
  #resolveKernel(override = null) {
    const kernel = override || (this.registry ? this.registry.resolve() : null)
    if (!kernel) {
      throw new Error('未提供内核注册表（KernelRegistry），无法定位 dsh 内核。')
    }

    // The registry already refuses incompatible snapshots; this is the second
    // gate, and it is the one that produces the user-visible dialog.
    if (!kernel.compatible) {
      throw new KernelError(
        'KERNEL_INCOMPATIBLE',
        `内核 ${kernel.version} 无法在此运行：${kernel.reason}`,
        { info: kernel }
      )
    }
    if (!fs.existsSync(kernel.entry)) {
      throw new KernelError('KERNEL_BROKEN', `内核入口不存在：${kernel.entry}`, { info: kernel })
    }

    this.kernel = kernel
    return kernel
  }

  async #startInternal(kernelOverride = null) {
    this.#checkNodeVersion()

    const kernel = this.#resolveKernel(kernelOverride)
    const dshBin = kernel.entry

    const port = await findFreePort()
    this.port = port
    this.#openLog()

    // --expose-internals is mandatory: dsh's HMR plugin refuses to load
    // without it and takes the whole web profile down with a loader error.
    // It must come BEFORE the script path. Note we deliberately do not pass
    // Electron flags like --no-sandbox here: under ELECTRON_RUN_AS_NODE the
    // binary parses arguments as plain Node and rejects them.
    const args = ['--expose-internals', dshBin, 'web', '--port', String(port), '--no-open']

    this.child = spawn(process.execPath, args, {
      cwd: paths.workspace(),
      env: buildDshEnv(kernel.entry),
      stdio: ['ignore', 'pipe', 'pipe'],
      // Windows 走 taskkill /T 杀整棵树，不需要 detached；POSIX 下设 detached
      // 让子进程成为独立进程组（pgid === pid），stop 时才能用进程组信号把
      // dsh 及其插件孙进程一并带走。不调用 unref：仍要监听它的退出与日志。
      detached: !isWindows,
      windowsHide: true
    })

    this.child.stdout.on('data', (d) => this.#writeLog(d))
    this.child.stderr.on('data', (d) => this.#writeLog(d))

    const url = await new Promise((resolve, reject) => {
      let buffer = ''
      let settled = false

      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        reject(
          new Error(
            `dsh did not report a ready URL within 60s on port ${port}. ` +
              `Check ${paths.logFile()} — a silent early exit usually means the Node version is too old.`
          )
        )
      }, 60000)

      const onData = (chunk) => {
        buffer += chunk.toString()
        const match = buffer.match(URL_PATTERN)
        if (match && !settled) {
          settled = true
          clearTimeout(timer)
          resolve(match[1])
        }
      }

      this.child.stdout.on('data', onData)
      this.child.stderr.on('data', onData)

      this.child.once('exit', (code, signal) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(
          new Error(
            `dsh exited before becoming ready (code=${code}, signal=${signal}). ` +
              `Log: ${paths.logFile()}`
          )
        )
      })

      this.child.once('error', (err) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(err)
      })
    })

    const serving = await waitUntilServing(url)
    if (!serving) {
      throw new Error(
        `dsh reported ${url} but never accepted connections on port ${port}. ` +
          `Log: ${paths.logFile()}`
      )
    }

    // A later death (plugin load error, OOM) must not leave the UI pointing
    // silently at a dead port — tell the shell so it can show the error page.
    const childRef = this.child
    childRef.once('exit', (code, signal) => {
      if (this.child === childRef && this.url === url) {
        this.url = null
        this.emit('crashed', { code, signal })
      }
    })

    this.url = url
    this.emit('ready', url)
    return url
  }

  /** Stop dsh. On Windows the whole tree must go, or plugin children linger. */
  async stop() {
    const child = this.child
    this.child = null
    this.url = null
    if (!child) {
      this.#closeLog()
      return
    }
    this.#closeLog()

    // 先异步杀整棵树（带超时，绝不阻塞事件循环）。Windows 用 taskkill /T，
    // POSIX 用进程组信号（detached 子进程）——两者都在 killTreeAsync 内部按
    // 平台分支。旧实现用同步 execSync，一旦某个子进程不肯退出，主线程会被
    // 永久卡死，就是「切换内核时界面卡死然后崩溃」的直接原因。杀成功就返回；
    // 极少数情况下（信号没生效）再走一次兜底的单进程 SIGTERM→SIGKILL。
    if (child.pid) {
      const killed = await killTreeAsync(child)
      if (killed) return
    }

    try {
      child.kill('SIGTERM')
    } catch {
      /* already gone */
    }

    // 兜底：5s 内不退出就 SIGKILL。整段只 await 一个短窗口，不会卡住 UI。
    await new Promise((resolve) => {
      const t = setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {
          /* already gone */
        }
        resolve()
      }, 5000)
      child.once('exit', () => {
        clearTimeout(t)
        resolve()
      })
    })
  }

  /**
   * 串行化会改变内核进程生命周期的操作（切换 / 重启）。
   *
   * 之前 switchTo 没有重入保护：UI 连点「切换」、或「切换」与「重启」并发时，
   * 两次 stop/start 互相竞争，会杀掉刚拉起的新进程、把配置写乱，表现就是
   * 「卡死后崩掉」。改为：已有操作在进行就明确拒绝（KERNEL_BUSY），而不是
   * 排队死等约 90s 或直接崩。拒绝是干净的 IPC 错误，UI 可以友好提示。
   */
  async #exclusive(label, fn) {
    if (this.#opRunning) {
      throw new KernelError('KERNEL_BUSY', `内核操作进行中（${label}），请稍候再试`, { busy: label })
    }
    this.#opRunning = true
    try {
      return await fn()
    } finally {
      this.#opRunning = false
    }
  }

  /** Restart — used after plugin installs that require a fresh tree. */
  async restart() {
    return this.#exclusive('restart', async () => {
      this.emit('switch-progress', { phase: 'switch-stop', percent: 20, label: '正在重启内核…' })
      await this.stop()
      return this.start()
    })
  }

  /** Kernel currently in use, or null before the first successful start. */
  currentKernel() {
    return this.kernel
  }

  /**
   * Switch to a snapshot already on disk.
   *
   * Ordering is the whole point of this method:
   *   stop → boot the *new* snapshot → only then write config → done.
   *
   * Writing config first (the obvious way) means a snapshot that fails to boot
   * leaves config pointing at it, so the app cannot start at all next time and
   * the user has no running kernel in the meantime. Committing after a
   * successful boot makes a failed switch a no-op.
   *
   * The running child must die first regardless: its files stay locked on
   * Windows, and anything that later tries to delete or replace that snapshot
   * would fail with EBUSY.
   */
  async switchTo(version) {
    if (!this.registry) throw new Error('未提供内核注册表（KernelRegistry）。')

    return this.#exclusive('switch', async () => {
      const info = this.registry.inspect(version)
      if (info.status !== 'ready') {
        throw new KernelError('KERNEL_INVALID', `内核 ${version} 不可选用：${info.reason}`, { info })
      }

      const previous = this.registry.currentVersion
      this.emit('switch-progress', { phase: 'switch-stop', percent: 15, label: '正在停止当前内核…' })
      await this.stop()

      try {
        this.emit('switch-progress', { phase: 'switch-boot', percent: 45, label: `正在启动内核 ${version}…` })
        const url = await this.start(info)
        this.registry.setCurrent(version)
        this.emit('switch-progress', { phase: 'switch-done', percent: 100, label: `已切换到 ${version}` })
        return { kernel: info, url }
      } catch (err) {
        this.emit('switch-progress', {
          phase: 'switch-rollback',
          percent: 70,
          label: '切换失败，正在回退到原内核…'
        })
        if (previous && previous !== version) {
          // 先把指针指回去——这是下次还能正常启动的关键；重启旧内核只是锦上添花。
          try {
            this.registry.setCurrent(previous)
          } catch {
            /* 旧快照可能已被删；指针回退是尽力而为 */
          }
          try {
            await this.start(this.registry.inspect(previous))
          } catch {
            /* 保持停止；UI 已经显示切换失败 */
          }
        }
        this.emit('switch-progress', {
          phase: 'switch-failed',
          percent: 100,
          label: `切换失败：${err.message}`
        })
        throw err
      }
    })
  }
}

module.exports = {
  DshLauncher,
  findFreePort,
  probe,
  waitUntilServing,
  URL_PATTERN,
  // Exported so the kernel installer can reuse the exact same readiness logic
  // for its smoke test instead of growing a second, subtly different copy.
  KERNEL_ARGS: (entry, port) => ['--expose-internals', entry, 'web', '--port', String(port), '--no-open']
}
