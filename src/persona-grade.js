/**
 * ══════════════════════════════════════════════════════════════════════
 *  角色卡「十维」判据 —— 0.1.2 版（唯一实现）
 * ══════════════════════════════════════════════════════════════════════
 *  为什么 0.1.2 也要这一套：
 *    0.1.2 的角色卡（`custom.skills` 里 `kind:'persona'`）已经能装 24 项人格快照
 *    （`custom.persona` 12 项 + `custom.enhance` 12 项），面板上「套用到人格设定」
 *    一键换人。但**卡攒得好不好，面板一个字都不说** —— 于是"这张卡能演一个人"
 *    只能靠人凭感觉。这套判据把"能演"拆成十件可数的事，给每件一个分、一个颜色。
 *
 *  为什么颜色是"安排"而不是"评价"：
 *    灰=别上 · 绿=能演 · 蓝=偏、还没边界 · 紫=齐了但缺边界 · 金=成品。
 *    用户定稿的五格→五色（2026-10-18）：残缺灰 / 演绎绿 / 完美蓝 / 具像紫 / 现实金。
 *
 *  ⚠️ 零依赖叶子：不 import 任何模块、不读时钟、不碰 IO。
 *     输入是**一张卡**（`{name, fields:{...}}`），输出是纯数据 —— 面板与测试共用这一份。
 *
 *  ⚠️ `fields` 的键名就是 `custom.persona` + `custom.enhance` 的 24 个键，
 *     一字不差（见 `src/custom-config.js` 的 `PERSONA_KEYS` / `ENHANCE_KEYS`）。
 *     写成别的键名的后果不是报错，而是**永远 0 分**，所以这里只写这些键。
 */

/** 十维（能不能演一个人，看这十样有没有）。`fields` 全部取自真实人格字段。 */
export const TEN_DIMS = Object.freeze([
  { id: 'world', label: '世界观', fields: ['world'], cues: ['世界', '时代', '设定', '大陆', '王朝', '社会', '规则', '未来', '城市', '背景'], question: '这个世界的基本规则是什么？（时代/地点/有没有超自然，一句话）' },
  { id: 'values', label: '价值观', fields: ['values'], cues: ['重视', '看重', '认为', '应该', '不该', '公平', '自由', '正义', '原则', '底线'], question: '他排在最前面的三样是什么？（例：自由 > 家人 > 正义）' },
  { id: 'life', label: '生命观', fields: ['fear'], cues: ['生命', '死亡', '活着', '存在', '灵魂', '永恒', '牺牲', '消失'], question: '他怎么看待生死和"活着"？（会为什么豁出去、什么情况绝不）' },
  { id: 'vocation', label: '职业理想', fields: ['desire', 'status'], cues: ['职业', '工作', '想成为', '梦想', '事业', '职责', '使命', '目标'], question: '他现在靠什么吃饭、想成为什么？（没想清楚也行，说"还在混"也算答案）' },
  { id: 'attachment', label: '情感寄托', fields: ['relation', 'desire'], cues: ['喜欢', '在意', '牵挂', '依赖', '陪伴', '家人', '朋友', '执念', '寄托'], question: '他真正放不下的是谁/什么？' },
  { id: 'self', label: '自我', fields: ['traits', 'attitude'], cues: ['我是', '我的', '我从不', '我认为', '我在意'], question: '他自己会怎么介绍自己？（只说他自己认的，不是设定集的那种）' },
  { id: 'id', label: '本我', fields: ['stress', 'habits'], cues: ['本能', '冲动', '下意识', '忍不住', '脾气', '身体', '饿', '困'], question: '压力来时他第一反应是什么？（战斗/逃跑/僵住/讨好/讽刺/沉默）' },
  { id: 'logic', label: '思考逻辑', fields: ['logic', 'decide'], cues: ['所以', '因为', '判断', '分析', '先', '再', '根据', '考虑'], question: '他拿主意时先看什么、后看什么？' },
  { id: 'reasoning', label: '推理能力', fields: ['lines'], cues: ['如果', '就会', '只有在', '除非', '一旦', '当', '例子'], question: '举一个"如果……他就会……"的具体条件，越具体越好。' },
  { id: 'knowledge', label: '知识储备边界', fields: ['limits', 'secrets'], cues: ['不知道', '不懂', '只懂', '没学过', '听说', '据说', '大概', '专业'], question: '他懂什么、不懂什么、又误以为什么呢？' },
]);

/** 三档门槛（与 0.1.1 定稿同一组数：低维 0.50 / 够材料 0.66 / 满档 0.90）。 */
export const CARD_TIERS = Object.freeze({ low: 0.50, full: 0.66, real: 0.90 });

/** 单个分数 → 颜色档（灰/绿/蓝/紫/金；与用户的「灰 绿 蓝 紫 金」排序同一条阶梯）。 */
export function tierOf(score) {
  const s = Number(score) || 0;
  if (s < 0.30) return 'gray';
  if (s < CARD_TIERS.low) return 'green';
  if (s < CARD_TIERS.full) return 'blue';
  if (s < CARD_TIERS.real) return 'purple';
  return 'gold';
}

/** 颜色档 → 中文（面板与 README 共用，别各写一份）。 */
export const TIER_LABEL = Object.freeze({ gray: '灰', green: '绿', blue: '蓝', purple: '紫', gold: '金' });

/** 五格 → 颜色（用户逐格定稿：残缺灰 / 演绎绿 / 完美蓝 / 具像紫 / 现实金）。 */
export const CELL_TIER = Object.freeze({ 残缺格: 'gray', 演绎格: 'green', 完美格: 'blue', 具像格: 'purple', 现实格: 'gold' });

