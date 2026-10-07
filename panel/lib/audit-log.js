/**
 * ══════════════════════════════════════════════════════════════════════
 *  面板审计（B9 · AU-AUDIT）—— 第 22 轮 H-10 从 `panel/server.js` 整块搬出
 * ══════════════════════════════════════════════════════════════════════
 *  为什么单独立一个模块：`panel/server.js` 是最后几个**巨型文件**之一，
 *  而"审计"是一族**边界清楚**的东西 —— 谁改的 / 改了什么 / 什么时候 / 成没成。
 *  它与路由、桥接、用量互不相干，混在主文件里只是让人多翻 500 行。
 *
 *  ⚠️ **注入而不是搬走的两个符号**（第 18/19 轮立的三条纪律之一）：
 *    · `isWriteRequest(p, method)` —— 它是**安全核心**（唯一入口表里
 *      「哪些请求算改动」这一条，审计与鉴权**同源**就靠它），必须留在主文件；
 *    · `UA_MAX_CHARS` —— 它另有一处调用点（时间常量族）。
 *    搬进来 = 两份实现，而"后改的那份不生效"正是本项目反复清掉的头号腐烂源。
 *
 *  ⚠️ 层次：L1（只依赖 L0 的 `paths.js` 与 `src/atomic-write.js` 这个共享叶子）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { truncateLinesAtomic } from '../../src/atomic-write.js';
import { AUDIT_FILE, ARCHIVE_FILE } from './paths.js';

/** 审计最多留多少行。和对话流一样折半截断，不做轮转改名。 */
const AUDIT_MAX = 500;

/**
 * 这次改动是谁发起的。
 * ⚠️ 现在没有鉴权（B9c 才有），所以能给出的只是"本机回环 vs 远端"；
 *    再加一个 User-Agent 当第二条线索 —— 浏览器（面板 UI）与 curl（脚本/别的进程）
 *    在这一栏是分得开的，而这恰好是 B9c 的威胁模型（同机任意进程）。
 */
function actorOf(req) {
  const ip = String(req.socket?.remoteAddress || '');
  if (!ip) return 'unknown';
  const loop = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  return loop ? 'loopback' : `remote:${ip}`;
}

function appendAudit(rec) {
  try {
    fs.mkdirSync(path.dirname(AUDIT_FILE), { recursive: true });
    fs.appendFileSync(AUDIT_FILE, JSON.stringify(rec) + '\n');
    // 截断走原子写：原地`writeFileSync` 覆盖会和**同一时刻的 append** 撞车，
    // 撞上时刚 append 的那行会被整段覆盖掉（表现是"刚刚那次操作查不到了"）。
    // 与src/index.js 的 writeTrace 用同一个函数，两处不再各写一份。
    truncateLinesAtomic(AUDIT_FILE, AUDIT_MAX, 0.5);
  } catch {
    /* 记不下来也绝不能影响这次请求本身 —— 审计是旁路，不是链路 */
  }
}

/** 最近的审计记录（默认 100 条，最新在前） */
export function readAudit(limit = 100) {
  try {
    const n = Math.min(AUDIT_MAX, Math.max(1, Math.round(limit)));
    return fs
      .readFileSync(AUDIT_FILE, 'utf8')
      .split('\n')
      .filter(Boolean)
      .slice(-n)
      .map((l) => {
        try { return JSON.parse(l); } catch { return null; } // 半行（正好在写）跳过
      })
      .filter(Boolean)
      .reverse();
  } catch {
    return []; // 文件不存在 = 还没发生过任何写操作，不是错误
  }
}

/**
 * 会话存档（P1 分区重构）。**只读** —— 面板不参与"该不该恢复"那个判断。
 * 读不到（文件不存在 / 机器人还没写过）返回 null，让页面走空态，而不是报错。
 */
export function readArchive() {
  try {
    return JSON.parse(fs.readFileSync(ARCHIVE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

/** 开始计时一次写请求。非写请求返回空壳，调用方无脑用即可。 */
/**
 * `beginAudit(req, p)` 的工厂（第 22 轮 H-10 搬家）。
 * 两个入参都由主文件注入，理由见本文件头注释。
 */
export function makeBeginAudit({ isWriteRequest, UA_MAX_CHARS }) {
  function beginAudit(req, p) {
    if (!isWriteRequest(p, req.method)) return { done() {} };
    const t0 = Date.now();
    return {
      done(status) {
        appendAudit({
          t: t0,
          actor: actorOf(req),
          ua: String(req.headers['user-agent'] || '').slice(0, UA_MAX_CHARS),
          method: req.method,
          path: p,
          status: Number(status) || 0,
          ms: Date.now() - t0,
        });
      },
    };
  }
  // ⚠️ 这一行是工厂的**全部意义所在**（2026-10-06 真实事故）：
  //   漏掉它，`makeBeginAudit()` 返回 `undefined`，主文件那句
  //   `const beginAudit = makeBeginAudit({…})` 静默拿到 undefined，
  //   于是**每一个请求**在 `server.js` 的第一行就抛
  //   `TypeError: beginAudit is not a function` —— 而那一行在 try 之外，
  //   只会被 `unhandledRejection` 记一笔，**响应永远写不出去**。
  //   用户看到的就是「点图标、页面一直转圈」，而面板日志一片安静。
  return beginAudit;
}
