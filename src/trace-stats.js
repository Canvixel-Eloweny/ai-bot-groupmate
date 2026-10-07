/**
 * 提示词命中率的**长期留档**（第 37 轮 B10f 收口 · O-CACHESTAT）
 * ══════════════════════════════════════════════════════════════════════════
 *  为什么需要它 —— 一次真实的"量数基准被自己吃掉了"
 * ══════════════════════════════════════════════════════════════════════════
 *  B10e 在 14:48 用 `scripts/prompt-diff.mjs` 量出「改序后真机中位 95.7%」，
 *  计划把「复量中位 ≥95.7%」定为 B10f 的**硬闸门**。
 *
 *  结果第 37 轮收口时复量：46 组样本的中位是 87.7%，而 95.7% 再也拿不出来。
 *  根因不是代码坏了，也不是提示词退步了，而是：
 *
 *    `src/index.js` 的 `TRACE_MAX = 120` + `truncateLinesAtomic(file, 120, 0.5)`
 *    会在超过 120 行时**折半截断** `panel/local-trace.jsonl`。
 *    它是给面板"看最近几条"用的有界窗口，**注定装不下一条要跨小时对比的基准线**。
 *
 *  也就是说：**闸门依赖的样本，被同一批代码里的截断策略销毁了**。
 *  表现与"它怎么突然变味了"同形 —— 不报错、不告警，只是某天发现基准没了。
 *  这正是本项目反复要消灭的那一类静默失效。
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  改法：把"要长期留的东西"与"要现看的东西"分开
 * ══════════════════════════════════════════════════════════════════════════
 *  - `panel/local-trace.jsonl`：**保持不变**。它是复盘窗口（含整包 prompt 正文），
 *    有界是它的特性，不是缺陷。
 *  - `panel/prompt-stats.json`：**只增不减**的**聚合**留档。不存 prompt 正文，
 *    只存"这一轮与上一轮的公共前缀占比"这一个数 —— 于是体积与聊天量**无关**：
 *    每天最多 101 个直方图桶 + 4 个计数，一年约几百 KB。
 *
 *  ⚠️ 刻意**不存 prompt 正文**：正文里有群聊内容与（已被哈希化的）图片引用，
 *     长期累积既没必要，也与"会话存档只留该留的"这条边界相冲突。
 *     要复盘正文去看 local-trace 的最近窗口；要长期趋势看这里。
 *
 *  ⚠️ 中位数由直方图反推，**精度 1%**（100 个桶）。这个精度足够做闸门
 *     （闸门本身就是 95.7% 这种百分比），而它换来的是固定体积。
 *     min / max 不存桶里，单独精确保留。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// 本地日期键的**唯一实现**住在 `holidays.js`（零依赖叶子）—— 这里只 import，不再自己拼一份。
// 第 13 轮 H-11：它曾有 `dayKeyOf` / `isoOfLocal` / `usage.monthKey` 三份 + `cache-hit.dayOf` 一份。
import { dayKeyOf } from './holidays.js';
import { writeJsonAtomic } from './atomic-write.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 直方图桶数：100 = 1% 一档。改它等于改中位数的精度，会同时影响历史数据的解读 */
export const RATIO_BUCKETS = 100;

/**
 * 最长公共前缀的长度（逐字符）。
 *
 * ⚠️ **判据只此一份**：`scripts/prompt-diff.mjs` 与 `test/smoke.js` 都从这里 import，
 *    不许各写一份 —— 本项目已经在 `normalizeThinking` 上真实踩过"两份拷贝各自漂移"，
 *    而这一份一旦漂移，"改前 vs 改后"的数字就不可比了（那正是本模块存在的理由）。
 */
export function lcp(a, b) {
  const x = String(a ?? '');
  const y = String(b ?? '');
  const n = Math.min(x.length, y.length);
  let i = 0;
  while (i < n && x[i] === y[i]) i += 1;
  return i;
}

/**
 * 从整包 prompt 文本里切出「背景消息」段。
 * 起点 `## 刚才群里的消息`，终点是下一个 `## ` 标题或必变段（当前时间）。
 *
 * 与 `lcp` 同理：**判据只此一份**（"背景段有没有变"就是靠它判的）。
 */
export function ambientBlockOf(prompt) {
  const s = String(prompt ?? '');
  const start = s.indexOf('## 刚才群里的消息');
  if (start < 0) return '';
  const lines = s.slice(start).split('\n');
  const out = [lines[0]];
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].startsWith('## ') || lines[i].startsWith('当前时间：')) break;
    out.push(lines[i]);
  }
  return out.join('\n');
}

/**
 * 留档文件路径。`QQBOT_PROMPT_STATS` 让测试指去临时目录 ——
 * 与 `QQBOT_CONFIG` / `QQBOT_TRACE_FILE` / `QQBOT_USAGE_FILE` / `QQBOT_SESSION_ARCHIVE`
 * 同一套做法（每次调用重新读环境变量，避免"改完却不生效"）。
 */
export function statsFilePath() {
  if (process.env.QQBOT_PROMPT_STATS) return path.resolve(process.env.QQBOT_PROMPT_STATS);
  return path.join(ROOT, 'panel', 'prompt-stats.json');
}

/** 一个空的统计槽：n / 直方图 / ambient 变动计数 / 精确 min-max / 时间覆盖范围 */
function emptySlot() {
  return { n: 0, hist: {}, ambient: 0, minRatio: 1, maxRatio: 0, firstT: 0, lastT: 0 };
}

export function emptyStats() {
  return { v: 1, total: emptySlot(), days: {} };
}

