/**
 * D17（提醒三件套 + 节假日 · 报告 E9）的变异清单 —— 纯数据，供
 * `node scripts/mutate.mjs test/mutations/d17.mjs` 复跑。
 *
 * 为什么每一步都要配变异：这一批的每一处判错**都不会报错**，只会安静地变错 ——
 *   · 日期维度写错 → 一条"明天下午三点提醒我"变成每天下午三点（刷屏）；
 *   · 窗口起点写错 → 静默期到点那条永远补不上（用户视角："它有时候不提醒"）；
 *   · missed 不再要求"亲眼看着它到点" → 每次重启都记一串**假事故**；
 *   · 状态不落盘 → 重启一次就把今天发过的再发一遍；
 *   · 节假日兜底顺序反了 → 调休上班的周六被判成休息（表白填，还以为填对了）。
 *
 *   | 组 | 打的是 | 该由哪一层拦住 |
 *   |---|---|---|
 *   | M1  | 判据层不许长依赖（反例要能直接喂） | check-wb §46 ① |
 *   | M2  | 日期维度：`date` 被忽略（一次性退化为每天） | check-wb §46 ③ |
 *   | M3  | 认不出的 at/date **回落成"现在"**（刷屏） | check-wb §46 ③ |
 *   | M4  | 窗口被放大到失去意义（"30 分钟内补发"变空话） | check-wb §46 ③ |
 *   | M5  | missed 不再要求"亲眼看着它到点" | check-wb §46 ② |
 *   | M6  | 状态不落盘（重启即重复发送） | check-wb §46 ② |
 *   | M7  | 三件套少一件（新落盘文件入库） | check-wb §46 ④ |
 *   | M8  | 节假日兜底顺序反了（先按星期几、后查表） | check-wb §46 ③ |
 *   | M9  | 面板保存不带 `holidays`（点一次保存清空一次） | check-wb §46 ⑤ |
 *   | M10 | `on` 在接线处自己比字符串（闭集合漂移） | check-wb §46 ② |
 *
 * 期望：十条全部 `BLOCKED`，`INVALID` 为 0。
 *
 * ⚠️ 跑这一批时若看到 `[safe-delete]`，那是**沙箱的批量删除保护**在冒充"被拦住"
 *    （不是断言失败）—— 换前台 + 非沙箱复跑同一组再下结论（R33/R34/R36 同款）。
 * ⚠️ 另：本机 shell 注入的 `NODE_OPTIONS` 会把 `err.code` 改写成 `CODEBUDDY_BROKER_DENY`
 *    （本批实测：T293/T296 因此假红）—— 跑测试要 `NODE_OPTIONS= node …`。
 */

export default [
  {
    id: 'M1',
    note: '提醒判据长出依赖（"日期维度 / 窗口"就没法在测试里逐格喂反例了）',
    file: 'src/reminder.js',
    // ⚠️ 第 13 轮 H-11：`isoOfLocal` 收敛成了 `holidays.js` 里的 `dayKeyOf`，这行 import 跟着变
    //    —— 锚点是"实现所在的那一行"，实现改名它就得改（否则 M1 会静默变成 INVALID）。
    anchor: /^import \{ parseIsoDay, dayKeyOf, dayKindOf \} from '\.\/holidays\.js';$/m,
    count: 1,
    apply: (s) => s.replace(
      "import { parseIsoDay, dayKeyOf, dayKindOf } from './holidays.js';",
      "import fs from 'node:fs'; // 变异：叶子不许有依赖\nimport { parseIsoDay, dayKeyOf, dayKindOf } from './holidays.js';"
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M2',
    note: '日期维度被摘：`date` 不再生效（"那天那一次"退化成"每天"，一次性提醒变刷屏）',
    file: 'src/reminder.js',
    anchor: /  if \(raw !== undefined && raw !== null && String\(raw\)\.trim\(\) !== ''\) \{/,
    count: 1,
    apply: (s) => s.replace(
      "  if (raw !== undefined && raw !== null && String(raw).trim() !== '') {",
      '  if (false) { // 变异：忽略 date'
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M3',
    note: '认不出的 at 回落成"当前时刻"（一条填错的提醒 = 每 30 秒都到期）',
    file: 'src/reminder.js',
    anchor: /  const t = parseHhmm\(entry\?\.at\);\n  if \(!t\) return null;/,
    count: 1,
    apply: (s) => s.replace(
      '  const t = parseHhmm(entry?.at);\n  if (!t) return null;',
      '  const t = parseHhmm(entry?.at) || { h: new Date(now).getHours(), mi: new Date(now).getMinutes() }; // 变异：回落到现在'
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M4',
    note: '窗口被放大 100 倍（30 分钟补发窗口变成两天，"错过"这个概念消失）',
    file: 'src/reminder.js',
    anchor: /  if \(now - dueMs < REMINDER_WINDOW_MS\) return 'due';/,
    count: 1,
    apply: (s) => s.replace(
      "  if (now - dueMs < REMINDER_WINDOW_MS) return 'due';",
      "  if (now - dueMs < REMINDER_WINDOW_MS * 100) return 'due'; // 变异：窗口失去意义"
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M5',
    note: 'missed 不再要求"亲眼看着它到点" —— 进程启动时就已过窗的那些也会记成错过（假事故）',
    file: 'src/index.js',
    anchor: /        if \(!seenDue\.has\(rkey\)\) continue;/,
    count: 1,
    apply: (s) => s.replace(
      '        if (!seenDue.has(rkey)) continue;',
      '        // 变异：删掉了"亲眼看着它到点"这一条'
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M6',
    note: '状态不落盘（重启一次就把今天已经发过的提醒再发一遍）',
    file: 'src/index.js',
    anchor: /    if \(reminderDirty\) saveReminderState\(\);/,
    count: 1,
    apply: (s) => s.replace(
      '    if (reminderDirty) saveReminderState();',
      '    if (reminderDirty) { /* 变异：不落盘 */ }'
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M7',
    note: '三件套少一件：新落盘文件被提交进仓库（本机运行态入库）',
    file: '.gitignore',
    anchor: /^panel\/reminder-state\.json$/m,
    count: 1,
    apply: (s) => s.replace('panel/reminder-state.json', '# 变异：忘了把提醒状态排除掉'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M8',
    note: '节假日兜底顺序反了：先按星期几、后查表（调休上班的周六被判成休息，法定假白填）',
    file: 'src/holidays.js',
    anchor: /  const hit = table\?\.\[isoOf\(p\)\];/,
    count: 1,
    apply: (s) => s.replace(
      '  const hit = table?.[isoOf(p)];',
      '  const hit = undefined; // 变异：不查表，只按星期几'
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  // ⚠️ S-12 第五批（2026-10-05）：原 M9（打 panel/parts/14-script.html）已**退役** ——
  //    它对应的旧页判据随旧页下线，且该关切在现役控制台没有等价判据。
  //    去向登记在 docs/S12-CONTRACT-MIGRATION-1005.md §十三。
  {
    id: 'M10',
    note: '`on` 在接线处自己比字符串（闭集合判据从叶子漂到调用方，加第三种日子只改一处）',
    file: 'src/index.js',
    anchor: /      if \(!matchesOn\(s\.on, kind\)\) \{/,
    count: 1,
    apply: (s) => s.replace(
      '      if (!matchesOn(s.on, kind)) {',
      "      if (s.on === 'workday' && kind !== 'workday') { // 变异：自己比字符串"
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
];
