/**
 * `context` 那三个整数的默认值与夹取 —— **唯一一份**（2026-11-03）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  为什么要单独成一个叶子
 * ══════════════════════════════════════════════════════════════════════════
 *  面板的「带入最近几轮对话」「带入几条群里闲聊当背景」这两格，以前读的是
 *  `config.presets[当前大脑].context.*` —— 那是**切大脑时归档的快照**，
 *  而运行时真正用的是 `src/config.js` 归一化出来的顶层 `cfg.context`。
 *  于是"保存后刷新还是旧数字"：用户以为没生效，反复重填。
 *
 *  要改成读真值，就不能把夹取与默认值**再抄一遍**到面板侧（抄两份必然漂移，
 *  这是本项目的头号纪律）。而面板侧也**不许**直接引 `src/config.js` ——
 *  §82 的准入判据写明共享叶子的闭包不得触达 `config` 本体（那会把面板进程的
 *  启动路径和机器人进程的启动路径缠在一起，后果是"加载期拿到半成品常量"，
 *  而且不报错）。所以把这三行抽成一个零依赖叶子，两侧引同一份。
 *
 * ⚠️ 零依赖叶子：只 import `ambient.js`（它自己也是零 import 的叶子）。
 *    不碰 node:、不读 env、不碰 IO —— 这是 §82 放行的前提，不是风格。
 */
import { DEFAULT_AMBIENT_BATCH } from './ambient.js';

/**
 * 默认值与下限（**经验值**，不是官方阈值）。
 *
 * · `recentTurns` 12 / 下限 2：一轮 = 一问一答；下限不是 0，因为带 0 轮
 *   等于"完全不记得上一句"，那是另一种坏法，不该由一个数字输入框误触。
 * · `ambientMessages` 20 / 下限 0：背景段可以为 0（用户明确要"别管群里闲聊"）。
 * · `ambientBatch` 4：见 `ambient.js` —— 成批更替的粒度，默认值只有那一处定义。
 */
const CONTEXT_INT_FIELDS = Object.freeze({
  recentTurns: { def: 12, min: 2 },
  ambientMessages: { def: 20, min: 0 },
  ambientBatch: { def: DEFAULT_AMBIENT_BATCH, min: 1 },
});

function asInt(v, fallback) {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * 只归一化三个整数（`budget` 那块留在 `src/config.js`，它归
 * `context-budget.js` 的 `budgetOf` 管，本叶子不该认识预算表）。
 *
 * @param {object|null|undefined} raw 未经归一化的那一份配置（**没有配置时是 null**，
 *   面板在没有 config.json 的机器上就会拿到 null —— 默认参数只挡 undefined，
 *   所以这里必须用可选链，否则 `/api/state` 直接 500）。
 * @returns {{recentTurns:number, ambientMessages:number, ambientBatch:number}}
 */
export function normalizeContextInts(raw) {
  const out = {};
  for (const [key, { def, min }] of Object.entries(CONTEXT_INT_FIELDS)) {
    out[key] = Math.max(min, asInt(raw?.context?.[key], def));
  }
  return out;
}
