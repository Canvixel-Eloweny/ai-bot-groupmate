/**
 * B33（内部标记不许外泄 · 2026-10-04）的变异清单。
 *
 * 这一批打的全是「坏了在界面上看不出来」：机器人在群里照常说话、日志照常刷，
 * 只有**群里偶尔冒出一句我们自己的批注**（真机上就是这么泄的），或者反过来
 * 「该说的话被咬掉半句」。
 *
 * 第一手证据（`panel/local-trace.jsonl` · 2026-10-04 10:27:03 · traceId 30253c4c23bc）：
 *   `raw` = `[这次没有接话]` → `chunks` 放行 → 群里看到 `@某某 [这次没有接话]`
 *
 *   | 条  | 打的是                                        | 该由哪一层拦住 | 期望    |
 *   |-----|-----------------------------------------------|----------------|---------|
 *   | M1  | 剥的函数**在、但不生效**（调用形状完好）      | smoke          | BLOCKED |
 *   | M2  | 词干与文案脱钩（改文案忘改词干）              | check-wb       | BLOCKED |
 *   | M3  | 文案在 index.js 里**又拼了一份**（就地拼）    | check-wb       | BLOCKED |
 *   | M4  | 剥了不留痕（internal 收了不用）               | check-wb       | BLOCKED |
 *   | M5  | 只抠词干、不摘外壳（留半截括号话）            | smoke          | BLOCKED |
 *   | M6  | 提示词里那句「批注不是你该说的话」被删        | check-wb       | BLOCKED |
 *   | M7  | 第二个出口（主动链）不再剥                    | check-wb       | BLOCKED |
 *
 * ⚠️ **M1 是本清单里最值钱的一条**：它把"调用还在"与"真的生效"分开 ——
 *    静态契约（§63④ 判 `parseReply` 里有没有调 `stripInternalMarks(`）**照样全绿**，
 *    因为那一行还在；只有行为断言（T367）能拦住它。
 *    这正是本项目反复踩过的「断言存在 ≠ 断言接线」，只是这一次被反过来用在闸门自己身上。
 *
 * ⚠️ **M5 的期望是"剥完还剩半截"**：`（系统标记：）` 这种残骸会**照样发进群** ——
 *    比不拦更糟，因为看起来已经修过了。所以判据不是"有没有剥"，而是"剥完是不是空的"。
 *
 * ⚠️ 跑测试一律 `NODE_OPTIONS= node …`（R39），漏带 = 内部基线假红，mutate 会正确地拒绝开跑。
 * ⚠️ 本清单在工作树上就地变异（mutate.mjs 的既定做法）——工作树里有未提交的改动是**正常的**，
 *    pristine 会在第一次运行时冻结当时的整棵工作树；**只要别在跑的过程中改文件**。
 *    实测踩过一次：并发编辑器写入 `panel/next/style.css` / `check-wb.mjs`，
 *    导致同一份代码两次跑出不同结论（一次假红两条玻璃 alpha，下一次全绿）。
 */

export default [
  {
    id: 'M1',
    file: 'src/brain.js',
    anchor: /const cleaned = stripInternalMarks\(s\);/,
    count: 1,
    // 恒真的三元：调用在、判据"看得见"，但一个字都不剥
    apply: (src) => src.replace(
      'const cleaned = stripInternalMarks(s);',
      'const cleaned = stripInternalMarks(s) === s ? s : s;'
    ),
    layer: 'smoke',
    expect: 'BLOCKED',
    note: 'B33 · T367：剥的函数在、但不生效（静态契约看不出来）',
  },
  {
    id: 'M2',
    file: 'src/internal-marks.js',
    anchor: /core: '没有接话',/,
    count: 1,
    apply: (src) => src.replace("core: '没有接话',", "core: '没有接话呀',"),
    layer: 'check-wb',
    expect: 'BLOCKED',
    note: 'B33 · §63②：改文案忘改词干 → 定义表自证 + 标记剥不干净',
  },
  {
    id: 'M3',
    file: 'src/index.js',
    anchor: /brain\.remember\(session, 'assistant', INTERNAL_MARKS\.SILENT\);/,
    count: 1,
    apply: (src) => src.replace(
      "brain.remember(session, 'assistant', INTERNAL_MARKS.SILENT);",
      "brain.remember(session, 'assistant', '[这次没有接话]');"
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
    note: 'B33 · §63③：文案又拼了一份（就地拼的那句，闸门认不出词干）',
  },
  {
    id: 'M4',
    file: 'src/index.js',
    anchor: /internal\.length/g,
    count: 2,
    apply: (src) => src.replace(/internal\.length/g, 'false'),
    layer: 'check-wb',
    expect: 'BLOCKED',
    note: 'B33 · §63④：剥了不留痕（日志 + trace 两处消费同时断掉）',
  },
  {
    id: 'M5',
    file: 'src/internal-marks.js',
    anchor: /if \(wrapped\) return cutWrapped\(/,
    count: 1,
    apply: (src) => src.replace('if (wrapped) return cutWrapped(', 'if (false) return cutWrapped('),
    layer: 'smoke',
    expect: 'BLOCKED',
    note: 'B33 · T371：只抠词干不摘壳 → 剥完留半截（`（系统标记：）` 照样发进群）',
  },
  {
    id: 'M6',
    file: 'src/brain.js',
    anchor: /不要照着写出来。）'\);/,
    count: 1,
    apply: (src) => src.replace(/    base\.lines\.push\('（另外：[^\n]*不要照着写出来。）'\);\n/, ''),
    layer: 'check-wb',
    expect: 'BLOCKED',
    note: 'B33 · §63⑥：提示词里那句声明被删（少让它复读那一半没了）',
  },
  {
    id: 'M7',
    file: 'src/proactive.js',
    anchor: /const cleaned = stripInternalMarks\(s\);/,
    count: 1,
    apply: (src) => src.replace('const cleaned = stripInternalMarks(s);', 'const cleaned = s;'),
    layer: 'check-wb',
    expect: 'BLOCKED',
    note: 'B33 · §63⑤：第二个出口（主动链）不再剥内部标记',
  },
];
