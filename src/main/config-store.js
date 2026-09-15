/**
 * Persistent user configuration (config.json).
 *
 * Why a hand-rolled store instead of electron-store: the file lives in
 * userData and is read before the app window exists, and we need atomic
 * writes. A half-written config.json during a kernel update is exactly the
 * kind of corruption that leaves the app unable to start at all, so every
 * write goes to a temp file and is renamed into place.
 *
 * The kernel section is the single source of truth for *which* dsh version
 * runs. There is deliberately no "stable" symlink: Windows restricts symlink
 * creation to administrators / developer mode, so switching versions means
 * flipping a pointer here rather than re-pointing a link on disk. That is
 * also atomic by construction — a crash mid-switch cannot leave a dangling
 * directory.
 */
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

/** @deepseek-ai/dsh declares no `engines` field (verified against the registry
 *  tarball), so the floor is pinned here instead of being read from the
 *  package. dsh's bin.js ends with `if (import.meta.main)`, which only exists
 *  from Node 24 — on 22 it exits 0 and prints nothing. */
const KERNEL_MIN_NODE_MAJOR = 24

const DEFAULTS = {
  version: 1,
  /** Desktop-shell自身的状态，与 kernel 段互不干扰。 */
  app: {
    /** 应用自更新源（静态目录，内含 latest.yml + 安装包）；未配置则整体停用。 */
    updateUrl: null,
    autoCheckUpdate: true,
    /** 已执行的迁移记录：[{ id, at, versions, rescued }] */
    migrations: [],
    /** 旧版本留下的 DSH_HOME 位置，仅用于迁移时抢救数据。 */
    legacyDshHome: null
  },
  kernel: {
    mode: 'auto', // 'auto' (follow latest) | 'pinned' (stay on pinnedVersion)
    pinnedVersion: null,
    currentVersion: null, // resolved snapshot actually in use
    autoUpdate: true,
    registry: 'https://registry.npmmirror.com',
    keepSnapshots: 3
  },
  limits: {
    kernelKBps: 0, // 0 = unlimited; separate from plugin downloads
    pluginKBps: 0
  }
}

/**
 * Structured clone of JSON-ish data.
 *
 * deepMerge must never share nested references with DEFAULTS: a shallow copy
 * leaves `out.kernel` pointing at `DEFAULTS.kernel`, so any in-place edit by a
 * caller would silently rewrite the defaults for the entire process.
 */
function cloneJson(value) {
  if (Array.isArray(value)) return value.map(cloneJson)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, cloneJson(v)]))
  }
  return value
}

function deepMerge(base, patch) {
  const out = cloneJson(base)
  for (const [k, v] of Object.entries(patch || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof out[k] === 'object' && out[k] !== null) {
      out[k] = deepMerge(out[k], v)
    } else if (v !== undefined) {
      out[k] = v
    }
  }
  return out
}

class ConfigStore {
  /**
   * @param {string} file absolute path to config.json
   * @param {string} lockPath absolute path to the update lock file
   */
  constructor(file, lockPath) {
    this.file = file
    this.lockPath = lockPath
    this.cache = null
  }

  /** Read config, filling in defaults for anything missing. Never throws. */
  read() {
    if (this.cache) return this.cache
    let raw = null
    try {
      raw = JSON.parse(fs.readFileSync(this.file, 'utf8'))
    } catch {
      // Missing or corrupt: fall back to defaults rather than refusing to boot.
      raw = null
    }
    this.cache = deepMerge(DEFAULTS, raw || {})
    return this.cache
  }

  /** Merge a patch and persist atomically. */
  write(patch) {
    const next = deepMerge(this.read(), patch)
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const tmp = `${this.file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8')
    fs.renameSync(tmp, this.file)
    this.cache = next
    return next
  }

  /** Convenience: read-modify-write. */
  update(fn) {
    const next = deepMerge(this.read(), fn(this.read()) || {})
    return this.write(next)
  }

  invalidate() {
    this.cache = null
  }

  /**
   * Run `fn` while holding the update lock.
   *
   * Kernel and plugin installs both rewrite node_modules; running them
   * concurrently on the same store is how you end up with a half-installed
   * tree. The lock is a plain file created with O_EXCL, and stale locks from
   * a crashed process are cleared so the app is never permanently stuck.
   */
  async withLock(fn, { staleMs = 10 * 60 * 1000 } = {}) {
    fs.mkdirSync(path.dirname(this.lockPath), { recursive: true })

    const payload = JSON.stringify({ pid: process.pid, host: os.hostname(), at: Date.now() })
    const busy = () => {
      const err = new Error('另一个更新任务正在进行中，请稍后再试。')
      err.code = 'UPDATE_BUSY'
      return err
    }

    // 'wx' creates the file atomically and fails with EEXIST if it is already
    // there — no existsSync/writeFileSync race between two processes.
    try {
      fs.writeFileSync(this.lockPath, payload, { flag: 'wx' })
    } catch (err) {
      if (err.code !== 'EEXIST') throw err

      let stale = true
      try {
        stale = Date.now() - fs.statSync(this.lockPath).mtimeMs > staleMs
      } catch {
        stale = true
      }
      if (!stale) throw busy()

      try {
        fs.rmSync(this.lockPath, { force: true })
      } catch {
        /* gone already */
      }
      try {
        fs.writeFileSync(this.lockPath, payload, { flag: 'wx' })
      } catch (err2) {
        if (err2.code === 'EEXIST') throw busy()
        throw err2
      }
    }

    try {
      return await fn()
    } finally {
      try {
        fs.rmSync(this.lockPath, { force: true })
      } catch {
        /* nothing to release */
      }
    }
  }
}

module.exports = { ConfigStore, DEFAULTS, KERNEL_MIN_NODE_MAJOR, deepMerge }
