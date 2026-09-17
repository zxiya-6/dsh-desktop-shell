/**
 * 内核自动更新。
 *
 * 它只回答四件事，其余全部复用已有的安装流水线：
 *   1. 什么时候查（触发）
 *   2. 去哪儿查、跟谁比（来源 + 比对规则）
 *   3. 查到了要不要装（策略）
 *   4. 装失败了怎么办（退避重试，当前内核不动）
 *
 * 刻意**不**自己实现下载/校验/替换/回滚：那条链路在 KernelPackageManager
 * 里已经跑通（暂存 → 校验入口 → 冒烟启动 → 原子提升 → 切换），自动更新只是
 * 它的一个调用者。同样的道理，它也不直接碰 Electron —— 依赖全部注入，好让
 * scripts/smoke-autoupdate.js 能单独测规则。
 *
 * @typedef {object} AutoUpdateDeps
 * @property {import('../config-store').ConfigStore} config
 * @property {import('./kernel-registry').KernelRegistry} registry
 * @property {import('./kernel-package-manager').KernelPackageManager} manager
 * @property {(version: string, opts?: object) => Promise<object>} installAndActivate
 *        装完并启用一个版本；由主进程提供（要先启动、再写配置）。
 * @property {(event: object) => void} [onEvent]  状态外发（面板 + 日志）
 */
const { compareSemver, isNewer, isPrerelease, prereleaseChannel } = require('./semver')

/** 触发方式：启动后延迟 / 定时 / 手动 / 失败退避重试。 */
const TRIGGERS = {
  startup: 'startup',
  scheduled: 'scheduled',
  manual: 'manual',
  retry: 'retry'
}

/** 启动后先让内核跑起来，别抢开机那几秒的带宽和 IO。 */
const STARTUP_DELAY_MS = 30 * 1000
/** 定时检查间隔。内核一天最多发两三个版本，6 小时足够及时又不打扰。 */
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000
/** 失败退避：网络抖一下很常见，立刻重试只会把错误放大。 */
const RETRY_BACKOFF_MS = [5 * 60 * 1000, 15 * 60 * 1000, 45 * 60 * 1000]

/** 一次检查的结论。面板与日志都按这个 code 说话。 */
const RESULT = {
  upToDate: 'up-to-date',
  updated: 'updated',
  installed: 'installed', // 原本没有内核
  skipped: 'skipped', // 策略上不该动（固定版本 / 降级 / 跨通道）
  busy: 'busy', // 有别的任务在跑
  failed: 'failed'
}

function nowIso() {
  return new Date().toISOString()
}

class KernelAutoUpdater {
  /**
   * @param {AutoUpdateDeps} deps
   */
  constructor({ config, registry, manager, installAndActivate, onEvent } = {}) {
    if (!config || !registry || !manager || typeof installAndActivate !== 'function') {
      throw new Error('KernelAutoUpdater 需要 config / registry / manager / installAndActivate')
    }
    this.config = config
    this.registry = registry
    this.manager = manager
    this.installAndActivate = installAndActivate
    this.onEvent = typeof onEvent === 'function' ? onEvent : () => {}

    this.timers = { startup: null, scheduled: null, retry: null }
    this.running = false // 一次「检查 + 可能的安装」是否在进行
    this.failures = 0
    this.stopped = false
    this.state = {
      enabled: Boolean(this.#cfg().autoUpdate),
      lastCheckAt: null,
      lastResult: null,
      lastMessage: null,
      lastTarget: null,
      nextCheckAt: null,
      updatedFrom: null,
      updatedTo: null
    }
  }

  #cfg() {
    return (this.config.read() || {}).kernel || {}
  }

