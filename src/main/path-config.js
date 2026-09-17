/**
 * 用户可配置路径（DSH_HOME / 内核快照目录）的校验与归一化。
 *
 * 为什么单独一个模块：这两条路径过去是硬编码的，DSH_HOME 甚至还是六条
 * 不变量之一（「必须等于 userData/dsh-home」）。现在要放开给用户改，那条
 * 不变量就从「代码保证」降级成了「校验保证」——所以规则必须集中在一处、
 * 可被单测覆盖，而不是散落在各个调用点。
 *
 * 放开之后要守住的其实是同一件事的**精神**：
 *   数据永远不能落进内核树里。
 * 因为内核快照是可以被 prune 掉的，一旦插件和会话跟着进了内核目录，
 * 清理旧快照就等于删用户数据。反过来的嵌套（内核在 DSH_HOME 里）同样
 * 要禁，否则 dsh 会把整个内核当成自己的数据目录去读写。
 *
 * 这里刻意不 require('electron')，好让 scripts/ 下的纯 node 冒烟脚本
 * 能直接跑（与 migrate.js 同样的取舍）。
 */
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

/** 内核入口相对于快照目录的位置，与 kernel-registry 的 ENTRY_RELATIVE 一致。 */
const KERNEL_ENTRY_RELATIVE = ['node_modules', '@deepseek-ai/dsh', 'lib', 'bin.js']
const KERNEL_PACKAGE_RELATIVE = ['node_modules', '@deepseek-ai/dsh', 'package.json']

class PathConfigError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'PathConfigError'
    this.code = code
  }
}

/**
 * 归一化为绝对路径。
 *
 * 用户填的路径来源很脏：从资源管理器复制来的带引号、手打的带尾部斜杠、
 * 用 ~ 指代家目录、中文全角空格。这里统一成 path.resolve 之后的绝对路径，
 * 后续所有比较都基于归一化结果，避免 `C:\a` 与 `C:\a\` 被判成两个目录。
 */
