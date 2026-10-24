/**
 * L3 聚合适配层 · 归一化（纯函数，零 IO）。
 * ══════════════════════════════════════════════════════════════════════════
 *  这一层解决三件"字段名一样、语义不一样"的事
 * ══════════════════════════════════════════════════════════════════════════
 *  ① **失败语义**：NapCat / Lagrange 都可能"业务失败仍回 retcode 200"，
 *     `status === 'ok' || retcode === 0` 这一条判据会把失败当成功。
 *     ⇒ `classifyOneBotReply` 把"传输成功"与"业务成功"拆成两个正交字段。
 *  ② **合并转发入参**：NapCat 是 `message_id || id`、LLBot 两个键都按 resId 字符串解读、
 *     SnowLuma 的 id 优先。⇒ `forwardAttemptsFor` 按后端表决定顺序，调用方不再自己拍。
 *  ③ **能力清单**：LLBot 的 `can_send_*` 恒 true、NapCat/Lagrange 的 `get_status.good`
 *     写死 true。⇒ `selfReportTrustOf` 一律不信任自报；`capabilitiesOf` 把没取证的动作
 *     标成 `unknown`，不替对方"应该支持"。
 *
 *  ⚠️ 本文件不读时钟、不碰网络、不读配置 —— 测试可以直接喂四家的真实回包形状。
 */

import {
  PRODUCTION_ACTIONS, MEDIA_ACTIONS, UNTRUSTED_CAN_SEND, backendOf, backendLabel,
} from './registry.js';

/** 归一后的错误码（调用方只认这些，不比中文文案）。 */
const REPLY_CODE = Object.freeze({
  ok: 'ok',
  business_failed: 'business_failed',
  malformed: 'malformed',
  forward_payload_empty: 'forward_payload_empty',
  forward_resid_invalid: 'forward_resid_invalid',
  token_invalid: 'token_invalid',
  already_logged_in: 'already_logged_in',
});

/**
 * 把一条 OneBot API 回包拆成「传输 / 业务」两半。
 *
 * @param {unknown} payload 已 JSON.parse 的回包
 * @returns {{transportOk:boolean,businessOk:boolean,code:string,data:unknown,
 *            message:string,retcode:number|null,status:string}}
 */
export function classifyOneBotReply(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return {
      transportOk: false,
      businessOk: false,
      code: REPLY_CODE.malformed,
      data: null,
      message: '回包不是对象',
      retcode: null,
      status: '',
    };
  }
  const status = String(payload.status ?? '').toLowerCase();
  const retRaw = payload.retcode;
  const retcode = Number(retRaw);
  const hasRet = retRaw !== undefined && retRaw !== null && retRaw !== '' && Number.isFinite(retcode);
  const message = String(payload.message ?? payload.wording ?? '');
  const data = payload.data;
  const dataFailed = !!data && typeof data === 'object'
    && String(data.status ?? '').toLowerCase() === 'failed';

  // 失败优先：Lagrange 的 `retcode 200 + status failed` 就是靠 statusFailed 抓到的。
  // 已知失败文案也算失败 —— 有的实现把 status 写成 ok、只在 message 里说原因。
  const statusFailed = status === 'failed' || /^failed$/i.test(message.trim());
  const retFailed = hasRet && retcode !== 0;
  const msgFailed = /payload is empty|resid无效|resid.*invalid|res_id.*invalid/i.test(message);
  const businessFailed = statusFailed || retFailed || dataFailed || msgFailed;

  const statusOk = status === 'ok' || status === 'async';
  const businessOk = !businessFailed && (statusOk || (hasRet && retcode === 0));

  return {
    transportOk: true,
    businessOk,
    code: businessOk ? REPLY_CODE.ok : classifyFailureCode({ message, retcode, status }),
    // 业务失败时**不把 data 交出去** —— 半份 data 会被上层当成成功内容。
    data: businessOk ? (data ?? null) : null,
    message,
    retcode: hasRet ? retcode : null,
    status,
  };
}

function classifyFailureCode({ message, retcode, status }) {
  if (/payload is empty/i.test(message)) return REPLY_CODE.forward_payload_empty;
  if (/resid无效|resid.*invalid|res_id.*invalid/i.test(message)) return REPLY_CODE.forward_resid_invalid;
  if (/token is invalid|unauthorized/i.test(message)) return REPLY_CODE.token_invalid;
  if (/logined|already logged/i.test(message)) return REPLY_CODE.already_logged_in;
  if (status === 'failed' || (Number.isFinite(retcode) && retcode !== 0)) return REPLY_CODE.business_failed;
  return REPLY_CODE.malformed;
}

