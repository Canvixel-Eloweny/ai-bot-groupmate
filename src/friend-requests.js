/**
 * 好友申请 / 群邀请（B1.1 · 2026-11-04 · 群友报告 MIG-*）。
 *
 * 修的是"申请到了但没有任何人知道"：`onebot.js` 把**所有非 message 报文**都
 * `emit('notice')`，而 `index.js` 的 notice 监听第一句是
 * `if (evt?.post_type !== 'notice') return;` ⇒ `post_type === 'request'` 的报文
 * **一声不响地被丢掉**。表现为"有人加她、她被群邀请，什么都没有发生过"，
 * 而四层回归全绿 —— 那是本项目最怕的失败模式（静默丢弃）。
 *
 * ⚠️ 零依赖叶子：不 import、不碰 IO、时间由 `now` 入参给（反例才能在测试里逐格喂）。
 *
 * 口径（维护者 2026-11-03 选定「通知 + 面板待处理列表」）：
 *   · **不自动通过**，也**不做自然语言审批** —— 加好友是永久性动作，一次误判撤不回来；
 *   · 机器人只做三件事：收下、落盘、告诉主人"有人在申请"；
 *   · 通过 / 拒绝由主人在面板上点，走**控制通道**回给机器人执行
 *     （只有机器人进程握着 OneBot 的连接与 token；面板自己去调等于把端点与凭据抄第二份）。
 */

/** 列表上限（**经验值**）：QQ 自己会把过期申请收走，这里只是防文件无限长。 */
export const FRIEND_REQ_MAX = 30;

/** 一条申请在盘上最多留这么久（**经验值**）：比 QQ 侧的有效期宽，宁多留不误删。 */
export const FRIEND_REQ_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * 状态的闭集合。
 *
 * ⚠️ 有 `failed` 是刻意的：`set_friend_add_request` 会因为申请已过期 / 协议端不认而失败。
 *    失败**必须留下痕迹并显示成失败** —— 把它折叠成"没有这条"，用户会以为已经处理过了，
 *    于是既没加上好友也没人告诉他为什么（本项目在"失败不静默"上踩过很多次）。
 */
export const FRIEND_REQ_STATUS = Object.freeze(['pending', 'approved', 'denied', 'failed']);

/** 两种申请（其它 `request_type` 一律不收，收下来路不明的种类等于自己造语义）。 */
export const FRIEND_REQ_KINDS = Object.freeze(['friend', 'group']);

/**
 * 盘上的**文件名**（不是全路径 —— 这个叶子零依赖，拼不了 `DATA_DIR`）。
 * 机器人写、面板读，两边各自 `path.join(DATA_DIR, FRIEND_REQ_FILE_NAME)`：
 * 名字只有一份，否则"改了写侧忘了改读侧"会让面板永远显示空列表而没有任何一层会红。
 */
export const FRIEND_REQ_FILE_NAME = 'friend-requests.json';

const s = (v) => String(v ?? '').trim();

/**
 * 一条 `request` 报文 → 待处理记录。不是这两种申请时给 `null`（**不猜**）。
 *
 * `flag` 是协议端给的"处理这一条申请"的凭据，**没有它就谁都办不了** ——
 * 所以缺 flag 直接不收，而不是收下来再在点按钮时报错（那会把一条根本办不成的
 * 记录留在列表里骗人）。
 */
export function normalizeRequestOf(evt, { now = 0 } = {}) {
  const flag = s(evt?.flag);
  if (!flag) return null;
  // 种类用闭集合判（不写两个三元）—— 加一种申请时只改 `FRIEND_REQ_KINDS` 那一处。
  const kind = s(evt?.request_type).toLowerCase();
  if (!FRIEND_REQ_KINDS.includes(kind)) return null;
  const at = Number(evt?.time) * 1000;
  return {
    flag,
    kind,
    userId: s(evt?.user_id),
    // 群邀请带 group_id；好友申请没有这一格（留空串，不写 null —— 面板逐字渲染它）。
    groupId: s(evt?.group_id),
    comment: s(evt?.comment).slice(0, 120),
    // 事件自带的 time 是**秒**且可能是旧版协议端漏发的；缺了就用收下的时刻。
    at: Number.isFinite(at) && at > 0 ? at : (Number(now) || 0),
    status: 'pending',
    result: '',
  };
}

/**
 * 收进列表（**纯函数**，返回新数组，不改入参）。
 *
 * 三条判据，缺一条都会变成看得见的麻烦：
 *   ① **同一个 flag 重复到达不再新增**：QQ 会把同一条申请反复推过来，
 *      每次都通知主人 = 半夜被自己的机器人刷屏；
 *   ② 过期条目先丢（文件不无限长，也不显示早已被 QQ 收走的申请）；
 *   ③ 封顶后丢**最旧的**，而不是最新的 —— 新到的那条才是主人现在能处理的事。
 *
 * @returns {{list:object[], added:boolean, duplicate:boolean, dropped:number}}
 */
