/**
 * 开源前审查（2026-10-05）· **S-01 的变异清单** —— 纯数据，
 * 供 `NODE_OPTIONS= node scripts/mutate.mjs test/mutations/sec-s01-1005.mjs` 复跑。
 *
 * 打的对象：真值表**搬出仓库**（`scripts/known-real.mjs` 从"持有真值的表"改成
 * "仓库外加载器"）· 白名单**拆回仓库内**（`scripts/plugin-allowlist.mjs`）·
 * 以及它们两侧的新契约（`scripts/check-wb.mjs` §34）。
 *
 * 为什么这条值得专门配一组变异：
 *   S-01 的整条修复只靠"`known-real.mjs` 里没有真值"这一个事实成立。它一旦被人
 *   （或未来的我）粘回一个字面量，**四层门禁与发布审计都不会响** ——
 *   那正是 P0 级事故（真值重新进版本控制）。所以必须有机器盯着"加载器保持是加载器"。
 *
 *   | 条 | 打的是 | 该由哪一层拦住 | 期望 |
 *   |---|---|---|---|
 *   | M1  | 往加载器里粘回一条 `{ re: /…/ }` 真值条目 | §34 "加载器不许含真值" | BLOCKED |
 *   | M2  | 加载器不再从仓库外读（`os.homedir()` → `process.cwd()`） | §34 "必须从仓库外加载" | BLOCKED |
 *   | M3  | 加载器不再导出 `KNOWN_REAL_LOADED`（空表认不出来） | §34 | BLOCKED |
 *   | M4  | publish-audit 的"空表告警"守卫被关掉（`if (false)`） | §34 守卫形状 | BLOCKED |
 *   | M5  | make-publish-copy 的同一条守卫被关掉 | §34 守卫形状 | BLOCKED |
 *   | M6  | 白名单被清空（`SELF_OWNED_PLUGIN_DIRS = []`） | §8 空数组 + 两处不一致 | BLOCKED |
 *   | M7  | 把白名单**搬回** known-real.mjs（重新合并） | §34 反向：不许同住一处 | BLOCKED |
 *   | M8  | 把 `known-real.mjs` 塞回 make-publish-copy 的排除清单 | §34 反向：加载器必须被拷进产物 | BLOCKED |
 *   | M9  | 只加一行**注释**（提到号码形状）到白名单 | 防线**不该**响 | NOT-BLOCKED |
 *   | M10 | 只加一行**注释**（提到 `re: /…/` 与号码）到加载器 | 防线**不该**响（注释已剥） | NOT-BLOCKED |
 *
 * ⚠️ **M10 是本组的重点**：新契约的两条核心判据（`re: /…/` 条目 + 9–11 位数字）
 *    如果作用在**未剥注释**的源码上，会把"文件里解释一句真值长什么样"误判成泄漏 ——
 *    而误红最容易诱导人**改松判据**（本项目 R38 的三号弱形状）。它钉的是"注释不算数"。
 * ⚠️ **M9/M10 的方向与别的相反**（R44）：期望是**防线不该响**。
 *
 * 期望：M1–M8 `BLOCKED`，M9/M10 `NOT-BLOCKED`，`INVALID` 为 0。
 * ⚠️ 跑测试一律 `NODE_OPTIONS= node …`（R39）；跑之前**先提交**；
 *    用全新的 `QQBOT_MUTATE_WORK` 目录（R46.1：复用旧目录会把工作树回滚）。
 */
const KR = 'scripts/known-real.mjs';
const AUDIT = 'scripts/publish-audit.mjs';
const COPY = 'scripts/make-publish-copy.mjs';
const ALLOW = 'scripts/plugin-allowlist.mjs';

// 加载器里那个"把表交给消费者"的出口 —— 三处变异都锚它（唯一出现）。
const KR_EXPORT = /export const KNOWN_REAL = table;/;

