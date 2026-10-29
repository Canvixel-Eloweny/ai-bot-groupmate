/**
 * MBTI 辅助层（2026-10-25 · 人设域六页合并）
 * ══════════════════════════════════════════════════════════════════════════
 *  这是一个**零依赖叶子**：只做三件事
 *    ① 四轴 ↔ 16 型的换算（判据只有这一份）；
 *    ② 类型的表达描述（提示词与面板共用，避免两处慢慢说不一样的话）；
 *    ③ 把「配置里的 mbti 段」归一化成确定形状。
 *
 *  为什么不需要任何 import：`src/custom-config.js` 要 import 它做归一化，
 *  而它若反过来 import custom-config 就成环。轴名与类型描述是本模块自有的常量。
 *
 *  ⚠️ 它不是能力量表，也不该被模型当标签用。提示词里那三句边界
 *  （不覆盖人设 / 不解释自己 / 不挂嘴边）是这一层的使用协议，不许省。
 */

export const MBTI_AXES = [
  { id: 'EI', left: 'E', right: 'I', leftName: '外向', rightName: '内向' },
  { id: 'SN', left: 'S', right: 'N', leftName: '实感', rightName: '直觉' },
  { id: 'TF', left: 'T', right: 'F', leftName: '思考', rightName: '情感' },
  { id: 'JP', left: 'J', right: 'P', leftName: '判断', rightName: '知觉' },
];

/** 每种类型的表达倾向。文案是产品自己的，不来自 16Personalities。 */
export const MBTI_TYPES = {
  INTJ: { name: '建筑师', tag: '先想清结构，再决定要不要开口；句子少，但每句有落点。', traits: ['目标先行', '独立', '克制'] },
  INTP: { name: '逻辑学家', tag: '对「为什么」比「怎么办」更感兴趣；喜欢拆开看，不急着下结论。', traits: ['拆解', '好奇', '慢半拍'] },
  ENTJ: { name: '指挥官', tag: '把聊天也当成一件要推进的事；直接、清楚，不绕弯。', traits: ['直接', '推进', '不怕冷场'] },
  ENTP: { name: '辩论家', tag: '喜欢换个角度看问题；反应快，偶尔嘴比脑子快半拍。', traits: ['机敏', '反问', '爱试探'] },
  INFJ: { name: '提倡者', tag: '先接住情绪，再给一句真正有用的话；克制、留白、看人很准。', traits: ['先共情', '克制', '留白', '对熟人更柔软'] },
  INFP: { name: '调停者', tag: '把感受放在事实前面；句子轻，但有自己的方向。', traits: ['柔软', '理想主义', '慢热'] },
  ENFJ: { name: '主人公', tag: '天然会照顾场子，但不抢每个人的话；希望大家都被看见。', traits: ['暖场', '照顾', '有主张'] },
  ENFP: { name: '竞选者', tag: '热情来得快，话题跳得也快；容易被新鲜的东西点亮。', traits: ['外放', '好奇', '容易上头'] },
  ISTJ: { name: '物流师', tag: '说过的话会记住，答应的事会做到；不喜欢夸张。', traits: ['可靠', '务实', '有记性'] },
  ISFJ: { name: '守卫者', tag: '先观察谁需要被照顾，再安静补位；记得很小的事。', traits: ['细心', '温和', '记得小事'] },
  ESTJ: { name: '总经理', tag: '把混乱的话题拉回可执行的那一步；条理清楚。', traits: ['有条理', '直接', '负责'] },
  ESFJ: { name: '执政官', tag: '在意每个人有没有被冷落；接话自然，场子不容易掉。', traits: ['体贴', '合群', '会接话'] },
  ISTP: { name: '鉴赏家', tag: '话不多，但一开口常常是关键；更喜欢动手而不是解释。', traits: ['冷静', '少废话', '现场感'] },
  ISFP: { name: '探险家', tag: '凭感觉行事，喜欢具体而美的东西；不太爱争。', traits: ['敏感', '随性', '审美强'] },
  ESTP: { name: '企业家', tag: '先做了再说；现场反应比计划快，敢接梗也不怕尴尬。', traits: ['行动派', '敢接梗', '不怕尴尬'] },
  ESFP: { name: '表演者', tag: '把气氛当成自己的责任；快乐很直接，也很会自嘲。', traits: ['鲜活', '爱玩', '会自嘲'] },
};

/** 默认四轴 = INFJ 的常见取值；类型按钮点一下也走 `axesForType()`。 */
export const MBTI_DEFAULT_AXES = Object.freeze({ EI: 62, SN: 58, TF: 57, JP: 46 });

const clampInt = (v, fallback) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(100, Math.round(n)));
};

/** 四轴 → 四字母。**50 归右半边**（与滑块「过半即倾向右侧」一致）。 */
function typeFromAxes(axes) {
  const a = axes && typeof axes === 'object' ? axes : {};
  return (Number(a.EI) >= 50 ? 'I' : 'E')
    + (Number(a.SN) >= 50 ? 'N' : 'S')
    + (Number(a.TF) >= 50 ? 'F' : 'T')
    + (Number(a.JP) >= 50 ? 'P' : 'J');
}

/** 四轴的人话摘要：`I 62% · N 58% · F 57% · J 54%`。 */
function axisSummary(axes) {
  const a = axes && typeof axes === 'object' ? axes : {};
  return MBTI_AXES.map((axis) => {
    const v = Number(a[axis.id]);
    return v >= 50 ? `${axis.right} ${Math.round(v)}%` : `${axis.left} ${Math.round(100 - v)}%`;
  }).join(' · ');
}

/**
 * 配置里的 `custom.mbti` → 确定形状。
 * 缺字段回落到默认；`on` 只认 `true`（默认关 —— 不替用户决定注入）。
 */
export function normalizeMbti(raw) {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const src = r.axes && typeof r.axes === 'object' ? r.axes : {};
  const axes = {};
  for (const axis of MBTI_AXES) axes[axis.id] = clampInt(src[axis.id], MBTI_DEFAULT_AXES[axis.id]);
  return {
    on: r.on === true,
    axes,
    note: String(r.note ?? '').slice(0, 500),
  };
}

/** 面板与提示词共用的当前类型信息。 */
export function mbtiInfoOf(mbti) {
  const m = normalizeMbti(mbti);
  const type = typeFromAxes(m.axes);
  const info = MBTI_TYPES[type] || MBTI_TYPES.INFJ;
  return {
    on: m.on,
    axes: m.axes,
    note: m.note,
    type,
    name: info.name,
    tag: info.tag,
    traits: info.traits.slice(),
    summary: axisSummary(m.axes),
  };
}

/**
 * 写进提示词的那一段。关着 / 没有类型时返回空数组（整段不出现）。
 * ⚠️ 顺序：类型 → 偏好 → 演法 → 个人差异 → 边界。边界必须在最后 ——
 *    它是"别把上面这些当标签"的唯一约束。
 */
export function mbtiPromptLines(custom) {
  const m = normalizeMbti(custom?.mbti);
  if (!m.on) return [];
  const info = mbtiInfoOf(m);
  const lines = [
    '## MBTI 辅助（只当表达倾向，不覆盖上面的人物设定）',
    `类型：${info.type}（${info.name}）`,
    `偏好：${info.summary}`,
    `演法：${info.tag} 表达时带上「${info.traits.join('、')}」的倾向，但别把它演成标签。`,
  ];
  if (m.note) lines.push(`个人差异：${m.note}`);
  lines.push('注意：不要用类型解释自己，也不要把 MBTI 挂在嘴边。');
  return lines;
}
