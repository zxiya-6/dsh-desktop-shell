#!/usr/bin/env node
/**
 * 跨版本单实例锁的冒烟测试（纯 node，不需要 Electron）。
 *
 *   npm run smoke:lock
 *
 * 这道锁要成立，靠的是「pid 还活着才算有人持有」这条判定。判错了只有两种
 * 后果，都很贵：判成「活着」→ 用户再也启动不了（而且不知道该删哪个文件）；
 * 判成「死了」→ 两个实例同时跑，接着就是抢端口、挤崩内核、留下僵尸锁。
 * 所以下面把每种锁文件形态各钉一个用例。
 */
'use strict'

const cp = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  isPidAlive,
  readLock,
  acquireInstanceLock,
  releaseInstanceLock,
  clearStaleLock
} = require('../src/main/instance-lock')

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

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-lock-smoke-'))
const lockFile = path.join(root, 'nested', 'deep', 'instance.lock')

/**
 * 拿一个「确实存在过、现在确定已经死了」的 pid。
 *
 * 不用硬编码数字：Windows 的 pid 会复用，硬编码一个数在某些机器上可能正好
 * 撞上活着的进程，测试就变成偶发失败。起一个空转子进程等它退出最稳。
 */
function makeDeadPid() {
  const r = cp.spawnSync(process.execPath, ['-e', '0'], { stdio: 'ignore' })
  return r.pid
}

const deadPid = makeDeadPid()

/* ------------------------------------------------------------------ *
 * 1. isPidAlive
 * ------------------------------------------------------------------ */
console.log('\n[1] isPidAlive')
check('当前进程判定为存活', isPidAlive(process.pid) === true)
check('已退出的子进程判定为死亡', isPidAlive(deadPid) === false, `pid=${deadPid}`)
check('0 不是合法 pid', isPidAlive(0) === false)
check('负数不是合法 pid', isPidAlive(-1) === false)
check('undefined 不是合法 pid', isPidAlive(undefined) === false)
check('字符串数字可用', isPidAlive(String(process.pid)) === true)

/* ------------------------------------------------------------------ *
 * 2. 首次抢锁 / 重复抢锁
 * ------------------------------------------------------------------ */
console.log('\n[2] 抢锁与互斥')
{
  const first = acquireInstanceLock({ file: lockFile, payload: { version: '0.1.1' } })
  check('首次抢锁成功', first.ok === true, JSON.stringify(first))
  check('自动创建了不存在的多级目录', fs.existsSync(lockFile))

  const body = readLock(lockFile)
  check('锁文件记录了 pid', body && body.pid === process.pid, JSON.stringify(body))
  check('锁文件记录了启动时间', Boolean(body && body.startedAt))
  check('调用方 payload 被写入', body && body.version === '0.1.1')

  const second = acquireInstanceLock({ file: lockFile })
  check('同进程再抢被拒（held）', second.ok === false && second.reason === 'held', JSON.stringify(second))
  check('被拒时能拿到持有者信息', Boolean(second.holder && second.holder.pid === process.pid))

  check('没有留下临时文件', fs.readdirSync(path.dirname(lockFile)).every((n) => n === 'instance.lock'),
    fs.readdirSync(path.dirname(lockFile)).join(','))
}

/* ------------------------------------------------------------------ *
 * 3. 释放
 * ------------------------------------------------------------------ */
console.log('\n[3] 释放')
{
  check('释放成功', releaseInstanceLock(lockFile) === true)
  check('锁文件已删除', !fs.existsSync(lockFile))
  check('重复释放不报错', releaseInstanceLock(lockFile) === false)

  // 别人持有的锁不能被我们释放掉 —— 否则就成了「后启动的把先启动的锁删了」。
  fs.mkdirSync(path.dirname(lockFile), { recursive: true })
  fs.writeFileSync(lockFile, JSON.stringify({ pid: deadPid }))
  check('不释放他人的锁', releaseInstanceLock(lockFile) === false)
  check('他人的锁文件仍在', fs.existsSync(lockFile))

  const after = acquireInstanceLock({ file: lockFile })
  check('持有人已死 → 自动接管陈旧锁', after.ok === true, JSON.stringify(after))
  check('接管后锁归自己', readLock(lockFile).pid === process.pid)
  releaseInstanceLock(lockFile)
}

/* ------------------------------------------------------------------ *
 * 4. 残缺锁文件
 * ------------------------------------------------------------------ */
console.log('\n[4] 残缺 / 非法的锁文件')
{
  fs.mkdirSync(path.dirname(lockFile), { recursive: true })

  fs.writeFileSync(lockFile, '')
  check('空文件 → readLock 返回 null', readLock(lockFile) === null)
  check('空文件 → 可接管', acquireInstanceLock({ file: lockFile }).ok === true)
  releaseInstanceLock(lockFile)

  fs.writeFileSync(lockFile, '{"pid":')
  check('半截 JSON → 可接管', acquireInstanceLock({ file: lockFile }).ok === true)
  releaseInstanceLock(lockFile)

  fs.writeFileSync(lockFile, '"just a string"')
  check('非对象 JSON → 可接管', acquireInstanceLock({ file: lockFile }).ok === true)
  releaseInstanceLock(lockFile)

  fs.writeFileSync(lockFile, JSON.stringify({ token: 'no-pid-here' }))
  check('没有 pid 字段 → 可接管', acquireInstanceLock({ file: lockFile }).ok === true)
  releaseInstanceLock(lockFile)
}

/* ------------------------------------------------------------------ *
 * 5. clearStaleLock（内核侧僵尸锁走的就是这条路径）
 * ------------------------------------------------------------------ */
console.log('\n[5] clearStaleLock')
{
  const ledger = path.join(root, 'dsh-home', 'task-board', 'ledger-v2.lock')

  check('文件不存在 → absent', clearStaleLock(ledger) === 'absent')

  // 真实场景里那个锁长这样：{"pid":51736,"token":"...","probe":"exact"}
  fs.mkdirSync(path.dirname(ledger), { recursive: true })
  fs.writeFileSync(ledger, JSON.stringify({ pid: deadPid, token: 'b4090b2d', probe: 'exact' }))
  check('持有者已死 → removed', clearStaleLock(ledger) === 'removed')
  check('僵尸锁文件已删除', !fs.existsSync(ledger))

  fs.writeFileSync(ledger, JSON.stringify({ pid: process.pid, token: 'x' }))
  check('持有者存活 → kept（绝不误删）', clearStaleLock(ledger) === 'kept')
  check('存活的锁文件还在', fs.existsSync(ledger))

  fs.writeFileSync(ledger, 'not json at all')
  check('内容不可读 → removed', clearStaleLock(ledger) === 'removed')

  check('file 为空 → absent', clearStaleLock(null) === 'absent')
}

/* ------------------------------------------------------------------ *
 * 6. 参数缺失
 * ------------------------------------------------------------------ */
console.log('\n[6] 参数缺失')
{
  const r = acquireInstanceLock({})
  check('缺 file → error 而不是抛异常', r.ok === false && r.reason === 'error', JSON.stringify(r))
}

/* ------------------------------------------------------------------ */

fs.rmSync(root, { recursive: true, force: true })

console.log(`\n${'-'.repeat(52)}`)
console.log(`单实例锁：${passed} 通过 / ${failed} 失败`)
process.exit(failed === 0 ? 0 : 1)