function normalize(input) {
  if (typeof input !== 'string') return null
  // 去掉包裹的英文/中文引号与首尾空白（含全角空格）
  let value = input.trim().replace(/^["'“”](.*)["'“”]$/, '$1').trim()
  if (!value) return null
  if (value === '~' || value.startsWith('~/')) {
    value = path.join(os.homedir(), value.slice(1))
  }
  return path.resolve(value)
}

/** Windows 路径比较不区分大小写，盘符写法也可能不同。 */
function samePath(a, b) {
  if (!a || !b) return false
  const norm = (p) => path.resolve(p).replace(/[\\/]+$/, '')
  const x = norm(a)
  const y = norm(b)
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y
}

/** child 是否严格位于 parent 之内（相同不算）。 */
function isSubPath(child, parent) {
  if (!child || !parent) return false
  const rel = path.relative(path.resolve(parent), path.resolve(child))
  return !!rel && rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

/** 这些目录下的任何位置都不允许放用户数据或内核。 */
function protectedRoots() {
  if (process.platform === 'win32') {
    const windir = process.env.SystemRoot || process.env.windir || 'C:\\Windows'
    return [
      windir,
      path.join(windir, 'System32'),
      process.env.ProgramFiles || 'C:\\Program Files',
      process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
      process.env.ProgramData || 'C:\\ProgramData'
    ].filter(Boolean)
  }
  return ['/', '/usr', '/etc', '/bin', '/sbin', '/System', '/Library', '/private'].filter(Boolean)
}

/**
 * 可写性探测。
 *
 * 目录不存在时不能直接判失败——用户很可能想填一个尚未创建的新位置。
 * 这时往上找最近的已存在祖先，只要那个祖先可写，就认为这里能建出来。
 */
function writableProbe(dir) {
  if (fs.existsSync(dir)) {
    try {
      if (!fs.statSync(dir).isDirectory()) {
        return { ok: false, reason: '该路径已存在，但它是一个文件' }
      }
    } catch (err) {
      return { ok: false, reason: `无法访问该路径：${err.message}` }
    }
    try {
      fs.accessSync(dir, fs.constants.W_OK)
      return { ok: true, exists: true }
    } catch {
      return { ok: false, reason: '目录不可写（权限不足或被占用）' }
    }
  }

  let probe = dir
  for (let i = 0; i < 64; i += 1) {
    const parent = path.dirname(probe)
    if (parent === probe) break
    if (fs.existsSync(parent)) {
      try {
        fs.accessSync(parent, fs.constants.W_OK)
        return { ok: true, exists: false }
      } catch {
        return { ok: false, reason: `上级目录不可写：${parent}` }
      }
    }
    probe = parent
  }
  return { ok: false, reason: '找不到可写的上级目录' }
}

/** 通用检查：空值 / 磁盘根 / 系统目录。 */
function commonChecks(value, label) {
  if (!value) {
    return { ok: false, code: 'EMPTY', reason: `请填写${label}` }
  }
  if (path.parse(value).root === value || /^[\\/]+$/.test(value)) {
    return { ok: false, code: 'ROOT', reason: '不能直接使用磁盘根目录' }
  }
  for (const root of protectedRoots()) {
    // POSIX 的受保护列表里带 "/"，而文件系统根是所有路径的祖先：
    // 若在这里也走 isSubPath，任何绝对路径都会被判成「在系统目录下」，
    // Linux 上就再也选不出一个合法目录（Windows 没有这个问题，因为它的
    // 受保护项都是具体目录，如 C:\Windows）。所以根只对「等于」生效，
    // 「在根下」由上面的 ROOT 检查表达。
    const isFsRoot = path.parse(root).root === root
    if (samePath(value, root)) {
      return { ok: false, code: 'PROTECTED', reason: `不能放在系统目录下（${root}），重装系统会一并带走` }
    }
    if (!isFsRoot && isSubPath(value, root)) {
      return { ok: false, code: 'PROTECTED', reason: `不能放在系统目录下（${root}），重装系统会一并带走` }
    }
  }
  return null
}

/**
 * 校验 DSH_HOME。
 *
 * @param {string} input 用户填写的原始值
 * @param {object} ctx
 * @param {string} [ctx.kernelDir]    当前内核快照目录，用于排除互相嵌套
 * @param {string} [ctx.snapshotsDir] 快照根目录，同样属于「内核树」
 * @param {string} [ctx.stagingDir]   暂存目录，也属于内核树
 */
function validateDshHome(input, ctx = {}) {
  const value = normalize(input)
  const base = commonChecks(value, 'DSH_HOME 路径')
  if (base) return base

  const kernelish = [ctx.kernelDir, ctx.snapshotsDir, ctx.stagingDir].filter(Boolean)
  for (const dir of kernelish) {
    if (samePath(value, dir)) {
      return { ok: false, code: 'SAME_AS_KERNEL', reason: 'DSH_HOME 不能与内核目录相同' }
    }
    if (isSubPath(value, dir)) {
      return {
        ok: false,
        code: 'INSIDE_KERNEL',
        reason: 'DSH_HOME 不能在内核目录内——清理旧快照会把插件和会话一起删掉'
      }
    }
    if (isSubPath(dir, value)) {
      return {
        ok: false,
        code: 'KERNEL_INSIDE',
        reason: '内核目录不能在 DSH_HOME 内——dsh 会把整个内核当成自己的数据目录'
      }
    }
  }

  const writable = writableProbe(value)
  if (!writable.ok) {
    return { ok: false, code: 'NOT_WRITABLE', reason: writable.reason }
  }
  return { ok: true, value, exists: writable.exists }
}

/**
 * 校验内核快照目录。
 *
 * 与 DSH_HOME 的区别：内核目录必须**已经是一个装好的内核**（要有入口文件），
 * 否则切过去会直接得到一个起不来的应用。同时尽量反推它对应的版本号，好与
 * config.kernel.currentVersion 保持同步——这两个值表达的是同一件事，
 * 一旦各说各话，Ctrl+K 面板和设置页就会显示不一致的结果。
 */
function validateKernelDir(input, ctx = {}) {
  const value = normalize(input)
  const base = commonChecks(value, '内核路径')
  if (base) return base

  if (ctx.dshHome) {
    if (samePath(value, ctx.dshHome)) {
      return { ok: false, code: 'SAME_AS_HOME', reason: '内核目录不能与 DSH_HOME 相同' }
    }
    if (isSubPath(value, ctx.dshHome)) {
      return { ok: false, code: 'INSIDE_HOME', reason: '内核目录不能在 DSH_HOME 内' }
    }
    if (isSubPath(ctx.dshHome, value)) {
      return { ok: false, code: 'HOME_INSIDE', reason: 'DSH_HOME 不能在内核目录内' }
    }
  }
  if (ctx.stagingDir && (samePath(value, ctx.stagingDir) || isSubPath(value, ctx.stagingDir))) {
    return { ok: false, code: 'STAGING', reason: '不能指向暂存目录 staging（安装失败时会被整体删除）' }
  }

  const entry = path.join(value, ...KERNEL_ENTRY_RELATIVE)
  if (!fs.existsSync(entry)) {
    return {
      ok: false,
      code: 'NOT_A_KERNEL',
      reason: `该目录下没有内核入口 ${KERNEL_ENTRY_RELATIVE.join('/')}，请选择一个已安装的内核`
    }
  }

  // 反推版本号：只在快照根目录下才推得出来，目录名即版本。
  let version = null
  if (ctx.snapshotsDir) {
    const rel = path.relative(path.resolve(ctx.snapshotsDir), value)
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
      version = rel.split(path.sep)[0] || null
    }
  }

  // 内核自己声明的版本，比目录名更可信（目录名可能被手工改过）。
  let kernelVersion = null
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(value, ...KERNEL_PACKAGE_RELATIVE), 'utf8'))
    kernelVersion = pkg.version || null
  } catch {
    /* 读不到就退回目录名 */
  }

  const writable = writableProbe(value)
  if (!writable.ok) {
    return { ok: false, code: 'NOT_WRITABLE', reason: writable.reason }
  }
  return { ok: true, value, version, kernelVersion, external: !version, exists: writable.exists }
}

/** 按 kind 分派，便于 IPC 只暴露一个入口。 */
function validate(kind, input, ctx = {}) {
  if (kind === 'dshHome') return validateDshHome(input, ctx)
  if (kind === 'kernelDir') return validateKernelDir(input, ctx)
  return { ok: false, code: 'UNKNOWN_KIND', reason: `未知的路径类型：${kind}` }
}

module.exports = {
  validate,
  validateDshHome,
  validateKernelDir,
  normalize,
  samePath,
  isSubPath,
  writableProbe,
  protectedRoots,
  PathConfigError,
  KERNEL_ENTRY_RELATIVE
}
