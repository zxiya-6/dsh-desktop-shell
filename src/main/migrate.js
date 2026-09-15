/**
 * Migration: legacy "dsh ships inside the installer" → kernel in core/snapshots.
 *
 * Why this module exists
 * ----------------------
 * Older builds carried dsh in the app bundle and booted it from there. Since
 * the installer was slimmed down, every entry point goes through
 * KernelRegistry + core/snapshots/<version>, so a machine upgraded from an old
 * build would otherwise boot to "尚未安装 Harness 内核" even though a perfectly
 * good dsh is sitting right there in its install directory.
 *
 * Three rules the whole file obeys:
 *
 *   1. Read-only toward anything that already exists. Legacy trees are
 *      *copied*, never moved or deleted — the bundled tree may live inside
 *      app.asar (not writable at all) and deleting an old kernel removes the
 *      user's only fallback the day after an upgrade.
 *   2. Nothing here patches the kernel. Per project invariant #3 the only file
 *      written into a snapshot is `snapshot.json` metadata.
 *   3. Idempotent. The result is recorded in config.json under
 *      `app.migrations`, and a second run is a no-op. Upgrades run this on
 *      every boot, so it has to be cheap *and* safe to repeat.
 *
 * Layouts recognised (both end up identical on disk):
 *   A. self-contained: <container>/node_modules/@deepseek-ai/dsh/…
 *      → <root>/core/snapshots/<ver>/node_modules/@deepseek-ai/dsh/…
 *   B. hoisted inside someone else's node_modules:
 *      <packageRoot>/@deepseek-ai/dsh/…  (dependencies sit next to it)
 *      → <root>/core/snapshots/<ver>/node_modules/…  (whole root copied)
 *
 * The module deliberately requires nothing from Electron: it works against a
 * plain root directory, which is what makes it testable by scripts/smoke-migrate.js.
 */
const fs = require('node:fs')
const path = require('node:path')

const PACKAGE_NAME = '@deepseek-ai/dsh'

/** Identity recorded in config.app.migrations. Bump when the layout changes. */
const MIGRATION_ID = 'legacy-kernel@v1'

/** Inside the package: the file dsh-launcher actually spawns. */
const ENTRY_RELATIVE = ['lib', 'bin.js']

/**
 * Places an older build could have left a kernel, relative to userData.
 * Historically these were tried before the `core/snapshots` layout existed.
 */
const LEGACY_DIRS = [
  ['core', 'current'],
  ['core', 'dsh'],
  ['core', 'kernel'],
  ['core', 'node_modules', PACKAGE_NAME],
  ['kernel'],
  ['dsh'],
  ['node_modules', PACKAGE_NAME]
]

/** Whole-tree data that belongs in DSH_HOME, never inside a kernel tree. */
const RESCUE_ENTRIES = ['profiles', 'credentials.json', 'sessions']

/** True when `child` is `parent` itself or lives underneath it. */
function isInside(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child))
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/** Read `<pkgDir>/package.json`, tolerating anything unreadable. */
function readPackage(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
  } catch {
    return null
  }
}

/**
 * Classify one candidate directory.
 *
 * A candidate is only interesting if we can point at both the package root
 * (where package.json lives) and the tree that carries its dependencies —
 * dsh is a launcher over ~522 packages, so copying the package alone would
 * produce a snapshot that cannot start.
 */
function describeCandidate({ dir, origin, packageRoots = [] }) {
  const entry = (pkgDir) => path.join(pkgDir, ...ENTRY_RELATIVE)

  // Shape A — the directory already owns a node_modules holding the kernel.
  const selfPkg = path.join(dir, 'node_modules', PACKAGE_NAME)
  if (fs.existsSync(entry(selfPkg))) {
    return { dir, pkgDir: selfPkg, entry: entry(selfPkg), copyFrom: dir, strategy: 'self-contained', origin }
  }

  // Shape B — the directory *is* the package, rooted in a hoisted node_modules.
  if (fs.existsSync(entry(dir))) {
    const packageRoot = packageRoots.map((r) => path.resolve(r)).find((r) => isInside(r, dir)) || path.dirname(dir)
    return {
      dir,
      pkgDir: dir,
      entry: entry(dir),
      copyFrom: packageRoot,
      targetSubdir: ['node_modules'],
      strategy: 'hoisted-root',
      origin
    }
  }

  return null
}

/**
 * Every plausible legacy kernel, classified but not touched further.
 *
 * @param {object} opts
 * @param {string} opts.root          userData root
 * @param {string[]} [opts.packageRoots] node_modules-like dirs that may hold @deepseek-ai/dsh
 */
