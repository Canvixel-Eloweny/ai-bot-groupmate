/**
 * D23-2（合并转发展开 · 2026-10-01）的变异清单 —— 纯数据，
 * 供 `NODE_OPTIONS= node scripts/mutate.mjs test/mutations/d23-2.mjs` 复跑。
 *
 * 这一批打的是一条**新长出来的能力链**（叶子的判据 → 接线 → 渲染 → 触发判据的隔离），
 * 所以每个变异都指向一个具体的失败形态，而不是"随便改坏一行"：
 *
 *   | 条 | 打的是 | 该由哪一层拦住 | 期望 |
 *   |---|---|---|---|
 *   | M1  | 展开内容漏进 `bareText`（触发判据跟着转发内容走） | check-wb §52⑦（反向断言） | BLOCKED |
 *   | M1b | **同上一条**，改由行为层复跑 | smoke T345②（转发里带关键词也不许回） | BLOCKED |
 *   | M2  | 去掉占位符回落（`text += expanded;`） | check-wb §52⑦ | BLOCKED |
 *   | M3  | 两个参数尝试**对调顺序**（res_id 排在 message_id 前面） | check-wb §52⑥（顺序就是语义） | BLOCKED |
 *   | M4  | 探针不可关（渲染内部节点时会污染量数探针） | check-wb §52⑦ | BLOCKED |
 *   | M5  | 嵌套转发不清空 data（深度不再封顶） | check-wb §52⑤ | BLOCKED |
 *   | M6  | `readForward` 改成 truthy 判断（`"false"` 会把能力关掉） | check-wb §52⑧ | BLOCKED |
 *   | M7  | 单条上限**只读了常量、使用点写死**（`slice(0, 500)`） | check-wb §52②b | BLOCKED |
 *   | M7b | **同上一条**，改由行为层复跑 | smoke T344（逐行核对正文长度） | BLOCKED |
 *   | M8  | 上限量级退化（`FORWARD_MAX_NODES` 20 → 1） | check-wb §52② 量级下限 | BLOCKED |
 *   | M9  | 展开结果没人消费（`flattenMessage` 不再收 forwardText） | check-wb §52⑪ | BLOCKED |
 *   | M10 | fail-open 变成 fail-loud（catch 里 rethrow） | **只由 smoke T346④ 拦** | BLOCKED |
 *   | M11 | 渲染器不再复用 `flattenMessage`（自己 String 一把） | **只由 smoke T345① 拦** | BLOCKED |
 *
 * ⚠️ **M1/M1b 与 M7/M7b 是两组"同一处改动的两条腿"**（本项目纪律 4b：同一处修复的理想形态是
 *    "契约 + 行为"两层都能拦住它）。只跑一层的话，那一层下线之后就没有人知道这里被改坏了。
 * ⚠️ **M10 / M11 刻意只有行为层能拦**：它们改的是**接线形状**，静态判据再去钉就会把实现写死；
 *    这也正是"行为层不能下线"的实证。
 * ⚠️ **M7 这条是"跑完第一遍变异才补上的"**：第一遍实测 `NOT-BLOCKED` ——
 *    旧判据只问"默认值那行有没有引用常量"，于是"常量在、上限亡"（截断点写死数字）全绿。
 *    → 补了 §52②b（三处截断点必须用**解出来的变量**），M7 才真的被拦住。
 *    这条是本轮**变异真的抓到了判据的洞**的实例，别把它当成"清单写错了"。
 *
 * 期望：13 条全部 `BLOCKED`，`INVALID` 为 0。
 * ⚠️ 跑测试一律 `NODE_OPTIONS= node …`（R39），漏带 = 内部基线假红、mutate 会正确地拒绝开跑。
 * ⚠️ 跑之前**先提交**，并用全新的 `QQBOT_MUTATE_WORK` 目录（R46.1：复用旧目录会把工作树回滚）。
 */
const OB = 'src/onebot.js';
const IDX = 'src/index.js';
const FE = 'src/forward-expand.js';

