/**
 * 开源前审查（2026-10-05）· **S-12 第四批**（旧页子判据 → 现役控制台）的变异清单 —— 纯数据，
 * 供 `NODE_OPTIONS= node scripts/mutate.mjs test/mutations/sec-s12d-1005.mjs` 复跑。
 *
 * 打的对象：本轮把 §3g / §3h / §3i / §3j / §15 / §20 / §27 的取源从**已下线旧页**
 * （`panel/parts/` 拼装产物 `html`）切到**现役控制台** `panel/next/{app.js,schema.js}`。
 * 切完必须证明：**新的取源真的在盯东西**（不是换了个恒真的判据）—— 本组就是那只手。
 *
 *   | 条 | 打的是 | 该由哪一条判据拦住 | 期望 |
 *   |---|---|---|---|
 *   | M1 | app.js 的 api() 不再带 Authorization（写请求全 401） | §3g 现役页三连 | BLOCKED |
 *   | M2 | schema.js 的「桥接实例数」读错键名 | §3h 实例数下发/消费 | BLOCKED |
 *   | M3 | app.js 的 traceList 不再渲染「为什么没回」 | §3i 对话流 | BLOCKED |
 *   | M4 | schema.js 的撤销动作名被改坏（改名忘了改表） | §3j 配置回滚 | BLOCKED |
 *   | M5 | app.js 不再从下发的 `meta.statusLabels` 取中文名 | §15 面板读的是后端下发的表 | BLOCKED |
 *   | M6 | app.js 插件开关不再只动 `plugins.enabled` 那一格 | §20 ④ 不整份重建 plugins | BLOCKED |
 *   | M7 | app.js 的 `pluginSettingHtml` 少一类控件（string） | §27 按 kind 渲染四类 | BLOCKED |
 *   | M8 | 只在 **app.js 的注释**里写下这些写法 | 防线**不该**响（取源已剥注释） | NOT-BLOCKED |
 *
 * ⚠️ **M8 是本组的重点**（R38「注释里引用字面量 → 判据自证式通过」）：本轮 §3g/§3i/§15/§20/§27
 *    的取源都过 `stripComments`，所以"在注释里写下那个写法"必须**不**触发防线。
 *    ⚠️ 它只动 `app.js`。第 8 轮（开源前审查）之前，`§3h` / `§3j` 的 schema.js 侧
 *       **故意取原文**（`stripComments` 不认字符串，schema.js 的 desc 里有一条通配路径），
 *       所以往 schema.js 里塞注释会**真的**被读到、那就不是"误报型"了；
 *       `stripComments` 改成字符串感知之后那一处绕行已撤回（见 `sec-s12c` 的 M5），
 *       但本条的形态**不变**：它只打 app.js，仍然只证明"app.js 侧剥注释"。
 *
 * 期望：M1–M7 `BLOCKED`，M8 `NOT-BLOCKED`，`INVALID` 为 0。
 * ⚠️ 跑测试一律 `NODE_OPTIONS= node …`（R39）；跑之前**先提交**；
 *    用全新的 `QQBOT_MUTATE_WORK` 目录（R46.1：复用旧目录会把工作树回滚）。
 */
const APP = 'panel/next/app.js';
const SCH = 'panel/next/schema.js';

