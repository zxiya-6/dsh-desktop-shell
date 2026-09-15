/**
 * Kernel snapshot registry — decides *which* dsh the launcher starts.
 *
 * Layout it manages:
 *   <userData>/core/
 *     snapshots/<version>/     installed kernels, each with its own node_modules
 *     staging/                 download/install scratch, promoted only on success
 *
 * Design notes that matter:
 *
 * 1. No "stable" symlink. Switching versions rewrites config.currentVersion,
 *    not the filesystem. Windows gates symlink creation behind admin /
 *    developer mode, and a link also gives us a directory that something can
 *    hold open. A pointer in a JSON file is atomic and needs no privileges.
 *
 * 2. The kernel is treated as read-only runtime code. Profiles, credentials,
 *    sessions and plugins all live in DSH_HOME (userData/dsh-home) — verified
 *    against dsh's own resolution logic (dsh-home-paths): `dsh plugin add`
 *    installs into $DSH_HOME/profiles/<name>/node_modules, never into the
 *    kernel tree. That is why swapping kernels does not cost the user their
 *    plugins.
 *
 * 3. dsh ships no `engines` field, so the Node >= 24 floor is hardcoded in
 *    config-store (KERNEL_MIN_NODE_MAJOR). If a future dsh declares engines,
 *    we honour it; if it declares nothing we still refuse to boot it on a
 *    runtime we know cannot work.
 */
const fs = require('node:fs')
const path = require('node:path')

const { KERNEL_MIN_NODE_MAJOR } = require('../../config-store')

const PACKAGE_NAME = '@deepseek-ai/dsh'
/** Relative to the snapshot root — matches the layout inside app.asar. */
const ENTRY_RELATIVE = ['node_modules', PACKAGE_NAME, 'lib', 'bin.js']

class KernelError extends Error {
  constructor(code, message, detail = {}) {
    super(message)
    this.name = 'KernelError'
    this.code = code
    this.detail = detail
  }
}

/** Parse the lowest Node major from a semver range like ">=24" or "^22.19.0". */
function minMajorFromRange(range) {
  if (typeof range !== 'string' || range.trim() === '') return null
  // A range carrying an upper bound ("<=22", ">=20 <24") asserts no usable
  // minimum, so it must never be the reason a kernel gets rejected.
  if (/[<]/.test(range)) return null
  const match = range.match(/(\d+)(?:\.(\d+))?/)
  return match ? Number(match[1]) : null
}

/**
 * Total order for "newest first".
 *
 * The old comparator returned 0 whenever either side lacked installedAt,
 * which is not a valid ordering and made the result order depend on the
 * input order. Fall back to a numeric-aware version compare so every pair is
 * comparable — listSnapshots and prune must agree on what "newest" means.
 */
function compareNewestFirst(a, b) {
  const ta = String(a.installedAt || '')
  const tb = String(b.installedAt || '')
  if (ta || tb) {
    const byTime = tb.localeCompare(ta)
    if (byTime !== 0) return byTime
  }
  return String(b.dirVersion || b.version).localeCompare(String(a.dirVersion || a.version), undefined, {
    numeric: true
  })
}

function dirSizeBytes(dir) {
  // Best-effort; a 500-package tree is too expensive to walk on every call,
  // so this is only used when explicitly asked.
  let total = 0
  const walk = (d) => {
    let entries
    try {
      entries = fs.readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const full = path.join(d, e.name)
      try {
        if (e.isDirectory()) walk(full)
        else total += fs.statSync(full).size
      } catch {
        /* unreadable entry — skip */
      }
    }
  }
  walk(dir)
  return total
}

class KernelRegistry {
  /**
   * @param {object} opts
   * @param {string} opts.snapshotsDir  absolute path to core/snapshots
   * @param {string} opts.stagingDir    absolute path to core/staging
   * @param {object} opts.config        ConfigStore instance
   * @param {number} [opts.nodeMajor]   current runtime major (injectable for tests)
   */
  constructor({ snapshotsDir, stagingDir, config, nodeMajor }) {
    this.snapshotsDir = snapshotsDir
    this.stagingDir = stagingDir
    this.config = config
    this.nodeMajor = nodeMajor ?? Number(process.versions.node.split('.')[0])
  }

