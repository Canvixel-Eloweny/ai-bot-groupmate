/**
 * ══════════════════════════════════════════════════════════════════════
 *  跨会话发言（D18 · 报告 E8）—— 判据层
 * ══════════════════════════════════════════════════════════════════════
 *
 * 「它能不能去别的会话说一句」这件事，此前只有两条半边：
 *   · **主链路** —— 只能在**当前这个会话**里回话；
 *   · **`tickProactive`** —— 按**配置**（定时消息 / 主动话题）往白名单群发，
 *     但发什么、什么时候发都是配置说了算，**不是它自己看着会话列表挑的**。
 * 这一步补的是后者缺的那半：让它**看见自己还在哪些群里**，并挑一个说话。
 *
 *  ────────────────────────────────────────────────────────────────────
 *  ⚠️ 三条硬约束（都不是"更好的写法"，是边界）
 *  ────────────────────────────────────────────────────────────────────
 *  ① **只许发给放行名单里的群**，且是**逐字比较群号** —— 不做前缀、不做模糊匹配。
 *     它主动去的是一个**你不一定盯着**的群，名单外的一个字都不许发。
 *  ② **本模块不发任何消息**。真正的出口只有一个：`index.js` 的 `sayToGroup`
 *     （出口闸门 / 分句 / 发送节奏全在那儿）。在这里再拼一次段 = 第二条发送路径。
 *  ③ **零依赖**。import 任何东西都会给 `src/index.js` 的依赖图多一条边 ——
 *     连 `node:path` 都不进，全部用纯 JS 与纯字符串完成。
 *
 *  ────────────────────────────────────────────────────────────────────
 *  ⚠️ 这一层**不做配额**（D8/D17 的同一条纪律）
 *  ────────────────────────────────────────────────────────────────────
 *  "现在能不能开口"只有一个判据：`brain.throttleReason` + `planProactiveSend`
 *  （外加 `usageGateOf()` 的花费档位），在**接线处**复用。
 *  在这里再写一套 = 两个闸各判一次，迟早不一致 —— 而"两套限流互相不对齐"
 *  这个项目已经有一份前车之鉴（主动路径曾经完全绕过限流）。
 */

/**
 * 跨会话一句话的字符上限（**经验值**）。
 *
 * 比当前会话的回复更该短：它是在**另一个群**里突然开口，别人没有上下文，
 * 长段落会直接读成"刷屏"。接线处还会再过一次出口闸门与分句，这里是**第一道**。
 */
export const CROSS_TEXT_MAX = 120;

/** `get_chats` 最多列几个会话（**经验值**）。列太多 = 每轮前缀 + 上下文都被它吃掉。 */
const CROSS_LIST_MAX = 8;

/** 多久没动静的会话就不再列出来（**经验值**：一天）。0 = 不按时间过滤。 */
export const CROSS_STALE_MS = 24 * 60 * 60 * 1000;

/**
 * 配置默认值 —— **唯一住处**（`custom-config.js` import 它，不许再手写一份，
 * 同 `BROWSE_LOCK_DEFAULTS` / `SLEEP_DEFAULTS` / `FORWARD_DEFAULTS`）。
 *
 * ⚠️ **默认 false**：跨会话发言是"它主动跑去一个**你不一定盯着**的群说话"，
 *    属于行为面变更 —— 与 `browseLock` / `sleep` 同向。
 *    它也**不是修缺陷**（不像 D23-2 的 `forwardExpand` 那样"关着就等于缺陷还在"），
 *    所以不该由一次提交替用户决定。
 * ⚠️ 本步**不加面板写控件**（按 E23 先例：没有控件就不硬声明）；要开是改配置 + **重启机器人**。
 */
export const CROSS_DEFAULTS = { enabled: false };

/**
 * 配置归一化。与 `readBrowseLock` / `readSleep` / `readForward` 同款：
 * **默认值与判据同住一处**，配置面只负责"取出来喂进来"。
 * "只有真是 `true` 才开"：写错成 `"yes"` / `1` 一律按关处理（fail-closed）。
 */
export function readCrossSend(raw) {
  const v = raw && typeof raw === 'object' ? raw : {};
  return { enabled: v.enabled === true };
}

/** 预览文本的字符上限（**经验值**）。它是**别人的群**里的一句话，只用来判断"那边在聊什么"。 */
const CROSS_PREVIEW_MAX = 40;

/** 压单行 + 封顶。段里有换行时，回灌给模型的文本会裂成多行，读起来像两条消息。 */
function clip(s, n = CROSS_PREVIEW_MAX) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) : t;
}

