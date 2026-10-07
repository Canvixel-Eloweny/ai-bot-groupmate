/**
 * 外包 ZCode《面板断言体检》两条"已确认"的复现清单
 * —— `node scripts/mutate.mjs test/mutations/zcode-0928.mjs`
 *
 * 为什么单独一份：这两条的**原始证据是外包给的**（PH4c / CM2），本机要能**独立复现**，
 * 才算真的验收（"读自述"不算验收）。搬进仓库后，谁改了 `src/working-memory.js`
 * 或 `panel/parts/14-script.html`，都能一条命令确认这两道防线还在。
 *
 * ⚠️ CM2 在收下补丁 PP1 **之前**是 NOT-BLOCKED（那正是 ZCode 报的假绿）；
 *    PP1 之后必须变 BLOCKED。所以这条同时是"补丁有没有真的落地"的判据。
 */

export default [
  {
    id: 'CM2',
    note: '§35 空轮判据：把"原样返回"改成"清空历史"（PP1 之前照打 ✓ 假绿）',
    file: 'src/working-memory.js',
    anchor: /if \(!turn\) return kept;/,
    count: 1,
    apply: (s) => s.replace('if (!turn) return kept;', 'if (!turn) return kept.slice(0, 0);'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  // ⚠️ S-12 第五批（2026-10-05）：原 PH4c（打 panel/parts/14-script.html）已**退役** ——
  //    它对应的旧页判据随旧页下线，且该关切在现役控制台没有等价判据。
  //    去向登记在 docs/S12-CONTRACT-MIGRATION-1005.md §十三。
];
