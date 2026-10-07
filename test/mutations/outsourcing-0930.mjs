/**
 * 外包回执采纳批（2026-09-30）的变异清单 —— 纯数据，供
 * `node scripts/mutate.mjs test/mutations/outsourcing-0930.mjs` 复跑。
 *
 * 来源：任务1 v7 回执（D29/D30 施工复核）与任务2 v2 回执（§47–§50 补审）里
 * **被证实为"双层皆绿 / 静态可绕"的那几条**。每条对应一处加严后的新判据。
 *
 *   | 组  | 打的是 | 该由哪一层拦住 |
 *   |---|---|---|
 *   | N1  | unread.js 导出名单外多一个函数（清空类换个名字就绕过黑名单，Q49） | check-wb §48 ② |
 *   | N2  | 方括号形态另开一处清空 `session['unread'] = []`（Q50） | check-wb §48 ③ |
 *   | N3  | 判定卡进了会话存档（Q55：此前只有注释声称，没有护栏） | check-wb §48 ⑤ |
 *   | N4  | 来源字段用**可选链**读进限额（Q27：`?.` 写法静态层漏） | check-wb §47 ⑤ |
 *   | N5  | 按来源取桶的动作被改名（Q28：页面永远显示空表而无人报） | check-wb §47 ⑥ |
 *   | N6  | 落盘形状里**行尾内联**塞 `status`（Q53：键数扫描照样绿） | check-wb §50 ② |
 *   | N7  | 定时器**别名声明**（Q54：只数 `setInterval(` 拦不住） | check-wb §50 ⑤ |
 *   | N8  | 运行态写进 config.json（Q56：refreshSleep 里没有这条反向断言） | check-wb §50 ② |
 *   | N9  | server.js 里改名复辟一份 CRC/ZIP（Q52：只认名字拦不住） | check-wb §49 ① |
 *   | N10 | 热重载不重算睡眠（Q29：面板上开了作息要等 30 秒才拦） | check-wb §50 ⑤ |
 *
 * 期望：十条全部 `BLOCKED`，`INVALID` 为 0。
 *
 * ⚠️ 跑测试一律 `NODE_OPTIONS= node …`（R39）。
 */

export default [
  {
    id: 'N1',
    note: 'unread.js 导出名单外多一个函数（黑名单天生被换名绕 → 改白名单）',
    file: 'src/unread.js',
    anchor: /^export function consume\(list, ids\) \{$/m,
    count: 1,
    apply: (s) => s.replace(
      'export function consume(list, ids) {',
      'export function purgeAll() { return []; }\n\nexport function consume(list, ids) { // 变异：名单外多了一个导出'
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'N2',
    note: '方括号形态另开一处清空（点号正则拦不住，S15/G3 双层皆绿）',
    file: 'src/bridge-io.js',
    anchor: /^function noteUnread\(session, info\) \{$/m,
    count: 1,
    apply: (s) => s.replace(
      'function noteUnread(session, info) {',
      "function noteUnread(session, info) {\n  if (info && info.now === -7) session['unread'] = []; // 变异：方括号另开一处清空"
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'N3',
    note: '判定卡进了会话存档（此前只有注释声称，删掉也不会响）',
    file: 'src/session-archive.js',
    // ⚠️ 锚点选 archiveOf **映射体里**的那一行（唯一）：往返回对象里插键必须插在
    //    真正产出记录的那一层，插错位置要么语法炸（N3 第一版）、要么根本不进存档形状。
    anchor: /^      key: s\.key,$/m,
    count: 1,
    apply: (s) => s.replace(
      /^      key: s\.key,$/m,
      "      key: s.key,\n      judge: true, // 变异：判定卡进了存档"
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'N4',
    note: '来源字段用可选链读进限额（`?.` 写法静态层漏，行为层才兜住）',
    file: 'src/usage.js',
    anchor: /^export function tokenTotalOf\(/m,
    count: 1,
    apply: (s) => s.replace(
      'export function tokenTotalOf(',
      "export function tokenTotalOf(\n  // 变异：可选链读来源\n  _guard = (typeof rec !== 'undefined' && rec?.s === 'memoryJudge') ? 0 : 0,"
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'N5',
    note: '按来源取桶的动作被改名（页面从此永远显示空表而无人报）',
    file: 'panel/lib/usage-report.js',
    // ⚠️ `bySrc.get(` 在文件里出现 **2** 次 —— 锚点必须钉在**带上下文的整行**上（唯一），
    //    否则"锚点 2/1"直接 INVALID（2026-09-30 实测）。
    // ⚠️ 第 22 轮：这一族搬进 lib 时整块缩进 2 格 ⇒ 锚点跟着改（缩进也是形状）。
    anchor: /^ {8}const bucket = bySrc\.get\(String\(r\.s \|\| ''\)\) \|\| unmarked;$/m,
    count: 1,
    apply: (s) => s.replace(
      /^ {8}const bucket = bySrc\.get\(String\(r\.s \|\| ''\)\) \|\| unmarked;$/m,
      "        const bucket = bySrcLookup(String(r.s || '')) || unmarked; // 变异：取桶动作被改名"
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'N6',
    note: '落盘形状里行尾内联塞 status（键数扫描照样绿，FG50-1）',
    file: 'src/sleep.js',
    anchor: /^    override,$/m,
    count: 1,
    apply: (s) => s.replace('    override,', "    override, status: 'asleep', // 变异：行尾内联"),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'N7',
    note: '定时器别名声明（只数 `setInterval(` 拦不住，FG50-2）',
    file: 'src/index.js',
    anchor: /^  setInterval\(\(\) => \{$/m,
    count: 1,
    apply: (s) => s.replace(
      '  setInterval(() => {',
      '  const ivAlias = setInterval; // 变异：别名声明\n  void ivAlias;\n  setInterval(() => {'
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'N8',
    note: '运行态写进 config.json（refreshSleep 里此前没有这条反向断言）',
    file: 'src/index.js',
    anchor: /^  function refreshSleep\(\) \{$/m,
    count: 1,
    apply: (s) => s.replace(
      '  function refreshSleep() {',
      '  function refreshSleep() {\n    writeConfig(cfg); // 变异：运行态写进配置'
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'N9',
    note: 'server.js 改名复辟一份 CRC/ZIP（只认名字拦不住，FG49-2）',
    file: 'panel/server.js',
    anchor: /^import \{ createHash \} from 'node:crypto';$/m,
    count: 1,
    apply: (s) => s.replace(
      /^import \{ createHash \} from 'node:crypto';$/m,
      "const CRC_LUT = 0xedb88320; // 变异：改名复辟\nimport { createHash } from 'node:crypto';"
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'N10',
    note: '热重载不重算睡眠（面板上开了作息要等 30 秒才拦，用户以为开关坏了）',
    file: 'src/index.js',
    anchor: /^      refreshSleep\(\);$/m,
    count: 1,
    apply: (s) => s.replace(/^      refreshSleep\(\);$/m, '      // 变异：热重载不重算睡眠'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
];
