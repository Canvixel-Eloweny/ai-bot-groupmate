/**
 * 热度（关系温度 + 群活跃度）
 * ══════════════════════════════════════════════════════════════════════════
 *  两套 0–1 的权重，只有一个用途：**决定它要不要自己开口**。
 *
 *  ① 按人关系温度（0.1.1 `vendor/dsh-onebot/src/mood.ts` 的移植）
 *     一个人连着找它聊天，热值一点点往下掉（从 80% 往 60% 底线掉，半夜能掉到 30%）；
 *     没人说话时慢慢回升。冷了就少冒头 —— 概率乘 `(1 - 冷却权重)`。
 *  ② 按群活跃度
 *     最近一段时间有多少人在说话。活跃的群优先巡逻、先被搭话；
 *     一个半天没人吭声的群，不该被它硬找话说。
 *
 *  ⚠️ 零依赖叶子（不许 import 任何模块）：被 `src/brain.js`（判定）、
 *     `src/index.js`（记账与落盘）、`src/patrol.js` 与契约扫描器直接读。
 *  ⚠️ 纯函数：不读时钟、不碰 IO。`now` 一律由调用方传入。
 * @module heat
 */

/** 关系温度基线（热络的上沿）。 */
export const HEAT_BASE = 0.8;
/** 频繁对话的底线。 */
export const HEAT_FLOOR = 0.6;
/** 半夜被折腾才允许到的底线。 */
export const HEAT_NIGHT_FLOOR = 0.3;
/** 新建条目的随机抖动（「80% 上下」）。 */
export const HEAT_JITTER = 0.03;
/** 每轮高频对话扣多少。 */
const HEAT_DECAY = 0.02;
/** 同一人多久才扣一次（连发不叠加）。 */
const HEAT_DECAY_COOLDOWN_MS = 60_000;
/** 安静下来每小时回升多少（0.15 = 80 分钟回满）。 */
const HEAT_RECOVER_PER_HOUR = 0.15;
/** 半夜窗口（本地小时，跨零点）。 */
const HEAT_NIGHT_FROM = 23;
const HEAT_NIGHT_TO = 3;
/** 冷却链最多算几档。 */
export const HEAT_CHAIN_MAX = 4;
/** 一档冷却折成多少概率权重（0.15/档）。 */
export const HEAT_COOL_STEP = 0.15;
/** 隔这么久没说话，冷却链清零。 */
const HEAT_CHAIN_RESET_MS = 60 * 60_000;
/** 群活跃度的统计窗（近 30 分钟）。 */
const CHAT_HEAT_WINDOW_MS = 30 * 60_000;
/** 近窗口内多少条算「满热」。 */
export const CHAT_HEAT_TARGET = 20;

/** 现在是本地半夜（23:00–03:00）吗。 */
export function heatIsNight(now) {
  const hour = new Date(now).getHours();
  return hour >= HEAT_NIGHT_FROM || hour < HEAT_NIGHT_TO;
}

/** 当前底线：半夜 30%，平时 60%。 */
export function heatFloor(now) {
  return heatIsNight(now) ? HEAT_NIGHT_FLOOR : HEAT_FLOOR;
}

/**
 * 新建一条关系温度。
 * @param {number} now
 * @param {number} [rnd] 0–1 的随机数（判据要可复现，默认 Math.random）
 */
export function newHeatEntry(now, rnd = Math.random()) {
  return {
    w: HEAT_BASE + (rnd * 2 - 1) * HEAT_JITTER,
    at: now,
    decayedAt: now,
    chain: 0,
  };
}

/**
 * 读出来的旧账本归一：缺字段补上、越界夹住。
 * 坏值一律当成「新建」，**不编一个看起来正常的数**（与面板读盘的纪律同一条）。
 */
export function normalizeHeatEntry(v, now) {
  if (!v || typeof v !== 'object') return newHeatEntry(now, 0.5);
  const at = Number.isFinite(v.at) ? v.at : now;
  const w = Number.isFinite(v.w) ? Math.min(1, Math.max(0, v.w)) : HEAT_BASE;
  const decayedAt = Number.isFinite(v.decayedAt) ? v.decayedAt : at;
  const chain = Number.isFinite(v.chain) ? Math.min(HEAT_CHAIN_MAX, Math.max(0, v.chain)) : 0;
  return { w, at, decayedAt, chain };
}

/** 安静时缓慢回升到基线（只往上）。 */
function recoverHeat(entry, now) {
  const hours = Math.max(0, now - entry.at) / 3_600_000;
  if (hours > 0) entry.w = Math.min(HEAT_BASE, entry.w + hours * HEAT_RECOVER_PER_HOUR);
}

/**
 * 记一轮对话（**原地改**，调用方负责落盘）。
 * 先按静默时长回升，再按冷却扣温；到当前底线就保持。
 * 冷却链只在 `w` 还没掉到 floor 时累加 —— 冷了就不再叠加。
 */
export function noteHeatTurn(entry, now) {
  recoverHeat(entry, now);
  if (now - entry.at >= HEAT_CHAIN_RESET_MS) entry.chain = 0;
  if (now - entry.decayedAt >= HEAT_DECAY_COOLDOWN_MS && entry.w > heatFloor(now)) {
    const chain = Math.min(entry.chain, HEAT_CHAIN_MAX);
    // 0.1.1 的 ramp（0.5）：chain 每多一档，这一次多扣一半。
    entry.w = Math.max(heatFloor(now), entry.w - HEAT_DECAY * (1 + chain * 0.5));
    entry.decayedAt = now;
    entry.chain = Math.min(HEAT_CHAIN_MAX, entry.chain + 1);
  }
  entry.at = now;
}

/** 这个人的冷却权重（0–1）：主动开口的概率乘 `(1 - 它)`。 */
export function heatCoolOf(entry) {
  if (!entry) return 0;
  return Math.min(1, Math.max(0, entry.chain) * HEAT_COOL_STEP);
}

/** 主动开口的权重（0–1）：`1 - 冷却权重`。 */
export function heatWeightOf(entry) {
  return Math.min(1, Math.max(0, 1 - heatCoolOf(entry)));
}

/** 温度档（给人看的）。 */
export function heatBandOf(w) {
  if (w >= 0.75) return '热络';
  if (w >= HEAT_FLOOR) return '有点烦';
  if (w >= HEAT_NIGHT_FLOOR) return '冷淡';
  return '很不耐烦';
}


/**
 * 群活跃度（0–1）：近窗口内有多少条消息，越近越满。
 * @param {{at:number}[]} recent 近段消息的时间戳（乱序、跨窗口的都行）
 * @param {number} now
 * @param {number} [windowMs]
 * @param {number} [target] 窗口内满热条数
 */
export function chatHeatOf(recent, now, windowMs = CHAT_HEAT_WINDOW_MS, target = CHAT_HEAT_TARGET) {
  if (!Array.isArray(recent) || recent.length === 0) return 0;
  let n = 0;
  let newest = 0;
  for (const item of recent) {
    const at = Number(item?.at);
    if (!Number.isFinite(at) || now - at > windowMs || at > now) continue;
    n += 1;
    if (at > newest) newest = at;
  }
  if (n === 0) return 0;
  const volume = Math.min(1, n / Math.max(1, target));
  // 越新越热：刚有人说话 = 1，窗口末尾 = 0.5 —— 不乘到 0，否则「刚说完就冷」。
  const freshness = 0.5 + 0.5 * Math.max(0, 1 - (now - newest) / Math.max(1, windowMs));
  return Math.min(1, volume * freshness);
}
