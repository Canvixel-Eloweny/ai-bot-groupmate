/**
 * 2026-10-01 代码审查批次（外包回执「未收口项」+ 独立发现 F-1）的变异清单 —— 纯数据，供
 * `node scripts/mutate.mjs test/mutations/review-1001.mjs` 复跑。
 *
 * 这一批改的全是**判据**（除 F-1 那两处一行改动），所以变异要回答的问题只有一个：
 * **新加严真的比旧判据强吗，还是只是把"绿"换了个写法？**
 *
 *   | 变异 | 打的是什么 | 该由哪一层拦住 | 期望 |
 *   |---|---|---|---|
 *   | M1 | 返回对象里多一个**6 空格缩进**的 status 键（旧文本扫描按"恰 4 空格"取键 → 看不见） | check-wb §50②（**运行时**键集） | BLOCKED |
 *   | M2 | `override,` 改成 `override: null,`（键在、值被抹掉 → 旧键集判据照样绿） | check-wb §50②（Q65 值断言） | BLOCKED |
 *   | M3 | 给 `override,` 加一段**行尾注释**，注释里带 `status:`（旧实现的已知误报） | ——（**应当不再红**） | NOT-BLOCKED |
 *   | M4 | 另开一处 `Object.assign(session, { unread })`（计数法看不见"按键写"） | check-wb §48③（Q61 语法机制禁令） | BLOCKED |
 *   | M5 | 删掉 `if (snap.asleep) return '';`（旧 T331 六条输入 asleep 恒 false → 删了不响） | smoke T331（Q67） | BLOCKED |
 *   | M6 | 存档记录里多挂一个键（C31 只看**源码字面**键集） | smoke T41f（Q71）· check-wb 的 C31 也会拦（两层，符合"配对才封闭"） | BLOCKED |
 *   | M7 | ~~取桶照算、但**结果不用**（P5a 的同一形态）~~ | ⚠️ **S-12 第六批退役**：裁判是 `test/verify-panel.mjs`（面板层），该文件已随旧页整块删除 | —（已删除） |
 *   | M8 | 删掉 `THINKING_FILE` 的 env 覆盖（F-1 的根因） | check-wb §37③b | BLOCKED |
 *   | M9 | 删掉 smoke 里 `QQBOT_THINKING_FILE` 那一行（"光有覆盖没人传"） | check-wb §37③b | BLOCKED |
 *   | M10 | 删掉沙箱 rsync 的 `--exclude 'panel/*.tmp'`（垃圾跟着进 /tmp） | check-wb §37③c | BLOCKED |
 *
 * ⚠️ 两条**刻意设计成"只由一层拦住"**的（M1，以及 M3 的"应当不红"），是这批变异里最有信息量的：
 *    它们正是"旧判据看不见、新判据才看得见"的那个差集。若某条变成"两层都红"，
 *    说明我加的静态判据过宽（又回到"靠形状穷举"那条老路），要回头收窄。
 *    （原来这条里并列的 **M7 已在 S-12 第六批退役** —— 它唯一的裁判 `test/verify-panel.mjs`
 *      随旧页整块删除；⚠️ 它盯的那个缺口**今天仍可能静态过关**，见文件里 M7 原位那段说明
 *      与 `docs/S12-CONTRACT-MIGRATION-1005.md` §十四。这是本批唯一一处覆盖损失。）
 *
 * ⚠️ 本机 shell 注入的 `NODE_OPTIONS` 会把 `err.code` 改写成 `CODEBUDDY_BROKER_DENY`（R39）
 *    —— 跑测试要 `NODE_OPTIONS= node …`。
 */

