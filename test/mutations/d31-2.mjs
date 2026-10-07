/**
 * D31-2（两条叫醒路 + owner 身份）的变异清单 —— 纯数据，供
 * `node scripts/mutate.mjs test/mutations/d31-2.mjs` 复跑。
 *
 * 为什么每一步都要配变异：叫醒的失效形态是**"我喊了，它没反应"** ——
 * 而这一句在用户嘴里与"网络卡了""它坏了""它讨厌我"完全同形。
 * 所以每一条都必须有一道门在它身上响，否则"看起来接上了"就等于接上了。
 *
 *   | 组  | 打的是 | 该由哪一层拦住 |
 *   |---|---|---|
 *   | M1  | 叫醒接线挪到门禁之后（睡着先 return，永远轮不到） | check-wb §50 ⑨ |
 *   | M2  | 叫醒正文改用 `parsed.text`（@ 别人的显示名也能叫醒它） | check-wb §50 ⑩ |
 *   | M3  | `wakeTriggerOf` 去掉主人判据（谁都能叫醒） | check-wb §50 ⑪ |
 *   | M4  | 群里去掉"必须 @"那道闸（群里一句「起床」就醒） | check-wb §50 ⑪ |
 *   | M5  | 去掉"未配主人即关闭"（没配置 = 谁都能叫醒） | check-wb §50 ⑪ |
 *   | M6  | 收尾里新开一条 `setTimeout`（本项目明令禁止） | check-wb §50 ⑫ |
 *   | M7  | `isOwner` 改成包含比较（相似 QQ 号也能叫醒） | check-wb §50 ⑪ |
 *   | M8  | `statusOf` 不再优先判 override（叫醒了也照睡） | check-wb §50 ⑮ + smoke T328 |
 *   | M9  | 落盘丢掉 override（重启一次就把"已经叫醒了"抹掉） | check-wb §50 ② |
 *   | M10 | 叫醒后不立刻重算（叫醒的那条被自己的门禁挡下） | check-wb §50 ⑤ |
 *   | M11 | 私聊不再等过连发窗口（第 1 条带词就正式醒 → 紧急被自己堵死） | smoke T326 |
 *   | M12 | 紧急过期不转正式起床（白天又睡回去，坑#9） | smoke T327 |
 *   | M13 | `owner` 没被收进配置返回值（下游永远拿到空列表） | check-wb §50 ⑭ |
 *
 * 期望：十三条全部 `BLOCKED`，`INVALID` 为 0。
 *
 * ⚠️ 跑这一批时若看到 `[safe-delete]`，那是**沙箱的批量删除保护**在冒充"被拦住"
 *    （不是断言失败）—— 换前台 + 非沙箱复跑同一组再下结论（R33/R34/R36 同款）。
 * ⚠️ 另：本机 shell 注入的 `NODE_OPTIONS` 会把 `err.code` 改写成 `CODEBUDDY_BROKER_DENY`
 *    （R39）—— 跑测试要 `NODE_OPTIONS= node …`。
 */

/** handleMessage 里的叫醒接线（整块搬移用它当锚点） */
// ⚠️ Q39（外包任务1 v8 · F4）：D31-3 给这段加了 sessionKey 两行之后，旧载荷整块失配 ——
//    "删除"静默没发生、只剩下"插入" → 重复声明 wokeNow → 语法不合法（INVALID）。
//    载荷必须与现行代码逐字一致（含 D31-3 的注释行与 sessionKey 行）。
const WAKE_CALL = [
  '    const wokeNow = evaluateWake({',
  '      scene, userId: evt.user_id, mentionedSelf: parsed.mentionedSelf,',
  '      text: triggerTextOf(parsed), now: Date.now(),',
  '      // D31-3：补看要跳过**当前**这个会话 —— 叫醒的那条正被处理，它本来就会被回。',
  '      sessionKey: session ? session.key : store.key(scene, id),',
  '    });',
  '    if (wokeNow) log.info(`[${traceId}] 被叫醒（${sleepSnap?.wakeKind}）→ 这一条照常处理`);',
].join('\n');

const DECIDE_LINE = '    const decision = brain.decide(session, evt, parsed);';

