/**
 * 会话存档（第 35 轮 B10d · O-SESSION）
 * ══════════════════════════════════════════════════════════════════════════
 *  为什么需要它
 * ══════════════════════════════════════════════════════════════════════════
 *  会话历史只活在一个内存 Map 里：**重启即清空**。
 *  于是"它刚才还在聊这个话题，重启之后完全接不上"是必然的，不是偶发的 ——
 *  而且用户描述不出来（他只知道"它记性变差了"）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  ⚠️ 命名说明（与计划 v2 §5 的一处刻意偏差）
 * ══════════════════════════════════════════════════════════════════════════
 *  计划写的是"新建 `src/session-store.js`"。但 **`SessionStore` 这个类已经存在**
 *  在 `src/brain.js`（内存态那一半）。再建一个同名的文件会变成
 *  "两个 session store、职责却不同" —— 正是本项目反复在清的那类歧义。
 *  所以这里叫 `session-archive.js`：它只管**落盘与恢复**，内存态仍归 brain.js。
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  三条必须守住的风险（横向报告把这项标成"高风险"，理由就在这三条）
 * ══════════════════════════════════════════════════════════════════════════
 *  ① **写盘阻塞**：每条消息都同步写一次 → 高频群里 I/O 直接压到回复延迟上。
 *     → 本模块**不做**调度（那是调用方的事），但提供了"只吐快照、不碰 IO"的
 *       纯函数，调用方才能安全地做防抖 / 节流。
 *  ② **数据丢失**：原地覆盖写到一半崩了，整份历史没了。
 *     → 一律走 `writeJsonAtomic`（tmp + rename，同目录）。
 *  ③ **孤儿 / 陈旧记录**：三天前的对话被当成"刚刚"恢复回来，
 *     模型会接着一个早就结束的话题说话 —— 比失忆更糟，因为它**看起来有记忆**。
 *     → 恢复时按 `maxAgeMs` 判新鲜度；且人设指纹变了就丢掉 assistant 消息
 *       （与 `Brain.update()` 的规则保持一致，不另立一套）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from './atomic-write.js';
import { imageHash } from './trace-id.js';

/** 默认新鲜度上限。**经验值**：隔夜还接得上，隔一周就不该装作还记得。 */
export const DEFAULT_MAX_AGE_MS = 6 * 60 * 60 * 1000;

/** 默认最多留几个会话。**经验值**：按白名单群数量给足余量。 */
const DEFAULT_MAX_SESSIONS = 50;

/** 默认每个会话留多少条。**经验值**：与 `context.recentTurns * 2` 同量级。 */
const DEFAULT_MAX_MSGS = 40;

/**
 * 存档前把内容里的图片 URL 换成短哈希（B10a · O-IMGURL 的同一条纪律）。
 * 会话历史会被 rsync 进沙箱、也可能被拿去复盘，QQ 图址常带签名/临时 token。
 */
export function scrubForArchive(text, hash = imageHash) {
  const s = String(text ?? '');
  if (!s) return '';
  return s.replace(/https?:\/\/[^\s)'"]+/g, (u) => {
    // 只处理看起来像图片的（含常见图床域或图片扩展名），正文里的普通链接保持原样 ——
    // 否则"把链接也哈希掉"会让恢复出来的对话变成一堆无法理解的乱码。
    if (!/\.(png|jpe?g|gif|webp|bmp)(\?|$)/i.test(u) && !/qpic\.cn|gchat\.qpic/i.test(u)) return u;
    return `[图 ${hash(u)}]`;
  });
}

/**
 * 把内存里的会话摊成一份可落盘的快照（**纯函数**：不读时钟以外的环境、不做 IO）。
 *
 * 只留"恢复对话连续性"真正需要的东西：history / ambient / 两个时间戳。
 * `recentReplies` 也留 —— 它是"别重复说同一句"的依据，丢了会原地复读。
 */
