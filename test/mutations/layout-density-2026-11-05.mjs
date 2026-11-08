/**
 * 控制台排版密度定向变异（2026-11-05 · §188）。
 *
 * 这一档守的是"看起来只是样式，改回去没人会发现"的那类回归：
 *   · 短输入又竖排成三行（宽卡右侧继续空一大条）；
 *   · 该并排的玻璃板改回 `span: 12`（一页一张板直接到底）；
 *   · 窄屏退路被删（手机上控件压成一条缝）；
 *   · 假 QQ 空会话又摆一整屏空白；
 *   · panel-dom 的真渲染断言被摘掉 —— 只剩静态字面量，CSS 改名也不会红。
 *
 * 跑法（串行；会改写真实工作树，失败后用 `--restore`）：
 *   NODE_OPTIONS= node scripts/mutate.mjs test/mutations/layout-density-2026-11-05.mjs
 */

const APP = 'panel/next/app.js';
const CSS = 'panel/next/style.css';
const SCHEMA = 'panel/next/schema.js';
const DOM = 'test/panel-dom.mjs';

export default [
  {
    id: 'L1',
    note: 'fieldInput 不再输出 f-row —— §188① 必须变红（短输入回到三行竖排）',
    file: APP,
    anchor: /class="f\$\{row \? ' f-row' : ''\}"/g,
    count: 1,
    apply: (s) => s.replace('class="f${row ? \' f-row\' : \'\'}"', 'class="f"'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'L2',
    note: 'row 判定丢掉 textarea / wide 两条闸 —— §188① 必须变红（长文本被压进右列）',
    file: APP,
    anchor: /const row = type !== 'textarea' && !x\.wide && ROW_TYPES\.has\(type\);/g,
    count: 1,
    apply: (s) => s.replace(
      "const row = type !== 'textarea' && !x.wide && ROW_TYPES.has(type);",
      'const row = ROW_TYPES.has(type);',
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'L3',
    note: 'number 又无条件写内联 width:130px —— §188① 必须变红（内联样式顶掉栅格列）',
    file: APP,
    anchor: /row \? '' : ` style="width:\$\{x\.wide \? '100%' : '130px'\}"`/g,
    count: 1,
    apply: (s) => s.replace(
      'row ? \'\' : ` style="width:${x.wide ? \'100%\' : \'130px\'}"`',
      '` style="width:${x.wide ? \'100%\' : \'130px\'}"`',
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'L4',
    note: '控件列改成固定 130px —— §188② 必须变红（窄卡与宽卡不再共用一档，长值被截）',
    file: CSS,
    anchor: /grid-template-columns: minmax\(0, 1fr\) clamp\(120px, 34%, 260px\);/,
    count: 1,
    apply: (s) => s.replace(
      'grid-template-columns: minmax(0, 1fr) clamp(120px, 34%, 260px);',
      'grid-template-columns: minmax(0, 1fr) 130px;',
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'L5',
    note: '删掉 ≤700px 的竖排退路 —— §188② 必须变红（手机档控件压成一条缝）',
    file: CSS,
    anchor: /@media \(max-width: 700px\) \{[\s\S]{0,220}\.f-row \{ grid-template-columns: minmax\(0, 1fr\); \}/,
    count: 1,
    apply: (s) => s.replace(
      '@media (max-width: 700px) {\n  .f-row { grid-template-columns: minmax(0, 1fr); }',
      '@media (max-width: 700px) {\n  .f-legacy { grid-template-columns: minmax(0, 1fr); }',
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'L6',
    note: '聊天等待改回一张 span-12 长板 —— §188③ 必须变红（一页一张玻璃板直接到底）',
    file: SCHEMA,
    anchor: /id: 'cw', title: '拟人停顿', span: 6,/,
    count: 1,
    apply: (s) => s.replace(
      "id: 'cw', title: '拟人停顿', span: 6,",
      "id: 'cw', title: '聊天等待', span: 12,",
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'L7',
    note: '花费卡被压成半栏 —— §188③ 必须变红（指标格与账本表格换行成筛子）',
    file: SCHEMA,
    anchor: /id: 'cost', title: '花费', span: 12,/,
    count: 1,
    apply: (s) => s.replace(
      "id: 'cost', title: '花费', span: 12,",
      "id: 'cost', title: '花费', span: 6,",
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'L8',
    note: '假 QQ 空会话没有高度上限 —— §188④ 必须变红（「还没有对话」下面一整屏空白）',
    file: CSS,
    anchor: /\.chat-log:has\(\.chat-empty\) \{ height: clamp\(180px, 26vh, 280px\); \}/,
    count: 1,
    apply: (s) => s.replace(
      '.chat-log:has(.chat-empty) { height: clamp(180px, 26vh, 280px); }',
      '.chat-log:has(.chat-empty-x) { height: clamp(180px, 26vh, 280px); }',
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'L9',
    note: '摘掉 panel-dom 的真渲染断言 —— §188⑤ 必须变红（只剩静态字面量，CSS 改名不会红）',
    file: DOM,
    anchor: /标签与输入框在同一行/,
    count: 1,
    apply: (s) => s.replace('标签与输入框在同一行', '标签与输入框同排'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
];
