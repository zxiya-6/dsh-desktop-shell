/**
 * 极简语义化版本比较。
 *
 * 为什么自己写：仓库没有 semver 依赖，而「要不要更新」这件事只需要回答
 * 「哪个版本更新」「是不是预发布」两个问题。npm 的版本形态是
 * `<major>.<minor>.<patch>[-<prerelease>]`，range / build metadata 不处理
 * （凡是 range 都在调用前被 validate.js 挡掉了）。
 *
 * 刻意不依赖 electron，好让纯 node 的冒烟脚本能直接测规则。
 */

/**
 * 拆成 { core: [major, minor, patch], pre }。
 * 非数字段（如 `1.2.3-beta.1` 里的 `beta`）统一归到 pre，数字缺失按 0。
 */
function parseVersion(value) {
  const raw = String(value ?? '').trim().replace(/^[v=]+/, '')
  const dash = raw.indexOf('-')
  const core = dash === -1 ? raw : raw.slice(0, dash)
  const pre = dash === -1 ? '' : raw.slice(dash + 1)
  return {
    core: core.split('.').map((n) => Number.parseInt(n, 10) || 0),
    pre
  }
}

/**
 * @returns {number} a > b → 1；a < b → -1；相等 → 0
 *
 * 规则：先比 core 三段；core 相同时**正式版高于预发布版**（1.0.0 > 1.0.0-rc.1）；
 * 同为预发布时按字符串比（rc.2 > rc.1，但 rc.10 < rc.9 —— 与 semver 规范一致，
 * 逐段比较会把数字段也当数字，这里为了简单按字符串处理，dsh 的 rc 序号
 * 尚未到两位数，够用且行为可预期）。
 */
function compareSemver(a, b) {
  const x = parseVersion(a)
  const y = parseVersion(b)
  for (let i = 0; i < 3; i += 1) {
    const diff = (x.core[i] || 0) - (y.core[i] || 0)
    if (diff !== 0) return diff > 0 ? 1 : -1
  }
  if (x.pre === y.pre) return 0
  if (!x.pre) return 1
  if (!y.pre) return -1
  return x.pre > y.pre ? 1 : -1
}

/** a 是否严格比 b 新。非法输入一律返回 false —— 判断不了就不更新。 */
function isNewer(a, b) {
  if (!a || !b) return false
  return compareSemver(a, b) > 0
}

/** 是否是预发布版本（含 -xxx 后缀）。 */
function isPrerelease(value) {
  return /-/.test(String(value ?? ''))
}

/**
 * 预发布「通道」：0.1.5-rc.1 → rc，0.1.6-alpha.1 → alpha。
 * 用来判断一次更新是不是跨了通道（rc → alpha 属于换通道，不该自动跳）。
 */
function prereleaseChannel(value) {
  const pre = parseVersion(value).pre
  if (!pre) return null
  const match = pre.match(/^[a-zA-Z]+/)
  return match ? match[0].toLowerCase() : pre.toLowerCase()
}

module.exports = { compareSemver, isNewer, isPrerelease, prereleaseChannel, parseVersion }
