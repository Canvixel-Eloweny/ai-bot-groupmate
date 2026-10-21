/**
 * 夜间产出：让「定时消息」除了发一句写死的文本，还能发**让模型现写的一份东西**
 * （当天摘要 / 本周周报）。
 *
 * 为什么挂在定时消息上而不是新开一条管线：0.1.2 已经有 `custom.trigger.scheduled`
 * 这一套完整的东西（到期时刻 + 30 分钟重试窗 + 节假日/频次判定 + 去重状态落盘），
 * 再长一条"夜间调度"就是第二份口径 —— 迟早出现"定时消息补发了、夜间没补"这种账对不上。
 * 于是这里只做**两件纯事**：把一条 scheduled 条目认成"要生成"、把提示词拼出来。
 * 什么时候跑、怎么去重、发给谁，全在 `src/index.js` 里复用既有那套。
 *
 * ⚠️ 目标只有两种：
 *   · `owner` —— 私聊发给主人。**不受睡眠/免打扰约束**：这是给运营者的一份产出，
 *     不是往群里开口说话（0.1.1 的夜岗就是"一个字都不往群里发"）。
 *   · `group` —— 发到群里，照旧受睡眠与免打扰管：睡着时群里就是要安静。
 */

/** 拼进提示词的群聊记录上限（字符）。够写一份摘要，又不至于把上下文烧穿。 */
export const NIGHTLY_MAX_CHARS = 4000;

/** 一份产出最多多少 token。摘要/周报不需要思维链，也不需要长篇。 */
export const NIGHTLY_MAX_TOKENS = 700;

/**
 * 这条定时消息要不要"生成"。
 *
 * 判据只看 `prompt` 有没有内容：`text` 是写死的原文，`prompt` 是给模型的活。
 * 两条都填时**以 prompt 为准** —— 用户既然写了要做的事，再发一句旧文案只会更奇怪。
 */
export function isNightly(entry) {
  return !!(entry && typeof entry.prompt === 'string' && entry.prompt.trim());
}

/** 投递目标。认不出的值回落 `group`（写错字段的后果应该是"按老样子发群里"，而不是静默丢件）。 */
export function nightlyTargetOf(entry) {
  return entry && entry.target === 'owner' ? 'owner' : 'group';
}

/**
 * 把群聊记录整理成提示词能吃的样子。
 *
 * 只做"压平换行 / 丢掉空行 / 留最后 N 行 / 超长截尾"这些确定的事 ——
 * 不做"挑重要的"：那属于模型的活，这里越智能，出问题时越说不清是哪一步歪的。
 */
export function transcriptOf(lines, { maxLines = 80, maxChars = NIGHTLY_MAX_CHARS } = {}) {
  const kept = (Array.isArray(lines) ? lines : [])
    .map((s) => String(s ?? '').replace(/\s+/g, ' ').trim())
    .filter((s) => s.length > 3);
  const tail = kept.slice(-Math.max(1, maxLines)).join('\n');
  if (!Number.isFinite(maxChars) || maxChars <= 0) return '';
  return tail.length > maxChars ? tail.slice(-maxChars) : tail;
}

/**
 * 一份产出的提示词。
 *
 * 交付纪律（与主链路的说话规则同向）：纯文本、不 @ 人、不写 Markdown 标题、
 * 不复述"我正在整理"这类工作汇报 —— 夜里发出去的东西应该是**能直接读的成品**。
 */
export function nightlyMessages({ name = '机器人', prompt = '', transcript = '' } = {}) {
  const ask = String(prompt || '').trim();
  const body = String(transcript || '').trim();
  return [
    {
      role: 'system',
      content:
        `你是 QQ 群里的「${name}」。现在是夜里，主人要一份整理好的东西，`
        + '你写给他看，不是写给群里看。要求：纯文本，不要 Markdown 标题和列表符号；'
        + '不要 @ 任何人；不要写"我这就整理""以下是"这类开场；'
        + '只写整理出来的内容本身，有把握的才写，看不清的就不写。',
    },
    {
      role: 'user',
      content:
        `${ask}\n\n最近的群聊记录（按时间先后，可能不完整）：\n`
        + (body || '（这段时间没有可用的群聊记录 —— 就按你手上的信息写，别编造具体发生过的事）'),
    },
  ];
}
