/**
 * 官方通道身份绑定的**唯一判据**（2026-11-06 · 零依赖叶子）。
 *
 * 为什么单独一份：这张表同时被三处读 —— 机器人出站要把内部群号换回 group_openid、
 * 机器人入站要把 openid 换成本地群号、面板写侧要在绑定**之前**拒绝冲突。
 * 判据写在任何一处，另外两处就会各抄一份；而这里的错不是"少一个字段"，
 * 是**两个官方群共用同一份记忆与人格**（串群）或**陌生人撞进权限链**。
 *
 * ⚠️ 本文件不许 import 任何东西（连 logger 都不行）：面板侧要过 §82 的 lib→src 准入，
 *    判据是"传递闭包不触达 llm/brain/onebot/index/config/logger"。
 *    所以这里只返回**结论**，"要不要说给用户听"由调用方决定。
 */

/** openid 形状：官方文档里是 32 位十六进制，但**不把它写死**（平台改格式不通知人）。 */
export const OPENID_SHAPE = /^[A-Za-z0-9_-]{8,128}$/;
/** 群号形状沿用本仓既有约定（`config.js` 的"群号写纯数字"与 `napcat-login.js` 的 5–12 位）。 */
export const GROUP_ID_SHAPE = /^\d{5,12}$/;

/** 这个内部 id 是不是"没绑定过的 openid"（决定出站要不要反查绑定表）。 */
function looksLikeOpenid(id) {
  return OPENID_SHAPE.test(String(id ?? '').trim());
}

/** 入站：openid → 本地群号；没绑定就原样返回 openid（**不派生假号**）。 */
export function localIdOfGroup(groups, openid) {
  const bound = groups && typeof groups === 'object' ? groups[String(openid ?? '').trim()] : null;
  const localId = String(bound?.localId ?? '').trim();
  return localId || String(openid ?? '').trim();
}

/**
 * 出站：内部群号 → group_openid。
 * 认不出来返回空串 —— 调用方必须明确失败，不能"随便挑一个群发出去"。
 */
export function openidOfGroup(groups, id) {
  const key = String(id ?? '').trim();
  if (!key) return '';
  const table = groups && typeof groups === 'object' ? groups : {};
  for (const [openid, value] of Object.entries(table)) {
    if (String(value?.localId ?? '').trim() === key) return openid;
  }
  if (table[key]) return key;
  return looksLikeOpenid(key) ? key : '';
}

/**
 * 绑定前的双向冲突检查。
 * @returns {null|{reason:string, detail:string}} null = 可以绑
 */
export function bindingConflict(groups, openid, groupId) {
  const table = groups && typeof groups === 'object' ? groups : {};
  for (const [other, value] of Object.entries(table)) {
    if (other === openid) continue;
    if (String(value?.localId ?? '').trim() === groupId) {
      return {
        reason: 'group-id-taken',
        detail: `群号 ${groupId} 已经绑在另一个 openid（${other.slice(0, 8)}…）上 —— `
          + '两个官方群共用一个群号，会共用同一份记忆与人格（串群）',
      };
    }
  }
  return null;
}

/**
 * 生成绑定后的新表（不改入参 —— 纯函数，便于断言与回滚）。
 * 同一个 openid 改绑到别的群号是允许的（用户填错了要能改），
 * 但调用方必须把"换掉了什么"说出来，不能静默替换。
 */
export function planGroupBind({ groups, openid, groupId, name = '' }) {
  const next = { ...(groups && typeof groups === 'object' ? groups : {}) };
  next[String(openid).trim()] = { localId: String(groupId).trim(), name: String(name).slice(0, 64) };
  return { groups: next };
}
