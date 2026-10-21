/**
 * §102（五份无行为契约的资产）的变异清单 —— 纯数据。
 *
 * 这五份资产此前只被 `NEXT_ASSETS` 的"文件还在不在"兜着，没有任何行为判据：
 *   morph.js / liquid-toggle.js / ticks.css / icons.js / demo-state.js。
 * 它们共同的失效形态是**页面照常打开、某个功能悄悄没了**。
 *
 * 每条变异各打一条判据，预期 BLOCKED（check-wb §102）。
 * 跑法：`NODE_OPTIONS= node scripts/mutate.mjs test/mutations/assets-contract-1020.mjs`
 * ⚠️ 串行；会改写真实工作树。2026-10-20 本轮因工作树被另一条会话占用，改在 /tmp 复本上
 *    逐条施加并跑真 `check-wb` 反证（五条各只打红 §102 一条）。
 */

const APP = 'panel/next/app.js';

export default [
  {
    id: 'N1',
    note: '去掉 `_morphMap.clear()` —— §102① 必须变红'
      + '（重建时不销毁上一批：每轮多一份 rAF 订阅，3 秒一次；页面看着完全正常）。预期 BLOCKED',
    file: APP,
    anchor: /  _morphMap\.clear\(\);\n/,
    count: 1,
    apply: (s) => s.replace('  _morphMap.clear();\n', '', 1),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'N2',
    note: '`RENDER.switch` 不再挂 `liq-host` —— §102② 必须变红'
      + '（液态开关静默退回原生样式；总闸与容器类对不上，谁也不会报错）。预期 BLOCKED',
    file: APP,
    anchor: /LIQUID_ON && !unsupported \? ' liq-host' : ''/,
    count: 1,
    apply: (s) => s.replace("LIQUID_ON && !unsupported ? ' liq-host' : ''", "''"),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'N3',
    note: '去掉 `_tickClean.splice(0)` 的回收 —— §102③ 必须变红'
      + '（3 秒重建后旧监听仍挂在被丢弃的节点上；拖拽/键盘可能同时改两次值）。预期 BLOCKED',
    file: APP,
    anchor: /  for \(const fn of _tickClean\.splice\(0\)\) \{ try \{ fn\(\); \} catch \{ \/\* DOM 已不在 \*\/ \} \}\n/,
    count: 1,
    apply: (s) => s.replace('  for (const fn of _tickClean.splice(0)) { try { fn(); } catch { /* DOM 已不在 */ } }\n', '', 1),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'N4',
    note: '把一处 `Icons.icon(` 换成空串 —— §102④ 必须变红'
      + '（图标表消费点掉到 2 处；真实场景多半是"内联 SVG 另起一套"，两个来源各自漂移）。预期 BLOCKED',
    file: APP,
    anchor: /Icons\.icon\(it\.ico, \{ size: 20 \}\)/,
    count: 1,
    apply: (s) => s.replace("Icons.icon(it.ico, { size: 20 })", "''", 1),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'N5',
    note: '把 `S.state = DEMO` 的 `HAS_TOKEN` 守卫拿掉 —— §102⑤ 必须变红'
      + '（有 token 时首屏先摆一屏演示数据：看起来正常、其实是假的，2026-10-12 真机抓到过）。预期 BLOCKED',
    file: APP,
    anchor: /if \(!S\.state && !HAS_TOKEN\) S\.state = DEMO;/,
    count: 1,
    apply: (s) => s.replace('if (!S.state && !HAS_TOKEN) S.state = DEMO;', 'if (!S.state) S.state = DEMO;'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
];
