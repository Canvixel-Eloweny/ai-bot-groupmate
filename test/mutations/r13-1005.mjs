/**
 * 第 13 轮（开源前审查 · **P3 的技术债块** H-11「四处重复实现收敛」）的变异清单 —— 纯数据，
 * 供 `NODE_OPTIONS= QQBOT_MUTATE_WORK=/tmp/r13-mutate node scripts/mutate.mjs test/mutations/r13-1005.mjs` 复跑。
 *
 * 打的对象：本轮新加的 §79（本地日期键唯一的实现 / probe 候选清单唯一实现）+ §9 新增的那一组
 * `json-object-guard` 登记。**每一条新契约都配一组只打它的变异**（本项目第 4.0.3 条纪律）。
 *
 * | 条 | 打的是 | 该由哪一层拦住 | 期望 |
 * |---|---|---|---|
 * | M1 | 把本地日期键实现抄回 `trace-stats.js`（`dayKeyOf` 第二处定义 + 就地拼） | check-wb §79 ①-a/①-c | BLOCKED |
 * | M2 | 把 `dayKeyOf` 的**补零**摘掉（`2026-9-18` ≠ `2026-09-18`） | smoke T52（行为层） | BLOCKED |
 * | M3 | 被收敛掉的 `monthKey` 抄回 `usage.js`（旧名复活） | check-wb §79 ①-b | BLOCKED |
 * | M4 | 面板不再从 `holidays.js` 取日期键，改成就地一份 | check-wb §79 ①-d | BLOCKED |
 * | M5 | `probe-functions` 把 glm 清单抄回脚本本地 | check-wb §79 ④ | BLOCKED |
 * | M6 | `probe-models` 的候选来源换成别的文件（共用清单被绕开） | check-wb §79 ④ | BLOCKED |
 * | M7 | `control-channel` 的解析守卫与 `bridge-lock` 分叉一个字 | check-wb §9（json-object-guard） | BLOCKED |
 * | M8 | 共用清单被删到只剩 14 个（"输入集合塌了"的自证必须响） | check-wb §79 ④ | BLOCKED |
 * | M9 | 别处又"就地拼了一份"本地日期键 | check-wb §79 ①-c | BLOCKED |
 *
 * ⚠️ 跑测试一律 `NODE_OPTIONS= node …`（R39）；用**全新**的 `QQBOT_MUTATE_WORK` 目录（R46.1）。
 * ⚠️ 若看到 `[safe-delete]`，那是沙箱的批量删除保护在冒充"被拦住"（R33/R34/R36 同款）。
 */

