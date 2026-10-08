/**
 * 清理轮（2026-10-01 · 死代码 / 导出面 / 归档 / 冗余件）的变异清单 —— 纯数据，供
 * `NODE_OPTIONS= node scripts/mutate.mjs test/mutations/cleanup-01.mjs` 复跑。
 *
 * 本轮修的两件"真缺陷"都**不会报错**，所以变异要回答的是：
 * **新加的两条契约（§55 / §56）与那条真入口用例（T349），是不是真的盯住了它们？**
 *
 *   | 变异 | 打的是什么 | 该由哪一层拦住 | 期望 |
 *   |---|---|---|---|
 *   | M1 | 删掉 `shutdown()` 里那句 `flushProfiles()`（本轮修的原始缺陷） | check-wb §55 | BLOCKED |
 *   | M2 | 同 M1，但走**行为层** | smoke **T349** | BLOCKED |
 *   | M3 | 具名 import 里去掉 `flushProfiles`（导出在、接线断） | check-wb §55 | BLOCKED |
 *   | M4 | `style-profile.js` 的 `flushProfiles` 去掉 `export`（接口没了） | check-wb §55 | BLOCKED |
 *   | M5 | 在 `process.on('exit')` 里**再补一次** `flushProfiles()`（调用点变 2） | check-wb §55 | BLOCKED |
 *   | M6 | 把 `scheduleArchive` 改名（§55 的"对象"没了） | check-wb §55 | BLOCKED |
 *   | M7 | 给 src 加一个**零引用**的 `export const` | check-wb §56 | BLOCKED |
 *   | M8 | 用 `export * from` 形态（解析器认不出 → **自证①**该响） | check-wb §56 | BLOCKED |
 *   | M9 | 用 `const y = 1; export { y };` 形态且零引用 | check-wb §56 | BLOCKED |
 *
 * ⚠️ **M1 与 M2 是同一处改动的两条腿**，这是本轮最重要的一组：
 *    只钉契约的话，"接线被摘掉"这件事在**行为层**就没有证据；只钉行为层的话，
 *    契约可以悄悄退化成"某个标识符在不在"。两条都在，才叫"接上了"。
 * ⚠️ **M8 打的是"自证"本身**：判据再对，解析器认不出的导出形态照样能躲过去 ——
 *    而"躲过去"是**静默**的（比误红更坏）。所以 §56 有一条"export 语句数 == 认出条数"的自证。
 * ⚠️ 本机 shell 注入的 `NODE_OPTIONS` 会把 `err.code` 改写成 `CODEBUDDY_BROKER_DENY`（R39）
 *    —— 跑测试要 `NODE_OPTIONS= node …`；这条前缀**也必须带到 `scripts/mutate.mjs` 前面**。
 */

/** 本轮修的那一句。M1/M2 用它当锚点（删掉 → 回到缺陷状态） */
const FLUSH_LINE = '    flushProfiles();\n';

