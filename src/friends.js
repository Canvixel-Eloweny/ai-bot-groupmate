/**
 * 「好友私聊按群友接待」的判据叶子（零依赖、无时钟、无网络）。
 *
 * 为什么需要这个文件：
 *   0.1.2 的私聊闸只认 `allow.private`（「同意私聊的 QQ 号」），而那格里默认只自动补了主人。
 *   于是**机器人加过的其它好友私聊它，一条都不回、也不留任何记录** —— 用户看到的是
 *   "它是不是坏了"。好友表本来就在协议端（`get_friend_list`），判据就一个成员关系，
 *   没必要让用户把好友号一个个抄进白名单。
 *
 * 边界（这三条都是故意的，不是漏写）：
 *   ① **不等同于"谁都能私聊"**：陌生人不在好友表里，照样被白名单闸挡掉；
 *   ② 好友也不等于管理员：主人那几条特权（叫醒、免打扰例外、夜间产出的收件人）
 *      判据仍是 `isOwner`，这里一个字都不碰；
 *   ③ 拉不到好友表时**不放行**（`ids` 为空集 ⇒ 全部失败关闭）。宁可少回一句，
 *      也不要把"拉取失败"读成"谁都能进来"。
 */

/** 好友表多久重拉一次（毫秒）。加好友后最多等这么久它就认得。 */
export const FRIENDS_TTL_MS = 10 * 60 * 1000;

/** 白名单挡下一条私聊时，最多隔多久重拉一次好友表（防止每条陌生消息都打一次协议端）。 */
export const FRIENDS_RECHECK_MS = 60 * 1000;

/**
 * 把协议端的 `get_friend_list` 结果归一成 QQ 号集合。
 *
 * 认三种形状（协议端实现各不相同，不能只认一种）：
 *   · OneBot 标准：`[{ user_id, nickname, remark }…]`
 *   · 已剥过一层的 `data`：同样的数组
 *   · 裸号数组：`[10001, '10002']`
 * 认不出的条目**跳过**（不猜、不塞空串）。
 */
export function friendIdsOf(payload) {
  const rows = Array.isArray(payload) ? payload : Array.isArray(payload?.data) ? payload.data : [];
  const ids = new Set();
  for (const row of rows) {
    const raw = row !== null && typeof row === 'object' ? (row.user_id ?? row.uin) : row;
    const qq = String(raw ?? '').trim();
    if (qq) ids.add(qq);
  }
  return ids;
}

/** 这个 QQ 号在不在好友表里（表缺失/形状不对 ⇒ false，失败关闭）。 */
export function isFriend(ids, qq) {
  if (!ids || typeof ids.has !== 'function') return false;
  const key = String(qq ?? '').trim();
  return key ? ids.has(key) : false;
}
