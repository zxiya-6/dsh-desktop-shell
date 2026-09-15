/**
 * Local throttling proxy — how kernel and plugin downloads get separate limits.
 *
 * pnpm has no "download at N KB/s" switch, so instead of patching its internals
 * we hand it a proxy (HTTPS_PROXY) and shape the bytes there. Two independent
 * instances therefore give us two independent bandwidth channels: a kernel
 * update can be capped without slowing down plugin installs, and vice versa.
 *
 * Only CONNECT tunnelling is implemented, which is all an npm registry needs:
 * the TLS session is end-to-end, we just meter the bytes flowing through.
 */
const http = require('node:http')
const net = require('node:net')
const { Transform } = require('node:stream')

/** Pass-through that delays each chunk by its size / rate. */
class Throttle extends Transform {
  constructor(bytesPerSec) {
    super()
    this.bytesPerSec = bytesPerSec
  }

  _transform(chunk, _enc, cb) {
    if (!this.bytesPerSec || this.bytesPerSec <= 0) return cb(null, chunk)
    const delayMs = (chunk.length / this.bytesPerSec) * 1000
    // Cap the sleep: tiny chunks at a low rate would otherwise schedule a
    // storm of timers and slow the transfer far below the requested rate.
    setTimeout(() => cb(null, chunk), Math.min(delayMs, 1000))
  }
}

class ThrottleProxy {
  /**
   * @param {object} [opts]
   * @param {number} [opts.kilobytesPerSec] 0 disables shaping (direct pipe)
   * @param {string} [opts.host] bind address, loopback by default
   */
  constructor({ kilobytesPerSec = 0, host = '127.0.0.1' } = {}) {
    this.kilobytesPerSec = kilobytesPerSec
    this.host = host
    this.server = null
    this.port = null
  }

  get bytesPerSec() {
    return this.kilobytesPerSec > 0 ? this.kilobytesPerSec * 1024 : 0
  }

  /** Change the cap at any time; existing tunnels pick it up immediately. */
  setLimit(kilobytesPerSec) {
    this.kilobytesPerSec = Number(kilobytesPerSec) >= 0 ? Number(kilobytesPerSec) : 0
  }

  async listen() {
    if (this.server) return this.port

    this.server = http.createServer((req, res) => {
      // Plain-HTTP requests are not used by the registry client; refuse rather
      // than silently proxying something we do not shape correctly.
      res.writeHead(405, { 'content-type': 'text/plain' })
      res.end('only CONNECT is supported')
    })

    this.server.on('connect', (req, clientSocket, head) => {
      const [targetHost, targetPortRaw] = String(req.url || '').split(':')
      const targetPort = Number(targetPortRaw) || 443
      if (!targetHost) {
        clientSocket.destroy()
        return
      }

      const upstream = net.connect(targetPort, targetHost, () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (head && head.length) upstream.write(head)

        const up = new Throttle(this.bytesPerSec)
        const down = new Throttle(this.bytesPerSec)
        clientSocket.pipe(up).pipe(upstream)
        upstream.pipe(down).pipe(clientSocket)
      })

      const cleanup = () => {
        try {
          clientSocket.destroy()
        } catch {
          /* already closed */
        }
        try {
          upstream.destroy()
        } catch {
          /* already closed */
        }
      }
      upstream.on('error', cleanup)
      clientSocket.on('error', cleanup)
      upstream.on('close', cleanup)
      clientSocket.on('close', cleanup)
    })

    await new Promise((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(0, this.host, resolve)
    })
    this.port = this.server.address().port
    return this.port
  }

  /** Proxy URL for HTTPS_PROXY/HTTP_PROXY env vars. */
  get url() {
    return this.port ? `http://${this.host}:${this.port}` : null
  }

  close() {
    if (!this.server) return
    try {
      this.server.close()
    } catch {
      /* already closed */
    }
    this.server = null
    this.port = null
  }
}

module.exports = { ThrottleProxy, Throttle }
