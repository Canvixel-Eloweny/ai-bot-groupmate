/**
 * 出站翻译：OneBot 段数组 → 官方发送计划（2026-11-06 · 零依赖纯函数）。
 *
 * 官方出站面比 OneBot 窄，三件事必须在这里**明说**，不许留给调用方猜：
 *   ① **没有 at 段** —— 只能降级成正文里的 `@名字`，它不是可信 ping；
 *      所以降级条目会带 `degraded`，让调用方记一条日志，而不是让用户以为"它 @ 了人"。
 *   ② **没有合并转发** —— `forward` / `node` 一律 `unsupported`，绝不伪造成功
 *      （伪造出去的表现是模型说"发好了"，群里什么都没有）。
 *   ③ **富媒体要先换 file_info** —— 图片不在这里上传，只产出"需要上传"的步骤，
 *      由 client 决定上传顺序与失败怎么回报（上传失败 ≠ 消息失败，要说清是哪一步）。
 *
 * 一条官方消息 = 一次请求，所以多个段会被拆成**多个步骤**；
 * 步骤顺序就是发送顺序，调用方按序消耗被动次数。
 */

import { MAX_TEXT_CHARS } from './constants.js';

/**
 * @param {Array<{type:string,data?:object}>} segments
 * @param {{selfId?:string|number, nameOf?:(id:string)=>string}} [ctx]
 * @returns {{steps:Array<object>, referenceId:string, degraded:string[], unsupported:string[]}}
 */
export function planOutbound(segments, ctx = {}) {
  const selfId = String(ctx.selfId ?? '');
  const nameOf = typeof ctx.nameOf === 'function' ? ctx.nameOf : () => '';
  const steps = [];
  const degraded = [];
  const unsupported = [];
  let referenceId = '';
  let text = '';

  const flush = () => {
    const trimmed = text.replace(/\s+$/, '');
    text = '';
    if (!trimmed) return;
    for (const piece of chunkText(trimmed)) steps.push({ kind: 'text', content: piece });
  };

  for (const seg of Array.isArray(segments) ? segments : []) {
    const type = seg?.type;
    const data = seg?.data ?? {};
    switch (type) {
      case 'text':
        text += String(data.text ?? '');
        break;
      case 'at': {
        const who = String(data.qq ?? '');
        // @ 自己不需要出现在正文里（回复本身就是接话）。
        if (who && who === selfId) break;
        if (who === 'all') { text += '@全体成员 '; degraded.push('all'); break; }
        const name = String(data.name || nameOf(who) || '').trim();
        text += name ? `@${name} ` : '@对方 ';
        degraded.push(who || 'unknown');
        break;
      }
      case 'reply':
        // 引用回复：官方用 message_reference，等价于"回到那一条上"。
        referenceId = String(data.id ?? '').trim() || referenceId;
        break;
      case 'image':
        flush();
        steps.push({ kind: 'image', file: String(data.file || data.url || '').trim(), subType: String(data.sub_type || '') });
        break;
      case 'forward':
      case 'node':
        unsupported.push('forward');
        break;
      case 'face':
      case 'record':
      case 'video':
      case 'file':
        unsupported.push(type);
        break;
      default:
        if (type) unsupported.push(String(type));
        break;
    }
  }
  flush();

  // 引用挂在**第一条**消息上：官方一次请求只有一个 message_reference，
  // 挂到后面几条会让"回到原话"这件事变成随机落点。
  if (referenceId && steps.length) steps[0].referenceId = referenceId;
  return { steps, referenceId, degraded, unsupported };
}

/**
 * 文本按保守上限切块。
 *
 * ⚠️ 只在**真的超长**时才切：主链路本来就会按 `reply.splitToken` 分条，
 *    这里再切一次只是兜住"模型一口气输出 5000 字"那种情况。
 *    切点按字符数、不按字节 —— 官方限制的是消息长度，而中文一个字算一个字符。
 */
export function chunkText(text, maxChars = MAX_TEXT_CHARS) {
  const s = String(text ?? '');
  if (s.length <= maxChars) return [s];
  const out = [];
  for (let i = 0; i < s.length; i += maxChars) out.push(s.slice(i, i + maxChars));
  return out;
}

/** 这一步能不能发出去（unsupported 非空时调用方必须明确失败，不能只发文本那半）。 */
export function hasNothingToSend(plan) {
  return !plan || !Array.isArray(plan.steps) || plan.steps.length === 0;
}