export default [
  {
    id: 'M1',
    file: 'src/index.js',
    anchor: /\n {4}flushProfiles\(\);\n/,
    count: 1,
    apply: (src) => src.replace(FLUSH_LINE, ''),
    layer: 'check-wb',
    expect: 'BLOCKED',
    note: '§55 ③：`shutdown` 函数体里必须同时有 flushArchive() 与 flushProfiles() —— 删掉后半句',
  },
  {
    id: 'M2',
    file: 'src/index.js',
    anchor: /\n {4}flushProfiles\(\);\n/,
    count: 1,
    apply: (src) => src.replace(FLUSH_LINE, ''),
    layer: 'smoke',
    expect: 'BLOCKED',
    note: '同 M1 的**行为层**一条腿：T349 要看见"退出时画像文件被补写"，删掉这句它就看不到',
  },
  {
    id: 'M3',
    file: 'src/index.js',
    anchor: /import \{ observeAndStore, flushProfiles \} from '\.\/style-profile\.js';/,
    count: 1,
    apply: (src) => src.replace(
      "import { observeAndStore, flushProfiles } from './style-profile.js';",
      "import { observeAndStore } from './style-profile.js';",
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
    note: '§55 ②：判**具名 import**（不是"全文出现过这个名字"）—— 接线断了要红',
  },
  {
    id: 'M4',
    file: 'src/style-profile.js',
    anchor: /^export function flushProfiles\(/m,
    count: 1,
    apply: (src) => src.replace(/^export function flushProfiles\(/m, 'function flushProfiles('),
    layer: 'check-wb',
    expect: 'BLOCKED',
    note: '§55 ②：出口不再导出 —— 那种"接口没了"的形态（三件齐里的第一件）',
  },
  {
    id: 'M5',
    file: 'src/index.js',
    anchor: /process\.on\('exit', \(\) => \{ releaseOwnLock\('进程退出'\); \}\);/,
    count: 1,
    apply: (src) => src.replace(
      "process.on('exit', () => { releaseOwnLock('进程退出'); });",
      "process.on('exit', () => { flushProfiles(); releaseOwnLock('进程退出'); });",
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
    note: '§55 ④：`flushProfiles(` 必须恰 1 处 —— 两个出口会让"谁负责落盘"变得含糊（表现是"有时候补上了"）',
  },
  {
    id: 'M6',
    file: 'src/index.js',
    anchor: /function scheduleArchive\(\) \{/,
    count: 1,
    apply: (src) => src.replace('function scheduleArchive() {', 'function scheduleArchiveRenamed() {'),
    layer: 'check-wb',
    expect: 'BLOCKED',
    note: '§55 ①：抽不出 `scheduleArchive` 的函数体 = 本节判据没有对象（**改名不该静默通过**）',
  },
  {
    id: 'M7',
    file: 'src/context-budget.js',
    anchor: /^const SECTION_ORDER = \[$/m,
    count: 1,
    // ⚠️ 名字**故意拼出来**（`'CLEAN' + 'UP_DEAD_PROBE'`），不写成字面量 ——
    //    写成一个完整的字面量的话，它会出现在**本清单自己的源码**里，
    //    而 §56 的交叉引用是"名字在别的文件里出现过就算引用" ——
    //    于是这条变异会被它自己的清单"引用"，恒 NOT-BLOCKED（**探针自己骗自己**，
    //    实测第一版就是这个结果，7/9）。拼出来之后，这个串在本清单里不存在，
    //    判据恢复到它本来的严格度。（本项目 R37 记过同型：探针自己也会有缺陷。）
    apply: (src) => `${src}\nexport const ${'CLEAN' + 'UP_DEAD_PROBE'} = 1;\n`,
    layer: 'check-wb',
    expect: 'BLOCKED',
    note: '§56：新增一个全仓零引用的导出 —— 这正是本轮清掉的那一类（"改完东西忘了收 export"）',
  },
  {
    id: 'M8',
    file: 'src/context-budget.js',
    anchor: /^const SECTION_ORDER = \[$/m,
    count: 1,
    apply: (src) => `${src}\nexport * from './atomic-write.js';\n`,
    layer: 'check-wb',
    expect: 'BLOCKED',
    note: '§56 **自证①**：解析器认不出的导出形态（export * from）必须让"语句数 ≠ 认出数"这条自证响 —— 否则它会**静默**地不被检查',
  },
  {
    id: 'M9',
    file: 'src/context-budget.js',
    anchor: /^const SECTION_ORDER = \[$/m,
    count: 1,
    // 同 M7：名字拼出来，别让它出现在**本清单自己**的源码里（否则恒 NOT-BLOCKED）。
    apply: (src) => {
      const n = 'probeClean' + 'up9';
      return `${src}\nconst ${n} = 1;\nexport { ${n} };\n`;
    },
    layer: 'check-wb',
    expect: 'BLOCKED',
    note: '§56：`export { x }` 形态仍要走同一条"必须被引用"的判据（导出清单式写法不许成为后门）',
  },
];
