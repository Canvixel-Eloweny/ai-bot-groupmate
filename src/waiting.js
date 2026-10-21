/**
 * 聊天等待（拟人）：收到消息之后**先停一下再回**，以及「正在输入」与慢任务垫一句。
 *
 * 为什么单独一个叶子：这三个数（停多久 / 攒多久 / 多久垫一句）都是**行为参数**，
 * 判据必须是纯函数 —— 否则面板改的是一套、主链路算的是另一套，两边迟早漂。
 * 与 `src/pace.js`（出站每条之间的节奏）分工不同：
 *   · `pace.js`  —— **发出去之后**，下一条前停多久（已经存在的「别刷屏」）；
 *   · 本文件    —— **回之前**，先等多久（真人看完、想一下、才开始打字）。
 *
 * ⚠️ 这些秒数是**经验值**，不是 QQ 或模型的官方阈值。默认值刻意保守（最长 2.5 秒），
 *    它们只影响观感，不影响判定：闸门、限流、额度一个都不看这里。
 */

/** 默认值。想改在 `config.json` 的 `custom.wait` 段里改（面板「触发方式 → 聊天等待」） */
export const WAIT_DEFAULTS = Object.freeze({
  /** 总开关。关掉 = 一条都不等，回到改造前的行为 */
  enabled: true,
  /** 最短停顿（毫秒） */
  minMs: 400,
  /** 最长停顿（毫秒） */
  maxMs: 2500,
  /** 每多一个字多停多久（毫秒）——长消息像真人多打一会儿 */
  perCharMs: 15,
  /**
   * 连发合并：同一个人连着发几条时，等这么久（毫秒）没人再发才合成一轮。
   * 0 = 不合并（每条都单独成一轮）。
   */
  mergeMs: 1200,
  /** 慢任务垫一句：模型超过这么久（毫秒）还没出结果，先回一句「我想想」 */
  holdMs: 6000,
  /** 垫的那句话。空串 = 不垫 */
  holdText: '我想想…',
  /** 私聊里显示「正在输入」气泡（群聊协议端不支持，自动忽略） */
  typing: true,
});

/** 只接受非负整数，其余回落 —— 配置里填 "abc" / -5 不该变成 NaN 等待 */
function posInt(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : fallback;
}

/**
 * 把 `custom.wait`（或老的缺省）归一化成一份完整的开关对象。
 * 只认布尔 false 作为关闭，其余非法值一律回落默认 —— 与 `readCustom` 里那些开关同款。
 *
 * @param {object} [custom] 整份 `cfg.custom`
 */
export function waitTuningOf(custom) {
  const w = custom?.wait || {};
  const minMs = posInt(w.minMs, WAIT_DEFAULTS.minMs);
  const maxMs = Math.max(minMs, posInt(w.maxMs, WAIT_DEFAULTS.maxMs));
  return {
    enabled: w.enabled !== false,
    minMs,
    maxMs,
    perCharMs: posInt(w.perCharMs, WAIT_DEFAULTS.perCharMs),
    mergeMs: posInt(w.mergeMs, WAIT_DEFAULTS.mergeMs),
    holdMs: posInt(w.holdMs, WAIT_DEFAULTS.holdMs),
    holdText: typeof w.holdText === 'string' ? w.holdText.slice(0, 40) : WAIT_DEFAULTS.holdText,
    typing: w.typing !== false,
  };
}

/**
 * 这一轮「回之前先等多久」。**纯函数**，随机源可注入（断言才能钉住区间）。
 *
 * @param {{chars?:number, tuning?:object, rng?:()=>number}} [opts]
 * @returns {number} 毫秒；`enabled === false` 时恒为 0
 */
export function humanDelayMs({ chars = 0, tuning = WAIT_DEFAULTS, rng = Math.random } = {}) {
  const t = tuning || WAIT_DEFAULTS;
  if (t.enabled === false) return 0;
  const minMs = posInt(t.minMs, WAIT_DEFAULTS.minMs);
  const maxMs = Math.max(minMs, posInt(t.maxMs, WAIT_DEFAULTS.maxMs));
  const perCharMs = posInt(t.perCharMs, WAIT_DEFAULTS.perCharMs);
  const r = Math.min(1, Math.max(0, Number(rng()) || 0));
  const extra = Math.round(r * (maxMs - minMs));
  const len = posInt(chars, 0);
  return Math.min(maxMs, minMs + extra + len * perCharMs);
}
