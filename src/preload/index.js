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
  setEnabled: (name, enabled) => ipcRenderer.invoke('plugin:setEnabled', { name, enabled })
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
  terminal
})
