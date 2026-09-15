/**
 * Phase-2 smoke test — proves the *management* layer works, not the kernel.
 *
 * Phase 1 proved a snapshot can boot (smoke:kernel). This proves the parts
 * around it: registry metadata, the two bandwidth channels, the plugin
 * manifest and the rollback inventory. It deliberately does NOT run a full
 * install — that is slow and already covered by seed:core — but it does
 * exercise every code path the UI touches.
 *
 * Run: npm run smoke:phase2
 */
const path = require('node:path')

const { paths, ensureDirectories } = require('../src/main/paths')
const { ConfigStore } = require('../src/main/config-store')
const { KernelRegistry } = require('../src/main/plugins/backup-roll/kernel-registry')
const { KernelPackageManager } = require('../src/main/plugins/backup-roll/kernel-package-manager')
const { PluginManager, BUILTIN_PLUGIN } = require('../src/main/plugins/backup-roll/plugin-manage')
const { ThrottleProxy } = require('../src/main/plugins/backup-roll/throttle-proxy')
const { app } = require('electron')

const results = []

function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then((value) => {
      results.push({ name, ok: true, value })
      console.log(`  PASS  ${name}${value ? ` — ${value}` : ''}`)
      return value
    })
    .catch((err) => {
      results.push({ name, ok: false, error: err.message })
      console.log(`  FAIL  ${name} — ${err.message}`)
      return null
    })
}

async function main() {
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

  console.log('\n[1] 本地快照')
  await check('至少一个 ready 快照', () => {
    const ready = registry.listSnapshots().filter((s) => s.status === 'ready')
    if (ready.length === 0) throw new Error('没有 ready 快照，请先运行 npm run seed:core')
    return `${ready.length} 个：${ready.map((s) => s.version).join(', ')}`
  })
  await check('registry.resolve() 返回可启动内核', () => {
    const k = registry.resolve()
    if (!k.entryExists) throw new Error('入口文件不存在')
    return `${k.version} (${k.source})`
  })

  console.log('\n[2] 远端元数据')
  await check('checkLatest() 返回版本号', async () => {
    const info = await kernelManager.checkLatest()
    if (!info.latest) throw new Error('未返回 latest')
    return `latest=${info.latest} current=${info.current} outdated=${info.outdated}`
  })
  await check('listAvailable() 离线可降级', async () => {
    const info = await kernelManager.listAvailable()
    if (!Array.isArray(info.items)) throw new Error('items 不是数组')
    return `${info.items.length} 个本地快照，latest=${info.latest || info.latestError}`
  })

  console.log('\n[3] 限速通道')
  await check('内核/插件两条通道端口不同', async () => {
    const a = await proxies.kernel.listen()
    const b = await proxies.plugin.listen()
    if (a === b) throw new Error('两条通道监听同一端口')
    return `kernel=${a} plugin=${b}`
  })
  await check('setLimit 可动态改速率', () => {
    proxies.kernel.setLimit(512)
    proxies.plugin.setLimit(128)
    if (proxies.kernel.bytesPerSec !== 512 * 1024) throw new Error('内核速率未生效')
    if (proxies.plugin.bytesPerSec !== 128 * 1024) throw new Error('插件速率未生效')
    proxies.kernel.setLimit(0)
    proxies.plugin.setLimit(0)
    return '512KB/s 与 128KB/s 独立设置成功'
  })

  console.log('\n[4] 插件与回滚清单')
  await check('内置插件 backup-roll 存在', () => {
    const list = plugins.list()
    const builtin = list.plugins.find((p) => p.id === BUILTIN_PLUGIN.id)
    if (!builtin) throw new Error('manifest 缺少内置插件')
    if (!builtin.builtin) throw new Error('内置插件未标记为 builtin')
    return `plugins=${list.plugins.length}`
  })
  await check('内置插件不可卸载', async () => {
    try {
      await plugins.uninstall(BUILTIN_PLUGIN.id)
    } catch (err) {
      if (err.code === 'PLUGIN_BUILTIN') return '已拒绝（PLUGIN_BUILTIN）'
      throw err
    }
    throw new Error('卸载内置插件居然成功了')
  })
  await check('syncKernelSnapshots() 写入清单', () => {
    const snaps = plugins.syncKernelSnapshots()
    const manifest = plugins.read()
    if (manifest.kernelSnapshots.length !== snaps.length) throw new Error('清单与快照数量不一致')
    return `${snaps.length} 条`
  })
  await check('历史记录写入并可回放', () => {
    plugins.recordHistory({ action: 'smoke', from: 'a', to: 'b' })
    const list = plugins.list()
    const last = list.history[0]
    if (!last || last.action !== 'smoke') throw new Error('历史未写入')
    if (last.from !== 'a' || last.to !== 'b') throw new Error('历史字段丢失')
    return `${list.history.length} 条`
  })
  await check('rollbackCandidates() 排除当前版本', () => {
    const cands = plugins.rollbackCandidates()
    const current = config.read().kernel.currentVersion
    if (cands.some((c) => c.dirVersion === current)) throw new Error('候选里包含了当前版本')
    return cands.length ? cands.map((c) => c.dirVersion).join(', ') : '（无其他可用快照，符合预期）'
  })

  console.log('\n[5] 并发保护')
  await check('同一时间只允许一个更新任务', async () => {
    let second = null
    await config.withLock(async () => {
      second = await config.withLock(() => '不应该执行到这里').catch((err) => err)
    })
    if (!second || second.code !== 'UPDATE_BUSY') throw new Error('第二个任务没有被拒绝')
    return 'UPDATE_BUSY 正确抛出'
  })

  console.log('\n[6] 清单文件')
  await check('plugin-manifest.json 已落盘', () => {
    const file = paths.manifestFile()
    // eslint-disable-next-line global-require
    const raw = JSON.parse(require('node:fs').readFileSync(file, 'utf8'))
    if (!raw.plugins?.length) throw new Error('清单没有插件')
    return file
  })

  const failed = results.filter((r) => !r.ok)
  console.log(`\n[smoke] 结果: ${results.length - failed.length}/${results.length} 通过`)
  if (failed.length) {
    console.log('[smoke] 失败项：')
    for (const f of failed) console.log(`  - ${f.name}: ${f.error}`)
  }
  return failed.length ? 1 : 0
}

app.whenReady().then(async () => {
  let code = 1
  try {
    code = await main()
  } catch (err) {
    console.error('[smoke] 异常:', err.stack || err.message)
  }
  proxiesCleanup()
  app.quit(code)
})

function proxiesCleanup() {
  // Nothing global to close here; kept explicit so a future leak is obvious.
}
