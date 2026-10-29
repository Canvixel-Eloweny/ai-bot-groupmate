/**
 * 工厂入口迁入二级导航（§165 · 2026-10-27）的变异清单 —— 纯数据。
 * 供 `NODE_OPTIONS= node scripts/mutate.mjs test/mutations/factory-nav-2026-10-27.mjs --layer check-wb` 复跑。
 *
 * 背景：三个工厂原先是顶栏三颗圆钮 + 空白占位页；现在必须是「工厂」的三个
 * frame 二级页，并由 `#page[data-frame]` 选帧。下面五条分别破坏这件事的五个面，
 * 每条都必须让 §165 变红（BLOCKED），否则这道门就是假绿。
 *
 * 写法约定：anchor 必须在 pristine 文件里**恰好命中 count 次**；命中数不对时
 * `mutate-lint` 判 INVALID，而不是"跑过去但不证明任何事"。
 *
 * ⚠️ 跑之前先本地提交（mutate 只支持干净树、会改写真实工作树），且串行。
 */
const SCHEMA = 'panel/next/schema.js';
const INDEX = 'panel/next/index.html';
const FF = 'panel/next/factory-frame.js';
const APP = 'panel/next/app.js';
const CSS = 'panel/next/style.css';

export default [
  {
    id: 'M1',
    note: '把 「工厂 → 人设工厂」的 frame 改回 blank —— §165① 必须变红（人设页会退回空白占位）。预期 BLOCKED（check-wb §165①）',
    anchor: /frame: 'persona-factory\.html',/,
    count: 1,
    file: SCHEMA,
    apply: (s) => s.replace(/frame: 'persona-factory\.html',/, 'blank: true,'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M2',
    note: '在顶栏重新插入一颗 #factoryBtn（带 factory.toggle）—— §165② 必须变红（入口又跑回顶栏）。预期 BLOCKED（check-wb §165②）',
    anchor: /<div class="tb-actions">/,
    count: 1,
    file: INDEX,
    apply: (s) => s.replace(
      /<div class="tb-actions">/,
      '<div class="tb-actions">\n    <button class="theme-btn" id="factoryBtn" type="button" data-a="factory.toggle">x</button>'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M3',
    note: '让 factory-frame.js 重新读取 #factoryBtn —— §165③ 必须变红（帧控制器又依赖顶栏圆钮）。预期 BLOCKED（check-wb §165③）',
    anchor: /build\(\);\n  const page = \$\('page'\);/,
    count: 1,
    file: FF,
    apply: (s) => s.replace(/build\(\);\n  const page = \$\('page'\);/, "build();\n  const page = $('page'); document.getElementById('factoryBtn');"),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M4',
    note: '去掉 paintPage 的「同值不写」判断 —— §165④ 必须变红（3 秒轮询会让工厂重播入场）。预期 BLOCKED（check-wb §165④）',
    anchor: /if \(\(page\.dataset\.frame \|\| ''\) !== frameSrc\) \{/,
    count: 1,
    file: APP,
    apply: (s) => s.replace(/if \(\(page\.dataset\.frame \|\| ''\) !== frameSrc\) \{/, 'if (true) {'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M5',
    note: '把 .factory-host 的 z-index 从 39 改回 41（压到导航之上）—— §165⑤ 必须变红（二级按钮会被工厂盖住）。预期 BLOCKED（check-wb §165⑤）',
    anchor: /\.factory-host \{[^}]*z-index:\s*39;/,
    count: 1,
    file: CSS,
    apply: (s) => s.replace(/(\.factory-host \{[^}]*z-index:\s*)39;/, (m, pre) => pre + '41;'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
];
