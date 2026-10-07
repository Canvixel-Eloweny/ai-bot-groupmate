/**
 * D31 缺陷批（**Q33 / Q34 / Q35 / Q37** · 2026-10-01）的变异清单 —— 纯数据，供
 * `node scripts/mutate.mjs test/mutations/d31-4.mjs` 复跑。
 *
 * 这四条全是"**接上了但语义差一格**"：改动前代码跑得通、契约全绿、界面无异常，
 * 只有真机在特定时序下才露出来。所以变异要回答的问题是：
 * **新加的判据/用例，是不是真的盯住了那一格？**
 *
 *   | 变异 | 打的是什么 | 该由哪一层拦住 | 期望 |
 *   |---|---|---|---|
 *   | M1 | 删掉 `settleWake` 兑现分支的补看**置位** | check-wb §50㉑ | BLOCKED |
 *   | M2 | 保留置位与消费位，删掉 tick 里那句 `runCatchUp` | check-wb §50㉑ | BLOCKED |
 *   | M3 | 把补看**整块挪进 `refreshSleep`**（在判定链里做重活） | check-wb §50㉑（消费点恰 1 + 必须在 tick 里） | BLOCKED |
 *   | M4 | 同 M2，但走行为层 | smoke **T341** | BLOCKED |
 *   | M5 | 删掉紧急态刷新后那句 `saveSleepState()` | check-wb §50㉒ | BLOCKED |
 *   | M6 | 同 M5，但走行为层 | smoke **T342** | BLOCKED |
 *   | M7 | 面板文案换回"积压"口径 | check-wb §50㉓ | BLOCKED |
 *   | M8 | 删掉 reply 记录的 `sleep` 字段 | check-wb §50㉔ | BLOCKED |
 *   | M9 | 字段留着、**值取空**（`wakeKind: ''`） | check-wb §50㉔（判"取自快照"而不是"有没有这个键"） | BLOCKED |
 *   | M10 | 同 M8，但走行为层 | smoke **T341**（trace 断言） | BLOCKED |
 *
 * ⚠️ M3 是这批最有信息量的一条：它**功能上照样能补看**（T341 会绿），
 *    只有"消费点恰 1 处且必须在 tick 尾部"这条**位置**判据会响 ——
 *    位置就是语义（`refreshSleep` 还被启动与 `applyWake` 调用）。
 * ⚠️ M4 / M6 / M10 是"行为层也要拦得住"的三条：契约下线之后，它们才是唯一还在守的那一层。
 *
 * ⚠️ **2026-10-05（第 7 轮 · 变异锚点修复）**：M8 / M10 重锚，**M9 修的是 `apply`**。
 *    · M8/M10：Q86 裁决①把 reply 记录里那个 `sleep` 从**内联字面量**换成了
 *      `sleep: sleepRound,`（生成前冻结的那一份）。关切没变、判据没变，锚点跟着形状走。
 *    · M9：**这一类是本轮那个量尺查不出来的** —— 锚点命中 1/1、`apply` 也真的改了内容，
 *      但它把行尾注释插进了**单行对象的中段**，于是 `//` 吃掉了同行的 `catchUp: … };`
 *      ⇒ 产物**语法错误** ⇒ `mutate.mjs` 报 INVALID（看着像"没拦住"）。
 *      量尺只查锚点，查不出这一层 —— 所以本轮 8 个套件**逐个真跑**过一遍，不只跑量尺。
 *      ⇒ 通用形态：**`apply` 的产物也是"变异体"，它必须过语法闸门**。
 *
 * ⚠️ 本机 shell 注入的 `NODE_OPTIONS` 会把 `err.code` 改写成 `CODEBUDDY_BROKER_DENY`（R39）
 *    —— 跑测试要 `NODE_OPTIONS= node …`。
 */

/** Q33 · tick 尾部那一整块（M3 用它当锚点并整块搬走） */
const CATCHUP_CONSUME = [
  '    if (catchUpRequested) {',
  '      catchUpRequested = false;',
  '      runCatchUp({ owners: ownerIds() });',
  '    }',
].join('\n');

/** 删掉紧急态刷新那支里的落盘（M5/M6）—— 先定位那一支，再动它后面的那一行 */
const dropEmergencySave = (src) => {
  const i = src.indexOf('until: now + EMERGENCY_QUIET_MS');
  const j = src.indexOf('saveSleepState();', i);
  if (i < 0 || j < 0) return src;
  return `${src.slice(0, j)}void 0;${src.slice(j + 'saveSleepState();'.length)}`;
};

/**
 * 删掉 reply 记录里的 sleep 字段（M8/M10）
 *
 * ⚠️ **2026-10-05（第 7 轮）重锚**：Q86 裁决①把那个字段从**内联对象字面量**
 *    改成了**引用一份生成前冻结好的值**：
 *        - 旧形状：`sleep: {\n  wakeKind: String(sleepSnap?.wakeKind || ''),\n  catchUp: !!evt.isCatchUp,\n},`
 *        - 现形状：`const sleepRound = { … };`（生成前冻结）+ 记录里 `sleep: sleepRound,`
 *    ⇒ 删掉"记录里那一行"仍然是同一个关切（reply 记录没有 sleep 字段），
 *      而 `§50㉔` 的判据也一个字没改成"必须先有 `sleep: sleepRound,`"。
 *      这就是**锚点跟着实现走**：对象的形状变了，关切没变。
 */
const dropSleepField = (src) => src.replace('      sleep: sleepRound,\n', '');

