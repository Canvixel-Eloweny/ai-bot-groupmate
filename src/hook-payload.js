/**
 * ══════════════════════════════════════════════════════════════════════
 *  钩子载荷的**唯一投影点**（2026-10-23 · 回迁维护者手改补丁）
 * ══════════════════════════════════════════════════════════════════════
 *  为什么单开一个文件，而不是在 `index.js` 里就地拼对象：
 *
 *    · 载荷形状是**对外契约**（扩展包按字段名读），必须能被测试直接喂；
 *    · 宿主主链路里 `evt` / `parsed` 是局部变量，起第二个真入口去测代价很高，
 *      而"字段少了"的表现是**静默降级**（插件读 `p.senderId` 拿到 undefined，
 *      不报错、只是分支不走）—— 这类缺陷只能靠纯函数 + 行为断言抓住；
 *    · 同一份投影被三个钩子点复用（`after-incoming-message` / `before-context` /
 *      `before-llm-messages`），各拼一份必然漂。
 *
 *  ⚠️ **零依赖叶子**：不 import 任何模块。`evt` / `parsed` 由调用方给，
 *     本文件只做"取字段 + 归一化类型"，不碰 IO、不读配置、不判业务。
 *
 *  ⚠️ 字段口径与维护者在 0.1.4 上手动打的补丁**逐字一致**：
 *     `media` 是**张数（数字）**，不是数组；`self` 恒 `false`（入站消息）。
 *     这两条若改成"更合理"的形状，已装的 4 个插件（affinity-v2 / mood-index /
 *     persona-schedule / token-guard）会读不到值 —— 它们是按补丁口径写的。
 */

/** 入站图片张数。`parsed.images` 可能是数组 / undefined / 混入空值。 */
function mediaCountOf(parsed) {
  return Array.isArray(parsed?.images) ? parsed.images.filter(Boolean).length : 0;
}

/** 时间戳：调用方给就用，给坏值就退回当前时刻（绝不把 NaN 写进载荷）。 */
function stampOf(now) {
  const n = Number(now);
  return Number.isFinite(n) ? n : Date.now();
}

/**
 * `after-incoming-message` 的载荷。
 *
 * 触发语义（由调用方保证）：**白名单放行 + 非拍一拍**，不要求"一定会回"。
 * 因此睡眠 / 峰谷闸拦下的消息也会触发 —— 插件要记账的正是"群里说过什么"，
 * 而不是"机器人回了什么"。
 *
 * @param {{chatKey?:string, scene?:string, evt?:object, parsed?:object,
 *          sender?:string, now?:number}} p
 * @returns {{chatKey:string, scene:string, senderId:string, senderName:string,
 *            text:string, messageId:string, mentionedSelf:boolean, media:number,
 *            timestamp:number, self:boolean}}
 */
export function incomingMessagePayload({ chatKey, scene, evt, parsed, sender, now } = {}) {
  return {
    chatKey: String(chatKey ?? ''),
    scene: String(scene ?? ''),
    senderId: String(evt?.user_id ?? ''),
    senderName: String(sender ?? ''),
    text: String(parsed?.text ?? ''),
    messageId: String(evt?.message_id ?? ''),
    mentionedSelf: Boolean(parsed?.mentionedSelf),
    media: mediaCountOf(parsed),
    timestamp: stampOf(now),
    self: false,
  };
}

/**
 * `before-context` 的载荷：保留原有 `triggerEntries[{text, atMe}]`，
 * 并补上按会话 / 按发送者记账需要的字段（纯新增，老插件读旧字段照常工作）。
 */
export function contextPayload({ chatKey, evt, parsed, sender, now } = {}) {
  return {
    chatKey: String(chatKey ?? ''),
    triggerEntries: [{
      text: String(parsed?.text ?? ''),
      atMe: Boolean(parsed?.mentionedSelf),
      senderId: String(evt?.user_id ?? ''),
      senderName: String(sender ?? ''),
      messageId: String(evt?.message_id ?? ''),
      mentionedSelf: Boolean(parsed?.mentionedSelf),
      media: mediaCountOf(parsed),
      timestamp: stampOf(now),
      self: false,
    }],
  };
}

/**
 * `before-llm-messages` 的载荷：`messages` **原引用**（钩子要能原地改它，
 * T124 盯着这条），外加 `chatKey`（插件按会话隔离状态要用）。
 */
export function llmMessagesPayload({ messages, chatKey } = {}) {
  return { messages, chatKey: String(chatKey ?? '') };
}
