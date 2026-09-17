/**
 * Application entry (main process).
 *
 * Responsibilities, in order:
 *   1. Single-instance lock — two desktops mutating one profile directory would
 *      corrupt it. The upstream design does the same.
 *   2. Start dsh as a child process and wait for its authenticated URL.
 *   3. Present a local loading/error page first, then swap in the real UI once
 *      dsh is actually ready. Showing a blank window while a 500-package runtime
 *      boots is how you get "it just hangs" bug reports.
 *   4. Own the terminal window and shut everything down cleanly on quit.
 *
 * Everything writable lives under userData (see paths.js), so reinstalling or
 * upgrading never touches profiles, plugins or sessions.
 */
const path = require('node:path')
const fs = require('node:fs')
const { app, BrowserWindow, ipcMain, Menu, dialog, shell } = require('electron')

// getOverrides 是 paths 模块的导出函数，不在 paths 对象上——早先误写成
// paths.getOverrides()，三个调用点全在运行时抛 TypeError，表现为启动时的
// 「校正内核目录失败」和设置页读不出路径。这里显式导出，避免再错。
const { paths, ensureDirectories, setOverrides, getOverrides } = require('./paths')
const { validate: validatePathConfig } = require('./path-config')
const { DshLauncher } = require('./dsh-launcher')
const { TerminalManager, detectShell } = require('./terminal')
const { ConfigStore } = require('./config-store')
const { KernelRegistry, KernelError } = require('./plugins/backup-roll/kernel-registry')
const { KernelPackageManager } = require('./plugins/backup-roll/kernel-package-manager')
const { KernelAutoUpdater } = require('./plugins/backup-roll/kernel-auto-update')
const { PluginManager } = require('./plugins/backup-roll/plugin-manage')
const { ThrottleProxy } = require('./plugins/backup-roll/throttle-proxy')
const { assertSnapshotVersion, assertVersion } = require('./plugins/backup-roll/validate')
const { migrateUserData } = require('./migrate')
const { AppUpdater } = require('./app-updater')
const { PluginStore } = require('./plugins/backup-roll/plugin-store')
const { acquireInstanceLock, releaseInstanceLock, clearStaleLock } = require('./instance-lock')

/**
 * Pin the userData directory name.
 *
 * Left to itself this derives from app.getName(), which is not stable — a dev
 * run reports "Electron" while a packaged run reports something else. The NSIS
 * uninstaller has to locate this exact folder to clean up, so fix it here:
 * %APPDATA%\dsh-desktop on Windows, ~/.config/dsh-desktop on Linux.
 *
 * Portable (green) builds keep data next to the executable (see user-data.js),
 * so deleting the folder really is a complete uninstall.
 */
const { pinUserData } = require('./user-data')

pinUserData()

const isMac = process.platform === 'darwin'
const dev = process.argv.includes('--dev')

/**
 * Kernel management wiring.
 *
 * The registry owns "which dsh runs"; the launcher owns "how it runs". Keeping
 * them separate is what lets phase 2 add downloading and rollback without
 * touching the process lifecycle code that is already proven.
 */
const config = new ConfigStore(paths.configFile(), paths.lockFile())

/** 未经覆盖时的默认 DSH_HOME，与 paths.js 里的兜底保持一致。 */
function defaultDshHome() {
  return path.join(paths.userData(), 'dsh-home')
}

/** 当前生效的内核快照目录：用户覆盖优先，否则跟随 config.kernel.currentVersion。 */
function currentKernelDir() {
  const explicit = paths.kernelDir()
  if (explicit) return explicit
  const version = config.read().kernel.currentVersion
  return version ? paths.snapshotDir(version) : null
}

/**
 * 把 config.paths 里保存的自定义路径应用到 paths 模块。
 *
 * 必须在 registry / launcher 之前跑完：DSH_HOME 决定子进程拿到的环境变量，
 * 内核目录决定入口解析，两者都得在任何一处路径计算之前定下来。
 *
 * 保存时已经校验过一次，这里再校验是防御性的——用户完全可能在应用没运行时
 * 手改了 config.json，也可能把目录整个挪走或删掉。校验不过就静默退回默认
 * 位置、只记日志：路径配错不该让应用起不来，否则用户连改回来的机会都没有。
 */
function applyPathOverrides() {
  const saved = config.read().paths || {}
  const base = { snapshotsDir: paths.snapshots(), stagingDir: paths.staging() }
  const applied = { dshHome: null, kernelDir: null }
  const warnings = []

  if (saved.dshHome) {
    const result = validatePathConfig('dshHome', saved.dshHome, base)
    if (result.ok) applied.dshHome = result.value
    else warnings.push(`DSH_HOME：${result.reason}`)
  }
  if (saved.kernelDir) {
    const result = validatePathConfig('kernelDir', saved.kernelDir, {
      ...base,
      dshHome: applied.dshHome || defaultDshHome()
    })
    if (result.ok) applied.kernelDir = result.value
    else warnings.push(`内核目录：${result.reason}`)
  }

  setOverrides(applied)
  if (warnings.length) {
    console.warn(`[paths] 自定义路径不合法，已回退为默认：${warnings.join('；')}`)
  }
  return { ...applied, warnings }
}

// 应用自定义路径这件事本身不许把模块加载打断：一旦这里抛出，主进程会在
// require 阶段就崩掉，用户连窗口都看不到，更没有机会把配错的路径改回来。
// 所以失败时静默退回默认位置——路径配错不该让应用起不来，这条原则在
// applyPathOverrides / path-config 里已经约束过一次，这里守住最后一环。
try {
  applyPathOverrides()
} catch (err) {
  console.warn('[paths] 应用自定义路径失败，已退回默认位置：', err.message)
  setOverrides({ dshHome: null, kernelDir: null })
}

