/**
 * 机器人**真正发出去**的消息条数（面板「今日发言」的唯一来源）。
 *
 * 为什么挂在客户端出口、而不是主回复循环里：主回复、主动出站、工具发图、
 * 插件的 `ctx.sender` 最终都走 `OneBotClient.sendMsg`；在主循环里记会漏掉后三条。
 *
 * 一条 = 一次成功的 `sendMsg` 调用（一次调用可以带 reply / at / text 多个段，
 * 但群里看到的是**一条消息**）。按月切分写入 `panel/sent-YYYY-MM.jsonl`。
 * 任何写盘失败都吞掉 —— 统计不能影响发送。
 */
import fs from 'node:fs';
import path from 'node:path';
import { monthKeyOf } from './holidays.js';
import { panelFile } from './user-root.js';

function sentFilePath() {
  if (process.env.QQBOT_SENT_FILE) return path.resolve(process.env.QQBOT_SENT_FILE);
  return panelFile(`sent-${monthKeyOf()}.jsonl`);
}

export function recordSentRound({ n = 1, at = Date.now(), chatKey = '' } = {}) {
  const count = Math.max(0, Math.floor(Number(n) || 0));
  if (!count) return;
  try {
    const file = sentFilePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify({
      t: Number.isFinite(Number(at)) ? Number(at) : Date.now(),
      n: count,
      k: String(chatKey || '').slice(0, 120),
    }) + '\n');
  } catch {
    /* 统计失败不能影响发送 */
  }
}
