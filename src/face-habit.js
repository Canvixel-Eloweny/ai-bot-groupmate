/**
 * ══════════════════════════════════════════════════════════════════════
 *  表情习惯（ATI-4）—— 不是每条都带、不一定在末尾、类型不单一
 * ══════════════════════════════════════════════════════════════════════
 *  为什么必须做成**确定性闸**而不是只写进提示词：
 *    项目既有先例（`custom-config.js` 里"连续追问/重复问题"那一条）——
 *    频率、去重这类需要**运行时信号**才判得准的事，光写进提示词等于没做：
 *    模型不知道"这张表情你三分钟前刚发过"，也不知道"这轮你已经带过一个了"。
 *
 *  ⚠️ **零依赖叶子**：不 import 任何模块（连 node: 内置都不引）。
 *    时间 `now` 与随机 `rng` 全部由入参给 —— 这样每一条判据都能被直接断言，
 *    不必在测试里等真时间或碰运气（本项目 OPS-FIXTURE 的一贯做法）。
 *
 *  ⚠️ 下面的数字全是**经验值**，不是任何官方阈值。
 */

/** 同一会话两次表情之间的最小间隔（经验值） */
export const FACE_COOLDOWN_MS = 3 * 60 * 1000;
/** 冷却过了之后，这一轮要不要带的概率（经验值） */
const FACE_CHANCE = 0.35;
/** 记住最近用过几张，用来降权（经验值） */
const RECENT_FACES = 4;
/** 最多记住多少个会话的状态（封住"无上限增长"这个口子） */
export const MAX_CHATS = 200;

/**
 * 位置分布（经验值）。刻意让"句末"占多数但不是全部 ——
 * 永远在末尾正是"一眼机器"的地方。
 *
 * 位置**只有三种**：`head` / `mid` / `tail`。**不做"单独发一条表情"** ——
 * 那会凭空多一条消息，与"别刷屏"冲突。
 * ⚠️ 2026-10-01 清理轮：这里原先有一个 `export const FACE_PLACES` 声明这条闭集合，
 *    但它全仓 0 引用（`placeOf` 返回的是裸字面量，从不经过那张表）——
 *    留着等于**一份不生效的"唯一来源"声明**，改它不会有任何后果，反而让人以为改它就行了。
 */
export function placeOf(rng = Math.random) {
  const r = Number(rng());
  if (r < 0.55) return 'tail';
  if (r < 0.85) return 'mid';
  return 'head';
}

/**
 * 挑哪一张：最近用过的**降权**（都用过时才允许重复，避免无表情可用）。
 * @param {{recentFaces?:string[], presets?:Array, rng?:Function}} opts
 */
export function pickFace(opts = {}) {
  const rng = opts.rng || Math.random;
  const presets = Array.isArray(opts.presets) && opts.presets.length ? opts.presets : [];
  if (!presets.length) return null;
  const recent = (opts.recentFaces || []).map((x) => String(x));
  const fresh = presets.filter((p) => !recent.includes(String(Array.isArray(p) ? p[0] : p)));
  const pool = fresh.length ? fresh : presets;
  const i = Math.min(pool.length - 1, Math.floor(Number(rng()) * pool.length));
  const item = pool[Math.max(0, i)];
  return String(Array.isArray(item) ? item[0] : item);
}

/**
 * 这一轮要不要带表情。**纯函数**。
 *
 * @param {{now?:number, lastFaceAt?:number, rng?:Function}} opts
 * @returns {boolean}
 */
export function shouldAttach(opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : 0;
  const last = Number(opts.lastFaceAt) || 0;
  const rng = opts.rng || Math.random;
  if (last && now - last < FACE_COOLDOWN_MS) return false;
  return Number(rng()) < FACE_CHANCE;
}

/**
 * 综合决策。**纯函数**。
 * @returns {{attach:boolean, faceId:string|null, place:string|null}}
 */
export function faceDecision(opts = {}) {
  if (!shouldAttach(opts)) return { attach: false, faceId: null, place: null };
  const faceId = pickFace(opts);
  if (!faceId) return { attach: false, faceId: null, place: null };
  return { attach: true, faceId, place: placeOf(opts.rng || Math.random) };
}

/**
 * 把表情标记插进文本。**纯函数**。句中位置尽量落在标点附近，读起来才像人打的。
 * @param {string} text
 * @param {string} faceId
 * @param {'head'|'mid'|'tail'} place
 */
export function applyFaceMark(text, faceId, place = 'tail') {
  const s = String(text ?? '');
  const mark = `[face:${faceId}]`;
  if (!s) return mark;
  if (place === 'head') return `${mark}${s}`;
  if (place === 'tail') return `${s}${mark}`;
  // mid：先找中点附近的标点，找不到就落在中点
  const mid = Math.floor(s.length / 2);
  let cut = -1;
  for (let d = 0; d <= 8 && cut < 0; d += 1) {
    for (const idx of [mid - d, mid + d]) {
      if (idx > 0 && idx < s.length && '，,。、；;！!？? '.includes(s[idx])) {
        cut = idx + 1;
        break;
      }
    }
  }
  if (cut < 0) cut = mid;
  return `${s.slice(0, cut)}${mark}${s.slice(cut)}`;
}

/**
 * 会话级的"最近用过什么 / 上次什么时候发的"记忆。
 * 刻意**不挂在 session 上** —— session 会被会话存档整份序列化落盘，
 * 而这是纯运行时的小状态，写进去只会让存档变大且语义混杂。
 */
export function createFaceMemory() {
  const map = new Map();
  const stateOf = (chatKey) => {
    const v = map.get(chatKey);
    return { lastFaceAt: v?.lastFaceAt || 0, recentFaces: v?.recentFaces || [] };
  };
  return {
    stateOf,
    /** 记一笔（只在真的发出去之后调） */
    note(chatKey, faceId, now = Date.now()) {
      const cur = stateOf(chatKey);
      const recent = [String(faceId), ...cur.recentFaces.filter((x) => String(x) !== String(faceId))]
        .slice(0, RECENT_FACES);
      map.delete(chatKey); // 重插以保持插入顺序（淘汰最老的）
      map.set(chatKey, { lastFaceAt: now, recentFaces: recent });
      while (map.size > MAX_CHATS) map.delete(map.keys().next().value);
    },
    size: () => map.size,
  };
}
