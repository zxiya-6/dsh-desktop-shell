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

/** 命令 shim 所在目录（同时是「伪装成系统命令」的 PATH 前缀来源）。 */
function shimDir() {
  return path.join(paths.userData(), 'bin')
}

/**
 * `node` shim —— 把 Electron 伪装成系统 node。
 *
 * 为什么必须有它：pnpm 装内核时，node-pty / koffi / protobufjs 这些带构建
 * 脚本的包会在子 shell 里直接唤 `node`。打包环境里系统 PATH 通常**没有**
 * node（这正是「与系统环境隔离」的代价），于是安装跑到 500/502 个包时全线
 * 报 `sh: 1: node: not found` 并整体失败——开发机上因为有 node 才看不出来。
 * 这里用 `ELECTRON_RUN_AS_NODE=1` 的 Electron 顶上，安装链路才真正自洽。
 */
function writeNodeShim() {
  const dir = shimDir()
  fs.mkdirSync(dir, { recursive: true })
  const nodeExe = process.execPath

  if (isWindows) {
    const file = path.join(dir, 'node.cmd')
    fs.writeFileSync(
      file,
      `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${nodeExe}" %*\r\n`,
      'utf8'
    )
    return file
  }

  const file = path.join(dir, 'node')
  fs.writeFileSync(file, `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "${nodeExe}" "$@"\n`, 'utf8')
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
  const dir = shimDir()
  fs.mkdirSync(dir, { recursive: true })
  // node shim 无条件写：终端里敲 `node`、以及 pnpm 装包时的构建脚本都要用到。
  writeNodeShim()
  if (dshEntry && fs.existsSync(dshEntry)) writeShim(dshEntry, 'dsh')
  writeShim(paths.pnpmBin(), 'pnpm')
  return dir
}

/**
 * 给 pnpm 子进程准备的环境：在 PATH 最前面放上我们的 shim 目录与 Electron
 * 所在目录。
 *
 * 内核/插件的安装脚本会自己唤 `node`，而打包环境里系统 PATH 没有 node；
 * 不补这一段，安装会一直卡在最后一个包上失败（详见 writeNodeShim）。
 */
function pnpmPathEntries() {
  return [shimDir(), path.dirname(process.execPath)]
}

function withPnpmPath(env = {}) {
  const rest = env[PATH_KEY] ?? process.env[PATH_KEY] ?? ''
  return { ...env, [PATH_KEY]: joinPath([...pnpmPathEntries(), rest]) }
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
  writeNodeShim,
  shimDir,
  pnpmPathEntries,
  withPnpmPath,
  defaultShell,
  systemPathEntries,
  PATH_KEY
}
