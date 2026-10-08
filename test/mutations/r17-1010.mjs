/**
 * 第 17 轮（开源前审查 · **契约自身的盲区**）的变异清单 ——
 * 纯数据，供 `NODE_OPTIONS= QQBOT_MUTATE_WORK=/tmp/r17-mutate
 * node scripts/mutate.mjs test/mutations/r17-1010.mjs` 复跑。
 *
 * 本轮**不改生产码**，改的是`scripts/check-wb.mjs` 里两扇门自己的判据：
 * 两处都用单行锚 `import[^\n]*?from` 抽 import，于是**多行** import 整条看不见。
 * 实测：往 `panel/lib/control.js` 顶部注入一条多行 import 指向**白名单外的
 * `src/brain.js`**，「后端拆分接线完整」与「§82 lib白名单」**同时打印通过** ——
 * 而这条边一旦成立，机器人��启动链就被拖进面板进程，正是这两扇门存在的理由。
 *
 * | 条 | 打的是 | 该由哪一层拦住 | 期望 |
 * |---|---|---|---|
 * | M1 | 多行 import 引白名单外的 `src/brain.js` | 后端拆分接线完整（`importsOf`） | BLOCKED |
 * | M2 | M1 的**反向**变异：多行 import 引**白名单内**的 `src/model-caps.js` | 不许假红（合法边） | NOT-BLOCKED |
 * | M3 | 1950 那道改回 `import[^\n]*?from`（**退回本轮那个真盲区**） | 整节· MULTILINE 必须消失 | BLOCKED |
 * | M4 | 白名单登记项变成「没人引」的孤儿 | 自证③ 双向核对（orphan 侧） | BLOCKED |
 * | M5 | 白名单删掉一项（登记表与实际接线脱节） | 自证③ 双向核对（outside 侧） | BLOCKED |
 * | M6 | 把双向核对改回**计数相等**（10 边 vs 8 项 ⇒ 假红） | 自证③ 必须是集合比对 | BLOCKED |
 *
 * ⚠️ **M2 是本清单的关键一条**：它证明修好之后这扇门**不是"见 import 就红"的
 *   假牙**。M1 打的是非法边（该红）、M2 打的是合法边（不该红）——
 *   两条一起过，才说明判据收窄到了正确位置（本项目 §45「断言存在 ≠ 断言接线」的正反面）。
 *
 * ⚠️ **M3 打的是判据自己**：它把 `importsOf` 换回本轮修掉的 `import[^\n]*?from`，
 *   于是 §44那条 MULTILINE 自证（真值=0条 多行 lib→src 边）会变成 2 ⇒ 报红。
 *   换句话说：**这条变异是"把盲区装回去"，装回去就被自己的契约看见。**
 *
 * ⚠️ **M6 的形状**：把集合比对换成 `srcEdges.length !== LIB_SRC_ALLOW.length`。
 *   实测原判据是**巧合通过**（10 条边只指向 8 个 distinct 模块，恰好 == 8 项）。
 *   所以 M6 会真的报红 —— 这条红是**正确的**（它在说"你把判据退回去了"）。
 *
 * ⚠️ 跑测试一律 `NODE_OPTIONS= node …`（R39）；用**全新**的 `QQBOT_MUTATE_WORK` 目录（R46.1）。
 */
const CWB = 'scripts/check-wb.mjs';
const CTRL = 'panel/lib/control.js';
const MODELS = 'panel/lib/models.js';
// 第 18 轮新增：「保存配置」路由的新家。
const CR = 'panel/lib/config-route.js';
// 第 19 轮新增：「面板状态」聚合的新家（M4 第 19 轮改打它，见该条注释）。
const STCOL = 'panel/lib/state-collector.js';

