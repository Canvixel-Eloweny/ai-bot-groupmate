/**
 * 真正调用协议端前的**最后一道同步许可复核**（2026-11-05 · 外部评估 P2）。
 *
 * 为什么单独成叶子：主回复、垫话、主动、工具发图、跨群 send_to、主人通知
 * 最终都汇到 `bot.sendMsg`。在每个调用点各写一遍判据，迟早漏一条；
 * 放在唯一的发送边界上，再由这里做成纯函数，才能被单测钉住。
 *
 * 判据与 `brain.gateReason` 同源（调用方把 `gateReason` 注入进来）。
 * `ownerBypass` 只允许 `sayToOwner` 显式传 true：运营者通知不该被群白名单误杀；
 * 主回复即使对象是主人也不豁免 —— 撤权就是撤权。
 *
 * @param {'group'|'private'} scene
 * @param {string|number} id 群号 / QQ 号
 * @param {{ownerBypass?:boolean, gateReason:(evt:object)=>string}} opts
 * @returns {string} '' = 允许；非空 = 拒绝原因
 */
export function sendPermissionReason(scene, id, { ownerBypass = false, gateReason } = {}) {
  const chatId = String(id ?? '');
  if (!chatId) return '会话 id 为空';
  if (ownerBypass === true && scene === 'private') return '';
  const evt = scene === 'group'
    ? { message_type: 'group', group_id: chatId, user_id: '' }
    : { message_type: 'private', user_id: chatId };
  return typeof gateReason === 'function' ? gateReason(evt) : '';
}

/**
 * 把任意 `send` 包成"发送前同步复核"的发送口。`bot.sendMsg` 的唯一包装用它。
 *
 * @param {{send:Function, gateReason:Function, recordSent?:Function}} deps
 * @returns {(scene:string, id:string|number, segments:any[], opts?:{ownerBypass?:boolean})=>Promise<any>}
 */
export function createGuardedSender({ send, gateReason, recordSent = null } = {}) {
  if (typeof send !== 'function') throw new TypeError('createGuardedSender 需要 send');
  return async function guardedSend(scene, id, segments, opts = {}) {
    const why = sendPermissionReason(scene, id, {
      ownerBypass: opts.ownerBypass === true,
      gateReason,
    });
    if (why) {
      const err = new Error(`发送许可已变（${why}）`);
      err.code = 'PERMISSION_BLOCKED';
      err.reason = why;
      throw err;
    }
    const result = await send(scene, id, segments);
    if (typeof recordSent === 'function') recordSent({ n: 1, chatKey: `${scene}:${id}` });
    return result;
  };
}
