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

const paths = {
  userData: () => userDataRoot(),

  /** DSH_HOME — stays outside the kernel tree so switching kernels keeps data. */
  dshHome: () => path.join(userDataRoot(), 'dsh-home'),

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
}

module.exports = { paths, ensureDirectories, layoutFor, layoutDirectories }
