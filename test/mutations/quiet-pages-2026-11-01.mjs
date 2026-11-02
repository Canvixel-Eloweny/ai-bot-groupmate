/**
 * 记忆 / 知识包降噪的定向变异（2026-11-01）。
 *
 * 每条都打在 §179 上：变异后 `check-wb` 必须 BLOCKED。
 * 跑法：
 *   NODE_OPTIONS= node scripts/mutate.mjs test/mutations/quiet-pages-2026-11-01.mjs
 * ⚠️ 串行；会改写真实工作树，失败后用 `--restore`。
 */

const APP = 'panel/next/app.js';
const SCHEMA = 'panel/next/schema.js';
const CSS = 'panel/next/style.css';
const DOM = 'test/panel-dom.mjs';

export default [
  {
    id: 'Q1',
    note: '记忆总览退回普通两列 —— §179② 必须变红（数字块/预算条消失）',
    file: APP,
    anchor: /<div class="mem-stats">/,
    count: 1,
    apply: (s) => s.replace('<div class="mem-stats">', '<div class="grid2">'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'Q2',
    note: '记忆筛选动作被改名 —— §179② 必须变红（按钮点了没有处理者）',
    file: APP,
    anchor: /'mem\.filter': \(p\) =>/,
    count: 1,
    apply: (s) => s.replace("'mem.filter': (p) =>", "'mem.filterOff': (p) =>"),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'Q3',
    note: '知识包预算条被换成旧灰块 —— §179② 必须变红（看不到注入字数/条数）',
    file: APP,
    anchor: /class="skill-budget"/,
    count: 1,
    apply: (s) => s.replace('class="skill-budget"', 'class="mem-budget"'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'Q4',
    note: '角色卡网格被改名 —— §179② 必须变红（覆盖率条没有容器）',
    file: APP,
    anchor: /class="role-grid"/,
    count: 1,
    apply: (s) => s.replace('class="role-grid"', 'class="role-list"'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'Q5',
    note: '旧的整段说明回到页面 —— §179① 必须变红（用户点名的“解释太多”）',
    file: SCHEMA,
    anchor: /desc: '手动记忆永远生效；自动记录要打开开关。'/,
    count: 1,
    apply: (s) => s.replace(
      "desc: '手动记忆永远生效；自动记录要打开开关。'",
      "desc: '让它长期记住一些事。手动记忆永远生效；自动记录要打开开关。'"
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'Q6',
    note: '记忆域卡头横线回来 —— §179③ 必须变红（只应在 know 域去掉）',
    file: CSS,
    anchor: /#page\[data-domain="know"\] \.card-h \{ border-bottom: 0; \}/,
    count: 1,
    apply: (s) => s.replace(
      '#page[data-domain="know"] .card-h { border-bottom: 0; }',
      '#page[data-domain="know"] .card-h { border-bottom: 1px solid var(--c-line); }'
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'Q7',
    note: '空态样式被改名 —— §179③ 必须变红（记忆页会退回虚线空态）',
    file: CSS,
    anchor: /^\.mem-empty \{$/m,
    count: 1,
    apply: (s) => s.replace(/^\.mem-empty \{$/m, '.mem-empty-old {'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'Q8',
    note: '知识包卡被拉回 12 栏 —— §179① 必须变红（用户点名的“强行拉大”）',
    file: SCHEMA,
    anchor: /id: 'sk', title: '知识包', span: 8/,
    count: 1,
    apply: (s) => s.replace("id: 'sk', title: '知识包', span: 8", "id: 'sk', title: '知识包', span: 12"),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'Q9',
    note: 'panel-dom 不再覆盖知识包页 —— §179④ 必须变红（真渲染没有守卫）',
    file: DOM,
    anchor: /知识包页/,
    count: 1,
    apply: (s) => s.replace('知识包页', '技能页'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'Q10',
    note: '记忆域短标签重新长出图库 —— §179⑤ 必须变红（已下线页回到导航）',
    file: SCHEMA,
    anchor: /subs: \{ memory: '自我', skills: '知识包' \}/,
    count: 1,
    apply: (s) => s.replace(
      "subs: { memory: '自我', skills: '知识包' }",
      "subs: { memory: '自我', skills: '知识包', faces: '图库' }"
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'Q11',
    note: 'CTRL_KINDS 重新收下 people —— §179⑤ 必须变红（控件清单与页面不同步）',
    file: SCHEMA,
    anchor: /'unread', 'apiDeals',/,
    count: 1,
    apply: (s) => s.replace("'unread', 'apiDeals',", "'unread', 'people', 'apiDeals',"),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'Q12',
    note: '群友档案渲染器被加回来 —— §179⑤ 必须变红（死页复活）',
    file: APP,
    anchor: /  \/\* 2026-11-01 · G7：群友档案 \/ 图库两页随「默认未内置插件」下线。/,
    count: 1,
    apply: (s) => s.replace(
      '  /* 2026-11-01 · G7：群友档案 / 图库两页随「默认未内置插件」下线。',
      "  people: (x) => '',\n  /* 2026-11-01 · G7：群友档案 / 图库两页随「默认未内置插件」下线。"
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
];