/**
 * 用 currentVersion 校正 kernelDir，防止两者分叉。
 *
 * 这两个值表达的是同一件事（「现在用哪个内核」），而 currentVersion 才是
 * 唯一的真相源：launcher 靠它解析入口，快照回滚也靠它。kernelDir 只是它
 * 在设置页里的路径投影。所以每次配置变动后都用 currentVersion 校正一遍，
 * 免得有人手改 config.json 之后，设置页和内核面板显示出两个不同的「当前内核」。
 */
function normalizeKernelDirToCurrent() {
  const current = config.read().kernel.currentVersion
  const next = current ? paths.snapshotDir(current) : null
  const applied = getOverrides()
  if (applied.kernelDir !== next) {
    config.write({ paths: { kernelDir: next } })
    setOverrides({ dshHome: applied.dshHome, kernelDir: next })
  }
}

const registry = new KernelRegistry({
  snapshotsDir: paths.snapshots(),
  stagingDir: paths.staging(),
  config
})

const launcher = new DshLauncher({ registry })
const terminals = new TerminalManager()

/**
 * Two throttling proxies = two independent bandwidth channels.
 *
 * A kernel is ~500 packages pulled once a month; a plugin is a handful pulled
 * on demand. Sharing one cap would let a plugin install stall a kernel update
 * (or the reverse), so they get separate instances and separate settings.
 */
const proxies = {
  kernel: new ThrottleProxy(),
  plugin: new ThrottleProxy()
}

const kernelManager = new KernelPackageManager({ registry, config, proxies })
const plugins = new PluginManager({ config, registry, proxies })

/**
 * Desktop-shell self update.
 *
 * Separate from kernel updates on purpose: this replaces the app, the panel
 * replaces dsh. It stays dormant until somebody publishes a release and points
 * config.app.updateUrl at it.
 */
const updater = new AppUpdater({ config })
updater.on('state', (state) => sendUpdaterState(state))

let mainWindow = null
let terminalWindow = null
let kernelWindow = null

/* ------------------------------------------------------------------ *
 * Single instance
 *
 * 两道锁，缺一不可：
 *   1) Electron 自带的 `requestSingleInstanceLock()` —— 只在**同一个
 *      userData** 内生效，负责把重复启动的同版本唤到前台（second-instance）。
 *   2) 自建的跨版本锁（instance-lock.js）—— 便携版与安装版的 userData
 *      不同，自带锁各管各的，两边能同时跑起来抢端口、互相挤崩内核。
 *
 * 第 2 道锁的路径**不能**取 userData（那正是失效的原因），要取一个与它无关
 * 的固定位置：%APPDATA%\dsh-desktop-shell\instance.lock。
 * ------------------------------------------------------------------ */

/**
 * 跨版本锁文件。
 *
 * `app.getPath('appData')` 不受 `pinUserData()` 改写 userData 的影响，所以
 * 便携版和安装版算出来是同一个文件。
 */
function crossEditionLockFile() {
  return path.join(app.getPath('appData'), 'dsh-desktop-shell', 'instance.lock')
}

let crossEditionLockPath = null

/**
 * 抢跨版本锁。抢不到就提示并退出。
 *
 * 这里不能像 second-instance 那样去唤醒已有窗口 —— 那是同一个 Electron 实例
 * 内部才有的事件，两个不同版本之间没有这条通道。所以只能明确告诉用户
 * 「已经开着一个了」，并说明为什么不能同时开。
 *
 * @returns {boolean} 是否可以继续启动
 */
function claimCrossEditionLock() {
  crossEditionLockPath = crossEditionLockFile()
  const result = acquireInstanceLock({
    file: crossEditionLockPath,
    payload: {
      version: app.getVersion(),
      portable: Boolean(process.env.PORTABLE_EXECUTABLE_DIR),
      exe: app.getPath('exe')
    }
  })
  if (result.ok) return true

  if (result.reason === 'held') {
    const who = result.holder || {}
    const which = who.portable ? '便携版' : '安装版'
    console.warn('[lock] 已有实例在运行：', JSON.stringify(who))
    dialog.showMessageBoxSync({
      type: 'warning',
      title: 'DSH Desktop 已在运行',
      message: `已经有一个 DSH Desktop 在运行了（${which}，pid ${who.pid ?? '未知'}）。`,
      detail:
        '两个实例会争抢同一个端口，并互相把对方的内核挤掉，还会在数据目录里留下' +
        '锁文件，导致下次启动失败。\n\n请先关掉正在运行的那个，再启动本程序。',
      buttons: ['知道了']
    })
    return false
  }

  // 写不了锁文件（目录权限等）：不拦启动，但要说清楚 —— 静默放行等于把
  // 「两个实例互踩」这个更难查的问题留给用户。
  console.warn('[lock] 跨版本锁获取失败，已按不检查继续启动：', result.error && result.error.message)
  return true
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })
}

/* ------------------------------------------------------------------ *
 * Window helpers
 * ------------------------------------------------------------------ */

function loadLocalPage(window, file, query = {}) {
  const url = new URL(`file://${path.join(__dirname, '..', 'renderer', file)}`)
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v))
  window.loadURL(url.toString())
}

/**
 * Is this a URL we own?
 *
 * A prefix test on "http://127.0.0.1" would also match
 * "http://127.0.0.1.evil.com", which is a different host entirely — a page
 * there would open with our preload and get the full dshDesktop API. Parse and
 * compare the hostname instead.
 */
function isLocalDshUrl(url) {
  try {
    const parsed = new URL(url)
    return (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' || parsed.hostname === '[::1]')
    )
  } catch {
    return false
  }
}

/**
 * Only http(s) may leave the app.
 *
 * `shell.openExternal` hands the string to the OS shell. Passing it an
 * arbitrary URL from a renderer — including file:///... .exe — is remote code
 * execution with extra steps.
 */
