#!/usr/bin/env node
/**
 * 内核自动更新的规则冒烟（需要 Electron，因为 paths / config 依赖它）。
 *
 *   npm run smoke:autoupdate
 *
 * 这里验的是**决策**，不是下载：
 *   - 什么情况下装（无内核 / 有更新 / 同通道预发布）
 *   - 什么情况下跳过（已是最新 / 远端更旧 / pinned / 跨预发布通道 / 开关关闭）
 *   - 失败怎么退（网络类退避重试、校验类不重试）
 *   - 并发怎么让（第二次直接 busy，不排队）
 * 真正的下载在 smoke:install / 手工点「下载并安装」那条链路上验。
 */
'use strict'

const { app } = require('electron')

const { paths } = require('../src/main/paths')
const { ConfigStore } = require('../src/main/config-store')
const { KernelRegistry } = require('../src/main/plugins/backup-roll/kernel-registry')
const { KernelPackageManager } = require('../src/main/plugins/backup-roll/kernel-package-manager')
const { KernelAutoUpdater, RESULT } = require('../src/main/plugins/backup-roll/kernel-auto-update')
const { compareSemver, isNewer, isPrerelease, prereleaseChannel } = require('../src/main/plugins/backup-roll/semver')

let passed = 0
let failed = 0

function check(name, ok, detail) {
  if (ok) {
    passed += 1
    console.log(`  ✓ ${name}`)
  } else {
    failed += 1
    console.log(`  ✗ ${name}${detail ? `  → ${detail}` : ''}`)
  }
}

/** 造一个不联网的自动更新器：latest 由 fake 提供，installAndActivate 记录调用。 */
function makeUpdater({ latest, current, cfg = {}, failCheck = null, installThrows = null }) {
  const calls = []
  const state = { ...cfg }
  const config = {
    read: () => ({ kernel: { mode: 'auto', pinnedVersion: null, autoUpdate: true, registry: 'https://example.com', ...state } }),
    write: () => {}
  }
  const registry = { currentVersion: current || null }
  const manager = {
    client: {
      latest: async () => {
        if (failCheck) throw failCheck
        return { version: latest, integrity: null, engines: null, distTags: { latest } }
      }
    }
  }
  const updater = new KernelAutoUpdater({
    config,
    registry,
    manager,
    installAndActivate: async (version) => {
      calls.push(version)
      if (installThrows) throw installThrows
      return { version }
    },
    onEvent: () => {}
  })
  return { updater, calls, config }
}

