/**
 * 插件商店 —— 基于 npm registry 的插件搜索。
 *
 * 为什么不再造一套后端：dsh 的插件本身就是 npm 包，安装走的是
 * `pnpm add <包名>`（见 plugin-manage）。所以「商店」直接查同一个 registry
 * 的搜索接口即可，好处是
 *   1. 复用用户已经配好的镜像（config.kernel.registry），国内不用连外网；
 *   2. 「搜得到的就一定装得上」——商店和安装包来自同一个源，不会出现
 *      列表里点进去 404 的尴尬。
 *
 * 两个不同的接口，别混：
 *   GET /-/v1/search?text=…   → { objects: [{ package: { name, version, … } }] }
 *   GET /<pkg>                → packument（单包全量元数据）
 * 搜索只负责「有哪些」，真正的安装仍然交给 PluginManager.install()。
 *
 * 这里刻意不 require('electron')，保持可单测。
 */
const { requestJson } = require('./registry-client')

/** 不传 query 时的默认检索词：先把明显是 dsh 插件的捞出来。 */
const DEFAULT_QUERY = 'dsh plugin'

class PluginStore {
  /**
   * @param {object} opts
   * @param {string} opts.registry npm 镜像基址
   */
  constructor({ registry } = {}) {
    this.registry = String(registry || 'https://registry.npmmirror.com').replace(/\/$/, '')
  }

  /**
   * 搜索插件。网络失败一律返回空列表而不是抛错——商店打不开不该让
   * 内核管理面板整体报错，用户还可以手动填包名安装。
   *
   * @param {object} opts
   * @param {string} [opts.query] 检索词，留空用默认词
   * @param {number} [opts.size]
   * @returns {Promise<{items: Array, total: number, error: string|null}>}
   */
  async search({ query = '', size = 30 } = {}) {
    const text = String(query || '').trim() || DEFAULT_QUERY
    const url = `${this.registry}/-/v1/search?text=${encodeURIComponent(text)}&size=${Number(size) || 30}`

    let doc
    try {
      doc = await requestJson(url, { timeout: 15000 })
    } catch (err) {
      return { items: [], total: 0, error: err.message || String(err) }
    }

    const objects = Array.isArray(doc?.objects) ? doc.objects : []
    const items = objects
      .map((obj) => obj?.package)
      .filter(Boolean)
      .map((pkg) => ({
        name: pkg.name,
        version: pkg.version || null,
        description: pkg.description || '',
        keywords: Array.isArray(pkg.keywords) ? pkg.keywords : [],
        updatedAt: pkg.date || null,
        relevance: relevanceOf(pkg)
      }))
      // 明显是 dsh 插件的排前面，其余按 relevance 再按更新时间
      .sort((a, b) => b.relevance - a.relevance || String(b.updatedAt).localeCompare(String(a.updatedAt)))

    return { items, total: doc?.total ?? items.length, error: null }
  }

  /**
   * 单个包的详情，用于安装前展示「它依赖哪个内核版本」。
   *
   * 依赖内核版本的声明位置没有统一标准，这里按优先级依次找：
   *   1. package.json 的 `dsh.kernelVersion`（我们建议的写法）
   *   2. peerDependencies['@deepseek-ai/dsh']（npm 生态的常规做法）
   *   3. engines.dsh
   * 都找不到就是没声明，UI 显示为「未声明」而不是报错——绝大多数插件
   * 确实没声明，把它当错误会挡掉一批本来能用的插件。
   */
  async detail(name) {
    if (!name) throw new Error('缺少包名')
    const encoded = name.startsWith('@') ? name : encodeURIComponent(name)
    try {
      const doc = await requestJson(`${this.registry}/${encoded}`, { timeout: 15000 })
      const latestVersion = doc?.['dist-tags']?.latest
      const manifest = latestVersion ? doc?.versions?.[latestVersion] : null
      return {
        name: doc?.name || name,
        version: latestVersion || null,
        description: doc?.description || manifest?.description || '',
        keywords: Array.isArray(doc?.keywords) ? doc?.keywords : [],
        requiresKernel: readRequiresKernel(manifest || doc),
        updatedAt: doc?.time?.modified || null
      }
    } catch (err) {
      return { name, version: null, error: err.message || String(err) }
    }
  }
}

/**
 * 从包的 package.json 里读出「依赖的内核版本」。
 * 三种声明位置都试一遍，见 PluginStore#detail 的说明。
 */
function readRequiresKernel(pkg) {
  if (!pkg || typeof pkg !== 'object') return null
  const direct = pkg.dsh?.kernelVersion || pkg.dsh?.kernel
  if (typeof direct === 'string' && direct.trim()) return direct.trim()
  const peer = pkg.peerDependencies?.['@deepseek-ai/dsh']
  if (typeof peer === 'string' && peer.trim()) return peer.trim()
  const engines = pkg.engines?.dsh || pkg.engines?.['@deepseek-ai/dsh']
  if (typeof engines === 'string' && engines.trim()) return engines.trim()
  return null
}

/**
 * 与 dsh 的相关度，用于排序：
 *   2 = 名字/关键词里明说是 dsh 插件，1 = 提到了 dsh 或 harness，0 = 无关。
 * 只是排序权重，不做过滤——万一某个插件没打关键词，用户仍然能搜到并手工装。
 */
function relevanceOf(pkg) {
  const hay = [
    pkg.name || '',
    (pkg.keywords || []).join(' '),
    pkg.description || ''
  ]
    .join(' ')
    .toLowerCase()
  if (/dsh[\s-]*plugin/.test(hay)) return 2
  if (/\bdsh\b/.test(hay) || /\bharness\b/.test(hay)) return 1
  return 0
}

module.exports = { PluginStore, readRequiresKernel, relevanceOf, DEFAULT_QUERY }
