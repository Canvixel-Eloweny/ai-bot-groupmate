/**
 * 本地对话流的**读盘口**（第 16 轮 · H-10「巨型文件拆分」第二半的第一步）。
 * ══════════════════════════════════════════════════════════════════════
 *  为什么单独成模块
 *  `TRACE_SHOWN` / `TRACE_AGGREGATE` / `readTrace` 原来住在 `panel/server.js` 里，
 * 而它们是**三个待搬的大块（`collectState` / `buildExport` / `apiConfig`）都用到的
 * 公共读盘口**—— 那一轮要动的地方全在它下游，它自己却留在主文件里，
 * 于是"拆主文件"永远差一个前置件。
 *
 *  它自身是**零业务依赖**的：只读一个 `TRACE_FILE`，不碰配置、不碰模型、不碰账本。
 *  依赖方向 `trace-io.js(L1) → paths.js(L0)`，是层次表里最浅的一档。
 *
 *  ⚠️ **两个窗口常量是两件事，绝不能合并**（合并后的失败形态是"页面看起来正常"）：
 *    `TRACE_SHOWN` = 对话流卡片显示几条（给「试一句」看链路）；
 *    `TRACE_AGGREGATE` = 会话列表能聚合多少条（给「会话」页）。
 *    共用会让会话列表永远只有 3 条记录里的 1~2 个会话。
 *
 *  ⚠️ **读盘口只有这一处**：主文件与三个大块都从这里取，
 *    谁再写一份 `fs.readFileSync(TRACE_FILE)` 就是第二份缓存判据（契约 §82 反向盯着）。
 */

import fs from 'node:fs';
import { TRACE_FILE } from './paths.js';

/**
 * 面板**固定**只显示最新 3 条：每条含四段原文（提示词可能上千字），
 * 条数一多页面就翻不动了，而排查"这一句为什么答歪了"看最近三条足够。
 */
export const TRACE_SHOWN = 3;

/**
 * 会话聚合能看多少条 trace。**经验值**。
 *
 * ⚠️ 它与 `TRACE_SHOWN = 3` 是两件事，绝不能共用一个常量：后者是"对话流卡片显示几条"
 *    （给"试一句"看链路用的），前者是"会话列表能聚合多少条"（给"会话"页用的）。
 *    共用会让会话列表永远只有 3 条记录里的 1~2 个会话 —— 而页面看起来是正常的。
 *    取 120 = 与 trace 文件的 `TRACE_MAX` 同量级（超过它就是白读）。
 */
export const TRACE_AGGREGATE = 120;

/**
 * 读最近 `limit` 条 trace，**最新的在前**。
 *
 * ⚠️ 读不出来一律返回空数组（永不抛）：一次读盘失败不该让 `/api/state` 整个 500。
 */
export function readTrace(limit = TRACE_SHOWN) {
  try {
    const raw = fs.readFileSync(TRACE_FILE, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    const out = [];
    // 只解析最后 limit 行：文件是追加写的，早先的行没必要反复 JSON.parse
    for (const line of lines.slice(-limit)) {
      try {
        out.push(JSON.parse(line));
      } catch {
        /* 半行（正在写）跳过 */
      }
    }
    return out.reverse(); // 最新的在前
  } catch {
    return [];
  }
}