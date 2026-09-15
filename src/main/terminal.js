/**
 * Interactive terminal sessions backed by node-pty.
 *
 * Why this file is picky about shell *type and version*: on Windows the
 * candidates behave differently enough to break things if you guess.
 *
 *   pwsh.exe        PowerShell 7+      modern, cross-platform, UTF-8 friendly
 *   powershell.exe  Windows PowerShell 5.1 (built-in) legacy, OEM code page output
 *   cmd.exe         CMD                needs `chcp 65001` before UTF-8 renders
 *   bash.exe        Git Bash / WSL     only when installed; many dev machines
 *                                      have this and nothing else, so we must not
 *                                      silently fall through to cmd.exe for them
 *
 * Passing PowerShell-7-only syntax into 5.1, or assuming UTF-8 from a 5.1
 * console, produces garbled Chinese text and mysterious parse errors. So we
 * detect what is actually installed, expose it, and adapt the launch arguments
 * per shell instead of hardcoding one.
 *
 * Sessions are per-window so several terminals can be open at once. Every
 * session starts from buildTerminalEnv(), which puts the bundled Node/pnpm/dsh
 * ahead of anything on the system PATH — that is what makes in-terminal plugin
 * updates act on the packaged runtime rather than the user's.
 *
 * node-pty is native and must be unpacked from asar (see build.asarUnpack).
 */
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { paths } = require('./paths')
const { buildTerminalEnv } = require('./env')

const isWindows = process.platform === 'win32'

let pty = null
let ptyError = null
try {
  pty = require('node-pty')
} catch (err) {
  ptyError = err
  console.error('[terminal] node-pty unavailable, terminal disabled:', err.message)
}

/**
 * Shell candidates in descending preference, with the arguments each one needs.
 * `utf8` holds a command that switches the console to UTF-8 where required.
 */
const SHELL_CANDIDATES = isWindows
  ? [
      {
        id: 'pwsh7',
        label: 'PowerShell 7+',
        file: 'pwsh.exe',
        args: ['-NoLogo', '-NoProfile'],
        utf8: null // UTF-8 by default
      },
      {
        id: 'pwsh5',
        label: 'Windows PowerShell 5.1',
        file: 'powershell.exe',
        args: ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass'],
        utf8: null
      },
      {
        id: 'bash',
        label: 'Git Bash / WSL',
        file: 'bash.exe',
        args: ['--login'],
        utf8: null // UTF-8 by default; covers both Git's bash.exe and WSL bash.exe
      },
      {
        id: 'cmd',
        label: 'CMD',
        file: 'cmd.exe',
        args: ['/k'],
        utf8: 'chcp 65001 >nul'
      }
    ]
  : [
      { id: 'bash', label: 'Bash', file: '/bin/bash', args: ['--login'], utf8: null },
      { id: 'zsh', label: 'Zsh', file: '/bin/zsh', args: ['--login'], utf8: null },
      { id: 'sh', label: 'sh', file: '/bin/sh', args: [], utf8: null }
    ]

