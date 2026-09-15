#!/usr/bin/env node
/**
 * 路径配置校验的冒烟测试（纯 node，不需要 Electron）。
 *
 * 这两条路径放开给用户填之后，安全和「数据不落进内核树」这条不变量就全靠
 * path-config.js 的校验兜着，所以这里把每条规则都钉死一个用例——尤其是
 * 各种互相嵌套的情况，它们是这条不变量唯一可能失守的地方。
 *
 *   npm run smoke:paths
 */
'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  validateDshHome,
  validateKernelDir,
  normalize,
  samePath,
  isSubPath
} = require('../src/main/path-config')

let passed = 0
let failed = 0

function check(name, ok, detail) {
  if (ok) {
    passed += 1
    console.log(`  ✓ ${name}`)
  } else {
    failed += 1
    console.log(`  ✗ ${name}${detail ? `  → ${detail}` : ''}`)
  }
}

function expectReject(name, result, code) {
  check(
    name,
    result.ok === false && (code ? result.code === code : true),
    `期望拒绝${code ? `(${code})` : ''}，实际 ok=${result.ok} code=${result.code}`
  )
}

/* ------------------------------------------------------------------ *
 * 夹具：搭一棵假的 userData 树
 * ------------------------------------------------------------------ */

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-pathcfg-'))
const snapshotsDir = path.join(root, 'core', 'snapshots')
const stagingDir = path.join(root, 'core', 'staging')
const kernelDir = path.join(snapshotsDir, '0.1.5-rc.1')
const homeDir = path.join(root, 'dsh-home')

