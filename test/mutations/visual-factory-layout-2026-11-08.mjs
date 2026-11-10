/**
 * 视觉工厂三栏到 1000px（§192 · 2026-11-08）的变异清单 —— 纯数据。
 * 背景：旧断点「≤1360 收单列」恰好等于桌面壳默认窗口宽，Windows 窗框/125%
 * 缩放一吃像素，左右栏就堆到底下。本清单证明 §192 的三条判据真的会红。
 * 跑法：
 *   NODE_OPTIONS= node scripts/mutate-lint.mjs
 *   NODE_OPTIONS= node scripts/mutate.mjs test/mutations/visual-factory-layout-2026-11-08.mjs --layer check-wb
 * 纪律：anchor 必须在 pristine 文件里**恰好命中 count 次**；apply 必须返回不同且语法合法的内容。
 */
const VF = 'panel/next/visual-factory.html';
const DOM = 'test/panel-dom.mjs';

export default [
  {
    id: 'M1',
    note: '堆叠阈值改回 1360（本次缺陷原样复发）—— §192② 必须变红。预期 BLOCKED',
    file: VF,
    anchor: /@media \(max-width: 1000px\) \{/,
    count: 1,
    apply: (s) => s.replace(/@media \(max-width: 1000px\) \{/, '@media (max-width: 1360px) {'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M2',
    note: '1360 中间档不再保持三列（收窄成单列 grid）—— §192① 必须变红。预期 BLOCKED',
    file: VF,
    anchor: /grid-template-columns: 216px minmax\(0, 1fr\) 316px;/,
    count: 1,
    apply: (s) => s.replace(/grid-template-columns: 216px minmax\(0, 1fr\) 316px;/, 'grid-template-columns: 1fr;'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M3',
    note: '1180 中间档三列被删 —— §192① 必须变红。预期 BLOCKED',
    file: VF,
    anchor: /grid-template-columns: 196px minmax\(0, 1fr\) 288px;/,
    count: 1,
    apply: (s) => s.replace(/grid-template-columns: 196px minmax\(0, 1fr\) 288px;/, 'grid-template-columns: 1fr;'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M4',
    note: 'panel-dom 的三栏并存真渲染断言被摘 —— §192③ 必须变红。预期 BLOCKED',
    file: DOM,
    anchor: /视觉工厂三栏并存/,
    count: 1,
    apply: (s) => s.replace(/视觉工厂三栏并存/, '视觉工厂布局检查'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M5',
    note: '1360 档的 display 复位被摘（旧 ≤1180 堆叠块的 flex 会复活）—— §192① 必须变红。预期 BLOCKED',
    file: VF,
    anchor: /display: grid; flex-direction: row;/,
    count: 1,
    apply: (s) => s.replace(/display: grid; flex-direction: row;/, 'flex-direction: row;'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
];