/**
 * ══════════════════════════════════════════════════════════════════════
 *  峰谷闸（C 改造）—— 工作日高峰里，群里没被叫到就不出声
 * ══════════════════════════════════════════════════════════════════════
 *  为什么要有这道闸：
 *    高峰时段（工作日 9:00–12:00、14:00–18:00）模型计价贵、群里话最多，
 *    而"没人叫它、它自己凑一句"是成本最高、最容易被当成刷屏的行为。
 *    这不是"限流"（限流管的是频率），是**节奏**：一天里有的时段它该安静待着。
 *
 *  判据全在这个零依赖叶子里：时间窗、星期几、以及"算不算被叫到"三件事。
 *    · 时间窗与星期 → 纯函数，`now` 入参，可被断言钉死；
 *    · "算不算被叫到"由调用方给出（@、引用我的话、关键词、拍一拍、私聊），
 *      这里只做**或**运算 —— 不猜业务，否则一条判据会在两个地方各长一份。
 *
 *  ⚠️ 与 `src/sleep.js` 的分工：睡眠是"整个人不在"（连未读都不消费、醒来补看）；
 *     峰谷只是"这个时段不主动搭话"——被叫到照回，未读照留（不消费，也不补看）。
 *     混成一个模块会让"为什么没回"分不清是睡着了还是闭嘴了，而这两件事的处理完全不同。
 *
 *  ⚠️ 零依赖叶子：不 import 任何模块（连 node: 内置都不引），`now` 由调用方传。
 */

/** 高峰窗口（分钟数，左闭右开）。默认就是需求里那两段 —— 只此一份，别处不许再写数字。 */
export const PEAK_WINDOWS = Object.freeze([
  Object.freeze({ from: 9 * 60, to: 12 * 60, label: '09:00–12:00' }),
  Object.freeze({ from: 14 * 60, to: 18 * 60, label: '14:00–18:00' }),
]);

/** 默认开：这套默认值是给"群里的陪伴型机器人"准备的；不想要的人在配置里关掉。 */
export const PEAK_DEFAULTS = Object.freeze({ enabled: true, muteUnmentioned: true });

/**
 * 归一化 `custom.peak`。
 *
 * ⚠️ 只认**真的是 true** 的开关（`"true"` 字符串不算）—— 这一条和本项目其它总闸同款：
 *    配置被手改成字符串时，宁可回到默认，也不要"看起来开了其实没开"。
 *
 * @param {any} raw config.json 里的 `custom.peak`
 * @returns {{enabled: boolean, muteUnmentioned: boolean}}
 */
export function readPeak(raw) {
  const v = raw && typeof raw === 'object' ? raw : {};
  return {
    enabled: v.enabled === undefined ? PEAK_DEFAULTS.enabled : v.enabled === true,
    muteUnmentioned: v.muteUnmentioned === undefined ? PEAK_DEFAULTS.muteUnmentioned : v.muteUnmentioned === true,
  };
}

/** 这一分钟落在哪个高峰窗口里（工作日才算）。不在窗口内 → null。 */
export function peakWindowOf(now = 0) {
  const d = new Date(now);
  const wd = d.getDay();
  if (wd === 0 || wd === 6) return null;
  const m = d.getHours() * 60 + d.getMinutes();
  for (const w of PEAK_WINDOWS) {
    if (m >= w.from && m < w.to) return w;
  }
  return null;
}

/**
 * 这一条该不该闭嘴？
 *
 * @param {object} p
 * @param {number} p.now 毫秒时间戳（调用方传，便于断言）
 * @param {'group'|'private'} [p.scene] 私聊没有沉默档
 * @param {boolean} [p.mentionedSelf] 被 @ 了
 * @param {boolean} [p.repliedToMe] 引用了我之前说的话（M-4 的既有口径）
 * @param {boolean} [p.keywordHit] 命中触发词（等于点了它的名）
 * @param {boolean} [p.isPoke] 拍一拍（本身不产生文字回复，但算打招呼）
 * @param {boolean} [p.isCatchUp] 起床补看那一轮
 * @param {{enabled: boolean, muteUnmentioned: boolean}} [p.peak] `readPeak()` 的结果
 * @returns {string} 非空＝这一轮不出声，值是能查的原因；空串＝照常处理
 */
export function peakSkipReason(p = {}) {
  const peak = readPeak(p.peak);
  if (!peak.enabled || !peak.muteUnmentioned) return '';
  if (p.scene && p.scene !== 'group') return '';
  const called = !!(p.mentionedSelf || p.repliedToMe || p.keywordHit || p.isPoke);
  if (called) return '';
  const w = peakWindowOf(p.now);
  if (!w) return '';
  return `高峰时段（工作日 ${w.label}），没被叫到就不出声`;
}

/**
 * 主动开口也该闭嘴吗（定时消息不受这条限制：那是用户点的活）。
 *
 * @param {number} now
 * @param {{enabled: boolean}} [peak] `readPeak()` 的结果
 */
export function peakQuietForProactive(now = 0, peak = PEAK_DEFAULTS) {
  const p = readPeak(peak);
  if (!p.enabled) return '';
  const w = peakWindowOf(now);
  return w ? `高峰时段（工作日 ${w.label}），不主动找话` : '';
}