function scanLegacy({ root, packageRoots = [] }) {
  const seen = new Set()
  const candidates = []

  for (const base of packageRoots) {
    candidates.push({ dir: path.join(base, PACKAGE_NAME), origin: 'bundled' })
  }
  for (const rel of LEGACY_DIRS) {
    candidates.push({ dir: path.join(root, ...rel), origin: 'userData' })
  }

  const found = []
  for (const candidate of candidates) {
    const key = path.resolve(candidate.dir)
    if (seen.has(key)) continue
    seen.add(key)

    const described = describeCandidate({ ...candidate, packageRoots })
    if (!described) continue

    const pkg = readPackage(described.pkgDir)
    found.push({ ...described, version: pkg?.version || null, package: pkg })
  }
  return found
}

/**
 * Copy `src` → `dest` without ever creating a symlink.
 *
 * Windows gates symlink creation behind admin / developer mode, and a legacy
 * tree may be pnpm-installed (full of junctions) or inside an asar.
 * Dereferencing yields plain files that can be read, served and — critically —
 * deleted again by `registry.prune()`.
 */
function copyTree(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.cpSync(src, dest, { recursive: true, dereference: true, force: true })
}

/** Atomic JSON write — same contract as ConfigStore and kernel-registry. */
function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
  fs.renameSync(tmp, file)
}

/**
 * Pull DSH_HOME data that mistakenly ended up next to a kernel back into
 * `<root>/dsh-home`.
 *
 * This is the genuinely lossy part of history: a build that pointed DSH_HOME at
 * the install directory wrote profiles, credentials and sessions beside the
 * kernel, and the moment you switch kernels that location is ignored entirely.
 * Copy-and-merge (never overwrite) means live data always wins.
 */
function rescueDshHome({ root, fromDir, log }) {
  const rescued = []
  const homeDir = path.join(root, 'dsh-home')
  // Copying the destination into itself is the one mistake worth guarding:
  // it would duplicate the entire home tree on every boot.
  if (isInside(homeDir, fromDir)) return rescued

  for (const name of RESCUE_ENTRIES) {
    const src = path.join(fromDir, name)
    if (!fs.existsSync(src)) continue

    const dest = path.join(homeDir, name)

    if (!fs.existsSync(dest)) {
      copyTree(src, dest)
      rescued.push({ name, from: src, to: dest, merged: false })
      continue
    }

    // Existing directory → merge new entries in, leave collisions alone.
    if (fs.statSync(src).isDirectory() && fs.statSync(dest).isDirectory()) {
      let copied = 0
      for (const name2 of fs.readdirSync(src)) {
        const s = path.join(src, name2)
        const d = path.join(dest, name2)
        if (fs.existsSync(d)) continue
        copyTree(s, d)
        copied += 1
      }
      if (copied > 0) rescued.push({ name, from: src, to: dest, merged: true, entries: copied })
    }
  }

  if (rescued.length && typeof log === 'function') {
    log(`已把 ${rescued.length} 项遗留数据迁移到 dsh-home`)
  }
  return rescued
}

/**
 * Run every pending migration. Safe to call on every boot.
 *
 * @param {object} opts
 * @param {string} opts.root            userData root (absolute)
 * @param {object} opts.config          ConfigStore-like: read() / write()
 * @param {string[]} [opts.packageRoots] bundled node_modules dirs to search
 * @param {number} [opts.nodeMajor]     runtime major recorded into snapshot.json
 * @param {(msg:string)=>void} [opts.log]
 */
