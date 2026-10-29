/**
 * 扩展 kind 的**唯一策略表**。
 *
 * 这里只回答一件事：同一个宿主里，`plugin` 与 `skill` 各自“默认怎么被使用”。
 * 它**不执行**任何扩展代码，也不替代 loader —— 加载、白名单、生命周期仍在
 * `plugin-host.js`；本模块只把散落在各处的 kind 判断收成一份可测的纯数据。
 *
 * ⚠️ 这不是“两套 API”：两种 kind 共用同一个 setup/registerTool/hooks 面。
 *    `promptCountsAsContract` 只表达一件事：纯提示词包能否算作“有入口契约”。
 */

const KIND_PLUGIN = 'plugin';
const KIND_SKILL = 'skill';

const KIND_POLICIES = Object.freeze({
  [KIND_PLUGIN]: Object.freeze({
    kind: KIND_PLUGIN,
    label: '插件',
    rootName: 'plugins',
    promptSegment: 'extensions',
    promptCountsAsContract: false,
    page: 'plugins',
  }),
  [KIND_SKILL]: Object.freeze({
    kind: KIND_SKILL,
    label: 'Skill',
    rootName: 'skills',
    promptSegment: 'skillExt',
    promptCountsAsContract: true,
    page: 'skill',
  }),
});

/** 认不出的 kind 一律按 plugin 处理：老目录/老测试没有 kind 时不能变成 Skill。 */
function normalizeKind(kind) {
  return kind === KIND_SKILL ? KIND_SKILL : KIND_PLUGIN;
}

function policyOf(kind) {
  return KIND_POLICIES[normalizeKind(kind)];
}

function labelOf(kind) {
  return policyOf(kind).label;
}

/** 从归一化后的 custom 里取两套白名单；extensions 缺失时回退旧单名单。 */
export function enabledByKindOf(custom) {
  const ex = custom && typeof custom === 'object' ? custom.extensions : null;
  if (ex && typeof ex === 'object' && !Array.isArray(ex)) {
    return {
      [KIND_PLUGIN]: Array.isArray(ex.plugins?.enabled) ? ex.plugins.enabled : [],
      [KIND_SKILL]: Array.isArray(ex.skills?.enabled) ? ex.skills.enabled : [],
    };
  }
  // 旧配置只有一份 plugins.enabled，而旧语义本来就同时约束两个根。
  const legacy = Array.isArray(custom?.plugins?.enabled) ? custom.plugins.enabled : [];
  return { [KIND_PLUGIN]: legacy, [KIND_SKILL]: legacy };
}

/** 从归一化后的 custom 里取两套用户设置；extensions 缺失时回退旧单设置。 */
export function settingsByKindOf(custom) {
  const ex = custom && typeof custom === 'object' ? custom.extensions : null;
  if (ex && typeof ex === 'object' && !Array.isArray(ex)) {
    return {
      [KIND_PLUGIN]: ex.plugins?.settings && typeof ex.plugins.settings === 'object' ? ex.plugins.settings : {},
      [KIND_SKILL]: ex.skills?.settings && typeof ex.skills.settings === 'object' ? ex.skills.settings : {},
    };
  }
  const legacy = custom?.plugins?.settings && typeof custom.plugins.settings === 'object'
    ? custom.plugins.settings : {};
  return { [KIND_PLUGIN]: legacy, [KIND_SKILL]: legacy };
}

/** 扩展总数上限（插件 + Skill 共用一个口，避免两个“总数”真相）。 */
export function maxOf(custom) {
  const n = Number(custom?.extensions?.max ?? custom?.plugins?.max);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
}

/**
 * 入口契约：一个包“确实做了什么”才算加载成功。
 *
 * - plugin：仍只认 setup / activate / hooks（纯 prompt 不改变旧语义）。
 * - skill：额外认 `prompt.sections` —— 纯提示词 Skill 可以有 `index.js: export {}`。
 * - `mixed`：Skill 导出 hooks。MVP 允许加载并在 UI 标“混合型（不推荐）”，不静默丢钩子。
 */
export function contractOf(mod, manifest, kind) {
  const k = normalizeKind(kind);
  const hasSetup = typeof mod?.setup === 'function';
  const hasActivate = typeof mod?.activate === 'function';
  const hooks = mod?.hooks && typeof mod.hooks === 'object' ? Object.keys(mod.hooks) : [];
  const hasHooks = hooks.length > 0;
  const promptSections = Array.isArray(manifest?.promptSections) ? manifest.promptSections : [];
  const hasPrompt = k === KIND_SKILL && promptSections.length > 0;
  const promptOnly = k === KIND_SKILL && hasPrompt && !hasSetup && !hasActivate && !hasHooks;
  const mixed = k === KIND_SKILL && hasHooks;
  return {
    kind: k,
    ok: hasSetup || hasActivate || hasHooks || hasPrompt,
    hasSetup,
    hasActivate,
    hasHooks,
    hasPrompt,
    promptSections: promptSections.length,
    hooks: hooks.length,
    promptOnly,
    mixed,
  };
}

/** Skill 额外接受 prompt 作为入口契约；plugin 不接受。 */
function promptCountsAsContract(kind) {
  return policyOf(kind).promptCountsAsContract;
}

/** 给人看的入口契约文案（entry 缺失/无导出时统一用这一句）。 */
export function entryContractText(kind) {
  const k = normalizeKind(kind);
  if (k === KIND_SKILL) {
    return '入口没有导出 setup / activate / hooks，也没有 prompt.sections'
      + '（纯提示词 Skill 也需要 index.js，内容写 export {} 即可）';
  }
  return '入口没有导出 setup / activate / hooks';
}