// 一个「装好的内核」：有入口文件 + 自己的 package.json
fs.mkdirSync(path.join(kernelDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib'), { recursive: true })
fs.writeFileSync(
  path.join(kernelDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
  '// fixture\n'
)
fs.writeFileSync(
  path.join(kernelDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
  JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.5-rc.1' })
)
fs.mkdirSync(stagingDir, { recursive: true })
fs.mkdirSync(homeDir, { recursive: true })
// 一个确实存在、但里面没有内核入口的普通目录
const plainDir = path.join(root, 'plain')
fs.mkdirSync(plainDir, { recursive: true })

const ctx = { kernelDir, snapshotsDir, stagingDir, dshHome: homeDir }

/* ------------------------------------------------------------------ *
 * 1. 归一化
 * ------------------------------------------------------------------ */
console.log('\n[1] 归一化')
check('去掉包裹的英文引号', normalize('"C:\\some\\dir"') === path.resolve('C:\\some\\dir'))
check('去掉包裹的中文引号', normalize('“C:\\some\\dir”') === path.resolve('C:\\some\\dir'))
check('去掉尾部斜杠', !/[\\/]$/.test(normalize('/tmp/foo/').replace(/^([A-Za-z]:)?[\\/]+$/, '$1')))
check('~ 展开为家目录', normalize('~/foo') === path.join(os.homedir(), 'foo'))
check('空串返回 null', normalize('   ') === null)

/* ------------------------------------------------------------------ *
 * 2. 路径关系判定
 * ------------------------------------------------------------------ */
console.log('\n[2] 路径关系')
check('相同路径判等', samePath('/a/b', '/a/b/'))
check('子目录判定', isSubPath('/a/b/c', '/a/b'))
check('相同不算子目录', isSubPath('/a/b', '/a/b') === false)
check('兄弟目录不算子目录', isSubPath('/a/bc', '/a/b') === false)

/* ------------------------------------------------------------------ *
 * 3. DSH_HOME 校验
 * ------------------------------------------------------------------ */
console.log('\n[3] DSH_HOME')
expectReject('空值被拒', validateDshHome('', ctx), 'EMPTY')
expectReject('null 被拒', validateDshHome(null, ctx), 'EMPTY')
expectReject('磁盘根目录被拒', validateDshHome(path.parse(root).root, ctx), 'ROOT')
expectReject('系统目录被拒', validateDshHome(process.env.SystemRoot || 'C:\\Windows', ctx), 'PROTECTED')
expectReject(
  '系统目录的子目录被拒',
  validateDshHome(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32'), ctx),
  'PROTECTED'
)
expectReject('与内核目录相同被拒', validateDshHome(kernelDir, ctx), 'SAME_AS_KERNEL')
expectReject(
  '落在内核目录内被拒（清理快照会删数据）',
  validateDshHome(path.join(kernelDir, 'profiles'), ctx),
  'INSIDE_KERNEL'
)
expectReject(
  '落在快照根内被拒',
  validateDshHome(path.join(snapshotsDir, 'whatever'), ctx),
  'INSIDE_KERNEL'
)
expectReject(
  '内核目录被包在 DSH_HOME 内被拒',
  validateDshHome(path.join(root, 'core'), { ...ctx, snapshotsDir: path.join(root, 'core', 'snapshots') }),
  'KERNEL_INSIDE'
)
{
  const r = validateDshHome(homeDir, ctx)
  check('合法目录通过', r.ok === true, r.reason)
  check('合法目录返回归一化值', r.ok && r.value === path.resolve(homeDir), JSON.stringify(r))
}
{
  const r = validateDshHome(path.join(root, 'brand-new-home'), ctx)
  check('不存在的目录允许（只要有可写的上级）', r.ok === true, r.reason)
  check('并标记 exists=false', r.ok && r.exists === false)
}

/* ------------------------------------------------------------------ *
 * 4. 内核目录校验
 * ------------------------------------------------------------------ */
console.log('\n[4] 内核目录')
expectReject('空值被拒', validateKernelDir('', ctx), 'EMPTY')
expectReject('磁盘根被拒', validateKernelDir(path.parse(root).root, ctx), 'ROOT')
expectReject('系统目录被拒', validateKernelDir(process.env.SystemRoot || 'C:\\Windows', ctx), 'PROTECTED')
expectReject('与 DSH_HOME 相同被拒', validateKernelDir(homeDir, ctx), 'SAME_AS_HOME')
expectReject('落在 DSH_HOME 内被拒', validateKernelDir(path.join(homeDir, 'kernel'), ctx), 'INSIDE_HOME')
expectReject(
  'DSH_HOME 被包在内被拒',
  validateKernelDir(path.join(root), { ...ctx, dshHome: path.join(root, 'core') }),
  'HOME_INSIDE'
)
expectReject('指向 staging 被拒', validateKernelDir(stagingDir, ctx), 'STAGING')
expectReject('存在的目录但无内核入口被拒', validateKernelDir(plainDir, ctx), 'NOT_A_KERNEL')
expectReject('不存在的目录不是内核', validateKernelDir(path.join(root, 'empty'), ctx), 'NOT_A_KERNEL')
{
  const r = validateKernelDir(kernelDir, ctx)
  check('合法内核目录通过', r.ok === true, r.reason)
  check('反推出目录版本号', r.ok && r.version === '0.1.5-rc.1', JSON.stringify(r))
  check('读出内核自称的版本', r.ok && r.kernelVersion === '0.1.5-rc.1', JSON.stringify(r))
  check('标记为非外部内核', r.ok && r.external === false)
}
{
  // 快照根之外的合法内核：推不出版本，但要允许（external）
  const ext = path.join(root, 'external-kernel')
  fs.mkdirSync(path.join(ext, 'node_modules', '@deepseek-ai', 'dsh', 'lib'), { recursive: true })
  fs.writeFileSync(path.join(ext, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), '// x\n')
  const r = validateKernelDir(ext, ctx)
  check('快照根外的合法内核允许', r.ok === true, r.reason)
  check('且标记为 external', r.ok && r.external === true && r.version === null)
}

/* ------------------------------------------------------------------ *
 * 5. 分派入口
 * ------------------------------------------------------------------ */
console.log('\n[5] validate 分派')
{
  const { validate } = require('../src/main/path-config')
  check('dshHome 走 DSH_HOME 分支', validate('dshHome', homeDir, ctx).ok === true)
  check('kernelDir 走内核分支', validate('kernelDir', kernelDir, ctx).ok === true)
  expectReject('未知类型被拒', validate('whatever', homeDir, ctx), 'UNKNOWN_KIND')
}

/* ------------------------------------------------------------------ */

fs.rmSync(root, { recursive: true, force: true })

console.log(`\n${'-'.repeat(52)}`)
console.log(`路径配置校验：${passed} 通过 / ${failed} 失败`)
process.exit(failed === 0 ? 0 : 1)
