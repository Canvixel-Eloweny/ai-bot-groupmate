/**
 * §134「人味机制与面板可观测性」的定向变异（2026-10-22）。
 *
 * 每条只打一个失效面；全部 BLOCKED 才说明 §134 不是假绿。
 * 跑法：`NODE_OPTIONS= node scripts/mutate.mjs test/mutations/human-tone-1022.mjs`
 * ⚠️ 串行；会改写真实工作树。
 */
export default [
  {
    id: 'H1',
    note: '提示词不再注入关系温度行 —— §134① 必须变红'
      + '（温度只影响概率，模型永远不知道自己冷了）。预期 BLOCKED',
    file: 'src/brain.js',
    anchor: /if \(opts\.heatLine\) volatileSec\.lines\.push\(String\(opts\.heatLine\)\);/,
    count: 1,
    apply: (s) => s.replace('if (opts.heatLine) volatileSec.lines.push(String(opts.heatLine));', ''),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'H2',
    note: '巡逻概率不再乘群级反馈热 —— §134② 必须变红'
      + '（看过没出声的群不会被降温）。预期 BLOCKED',
    file: 'src/index.js',
    anchor: /chatHeatFor\(chat\.key, nowMs\) \* feedbackHeatFor\(chat\.key\)/,
    count: 1,
    apply: (s) => s.replace(
      'chatHeatFor(chat.key, nowMs) * feedbackHeatFor(chat.key)',
      'chatHeatFor(chat.key, nowMs)'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'H3',
    note: '删掉困倦的半小时档 —— §134③ 必须变红'
      + '（困倦只剩"两小时内"和"已过点"两档）。预期 BLOCKED',
    file: 'src/reply-text.js',
    anchor: /DROWSY_CRITICAL_MS/g,
    count: 2,
    apply: (s) => s.replaceAll('DROWSY_CRITICAL_MS', 'DROWSY_OLD'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'H4',
    note: '夜间产出不再读日流水 —— §134④ 必须变红'
      + '（夜岗素材退回无时间戳的最近 40 条）。预期 BLOCKED',
    file: 'src/index.js',
    anchor: /dayLogTextRecent\(DATA_DIR, key\)/,
    count: 1,
    apply: (s) => s.replace('dayLogTextRecent(DATA_DIR, key)', "''"),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
];