// ── M1：多行 import 引白名单外的重型模块（**本轮那个真盲区**）──────────────
// ⚠️ 必须写成**多行**才有意义：单行 import 在修复前就能被看见，这盲区只对多行成立。
const M1 = {
  id: 'M1',
  note: 'panel/lib/control.js 加一条【多行】import 指向白名单外的 src/brain.js ——',
  anchor: /^import fs from 'node:fs';$/m,
  count: 1,
  file: CTRL,
  apply: (s) => s.replace(
    "import fs from 'node:fs';",
    "import fs from 'node:fs';\nimport {\n  someBrainHelper,\n} from '../../src/brain.js';"
  ),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M2：反向变异 —— 多行 import 引**白名单内**的模块（合法边，不许红）────────
const M2 = {
  id: 'M2',
  note: '同上但引白名单内的 src/model-caps.js（合法边）—— 这条【不该】被拦住；',
  note2: 'M1 + M2 一起过，才证明判据不是"见 import 就红"的假牙',
  anchor: /^import fs from 'node:fs';$/m,
  count: 1,
  file: CTRL,
  apply: (s) => s.replace(
    "import fs from 'node:fs';",
    "import fs from 'node:fs';\nimport {\n  supportsVision,\n} from '../../src/model-caps.js';"
  ),
  layer: 'check-wb',
  expect: 'NOT-BLOCKED',
};

// ── M3：把 1950 那道改回单行锚 `import[^\n]*?from`（**装回本轮的盲区**）──────
const M3 = {
  id: 'M3',
  note: '1950 那道退回 import[^\\n]*?from（多行 import 整条看不见 ⇒ §44 MULTILINE 真值归 0）——',
  anchor: /for \(const spec of importsOf\(src\)\) \{/,
  count: 1,
  file: CWB,
  apply: (s) => s.replace(
    'for (const spec of importsOf(src)) {',
    "for (const m of src.matchAll(/import[^\\n]*?from\\s*'([^']+)'/g)) {\n        const spec = m[1];"
  ),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M4：白名单登记项变成「没人引」的孤儿（**旧判据永远抓不到**）──────────────
// ⚠️ 这一条专门打旧判据的盲区：删掉某条 src import 后，对应白名单项就没人引了——
//    **边数恰好又等于白名单项数**，旧判据照样打印"通过"。
//
// ⚠️ **第 18/19 轮两次改指目标**：原版打的是 `models.js` 的两条 import（`model-caps.js`
//    与 `net-rules.js`）。第 18 轮 `config-route.js` 也引这两项 ⇒ 删 `models.js` 那份
//    **不会**让它们成孤儿（实测 NOT-BLOCKED）。改打 `custom-config.js`；
//    但第 19 轮 `state-collector.js` **也**引 `custom-config.js` ⇒ 同样有两个边来源。
//    第三次改打 `memory-record.js` —— 实测它**只**被 `state-collector.js` 一处引。
//
// ⚠️ 三次都是同一个成因：**搬家让被引模块多了一个来源**，
//    而**判据本身一直是对的**（它确实在守 orphan 侧）。
//    ⇒ 「变异前提过时」与「判据坏了」必须分开认定，否则会去"修"一个本来正确的判据。
//    ⚠️ 选目标的方法：先实测「哪些白名单项只有单一来源」，再从里面挑 —— 别凭印象挑。
const M4 = {
  id: 'M4',
  note: 'state-collector.js 删掉 memory-record.js 的 import → 该白名单项没人引了（孤儿侧）——',
  anchor: /^import \{\n  PROMPT_BUDGET_CHARS,/m,
  count: 1,
  file: STCOL,
  apply: (s) => s.replace(
    /import \{\n(?:.|\n)*?\} from '\.\.\/\.\.\/src\/memory-record\.js';\n/,
    ''
  ),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M5：白名单删掉一项（登记表与实际接线脱节）──────────────────────────────
// ⚠️ 这里删的项**仍在被 models.js 引**，所以判的是 `usedAllow \ LIB_SRC_ALLOW`（outside 侧）。
const M5 = {
  id: 'M5',
  note: '白名单里删掉 net-rules.js（但 models.js 还在引它 ⇒ 指向白名单外）——',
  anchor: /^  'net-rules\.js', \/\/ 本机地址 \/ 服务商判据（唯一一份）$/m,
  count: 1,
  file: CWB,
  apply: (s) => s.replace("  'net-rules.js', // 本机地址 / 服务商判据（唯一一份）\n", ''),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M6：把双向集合核对改回计数相等（退回那个巧合判据）─────────────────────
const M6 = {
  id: 'M6',
  note: '自证③ 从集合比对改回 srcEdges.length !== LIB_SRC_ALLOW.length（10 边 vs 8 项 ⇒ 假红）——',
  anchor: /const orphanAllow = LIB_SRC_ALLOW\.filter\(/,
  count: 1,
  file: CWB,
  apply: (s) => s.replace(
    "    const usedAllow = [...new Set(srcEdges.map((e) => e.slice(e.lastIndexOf('src/') + 4)))];",
    '    const usedAllow = [];\n'
      + "    if (srcEdges.length !== LIB_SRC_ALLOW.length) {\n"
      + "      bad++; n++;\n"
      + "      console.log('\\u2717 lib\\u2192src \\u767d\\u540d\\u5355\\u5bf9\\u4e0d\\u4e0a\\uff08\\u9000\\u56de\\u8ba1\\u6570\\u76f8\\u7b49\\uff09');\n"
      + '    }'
  ),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

export default [M1, M2, M3, M4, M5, M6];