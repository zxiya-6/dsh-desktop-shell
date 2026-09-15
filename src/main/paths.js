/**
 * Path resolution for the desktop shell.
 *
 * Two rules govern everything here:
 *
 *   1. Nothing writable goes next to the executable. Install dir holds code,
 *      userData holds state — so upgrading, reinstalling or moving the
 *      program never touches profiles, plugins or sessions.
 *
 *   2. The kernel (dsh) is *also* state now, not shipped code. It lives in
 *      userData/core/snapshots/<version>, which is what makes it updatable
 *      and rollback-able without touching the installation.
 *
 * Layout:
 *   <userData>/
 *     dsh-home/            DSH_HOME — profiles, credentials, plugins, sessions
 *     core/
 *       snapshots/<ver>/   installed kernels (each with its own node_modules)
 *       staging/           install scratch, promoted only after a smoke test
 *       update.lock        guards concurrent kernel/plugin installs
 *     plugins/             user-installed plugins
 *     workspace/           default agent workspace
 *     logs/                dsh child-process logs
 *     bin/                 generated dsh / pnpm shims
 *     config.json          kernel selection, limits, retention
 *     plugin-manifest.json plugin + kernel manifest
 */
const fs = require('node:fs')
const path = require('node:path')
const { app } = require('electron')
const { pinUserData } = require('./user-data')
const { layoutFor, layoutDirectories } = require('./layout')

// Must happen before the first getPath('userData') anywhere in the process.
pinUserData()

/** Per-user, upgrade-safe root. */
function userDataRoot() {
  return app.getPath('userData')
}

/**
 * 用户覆盖的路径（来自 config.json → paths）。
 *
 * 之所以用模块级变量而不是每次读 config：paths 被 env / plugin-manage /
 * kernel-package-manager 等一堆模块直接调用，让它们全都依赖 ConfigStore 会
 * 造成一圈循环引用（config-store 不依赖 paths，但 paths 一旦依赖它就反过来了）。
 * 改成启动时注入一次覆盖值，调用方签名完全不变。
 *
 * 覆盖值一律在写入前经过 path-config 校验，非法值在这里也不会被采纳。
 */
let overrides = { dshHome: null, kernelDir: null }

/** 注入已校验的路径覆盖。传 null 表示恢复默认。 */
function setOverrides(next = {}) {
  overrides = {
    dshHome: next.dshHome ? path.resolve(next.dshHome) : null,
    kernelDir: next.kernelDir ? path.resolve(next.kernelDir) : null
  }
  return { ...overrides }
}

function getOverrides() {
  return { ...overrides }
}

const paths = {
  userData: () => userDataRoot(),

  /** DSH_HOME — stays outside the kernel tree so switching kernels keeps data. */
  dshHome: () => overrides.dshHome || path.join(userDataRoot(), 'dsh-home'),

  /**
   * 当前使用的内核快照目录。
   *
   * 返回 null 表示「跟随 config.kernel.currentVersion 自动解析」，调用方需要
   * 自行拼 snapshots/<version>。之所以不在这里拼：paths 拿不到 config，而
   * currentVersion 又是唯一的真相源，两处拼接迟早会不一致。
   */
  kernelDir: () => overrides.kernelDir || null,

  workspace: () => path.join(userDataRoot(), 'workspace'),

  logs: () => path.join(userDataRoot(), 'logs'),

  logFile: () => path.join(userDataRoot(), 'logs', 'dsh.log'),

  /* ---------------- kernel (dynamic, updatable) ---------------- */

  core: () => path.join(userDataRoot(), 'core'),

  snapshots: () => path.join(paths.core(), 'snapshots'),

  staging: () => path.join(paths.core(), 'staging'),

  snapshotDir: (version) => path.join(paths.snapshots(), String(version)),

  lockFile: () => path.join(paths.core(), 'update.lock'),

  configFile: () => path.join(userDataRoot(), 'config.json'),

  manifestFile: () => path.join(userDataRoot(), 'plugin-manifest.json'),

  plugins: () => path.join(userDataRoot(), 'plugins'),

  /**
   * 桌面壳自己安装的插件目录 —— DSH_HOME 下的一个独立子目录。
   *
   * 为什么不是 dsh 自己的 `$DSH_HOME/profiles/<name>/node_modules`：那是 dsh
   * 插件系统的地盘，而这里的插件是桌面壳用 pnpm 单独装的，两边共用一个
   * 目录会互相改写 package.json。放在 DSH_HOME 下则保持了「插件属于用户
   * 数据」的语义——它跟着 DSH_HOME 走，永远不进内核树、也不碰系统目录。
   */
  pluginDir: () => path.join(paths.dshHome(), 'dsh-plugins'),

  /**
   * Built-in plugins ship inside the app and are read-only by design — the
   * user cannot delete backup-roll, which is what keeps kernel management
   * available even if everything else goes wrong.
   */
  builtinPlugins: () =>
    path.join(app.isPackaged ? process.resourcesPath : app.getAppPath(), 'src', 'main', 'plugins'),

  /* ---------------- bundled (shipped, non-updatable) ---------------- */

  /**
   * Where the *bundled* node_modules live.
   *
   * Packaged: resources/app.asar.unpacked/node_modules (asar is read-only).
   * Dev: plain node_modules.
   * Used for pnpm and for seeding a first kernel — never as the runtime
   * entry point any more (see kernel-registry).
   */
  appModules: () => {
    if (app.isPackaged) {
      return path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules')
    }
    // Derived from this file rather than app.getAppPath(): when a script is
    // launched as `electron scripts/foo.js`, getAppPath() points at scripts/,
    // which would resolve bundled tools (pnpm) to a directory that has none.
    return path.join(path.resolve(__dirname, '..', '..'), 'node_modules')
  },

  /**
   * dsh used to ship inside the installer. It no longer does: the kernel lives
   * in core/snapshots and is fetched on demand, which is what keeps the
   * installer small and lets the kernel be updated without a reinstall. This
   * path is deliberately gone — anything that needs a kernel must go through
   * KernelRegistry, never through the app bundle.
   */

  /** Bundled pnpm launcher — kernel and plugin installs must never use a system pnpm. */
  pnpmBin: () => {
    const base = path.join(paths.appModules(), 'pnpm', 'bin')
    for (const candidate of ['pnpm.cjs', 'pnpm.js']) {
      if (fs.existsSync(path.join(base, candidate))) return path.join(base, candidate)
    }
    return path.join(base, 'pnpm.cjs')
  },

  /** Directory holding the bundled node executable (Electron itself, run as node). */
  nodeDir: () => path.dirname(process.execPath)
}

/** Create the directories the app needs. Safe to call repeatedly. */
function ensureDirectories() {
  for (const dir of layoutDirectories(userDataRoot())) {
    fs.mkdirSync(dir, { recursive: true })
  }
  // 用户自定义的位置也要建出来：DSH_HOME 不存在时 dsh 会自行另建一套默认
  // 结构，那就会出现「配置指向 A、数据其实落在 B」的错位。
  if (overrides.dshHome) {
    fs.mkdirSync(overrides.dshHome, { recursive: true })
  }
}

module.exports = {
  paths,
  ensureDirectories,
  setOverrides,
  getOverrides,
  layoutFor,
  layoutDirectories
}
