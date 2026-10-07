/**
 * 第 9 轮（开源前审查 · **S-04 git 历史清洗**）的变异清单 —— 纯数据，
 * 供 `NODE_OPTIONS= node scripts/mutate.mjs test/mutations/sec-r9-1005.mjs` 复跑。
 *
 * 打的对象：**发布审计的例外名单**。
 *
 * 为什么这一条值得专门配一组变异（这是本轮最值钱的教训）：
 *   第 9 轮开工第一件事是量「HEAD 上还有没有真值」，结果**只查到一处** ——
 *   而那一处就住在 `scripts/publish-audit.mjs` **自己的注释里**（一个真实群号）。
 *   它能活那么久的全部原因是：`SELF_SKIP` 里有一条 `'scripts/publish-audit.mjs'`，
 *   于是**唯一有能力扫它的那个脚本，恰好被自己排除在外**。
 *   四层回归（check-wb / smoke / presets / panel）、CI、发布审计 —— **全绿**。
 *
 *   那条跳过的**理由早就没了**：真值表 2026-09-27 搬去 `known-real.mjs`、
 *   S-01 再搬去仓库外，本文件里一个真值字面量都不剩。没人回来删它，是因为
 *   **删不删都不会有任何东西响** —— 这正是需要判据的地方。
 *
 *   | 条 | 打的是 | 该由哪一层拦住 | 期望 |
 *   |---|---|---|---|
 *   | M1 | 把 `'scripts/publish-audit.mjs'` **塞回** SELF_SKIP | 本节"不许把自己列进例外名单" | BLOCKED |
 *   | M2 | 只在 SELF_SKIP 里加**一行注释**提到同一路径 | 防线**不该**响 | NOT-BLOCKED |
 *
 * ⚠️ **M2 的方向与 M1 相反**（R44：误报型的期望和别的相反）。它钉的是"判据建立在
 *    **已剥注释**的源上" —— 注释里提一句路径只是说明，不是接线。
 *    若 M2 变红，说明判据被写到了未剥注释的源上，而那会让"在注释里解释一句"
 *    被当成违规，进而诱导人**改松判据**（本项目 R38 的三号弱形状）。
 *
 * ⚠️ 判据**刻意不查"文件里有没有数字"**：既有裁决 M10（`sec-s01-1005.mjs`）明确
 *    认定"注释里写号码形状不算数"。这里要钉的是"这道闸闭着眼"（名单的事），
 *    不是"注释里有什么"（形状的事）—— 两者别混。
 *
 * 期望：M1 `BLOCKED`，M2 `NOT-BLOCKED`，`INVALID` 为 0。
 * ⚠️ 跑测试一律 `NODE_OPTIONS= node …`（R39）；跑之前**先提交**；
 *    用全新的 `QQBOT_MUTATE_WORK` 目录（R46.1：复用旧目录会把工作树回滚）。
 */
const AUDIT = 'scripts/publish-audit.mjs';

// SELF_SKIP 数组的收口处 —— 三处变异都锚它（`'scripts/known-real.mjs',` + `];` 唯一出现）。
const SKIP_TAIL = /'scripts\/known-real\.mjs',\s*\n\];/;

// ── M1：把自己塞回例外名单 ──────────────────────────────────────────────────
const M1 = {
  id: 'M1',
  note: '把 publish-audit 自己塞回 SELF_SKIP —— 它已不含真值（表在仓库外），再跳过等于让唯一能扫它的闸合上。'
    + '预期 BLOCKED（本节反向断言：不许把自己列进例外名单；第 9 轮实测它就这样藏了一个真实群号）',
  anchor: SKIP_TAIL,
  count: 1,
  file: AUDIT,
  apply: (s) => s.replace(SKIP_TAIL, "'scripts/known-real.mjs',\n  'scripts/publish-audit.mjs',\n];"),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M2：只加注释（误报型）────────────────────────────────────────────────────
const M2 = {
  id: 'M2',
  note: '只在 SELF_SKIP 里加**一行注释**提到同一路径 —— 判据跑在已剥注释的源上，防线**不该**响。'
    + '预期 NOT-BLOCKED（若响了说明判据没剥注释 → 会诱导人改松判据）',
  anchor: SKIP_TAIL,
  count: 1,
  file: AUDIT,
  apply: (s) => s.replace(
    SKIP_TAIL,
    "'scripts/known-real.mjs',\n  // 注：'scripts/publish-audit.mjs' 这一条已经撤掉，别再加回来。\n];"
  ),
  layer: 'check-wb',
  expect: 'NOT-BLOCKED',
};

export default [M1, M2];
