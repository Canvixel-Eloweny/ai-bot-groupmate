/**
 * 第 11 轮（开源前审查 · **P2 收尾**）的变异清单 —— 纯数据，
 * 供 `NODE_OPTIONS= node scripts/mutate.mjs test/mutations/r11-1005.mjs` 复跑。
 *
 * 打的对象：本轮新加的那三道闸（§71 发布面 docs 白名单 · §72 README 计数不写死 ·
 * §73 重复实现收敛）与 `src/logger.js` 的 5 条新用例（M-04）。
 * **每一条新契约 / 新断言都配一组只打它的变异**（本项目第 4.0.3 条纪律）。
 *
 * | 条 | 打的是 | 该由哪一层拦住 | 期望 |
 * |---|---|---|---|
 * | M1 | 摘掉 `isHeldBackDoc` 排除规则（白名单变空转） | check-wb §71 | BLOCKED |
 * | M2 | 把内部台账加进 `DOCS_KEEP` | check-wb §71 | BLOCKED |
 * | M3 | 白名单塞一条不存在的路径（僵尸条目） | check-wb §71 | BLOCKED |
 * | M4 | 往被发布的 README 里塞死引用 | check-wb §71 | BLOCKED |
 * | M5 | README 把「N 条断言」写回来 | check-wb §72 | BLOCKED |
 * | M6 | README 删掉「不写死」的理由 | check-wb §72 | BLOCKED |
 * | M7 | `logger.emit` 摘掉消息体脱敏 | smoke T380c | BLOCKED |
 * | M8 | `logger.emit` 摘掉 extra 脱敏（JSON 后门） | smoke T380d | BLOCKED |
 * | M9 | `safeJson` 兜底被绕过（直接 JSON.stringify） | smoke T380e | BLOCKED |
 * | M10 | `LEVELS` 分级闸被摘成恒假 | smoke T380 / T380b | BLOCKED |
 * | M11 | `check-wb` 里把 `read` 重复抄回一份 | check-wb §73 | BLOCKED |
 * | M12 | `check-wb` 里把 `walk` 抄回一份（绕过 walkInto） | check-wb §73 | BLOCKED |
 * | M13 | `smoke.js` 把一处 `cfgWith` 改回裸 `...sampleConfig()` | check-wb §73 | BLOCKED |
 * | M14 | `smoke.js` 把一处 `groupEvt()` 改回内联对象 | check-wb §73 | BLOCKED |
 * | M15 | `restart-verify` 摘掉 `lib/cdp.mjs` 的 import | check-wb §73 | BLOCKED |
 *
 * ⚠️ 这批的"只打它"是**逐个核对过的**：每条只改一处，且只有它对应的那一节会红。
 * ⚠️ 跑测试一律 `NODE_OPTIONS= node …`（R39）；用全新的 `QQBOT_MUTATE_WORK` 目录（R46.1）。
 */
const MPC = 'scripts/make-publish-copy.mjs';
const PDOCS = 'scripts/lib/publish-docs.mjs';
const RD = 'README.md';
const LOGR = 'src/logger.js';
const CKWB = 'scripts/check-wb.mjs';
const SMOKE = 'test/smoke.js';
const E2E = 'test/e2e/browser-restart-verify.mjs';

