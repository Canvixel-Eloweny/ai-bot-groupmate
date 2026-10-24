/**
 * §56「导出面 = 被引用集合」子目录扫描（2026-10-22 · G7-6）的变异清单。
 *
 * 背景：L3 把 registry / normalize / driver 搬进 `src/backend/`，而 §56 原来只
 * `readdirSync('src')` 顶层 ⇒ 子目录导出面永远不被检查（`backendOfConfig` 等
 * 死导出在全绿下活着）。修复后扫描面 = `src/ 下所有 .js（递归）`。
 *
 * 这条变异往 `src/backend/registry.js` 插一个无人引用的导出；只有递归扫描才能拦住。
 * 若 §56 退回只扫顶层，这条会 NOT-BLOCKED。
 *
 * 跑法：`NODE_OPTIONS= node scripts/mutate.mjs test/mutations/export-face-subdir-1022.mjs`
 * ⚠️ 串行；会改写真实工作树。
 */

const FILE = 'src/backend/registry.js';
const ANCHOR = /export const MEDIA_ACTIONS = Object\.freeze\(\[/;

export default [
  {
    id: 'M1',
    note: '在 src/backend 插一个无人引用的导出 —— 递归后的 §56 必须变红；退回只扫 src 顶层则 NOT-BLOCKED',
    file: FILE,
    anchor: ANCHOR,
    count: 1,
    // ⚠️ 名字必须拼出来：§56 的交叉引用扫描面包含本文件；写完整字面量会让
    //    “被本变异清单引用”误当成“被生产代码引用”，变异就永远 NOT-BLOCKED。
    apply: (s) => s.replace(
      ANCHOR,
      `export const ${['DEAD', 'SUBDIR', 'PROBE'].join('_')} = 1;\n`
      + 'export const MEDIA_ACTIONS = Object.freeze(['
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
];
