/**
 * 被动回复凭据账本（2026-11-06 · 零依赖纯函数）。
 *
 * 官方口径：群聊「收到消息后 5 分钟内、同一条消息最多回复 5 次」，单聊 60 分钟 / 4 次。
 * 回复要带 `msg_id` + `msg_seq`，而**相同 msg_id + msg_seq 重复发送会失败**。
 *
 * 为什么按 `scene + chatId` 各存一份，而不是一个全局槽：
 *   全局槽会让 A 群的回复拿着 B 群的凭据发出去 —— 平台不一定报错，
 *   但"回没回到原话上"这件事就再也没人知道了。教程里明写过这一条。
 *
 * ⚠️ 分配即消耗：`next()` 一返回就 +1，即使后面那次发送失败也不回退。
 *   回退会让重试用同一个 seq 再发一次，而那正好撞上平台的去重失败。
 */

import { PASSIVE_LIMIT } from './constants.js';

export function createPassiveLedger({ now = () => Date.now(), limits = PASSIVE_LIMIT } = {}) {
  /** @type {Map<string,{msgId:string,receivedAt:number,seq:number}>} */
  const slots = new Map();
  const stats = { allocated: 0, exhausted: 0, expired: 0 };

  function keyOf(scene, chatId) {
    return `${scene === 'group' ? 'group' : 'private'}:${String(chatId ?? '').trim()}`;
  }

  /** 入站一条消息 ⇒ 这个会话的被动窗口重新起算（新的 msg_id，seq 归零）。 */
  function noteInbound({ scene, chatId, msgId, receivedAt }) {
    const id = String(msgId ?? '').trim();
    if (!id) return false;
    slots.set(keyOf(scene, chatId), {
      msgId: id,
      receivedAt: Number(receivedAt) || now(),
      seq: 0,
    });
    return true;
  }

  /**
   * 取下一次被动回复的凭据。
   * @returns {{msg_id:string,msg_seq:number}|null} null = 只能走主动消息（或干脆别发）
   */
  function next({ scene, chatId }) {
    const limit = (scene === 'group' ? limits.group : limits.private) || limits.group;
    const slot = slots.get(keyOf(scene, chatId));
    if (!slot) return null;
    if (now() - slot.receivedAt > limit.windowMs) {
      slots.delete(keyOf(scene, chatId));
      stats.expired += 1;
      return null;
    }
    if (slot.seq >= limit.maxReplies) {
      stats.exhausted += 1;
      return null;
    }
    slot.seq += 1;
    stats.allocated += 1;
    return { msg_id: slot.msgId, msg_seq: slot.seq };
  }

  /** 还剩几次可用（面板与日志用，不参与判定）。 */
  function remaining({ scene, chatId }) {
    const limit = (scene === 'group' ? limits.group : limits.private) || limits.group;
    const slot = slots.get(keyOf(scene, chatId));
    if (!slot) return 0;
    if (now() - slot.receivedAt > limit.windowMs) return 0;
    return Math.max(0, limit.maxReplies - slot.seq);
  }

  function snapshot() {
    return {
      chats: slots.size,
      allocated: stats.allocated,
      exhausted: stats.exhausted,
      expired: stats.expired,
      limits: {
        group: { ...limits.group },
        private: { ...limits.private },
      },
    };
  }

  return { noteInbound, next, remaining, snapshot };
}
