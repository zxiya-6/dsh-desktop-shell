/**
 * Terminal smoke test.
 *
 * Verifies that node-pty can actually spawn a shell and round-trip data from
 * inside the Electron main process — the one thing the packaging step cannot
 * prove. Run with:
 *
 *   npm run smoke:terminal
 *
 * Exits 0 if a shell started and echoed back our marker, 1 otherwise.
 */
const { app } = require('electron')
const { TerminalManager } = require('../src/main/terminal')
const { ensureDirectories } = require('../src/main/paths')

const MARKER = 'DSH_TERMINAL_SMOKE_OK'
const TIMEOUT_MS = 15000

app.on('ready', () => {
  ensureDirectories()

  const terminals = new TerminalManager()
  const shell = terminals.getShell()

  console.log('[smoke] node-pty available:', terminals.available())
  console.log(`[smoke] shell: ${shell.label} (${shell.id}) version=${shell.version || 'unknown'}`)
  console.log(`[smoke] path:  ${shell.exePath}`)

  if (!terminals.available()) {
    console.error('[smoke] FAIL reason:', terminals.unavailableReason())
    app.exit(1)
    return
  }

  let buffer = ''
  let finished = false

  const timer = setTimeout(() => {
    if (finished) return
    finished = true
    console.error('[smoke] FAIL timeout, output so far:', JSON.stringify(buffer.slice(0, 400)))
    terminals.disposeAll()
    app.exit(1)
  }, TIMEOUT_MS)

  try {
    terminals.create('smoke', { cols: 80, rows: 24 }, (data) => {
      buffer += data
      if (buffer.includes(MARKER)) {
        if (finished) return
        finished = true
        clearTimeout(timer)
        console.log('[smoke] PASS — shell responded')
        terminals.disposeAll()
        app.exit(0)
      }
    })
  } catch (err) {
    clearTimeout(timer)
    console.error('[smoke] FAIL create:', err.message)
    app.exit(1)
    return
  }

  setTimeout(() => terminals.write('smoke', `echo ${MARKER}\n`), 1200)
})
