#!/usr/bin/env node
/**
 * 官方机器人通道的离线契约测试（2026-11-06 · P1/P2/P3 的判据）。
 *
 * 取向与本仓其它 `test/check-*.mjs` 一致：
 *   · **不碰真网**：fetch / WebSocket 全部注入假的，断言的是"我们发出去什么形状"，
 *     不是"平台今天答不答"（平台行为归 P7 真机验收矩阵）。
 *   · 每条判据都要能**独立变红**：所以既有正向（翻译对）也有反向（缺凭据不许连、
 *     不支持的动作不许伪成功、AppSecret 不许进快照）。
 *   · 输入基数自证：`OFFICIAL_CHECKS=<n>` 由 `scripts/mutate-lint.mjs` / §190 核下限。
 *
 * 退出码：0 = 全过；1 = 有失败；2 = 环境读不到（不接受"因此没测"当通过）。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CHANNEL_LABELS, CHANNEL_MODES, DEFAULT_CHANNEL_MODE, LEGACY_CHANNEL_MODE,
  channelIsConfigured, normalizeChannelMode, resolveChannelMode,
} from '../src/channel-mode.js';
import {
  FILE_TYPE, MSG_TYPE, OFFICIAL_BASE, PASSIVE_LIMIT, TOKEN_PATH,
  assertOfficialBase, groupMessagesPath,
} from '../src/backend/official/constants.js';
import { OFFICIAL_CODE, classifyOfficialReply } from '../src/backend/official/errors.js';
import { createOfficialHttp } from '../src/backend/official/http.js';
import { createTokenManager } from '../src/backend/official/token.js';
import { createPassiveLedger } from '../src/backend/official/passive.js';
import { createSeenStore } from '../src/backend/official/seen-store.js';
import {
  arkText, dedupeKeyOf, eventTimeSeconds, flattenElements, mediaSegments,
  parseContentMentions, translateInbound,
} from '../src/backend/official/inbound.js';
import { chunkText, hasNothingToSend, planOutbound } from '../src/backend/official/outbound.js';
import { officialPanelView, officialVerdictOf } from '../src/official-liveness.js';
import { OfficialClient } from '../src/backend/official/client.js';
import { flattenMessage } from '../src/onebot.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];
let checks = 0;
const hit = (cond, msg) => { checks += 1; if (!cond) problems.push(msg); };
const eq = (actual, expected, msg) => hit(actual === expected, `${msg}（实际 ${JSON.stringify(actual)}，应为 ${JSON.stringify(expected)}）`);
// 端到端那一节的等待一律轮询终态，不固定 sleep：慢机器上 sleep 会稳定变红，
// 而快机器上又掩盖真 bug（与 panel-dom 的"动画终态必须轮询"同一条纪律）。
const until = async (pred, ms = 2000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return pred();
};

// 一条最小 PNG 的头（imageMimeOf 认它），用来喂 base64 图片段。
const PNG_B64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]).toString('base64');

// ──  通道选择：默认 NapCat，两档来源语义分开 ─────────────────────────────
// 维护者 2026-11-06 先定"默认官方"、同日改口回 NapCat：官方通道要 AppID/AppSecret，
// 设成默认会让新装第一眼就是"缺凭据、不说话"。两档默认值同值但**语义不同**
// （example 说新装、legacy 说已装升级），所以下面两行都要单独验出处。
eq(CHANNEL_MODES.length, 2, '通道枚举只许有两条');
eq(DEFAULT_CHANNEL_MODE, 'napcat', '新装默认必须是 NapCat');
eq(LEGACY_CHANNEL_MODE, 'napcat', '旧配置回落必须是 NapCat');
eq(normalizeChannelMode('Official'), 'official', '通道值大小写不敏感');
eq(normalizeChannelMode('napcat '), 'napcat', '通道值去空格');
eq(normalizeChannelMode('snowluma'), '', '非通道值不许被当成通道（那是 onebot.backend 的词表）');
{
  const cases = [
    [{ configured: 'official', usedExample: false, env: {} }, 'official', 'config'],
    [{ configured: '', usedExample: false, env: {} }, 'napcat', 'legacy'],
    [{ configured: '', usedExample: true, env: {} }, 'napcat', 'example'],
    [{ configured: 'official', usedExample: false, env: { QQBOT_CHANNEL: 'napcat' } }, 'napcat', 'env'],
    [{ configured: 'napcat', usedExample: true, env: { QQBOT_CHANNEL: '坏值' } }, 'napcat', 'config'],
  ];
  for (const [input, mode, source] of cases) {
    const got = resolveChannelMode(input);
    eq(got.mode, mode, `通道判定 ${JSON.stringify(input)}`);
    eq(got.source, source, `通道判定出处 ${JSON.stringify(input)}`);
  }
  const ignored = resolveChannelMode({ configured: '', usedExample: true, env: { QQBOT_CHANNEL: 'qq' } });
  eq(ignored.ignoredEnv, 'qq', '不认识的环境覆盖必须被说出来，而不是静默吞掉');
}
eq(channelIsConfigured('official', { appId: '1', appSecret: '' }), false, '只有 AppID 不算配好');
eq(channelIsConfigured('official', { appId: '1', appSecret: 's' }), true, '两个都有才算配好');
eq(channelIsConfigured('napcat', {}), true, 'NapCat 通道不看 AppID');

// ── ② 固定地址：AppSecret 不许发往第三台机器 ─────────────────────────────
eq(assertOfficialBase(OFFICIAL_BASE), 'https://api.bot.qq.com', '官方根地址');
eq(assertOfficialBase('http://127.0.0.1:9099'), 'http://127.0.0.1:9099', '环回允许（本地假网关）');
for (const bad of ['https://evil.example.com', 'https://api.bot.qq.com.evil.example', 'ftp://api.bot.qq.com']) {
  checks += 1;
  let threw = false;
  try { assertOfficialBase(bad); } catch { threw = true; }
  if (!threw) problems.push(`放行非法官方地址：${bad} —— 这条放行等于把 AppSecret 外送做成一个功能`);
}
eq(groupMessagesPath('B2C3/xx'), '/v2/groups/B2C3%2Fxx/messages', 'openid 必须 encode 进路径');

// ── ③ 失败归一：HTTP 200 也可能是失败 ───────────────────────────────────
{
  const a = classifyOfficialReply({ httpStatus: 200, body: { code: 40034128, message: '被动消息失败' } });
  eq(a.businessOk, false, 'HTTP 200 + 业务码非 0 必须是失败');
  eq(a.code, OFFICIAL_CODE.passiveExhausted, '40034128 归一成被动超限');
  const b = classifyOfficialReply({ httpStatus: 200, body: { code: 0, data: { id: 'x' } } });
  eq(b.businessOk, true, 'code 0 是成功');
  const c = classifyOfficialReply({ httpStatus: 401, body: {} });
  eq(c.code, OFFICIAL_CODE.auth, '401 归一成鉴权');
  eq(c.retryable, true, '鉴权失败可以重取 token 再试');
  const d = classifyOfficialReply({ httpStatus: 503, body: {} });
  eq(d.retryable, false, '5xx 是结果不明，不许自动重发');
  const e = classifyOfficialReply({ transportError: 'socket hang up' });
  eq(e.retryable, false, '传输失败不许自动重发（重发 = 群里两条一样的话）');
  eq(classifyOfficialReply({ httpStatus: 200, body: { code: 40054005 } }).code, OFFICIAL_CODE.duplicate, '去重码归一');
  eq(classifyOfficialReply({ httpStatus: 200, body: { code: 40054010 } }).code, OFFICIAL_CODE.urlNotAllowed, 'URL 拒绝码归一');
  eq(classifyOfficialReply({ httpStatus: 200, body: { code: 11253 } }).code, OFFICIAL_CODE.noPermission, '白名单接口码归一');
  eq(classifyOfficialReply({ httpStatus: 200, rawText: 'not json' }).code, OFFICIAL_CODE.business, '非 JSON 回包算失败');
}

// ──  token：单飞 + 提前刷新 + 快照不带凭据 ─────────────────────────────
{
  let calls = 0;
  let clock = 1_000_000;
  const fakeHttp = {
    async fetchAccessToken() { calls += 1; return { token: `TK${calls}`, expiresIn: 7200 }; },
  };
  const tm = createTokenManager({ appId: 'APPID-X', appSecret: 'SECRET-Y', http: fakeHttp, now: () => clock });
  const [x, y] = await Promise.all([tm.get(), tm.get()]);
  eq(x, y, '并发取 token 必须共用一次请求');
  eq(calls, 1, `token 单飞（实际取了 ${calls} 次）`);
  clock += (7200 - 60) * 1000;
  eq(tm.needsRefresh(), true, '临近过期要主动刷新');
  await tm.get();
  eq(calls, 2, '过期后重新取');
  tm.invalidate();
  const snap = JSON.stringify(tm.snapshot());
  eq(snap.includes('expiresAt":0'), true, '作废后快照不再报有效期');
  hit(!snap.includes('SECRET-Y'), 'token 快照里不许出现 AppSecret');
  hit(!snap.includes('TK1') && !snap.includes('TK2'), 'token 快照里不许出现 access_token 本体');
  const un = createTokenManager({ appId: 'a', appSecret: '', http: fakeHttp });
  checks += 1;
  let code = '';
  await un.get().catch((e) => { code = e.code; });
  eq(code, OFFICIAL_CODE.unconfigured, '缺凭据取 token 必须是"未配置"，不是网络错误');
}

// ── ⑤ HTTP：头格式、body、重定向、超时 ──────────────────────────────────
{
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, init });
    return {
      status: 200,
      text: async () => JSON.stringify({ code: 0, data: { ok: 1 } }),
    };
  };
  const http = createOfficialHttp({ base: OFFICIAL_BASE, fetchImpl });
  const data = await http.request('GET', '/users/@me', { token: 'T' });
  eq(data.ok, 1, '回包 data 被剥出来');
  eq(seen[0].init.headers.Authorization, 'QQBot T', '鉴权头格式必须是 QQBot <token>');
  eq(seen[0].init.redirect, 'manual', '不许自动跟随重定向');
  // 回包结构对了但没有 access_token：必须报错，而不是把 undefined 交给上层当"拿到凭据了"。
  checks += 1;
  let noTokenCode = '';
  await http.fetchAccessToken('APP', 'SECRET').catch((e) => { noTokenCode = e.code; });
  eq(noTokenCode, OFFICIAL_CODE.auth, '取 token 回包没有 access_token 必须当鉴权失败');
}
{
  // 取 token 的接口**业务失败也回 HTTP 200**：这条必须报错，而不是把 undefined 交出去。
  const fetchImpl = async () => ({ status: 200, text: async () => JSON.stringify({ code: 11244, message: 'appsecret 错误' }) });
  const http = createOfficialHttp({ base: OFFICIAL_BASE, fetchImpl });
  checks += 1;
  let code = '';
  await http.fetchAccessToken('A', 'S').catch((e) => { code = e.code; });
  eq(code, OFFICIAL_CODE.auth, 'HTTP 200 + 鉴权码必须当失败');
}
{
  // 重定向：3xx 一律失败（跟随重定向就是凭据外送的那条路）。
  const fetchImpl = async () => ({ status: 302, text: async () => '' });
  const http = createOfficialHttp({ base: OFFICIAL_BASE, fetchImpl });
  checks += 1;
  let code = '';
  await http.request('GET', '/x', { token: 'T' }).catch((e) => { code = e.code; });
  eq(code, OFFICIAL_CODE.transport, '3xx 按失败处理');
}
{
  // 超时：AbortController 真的把请求掐掉。
  // ⚠️ 生产侧的超时定时器是 unref 的（一个挂着的请求不该拖住进程退出），
  //    所以这里必须自己留一个 ref 定时器，否则事件空转、Node 直接带着未完成的 await 退出。
  const keep = setTimeout(() => {}, 500);
  const fetchImpl = (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
  const http = createOfficialHttp({ base: OFFICIAL_BASE, fetchImpl, timeoutMs: 20 });
  checks += 1;
  let code = '';
  await http.request('GET', '/x', {}).catch((e) => { code = e.code; });
  eq(code, OFFICIAL_CODE.timeout, '超时归一成 timeout');
  clearTimeout(keep);
}
{
  const http = createOfficialHttp({ base: OFFICIAL_BASE, fetchImpl: async () => ({ status: 200, text: async () => '{}' }) });
  checks += 1;
  let emptyCode = '';
  await http.fetchAccessToken('A', 'S').catch((e) => { emptyCode = e.code; });
  eq(emptyCode, OFFICIAL_CODE.auth, '完全空的回包也要当鉴权失败');
}

// ── ⑥ 入站翻译：@ 必须是可信证据 ─────────────────────────────────────────
{
  const ctx = { selfId: 'BOTOID', appId: '10001' };
  const at = translateInbound({
    t: 'GROUP_AT_MESSAGE_CREATE',
    d: {
      id: 'Q1', group_openid: 'G1'.padEnd(32, '0'), timestamp: '2026-11-06T10:00:00+08:00',
      author: { member_openid: 'M1'.padEnd(32, '0'), username: '小明' },
      content: '今天中午吃什么',
    },
  }, ctx);
  eq(at.kind, 'message', 'AT 事件要产出消息');
  eq(at.event.message_type, 'group', 'AT 事件是群消息');
  const f = flattenMessage(at.event.message, at.event.self_id);
  eq(f.mentionedSelf, true, 'AT 事件必须让 mentionedSelf 成立（否则档位永远不因 @ 命中）');
  eq(at.event.group_id, 'G1'.padEnd(32, '0'), '没绑定时群键就是 openid');
  eq(at.event.user_id, 'M1'.padEnd(32, '0'), '没绑定时人键就是 member_openid');
  eq(at.event.sender.nickname, '小明', '昵称只作展示');
  eq(at.event.message_id, 'Q1', '消息号透传，供去重与被动回复');
  eq(at.dedupeKey, '10001|Q1', '去重键必须带 appId');

  const bound = translateInbound({
    t: 'GROUP_AT_MESSAGE_CREATE',
    d: {
      id: 'Q2', group_openid: 'G2'.padEnd(32, '0'), timestamp: '1780000000',
      author: { member_openid: 'M2'.padEnd(32, '0'), username: '小红' }, content: '在吗',
    },
  }, { ...ctx, resolveGroupId: () => '123456789' });
  eq(bound.event.group_id, '123456789', '绑定过的群要用本地群号（旧记忆才接得上）');

  // 全量事件：正文带 `<@别人>`，且没有 AT 事件 —— 不能被误判成"被 @ 了"。
  const full = translateInbound({
    t: 'GROUP_MESSAGE_CREATE',
    d: {
      id: 'Q3', group_openid: 'G3'.padEnd(32, '0'), timestamp: '1780000001',
      author: { member_openid: 'M3'.padEnd(32, '0'), username: '群友' },
      content: `前面那句 <@${'M4'.padEnd(32, '0')}> 说得对`,
    },
  }, ctx);
  eq(full.kind, 'message', '全量事件要产出消息');
  eq(flattenMessage(full.event.message, full.event.self_id).mentionedSelf, false,
    '全量事件里没 @ 自己就不算被 @（补全会让它逢话必答）');

  // 正文为空但有图：整条不许被丢掉。
  const onlyImage = translateInbound({
    t: 'GROUP_MESSAGE_CREATE',
    d: {
      id: 'Q4', group_openid: 'G4'.padEnd(32, '0'), timestamp: '1780000002',
      author: { member_openid: 'M5'.padEnd(32, '0'), username: '发图的人' },
      content: '',
      attachments: [{ content_type: 'image/png', url: 'https://multimedia.nt.qq.com.cn/d?rkey=1' }],
    },
  }, ctx);
  eq(onlyImage.kind, 'message', '只有附件的消息仍然要入链路');
  eq(flattenMessage(onlyImage.event.message, 'BOTOID').images.length, 1, '附件图进 images');
}
{
  const self = 'B'.repeat(32);
  const other = 'A'.repeat(32);
  const parsed = parseContentMentions(`早啊 <@${other}> 和 <@${self}> 还有 <@all>`, {
    selfId: self,
    mentions: new Map([[other, { username: '老王', isYou: false }]]),
  });
  eq(parsed.mentionedSelf, true, '全量事件里 <@自己> 也算被 @');
  const f = flattenMessage(parsed.segments, self);
  eq(f.mentionedSelf, true, '翻译结果交给既有 flattenMessage 必须认出自指 @');
  hit(!f.bareText.includes('老王'), '别人的 @ 显示名不许进触发判据（bareText）');
  hit(f.text.includes('@老王'), '别人的 @ 显示名要给人看得到');
  const all = parseContentMentions('<@all> 集合', { selfId: self });
  eq(flattenMessage(all.segments, self).mentionedSelf, true, '@ 全体成员算被 @');
  const none = parseContentMentions('随便聊聊', { selfId: self });
  eq(none.mentionedSelf, false, '没有提及就是没有被 @，不许补全');
}
{
  // 正文为空但有图：不能整条丢掉。
  const seg = mediaSegments({ attachments: [{ content_type: 'image/png', url: 'https://multimedia.nt.qq.com.cn/download?rkey=x' }] });
  const f = flattenMessage(seg.segments, 'BOT');
  eq(f.images.length, 1, '图片段要进 images（识图链路的入口）');
  eq(f.text, '[图片]', '正文为空也要有占位文本');
  const ark = arkText({ ark_name: '小程序', fields: { title: 'B 站视频', desc: '_up_ 某UP', jump_url: 'https://b23.tv/x' } });
  hit(ark.includes('[小程序]') && ark.includes('B 站视频') && ark.includes('https://b23.tv/x'), '卡片要抽出标题与链接');
  const rec = flattenElements([{ message_type: 102, content: '第一条\n第二条' }]);
  hit(rec.text.includes('[聊天记录]') && rec.text.includes('第二条'), '聊天记录当场拍平成文本');
  eq(eventTimeSeconds('2026-11-06T10:00:00+08:00'), Math.floor(Date.parse('2026-11-06T10:00:00+08:00') / 1000), 'RFC3339 → 秒');
  eq(eventTimeSeconds('1780000000'), 1780000000, '秒级时间戳原样');
}

// ── ⑦ 出站计划：不支持就是不支持 ─────────────────────────────────────────
{
  const plan = planOutbound([
    { type: 'at', data: { qq: 'BOT' } },
    { type: 'text', data: { text: '来了' } },
    { type: 'reply', data: { id: 'Q9' } },
  ], { selfId: 'BOT' });
  eq(plan.steps.length, 1, '一条文本一个步骤');
  eq(plan.steps[0].content, '来了', '@ 自己不落到正文');
  eq(plan.referenceId, 'Q9', '引用段变成 message_reference');
  eq(plan.steps[0].referenceId, 'Q9', '引用挂在第一条上');

  const atOther = planOutbound([{ type: 'at', data: { qq: 'A'.repeat(32) } }, { type: 'text', data: { text: '看看' } }],
    { selfId: 'BOT', nameOf: () => '老王' });
  eq(atOther.steps[0].content, '@老王 看看', '出站 @ 降级为正文');
  eq(atOther.degraded.length, 1, '降级要留下可日志的痕迹');

  const fwd = planOutbound([{ type: 'forward', data: {} }], { selfId: 'BOT' });
  hit(fwd.unsupported.includes('forward'), '合并转发段必须被标成不支持');

  const img = planOutbound([{ type: 'image', data: { file: `base64://${PNG_B64}` } }], { selfId: 'BOT' });
  eq(img.steps[0].kind, 'image', '图片段产出上传步骤');
  hit(hasNothingToSend(planOutbound([], { selfId: 'BOT'})), '空段数组要判成"没东西可发"');
  eq(chunkText('x'.repeat(2500)).length, 2, '超长文本按保守上限切块');
  eq(chunkText('短').length, 1, '不超长不切');
  eq(FILE_TYPE.image, 1, '文件类型枚举与官方一致');
  eq(MSG_TYPE.media, 7, '富媒体消息类型与官方一致');
  eq(PASSIVE_LIMIT.group.maxReplies, 5, '群被动次数上限');
  eq(PASSIVE_LIMIT.private.maxReplies, 4, '私聊被动次数上限');
}

// ── ⑧ 被动账本：逐会话、限次、限时 ───────────────────────────────────────
{
  let clock = 0;
  const ledger = createPassiveLedger({ now: () => clock });
  ledger.noteInbound({ scene: 'group', chatId: 'G1', msgId: 'M1', receivedAt: clock });
  ledger.noteInbound({ scene: 'group', chatId: 'G2', msgId: 'M2', receivedAt: clock });
  const seqs = [];
  for (let i = 0; i < 7; i += 1) seqs.push(ledger.next({ scene: 'group', chatId: 'G1' }));
  eq(seqs[0].msg_seq, 1, '第一次被动回复 seq=1');
  eq(seqs[4].msg_seq, 5, '第五次仍在窗口内');
  eq(seqs[5], null, '第六次必须没有凭据（平台只给 5 次）');
  eq(seqs[0].msg_id, 'M1', '凭据用的是本会话自己的消息号');
  eq(ledger.next({ scene: 'group', chatId: 'G2' }).msg_id, 'M2', '另一个群用另一个凭据（全局槽就是串群）');
  clock = PASSIVE_LIMIT.group.windowMs + 1;
  eq(ledger.next({ scene: 'group', chatId: 'G2' }), null, '超窗后不再给被动凭据');
  eq(ledger.snapshot().expired >= 1, true, '过期计数要能看见');
}

// ── ⑨ 去重表：跨重启仍然有效 ─────────────────────────────────────────────
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'official-seen-'));
  const file = path.join(dir, 'seen.json');
  const quiet = { warn() {} };
  const s1 = createSeenStore({ file, limit: 3, log: quiet });
  s1.add('a|1'); s1.add('a|2'); s1.add('a|3'); s1.add('a|4');
  s1.flush();
  eq(fs.existsSync(file), true, '去重表落盘');
  const s2 = createSeenStore({ file, limit: 3, log: quiet });
  s2.load();
  eq(s2.has('a|4'), true, '重启后仍然认识最近那条');
  eq(s2.has('a|1'), false, '超过容量上限的最旧记录被挤掉（有上限才不会被撑爆）');
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── ⑩ 客户端端到端（假网关 + 假 fetch）───────────────────────────────────
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'official-client-'));
  const reqs = [];
  const fetchImpl = async (url, init) => {
    reqs.push({ url, init });
    if (url.endsWith(TOKEN_PATH)) {
      return { status: 200, text: async () => JSON.stringify({ code: 0, data: { access_token: 'TK', expires_in: 7200 } }) };
    }
    if (url.endsWith('/users/@me')) {
      return { status: 200, text: async () => JSON.stringify({ code: 0, data: { id: 'BOTID', username: '小助手' } }) };
    }
    if (url.includes('/files')) {
      return { status: 200, text: async () => JSON.stringify({ code: 0, data: { file_info: 'FI', ttl: 300 } }) };
    }
    return { status: 200, text: async () => JSON.stringify({ code: 0, data: { id: 'SENT1', timestamp: '2026-11-06T10:00:00+08:00' } }) };
  };

  // 缺凭据：一行都不许发出去（回落 NapCat 或"假装在线"都比这坏）。
  const off = new OfficialClient({ official: { appId: '', appSecret: '' } }, { dataDir: dir, fetchImpl });
  let emitted = 0;
  off.on('unconfigured', () => { emitted += 1; });
  off.start();
  eq(emitted, 1, '缺凭据要说"待配置"');
  eq(reqs.length, 0, '缺凭据时一个请求都不发');
  checks += 1;
  let unCode = '';
  await off.sendMsg('group', 'G1', [{ type: 'text', data: { text: 'hi' } }]).catch((e) => { unCode = e.code; });
  eq(unCode, OFFICIAL_CODE.unconfigured, '未配置时发送必须明确失败');

  const on = new OfficialClient({
    official: { appId: '10001', appSecret: 'SEC' },
    bindings: { groups: { ['G' + '0'.repeat(31)]: { localId: '123456789', name: '测试群' } }, owners: [] },
  }, { dataDir: dir, fetchImpl, base: OFFICIAL_BASE, wsUrl: 'wss://api.bot.qq.com/websocket/' });
  eq(on.configured, true, '两个凭据都有才算配好');

  // 绑定表反查：本地群号 → group_openid
  const sent = await on.sendMsg('group', '123456789', [{ type: 'text', data: { text: '在的' } }]);
  eq(sent.message_id, 'SENT1', '回执归一成 message_id（reply-track 只认这个键）');
  const body = JSON.parse(reqs[reqs.length - 1].init.body);
  eq(body.content, '在的', '正文原样');
  hit(reqs[reqs.length - 1].url.includes('api.bot.qq.com/v2/groups/'), '发群消息走群接口');
  hit(!reqs[reqs.length - 1].url.includes('NaN'), 'openid 不许被 Number() 打成 NaN');

  // 图片：先上传再发，两步都在同一条链上
  const before = reqs.length;
  await on.sendMsg('group', '123456789', [{ type: 'image', data: { file: `base64://${PNG_B64}` } }]);
  eq(reqs.length - before, 2, '发图是"上传 + 发送"两步');
  eq(JSON.parse(reqs[reqs.length - 2].init.body).file_type, 1, '上传按图片类型');
  eq(JSON.parse(reqs[reqs.length - 1].init.body).msg_type, 7, '第二条是富媒体消息');

  // 不支持的动作：必须明确失败，不许返回空数组糊过去
  for (const action of ['get_forward_msg', 'send_group_forward_msg', 'get_group_member_info', 'get_friend_list', 'set_input_status', 'get_version_info']) {
    checks += 1;
    let code = '';
    await on.call(action, {}).catch((e) => { code = e.code; });
    hit(code === OFFICIAL_CODE.unsupportedBackend || code === OFFICIAL_CODE.unsupportedForward,
      `${action} 在官方通道必须显式失败（实际 ${code || '没报错'}）`);
  }
  const status = await on.call('get_status', {});
  eq(status.good, false, '自报 good 一律不可信');
  eq(status.online, false, '没连上网关时 online 必须是 false');
  const login = await on.call('get_login_info', {});
  eq(login.nickname, '小助手', '机器人昵称来自 /users/@me');
  const list = await on.call('get_group_list', {});
  eq(list.length, 1, '群列表来自绑定表（官方没有群列表接口）');
  eq(String(list[0].group_id), '123456789', '群列表用本地群号');

  // 快照里不许出现凭据本体（/api/state 是不鉴权的只读口）
  const snapText = JSON.stringify(on.healthSnapshot());
  hit(!snapText.includes('SEC'), '健康快照里不许出现 AppSecret');
  hit(!snapText.includes('TK'), '健康快照里不许出现 access_token');
  eq(on.healthSnapshot().channel, 'official', '快照说明自己是官方通道');
  eq(on.healthSnapshot().groupsBound, 1, '快照带出绑定群数（面板那格读它）');
  hit(typeof on.healthSnapshot().passive.limits.group.maxReplies === 'number', '快照带出被动上限');

  // 入站事件在客户端里走去重 + 被动登记
  on.selfId = 'BOTID';
  const openidG = 'G' + '0'.repeat(31);
  const translated = translateInbound({
    t: 'GROUP_AT_MESSAGE_CREATE',
    d: {
      id: 'MSG-A', group_openid: openidG, timestamp: '1780000000',
      author: { member_openid: 'M' + '0'.repeat(31), username: '小明' }, content: '吃什么',
    },
  }, { selfId: 'BOTID', appId: '10001', resolveGroupId: () => '123456789' });
  eq(translated.event.group_id, '123456789', '入站按绑定表落到本地群号');
  eq(dedupeKeyOf('10001', 'MSG-A'), '10001|MSG-A', '去重键含 appId');
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── ⑫ 端到端：真 WS + 真 HTTP，只是对端在本机环回 ───────────────────────
// 这一节是整份文件存在的理由：纯函数单测**看不见接缝形状**。
// 教程里那条真机事故（把平台原始事件裸投给大脑 ⇒ 大脑不认 ⇒ 不回 ack ⇒ 无限重投）
// 就是"离线全绿、真机才炸"的形状，这里用假网关把它钉成回归。
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'official-e2e-'));
  const { startMockOfficialGateway } = await import('./mock-official-gateway.mjs');
  const mock = await startMockOfficialGateway({ heartbeatIntervalMs: 400 });
  const G = 'G'.repeat(32);
  const M = 'M'.repeat(32);
  const client = new OfficialClient(
    { official: { appId: '10001', appSecret: 'SEC-E2E' }, bindings: { groups: {} } },
    { base: mock.httpBase, wsUrl: mock.wsUrl, dataDir: dir, mergeWindowMs: 30, backoffMs: [120] },
  );
  const events = [];
  client.on('message', (e) => events.push(e));
  const ready = new Promise((resolve) => client.on('ready', resolve));
  client.start();
  await ready;

  eq(client.selfId, 'BOTOPENID', 'READY 里的 user.id 要成为 selfId（判"@ 的是不是我"靠它）');
  eq(client.connected, true, '连上网关后 connected 为真');
  const identify = mock.log.identifies[0] || {};
  eq(identify.token, 'QQBot MOCK-TOKEN', 'identify 的 token 格式必须是 QQBot <access_token>');
  eq(identify.intents, 1 << 25, '订阅位必须是 GROUP_AND_C2C_EVENT');

  // AT 与全量在合并窗口内到齐 ⇒ 只产出一条事件，@ 语义保住
  mock.socket().push('GROUP_AT_MESSAGE_CREATE', {
    id: 'E2E-1', group_openid: G, timestamp: '1780000000',
    author: { member_openid: M, username: '小明' }, content: '吃了吗',
  });
  mock.socket().push('GROUP_MESSAGE_CREATE', {
    id: 'E2E-1', group_openid: G, timestamp: '1780000000',
    author: { member_openid: M, username: '小明' }, content: '吃了吗',
  });
  eq(await until(() => events.length >= 1 && client.stats.merged === 1), true,
    '同一条消息的两个事件在合并窗口内没有合成一条');
  eq(events.length, 1, '同一条消息的两个事件必须合成一条（回两次就是刷屏）');
  eq(client.stats.merged, 1, '合并计数要看得见，不能静默');  const flat = flattenMessage(events[0].message, events[0].self_id);
  eq(flat.mentionedSelf, true, '合并后 @ 语义不许丢（丢了就变成"平时偶尔回、被 @ 反而不稳"）');
  eq(events[0].group_id, G, '未绑定的群用 openid 作群键');

  // 出站到 REST：被动凭据必须带上刚才那条消息的 id
  const sent = await client.sendMsg('group', G, [{ type: 'text', data: { text: '吃了' } }]);
  eq(sent.message_id, 'MOCK-MSG-1', '回执归一成 message_id（引用与"我发过的"都读它）');
  const sendReq = mock.log.requests.filter((r) => /\/messages$/.test(r.url)).pop();
  eq(JSON.parse(JSON.stringify(sendReq.body)).content, '吃了', '正文原样发出去');
  eq(sendReq.body.msg_id, 'E2E-1', '被动回复带上入站消息号');
  eq(sendReq.body.msg_seq, 1, '第一次回复 seq=1');
  eq(sendReq.headers.authorization, 'QQBot MOCK-TOKEN', 'REST 用 QQBot 头');
  await client.sendMsg('group', G, [{ type: 'text', data: { text: '再来一句' } }]);
  eq(mock.log.requests.filter((r) => /\/messages$/.test(r.url)).pop().body.msg_seq, 2,
    '同一轮的第二条换 seq（同 seq 重复发平台会直接拒）');

  // 重复推送（合并窗口之后再来同 id）⇒ 走去重，不再进大脑
  mock.socket().push('GROUP_AT_MESSAGE_CREATE', {
    id: 'E2E-1', group_openid: G, timestamp: '1780000000',
    author: { member_openid: M, username: '小明' }, content: '吃了吗',
  });
  eq(await until(() => client.stats.duplicates >= 1), true, '窗口后的重复推送没有被去重丢掉');
  // "不该发生的事没发生"只能等一个 SETTLE 窗口（这里 3 倍合并窗口）再数，
  // 不能只数当下 —— 但等的是判定条件，不是随手一个 sleep。
  await new Promise((r) => setTimeout(r, 3 * 30 + 40));
  eq(events.length, 1, '重复推送不得再进大脑一次');
  eq(client.stats.duplicates >= 1, true, '去重要有计数（"没回"与"没收到"得能分开）');

  // 群状态事件：官方的「接收所有消息」开关**没有查询端点**，只能等事件落下。
  // 面板那一格"仅 @ / 全量已开 / 未知"完全依赖这里，落不下来就是永远显示未知。
  // ⚠️ 必须在重连那一段之前推：`mock.socket()` 拿的是"当前还活着的那条连接"，
  //    重连之后旧连接已经从 wss.clients 里摘掉，往回推就石沉大海了。
  mock.socket().push('GROUP_MSG_RECEIVE', { group_openid: G });
  eq(await until(() => client.recvAll.get(G) === true), true,
    'GROUP_MSG_RECEIVE 没有落到 recvAll（面板那格会一直"未知"）');

  // 平台侧失败要带码回来，而不是"看起来发成功了"
  mock.reply.sendFailure = { body: { code: 40054005, message: '消息被去重' } };
  checks += 1;
  let dupCode = '';
  await client.sendMsg('group', G, [{ type: 'text', data: { text: '重试' } }]).catch((e) => { dupCode = e.code; });
  eq(dupCode, OFFICIAL_CODE.duplicate, '发送失败必须抛出带归一码的错误');

  // 图片：先上传再发，两步都在同一条链上
  const before = mock.log.requests.length;
  await client.sendMsg('group', G, [{ type: 'image', data: { file: `base64://${PNG_B64}` } }]);
  const added = mock.log.requests.slice(before);
  eq(added.some((r) => /\/files$/.test(r.url)), true, '发图第一步是上传');
  eq(added.some((r) => /\/messages$/.test(r.url) && r.body.msg_type === 7), true, '发图第二步是富媒体消息');

  // 网关要求重连 ⇒ 客户端自己回来，并优先用 resume 续传
  mock.requestReconnect();
  eq(await until(() => mock.log.sockets >= 2), true,
    `op 7 之后客户端没有连回第二条（sockets=${mock.log.sockets}）`);
  eq(await until(() => mock.log.resumes.length >= 1), true,
    '有 session_id 时优先 resume（漏掉的事件由平台补发）');
  eq(await until(() => client.gateway.snapshot().connected === true), true, '重连后 connected 要回到真');

  // 凭据外送检查：AppSecret 只许出现在取 token 那一条请求里
  const leaked = mock.log.requests.filter((r) => r.url !== TOKEN_PATH
    && JSON.stringify(r.body || '').includes('SEC-E2E'));
  eq(leaked.length, 0, 'AppSecret 只许出现在取 token 的请求里');

  // ── ⑬（本块内）面板投影喂**真快照** ────────────────────────────────────
  // 这一小节存在的理由是一条实测崩溃：机器人写进 effective.json 的 `recvAll` 是**对象**，
  // 而面板那侧照旧形状写了 `Object.fromEntries(...)` ⇒ 只要官方通道真在跑，
  // 采一次状态就 TypeError 整颗抛。两份形状只有把两边喂进同一个函数才看得见。
  const snap = client.healthSnapshot();
  const view = officialPanelView({
    mode: 'official',
    health: snap,
    effChannel: 'official',
    cfgChannel: {
      official: { appId: '10001', appSecret: 'SEC-E2E' },
      bindings: { groups: { [G]: { localId: '1000000001', name: '读书分享会' } } },
    },
    ownerIds: [M],
  });
  eq(view.mode, 'official', '投影带着模式走（页面按它决定整块显不显示）');
  eq(view.label, CHANNEL_LABELS.official, '中文标签取自 channel-mode 那一份，不在面板里另写');
  eq(view.configured, true, '凭据齐了就要报"已配置"');
  eq(view.official.recvAll[G], true, 'recvAll 必须原样转述对象（重拼成数组就是那颗 TypeError）');
  eq(Array.isArray(view.official.pendingGroups), true, '待绑定群下发的是数组（页面 .map 它）');
  eq(view.official.groupsBound, 1, '已绑定群数取配置那一份，不取快照');
  eq(view.official.ownersBound, 1, '主人数取 owner.qq 里非纯数字那几条');
  eq(view.official.hasSecret, true, '只说"有没有配过"');
  eq(JSON.stringify(view).includes('SEC-E2E'), false, '★ 投影整份序列化后仍不得出现 AppSecret');
  eq(view.restartRequired, false, '运行侧与配置一致时不许报"要重启"');
  eq(officialPanelView({
    mode: 'official', health: snap, effChannel: 'official',
    cfgChannel: { official: { appId: '99999', appSecret: 'SEC-E2E' }, bindings: { groups: {} } },
    ownerIds: [],
  }).restartRequired, true, '换了 AppID 但机器人还在用旧的那份 ⇒ 必须提示重启');
  eq(officialPanelView({
    mode: 'official', health: { ...snap, configured: false, appId: '10001' },
    effChannel: 'official',
    cfgChannel: { official: { appId: '10001', appSecret: 'SEC-E2E' }, bindings: { groups: {} } },
    ownerIds: [],
  }).restartRequired, true, '凭据补上而运行侧还是"没配齐" ⇒ 必须提示重启');
  eq(officialPanelView({
    mode: 'official', health: null, effChannel: '',
    cfgChannel: { official: { appId: '', appSecret: '' }, bindings: { groups: {} } },
    ownerIds: [],
  }).restartRequired, false, '全新安装还没填凭据时报的该是"还缺 AppID"，不是"要重启"');
  eq(officialPanelView({
    mode: 'official', health: snap, effChannel: 'napcat',
    cfgChannel: { official: { appId: '10001', appSecret: 'SEC-E2E' }, bindings: { groups: {} } },
    ownerIds: [],
  }).restartRequired, true, '运行侧还在 NapCat ⇒ 必须提示重启');
  eq(officialPanelView({
    mode: 'napcat', health: null, effChannel: 'official',
    cfgChannel: { bindings: { groups: {} } }, ownerIds: ['12345'],
  }).official, null, 'NapCat 模式下不发官方那一份');

  client.stop();
  await mock.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── ⑭ 存活阶梯：面板那一格的颜色与文案只有一个来源 ────────────────────────
// 官方通道**没有本地端口可探**（它是出站到 api.bot.qq.com 的客户端），
// 所以不能套 `src/onebot-liveness.js` 那条以"3000/3001 通不通"为第一层的阶梯 ——
// 套上去要么把连得好好的通道判成 down，要么为了让它绿而把探活"当成通"（那是写坏判据）。
// 这里的每一档都对应面板上一个具体的说法，判错一档就说错一句话。
{
  const v = (health, options = {}) => officialVerdictOf({ health, now: options.now, staleMs: options.staleMs });
  eq(v(null).code, 'no-snapshot', '机器人还没写出快照 ⇒ 该说"没在跑"，不是"连不上"');
  eq(v({ configured: false }).code, 'unconfigured', '缺凭据是一等状态（新装第一屏就停在这一格）');
  eq(v({ configured: true, gateway: { terminalCode: 4914, terminalReason: '被平台下架' } }).code, 'terminal',
    '下架/封禁必须排在"连接中"前面 —— 重试没有意义，白烧一次鉴权');
  eq(v({ configured: true, gateway: { terminalCode: 4914 } }).detail.includes('网关终止码'), true,
    '终止那一格要带上平台给的原因（没给就用终止码兜底，不许空着）');
  eq(v({ configured: true, lastErrorCode: 'official_auth', connected: false }).code, 'auth-failed',
    '鉴权失败排在连接中前面（表现是反复连上又被踢，不是"在连"）');
  eq(v({ configured: true, connected: false, lastDropReason: '心跳连续 90 秒没有 ACK' }).detail,
    '心跳连续 90 秒没有 ACK', 'connecting 要把机器人自己记的原因交出去，不能只剩一句"未连接"');
  eq(v({ configured: true, connected: true, botOffline: true }).code, 'account-offline',
    '连接在但平台侧账号不在线，是独立一档');
  const staleCase = { configured: true, connected: true, lastFrameAt: 1_000, connectedAt: 1_000, heartbeatIntervalMs: 45_000 };
  // 阈值取 `max(120s, 心跳间隔 × 3)` = 这一例的 135 秒：太短会把"这半小时没人说话"
  // 误判成停摆（官方通道空闲时真的可以几分钟没有帧）。
  eq(v(staleCase, { now: 101_000 }).code, 'online', '阈值内不算停摆（这一例是 135 秒）');
  eq(v(staleCase, { now: 201_000 }).code, 'stalled', '事件流停摆要单独成档：端口没意义，帧不来就是哑了');
  eq(v(staleCase, { now: 201_000 }).staleMs >= 120_000, true, '停摆阈值下限 120 秒（心跳间隔的三倍也不许把它调小）');
  eq(v(staleCase, { now: 201_000, staleMs: 999_999 }).code, 'online',
    '外部给的阈值必须真的被用上（否则注入只是装饰）');
  eq(v({ configured: true, connected: true, lastFrameAt: 0, connectedAt: 0 }).code, 'online',
    '没有任何时刻信息时不许误判停摆');
}

// ──  输入基数自证 ───────────────────────────────────────────────────────
if (checks < 80) problems.push(`只跑了 ${checks} 条判据（下限 80）—— 有整段没被执行，"零失败"是假的`);

if (problems.length) {
  for (const p of problems) console.log(`✗ ${p}`);
  console.log(`\nOFFICIAL_CHECKS=${checks} FAILED=${problems.length}`);
  process.exit(1);
}
console.log('✓ 官方机器人通道（2026-11-06）：通道默认只作用新装 · 地址钉死防凭据外送 · HTTP 200 也算失败 · '
  + 'token 单飞且不落快照 · @ 走可信提及 · 正文为空不丢附件 · 出站 @ 降级 / 转发明确失败 · '
  + '被动凭据逐会话限 5/4 次与 5min/60min · 去重跨重启 · 未配置零请求 · 不支持动作全部明确失败');
console.log(`\nOFFICIAL_CHECKS=${checks}`);
