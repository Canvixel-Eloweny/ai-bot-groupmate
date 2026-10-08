/**
 * 合并转发展开（D23-2 · Wave 5）—— **零依赖叶子**：判据全在这里，IO 全在调用方。
 * ══════════════════════════════════════════════════════════════════════════
 *  它要解决的事
 * ══════════════════════════════════════════════════════════════════════════
 * 别人把一段聊天记录**合并转发**给它所在群，然后 @ 它说「你看看这个」——
 * 在今天之前，`flattenMessage` 对 forward/node 段只产出两个字面量：`[合并转发]`。
 * 也就是说**它压根看不见里面写了什么**，只能回一句"我看不见转发的内容"。
 * 真机实证（2026-10-01 18:41，D23-1 探针的第一条样本）：用户 @ 它发了一条合并转发，
 * 它的回复是「啊这……我看不见转发的具体内容呀」。
 *
 * 所以这一片的产出是**文本**：把转发里的 N 条消息渲染成"谁说了什么"，
 * 补进那条消息的正文里。**没有别的副作用**。
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  四条硬约定
 * ══════════════════════════════════════════════════════════════════════════
 * ① **段 → 文本的唯一实现在 `onebot.flattenMessage`** —— 这里通过 `renderNode`
 *    入参注入渲染器，**绝不自己再写一份**（本项目头号禁忌：同一份语义两份拷贝）。
 *    顺带白拿两条：嵌套转发天然是深度 1 封顶（内层也只是占位符）、@ 段的显示名
 *    处理与主链路逐字一致。
 * ② **有界**：节点数、总字符、单条字符三个上限都在本文件里，且只有这一份。
 *    超限**如实说还有几条没展开**（宁可少说，不可假装全说了）。
 * ③ **纯函数**：不碰 IO、不读时钟、不改入参。那一次 `get_forward_msg` 由调用方发。
 * ④ **认不出就是认不出**：返回形状不对（没有节点数组）→ 空数组，调用方据此退回占位符。
 *    绝不编造内容（"失忆是诚实的，假记忆不是"，与 `working-memory.js` / `unread.js` 同一条纪律）。
 *
 * ⚠️ **参数用 `message_id`，不是段里的那个 id** —— 见 `forwardResIdOf` 的注释。
 */

/**
 * 配置默认值（`custom.forwardExpand`）。
 *
 * `enabled` 默认 **true**（与 `browseLock` / `sleep` 的"默认 false"方向相反），理由：
 *   · 关掉它 = 它继续看不见任何转发内容，而**这正是本步要修的那个缺陷**；
 *   · 打开它只影响"带合并转发的消息"这一小类，且**不改变触发判据**
 *     （展开内容只进 `text`，不进 `bareText` —— 见 `onebot.flattenMessage` 的 forward 分支）；
 *   · 与最高准则一致：「一切的准则是让她们更拟人」。
 * 不想要就 `config.json` 里写 `custom.forwardExpand.enabled = false` 并重启机器人。
 */
export const FORWARD_DEFAULTS = Object.freeze({ enabled: true });

/** 最多展开几条（**经验值**）。超出部分如实报"还有 N 条未展开"。 */
export const FORWARD_MAX_NODES = 20;
/** 展开文本的总字符上限（**经验值**，防一条转发把提示词撑爆）。 */
export const FORWARD_MAX_CHARS = 1500;
/** 单个节点正文的字符上限（**经验值**）。 */
export const FORWARD_NODE_CHARS = 120;

/**
 * 配置面归一化。**只有真的是 `false` 才算关** —— 与 `browseLock` / `readSleep`
 * 同一条约定（字符串 `"false"` 之类一律当开，不许让一个读不懂的值静默关掉能力）。
 *
 * @param {unknown} raw `config.json` 的 `custom.forwardExpand`
 * @returns {{enabled:boolean}}
 */
export function readForward(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  return { enabled: r.enabled !== false };
}

/**
 * 这条消息里有没有该展开的段（`forward` 与 `node` 都算）。
 *
 * @param {unknown} segments OneBot 消息段数组
 * @returns {Array<object>}
 */
export function forwardSegmentsOf(segments) {
  if (!Array.isArray(segments)) return [];
  return segments.filter((s) => s?.type === 'forward' || s?.type === 'node');
}

/**
 * 段里那个 id（转发卡片上的 `res_id`）——**只作兜底**。
 *
 * ⚠️ 参考实现的真机实测（2026-09-05，SnowLuma/NapCat）：`get_forward_msg` **只认
 *    `message_id`**；`res_id` 会过期，报 `payload is empty`。所以调用方**先**用
 *    `message_id`，失败了才拿这个 id 再试一次，两个都不行就退回占位符。
 *
 * @param {unknown} segments
 * @returns {string} 没有则空串
 */
