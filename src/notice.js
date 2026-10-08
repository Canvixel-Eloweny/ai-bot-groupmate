/**
 * ══════════════════════════════════════════════════════════════════════════
 *  OneBot notice 事件的标准化（D9b · 报告 E7）
 * ══════════════════════════════════════════════════════════════════════════
 *  这件事解决什么
 * ──────────────────────────────────────────────────────────────────────────
 *  `src/onebot.js` 从第一天起就在 `emit('notice', payload)`，
 *  而**全项目没有一个监听者** —— 拍一拍、禁言、群管事件全部停在门外。
 *  这是最便宜的一类新触发源：事件已经在网线上跑着，只是没人接。
 *
 *  本文件只做**把协议形状翻译成宿主形状**这一件事（纯函数、零依赖）：
 *    · 拍一拍（`notify` + `poke`）→ `kind: 'poke'`
 *    · 群禁言 / 解除（`group_ban`）→ `kind: 'muted'` / `'unmuted'`
 *    · 其余一律 `kind: 'other'` —— **不认识就说"不认识"**，不要猜。
 *
 *  ⚠️ 协议端差异是已知风险（NapCat 与 SnowLuma 的字段名不完全一致）。
 *     应对方式是**对模糊情形一律 fail-closed**：拿不准"被拍的/被禁言的是不是机器人"
 *     就回 `aboutSelf: false`，宁可不触发，也不要对着别人的拍一拍开口。
 *
 *  ⚠️ 零依赖叶子：本文件不许 import 任何模块（它要能被测试与契约直接读）。
 */

/** 宿主认识的四种 notice。`other` 是"收到了但不管"，不是错误。 */
export const NOTICE_KINDS = ['poke', 'muted', 'unmuted', 'other'];

/**
 * 拍一拍合成为一条消息时用的正文。
 *
 * 带一对全角括号是**刻意**的：模型看到 `佐雪佑: （拍了拍你）` 会明白这不是一句话，
 * 而 `佐雪佑: 拍了拍你` 会被当成陈述句去接。括号在群里也是真人常用的"动作"写法。
 */
export const POKE_TEXT = '（拍了拍你）';

/** 「/安静」不写分钟数时的默认时长。**经验值**：够泡一杯茶，又不至于让用户第二天才发现它不吭声。 */
export const QUIET_DEFAULT_MIN = 30;
/** 「/安静」允许的最长时长。**经验值**：再长就该去面板关总闸，而不是靠一条群里指令。 */
export const QUIET_MAX_MIN = 240;

/**
 * 把一条 OneBot notice 标准化成宿主形状。
 *
 * @param {object} payload 协议端推来的原始事件
 * @param {string|number} selfId 机器人自己的号（判定"这事是不是冲着我来"）
 * @returns {{kind:string, ...}} `kind` 一定在 `NOTICE_KINDS` 里
 */
export function normalizeNotice(payload, selfId) {
  const p = payload || {};
  if (p.post_type !== 'notice') return { kind: 'other', reason: 'post_type 不是 notice' };

  const self = String(selfId ?? p.self_id ?? '');
  const groupId = p.group_id == null ? '' : String(p.group_id);
  const scene = groupId ? 'group' : 'private';

  // ── ① 拍一拍 ──────────────────────────────────────────────────────────
  // OneBot v11：`user_id` = 发起者，`target_id` = 被拍的人。
  // ⚠️ `target_id` 缺失时**不用 `user_id` 兜底** —— 那会把"谁拍的"当成"拍的谁"，
  //    于是任何人拍别人都会被当成拍在机器人身上。拿不准就不触发（fail-closed）。
  if (p.notice_type === 'notify' && p.sub_type === 'poke') {
    const fromId = String(p.user_id ?? '');
    const targetId = p.target_id == null ? '' : String(p.target_id);
    return {
      kind: 'poke',
      scene,
      id: groupId || fromId,
      fromId,
      targetId,
      aboutSelf: !!self && targetId === self,
    };
  }

  // ── ② 群禁言 / 解除 ───────────────────────────────────────────────────
  // OneBot v11：`user_id` = **被禁言的人**，`operator_id` = 操作者，`duration` = 秒。
  // ⚠️ 两道 fail-closed：
  //    · `user_id` 缺失时不拿 `target_id` 兜底（那可能是操作者）；
  //    · 操作者就是自己时直接判否 —— 机器人不可能禁言自己，
  //      出现这种组合说明字段含义与我们的假设不同，此时宁可不管。
  if (p.notice_type === 'group_ban') {
    const banned = p.user_id == null ? '' : String(p.user_id);
    const operator = p.operator_id == null ? '' : String(p.operator_id);
    const lifting = p.sub_type === 'lift_ban';
    const durationSec = Math.max(0, Math.trunc(Number(p.duration ?? 0)) || 0);
    return {
      kind: lifting ? 'unmuted' : 'muted',
      scene: 'group',
      id: groupId,
      fromId: operator,
      targetId: banned,
      aboutSelf: !!self && banned === self && operator !== self,
      durationSec,
    };
  }

  return { kind: 'other', reason: `未处理的 notice_type=${p.notice_type ?? '(空)'}` };
}

