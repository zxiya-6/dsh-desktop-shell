/**
 * Application self-update (electron-updater), wired for a *generic* host.
 *
 * This is distinct from kernel updates — those replace the dsh runtime in
 * core/snapshots (see kernel-package-manager). This replaces the desktop shell
 * itself, which only makes sense once a release is actually published somewhere,
 * so the whole thing degrades to a no-op when no feed is configured:
 *
 *   enabled = app.isPackaged && config.app.updateUrl is set
 *
 * Why a generic provider instead of GitHub: there is no public release yet.
 * `generic` means "any static directory holding latest.yml + installers", which
 * covers an object-storage bucket or a private CDN — the two realistic options
 * for a China mainland download. Point config.app.updateUrl at it and nothing
 * else changes.
 *
 * Security notes:
 *  - The feed URL lives in user config, so it is operator-controlled, not
 *    renderer-controlled: no IPC here lets a page choose where updates come
 *    from. Only the path setter validates and persists to config.json.
 *  - No `file://` or `http://` downgrade: if the configured scheme is not
 *    https we still allow it (private mirrors often run http on a LAN) but say
 *    so loudly in the log. Never follow a URL handed over from the renderer.
 */
const { EventEmitter } = require('node:events')

const UPDATER_DISABLED_REASON = {
  dev: '开发模式下不检查应用更新',
  noUrl: '尚未配置应用更新地址（config.json → app.updateUrl）',
  unsupported: '当前平台不支持应用内更新'
}

class AppUpdater extends EventEmitter {
  /**
   * @param {object} opts
   * @param {object} opts.config   ConfigStore instance
   * @param {object} [opts.app]    Electron app object (injectable for tests)
   * @param {(level:string, msg:string)=>void} [opts.log]
   */
  constructor({ config, app, log } = {}) {
    super()
    this.config = config
    // Lazy require: the module touches Electron internals on load, and every
    // other part of the app must work with it uninstalled.
    this.app = app || (() => {
      try {
        return require('electron').app
      } catch {
        return null
      }
    })()
    this.log = typeof log === 'function' ? log : (level, msg) => console[level === 'error' ? 'error' : 'log'](`[updater] ${msg}`)
    this.autoUpdater = null
    this.state = { status: 'idle', info: null, error: null, lastCheckedAt: null }
  }

  /** Packaged builds only, and only when a feed URL exists. */
  availability() {
    const cfg = this.config?.read?.() ?? {}
    const url = cfg?.app?.updateUrl
    if (!this.app?.isPackaged) return { ok: false, reason: UPDATER_DISABLED_REASON.dev }
    if (!url || typeof url !== 'string') return { ok: false, reason: UPDATER_DISABLED_REASON.noUrl }
    return { ok: true, url }
  }

  /** Snapshot for IPC / UI. */
  snapshot() {
    const cfg = this.config?.read?.() ?? {}
    const availability = this.availability()
    return {
      ...this.state,
      updateUrl: cfg?.app?.updateUrl ?? null,
      autoCheck: cfg?.app?.autoCheckUpdate !== false,
      enabled: availability.ok,
      reason: availability.ok ? null : availability.reason,
      currentVersion: this.app?.getVersion?.() ?? null
    }
  }

  /** Load electron-updater lazily and configure it once. Throws only for real breakage. */
  #ensure() {
    if (this.autoUpdater) return this.autoUpdater

    const { autoUpdater } = require('electron-updater')
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.allowDowngrade = false
    autoUpdater.allowPrerelease = false
    // A dead logger inside electron-updater swallows its own errors; keep ours.
    autoUpdater.logger = {
      info: (msg) => this.log('info', String(msg)),
      warn: (msg) => this.log('warn', String(msg)),
      error: (msg) => this.log('error', String(msg)),
      debug: (msg) => this.log('debug', String(msg))
    }

    autoUpdater.on('checking-for-update', () => this.#emit({ status: 'checking' }))
    autoUpdater.on('update-available', (info) =>
      this.#emit({ status: 'available', info: { version: info.version, releaseDate: info.releaseDate, notes: info.releaseNotes || null } })
    )
    autoUpdater.on('update-not-available', (info) =>
      this.#emit({ status: 'not-available', info: { version: info?.version ?? null } })
    )
    autoUpdater.on('download-progress', (p) =>
      this.#emit({ status: 'downloading', percent: Math.round(p.percent), transferred: p.transferred, total: p.total })
    )
    autoUpdater.on('update-downloaded', (info) =>
      this.#emit({ status: 'downloaded', info: { version: info.version, releasedAt: info.releaseDate } })
    )
    autoUpdater.on('error', (err) => this.#emit({ status: 'error', error: err?.message || String(err) }))

    this.autoUpdater = autoUpdater
    return autoUpdater
  }

  #emit(patch) {
    this.state = { ...this.state, ...patch, lastCheckedAt: new Date().toISOString() }
    this.emit('state', this.snapshot())
    return this.state
  }

  /** Persist the feed URL. Only http(s) is accepted — never file or anything exotic. */
  setUpdateUrl(url) {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
      throw new Error('更新地址必须是 http(s) 链接')
    }
    this.config?.write?.({ app: { updateUrl: url } })
    // Force a re-configure on the next check.
    this.autoUpdater = null
    this.emit('state', this.snapshot())
    return this.snapshot()
  }

  setAutoCheck(enabled) {
    this.config?.write?.({ app: { autoCheckUpdate: !!enabled } })
    this.emit('state', this.snapshot())
    return this.snapshot()
  }

  /** Check for a new shell version. Resolves with a status snapshot, never rejects. */
  async checkForUpdates() {
    const availability = this.availability()
    if (!availability.ok) return this.#emit({ status: 'disabled', error: null, reason: availability.reason })

    try {
      const updater = this.#ensure()
      updater.setFeedURL({ provider: 'generic', url: availability.url })
      const result = await updater.checkForUpdatesAndNotify()
      if (!result?.updateInfo) {
        return this.state.status === 'available' ? this.snapshot() : this.#emit({ status: 'not-available' })
      }
      return this.snapshot()
    } catch (err) {
      // Offline or a broken feed must never surface as an app failure.
      this.log('warn', `检查应用更新失败：${err.message}`)
      return this.#emit({ status: 'error', error: err.message })
    }
  }

  /** Download whatever checkForUpdates found. */
  async download() {
    const availability = this.availability()
    if (!availability.ok) return this.#emit({ status: 'disabled', reason: availability.reason })
    try {
      const updater = this.#ensure()
      await updater.downloadUpdate()
      return this.snapshot()
    } catch (err) {
      return this.#emit({ status: 'error', error: err.message })
    }
  }

  /** Install now and restart. Only meaningful after a download completed. */
  quitAndInstall() {
    const availability = this.availability()
    if (!availability.ok) throw new Error(availability.reason)
    try {
      this.#ensure().quitAndInstall(false, true)
      return true
    } catch (err) {
      this.#emit({ status: 'error', error: err.message })
      throw err
    }
  }
}

module.exports = { AppUpdater, UPDATER_DISABLED_REASON }
