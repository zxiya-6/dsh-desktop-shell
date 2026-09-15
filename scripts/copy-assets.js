/**
 * Copy renderer-facing third-party assets into src/renderer/vendor.
 *
 * The terminal page is loaded over file:// with nodeIntegration disabled, so it
 * cannot `require()` anything. It pulls xterm in with a plain <script> tag,
 * which means the files must sit at a path that stays valid inside app.asar
 * after packaging. Reaching into ../../node_modules works in dev but breaks
 * once asarUnpack moves things around, so we vendor a known copy instead.
 */
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const vendor = path.join(root, 'src', 'renderer', 'vendor')

const assets = [
  ['node_modules/@xterm/xterm/lib/xterm.js', 'xterm.js'],
  ['node_modules/@xterm/xterm/css/xterm.css', 'xterm.css'],
  ['node_modules/@xterm/addon-fit/lib/addon-fit.js', 'addon-fit.js'],
  ['node_modules/@xterm/addon-web-links/lib/addon-web-links.js', 'addon-web-links.js']
]

fs.mkdirSync(vendor, { recursive: true })

let copied = 0
for (const [from, to] of assets) {
  const src = path.join(root, from)
  if (!fs.existsSync(src)) {
    console.warn(`[assets] skip (not installed): ${from}`)
    continue
  }
  fs.copyFileSync(src, path.join(vendor, to))
  copied++
}

console.log(`[assets] copied ${copied}/${assets.length} file(s) to src/renderer/vendor`)
