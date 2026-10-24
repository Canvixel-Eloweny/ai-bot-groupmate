/**
 * §136（液态玻璃制作站 + 渐进模糊弹层 · 2026-10-22）的变异清单 —— 纯数据。
 *
 * 五条各打一个失效面，每条都必须只让 §136 变红：
 *   ① 引擎默认仍 ramp / 单一 initGlass；
 *   ② 制作站资产登记、不挂产品导航、不复制 --c-*；
 *   ③ 遮罩必须紧挨 #modal、默认 hidden、三层；
 *   ④ modal() / closeModal() 接线；
 *   ⑤ 减少透明度 / @supports 回退。
 *
 * 跑法：`NODE_OPTIONS= node scripts/mutate.mjs test/mutations/glass-station-1022.mjs`
 * ⚠️ 串行；会改写真实工作树；失败后用 `--restore`。
 */

const GLASS = 'panel/next/glass.js';
const ENTRY = 'panel/next/index.html';
const SCRIM = 'panel/next/glass-scrim.css';

export default [
  {
    id: 'G1',
    note: '把 window.EstrellaGlass 改名 —— §136① 必须变红（制作站拿不到引擎 API）',
    file: GLASS,
    anchor: /window\.EstrellaGlass = Object\.freeze\(\{/,
    count: 1,
    apply: (s) => s.replace('window.EstrellaGlass = Object.freeze({', 'window.EstrellaGlassX = Object.freeze({'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'G2',
    note: '把 G_DEFAULTS.map 从 ramp 改成 sdf —— §136① 必须变红（产品顶栏/保存条光学漂移）',
    file: GLASS,
    anchor: /^  map: 'ramp',$/m,
    count: 1,
    apply: (s) => s.replace("  map: 'ramp',", "  map: 'sdf',"),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'G3',
    note: '注释掉尾部唯一的 initGlass(); —— §136① 必须变红（产品玻璃总闸不再初始化）',
    file: GLASS,
    anchor: /^initGlass\(\);$/m,
    count: 1,
    apply: (s) => s.replace(/^initGlass\(\);$/m, '// initGlass();'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'G4',
    note: '删掉 #glassScrim 默认的 hidden —— §136④ 必须变红（全屏遮罩在首屏就可见）',
    file: ENTRY,
    anchor: /<div class="glass-scrim" id="glassScrim" hidden aria-hidden="true">/,
    count: 1,
    apply: (s) => s.replace(
      '<div class="glass-scrim" id="glassScrim" hidden aria-hidden="true">',
      '<div class="glass-scrim" id="glassScrim" aria-hidden="true">'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'G5',
    note: '删掉第三层 .gsc-blur-3 —— §136④ 必须变红（渐进模糊退回两层，半径过渡变硬）',
    file: ENTRY,
    anchor: /<span class="gsc-blur gsc-blur-3"><\/span>/,
    count: 1,
    apply: (s) => s.replace('  <span class="gsc-blur gsc-blur-3"></span>\n', ''),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'G6',
    note: '把 prefers-reduced-transparency 回退改成 no-preference —— §136⑥ 必须变红（减少透明度时仍开三层滤镜）',
    file: SCRIM,
    anchor: /@media \(prefers-reduced-transparency: reduce\) \{/,
    count: 1,
    apply: (s) => s.replace(
      '@media (prefers-reduced-transparency: reduce) {',
      '@media (prefers-reduced-transparency: no-preference) {'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'G7',
    note: '删掉两档 --c-eg-shade 里的内侧暗壁层 —— §136⑦ 必须变红（令牌成了没人消费的死件）',
    file: 'panel/next/style.css',
    anchor: /    inset 0 -8px 18px -8px var\(--c-eg-wall\),\n/g,
    count: 2,
    apply: (s) => s.replace(/    inset 0 -8px 18px -8px var\(--c-eg-wall\),\n/g, ''),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'G8',
    note: '断掉 bindGooey(); —— §136⑦ 必须变红（融合演示静默不接线）',
    file: 'panel/next/glass-station.js',
    anchor: /^    bindGooey\(\);$/m,
    count: 1,
    apply: (s) => s.replace(/^    bindGooey\(\);$/m, '    // bindGooey();'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
];