function migrateUserData({ root, config, packageRoots = [], nodeMajor, log }) {
  const say = typeof log === 'function' ? log : () => {}
  const major = nodeMajor ?? Number(process.versions.node.split('.')[0])

  const snapshotsDir = path.join(root, 'core', 'snapshots')
  const errors = []

  const report = {
    root,
    id: MIGRATION_ID,
    scanned: [],
    adopted: [],
    skipped: [],
    rescued: [],
    errors,
    dshHomeFixed: false,
    alreadyDone: false,
    /** Something was found and deliberately left alone — worth telling the user. */
    pending: false
  }

  const cfg = config?.read?.() ?? {}
  const migrations = Array.isArray(cfg?.app?.migrations) ? cfg.app.migrations : []
  const done = migrations.filter((m) => m && m.id === MIGRATION_ID)
  report.alreadyDone = done.length > 0

  /* ---- 1. Rescue stray DSH_HOME data (invariant #4) -------------------- */

  // An old build may have recorded where its DSH_HOME used to be.
  const legacyHome = cfg?.app?.legacyDshHome
  if (legacyHome && fs.existsSync(legacyHome)) {
    report.dshHomeFixed = rescueDshHome({ root, fromDir: legacyHome, log: say }).length > 0
  }

  // Snapshots already living in core/ can carry the same leftovers.
  try {
    for (const name of fs.readdirSync(snapshotsDir)) {
      const dir = path.join(snapshotsDir, name)
      if (!fs.statSync(dir).isDirectory()) continue
      for (const rescued of rescueDshHome({ root, fromDir: dir, log: say })) {
        report.rescued.push({ ...rescued, source: dir })
        report.dshHomeFixed = true
      }
    }
  } catch {
    /* no snapshots dir yet — nothing to rescue */
  }

  /* ---- 2. Adopt legacy kernels into snapshots -------------------------- */

  report.scanned = scanLegacy({ root, packageRoots })

  for (const candidate of report.scanned) {
    try {
      const version = candidate.version

      // Rescue is independent of adoption: profiles parked next to a kernel are
      // invisible no matter what we decide about the kernel itself. Check the
      // container *and* the package itself — either could have been DSH_HOME.
      for (const fromDir of new Set([candidate.dir, candidate.pkgDir])) {
        for (const rescued of rescueDshHome({ root, fromDir, log: say })) {
          report.rescued.push({ ...rescued, source: fromDir })
        }
      }

      if (!version) {
        report.skipped.push({ dir: candidate.dir, reason: '无法读取 package.json，跳过' })
        continue
      }

      const target = path.join(snapshotsDir, version)
      const targetPkg = path.join(target, 'node_modules', PACKAGE_NAME)

      if (fs.existsSync(target)) {
        report.skipped.push({ dir: candidate.dir, version, reason: `快照 ${version} 已存在，保留原样` })
        continue
      }

      if (report.alreadyDone && done.some((m) => Array.isArray(m.versions) && m.versions.includes(version))) {
        report.skipped.push({ dir: candidate.dir, version, reason: '本轮迁移已处理过，跳过' })
        continue
      }

      // Never copy a directory into itself.
      if (isInside(candidate.copyFrom, target)) {
        report.skipped.push({ dir: candidate.dir, version, reason: '候选目录已是目标快照，跳过' })
        continue
      }

      // Shape B copies a bare node_modules root, so it needs one extra level to
      // land at snapshots/<version>/node_modules/<pkg>.
      const dest = candidate.targetSubdir ? path.join(target, ...candidate.targetSubdir) : target
      copyTree(candidate.copyFrom, dest)

      // The copy must actually produce a bootable layout. If it does not, undo
      // it rather than leaving a snapshot that can never pass a smoke test.
      if (!fs.existsSync(path.join(targetPkg, ...ENTRY_RELATIVE))) {
        fs.rmSync(target, { recursive: true, force: true, maxRetries: 3 })
        throw new Error(`复制后仍缺少入口 ${PACKAGE_NAME}/lib/bin.js，已回滚`)
      }

      writeJsonAtomic(path.join(target, 'snapshot.json'), {
        version,
        dirVersion: version,
        packageVersion: version,
        installedAt: new Date().toISOString(),
        nodeMajor: major,
        migrated: true,
        migration: MIGRATION_ID,
        source: candidate.dir,
        origin: candidate.origin,
        strategy: candidate.strategy,
        // No integrity or registry: this tree predates both being recorded.
        integrity: null,
        registry: null
      })

      const adopted = {
        from: candidate.dir,
        version,
        to: target,
        origin: candidate.origin,
        strategy: candidate.strategy,
        activated: false
      }
      report.adopted.push(adopted)
      say(`已采纳遗留内核 ${version}（${candidate.strategy}）→ ${target}`)

      // Only claim the pointer when nothing else has a better claim: an
      // already-working currentVersion must never be downgraded by migration.
      const current = config?.read?.()?.kernel?.currentVersion
      const currentDir = current ? path.join(snapshotsDir, current) : null
      if (!current || !fs.existsSync(currentDir)) {
        config?.write?.({ kernel: { currentVersion: version } })
        adopted.activated = true
      }
    } catch (err) {
      // One bad directory must not abort the rest, and migration must never be
      // fatal to boot — it is best-effort by definition.
      errors.push({ dir: candidate.dir, error: err.message })
      report.skipped.push({ dir: candidate.dir, reason: `迁移失败：${err.message}` })
    }
  }

  /* ---- 3. Record it ---------------------------------------------------- */

  if (report.adopted.length > 0 || report.rescued.length > 0) {
    config?.write?.({
      app: {
        migrations: [
          ...migrations,
          {
            id: MIGRATION_ID,
            at: new Date().toISOString(),
            versions: report.adopted.map((a) => a.version),
            rescued: report.rescued.map((r) => r.name)
          }
        ]
      }
    })
  }

  report.pending = report.scanned.length > 0 && report.adopted.length === 0

  return report
}

module.exports = {
  migrateUserData,
  scanLegacy,
  describeCandidate,
  rescueDshHome,
  copyTree,
  isInside,
  LEGACY_DIRS,
  RESCUE_ENTRIES,
  ENTRY_RELATIVE,
  MIGRATION_ID,
  PACKAGE_NAME
}
