/**
 * B5 · 直呼豁免与配置数值校验（§124 · 2026-10-21）的变异清单。
 * 跑法：NODE_OPTIONS= node scripts/mutate.mjs test/mutations/quota-1021.mjs
 */

const FS = 'src/field-schema.js';
const CFG = 'src/config.js';
const BRAIN = 'src/brain.js';
const IDX = 'src/index.js';
const SCH = 'panel/next/schema.js';
const CR = 'panel/lib/config-route.js';

export default [
  {
    id: 'Q1',
    note: 'NUM_FIELDS 不再登记 temperature —— §124① 必须变红',
    file: FS,
    anchor: /  temperature: \{ default: 1, min: 0, max: 2 \},/,
    count: 1,
    apply: (s) => s.replace('  temperature: { default: 1, min: 0, max: 2 },', ''),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'Q2',
    note: 'temperature 退回裸 Number() —— §124② 必须变红（非数字变 NaN）',
    file: CFG,
    anchor: /temperature: numOr\('temperature', raw\.llm\?\.temperature, Number\)/,
    count: 1,
    apply: (s) => s.replace("temperature: numOr('temperature', raw.llm?.temperature, Number)", 'temperature: Number(raw.llm?.temperature ?? 1.0)'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'Q3',
    note: '坏 JSON 不再给文件名 —— §124③ 必须变红',
    file: CFG,
    anchor: /配置文件不是合法 JSON/,
    count: 1,
    apply: (s) => s.replace('配置文件不是合法 JSON', '配置文件损坏'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'Q4',
    note: '直呼类不再计入豁免（小时上限仍拦 @/私聊）—— §124④ 必须变红',
    file: BRAIN,
    anchor: /const direct = kind === 'private' \|\| kind === 'named' \|\| kind === 'keyword';/,
    count: 1,
    apply: (s) => s.replace(
      "const direct = kind === 'private' || kind === 'named' || kind === 'keyword';",
      'const direct = false;'
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'Q5',
    note: '主链路不再把 decision.kind 传给限流 —— §124⑤ 必须变红',
    file: IDX,
    anchor: /throttleReason\(session, Date\.now\(\), \{ kind: decision\.kind \}\)/,
    count: 1,
    apply: (s) => s.replace('throttleReason(session, Date.now(), { kind: decision.kind })', 'throttleReason(session)'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'Q6',
    note: '面板删掉每小时上限控件 —— §124⑥ 必须变红',
    file: SCH,
    anchor: /bindSys: 'perHourPerSession'/,
    count: 1,
    apply: (s) => s.replace("bindSys: 'perHourPerSession'", "bindSys: 'perHourPerSessionX'"),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'Q7',
    note: '/api/config 不再夹取小时上限 —— §124⑦ 必须变红',
    file: CR,
    anchor: /Math\.min\(600, Math\.max\(1, body\.perHourPerSession\)\)/,
    count: 1,
    apply: (s) => s.replace('Math.min(600, Math.max(1, body.perHourPerSession))', 'body.perHourPerSession'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
];