/**
 * message_id 的形状。SnowLuma 是 int32 哈希、**可为负**；任何"当无符号数用"的代码
 * 都会在它身上歪。这个函数只描述事实，不替调用方决定怎么用。
 */
export function messageIdShapeOf(id) {
  if (typeof id === 'number' && Number.isFinite(id)) return id < 0 ? 'int32-negative' : 'int32';
  const s = String(id ?? '').trim();
  if (!s) return 'empty';
  if (/^-?\d+$/.test(s)) return Number(s) < 0 ? 'int32-negative' : 'int32';
  return 'string';
}

/**
 * `message_id` 这个键该喂什么类型。
 * LLBot 把它也按 resId 字符串解读（且明写"不要把整数 message_id 用在这里"），
 * 其余家按整数回查 —— 数字化的字符串也还原成数字，免得对方把它当 resId 下载。
 */
function normalizeMessageId(backendId, id) {
  const b = backendOf(backendId);
  if (b.messageId === 'resid-string') return String(id);
  const n = Number(id);
  return String(id ?? '').trim() !== '' && Number.isFinite(n) ? n : id;
}

/**
 * 合并转发的参数尝试顺序（**唯一决定点**）。
 *
 * 返回值是 `[{via, params}]`，按后端表里的 `forwardOrder` 排列：
 *   · NapCat / SnowLuma / Lagrange：`message_id`（历史回查）→ `id`（resId 兜底）
 *   · LLBot：`id`（它的正路）→ `message_id`（它按 resId 解读，通常空转）
 * 调用方只负责"逐条试、全空就占位"，**不许再自己决定先试哪个**。
 *
 * @param {string} backendId
 * @param {{messageId?:unknown,resId?:unknown}} ids
 * @returns {Array<{via:'message_id'|'res_id',params:object}>}
 */
export function forwardAttemptsFor(backendId, { messageId, resId } = {}) {
  const b = backendOf(backendId);
  const hasMid = messageId !== undefined && messageId !== null && String(messageId).trim() !== '';
  const hasRid = resId !== undefined && resId !== null && String(resId).trim() !== '';
  const out = [];
  for (const key of b.forwardOrder) {
    if (key === 'message_id' && hasMid) {
      out.push({ via: 'message_id', params: { message_id: normalizeMessageId(b.id, messageId) } });
    } else if (key === 'id' && hasRid) {
      out.push({ via: 'res_id', params: { id: residOf(resId) } });
    }
  }
  return out;
}

function residOf(resId) {
  // resId 是协议端自己给的字符串标识；数字形态原样保留（有的家就吃数字）。
  return typeof resId === 'number' && Number.isFinite(resId) ? resId : String(resId);
}

/**
 * 某家对某动作的支持面。只认三种值：
 *   `yes` = 有实现且已取证；`unknown` = 未取证/不保证；`no` = 明确没有。
 * ⚠️ 生产动作没在表里写差异的默认 `yes`（四家都对这 8 个有实现，取证见蓝图 §1）；
 *    但 `get_version_info` / `get_status` 这类有差异的必须在表里显式写。
 */
function actionSupportOf(backendId, action) {
  const b = backendOf(backendId);
  if (b.supports[action] !== undefined) return b.supports[action];
  if (PRODUCTION_ACTIONS.includes(action)) return 'yes';
  return 'unknown';
}

/** 给面板/测试看的能力清单（不含任何"健康"结论）。 */
export function capabilitiesOf(backendId) {
  const b = backendOf(backendId);
  const actions = {};
  for (const a of [...PRODUCTION_ACTIONS, ...MEDIA_ACTIONS]) actions[a] = actionSupportOf(b.id, a);
  return {
    backend: b.id,
    label: backendLabel(b.id),
    actions,
    // 上游自报的 can_send_* 一律不可信（LLBot 恒 true）；值只有 registry 一份。
    canSend: { ...UNTRUSTED_CAN_SEND },
    forwardOrder: [...b.forwardOrder],
    messageId: b.messageId,
  };
}

/**
 * 自报值可不可信。**一律 false** 是有意的：
 *   · NapCat `GetStatus.ts:29-30` 把 good 写死 true；Lagrange 的 online/good 同样是硬编码；
 *   · LLBot 的 can_send_image / can_send_record 恒 true。
 * 返回值带 `reason`，面板可以原样转述，不用自己再写一份解释。
 */
export function selfReportTrustOf(backendId) {
  const b = backendOf(backendId);
  return {
    backend: b.id,
    online: false,
    good: false,
    canSendImage: false,
    canSendRecord: false,
    reason: '上游自报值不可信：NapCat/Lagrange 的 good 写死 true，LLBot 的 can_send_* 恒 true',
  };
}
