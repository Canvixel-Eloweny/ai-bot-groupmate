/**
 * D29（判定可见性 + 账务按来源分）的变异清单 —— 纯数据，供
 * `node scripts/mutate.mjs test/mutations/d29.mjs` 复跑。
 *
 * 为什么每一步都要配变异：这一批的每一处判错**都不会报错**，只会安静地变错 ——
 *   · 账本少写来源列 → 账照记、界面照显示，只是"今天这些 token 是谁花的"永远答不出；
 *   · 某个调用点忘了声明来源 → 那一族的账全归"未标注"（看着像"没花多少"）；
 *   · 判定卡没接线 / 另一处写 trace → 旁路判定的过程依旧不可见，或截断与缓存采样两边漂；
 *   · 来源混进限额计算 → D8 的三档熔断莫名收紧，而没有任何门会响；
 *   · 判定卡混进会话聚合 → "回复数"虚高、列表里多一张没有内容的白卡；
 *   · 面板自带一份来源枚举 / 标签表漏一个 → 加第四个来源时页面冒出英文裸键。
 *
 *   | 组  | 打的是 | 该由哪一层拦住 |
 *   |---|---|---|
 *   | M1  | 账本不写来源列（归因凭空消失） | check-wb §47 ① |
 *   | M2  | 来源列猜一个默认值（老记录被"回填"） | check-wb §47 ① |
 *   | M3  | 主回复忘声明来源 | check-wb §47 ② |
 *   | M4  | 记忆判官的账算到主回复头上（来源写错） | check-wb §47 ② |
 *   | M5  | 主动话题忘声明来源 | check-wb §47 ② |
 *   | M6  | 新开第四个记账调用点（一条没登记的旁路） | check-wb §47 ② |
 *   | M7  | 判定卡另开一处写 trace（截断/采样漂移） | check-wb §47 ③ |
 *   | M8  | 判定卡定义了却没接线（onResult 不传） | check-wb §47 ③ |
 *   | M9  | 记忆模块自己写 trace（判据层长出落盘依赖） | check-wb §47 ③ |
 *   | M10 | 来源参与限额计算（判定类的账被排除） | check-wb §47 ⑤ + smoke T307 |
 *   | M11 | 页面自带来源枚举（与服务端那份漂移） | check-wb §47 ⑥ |
 *   | M12 | 标签表漏一个来源（页面冒出英文裸键） | check-wb §47 ⑥ |
 *   | M13 | 判定卡混进会话聚合（"回复数"虚高） | check-wb §47 ⑦ |
 *
 * 期望：十三条全部 `BLOCKED`，`INVALID` 为 0。
 *
 * ⚠️ 跑这一批时若看到 `[safe-delete]`，那是**沙箱的批量删除保护**在冒充"被拦住"
 *    （不是断言失败）—— 换前台 + 非沙箱复跑同一组再下结论（R33/R34/R36 同款）。
 * ⚠️ 另：本机 shell 注入的 `NODE_OPTIONS` 会把 `err.code` 改写成 `CODEBUDDY_BROKER_DENY`
 *    （D17 批实测：T293/T296 因此假红）—— 跑测试要 `NODE_OPTIONS= node …`。
 */

