/**
 * 第 16 轮（开源前审查 · **H-10 巨型文件拆分第二半 · 前置件**）的变异清单 ——
 * 纯数据，供 `NODE_OPTIONS= QQBOT_MUTATE_WORK=/tmp/r16-mutate
 * node scripts/mutate.mjs test/mutations/r16-1006.mjs` 复跑。
 *
 * 本轮做两件事：
 *  ① 把 `readTrace` / `TRACE_SHOWN` / `TRACE_AGGREGATE` 搬进 `panel/lib/trace-io.js`
 *     （L1 · 只依赖 paths.js 的 TRACE_FILE）—— 它是下一轮要动的三个大块
 *     （`collectState` / `buildExport` / `apiConfig`）**共同的读盘口**，
 *     不先沉掉它们，"拆主文件"永远差一个前置件。
 *  ② 新增契约 **§82**：把 `LIB_SRC_ALLOW` 的**真实准入判据**写下来并断言 ——
 *     "传递闭包不触达机器人重型启动链"，替掉那条与实测不符的"零依赖叶子"注释。
 *
 * | 条 | 打的是 | 该由哪一层拦住 | 期望 |
 * |---|---|---|---|
 * | M1 | 白名单里塞进 `src/config.js`（机器人配置入口，传递触达重型链） | check-wb §82 ① | BLOCKED |
 * | M2 | 白名单里塞进 `src/brain.js` | check-wb §82 ②（入口无条件禁） | BLOCKED |
 * | M3 | `trace-io.js` 不再读 `TRACE_FILE`（改成读别的路径） | check-wb §82 ③ | BLOCKED |
 * | M4 | 主文件在本地**又定义**一份 `readTrace`（搬家只搬一半的经典漏） | check-wb §82 ④ | BLOCKED |
 * | M5 | `server.js` 那行 import 被删（叶子成了空壳） | check-wb §82 ④ | BLOCKED |
 * | M6 | 两个窗口常量被合并成同一个值（TRACE_AGGREGATE = 3） | check-wb §82 ⑤ | BLOCKED |
 *
 * ⚠️ **如实登记的覆盖缺口**：无 —— §82 五条子判据全部配到变异。
 *   「白名单里塞进一个**传递**触达 llm 的中间模块」这条更难构造，
 *   M1 用 `config.js` 覆盖的是同一判据的可达路径（实测 `config.js` 传递触达 llm）。
 *
 * ⚠️ 跑测试一律 `NODE_OPTIONS= node …`（R39）；用**全新**的 `QQBOT_MUTATE_WORK` 目录（R46.1）。
 */
const SRV = 'panel/server.js';
const TI = 'panel/lib/trace-io.js';
const CWB = 'scripts/check-wb.mjs';

// ── M1：白名单里塞进机器人配置入口（§82 ① 传递闭包）────────────────────────
const M1 = {
  id: 'M1',
  note: 'LIB_SRC_ALLOW 里塞进 src/config.js（机器人配置入口，传递触达 llm/brain）——',
  anchor: /const LIB_SRC_ALLOW = \[\n/,
  count: 1,
  file: CWB,
  apply: (s) => s.replace(
    "const LIB_SRC_ALLOW = [\n  'atomic-write.js',",
    "const LIB_SRC_ALLOW = [\n  'config.js',\n  'atomic-write.js',"
  ),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M2：白名单里塞进 brain.js（§82 ② 入口无条件禁）──────────────────────────
const M2 = {
  id: 'M2',
  note: 'LIB_SRC_ALLOW 里塞进 src/brain.js ——',
  anchor: /const LIB_SRC_ALLOW = \[\n/,
  count: 1,
  file: CWB,
  apply: (s) => s.replace(
    "const LIB_SRC_ALLOW = [\n  'atomic-write.js',",
    "const LIB_SRC_ALLOW = [\n  'brain.js',\n  'atomic-write.js',"
  ),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M3：读盘口不再读 TRACE_FILE（§82 ③ 读者唯一性）─────────────────────────
const M3 = {
  id: 'M3',
  note: 'trace-io.js 改成读别的路径（TRACE_FILE 的读者变成 0 处）——',
  anchor: /const raw = fs\.readFileSync\(TRACE_FILE, 'utf8'\);/,
  count: 1,
  file: TI,
  apply: (s) => s.replace(
    "const raw = fs.readFileSync(TRACE_FILE, 'utf8');",
    "const raw = fs.readFileSync('/dev/null', 'utf8');"
  ),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M4：主文件本地又留一份 readTrace（§82 ④ 搬家只搬一半）──────────────────
// ⚠️ 写法要点：这一条**不能**写成"再 `const TRACE_SHOWN = 3` 一遍" —— 那会让
//    server.js 撞上 `Identifier 'TRACE_SHOWN' has already been declared`，
//    **语法错在契约之前**，于是变异被判 INVALID（不计入统计，结论显得比实际好看）。
//    本轮首次跑就是这样（5/5 · INVALID 1）。正确写法是只加一个**合法**的重复定义：
//    一个未被 import 使用的同名 function 声明，语法合法、语义上"两份实现各活一份"。
const M4 = {
  id: 'M4',
  note: 'server.js 里又本地定义一份 readTrace（搬走的实现与留下的定义各活一份）——',
  anchor: /import \{ readTrace, TRACE_SHOWN, TRACE_AGGREGATE \} from '\.\/lib\/trace-io\.js';/,
  count: 1,
  file: SRV,
  apply: (s) => s.replace(
    "import { readTrace, TRACE_SHOWN, TRACE_AGGREGATE } from './lib/trace-io.js';",
    "import { readTrace as _leafReadTrace, TRACE_SHOWN, TRACE_AGGREGATE } from './lib/trace-io.js';\n"
      + 'function readTrace() { return []; }'
  ),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M5：主文件那行 import 被删（叶子成了空壳，改动永不生效）─────────────────
const M5 = {
  id: 'M5',
  note: 'server.js 删掉从 trace-io.js 的 import —— 叶子成了空壳',
  anchor: /import \{ readTrace, TRACE_SHOWN, TRACE_AGGREGATE \} from '\.\/lib\/trace-io\.js';\n/,
  count: 1,
  file: SRV,
  apply: (s) => s.replace(
    "import { readTrace, TRACE_SHOWN, TRACE_AGGREGATE } from './lib/trace-io.js';\n", ''
  ),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M6：两个窗口常量被合并（§82 ⑤）───────────────────────────────────────
const M6 = {
  id: 'M6',
  note: 'TRACE_AGGREGATE 被改成 3（与会话卡片的窗口合并成同一个数）——',
  anchor: /export const TRACE_AGGREGATE = 120;/,
  count: 1,
  file: TI,
  apply: (s) => s.replace('export const TRACE_AGGREGATE = 120;', 'export const TRACE_AGGREGATE = 3;'),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

export default [M1, M2, M3, M4, M5, M6];