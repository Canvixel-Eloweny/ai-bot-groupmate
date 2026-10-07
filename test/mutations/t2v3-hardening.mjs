/**
 * 任务2 v3 回执 · **形态面收口**批的变异清单（2026-09-30 · 收口轮）。
 *
 * 背景：v3 回执（`~/Desktop/外包/Qoder CN/任务2v3回执-加严复核与Q47-Q57收口-0930.md`）
 * 用"同缺陷换写法"打出了 8 条加严可绕的写法。**但在本仓重测后**（收口轮的第一动作），
 * 其中 7 条已被 `Q36`（提交 `b6eeb2a`）**提前收口** —— 回执是在 09-30 19:37 的发布拷贝上
 * 跑的，那份**不含 Q36 的五处静态层加严**。
 *
 * 本文件只收**在本仓实测仍然漏**、且按"只对『静态层漏 **且** 行为层也漏』的加严"这条
 * 取舍原则必须收的那几条：
 *
 *   | id | 回执编号 | 换写法 | 收口方式 |
 *   |---|---|---|---|
 *   | H1 | P4a（← Q27） | `Reflect.get(rec, 's')` 读来源字段 | §47⑤ 正则补 Reflect.get 形态 |
 *   | H2 | P4b（← Q27） | `` rec[`s`] `` 反引号方括号 | §47⑤ 方括号引号类补反引号 |
 *   | H3 | P7a（← Q54） | 别名调用（第 5 个判定点） | §50 补数 `refreshSleep` **标识符**（恰 5） |
 *   | H4 | P7c（← Q54） | `queueMicrotask(() => refreshSleep())` | §50 直接**禁掉** queueMicrotask + §50⑫ 补 `applyWake` |
 *   | H5 | d31-1 **M11**（← Q68） | 把迁移留痕降级成 debug | §50 两处 journal **各自点名**（`journal('sleep'` / `journal('wake'`） |
 *
 *   ⚠️ H1/H2 是**静态层漏但行为层兜住**（T307 会红）—— 按纪律本可不收；
 *      这里收是因为成本只有一行正则，而"靠行为层兜着"在行为层下线后就没人知道了。
 *   ⚠️ H3/H4 是**双层皆绿**（回执的 `C-P7a` / `B-P7c` 都是 NOT-BLOCKED）—— 必须收。
 *   ⚠️ H4 会同时命中两条（queueMicrotask 计数 + applyWake 函数体）—— 这是**有意**的
 *      纵深：一条是"这个 API 不许出现"，一条是"这个函数体里不许有调度"。两条都要在。
 *   ⚠️ 未收的两条（P2b/P2c 解构与 Object.assign 清空未读 · P5a 取桶结果被逗号表达式丢弃）
 *      见台账 §4 的 Q 条目：前者行为层可达时兜得住，后者要另设计判据。**如实登记，不假装收了口。**
 *
 * 期望：四条全部 `BLOCKED`，`INVALID` 为 0。
 * ⚠️ 跑测试一律 `NODE_OPTIONS= node …`（R39）。
 */

export default [
  {
    id: 'H1',
    note: 'P4a 收口：`Reflect.get(rec, \'s\')` 读来源字段进限额（连"方括号"这个词都不出现）',
    file: 'src/usage.js',
    anchor: /^export function tokenTotalOf\(rec\) \{$/m,
    count: 1,
    apply: (s) => s.replace(
      'export function tokenTotalOf(rec) {',
      "export function tokenTotalOf(rec) {\n  if (rec && Reflect.get(rec, 's')) return 0; // mutation: Reflect.get source"
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'H2',
    note: 'P4b 收口：模板串键 rec[`s`] 读来源字段（方括号的第三种引号）',
    file: 'src/usage.js',
    anchor: /^export function tokenTotalOf\(rec\) \{$/m,
    count: 1,
    apply: (s) => s.replace(
      'export function tokenTotalOf(rec) {',
      'export function tokenTotalOf(rec) {\n  if (rec && rec[`s`]) return 0; // mutation: template-string key'
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'H3',
    note: 'P7a 收口：别名调用多开一个判定点（refreshSleep(); 计数不变，标识符变 6）',
    file: 'src/index.js',
    anchor: /^      refreshSleep\(\);\n      writeEffective\(cfg\);$/m,
    count: 1,
    apply: (s) => s.replace(
      '      refreshSleep();\n      writeEffective(cfg);',
      '      refreshSleep();\n      const rsHot = refreshSleep;\n      rsHot(); // mutation: alias call (5th refresh point)\n      writeEffective(cfg);'
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'H4',
    note: 'P7c 收口：queueMicrotask 另开一条调度（比 setTimeout 更隐蔽，任何定时器计数都看不到）',
    file: 'src/index.js',
    anchor: /^  function applyWake\(override, reason, \{ skipKey = '' \} = \{\}\) \{$/m,
    count: 1,
    apply: (s) => s.replace(
      "  function applyWake(override, reason, { skipKey = '' } = {}) {",
      "  function applyWake(override, reason, { skipKey = '' } = {}) {\n    queueMicrotask(() => refreshSleep()); // mutation: microtask scheduling"
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'H5',
    note: 'Q68 收口：把**迁移留痕**降级为 debug（睡眠那一处 journal 被换掉 —— 第二处 journal 曾把这道门撑大）',
    file: 'src/index.js',
    anchor: /^        journal\('sleep', status === SLEEP_STATUS\.asleep$/m,
    count: 1,
    apply: (s) => s.replace(
      "        journal('sleep'",
      "        log.debug('sleep'"
    ),
    // 就是 d31-1 的 **M11** —— 它在原契约下**双层皆绿**（check-wb 的 `includes('journal(')`
    // 被同函数里的 `journal('wake'` 满足；行为层也没有睡眠 journal 断言）。
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
];
