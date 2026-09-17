/**
 * Kernel-panel UI smoke test.
 *
 * Run: npm run smoke:ui
 *
 * The panel is a big new surface and it is the one place a typo shows up only
 * when a human clicks something. This loads the real HTML in a real
 * BrowserWindow with the real preload, wires the IPC handlers to the real
 * managers, and fails on any console error or uncaught exception.
 *
 * It is not a substitute for clicking — it proves the page boots, the API
 * contract matches, and every element the script reaches for exists.
 */
const path = require('node:path')
const { app, BrowserWindow, ipcMain } = require('electron')

const { paths, ensureDirectories } = require('../src/main/paths')
const { ConfigStore } = require('../src/main/config-store')
const { KernelRegistry } = require('../src/main/plugins/backup-roll/kernel-registry')
const { KernelPackageManager } = require('../src/main/plugins/backup-roll/kernel-package-manager')
const { PluginManager } = require('../src/main/plugins/backup-roll/plugin-manage')
const { ThrottleProxy } = require('../src/main/plugins/backup-roll/throttle-proxy')

const PAGE = path.join(__dirname, '..', 'src', 'renderer', 'kernel.html')
const PRELOAD = path.join(__dirname, '..', 'src', 'preload', 'index.js')

const problems = []

function report(kind, text) {
  problems.push(`${kind}: ${text}`)
  console.log(`  ✗ ${kind}: ${text}`)
}

async function run() {
  ensureDirectories()
  const config = new ConfigStore(paths.configFile(), paths.lockFile())
  const registry = new KernelRegistry({
    snapshotsDir: paths.snapshots(),
    stagingDir: paths.staging(),
    config
  })
  const proxies = { kernel: new ThrottleProxy(), plugin: new ThrottleProxy() }
  const kernelManager = new KernelPackageManager({ registry, config, proxies })
  const plugins = new PluginManager({ config, registry, proxies })

  // The same handlers index.js registers — kept here so the page is exercised
  // against the real contract without booting the whole app.
  const kernelStatus = () => ({
    mode: config.read().kernel.mode,
    currentVersion: config.read().kernel.currentVersion,
    runningVersion: null,
    nodeMajor: Number(process.versions.node.split('.')[0]),
    snapshotsDir: paths.snapshots(),
    limits: config.read().limits
  })
  ipcMain.handle('kernel:status', kernelStatus)
  ipcMain.handle('kernel:listVersions', () => ({ ...kernelStatus(), items: registry.listSnapshots() }))
  ipcMain.handle('kernel:checkLatest', async () => {
    try {
      return await kernelManager.checkLatest()
    } catch (err) {
      return { latest: null, current: registry.currentVersion, outdated: false, error: err.message }
    }
  })
  // 面板第 2 节的远端版本下拉框走这个通道；与 index.js 一样失败不抛错，
  // 否则内核页会多出一个「无 handler」的控制台报错。
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
  ipcMain.handle('kernel:switchVersion', async () => kernelStatus())
  ipcMain.handle('kernel:rollback', async () => kernelStatus())
  ipcMain.handle('kernel:update', async () => kernelStatus())
  ipcMain.handle('kernel:setMode', () => kernelStatus())
  ipcMain.handle('kernel:setLimits', (_e, limits = {}) => {
    config.write({ limits })
    return kernelStatus()
  })
  ipcMain.handle('kernel:prune', (_e, { keep } = {}) => registry.prune(keep, null))
  ipcMain.handle('plugin:list', () => plugins.list())
  ipcMain.handle('plugin:install', () => plugins.list())
  ipcMain.handle('plugin:uninstall', () => plugins.list())
  ipcMain.handle('plugin:setEnabled', () => plugins.list())
  ipcMain.handle('dsh:getStatus', () => ({ userData: paths.userData(), logFile: paths.logFile() }))
  ipcMain.handle('dsh:restart', async () => 'http://127.0.0.1:1/?token=x')
  ipcMain.handle('app:openPath', () => true)
  ipcMain.handle('app:openTerminal', () => true)
  ipcMain.handle('app:openKernel', () => true)
  ipcMain.handle('terminal:available', () => ({ available: false, reason: 'ui smoke' }))

  const win = new BrowserWindow({
    show: false,
    width: 900,
    height: 760,
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false, sandbox: true }
  })

  win.webContents.on('console-message', (_e, level, message) => {
    const text = String(message || '')
    if (level >= 2 && !/favicon|net::ERR_/.test(text)) report('console.error', text)
  })
  win.webContents.on('preload-error', (_e, p, err) => report('preload-error', `${p}: ${err.message}`))
  win.webContents.on('did-fail-load', (_e, code, desc) => report('did-fail-load', `${code} ${desc}`))

  await win.loadFile(PAGE)
  // Give the page time to run its async refresh against the handlers above.
  await new Promise((r) => setTimeout(r, 4000))

  const dom = await win.webContents.executeJavaScript(
    `(() => {
      const text = document.body.innerText || ''
      return {
        length: text.length,
        hasErrorBox: /加载失败|初始化失败/.test(text),
        mentionsBackupRoll: /backup-roll/.test(text),
        mentionsLimit: /限速/.test(text),
        title: document.title
      }
    })()`
  )

  console.log('')
  console.log(`  标题                : ${dom.title}`)
  console.log(`  可见文本长度        : ${dom.length}`)
  console.log(`  渲染出 backup-roll  : ${dom.mentionsBackupRoll}`)
  console.log(`  渲染出限速区块      : ${dom.mentionsLimit}`)
  console.log(`  显示加载失败        : ${dom.hasErrorBox}`)

  if (dom.length < 500) report('DOM', '页面文本过少，可能没有渲染')
  if (dom.hasErrorBox) report('DOM', '页面显示了加载失败态')
  if (!dom.mentionsBackupRoll) report('DOM', '没有渲染出内置插件 backup-roll')
  if (!dom.mentionsLimit) report('DOM', '没有渲染出限速区块')

  win.destroy()

  console.log('')
  if (problems.length === 0) {
    console.log('[smoke] PASS — 内核管理面板无控制台错误且渲染正常')
    return 0
  }
  console.log(`[smoke] FAIL — ${problems.length} 个问题`)
  return 1
}

app.whenReady().then(async () => {
  let code = 1
  try {
    code = await run()
  } catch (err) {
    console.error('[smoke] 异常:', err.stack || err.message)
  }
  app.quit(code)
})
