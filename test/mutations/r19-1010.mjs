/**
 * 第 19 轮（开源前审查 · **H-10 第二半收尾**）的变异清单 ——
 * 纯数据，供 `NODE_OPTIONS= QQBOT_MUTATE_WORK=/tmp/r19-mutate
 * node scripts/mutate.mjs test/mutations/r19-1010.mjs` 复跑。
 *
 * 本轮把 `collectState`（297 行）与 `buildExport`（240 行）搬进 `panel/lib/`，
 * `panel/server.js` 3678 → 3157 行。**三块至此全部搬完**（H-10 第二半收口）。
 *
 * 卡了两轮的那条边也解开了：`src/memory.js` 静态 import `logger.js` → `egress.js`，
 * 而 `egress.js` 在 **import 期**就 `compiled(SECRET_RULES)` 编译凭据特征表——
 * 面板只要 import `memory.js`，启动路径就被拖进机器人的凭据装载。
 * 解法**不是放宽白名单**，而是把读的那半边拆成零依赖叶子 `src/memory-store.js`。
 *
 * | 条 | 打的是 | 该由哪一层拦住 | 期望 |
 * |---|---|---|---|
 * | M1 | 主文件又本地留一份 `collectState` 实现 | §84 ① | BLOCKED |
 * | M2 | 工厂接线少注入一个判据 | §84 ② | BLOCKED |
 * | M3 | 主文件那份 `bridgeRunning` 被删（连带打坏另外 7 处） | §84 ③ | BLOCKED |
 * | M4 | `memory-store.js` 引一个 src 模块（叶子不再零依赖） | §84 ④ | BLOCKED |
 * | M5 | `memory.js` 自己再写一份读盘实现（与叶子构成两份） | §84 ④ | BLOCKED |
 * | M6 | 路径解析退回叶子里的模块级常量（env 隔离失效） | §84 ⑤ | BLOCKED |
 *
 * ⚠️ **M6 是本清单最要紧的一条**，它对应本轮真实踩到的事故：
 *   叶子初版把路径算成模块级常量，于是测试那句「设 env → `import('…memory.js?probe=…')`」
 *   **穿透了 `memory.js` 却没穿透叶子** ⇒ 8 条结构化记忆用例读到的仍是**真机那份**
 *   `panel/memory-records.json`（smoke 实测 454/462，「条数=16」正是真机条数）。
 *   症状不是「测试失败」，而是**测试会往用户真实数据文件里写**——
 *   与 B7 修过两次的「测试污染生产数据」同一个坑。
 *   正解：路径解析必须由 `memory.js` 在**自己被 import 的那一刻**触发。
 *
 * ⚠️ **M4 与 M5 是同一个不变量（判据只有一份）的两个方向**：
 *   M4 打「叶子不干净」（⇒ 白名单不敢放行，这一整轮拆分白做），
 *   M5 打「主文件又写一份」（⇒ 面板与机器人读到不同数据）。
 *
 * ⚠️ 跑测试一律 `NODE_OPTIONS= node …`（R39）；用**全新**的 `QQBOT_MUTATE_WORK` 目录（R46.1）。
 */
const CWB = 'scripts/check-wb.mjs';
const SRV = 'panel/server.js';
const STORE = 'src/memory-store.js';
const MEM = 'src/memory.js';

// ── M1：主文件又留一份实现（搬家只搬一半的经典漏）────────────────────────
const M1 = {
  id: 'M1',
  note: 'server.js 里又本地定义一份 collectState（新家与主文件两份实现各活一份）——',
  anchor: /const collectState = makeStateCollector\(\{/,
  count: 1,
  file: SRV,
  apply: (s) => s.replace(
    'const collectState = makeStateCollector({',
    'async function collectState() {\n  return { ok: true };\n}\nconst unusedCollector = makeStateCollector({'
  ),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M2：少注入一个判据（那个判断悄悄失效）───────────────────────────────
const M2 = {
  id: 'M2',
  note: '工厂接线里少注入 readUsage（用量那段悄悄失效）——',
  anchor: /const collectState = makeStateCollector\(\{/,
  count: 1,
  file: SRV,
  apply: (s) => s.replace(
    /readThinking, readUsage,\n\}\);/,
    'readThinking,\n});'
  ),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M3：主文件那份判据被删（连带打坏另外 7 个调用点）────────────────────
const M3 = {
  id: 'M3',
  note: 'server.js 里的 bridgeRunning 被删（它另有 7 个调用点）——',
  anchor: /^function bridgeRunning\(\) \{$/m,
  count: 1,
  file: SRV,
  apply: (s) => s.replace(/function bridgeRunning\(\) \{[\s\S]*?\n\}\n/, ''),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M4：叶子不干净（引了 src 模块 ⇒ 白名单不敢放行，这轮拆分白做）─────────
const M4 = {
  id: 'M4',
  note: 'memory-store.js 引一个 src 模块（不再是零依赖叶子）——',
  anchor: /^const ROOT = /m,
  count: 1,
  file: STORE,
  apply: (s) => s.replace(
    'const ROOT =',
    "import { similarity } from './custom-config.js';\nconst ROOT ="
  ),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M5：主文件又写一份读盘实现（与叶子构成两份实现）──────────────────────
// ⚠️ 写成**合法**代码：把转发体换成真正的读盘实现（不是语法错）。
//    那才是「两份实现」的真故障 —— 而 §84④ 判的正是「转发那一行的形状」。
const M5 = {
  id: 'M5',
  note: 'memory.js 把 listAutoMemory 改回自己实现（与叶子两份实现）——',
  anchor: /export function listAutoMemory\(\) \{/,
  count: 1,
  file: MEM,
  apply: (s) => s.replace(
    /export function listAutoMemory\(\) \{[\s\S]*?\n\}/,
    "export function listAutoMemory() {\n  try {\n    return require('node:fs').readFileSync(AUTO_MEMORY_FILE, 'utf8').split('\\n').map((l) => JSON.parse(l));\n  } catch {\n    return [];\n  }\n}"
  ),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M6：路径解析退回叶子里的模块级常量（env 隔离失效 · 本轮真踩过）────────
const M6 = {
  id: 'M6',
  note: 'memory.js 不在import 时调 resolveMemoryFiles（env 隔离失效 ⇒ 测试读写真机记忆文件）——',
  anchor: /const MEM_FILES = resolveMemoryFiles\(\);/,
  count: 1,
  file: MEM,
  apply: (s) => s.replace(
    'const MEM_FILES = resolveMemoryFiles();',
    "const MEM_FILES = { autoFile: AUTO_MEMORY_FILE_FALLBACK, recordsFile: RECORDS_FALLBACK };"
  ),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

export default [M1, M2, M3, M4, M5, M6];