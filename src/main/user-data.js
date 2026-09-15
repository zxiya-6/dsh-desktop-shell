/**
 * Pin the userData directory — once, before anything reads it.
 *
 * Left to Electron this derives from app.getName(), which is not stable: a dev
 * run reports "Electron", a script launched as `electron scripts/foo.js`
 * reports yet another path, and the NSIS uninstaller has to find the real one
 * to clean up. Every entry point (app, seed script, smoke test) therefore goes
 * through here.
 *
 * Portable (green) builds are the exception: their whole point is "delete the
 * folder and it is gone", so data follows the executable instead of leaking
 * into %APPDATA%. Electron sets PORTABLE_EXECUTABLE_DIR in that mode.
 */
const path = require('node:path')
const { app } = require('electron')

let pinned = false

function pinUserData() {
  if (pinned) return app.getPath('userData')

  const portableDir = process.env.PORTABLE_EXECUTABLE_DIR
  app.setPath(
    'userData',
    portableDir
      ? path.join(portableDir, 'dsh-desktop-data')
      : path.join(app.getPath('appData'), 'dsh-desktop')
  )
  pinned = true
  return app.getPath('userData')
}

/** True when the resolved root matches what pinUserData would set. */
function isPinned() {
  return pinned
}

module.exports = { pinUserData, isPinned }