  #emit(patch, log) {
    this.state = { ...this.state, ...patch }
    if (log) console.log(`[kernel:auto] ${log}`)
    this.onEvent({ ...this.state, log: log || null })
  }

  /* ------------------------------------------------------------------ *
   * 触发
   * ------------------------------------------------------------------ */

  /**
   * 启动：延迟一次（TRIGGERS.startup）+ 之后每 6 小时一次（TRIGGERS.scheduled）。
   * 关掉自动更新只是不再自动装，定时检查仍然跑 —— 否则开关一关，
   * 面板上「有新版本」的提示也跟着没了。
   */
  start() {
    if (this.timers.startup || this.timers.scheduled) return this
    this.stopped = false
    this.state.enabled = Boolean(this.#cfg().autoUpdate)
    this.#scheduleStartup()
    this.timers.scheduled = setInterval(() => {
      this.check({ trigger: TRIGGERS.scheduled }).catch(() => {})
    }, CHECK_INTERVAL_MS)
    this.#emit({ nextCheckAt: new Date(Date.now() + STARTUP_DELAY_MS).toISOString() }, '已启动：30s 后首次检查，之后每 6 小时一次')
    return this
  }

  #scheduleStartup() {
    this.timers.startup = setTimeout(() => {
      this.timers.startup = null
      this.check({ trigger: TRIGGERS.startup }).catch(() => {})
    }, STARTUP_DELAY_MS)
  }

  /** 停掉所有定时器（应用退出 / 关闭功能时调用）。 */
  stop() {
    this.stopped = true
    for (const key of Object.keys(this.timers)) {
      if (this.timers[key]) clearTimeout(this.timers[key])
      if (this.timers[key] && key === 'scheduled') clearInterval(this.timers[key])
      this.timers[key] = null
    }
    return this
  }

  /** 手动触发（面板「立即检查」）。已有任务在跑时返回 busy，不排队。 */
  async checkNow() {
    return this.check({ trigger: TRIGGERS.manual, force: true })
  }

  /* ------------------------------------------------------------------ *
   * 一次完整检查
   * ------------------------------------------------------------------ */

  /**
   * @param {object} [opts]
   * @param {string} [opts.trigger] startup | scheduled | manual | retry
   * @param {boolean} [opts.force] 手动触发时忽略「刚查过」的节流
   * @param {boolean} [opts.apply] 是否真的安装（false = 只检查）
   */
  async check({ trigger = TRIGGERS.scheduled, force = false, apply = true } = {}) {
    if (this.stopped) return { result: RESULT.skipped, reason: '已停止' }
    if (this.running) {
      // 不排队、不死等：和内核切换同一个原则（KERNEL_BUSY 那套）。
      return { result: RESULT.busy, reason: '上一次检查尚未结束' }
    }
    if (!force && trigger === TRIGGERS.manual && this.#justChecked()) {
      return { result: RESULT.busy, reason: '刚刚检查过，稍后再试' }
    }

    this.running = true
    const startedAt = Date.now()
    try {
      const outcome = await this.#run({ trigger, apply })
      this.#afterSuccess(outcome, trigger)
      return outcome
    } catch (err) {
      return this.#afterFailure(err, trigger)
    } finally {
      this.running = false
      this.state.nextCheckAt = new Date(Date.now() + CHECK_INTERVAL_MS).toISOString()
      console.log(
        `[kernel:auto] 检查结束（${trigger}，${Date.now() - startedAt}ms）：${this.state.lastResult} ${this.state.lastMessage || ''}`.trim()
      )
    }
  }

  /** 60s 内的重复手动检查直接忽略，避免用户连点把 registry 打爆。 */
  #justChecked() {
    if (!this.state.lastCheckAt) return false
    return Date.now() - new Date(this.state.lastCheckAt).getTime() < 60 * 1000
  }

  async #run({ trigger, apply }) {
    const cfg = this.#cfg()
    const current = this.registry.currentVersion || cfg.currentVersion || null

    // 1) 来源：registry 的 dist-tag。auto 模式跟随 latest，pinned 模式只报告不动。
    const latest = await this.manager.client.latest()
    const target = latest?.version || null
    if (!target) throw new Error('registry 未返回可用版本（latest 为空）')

    this.#emit({ lastCheckAt: nowIso(), lastTarget: target }, `远端 latest = ${target}，本地 current = ${current || '（无）'}`)

    // 2) 比对规则
    const decision = this.#decide({ current, target, cfg })
    if (decision.action === 'skip') {
      this.#emit(
        { lastResult: RESULT.skipped, lastMessage: decision.reason },
        `跳过：${decision.reason}`
      )
      return { result: RESULT.skipped, reason: decision.reason, current, target }
    }

    if (!apply || !cfg.autoUpdate) {
      // 手动「只检查」或开关关着：把结论交给界面，不自动装。
      this.#emit(
        { lastResult: RESULT.skipped, lastMessage: `发现 ${target}（自动更新未开启，需手动确认）` },
        `发现新版本 ${target}，未自动安装`
      )
      return { result: RESULT.skipped, reason: 'autoUpdate 未开启', current, target, pending: true }
    }

    // 3) 拉取并安装：走与手动「下载并安装」完全相同的流水线
    const from = current
    const result = await this.installAndActivate(target, { trigger })
    const to = result?.version || target
    this.#emit(
      {
        lastResult: current ? RESULT.updated : RESULT.installed,
        lastMessage: `已从 ${from || '（无）'} 更新到 ${to}`,
        updatedFrom: from,
        updatedTo: to
      },
      `已更新：${from || '（无）'} → ${to}`
    )
    return { result: current ? RESULT.updated : RESULT.installed, from, to, target }
  }

  /**
   * 版本比对规则（唯一真相源）。
   *
   * - 没有当前内核 → 装（首次使用）
   * - 相同 → 已是最新
   * - 更新 → 装
   * - 更旧 → 不自动降级（registry 的 latest 被打回旧版本时必须保守）
   * - pinned 模式 → 只报告
   * - 当前是正式版、目标是预发布 → 不自动跳（正式版不该被 rc 覆盖）
   * - 跨预发布通道（rc → alpha）→ 不自动跳，交给人工
   */
  #decide({ current, target, cfg }) {
    if (!current) return { action: 'install' }
    if (cfg.mode === 'pinned') {
      return { action: 'skip', reason: `固定版本模式（${cfg.pinnedVersion || current}），不自动切换` }
    }
    if (compareSemver(target, current) === 0) {
      return { action: 'skip', reason: `已是最新（${current}）` }
    }
    if (!isNewer(target, current)) {
      return { action: 'skip', reason: `远端 ${target} 低于当前 ${current}，不自动降级` }
    }
    if (!isPrerelease(current) && isPrerelease(target)) {
      return { action: 'skip', reason: `当前为正式版 ${current}，不自动跳到预发布 ${target}` }
    }
    const fromCh = prereleaseChannel(current)
    const toCh = prereleaseChannel(target)
    if (fromCh && toCh && fromCh !== toCh) {
      return { action: 'skip', reason: `预发布通道变化（${fromCh} → ${toCh}），需手动确认` }
    }
    return { action: 'install' }
  }

  /* ------------------------------------------------------------------ *
   * 失败处理与退避
   * ------------------------------------------------------------------ */

  #afterSuccess(outcome, trigger) {
    this.failures = 0
    if (this.timers.retry) {
      clearTimeout(this.timers.retry)
      this.timers.retry = null
    }
    return outcome
  }

  /**
   * 失败分类 + 指数退避。
   *
   * 网络类（ETIMEDOUT / ENOTFOUND / ECONNRESET / 代理/超时）走退避重试；
   * 校验类与权限类**不重试**——重试只会再失败一次，还可能把 staging 反复
   * 重建。无论哪种失败，当前内核都没被动过（流水线的原子性保证）。
   */
  #afterFailure(err, trigger) {
    const message = err?.message || String(err)
    this.failures += 1
    const retryable = /ETIMEDOUT|ENOTFOUND|ECONNRESET|EAI_AGAIN|EPIPE|socket hang up|请求超时|请求 registry 失败|aggregate/i.test(message)
    this.#emit(
      { lastResult: RESULT.failed, lastMessage: message },
      `${trigger} 触发的检查失败：${message}${retryable ? '（网络类，将退避重试）' : '（非网络类，不自动重试）'}`
    )

    if (retryable && !this.stopped) {
      const delay = RETRY_BACKOFF_MS[Math.min(this.failures - 1, RETRY_BACKOFF_MS.length - 1)]
      if (this.timers.retry) clearTimeout(this.timers.retry)
      this.timers.retry = setTimeout(() => {
        this.timers.retry = null
        this.check({ trigger: TRIGGERS.retry }).catch(() => {})
      }, delay)
      this.state.nextCheckAt = new Date(Date.now() + delay).toISOString()
    }
    return { result: RESULT.failed, reason: message, retryable }
  }

  /**
   * 开关：只影响「查到新版本后要不要自动装」。
   * 关掉之后仍然定时检查，好让面板继续显示「有新版本可用」。
   */
  setEnabled(enabled) {
    this.state = { ...this.state, enabled: !!enabled }
    this.#emit({}, `自动更新已${enabled ? '开启' : '关闭'}（检查仍在进行）`)
    return this.snapshot()
  }

  /** 面板用的一次性快照。 */
  snapshot() {
    return { ...this.state, intervalMs: CHECK_INTERVAL_MS }
  }
}

module.exports = {
  KernelAutoUpdater,
  TRIGGERS,
  RESULT,
  STARTUP_DELAY_MS,
  CHECK_INTERVAL_MS,
  RETRY_BACKOFF_MS
}
