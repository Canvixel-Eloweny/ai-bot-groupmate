/**
 * 开源前审查（2026-10-05）· **S-12 第二批**（现役控制台动作面）的变异清单 —— 纯数据，
 * 供 `NODE_OPTIONS= node scripts/mutate.mjs test/mutations/sec-s12b-1005.mjs` 复跑。
 *
 * 打的对象：`scripts/check-wb.mjs` §68（本轮新增）—— 现役控制台 `panel/next/` 的
 * 「页面上每个 `data-a` 都必须有处理者」。它是旧页 §1「onclick 引用的函数必须存在」
 * 在现役页（`data-a` + 三张表）上的对应物。
 *
 *   | 条 | 打的是 | 该由哪一层拦住 | 期望 |
 *   |---|---|---|---|
 *   | M1 | 入口页加一个**没有处理者**的按钮 | §68 正查 | BLOCKED |
 *   | M2 | 把一个**真实按钮**的动作名改坏（相当于改名忘了改表） | §68 正查 | BLOCKED |
 *   | M3 | 运行期 `auditActions()` 的已知集合少合一张表 | §68 反查（口径分家） | BLOCKED |
 *   | M4 | 只在 **`querySelector` 的选择器串**里加一个假动作名 | 防线**不该**响 | NOT-BLOCKED |
 *
 * ⚠️ **M4 是本组的重点**：`data-a="…"` 也会出现在
 *    `document.querySelector('[data-a="memlist.new"]')` 这类选择器里 ——
 *    那是历史标记的回退查找，不是页面元素。**第一版判据没排除它，当场误报一个"死按钮"**
 *    （`memlist.new`）。M4 就是钉这条：抽取规则必须只认**属性位置**。
 * ⚠️ **M4 的方向与别的相反**（R44）：期望是防线**不该**响。
 *
 * 期望：M1–M3 `BLOCKED`，M4 `NOT-BLOCKED`，`INVALID` 为 0。
 * ⚠️ 跑测试一律 `NODE_OPTIONS= node …`（R39）；跑之前**先提交**；
 *    用全新的 `QQBOT_MUTATE_WORK` 目录（R46.1：复用旧目录会把工作树回滚）。
 */
const IDX = 'panel/next/index.html';
const APP = 'panel/next/app.js';

// ── M1：加一个没人处理的按钮 ────────────────────────────────────────────────
const M1 = {
  id: 'M1',
  note: '入口页尾部加一个 `data-a="nope.dead"` 的按钮 —— 三张表里都没有它，点下去不会有任何反应。预期 BLOCKED（§68 正查）',
  anchor: /<\/body>/,
  count: 1,
  file: IDX,
  apply: (s) => s.replace(/<\/body>/, '<button data-a="nope.dead">x</button></body>'),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M2：真实按钮的动作名被改坏 ──────────────────────────────────────────────
const M2 = {
  id: 'M2',
  note: '把保存条那个按钮的动作名改坏（`draft-save` → `draft-save-x`）—— 相当于"改了按钮忘了改表"。预期 BLOCKED（§68 正查）',
  anchor: /data-a="draft-save"/,
  count: 1,
  file: IDX,
  apply: (s) => s.replace(/data-a="draft-save"/, 'data-a="draft-save-x"'),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M3：运行期自检与静态契约口径分家 ────────────────────────────────────────
const M3 = {
  id: 'M3',
  note: '运行期 `auditActions()` 的已知集合里去掉 `...SHELL_ACTIONS` —— 顶栏那四个按钮会被现场自检判成"没有处理者"，而静态契约还在按三张表算。预期 BLOCKED（§68 反查）',
  anchor: /const known = new Set\(\[\.\.\.Object\.keys\(ACTIONS\), \.\.\.INLINE_ACTIONS, \.\.\.SHELL_ACTIONS\]\);/,
  count: 1,
  file: APP,
  apply: (s) => s.replace(
    /const known = new Set\(\[\.\.\.Object\.keys\(ACTIONS\), \.\.\.INLINE_ACTIONS, \.\.\.SHELL_ACTIONS\]\);/,
    'const known = new Set([...Object.keys(ACTIONS), ...INLINE_ACTIONS]);'
  ),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M4：只在选择器串里加假动作名（误报型 · 本组重点）───────────────────────
const M4 = {
  id: 'M4',
  note: '只在 `querySelector` 的选择器串里再串一个假动作名 —— 那不是页面元素，防线**不该**响。预期 NOT-BLOCKED（R44）',
  anchor: /document\.querySelector\('\[data-a="memlist\.new"\]'\)/,
  count: 1,
  file: APP,
  apply: (s) => s.replace(
    /document\.querySelector\('\[data-a="memlist\.new"\]'\)/,
    "document.querySelector('[data-a=\"memlist.new\"]') || document.querySelector('[data-a=\"ghost.one\"]')"
  ),
  layer: 'check-wb',
  expect: 'NOT-BLOCKED',
};

export default [M1, M2, M3, M4];
