/**
 * 协议端进程守护（Windows 原生 NapCat）
 * ══════════════════════════════════════════════════════════════════════════
 *  `src/onebot.js` 的看门狗只管**连接**（心跳停摆就重连）；它管不了
 *  「NapCatWinBootMain.exe / QQ.exe 整个进程没了」——那时重连永远失败，
 *  机器人会一直哑着，直到用户自己发现。
 *
 *  本文件补的是**进程级**那一半，判据顺序来自群友独立版
 *  `Win-v0.1.1/app/panel/lib/protocol-guard.js`（2026-10-17），但实现按本仓的
 *  依赖边界重写：面板已经合法持有 NapCat 知识（`napcat-native.js`），不需要
 *  再走 `QQBOT_PROTOCOL_LAUNCHER` 环境变量。
 *
 *  七条判据（命中即返回）：
 *    ① 守护关着 / 没配拉起方式 → skip / give_up（不是故障）
 *    ② QQ 账号掉线             → skip（重启没用，还会多一次风控）
 *    ③ 端口还有应答             → skip（协议端还活着），并记 seenAlive
 *    ④ 探测失败（null）        → skip（本功能最贵的错是**误拉**）
 *    ⑤ 本次运行从没活过且非 force → skip（首次安装不替用户开窗口）
 *    ⑥ 冷却中 / 超过上限        → skip / give_up
 *    ⑦ 其余                    → spawn
 *
 *  ⚠️ 停止链（两个停止接口 + shutdown）必须**先** `stop()` 再停协议端；
 *     否则刚停掉的协议端会被下一拍拉回来，用户看到的是「关不掉」。
 * @module protocol-guard
 */

/** 经验值，不是官方阈值。 */
export const GUARD_DEFAULTS = Object.freeze({
  intervalMs: 15000,
  maxAttempts: 3,
  cooldownsMs: [60000, 180000, 540000],
  readyWaitMs: 90000,
});

/**
 * 这一拍该不该拉起。**纯函数**，测试直接喂反例。
 *
 * @param {{now:number, guard:object, configured?:boolean, onebotState?:string,
 *          alive?:boolean|null, force?:boolean}} ctx
 * @returns {{act:'spawn'|'skip'|'give_up', reason:string, verbose?:boolean}}
 */
export function guardDecision({ now, guard, configured = true, onebotState = '', alive = null, force = false } = {}) {
  if (!guard?.enabled) return { act: 'skip', reason: '守护关着（面板里关的）' };
  if (!configured) return { act: 'give_up', reason: '没配拉起方式（只上报）' };
  if (onebotState === 'offline') {
    return { act: 'skip', reason: 'QQ 账号掉线（不是进程死）—— 重启没用，还会多一次风控判定', verbose: true };
  }
  if (alive === true) return { act: 'skip', reason: '协议端还活着（端口有应答）' };
  if (alive === null) return { act: 'skip', reason: '端口探测失败，拿不准 —— 不冒险拉起', verbose: true };
  if (!guard.seenAlive && !force) {
    return { act: 'skip', reason: '本次运行里协议端从没起来过 —— 首次安装请自己双击启动（不替你开窗口）' };
  }
  if (!force && now < guard.nextRetryAt) {
    return { act: 'skip', reason: `冷却中（还剩 ${Math.max(1, Math.ceil((guard.nextRetryAt - now) / 1000))} 秒）`, verbose: true };
  }
  if (!force && guard.attempts >= guard.maxAttempts) {
    return { act: 'give_up', reason: `连续 ${guard.attempts} 次没拉起来，已停止自动拉起` };
  }
  return { act: 'spawn', reason: '协议端进程不在了' };
}

/**
 * 建一个守护实例。返回 `{ start, stop, runStep, stateOf, noteAttempt }`。
 *
 * @param {{probeAlive:()=>Promise<boolean|null>, launch:()=>Promise<{ok?:boolean,msg?:string}>|{ok?:boolean,msg?:string},
 *          readOnebotState?:()=>string, log?:(m:string)=>void, now?:()=>number, conf?:object}} deps
 */
