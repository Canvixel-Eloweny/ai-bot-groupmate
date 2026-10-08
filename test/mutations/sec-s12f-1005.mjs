/**
 * 开源前审查（2026-10-05）· **S-12 第六批（三层收口）** 的变异清单 —— 纯数据，
 * 供 `NODE_OPTIONS= node scripts/mutate.mjs test/mutations/sec-s12f-1005.mjs` 复跑。
 *
 * 打的对象：本批**删掉了**旧页三层（`panel/parts/` + `panel/lib/page-parts.js` +
 * `test/verify-panel.mjs` + `test/e2e/verify-fixes.mjs`），并把四层里最后一批准对它的
 * 引用清干净。删完之后要回答两个问题 —— 这组就是那两只手：
 *
 *   ① **反向闸门还在不在**（§66）：旧机制整块不存在了，但"不许铺回来"必须仍然有人管。
 *      本批还顺手把 §66 的**豁免集清空**了（原来豁免 `paths.js` / `page-parts.js`）——
 *      F1 正是用来证明那个决定有效的：往 `paths.js` 里加回 `PARTS_DIR` **必须**被拦。
 *   ② **改指后的 smoke 取源真的在盯东西**（T68 / T70 / T76 / T158）：
 *      这四条本批从旧页拼装产物改指到现役控制台（`next-page.js` / `schema.js` / `app.js`）。
 *      "改了取源"不等于"取源在盯" —— 拆掉防线必须当场红。
 *
 *   | 条 | 层 | 打的是什么 | 该由哪一条判据拦住 | 期望 |
 *   |---|---|---|---|---|
 *   | F1 | check-wb | `panel/lib/paths.js` 里重新导出 `PARTS_DIR` | §66（豁免集已清空） | BLOCKED |
 *   | F2 | check-wb | `panel/server.js` 里把 `readPage` 接回运行时 | §66 | BLOCKED |
 *   | F3 | check-wb | 只把六个机制名写进 `next-page.js` 的**注释** | 防线**不该**响（§66 剥注释） | NOT-BLOCKED |
 *   | F4 | smoke | 拆掉 `resolveNextAsset` 的**三道闸**（只剩拼路径） | smoke **T68** 反目录穿越 | BLOCKED |
 *   | F5 | smoke | 删掉 `readNextAsset` 的"内容为空当场抛" | smoke **T70** | BLOCKED |
 *   | F6 | smoke | `schema.js` 的 `bounds: 'cooldownSec'` 写错键名 | smoke **T76**（跨层键名） | BLOCKED |
 *   | F7 | smoke | `app.js` 把 `meta.statusLabels` 念成别的键 | smoke **T158**（读下发状态名） | BLOCKED |
 *
 * ⚠️ **F3 是误报型**（R38/R44「注释里引用字面量 → 判据自证式通过」）：§66 的取源
 *    全过 `stripComments`，所以把这六个名字写进注释**必须不**触发防线。
 * ⚠️ **F4 会被两层拦**（smoke T68 **与** check-wb §58② 喂的是同一批反例）——
 *    这是**有意保留的重复**：两层强度不同（一个是动态真调用、一个是静态喂反例），
 *    变异只跑自己声明的层，所以它仍然只证明"smoke 那一条是活的"。
 * ⚠️ **F5/F6/F7 都只有 smoke 盯**：`check-wb` 今天没有"资产读到空要抛"、
 *    "`bounds:` 键必须在声明表里"、"页面读下发的状态名表"这三条静态判据 ——
 *    这也正是本批把这三条**改指**而不是删除的理由（删了就真的没人管了）。
 *
 * 期望：F1 / F2 / F4 / F5 / F6 / F7 `BLOCKED`，F3 `NOT-BLOCKED`，`INVALID` 为 0。
 * ⚠️ 跑测试一律 `NODE_OPTIONS= node …`（R39）；跑之前**先提交**；
 *    用全新的 `QQBOT_MUTATE_WORK` 目录（R46.1：复用旧目录会把工作树回滚）。
 * ⚠️ **smoke 层需要面板不在跑**（否则 T332/T341/T342/T343 假红 → 基线不是全绿，
 *    工具会拒绝下结论）。本批跑的时候面板是停着的。
 */
const PATHS = 'panel/lib/paths.js';
const NEXT = 'panel/lib/next-page.js';
const SRV = 'panel/server.js';
const SCH = 'panel/next/schema.js';
const APP = 'panel/next/app.js';

