/**
 * D31-1（睡眠 / 作息骨架）的变异清单 —— 纯数据，供
 * `node scripts/mutate.mjs test/mutations/d31-1.mjs` 复跑。
 *
 * 为什么每一步都要配变异：睡着的失效形态是**静默地不响应** ——
 *   · 门禁位置错 → 那条消息被"处理完了"（用户以为它看见了，其实它睡着了）；
 *   · 门禁排到 decide 之后 → 白跑一次模型（花了 token 却不回话）；
 *   · 落盘存了 status → 重启后拿昨天的状态过今天；
 *   · 默认被翻成开 → 用户从没同意过"半夜不说话"，而这是行为面变更；
 *   · 排到定时消息之后 → 睡着时照样发早安；
 *   · 留痕被摘 → "它昨晚几点睡的"永远查不到（一道删了不会响的门）。
 *
 *   | 组  | 打的是 | 该由哪一层拦住 |
 *   |---|---|---|
 *   | M1  | 判据叶子长出依赖 | check-wb §50 ① |
 *   | M2  | 判据叶子直接读时钟 | check-wb §50 ① |
 *   | M3  | 落盘形状里塞进 `status`（状态自证） | check-wb §50 ② |
 *   | M4  | 门禁搬到 `decide` 之后（白花一次模型） | check-wb §50 ③ |
 *   | M5  | 门禁被摘掉（睡着照样回话） | check-wb §50 ③ |
 *   | M6  | 默认翻成开 | check-wb §50 ④ + smoke T323 |
 *   | M7  | 新开一条定时器 | check-wb §50 ⑤ |
 *   | M8  | 主动链睡眠闸排到定时消息之后 | check-wb §50 ⑦ |
 *   | M9  | `effective` 少一节（面板看不见它睡没睡） | check-wb §50 ⑧ |
 *   | M10 | 路径手写（绕开 DATA_DIR，测试会写进真机目录） | check-wb §50 ⑥ |
 *   | M11 | 迁移留痕降级成 debug（默认级别不输出） | check-wb §50 ② |
 *
 * 期望：十一条全部 `BLOCKED`，`INVALID` 为 0。
 *
 * ⚠️ 跑这一批时若看到 `[safe-delete]`，那是**沙箱的批量删除保护**在冒充"被拦住"
 *    （不是断言失败）—— 换前台 + 非沙箱复跑同一组再下结论（R33/R34/R36 同款）。
 * ⚠️ 另：本机 shell 注入的 `NODE_OPTIONS` 会把 `err.code` 改写成 `CODEBUDDY_BROKER_DENY`
 *    （D17 批实测：T293/T296 因此假红）—— 跑测试要 `NODE_OPTIONS= node …`。
 */

/** 主链路的睡眠门禁块（整块搬移 / 摘除都用它当锚点）
 *  ⚠️ **2026-10-05（第 7 轮 · 惰性体检）**：块里后来多了一行 `forward: forwardStat,`
 *     （D23-2 给 skip 记录补的那一格）⇒ 这份常量与真代码**逐字对不上**了 ⇒
 *     M4 / M5 的 `apply` **静默空转**（锚点仍命中，锚点体检与 mutate 的 ③ 都看不见）。
 *     常量是"整块搬移"的**唯一来源**，所以它一旦漂，搬走的就不是那一块了 ——
 *     这类常量每次真代码改动都要跟着核。 */
const GATE = `    if (sleepSnap?.asleep) {
      writeSkip({
        traceId, stage: 'sleep', scene, id, sender,
        text: \`\${sender}: \${parsed.text}\`,
        reason: \`它在睡觉（计划 \${sleepSnap.bed}–\${sleepSnap.wake}）\`,
        model: cfg.llm.model, baseUrl: cfg.llm.baseUrl,
        // 睡着时**不消费未读** ⇒ 这里如实是 null（不是"处理了 0 条"）。
        unread: null,
        forward: forwardStat,
      });
      log.info(\`[\${traceId}] 休眠中跳过 \${session ? session.key : store.key(scene, id)} \${sender}: \${truncate(parsed.text)}\`);
      return;
    }`;

/** ⚠️ **2026-10-05（第 7 轮）**：这一行也漂了 —— M-4（2026-10-04 审查轮）给 `decide()`
 *  加了第四个参数（`{ repliedToMe }`，把"引用了我的话"算进"被叫到"）。
 *  M4 的"把门禁搬到 decide 之后"靠它定位，对不上就整条空转。 */
const DECIDE_LINE = '    const decision = brain.decide(session, evt, parsed, { repliedToMe });';
/** tickProactive 里的睡眠闸（一行） */
const GATE_TP = '    if (sleepSnap?.asleep) return;';