export function createProtocolGuard({
  probeAlive,
  launch,
  readOnebotState = () => '',
  log = () => {},
  now = () => Date.now(),
  conf = GUARD_DEFAULTS,
} = {}) {
  const configured = typeof probeAlive === 'function' && typeof launch === 'function';
  const g = {
    enabled: true,
    configured,
    configReason: configured ? '' : '没配探测/拉起方式 —— 只上报',
    attempts: 0,
    lastAttemptAt: 0,
    nextRetryAt: 0,
    readyUntil: 0,
    lastError: '',
    gaveUp: false,
    seenAlive: false,
    stopped: false,
  };
  let timer = null;

  function scheduleRetry(at) {
    const idx = Math.min(Math.max(0, g.attempts - 1), conf.cooldownsMs.length - 1);
    const cool = now() + conf.cooldownsMs[idx];
    g.nextRetryAt = Math.max(cool, at || 0);
  }

  async function runStep({ force = false } = {}) {
    if (g.stopped) return { act: 'skip', reason: '守护已停（关停链上）' };
    if (!configured) return { act: 'give_up', reason: g.configReason };
    const t = now();
    const onebotState = String(readOnebotState?.() || '');
    let alive = null;
    try {
      alive = await probeAlive();
    } catch {
      alive = null;
    }
    if (alive === true) {
      g.seenAlive = true;
      g.attempts = 0;
      g.nextRetryAt = 0;
      g.readyUntil = 0;
    }
    // 刚拉起、还在等端口就绪：别再撞一次（否则 15 秒一拍会起出第二个 NapCat）。
    if (!force && g.readyUntil && t < g.readyUntil && alive !== true) {
      return { act: 'skip', reason: '上次拉起还在等端口就绪', verbose: true };
    }
    const d = guardDecision({ now: t, guard: g, configured, onebotState, alive, force });
    if (d.act === 'spawn') {
      g.lastAttemptAt = t;
      g.attempts += 1;
      g.readyUntil = t + conf.readyWaitMs;
      try {
        const r = await launch();
        if (r && r.ok === false) {
          g.lastError = String(r.msg || '拉起失败');
          scheduleRetry(g.readyUntil);
          log(`[守护] 拉起失败：${g.lastError}`);
          return { act: 'spawn', ok: false, reason: g.lastError };
        }
        log(`[守护] 已发起拉起（第 ${g.attempts} 次）`);
        scheduleRetry(g.readyUntil);
        return { act: 'spawn', ok: true, reason: d.reason };
      } catch (e) {
        g.lastError = `拉起进程出错：${e?.message || e}`;
        scheduleRetry(g.readyUntil);
        log(`[守护] ${g.lastError}`);
        return { act: 'spawn', ok: false, reason: g.lastError };
      }
    }
    if (d.act === 'give_up') {
      if (!g.gaveUp) {
        g.gaveUp = true;
        log(`[守护] 停手：${d.reason}`);
      }
      return d;
    }
    if (d.verbose) log(`[守护] 不拉起：${d.reason}`);
    return d;
  }

  function start() {
    if (!configured || timer) return;
    timer = setInterval(() => {
      void runStep().catch((e) => log(`[守护] 检查异常：${e?.message || e}`));
    }, conf.intervalMs);
    timer.unref?.();
    log(`[守护] 已启动：每 ${Math.round(conf.intervalMs / 1000)} 秒检查一次`);
  }

  async function stop() {
    g.stopped = true;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    log('[守护] 已停止（关停链）');
  }

  /** 自启入口发起过拉起（无论成功失败）后调用：允许守护后续按冷却重试。 */
  function noteAttempt() {
    g.seenAlive = true;
  }

  function stateOf() {
    return {
      configured: g.configured,
      configReason: g.configReason,
      enabled: g.enabled,
      attempts: g.attempts,
      lastAttemptAt: g.lastAttemptAt,
      nextRetryAt: g.nextRetryAt,
      lastError: g.lastError,
      gaveUp: g.gaveUp,
      seenAlive: g.seenAlive,
    };
  }

  return { start, stop, runStep, stateOf, noteAttempt };
}