const clip = (s, n) => String(s ?? '').trim().slice(0, n);
const textOf = (card) => {
  const f = card?.fields && typeof card.fields === 'object' ? card.fields : {};
  return Object.values(f).map((v) => clip(v, 4000)).join('\n');
};

/**
 * 给一张卡打分（十维 + 五格）。**纯函数**，不改入参。
 *
 * 每一维两路证据取高：
 *   · 字段：填了 ≥20 字算"有实物"（1.0），有字但太短算半截（0.6）；
 *   · 词：本维 `cues` 在卡的全部字段文本里命中 3 个给满（0.8 封顶）。
 * ⚠️ 词证据封顶 0.8 是刻意的：只靠"原文提到过"进不了现实格（0.90），
 *    必须把字段写实 —— 这是「现实格要求均满分」那条要求的实现。
 *
 * @param {{name?: string, fields?: Record<string, string>}} card
 * @returns {{
 *   name: string, cell: string, cellTier: string, coverage: number, balance: number,
 *   boundary: number, reasonability: number, minScore: number, overallTier: string,
 *   dims: Array<{id:string,label:string,score:number,tier:string,tierLabel:string,filledChars:number,cueHits:string[],source:'field'|'text'|'none'}>,
 *   gaps: Array<{id:string,label:string,score:number,question:string,hint:string}>,
 *   advice: string,
 * }}
 */
export function gradePersonaCard(card) {
  const fields = card?.fields && typeof card.fields === 'object' ? card.fields : {};
  const all = textOf(card);

  const dims = TEN_DIMS.map((dim) => {
    const vals = dim.fields.map((k) => clip(fields[k], 4000)).filter(Boolean);
    const filledChars = vals.reduce((n, v) => n + v.length, 0);
    const longest = vals.reduce((n, v) => Math.max(n, v.length), 0);
    const byField = longest >= 20 ? 1 : longest > 0 ? 0.6 : 0;
    const cueHits = dim.cues.filter((c) => all.includes(c));
    const byText = Math.min(1, cueHits.length / 3) * 0.8;
    const score = Math.max(byField, byText);
    return {
      id: dim.id, label: dim.label, score,
      tier: tierOf(score), tierLabel: TIER_LABEL[tierOf(score)],
      filledChars, cueHits,
      source: byField >= byText && byField > 0 ? 'field' : byText > 0 ? 'text' : 'none',
    };
  });

  const scores = dims.map((d) => d.score);
  const coverage = scores.reduce((a, b) => a + b, 0) / scores.length;
  const minScore = Math.min(...scores);
  const maxScore = Math.max(...scores);
  const balance = 1 - (maxScore - minScore);
  const boundary = clip(fields.limits, 4000) || clip(fields.secrets, 4000) ? 1 : 0;
  const reasoning = dims.find((d) => d.id === 'reasoning')?.score || 0;
  const hasExample = /如果|就会|一旦|除非|只有在/.test(all) ? 1 : 0;
  const reasonability = Math.min(1, 0.5 * hasExample + 0.3 * reasoning + 0.2 * boundary);

  const allReal = minScore >= CARD_TIERS.real;
  const hasLow = minScore < CARD_TIERS.low;
  const allFilled = scores.every((s) => s >= CARD_TIERS.full);
  const canAct = reasonability >= 0.3;

  // 严格阶梯（先中先出）：残缺 → 现实 → 演绎 → 具像 → 完美。
  // 「可推」只在**材料本来就不够**（覆盖 < 0.50）时才算残缺 —— 否则文字卡
  //（没有 example_dialogue，reasonability 天然偏低）会全部掉进残缺格，后面四格永远出不来。
  let cell;
  if (coverage < 0.30 || (!canAct && coverage < 0.50)) cell = '残缺格';
  else if (allReal) cell = '现实格';
  else if (hasLow) cell = '演绎格';
  else if (!boundary && allFilled) cell = '具像格';
  else cell = '完美格';

  const gaps = dims
    .filter((d) => d.score < CARD_TIERS.full)
    .map((d) => ({
      id: d.id, label: d.label, score: d.score,
      question: TEN_DIMS.find((x) => x.id === d.id).question,
      hint: TEN_DIMS.find((x) => x.id === d.id).fields.join(' / '),
      // 补全要写进哪个字段：面板拿它直接落进卡的 fields，不必自己再算一遍
      field: fieldForDim(card, d.id),
    }));

  return {
    name: clip(card?.name, 40) || '未命名',
    cell, cellTier: CELL_TIER[cell], coverage, balance, boundary, reasonability,
    minScore, allReal, hasLow, allFilled, canAct,
    overallTier: tierOf(minScore), overallLabel: TIER_LABEL[tierOf(minScore)],
    dims, gaps,
    advice: adviceOf(cell),
  };
}

/** 五格各自"接下来该干什么"一句话（面板与 README 同一份文案）。 */
export function adviceOf(cell) {
  switch (cell) {
    case '现实格': return '每一维都到金档：这是能直接当成品用的卡。';
    case '具像格': return '十维都齐了，但没有边界（它不懂什么）：补「知识储备边界」就能上金档。';
    case '完美格': return '有短板也有边界：把缺的那几维补到 0.66 以上。';
    case '演绎格': return '至少有一维是空的/很浅，只够演样板剧：先把低维补起来。';
    default: return '材料本来就不够：至少补到覆盖 0.5、每维有字。';
  }
}

/** 某一维该写进哪个字段（补全按钮用：第一个**空着**的字段，都满了就第一个）。 */
export function fieldForDim(card, dimId) {
  const dim = TEN_DIMS.find((d) => d.id === dimId);
  if (!dim) return '';
  const fields = card?.fields && typeof card.fields === 'object' ? card.fields : {};
  return dim.fields.find((k) => !String(fields[k] ?? '').trim()) || dim.fields[0];
}
