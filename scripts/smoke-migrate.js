/**
 * Migration smoke test — proves legacy layouts survive an upgrade.
 *
 * Deliberately runs on plain `node` (not `electron`): src/main/migrate.js
 * requires nothing from Electron, so any contributor can run it without a
 * display and without the app booting.
 *
 * Run: npm run smoke:migrate
 *
 * What it pins down:
 *   1. a bundled kernel (installer layout) gets adopted into core/snapshots
 *   2. a userData-side legacy dir (<root>/core/dsh) gets adopted too
 *   3. an existing snapshot is never overwritten (rollback data is sacred)
 *   4. stray DSH_HOME data parked inside the kernel is rescued, never clobbered
 *   5. running twice is a no-op (idempotent)
 *   6. a broken candidate (no package.json) is skipped instead of throwing
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')

const { migrateUserData, scanLegacy, MIGRATION_ID } = require('../src/main/migrate')

const PACKAGE_NAME = '@deepseek-ai/dsh'

let passed = 0
let failed = 0

function check(name, fn) {
  try {
    const value = fn()
    passed += 1
    console.log(`  PASS  ${name}${value ? ` — ${value}` : ''}`)
  } catch (err) {
    failed += 1
    console.log(`  FAIL  ${name} — ${err.message}`)
  }
}

/** Minimal stand-in for ConfigStore: same read/write surface, no Electron. */
function fakeConfig(file) {
  let cache = null
  const read = () => {
    if (cache) return cache
    try {
      cache = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      cache = { version: 1, kernel: { currentVersion: null }, app: { migrations: [] } }
    }
    return cache
  }
  const merge = (base, patch) => {
    const out = Array.isArray(base) ? [...base] : { ...base }
    for (const [k, v] of Object.entries(patch || {})) {
      out[k] = v && typeof v === 'object' && !Array.isArray(v) && typeof out[k] === 'object' && out[k]
        ? merge(out[k], v)
        : v
    }
    return out
  }
  return {
    read,
    write(patch) {
      cache = merge(read(), patch)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, JSON.stringify(cache, null, 2), 'utf8')
      return cache
    }
  }
}

/** Write a plausible legacy kernel tree: package.json + entry + stray profile. */
function makeLegacyKernel(dir, version, { withProfiles = false, profileName = 'default' } = {}) {
  fs.mkdirSync(path.join(dir, 'lib'), { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: PACKAGE_NAME, version }, null, 2)
  )
  fs.writeFileSync(path.join(dir, 'lib', 'bin.js'), '// placeholder entry\n')
  if (withProfiles) {
    fs.mkdirSync(path.join(dir, 'profiles', profileName, 'node_modules', 'demo-plugin'), {
      recursive: true
    })
    fs.writeFileSync(path.join(dir, 'profiles', profileName, 'node_modules', 'demo-plugin', 'index.js'), '')
    fs.writeFileSync(
      path.join(dir, 'profiles', profileName, 'marker.txt'),
      `legacy-${profileName}`
    )
  }
  return dir
}

/** Fresh sandbox for one scenario. */
function scenario(name) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-migrate-'))
  const root = path.join(tmp, 'userData')
  fs.mkdirSync(root, { recursive: true })
  console.log(`\n[${name}]`)
  return { tmp, root, config: fakeConfig(path.join(root, 'config.json')) }
}