/**
 * 把「被拍」合成成一条**普通的群消息事件**。
 *
 * 为什么要合成而不是另开一条处理路径：合成之后它能**原样走主链路** ——
 * 串行队列、判定、限流、花费闸、出口闸门、发送节奏、会话存档，一个都不少。
 * 另开一条路径等于把这六道一次性复制一遍，而它们将来一定会漂。
 *
 * `at` 段的 `qq` 填机器人自己 → `flattenMessage` 会打上 `mentionedSelf`，
 * 于是 `decide()` 按「被 @」这一档处理（与参考实现的「拍一拍＝召唤」一致）。
 *
 * @param {object} n `normalizeNotice` 的返回值（`kind === 'poke'`）
 * @param {string|number} selfId
 * @param {string} [senderName] 展示名；拿不到就给空串（**不编造**，调用方会回落成「用户<号>」）
 */
export function pokeEventOf(n, selfId, senderName = '') {
  const self = String(selfId ?? '');
  const name = String(senderName ?? '').trim();
  return {
    post_type: 'message',
    message_type: 'group',
    group_id: n.id,
    user_id: n.fromId,
    self_id: self,
    sender: name ? { card: name, nickname: name } : {},
    message: [
      { type: 'at', data: { qq: self } },
      { type: 'text', data: { text: POKE_TEXT } },
    ],
    // 宿主侧的标记：这一轮**不进历史、不进背景**（见 src/index.js 的各处守卫）。
    // 防的是模型把「被拍 → 回话」当成一条可复读的规律记进上下文。
    isPoke: true,
  };
}

/**
 * 起床补看的**合成事件**（D31-3）。与 `pokeEventOf` 同一族、同一理由：
 * 合成成一条**普通的消息事件**，它就能原样走主链路 —— 串行队列、判定、限流、
 * 花费闸、出口闸门、发送节奏、会话存档，一个都不少。另开一条发送路径
 * 等于把这六道抄一遍，而它们将来一定会漂。
 *
 * 三段的形状是刻意的：
 *   · `reply` 引用**原消息**（`p.messageId`）—— 补看回的是"那条"，不是凭空开新话题，
 *     群里看过去也是一条引用回复（真人是这么回的）；
 *   · `at` 机器人自己 —— `flattenMessage` 会打上 `mentionedSelf`，
 *     于是 `decide()` 按「被 @」那一档处理（那条本来就是 @ 它的）；
 *   · `text` 是原消息正文（给人/模型看的那一份）。
 *
 * ⚠️ 它**没有 `message_id`** —— 于是不会二次进未读（`unreadEntryOf` 认不出就不记），
 *    也不会被当成"新积压"。这是"补看不会自我繁殖"的结构性保证。
 *
 * @param {{scene:string, id:string|number, messageId:string, userId:string, sender:string, text:string}} p
 *        `catchUpPlanOf().picked` 里的一项
 * @param {string|number} selfId
 */
export function catchUpEventOf(p, selfId) {
  const self = String(selfId ?? '');
  const scene = String(p?.scene || '') === 'group' ? 'group' : 'private';
  const evt = {
    post_type: 'message',
    message_type: scene,
    user_id: String(p?.userId || ''),
    self_id: self,
    sender: p?.sender ? { card: String(p.sender), nickname: String(p.sender) } : {},
    message: [],
    // 宿主侧的标记：这一轮是"补看"，提示词里要多一句（见 brain 的 catchUp 入参）。
    isCatchUp: true,
  };
  if (scene === 'group') evt.group_id = p?.id;
  else evt.user_id = String(p?.userId || '');
  if (p?.messageId) evt.message.push({ type: 'reply', data: { id: String(p.messageId) } });
  evt.message.push({ type: 'at', data: { qq: self } });
  evt.message.push({ type: 'text', data: { text: String(p?.text || '') } });
  return evt;
}

/**
 * 群里发的「/安静」。命中返回 `{ minutes }`，没命中返回 `null`。
 *
 * 接受的形式（**故意只有一种词**，不做同义词表）：
 *   `/安静` · `／安静` · `安静`           → 默认 30 分钟
 *   `/安静 60`                            → 60 分钟
 *   `/安静 0`                             → 解除（写 0 就等于立刻恢复）
 *
 * ⚠️ 调用方**必须先确认这条消息是在跟机器人说话**（`decision.kind === 'named'`），
 *    否则群里一句不带 @ 的「安静」就会让机器人闭嘴 —— 那是个很容易踩的误伤。
 */
export function parseQuietCommand(text) {
  const m = /^[/／]?\s*安静\s*(\d{1,4})?$/.exec(String(text ?? '').trim());
  if (!m) return null;
  const raw = m[1] === undefined ? QUIET_DEFAULT_MIN : Number(m[1]);
  const minutes = Number.isFinite(raw)
    ? Math.min(QUIET_MAX_MIN, Math.max(0, Math.trunc(raw)))
    : QUIET_DEFAULT_MIN;
  return { minutes };
}

/**
 * 「安静到什么时候」。`minutes <= 0` 回 0（= 没有安静期）。
 *
 * 做成两个函数（解析 / 换算）而不是一个带 IO 的：这样"到期自动恢复"
 * 就只是"时间过了"这一件事 —— 不需要任何定时器去清状态，
 * 也就不会出现"定时器没跑，它一直不说话"这种最难查的失败。
 */
export function quietUntilOf(now, minutes) {
  const min = Number(minutes);
  if (!Number.isFinite(min) || min <= 0) return 0;
  return Number(now) + Math.min(QUIET_MAX_MIN, Math.trunc(min)) * 60000;
}