  snapshotDir(version) {
    return path.join(this.snapshotsDir, String(version))
  }

  entryFor(version) {
    return path.join(this.snapshotDir(version), ...ENTRY_RELATIVE)
  }

  /** Read a snapshot's own package.json (the kernel's, not a wrapper's). */
  readKernelPackage(version) {
    const file = path.join(this.snapshotDir(version), 'node_modules', PACKAGE_NAME, 'package.json')
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      return null
    }
  }

  readMeta(version) {
    const file = path.join(this.snapshotDir(version), 'snapshot.json')
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      return null
    }
  }

  writeMeta(version, meta) {
    const file = path.join(this.snapshotDir(version), 'snapshot.json')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(meta, null, 2), 'utf8')
    fs.renameSync(tmp, file)
  }

  /**
   * Inspect one snapshot without throwing — the UI needs to render
   * incompatible entries greyed out, not hide them.
   */
  inspect(version) {
    const dir = this.snapshotDir(version)
    const entry = this.entryFor(version)
    const meta = this.readMeta(version)
    const pkg = this.readKernelPackage(version)

    const out = {
      // Directory name is the addressable identity (config.currentVersion must
      // resolve back to a real directory); package version is metadata.
      dirVersion: String(version),
      version: String(version),
      dir,
      entry,
      exists: fs.existsSync(dir),
      entryExists: fs.existsSync(entry),
      declaredEngines: pkg?.engines?.node ?? null,
      installedAt: meta?.installedAt ?? null,
      integrity: meta?.integrity ?? null,
      registry: meta?.registry ?? null,
      sizeBytes: null,
      compatible: false,
      status: 'unknown',
      reason: ''
    }

    if (!out.exists) {
      out.status = 'missing'
      out.reason = '快照目录不存在'
      return out
    }
    if (!out.entryExists) {
      out.status = 'broken'
      out.reason = `入口文件缺失：${ENTRY_RELATIVE.join('/')}`
      return out
    }
    if (!pkg) {
      out.status = 'broken'
      out.reason = '无法读取 package.json，快照可能不完整'
      return out
    }

    out.version = pkg.version || out.version
    // dsh declares no engines today; fall back to the known floor so a kernel
    // that cannot possibly run is never offered as an option.
    const minMajor = minMajorFromRange(pkg.engines?.node) ?? KERNEL_MIN_NODE_MAJOR
    out.minNodeMajor = minMajor
    out.enginesAssumed = !pkg.engines?.node
    out.compatible = this.nodeMajor >= minMajor

    if (!out.compatible) {
      out.status = 'incompatible'
      out.reason = `需要 Node >= ${minMajor}，当前内置运行时为 Node ${this.nodeMajor}`
      return out
    }

    out.status = 'ready'
    return out
  }

  /** All snapshots on disk, newest first, with compatibility already resolved. */
  listSnapshots() {
    let entries = []
    try {
      entries = fs.readdirSync(this.snapshotsDir, { withFileTypes: true })
    } catch {
      return []
    }
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => this.inspect(e.name))
      .sort(compareNewestFirst)
  }

  get currentVersion() {
    return this.config.read().kernel.currentVersion
  }

  /**
   * Resolve the kernel the launcher should start.
   *
   * A pinned or current version that turns out to be broken must not hard-lock
   * the app: fall back to any healthy snapshot, but report what happened in
   * `degraded` so the UI can say so instead of silently running something
   * else. Only when nothing usable exists do we throw.
   *
   * @throws {KernelError} KERNEL_MISSING when no snapshot can run
   */
  resolve() {
    const cfg = this.config.read().kernel
    const pinned = cfg.mode === 'pinned' ? cfg.pinnedVersion : null
    const wanted = pinned || cfg.currentVersion
    const degraded = []

    if (wanted) {
      const info = this.inspect(wanted)
      if (info.status === 'ready') {
        return { ...info, source: pinned ? 'pinned' : 'current', degraded: [] }
      }
      degraded.push({ version: wanted, status: info.status, reason: info.reason })
    }

    const ready = this.listSnapshots().filter((s) => s.status === 'ready')
    if (ready.length > 0) {
      return { ...ready[0], source: degraded.length ? 'fallback' : 'first', degraded }
    }

    const any = this.listSnapshots()
    throw new KernelError(
      'KERNEL_MISSING',
      any.length > 0
        ? `已安装的内核均不可用（${any.map((s) => `${s.version}: ${s.reason}`).join('；')}）。请安装兼容版本。`
        : '尚未安装 Harness 内核。首次使用需要下载内核（约需几分钟），或手动放置到内核目录。',
      { snapshots: any, degraded }
    )
  }

  /** Point the app at a snapshot. Validates first — no silent downgrades. */
  setCurrent(version) {
    const info = this.inspect(version)
    if (info.status !== 'ready') {
      throw new KernelError('KERNEL_INVALID', `内核 ${version} 不可选用：${info.reason}`, { info })
    }
    // Store the directory name, not the package version: config.currentVersion
    // is fed straight back into snapshotDir(), and the two can differ when a
    // snapshot was installed under an alias.
    this.config.write({ kernel: { currentVersion: info.dirVersion } })
    return info
  }

  setMode(mode, pinnedVersion = null) {
    if (mode !== 'auto' && mode !== 'pinned') {
      throw new KernelError('KERNEL_INVALID', `未知的内核模式：${mode}`)
    }
    if (mode === 'pinned' && !pinnedVersion) {
      throw new KernelError('KERNEL_INVALID', '固定版本模式需要指定版本号')
    }
    return this.config.write({
      kernel: { mode, pinnedVersion: mode === 'pinned' ? pinnedVersion : null }
    })
  }

  /** Called by the installer after a promoted snapshot passes its smoke test. */
  promote(version, meta = {}) {
    const info = this.inspect(version)
    if (!info.entryExists) {
      throw new KernelError('KERNEL_INVALID', `内核 ${version} 缺少入口文件，拒绝启用`, { info })
    }
    this.writeMeta(version, {
      // `version` stays the snapshot identity (directory name) so external
      // readers keep working; the extra fields make the distinction explicit.
      version: info.dirVersion,
      dirVersion: info.dirVersion,
      packageVersion: info.version,
      installedAt: new Date().toISOString(),
      nodeMajor: this.nodeMajor,
      ...meta
    })
    return info
  }

  /**
   * Drop snapshots beyond the retention limit.
   *
   * @param {number} [keep] override the configured retention count
   * @param {string|null} [activeVersion] snapshot actually running right now.
   *        Passed in rather than read from config, because in a degraded
   *        fallback the running kernel is not the configured one — and deleting
   *        a snapshot a live process has open only half-succeeds, leaving a
   *        broken directory behind.
   */
  prune(keep = null, activeVersion = null) {
    const limit = keep ?? this.config.read().kernel.keepSnapshots ?? 3
    const active = activeVersion ?? this.currentVersion
    const all = this.listSnapshots()
    const retired = []
    // Newest first by install time; keep the active one regardless of age.
    const ordered = [...all].sort(compareNewestFirst)
    const keepSet = new Set()
    for (const s of ordered) {
      if (keepSet.size >= limit) break
      keepSet.add(s.dirVersion)
    }
    if (active) keepSet.add(String(active))

    for (const s of ordered) {
      if (keepSet.has(s.dirVersion)) continue
      try {
        fs.rmSync(s.dir, { recursive: true, force: true, maxRetries: 3 })
        retired.push(s.version)
      } catch (err) {
        // A locked file just means "try again later" — not a fatal error.
        retired.push(`${s.version} (删除失败: ${err.code || err.message})`)
      }
    }
    return { kept: [...keepSet], retired }
  }

  /** Snapshot sizes for the storage panel. Expensive — call on demand. */
  sizes() {
    return this.listSnapshots().map((s) => ({ version: s.version, sizeBytes: dirSizeBytes(s.dir) }))
  }
}

module.exports = { KernelRegistry, KernelError, minMajorFromRange, KERNEL_MIN_NODE_MAJOR, ENTRY_RELATIVE, PACKAGE_NAME }
