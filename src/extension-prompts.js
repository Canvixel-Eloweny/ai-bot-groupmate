/**
 * 扩展提示词渲染器：插件（extensions）与 Skill（skillExt）共用同一套“行数组”输出。
 *
 * 为什么单独成模块：
 *   · brain 与面板预览必须**逐字同源** —— 两处各拼一份，迟早出现“页面说注入 A、
 *     模型收到 B”；这里把“段怎么排、标题怎么写、工具名怎么补、超预算怎么丢”收成纯函数。
 *   · 本模块零 import、零 IO、零环境读取，面板 lib 可以安全引用。
 */

const SKILL_MAX_CHARS = 2000;
const SKILL_HEADER = '## 你现在会用的 Skill';
const SKILL_INTRO = '（下面这些是你确实能做的扩展能力。需要的时候直接去用，不要凭空编造结果；它们不改变核心安全规则与工具协议。）';
const EXT_HEADER = '## 你可以用的额外能力';
const EXT_INTRO = '（下面这些是你确实能做的事。需要的时候直接去用，不要凭空编造结果。）';

const charsOf = (lines) => lines.reduce((n, l) => n + String(l || '').length + 1, 0);

export function extensionPromptMax() {
  return SKILL_MAX_CHARS;
}

/**
 * @param {{title?:string, content?:string, tools?:string[], priority?:number}[]} sections
 * @param {{maxChars?:number}} [opts]
 * @returns {{lines:string[], used:number, dropped:number, sections:object[], maxChars:number}}
 */
export function skillExtPlanOf(sections = [], { maxChars = SKILL_MAX_CHARS } = {}) {
  const input = Array.isArray(sections) ? sections : [];
  const cap = Number.isFinite(Number(maxChars)) && Number(maxChars) > 0
    ? Math.trunc(Number(maxChars)) : SKILL_MAX_CHARS;
  if (!input.length) return { lines: [], used: 0, dropped: 0, sections: [], maxChars: cap };

  const lines = [SKILL_HEADER, SKILL_INTRO];
  let used = charsOf(lines);
  const kept = [];
  let dropped = 0;
  for (const s of input) {
    const title = String(s?.title || '说明').trim() || '说明';
    const content = String(s?.content || '').trim();
    if (!content) continue;
    const block = [`### ${title}`, content];
    if (Array.isArray(s?.tools) && s.tools.length) {
      block.push(`（对应的工具名：${s.tools.join('、')}）`);
    }
    const need = charsOf(block);
    if (used + need > cap) { dropped += 1; continue; }
    lines.push(...block);
    used += need;
    kept.push(s);
  }
  return { lines, used, dropped, sections: kept, maxChars: cap };
}

/** 插件侧的兼容提示词段；排版与旧 `brain.js` 的 `extensions` 段逐字一致。 */
export function extensionPlanOf(sections = []) {
  const input = Array.isArray(sections) ? sections : [];
  if (!input.length) return { lines: [], used: 0, sections: [] };
  const lines = [EXT_HEADER, EXT_INTRO];
  for (const s of input) {
    const title = String(s?.title || '说明').trim() || '说明';
    const content = String(s?.content || '').trim();
    if (!content) continue;
    lines.push(`### ${title}`, content);
    if (Array.isArray(s?.tools) && s.tools.length) {
      lines.push(`（对应的工具名：${s.tools.join('、')}）`);
    }
  }
  return { lines, used: charsOf(lines), sections: input };
}
