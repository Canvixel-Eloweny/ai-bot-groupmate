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
 * @returns {Array} 命中且在上限内的技能（原样返回条目，调用方决定怎么拼）
 */
export function pickSkillsForPrompt(skills, ctx, text) {
  const live = (skills || []).filter((s) => s && s.enabled && scopeMatches(s.scope, ctx));

  // 角色卡同一个会话只取第一张 —— 两张卡同时注入会互相打架，模型会变成四不像
  const card = live.find((s) => s.kind === 'persona');
  const packs = live.filter((s) => s.kind === 'pack' && packHit(s, text));

  const picked = [...(card ? [card] : []), ...packs];

  // 条数 + 总字数双闸。字数不够时**跳过这一条**而不是直接截断整份列表 ——
  // 后面可能还有一条很短的能进，一刀切会把机会也砍掉。
  const out = [];
  let budget = SKILL_CHARS_IN_PROMPT;
  for (const s of picked) {
    if (out.length >= SKILL_IN_PROMPT) break;
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