export function forwardResIdOf(segments) {
  for (const s of forwardSegmentsOf(segments)) {
    if (s.type !== 'forward') continue;
    const id = String(s?.data?.id ?? '').trim();
    if (id) return id;
  }
  return '';
}

/**
 * 从 `get_forward_msg` 的返回里取节点数组。
 *
 * 两种键名都认（`messages` / `message`）：协议端实现不统一，认不出就返回空数组
 * —— 调用方据此退回占位符，**不猜、不造**。
 *
 * @param {unknown} data `call('get_forward_msg')` 的返回值（已由 `OneBotClient` 剥掉外层）
 * @returns {Array<object>}
 */
export function forwardNodesOf(data) {
  const d = data && typeof data === 'object' ? data : {};
  const list = Array.isArray(d.messages) ? d.messages : (Array.isArray(d.message) ? d.message : []);
  return list.filter((n) => n && typeof n === 'object');
}

/**
 * 把一个节点拍平成**可以喂给 `flattenMessage` 的段数组**。
 *
 * 三种形态：
 *   · `node.message` 是数组 → 直接用；其中嵌套的 forward/node 段**清空 data**
 *     （渲染出来就是 `[合并转发]` 占位符 —— 深度 1 封顶，也不会为它再调一次协议端）；
 *   · `node.content`（有些人只给字符串）→ 当成一个 text 段，并**剥掉 `[CQ:xxx]`**
 *     （字符串形态一般是 CQ 码原文，原样喂进去等于把协议方言倒进提示词）；
 *   · 都没有 → 空数组（渲染出空串，节点被跳过）。
 *
 * @param {object} node
 * @returns {Array<object>}
 */
export function nodeSegmentsOf(node) {
  const raw = node?.message ?? node?.content ?? '';
  if (Array.isArray(raw)) {
    return raw.map((s) => ((s?.type === 'forward' || s?.type === 'node') ? { type: 'forward', data: {} } : s));
  }
  return [{ type: 'text', data: { text: String(raw).replace(/\[CQ:[^\]]*\]/g, '') } }];
}

/** 昵称：群名片 → 昵称 → QQ 号 → `?`（拿不到名字也不编一个） */
function nameOf(node) {
  const s = node?.sender && typeof node.sender === 'object' ? node.sender : {};
  const name = String(s.card || s.nickname || node?.user_id || node?.sender_id || '').trim();
  return name || '?';
}

/**
 * 把节点数组渲染成一段文本。
 *
 * 形状（与参考实现同款，便于两边的模型都读得惯）：
 * ```
 * [合并转发 共3条]
 * 小王: 今晚吃什么
 * 小李: 随便
 * 小王: [图片]
 * …（还有 7 条未展开）
 * ```
 *
 * @param {Array<object>} nodes
 * @param {{renderNode?:(node:object)=>string, maxNodes?:number, maxChars?:number, nodeChars?:number}} [opts]
 *   `renderNode` 是**注入的段渲染器**（调用方传 `flattenMessage(...).text`）——
 *   本叶子不认识 OneBot 段，也不许自己实现一份（见文件头 ①）。
 * @returns {string} 永远返回非空串（一条都没有时是 `[合并转发 共0条]`）
 */
export function renderForwardText(nodes, opts = {}) {
  const list = Array.isArray(nodes) ? nodes : [];
  const renderNode = typeof opts.renderNode === 'function' ? opts.renderNode : null;
  const maxNodes = Number(opts.maxNodes) > 0 ? Number(opts.maxNodes) : FORWARD_MAX_NODES;
  const maxChars = Number(opts.maxChars) > 0 ? Number(opts.maxChars) : FORWARD_MAX_CHARS;
  const nodeChars = Number(opts.nodeChars) > 0 ? Number(opts.nodeChars) : FORWARD_NODE_CHARS;

  const head = `[合并转发 共${list.length}条]`;
  const lines = [];
  let truncated = 0;
  let used = 0;

  for (let i = 0; i < list.length; i += 1) {
    if (lines.length >= maxNodes) { truncated = list.length - i; break; }
    let body = '';
    try {
      body = String(renderNode ? renderNode(list[i]) : '').replace(/\s+/g, ' ').trim();
    } catch {
      body = ''; // 单个节点渲染失败 → 跳过它，别把整条转发一起拖下水
    }
    body = body.slice(0, nodeChars);
    if (!body) continue;
    const line = `${nameOf(list[i])}: ${body}`;
    // 上限判在**加进来之前**：先加后判会让最后一行永远越界一截（参考实现就是这么写的）。
    if (lines.length && used + line.length + 1 > maxChars) { truncated = list.length - i; break; }
    lines.push(line);
    used += line.length + 1;
  }

  if (!lines.length) return head;
  const tail = truncated > 0 ? `\n…（还有 ${truncated} 条未展开）` : '';
  return `${head}\n${lines.join('\n')}${tail}`;
}
