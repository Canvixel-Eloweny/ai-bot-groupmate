/**
 * D18（跨会话发言 · 2026-10-01）的变异清单 —— 纯数据，
 * 供 `NODE_OPTIONS= node scripts/mutate.mjs test/mutations/d18.mjs` 复跑。
 *
 * 这一批打的是一条"**你不在场的那个群里多出一句话**"的路：
 * 它的失败形态几乎都不会报错（话发到了不该去的地方 / 绕过闸门 / 关着的时候照样带着工具），
 * 所以每条变异都指向一个具体的走样：
 *
 *   | 条  | 打的是 | 该由哪一层拦住 | 期望 |
 *   |---|---|---|---|
 *   | M1  | 目标裁决**不查放行名单**（谁都能发） | check-wb §54② | BLOCKED |
 *   | M2  | 群号形态闸被放宽（`{5,12}` → `{0,99}`） | check-wb §54② | BLOCKED |
 *   | M3  | 绕过 `sayToGroup` 直接 `bot.sendMsg` | check-wb §54③ | BLOCKED |
 *   | M4  | 接线处**自己又判一次花费档位** | check-wb §54④ | BLOCKED |
 *   | M5  | 少了 `journal('cross')`（话说了却查不到） | check-wb §54⑦ | BLOCKED |
 *   | M6  | 少了 `brain.markReplied`（不算"发过话"） | check-wb §54⑦ | BLOCKED |
 *   | M7  | 工具**无条件注册**（关着时请求体也带 schema） | check-wb §54⑤ | BLOCKED |
 *   | M8  | 默认值翻成 `enabled: true` | check-wb §54⑥ **且** smoke T347 | BLOCKED |
 *   | M9  | 配置面就地写一份默认值（真相两份） | check-wb §54⑥ | BLOCKED |
 *   | M10 | trace 少了 `cross` 那一格（审计面没了） | check-wb §54⑧ | BLOCKED |
 *   | M11 | 文本不封顶（`CROSS_TEXT_MAX` 成了摆设） | **只由 smoke T347 拦** | BLOCKED |
 *   | M12 | 可见列表不再过滤"没动静 / 太久没动静" | **只由 smoke T347 拦** | BLOCKED |
 *   | M13 | 渲染不标"你正在这里说话" | **只由 smoke T347 拦** | BLOCKED |
 *   | M14 | 夹具退化成"取第一个工具"（会调成 get_chats） | **只由 smoke T348 拦** | BLOCKED |
 *
 * ⚠️ **M8 是同一处改动的两条腿**（契约层 + 行为层：默认值这件事两边都该响）。
 * ⚠️ **M11/M12/M13 刻意只由行为层拦**：它们改的是"上限/过滤/标注有没有生效"，
 *    静态层只能看到常量还在、函数还在 —— 那正是"另一层不能下线"的实证。
 * ⚠️ **M14 打的是夹具**（`test/mock-llm.js`）：它证明 **T348 不是真空的** ——
 *    夹具一旦不按名字挑工具（按字母序第一个是 `get_chats`），真入口那条用例会立刻红。
 *    "测试自己也会骗自己"这件事，本项目已经有先例（§50 的自测三条同族）。
 *
 * 期望：14 条全部 `BLOCKED`，`INVALID` 为 0。
 * ⚠️ 跑测试一律 `NODE_OPTIONS= node …`（R39），漏带 = 内部基线假红、mutate 会正确地拒绝开跑。
 * ⚠️ 跑之前**先提交**，并用全新的 `QQBOT_MUTATE_WORK` 目录（R46.1：复用旧目录会把工作树回滚）。
 */
const LEAF = 'src/cross-send.js';
const IDX = 'src/index.js';
const CFG = 'src/custom-config.js';
const MOCK = 'test/mock-llm.js';

