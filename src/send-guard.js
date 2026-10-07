/**
 * ══════════════════════════════════════════════════════════════════════
 *  发送闸（send_message 的 `before-tool` 钩子点）
 *  第 46 轮 B12e-2 · 执行层第二步
 * ══════════════════════════════════════════════════════════════════════
 *
 *  ────────────────────────────────────────────────────────────────────
 *  ⚠️ 为什么需要这个模块：`复读拦截` 的钩子挂在 `send_message` 上，而
 *     本项目**没有** `send_message` 这个模型可调用的工具
 *  ────────────────────────────────────────────────────────────────────
 *  参考实现（QQ-Agent v0.31 · MIT）里"发言"本身就是一次工具调用：
 *  提示词原话是「你的文本输出只是思考过程，【不会发送到 QQ】。要发言必须调用
 *  send_message」，扩展包的 `before-tool` 因此**天然**落在"即将发言"那一刻。
 *
 *  本项目的发言路径完全不同（也是它优化过三个批次的路径）：
 *  模型输出文本 → `brain.parseReply()` 拆段 → 出口闸门 → 逐条发出。
 *
 *  两条路要不要合并，是一件事关"每天在群里怎么说话"的大决策，
 *  不该在"启用一个去重插件"这个批次里被顺手做掉。所以本模块采取的是一条
 *  **中间路线**：
 *
 *  > 在"即将发出这一条"的时刻，**合成一次 `send_message` 的工具调用**，
 *  > 把它喂给 `before-tool` 钩子。扩展包一行都不用改 ——
 *  > 它看到的东西（`toolName` / `argsRaw.messages` / `session.chatKey` /
 *  > `session.sent`）与在参考实现里看到的**逐字段相同**。
 *
 *  → 于是"说话方式"一个字都没变，而去重能力真的生效了。
 *  → 偏差已记录（计划附 T.4）：**在参考实现里 send_message 是真工具，
 *    在这里是一次合成调用**。将来若要把发言改成工具调用（那会动提示词主路径
 *    与整个出口闸门的位置），本模块正好是那个切换点。
 *
 *  ⚠️ **零副作用 + 可短路**：没有钩子时 `check()` 直接返回"放行"，
 *     连 payload 都不构造。所以"一个钩子都没挂"时，
 *     这段代码在主路径上是**零行为改变**（有断言钉着）。
 */

/** 合成的工具名。扩展包（如 `复读拦截`）按 `/send_message/i` 匹配它 —— **别改名**。 */
export const SEND_TOOL_NAME = 'send_message';

/**
 * 造一次"合成工具调用"的载荷。**纯函数**。
 *
 * 字段与参考实现逐一对齐（拿真实扩展包的取用方式核过）：
 *   `toolName`        —— 扩展包用它判断"是不是在发消息"
 *   `argsRaw`         —— **字符串**（工具调用的 arguments 就是 JSON 串）；
 *                        `复读拦截` 会 `JSON.parse` 它并读 `messages`
 *   `session.chatKey` —— 去重窗口按会话分开
 *   `session.sent`    —— 这一轮**已经发出去**的段（`{type:'text'}`），
 *                        扩展包用它做"单轮最多几条"的兜底
 *
 * @param {{chunks:string[], chatKey:string, sentTexts?:string[]}} a
 */
export function buildSendCall({ chunks, chatKey, sentTexts = [] }) {
  const messages = (Array.isArray(chunks) ? chunks : []).map(String);
  return {
    toolName: SEND_TOOL_NAME,
    argsRaw: JSON.stringify({ messages }),
    session: {
      chatKey: String(chatKey ?? ''),
      // 形状必须是 `[{type:'text'}]`：扩展包按 `s.type === 'text'` 数。
      // 传一个纯数字（"已发几条"）会在扩展包里被算成 0 —— 静默失效。
      sent: (Array.isArray(sentTexts) ? sentTexts : []).map((t) => ({ type: 'text', text: String(t) })),
    },
  };
}

/**
 * 发一条前的判据。
 *
 * @param {{bus:{size:Function, emit:Function}, log?:{warn?:Function}}} deps
 */
export function createSendGuard({ bus, log } = {}) {
  return {
    /** 有没有钩子挂在发送前。**没有就直接短路**，主路径一行都不多跑。 */
    active() {
      return typeof bus?.size === 'function' && bus.size('before-tool') > 0;
    },

    /**
     * 这一条能不能发。
     * @returns {Promise<{vetoed:null|{reason:string,owner:string}, checked:boolean}>}
     */
    async check({ chunks, chatKey, sentTexts = [] } = {}) {
      if (!this.active()) return { vetoed: null, checked: false };
      const r = await bus.emit('before-tool', buildSendCall({ chunks, chatKey, sentTexts }));
      return { vetoed: r?.vetoed ?? null, checked: true, errors: r?.errors ?? [] };
    },
  };
}
