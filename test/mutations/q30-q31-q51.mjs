/**
 * Q30 / Q31 / Q51 落地批复的变异清单（2026-09-30 · 收口轮）。
 *
 * 来源：外包任务2 v3 回执的 C30 / C30b / C31 / C51 四条**判据级建议**（本轮采纳并落到
 * `scripts/check-wb.mjs` 的 §47③ / §48④ / §48⑤ / §49② 邻域）。
 * 跑法：`NODE_OPTIONS= node scripts/mutate.mjs test/mutations/q30-q31-q51.mjs`
 *
 *   | id | 打的是 | 该由哪一条拦住 |
 *   |---|---|---|
 *   | M1 | 判定卡的 `traceId` 简写属性被删（卡与当轮 reply 失去关联） | §47 C30 |
 *   | M2 | 判定卡当场 `newTraceId()` 自己造号（永远对不上 reply） | §47 C30 |
 *   | M3 | 一处 skip 插到 `unreadStat` **之前**（那条 skip 的未读翻空） | §48 C30b |
 *   | M4 | 存档记录**换个名字**多挂一个键（`whiteCard`，两个黑名单都不命中） | §48 C31 |
 *   | M5 | 存档记录用 `...s` 展开（键集仍是 8，白名单被展开绕过） | §48 C31 |
 *   | M6 | 安装路由里 `writeConfig` 只声明不调用（窄黑名单只认带括号的） | §49 C51 |
 *   | M7 | 安装路由里 `appendRecord({})` 一个新调用（白名单外） | §49 C51 |
 *   | M8 | 消费照做但把未读统计丢掉（`unreadStat` 恒 null） | smoke **T340** |
 *   | M9 | 判定卡挂一个假号（`traceId: 'bogus'`） | smoke **T339** |
 *
 * 期望：九条全部 `BLOCKED`，`INVALID` 为 0。
 * ⚠️ M1/M2 与 M9 打的是**同一个节点、不同的层** —— 这正是 HANDOFF §5-4b 那条
 *    "同一处修复的理想形态是契约 + 行为两层都能拦住它"：只有一层会响时，
 *    那层下线后就没人知道了。
 * ⚠️ M4 与 M5 同节点但触发**不同的那一条**（键集 vs 展开）—— 两条都要在，否则
 *    白名单会被"展开"这种写法整体绕过而没人知道。
 * ⚠️ M6 与 M7 同节点互补（引用黑名单 vs 调用白名单）—— 缺任何一条都有一类写法穿过去。
 * ⚠️ 跑测试一律 `NODE_OPTIONS= node …`（R39）。M8/M9 是 smoke 层，各要跑满一遍 smoke。
 */

export default [
  {
    id: 'M1',
    note: 'Q30①：判定卡丢掉本轮的 traceId（简写属性被删）—— 卡还在，但永远对不上当轮 reply',
    file: 'src/index.js',
    anchor: /^        traceId,$/m,
    count: 1,
    apply: (s) => s.replace(/^        traceId,$\n/m, ''),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M2',
    note: 'Q30①：判定卡当场 newTraceId() 自己造号（与当轮 reply 的号必然不同）',
    file: 'src/index.js',
    anchor: /^        traceId,$/m,
    count: 1,
    apply: (s) => s.replace(/^        traceId,$/m, '        traceId: newTraceId(),'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M3',
    note: 'Q30②：一处 skip 插到 unreadStat 之前（顺序倒置 → 那条 skip 的 unread 是空值）',
    file: 'src/index.js',
    anchor: /^    const unreadStat = session \? consumeUnread\(session, evt\.message_id\) : null;$/m,
    count: 1,
    apply: (s) => s.replace(
      "    const unreadStat = session ? consumeUnread(session, evt.message_id) : null;",
      "    writeSkip({ traceId, stage: 'decide', scene, id, sender, text: '', reason: 'mutation-order' });\n"
      + '    const unreadStat = session ? consumeUnread(session, evt.message_id) : null;'
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M4',
    note: 'Q31：存档记录换个名字多挂一个键（whiteCard）—— 两个名字黑名单都不命中，只有键集白名单拦得住',
    file: 'src/session-archive.js',
    anchor: /^      key: s\.key,$/m,
    count: 1,
    apply: (s) => s.replace(
      '      key: s.key,',
      '      key: s.key,\n      whiteCard: true,'
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M5',
    note: 'Q31：存档记录用 ...s 展开（键集仍恰好 8 —— 白名单会被展开整体绕过）',
    file: 'src/session-archive.js',
    anchor: /^      key: s\.key,$/m,
    count: 1,
    apply: (s) => s.replace(
      '      key: s.key,',
      '      ...s,\n      key: s.key,'
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M6',
    note: 'Q51：安装路由里 writeConfig 只声明不调用（窄黑名单只认 writeConfig( 那种写法）',
    file: 'panel/server.js',
    // ⚠️ 第 15 轮（H-10 路由表化）：安装路由搬成模块级 handler，体缩进 6 → 2 —— 锚点跟着搬。
    anchor: /^ {2}const overwrite = url\.searchParams\.get\('overwrite'\) === '1';$/m,
    count: 1,
    apply: (s) => s.replace(
      "  const overwrite = url.searchParams.get('overwrite') === '1';",
      '  const wc = writeConfig;\n'
      + "  const overwrite = url.searchParams.get('overwrite') === '1';"
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M7',
    note: 'Q51：安装路由里多一个白名单之外的调用 appendRecord({})（多一个即红）',
    file: 'panel/server.js',
    // ⚠️ 同 M6：第 15 轮路由表化后体缩进 6 → 2，锚点跟着搬。
    anchor: /^ {2}const overwrite = url\.searchParams\.get\('overwrite'\) === '1';$/m,
    count: 1,
    apply: (s) => s.replace(
      "  const overwrite = url.searchParams.get('overwrite') === '1';",
      '  appendRecord({});\n'
      + "  const overwrite = url.searchParams.get('overwrite') === '1';"
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M8',
    note: 'Q30② 行为层：消费照做、但把统计丢掉（unreadStat 恒 null）→ T340 必须红（skip 行带上一个空值）',
    file: 'src/index.js',
    anchor: /^    const unreadStat = session \? consumeUnread\(session, evt\.message_id\) : null;$/m,
    count: 1,
    apply: (s) => s.replace(
      '    const unreadStat = session ? consumeUnread(session, evt.message_id) : null;',
      '    consumeUnread(session, evt.message_id);\n    const unreadStat = null;'
    ),
    // ⚠️ 消费点仍然只此一处（`consumeUnread(` 计数不变）—— 所以这不是"另开一处清空"，
    //    而是**只把统计弄丢**：静态层不受影响，只有 T340 那条真入口看得见。
    layer: 'smoke',
    expect: 'BLOCKED',
  },
  {
    id: 'M9',
    note: 'Q30① 行为层：判定卡挂一个假号（traceId: \'bogus\'）→ T339 必须红（没有任何 reply 与它同源）',
    file: 'src/index.js',
    anchor: /^        traceId,$/m,
    count: 1,
    apply: (s) => s.replace(/^        traceId,$/m, "        traceId: 'bogus',"),
    // 与 M1/M2 同节点、**不同层** —— 这正是"同一处修复的理想形态是两层都能拦住它"。
    layer: 'smoke',
    expect: 'BLOCKED',
  },
];