function safeOpenExternal(url) {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
    shell.openExternal(parsed.href)
    return true
  } catch {
    return false
  }
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    title: 'DSH Desktop',
    backgroundColor: '#1e1e1e',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Renderers get no --expose-internals and no Node access. That flag is
      // required by Cordis HMR, so it is granted to the dsh child process only.
      sandbox: true
    }
  })

  loadLocalPage(mainWindow, 'loading.html')

  mainWindow.once('ready-to-show', () => mainWindow.show())
  // 兜底：窗口是 show:false，只靠 ready-to-show 才露面。加载页一旦加载失败，
  // ready-to-show 永远不会触发，窗口就一直藏着——用户看到的就是「双击了却
  // 什么都没发生」，且日志里没有任何线索。这里保证窗口至少会弹出来。
  mainWindow.webContents.once('did-fail-load', (_event, code, desc, url) => {
    console.error(`[ui] 页面加载失败：${code} ${desc} ${url || ''}`)
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show()
  })
  mainWindow.on('closed', () => {
    mainWindow = null
  })

  // Keep in-app navigation; send anything external to the system browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isLocalDshUrl(url)) return { action: 'allow' }
    safeOpenExternal(url)
    return { action: 'deny' }
  })

  // Navigation allow-list: this window may only ever visit the local dsh
  // server (and its own local pages). Anything else goes to the browser, so a
  // compromised or redirected page cannot silently swap the UI out from under
  // the session cookie.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (isLocalDshUrl(url) || url.startsWith('file://')) return
    event.preventDefault()
    safeOpenExternal(url)
  })

  return mainWindow
}

function createTerminalWindow() {
  if (terminalWindow && !terminalWindow.isDestroyed()) {
    terminalWindow.focus()
    return terminalWindow
  }

  terminalWindow = new BrowserWindow({
    width: 1000,
    height: 640,
    title: 'Terminal — DSH Desktop',
    backgroundColor: '#0d0d0d',
    parent: mainWindow || undefined,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  loadLocalPage(terminalWindow, 'terminal.html')
  terminalWindow.on('closed', () => {
    terminalWindow = null
    for (const id of [...terminals.sessions.keys()]) {
      if (id.startsWith('term-')) terminals.dispose(id)
    }
  })

  return terminalWindow
}

/**
 * Kernel management panel.
 *
 * Its own window rather than a tab in the dsh web UI: the panel has to work
 * when dsh itself will not start, which is exactly when you need it.
 */
function createKernelWindow() {
  if (kernelWindow && !kernelWindow.isDestroyed()) {
    kernelWindow.focus()
    return kernelWindow
  }

  kernelWindow = new BrowserWindow({
    width: 900,
    height: 760,
    title: '内核管理 — DSH Desktop',
    backgroundColor: '#14161a',
    parent: mainWindow || undefined,
    modal: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  loadLocalPage(kernelWindow, 'kernel.html')
  kernelWindow.on('closed', () => {
    kernelWindow = null
  })

  return kernelWindow
}

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */

/**
 * 最后一次状态。
 *
 * 只推送是不够的：boot 在窗口 `did-finish-load` 之前就可能跑完，加载页注册
 * `onStatus` 时那条 `kernel-missing` / `ready` 早已发过了，页面会永远停在
 * 「正在初始化…」—— 内核缺失时的「安装内核」入口也就跟着不出现。所以状态
 * 除了推送，还要能被 `dsh:getStatus()` 拉一次（见 loading.html）。
 */
let lastStatus = { state: 'starting', detail: '' }

function sendStatus(state, detail) {
  lastStatus = { state, detail: detail || '' }
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    try {
      win.webContents.send('dsh:status', { state, detail })
    } catch {
      /* window went away mid-send */
    }
  }
}

/**
 * Fan update progress out to every window.
 *
 * The kernel panel can be open in the main window while the loading page is
 * showing in another, so this is a broadcast rather than a reply — an
 * ipcMain.handle result only arrives when the whole install is over.
 */
function sendKernelProgress(payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    try {
      win.webContents.send('kernel:progress', payload)
    } catch {
      /* window went away mid-send */
    }
  }
}

/** Same reasoning as kernel progress: every window may be listening. */
function sendUpdaterState(state) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    try {
      win.webContents.send('app:update', state)
    } catch {
      /* window went away mid-send */
    }
  }
}

/** Snapshot of kernel state for the UI. */
function kernelStatus() {
  const cfg = config.read()
  const running = launcher.currentKernel()
  return {
    mode: cfg.kernel.mode,
    pinnedVersion: cfg.kernel.pinnedVersion,
    currentVersion: cfg.kernel.currentVersion,
    runningVersion: running?.version ?? null,
    autoUpdate: cfg.kernel.autoUpdate,
    registry: cfg.kernel.registry,
    keepSnapshots: cfg.kernel.keepSnapshots,
    nodeMajor: Number(process.versions.node.split('.')[0]),
    snapshotsDir: paths.snapshots(),
    limits: cfg.limits
  }
}

/**
 * Bring a machine upgraded from an older build onto the current layout.
 *
 * Runs before the kernel is resolved — the whole point is that a legacy kernel
 * must be adopted *before* the app decides there is no kernel at all. Never
 * fatal: a migration that fails must not stop the shell from booting.
 */
function runMigrations() {
  try {
    const bundledRoots = []
    try {
      bundledRoots.push(paths.appModules())
    } catch {
      /* not resolvable in some script contexts — userData scan still runs */
    }

    const report = migrateUserData({
      root: paths.userData(),
      config,
      packageRoots: bundledRoots,
      log: (msg) => console.log(`[migrate] ${msg}`)
    })

    if (report.adopted.length || report.rescued.length) {
      console.log(
        `[migrate] 采纳 ${report.adopted.length} 个遗留内核，抢救 ${report.rescued.length} 项数据`
      )
    }
    for (const skipped of report.skipped) {
      console.log(`[migrate] 跳过 ${skipped.dir}${skipped.version ? ` (${skipped.version})` : ''}：${skipped.reason}`)
    }
    for (const err of report.errors) {
      console.warn(`[migrate] ${err.dir} 迁移失败：${err.error}`)
    }
    return report
  } catch (err) {
    console.error('[migrate] 非致命失败：', err.message)
    return null
  }
}

