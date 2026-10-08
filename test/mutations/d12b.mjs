/**
 * D12b（插话时机：活跃期提权 / 冷场降权）的变异清单 —— 纯数据，供
 * `node scripts/mutate.mjs test/mutations/d12b.mjs` 复跑。
 *
 * 背景：Q20 裁决选②（因子照做、总闸不开）→ 插话当下根本不跑，**没有任何真机会报警**。
 * 这一组变异验收的是"参数化"这条路本身还站着：判据层、接线、记账时序、
 * fail-open 方向、夹取、可观测落盘 —— 每条各打一个门。
 *
 * 期望：七条全部 `BLOCKED`（M1/M2/M6/M7 由 check-wb §41 拦；M3/M4/M5 由 smoke 拦）。
 */

export default [
  {
    id: 'M1',
    note: '叶子里混进时段判据（深夜降权归 D31，这里做就是第二个判据）',
    file: 'src/interject.js',
    anchor: /export const DEFAULT_INTERJECT_TUNING = \{/,
    count: 1,
    apply: (s) => s.replace(
      'export const DEFAULT_INTERJECT_TUNING = {',
      "const QUIET = 'quietHours'; // 变异：越界做时段\n\nexport const DEFAULT_INTERJECT_TUNING = {"
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M2',
    note: '掷骰子绕过因子（拿原概率直接掷，活跃期/冷场等于没做）',
    file: 'src/brain.js',
    anchor: /roll < plan\.chance/,
    count: 1,
    apply: (s) => s.replace('roll < plan.chance', 'roll < trigger.interjectChance'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M3',
    note: '概率夹取去掉（提权乘子 >1 时会掷出"必插话"）',
    file: 'src/interject.js',
    anchor: /const chance = Math\.min\(1, Math\.max\(0, raw \* weight\)\);/,
    count: 1,
    apply: (s) => s.replace(
      'const chance = Math.min(1, Math.max(0, raw * weight));',
      'const chance = raw * weight;'
    ),
    layer: 'smoke',
    expect: 'BLOCKED',
  },
  {
    id: 'M4',
    note: 'fail-open 反转：lastMsgAt 未知（重启后第一轮）也降权',
    file: 'src/interject.js',
    anchor: /const cold = lastMsgAt > 0 && coldGapMs >= t\.coldGapMs;/,
    count: 1,
    apply: (s) => s.replace(
      'const cold = lastMsgAt > 0 && coldGapMs >= t.coldGapMs;',
      'const cold = coldGapMs > 0 ? coldGapMs >= t.coldGapMs : true;'
    ),
    layer: 'smoke',
    expect: 'BLOCKED',
  },
  {
    id: 'M5',
    note: 'TTL 边界改成 <=（"恰好到期"仍算活跃 → 永远多活跃一轮）',
    file: 'src/interject.js',
    anchor: /const active = lastReplyAt > 0 && sinceReply < t\.activeWindowMs;/,
    count: 1,
    apply: (s) => s.replace(
      'const active = lastReplyAt > 0 && sinceReply < t.activeWindowMs;',
      'const active = lastReplyAt > 0 && sinceReply <= t.activeWindowMs;'
    ),
    layer: 'smoke',
    expect: 'BLOCKED',
  },
  {
    id: 'M6',
    note: '冷场记账挪到 decide 之前（冷场时长恒为 0，因子变死代码而四层照绿）',
    file: 'src/index.js',
    anchor: /if \(session && !evt\.isPoke\) brain\.noteSeen\(session\);/,
    count: 1,
    apply: (s) => s
      .replace(
        '    const decision = brain.decide(session, evt, parsed);',
        '    if (session && !evt.isPoke) brain.noteSeen(session);\n\n    const decision = brain.decide(session, evt, parsed);'
      )
      .replace('    if (session && !evt.isPoke) brain.noteSeen(session);\n\n    if (!decision.respond) {', '    if (!decision.respond) {'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M7',
    note: 'skip 记录不再落因子表（"它为什么没接话"无从排查）',
    file: 'src/bridge-io.js',
    anchor: /interject: info\.interject \|\| null,/,
    count: 1,
    apply: (s) => s.replace('interject: info.interject || null,', 'interject: null,'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
];
