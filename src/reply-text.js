/**
 * ══════════════════════════════════════════════════════════════════════
 *  回复文本工具（H-10 第 22 轮 · 从 `src/brain.js` 整块搬出）
 * ══════════════════════════════════════════════════════════════════════
 *  为什么单独立一个模块：
 *    · `brain.js` 是**巨型文件**（唯一入口表里最后几个之一）。这里装的全是
 *      **纯函数 / 纯常量** —— 不碰 IO、不读时钟（要时间的用 `now` 入参）、
 *      不 import 任何模块，所以搬出来之后它仍是"零依赖叶子"。
 *    · 它们与 `Brain` 类的**生命周期无关**：不需要 `this.cfg`、不需要会话对象。
 *      混在类文件里，读者要读完 200 行才会发现"这些跟类没关系"。
 *
 *  ⚠️ **搬家纪律（第 18/19 轮为 `panel/server.js` 立的那套，这里照做）**：
 *    ① 实现只在新家一份；`brain.js` 只 `import` 再**原样转出**（外部引用不变：
 *       `src/index.js` / `test/smoke.js` / `scripts/dryrun.js` 都从 brain 取）。
 *    ② 搬完必须回头查旧**变异锚点**（`test/mutations/*.mjs` 里写着 `file:` 的）。
 *    ③ 判据不许跟着体搬 —— `check-wb` 的取源**改指这里**，不是复制一份。
 */

/**
 * 把「谁说了什么」渲染成提示词里的一行（**唯一实现**）。
 *
 * ⚠️ 空文本**不许**留下悬空的分隔符。实测（第 56 轮 F1-3，真机 `panel/local-trace.jsonl`）：
 * 纯图 / 纯表情消息的 `parsed.text` 是空串，于是渲染出 `"路人甲: "` ——
 * （⚠️ 上面那个说话人原是**真机上的真实昵称**，第 22 轮发布前换成占位；别再写回具体名字。）
 * **行尾带一个空格**，6 条带 prompt 的记录里命中 2 条。
 * 行尾空白是提示词前缀的隐形杀手（本项目已记过：一个尾随换行曾让 ~3100 token 的
 * 稳定前缀命中率掉到 0），而它**一个字节的信息都不承载**。
 *
 * 空文本时只留说话人：语义上等于"这人发了点什么，但没有文字"，比丢掉整行诚实
 * （丢掉会把"有人来过"这件事一起抹掉，而背景段的用途正是让模型知道"刚才谁在说话"）。
 *
 * 顺带 `trim()` 一次：这条行是我们自己拼的，两端的空白没有任何来源需要它。
 *
 * @param {string} speaker 展示名
 * @param {string} text 消息正文（可能为空）
 * @returns {string}
 */
export function renderSpeakerLine(speaker, text) {
  const t = String(text ?? '').trim();
  return t ? `${speaker}: ${t}` : String(speaker ?? '');
}

/**
 * 提示词里**行尾带空白**的行数。上面那条约束的探针（smoke 用它当判据）。
 * 只负责发现，不负责修 —— 修在渲染处，唯一实现。
 *
 * @param {string} text
 * @returns {number}
 */
export function trailingBlankLines(text) {
  return String(text ?? '')
    .split('\n')
    .filter((l) => /[ \t]+$/.test(l)).length;
}

/**
 * 发送时刻复核的判据（第 56 轮 F1-2 · E22）。**纯函数**，两个入参都由调用方给。
 *
 * ── 它补的是哪个窗口 ────────────────────────────────────────────────
 * 现在的链路是：收到消息 → 判许可（`isAllowed`）→ 调模型（**秒级**）→ 逐条发，
 * 条与条之间还有 1 秒起的节奏延迟。而面板支持热改白名单 ——
 * 于是"判定通过"与"真的发出去"之间有一个**秒级到十几秒**的窗口，
 * 在这段窗口里把某个群移出白名单，**在途的旧回复照样会发**。
 *
 * 出站闸门管的是**内容**（凭据不外泄），管不到**许可与时序**。这一条补的是后者。
 *
 * ── 两个条件 ────────────────────────────────────────────────────────
 *   ① `gateReason` 非空 —— 许可现值已经不允许这条会话（黑白名单被改过，或配置被回滚）；
 *   ② `sessionLive === false` —— 内存里那个 session 对象已经不是当前的了
 *      （存档恢复 / 清理把它换掉了）。这时候再发，等于替一个**已经作废的上下文**说话。
 *
 * ⚠️ **只复核许可与时序，不复核内容**。内容归出口闸门（`scanEgress`），
 *    两件事混在一起会让"为什么没发出去"变得查不清（truncated 原因会被互相盖住）。
 *
 * @param {string} gateReason `brain.gateReason(evt)` 的返回值（'' 表示现在仍允许）
 * @param {boolean} sessionLive 会话对象是否仍是 store 里当前那一个
 * @returns {string} '' 表示可以发；否则是**丢弃原因**（直接进日志与 trace）
 */
export function lateSendReason(gateReason, sessionLive) {
  if (gateReason) return `发送前复核不通过：${gateReason}`;
  if (!sessionLive) return '发送前复核不通过：会话已作废（存档恢复或清理）';
  return '';
}

/**
 * 快到入睡点多久之内算"开始犯困"（**经验值**：一小时，够它开始敷衍两句了）。
 * ⚠️ **不导出**：只有一个消费者（本文件里的 `restLineOf`）。导出它会被 §56
 *    的「导出全仓无人引用」当场拦下 —— 那正是那条判据要防的形态。
 */
