/**
 * 未读模型（D30 · Wave 4）—— **零依赖叶子**，判据全在这里，IO 全在调用方。
 * ══════════════════════════════════════════════════════════════════════════
 *  它要回答的问题
 * ══════════════════════════════════════════════════════════════════════════
 *  「这一条我到底看没看见」。本项目的头号可查性缺陷之一就是这两件事同形：
 *  被 @ 了没反应 —— 是"它看了决定不回"，还是"它压根没看到"？在今天之前，
 *  账面**无法区分**（`skip` 记录只说明"门禁给了一个结论"，不说明这条消息被怎么处理）。
 *
 *  所以未读不是"待办清单"，而是**门禁的基础设施**：谁消费、何时消费必须显式可审计。
 *  这也是 D31（睡眠/作息）的前置 —— 睡着的消息要"停在未读"，醒来按快照消费。
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  三条硬约定
 * ══════════════════════════════════════════════════════════════════════════
 *  ① **禁 markAllRead：这是一条 API 形态约束，不是一句口号。**
 *     本模块**没有**任何"无参清空"形态的导出 —— 只有 `consume(list, ids)`，
 *     而它**必须**拿到 id 列表。于是"顺手全清"这件事在类型上就写不出来，
 *     不靠自觉、不靠注释提醒。调用方要成批消费（D31 的起床补看）时必须先**取快照**
 *     （`pendingOf`），再用快照的 id 去消费 —— 快照与消费之间新到的消息
 *     **必然留在未读**，这就是"防吞消息"的结构性保证。
 *  ② **认不出就不记**：没有 `message_id` 的消息（拍一拍合成事件就没有）
 *     一律**不入未读**，绝不编一个 id 出来 —— 编出来的 id 无法被消费，
 *     会永久积压成一条假未读。这是 fail-closed 方向。
 *  ③ **纯函数**：不碰 IO、不读时钟（`now` 入参）、不改入参（返回新数组）。
 *     内存态、**不落盘**：重启即丢、不重建、不猜（"失忆是诚实的，假记忆不是"，
 *     与 `working-memory.js` / `session-archive.js` 的文件头同一条纪律）。
 *
 * ⚠️ 参照实现里那套"已读回执"在本架构**没有落点**（协议端不给我们回执），
 *    所以这里的"读"= **宿主门禁处理完毕**，与"回复"是两件事（respond / skip 都算处理完）。
 */

/**
 * 每个会话最多留多少条未读（**经验值**，不是任何官方阈值）。
 *
 * 超限丢**最旧**的：补看语义里"最近发生的"最值得回，而积压越久越说明那阵子它没在。
 * 上限存在的意义只是防内存无限涨（每个会话一个数组、只增不减是本项目的经典病）。
 */
export const UNREAD_MAX = 200;

/**
 * 由"一条入站消息"造一个未读项。**认不出就返回 null**（见文件头 ②）。
 *
 * @param {{messageId?:string|number, userId?:string|number, sender?:string,
 *          text?:string, mentionedSelf?:boolean, now?:number}} info
 * @returns {{id:string, at:number, userId:string, sender:string, text:string, mentionedSelf:boolean}|null}
 */
export function unreadEntryOf(info = {}) {
  const id = String(info.messageId ?? '').trim();
  if (!id) return null; // 没有 message_id → 不记（拍一拍合成事件就是这一支）
  return {
    id,
    at: Number(info.now) || 0,
    userId: String(info.userId ?? ''),
    sender: String(info.sender ?? ''),
    // 与人/模型看的是同一份正文（`parsed.text`，含 @ 显示名）——
    // **它不参与触发判定**（那是 `triggerTextOf` 的地盘），只作补看与展示。
    text: String(info.text ?? ''),
    mentionedSelf: !!info.mentionedSelf,
  };
}

/**
 * 记一条未读。返回**新数组**（不改入参），超上限丢最旧并如实报丢了几条。
 *
 * ⚠️ 同一个 id 不重复记：协议端在重连 / 重推时可能把同一条推两遍，
 *    重复记会让"未读数"虚高，而 `consume` 按 id 消费天然幂等 —— 记两遍只错在计数上。
 *
 * @param {Array<object>} list
 * @param {object|null} entry `unreadEntryOf` 的返回值
 * @param {{max?:number}} [opts]
 * @returns {{items:Array<object>, added:number, dropped:number}}
 */
export function pushUnread(list, entry, { max = UNREAD_MAX } = {}) {
  const items = Array.isArray(list) ? list : [];
  if (!entry?.id) return { items, added: 0, dropped: 0 };
  if (items.some((x) => x?.id === entry.id)) return { items, added: 0, dropped: 0 };
  const cap = Math.max(1, Number(max) || UNREAD_MAX);
  const next = [...items, entry];
  const over = Math.max(0, next.length - cap);
  return { items: over ? next.slice(over) : next, added: 1, dropped: over };
}

/**
 * 取快照：当前这一批未读的 **id 列表**。成批消费前**必须先调它**。
 *
 * 为什么只回 id 不回条目：消费只需要 id（`consume` 的入参）。
 * D31 的起床补看要按"@ 我的条数 / 主人条数"排序时，那是**它自己的**需求 ——
 * 到时候由它决定要不要直接读未读数组，不要现在替它提前造一个投影函数
 * （本项目明令否决"提前通用化"：没有消费方的导出就是下一段要清的死代码）。
 *
 * @param {Array<object>} list
 * @returns {string[]}
 */
export function pendingOf(list) {
  return (Array.isArray(list) ? list : []).map((x) => String(x?.id ?? '')).filter(Boolean);
}

/**
 * 按 id 消费。**唯一清除路径**（也是"禁 markAllRead"的落点）。
 *
 * · 只清**明确点名**的那些 id；没点名的（包括消费期间新到的）一条都不动；
 * · 不传 ids / 传空数组 → **什么都不清**（fail-closed 方向：宁可留，不可误清）；
 * · 不认识的 id 直接忽略（可能是另一条路径已经消费过了）—— 幂等。
 *
 * @param {Array<object>} list
 * @param {string[]|string} ids 被消费的 id（**必须给**）
 * @returns {{items:Array<object>, consumed:string[]}}
 */
export function consume(list, ids) {
  const items = Array.isArray(list) ? list : [];
  const want = new Set(
    (Array.isArray(ids) ? ids : ids === undefined || ids === null || ids === '' ? [] : [ids])
      .map((x) => String(x ?? '')).filter(Boolean)
  );
  if (!want.size) return { items, consumed: [] };
  const left = [];
  const consumed = [];
  for (const x of items) {
    if (x?.id && want.has(String(x.id))) consumed.push(String(x.id));
    else left.push(x);
  }
  return { items: left, consumed };
}