/**
 * 清掉内核侧留下的僵尸锁。
 *
 * task-board 插件会在 `dsh-home/task-board/ledger-v2.lock` 里记下自己的 pid。
 * 进程被强杀（多开互挤、任务管理器结束进程、上次的崩溃）时锁不会自己消失，
 * 下次启动内核会直接报：
 *
 *   task-board ledger is already owned by process 53632; ...
 *   remove ...\ledger-v2.lock manually and retry
 *
 * 然后内核进程退出 —— 应用界面停在错误页，用户看到的就是「双击了却打不开」。
 * 这里启动前判一次 pid：已死就删掉，还活着就绝不动（那说明真有另一个实例）。
 *
 * 整段包在 try/catch 里，理由同 runMigrations —— 清理失败不许阻断启动。
 */
function clearStaleKernelLock() {
  try {
    const file = path.join(paths.dshHome(), 'task-board', 'ledger-v2.lock')
    const result = clearStaleLock(file)
    if (result === 'removed') {
      console.warn('[lock] 已清理内核侧僵尸锁（持有者进程已退出）：', file)
    }
  } catch (err) {
    console.warn('[lock] 清理内核侧锁失败，已跳过：', err.message)
  }
}

async function boot() {
  ensureDirectories()
  runMigrations()
  // 迁移可能改写了 config（包括 currentVersion），所以校正要放在它之后。
  // 校正失败同样不许阻断启动：它只是让设置页显示得更准确，窗口和内核才是
  // 主体。否则一次写不了 config 的权限问题，就会让应用连窗口都弹不出来。
  try {
    normalizeKernelDirToCurrent()
  } catch (err) {
    console.warn('[paths] 校正内核目录失败，已按默认路径继续启动：', err.message)
  }
  // 必须在拉起内核之前：内核一起来就会去抢这把锁。
  clearStaleKernelLock()
  createMainWindow()

  // Resolve the kernel *before* booting it. Without this the user would stare
  // at a spinner while the launcher fails 60s later on a missing kernel.
  try {
    const kernel = registry.resolve()
    sendStatus('starting', `正在启动内置 dsh 运行时（内核 ${kernel.version}）…`)
  } catch (err) {
    if (err instanceof KernelError) {
      console.warn('[kernel]', err.code, err.message)
      sendStatus('kernel-missing', err.message)
      return
    }
    throw err
  }

  try {
    const url = await launcher.start()
    sendStatus('ready', url)
    if (mainWindow) mainWindow.loadURL(url)
  } catch (err) {
    console.error('[dsh] failed to start:', err)
    sendStatus(
      err instanceof KernelError ? 'kernel-missing' : 'error',
      err.message
    )
  }
}

/**
 * Interactive app-update flow for the menu item.
 *
 * Native dialogs rather than the web UI on purpose: the shell update has to be
 * usable even when dsh — and therefore most of our rendered UI — is not
 * running. The renderer gets the same information over `app:update` later.
 */
async function promptAppUpdate() {
  const availability = updater.availability()
  if (!availability.ok) {
    dialog.showMessageBox({
      type: 'info',
      title: '应用更新',
      message: availability.reason,
      detail: '把静态更新目录写到 config.json 的 app.updateUrl（内含 latest.yml 与安装包）即可启用自动检查。'
    })
    return null
  }

  const state = await updater.checkForUpdates()

  if (state.status === 'not-available') {
    dialog.showMessageBox({ type: 'info', title: '应用更新', message: `已是最新版本（${state.currentVersion}）` })
    return state
  }
  if (state.status === 'error') {
    dialog.showErrorBox('检查更新失败', state.error || '未知错误')
    return state
  }
  if (state.status !== 'available') return state

  const answer = await dialog.showMessageBox({
    type: 'question',
    title: '应用更新',
    message: `发现新版本 ${state.info?.version}`,
    detail: `当前: ${state.currentVersion}\n${state.info?.releaseDate ? `发布日期: ${state.info.releaseDate}\n` : ''}是否现在下载并安装？`,
    buttons: ['下载并安装', '取消'],
    defaultId: 0,
    cancelId: 1
  })
  if (answer.response !== 0) return state

  const downloaded = await updater.download()
  if (downloaded.status !== 'downloaded') {
    dialog.showErrorBox('下载更新失败', downloaded.error || '未知错误')
    return downloaded
  }

  const restart = await dialog.showMessageBox({
    type: 'question',
    title: '应用更新',
    message: `版本 ${downloaded.info?.version} 已就绪`,
    detail: '安装需要重启应用。',
    buttons: ['立即重启并安装', '稍后'],
    defaultId: 0,
    cancelId: 1
  })
  if (restart.response === 0) updater.quitAndInstall()
  return downloaded
}

/* ------------------------------------------------------------------ *
 * Application menu
 * ------------------------------------------------------------------ */