const DROWSY_BEFORE_BED_MS = 60 * 60 * 1000;
/** 作息状态行（三条，都是**状态**不是指令）。⚠️ 改文案要同步 smoke T329 的上限断言。 */
export const REST_LINE_WOKE = '你刚醒，还没完全开机 —— 说话可以慢半拍。';
export const REST_LINE_EMERGENCY = '你被人连着喊醒的，还有点懵 —— 别装作精神很好。';
export const REST_LINE_DROWSY = '快到你睡觉的点了，你开始犯困。';
/** 补看轮那句（只有 `isCatchUp` 的轮次才有）。 */
export const CATCHUP_LINE = '你刚醒，翻到了睡着时错过的消息 —— 挑一两条自然地接上，别一股脑全回，也别提自己睡着了。';

/**
 * D31-3 · 作息状态行（**提示词里那句"它现在什么状态"**）。**纯函数**（`now` 入参）。
 *
 * 为什么值得单独一句：睡 / 醒不是"要不要回话"的开关（那是门禁的事），
 * 而是**它此刻是什么样的人** —— 刚被叫醒的人说话是慢的，快到点睡觉的人开始犯困。
 * 门禁只管回不回，这句管的是回的时候像不像。
 *
 * 四条取向：
 *   · **总闸关着 / 没有快照 → 返回空串**（提示词一个字都不多 —— 默认配置逐字不变）；
 *   · 睡着 → 不进提示词（睡着的轮根本走不到这里，门禁已经挡掉了）；
 *   · 被**紧急**叫醒 ≠ 自然醒："还有点懵"和"刚睡醒"是两种口气；
 *   · 快到入睡时刻（≤ `DROWSY_BEFORE_BED_MS`）→ "开始犯困"。
 *
 * ⚠️ 它是**状态**不是指令：只说它现在怎样，不说它该怎么答 ——
 *    后者是人格文件的地盘，挤进来两者会互相打架。
 *
 * @param {object|null} snap `sleepSnap`（唯一判定点重算出来的那份）
 * @param {{now?:number}} [o]
 * @returns {string} 空串 = 这一行不出现
 */
export function restLineOf(snap, { now = 0 } = {}) {
  if (!snap || snap.enabled !== true) return '';
  if (snap.asleep) return '';
  // 紧急态（被主人连发叫起来的临时清醒）—— 它不是"睡醒了"，是被整醒的。
  if (snap.mode === 'emergency') return REST_LINE_EMERGENCY;
  // 本夜正式起床（含刚被叫醒）：wokeKind === 'owner'
  if (snap.wakeKind === 'owner') return REST_LINE_WOKE;
  const untilBed = Number(snap.bedAt) - Number(now);
  if (Number.isFinite(untilBed) && untilBed > 0 && untilBed <= DROWSY_BEFORE_BED_MS) return REST_LINE_DROWSY;
  return '';
}

/**
 * 「只有图 / 只有表情 / 只有语音」这类**没有一个字**的消息（B8 · S-BARE）。
 *
 * 判据要看 flattenMessage 的实际产物：图片段会把正文补成 `[图片]`、表情补成 `[表情]`，
 * 所以"纯表情"的正文**不是空串**、只是占位符而已 —— 只判空串会漏掉它。
 *
 * 反过来也要小心：`这是啥[图片]` 这种**带正文**的消息不该被当成纯图 ——
 * 用户是拿图在提问，不接就是装死。所以占位符必须**占满整条**才算。
 */
const BARE_ONLY_RE = /^(?:\[(?:图片|表情|语音|视频|文件)\]\s*)+$/;

export function isBareMedia(parsed) {
  const text = String(parsed?.text ?? '').trim();
  if (BARE_ONLY_RE.test(text)) return true;
  // 正文为空但有图片：理论上 flattenMessage 一定会补 `[图片]`，这里是第二道兜底 ——
  // 万一将来那个"补占位符"的行为被改掉，这道闸门不该跟着一起失效。
  return !text && Array.isArray(parsed?.images) && parsed.images.length > 0;
}

export function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 去掉一段文字里的链接。
 * 覆盖 http(s):// 和裸域名（`xxx.com/yyy`）两种写法 —— 只挡 http 的话，
 * "看 www 点 xx 点 com" 和 "abc.cn/1" 照样能过，等于没挡。
 */
export function stripLinks(s) {
  return String(s)
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/\b[\w-]+(?:\.[\w-]+)+\.(?:com|cn|net|org|io|me|tv|xyz|top|cc)\b(?:\/\S*)?/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * 剥掉思考过程。本机模型开了思考之后，输出里会带 <think>……</think>，
 * 直接发出去群里就会看到一大段"自言自语"。
 * 两种情况都要处理：完整的块，以及输出被 max_tokens 截断留下的半个块。
 */
export function stripThink(s) {
  let out = s
    .replace(/<think(ing)?>[\s\S]*?<\/think(ing)?>/gi, ' ')
    .replace(/<think(ing)?>[\s\S]*$/gi, ' ') // 没闭合的
    .replace(/<\/?think(ing)?>/gi, ' '); // 零散残留标签
  return out.replace(/[ \t]{2,}/g, ' ').trim();
}

/** 超长单段按标点硬切，避免被协议端截断 */
export function hardWrap(text, max) {
  if (text.length <= max) return text;
  const parts = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf('。', max);
    if (cut < max * 0.5) cut = rest.lastIndexOf('，', max);
    if (cut < max * 0.5) cut = rest.lastIndexOf(' ', max);
    if (cut < max * 0.5) cut = max;
    parts.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1).trim();
  }
  if (rest) parts.push(rest);
  return parts.join(' ');
}