// ── M1：H-11① —— 把本地日期键实现**抄回** trace-stats.js ─────────────────────
// 抄回时那行 `import { dayKeyOf } from './holidays.js'` 必须一起去掉 ——
// 否则 ESM 会报"标识符重名"，语法闸门先拦下来，就测不到契约了。
const TS_IMPORT = "import { dayKeyOf } from './holidays.js';\n";
const TS_STATS_PATH = /^export function statsFilePath\(\) \{$/m;
const M1 = {
  id: 'M1',
  note: '把本地日期键的实现抄回 trace-stats.js（第二处定义 + 就地拼日期）——',
  anchor: TS_STATS_PATH,
  count: 1,
  file: 'src/trace-stats.js',
  apply: (s) => s
    .replace(TS_IMPORT, '')
    .replace(TS_STATS_PATH, "export function dayKeyOf(d = new Date()) {\n  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;\n}\n\nexport function statsFilePath() {"),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M2：H-11① —— 补零被摘（唯一实现在，但行为退化）───────────────────────────
const H_DAYKEY_BODY = '  return isoOf({ y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate() });';
const M2 = {
  id: 'M2',
  note: '把 dayKeyOf 的补零摘掉（`2026-9-18` 与面板/账本的 `2026-09-18` 差一格）——',
  anchor: /  return isoOf\(\{ y: d\.getFullYear\(\), m: d\.getMonth\(\) \+ 1, d: d\.getDate\(\) \}\);/,
  count: 1,
  file: 'src/holidays.js',
  apply: (s) => s.replace(H_DAYKEY_BODY, "  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;"),
  layer: 'smoke',
  expect: 'BLOCKED',
};

// ── M3：H-11① —— 被收敛掉的旧名 `monthKey` 抄回 usage.js ─────────────────────
const U_ANCHOR = /^export function usageFilePath\(\) \{$/m;
const M3 = {
  id: 'M3',
  note: '把被收敛掉的 `monthKey` 抄回 usage.js（旧名复活 + 就地拼月份）——',
  anchor: U_ANCHOR,
  count: 1,
  file: 'src/usage.js',
  apply: (s) => s.replace('export function usageFilePath() {', "function monthKey(d = new Date()) {\n  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;\n}\n\nexport function usageFilePath() {"),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M4：H-11① —— 消费方不再"从唯一实现取" ────────────────────────────────────
const SRV_DAYKEY_IMPORT = /^import \{ dayKeyOf \} from '\.\.\/src\/holidays\.js';$/m;
const M4 = {
  id: 'M4',
  note: '面板不再从 holidays.js 取日期键，改成就地实现一份（唯一入口被绕开）——',
  anchor: SRV_DAYKEY_IMPORT,
  count: 1,
  file: 'panel/server.js',
  apply: (s) => s.replace("import { dayKeyOf } from '../src/holidays.js';", "function dayKeyOf(d = new Date()) {\n  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;\n}"),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M5：H-11④ —— probe 清单抄回脚本本地 ─────────────────────────────────────
const PF_ZP = 'const zp = only.length ? only : ZHIPU_CHAT_CANDIDATES;';
const M5 = {
  id: 'M5',
  note: 'probe-functions 把 glm 清单抄回脚本本地（两个探测器的候选集合会分叉）——',
  anchor: /const zp = only\.length \? only : ZHIPU_CHAT_CANDIDATES;/,
  count: 1,
  file: 'scripts/probe-functions.mjs',
  apply: (s) => s.replace(PF_ZP, "const zp = only.length ? only : ['glm-4.5-air', 'glm-4.7', 'glm-5.3'];"),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M6：H-11④ —— 候选来源被换走 ─────────────────────────────────────────────
const M6 = {
  id: 'M6',
  note: 'probe-models 的候选来源换了文件（共用清单被绕开，两个脚本从此各拿一份）——',
  anchor: /from '\.\/lib\/probe-common\.mjs'/,
  count: 1,
  file: 'scripts/probe-models.mjs',
  apply: (s) => s.replace("from './lib/probe-common.mjs'", "from './lib/probe-list.mjs'"),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M7：§9 —— 两处解析守卫分叉一个字 ────────────────────────────────────────
const CC_TEXT = '    if (!text) return null;';
const M7 = {
  id: 'M7',
  note: 'control-channel 的解析守卫与 bridge-lock 分叉一个字（`json-object-guard` 逐字比对必须响）——',
  anchor: /    if \(!text\) return null;/,
  count: 1,
  file: 'src/control-channel.js',
  apply: (s) => s.replace(CC_TEXT, '    if (!text) return undefined;'),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M8：H-11④ —— 共用清单被删空（"输入集合塌了"的自证）──────────────────────
const PC_TAIL = /  'glm-4\.7-flash', 'glm-4\.6v-flash',\n  'glm-5\.3', 'glm-5\.3-flash', 'glm-4\.6v-flashx', 'glm-4\.5v',\n\];/;
const M8 = {
  id: 'M8',
  note: '把共用清单删到只剩 14 个（清单塌了，判据若只看"有没有 import"就会在真空里通过）——',
  anchor: PC_TAIL,
  count: 1,
  file: 'scripts/lib/probe-common.mjs',
  apply: (s) => s.replace(PC_TAIL, '];'),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M9：H-11① —— 别处又"就地拼了一份"日期键 ────────────────────────────────
const RM_ANCHOR = /^export function dayKindAt\(dueMs, table = \{\}\) \{$/m;
const M9 = {
  id: 'M9',
  note: '在 reminder.js 里又就地拼了一份本地日期键（绕过唯一实现）——',
  anchor: RM_ANCHOR,
  count: 1,
  file: 'src/reminder.js',
  apply: (s) => s.replace('export function dayKindAt(dueMs, table = {}) {', "const __inlineDayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;\n\nexport function dayKindAt(dueMs, table = {}) {"),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

export default [M1, M2, M3, M4, M5, M6, M7, M8, M9];