// ── M1：目标裁决**必须**查放行名单 ──────────────────────────────────────────
const M1 = {
  id: 'M1',
  note: '目标裁决不查名单（`if (!allow.includes(id))` → `if (false)`）—— 它就能去任何群说话，而页面与日志里一切正常。预期 BLOCKED（§54②）',
  anchor: /if \(!allow\.includes\(id\)\) \{/,
  count: 1,
  file: LEAF,
  apply: (s) => s.replace('if (!allow.includes(id)) {', 'if (false) {'),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M2：群号形态闸被放宽 ────────────────────────────────────────────────────
const M2 = {
  id: 'M2',
  note: '群号形态闸从 `{5,12}` 放宽到 `{0,99}` —— 任何字符串都能当目标传下去，报错发生在协议端而不是这里。预期 BLOCKED（§54②）',
  anchor: /\{5,12\}/,
  count: 1,
  file: LEAF,
  apply: (s) => s.replace('{5,12}', '{0,99}'),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M3：绕过唯一出口（直接发） ──────────────────────────────────────────────
const M3 = {
  id: 'M3',
  note: '绕过 `sayToGroup` 直接 `bot.sendMsg` —— 出口闸门 / 分句 / 发送节奏全绕过，而日志里只有"发送成功"。预期 BLOCKED（§54③）',
  anchor: /const n = await sayToGroup\(target\.group, norm\.text\);/,
  count: 1,
  file: IDX,
  apply: (s) => s.replace('const n = await sayToGroup(target.group, norm.text);',
    "await bot.sendMsg('group', target.group, [textSegment(norm.text)]);\n      const n = 1;"),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M4：接线处自己又判一次配额 ──────────────────────────────────────────────
const M4 = {
  id: 'M4',
  note: '在 `toolSendTo` 里再判一次花费档位（`usageGateOf()`）—— 与 `planFor` 两个闸各判一次，迟早不一致。预期 BLOCKED（§54④）',
  anchor: /const why = crossBlockReason\(target\.group\);/,
  count: 1,
  file: IDX,
  apply: (s) => s.replace('const why = crossBlockReason(target.group);',
    'usageGateOf();\n    const why = crossBlockReason(target.group);'),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M5：话说出去了却**查不到** ──────────────────────────────────────────────
const M5 = {
  id: 'M5',
  note: "少了 `journal('cross')` —— 它跑去别的群说了话，而 append-only 留档里没有这一行。预期 BLOCKED（§54⑦）",
  anchor: /journal\('cross', /,
  count: 1,
  file: IDX,
  // 注释掉那一行：`stripComments` 会把整行注释剥掉 → 契约数到 0
  apply: (s) => s.replace("journal('cross', ", "// journal('cross', "),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M6：不记账 = 配额闸门只是装饰品 ────────────────────────────────────────
const M6 = {
  id: 'M6',
  note: '少了 `brain.markReplied(...)` —— 主动出站不算"发过话"，这道配额闸门就只是装饰品。预期 BLOCKED（§54⑦）',
  anchor: /brain\.markReplied\(sessionOfGroup\(target\.group\)\);/,
  count: 1,
  file: IDX,
  apply: (s) => s.replace('brain.markReplied(sessionOfGroup(target.group));', ''),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M7：工具**无条件注册** ─────────────────────────────────────────────────
const M7 = {
  id: 'M7',
  note: '把"开闸才注册"改成无条件注册 —— 关着的时候每个请求体也凭空多两条 schema，'
    + '而"零注册工具 → 请求体逐字节相同"（T100/T101）静默失效。预期 BLOCKED（§54⑤）',
  anchor: /if \(cfg\.custom\?\.crossSend\?\.enabled === true\) \{/,
  count: 1,
  file: IDX,
  apply: (s) => s.replace('if (cfg.custom?.crossSend?.enabled === true) {', 'if (true) {'),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M8：默认值翻面（**两条腿**：契约层 + 行为层都该响） ─────────────────────
const M8 = {
  id: 'M8',
  note: '默认值翻成 `enabled: true` —— 跨会话发言是行为面变更，默认关是它的边界。预期 BLOCKED（§54⑥）',
  anchor: /export const CROSS_DEFAULTS = \{ enabled: false \};/,
  count: 1,
  file: LEAF,
  apply: (s) => s.replace('export const CROSS_DEFAULTS = { enabled: false };',
    'export const CROSS_DEFAULTS = { enabled: true };'),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M8b：与 M8 **同一处改动**，换行为层跑 ──────────────────────────────────
const M8b = {
  id: 'M8b',
  note: '同 M8（默认值翻成 true），**改由行为层复跑**：T347 里"配置默认必须是关的"那一条应当红。预期 BLOCKED（smoke T347）',
  anchor: /export const CROSS_DEFAULTS = \{ enabled: false \};/,
  count: 1,
  file: LEAF,
  apply: (s) => s.replace('export const CROSS_DEFAULTS = { enabled: false };',
    'export const CROSS_DEFAULTS = { enabled: true };'),
  layer: 'smoke',
  expect: 'BLOCKED',
};

// ── M9：真相两份（配置面就地写默认值） ─────────────────────────────────────
const M9 = {
  id: 'M9',
  note: '配置面不喂 `readCrossSend`、就地写一份默认值 —— 默认值从此有两处真相，改一处不够。预期 BLOCKED（§54⑥）',
  anchor: /crossSend: readCrossSend\(c\.crossSend\),/,
  count: 1,
  file: CFG,
  apply: (s) => s.replace('crossSend: readCrossSend(c.crossSend),', 'crossSend: { enabled: false },'),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M10：审计面丢一格 ──────────────────────────────────────────────────────
const M10 = {
  id: 'M10',
  note: 'trace 的 reply 记录里去掉 `cross` 那一格 —— "它到底跑去别的群说了什么"事后无从复盘。预期 BLOCKED（§54⑧）',
  anchor: /^\s*cross: crossStat,$/m,
  count: 1,
  file: IDX,
  apply: (s) => s.replace('cross: crossStat,\n', ''),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M11：文本上限成摆设（**只由行为层拦**） ────────────────────────────────
const M11 = {
  id: 'M11',
  note: '文本不再封顶 —— 常量还在、函数还在，静态层看不出异常；但它在另一个群里一次吐出几百字。预期 BLOCKED（**只由** smoke T347 拦）',
  anchor: /return \{ ok: true, text: s\.length > CROSS_TEXT_MAX \? s\.slice\(0, CROSS_TEXT_MAX\) : s \};/,
  count: 1,
  file: LEAF,
  apply: (s) => s.replace(
    'return { ok: true, text: s.length > CROSS_TEXT_MAX ? s.slice(0, CROSS_TEXT_MAX) : s };',
    'return { ok: true, text: s };'
  ),
  layer: 'smoke',
  expect: 'BLOCKED',
};

// ── M12：可见列表不再过滤（**只由行为层拦**） ──────────────────────────────
const M12 = {
  id: 'M12',
  note: '可见列表不再过滤"没动静 / 太久没动静"的群 —— 它就会跑去一个死群里自言自语，而静态层看不出。预期 BLOCKED（**只由** smoke T347 拦）',
  anchor: /if \(maxAgeMs > 0 && \(!lastAt \|\| now - lastAt > maxAgeMs\)\) continue;/,
  count: 1,
  file: LEAF,
  apply: (s) => s.replace('if (maxAgeMs > 0 && (!lastAt || now - lastAt > maxAgeMs)) continue;', 'if (false) continue;'),
  layer: 'smoke',
  expect: 'BLOCKED',
};

// ── M13：渲染不标"你正在这里说话"（**只由行为层拦**） ──────────────────────
const M13 = {
  id: 'M13',
  note: '渲染不再标出当前会话 —— 模型很可能把话说到自己正在说话的这个群里（那条路绕过"这一轮的回复"）。预期 BLOCKED（**只由** smoke T347 拦）',
  anchor: /const mark = c\.group === self \? /,
  count: 1,
  file: LEAF,
  apply: (s) => s.replace("const mark = c.group === self ? ' ← 你正在这里说话，别用工具回这个群' : '';",
    "const mark = '';"),
  layer: 'smoke',
  expect: 'BLOCKED',
};

// ── M14：夹具退化成"取第一个工具" → 证明 T348 **不是真空的** ────────────────
const M14 = {
  id: 'M14',
  note: '把夹具的 `pick(\'send_to\', …)` 换成"取第一个工具"（`mk`）—— 按字母序第一个是 `get_chats`，'
    + '于是真入口那条用例会**全绿但一步都没走要验的那条路**；这里应当立刻红。预期 BLOCKED（**只由** smoke T348 拦）',
  anchor: /return pick\('send_to', /,
  count: 1,
  file: MOCK,
  apply: (s) => s.replace("return pick('send_to', ", 'return mk('),
  layer: 'smoke',
  expect: 'BLOCKED',
};

export default [M1, M2, M3, M4, M5, M6, M7, M8, M8b, M9, M10, M11, M12, M13, M14];
