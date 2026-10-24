/**
 * ══════════════════════════════════════════════════════════════════════
 *  技能注册表 —— 「技能」这一层的运行时实现
 * ══════════════════════════════════════════════════════════════════════
 *  在这之前，全项目的"可增长的表"（场景表、表情表、模型档案）都是**编译期常量**：
 *  加一项要改后端表 + 前端表 + 导出文案好几处。技能是会长大的东西，写死迟早腐烂。
 *  所以这一层做成**运行时注册**：数据存在 custom.skills 里，加技能＝加数据。
 *
 *  两种 kind，语义不同，别混：
 *
 *    persona —— 一套人格（角色卡）。存多张，随时"应用"到工作台的人格表单上。
 *               也可以带 scope 让它自动在某个群生效（同一个会话只取第一张，
 *               两张卡同时注入会互相打架 —— 这是本条规则的唯一理由）。
 *
 *    pack    —— 一个知识包（星座 / 冷笑话 / 某个游戏的攻略 / 本群的内部梗）。
 *               靠 triggers 命中才注入；没填 triggers 表示"总是带上"。
 *
 *  ⚠️ 双闸限流：命中的技能可能不止一条，所以注入有条数上限 + 总字数上限。
 *     理由和"自动记忆只放最近 12 条"完全一样 —— 这一节一旦比人格本身还长，
 *     模型就开始忽略人格了。
 */
import { SKILL_IN_PROMPT, SKILL_CHARS_IN_PROMPT } from './custom-config.js';

/**
 * 技能的作用范围是否命中当前会话。
 *
 * 「没填 id 的 group/user 范围」返回 false 而不是 true：
 * 那种技能是用户填漏了，让它"哪儿都不生效"比"到处都生效"安全得多 ——
 * 前者他一眼能看出没效果，后者会莫名其妙污染所有群。
 */
export function scopeMatches(scope, ctx) {
  if (!scope || scope.type === 'global') return true;
  if (!scope.id) return false;
  if (scope.type === 'group') return String(ctx?.groupId ?? '') === String(scope.id);
  if (scope.type === 'user') return String(ctx?.userId ?? '') === String(scope.id);
  return false;
}

/**
 * 这一轮生效的**角色卡**（没有就是 `null`）。
 *
 * 和「技能」分开挑：卡不是"本事"，它是"你是谁" —— 它替换人格段，不跟知识包抢字数预算。
 * 按"最具体优先"：按人 > 按群 > 全局；同档取数组里第一张。
 */
export function pickPersonaCard(skills, ctx) {
  const live = (skills || []).filter(
    (s) => s && s.enabled && s.kind === 'persona' && scopeMatches(s.scope, ctx)
  );
  const rank = (s) => (s.scope?.type === 'user' ? 0 : s.scope?.type === 'group' ? 1 : 2);
  let best = null;
  for (const s of live) if (!best || rank(s) < rank(best)) best = s;
  return best;
}

/** 一个知识包这一轮该不该上：填了触发词就要求命中，没填就是"总是带上" */
function packHit(skill, text) {
  if (!skill?.triggers?.length) return true;
  const low = String(text || '').toLowerCase();
  return skill.triggers.some((t) => low.includes(String(t).toLowerCase()));
}

/**
 * 挑出这一轮真正要注入提示词的技能。
 *
 * @param {Array} skills 归一化过的技能列表（custom.skills）
 * @param {{groupId?:string,userId?:string}} ctx 当前会话
 * @param {string} text 这一轮群友说的话（用来判触发词）
 * @param {{max?:number,chars?:number}} [opts] 注入预算（2026-10-23 可配）。
 *        `custom.skillPrompt.{max,chars}` 由调用方送入；缺省回落常量。
 * @returns {Array} 命中且在上限内的技能（原样返回条目，调用方决定怎么拼）
 */
export function pickSkillsForPrompt(skills, ctx, text, opts = {}) {
  const live = (skills || []).filter((s) => s && s.enabled && scopeMatches(s.scope, ctx));
  const maxSkills = Number.isFinite(Number(opts.max))
    ? Math.max(1, Math.trunc(Number(opts.max)))
    : SKILL_IN_PROMPT;
  const maxChars = Number.isFinite(Number(opts.chars))
    ? Math.max(0, Math.trunc(Number(opts.chars)))
    : SKILL_CHARS_IN_PROMPT;

  // 角色卡**不在这里**：它进的是人格段（见 `pickPersonaCard`），不是技能段。
  // 早期两张卡都往这里塞，结果是卡既改不了人设、又占掉知识包的字数预算。
  const picked = live.filter((s) => s.kind === 'pack' && packHit(s, text));

  // 条数 + 总字数双闸。字数不够时**跳过这一条**而不是直接截断整份列表 ——
  // 后面可能还有一条很短的能进，一刀切会把机会也砍掉。
  const out = [];
  let budget = maxChars;
  for (const s of picked) {
    if (out.length >= maxSkills) break;
    const cost = String(s.background || '').length + (s.examples || []).join('').length;
    if (cost > budget) continue;
    budget -= cost;
    out.push(s);
  }
  return out;
}

/**
 * 面板/调试用：把命中的技能拼成给模型看的那几段文本。
 * 和 brain.buildMessages 里的拼法共用一份，避免"调试看到一套、实际发出去另一套"。
 */
export function skillLines(skill) {
  const lines = [`【技能：${skill.name}】`, skill.background];
  if (skill.examples?.length) {
    lines.push('可以这样说话（只学语气，别照抄内容）：');
    for (const e of skill.examples) lines.push(`- ${e}`);
  }
  return lines;
}
