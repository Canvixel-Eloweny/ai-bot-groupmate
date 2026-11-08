/**
 * 入站翻译：官方事件 → 主链路认得的 OneBot v11 消息事件（2026-11-06 · 零依赖纯函数）。
 *
 * 为什么"翻译成 OneBot 形状"而不是新造一套事件：
 *   主链路（聚批 / 白名单 / 档位 / 存档 / 记忆 / 发送闸）吃的就是
 *   `post_type / message_type / group_id / user_id / message[] / sender / message_id / time`。
 *   换一套形状就要在判定层再写一遍分支，而"同一件事两份判据"正是本仓清得最久的那类腐烂。
 *   翻译层是**唯一**允许知道"官方长什么样"的地方。
 *
 * 三条不能含糊的判据：
 *   ① **@ 必须是可信证据**：官方把 @ 渲染成正文里的 `<@openid>`，
 *      只有解析出来的 at 段才算 @，手打的"@名字"不算（名字会改、也能伪造）。
 *      AT 事件本身没有 at 段（官方已去掉前缀），所以这里**补一个 at(selfId)**，
 *      否则触发档位永远不会因为 @ 命中 —— 这是教程里"平时偶尔回、@ 反而不稳"的根因。
 *   ② **正文为空不等于没东西**：图片/卡片/聊天记录都藏在 attachments / ark_data / msg_elements，
 *      见空就 return 会把整条消息丢掉。
 *   ③ **身份只用 openid，不伪造数字号**：绑定表里有本地群号就用它（旧数据能续上），
 *      没有就原样用 openid。绝不"哈希截短 + 前缀"造一个假 QQ 号 —— 那会把陌生人推进权限链。
 */

import { EVENT } from './constants.js';

// `all` 只有三个字符，必须**显式列出来** —— 否则"@ 全体成员"会被当成普通文字，
// 而 flattenMessage 认的是 `qq:'all'` 段，漏掉它等于逢全体通知必不接话。
const MENTION_RE = /<@(all|[A-Za-z0-9_-]{4,128})>/g;
const OPENID_RE = /^[A-Za-z0-9_-]{8,128}$/;

/**
 * @param {{t?:string,d?:object}} dispatch 网关 op 0 的原始分发
 * @param {{selfId?:string, appId?:string,
 *          resolveGroupId?:(openid:string)=>string,
 *          resolveUserId?:(openid:string)=>string}} ctx
 * @returns {{kind:'message'|'groupStatus'|'ignore', event?:object, official?:object,
 *            dedupeKey?:string, reason?:string}}
 */
export function translateInbound(dispatch, ctx = {}) {
  const t = String(dispatch?.t ?? '');
  const d = dispatch?.d && typeof dispatch.d === 'object' ? dispatch.d : null;
  if (!d) return { kind: 'ignore', reason: '事件体不是对象' };
  const selfId = String(ctx.selfId ?? '');

  switch (t) {
    case EVENT.GROUP_AT:
    case EVENT.GROUP_ALL:
      return groupMessage(d, { selfId, atSelf: t === EVENT.GROUP_AT, appId: ctx.appId, ctx });
    case EVENT.C2C:
      return c2cMessage(d, { selfId, appId: ctx.appId, ctx });
    case EVENT.GROUP_ADD_ROBOT:
    case EVENT.GROUP_DEL_ROBOT:
    case EVENT.GROUP_MSG_RECEIVE:
    case EVENT.GROUP_MSG_REJECT:
      return {
        kind: 'groupStatus',
        official: {
          type: t,
          groupOpenid: String(d.group_openid ?? ''),
          opMemberOpenid: String(d.op_member_openid ?? ''),
          at: eventTimeSeconds(d.timestamp) * 1000,
        },
      };
    default:
      return { kind: 'ignore', reason: `未订阅的事件 ${t || '(空)'}` };
  }
}