function buildMenu() {
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: '文件',
      submenu: [
        {
          label: '打开终端',
          accelerator: 'Ctrl+`',
          click: () => createTerminalWindow()
        },
        { type: 'separator' },
        { role: 'quit', label: '退出' }
      ]
    },
    {
      label: '内核',
      submenu: [
        {
          label: '内核管理…',
          accelerator: 'Ctrl+K',
          click: () => createKernelWindow()
        },
        {
          label: '检查内核更新',
          click: async () => {
            try {
              const info = await kernelManager.checkLatest()
              dialog.showMessageBox({
                type: 'info',
                title: '内核更新',
                message: info.outdated
                  ? `发现新版本 ${info.latest}`
                  : `已是最新（${info.current}）`,
                detail: `当前: ${info.current || '（无）'}\n最新: ${info.latest}`
              })
            } catch (err) {
              dialog.showErrorBox('检查更新失败', err.message)
            }
          }
        },
        {
          label: '清理旧快照',
          click: () => {
            const out = registry.prune()
            plugins.syncKernelSnapshots()
            dialog.showMessageBox({
              type: 'info',
              title: '快照清理',
              message: out.retired.length ? `已清理 ${out.retired.length} 个快照` : '没有需要清理的快照',
              detail: `保留: ${out.kept.join(', ')}\n${out.retired.length ? `清理: ${out.retired.join(', ')}` : ''}`
            })
          }
        },
        { type: 'separator' },
        {
          label: '打开快照目录',
          click: () => shell.openPath(paths.snapshots())
        }
      ]
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '重新加载' },
        { role: 'forceReload', label: '强制重新加载' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' }
      ]
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '重新加载 dsh 运行时',
          click: async () => {
            if (!mainWindow) return
            loadLocalPage(mainWindow, 'loading.html')
            try {
              const url = await launcher.restart()
              sendStatus('ready', url)
              mainWindow.loadURL(url)
            } catch (err) {
              sendStatus('error', err.message)
            }
          }
        },
        {
          label: '打开数据目录',
          click: () => shell.openPath(paths.userData())
        },
        {
          label: '打开 dsh 日志',
          click: () => shell.openPath(paths.logFile())
        },
        {
          label: '检查应用更新…',
          click: () => {
            promptAppUpdate().catch((err) => dialog.showErrorBox('检查更新失败', err.message))
          }
        },
        { type: 'separator' },
        {
          label: '关于',
          click: () => {
            const shellInfo = terminals.getShell()
            dialog.showMessageBox({
              type: 'info',
              title: '关于 DSH Desktop',
              message: 'DSH Desktop',
              detail: [
                `版本: ${app.getVersion()}`,
                `Electron: ${process.versions.electron}`,
                `Node: ${process.versions.node}`,
                `终端: ${shellInfo.label}${shellInfo.version ? ` (${shellInfo.version})` : ''}`,
                '',
                `数据目录: ${paths.userData()}`,
                `内核快照: ${paths.snapshots()}`,
                `当前内核: ${registry.currentVersion || '（未安装）'}`,
                `内置运行时: Node ${process.versions.node}`
              ].join('\n')
            })
          }
        }
      ]
    }
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

/* ------------------------------------------------------------------ *
 * IPC
 * ------------------------------------------------------------------ */

/** 内核自动更新器。在 registerIpc() 里实例化——它依赖那个安装函数。 */
let autoUpdater = null

/** 自动更新状态广播给所有窗口（日志由 KernelAutoUpdater 自己打）。 */
function sendAutoUpdateState(state, log) {
  if (log) console.log(`[kernel:auto] ${log}`)
  const payload = state || (autoUpdater ? autoUpdater.snapshot() : null)
  if (!payload) return
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    try {
      win.webContents.send('kernel:autoUpdate', payload)
    } catch {
      /* window went away mid-send */
    }
  }
}