export default [
  {
    id: 'M1',
    file: 'src/sleep.js',
    anchor: /^    override,$/m,
    count: 1,
    apply: (src) => src.replace(/^    override,$/m, "    override,\n        status: 'asleep',"),
    layer: 'check-wb',
    expect: 'BLOCKED',
    note: '§50②：6 空格缩进的顶层 status —— 旧文本扫描（恰好 4 空格）看不见它，靠新加的运行时键集判据拦',
  },
  {
    id: 'M2',
    file: 'src/sleep.js',
    anchor: /^    override,$/m,
    count: 1,
    apply: (src) => src.replace(/^    override,$/m, '    override: null,'),
    layer: 'check-wb',
    expect: 'BLOCKED',
    note: '§50②/Q65：键还在、值被抹掉（叫醒态每次读盘都被清）—— 旧键集判据照样绿',
  },
  {
    id: 'M3',
    file: 'src/sleep.js',
    anchor: /^    override,$/m,
    count: 1,
    apply: (src) => src.replace(/^    override,$/m, "    override, // status: 'asleep' 是上一次的写法"),
    layer: 'check-wb',
    expect: 'NOT-BLOCKED',
    note: '§50②：行尾注释里的 status: —— 这是**旧实现的误报**，本批修好后应当**不再红**（注释不是键）',
  },
  {
    id: 'M4',
    file: 'src/bridge-io.js',
    anchor: /session\.unread = r\.items;/g,
    count: 2,
    apply: (src) => src.replace(
      'session.unread = r.items;',
      'Object.assign(session, { unread: r.items });\n    session.unread = r.items;',
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
    note: '§48③/Q61：另开一处"按键写"（保留原行，所以点号计数仍是 2 —— 只有新加的语法机制禁令能拦）',
  },
  {
    id: 'M5',
    file: 'src/reply-text.js',
    anchor: /if \(snap\.asleep\) return '';/,
    count: 1,
    apply: (src) => src.replace(/if \(snap\.asleep\) return '';/, '/* 守卫被删：W12a 的形态 */'),
    layer: 'smoke',
    expect: 'BLOCKED',
    note: 'T331/Q67：旧的六条输入 asleep 恒 false，删守卫照样绿；补的两条（睡+喊醒 / 睡+紧急）才拦得住',
  },
  {
    id: 'M6',
    file: 'src/session-archive.js',
    anchor: /^      key: s\.key,$/m,
    count: 1,
    apply: (src) => src.replace(/^      key: s\.key,$/m, '      key: s.key,\n      probe: 1,'),
    layer: 'smoke',
    expect: 'BLOCKED',
    note: 'T41f/Q71：记录多挂一个键 —— 静态白名单（C31）与运行时键集（新加的）是两件事，这条走行为层',
  },
  // ⚠️ S-12 第六批（2026-10-05）：原 **M7**（layer: 'panel'）已**退役** ——
  //    它打的是 `panel/server.js` 里 `readUsage` 的"取桶照算、结果不用"那个形态，
  //    而**拦它的唯一裁判是 `test/verify-panel.mjs` 的 bySource 行为断言**（面板层）。
  //    那份文件已随旧页（`panel/parts/` + `page-parts.js`）整块删除 ⇒ 裁判不存在了。
  //    ⚠️ **不是"这条缺陷已经不可能发生"**：静态那一侧（`check-wb` §47 第 ⑥ 组）
  //       只能看出"动作发生过"，逗号表达式/直接丢值那种改写今天仍可能静态过关。
  //       ⇒ 这是本批**唯一**一处"关切没有等价物"的覆盖损失，登记在
  //          `docs/S12-CONTRACT-MIGRATION-1005.md` §十四（含补它的正路：
  //          给 `panel/next/verify.mjs` 加一条真渲染断言，不在本批范围）。
  //    ⚠️ 也**不许**把它改成 layer: 'smoke' 或 'check-wb' 蒙过去 —— 那两个层
  //       本来就拦不住它，改了只会得到一条 NOT-BLOCKED 的假账。
  {
    id: 'M8',
    file: 'src/bridge-io.js',
    anchor: /const THINKING_FILE = process\.env\.QQBOT_THINKING_FILE/,
    count: 1,
    apply: (src) => src.replace(
      /const THINKING_FILE = process\.env\.QQBOT_THINKING_FILE\n  \|\| path\.join\(ROOT, 'panel', '\.thinking\.json'\);/,
      "const THINKING_FILE = path.join(ROOT, 'panel', '.thinking.json');",
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
    note: '§37③b/F-1：删掉 env 覆盖 → 测试把"正在生成"写进用户真实文件，并留下临时文件垃圾',
  },
  {
    id: 'M9',
    file: 'test/smoke.js',
    anchor: /QQBOT_THINKING_FILE: thfile,/,
    count: 1,
    apply: (src) => src.replace(/\n *QQBOT_THINKING_FILE: thfile,/, ''),
    layer: 'check-wb',
    expect: 'BLOCKED',
    note: '§37③b：光是 src 侧有覆盖、smoke 不传 = 没隔离（与 EFFECTIVE_FILE 那条同形）',
  },
  {
    id: 'M10',
    file: 'test/sandbox.sh',
    anchor: /--exclude 'panel\/\*\.tmp'/,
    count: 1,
    apply: (src) => src.replace(/\n *--exclude 'panel\/\*\.tmp' \\/, ''),
    layer: 'check-wb',
    expect: 'BLOCKED',
    note: "§37③c：沙箱不再排除原子写临时文件 → 每跑一次就把它们复制进 /tmp",
  },
];