export default [
  {
    id: 'M1',
    file: 'src/index.js',
    anchor: /if \(p\.override\.kind === 'owner'\) catchUpRequested = true;/,
    count: 1,
    apply: (src) => src.replace(
      /if \(p\.override\.kind === 'owner'\) catchUpRequested = true;/,
      'void 0;',
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
    note: '§50㉑/Q33：兑现分支不再请求补看 —— "同样是主人喊了一声"，补看又变成看时序运气',
  },
  {
    id: 'M2',
    file: 'src/index.js',
    anchor: /      runCatchUp\(\{ owners: ownerIds\(\) \}\);/,
    count: 1,
    apply: (src) => src.replace(CATCHUP_CONSUME, [
      '    if (catchUpRequested) {',
      '      catchUpRequested = false;',
      '    }',
    ].join('\n')),
    layer: 'check-wb',
    expect: 'BLOCKED',
    note: '§50㉑/Q33：请求位照置、照消费，但没人真的去翻积压 —— "接线在、动作没了"',
  },
  {
    id: 'M3',
    file: 'src/index.js',
    anchor: /    if \(catchUpRequested\) \{/,
    count: 1,
    apply: (src) => src
      .replace(`${CATCHUP_CONSUME}\n`, '')
      .replace(
        "if (p.override.kind === 'owner') catchUpRequested = true;",
        "if (p.override.kind === 'owner') runCatchUp({ owners: ownerIds() });",
      ),
    layer: 'check-wb',
    expect: 'BLOCKED',
    note: '§50㉑/Q33：把补看挪进 `refreshSleep`（它还被**启动**与 `applyWake` 调用）—— '
      + '功能上照样补看（行为层会绿），只有"消费点恰 1 处且必须在 tick 尾部"这条位置判据会响',
  },
  {
    id: 'M4',
    file: 'src/index.js',
    anchor: /      runCatchUp\(\{ owners: ownerIds\(\) \}\);/,
    count: 1,
    apply: (src) => src.replace(CATCHUP_CONSUME, [
      '    if (catchUpRequested) {',
      '      catchUpRequested = false;',
      '    }',
    ].join('\n')),
    layer: 'smoke',
    expect: 'BLOCKED',
    note: 'T341/Q33：行为层也要拦得住（契约下线后只剩它）—— 真入口那条"兑现后要回头回私聊"会红',
  },
  {
    id: 'M5',
    file: 'src/index.js',
    anchor: /override: \{ \.\.\.sleepState\.override, until: now \+ EMERGENCY_QUIET_MS \},/,
    count: 1,
    apply: dropEmergencySave,
    layer: 'check-wb',
    expect: 'BLOCKED',
    note: '§50㉒/Q34：紧急态刷新 until 后不落盘 —— 重启会把进行中的紧急态打回旧 until（主人还在说话它却回去睡了）',
  },
  {
    id: 'M6',
    file: 'src/index.js',
    anchor: /override: \{ \.\.\.sleepState\.override, until: now \+ EMERGENCY_QUIET_MS \},/,
    count: 1,
    apply: dropEmergencySave,
    layer: 'smoke',
    expect: 'BLOCKED',
    note: 'T342/Q34：行为层也要拦得住 —— 真入口读状态文件，until 停在刷新前那个值',
  },
  // ⚠️ S-12 第五批（2026-10-05）：原 M7（打 panel/parts/14-script.html）已**退役** ——
  //    它对应的旧页判据随旧页下线，且该关切在现役控制台没有等价判据。
  //    去向登记在 docs/S12-CONTRACT-MIGRATION-1005.md §十三。
  {
    id: 'M8',
    file: 'src/index.js',
    // ⚠️ **2026-10-05（第 7 轮）重锚**：对象从内联字面量换成 `sleep: sleepRound,`（见 `dropSleepField` 上方）。
    anchor: /      sleep: sleepRound,\n/,
    count: 1,
    apply: dropSleepField,
    layer: 'check-wb',
    expect: 'BLOCKED',
    note: '§50㉔/Q37：reply 记录没有 sleep 字段 —— "这一轮是不是补看轮"又要靠人肉对表',
  },
  {
    id: 'M9',
    file: 'src/index.js',
    // ⚠️ **2026-10-05（第 7 轮）修 `apply`（不是锚点）**：`wakeKind` 那一格现在是
    //    **单行对象里的一段**，而旧 `apply` 在替换文本末尾留了一句行尾注释 ——
    //    那句 `//` 会把**同一行剩下的 `catchUp: … };` 一起注释掉**，
    //    于是产物是**语法错误**（`}）` 悬空）。`mutate.mjs` 会在语法闸门那里报 INVALID，
    //    而 INVALID 看起来与"没拦住"极像 —— 这正是本轮那个量尺（`mutate-lint.mjs`）
    //    查不出来的第二类腐烂：**锚点命中、apply 也变了内容，但产物跑不起来**。
    //    ⇒ 值取空的**语义一点没变**（"字段留着、值恒空"），只是不再往行中间插注释。
    anchor: /wakeKind: String\(sleepSnap\?\.wakeKind \|\| ''\),/,
    count: 1,
    apply: (src) => src.replace(
      "wakeKind: String(sleepSnap?.wakeKind || ''),",
      "wakeKind: '',",
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
    note: '§50㉔/Q37：字段留着、**值取空**（`wakeKind: \'\'`）—— 判"取自冻结的那份"，不是"有没有这个键"',
  },
  {
    id: 'M10',
    file: 'src/index.js',
    // ⚠️ **2026-10-05（第 7 轮）重锚**：与 M8 同一条（行为层那一腿）—— `sleep: sleepRound,`。
    anchor: /      sleep: sleepRound,\n/,
    count: 1,
    apply: dropSleepField,
    layer: 'smoke',
    expect: 'BLOCKED',
    note: 'T341/Q37：行为层也要拦得住 —— 真入口读 trace，找不到带 sleep 的 reply 行',
  },
];