/* ------------------------------------------------------------------ *
 * 1. Bundled installer layout → snapshot
 * ------------------------------------------------------------------ */
{
  const { root, config } = scenario('1. 内置布局（node_modules/@deepseek-ai/dsh）')

  const bundled = path.join(root, '..', 'resources', 'app.asar.unpacked', 'node_modules')
  makeLegacyKernel(path.join(bundled, PACKAGE_NAME), '0.1.5-rc.1')
  fs.mkdirSync(path.join(root, 'core', 'snapshots'), { recursive: true })

  const report = migrateUserData({ root, config, packageRoots: [bundled], nodeMajor: 24 })

  check('扫描到内置内核', () => {
    assert.equal(report.scanned.length, 1)
    return report.scanned[0].version
  })
  check('收养为快照并设置 currentVersion', () => {
    assert.equal(report.adopted.length, 1)
    assert.equal(config.read().kernel.currentVersion, '0.1.5-rc.1')
    const entry = path.join(root, 'core', 'snapshots', '0.1.5-rc.1', 'node_modules', PACKAGE_NAME, 'lib', 'bin.js')
    assert.ok(fs.existsSync(entry), '入口文件应随树一起搬过来')
    return '1 个'
  })
  check('snapshot.json 写入且标记 migrated', () => {
    const meta = JSON.parse(
      fs.readFileSync(path.join(root, 'core', 'snapshots', '0.1.5-rc.1', 'snapshot.json'), 'utf8')
    )
    assert.equal(meta.version, '0.1.5-rc.1')
    assert.equal(meta.migration, MIGRATION_ID)
    return `nodeMajor=${meta.nodeMajor}`
  })
  check('迁移被记录（可重复）', () => {
    const list = config.read().app.migrations
    assert.equal(list.length, 1)
    assert.equal(list[0].id, MIGRATION_ID)
    return list[0].versions.join(',')
  })
  check('第二次运行是空操作（幂等）', () => {
    const second = migrateUserData({ root, config, packageRoots: [bundled], nodeMajor: 24 })
    assert.equal(second.adopted.length, 0, '不应重复收养')
    return `scanned=${second.scanned.length} skipped=${second.skipped.length}`
  })
}

/* ------------------------------------------------------------------ *
 * 2. userData-side legacy dir + existing snapshot protection
 * ------------------------------------------------------------------ */
{
  const { root, config } = scenario('2. userData 侧遗留目录 & 快照不被覆盖')

  const legacy = makeLegacyKernel(
    path.join(root, 'core', 'dsh', 'node_modules', PACKAGE_NAME),
    '0.1.4-rc.2',
    { withProfiles: true, profileName: 'legacy' }
  )
  // A snapshot that already exists must win — never overwrite existing data.
  const existing = path.join(root, 'core', 'snapshots', '0.1.4-rc.2')
  fs.mkdirSync(path.join(existing, 'node_modules', PACKAGE_NAME, 'lib'), { recursive: true })
  fs.writeFileSync(path.join(existing, 'node_modules', PACKAGE_NAME, 'lib', 'bin.js'), '// existing\n')
  fs.writeFileSync(path.join(existing, 'CANARY.txt'), 'do not touch')

  const report = migrateUserData({ root, config })

  check('已存在同名快照时跳过', () => {
    assert.equal(report.adopted.length, 0)
    assert.ok(report.skipped.some((s) => s.reason.includes('已存在')))
    return report.skipped[0].reason
  })
  check('既有快照内容未被改动', () => {
    assert.ok(fs.existsSync(path.join(existing, 'CANARY.txt')))
    assert.equal(
      fs.readFileSync(path.join(existing, 'node_modules', PACKAGE_NAME, 'lib', 'bin.js'), 'utf8'),
      '// existing\n'
    )
    return 'CANARY 存活'
  })
  check('遗留树仍在原位（不删除用户文件）', () => {
    assert.ok(fs.existsSync(path.join(legacy, 'lib', 'bin.js')))
    return '原树保留'
  })
  check('内核目录里的 profiles 被救回 dsh-home', () => {
    const rescuedDir = path.join(root, 'dsh-home', 'profiles', 'legacy')
    assert.ok(fs.existsSync(rescuedDir), 'profiles/legacy 应落在 dsh-home 下')
    assert.equal(
      fs.readFileSync(path.join(rescuedDir, 'marker.txt'), 'utf8'),
      'legacy-legacy'
    )
    assert.ok(fs.existsSync(path.join(legacy, 'profiles', 'legacy')), '源文件不应被移走')
    return 'copy + keep'
  })
}

