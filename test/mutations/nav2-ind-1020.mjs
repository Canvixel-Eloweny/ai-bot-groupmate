/**
 * §103（二级导航滑块 `.nav2-ind` · 2026-10-20）的变异清单 —— 纯数据。
 *
 * 二级导航从「纯 CSS 下划线（S1）」升到「Motion 驱动滑块（S2）」，
 * 依据是 `MOTION-METHODOLOGY §6.4` 的三条准入对导航全中，而一级早已按 S2 做。
 * 这七条各打一个失效面，每条都必须**只打红 §103**。
 *
 * 跑法：`NODE_OPTIONS= node scripts/mutate.mjs test/mutations/nav2-ind-1020.mjs`
 * ⚠️ 串行；会改写真实工作树。
 */

const CSS = 'panel/next/style.css';
const APP = 'panel/next/app.js';
const ENTRY = 'panel/next/index.html';

export default [
  {
    id: 'Q1',
    note: '删掉入口页里静态的 `#nav2Ind` —— §103① 必须变红'
      + '（滑块只存在于 renderNav2 的 innerHTML 里时，每次切页都"从 0 长出来"）。预期 BLOCKED',
    file: ENTRY,
    anchor: /    <span class="nav2-ind" id="nav2Ind" aria-hidden="true"><\/span>\n/,
    count: 1,
    apply: (s) => s.replace('    <span class="nav2-ind" id="nav2Ind" aria-hidden="true"></span>\n', '', 1),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'Q2',
    note: '`.nav2-ind` 的 `position: absolute` 改成 `static` —— §103② 必须变红'
      + '（掉进文档流：滑动失效但元素仍在，肉眼像多了一条线）。预期 BLOCKED',
    file: CSS,
    anchor: /\.nav2-ind \{\n  position: absolute;/,
    count: 1,
    apply: (s) => s.replace('.nav2-ind {\n  position: absolute;', '.nav2-ind {\n  position: static;'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'Q3',
    note: '把退役的 `.sub[aria-selected="true"]::after` 规则加回来 —— §103③ 必须变红'
      + '（两套指示器叠加：下划线与滑块同时出现）。预期 BLOCKED',
    file: CSS,
    anchor: /\.sub:focus-visible \{ outline: 2px solid var\(--c-accent\); outline-offset: 2px; \}/,
    count: 1,
    apply: (s) => s.replace(
      '.sub:focus-visible { outline: 2px solid var(--c-accent); outline-offset: 2px; }',
      '.sub:focus-visible { outline: 2px solid var(--c-accent); outline-offset: 2px; }\n'
      + '.sub[aria-selected="true"]::after { content: ""; position: absolute; left: 8px; right: 8px; bottom: -3px; height: 2px; background: var(--c-accent); }'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'Q4',
    note: '`renderNav2()` 之后不再同步滑块 —— §103④ 必须变红'
      + '（切页后滑块停在上一项的位置）。预期 BLOCKED',
    file: APP,
    anchor: /layoutNavDock\(true\);\n  syncNav2Indicator\(false\);\n\}/,
    count: 1,
    apply: (s) => s.replace('layoutNavDock(true);\n  syncNav2Indicator(false);\n}', 'layoutNavDock(true);\n}', 1),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'Q5',
    note: '`syncNav2Selection()` 里不再同步滑块（3 秒轮询 / 同 group 二级切换共用同一入口）—— §103⑤ 必须变红。预期 BLOCKED',
    file: APP,
    anchor: /String\(i === S\.si\)\)\);\n  syncNav2Indicator\(false\);\n\}/,
    count: 1,
    apply: (s) => s.replace("String(i === S.si)));\n  syncNav2Indicator(false);\n}", 'String(i === S.si)));\n}', 1),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'Q6',
    note: '坐标不再减 `scrollLeft` —— §103⑥ 必须变红'
      + '（窄屏横向滚动后与按钮错开，且不报错；最终版还要求补上 .nav2 的 4px 留白）。预期 BLOCKED',
    file: APP,
    anchor: /const x = sel\.offsetLeft \+ nav\.offsetLeft \+ NAV2_INSET - nav\.scrollLeft;/,
    count: 1,
    apply: (s) => s.replace('const x = sel.offsetLeft + nav.offsetLeft + NAV2_INSET - nav.scrollLeft;', 'const x = sel.offsetLeft + nav.offsetLeft + NAV2_INSET;'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'Q7',
    note: '把 `Motion` 驱动换回直接赋值 —— §103⑦ 必须变红'
      + '（改回 CSS/瞬时跳变：`paintPage` 每次整页重建，跨重建的过渡必死，§101 已踩过）。预期 BLOCKED',
    file: APP,
    anchor: /ind\.anims = \[M\.animate\(ind\.x, x, NAV2_SPRING\), M\.animate\(ind\.w, w, NAV2_SPRING\)\];/,
    count: 1,
    apply: (s) => s.replace('ind.anims = [M.animate(ind.x, x, NAV2_SPRING), M.animate(ind.w, w, NAV2_SPRING)];', 'ind.anims = [];'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
];