/**
 * 把模型给的目标收敛成一个**真的可以发**的群号。
 *
 * @param {unknown} raw 模型给的会话标识（群号）
 * @param {Array<string|number>} groups 放行名单（与主动出站用的是同一份）
 * @returns {{ok:true, group:string}|{ok:false, reason:string}}
 */
export function resolveCrossTarget(raw, groups = []) {
  const id = String(raw ?? '').trim();
  if (!id) return { ok: false, reason: '没说发给哪个群' };
  // 群号是纯数字。这条不是"防呆"，是**防注入**：带路径分隔符 / 协议前缀之类的字符串
  // 一旦被当成 id 传下去，报错会发生在协议端而不是这里（而日志里看起来一切正常）。
  if (!/^\d{5,12}$/.test(id)) return { ok: false, reason: `「${id}」不像一个 QQ 群号` };
  const allow = (Array.isArray(groups) ? groups : []).map((g) => String(g).trim()).filter(Boolean);
  if (!allow.includes(id)) {
    return { ok: false, reason: `「${id}」不在放行的群名单里 —— 它只许在自己被放行的群里说话` };
  }
  return { ok: true, group: id };
}

/**
 * 收敛要说的那句话。
 * 空内容**当场拒**（不是"发一个空段"）：空段在协议端可能被当成一条真消息发出去。
 */
export function normalizeCrossText(raw) {
  const s = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (!s) return { ok: false, reason: '没说要说什么' };
  return { ok: true, text: s.length > CROSS_TEXT_MAX ? s.slice(0, CROSS_TEXT_MAX) : s };
}

/**
 * 「它现在还能去哪些群说话」—— 给 `get_chats` 用的可见会话列表。
 *
 * ⚠️ 数据全部取**既有字段**，不新造任何状态：
 *     · 时间维度用 `session.lastMsgAt`（D12b 起就有的"最后一次有人说话"），
 *       退而求其次用 `session.lastReplyAt`；
 *     · 近况用 `session.ambient` 的最后一条（`{speaker, text}`，背景段的同一份数据）。
 *     为这件事新加一个"最后活跃时间"字段，就是同一份语义的第二份拷贝。
 *
 * 排序是**确定性**的（近的在前，同刻按群号）：同一次输入永远得到同一份输出 ——
 * 否则"它为什么挑了这个群"在事后完全查不出来。
 *
 * @param {{groups?:Array, sessionOf?:Function, now?:number, maxAgeMs?:number, limit?:number}} p
 */
export function crossChatsOf({
  groups = [], sessionOf, now = 0, maxAgeMs = CROSS_STALE_MS, limit = CROSS_LIST_MAX,
} = {}) {
  const out = [];
  for (const raw of Array.isArray(groups) ? groups : []) {
    const id = String(raw ?? '').trim();
    if (!id) continue;
    const s = typeof sessionOf === 'function' ? sessionOf(id) : null;
    const lastAt = Number(s?.lastMsgAt) || Number(s?.lastReplyAt) || 0;
    // 从来没动静 / 太久没动静 → **不列**。列出去它就会去一个死群里自言自语。
    if (maxAgeMs > 0 && (!lastAt || now - lastAt > maxAgeMs)) continue;
    const amb = Array.isArray(s?.ambient) ? s.ambient : [];
    const last = amb.length ? amb[amb.length - 1] : null;
    out.push({
      group: id,
      lastAt,
      agoMin: Math.max(0, Math.round((now - lastAt) / 60000)),
      preview: clip(`${last?.speaker ?? ''}: ${last?.text ?? ''}`),
    });
  }
  out.sort((a, b) => (b.lastAt - a.lastAt)
    || (a.group < b.group ? -1 : a.group > b.group ? 1 : 0));
  return out.slice(0, Math.max(0, Number(limit) || 0));
}

/**
 * 列表 → 回灌给模型的文本。
 *
 * ⚠️ **当前会话要标出来**：不标的话它会把话说到自己正在说话的这个群里 ——
 *    那条路走的是工具而不是回复流程，等于绕过"这一轮的回复"直接插一句。
 *    接线处也会拒（`resolveCrossTarget` 之后还有一道），这里是**第一道**。
 */
export function renderCrossChats(list = [], { selfGroup = '' } = {}) {
  const self = String(selfGroup ?? '');
  const items = Array.isArray(list) ? list : [];
  if (!items.length) return '（除了这里，它现在没有别的活跃群）';
  return items.map((c) => {
    const ago = c.agoMin <= 0 ? '刚刚' : `${c.agoMin} 分钟前`;
    const mark = c.group === self ? ' ← 你正在这里说话，别用工具回这个群' : '';
    return `${c.group}（${ago}）：${c.preview}${mark}`;
  }).join('\n');
}