// ── F1：往 paths.js 里把片段目录常量加回来（§66 必须拦）────────────────────
const F1 = {
  id: 'F1',
  note: 'panel/lib/paths.js 里重新导出 `PARTS_DIR` —— 旧机制回到运行时的**最可能形态**（那正是它原来的住处）。本批把 §66 的豁免集清空了，这条证明它现在真的被扫。预期 BLOCKED（§66）',
  anchor: /export const NEXT_DIR = path\.join\(ROOT, 'panel', 'next'\);/,
  count: 1,
  file: PATHS,
  apply: (s) => s.replace(
    /export const NEXT_DIR = path\.join\(ROOT, 'panel', 'next'\);/,
    "export const PARTS_DIR = path.join(ROOT, 'panel', 'parts');\n"
      + "export const NEXT_DIR = path.join(ROOT, 'panel', 'next');"
  ),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── F2：把拼装页读取口接回服务端（§66 必须拦）─────────────────────────────
const F2 = {
  id: 'F2',
  note: 'panel/server.js 里出现 `readPage` 的调用 —— "图省事把死页面接回产品面"的形态。预期 BLOCKED（§66）',
  anchor: /import fs from 'node:fs';/,
  count: 1,
  file: SRV,
  apply: (s) => s.replace(
    /import fs from 'node:fs';/,
    "import fs from 'node:fs';\nconst _legacyPage = () => readPage(process.cwd());"
  ),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── F3：只在注释里写下这六个名字（误报型）──────────────────────────────────
const F3 = {
  id: 'F3',
  note: '只把六个机制名写进 next-page.js 的**注释**（page-parts / loadParts / joinParts / readPage / resolvePartPath / PARTS_DIR）—— §66 取源过 stripComments，防线**不该**响。预期 NOT-BLOCKED（R38/R44）',
  anchor: /export const NEXT_ASSETS = \{/,
  count: 1,
  file: NEXT,
  apply: (s) => s.replace(
    /export const NEXT_ASSETS = \{/,
    '// 反例注释（都不算数）：page-parts / loadParts / joinParts / readPage / '
      + "resolvePartPath / PARTS_DIR —— 历史方案，已删除\n"
      + 'export const NEXT_ASSETS = {'
  ),
  layer: 'check-wb',
  expect: 'NOT-BLOCKED',
};

// ── F4：拆掉 resolveNextAsset 的三道闸（T68 必须拦）────────────────────────
const F4 = {
  id: 'F4',
  note: '把 `resolveNextAsset` 的三道闸（白名单 → 名字形状 → path.relative 复核）整个拆掉、只剩"拼路径" —— 八个恶意名字全部取得到路径。预期 BLOCKED（smoke T68；check-wb §58② 喂的是同一批反例，也会红，见文件头说明）',
  anchor: /export function resolveNextAsset\(name, dir = NEXT_DIR\) \{/,
  count: 1,
  file: NEXT,
  apply: (s) => s.replace(
    /export function resolveNextAsset\(name, dir = NEXT_DIR\) \{[\s\S]*?\n\}/,
    'export function resolveNextAsset(name, dir = NEXT_DIR) {\n'
      + "  return path.resolve(path.resolve(dir), String(name == null ? '' : name));\n"
      + '}'
  ),
  layer: 'smoke',
  expect: 'BLOCKED',
};

// ── F5：资产读到空内容不再抛（T70 必须拦）──────────────────────────────────
const F5 = {
  id: 'F5',
  note: '删掉 `readNextAsset` 的"内容为空当场抛" —— 浏览器会拿到一份空模块，表现是白屏而服务端一片安静。预期 BLOCKED（smoke T70）',
  anchor: /if \(!raw\.trim\(\)\) throw new Error\(`新版页面资产是空的：\$\{name\} —— 空资产发出去必然白屏`\);/,
  count: 1,
  file: NEXT,
  apply: (s) => s.replace(
    /if \(!raw\.trim\(\)\) throw new Error\(`新版页面资产是空的：\$\{name\} —— 空资产发出去必然白屏`\);/,
    'if (false) throw new Error(`新版页面资产是空的：${name}`);'
  ),
  layer: 'smoke',
  expect: 'BLOCKED',
};

// ── F6：bounds 的键名写错（T76 必须拦）─────────────────────────────────────
const F6 = {
  id: 'F6',
  note: "schema.js 的 `bounds: 'cooldownSec'` 写成不存在的键 —— 页面上那行「后端允许 lo – hi」提示会静默消失。预期 BLOCKED（smoke T76）",
  anchor: /bounds: 'cooldownSec',/,
  count: 1,
  file: SCH,
  apply: (s) => s.replace(/bounds: 'cooldownSec',/, "bounds: 'cooldownSecX',"),
  layer: 'smoke',
  expect: 'BLOCKED',
};

// ── F7：页面不再读下发的状态名（T158 必须拦）───────────────────────────────
const F7 = {
  id: 'F7',
  note: 'app.js 把 `meta.statusLabels` 念成别的键 —— 后端下发了却没人看，页面上只剩英文裸键。预期 BLOCKED（smoke T158）',
  anchor: /const labels = meta\.statusLabels \|\| \{\};/,
  count: 1,
  file: APP,
  apply: (s) => s.replace(/const labels = meta\.statusLabels \|\| \{\};/, 'const labels = meta.statusLabelsX || {};'),
  layer: 'smoke',
  expect: 'BLOCKED',
};

export default [F1, F2, F3, F4, F5, F6, F7];