/* ------------------------------------------------------------------ *
 * 3. Rescue merge semantics: existing data wins
 * ------------------------------------------------------------------ */
{
  const { root, config } = scenario('3. 抢救合并：已有数据优先')

  // Home already has a profile with the same name but different content.
  const homeProfile = path.join(root, 'dsh-home', 'profiles', 'default')
  fs.mkdirSync(homeProfile, { recursive: true })
  fs.writeFileSync(path.join(homeProfile, 'marker.txt'), 'live')

  makeLegacyKernel(path.join(root, 'core', 'current', 'node_modules', PACKAGE_NAME), '0.1.3', {
    withProfiles: true,
    profileName: 'default'
  })

  migrateUserData({ root, config })

  check('同名 profile 不被覆盖', () => {
    assert.equal(fs.readFileSync(path.join(homeProfile, 'marker.txt'), 'utf8'), 'live')
    return 'live 保留'
  })
  check('已收养的内核变成 current', () => {
    assert.equal(config.read().kernel.currentVersion, '0.1.3')
    return '0.1.3'
  })
}

/* ------------------------------------------------------------------ *
 * 4. Broken candidates: skip, never throw
 * ------------------------------------------------------------------ */
{
  const { root, config } = scenario('4. 残缺候选：跳过而非抛出')

  // Legacy layout, but with the package's own package.json missing.
  const dir = path.join(root, 'core', 'dsh', 'node_modules', PACKAGE_NAME)
  fs.mkdirSync(path.join(dir, 'lib'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'lib', 'bin.js'), '')

  const found = scanLegacy({ root })
  check('无 package.json 的目录仍被扫描到', () => {
    assert.equal(found.length, 1)
    assert.equal(found[0].version, null)
    return 'version=null'
  })
  check('迁移跳过并记录原因', () => {
    const report = migrateUserData({ root, config })
    assert.equal(report.adopted.length, 0)
    assert.ok(report.skipped.some((s) => s.reason.includes('无法读取 package.json')))
    return report.skipped[0].reason
  })
}

/* ------------------------------------------------------------------ *
 * 5. Empty machine: nothing to do, nothing broken
 * ------------------------------------------------------------------ */
{
  const { root, config } = scenario('5. 全新机器：零副作用')

  const report = migrateUserData({ root, config })
  check('无遗留布局时不做任何写操作', () => {
    assert.equal(report.scanned.length, 0)
    assert.equal(report.adopted.length, 0)
    assert.equal(report.errors.length, 0)
    return 'clean'
  })
}

/* ------------------------------------------------------------------ *
 * 6. App updater gating: dormant until somebody ships a release
 * ------------------------------------------------------------------ */
{
  const { tmp, config } = scenario('6. 应用自更新的启用门槛')

  const { AppUpdater } = require('../src/main/app-updater')
  const app = { isPackaged: false, getVersion: () => '0.1.0' }
  const updater = new AppUpdater({ config, app })

  check('开发态一律不检查更新', () => {
    assert.equal(updater.availability().ok, false)
    assert.equal(updater.snapshot().status, 'idle')
    return updater.availability().reason
  })

  check('打包但未配置源 → 仍停用', () => {
    app.isPackaged = true
    assert.equal(updater.availability().ok, false)
    assert.ok(updater.snapshot().reason.includes('updateUrl'))
    return updater.snapshot().reason
  })

  check('更新源拒绝非 http(s)', () => {
    assert.throws(() => updater.setUpdateUrl('file:///tmp/updates'), /http\(s\)/)
    assert.throws(() => updater.setUpdateUrl('not-a-url'), /http\(s\)/)
    return 'file:// 与非 URL 均被拒'
  })

  check('配置合法源后启用', () => {
    const state = updater.setUpdateUrl('https://example.com/desktop-updates')
    assert.equal(state.enabled, true)
    assert.equal(updater.availability().ok, true)
    return state.updateUrl
  })

  fs.rmSync(tmp, { recursive: true, force: true })
}

console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} — ${passed} passed, ${failed} failed\n`)
process.exit(failed === 0 ? 0 : 1)
