/**
 * Kernel package manager — downloads, validates and promotes dsh versions.
 *
 * The whole point of this module is the invariant at the end of install():
 * **the running kernel is only replaced after a new one has actually been
 * started and answered HTTP.** A failed or interrupted update leaves the
 * current snapshot untouched and deletes the scratch directory.
 *
 * Pipeline:
 *   resolve → stage → install deps → verify → smoke test → promote → prune
 *
 * Notes that shaped this:
 *  - dsh is a thin launcher over ~522 transitive dependencies, so "download a
 *    tarball and unzip it" is not enough; the dependency tree has to be
 *    installed. We use the bundled pnpm with node-linker=hoisted: flat
 *    node_modules keeps paths short, which matters against Windows MAX_PATH.
 *  - The tree contains native modules (node-pty, koffi, sharp) with install
 *    scripts that fetch binaries from GitHub by default. .npmrc points them at
 *    the mirror so installs do not fall back to node-gyp and a toolchain the
 *    user does not have.
 *  - Integrity is enforced by pnpm itself (it verifies every package against
 *    the registry metadata); we record the expected integrity alongside the
 *    snapshot so a tampered install is visible after the fact.
 *  - Nothing here writes into an existing snapshot. Old versions stay intact
 *    until an explicit prune, which is what makes rollback possible.
 */
const fs = require('node:fs')
const path = require('node:path')
  const { spawn } = require('node:child_process')

const isWindows = process.platform === 'win32'

const { paths } = require('../../paths')
const { RegistryClient, PACKAGE_NAME } = require('./registry-client')
const { findFreePort, waitUntilServing, URL_PATTERN, KERNEL_ARGS } = require('../../dsh-launcher')
const { assertSnapshotVersion } = require('./validate')

class KernelUpdateError extends Error {
  constructor(code, message, detail = {}) {
    super(message)
    this.name = 'KernelUpdateError'
    this.code = code
    this.detail = detail
  }
}

const PHASES = {
  resolve: { percent: 5, label: '查询可用版本' },
  stage: { percent: 12, label: '准备临时目录' },
  install: { percent: 45, label: '下载并依赖安装' },
  verify: { percent: 70, label: '校验文件与入口' },
  smoke: { percent: 85, label: '预启动冒烟测试' },
  promote: { percent: 97, label: '启用新内核' },
  done: { percent: 100, label: '完成' }
}

function emit(onProgress, phase, extra = {}) {
  if (typeof onProgress !== 'function') return
  onProgress({ phase, ...PHASES[phase], ...extra })
}

/**
 * 异步、带超时的进程树终止。
 *
 * 旧实现用 execSync('taskkill …') 同步阻塞事件循环：在 pnpm 超时或冒烟测试
 * 收尾时若子进程不肯退出，主线程会被卡死。这里改用 spawn 异步执行并设硬超时，
 * 绝不阻塞事件循环。返回值被调用方忽略（fire-and-forget），kill 在后台继续。
 */
