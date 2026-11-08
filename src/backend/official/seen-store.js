/**
 * 入站消息 id 的**持久**去重表（2026-11-06）。
 *
 * 为什么必须落盘：官方明写"相同 msg_id 可能重复推送"，而 resume 补发 + 进程重启
 * 会跨越内存。只在内存里去重的表现是"每次重启它把刚才那条话又回一遍" ——
 * 那是本项目最忌的重复发送，而且没人会怀疑到去重表上。
 *
 * 写盘纪律与本仓一致：原子写 + 失败只记日志，绝不因为"记不住 id"就把消息丢掉。
 */

import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from '../../atomic-write.js';

export function createSeenStore({ file, limit = 500, log = console } = {}) {
  /** @type {Map<string,number>} key -> 首次见到的时刻 */
  const seen = new Map();
  let dirty = false;
  let flushTimer = null;

  function load() {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      const items = Array.isArray(raw?.items) ? raw.items : [];
      for (const it of items) {
        if (!it || typeof it !== 'object') continue;
        const key = String(it.k ?? '');
        const at = Number(it.at) || 0;
        if (key && at) seen.set(key, at);
      }
      trim();
    } catch { /* 第一次跑没有这个文件，是正常状态 */ }
  }

  function trim() {
    while (seen.size > limit) {
      // Map 的迭代顺序就是插入顺序，删最旧的那一条。
      const oldest = seen.keys().next().value;
      seen.delete(oldest);
    }
  }

  function has(key) {
    return Boolean(key) && seen.has(String(key));
  }

  function add(key) {
    const k = String(key ?? '');
    if (!k) return;
    if (seen.has(k)) return;
    seen.set(k, Date.now());
    dirty = true;
    trim();
    scheduleFlush();
  }

  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(() => { flushTimer = null; flush(); }, 5000);
    if (typeof flushTimer.unref === 'function') flushTimer.unref();
  }

  function flush() {
    if (!dirty) return;
    dirty = false;
    const items = [...seen.entries()].map(([k, at]) => ({ k, at }));
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      writeJsonAtomic(file, { version: 1, count: items.length, items });
    } catch (err) {
      // 写不进去只是"下次重启可能重复回一条"，不是"这条消息处理不了"。
      if (typeof log?.warn === 'function') log.warn(`官方通道去重表写盘失败：${err.message}`);
    }
  }

  function snapshot() {
    return { size: seen.size, limit, file };
  }

  return { load, has, add, flush, snapshot };
}