// ── M1：展开放宽了"它读到的内容"，但**绝不许**放宽触发判据 ────────────────────
const M1 = {
  id: 'M1',
  note: '展开内容漏进 bareText（`bareText += \'[合并转发]\'` → `bareText += expanded || \'[合并转发]\'`）—— 转发记录里出现「小鱼」就会把它叫出来。预期 BLOCKED（§52⑦ 反向断言）',
  file: OB,
  anchor: /bareText \+= '\[合并转发\]';/,
  count: 1,
  apply: (s) => s.replace("bareText += '[合并转发]';", "bareText += expanded || '[合并转发]';"),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M1b：与 M1 **同一处改动**，换行为层跑 —— 证明"契约下线之后还有人守着" ─────
const M1b = {
  id: 'M1b',
  note: '同 M1（展开内容漏进 bareText），**改由行为层复跑**：转发内容里带触发关键词「菠萝」时，它应当**仍然不回**。预期 BLOCKED（smoke T345②）',
  file: OB,
  anchor: /bareText \+= '\[合并转发\]';/,
  count: 1,
  apply: (s) => s.replace("bareText += '[合并转发]';", "bareText += expanded || '[合并转发]';"),
  layer: 'smoke',
  expect: 'BLOCKED',
};

// ── M2：展开取不到时**必须**回落成占位符（否则渲染出 undefined） ──────────────
const M2 = {
  id: 'M2',
  note: '去掉占位符回落：`text += expanded || \'[合并转发]\';` → `text += expanded;` —— 展开失败时正文里什么都没有（比"看不见"更糟：它以为对方什么都没发）。预期 BLOCKED（§52⑦ / T346④）',
  file: OB,
  anchor: /text \+= expanded \|\| '\[合并转发\]';/,
  count: 1,
  apply: (s) => s.replace("text += expanded || '[合并转发]';", 'text += expanded;'),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M3：参数尝试的顺序就是语义（协议端只认 message_id；res_id 会过期） ────────
const M3 = {
  id: 'M3',
  note: '两个参数尝试对调顺序（res_id 排在 message_id 之前）—— 真机上会永远走那条"过期 id"的路、天天报 payload is empty。预期 BLOCKED（§52⑥ 顺序判据）',
  file: IDX,
  anchor: /const attempts = \[\];\n/,
  count: 1,
  apply: (s) => {
    const mid = "    if (evt.message_id !== undefined && evt.message_id !== null && String(evt.message_id)) {\n"
      + "      attempts.push({ via: 'message_id', params: { message_id: Number(evt.message_id) || evt.message_id } });\n"
      + '    }\n';
    const res = '    const resId = forwardResIdOf(evt.message);\n'
      + "    if (resId) attempts.push({ via: 'res_id', params: { id: resId } });\n";
    return s.replace(mid + res, res + mid);
  },
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M4：探针必须可关（二次渲染不许进量数文件） ───────────────────────────────
const M4 = {
  id: 'M4',
  note: '探针不可关（`if (probe) probeForwardSegment(seg);` → 直接调）—— 渲染转发**内部节点**时会把二次渲染也记进 panel/forward-probe.jsonl，而那份是"要不要做这个功能"的数据来源。预期 BLOCKED（§52⑦）',
  file: OB,
  anchor: /if \(probe\) probeForwardSegment\(seg\);/,
  count: 1,
  apply: (s) => s.replace('if (probe) probeForwardSegment(seg);', 'probeForwardSegment(seg);'),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M5：嵌套转发深度 1 封顶 ──────────────────────────────────────────────────
const M5 = {
  id: 'M5',
  note: '嵌套转发段不再清空 data（`.map((s) => (... ? { type: \'forward\', data: {} } : s))` → `.map((s) => s)`）—— 内层带着 id 继续走，一旦有人把展开写成递归，转发链会被无限放大。预期 BLOCKED（§52⑤）',
  file: FE,
  anchor: /\.map\(\(s\) => \(\(s\?\.type === 'forward' \|\| s\?\.type === 'node'\) \? \{ type: 'forward', data: \{\} \} : s\)\);/,
  count: 1,
  apply: (s) => s.replace(
    ".map((s) => ((s?.type === 'forward' || s?.type === 'node') ? { type: 'forward', data: {} } : s));",
    '.map((s) => s);'
  ),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M6：配置面"只有真的是 false 才算关" ──────────────────────────────────────
const M6 = {
  id: 'M6',
  note: 'readForward 改成 truthy（`r.enabled !== false` → `!!r.enabled`）—— `"false"` 这种读不懂的值会把能力**静默关掉**（界面上看不出来）。预期 BLOCKED（§52⑧）',
  file: FE,
  anchor: /return \{ enabled: r\.enabled !== false \};/,
  count: 1,
  apply: (s) => s.replace('return { enabled: r.enabled !== false };', 'return { enabled: !!r.enabled };'),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M7：上限必须**被消费到使用点上**（写了没人读 = 上限不存在） ───────────────
//   ⚠️ 这条是**跑完第一遍变异才补上的**：第一遍它实测 NOT-BLOCKED ——
//      `const nodeChars = … : FORWARD_NODE_CHARS;` 照旧读常量，而下面 `body.slice(0, 500)`
//      写死了一个数字，旧判据只看"默认值那行有没有引用常量" → 全绿。
// → 补了 §52②b（钉住三处截断点用的是解出来的变量），M7 才真的被拦住。
const M7 = {
  id: 'M7',
  note: '单条渲染上限脱离常量（`body.slice(0, nodeChars)` → `body.slice(0, 500)`）—— 常量还在、使用点写死，"上限"名存实亡。预期 BLOCKED（§52②b；第一遍实测 **NOT-BLOCKED**，补强判据后才转正）',
  file: FE,
  anchor: /body = body\.slice\(0, nodeChars\);/,
  count: 1,
  apply: (s) => s.replace('body = body.slice(0, nodeChars);', 'body = body.slice(0, 500);'),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M7b：与 M7 **同一处改动**，换行为层跑（T344 会看到正文比单条上限长） ──────
const M7b = {
  id: 'M7b',
  note: '同 M7（截断点写死 500），**改由行为层复跑**：T344 逐行核对"正文长度恰为单条上限"，写死后正文会变长。预期 BLOCKED（smoke T344）',
  file: FE,
  anchor: /body = body\.slice\(0, nodeChars\);/,
  count: 1,
  apply: (s) => s.replace('body = body.slice(0, nodeChars);', 'body = body.slice(0, 500);'),
  layer: 'smoke',
  expect: 'BLOCKED',
};

// ── M8：上限的**量级**退化（行为层读的是同一个常量，看不出来） ────────────────
const M8 = {
  id: 'M8',
  note: '上限量级退化（FORWARD_MAX_NODES 20 → 1）—— 展开退化成"什么都装不下"，而用例 import 的是**同一个常量**，行为层不会响；量级下限是这里唯一的防线。预期 BLOCKED（§52② 量级下限）',
  file: FE,
  anchor: /export const FORWARD_MAX_NODES = 20;/,
  count: 1,
  apply: (s) => s.replace('export const FORWARD_MAX_NODES = 20;', 'export const FORWARD_MAX_NODES = 1;'),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M9：算了却没人用（这类改动的标准失败形态） ──────────────────────────────
const M9 = {
  id: 'M9',
  note: '展开结果没人消费（`flattenMessage(evt.message, selfId, { forwardText: forward.text })` → 不传第三参）—— 展开函数跑了、日志也打了，而正文里仍是 `[合并转发]`：它照样回「我看不见转发的内容」，四层全绿。预期 BLOCKED（§52⑪）',
  file: IDX,
  anchor: /flattenMessage\(evt\.message, selfId, \{ forwardText: forward\.text \}\);/,
  count: 1,
  apply: (s) => s.replace('flattenMessage(evt.message, selfId, { forwardText: forward.text });', 'flattenMessage(evt.message, selfId);'),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M10：fail-open → fail-loud（**只由行为层拦**） ───────────────────────────
const M10 = {
  id: 'M10',
  note: 'catch 里 rethrow（"顺手把错误抛出去好排查"）—— 展开失败会让这条消息整个丢掉：它既不回话、日志里也只有一行 enqueue 异常。静态判据钉不到这里（会写死实现）。预期 BLOCKED（**只由** smoke T346④ 拦）',
  file: IDX,
  anchor: /stat\.error = err\.message;/,
  count: 1,
  apply: (s) => s.replace('stat.error = err.message;', 'stat.error = err.message;\n        throw err;'),
  layer: 'smoke',
  expect: 'BLOCKED',
};

// ── M11：渲染器不再复用 flattenMessage（**只由行为层拦**） ───────────────────
const M11 = {
  id: 'M11',
  note: '渲染器自己 String 一把（不再复用 flattenMessage）—— 段 → 文本出现第二份实现：@ 显示名、图片 / 表情占位符、嵌套封顶全部与主链路漂开。预期 BLOCKED（**只由** smoke T345① 拦：提示词里不再是「小王: 今晚吃什么」）',
  file: IDX,
  anchor: /const renderNode = \(node\) => flattenMessage\(/,
  count: 1,
  apply: (s) => s.replace(
    'const renderNode = (node) => flattenMessage(\n'
    + '      nodeSegmentsOf(node),\n'
    + "      bot.selfId ?? String(evt.self_id ?? ''),\n"
    + '      { probe: false },\n'
    + '    ).text;',
    "const renderNode = (node) => String(node?.message ?? '');"
  ),
  layer: 'smoke',
  expect: 'BLOCKED',
};

export default [M1, M1b, M2, M3, M4, M5, M6, M7, M7b, M8, M9, M10, M11];