export function archiveOf(sessions, {
  fp = '',
  now = Date.now(),
  maxSessions = DEFAULT_MAX_SESSIONS,
  maxMsgs = DEFAULT_MAX_MSGS,
} = {}) {
  const list = [...sessions.values()]
    // 空会话不存：没有可恢复的东西，只会让文件变大
    .filter((s) => (s.history?.length || s.ambient?.length))
    // 最近有动静的优先 —— 满了之后被丢掉的应该是最冷的那个会话
    .sort((a, b) => (b.lastReplyAt || 0) - (a.lastReplyAt || 0))
    .slice(0, maxSessions)
    .map((s) => ({
      key: s.key,
      scene: s.scene,
      id: s.id,
      history: (s.history || []).slice(-maxMsgs)
        .map((m) => ({ role: m.role, content: scrubForArchive(m.content) })),
      ambient: (s.ambient || []).slice(-maxMsgs)
        .map((a) => ({ speaker: a.speaker, text: scrubForArchive(a.text) })),
      lastReplyAt: s.lastReplyAt || 0,
      lastInterjectAt: s.lastInterjectAt || 0,
      recentReplies: (s.recentReplies || []).slice(-10),
    }));
  return { v: 1, fp, t: now, sessions: list };
}

/**
 * 判断一份存档还新不新鲜。
 * 没有时间戳的旧格式 → 一律判为不新鲜（无从判断就不恢复，fail-closed）。
 */
export function archiveIsFresh(snap, { now = Date.now(), maxAgeMs = DEFAULT_MAX_AGE_MS } = {}) {
  if (!snap || typeof snap !== 'object') return false;
  if (!Number.isFinite(snap.t)) return false;
  return now - snap.t < maxAgeMs;
}

/**
 * 把存档恢复进一个 SessionStore。
 *
 * 返回**做了什么**（条数），调用方拿它去写日志 ——
 * "恢复了几个会话 / 因为太旧丢了多少 / 因为人设变了丢了多少"必须看得见，
 * 否则"它怎么突然接上了三天前的话题"会变成下一个无从查起的谜。
 */
export function restoreInto(store, snap, {
  now = Date.now(),
  fp = '',
  maxAgeMs = DEFAULT_MAX_AGE_MS,
} = {}) {
  const out = { restored: 0, stale: 0, personaDropped: 0 };
  if (!store || !snap || !Array.isArray(snap.sessions)) return out;

  if (!archiveIsFresh(snap, { now, maxAgeMs })) {
    out.stale = snap.sessions.length;
    return out;
  }

  // 人设变了：与 Brain.update() 同一条规则 —— 丢掉 assistant 消息，只留用户侧。
  // 不另立一套判据，否则"热重载时"和"重启恢复时"会表现不一致。
  const fpChanged = !!fp && !!snap.fp && snap.fp !== fp;

  for (const s of snap.sessions) {
    if (!s?.key) continue;
    const cur = store.get(s.scene ?? '', s.id ?? '');
    // 内存里已经有内容的会话**不覆盖**：正在跑的这一轮比磁盘上的新
    if (cur.history.length || cur.ambient.length) continue;

    let history = Array.isArray(s.history) ? s.history.filter((m) => m && m.role) : [];
    if (fpChanged) {
      const before = history.length;
      history = history.filter((m) => m.role !== 'assistant');
      out.personaDropped += before - history.length;
    }
    cur.history = history;
    cur.ambient = Array.isArray(s.ambient) ? s.ambient.filter((a) => a && a.speaker) : [];
    cur.lastReplyAt = Number.isFinite(s.lastReplyAt) ? s.lastReplyAt : 0;
    cur.lastInterjectAt = Number.isFinite(s.lastInterjectAt) ? s.lastInterjectAt : 0;
    cur.recentReplies = Array.isArray(s.recentReplies) ? s.recentReplies.slice(-10) : [];
    if (history.length || cur.ambient.length) out.restored += 1;
  }
  return out;
}

/** 写存档。原子写 + 0600（里面是真实聊天内容）。失败**抛出**，交给调用方决定。 */
export function writeArchive(file, snap) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeJsonAtomic(file, snap, { mode: 0o600 });
}

/** 读存档。没有 / 坏了都返回 null —— 恢复不了不是错误，是"当作第一次启动"。 */
export function readArchive(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return j && typeof j === 'object' ? j : null;
  } catch {
    return null;
  }
}
