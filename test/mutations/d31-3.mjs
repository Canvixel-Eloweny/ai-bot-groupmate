/**
 * D31-3（起床补看 + 两处提示词段）的变异清单 —— 纯数据，供
 * `node scripts/mutate.mjs test/mutations/d31-3.mjs` 复跑。
 *
 * 补看这一块的失效形态有两条，都**看不见**：
 *   ① 它把一夜的闲话全回了一遍（像巡群机器人）—— 挑选取舍被放宽；
 *   ② 它一条都没回，但积压已经清空（"看过了"被当成"回过了"）—— 顺序或发送口被改。
 * 再叠加"碰提示词"那条老纪律：默认配置下提示词必须**逐字不变**。
 *
 *   | 组  | 打的是 | 该由哪一层拦住 |
 *   |---|---|---|
 *   | M14 | 挑选掺随机（同一份积压每次醒来结果不同，行为没法钉） | check-wb §50 ⑰ |
 *   | M15 | 先合成后消费（补看轮新到的被当成积压再消费一次） | check-wb §50 ⑰ |
 *   | M16 | 补看另开一个发送口（不走 enqueueFor = 六道闸全绕过） | check-wb §50 ⑰ |
 *   | M17 | 合成事件带上 message_id（补看自我繁殖，积压永远清不完） | check-wb §50 ⑱ |
 *   | M18 | 作息行不在必变段内（缓存被多断一次 / 末尾形状被破坏） | check-wb §50 ⑲ |
 *   | M19 | 总闸关着也产出作息行（默认配置的提示词被改了） | check-wb §50 ⑳ |
 *   | M20 | 总闸关掉不清叫醒态（一次叫醒挂在"上一次"的作息上，且没有重置路径） | check-wb §50 |
 *
 * 期望：七条全部 `BLOCKED`，`INVALID` 为 0。
 *
 * ⚠️ 本机 shell 注入的 `NODE_OPTIONS` 会把 `err.code` 改写成 `CODEBUDDY_BROKER_DENY`（R39）
 *    —— 跑测试要 `NODE_OPTIONS= node …`。
 */

/** runCatchUp 里"挑中的合成事件"那一段（整块搬移用它当锚点） */
const PICKED_BLOCK = [
  '      let n = 0;',
  '      for (const p of plan.picked) {',
  '        const s = store.sessions.get(p.key);',
  '        if (!s) continue;',
  "        enqueueFor(catchUpEventOf(p, bot.selfId ?? ''), '起床补看处理异常');",
  '        n += 1;',
  '      }',
].join('\n');

const CONSUME_LOOP = '      for (const item of plan.consumeByKey) {';

const REST_PUSH = [
  '    const restLine = restLineOf(opts.sleep, { now });',
  '    if (restLine) volatileSec.lines.push(restLine);',
].join('\n');

export default [
  {
    id: 'M14',
    note: '挑选掺随机（同一份积压每次醒来得到不同一批 —— 行为再也没法被断言钉死）',
    file: 'src/sleep.js',
    anchor: /^  scored\.sort\(\(a, b\) => \(b\.atCount - a\.atCount\)$/m,
    count: 1,
    apply: (s) => s.replace(
      '  scored.sort((a, b) => (b.atCount - a.atCount)',
      '  scored.sort((a, b) => (Math.random() - 0.5) // 变异：掺了随机'
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M15',
    note: '先合成后消费（补看轮新到的那条会被当成"睡着时的积压"再消费一次）',
    file: 'src/index.js',
    anchor: /^      for \(const item of plan\.consumeByKey\) \{$/m,
    count: 1,
    apply: (s) => s.replace(PICKED_BLOCK, '').replace(CONSUME_LOOP, `${PICKED_BLOCK}\n${CONSUME_LOOP}`),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M16',
    note: '补看另开一个发送口（不走 enqueueFor —— 串行/限流/花费闸/出口闸门/节奏/存档六道全绕过）',
    file: 'src/index.js',
    anchor: /^        enqueueFor\(catchUpEventOf\(p, bot\.selfId \?\? ''\), '起床补看处理异常'\);$/m,
    count: 1,
    apply: (s) => s.replace(
      "        enqueueFor(catchUpEventOf(p, bot.selfId ?? ''), '起床补看处理异常');",
      "        bot.sendMsg(p.scene, p.id, [{ type: 'text', data: { text: '补看' } }]); // 变异：另开了发送口"
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M17',
    note: '合成事件带上 message_id（补看会被再记一次未读 → 自我繁殖，积压永远清不完）',
    file: 'src/notice.js',
    anchor: /^    isCatchUp: true,$/m,
    count: 1,
    apply: (s) => s.replace(
      '    isCatchUp: true,',
      "    isCatchUp: true,\n    message_id: String(p?.messageId || ''), // 变异：补看事件带上了 message_id"
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M18',
    note: '作息状态行被摘出必变段（缓存被多断一次，且末尾两行不再是「时间 + 场景」）',
    file: 'src/brain.js',
    anchor: /^    const restLine = restLineOf\(opts\.sleep, \{ now \}\);$/m,
    count: 1,
    apply: (s) => s.replace(REST_PUSH, ''),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M19',
    note: '总闸关着也产出作息行（默认配置的提示词被改了 —— 碰提示词这一类最要命的一条）',
    file: 'src/reply-text.js',
    anchor: /^  if \(!snap \|\| snap\.enabled !== true\) return '';$/m,
    count: 1,
    apply: (s) => s.replace(
      "  if (!snap || snap.enabled !== true) return '';",
      "  if (!snap) return ''; // 变异：总闸关着也产出作息行"
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M20',
    note: '总闸关掉不清叫醒态（一次叫醒会一直挂在"上一次"的作息上，且没有任何重置路径）',
    file: 'src/index.js',
    anchor: /^      if \(sc\.enabled !== true && sleepState\.override\) \{$/m,
    count: 1,
    apply: (s) => s.replace(
      '      if (sc.enabled !== true && sleepState.override) {',
      '      if (false) { // 变异：总闸关了也不清叫醒态'
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
];
