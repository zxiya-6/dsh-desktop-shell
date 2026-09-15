/**
 * npm registry client for kernel metadata.
 *
 * Deliberately tiny and dependency-free: it runs in the main process on the
 * bundled Node, and the only thing we need is "which versions exist, and where
 * is the tarball". Integrity verification of the actual install is left to
 * pnpm, which verifies every package it fetches.
 *
 * Two endpoints, two different shapes — this is the part that is easy to get
 * wrong:
 *   GET /<pkg>            → packument: { "dist-tags": {...}, "versions": {...} }
 *   GET /<pkg>/<version>  → single manifest: { version, dist: { tarball, integrity } }
 * The second one has no `versions` field at all.
 *
 * Scoped packages keep their slash unencoded (registry.npmmirror.com serves
 * both forms, but the unencoded one is what the CLI uses), and tarball URLs
 * answer with a 302 to cdn.npmmirror.com, so redirects must be followed.
 */
const https = require('node:https')
const http = require('node:http')

const PACKAGE_NAME = '@deepseek-ai/dsh'

function requestJson(url, { timeout = 20000, redirects = 5 } = {}) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('http://') ? http : https
    const req = client.get(url, { headers: { accept: 'application/json' } }, (res) => {
      const { statusCode, headers } = res

      if (statusCode >= 300 && statusCode < 400 && headers.location && redirects > 0) {
        res.resume()
        requestJson(headers.location, { timeout, redirects: redirects - 1 }).then(resolve, reject)
        return
      }
      if (statusCode !== 200) {
        res.resume()
        reject(new Error(`GET ${url} → HTTP ${statusCode}`))
        return
      }

      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => (body += chunk))
      res.on('end', () => {
        try {
          resolve(JSON.parse(body))
        } catch (err) {
          reject(new Error(`registry 响应不是合法 JSON：${err.message}`))
        }
      })
    })

    req.setTimeout(timeout, () => req.destroy(new Error(`请求超时（${timeout}ms）：${url}`)))
    req.on('error', reject)
  })
}

class RegistryClient {
  /**
   * @param {object} opts
   * @param {string} opts.registry npm mirror base URL
   * @param {string} [opts.packageName]
   */
  constructor({ registry, packageName = PACKAGE_NAME }) {
    this.registry = String(registry || 'https://registry.npmmirror.com').replace(/\/$/, '')
    this.packageName = packageName
  }

  get packagePath() {
    return `${this.registry}/${this.packageName}`
  }

  /** Full packument: dist-tags plus every published version. */
  async packument() {
    const doc = await requestJson(this.packagePath)
    if (!doc || typeof doc !== 'object') throw new Error('registry 响应格式异常')
    return doc
  }

  /** Latest version per dist-tags, plus the resolved manifest. */
  async latest() {
    const doc = await this.packument()
    const version = doc['dist-tags']?.latest
    if (!version) throw new Error('registry 未返回 dist-tags.latest')
    const manifest = doc.versions?.[version]
    if (!manifest) throw new Error(`registry 上找不到 latest 指向的版本 ${version}`)
    return { ...this.#shape(manifest), distTags: doc['dist-tags'] }
  }

  /**
   * Resolve an exact version, or 'latest'.
   * @param {string} version
   */
  async version(version) {
    if (!version || version === 'latest') return this.latest()
    const manifest = await requestJson(`${this.packagePath}/${encodeURIComponent(version)}`)
    if (!manifest || !manifest.dist?.tarball) {
      throw new Error(`registry 上找不到版本 ${version}（或缺少 dist.tarball）`)
    }
    return this.#shape(manifest)
  }

  /** Every published version, newest last (registry order). */
  async listVersions() {
    const doc = await this.packument()
    const versions = Object.keys(doc.versions || {})
    return versions.map((v) => this.#shape(doc.versions[v]))
  }

  #shape(manifest) {
    return {
      version: manifest.version,
      tarball: manifest.dist?.tarball || null,
      integrity: manifest.dist?.integrity || manifest.dist?.shasum || null,
      engines: manifest.engines || null,
      dependencies: manifest.dependencies ? Object.keys(manifest.dependencies).length : 0
    }
  }
}

module.exports = { RegistryClient, requestJson, PACKAGE_NAME }
