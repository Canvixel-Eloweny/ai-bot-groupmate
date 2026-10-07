/**
 * 自己发出去的消息 id（M-4 · 2026-10-04 审查轮）
 * ══════════════════════════════════════════════════════════════════════════
 *  这个模块只回答一个问题：
 *
 *      「这条消息**引用的**那一条，是不是我自己发的？」
 *
 * ──────────────────────────────────────────────────────────────────────────
 *  为什么需要它（一个被承诺了很久、却从没兑现过的能力）
 * ──────────────────────────────────────────────────────────────────────────
 *  `persona/qq-chat.md` 明写：「被叫到（@我 / 点了我的名 / **引了我的话**）**必须出声**，
 *  哪怕只发一个「？」。这是硬要求。」
 *
 *  而实测：`onebot.flattenMessage()` 老老实实把 `reply` 段的 id 存进了 `parsed.replyTo`，
 *  但**全 `src/` 零消费者** —— 也就是说"引用了我的话"这条路**从来没接上过**。
 *  这不是"人设写得夸张"，而是**宣称具备、实际不可达**（本项目最忌讳的那一类）。
 *
 * ──────────────────────────────────────────────────────────────────────────
 *  为什么不能只看 `replyTo` 非空
 * ──────────────────────────────────────────────────────────────────────────
 *  `reply` 段只给"被引用消息的 id"，**不含作者**。所以"引用了"≠"引用了我" ——
 *  群里 A 引用 B 的消息是常态，把它当成"被叫到"会让机器人**逢引用必回**。
 *  唯一可靠的判据是：**那个 id 是不是我自己发出去的**。
 *  于是需要记住"我最近发过哪些 id"。
 *
 * ──────────────────────────────────────────────────────────────────────────
 *  ⚠️ 三条纪律
 * ──────────────────────────────────────────────────────────────────────────
 *  ① **零依赖、纯函数、零 IO** —— 状态由调用方持有（`session` 之外的进程级数组），
 *     这样它才能被 smoke 直接喂反例，而不必起一个真进程。
 *  ② **只进内存、不落盘**：重启后记不得旧 id 是**可接受**的降级
 *     （重启后的第一条引用识别不出来，仅此而已）；
 *     而落盘会带来"上一世的消息 id 被当成这一世的"这种更难查的问题。
 *  ③ **有界丢旧**：不设上限就是一个只增不减的数组 —— 长跑的机器人会慢慢吃内存，
 *     而"慢慢"正是这类泄漏最难被发现的原因。
 */

/**
 * 记住多少个自己发出的消息 id（**经验值**）。
 *
 * 取 60 的理由：它只服务"翻回去引用上一句"这种即时行为，群里 60 条消息的窗口
 * 足够覆盖实际发生的引用；而更大的窗口只是在内存里多存一串没人看的数字。
 */
export const SELF_SENT_MAX = 60;

/**
 * OneBot 响应 → 新发出的消息 id 列表（认不出就返回空数组，**不猜**）。
 *
 * @param {unknown} res OneBot API 的返回值，形如 `{status:'ok', data:{message_id:123}}`
 * @returns {string[]}
 */
export function messageIdsOf(res) {
  const d = res?.data;
  if (!d) return [];
  const out = [];
  if (d.message_id !== undefined && d.message_id !== null) out.push(String(d.message_id));
  // 合并转发之类的接口会回一个 id 数组 —— 一并记下（它们同样是"我发的"）。
  if (Array.isArray(d.message_ids)) for (const x of d.message_ids) out.push(String(x));
  return out.filter(Boolean);
}

/**
 * 记下新发出的 id。**返回新数组**（不改入参）—— 纯函数，便于断言。
 *
 * 新的排在前面；重复的 id 只留最新那一次（不重复占位）。
 *
 * @param {Iterable<string>} list 现有列表（新→旧）
 * @param {Iterable<string>} ids 本次发出的
 * @returns {string[]}
 */
export function noteSelfSent(list, ids) {
  const fresh = [...new Set([...(ids || [])].map((x) => String(x)).filter(Boolean))];
  if (!fresh.length) return [...(list || [])];
  const keep = [...(list || [])].filter((x) => !fresh.includes(x));
  return [...fresh, ...keep].slice(0, SELF_SENT_MAX);
}

/**
 * 这条消息引用的是不是我发的那一条。
 *
 * ⚠️ `replyTo` 为空 / 列表为空 → **恒 false**（"不知道"不当成"是"）：
 *    方向刻意保守 —— 判成"是"会让它逢引用必回（刷屏），
 *    判成"不是"最多是少回一条引用（用户再 @ 一次即可）。
 *
 * @param {Iterable<string>} list 我发过的 id
 * @param {unknown} replyTo 本条消息引用的消息 id（`parsed.replyTo`）
 */
export function isReplyToSelf(list, replyTo) {
  const id = String(replyTo ?? '').trim();
  if (!id) return false;
  for (const x of list || []) if (String(x) === id) return true;
  return false;
}
