/**
 * Skill 扩展域（§167 · 2026-10-28）的变异清单 —— 纯数据。
 * 供 `NODE_OPTIONS= node scripts/mutate.mjs test/mutations/extensions-skill-2026-10-28.mjs --layer check-wb` 复跑。
 *
 * 背景：插件与 Skill 共用一套宿主，Skill 额外认 `prompt.sections` 作为入口契约；
 * 配置升为 `custom.extensions.plugins/skills` 双命名空间；Skill 的提示词走独立 2000 字预算段。
 * 下面七条各自只破坏一处接线，必须全部 BLOCKED。
 *
 * 写法约定：anchor 必须在 pristine 文件里**恰好命中 count 次**；命中数不对时
 * `mutate-lint` 判 INVALID。⚠️ 跑之前先本地提交（干净树），且串行。
 */
const KIND = 'src/extension-kind.js';
const CC = 'src/custom-config.js';
const HOST = 'src/plugin-host.js';
const BUDGET = 'src/context-budget.js';
const SCHEMA = 'panel/next/schema.js';
const APP = 'panel/next/app.js';
const COLLECTOR = 'panel/lib/state-collector.js';

export default [
  {
    id: 'M1',
    note: '纯提示词的 prompt.sections 不再算入口契约 —— §167① 必须变红（纯提示词 Skill 会被判 SKIPPED）。预期 BLOCKED',
    anchor: /const hasPrompt = k === KIND_SKILL && promptSections\.length > 0;/,
    count: 1,
    file: KIND,
    apply: (s) => s.replace(
      /const hasPrompt = k === KIND_SKILL && promptSections\.length > 0;/,
      'const hasPrompt = false;'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M2',
    note: '删掉旧 custom.plugins 的派生别名 —— §167② 必须变红（老配置读回来后插件列表会消失）。预期 BLOCKED',
    anchor: /plugins: legacyPluginAlias\(extensions\),/,
    count: 1,
    file: CC,
    apply: (s) => s.replace(
      /plugins: legacyPluginAlias\(extensions\),/,
      'plugins: { enabled: [], settings: {} },'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M3',
    note: 'empty 判定不再计入 promptSections —— §167③ 必须变红（纯提示词 Skill 会被误标「空载」）。预期 BLOCKED',
    anchor: /&& \(Array\.isArray\(m\.promptSections\) \? m\.promptSections\.length : 0\) === 0/,
    count: 1,
    file: HOST,
    apply: (s) => s.replace(
      /&& \(Array\.isArray\(m\.promptSections\) \? m\.promptSections\.length : 0\) === 0/,
      '&& true'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M4',
    note: 'skillExt 预算从 2000 缩到 200 —— §167④ 必须变红（提示词被大面积裁掉）。预期 BLOCKED',
    anchor: /skillExt: 2000,/,
    count: 1,
    file: BUDGET,
    apply: (s) => s.replace(/skillExt: 2000,/, 'skillExt: 200,'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M5',
    note: 'Schema 里把 Skill 页改名 —— §167⑤ 必须变红（维护域不再有 Skill 入口）。预期 BLOCKED',
    anchor: /id: 'skill',/,
    count: 1,
    file: SCHEMA,
    apply: (s) => s.replace(/id: 'skill',/, "id: 'skill-x',"),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M6',
    note: '设置路径退回单数 kind —— §167⑥ 必须变红（这正是 2026-10-28 实测的保存无效缺陷：写到 extensions.plugin）。预期 BLOCKED',
    anchor: /extensions\.\$\{extNsOf\(kind\)\}\.settings/g,
    count: 2,
    file: APP,
    apply: (s) => s.replace(
      /extensions\.\$\{extNsOf\(kind\)\}\.settings/g,
      'extensions.${kind}.settings'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M7',
    note: '删掉状态采集里的 Skill 提示词预览 —— §167⑦ 必须变红（面板看不到模型到底会收到什么）。预期 BLOCKED',
    anchor: /extensionPromptPreviewOf/g,
    count: 2,
    file: COLLECTOR,
    // ⚠️ 不能改成 extensionPromptPreviewOff —— "Off" 里仍含 "Of"，
    //    §167⑦ 的 `extensionPromptPreviewOf` 正则会照样命中（实测 NOT-BLOCKED）。
    apply: (s) => s.replace(/extensionPromptPreviewOf/g, 'extPreviewPlanOf'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
];
