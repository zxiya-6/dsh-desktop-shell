/**
 * Kernel smoke test — proves the dynamic kernel actually boots.
 *
 * Run: npm run smoke:kernel
 *
 * This is the check that decides whether the whole dynamic-kernel design is
 * viable: resolve a snapshot from userData, start it with the same flags the
 * real launcher uses (ELECTRON_RUN_AS_NODE + --expose-internals), and confirm
 * it prints an authenticated URL and answers HTTP on it.
 *
 * No GUI, no window — safe to run headless.
 */
const { paths, ensureDirectories } = require('../src/main/paths')
const { ConfigStore } = require('../src/main/config-store')
const { KernelRegistry } = require('../src/main/plugins/backup-roll/kernel-registry')
const { KernelPackageManager } = require('../src/main/plugins/backup-roll/kernel-package-manager')
const { app } = require('electron')

async function main() {
  ensureDirectories()

  const config = new ConfigStore(paths.configFile(), paths.lockFile())
  const registry = new KernelRegistry({
    snapshotsDir: paths.snapshots(),
    stagingDir: paths.staging(),
    config
  })
  const manager = new KernelPackageManager({ registry, config })

  let kernel
  try {
    kernel = registry.resolve()
  } catch (err) {
    console.error(`[smoke] 无法解析内核（${err.code}）：${err.message}`)
    console.error(`[smoke] 请先运行: npm run seed:core -- 0.1.5-rc.1`)
    return 1
  }

  console.log(`[smoke] 内核目录   : ${kernel.dir}`)
  console.log(`[smoke] 内核入口   : ${kernel.entry}`)
  console.log(`[smoke] 兼容性     : ${kernel.status}${kernel.enginesAssumed ? '（未声明 engines，按 Node>=24）' : ''}`)
  console.log(`[smoke] 运行时 Node: ${process.versions.node}`)
  if (kernel.degraded?.length) {
    console.log(`[smoke] 降级信息   : ${JSON.stringify(kernel.degraded)}`)
  }

  console.log('[smoke] 正在预启动（随机端口，等待 token 与就绪探测）…')
  const result = await manager.smokeTest(kernel.entry, { cwd: kernel.dir })

  if (result.ok) {
    console.log(`[smoke] PASS — 内核已就绪: ${result.url}`)
    return 0
  }
  console.error(`[smoke] FAIL — ${result.reason}`)
  if (result.tail) console.error(`[smoke] 输出尾部:\n${result.tail}`)
  return 1
}

app.whenReady().then(async () => {
  let code = 1
  try {
    code = await main()
  } catch (err) {
    console.error('[smoke] 异常:', err.message)
  }
  app.quit(code)
})
