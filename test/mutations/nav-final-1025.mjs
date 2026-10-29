/**
 * 导航最终版（2026-10-25 · M18 接入主项目）的定向变异 —— 纯数据。
 *
 * §131⑤ 的六组静态护栏各打一个失效面：
 *   ① 静态 press 环被改名 → 新增一级项没有按压反馈；
 *   ② 细框变粗 → 1px 最终版退化；
 *   ③ 二级扫光类名改坏 → 切二级不再有扫光；
 *   ④ 一级按压缩到 2px → 与设计值 3px 不符；
 *   ⑤ glider 速度拉伸被摘 → 滑片不再“液体”。
 *
 * 跑法：`NODE_OPTIONS= node scripts/mutate.mjs test/mutations/nav-final-1025.mjs`
 * ⚠️ 串行；会改写真实工作树，由脚手架还原。
 */
const INDEX = 'panel/next/index.html';
const CSS = 'panel/next/style.css';
const APP = 'panel/next/app.js';

export default [
  {
    id: 'NF1',
    note: '改名静态 press 环 —— §131⑤ 静态层判据必须红（新增一级项失去按压环）',
    file: INDEX,
    anchor: /id="navPress"/g,
    count: 1,
    apply: (s) => s.replace('id="navPress"', 'id="navPressX"'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'NF2',
    note: '把 1px 细框改成 1.5px —— §131⑤ 的 1px 判据必须红',
    file: CSS,
    anchor: /border: 1px solid var\(--c-nav-ring\);/g,
    count: 2,
    apply: (s) => s.replaceAll('border: 1px solid var(--c-nav-ring);', 'border: 1.5px solid var(--c-nav-ring);'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'NF3',
    note: '改坏二级扫光类名 —— §131⑤ 的 sweep 判据必须红',
    file: APP,
    anchor: /classList\.add\('sweep'\)/g,
    count: 1,
    apply: (s) => s.replace("classList.add('sweep')", "classList.add('sweepX')"),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'NF4',
    note: '把一级按压缩到 2px —— §131⑤ 的 3px 判据必须红',
    file: CSS,
    anchor: /\.grp:active \{[\s\S]{0,80}?transform: translateY\(3px\);/g,
    count: 1,
    apply: (s) => s.replace('.grp:active {\n  transform: translateY(3px);', '.grp:active {\n  transform: translateY(2px);'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'NF5',
    note: '摘掉滑片的 glider-core 速度拉伸 —— §131⑤ 的 glider 判据必须红',
    file: APP,
    anchor: /glideCore\.style\.transform/g,
    count: 1,
    apply: (s) => s.replace('glideCore.style.transform', 'glideCore.style.scaleBroken'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
];