async function main() {
  console.log('\n[1] 版本比对规则')
  check('正式版相同 → 相等', compareSemver('1.2.3', '1.2.3') === 0)
  check('patch 更大 → 更新', isNewer('1.2.4', '1.2.3'))
  check('1.0.10 > 1.0.9（不是字符串比较）', isNewer('1.0.10', '1.0.9'))
  check('正式版 > 同 core 的 rc', isNewer('1.0.0', '1.0.0-rc.1'))
  check('rc.2 > rc.1', isNewer('1.0.0-rc.2', '1.0.0-rc.1'))
  check('预发布识别', isPrerelease('0.1.5-rc.1') && !isPrerelease('1.0.0'))
  check('通道识别 rc / alpha', prereleaseChannel('0.1.5-rc.1') === 'rc' && prereleaseChannel('0.1.6-alpha.1') === 'alpha')

  console.log('\n[2] 决策：该装')
  {
    const { updater, calls } = makeUpdater({ latest: '0.1.6-rc.1', current: '0.1.5-rc.1' })
    const r = await updater.check({ trigger: 'scheduled' })
    check('有更新 → 自动安装', r.result === RESULT.updated && calls[0] === '0.1.6-rc.1', JSON.stringify(r))
    check('记录 from → to', updater.snapshot().updatedFrom === '0.1.5-rc.1' && updater.snapshot().updatedTo === '0.1.6-rc.1')
  }
  {
    const { updater, calls } = makeUpdater({ latest: '0.1.5-rc.1', current: null })
    const r = await updater.check({ trigger: 'startup' })
    check('没有内核 → 首次安装', r.result === RESULT.installed && calls.length === 1, JSON.stringify(r))
  }

  console.log('\n[3] 决策：该跳过')
  {
    const { updater, calls } = makeUpdater({ latest: '0.1.5-rc.1', current: '0.1.5-rc.1' })
    const r = await updater.check({})
    check('已是最新 → 不装', r.result === RESULT.skipped && calls.length === 0, JSON.stringify(r))
  }
  {
    const { updater, calls } = makeUpdater({ latest: '0.1.4-rc.9', current: '0.1.5-rc.1' })
    const r = await updater.check({})
    check('远端更旧 → 不自动降级', r.result === RESULT.skipped && /不自动降级/.test(r.reason || ''), JSON.stringify(r))
  }
  {
    const { updater, calls } = makeUpdater({ latest: '0.1.6-rc.1', current: '0.1.5-rc.1', cfg: { mode: 'pinned', pinnedVersion: '0.1.5-rc.1' } })
    const r = await updater.check({})
    check('固定版本模式 → 只报告', r.result === RESULT.skipped && /固定版本/.test(r.reason || ''), JSON.stringify(r))
  }
  {
    const { updater, calls } = makeUpdater({ latest: '0.1.6-alpha.1', current: '0.1.5-rc.1' })
    const r = await updater.check({})
    check('跨预发布通道（rc → alpha）→ 需人工', r.result === RESULT.skipped && /通道/.test(r.reason || ''), JSON.stringify(r))
  }
  {
    // 目标必须「确实更新」且是预发布：1.1.0-rc.1 > 1.0.0（1.0.0-rc.1 是降级，
    // 会先被「不自动降级」拦下，测不到这条规则）。
    const { updater, calls } = makeUpdater({ latest: '1.1.0-rc.1', current: '1.0.0' })
    const r = await updater.check({})
    check('正式版不自动跳预发布', r.result === RESULT.skipped && /预发布/.test(r.reason || ''), JSON.stringify(r))
  }
  {
    const { updater, calls } = makeUpdater({ latest: '0.1.6-rc.1', current: '0.1.5-rc.1', cfg: { autoUpdate: false } })
    const r = await updater.check({})
    check('开关关闭 → 提示但不装', r.result === RESULT.skipped && r.pending === true && calls.length === 0, JSON.stringify(r))
  }

  console.log('\n[4] 失败处理')
  {
    const { updater } = makeUpdater({ latest: '0.1.6-rc.1', current: '0.1.5-rc.1', failCheck: new Error('请求 registry 失败（x）：ETIMEDOUT') })
    updater.timers.scheduled = null
    const r = await updater.check({})
    check('网络类失败 → 标记 failed 且可重试', r.result === RESULT.failed && r.retryable === true, JSON.stringify(r))
    check('并排了退避重试', updater.timers.retry !== null)
    updater.stop()
  }
  {
    const { updater } = makeUpdater({ latest: '0.1.6-rc.1', current: '0.1.5-rc.1', failCheck: new Error('VERIFY_FAILED 安装版本不符') })
    const r = await updater.check({})
    check('校验类失败 → 不自动重试', r.result === RESULT.failed && r.retryable === false, JSON.stringify(r))
    check('也没有排退避定时器', !updater.timers.retry)
  }
  {
    // 安装失败（比如冒烟没过）也必须落到 failed，且当前内核不变
    const { updater } = makeUpdater({
      latest: '0.1.6-rc.1',
      current: '0.1.5-rc.1',
      installThrows: new Error('SMOKE_FAILED 新内核未能启动')
    })
    const r = await updater.check({})
    check('安装失败 → failed，当前内核未变', r.result === RESULT.failed && updater.snapshot().updatedTo === null, JSON.stringify(r))
  }

  console.log('\n[5] 并发与开关')
  {
    const { updater } = makeUpdater({ latest: '0.1.6-rc.1', current: '0.1.5-rc.1' })
    let release
    const gate = new Promise((resolve) => { release = resolve })
    updater.installAndActivate = async () => { await gate; return { version: '0.1.6-rc.1' } }
    const p1 = updater.check({})
    const p2 = updater.check({})
    const r2 = await p2
    check('并发第二次 → busy（不排队死等）', r2.result === RESULT.busy, JSON.stringify(r2))
    release()
    await p1
  }
  {
    const { updater } = makeUpdater({ latest: '0.1.6-rc.1', current: '0.1.5-rc.1' })
    updater.setEnabled(false)
    check('关闭后 snapshot.enabled=false', updater.snapshot().enabled === false)
    updater.setEnabled(true)
    check('开启后 snapshot.enabled=true', updater.snapshot().enabled === true)
  }

  console.log('\n[6] 与真实 registry 的一次连通性（可选）')
  {
    const config = new ConfigStore(paths.configFile(), paths.lockFile())
    const registry = new KernelRegistry({
      snapshotsDir: paths.snapshots(),
      stagingDir: paths.staging(),
      config
    })
    const manager = new KernelPackageManager({ registry, config })
    try {
      const latest = await manager.client.latest()
      check(`拿到远端 latest = ${latest.version}`, !!latest.version)
    } catch (err) {
      // 离线不算失败：规则已经在上面验过了，这里只是顺带看一眼真实网络。
      console.log(`  · 跳过（离线）：${err.message}`)
    }
  }
}

app.whenReady().then(async () => {
  try {
    await main()
  } catch (err) {
    failed += 1
    console.log('  ✗ 未预期的异常：', err.stack || err.message)
  }
  console.log(`\n${'-'.repeat(52)}`)
  console.log(`内核自动更新规则：${passed} 通过 / ${failed} 失败`)
  app.quit(failed === 0 ? 0 : 1)
})
