/**
 * Post-install sanity check.
 *
 * Runs after `npm install`. Verifies that the pieces the desktop shell depends
 * on actually landed on disk, and prints actionable guidance when they did not.
 * Never fails the install hard — a missing optional piece should surface as a
 * clear message, not as a broken node_modules.
 */
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')

function exists(p) {
  return fs.existsSync(path.join(root, p))
}

/**
 * Restore .npmrc from npmrc.sample when it is missing.
 *
 * Dotfiles are routinely dropped in transit — by zip payloads, by some sync
 * tools, by people copying a folder over SMB. Without this file `npm install`
 * silently produces a tree with no native binaries, which only fails later at
 * runtime. Keeping a non-dot sample next to it means the one that matters can
 * always be recovered.
 */
function ensureNpmrc() {
  const target = path.join(root, '.npmrc')
  const sample = path.join(root, 'npmrc.sample')
  if (fs.existsSync(target) || !fs.existsSync(sample)) return null
  fs.copyFileSync(sample, target)
  return target
}

const restoredNpmrc = ensureNpmrc()
if (restoredNpmrc) {
  console.log(`[OK  ] npmrc restored from npmrc.sample -> ${path.relative(root, restoredNpmrc)}`)
}

const checks = [
  {
    name: 'pnpm (bundled, used for kernel & plugin installs)',
    path: path.join('node_modules', 'pnpm', 'bin', 'pnpm.cjs'),
    hint: 'run `npm install pnpm`'
  },
  {
    name: 'node-pty native binding',
    path: path.join('node_modules', 'node-pty', 'build', 'Release'),
    hint: 'node-pty needs a native build; on Windows install the VS build tools, on Linux install python3 + build-essential',
    optional: true
  }
]

// The DeepSeek Harness kernel is no longer shipped inside the app — it is
// downloaded into %APPDATA%/dsh-desktop/core/snapshots on first run (or via
// `npm run seed:core -- <version>`). So its absence from node_modules is
// expected and must not be reported as a failure.
console.log('note: the dsh kernel is downloaded at runtime into the user data directory;')
console.log('      run `npm run seed:core -- 0.1.5-rc.1` to pre-seed a kernel for dev testing.')

let failed = 0
for (const check of checks) {
  const ok = exists(check.path)
  if (!ok && !check.optional) failed++
  const mark = ok ? 'OK  ' : check.optional ? 'WARN' : 'FAIL'
  console.log(`[${mark}] ${check.name}`)
  if (!ok) console.log(`         missing: ${check.path}\n         fix: ${check.hint}`)
}

if (failed > 0) {
  console.log(`\n${failed} required component(s) missing — the app will not start correctly.`)
} else {
  console.log('\nAll required components present.')
}
