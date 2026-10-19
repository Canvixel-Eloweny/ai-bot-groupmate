/**
 * 官方模型目录对账的**状态文件读写**（2026-10-17）
 *
 * 为什么单独一个文件（而不是跟引擎住一起）：
 *   `panel/lib/state-collector.js`（L3）只需要**读**它（把事件下发给页面），
 *   而引擎（`model-sync.js`，L3）还要写配置。两者放同一个文件时
 *   state-collector → model-sync 就是 **L3 → L3**，层次检查会当场报"同层会构成循环"。
 *   ⇒ 把"一个 json 的读写"拆成 L1 叶子（只依赖 `paths.js` 与原子写），两边都干净。
 *
 * ⚠️ 它**不判断**该不该同步、也不碰 config.json —— 那是引擎的事。
 *    这里只有一份缓存：上次跑的时间 + 最近几条事件。
 */
import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from '../../src/atomic-write.js';
import { PANEL_STATE_DIR } from './paths.js';

/** 对账状态文件（面板运行态，不是用户配置 —— 所以不在 config.json 里）。 */
export const MODEL_SYNC_FILE = path.join(PANEL_STATE_DIR, 'model-sync.json');
/** 对账节流：6 小时。`/api/state` 每 3 秒被轮询，不节流等于每 3 秒读一遍配置。 */
export const SYNC_THROTTLE_MS = 6 * 60 * 60 * 1000;
/** 事件最多留几条（页面只弹没见过的，多了会被当成刷屏）。 */
export const MAX_SYNC_EVENTS = 5;

/** 读对账状态（坏了就当没有 —— 它只是缓存，不是真相）。 */
export function readModelSync() {
  try {
    const o = JSON.parse(fs.readFileSync(MODEL_SYNC_FILE, 'utf8'));
    return {
      lastAt: Number(o?.lastAt) || 0,
      events: Array.isArray(o?.events) ? o.events.slice(-MAX_SYNC_EVENTS) : [],
    };
  } catch {
    return { lastAt: 0, events: [] };
  }
}

/** 写对账状态。写不进去**不抛** —— 最坏是下次再弹一遍。 */
export function writeModelSync(s) {
  try {
    writeJsonAtomic(MODEL_SYNC_FILE, {
      lastAt: Number(s?.lastAt) || Date.now(),
      events: (s?.events || []).slice(-MAX_SYNC_EVENTS),
    });
  } catch {
    /* 缓存写不进去不影响对账本身 */
  }
}