// ── M1：H-12 的排除规则被摘掉（白名单成了一张没人读的表）─────────────────────
const MPC_RULE = /if \(isHeldBackDoc\(f\)\) return false;/;
const M1 = {
  id: 'M1',
  note: '把 make-publish-copy 的 `isHeldBackDoc(f)` 排除规则摘掉（import 还在、叶子还在）——',
  anchor: MPC_RULE,
  count: 1,
  file: MPC,
  apply: (s) => s.replace(MPC_RULE, 'if (false) return false;'),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M2：内部台账混进白名单（"内容形态适不适合公开"这道判断被撤掉）────────────
const PDOCS_HEAD = /export const DOCS_KEEP = \[/;
const M2 = {
  id: 'M2',
  note: '把内部台账 `docs/DEEP-IMPROVE.md` 加进 DOCS_KEEP（名单还在、双向核对照过）——',
  anchor: PDOCS_HEAD,
  count: 1,
  file: PDOCS,
  apply: (s) => s.replace(PDOCS_HEAD, "export const DOCS_KEEP = [\n  'docs/DEEP-IMPROVE.md',"),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M3：白名单塞僵尸条目（"已发布"的假象）──────────────────────────────────
const M3 = {
  id: 'M3',
  note: '给 DOCS_KEEP 塞一条**不存在**的路径（僵尸条目：排除不了任何东西，却让人以为已发布）——',
  anchor: PDOCS_HEAD,
  count: 1,
  file: PDOCS,
  apply: (s) => s.replace(PDOCS_HEAD, "export const DOCS_KEEP = [\n  'docs/ZZZ-NOT-A-FILE.md',"),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M4：被发布的文档里塞死引用（公开仓库里那份并不存在）────────────────────
// ⚠️ 2026-10-06：README.md 改成英文默认版 ⇒ 锚点随第 9 节标题改成英文写法。
const RD_SEC9 = /## 9\. API reference/;
const M4 = {
  id: 'M4',
  note: '往 README（会被发布的文件）里塞一条指向非白名单 docs 的引用 ——',
  anchor: RD_SEC9,
  count: 1,
  file: RD,
  apply: (s) => s.replace(RD_SEC9, '## 9. API reference\n\n内部台账见 [`docs/DEEP-IMPROVE.md`](./docs/DEEP-IMPROVE.md)。'),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M5：M-02 —— 把「N 条断言」写回 README ──────────────────────────────────
// ⚠️ 2026-10-06：同上，锚点改钉英文那行；`apply` 也改成**英文形态**的计数 ——
//    否则这条变异只能证明"中文形态被拦"，而 README 现在是英文的（对它是真空）。
//    它同时覆盖 §72 新增的那三条英文 ROT 判据。
const RD_NPMTEST = /npm test\s+# behaviour regression/;
const M5 = {
  id: 'M5',
  note: 'README 里把四层计数写回去（英文形态 `behaviour regression (449 assertions)`）—— 那份数字腐烂过四次，正是本轮的修法要拦的形态，',
  anchor: RD_NPMTEST,
  count: 1,
  file: RD,
  apply: (s) => s.replace(RD_NPMTEST, 'npm test        # behaviour regression (449 assertions)'),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M6：M-02 —— 删掉"为什么不写死"的理由（修法退化成空话）──────────────────
// ⚠️ 2026-10-06：README.md 改成**英文默认版** ⇒ 这句理由的措辞从「刻意不写死」换成
//    `deliberately not hard-coded`。与 `check-wb` §72 那条判据**成对改**
//    （那里的注释写着"措辞耦合是有意的摩擦，要改这句话就来这里一起改"）。
const RD_WHY = /deliberately not hard-coded/;
const M6 = {
  id: 'M6',
  note: 'README 把"deliberately not hard-coded"这句理由删掉（数字是删了，但下一个人不知道为什么）——',
  anchor: RD_WHY,
  count: 1,
  file: RD,
  apply: (s) => s.replace(RD_WHY, 'listed somewhere else'),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M7：M-04 —— 消息体脱敏被摘 ─────────────────────────────────────────────
const LOG_MSG = /maskSecrets\(String\(msg\)\)/;
const M7 = {
  id: 'M7',
  note: '把 logger.emit 里的 `maskSecrets(String(msg))` 摘成 `String(msg)`（日志照样打印、看不出异常）——',
  anchor: LOG_MSG,
  count: 1,
  file: LOGR,
  apply: (s) => s.replace(LOG_MSG, 'String(msg)'),
  layer: 'smoke',
  expect: 'BLOCKED',
};

// ── M8：M-04 —— extra 那条后门（JSON 形状的凭据）────────────────────────────
const LOG_EXTRA = /maskSecrets\(safeJson\(extra\)\)/;
const M8 = {
  id: 'M8',
  note: '把 emit 里 extra 那一路的脱敏摘掉（`emit(tag,"ok",{apiKey:"sk-…"})` 会把值原样写进日志）——',
  anchor: LOG_EXTRA,
  count: 1,
  file: LOGR,
  apply: (s) => s.replace(LOG_EXTRA, 'safeJson(extra)'),
  layer: 'smoke',
  expect: 'BLOCKED',
};

// ── M9：M-04 —— safeJson 的循环引用兜底被绕过 ──────────────────────────────
const LOG_SAFEJSON = /maskSecrets\(safeJson\(extra\)\)/;
const M9 = {
  id: 'M9',
  note: '绕开 `safeJson`（直接 `JSON.stringify(extra)`）—— extra 自引用时当场抛，**一次日志变成一次崩溃**，',
  anchor: LOG_SAFEJSON,
  count: 1,
  file: LOGR,
  apply: (s) => s.replace(LOG_SAFEJSON, 'maskSecrets(JSON.stringify(extra))'),
  layer: 'smoke',
  expect: 'BLOCKED',
};

// ── M10：M-04 —— LEVELS 分级闸被摘成恒假 ───────────────────────────────────
const LOG_LEVEL = /if \(LEVELS\[level\] < threshold\) return;/;
const M10 = {
  id: 'M10',
  note: '把 emit 的分级闸摘成恒假（`if (false) return;`）—— 阈值失效，debug 也会写出去，',
  anchor: LOG_LEVEL,
  count: 1,
  file: LOGR,
  apply: (s) => s.replace(LOG_LEVEL, 'if (false) return;'),
  layer: 'smoke',
  expect: 'BLOCKED',
};

// ── M11：M-05 —— `read` 被抄回一份 ─────────────────────────────────────────
const CK_ANCHOR = /  const mpcRel = 'scripts\/make-publish-copy\.mjs';/;
const DUP_READ = "  const read = (rel) => stripComments(fs.readFileSync(new URL(rel, import.meta.url), 'utf8'));\n";
const M11 = {
  id: 'M11',
  note: '在 check-wb 某一段里把 `const read = …` 抄回一份（段内重复的老毛病）——',
  anchor: CK_ANCHOR,
  count: 1,
  file: CKWB,
  apply: (s) => s.replace(CK_ANCHOR, DUP_READ + "  const mpcRel = 'scripts/make-publish-copy.mjs';"),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M12：M-05 —— `walk` 被抄回一份（绕过 walkInto）─────────────────────────
const DUP_WALK = '  const walk = (dir, out) => walkInto(dir, out, {});\n';
const M12 = {
  id: 'M12',
  note: '在 check-wb 某一段里把 `const walk = (dir, out) => …` 抄回一份（绕过 walkInto）——',
  anchor: CK_ANCHOR,
  count: 1,
  file: CKWB,
  apply: (s) => s.replace(CK_ANCHOR, DUP_WALK + "  const mpcRel = 'scripts/make-publish-copy.mjs';"),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M13：M-06 —— 一处 cfgWith 退回内联 ─────────────────────────────────────
const SMK_CFG = /      const cfg = cfgWith\(\{\n        context: \{ recentTurns: 12, ambientMessages: 20, ambientBatch: 4 \},\n      \}\);/;
const M13 = {
  id: 'M13',
  note: '把 smoke 里一处 `cfgWith({ context: … })` 改回裸的 `{ ...sampleConfig(), context: … }` ——',
  anchor: SMK_CFG,
  count: 1,
  file: SMOKE,
  apply: (s) => s.replace(SMK_CFG, '      const cfg = {\n        ...sampleConfig(),\n        context: { recentTurns: 12, ambientMessages: 20, ambientBatch: 4 },\n      };'),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M14：M-06 —— 一处 groupEvt 退回内联 ────────────────────────────────────
const SMK_EVT = /const evt = groupEvt\(\);/;
const M14 = {
  id: 'M14',
  note: '把 smoke 里一处 `groupEvt()` 改回内联的群消息事件对象 ——',
  anchor: SMK_EVT,
  count: 10,
  file: SMOKE,
  // 只改**第一处**：其余 9 处保持不变，判据（要求 0 处内联）照样会红 —— 这正是"改一处漏一处"的形状
  apply: (s) => s.replace(SMK_EVT, "const evt = { message_type: 'group', group_id: '100000001', user_id: '2', sender: { nickname: '甲' } };"),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M15：M-07 —— e2e 把脚手架的 import 摘掉（各写一份的老路）───────────────
const E2E_IMP = /import \{ launchCdp, makeCounter, sleep \} from '\.\/lib\/cdp\.mjs';/;
const M15 = {
  id: 'M15',
  note: '把 restart-verify 里 `./lib/cdp.mjs` 的 import 摘掉（脚本会自己造脚手架的老路）——',
  anchor: E2E_IMP,
  count: 1,
  file: E2E,
  apply: (s) => s.replace(E2E_IMP, "// 变异：脚手架 import 被摘（回到各写一份）"),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M16：M-06 的**边界** —— 夹具调用越界进子进程代码串 ──────────────────────
// ⚠️ 这一条是**本轮真实踩过的 bug**（不是想象出来的）：那处字面量住在 `spawn(node -e …)`
//    的模板串里，换成夹具调用后 T160 / T160b / T160c 三条同时红，
//    而失败详情只是一串 `undefined`。§73 的第四条判据就是为它加的。
const SMK_CHILD_EVT = /const evt = \{ message_type: 'group', group_id: '100000001', user_id: '20002', sender: \{ nickname: '路人' \} \};/;
const M16 = {
  id: 'M16',
  note: '把**子进程代码串**里的群消息字面量换成夹具调用（夹具越界；真机现象是三条用例一起红、详情只有 undefined）——',
  anchor: SMK_CHILD_EVT,
  count: 1,
  file: SMOKE,
  apply: (s) => s.replace(SMK_CHILD_EVT, "const evt = groupEvt({ user_id: '20002', sender: { nickname: '路人' } });"),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

export default [M1, M2, M3, M4, M5, M6, M7, M8, M9, M10, M11, M12, M13, M14, M15, M16];