// ── M1：api() 不再把 token 放进 Authorization（§3g 现役页三连的第二条）────────────
const M1 = {
  id: 'M1',
  note: 'app.js 的 api() 去掉 `Authorization` 赋值 —— 页面所有写请求会 401，而"meta 占位符在"照样绿。预期 BLOCKED（§3g）',
  anchor: /if \(HAS_TOKEN\) opt\.headers\['Authorization'\] = `Bearer \$\{TOKEN\}`;/,
  count: 1,
  file: APP,
  apply: (s) => s.replace(
    /if \(HAS_TOKEN\) opt\.headers\['Authorization'\] = `Bearer \$\{TOKEN\}`;/,
    'if (HAS_TOKEN) { /* token 忘了带上 */ }'
  ),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M2：实例数读错键名（§3h 3h-4 的消费侧）────────────────────────────────────
const M2 = {
  id: 'M2',
  note: 'schema.js 的「桥接实例数」把 `instances` 读成 `instancez` —— 界面上恒显示 0，多实例重新变成隐形。预期 BLOCKED（§3h）',
  anchor: /j\(s, \['bridge', 'instances'\], 0\)/,
  count: 2,
  file: SCH,
  apply: (s) => s.replaceAll(/j\(s, \['bridge', 'instances'\], 0\)/g, "j(s, ['bridge', 'instancez'], 0)"),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M3：对话流不再渲染「为什么没回」（§3i）───────────────────────────────────
const M3 = {
  id: 'M3',
  note: 'app.js 的 traceList 不再渲染 `r.reason` —— 没回的记录在界面上重新变成看不见。预期 BLOCKED（§3i）',
  anchor: /\$\{r\.reason \?/,
  count: 1,
  file: APP,
  apply: (s) => s.replace(/\$\{r\.reason \?/, '${false ?'),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M4：撤销动作名被改坏（§3j）──────────────────────────────────────────────
const M4 = {
  id: 'M4',
  note: 'schema.js 的撤销动作名 `config.undo` 改成 `config.undo2` —— 按钮点下去没有处理者。预期 BLOCKED（§3j）',
  anchor: /'config\.undo'/,
  count: 1,
  file: SCH,
  apply: (s) => s.replace(/'config\.undo'/, "'config.undo2'"),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M5：不再从后端下发的表取状态中文名（§15）─────────────────────────────────
const M5 = {
  id: 'M5',
  note: 'app.js 的 memRecords 不再读 `meta.statusLabels`（改成自己造一个空表）—— 状态徽标会显示英文键。预期 BLOCKED（§15）',
  anchor: /const labels = meta\.statusLabels \|\| \{\};/,
  count: 1,
  file: APP,
  apply: (s) => s.replace(/const labels = meta\.statusLabels \|\| \{\};/, 'const labels = {};'),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M6：插件开关不再只动那一格（§20 ④）───────────────────────────────────────
const M6 = {
  id: 'M6',
  note: 'app.js 的 plugin.toggle 去掉 `touchC(\'plugins.enabled\')` —— 开关改了却不记进草稿，保存时白名单不生效。预期 BLOCKED（§20 ④）',
  anchor: /touchC\('plugins\.enabled'\);/,
  count: 1,
  file: APP,
  apply: (s) => s.replace(/touchC\('plugins\.enabled'\);/, '/* 没记进草稿 */'),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M7：少一类控件（§27 按 kind 渲染四类）────────────────────────────────────
const M7 = {
  id: 'M7',
  note: 'app.js 的 `pluginSettingHtml` 去掉 `string` 分支（改成 stringx）—— 字符串类设置项退回"不支持编辑"。预期 BLOCKED（§27）',
  anchor: /if \(f\.kind === 'string'\) \{/,
  count: 1,
  file: APP,
  apply: (s) => s.replace(/if \(f\.kind === 'string'\) \{/, "if (f.kind === 'stringx') {"),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M8：只在注释里写下这些写法（误报型 · 本组重点）──────────────────────────
const M8 = {
  id: 'M8',
  note: '只在 app.js 顶部**注释**里写下这些写法（Authorization / r.reason / meta.statusLabels / f.kind === string）—— 取源过 stripComments，防线**不该**响。预期 NOT-BLOCKED（R38）',
  anchor: /^const TOKEN = /m,
  count: 1,
  file: APP,
  apply: (s) => s.replace(
    /^const TOKEN = /m,
    "// 反例：注释里写下 HAS_TOKEN) opt.headers['Authorization'] = `Bearer ${TOKEN}`;\n"
      + '// 反例注释：${r.reason ? 1 : 2} / const labels = meta.statusLabels || {}; / if (f.kind === \'string\') {\n'
      + 'const TOKEN = '
  ),
  layer: 'check-wb',
  expect: 'NOT-BLOCKED',
};

export default [M1, M2, M3, M4, M5, M6, M7, M8];