export default [
  {
    id: 'M1',
    note: '叫醒接线挪到门禁**之后**（睡着的分支先 return，它永远不会被走到）',
    file: 'src/index.js',
    anchor: /^    const wokeNow = evaluateWake\(\{$/m,
    count: 1,
    apply: (s) => s.replace(WAKE_CALL, '').replace(DECIDE_LINE, `${WAKE_CALL}\n${DECIDE_LINE}`),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M2',
    note: '叫醒正文改用 `parsed.text`（@ 一个名字里带叫醒词的群友就能把它叫醒）',
    file: 'src/index.js',
    anchor: /^      text: triggerTextOf\(parsed\), now: Date\.now\(\),$/m,
    count: 1,
    apply: (s) => s.replace('      text: triggerTextOf(parsed), now: Date.now(),', '      text: parsed.text, now: Date.now(), // 变异：吃了带显示名的那份'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M3',
    note: '`wakeTriggerOf` 去掉主人判据（任何人说到的词都会生效）',
    file: 'src/sleep.js',
    anchor: /^  if \(!isOwner\(userId, owners\)\) return \{ \.\.\.base, reason: '不是主人' \};$/m,
    count: 1,
    apply: (s) => s.replace(
      "  if (!isOwner(userId, owners)) return { ...base, reason: '不是主人' };",
      '  // 变异：主人判据被摘掉了'
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M4',
    note: '群里去掉"必须 @"那道闸（群里一句不带 @ 的「起床」把它喊起来）',
    file: 'src/sleep.js',
    anchor: /^    if \(!mentionedSelf\) return \{ \.\.\.base, reason: '群里没 @ 它' \};$/m,
    count: 1,
    apply: (s) => s.replace(
      "    if (!mentionedSelf) return { ...base, reason: '群里没 @ 它' };",
      '    // 变异：@ 那道闸被摘掉了'
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M5',
    note: '去掉"未配主人即关闭"（没填配置 = 谁都能叫醒，fail-open）',
    file: 'src/sleep.js',
    anchor: /^  if \(!Array\.isArray\(owners\) \|\| owners\.length === 0\) return \{ \.\.\.base, reason: '未配置主人（叫醒路整体关闭）' \};$/m,
    count: 1,
    apply: (s) => s.replace(
      "  if (!Array.isArray(owners) || owners.length === 0) return { ...base, reason: '未配置主人（叫醒路整体关闭）' };",
      '  // 变异：fail-closed 那一支被摘掉了'
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M6',
    note: '收尾里新开一条 `setTimeout`（本项目明令禁止：不许为睡眠/叫醒新开调度）',
    file: 'src/index.js',
    anchor: /^    const wakeAt = Number\(plan\?\.wakeAt\) \|\| 0;$/m,
    count: 1,
    apply: (s) => s.replace(
      '    const wakeAt = Number(plan?.wakeAt) || 0;',
      '    const wakeAt = Number(plan?.wakeAt) || 0;\n    setTimeout(() => {}, WAKE_BURST.windowMs); // 变异：新开了定时器'
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M7',
    note: '`isOwner` 改成包含比较（与主人 QQ 号相似的号也能叫醒）',
    file: 'src/sleep.js',
    anchor: /^  return \(owners \|\| \[\]\)\.some\(\(o\) => String\(o\) === u\);$/m,
    count: 1,
    apply: (s) => s.replace(
      '  return (owners || []).some((o) => String(o) === u);',
      '  return (owners || []).some((o) => String(o).includes(u)); // 变异：放宽成包含'
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M8',
    note: '`statusOf` 不再优先判叫醒态（叫醒了也照睡，而两条路看起来都接上了）',
    file: 'src/sleep.js',
    anchor: /^  if \(overrideActive\(override, now\)\) return SLEEP_STATUS\.awake;$/m,
    count: 1,
    apply: (s) => s.replace(
      '  if (overrideActive(override, now)) return SLEEP_STATUS.awake;',
      '  if (override && now < 0) return SLEEP_STATUS.awake; // 变异：叫醒态不再优先'
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M9',
    note: '落盘丢掉 `override`（重启一次就把"已经叫醒了"抹掉 —— 主人叫了、它答应、然后又睡了）',
    file: 'src/sleep.js',
    anchor: /^    override,$/m,
    count: 1,
    apply: (s) => s.replace('    override,', '    // 变异：叫醒不落盘'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M10',
    note: '叫醒后不立刻重算（门禁读到的是旧快照 —— 表现是"喊一声没应，再喊才活"）',
    file: 'src/index.js',
    // ⚠️ Q39：D31-3 把签名加了 `{ skipKey = '' } = {}` 第三参 —— 旧锚点命中 0/1（INVALID）。
    anchor: /^  function applyWake\(override, reason, \{ skipKey = '' \} = \{\}\) \{$/m,
    count: 1,
    apply: (s) => s.replace(
      /    refreshSleep\(\); \/\/[^\n]*/,
      '    // 变异：叫醒后不立刻重算（门禁读到的是旧快照）'
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M11',
    note: '私聊不再等过连发窗口（第 1 条带词就走正式 → 主人连发 3 条时"紧急"被自己堵死，坑#7）',
    file: 'src/sleep.js',
    anchor: /^  if \(Number\(now\) - Number\(pending\.at\) < WAKE_BURST\.windowMs\) \{$/m,
    count: 1,
    apply: (s) => s.replace(
      '  if (Number(now) - Number(pending.at) < WAKE_BURST.windowMs) {',
      '  if (false) { // 变异：延迟判定被摘掉了'
    ),
    layer: 'smoke',
    expect: 'BLOCKED',
  },
  {
    id: 'M12',
    note: '紧急过期不再转正式起床（已过起床点也回睡 —— 白天又睡回去，坑#9）',
    file: 'src/sleep.js',
    anchor: /^  if \(o\.kind === 'emergency' && Number\(wakeAt\) > 0 && Number\(now\) >= Number\(wakeAt\)\) \{$/m,
    count: 1,
    // ⚠️ apply 里必须用与 anchor **同源**的正则（带 `^` 与 `/m`），不能用字符串：
    //    文件里有两行文字完全相同、只差缩进（未到期那支 4 空格 / 到期那支 2 空格），
    //    `String.replace(字符串)` 会命中**先出现的那一处**（4 空格那行里含着这个子串），
    //    于是锚点说的是 B、实际改的是 A —— 探针报 NOT-BLOCKED 而原因与代码无关（R42）。
    apply: (s) => s.replace(
      /^  if \(o\.kind === 'emergency' && Number\(wakeAt\) > 0 && Number\(now\) >= Number\(wakeAt\)\) \{$/m,
      '  if (false) { // 变异：过起床点不转正式'
    ),
    layer: 'smoke',
    expect: 'BLOCKED',
  },
  {
    id: 'M13',
    note: '`owner` 没被收进配置返回值（下游永远拿到空列表 —— 表现恰好是"叫不醒"）',
    file: 'src/config.js',
    anchor: /^    owner,$/m,
    count: 1,
    apply: (s) => s.replace('    owner,', '    // 变异：owner 没收进返回值'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
];