export default [
  {
    id: 'M1',
    note: '账本不写来源列 —— 三个调用点照旧各自声明，但那一列在落盘时被抹掉（归因凭空消失）',
    file: 'src/usage.js',
    anchor: /^        s: u\.source \|\| '',$/m,
    count: 1,
    apply: (s) => s.replace("        s: u.source || '',", "        // 变异：不写来源列"),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M2',
    note: '来源列猜一个默认值（老记录 / 未声明来源的被"回填"成 agent）—— 这是不许做的猜',
    file: 'src/usage.js',
    anchor: /^        s: u\.source \|\| '',$/m,
    count: 1,
    apply: (s) => s.replace("        s: u.source || '',", "        s: u.source || 'agent', // 变异：猜一个默认来源"),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M3',
    note: '主回复那一处忘了声明来源 —— 主回复的账会整族归进"未标注"',
    file: 'src/index.js',
    anchor: /^    if \(llm\.lastUsage\) recordUsage\(\{ \.\.\.llm\.lastUsage, chat: session\.key, source: USAGE_SOURCES\.agent \}\);$/m,
    count: 1,
    apply: (s) => s.replace(
      '    if (llm.lastUsage) recordUsage({ ...llm.lastUsage, chat: session.key, source: USAGE_SOURCES.agent });',
      '    if (llm.lastUsage) recordUsage({ ...llm.lastUsage, chat: session.key }); // 变异：漏了来源'
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M4',
    note: '记忆判官的账算到主回复头上（来源字面量写错）—— 分来源统计从此系统性偏移',
    file: 'src/memory.js',
    anchor: /^    recordUsage\(\{ \.\.\.usage, chat: chatKey, source: USAGE_SOURCES\.memoryJudge \}\);$/m,
    count: 1,
    apply: (s) => s.replace(
      '    recordUsage({ ...usage, chat: chatKey, source: USAGE_SOURCES.memoryJudge });',
      '    recordUsage({ ...usage, chat: chatKey, source: USAGE_SOURCES.agent }); // 变异：来源写错'
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M5',
    note: '主动话题那一处忘了声明来源（它故意不带会话键，于是只能靠这一列认出它）',
    file: 'src/index.js',
    anchor: /^      recordUsage\(\{ \.\.\.usage, source: USAGE_SOURCES\.proactiveTopic \}\);$/m,
    count: 1,
    apply: (s) => s.replace(
      '      recordUsage({ ...usage, source: USAGE_SOURCES.proactiveTopic });',
      '      recordUsage(usage); // 变异：漏了来源'
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M6',
    note: '新开第四个记账调用点（一条没登记的、会花钱的旁路）',
    file: 'src/index.js',
    anchor: /^    if \(llm\.lastUsage\) recordUsage\(\{ \.\.\.llm\.lastUsage, chat: session\.key, source: USAGE_SOURCES\.agent \}\);$/m,
    count: 1,
    apply: (s) => s.replace(
      '    if (llm.lastUsage) recordUsage({ ...llm.lastUsage, chat: session.key, source: USAGE_SOURCES.agent });',
      '    if (llm.lastUsage) recordUsage({ ...llm.lastUsage, chat: session.key, source: USAGE_SOURCES.agent });\n'
        + '    recordUsage({ ...llm.lastUsage, chat: session.key, source: USAGE_SOURCES.agent }); // 变异：旁路多记一笔'
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M7',
    note: '判定卡另开一处写 trace（绕开唯一写入点 → 折半截断与缓存采样必然漂移）',
    file: 'src/bridge-io.js',
    anchor: /^function writeJudgeCard\(info\) \{\n  writeTrace\(\{$/m,
    count: 1,
    apply: (s) => s.replace(
      "function writeJudgeCard(info) {\n  writeTrace({",
      "function writeJudgeCard(info) {\n  fs.appendFileSync(TRACE_FILE, ''); // 变异：另开一处写 trace\n  writeTrace({"
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M8',
    note: '判定卡定义了却没接线（宿主不再把 onResult 交给判官）—— 函数在那儿，卡一张都不会出现',
    file: 'src/index.js',
    anchor: /^      onResult: \(rep\) => writeJudgeCard\(\{$/m,
    count: 1,
    apply: (s) => s.replace(
      '      onResult: (rep) => writeJudgeCard({',
      '      onJudge: (rep) => writeJudgeCard({ // 变异：回调名不对，判官永远叫不响它'
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M9',
    note: '记忆模块自己写 trace（判据层长出落盘依赖，"写哪里"不再由宿主说了算）',
    file: 'src/memory.js',
    anchor: /^    return \{\n      parsed: parseJudge\(out\),$/m,
    count: 1,
    apply: (s) => s.replace(
      '    return {\n      parsed: parseJudge(out),',
      "    fs.appendFileSync(TRACE_FILE, ''); // 变异：记忆模块自己写 trace\n    return {\n      parsed: parseJudge(out),"
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M10',
    note: '来源混进限额计算：判定类的账被排除在当日总量之外 —— D8 的三档熔断会莫名收紧',
    file: 'src/usage.js',
    anchor: /^    const n = tokenTotalOf\(r\);$/m,
    count: 1,
    apply: (s) => s.replace(
      '    const n = tokenTotalOf(r);',
      "    if (r.s === 'memoryJudge') continue; // 变异：来源参与计算\n    const n = tokenTotalOf(r);"
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M11',
    note: '现役面板自带一份来源枚举（与服务端那份漂移：加了来源两边不同步）。⚠️ S-12 第五批：取源已从旧页 panel/parts/14-script.html 切到现役页 panel/next/app.js',
    file: 'panel/next/app.js',
    anchor: /^const TOKEN = /m,
    count: 1,
    apply: (s) => s.replace(/^const TOKEN = /m, "const GHOST_SRC = 'memoryJudge';\nconst TOKEN = "),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M12',
    note: '标签表漏一个来源 —— 加来源时页面会冒出一个英文裸键，而没有任何门会响',
    file: 'panel/lib/usage-report.js',
    // ⚠️ 第 22 轮：这一族搬进 lib 时**整块缩进了 2 格** ⇒ 锚点跟着改（缩进也是形状）。
    anchor: /^ {4}memoryJudge: '记忆判定',$/m,
    count: 1,
    apply: (s) => s.replace("    memoryJudge: '记忆判定',", "    // 变异：少了 memoryJudge 的标签"),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M13',
    note: '判定卡混进会话聚合（`count` 对每条记录都加 → "回复数"虚高、列表里多一张白卡）',
    file: 'panel/lib/sessions.js',
    anchor: /^    if \(isJudgeCard\(r\)\) continue;.*$/m,
    count: 1,
    apply: (s) => s.replace(
      '    if (isJudgeCard(r)) continue; // 判定卡不是这个会话的一条消息（见 isJudgeCard 的注释）',
      '    // 变异：不过滤判定卡'
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
];
