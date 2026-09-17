/**
 * Preload bridge.
 *
 * contextIsolation stays on and nodeIntegration off; the renderer gets exactly
 * the surface below and nothing else. Data is delivered over per-session
 * channels (`terminal:data:<id>`) so several terminals can coexist without
 * cross-talk.
 */
const { contextBridge, ipcRenderer } = require('electron')

const terminal = {
  available: () => ipcRenderer.invoke('terminal:available'),
  create: (sessionId, cols, rows) => ipcRenderer.invoke('terminal:create', { sessionId, cols, rows }),
  write: (sessionId, data) => ipcRenderer.invoke('terminal:write', { sessionId, data }),
  resize: (sessionId, cols, rows) => ipcRenderer.invoke('terminal:resize', { sessionId, cols, rows }),
  dispose: (sessionId) => ipcRenderer.invoke('terminal:dispose', { sessionId }),

  onData: (sessionId, callback) => {
    const channel = `terminal:data:${sessionId}`
    const listener = (_event, data) => callback(data)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  },

  onExit: (sessionId, callback) => {
    const channel = `terminal:exit:${sessionId}`
    const listener = (_event, info) => callback(info)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  }
}

const kernel = {
  status: () => ipcRenderer.invoke('kernel:status'),
  listVersions: () => ipcRenderer.invoke('kernel:listVersions'),
  switchVersion: (version) => ipcRenderer.invoke('kernel:switchVersion', { version }),
  setMode: (mode, version) => ipcRenderer.invoke('kernel:setMode', { mode, version }),
  setLimits: (limits) => ipcRenderer.invoke('kernel:setLimits', limits),
  prune: (keep) => ipcRenderer.invoke('kernel:prune', { keep }),

  /** Remote metadata. Fails soft: `{ latest: null, error }` when offline. */
  checkLatest: () => ipcRenderer.invoke('kernel:checkLatest'),

  /**
   * 远端可下载的版本列表（带「已安装 / 当前」标记）。
   * 失败不抛错，返回 `{ items: [], error }` —— 离线时本地快照仍要看得到。
   */
  remoteVersions: () => ipcRenderer.invoke('kernel:remoteVersions'),

  /* ---- 自动更新 ---- */

  /**
   * 手动立刻检查一次（装不装取决于「自动更新」开关）。
   * @returns {Promise<{result: string, reason?: string, from?: string, to?: string}>}
   */
  checkNow: () => ipcRenderer.invoke('kernel:checkNow'),

  /** 最近一次检查时间 / 结果 / 下次检查时间 / 开关状态。 */
  autoUpdateStatus: () => ipcRenderer.invoke('kernel:autoUpdateStatus'),

  /** 开关：只决定「查到新版本后是否自动安装」，定时检查照常跑。 */
  setAutoUpdate: (enabled) => ipcRenderer.invoke('kernel:setAutoUpdate', { enabled }),

  /** 主进程推来的自动更新状态（kernel:autoUpdate）。 */
  onAutoUpdate: (callback) => {
    const listener = (_event, value) => callback(value)
    ipcRenderer.on('kernel:autoUpdate', listener)
    return () => ipcRenderer.removeListener('kernel:autoUpdate', listener)
  },

  /**
   * Download + smoke test + promote. Returns only at the end; progress arrives
   * through onProgress because an install is ~1-2 minutes, not a round trip.
   */
  update: (version, activate = true) =>
    ipcRenderer.invoke('kernel:update', { version, activate }),

  /** Switch to an already-installed snapshot, recorded as a rollback. */
  rollback: (version) => ipcRenderer.invoke('kernel:rollback', { version }),

  /** `{phase, percent, label, message, output}`; `phase === 'failed'` ends it. */
  onProgress: (callback) => {
    const listener = (_event, value) => callback(value)
    ipcRenderer.on('kernel:progress', listener)
    return () => ipcRenderer.removeListener('kernel:progress', listener)
  }
}

const plugins = {
  list: () => ipcRenderer.invoke('plugin:list'),
  install: (name, version) => ipcRenderer.invoke('plugin:install', { name, version }),
  uninstall: (name) => ipcRenderer.invoke('plugin:uninstall', { name }),
  setEnabled: (name, enabled) => ipcRenderer.invoke('plugin:setEnabled', { name, enabled }),

  /** 插件商店搜索；网络失败不抛错，返回 { items: [], error }。 */
  search: (query, size) => ipcRenderer.invoke('plugin:search', { query, size }),
  /** 单个插件详情（含它声明依赖的内核版本 requiresKernel）。 */
  detail: (name) => ipcRenderer.invoke('plugin:detail', { name })
}

/**
 * 用户可配置路径（DSH_HOME / 内核目录）。
 *
 * 与 updater 同样的取舍：渲染层只能「提议」一个路径，能不能用完全由主进程
 * 的 path-config 校验说了算，不合法的写入会被直接拒绝——所以这里的 set 抛错
 * 是正常流程，UI 要把 reason 原样显示给用户，而不是当成崩溃。
 */
const pathConfig = {
  get: () => ipcRenderer.invoke('pathConfig:get'),
  validate: (kind, value) => ipcRenderer.invoke('pathConfig:validate', { kind, value }),
  set: (kind, value) => ipcRenderer.invoke('pathConfig:set', { kind, value }),
  /** 打开系统目录选择框；返回 null 表示用户取消，否则带一份即时校验结果。 */
  browse: (kind) => ipcRenderer.invoke('pathConfig:browse', { kind })
}

/**
 * Desktop-shell self update (electron-updater).
 *
 * Renderers get read-mostly access: they may trigger a check or an install, but
 * the feed URL write goes through AppUpdater's own validation first and always
 * ends up in config.json — never from a value a page can hijack at runtime.
 */
const updater = {
  status: () => ipcRenderer.invoke('app:updateStatus'),
  check: () => ipcRenderer.invoke('app:checkUpdate'),
  download: () => ipcRenderer.invoke('app:downloadUpdate'),
  install: () => ipcRenderer.invoke('app:installUpdate'),
  setUpdateUrl: (url) => ipcRenderer.invoke('app:setUpdateUrl', { url }),
  setAutoCheck: (enabled) => ipcRenderer.invoke('app:setAutoCheck', { enabled }),

  /** `{status: idle|checking|available|downloading|downloaded|not-available|error|disabled, info, error}` */
  onState: (callback) => {
    const listener = (_event, value) => callback(value)
    ipcRenderer.on('app:update', listener)
    return () => ipcRenderer.removeListener('app:update', listener)
  }
}

contextBridge.exposeInMainWorld('dshDesktop', {
  getStatus: () => ipcRenderer.invoke('dsh:getStatus'),
  restart: () => ipcRenderer.invoke('dsh:restart'),
  openTerminal: () => ipcRenderer.invoke('app:openTerminal'),
  openPath: (target) => ipcRenderer.invoke('app:openPath', target),
  onStatus: (callback) => {
    const listener = (_event, value) => callback(value)
    ipcRenderer.on('dsh:status', listener)
    return () => ipcRenderer.removeListener('dsh:status', listener)
  },
  openKernel: () => ipcRenderer.invoke('app:openKernel'),
  updater,
  kernel,
  plugins,
  pathConfig,
  terminal
})