function registerIpc() {
  autoUpdater = new KernelAutoUpdater({
    config,
    registry,
    manager: kernelManager,
    // 自动更新与手动「下载并安装」共用同一条安装链路（先启动、再写配置）。
    installAndActivate: (version) => installKernelVersion(version, { activate: true, trigger: 'auto' }),
    onEvent: sendAutoUpdateState
  })

  ipcMain.handle('dsh:getStatus', () => ({
    // state / detail：给「晚一步加载完」的页面补齐推送前已经发生过的状态。
    state: lastStatus.state,
    detail: lastStatus.detail,
    url: launcher.url,
    pid: launcher.child?.pid ?? null,
    dshHome: paths.dshHome(),
    workspace: paths.workspace(),
    userData: paths.userData(),
    logFile: paths.logFile(),
    kernel: launcher.currentKernel()?.version ?? registry.currentVersion ?? null
  }))

  /* ---------------- kernel (dynamic dsh) ---------------- */

  ipcMain.handle('kernel:status', () => kernelStatus())

  ipcMain.handle('kernel:listVersions', () => ({
    ...kernelStatus(),
    items: registry.listSnapshots()
  }))

  // Switching restarts the child process; the running kernel holds file locks
  // that would otherwise block any later snapshot deletion.
  ipcMain.handle('kernel:switchVersion', async (_event, { version } = {}) => {
    if (!version) throw new Error('缺少内核版本号')
    // A version is a snapshot directory name; anything else would be a path
    // probe against the filesystem. Reject it before it reaches inspect().
    const safeVersion = assertSnapshotVersion(version)
    const result = await launcher.switchTo(safeVersion)
    // 版本切过去了，设置页那条「内核路径」也要跟着走（两者互为投影）
    normalizeKernelDirToCurrent()
    return { ...kernelStatus(), url: result.url }
  })

  /* ---------------- 用户可配置路径（DSH_HOME / 内核目录） ---------------- */

  /** 校验上下文：把「内核树」和 DSH_HOME 一起喂进去，才能判定互相嵌套。 */
  function pathConfigContext() {
    return {
      snapshotsDir: paths.snapshots(),
      stagingDir: paths.staging(),
      dshHome: paths.dshHome(),
      kernelDir: currentKernelDir()
    }
  }

  /** 设置页一次拿全：当前值、默认值、是否为自定义。 */
  function pathConfigSnapshot() {
    const applied = getOverrides()
    const current = config.read().kernel.currentVersion
    return {
      dshHome: paths.dshHome(),
      kernelDir: currentKernelDir(),
      snapshotsDir: paths.snapshots(),
      currentVersion: current,
      defaults: {
        dshHome: defaultDshHome(),
        kernelDir: current ? paths.snapshotDir(current) : null
      },
      custom: {
        dshHome: !!applied.dshHome,
        kernelDir: !!applied.kernelDir
      }
    }
  }

  /**
   * DSH_HOME 变更后重启内核。
   *
   * DSH_HOME 是以环境变量的形式喂给 dsh 子进程的，改了配置不等于改了那个
   * 已经在跑的进程。所以这里按新值重启一次，让配置立刻生效而不必等用户
   * 手动退出。失败只影响内核本身——配置已经落盘，下次启动照样生效。
   */
  async function restartKernelForDshHome() {
    if (!config.read().kernel.currentVersion) {
      return { ok: false, error: '尚未安装内核，配置已保存，安装后自动生效' }
    }
    try {
      const url = await launcher.restart()
      if (mainWindow && url) mainWindow.loadURL(url)
      return { ok: true, url }
    } catch (err) {
      console.warn('[paths] DSH_HOME 变更后重启内核失败：', err.message)
      return { ok: false, error: err.message }
    }
  }

  ipcMain.handle('pathConfig:get', () => pathConfigSnapshot())

  ipcMain.handle('pathConfig:validate', (_event, { kind, value } = {}) =>
    validatePathConfig(kind, value, pathConfigContext())
  )

  ipcMain.handle('pathConfig:browse', async (_event, { kind } = {}) => {
    const win = BrowserWindow.getFocusedWindow() || mainWindow
    const result = await dialog.showOpenDialog(win, {
      title: kind === 'kernelDir' ? '选择内核目录' : '选择 DSH_HOME 目录',
      defaultPath: kind === 'kernelDir' ? paths.snapshots() : paths.dshHome(),
      properties: ['openDirectory', 'dontAddToRecent']
    })
    if (result.canceled || !result.filePaths?.length) return null
    const picked = result.filePaths[0]
    // 选完立刻校验，让界面马上告诉用户「这个能不能用」
    return { path: picked, ...validatePathConfig(kind, picked, pathConfigContext()) }
  })

  ipcMain.handle('pathConfig:set', async (_event, { kind, value } = {}) => {
    if (kind !== 'dshHome' && kind !== 'kernelDir') {
      throw new Error(`未知的路径类型：${kind}`)
    }
    const applied = getOverrides()

    // 留空 = 恢复默认位置
    if (value === null || String(value).trim() === '') {
      config.write({
        paths: kind === 'dshHome'
          ? { dshHome: null, kernelDir: applied.kernelDir }
          : { dshHome: applied.dshHome, kernelDir: null }
      })
      applyPathOverrides()
      if (kind === 'kernelDir') normalizeKernelDirToCurrent()
      if (kind === 'dshHome') {
        ensureDirectories()
        await restartKernelForDshHome()
      }
      return pathConfigSnapshot()
    }

    const result = validatePathConfig(kind, value, pathConfigContext())
    if (!result.ok) throw new Error(result.reason)

    if (kind === 'dshHome') {
      config.write({ paths: { dshHome: result.value, kernelDir: applied.kernelDir } })
      applyPathOverrides()
      ensureDirectories()
      const restarted = await restartKernelForDshHome()
      return { ...pathConfigSnapshot(), restarted }
    }

    // 内核目录必须落在快照根目录内：只有那样才反推得出版本号，才能复用
    // switchTo 这条已经过验证的切换链路。快照外的目录无法与 currentVersion
    // 对应，硬切过去只会让设置页和内核面板各说各话。
    if (!result.version) {
      throw new Error(`请选择 ${paths.snapshots()} 下的内核快照目录`)
    }
    await launcher.switchTo(result.version)
    normalizeKernelDirToCurrent()
    return pathConfigSnapshot()
  })

  ipcMain.handle('kernel:setMode', (_event, { mode, version } = {}) => {
    registry.setMode(mode, version ? assertSnapshotVersion(version) : null)
    return kernelStatus()
  })

  ipcMain.handle('kernel:setLimits', (_event, limits = {}) => {
    config.write({
      limits: {
        kernelKBps: Number(limits.kernelKBps) >= 0 ? Number(limits.kernelKBps) : 0,
        pluginKBps: Number(limits.pluginKBps) >= 0 ? Number(limits.pluginKBps) : 0
      }
    })
    return kernelStatus()
  })

  /**
   * Download + verify + promote a kernel version.
   *
   * The old kernel keeps running until the new one has booted and answered
   * HTTP, so a failed update is invisible to the user apart from an error.
   */
  ipcMain.handle('kernel:update', async (_event, { version = 'latest', activate = true } = {}) => {
    const result = await installKernelVersion(version, { activate, trigger: 'manual' })
    // 手动触发走 IPC 时要把异常抛回渲染层（界面负责提示）；自动更新自己在
    // KernelAutoUpdater 里吞掉并记录。
    return result
  })

  ipcMain.handle('kernel:checkNow', async () => autoUpdater.checkNow())

  ipcMain.handle('kernel:autoUpdateStatus', () => autoUpdater.snapshot())

  ipcMain.handle('kernel:setAutoUpdate', (_event, { enabled } = {}) => {
    config.write({ kernel: { autoUpdate: !!enabled } })
    autoUpdater.setEnabled(!!enabled)
    return autoUpdater.snapshot()
  })

  sendAutoUpdateState()

  /**
   * 下载并安装一个内核版本，可选随后启用。
 *
 * 手工点「下载并安装」与自动更新共用这一个函数 —— 两条路径一旦分开写，
 * 迟早有一边漏掉「先启动、再写配置」这条铁律。
 *
 * @param {string} version 'latest' 或精确版本号
 * @param {object} [opts]
 * @param {boolean} [opts.activate] 装完是否切换过去
 * @param {string} [opts.trigger] manual | auto，仅用于历史记录
 * @param {(p: object) => void} [opts.onProgress]
 */
async function installKernelVersion(version, { activate = true, trigger = 'manual', onProgress } = {}) {
  const emit = onProgress || sendKernelProgress
  // 'latest' is a valid dist-tag; a concrete version must be a real semver.
    // Reject path separators and ranges up front — they can never be a snapshot
    // directory and would otherwise be sent verbatim to the registry client.
    const safeVersion = assertVersion(version, { allowTag: true })
    const before = registry.currentVersion
    try {
      // activate:false — the manager must not commit the selection, because
      // committing before the new kernel has booted is exactly the failure
      // mode we are designed to avoid. The switch below does it safely.
      const result = await kernelManager.install({
        version,
        channel: 'kernel',
        activate: false,
        onProgress: sendKernelProgress
      })

      if (activate) {
        sendKernelProgress({ phase: 'restart', label: '正在切换运行内核…', percent: 99 })
        const wasRunning = !!launcher.child
        let url
        if (wasRunning) {
          // switchTo boots the new snapshot and only then commits config.
          url = (await launcher.switchTo(result.version)).url
        } else {
          // Nothing is running (first install). Same rule: boot first, commit
          // after — so a kernel that cannot start never becomes "current".
          url = await launcher.start(registry.inspect(result.version))
          registry.setCurrent(result.version)
        }
        if (mainWindow && url) mainWindow.loadURL(url)
        plugins.recordHistory({
          action: trigger === 'auto' ? 'auto-update' : 'update',
          from: before,
          to: result.version
        })
        plugins.syncKernelSnapshots()
        sendKernelProgress({ phase: 'done', label: '完成', percent: 100, url })
        return { ...kernelStatus(), url, result, version: result.version }
      }

      plugins.recordHistory({ action: 'install', from: before, to: before })
      plugins.syncKernelSnapshots()
      return { ...kernelStatus(), result, version: result.version }
    } catch (err) {
      plugins.recordHistory({
        action: trigger === 'auto' ? 'auto-update' : 'update',
        from: before,
        to: version,
        ok: false,
        note: err.message
      })
      sendKernelProgress({ phase: 'failed', label: '更新失败', percent: 100, message: err.message })
      throw err
    }
  }

  /**
   * registry 上可下载的版本列表。
   *
   * 界面要「先选版本、再点下载」，就必须能看到**还没装过**的版本；本地快照
   * 列表（kernel:listVersions）在首次使用时是空的，光靠它选不出任何东西。
   * 网络失败时不抛错——离线也要能看本地快照，只是拉不到远端列表。
   */
  ipcMain.handle('kernel:remoteVersions', async () => {
    try {
      return await kernelManager.listRemoteVersions()
    } catch (err) {
      return {
        registry: config.read().kernel.registry,
        latest: null,
        distTags: {},
        current: registry.currentVersion,
        total: 0,
        items: [],
        error: err.message
      }
    }
  })

  ipcMain.handle('kernel:checkLatest', async () => {
    try {
      return await kernelManager.checkLatest()
    } catch (err) {
      // Offline must not look like "you are up to date".
      return { latest: null, current: registry.currentVersion, outdated: false, error: err.message }
    }
  })

  /** Roll back to a previous snapshot. Same path as switching, but recorded. */
  ipcMain.handle('kernel:rollback', async (_event, { version } = {}) => {
    if (!version) throw new Error('缺少目标版本号')
    const safeVersion = assertSnapshotVersion(version)
    const before = registry.currentVersion
    const result = await launcher.switchTo(safeVersion)
    plugins.recordHistory({ action: 'rollback', from: before, to: safeVersion })
    return { ...kernelStatus(), url: result.url }
  })

  ipcMain.handle('plugin:list', () => plugins.list())

  ipcMain.handle('plugin:install', (_event, opts = {}) =>
    plugins.install({ ...opts, onProgress: (p) => sendKernelProgress({ channel: 'plugin', ...p }) })
  )

  ipcMain.handle('plugin:uninstall', (_event, { name } = {}) => plugins.uninstall(name))

  /**
   * 插件商店搜索。
   *
   * 每次都用当前配置的镜像现建实例：用户随时可能改 registry，而这里没有
   * 需要保持的会话状态。搜索失败由 PluginStore 内部兜住（体现为 error 字段），
   * 不会把网络异常直接抛到渲染层。
   */
  ipcMain.handle('plugin:search', async (_event, { query, size } = {}) => {
    const store = new PluginStore({ registry: config.read().kernel.registry })
    return store.search({ query, size })
  })

  /** 单个插件的详情，安装前用来展示它声明依赖哪个内核版本。 */
  ipcMain.handle('plugin:detail', async (_event, { name } = {}) => {
    if (!name) throw new Error('缺少插件包名')
    const store = new PluginStore({ registry: config.read().kernel.registry })
    return store.detail(name)
  })

  ipcMain.handle('plugin:setEnabled', (_event, { name, enabled } = {}) =>
    plugins.setEnabled(name, enabled)
  )

  ipcMain.handle('kernel:prune', (_event, { keep } = {}) => {
    // An unvalidated `keep` of 0 (or a negative) would delete every snapshot
    // except the running one — silently destroying the ability to roll back.
    let safeKeep
    if (keep !== undefined && keep !== null && keep !== '') {
      const n = Number(keep)
      if (Number.isFinite(n)) safeKeep = Math.max(1, Math.min(20, Math.trunc(n)))
    }
    // Protect what is *actually running*, not just what config says: in a
    // degraded fallback the two differ, and deleting the running snapshot
    // leaves a half-removed tree that dsh is still holding open.
    const running = launcher.currentKernel()
    const out = registry.prune(safeKeep, running?.dirVersion || null)
    plugins.syncKernelSnapshots()
    return out
  })

  ipcMain.handle('dsh:restart', async () => {
    const url = await launcher.restart()
    if (mainWindow) mainWindow.loadURL(url)
    return url
  })

  ipcMain.handle('app:openTerminal', () => {
    createTerminalWindow()
    return true
  })

  ipcMain.handle('app:openKernel', () => {
    createKernelWindow()
    return true
  })

  /* ---------------- desktop shell self-update ---------------- */

  ipcMain.handle('app:updateStatus', () => updater.snapshot())

  ipcMain.handle('app:checkUpdate', () => updater.checkForUpdates())

  ipcMain.handle('app:downloadUpdate', () => updater.download())

  ipcMain.handle('app:installUpdate', () => {
    // Relies on the same before-quit teardown as a manual exit, so the dsh
    // child process is not left behind holding files the installer replaces.
    terminals.disposeAll()
    return updater.quitAndInstall()
  })

  // Only ever accepts http(s) (validated in AppUpdater) and only ever persists
  // to config.json — a renderer must not be able to pick its own update source.
  ipcMain.handle('app:setUpdateUrl', (_event, { url } = {}) => {
    if (typeof url !== 'string' || !url) throw new Error('缺少更新地址')
    return updater.setUpdateUrl(url)
  })

  ipcMain.handle('app:setAutoCheck', (_event, { enabled } = {}) => updater.setAutoCheck(enabled !== false))

  ipcMain.handle('terminal:available', () => ({
    available: terminals.available(),
    reason: terminals.unavailableReason(),
    shell: (() => {
      const s = terminals.getShell()
      return { id: s.id, label: s.label, version: s.version, path: s.exePath }
    })()
  }))

  ipcMain.handle('terminal:create', (event, { sessionId, cols, rows }) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    return terminals.create(
      sessionId,
      { cols, rows },
      (data) => {
        if (!win.isDestroyed()) win.webContents.send(`terminal:data:${sessionId}`, data)
      },
      (info) => {
        if (!win.isDestroyed()) win.webContents.send(`terminal:exit:${sessionId}`, info)
      }
    )
  })

  ipcMain.handle('terminal:write', (_event, { sessionId, data }) =>
    terminals.write(sessionId, data)
  )

  ipcMain.handle('terminal:resize', (_event, { sessionId, cols, rows }) =>
    terminals.resize(sessionId, cols, rows)
  )

  ipcMain.handle('terminal:dispose', (_event, { sessionId }) => {
    terminals.dispose(sessionId)
    return true
  })

  /**
   * Open a path in the OS file manager.
   *
   * `shell.openPath` executes whatever it is given, so an unvalidated target
   * from a renderer is an arbitrary-execution primitive. Only paths inside
   * userData — the one directory we own and the only one the UI ever asks
   * about — are allowed.
   */
  ipcMain.handle('app:openPath', (_event, target) => {
    if (typeof target !== 'string' || !target) throw new Error('缺少路径')
    const resolved = path.resolve(target)
    const root = path.resolve(paths.userData())
    const inside = resolved === root || resolved.startsWith(root + path.sep)
    if (!inside) throw new Error('只允许打开应用数据目录内的路径')
    return shell.openPath(resolved)
  })
}

