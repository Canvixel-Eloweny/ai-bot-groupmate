/**
 * QQ 官方机器人通道的**固定事实**（2026-11-06，逐页核对官方文档）。
 *
 * ⚠️ 这里的东西**一律不许从配置读**：
 *   `api.bot.qq.com` 一旦变成用户可填的 `apiBase`，AppSecret 就会被发往任意主机 ——
 *   那不是"灵活性"，那是把凭据外送做成一个功能。
 *   测试要换地址，走构造函数注入（`createOfficialRest({ base })`），
 *   而且注入口自己会拒掉非官方、非环回的主机（见 `assertOfficialBase`）。
 */

/** 官方 OpenAPI 主机与根地址（20260810 起所有接口域名统一为 api.bot.qq.com）。 */
const OFFICIAL_HOST = 'api.bot.qq.com';
export const OFFICIAL_BASE = `https://${OFFICIAL_HOST}`;

/** 事件网关（WebSocket）。 */
export const OFFICIAL_WS_URL = `wss://${OFFICIAL_HOST}/websocket/`;

/** 取 access_token：body 用 `clientSecret`（控制台里那个叫 AppSecret）。 */
export const TOKEN_PATH = '/app/getAppAccessToken';

/** access_token 生命周期 7200 秒；提前 120 秒换，避免"刚好卡在过期边界上发不出去"。 */
export const TOKEN_REFRESH_SKEW_MS = 120_000;
export const TOKEN_FALLBACK_TTL_MS = 60 * 60 * 1000;

/** 群 + 私聊事件意图位（GROUP_AND_C2C_EVENT）。 */
export const INTENT_GROUP_AND_C2C = 1 << 25;

/** 网关 opcode。 */
export const OP = Object.freeze({
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  PRESENCE: 3,
  IDLE: 4,
  RESUME: 6,
  RECONNECT: 7,
  INVALID_SESSION: 9,
  HELLO: 10,
  ACK: 11,
});

/** 事件名（只列本通道真正消费的）。 */
export const EVENT = Object.freeze({
  READY: 'READY',
  RESUMED: 'RESUMED',
  GROUP_AT: 'GROUP_AT_MESSAGE_CREATE',
  GROUP_ALL: 'GROUP_MESSAGE_CREATE',
  C2C: 'C2C_MESSAGE_CREATE',
  GROUP_ADD_ROBOT: 'GROUP_ADD_ROBOT',
  GROUP_DEL_ROBOT: 'GROUP_DEL_ROBOT',
  GROUP_MSG_RECEIVE: 'GROUP_MSG_RECEIVE',
  GROUP_MSG_REJECT: 'GROUP_MSG_REJECT',
});

/** 网关终止码：机器人下架 / 封禁。重试没有意义，且会白烧一次鉴权。 */
export const TERMINAL_WS_CODES = Object.freeze([4914, 4915]);

/** 消息类型。 */
export const MSG_TYPE = Object.freeze({ text: 0, markdown: 2, inputNotify: 6, media: 7 });

/** 富媒体文件类型（群/单聊上传接口**不互通**）。 */
export const FILE_TYPE = Object.freeze({ image: 1, video: 2, voice: 3, file: 4 });

/**
 * 被动回复窗口与次数（官方原文：群聊 5 分钟 5 次、单聊 60 分钟 4 次）。
 *
 * ⚠️ 这是**平台侧硬闸**，不是我们的调参项：超了就是 `40034128`，
 *   而"本地没有计数器"不等于"平台不限"。分块发送必须在这里封顶，
 *   不能等第 6 条发失败了再靠错误码回推 —— 那时话已经说到一半了。
 */
export const PASSIVE_LIMIT = Object.freeze({
  group: { windowMs: 5 * 60_000, maxReplies: 5 },
  private: { windowMs: 60 * 60_000, maxReplies: 4 },
});

/** 单条文本的保守上限（官方有 `40054007 消息长度超限`，但没公布数字；2000 是保守值）。 */
export const MAX_TEXT_CHARS = 2000;

/** 二进制直传上限（官方：>5MB 要走分片；分片上传本批不做，明确拒绝而不是悄悄截断）。 */
export const DIRECT_UPLOAD_MAX_BYTES = 5 * 1024 * 1024;

/** 重连退避：官方网关对频繁 identify 有限流，起步比 NapCat 那条慢一档。 */
export const RECONNECT_BACKOFF_MS = Object.freeze([1000, 2000, 5000, 10000, 30000, 60000]);

/** 取 token / 业务调用的默认超时。 */
export const REQUEST_TIMEOUT_MS = 10_000;
export const UPLOAD_TIMEOUT_MS = 30_000;

/** 入站去重与合并（去重表本体见 `seen-store.js`，容量在那里定）。 */

/**
 * AT 与全量事件可能是**同一条消息**的两次推送。
 * 缓冲这一小段时间，把两条合成一条再入大脑 —— 否则要么回两次，要么丢掉 @ 语义。
 * 0.8 秒 < 主链路的连发合并窗口（1.2 秒），不会把聚批节奏拖慢一档。
 */
export const MERGE_WINDOW_MS = 800;

/** 路径构造：openid 一律 encode，别让它带着奇怪字符拼进 URL。 */
export function groupMessagesPath(groupOpenid) {
  return `/v2/groups/${encodeURIComponent(String(groupOpenid).trim())}/messages`;
}
export function groupFilesPath(groupOpenid) {
  return `/v2/groups/${encodeURIComponent(String(groupOpenid).trim())}/files`;
}
export function groupInfoPath(groupOpenid) {
  return `/v2/groups/${encodeURIComponent(String(groupOpenid).trim())}/info`;
}
export function userMessagesPath(userOpenid) {
  return `/v2/users/${encodeURIComponent(String(userOpenid).trim())}/messages`;
}
export const BOT_INFO_PATH = '/users/@me';

/**
 * 允许的请求根地址：**官方主机或环回**（环回只服务本地假网关测试）。
 * 其余一律抛 —— 这条判据存在的唯一理由就是"AppSecret 不许被发往第三台机器"。
 */
export function assertOfficialBase(base) {
  let url;
  try { url = new URL(String(base)); } catch { throw new Error(`官方通道地址不合法: ${base}`); }
  const host = url.hostname.toLowerCase();
  const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`官方通道只走 http(s)，收到 ${url.protocol}`);
  }
  if (host !== OFFICIAL_HOST && !loopback) {
    throw new Error(`官方通道的主机必须是 ${OFFICIAL_HOST}（当前 ${host}）—— AppSecret 不许发往别的机器`);
  }
  return url.origin;
}

/**
 * 事件网关地址同样要判主机（2026-11-06）：identify 帧里带的是 `QQBot <access_token>`，
 * 与 REST 用的是同一份凭据 —— 只钉住 REST 而让 wsUrl 可填，等于留了第二条外送口。
 */
export function assertOfficialWsUrl(url) {
  let parsed;
  try { parsed = new URL(String(url)); } catch { throw new Error(`官方通道网关地址不合法: ${url}`); }
  if (parsed.protocol !== 'wss:' && parsed.protocol !== 'ws:') {
    throw new Error(`官方通道网关只走 ws(s)，收到 ${parsed.protocol}`);
  }
  const host = parsed.hostname.toLowerCase();
  const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';
  if (host !== OFFICIAL_HOST && !loopback) {
    throw new Error(`官方通道网关必须是 ${OFFICIAL_HOST}（当前 ${host}）—— identify 帧带着 access_token，不许发往别的机器`);
  }
  return parsed.href;
}