function killTree(child, timeoutMs = 8000) {
  if (!child || child.exitCode !== null) return Promise.resolve(true)
  const pid = child.pid
  if (!pid) return Promise.resolve(false)
  return new Promise((resolve) => {
    let done = false
    const finish = (ok) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(ok)
    }
    let timer
    if (process.platform === 'win32') {
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
      // POSIX（Linux / macOS）：被 kill 的进程（pnpm / dsh 冒烟）都会派生子进程，
      // 必须杀整棵进程树。调用方在 spawn 时设了 detached:true，使其成为独立进程组
      // （pgid === pid），这里向 -pid 发信号即可连孙进程一起带走。
      const pgid = pid
      const signalGroup = (sig) => {
        try {
          process.kill(-pgid, sig)
        } catch {
          /* 进程组已不存在 */
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

function runPnpm(args, cwd, { env, onOutput, timeoutMs = 20 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [paths.pnpmBin(), ...args], {
      cwd,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...(env || {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
      // POSIX 下 detached 让 pnpm 成为独立进程组，killTree 才能用 -pid 连其
      // 派生的构建脚本（node-pty 等）一起杀掉；Windows 走 taskkill /T，不需要。
      detached: !isWindows,
      windowsHide: true
    })

    let tail = ''
    const handle = (chunk) => {
      const text = chunk.toString()
      tail = (tail + text).slice(-4000)
      if (onOutput) onOutput(text)
    }
    child.stdout.on('data', handle)
    child.stderr.on('data', handle)

    const timer = setTimeout(() => {
      killTree(child)
      reject(new Error(`pnpm 执行超时（${Math.round(timeoutMs / 1000)}s）`))
    }, timeoutMs)

    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error(`pnpm 退出码 ${code}\n${tail}`))
    })
  })
}

/**
 * .npmrc for a staging install.
 *
 * node-linker=hoisted: flat node_modules, which keeps paths short enough to
 * stay under Windows MAX_PATH — the .pnpm virtual store would add another
 * segment to every one of ~500 packages.
 *
 * dangerously-allow-all-builds: pnpm 10 stopped running dependency build
 * scripts by default. Without this, node-pty / koffi / dsh-subprocess-local
 * silently end up with no native binary and the kernel fails at runtime
 * instead of at install time.
 *
 * Binary mirrors: those same scripts fetch prebuilt binaries from GitHub,
 * which is unreachable or slow from mainland China; the mirror keeps the
 * install from falling back to node-gyp and a toolchain most users lack.
 */
function npmrcFor(registryUrl) {
  return [
    'node-linker=hoisted',
    `registry=${registryUrl}`,
    'dangerously-allow-all-builds=true',
    'node_pty_binary_host_mirror=https://registry.npmmirror.com/-/binary/node-pty',
    'sharp_binary_host_mirror=https://registry.npmmirror.com/-/binary/sharp',
    'sharp_libvips_binary_host_mirror=https://registry.npmmirror.com/-/binary/sharp-libvips',
    ''
  ].join('\n')
}

class KernelPackageManager {
  /**
   * @param {object} opts
   * @param {import('./kernel-registry').KernelRegistry} opts.registry
   * @param {import('../../config-store').ConfigStore} opts.config
   * @param {{kernel: import('./throttle-proxy').ThrottleProxy, plugin: import('./throttle-proxy').ThrottleProxy}} [opts.proxies]
   */
  constructor({ registry, config, proxies = {} } = {}) {
    if (!registry || !config) throw new Error('KernelPackageManager 需要 registry 与 config')
    this.registry = registry
    this.config = config
    this.proxies = proxies
    this.client = new RegistryClient({ registry: config.read().kernel.registry })
  }

  /** Refresh the client when the user changes registries at runtime. */
  syncRegistry() {
    this.client = new RegistryClient({ registry: this.config.read().kernel.registry })
    return this.client
  }

  /** Latest published version and whether we are behind. */
  async checkLatest() {
    const latest = await this.client.latest()
    const current = this.config.read().kernel.currentVersion
    return {
      latest: latest.version,
      current,
      outdated: current ? current !== latest.version : true,
      integrity: latest.integrity,
      engines: latest.engines,
      distTags: latest.distTags || null
    }
  }

  /** Everything the UI's version dropdown needs in one call. */
  async listAvailable() {
    let latest = null
    try {
      latest = await this.client.latest()
    } catch (err) {
      // Offline or mirror down: the local snapshots are still perfectly usable,
      // so report the failure instead of failing the whole call.
      latest = { error: err.message }
    }
    return {
      ...(latest && !latest.error ? { latest: latest.version, latestEngines: latest.engines } : { latestError: latest?.error }),
      currentVersion: this.config.read().kernel.currentVersion,
      mode: this.config.read().kernel.mode,
      items: this.registry.listSnapshots()
    }
  }

  /**
   * Install a kernel version.
   *
   * @param {object} [opts]
   * @param {string} [opts.version] 'latest' or an exact version; default 'latest'
   * @param {'kernel'|'plugin'} [opts.channel] which bandwidth cap applies
   * @param {(p:object)=>void} [opts.onProgress]
   * @param {boolean} [opts.activate] promote and switch to it (default true)
   */
  async install({ version = 'latest', channel = 'kernel', onProgress, activate = true } = {}) {
    // Declared outside withLock so the catch block can clean it up. The
    // previous version read err.detail?.staging, which nothing ever set, so a
    // failed install left its half-built tree in core/staging forever.
    let stagingTarget = null
    return this.config.withLock(async () => {
      emit(onProgress, 'resolve')
      const target = await this.client.version(version)
      if (!target?.version) throw new KernelUpdateError('RESOLVE_FAILED', '无法确定要安装的内核版本')

      // Never join an unvalidated version into a path: this string comes from
      // the registry (or from the renderer), and "1.0.0/../../evil" would
      // escape the snapshots directory entirely.
      const safeVersion = assertSnapshotVersion(target.version)

      // Refresh cached installs instead of redownloading them.
      const existing = this.registry.inspect(safeVersion)
      if (existing.status === 'ready') {
        if (activate) this.registry.setCurrent(safeVersion)
        emit(onProgress, 'done', { message: `内核 ${safeVersion} 已在本地缓存，直接启用`, cached: true })
        return { version: safeVersion, cached: true, info: existing }
      }

      stagingTarget = path.join(paths.staging(), safeVersion)
      emit(onProgress, 'stage', { message: `准备 ${stagingTarget}` })
      fs.rmSync(stagingTarget, { recursive: true, force: true, maxRetries: 3 })
      fs.mkdirSync(stagingTarget, { recursive: true })

      fs.writeFileSync(
        path.join(stagingTarget, 'package.json'),
        JSON.stringify({ name: 'dsh-core', version: '0.0.0', private: true }, null, 2)
      )
      fs.writeFileSync(path.join(stagingTarget, '.npmrc'), npmrcFor(this.config.read().kernel.registry))

      emit(onProgress, 'install', { message: `正在安装 ${PACKAGE_NAME}@${safeVersion}（约 500 个依赖）` })
      await runPnpm(
        ['add', `${PACKAGE_NAME}@${safeVersion}`, '--config.node-linker=hoisted', '--reporter=append-only'],
        stagingTarget,
        { env: await this.#installEnv(channel), onOutput: (text) => emit(onProgress, 'install', { output: text.trim() }) }
      )

      emit(onProgress, 'verify')
      const entry = path.join(stagingTarget, 'node_modules', PACKAGE_NAME, 'lib', 'bin.js')
      if (!fs.existsSync(entry)) {
        throw new KernelUpdateError('VERIFY_FAILED', '安装完成但未找到入口文件 lib/bin.js', { entry })
      }
      const pkg = JSON.parse(fs.readFileSync(path.join(stagingTarget, 'node_modules', PACKAGE_NAME, 'package.json'), 'utf8'))
      if (pkg.version !== safeVersion) {
        throw new KernelUpdateError('VERIFY_FAILED', `安装版本不符：期望 ${safeVersion}，实际 ${pkg.version}`)
      }

      emit(onProgress, 'smoke', { message: '正在预启动验证（随机端口 + token 鉴权）' })
      const smoke = await this.smokeTest(entry, { cwd: stagingTarget })
      if (!smoke.ok) {
        throw new KernelUpdateError('SMOKE_FAILED', `新内核未能启动：${smoke.reason}`, { smoke })
      }

      emit(onProgress, 'promote')
      const finalDir = paths.snapshotDir(safeVersion)
      if (fs.existsSync(finalDir)) fs.rmSync(finalDir, { recursive: true, force: true, maxRetries: 3 })
      fs.renameSync(stagingTarget, finalDir)
      // Already promoted to its final home — the scratch pointer must not be
      // cleaned up any more, or a later error would delete a live snapshot.
      stagingTarget = null

      const info = this.registry.promote(safeVersion, {
        registry: this.config.read().kernel.registry,
        integrity: target.integrity,
        engines: target.engines || null,
        smoke: { port: smoke.port, at: new Date().toISOString() }
      })

      if (activate) this.registry.setCurrent(safeVersion)

      emit(onProgress, 'done', { message: `内核 ${safeVersion} 已启用` })
      return { version: safeVersion, cached: false, info, smoke }
    }).catch((err) => {
      // Never leave a half-built tree behind: the next attempt starts clean and
      // the current kernel is exactly as it was.
      if (stagingTarget) {
        try {
          fs.rmSync(stagingTarget, { recursive: true, force: true, maxRetries: 3 })
        } catch {
          /* best effort */
        }
      }
      throw err
    })
  }

  /**
   * Boot a candidate kernel and confirm it really serves.
   *
   * Reuses the launcher's own readiness logic (same flags, same token regex,
   * same HTTP probe) so there is exactly one definition of "dsh is up".
   */
  async smokeTest(entry, { cwd, timeoutMs = 120000 } = {}) {
    const port = await findFreePort()
    const env = {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      DSH_HOME: path.join(paths.userData(), 'smoke-home')
    }

    return new Promise((resolve) => {
      let settled = false
      let matched = false
      let buffer = ''
      let child

      const finish = (result) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        killTree(child)
        resolve(result)
      }

      const timer = setTimeout(
        () => finish({ ok: false, reason: `${Math.round(timeoutMs / 1000)}s 内未输出就绪地址`, port }),
        timeoutMs
      )

      try {
        child = spawn(process.execPath, KERNEL_ARGS(entry, port), {
          cwd: cwd || paths.workspace(),
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: !isWindows,
          windowsHide: true
        })
      } catch (err) {
        return finish({ ok: false, reason: `无法启动子进程：${err.message}`, port })
      }

      const onData = (chunk) => {
        buffer += chunk.toString()
        // The URL is printed once, but dsh keeps writing afterwards, so every
        // later chunk re-matches the buffer. Without this guard each one would
        // start its own 30s polling loop against the same port.
        if (matched) return
        const match = buffer.match(URL_PATTERN)
        if (!match) return
        matched = true
        waitUntilServing(match[1], 30000).then((serving) => {
          finish(serving ? { ok: true, url: match[1], port } : { ok: false, reason: `端口 ${port} 未接受连接`, port })
        })
      }
      child.stdout.on('data', onData)
      child.stderr.on('data', onData)
      child.on('error', (err) => finish({ ok: false, reason: err.message, port }))
      child.on('exit', (code) => {
        if (!settled) finish({ ok: false, reason: `进程退出（code=${code}）`, port, tail: buffer.slice(-800) })
      })
    })
  }

  /** Env for the install, including the throttling proxy when a cap is set. */
  async #installEnv(channel) {
    // npm_config_userconfig must point at a file that actually exists: pointing
    // it at a missing path makes pnpm skip user config silently, which is fine,
    // but it also breaks any user who *relied* on a global .npmrc without us
    // telling them. Writing our own keeps the install reproducible and visibly
    // isolated from whatever the machine happens to have configured.
    const userconfig = path.join(paths.userData(), 'npmrc')
    fs.writeFileSync(userconfig, npmrcFor(this.config.read().kernel.registry))

    const env = {
      npm_config_registry: this.config.read().kernel.registry,
      npm_config_userconfig: userconfig
    }
    const proxy = this.proxies?.[channel]
    const cap = this.config.read().limits?.[channel === 'plugin' ? 'pluginKBps' : 'kernelKBps'] || 0
    if (proxy && cap > 0) {
      proxy.setLimit(cap)
      const port = await proxy.listen()
      env.HTTPS_PROXY = `http://127.0.0.1:${port}`
      env.HTTP_PROXY = env.HTTPS_PROXY
    }
    return env
  }

  /** Disk usage per snapshot, for the storage panel. */
  async usage() {
    return this.registry.sizes()
  }
}

module.exports = { KernelPackageManager, KernelUpdateError, PHASES, killTree, runPnpm, npmrcFor }