/* ------------------------------------------------------------------ *
 * Lifecycle
 * ------------------------------------------------------------------ */

if (gotLock) {
  app.on('ready', () => {
    // 先抢跨版本锁：抢不到说明另一个版本已经在跑，弹提示后直接退出，
    // 不要走到下面去创建窗口和拉起内核 —— 那正是「两个内核互踩」的起点。
    if (!claimCrossEditionLock()) {
      app.quit()
      return
    }

    registerIpc()
    buildMenu()

    // dsh can die *after* it reports ready — a plugin that fails to load, or an
    // OOM. Without this the user just stares at a frozen UI on a dead port.
    launcher.on('crashed', ({ code, signal }) => {
      console.error('[dsh] exited after ready:', code, signal)
      sendStatus(
        'error',
        `dsh 运行时意外退出（代码 ${code ?? signal}）。\n` +
          `可通过"帮助 → 重新加载 dsh 运行时"重启，或打开日志排查。`
      )
      if (mainWindow && !mainWindow.isDestroyed()) loadLocalPage(mainWindow, 'loading.html')
    })

    // 内核切换进度广播给内核管理面板，让「切换中」有可见反馈，而不是像卡死。
    launcher.on('switch-progress', (payload) => sendKernelProgress(payload))

    // Deliberately quiet: no dialog when nothing is available. Checking costs
    // one request to the configured feed and nothing happens until the user
    // agrees to install.
    if (updater.availability().ok && config.read().app.autoCheckUpdate !== false) {
      setTimeout(() => {
        updater.checkForUpdates().catch((err) => console.warn('[updater]', err.message))
      }, 8000)
    }

    // 内核自动更新：启动 30s 后检查一次，之后每 6 小时一次。
    // 放在 boot() 之前启动也没关系——它的首次检查刻意延后，等内核先跑起来。
    if (autoUpdater) autoUpdater.start()

    boot().catch((err) => {
      // boot() resolves the kernel before creating the window, so a throw here
      // is a genuine boot failure with nowhere to report it but the console —
      // and without this catch it would be an unhandled rejection that leaves
      // a blank window on screen.
      console.error('[boot] fatal:', err.stack || err.message)
      sendStatus('error', err.message)
    })
  })

  app.on('window-all-closed', () => {
    // Keep dsh alive with the app on macOS convention; quit elsewhere.
    if (!isMac) app.quit()
  })

  // 释放跨版本锁。放在 will-quit（而不是 before-quit）是因为 before-quit 里
  // 可能被 preventDefault 拦下来去收进程树 —— 那时候还不能算退出。
  app.on('will-quit', () => {
    // 停掉自动更新的定时器，否则进程会被挂着不退。
    if (autoUpdater) autoUpdater.stop()
    if (crossEditionLockPath) {
      releaseInstanceLock(crossEditionLockPath)
      crossEditionLockPath = null
    }
  })

  app.on('before-quit', async (event) => {
    if (terminals.sessions.size > 0 || launcher.child) {
      event.preventDefault()
      terminals.disposeAll()
      await launcher.stop()
      app.quit()
    }
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) boot()
  })
}