/** 把一个占比塞进直方图（1% 一档，上限桶兜住恰好 1.0 的情况） */
function addToSlot(slot, { ratio, ambientChanged, t }) {
  const r = Number.isFinite(ratio) ? Math.min(1, Math.max(0, ratio)) : 0;
  const b = Math.min(RATIO_BUCKETS, Math.floor(r * RATIO_BUCKETS));
  return {
    n: slot.n + 1,
    hist: { ...slot.hist, [b]: (slot.hist[b] || 0) + 1 },
    ambient: slot.ambient + (ambientChanged ? 1 : 0),
    // min / max 不落桶：桶会把 87.7% 记成 87%，闸门看的是真值
    minRatio: slot.n === 0 ? r : Math.min(slot.minRatio, r),
    maxRatio: slot.n === 0 ? r : Math.max(slot.maxRatio, r),
    firstT: slot.n === 0 ? t : Math.min(slot.firstT, t),
    lastT: slot.n === 0 ? t : Math.max(slot.lastT, t),
  };
}

/**
 * 折进一条样本。**纯函数**：返回新对象，不改入参 ——
 * 这样"同一批样本不管以什么顺序折入，结果都一样"可以被 smoke 直接断言。
 *
 * @param {object} stats 上一版留档（`emptyStats()` 起手）
 * @param {{day:string, ratio:number, ambientChanged:boolean, t?:number}} sample
 */
export function foldSample(stats, sample) {
  const base = stats && typeof stats === 'object' && stats.total ? stats : emptyStats();
  const day = sample?.day || dayKeyOf();
  const t = Number.isFinite(sample?.t) ? sample.t : Date.now();
  const one = { ratio: sample?.ratio, ambientChanged: !!sample?.ambientChanged, t };
  return {
    v: 1,
    total: addToSlot(base.total || emptySlot(), one),
    days: { ...(base.days || {}), [day]: addToSlot(base.days?.[day] || emptySlot(), one) },
  };
}

/**
 * 从直方图反推中位数。**精度 1%**：返回所属桶的下沿（桶 = floor(ratio×100)）。
 * 前一半落在哪个桶里，就是哪个桶。
 */
function medianOfSlot(slot) {
  if (!slot || !slot.n) return null;
  const half = (slot.n + 1) / 2;
  let acc = 0;
  const keys = Object.keys(slot.hist).map(Number).sort((a, b) => a - b);
  for (const k of keys) {
    acc += slot.hist[k];
    if (acc >= half) return k / RATIO_BUCKETS;
  }
  return null;
}

/** 把统计槽压成可读数字（中位用桶反推，min/max 用精确值，ambient 用精确计数） */
function summarizeSlot(slot) {
  if (!slot || !slot.n) return null;
  return {
    n: slot.n,
    median: medianOfSlot(slot),
    min: slot.minRatio,
    max: slot.maxRatio,
    ambientRate: slot.ambient / slot.n,
    firstT: slot.firstT,
    lastT: slot.lastT,
  };
}

/**
 * 汇总留档。
 * @param {object} stats
 * @param {{since?:string}} opts since = 只看该日期起的日桶（累计仍用 total）
 * @returns {{total:object|null, days:{day:string,stat:object}[]}}
 */
export function summarizeStats(stats, { since } = {}) {
  const base = stats && typeof stats === 'object' && stats.total ? stats : emptyStats();
  const days = Object.keys(base.days || {})
    .filter((d) => !since || d >= since)
    .sort()
    .map((day) => ({ day, stat: summarizeSlot(base.days[day]) }))
    .filter((x) => x.stat);
  return { total: summarizeSlot(base.total), days };
}

/**
 * 由**相邻两轮 prompt** 算出一条样本。
 * 两轮相同 / 任一轮为空 → null（没有可比的样本，不硬凑一个 1.0 进去）。
 */
export function sampleOf(prevPrompt, curPrompt, { t } = {}) {
  if (typeof prevPrompt !== 'string' || typeof curPrompt !== 'string' || !prevPrompt || !curPrompt) return null;
  const len = Math.min(prevPrompt.length, curPrompt.length);
  if (!len) return null;
  return {
    ratio: lcp(prevPrompt, curPrompt) / len,
    ambientChanged: ambientBlockOf(prevPrompt) !== ambientBlockOf(curPrompt),
    t,
  };
}

/** 读留档。坏文件 / 不存在都当空 —— 统计读不出来绝不能影响机器人说话 */
export function readStats(file = statsFilePath()) {
  try {
    const o = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (o && typeof o === 'object' && o.total && o.total.n >= 0 && o.days) return o;
    return emptyStats();
  } catch {
    return emptyStats();
  }
}

/** 写留档。走原子写：面板可能正在读它，半份 JSON 会让趋势图闪成空白 */
export function writeStats(stats, file = statsFilePath()) {
  writeJsonAtomic(file, stats);
}

/**
 * 模块级便捷入口：读 → 折 → 写。
 * 每次回复一次读盘太贵，所以**进程内缓存**一份；失败一律吞掉（统计不该拖垮对话）。
 *
 * ⚠️ 只允许**写入方**（src/index.js）调用。面板只读。
 */
let CACHE = null;
export function recordSample(sample, file = statsFilePath()) {
  try {
    if (!CACHE) CACHE = readStats(file);
    CACHE = foldSample(CACHE, sample);
    writeStats(CACHE, file);
    return true;
  } catch {
    return false;
  }
}

/** 测试用：丢掉进程内缓存（不这么做，smoke 之间会互相串味） */
export function resetStatsCache() {
  CACHE = null;
}
