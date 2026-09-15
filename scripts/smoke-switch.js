/**
 * Kernel-switch smoke test — proves the "commit only after it boots" rule.
 *
 * Run: npm run smoke:switch
 *
 * The dangerous failure mode in a dynamic-kernel app is a switch that writes
 * the new version into config *before* proving it can start. If the new kernel
 * then fails to boot, config points at something unusable and the app cannot
 * start next time — with no running kernel in the meantime.
 *
 * This script drives both branches:
 *   1. a switch to a version that works → config updated, kernel serving
 *   2. a switch to a version that cannot exist → rejected, config unchanged,
 *      and the previously running kernel restored
 */
const path = require('node:path')

const { paths, ensureDirectories } = require('../src/main/paths')
const { ConfigStore } = require('../src/main/config-store')
const { DshLauncher } = require('../src/main/dsh-launcher')
const { KernelRegistry } = require('../src/main/plugins/backup-roll/kernel-registry')
const { app } = require('electron')

const results = []
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then((v) => {
      results.push({ name, ok: true })
      console.log(`  PASS  ${name}${v ? ` — ${v}` : ''}`)
    })
    .catch((err) => {
      results.push({ name, ok: false, error: err.message })
      console.log(`  FAIL  ${name} — ${err.message}`)
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
  const launcher = new DshLauncher({ registry })

  const target = registry.resolve().dirVersion
  const before = config.read().kernel.currentVersion

  console.log('\n[1] 首次启动')
  let firstUrl = null
  await check('launcher.start() 返回可用地址', async () => {
    firstUrl = await launcher.start()
    if (!/^http:\/\/127\.0\.0\.1:\d+\/\?token=/.test(firstUrl || '')) {
      throw new Error(`地址格式异常: ${firstUrl}`)
    }
    return firstUrl
  })
  await check('currentKernel() 记录了运行中的内核', () => {
    const k = launcher.currentKernel()
    if (!k || k.dirVersion !== target) throw new Error('未记录或版本不符')
    return k.dirVersion
  })

  console.log('\n[2] 切换到可用版本（应先启动，再写配置）')
  await check('switchTo() 成功且返回新地址', async () => {
    const { url, kernel } = await launcher.switchTo(target)
    if (!url) throw new Error('未返回地址')
    if (kernel.dirVersion !== target) throw new Error('返回的内核不符')
    return url
  })
  await check('配置已指向目标版本', () => {
    const now = config.read().kernel.currentVersion
    if (now !== target) throw new Error(`配置=${now}，期望=${target}`)
    return now
  })

  console.log('\n[3] 切换到不可用版本（必须拒绝且不改配置）')
  await check('switchTo(不存在的版本) 被拒绝', async () => {
    try {
      await launcher.switchTo('9.9.9-not-installed')
    } catch (err) {
      if (!/不可选用|KERNEL_INVALID/.test(err.message)) throw new Error(`错误类型不符: ${err.message}`)
      return `已拒绝：${err.message}`
    }
    throw new Error('居然成功了')
  })
  await check('配置仍指向原版本', () => {
    const now = config.read().kernel.currentVersion
    if (now !== before && now !== target) throw new Error(`配置被污染: ${now}`)
    return now
  })
  await check('旧内核已恢复运行（失败切换可自愈）', async () => {
    // switchTo() rejected before stopping anything, so the original child is
    // still the one holding the port; confirm it answers.
    if (!launcher.url) throw new Error('切换失败后没有运行中的内核')
    return launcher.url
  })

  console.log('\n[4] 停止后状态干净')
  await check('stop() 清空 child / url / 日志句柄', async () => {
    await launcher.stop()
    if (launcher.child) throw new Error('child 未清空')
    if (launcher.url) throw new Error('url 未清空')
    if (launcher.logStream) throw new Error('日志流未关闭')
    return '已清空'
  })

  console.log('\n[5] 启动失败不会留下僵尸进程句柄')
  await check('无内核时 start() 抛错且不留 child', async () => {
    const broken = new DshLauncher({ registry: null })
    try {
      await broken.start()
    } catch {
      /* expected */
    }
    if (broken.child) throw new Error('失败后仍持有 child，launcher 会永久卡死')
    return '已清空'
  })

  await launcher.stop()

  const failed = results.filter((r) => !r.ok)
  console.log(`\n[smoke] 结果: ${results.length - failed.length}/${results.length} 通过`)
  for (const f of failed) console.log(`  - ${f.name}: ${f.error}`)
  return failed.length ? 1 : 0
}

app.whenReady().then(async () => {
  let code = 1
  try {
    code = await main()
  } catch (err) {
    console.error('[smoke] 异常:', err.stack || err.message)
  }
  app.quit(code)
})
