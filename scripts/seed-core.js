/**
 * Seed a kernel snapshot into userData — phase-1 verification tool.
 *
 * Run: npm run seed:core -- 0.1.5-rc.1
 *
 * It exists to answer one question before any UI is written: can the bundled
 * pnpm install a *complete, runnable* dsh dependency tree into a plain
 * user-writable directory, and does the launcher then boot it? Everything
 * else in the dynamic-kernel plan depends on that being true.
 *
 * It also exercises the registry metadata path end to end, including the
 * 302 redirect from registry.npmmirror.com to cdn.npmmirror.com that the
 * tarball URL performs.
 *
 * This script never touches the installed dsh sources: the kernel is fetched
 * from the npm registry and verified by entry-file presence and integrity
 * metadata, never patched.
 */
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { app } = require('electron')

const { paths, ensureDirectories } = require('../src/main/paths')
const { ConfigStore } = require('../src/main/config-store')
const { KernelRegistry } = require('../src/main/plugins/backup-roll/kernel-registry')
const { RegistryClient, PACKAGE_NAME } = require('../src/main/plugins/backup-roll/registry-client')
const { npmrcFor } = require('../src/main/plugins/backup-roll/kernel-package-manager')

const DEFAULT_VERSION = '0.1.5-rc.1'

function run(cmd, args, cwd, env) {
  return new Promise((resolve, reject) => {
    console.log(`[seed] $ ${path.basename(cmd)} ${args.join(' ')}   (cwd=${cwd})`)
    const child = spawn(cmd, args, { cwd, env, stdio: 'inherit' })
    child.on('error', reject)
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`${path.basename(cmd)} 退出码 ${code}`))
    )
  })
}

async function installKernel(version, { registryUrl }) {
  const client = new RegistryClient({ registry: registryUrl })
  const info = await client.version(version)
  console.log(`[seed] 目标内核 ${info.version}`)
  console.log(`[seed] tarball ${info.tarball}`)
  console.log(`[seed] integrity ${info.integrity || '(none)'}`)

  const stagingTarget = path.join(paths.staging(), info.version)
  fs.rmSync(stagingTarget, { recursive: true, force: true })
  fs.mkdirSync(stagingTarget, { recursive: true })

  fs.writeFileSync(
    path.join(stagingTarget, 'package.json'),
    JSON.stringify({ name: 'dsh-core', version: '0.0.0', private: true }, null, 2)
  )
  fs.writeFileSync(
    path.join(stagingTarget, '.npmrc'),
    npmrcFor(registryUrl)
  )

  const pnpmBin = paths.pnpmBin()
  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    npm_config_registry: registryUrl,
    npm_config_userconfig: path.join(paths.userData(), 'npmrc')
  }
  await run(process.execPath, [pnpmBin, 'add', `${PACKAGE_NAME}@${info.version}`, '--config.node-linker=hoisted', '--reporter=append-only'], stagingTarget, env)

  const stagingEntry = path.join(stagingTarget, 'node_modules', PACKAGE_NAME, 'lib', 'bin.js')
  if (!fs.existsSync(stagingEntry)) throw new Error(`安装完成后仍缺少入口：${stagingEntry}`)

  const finalDir = paths.snapshotDir(info.version)
  if (fs.existsSync(finalDir)) fs.rmSync(finalDir, { recursive: true, force: true })
  fs.mkdirSync(path.dirname(finalDir), { recursive: true })
  fs.renameSync(stagingTarget, finalDir)

  // Report the path *after* the move — the staging path no longer exists.
  const entry = path.join(finalDir, 'node_modules', PACKAGE_NAME, 'lib', 'bin.js')
  if (!fs.existsSync(entry)) throw new Error(`移动后仍缺少入口：${entry}`)

  return { info, finalDir, entry }
}

async function main() {
  const version = process.argv[2] || DEFAULT_VERSION
  ensureDirectories()

  const config = new ConfigStore(paths.configFile(), paths.lockFile())
  const registry = new KernelRegistry({
    snapshotsDir: paths.snapshots(),
    stagingDir: paths.staging(),
    config
  })

  const { info, finalDir, entry } = await config.withLock(() =>
    installKernel(version, { registryUrl: config.read().kernel.registry })
  )

  const promoted = registry.promote(info.version, {
    registry: config.read().kernel.registry,
    integrity: info.integrity,
    engines: info.engines || null
  })
  registry.setCurrent(info.version)

  console.log('\n[seed] 完成')
  console.log(`[seed] 版本       : ${promoted.version}`)
  console.log(`[seed] 快照目录   : ${finalDir}`)
  console.log(`[seed] 入口       : ${entry}`)
  console.log(`[seed] 兼容性     : ${promoted.status}${promoted.enginesAssumed ? '（未声明 engines，按 Node>=24 校验）' : ''}`)
  console.log(`[seed] 当前配置   : ${JSON.stringify(config.read().kernel)}`)
  console.log('\n[seed] 现在可以运行 npm start 验证启动。')
}

app.whenReady().then(async () => {
  try {
    await main()
    app.quit(0)
  } catch (err) {
    console.error('\n[seed] 失败:', err.message)
    app.quit(1)
  }
})
