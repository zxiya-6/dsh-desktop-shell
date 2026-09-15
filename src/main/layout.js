/**
 * Directory layout, independent of Electron.
 *
 * This module deliberately requires nothing but `path` so the kernel layout
 * can be reasoned about — and tested — without a running app instance. The
 * Electron-bound `paths.js` builds on top of it; `kernel-registry` can be
 * exercised against a temp directory using the very same function.
 */
const path = require('node:path')

/**
 * Compute the whole user-data layout from an arbitrary root.
 *
 * @param {string} root absolute path to the userData directory
 */
function layoutFor(root) {
  return {
    userData: root,
    dshHome: path.join(root, 'dsh-home'),
    workspace: path.join(root, 'workspace'),
    logs: path.join(root, 'logs'),
    logFile: path.join(root, 'logs', 'dsh.log'),
    bin: path.join(root, 'bin'),
    core: path.join(root, 'core'),
    snapshots: path.join(root, 'core', 'snapshots'),
    staging: path.join(root, 'core', 'staging'),
    snapshotDir: (version) => path.join(root, 'core', 'snapshots', String(version)),
    plugins: path.join(root, 'plugins'),
    configFile: path.join(root, 'config.json'),
    manifestFile: path.join(root, 'plugin-manifest.json'),
    lockFile: path.join(root, 'core', 'update.lock')
  }
}

/** Directories that must exist before the app can do anything useful. */
function layoutDirectories(root) {
  const l = layoutFor(root)
  return [l.userData, l.dshHome, l.workspace, l.logs, l.core, l.snapshots, l.staging, l.plugins]
}

module.exports = { layoutFor, layoutDirectories }
