/**
 * 第 14 轮（开源前审查 · **M-09 `docs/` 物理归档** + `R11-d1/d3/d4` 裁决落地）的变异清单 ——
 * 纯数据，供 `NODE_OPTIONS= QQBOT_MUTATE_WORK=/tmp/r14-mutate node scripts/mutate.mjs
 * test/mutations/r14-1005.mjs` 复跑。
 *
 * 打的对象：本轮新加的 `§80`（归档完整性 / 旧族零复活 / 滚动窗口 / 含真值件不入库 /
 * `--with-handoff` 死路已删）。
 *
 * | 条 | 打的是 | 该由哪一层拦住 | 期望 |
 * |---|---|---|---|
 * | M1 | `.gitignore` 里 `docs/OPENSOURCE-REVIEW-1005.md` 那条规则被删 | check-wb §80 ④ | BLOCKED |
 * | M2 | `.gitignore` 里 `docs/persona-apply-whalegirl.html` 那条规则被删 | check-wb §80 ④ | BLOCKED |
 * | M3 | `make-publish-copy.mjs` 又长出 `withHandoff`（死路复活） | check-wb §80 ⑤ | BLOCKED |
 * | M4 | `ARCHIVE.md` 里 `R12-P3-L-CLOSE-1005.html` 那处名字被删 | check-wb §80 ① | BLOCKED |
 * | M5 | `ARCHIVE.md` 里 `B30-…` 那处名字被删 | check-wb §80 ① | BLOCKED |
 * | M6 | `ARCHIVE.md` 里 `WHY-25-33-1004.html` 那处名字被删 | check-wb §80 ① | BLOCKED |
 *
 * ⚠️ **如实登记的覆盖缺口**：`§80` 有两条判据**打不到** ——
 *     ②-b「逐轮交付报告滚动只留最近两轮」与 ③「顶层被跟踪文件 ≤ 15」。
 *     它们判的是**"某个文件在不在 `docs/` 顶层"**，而 `scripts/mutate.mjs` 只改文件内容、
 *     **不增删文件** ⇒ 无法用这个工具构造反例。这两条只能靠 `git ls-files` 的实跑读数。
 *     （与 §9 的抽取器那条一样，属"已知边界"，不假装被覆盖。）
 *
 * ⚠️ 跑测试一律 `NODE_OPTIONS= node …`（R39）；用**全新**的 `QQBOT_MUTATE_WORK` 目录（R46.1）。
 */
const GI = '.gitignore';
const MPC = 'scripts/make-publish-copy.mjs';
const AR = 'docs/ARCHIVE.md';

// ── M1：R11-d3 —— 含真值的审查报告那条 ignore 规则被删 ───────────────────────
const M1 = {
  id: 'M1',
  note: '删掉 .gitignore 里 docs/OPENSOURCE-REVIEW-1005.md 那条（含真值 12 处的文件又只剩"靠人记得别 add"）——',
  anchor: /^docs\/OPENSOURCE-REVIEW-1005\.md$/m,
  count: 1,
  file: GI,
  apply: (s) => s.replace('docs/OPENSOURCE-REVIEW-1005.md\n', ''),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M2：R11-d4 —— persona 那条 ignore 规则被删 ──────────────────────────────
const M2 = {
  id: 'M2',
  note: '删掉 .gitignore 里 docs/persona-apply-whalegirl.html 那条（含 2 处机器人显示昵称）——',
  anchor: /^docs\/persona-apply-whalegirl\.html$/m,
  count: 1,
  file: GI,
  apply: (s) => s.replace('docs/persona-apply-whalegirl.html\n', ''),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M3：R11-d1 —— `--with-handoff` 那条死路又长回来 ─────────────────────────
const M3 = {
  id: 'M3',
  note: 'make-publish-copy 又长出 withHandoff（它读的 docs/HANDOFF.md 不存在 ⇒ 一用就 ENOENT）——',
  anchor: /^if \(!dest\) \{$/m,
  count: 1,
  file: MPC,
  apply: (s) => s.replace('if (!dest) {', "const withHandoff = process.argv.includes('--with-handoff');\nif (!dest) {"),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M4：M-09 —— 归档索引里少登记一份（本轮新归档的）─────────────────────────
const M4 = {
  id: 'M4',
  note: '把 ARCHIVE.md 里 R12-P3-L-CLOSE-1005.html 那处名字删掉（归档了却查不到去哪）——',
  anchor: /`R12-P3-L-CLOSE-1005\.html`/,
  count: 1,
  file: AR,
  apply: (s) => s.replace('`R12-P3-L-CLOSE-1005.html`', ''),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M5：M-09 —— 归档索引里少登记一份（更早那批 B3x）─────────────────────────
const M5 = {
  id: 'M5',
  note: '把 ARCHIVE.md 里 B30-模型线路拖拽排序-收口报告.html 那处名字删掉 ——',
  anchor: /`B30-模型线路拖拽排序-收口报告\.html`/,
  count: 1,
  file: AR,
  apply: (s) => s.replace('`B30-模型线路拖拽排序-收口报告.html`', ''),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M6：M-09 —— 归档索引里少登记一份（1004 那轮的说明件）────────────────────
const M6 = {
  id: 'M6',
  note: '把 ARCHIVE.md 里 WHY-25-33-1004.html 那处名字删掉 ——',
  anchor: /`WHY-25-33-1004\.html`/,
  count: 1,
  file: AR,
  apply: (s) => s.replace('`WHY-25-33-1004.html`', ''),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

export default [M1, M2, M3, M4, M5, M6];
