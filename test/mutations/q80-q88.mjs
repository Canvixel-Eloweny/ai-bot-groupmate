/**
 * Q80–Q88 批（2026-10-01 · 回收 v10/v5 回执后落地的"§50 ㉑–㉔ 二轮加固"）的变异清单
 * —— 纯数据，供 `NODE_OPTIONS= node scripts/mutate.mjs test/mutations/q80-q88.mjs` 复跑。
 *
 * 这一批打的**不是被测代码，而是扫描器自己**（工具 + 自证）。理由：
 *   ① 被测代码（`src/index.js` 的 settleWake / evaluateWake / rec）那一侧的换写法，
 *      已由外包回执的复现件 `test/mutations/t2v5-all.mjs` 逐条覆盖；
 *   ② 本轮真正**新引入**的是三件工具 / 自证 —— `fnSlice` 的 `minLen` 兑现（Q88）、
 *      新工具 `braceAt`/`braceSlice` 的配平（Q85）、以及 §51 里三条"扫描器自测自己"的断言。
 *      它们一旦退化，**整套判据会静默变松**（正是 Q88 那个形态：参数在、语义亡）。
 *
 *   | 条 | 打的是 | 该由哪一层拦住 | 期望 |
 *   |---|---|---|---|
 *   | M1 | `fnSlice` 的 `minLen` 兑现被删（抽出一小截也当成功） | check-wb §51 ④b 自测 | BLOCKED |
 *   | M2 | `stripTrailingComments` 退化成"不剥行尾"（F-2 的工具） | check-wb §51 ④c 自测 | BLOCKED |
 *   | M3 | `braceAt` 退化成固定 2800 字符窗口（越界取体） | check-wb §51 ④d 自测 | BLOCKED |
 *
 * 期望：三条全部 `BLOCKED`，`INVALID` 为 0。
 *
 * ⚠️⚠️ **2026-10-05（第 7 轮 · 变异锚点修复）：三条的 `file` 从 `scripts/check-wb.mjs`
 *    改指 `scripts/lib/scan-utils.mjs`。** 这三个函数在 **M-2 首切口**
 *    （2026-10-04）**一字未改地整块搬**出了那个 12,000 行的文件，并加了 `export`
 *    （搬迁理由见那个文件的头注释：`fnBody` 曾被逐字复制 6 份而漏改 6 处）。
 *    ⇒ 锚点必须跟着**实现**走，不是跟着"它历史上住过哪"走 ——
 *      否则命中 0 次、`mutate.mjs` 报 `INVALID`，这三条**拿不到结论**
 *      （而"拿不到结论"极容易被读成"防线没牙"，进而去改一个本来就对的实现）。
 *      纪律原文：**锚点是"实现所在文件"**（本项目第 15 条 / 第 38 轮 M1–M3 立）。
 *
 * ⚠️ 这三条都是**改扫描器自己的工具**，所以"判据红了"这件事本身要靠 §51 的自测
 *    （而不是靠别的判据）—— 也就是说：**自测本身就是这一批的最后一道闸**。
 *    一条自测都没有的工具函数（例如 §51 没覆盖的工具）不在这份清单的射程内，如实登记为盲区。
 * ⚠️ 跑测试一律 `NODE_OPTIONS= node …`（R39），漏带 = 内部基线假红、mutate 拒绝开跑。
 */
const SCAN = 'scripts/lib/scan-utils.mjs';

// M1：Q88 —— `minLen` 又变回死参数（把兑现那一行换成裸 return）。
const M1 = {
  id: 'M1',
  note: 'Q88：fnSlice 的 minLen 兑现被删（`return out.length >= minLen ? out : \'\';` → `return out;`）—— 抽出一小截照样当成功，判据在真空里变绿。预期 BLOCKED（§51 ④b 自测）',
  file: SCAN,
  anchor: /return out\.length >= minLen \? out : '';/,
  count: 1,
  apply: (s) => s.replace("return out.length >= minLen ? out : '';", 'return out;'),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// M2：F-2 的工具退化 —— 行尾注释不再被剥（计数类判据会跟着误红）。
const M2 = {
  id: 'M2',
  note: 'F-2 工具退化：stripTrailingComments 改成直接返回原串（行尾注释不再剥）—— 计数类判据会因行尾注释误红，而"误红会诱导人改松判据"。预期 BLOCKED（§51 ④c 自测）',
  file: SCAN,
  anchor: /function stripTrailingComments\(s\) \{\n  return s\.replace/,
  count: 1,
  apply: (s) => {
    const i = s.indexOf('function stripTrailingComments(s) {');
    const j = s.indexOf('\n}', i);
    return s.slice(0, i) + 'function stripTrailingComments(s) {\n  return s;\n' + s.slice(j);
  },
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// M3：Q85 的工具退化 —— 配平提取变回"固定窗口"（窗尾越界，窗外代码可替检）。
const M3 = {
  id: 'M3',
  note: 'Q85 工具退化：braceAt 改成固定 2800 字符窗口（不再配平）—— 取体会越界（本仓实测越出 rec 74 行），窗外别的代码可替它过检。预期 BLOCKED（§51 ④d 自测）',
  file: SCAN,
  anchor: /if \(b < 0 \|\| src\[b\] !== '\{'\) return '';/,
  count: 1,
  apply: (s) => {
    const i = s.indexOf("  if (b < 0 || src[b] !== '{') return '';");
    const j = s.indexOf('\n}', i);
    return s.slice(0, i)
      + "  if (b < 0 || src[b] !== '{') return '';\n  return src.slice(b, b + 2800);"
      + s.slice(j);
  },
  layer: 'check-wb',
  expect: 'BLOCKED',
};

export default [M1, M2, M3];