function groupMessage(d, { selfId, atSelf, appId, ctx }) {
  const groupOpenid = String(d.group_openid ?? '').trim();
  if (!OPENID_RE.test(groupOpenid)) return { kind: 'ignore', reason: '群 openid 形状不对' };
  const author = d.author && typeof d.author === 'object' ? d.author : {};
  const memberOpenid = String(author.member_openid || author.id || '').trim();
  if (!OPENID_RE.test(memberOpenid)) return { kind: 'ignore', reason: '成员 openid 形状不对' };
  if (author.bot === true && memberOpenid === selfId) {
    // 自己发的消息不回流（官方一般不会推，但推了也不能让它自己接自己的话）。
    return { kind: 'ignore', reason: '机器人自己的消息' };
  }

  const mentions = mentionIndex(d.mentions);
  const segments = [];
  // AT 事件：正文已去掉 @ 前缀，补一个自指 at 段，让 mentionedSelf 成立。
  if (atSelf) segments.push({ type: 'at', data: { qq: selfId } });
  const parsed = parseContentMentions(String(d.content ?? ''), { selfId, mentions, atSelf });
  segments.push(...parsed.segments);

  const extra = mediaSegments(d);
  segments.push(...extra.segments);

  const text = parsed.text + (extra.text ? ` ${extra.text}`.trimEnd() : '');
  const event = {
    post_type: 'message',
    message_type: 'group',
    sub_type: 'normal',
    group_id: resolveLocal(ctx, 'group', groupOpenid),
    user_id: resolveLocal(ctx, 'user', memberOpenid),
    self_id: selfId,
    message_id: String(d.id ?? ''),
    time: eventTimeSeconds(d.timestamp),
    sender: {
      user_id: resolveLocal(ctx, 'user', memberOpenid),
      nickname: String(author.username ?? ''),
      card: '',
    },
    message: segments,
    raw_message: text,
  };
  return {
    kind: 'message',
    event,
    official: {
      scene: 'group',
      msgId: String(d.id ?? ''),
      groupOpenid,
      memberOpenid,
      nickname: String(author.username ?? ''),
      memberRole: String(author.member_role ?? ''),
      atSelf: atSelf || parsed.mentionedSelf,
      imageUrls: imageUrlsOf(segments),
    },
    dedupeKey: dedupeKeyOf(appId, d.id),
  };
}

function c2cMessage(d, { selfId, appId, ctx }) {
  const author = d.author && typeof d.author === 'object' ? d.author : {};
  const userOpenid = String(author.user_openid || author.id || '').trim();
  if (!OPENID_RE.test(userOpenid)) return { kind: 'ignore', reason: '私聊 openid 形状不对' };
  if (author.bot === true && userOpenid === selfId) return { kind: 'ignore', reason: '机器人自己的消息' };
  const mentions = mentionIndex(d.mentions);
  const parsed = parseContentMentions(String(d.content ?? ''), { selfId, mentions, atSelf: false });
  const segments = parsed.segments;
  const extra = mediaSegments(d);
  segments.push(...extra.segments);
  const text = parsed.text + (extra.text ? ` ${extra.text}`.trimEnd() : '');
  const event = {
    post_type: 'message',
    message_type: 'private',
    sub_type: 'C2C',
    user_id: resolveLocal(ctx, 'user', userOpenid),
    self_id: selfId,
    message_id: String(d.id ?? ''),
    time: eventTimeSeconds(d.timestamp),
    sender: {
      user_id: resolveLocal(ctx, 'user', userOpenid),
      nickname: String(author.username ?? ''),
      card: '',
    },
    message: segments,
    raw_message: text,
  };
  return {
    kind: 'message',
    event,
    official: {
      scene: 'private',
      msgId: String(d.id ?? ''),
      userOpenid,
      nickname: String(author.username ?? ''),
      atSelf: false,
      imageUrls: imageUrlsOf(segments),
    },
    dedupeKey: dedupeKeyOf(appId, d.id),
  };
}

/**
 * 正文里的 `<@openid>` 拆成 at 段 + 文本段。
 *
 * ⚠️ 空 mentions 列表**不等于**"明确 @ 了别人"，也**不等于**"@ 了自己"：
 *    它只说明这条事件没带提及信息。判据只看解析出来的 token，不做任何补全。
 */
export function parseContentMentions(content, { selfId, mentions = new Map(), atSelf = false } = {}) {
  const segments = [];
  let text = '';
  let mentionedSelf = atSelf;
  let last = 0;
  const re = new RegExp(MENTION_RE.source, 'g');
  let m;
  while ((m = re.exec(content)) !== null) {
    const before = content.slice(last, m.index);
    if (before) { segments.push({ type: 'text', data: { text: before } }); text += before; }
    const who = m[1];
    if (who === selfId) mentionedSelf = true;
    const name = who === 'all' ? '全体成员' : (mentions.get(who)?.username ?? '');
    segments.push({ type: 'at', data: { qq: who === 'all' ? 'all' : who, name } });
    if (who !== selfId) text += `@${name || who} `;
    last = m.index + m[0].length;
  }
  const tail = content.slice(last);
  if (tail) { segments.push({ type: 'text', data: { text: tail } }); text += tail; }
  if (mentionedSelf && !segments.some((s) => s.type === 'at' && s.data.qq === selfId)) {
    segments.unshift({ type: 'at', data: { qq: selfId } });
  }
  return { segments, text: text.trim(), mentionedSelf };
}

