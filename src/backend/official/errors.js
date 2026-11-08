/**
 * 官方通道回包的**失败归一**（零依赖纯函数）。
 *
 * 为什么必须单独一份：官方有两处形状会把失败洗成成功 ——
 *   ① 取 token 的接口**业务失败也回 HTTP 200**，只看状态码会把"凭据不对"读成成功；
 *   ② 发送类接口把原因放在 `code` / `message` 里，`data` 可能是半个对象。
 * 这与本仓 `src/backend/normalize.js` 对 OneBot「retcode=200 但业务失败」的处理是同一条纪律：
 * **传输成功与业务成功是两个正交字段**，调用方只认归一后的 `code`，不比中文文案。
 */

/** 我们对外暴露的错误码（调用方按码分支，不按文案分支）。 */
export const OFFICIAL_CODE = Object.freeze({
  ok: 'ok',
  transport: 'official_transport',
  timeout: 'official_timeout',
  auth: 'official_auth',
  rateLimited: 'official_rate_limited',
  passiveExhausted: 'passive_exhausted',
  duplicate: 'official_duplicate',
  urlNotAllowed: 'official_url_not_allowed',
  tooLong: 'official_too_long',
  notMember: 'official_not_member',
  muted: 'official_muted',
  botOffline: 'official_bot_offline',
  quota: 'official_quota',
  noPermission: 'official_no_interface_permission',
  business: 'official_business',
  unsupportedBackend: 'unsupported_backend',
  unsupportedForward: 'unsupported_forward',
  unsupportedSegment: 'unsupported_segment',
  unconfigured: 'channel_unconfigured',
  unknownGroup: 'official_unknown_group',
});

/**
 * 官方业务码 → 我们的码。
 * 只收录**已核对到原文**的码；认不出的落 `business`，不猜成"成功"也不猜成"限流"。
 */
const CODE_MAP = new Map([
  [40034128, OFFICIAL_CODE.passiveExhausted], // 被动回复时间或次数超限
  [40054005, OFFICIAL_CODE.duplicate],        // 消息被去重（msg_id + msg_seq 撞了）
  [40054010, OFFICIAL_CODE.urlNotAllowed],    // 不允许发送 URL
  [40054007, OFFICIAL_CODE.tooLong],          // 消息长度超限
  [40054003, OFFICIAL_CODE.notMember],        // 机器人不是群成员
  [40034101, OFFICIAL_CODE.notMember],        // 机器人非群成员
  [40054002, OFFICIAL_CODE.muted],            // 机器人被禁言
  [40054016, OFFICIAL_CODE.botOffline],       // 机器人已下线
  [304018, OFFICIAL_CODE.botOffline],         // SESSION_NOT_EXIST：没连上 gateway
  [40034100, OFFICIAL_CODE.quota],            // 主动消息超过频控
  [40034105, OFFICIAL_CODE.quota],            // 主动消息无权限
  [40034102, OFFICIAL_CODE.quota],            // 实测出现过、官方码表里没有的同义失败
  [11253, OFFICIAL_CODE.noPermission],        // 接口仅白名单机器人可用
  [1100100, OFFICIAL_CODE.rateLimited],       // 安全打击：消息被限频
  [1100102, OFFICIAL_CODE.rateLimited],       // 安全打击：暂未获得新功能体验资格
]);

/** 鉴权类 HTTP 状态（token 失效走这一支，刷新一次再试）。 */
const AUTH_STATUS = new Set([401, 403]);

/**
 * @param {{httpStatus?:number, body?:unknown, rawText?:string, transportError?:string}} input
 * @returns {{transportOk:boolean, businessOk:boolean, code:string, officialCode:number|null,
 *            message:string, retryable:boolean}}
 */
export function classifyOfficialReply({ httpStatus, body, rawText, transportError } = {}) {
  if (transportError) {
    // 传输层失败 = **结果不明**：请求可能已经到达平台。发送类动作绝不自动重试，
    // 重试的代价是群里出现两条一样的话（本项目最忌的"重复发送"）。
    return {
      transportOk: false, businessOk: false, code: OFFICIAL_CODE.transport,
      officialCode: null, message: String(transportError), retryable: false,
    };
  }
  if (!Number.isFinite(httpStatus)) {
    return {
      transportOk: false, businessOk: false, code: OFFICIAL_CODE.transport,
      officialCode: null, message: '没有拿到 HTTP 状态码', retryable: false,
    };
  }
  const parsed = body && typeof body === 'object' && !Array.isArray(body)
    ? body : parseMaybeJson(rawText);
  const officialCode = numberOrNull(parsed?.code ?? parsed?.retcode);
  const message = truncateText(String(parsed?.message ?? parsed?.msg ?? parsed?.error ?? ''));

  if (AUTH_STATUS.has(httpStatus) || officialCode === 11244 || officialCode === 11235) {
    return { transportOk: true, businessOk: false, code: OFFICIAL_CODE.auth, officialCode, message, retryable: true };
  }
  if (httpStatus === 429) {
    return { transportOk: true, businessOk: false, code: OFFICIAL_CODE.rateLimited, officialCode, message, retryable: true };
  }
  if (httpStatus >= 500) {
    // 5xx：平台侧没答上来，**同样按结果不明处理**（发送不自动重试）。
    return { transportOk: false, businessOk: false, code: OFFICIAL_CODE.transport, officialCode, message: message || `HTTP ${httpStatus}`, retryable: false };
  }
  if (parsed === null) {
    return { transportOk: true, businessOk: false, code: OFFICIAL_CODE.business, officialCode, message: '回包不是 JSON', retryable: false };
  }
  // 业务码优先于 HTTP 状态：取 token 那条接口失败也是 200。
  if (officialCode !== null && officialCode !== 0) {
    const code = CODE_MAP.get(officialCode) || OFFICIAL_CODE.business;
    return {
      transportOk: true, businessOk: false, code, officialCode, message,
      retryable: code === OFFICIAL_CODE.duplicate || code === OFFICIAL_CODE.rateLimited,
    };
  }
  if (httpStatus >= 400) {
    return { transportOk: true, businessOk: false, code: OFFICIAL_CODE.business, officialCode, message: message || `HTTP ${httpStatus}`, retryable: false };
  }
  return { transportOk: true, businessOk: true, code: OFFICIAL_CODE.ok, officialCode: 0, message, retryable: false };
}

/** 造一个带归一码的 Error（调用方 catch 后只看 `err.code` / `err.officialCode`）。 */
export function officialError(code, message, extra = {}) {
  const err = new Error(message || code);
  err.code = code;
  err.officialCode = extra.officialCode ?? null;
  if (extra.retryable !== undefined) err.retryable = extra.retryable === true;
  if (extra.traceId) err.traceId = String(extra.traceId);
  return err;
}

function parseMaybeJson(text) {
  const s = String(text ?? '').trim();
  if (!s) return null;
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch { return null; }
}

function numberOrNull(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function truncateText(s) {
  return s.length > 200 ? `${s.slice(0, 200)}…` : s;
}
