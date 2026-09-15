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

const { paths, ensureDirectories } = require('./paths')
const { DshLauncher } = require('./dsh-launcher')
const { TerminalManager, detectShell } = require('./terminal')
const { ConfigStore } = require('./config-store')
const { KernelRegistry, KernelError } = require('./plugins/backup-roll/kernel-registry')
const { KernelPackageManager } = require('./plugins/backup-roll/kernel-package-manager')
const { PluginManager } = require('./plugins/backup-roll/plugin-manage')
const { ThrottleProxy } = require('./plugins/backup-roll/throttle-proxy')
const { assertSnapshotVersion, assertVersion } = require('./plugins/backup-roll/validate')
const { migrateUserData } = require('./migrate')
const { AppUpdater } = require('./app-updater')

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
 * ------------------------------------------------------------------ */

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

function sendStatus(state, detail) {
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

async function boot() {
  ensureDirectories()
  runMigrations()
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

function registerIpc() {
  ipcMain.handle('dsh:getStatus', () => ({
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
    return { ...kernelStatus(), url: result.url }
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
        sendKernelProgress({ phase: 'restart', label: '正在切换到新内核…', percent: 99 })
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
        plugins.recordHistory({ action: 'update', from: before, to: result.version })
        plugins.syncKernelSnapshots()
        sendKernelProgress({ phase: 'done', label: '完成', percent: 100, url })
        return { ...kernelStatus(), url, result }
      }

      plugins.recordHistory({ action: 'install', from: before, to: before })
      plugins.syncKernelSnapshots()
      return { ...kernelStatus(), result }
    } catch (err) {
      plugins.recordHistory({ action: 'update', from: before, to: version, ok: false, note: err.message })
      sendKernelProgress({ phase: 'failed', label: '更新失败', percent: 100, message: err.message })
      throw err
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

    // Deliberately quiet: no dialog when nothing is available. Checking costs
    // one request to the configured feed and nothing happens until the user
    // agrees to install.
    if (updater.availability().ok && config.read().app.autoCheckUpdate !== false) {
      setTimeout(() => {
        updater.checkForUpdates().catch((err) => console.warn('[updater]', err.message))
      }, 8000)
    }

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