/** 附件 / 卡片 / 消息元素 → 段数组 + 一句占位文本（**正文为空也不丢**）。 */
export function mediaSegments(d) {
  const segments = [];
  const bits = [];
  for (const a of Array.isArray(d.attachments) ? d.attachments : []) {
    const kind = String(a?.content_type ?? '').toLowerCase();
    const url = String(a?.url ?? '').trim();
    const name = String(a?.filename ?? '').trim();
    if (kind.startsWith('image/')) {
      segments.push({ type: 'image', data: { url, file: url } });
      bits.push('[图片]');
    } else if (kind === 'voice') {
      // 官方已经给了转好的 WAV 与 ASR 参考文本；本批只留地址，不自动听。
      segments.push({
        type: 'record',
        data: { url: String(a?.voice_wav_url ?? url), file: url, asr: String(a?.asr_refer_text ?? '') },
      });
      bits.push('[语音]');
    } else if (kind === 'video/mp4') {
      segments.push({ type: 'video', data: { url, file: url, name } });
      bits.push('[视频]');
    } else {
      segments.push({ type: 'file', data: { url, file: url, name } });
      bits.push(name ? `[文件:${name}]` : '[文件]');
    }
  }
  if (d.ark_data && typeof d.ark_data === 'object') {
    const line = arkText(d.ark_data);
    if (line) { segments.push({ type: 'text', data: { text: line } }); bits.push(line); }
  }
  const flat = flattenElements(d.msg_elements);
  if (flat.text) { segments.push({ type: 'text', data: { text: flat.text } }); bits.push(flat.text); }
  if (flat.replyTo) segments.push({ type: 'reply', data: { id: flat.replyTo } });
  return { segments, text: bits.join(' ') };
}

/** 结构化卡片：只把"人看得懂的那几句"拼出来，链接原样保留（模型自己决定要不要提）。 */
export function arkText(ark) {
  const f = ark?.fields && typeof ark.fields === 'object' ? ark.fields : {};
  const title = String(f.title ?? '').trim();
  const desc = String(f.desc ?? '').trim();
  const url = String(f.jump_url ?? '').trim();
  const label = String(ark.ark_name || ark.ark_type || '卡片').trim();
  const parts = [`[${label}]`];
  if (title) parts.push(title);
  if (desc) parts.push(desc);
  if (url) parts.push(url);
  return parts.length > 1 ? parts.join(' ') : '';
}

/**
 * `msg_elements` 拍平。
 *
 * 官方把「聊天记录」(102) 与「引用」(103) 放在递归元素里，**没有** OneBot 的
 * forward 段，也没有可回查的历史接口 —— 所以这里当场拍成文本，
 * 让 `get_forward_msg` 那条回查路径在官方通道里根本没有机会被调用。
 */
export function flattenElements(elements, depth = 0) {
  const out = [];
  let replyTo = '';
  if (!Array.isArray(elements) || depth > 3) return { text: '', replyTo: '' };
  for (const el of elements) {
    const type = Number(el?.message_type);
    const body = String(el?.content ?? '').trim();
    const inner = flattenElements(el?.msg_elements, depth + 1);
    if (type === 103) {
      const quoted = body || inner.text;
      if (quoted) out.push(`[引用] ${quoted}`);
    } else if (type === 102) {
      const quoted = [body, inner.text].filter(Boolean).join('\n');
      if (quoted) out.push(`[聊天记录]\n${quoted}`);
    } else if (type === 3) {
      const line = el?.ark_data ? arkText(el.ark_data) : '';
      if (line) out.push(line);
    } else if (body) {
      out.push(body);
    }
    if (inner.replyTo && !replyTo) replyTo = inner.replyTo;
    for (const a of Array.isArray(el?.attachments) ? el.attachments : []) {
      if (String(a?.content_type ?? '').toLowerCase().startsWith('image/')) out.push('[图片]');
    }
  }
  return { text: out.join('\n').trim(), replyTo };
}

/** RFC3339 或秒级时间戳 → Unix 秒（认不出来就用当前时间，并让调用方能看出它没解出来）。 */
export function eventTimeSeconds(timestamp) {
  const raw = String(timestamp ?? '').trim();
  if (!raw) return Math.floor(Date.now() / 1000);
  if (/^\d{10}$/.test(raw)) return Number(raw);
  if (/^\d{13}$/.test(raw)) return Math.floor(Number(raw) / 1000);
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : Math.floor(Date.now() / 1000);
}

/** 去重键必须带 appId：同一台机器上跑两个机器人应用时，两边的 msg_id 不属于同一个命名空间。 */
export function dedupeKeyOf(appId, msgId) {
  const id = String(msgId ?? '').trim();
  return id ? `${String(appId ?? '').trim()}|${id}` : '';
}

function mentionIndex(mentions) {
  const map = new Map();
  for (const m of Array.isArray(mentions) ? mentions : []) {
    const id = String(m?.id || m?.member_openid || m?.user_openid || '').trim();
    if (id) map.set(id, { username: String(m?.username ?? ''), isYou: m?.is_you === true });
  }
  return map;
}

function imageUrlsOf(segments) {
  return segments
    .filter((s) => s?.type === 'image')
    .map((s) => String(s.data?.url ?? '').trim())
    .filter(Boolean);
}

function resolveLocal(ctx, kind, openid) {
  const fn = kind === 'group' ? ctx.resolveGroupId : ctx.resolveUserId;
  if (typeof fn !== 'function') return openid;
  return fn(openid) || openid;
}
