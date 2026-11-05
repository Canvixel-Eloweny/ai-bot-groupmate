/**
 * 批 C1（用量上限可配 + 可见）定向变异（2026-11-03 · 群友报告 BUG-10）。
 *
 * 修的形状是"三处都得对，缺任何一处都不报错"：
 *   默认值与回落算法只住在 `usageLimitsOf()`；`readCustom` 是白名单投影，漏了
 *   `usage` 这一格 ⇒ 面板保存一次就把用户填的上限从 config.json 里抹掉；
 *   主链路两处不显式传 `limits` ⇒ 函数写了但没人用，界面填了照样按常量裁；
 *   不下发 `usageLimits` ⇒ 页面只能自存一份默认数字，显示的就不是生效值。
 * 所以四条各打一枪。
 *
 * 跑法（串行；会改写真实工作树，失败后用 `--restore`）：
 *   NODE_OPTIONS= node scripts/mutate.mjs test/mutations/usage-limits-c1-1103.mjs
 */

const USAGE = 'src/usage.js';
const CC = 'src/custom-config.js';
const IDX = 'src/index.js';
const SC = 'panel/lib/state-collector.js';

export default [
  {
    id: 'U1',
    note: '主链路不传 limits（用回常量）—— §D8⑤ 必须变红（上限改了不生效）',
    file: IDX,
    anchor: /usageGateOf\(\{ chatKey: session\.key, limits: usageLimitsOf\(cfg\.custom\) \}\)/g,
    count: 1,
    apply: (s) => s.replace(
      'usageGateOf({ chatKey: session.key, limits: usageLimitsOf(cfg.custom) })',
      'usageGateOf({ chatKey: session.key })',
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'U2',
    note: 'readCustom 的白名单投影丢掉 usage —— §D8⑤b 必须变红（保存一次就抹掉用户填的上限）',
    file: CC,
    anchor: /usage: usageFields\(c\.usage\),/g,
    count: 1,
    apply: (s) => s.replace('    usage: usageFields(c.usage),\n', ''),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'U3',
    note: '不再下发生效上限 —— §D8⑤b 必须变红（页面只能自存默认数字，显示的不是生效值）',
    file: SC,
    anchor: /usageLimits: usageLimitsOf\(custom\),/g,
    count: 1,
    apply: (s) => s.replace('usageLimits: usageLimitsOf(custom),', ''),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'U4',
    note: 'usageLimitsOf 恒返回常量（函数在、也被调用，但不采纳用户值）—— §D8⑤c 必须变红',
    file: USAGE,
    anchor: /return \{\n    dailyTokens: posInt\(u\.dailyTokens, USAGE_LIMITS\.dailyTokens\),/g,
    count: 1,
    apply: (s) => s.replace(
      'return {\n    dailyTokens: posInt(u.dailyTokens, USAGE_LIMITS.dailyTokens),',
      'return {\n    dailyTokens: USAGE_LIMITS.dailyTokens,',
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
];