// ── M1：把真值粘回加载器 ────────────────────────────────────────────────────
const M1 = {
  id: 'M1',
  note: '往加载器里粘回一条 { re: /…/ } 真值条目 —— P0 事故（真值重新进版本控制）。预期 BLOCKED（§34 "加载器不许含真值"）',
  anchor: KR_EXPORT,
  count: 1,
  file: KR,
  apply: (s) => s.replace(KR_EXPORT, "export const LEAKED = [{ re: /123456789/g, what: 'x' }];\nexport const KNOWN_REAL = table;"),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M2：加载器不再从仓库外读 ────────────────────────────────────────────────
const M2 = {
  id: 'M2',
  note: '加载器的读取源从仓库外改成进程目录（os.homedir() → process.cwd()）—— 表会落回仓库旁。预期 BLOCKED（§34 "必须从仓库外加载"）',
  anchor: /os\.homedir\(\)/,
  count: 1,
  file: KR,
  apply: (s) => s.replace(/os\.homedir\(\)/, 'process.cwd()'),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M3：空表信号消失 ────────────────────────────────────────────────────────
const M3 = {
  id: 'M3',
  note: '加载器不再导出 KNOWN_REAL_LOADED（改名）—— "表没加载"会静默降级成"没有命中"。预期 BLOCKED（§34 导出契约）',
  anchor: /export const KNOWN_REAL_LOADED = loaded;/,
  count: 1,
  file: KR,
  apply: (s) => s.replace(/export const KNOWN_REAL_LOADED = loaded;/, 'export const KNOWN_REAL_LOADED_INTERNAL = loaded;'),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M4/M5：空表告警守卫被关掉（守卫形状，不是"名字出现过"）──────────────────
const M4 = {
  id: 'M4',
  note: 'publish-audit 的"空表告警"守卫被短路（if (!KNOWN_REAL_LOADED) → if (false)）—— 空表又变成静默降级。预期 BLOCKED（§34 守卫形状）',
  anchor: /if \(!KNOWN_REAL_LOADED\) \{/,
  count: 1,
  file: AUDIT,
  apply: (s) => s.replace(/if \(!KNOWN_REAL_LOADED\) \{/, 'if (false) {'),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

const M5 = {
  id: 'M5',
  note: 'make-publish-copy 的同一条守卫被短路 —— 去标识安全网降级却不说话。预期 BLOCKED（§34 守卫形状）',
  anchor: /if \(!KNOWN_REAL_LOADED\) \{/,
  count: 1,
  file: COPY,
  apply: (s) => s.replace(/if \(!KNOWN_REAL_LOADED\) \{/, 'if (false) {'),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M6：白名单被清空 ───────────────────────────────────────────────────────
const M6 = {
  id: 'M6',
  note: '把自用包白名单清空（SELF_OWNED_PLUGIN_DIRS = []）—— 空输入会让"口径对齐"判据恒真，且发布审计会误杀自用包。预期 BLOCKED（§8 空数组 + 两处不一致）',
  // ⚠️ 锚点认的是「这条 export 语句」而不是数组字面量（2026-10-07 修）：
  //   自用包名单从 1 个长到 5 个、且改成多行排版之后，钉 `= ['plugins/本体情绪/'];`
  //   的锚点命中 0/1 ⇒ 这两条变异从此 INVALID（拿不到任何结论）。
  //   排版与成员都会再变，被执行的那一行不会。
  anchor: /export const SELF_OWNED_PLUGIN_DIRS = \[/,
  count: 1,
  file: ALLOW,
  apply: (s) => s.replace(/export const SELF_OWNED_PLUGIN_DIRS = \[[\s\S]*?\];/, 'export const SELF_OWNED_PLUGIN_DIRS = [];'),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M7：白名单搬回已知真值表模块（重新合并）────────────────────────────────
const M7 = {
  id: 'M7',
  note: '把白名单搬回 known-real.mjs（= 重新合并两件性质不同的东西）—— 真值出仓库时会把白名单一起带走。预期 BLOCKED（§34 反向：不许同住一处）',
  anchor: KR_EXPORT,
  count: 1,
  file: KR,
  apply: (s) => s.replace(KR_EXPORT, "export const SELF_OWNED_PLUGIN_DIRS = ['plugins/本体情绪/'];\nexport const KNOWN_REAL = table;"),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M8：把加载器塞回排除清单 ───────────────────────────────────────────────
const M8 = {
  id: 'M8',
  note: '把 known-real.mjs 塞回 make-publish-copy 的排除清单 —— 拷贝里 make-publish-copy 一 import 就崩、check-wb 在拷贝上直接红。预期 BLOCKED（§34 反向）',
  anchor: /'scripts\/publish-audit\.mjs',\s*\/\/ 按设计持有真实标识符哨兵表/,
  count: 1,
  file: COPY,
  apply: (s) => s.replace(/'scripts\/publish-audit\.mjs',(\s*)\/\/ 按设计持有真实标识符哨兵表/, "'scripts/publish-audit.mjs', 'scripts/known-real.mjs',$1// 按设计持有真实标识符哨兵表"),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M9：只加注释（误报型）───────────────────────────────────────────────────
const M9 = {
  id: 'M9',
  note: '只往白名单模块加一行提到号码形状的注释 —— 防线**不该**响。预期 NOT-BLOCKED（R44：误报型的期望与别的相反）',
  anchor: /export const SELF_OWNED_PLUGIN_DIRS = \[/,
  count: 1,
  file: ALLOW,
  apply: (s) => s.replace(
    /export const SELF_OWNED_PLUGIN_DIRS = \[/,
    "export const SELF_OWNED_PLUGIN_DIRS = [ // 注：这里只放目录名，不放号码（如 123456789 那种真值）。\n"
  ),
  layer: 'check-wb',
  expect: 'NOT-BLOCKED',
};

// ── M10：加载器里只加注释（误报型 · 本组重点）───────────────────────────────
const M10 = {
  id: 'M10',
  note: '只往加载器加一行**注释**，注释里写出 re: /…/ 条目与号码的形状 —— 判据建立在"已剥注释"的源上，**不该**响。预期 NOT-BLOCKED（若响了说明判据没剥注释 → 会诱导人改松判据）',
  anchor: KR_EXPORT,
  count: 1,
  file: KR,
  apply: (s) => s.replace(
    KR_EXPORT,
    "// 说明：真值条目形如 { re: /123456789/g, what: 'x' }，本文件不许再有这种行。\nexport const KNOWN_REAL = table;"
  ),
  layer: 'check-wb',
  expect: 'NOT-BLOCKED',
};

export default [M1, M2, M3, M4, M5, M6, M7, M8, M9, M10];