export function upsertRequest(list, rec, { now = 0 } = {}) {
  const base = Array.isArray(list) ? list : [];
  if (!rec || !s(rec.flag)) return { list: base, added: false, duplicate: false, dropped: 0 };
  if (base.some((x) => s(x?.flag) === s(rec.flag))) {
    return { list: base, added: false, duplicate: true, dropped: 0 };
  }
  const live = base.filter((x) => !(Number(x?.at) > 0 && Number(now) - Number(x.at) > FRIEND_REQ_TTL_MS));
  const next = [...live, rec];
  const dropped = Math.max(0, next.length - FRIEND_REQ_MAX);
  return {
    list: dropped ? next.slice(next.length - FRIEND_REQ_MAX) : next,
    added: true,
    duplicate: false,
    dropped,
  };
}

/**
 * 把某一条标成处理完（**纯函数**）。找不到时 `found:false` —— 调用方要如实回执，
 * 不许"没找到也回 ok"（面板据此显示"已同意"，而实际上什么都没发生）。
 *
 * ⚠️ 过期条目**也允许被 resolve**：主人看到列表时它可能已经老了，但"我点了同意，
 *    机器人说没这条"比"机器人去试、失败、告诉我失败原因"更难查。
 *    真正的过期由协议端裁定，我们只负责不静默。
 */
export function resolveRequestOf(list, flag, { status = '', msg = '', at = 0 } = {}) {
  const base = Array.isArray(list) ? list : [];
  const want = s(flag);
  if (!FRIEND_REQ_STATUS.includes(status)) {
    return { list: base, found: false, reason: `不认识的处理结果「${status}」` };
  }
  const at2 = base.findIndex((x) => s(x?.flag) === want);
  if (at2 < 0) return { list: base, found: false, reason: `列表里没有 flag「${want}」这条申请（可能已被清掉）` };
  const next = base.slice();
  next[at2] = { ...next[at2], status, result: s(msg).slice(0, 160), handledAt: Number(at) || 0 };
  return { list: next, found: true, reason: '' };
}

/** 还等主人拍板的那几条（面板显示"待处理 N"，机器人通知时也用它判重）。 */
export function pendingRequestsOf(list) {
  return (Array.isArray(list) ? list : []).filter((x) => x?.status === 'pending');
}

/**
 * 给主人那一句通知的**内容**（不含发送，发送归 `sayToOwner`）。
 *
 * 单独成一个函数是为了可测：这条消息里必须带上"怎么回"（去面板点），
 * 否则主人收到"有人在申请"之后除了猜测没有第二条路 ——
 * 而这条缺陷报告原本的形状就是"她不理人"。
 *
 * ⚠️ 这里**不写 QQ 号之外的任何画像**：comment 是申请人自己填的原文，
 *    照搬可以，替他归纳"他大概是…"就是编造（与说话风格画像同一条纪律）。
 */
export function requestNoticeTextOf(rec, { pending = 1 } = {}) {
  const who = s(rec?.userId) || '（没有号）';
  const what = rec?.kind === 'group'
    ? `有人邀请她加群（群号 ${s(rec.groupId) || '未知'}）`
    : `有人申请加她好友`;
  const note = s(rec?.comment) ? `，留言「${s(rec.comment)}」` : '';
  const more = Number(pending) > 1 ? `（这是第 ${Number(pending)} 条，都堆在控制台的「好友申请」那格）` : '';
  return `${what}${note} —— 来自 ${who}${more}。要不要通过由你在控制台里点，我不会自己答应。`;
}

/**
 * 控制通道那一条命令要用的入参（**唯一校验点**）。
 *
 * `friend.resolve` 的 `arg` 形状是 `<flag>|<approve>`：
 *   · flag 里不许出现 `|`（上面归一化时已按整个字符串收，这里再挡一次拼接注入）；
 *   · approve 只认 `true` / `false` 两个字面量 —— 拒绝"任何非空字符串都算同意"，
 *     那会让一条写歪的命令变成永久性动作。
 *
 * @returns {{ok:boolean, flag:string, approve:boolean, reason:string}}
 */
export function parseResolveArg(arg = '') {
  const text = s(arg);
  const cut = text.lastIndexOf('|');
  if (cut <= 0) return { ok: false, flag: '', approve: false, reason: '命令没带申请标识与同意/拒绝' };
  const flag = text.slice(0, cut);
  const approve = text.slice(cut + 1);
  if (!flag || flag.includes('|')) {
    return { ok: false, flag: '', approve: false, reason: '申请标识是空的或含分隔符，无法定位那一条' };
  }
  if (approve !== 'true' && approve !== 'false') {
    return { ok: false, flag: '', approve: false, reason: `同意/拒绝那一格只认 true / false，收到「${approve}」` };
  }
  return { ok: true, flag, approve: approve === 'true', reason: '' };
}
