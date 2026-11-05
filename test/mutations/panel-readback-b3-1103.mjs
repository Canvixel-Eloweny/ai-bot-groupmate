/**
 * 批 B3（面板回显 / 清单误报）定向变异（2026-11-03）。
 *
 * 三条修的都是"写得进、读不出"或"假警"：
 *   Q1/Q2 主人 QQ：控件绑 `ownerQq`，状态里只下发过 `owners` ⇒ 配好了界面仍空白。
 *   Q3/Q4 上下文预算：保存写顶层 `context`，读取走 `presets[当前大脑]` 归档快照 ⇒
 *          改完刷新还是旧数字（而且自定义大脑那一支根本不归档）。
 *   Q5/Q6 清单 `settings:{}` / `configSchema:{}` 被报成"不是对象"（假警）。
 *
 * 为什么这三条能一路活到 0.1.7：§123⑧⑨⑩ 各自都绿 —— ⑧ 钉控件名、⑨ 钉写入、
 * ⑩ 钉 `owners` 存在，**没有任何一条把两端接起来核**。这是"每半边都有闸、
 * 合起来没人管"的标准形状，所以下面每条都打在"两端对上"这件事上。
 *
 * 跑法（串行；会改写真实工作树，失败后用 `--restore`）：
 *   NODE_OPTIONS= node scripts/mutate.mjs test/mutations/panel-readback-b3-1103.mjs
 */

const SC = 'panel/lib/state-collector.js';
const SCH = 'panel/next/schema.js';
const MAN = 'src/plugin-manifest.js';

export default [
  {
    id: 'Q1',
    note: '状态里不再下发 ownerQq —— §123⑪ 必须变红（控件取不到值，主人 QQ 显示空白）',
    file: SC,
    anchor: /ownerQq: cfg\?\.owner\?\.qq \|\| \[\],/g,
    count: 1,
    apply: (s) => s.replace('ownerQq: cfg?.owner?.qq || [],', ''),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'Q2',
    note: '不再下发顶层 context 的生效值 —— §123⑫ 必须变红（面板没有真值可读）',
    file: SC,
    anchor: /context: normalizeContextInts\(cfg\),/g,
    count: 1,
    apply: (s) => s.replace('context: normalizeContextInts(cfg),', ''),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'Q3',
    note: '上下文预算读回 presets 归档快照 —— §123⑬ 必须变红（保存后刷新仍是旧数字）',
    file: SCH,
    anchor: /read: \(s\) => j\(s, \['config', 'context', 'recentTurns'\], 12\),/g,
    count: 1,
    apply: (s) => s.replace(
      "read: (s) => j(s, ['config', 'context', 'recentTurns'], 12),",
      "read: (s) => j(s, ['config', 'presets', activePreset(s), 'context', 'recentTurns'], 6),",
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'Q4',
    note: '控件 min 回到 0（后端下限是 2）—— §123⑭ 必须变红（界面允许填一个后端不认的值）',
    file: SCH,
    anchor: /id: 'ctx\.turns', label: '带入最近几轮对话', min: 2, max: 120, step: 1, volatile: true,/g,
    count: 1,
    apply: (s) => s.replace(
      "{ t: 'number', id: 'ctx.turns', label: '带入最近几轮对话', min: 2, max: 120, step: 1, volatile: true,",
      "{ t: 'number', id: 'ctx.turns', label: '带入最近几轮对话', min: 0, max: 40, step: 1, volatile: true,",
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'Q5',
    note: '清单空对象又被当成"不是对象"（旧判据）—— §扩展包宿主⑩ 必须变红（假警复活）',
    file: MAN,
    anchor: /if \(raw\.configSchema && !isPlainObj\(raw\.configSchema\)\) \{/g,
    count: 1,
    apply: (s) => s.replace(
      'if (raw.configSchema && !isPlainObj(raw.configSchema)) {',
      'if (schemaKeys.length === 0 && raw.configSchema) {',
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'Q6',
    note: '把 configSchema 的类型检查整个拆掉 —— §扩展包宿主⑩ 必须变红（修假警不许连真警一起没）',
    file: MAN,
    anchor: /if \(raw\.configSchema && !isPlainObj\(raw\.configSchema\)\) \{\n    problems\.push\(\{ code: 'bad-schema', text: 'configSchema 不是对象，已忽略' \}\);\n  \}/g,
    count: 1,
    apply: (s) => s.replace(
      "if (raw.configSchema && !isPlainObj(raw.configSchema)) {\n    problems.push({ code: 'bad-schema', text: 'configSchema 不是对象，已忽略' });\n  }",
      '',
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
];
