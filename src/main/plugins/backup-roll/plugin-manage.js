/**
 * Plugin & rollback manager — the "backup-roll" built-in plugin's main-process half.
 *
 * Scope, deliberately narrow:
 *
 *  1. It owns `plugin-manifest.json`: which plugins exist, which of them are
 *     built-in (backup-roll can never be removed — if kernel management
 *     disappears the app has no way to repair itself), and the kernel snapshot
 *     inventory used for rollback.
 *
 *  2. It owns the *plugin* bandwidth channel. Kernel downloads and plugin
 *     downloads have separate caps because they are not the same shape of
 *     problem: a kernel is ~500 packages once a month, a plugin is a few
 *     packages on demand. One shared cap means a plugin install stalls a kernel
 *     update for ten minutes.
 *
 *  3. It records a rollback history so "go back to what worked" is a button
 *     press, not archaeology in a directory listing.
 *
 * It does NOT install into the kernel tree. dsh's own plugin system installs
 * into $DSH_HOME/profiles/<name>/node_modules, which lives outside every
 * snapshot — that separation is what makes switching kernels free.
 */
const fs = require('node:fs')
const path = require('node:path')

const { paths } = require('../../paths')
const { runPnpm, npmrcFor } = require('./kernel-package-manager')
const { assertPackageName, assertVersion } = require('./validate')
const { readRequiresKernel } = require('./plugin-store')

const MANIFEST_VERSION = 1

/** The one plugin that ships with the app and cannot be deleted. */
const BUILTIN_PLUGIN = {
  id: 'backup-roll',
  name: '备份与回滚',
  description: '内核版本管理、快照回滚、下载限速',
  builtin: true,
  enabled: true
}

const DEFAULT_MANIFEST = {
  version: MANIFEST_VERSION,
  plugins: [{ ...BUILTIN_PLUGIN, version: '0.1.0', updatedAt: null }],
  kernelSnapshots: [],
  history: []
}

function cloneJson(value) {
  if (Array.isArray(value)) return value.map(cloneJson)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, cloneJson(v)]))
  }
  return value
}

class PluginError extends Error {
  constructor(code, message, detail = {}) {
    super(message)
    this.name = 'PluginError'
    this.code = code
    this.detail = detail
  }
}

class PluginManager {
  /**
   * @param {object} opts
   * @param {string} [opts.manifestFile]
   * @param {string} [opts.installDir]   where user plugins are installed
   * @param {import('../../config-store').ConfigStore} opts.config
   * @param {import('./kernel-registry').KernelRegistry} opts.registry
   * @param {{plugin?: import('./throttle-proxy').ThrottleProxy}} [opts.proxies]
   */
  constructor({ manifestFile, installDir, config, registry, proxies = {} } = {}) {
    if (!config) throw new Error('PluginManager 需要 config')
    this.manifestFile = manifestFile || paths.manifestFile()
    // 插件只待在 DSH_HOME 下的独立目录里：既不进内核树（清理旧快照不会连带
    // 删掉插件），也不写系统目录、不碰任何全局配置。
    this.installDir = installDir || paths.pluginDir()
    this.config = config
    this.registry = registry
    this.proxies = proxies
  }

  /* ---------------- manifest ---------------- */

  read() {
    let raw = null
    try {
      raw = JSON.parse(fs.readFileSync(this.manifestFile, 'utf8'))
    } catch {
      raw = null
    }
    const base = cloneJson(DEFAULT_MANIFEST)
    if (!raw) return base

    // Merge rather than replace: a manifest written by an older build must not
    // lose the built-in entry, and a corrupted plugins array must not take the
    // whole file down with it.
    const merged = {
      version: raw.version ?? base.version,
      plugins: Array.isArray(raw.plugins) ? raw.plugins : base.plugins,
      kernelSnapshots: Array.isArray(raw.kernelSnapshots) ? raw.kernelSnapshots : [],
      history: Array.isArray(raw.history) ? raw.history : []
    }
    if (!merged.plugins.some((p) => p.id === BUILTIN_PLUGIN.id)) {
      merged.plugins.unshift({ ...BUILTIN_PLUGIN, version: '0.1.0', updatedAt: null })
    }
    return merged
  }

