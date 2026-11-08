/**
 * 二级页合并定向变异（2026-11-05 · §189 · G7 点名批准后落地）。
 *
 * 删页最容易出的两种事故，各有一条变异盯着：
 *   · 「页删了、功能也删了」—— 卡搬过去时漏一张，或控件字面量跟着没了；
 *   · 「页没真删」—— schema 改了但短标签表 / 签名清单 / 真渲染还留着旧页。
 * N7 是对照组：只改注释，必须**不**被拦住，证明这一串判据不是空断言。
 *
 * 跑法（串行；会改写真实工作树，失败后用 `--restore`）：
 *   NODE_OPTIONS= node scripts/mutate.mjs test/mutations/nav-merge-2026-11-05.mjs
 */

const SCHEMA = 'panel/next/schema.js';
const IDENTITY = 'panel/ui-identity.json';
const DOM = 'test/panel-dom.mjs';
const VERIFY = 'panel/next/verify.mjs';

export default [
  {
    id: 'N1',
    note: '维护域又长出一个「配置历史」页签 —— §189① 必须变红（空玻璃板页回来）',
    file: SCHEMA,
    anchor: /id: 'hud', label: 'HUD调整', title: '顶栏 HUD 信息岛',/,
    count: 1,
    apply: (s) => s.replace(
      "id: 'hud', label: 'HUD调整', title: '顶栏 HUD 信息岛',",
      "id: 'history', label: '配置历史', title: '顶栏 HUD 信息岛',",
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'N2',
    note: '思考模式卡搬丢（id 改走）—— §189② 必须变红（删页顺带把功能删了）',
    file: SCHEMA,
    anchor: /id: 'think', title: '思考模式', span: 6,/,
    count: 1,
    apply: (s) => s.replace(
      "id: 'think', title: '思考模式', span: 6,",
      "id: 'thinkX', title: '思考模式', span: 6,",
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'N3',
    note: '撤销动作改名 —— §189② 与 §3j 都必须变红（回滚入口够不着）',
    file: SCHEMA,
    anchor: /'config\.undo'/g,
    count: 1,
    apply: (s) => s.replace("'config.undo'", "'config.undoX'"),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'N4',
    note: 'NAV_SHORT 仍登记 thinking —— §189③ 必须变红（短标签指向不存在的页）',
    file: SCHEMA,
    anchor: /subs: \{ model: '模型', usage: '用量' \},/,
    count: 1,
    apply: (s) => s.replace(
      "subs: { model: '模型', usage: '用量' },",
      "subs: { model: '模型', thinking: '思考', usage: '用量' },",
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'N5',
    note: '签名清单没跟着重生成（仍列 thinking）—— §189④ 必须变红（§171① 同时红是预期的：改清单必然破签）',
    file: IDENTITY,
    anchor: /"id": "usage",/,
    count: 1,
    apply: (s) => s.replace(
      '        {\n          "id": "usage",',
      '        {\n          "id": "thinking",\n          "label": "思考与能力"\n        },\n        {\n          "id": "usage",',
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'N6',
    note: 'panel-dom 不再量 #card-hist —— §189⑤ 必须变红（只剩静态字面量，画不出来也不会红）',
    file: DOM,
    anchor: /card-hist/g,
    count: 3,
    apply: (s) => s.split('card-hist').join('card-histz'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'N7',
    note: '对照组：只改合并说明注释的措辞 —— 必须 NOT-BLOCKED（证明前面六条不是空断言）',
    file: SCHEMA,
    anchor: /删的是那一层导航，不是功能/,
    count: 1,
    apply: (s) => s.replace('删的是那一层导航，不是功能', '删掉的是导航那一层，功能没动'),
    layer: 'check-wb',
    expect: 'NOT-BLOCKED',
  },
  {
    id: 'N8',
    note: 'verify 的落点退回按下标点页签且找不到不报错 —— §189⑥ 必须变红（本轮 6 条假红的成因）',
    file: VERIFY,
    anchor: /const landed = await evalJs\(`const s=\$\{pick\}; if\(!s\) return 0; s\.click\(\); return 1;\`\);/,
    count: 1,
    apply: (s) => s.replace(
      'const landed = await evalJs(`const s=${pick}; if(!s) return 0; s.click(); return 1;`);',
      "await evalJs(`const s=document.querySelectorAll('#nav2 .sub')[${sub}]; if(s) s.click(); return 1;`);\n  const landed = 1;",
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'N9',
    note: '对照组：只改落点纪律那条注释的措辞 —— 必须 NOT-BLOCKED',
    file: VERIFY,
    anchor: /下标会随导航重排漂，页签名不会/,
    count: 1,
    apply: (s) => s.replace('下标会随导航重排漂，页签名不会', '页码会随导航重排漂，页签名不会'),
    layer: 'check-wb',
    expect: 'NOT-BLOCKED',
  },
];
