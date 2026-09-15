/**
 * 跨「便携版 / 安装版」的单实例锁。
 *
 * Electron 自带的 `requestSingleInstanceLock()` 是按 **userData 目录** 区分的：
 * 便携版把 userData 指到 exe 同级的 `dsh-desktop-data`，安装版指到
 * `%APPDATA%\dsh-desktop`。两者路径不同，锁就各管各的 —— 同一台机器上可以
 * 同时跑起来，然后两个内核抢同一个端口、互相把对方挤崩，还会在
 * `dsh-home/task-board/` 留下僵尸锁，导致下次启动内核直接报
 * `ledger is already owned by process <pid>` 后退出（用户看到的就是「打不开」）。
 *
 * 所以这道锁刻意**不放在 userData 下**，而是放在一个与 userData 无关的固定
 * 位置，让两个版本共享同一把锁。调用方负责给出这个路径。
 *
 * 纯 node 实现，不 require electron —— 这样 `scripts/smoke-lock.js` 能直接单测。
 */
const fs = require('node:fs')
const path = require('node:path')

/**
 * 进程是否还活着。
 *
 * 信号 0 是「只探测、不投递」，Node 在 Windows 上同样支持。进程不存在时抛
 * ESRCH；EPERM 表示进程存在但不属于当前用户 —— 那也算活着（比如另一个用户的
 * 会话跑着同一个程序）。
 *
 * pid 复用的理论风险这里接受：锁文件里同时记了 startedAt 与 exe 路径，真要
 * 排查时能看出来。
 */
function isPidAlive(pid) {
  const n = Number(pid)
  if (!Number.isInteger(n) || n <= 0) return false
  if (n === process.pid) return true
  try {
    process.kill(n, 0)
    return true
  } catch (err) {
    if (err.code === 'EPERM') return true
    return false
  }
}

/** 读出锁文件里的记录；文件不存在或内容不成形（写了一半 / 被截断）都返回 null。 */
function readLock(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8').trim()
    if (!raw) return null
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/**
 * 抢锁。成功返回 `{ ok: true, file }`，失败返回
 * `{ ok: false, reason: 'held' | 'error', holder?, error? }`。
 *
 * 写入用「先写临时文件，再 hard link 到目标」的办法，让**独占创建**和
 * **内容落盘**变成一步：`link` 在目标已存在时抛 EEXIST，于是不存在「文件建好
 * 了但内容还空着」的窗口，别人不会把一把正在写的锁误判成僵尸锁。
 * 若文件系统不支持硬链接（在 NTFS 上必然支持，但别处不一定），退回 `wx` 写。
 */
function acquireInstanceLock({ file, payload = {} } = {}) {
  if (!file) return { ok: false, reason: 'error', error: new Error('缺少锁文件路径') }

  const body = JSON.stringify({
    ...payload,
    pid: process.pid,
    startedAt: new Date().toISOString()
  })

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
    } catch (err) {
      return { ok: false, reason: 'error', error: err }
    }

    const linked = tryLinkWrite(file, body)
    if (linked.ok) return { ok: true, file }
    if (linked.error && linked.error.code !== 'EEXIST') {
      return { ok: false, reason: 'error', error: linked.error }
    }

    // 到这儿说明锁文件已存在，看看持有者是不是已经死了。
    const holder = readLock(file)
    // 读不出内容 → 陈旧锁（进程恰好死在写盘前）。清掉重试。
    if (!holder || !isPidAlive(holder.pid)) {
      try {
        fs.unlinkSync(file)
      } catch {
        /* 别人抢先清掉了，下一轮再说 */
      }
      continue
    }
    return { ok: false, reason: 'held', holder }
  }

  return { ok: false, reason: 'held', holder: readLock(file) }
}

/** 独占写入：硬链接优先，失败退回 O_EXCL。返回 `{ ok }` 或 `{ ok:false, error }`。 */
function tryLinkWrite(file, body) {
  const tmp = `${file}.${process.pid}.tmp`
  try {
    fs.writeFileSync(tmp, body)
  } catch (err) {
    return { ok: false, error: err }
  }
  try {
    fs.linkSync(tmp, file)
    return { ok: true }
  } catch (err) {
    if (err.code !== 'EEXIST' && err.code !== 'EPERM' && err.code !== 'ENOSYS' && err.code !== 'EACCES') {
      return { ok: false, error: err }
    }
    if (err.code === 'EEXIST') return { ok: false, error: err }
    // 文件系统不支持硬链接 → 退回 O_EXCL 写入。
    try {
      const fd = fs.openSync(file, 'wx')
      try {
        fs.writeFileSync(fd, body)
      } finally {
        fs.closeSync(fd)
      }
      return { ok: true }
    } catch (err2) {
      return { ok: false, error: err2 }
    }
  } finally {
    try {
      fs.unlinkSync(tmp)
    } catch {
      /* 清不掉就算了，名字里带 pid，不会互相覆盖 */
    }
  }
}

/** 释放锁。只删自己持有的那一把，免得误删别人刚抢到的。 */
function releaseInstanceLock(file) {
  if (!file) return false
  const holder = readLock(file)
  if (holder && Number(holder.pid) !== process.pid) return false
  try {
    fs.unlinkSync(file)
    return true
  } catch {
    return false
  }
}

/**
 * 清理陈旧锁：持有者进程已死 → 删掉；还活着 → 不动。
 *
 * 这是给内核侧那种「进程崩了但锁留在盘上」的场景用的，典型是
 * `dsh-home/task-board/ledger-v2.lock` —— 它的格式同样是 `{"pid":...}`，
 * 所以能复用同一套判定。
 *
 * 返回 `'absent' | 'removed' | 'kept' | 'unreadable'`，调用方据此打日志。
 */
function clearStaleLock(file) {
  if (!file) return 'absent'
  if (!fs.existsSync(file)) return 'absent'

  const holder = readLock(file)
  if (holder && isPidAlive(holder.pid)) return 'kept'

  try {
    fs.unlinkSync(file)
    return 'removed'
  } catch {
    return 'unreadable'
  }
}

module.exports = {
  isPidAlive,
  readLock,
  acquireInstanceLock,
  releaseInstanceLock,
  clearStaleLock
}
