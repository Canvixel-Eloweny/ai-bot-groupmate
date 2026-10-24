/**
 * 日流水（`.raw.md`）：把当天群聊机械地记成一行一条，**不过模型**。
 *
 * 为什么要有它：夜岗/夜间产出以前直接读"最近 40 条会话历史"——历史里没有时间戳、
 * 也没有"今天"的概念，写出来的摘要容易把几天前的事当成今天。日流水补的是**素材层**：
 * 一行一条、带时间、按群分文件，夜间产出再从这个文件里取。
 *
 * ⚠️ 零依赖、只做确定的事：压平换行、截 200 字、空文本/纯占位（[图片][表情]）跳过。
 *    不做"挑重要的"——那属于模型；这里越智能，出问题时越说不清是哪一步歪的。
 * @module day-log
 */

import fs from 'node:fs';
import path from 'node:path';
import { dayKeyOf } from './holidays.js';

/** 单行正文上限（字）。够看清一句话，又不至于把日文件撑爆。 */
export const MAX_LINE_TEXT = 200;

/** 本地日期键：唯一实现在 `src/holidays.js`（H-11①），这里只把毫秒转成 Date。 */
function dateKeyOf(now = Date.now()) {
  return dayKeyOf(new Date(now));
}

/** `HH:MM`。 */
export function stampOf(now = Date.now()) {
  const d = new Date(now);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 会话键 → 安全目录名（Windows 不允许 `:`；group:123 → group_123）。 */
export function safeChatDir(chatKey) {
  return String(chatKey ?? '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80) || 'unknown';
}

/** 某个会话某一天的日文件路径。 */
export function dayLogPath(dataDir, chatKey, now = Date.now()) {
  return path.join(String(dataDir || ''), 'daylog', safeChatDir(chatKey), `${dateKeyOf(now)}.raw.md`);
}

/** 纯占位（整条只有图片/表情/语音/视频）不占一行。 */
const PLACEHOLDER_ONLY = /^(?:\[(?:图片|表情|语音|视频)\])+$/;

/** 把一条入站消息落成一行。写不进去不抛（素材缺失不该带崩主链）。 */
export function appendDayLog(dataDir, chatKey, { who = '', text = '' } = {}, now = Date.now()) {
  const body = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!body || PLACEHOLDER_ONLY.test(body)) return false;
  const line = `- [${stampOf(now)}] ${String(who || '群友').slice(0, 40)}：${body.slice(0, MAX_LINE_TEXT)}\n`;
  const file = dayLogPath(dataDir, chatKey, now);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, line, 'utf8');
    return true;
  } catch {
    return false;
  }
}

/** 读当天日流水；没有/读不了 → 空串（调用方回退到旧素材）。 */
export function dayLogTextOf(dataDir, chatKey, now = Date.now()) {
  try {
    return fs.readFileSync(dayLogPath(dataDir, chatKey, now), 'utf8').trim();
  } catch {
    return '';
  }
}

/**
 * 读**最近**几天的日流水（默认今天→昨天）。夜岗在凌晨 4 点跑时"今天"是新的一天，
 * 前一晚的流水还在昨天的文件里 —— 只读今天会拿到空文件、退回无时间戳的历史。
 */
export function dayLogTextRecent(dataDir, chatKey, now = Date.now(), days = 2) {
  const n = Math.max(1, Math.min(7, Number(days) || 2));
  for (let i = 0; i < n; i += 1) {
    const text = dayLogTextOf(dataDir, chatKey, now - i * 86400000);
    if (text) return text;
  }
  return '';
}