  write(manifest) {
    fs.mkdirSync(path.dirname(this.manifestFile), { recursive: true })
    const tmp = `${this.manifestFile}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2), 'utf8')
    fs.renameSync(tmp, this.manifestFile)
    return manifest
  }

  updateManifest(fn) {
    const next = fn(this.read())
    return this.write(next || this.read())
  }

  /* ---------------- plugins ---------------- */

  /** Plugins plus the live kernel snapshot inventory, for one UI call. */
  list() {
    const manifest = this.read()
    return {
      plugins: manifest.plugins,
      installDir: this.installDir,
      kernelSnapshots: this.registry ? this.registry.listSnapshots() : manifest.kernelSnapshots,
      history: manifest.history.slice(-20).reverse(),
      limits: this.config.read().limits
    }
  }

  /**
   * Install a user plugin from the registry.
   *
   * Runs under the same update lock as kernel installs — both rewrite
   * node_modules trees, and two concurrent pnpm runs in one store is the
   * classic way to end up with a dependency tree that resolves but does not
   * load.
   */
  async install({ name, version = 'latest', onProgress } = {}) {
    const safeName = assertPackageName(name)
    if (safeName === BUILTIN_PLUGIN.id) {
      throw new PluginError('PLUGIN_BUILTIN', '内置插件不可重新安装')
    }
    // Dist-tags are fine for a pnpm spec but must never reach this far as a
    // bare string; validate anyway so a bad UI payload fails here, not in pnpm.
    const safeVersion = assertVersion(version, { allowTag: true })

    return this.config.withLock(async () => {
      onProgress?.({ phase: 'stage', label: '准备插件目录' })
      fs.mkdirSync(this.installDir, { recursive: true })

      const pkgJson = path.join(this.installDir, 'package.json')
      if (!fs.existsSync(pkgJson)) {
        fs.writeFileSync(
          pkgJson,
          JSON.stringify({ name: 'dsh-plugins', version: '0.0.0', private: true }, null, 2)
        )
      }
      fs.writeFileSync(path.join(this.installDir, '.npmrc'), npmrcFor(this.config.read().kernel.registry))

      const spec = safeVersion && safeVersion !== 'latest' ? `${safeName}@${safeVersion}` : safeName
      onProgress?.({ phase: 'install', label: `正在安装 ${spec}` })
      await runPnpm(['add', spec, '--config.node-linker=hoisted', '--reporter=append-only'], this.installDir, {
        env: await this.#installEnv('plugin'),
        onOutput: (text) => onProgress?.({ phase: 'install', output: text.trim() })
      })

      const installed = this.#readInstalledVersion(safeName)
      onProgress?.({ phase: 'done', label: `已安装 ${spec}`, percent: 100 })

      // 元信息里记两个内核版本，含义不同，缺一不可：
      //   requiresKernel —— 插件自己声明依赖哪个内核（多数插件没声明，为 null），
      //     用来在换内核之后提示「它当初是为哪个版本写的」；
      //   kernelVersion  —— 实际装到哪个内核上，是排障时的现场快照。
      const requiresKernel = readRequiresKernel(this.#readInstalledPackage(safeName))
      const kernelVersion = this.config.read().kernel.currentVersion || null

      this.updateManifest((m) => ({
        ...m,
        plugins: [
          ...m.plugins.filter((p) => p.id !== safeName),
          {
            id: safeName,
            name: safeName,
            builtin: false,
            enabled: true,
            version: installed || safeVersion,
            requiresKernel,
            kernelVersion,
            updatedAt: new Date().toISOString()
          }
        ]
      }))

      return this.list()
    })
  }

  async uninstall(name) {
    const safeName = assertPackageName(name)
    if (safeName === BUILTIN_PLUGIN.id) {
      throw new PluginError('PLUGIN_BUILTIN', '内置插件不可卸载')
    }
    return this.config.withLock(async () => {
      await runPnpm(['remove', safeName, '--reporter=append-only'], this.installDir, {
        env: await this.#installEnv('plugin')
      }).catch((err) => {
        // Removing a plugin that was never recorded in package.json is not an
        // error worth blocking on; the manifest entry still has to go.
        if (!/ENOENT/.test(err.message)) throw err
      })
      this.updateManifest((m) => ({ ...m, plugins: m.plugins.filter((p) => p.id !== safeName) }))
      return this.list()
    })
  }

  setEnabled(name, enabled) {
    return this.updateManifest((m) => ({
      ...m,
      plugins: m.plugins.map((p) => (p.id === name ? { ...p, enabled: !!enabled } : p))
    }))
  }

  /* ---------------- kernel rollback ---------------- */

  /** Refresh the snapshot inventory the rollback list is built from. */
  syncKernelSnapshots() {
    if (!this.registry) return []
    const snapshots = this.registry.listSnapshots()
    this.updateManifest((m) => ({ ...m, kernelSnapshots: snapshots }))
    return snapshots
  }

  /**
   * Record a kernel transition. Called after a successful switch so the UI can
   * offer "undo" instead of guessing which snapshot was previously in use.
   */
  recordHistory({ action, from, to, ok = true, note = '' }) {
    return this.updateManifest((m) => ({
      ...m,
      history: [
        ...m.history.slice(-99),
        { at: new Date().toISOString(), action, from: from ?? null, to: to ?? null, ok, note }
      ]
    }))
  }

  /** The most recent version that is not `current` and still exists on disk. */
  rollbackCandidates() {
    const current = this.config.read().kernel.currentVersion
    return (this.registry ? this.registry.listSnapshots() : this.read().kernelSnapshots).filter(
      (s) => s.status === 'ready' && s.dirVersion !== current
    )
  }

  /* ---------------- internals ---------------- */

  /** 读已装插件自己的 package.json；没装或读不到一律返回 null。 */
  #readInstalledPackage(name) {
    try {
      return JSON.parse(
        fs.readFileSync(path.join(this.installDir, 'node_modules', name, 'package.json'), 'utf8')
      )
    } catch {
      return null
    }
  }

  #readInstalledVersion(name) {
    return this.#readInstalledPackage(name)?.version || null
  }

  /** Plugin channel env, incl. the throttling proxy when a cap is set. */
  async #installEnv(channel) {
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
}

module.exports = { PluginManager, PluginError, BUILTIN_PLUGIN, DEFAULT_MANIFEST, MANIFEST_VERSION }
