/**
 * 配置回滚历史（第 35 轮 B10b · O-CFGHIST）
 * ══════════════════════════════════════════════════════════════════════════
 *  为什么必须有它
 * ══════════════════════════════════════════════════════════════════════════
 *  `config.json` **被 gitignore**（里面是真实 API Key，入库即泄露）。
 *  于是它就成了一个"没有版本历史、也无从 diff"的文件 ——
 *  在面板上点错一次保存，除了凭记忆改回去，**没有任何办法回到上一版**。
 *  这正是"改了之后它就不对劲了，但说不清改了什么"的源头。
 *
 *  在写入**之前**把旧的那一份 append 进环形文件，就得到了一份只保留最近 N 次的
 *  本地历史：能看、能撤销。
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  ⚠️ 一个必须讲清楚的决定：历史里存**全量**，包括 API Key
 * ══════════════════════════════════════════════════════════════════════════
 *  直觉做法是"把凭据脱敏后再存"。**不能这么做**：
 *  `scripts/sanitize-config.mjs` 的脱敏是**抹空 / 替换**，
 *  拿它处理历史的话，撤销一次就会把 `llm.apiKey` 变成空串或假值 ——
 *  **撤一次毁一次凭据**，比没有历史还糟。
 *
 *  而且"撤销上一次保存"的**正确语义**就是完全回到上一版：
 *  如果你刚存错了一把 Key，撤销就该把对的那一把还回来。
 *
 *  所以存全量，靠三件事管住它（同 `config.json` 一个等级）：
 *   ① 文件权限 0600；
 *   ② `panel/*.jsonl` 已在 .gitignore（**不入库**）；
 *   ③ `test/sandbox.sh` 必须排除它（不能流进 /tmp）—— 由 check-wb 契约盯着。
 */

import fs from 'node:fs';
import path from 'node:path';
import { truncateLinesAtomic, writeTextAtomic } from './atomic-write.js';

/** 环形上限。**经验值**：够回溯最近一次误操作，又不至于把配置复制成一大堆。 */
const HISTORY_MAX = 20;

/** 纯函数：造一条历史条目。`via` 记"从哪个入口改的"，事后对账用得上。 */
export function historyEntryOf(prev, { actor = 'unknown', via = '', now = Date.now() } = {}) {
  return { t: now, actor, via, cfg: prev };
}

/**
 * 追加一条历史。返回被丢掉的行数（0 = 还没满）。
 *
 * 用 append 而不是整体重写：历史是**只增**的，覆盖式写入会在并发时丢条目。
 * 折半截断复用 `truncateLinesAtomic` —— 与对话流同一套办法，不另写一份。
 */
export function appendHistory(file, entry, { mode = 0o600, max = HISTORY_MAX } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(entry) + '\n', { mode });
  try {
    fs.chmodSync(file, mode); // append 的 mode 只在创建时生效，已存在的文件要补一次
  } catch {
    /* 无关紧要：chmod 失败不该挡住记账 */
  }
  return truncateLinesAtomic(file, max, 0.5);
}

/** 读历史（最新在前）。半行（正好在写）跳过 —— 与对话流同一个处理办法。 */
export function readHistory(file, limit = HISTORY_MAX) {
  let lines = [];
  try {
    lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  } catch {
    return []; // 文件不存在 = 还没发生过保存，不是错误
  }
  const out = [];
  for (const line of lines.slice(-limit)) {
    try {
      const o = JSON.parse(line);
      // 只暴露摘要，不把整份配置塞进列表响应（那会让 /api/config/history 变得很大）
      out.push({ t: o.t, actor: o.actor, via: o.via, bytes: JSON.stringify(o.cfg || {}).length });
    } catch {
      /* 半行跳过 */
    }
  }
  return out.reverse();
}

/**
 * 弹掉最后一条（撤销用）。
 *
 * 为什么撤销要**消费**掉历史条目，而不是只读取它：
 * 不消费的话，"撤一次"拿到的是最近那版的上一个状态，写完历史又多了一条 ——
 * 于是再撤一次同样的步数会跳回刚离开的那版，**撤销变成了来回切换**。
 * 消费掉才是"撤销"这个词本来的意思。
 */
export function popHistory(file) {
  let lines = [];
  try {
    lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  } catch {
    return false; // 没有历史可弹
  }
  if (!lines.length) return false;
  const rest = lines.slice(0, -1);
  writeTextAtomic(file, rest.length ? rest.join('\n') + '\n' : '', { mode: 0o600 });
  return true;
}

/**
 * 取第 n 条（0 = 最近一次）**完整**配置，用于撤销。
 * 读不到就返回 null —— 撤销"没有历史"时必须明确失败，不能静默什么都不做。
 */
export function configAt(file, n = 0) {
  let lines = [];
  try {
    lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  } catch {
    return null;
  }
  const line = lines[lines.length - 1 - n];
  if (!line) return null;
  try {
    return JSON.parse(line).cfg ?? null;
  } catch {
    return null;
  }
}