/** Resolve a command through PATH the way the OS would. */
function resolveOnPath(file) {
  if (path.isAbsolute(file)) return fs.existsSync(file) ? file : null
  try {
    const cmd = isWindows ? 'where' : 'which'
    const out = execFileSync(cmd, [file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    const first = out.split(/\r?\n/).map((s) => s.trim()).find(Boolean)
    return first || null
  } catch {
    return null
  }
}

/** Extra locations PowerShell 7 can live in even when it is not on PATH. */
function pwsh7InstallPaths() {
  if (!isWindows) return []
  const pf = process.env.ProgramFiles || 'C:\\Program Files'
  return [path.join(pf, 'PowerShell', '7', 'pwsh.exe')]
}

/**
 * Extra locations Git Bash can live in even when it is not on PATH. `bash.exe`
 * also resolves to WSL's shim when that is set up, so either way a working bash
 * is found. Listed explicitly so a dev box with Git Bash but no PowerShell 7
 * does not fall through to cmd.exe.
 */
function gitBashPaths() {
  if (!isWindows) return []
  const pf = process.env.ProgramFiles || 'C:\\Program Files'
  const local = process.env.LocalAppData || ''
  return [
    path.join(pf, 'Git', 'bin', 'bash.exe'),
    path.join(pf, 'Git', 'usr', 'bin', 'bash.exe'),
    path.join(local, 'Programs', 'Git', 'bin', 'bash.exe')
  ].filter(Boolean)
}

/** Best-effort read of the shell version string, for display and logging. */
function readShellVersion(candidate, exePath) {
  const probes = {
    pwsh7: ['--version'],
    pwsh5: ['-NoLogo', '-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'],
    cmd: ['/c', 'ver'],
    bash: ['--version'],
    zsh: ['--version'],
    sh: ['--version']
  }
  const args = probes[candidate.id]
  if (!args) return null
  try {
    const out = execFileSync(exePath, args, {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true
    })
    return out.split(/\r?\n/).map((s) => s.trim()).find(Boolean) || null
  } catch {
    return null
  }
}

/** Pick the best installed shell. Falls back to the platform default. */
function detectShell() {
  for (const candidate of SHELL_CANDIDATES) {
    let exePath = resolveOnPath(candidate.file)
    if (!exePath && candidate.id === 'pwsh7') {
      exePath = pwsh7InstallPaths().find((p) => fs.existsSync(p)) || null
    }
    if (!exePath && candidate.id === 'bash') {
      exePath = gitBashPaths().find((p) => fs.existsSync(p)) || null
    }
    if (!exePath) continue
    return { ...candidate, exePath, version: readShellVersion(candidate, exePath) }
  }

  // Nothing matched: fall back to whatever the OS reports.
  const fallback = isWindows
    ? { id: 'cmd', label: 'CMD', file: process.env.COMSPEC || 'cmd.exe', args: ['/k'], utf8: 'chcp 65001 >nul' }
    : { id: 'sh', label: 'sh', file: process.env.SHELL || '/bin/sh', args: [], utf8: null }
  return { ...fallback, exePath: fallback.file, version: null }
}

class TerminalManager {
  constructor() {
    this.sessions = new Map()
    this.shell = null
  }

  /** Detect once at startup; reused by every session. */
  getShell() {
    if (!this.shell) this.shell = detectShell()
    return this.shell
  }

  available() {
    return Boolean(pty)
  }

  unavailableReason() {
    return ptyError ? ptyError.message : null
  }

  /**
   * @param {string} sessionId
   * @param {{cols:number, rows:number, cwd?:string}} options
   * @param {(data:string)=>void} onData
   * @param {(info:{code?:number, signal?:number})=>void} [onExit]
   */
  create(sessionId, options, onData, onExit) {
    if (!pty) throw new Error(`Terminal unavailable: ${this.unavailableReason()}`)
    if (this.sessions.has(sessionId)) this.dispose(sessionId)

    const shell = this.getShell()
    const cols = options.cols || 80
    const rows = options.rows || 24
    const cwd = options.cwd && fs.existsSync(options.cwd) ? options.cwd : paths.workspace()

    console.log(
      `[terminal] session=${sessionId} shell=${shell.label} (${shell.id}) ` +
        `path=${shell.exePath} version=${shell.version || 'unknown'}`
    )

    const term = pty.spawn(shell.exePath, shell.args ?? [], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env: buildTerminalEnv()
    })

    const disposable = term.onData((data) => onData(data))
    let exitDisposable = null
    if (typeof term.onExit === 'function') {
      exitDisposable = term.onExit(({ exitCode, signal }) => {
        this.sessions.delete(sessionId)
        if (onExit) onExit({ code: exitCode, signal })
      })
    }

    this.sessions.set(sessionId, { term, disposable, exitDisposable, shell })

    // CMD cannot emit UTF-8 until the code page is switched.
    if (shell.utf8) {
      setTimeout(() => {
        try {
          term.write(`${shell.utf8}\r`)
        } catch {
          /* session already gone */
        }
      }, 150)
    }

    return { shell: { id: shell.id, label: shell.label, version: shell.version }, cols, rows, cwd }
  }

  write(sessionId, data) {
    const session = this.sessions.get(sessionId)
    if (!session) return false
    try {
      session.term.write(data)
      return true
    } catch {
      return false
    }
  }

  resize(sessionId, cols, rows) {
    const session = this.sessions.get(sessionId)
    if (!session) return false
    try {
      session.term.resize(Math.max(1, cols), Math.max(1, rows))
      return true
    } catch {
      return false
    }
  }

  dispose(sessionId) {
    const session = this.sessions.get(sessionId)
    if (!session) return
    this.sessions.delete(sessionId)
    try {
      session.disposable?.dispose?.()
      session.exitDisposable?.dispose?.()
    } catch {
      /* ignore */
    }
    try {
      session.term.kill()
    } catch {
      /* already dead */
    }
  }

  disposeAll() {
    for (const id of [...this.sessions.keys()]) this.dispose(id)
  }
}

module.exports = { TerminalManager, detectShell, SHELL_CANDIDATES }
