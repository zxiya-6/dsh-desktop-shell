/**
 * Environment construction — the actual isolation boundary.
 *
 * Two things must hold:
 *   1. dsh and pnpm resolve to the BUNDLED copies, never to whatever the user
 *      happens to have installed. That is what "isolated from the system" means
 *      in practice.
 *   2. The OS keeps enough of its own PATH to launch a shell at all. Wiping PATH
 *      entirely breaks spawning on Windows (no cmd.exe), so we keep the system
 *      core directories as a fallback *behind* our bundled entries.
 *
 * Isolation is therefore "ours wins, system fills the gaps" — not "system is
 * invisible". Trying to be stricter just produces a terminal that cannot start.
 */
const fs = require('node:fs')
const path = require('node:path')
const { paths } = require('./paths')

const isWindows = process.platform === 'win32'
const PATH_KEY = isWindows ? 'Path' : 'PATH'

/** Directories the OS needs to be able to spawn processes at all. */
function systemPathEntries() {
  if (isWindows) {
    const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows'
    return [
      path.join(root, 'System32'),
      root,
      path.join(root, 'System32', 'WindowsPowerShell', 'v1.0'),
      path.join(root, 'System32', 'Wbem')
    ]
  }
  return ['/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin']
}

/**
 * Cross-platform command shim.
 *
 * Users expect to type `dsh` and `pnpm` in the built-in terminal. Rather than
 * relying on npm's .bin wrappers (which are generated per-platform and awkward
 * to ship inside asar) we emit our own shims that invoke the bundled Node
 * against a known script path.
 */
function writeShim(targetPath, name) {
  const shimDir = path.join(paths.userData(), 'bin')
  fs.mkdirSync(shimDir, { recursive: true })

  const nodeExe = process.execPath

  if (isWindows) {
    const file = path.join(shimDir, `${name}.cmd`)
    // @echo off + quoted paths: survives spaces in "Program Files".
    fs.writeFileSync(
      file,
      `@echo off\r\n"${nodeExe}" "${targetPath}" %*\r\n`,
      'utf8'
    )
    return file
  }

  const file = path.join(shimDir, name)
  fs.writeFileSync(file, `#!/bin/sh\nexec "${nodeExe}" "${targetPath}" "$@"\n`, 'utf8')
  fs.chmodSync(file, 0o755)
  return file
}

/**
 * Emit `dsh` and `pnpm` shims and return the directory containing them.
 *
 * `dshEntry` is the resolved kernel entry (userData/core/snapshots/<ver>/...).
 * It is a parameter rather than a lookup because the kernel is now dynamic:
 * the shim has to point at whichever version is currently active, and during
 * first-run no kernel exists at all — the terminal must still work, so the
 * dsh shim is simply skipped while pnpm stays available.
 */
function ensureShims(dshEntry) {
  const dir = path.join(paths.userData(), 'bin')
  fs.mkdirSync(dir, { recursive: true })
  if (dshEntry && fs.existsSync(dshEntry)) writeShim(dshEntry, 'dsh')
  writeShim(paths.pnpmBin(), 'pnpm')
  return dir
}

function joinPath(entries) {
  return entries.filter(Boolean).join(path.delimiter)
}

/**
 * Environment for the dsh child process.
 *
 * ELECTRON_RUN_AS_NODE makes the Electron binary behave as plain Node, which is
 * how we avoid shipping a second ~50MB runtime. Requires Electron >= 44
 * (Node 24.18.x) so that `import.meta.main` exists inside dsh's bin.js.
 */
function buildDshEnv(dshEntry = null) {
  const env = { ...process.env }

  env.DSH_HOME = paths.dshHome()
  env.ELECTRON_RUN_AS_NODE = '1'
  // Keep Electron from trying to be a GUI app in this process.
  delete env.ELECTRON_NO_ATTACH_CONSOLE

  // npm/pnpm must not touch the user's global prefix or cache.
  env.npm_config_global_prefix = path.join(paths.userData(), 'npm-global')
  env.npm_config_cache = path.join(paths.userData(), 'npm-cache')
  env.npm_config_userconfig = path.join(paths.userData(), 'npmrc')
  env.PNPM_HOME = path.join(paths.userData(), 'pnpm-home')

  env[PATH_KEY] = joinPath([
    path.dirname(process.execPath), // bundled node first
    ensureShims(dshEntry),
    ...systemPathEntries()
  ])

  return env
}

/** Environment for the interactive terminal — same isolation, plus our shims. */
function buildTerminalEnv(dshEntry = null) {
  const env = buildDshEnv(dshEntry)
  // A terminal is interactive: hand it a sane default shell and a home it owns.
  if (!env.HOME && !isWindows) env.HOME = paths.userData()
  env.DSH_WORKSPACE = paths.workspace()
  return env
}

/** Default shell for the built-in terminal, per platform. */
function defaultShell() {
  if (isWindows) {
    return process.env.COMSPEC || 'powershell.exe'
  }
  return process.env.SHELL || '/bin/bash'
}

module.exports = {
  buildDshEnv,
  buildTerminalEnv,
  ensureShims,
  defaultShell,
  systemPathEntries,
  PATH_KEY
}
