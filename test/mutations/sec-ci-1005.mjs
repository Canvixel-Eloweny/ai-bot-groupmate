/**
 * 开源前审查（2026-10-05）· S-11 的变异清单 —— CI / 依赖更新 / 静态分析。
 *
 * 供 `NODE_OPTIONS= node scripts/mutate.mjs test/mutations/sec-ci-1005.mjs` 复跑。
 *
 * 为什么单独一份而不是并进 sec-1005.mjs：那份已经 13 条、跑一轮要几分钟；
 * 这一组打的是 `.github/` 下的 YAML，改动面完全不同，分开跑更快也更好归因。
 *
 * 为什么这些文件值得配变异：
 *   四层门禁此前**只能靠人在本机跑**（`CONTRIBUTING.md` 就是这么写的），
 *   于是"真实凭据被 `git add -A` 带进仓库"没有任何机器门槛 ——
 *   本仓已发生过两次（`.gitignore:154-155` 有记录）。
 *   ⇒ 这些 YAML 是那道门槛的**载体**，它们被改坏 = 门槛静默消失，没有任何东西会报警。
 *
 *   | 条  | 打的是 | 该由哪一条判据拦住 | 期望 |
 *   |---|---|---|---|
 *   | C1  | 删掉 ci.yml 的 publish-audit job（真值闸门） | §25「ci.yml 没有跑 publish-audit.mjs」 | BLOCKED |
 *   | C2  | dependabot 去掉 github-actions | §25「没有覆盖 github-actions」 | BLOCKED |
 *   | C3  | ci.yml 去掉 `NODE_OPTIONS=` 前缀 | §25「没带 NODE_OPTIONS=」 | BLOCKED |
 *   | C4  | 只在 ci.yml 加注释，代码一字不动 | 防线**不该**响 | NOT-BLOCKED |
 *
 * ⚠️ **C1 是这一组的重点**：`publish-audit` 是**真值闸门** ——
 *    真实 QQ 号 / 群号 / 本机路径进仓库时，它按 `scripts/known-real.mjs` 扫
 *    `git ls-files` 并非零退出。删掉它，S-01/02/03 那批真值清理就失去了守门人。
 *
 * ⚠️ **C4 是误报型**（R44）：期望 NOT-BLOCKED。判据做的是**子串包含**判断，
 *    注释里提到 `check-wb.mjs` 不该让"跑了契约层"这条成立 —— 但本判据就是子串匹配，
 *    所以这条钉的是"注释里提到不会误报"这个**当前事实**；
 *    若将来判据升级成 YAML 结构化解析，这条会变成更有意义的形状。
 *
 * 期望：C1–C3 `BLOCKED`，C4 `NOT-BLOCKED`，`INVALID` 为 0。
 */
const CI = '.github/workflows/ci.yml';
const DEP = '.github/dependabot.yml';

// ── C1：删掉真值闸门 ───────────────────────────────────────────────────────
const C1 = {
  id: 'C1',
  note: '删掉 ci.yml 里的 publish-audit job —— 真值（QQ 号 / 群号 / 本机路径）进仓库时没人拦。预期 BLOCKED',
  // ⚠️ 锚点钉的是**被执行的那一步**，不是"文件里出现过这个文件名"（2026-10-06）：
  //    给这一步加 `hashFiles(...)` 守卫之后，同一份文件里会**再出现一次**该文件名
  //    ⇒ 旧锚点 `publish-audit\.mjs` 命中 2/1、这条变异直接 INVALID。
  //    "判据/锚点钉在存在性上"正是本项目反复吃过的那类假绿。
  anchor: /run: node scripts\/publish-audit\.mjs/,
  count: 1,
  file: CI,
  apply: (s) => s.replace(/\n  # 真值闸门[\s\S]*?run: node scripts\/publish-audit\.mjs\n/, '\n'),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── C2：dependabot 去掉 github-actions ─────────────────────────────────────
const C2 = {
  id: 'C2',
  note: 'dependabot 只留 npm —— GitHub Actions 的版本（`actions/checkout@v4` 这类）从此没人盯着。预期 BLOCKED',
  anchor: /package-ecosystem: github-actions/,
  count: 1,
  file: DEP,
  apply: (s) => s.replace(
    /\n  - package-ecosystem: github-actions\n    directory: \/\n    schedule:\n      interval: weekly\n    open-pull-requests-limit: 5\n/,
    '\n',
  ),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── C3：去掉 NODE_OPTIONS= 前缀 ────────────────────────────────────────────
const C3 = {
  id: 'C3',
  note: 'ci.yml 跑测试去掉 `NODE_OPTIONS=` 前缀 —— R39：shell 注入的 shim 会把 err.code 改写成 CODEBUDDY_BROKER_DENY，CI 上会出现假红（人极易读成"项目坏了"）。预期 BLOCKED',
  // ⚠️ 锚 `run: NODE_OPTIONS=`，计数 2（两个 run 步骤）。
  //    只锚裸的 `NODE_OPTIONS=` 会连文件头注释一起数进来（那里在讲 R39），
  //    计数对不上；而判据侧同样只认 run 行 —— 两边形状必须一致。
  anchor: /run: NODE_OPTIONS=/,
  count: 2,
  file: CI,
  apply: (s) => s.replace(/NODE_OPTIONS= /g, ''),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── C4：只动注释（误报型） ─────────────────────────────────────────────────
const C4 = {
  id: 'C4',
  note: '只在 ci.yml 顶部补一句注释，YAML 结构一字不动 —— 防线**不该**响。预期 NOT-BLOCKED（R44）',
  anchor: /name: 四层门禁/,
  count: 1,
  file: CI,
  apply: (s) => s.replace('# 四层门禁（2026-10-05 开源前审查 · S-11）',
    '# 四层门禁（2026-10-05 开源前审查 · S-11）\n# 注：check-wb.mjs 与 publish-audit.mjs 都在这里跑'),
  layer: 'check-wb',
  expect: 'NOT-BLOCKED',
};

export default [C1, C2, C3, C4];
