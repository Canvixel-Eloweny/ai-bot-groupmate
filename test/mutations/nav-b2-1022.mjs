/**
 * B2 导航合并（2026-10-22）的定向变异 —— 纯数据。
 *
 * 角色卡分级页并入「知识包与角色卡」、峰谷页并入「主动与免打扰」后，
 * §126 / §127 的判据从「页 id」改为「控件 / bind 仍在」。这三条各打一个失效面：
 *   ① 角色卡分级控件被删 → §126 必须红；
 *   ② 峰谷总闸被删 → §127 必须红；
 *   ③ 峰谷「没被叫到不接话」被删 → §127 必须红。
 *
 * 跑法：`NODE_OPTIONS= node scripts/mutate.mjs test/mutations/nav-b2-1022.mjs`
 * ⚠️ 串行；会改写真实工作树，由脚手架还原。
 */
const SCHEMA = 'panel/next/schema.js';

export default [
  {
    id: 'N1',
    note: '删掉角色卡分级的卡 id（cg）—— §126「面板没有角色卡分级控件」必须变红。预期 BLOCKED',
    file: SCHEMA,
    anchor: /id: 'cg'/g,
    count: 1,
    apply: (s) => s.replace("id: 'cg'", "id: 'cg2'"),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'N2',
    note: '把峰谷总闸的绑定改坏 —— §127「峰谷控件」必须变红（页已并入主动与免打扰，判据盯 bind）。预期 BLOCKED',
    file: SCHEMA,
    anchor: /bind: 'peak\.enabled'/g,
    count: 1,
    apply: (s) => s.replace("bind: 'peak.enabled'", "bind: 'peak2.enabled'"),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'N3',
    note: '把峰谷「没被叫到不接话」的绑定改坏 —— §127 的第二条峰谷判据必须变红。预期 BLOCKED',
    file: SCHEMA,
    anchor: /bind: 'peak\.muteUnmentioned'/g,
    count: 1,
    apply: (s) => s.replace("bind: 'peak.muteUnmentioned'", "bind: 'peak2.muteUnmentioned'"),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
];