export default [
  {
    id: 'M1',
    note: '判据叶子长出依赖（反例再也喂不进去，只能靠真机等一晚）',
    file: 'src/sleep.js',
    anchor: /^export const SLEEP_DEFAULTS = Object\.freeze\(\{$/m,
    count: 1,
    apply: (s) => s.replace(
      'export const SLEEP_DEFAULTS = Object.freeze({',
      "import fs from 'node:fs'; // 变异：叶子不许有依赖\nexport const SLEEP_DEFAULTS = Object.freeze({"
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M2',
    note: '判据叶子直接读时钟（判定再也没法在测试里逐格喂）',
    file: 'src/sleep.js',
    anchor: /^  const off = \{ disabled: true, reason: '', inWindow: false, bedAt: 0, wakeAt: 0, cycleKey: '' \};$/m,
    count: 1,
    apply: (s) => s.replace(
      "  const off = { disabled: true, reason: '', inWindow: false, bedAt: 0, wakeAt: 0, cycleKey: '' };",
      "  const off = { disabled: true, reason: '', inWindow: false, bedAt: Date.now(), wakeAt: 0, cycleKey: '' }; // 变异：叶子里读时钟"
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M3',
    note: '落盘形状里塞进 status（于是"上一次写入时的状态"开始决定今天）',
    file: 'src/sleep.js',
    anchor: /^    version: 1,\n    cycleKey: String\(raw\.cycleKey \?\? ''\),$/m,
    count: 1,
    apply: (s) => s.replace(
      "    version: 1,\n    cycleKey: String(raw.cycleKey ?? ''),",
      "    version: 1,\n    status: String(raw.status ?? ''), // 变异：存了状态\n    cycleKey: String(raw.cycleKey ?? ''),"
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M4',
    note: '门禁搬到 `decide` 之后（睡着了也先跑一次模型：白花 token，且那条消息被"处理完了"）',
    file: 'src/index.js',
    anchor: /^    if \(sleepSnap\?\.asleep\) \{$/m,
    count: 1,
    apply: (s) => s.replace(GATE, '    // 变异：门禁被搬走了').replace(DECIDE_LINE, `${DECIDE_LINE}\n${GATE}`),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M5',
    note: '门禁被摘掉（睡着照样回话 —— 这一批最核心的一行）',
    file: 'src/index.js',
    anchor: /^    if \(sleepSnap\?\.asleep\) \{$/m,
    count: 1,
    apply: (s) => s.replace(GATE, '    // 变异：门禁被摘掉'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M6',
    note: '默认翻成开（用户从没同意过"半夜不说话"，而那是行为面变更）',
    file: 'src/custom-config.js',
    anchor: /^  sleep: \{ \.\.\.SLEEP_DEFAULTS \},$/m,
    count: 1,
    apply: (s) => s.replace(
      '  sleep: { ...SLEEP_DEFAULTS },',
      '  sleep: { ...SLEEP_DEFAULTS, enabled: true }, // 变异：默认开了'
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M7',
    note: '新开一条定时器（忘记"挂在既有 30 秒 tick 上"这条纪律）',
    file: 'src/index.js',
    anchor: /^  \}, 30000\);$/m,
    count: 1,
    apply: (s) => s.replace(
      '  }, 30000);',
      '  }, 30000);\n  setInterval(() => refreshSleep(), 30000); // 变异：新开了一条调度'
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M8',
    note: '主动链睡眠闸排到定时消息**之后**（睡着时照样发早安）',
    file: 'src/index.js',
    anchor: /^    if \(sleepSnap\?\.asleep\) return;$/m,
    count: 1,
    apply: (s) => s
      .replace(`${GATE_TP}\n`, '')
      .replace(
        'for (const s of c.trigger?.scheduled || []) {',
        `for (const s of c.trigger?.scheduled || []) {\n    ${GATE_TP.trim()} // 变异：排到定时消息之后`
      ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M9',
    note: '`effective` 少一节（后端算了却没人看 —— 面板上看不见它睡没睡）',
    file: 'src/index.js',
    // ⚠️ 锚点修正（2026-09-30 · 收口轮，采纳外包任务2 v3 的 Q69 抽检结论）：
    //    原锚点 `^      sleep: sleepSnap,$` 在 index.js 里**命中 2**（effective 快照 + 提示词装配），
    //    于是这条变异**一直是 INVALID、从来没有真正跑过**。改成"从 updatedAt 数到 sleep 这一行、
    //    中间恰好三条注释"的确定形状 —— 唯一命中 effective 那一处。
    //    ⚠️ 契约侧也一并补了"两处各自都要在"的计数判据（§50⑧），否则本条照样会假绿。
    anchor: /^      updatedAt: Date\.now\(\),\n(?:      \/\/[^\n]*\n){3}      sleep: sleepSnap,$/m,
    count: 1,
    apply: (s) => s.replace(
      /^(      updatedAt: Date\.now\(\),\n)(?:      \/\/[^\n]*\n){3}(      sleep: sleepSnap,)$/m,
      '$1      // mutation: effective no longer publishes the sleep snapshot'
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M10',
    note: '路径手写（绕开 DATA_DIR —— 测试会写进真机目录）',
    file: 'src/index.js',
    anchor: /^const SLEEP_FILE = path\.join\(DATA_DIR, 'sleep-state\.json'\);$/m,
    count: 1,
    apply: (s) => s.replace(
      "const SLEEP_FILE = path.join(DATA_DIR, 'sleep-state.json');",
      "const SLEEP_FILE = path.join(ROOT, 'data', 'sleep-state.json'); // 变异：手写路径"
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M11',
    note: '迁移留痕降级成 debug（默认日志级别不输出 → "它昨晚几点睡的"永远查不到）',
    file: 'src/index.js',
    anchor: /^        journal\('sleep', status === SLEEP_STATUS\.asleep$/m,
    count: 1,
    apply: (s) => s.replace(
      "        journal('sleep', status === SLEEP_STATUS.asleep",
      "        log.debug('sleep', status === SLEEP_STATUS.asleep"
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
];
