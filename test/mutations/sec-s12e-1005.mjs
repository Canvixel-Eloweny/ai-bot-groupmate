/**
 * 开源前审查（2026-10-05）· **S-12 第五批**（旧页子判据 → 现役控制台）的变异清单 —— 纯数据，
 * 供 `NODE_OPTIONS= node scripts/mutate.mjs test/mutations/sec-s12e-1005.mjs` 复跑。
 *
 * 打的对象：本轮把 §42 / §43 / §46 / §49 / §50 的取源从**已下线旧页**
 * （`panel/parts/` 拼装产物 `html`）切到**现役控制台** `panel/next/{app.js,schema.js}`。
 * 切完必须证明新的取源**真的在盯东西** —— 本组就是那只手。
 * （§47 的重锚在 `d29.mjs` M11、§49 判定卡的漂移在 `d21.mjs` M10，不重复。）
 *
 *   | 条 | 打的是 | 该由哪一条判据拦住 | 期望 |
 *   |---|---|---|---|
 *   | N1 | app.js 丢了 `bridgeCmd('abort')` 的中止接线 | §42 现役落点 | BLOCKED |
 *   | N2 | schema.js 的 `controlHintOf` 被改名 | §42 现役落点 | BLOCKED |
 *   | N3 | app.js 不再渲染 `lock.pid` | §43 现役落点 | BLOCKED |
 *   | N4 | app.js 的定时行丢了 `date` 控件 | §46 现役落点 | BLOCKED |
 *   | N5 | app.js 的 ZIP 安装入口被改名 | §49 现役落点 | BLOCKED |
 *   | N6 | app.js 不再读 `effective.sleep` | §50 现役落点 | BLOCKED |
 *   | N7 | app.js 的快照标签表少了 `mode` | §50 现役落点（mode/wakeKind/privateWake） | BLOCKED |
 *   | N8 | 只在 **app.js 注释**里写下这些写法 | 防线**不该**响（取源已剥注释） | NOT-BLOCKED |
 *
 * ⚠️ **N8 是误报型**（R38「注释里引用字面量 → 判据自证式通过」）：§42/§43/§46/§49/§50
 *    的现役取源全部过 `stripComments`，所以"在注释里写下那个写法"必须**不**触发防线。
 *    ⚠️ §47 的取源也剥注释，但它的判据是**反向**的（"页面里不许出现 memoryJudge"），
 *       往注释里写反而正是要证明"不算数" —— 那条由 `d29.mjs` M11 的正向形态覆盖。
 *
 * 期望：N1–N7 `BLOCKED`，N8 `NOT-BLOCKED`，`INVALID` 为 0。
 * ⚠️ 跑测试一律 `NODE_OPTIONS= node …`（R39）；跑之前**先提交**；
 *    用全新的 `QQBOT_MUTATE_WORK` 目录（R46.1：复用旧目录会把工作树回滚）。
 */
const APP = 'panel/next/app.js';
const SCH = 'panel/next/schema.js';

// ── N1：中止接线丢了（§42）──────────────────────────────────────────────────
const N1 = {
  id: 'N1',
  note: 'app.js 把 `bridgeCmd(\'abort\')` 改成别名 —— 「中止本轮」按钮点下去没有接线。预期 BLOCKED（§42）',
  anchor: /bridgeCmd\('abort'\)/,
  count: 1,
  file: APP,
  apply: (s) => s.replace(/bridgeCmd\('abort'\)/, "bridgeCmd('abort-x')"),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── N2：控制提示的落点被改名（§42）──────────────────────────────────────────
const N2 = {
  id: 'N2',
  note: 'schema.js 的 `controlHintOf` 改名 —— 「已下发 / 已执行 / 被忽略」这三种状态没人画。预期 BLOCKED（§42）',
  anchor: /function controlHintOf\(/,
  count: 1,
  file: SCH,
  apply: (s) => s.replace(/function controlHintOf\(/, 'function controlHintOfX('),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── N3：锁状态不再渲染（§43）────────────────────────────────────────────────
const N3 = {
  id: 'N3',
  note: 'app.js 把 `[\'bridge\', \'lock\', \'pid\']` 的键读错 —— 「有人持着锁」这件事在界面上重新变成隐形。预期 BLOCKED（§43）',
  anchor: /\['bridge', 'lock', 'pid'\]/,
  count: 1,
  file: APP,
  apply: (s) => s.replace(/\['bridge', 'lock', 'pid'\]/, "['bridge', 'lock', 'pidX']"),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── N4：定时行丢了日期控件（§46）────────────────────────────────────────────
const N4 = {
  id: 'N4',
  note: 'app.js 的定时行去掉 `date` 控件（`data-p="${i}|date"` → 去掉）—— 日期维度在面板上没了。预期 BLOCKED（§46）',
  anchor: /data-a="sched\.set" data-p="\$\{i\}\|date"/,
  count: 1,
  file: APP,
  apply: (s) => s.replace(/data-a="sched\.set" data-p="\$\{i\}\|date"/, 'data-a="sched.set" data-p="${i}|dateX"'),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── N5：ZIP 安装入口被改名（§49）────────────────────────────────────────────
const N5 = {
  id: 'N5',
  note: 'app.js 的 `installZip` 改名 —— 装了后端也没人能用。预期 BLOCKED（§49）',
  anchor: /function installZip\(/,
  count: 1,
  file: APP,
  apply: (s) => s.replace(/function installZip\(/, 'function installZipX('),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── N6：睡眠快照不再被读（§50）──────────────────────────────────────────────
const N6 = {
  id: 'N6',
  note: 'app.js 把 `[\'effective\', \'sleep\']` 读成别的键 —— 后端下发了却没人看。预期 BLOCKED（§50）',
  anchor: /\['effective', 'sleep'\]/,
  count: 1,
  file: APP,
  apply: (s) => s.replace(/\['effective', 'sleep'\]/, "['effective', 'sleepX']"),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── N7：快照标签表少一项（§50）──────────────────────────────────────────────
const N7 = {
  id: 'N7',
  note: 'app.js 的 `SLEEP_LABEL` 去掉 `mode` 一项 —— 叫醒态里的「模式」不再渲染。预期 BLOCKED（§50）',
  anchor: /mode: '模式',/,
  count: 1,
  file: APP,
  apply: (s) => s.replace(/mode: '模式',/, "modeX: '模式',"),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── N8：只在注释里写下这些写法（误报型）────────────────────────────────────
const N8 = {
  id: 'N8',
  note: '只在 app.js 顶部**注释**里写下这些写法（bridgeCmd(abort) / controlHintOf / lock pid / sched date / installZip / effective sleep / mode 模式）—— 取源过 stripComments，防线**不该**响。预期 NOT-BLOCKED（R38）',
  anchor: /^const TOKEN = /m,
  count: 1,
  file: APP,
  apply: (s) => s.replace(
    /^const TOKEN = /m,
    "// 反例注释：bridgeCmd('abort') / function controlHintOf( / ['bridge', 'lock', 'pid']\n"
      + "// 反例注释：data-a=\"sched.set\" data-p=\"${i}|date\" / function installZip( / ['effective', 'sleep'] / mode: '模式',\n"
      + 'const TOKEN = '
  ),
  layer: 'check-wb',
  expect: 'NOT-BLOCKED',
};

export default [N1, N2, N3, N4, N5, N6, N7, N8];
