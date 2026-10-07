/**
 * 开源前审查（2026-10-05）· **S-13 的变异清单** —— 纯数据，
 * 供 `NODE_OPTIONS= node scripts/mutate.mjs test/mutations/sec-s13-1005.mjs` 复跑。
 *
 * 打的对象：五个**核心安全模块**（此前**变异覆盖为 0**）——
 *   `src/gate-scan.js`（闸门遍历的唯一实现 + 哨兵/fail 策略）
 *   `src/egress.js`（出口闸门 + 日志脱敏 + 运行时凭据阻断集）
 *   `src/injection.js`（注入闸门）
 *   `src/safe-fetch.js`（SSRF 地址判据；与 net-rules 不许互相 import）
 *   `src/ext-scope.js`（扩展包权限边界：给的是受限代理，不是原始 OneBot 客户端）
 *
 * 为什么这组值得存在：项目自己的纪律是「每处修复都配一组只打它的变异」（`scripts/mutate.mjs` 六条纪律），
 * 而 `src/index.js` 有 129 次引用、这五个模块 **0 次** —— 一旦有人把它们"顺手简化"回去，
 * 四层门禁与回归**都不会响**。本组就是给它们装上的回归闸。
 *
 *   | 条 | 打的是 | 该由哪一层拦住 | 期望 |
 *   |---|---|---|---|
 *   | G1  | gate-scan 长出 import（破坏零依赖） | §10b 零依赖 | BLOCKED |
 *   | G2  | `isBlocking` 把哨兵也判成拦截（fail-open → fail-closed） | §10b ②b **本轮新增** | BLOCKED |
 *   | G3  | egress 又长回"遍历规则表 + re.test" | §10b ① | BLOCKED |
 *   | G4  | injection 不再调用 scanRules（只留 import） | §10b ①b **本轮新增** | BLOCKED |
 *   | G5  | memory.js 把 `isBlocking(kind)` 写成 `if (kind)` | §10b ② | BLOCKED |
 *   | G6  | brain.js 用上 isBlocking（出口闸门悄悄变 fail-open） | §10b ③ | BLOCKED |
 *   | E1  | scanEgress 不再跑值匹配（真实 Key 原样发出） | §21 | BLOCKED |
 *   | E2  | maskSecrets 不再消费阻断集（Key 原样落日志） | §21 | BLOCKED |
 *   | E3  | 去掉 scanEgress 的 `typeof text === 'string'` 前置 | §21 | BLOCKED |
 *   | X1  | ext-scope 长出 import（破坏零依赖叶子） | §14 ⑧e | BLOCKED |
 *   | X2  | index.js 把裸 `bot` 交给扩展包 | §14 ⑧e | BLOCKED |
 *   | S1  | safe-fetch 引入非 node 依赖（与 net-rules 的边界） | §10 自身依赖 | BLOCKED |
 *   | N1  | gate-scan 只加注释（注释里写着规则的写法） | 防线**不该**响 | NOT-BLOCKED |
 *   | N2  | egress 只加注释（注释里写着 `String(text ?? '')`） | 防线**不该**响 | NOT-BLOCKED |
 *
 * ⚠️ **G2 / G4 是本组的重点**：它们一开始都是**真缺口** ——
 *    旧判据只查"名字/import 在不在"，于是 `return null;`（闸门废掉）与
 *    `return !!kind;`（策略反了）都能**全绿通过**。本轮据此给 §10b 补了两条判据
 *    （"必须真的调用 scanRules" + "isBlocking 必须引用哨兵"）才把它们拦住 ——
 *    即**变异既验证码，也验证契约本身**。
 * ⚠️ **N1/N2 的方向与别的相反**（R44）：期望是防线**不该**响。
 *    它们钉的是"判据建立在已剥注释的源上" —— 若判据作用在原文上，
 *    一句解释性注释就会被当成违规，而误红最容易诱导人**改松判据**（R38 的三号弱形状）。
 *
 * 期望：G1–G6 / E1–E3 / X1–X2 / S1 = 12 条 `BLOCKED`，N1/N2 `NOT-BLOCKED`，`INVALID` 为 0。
 * ⚠️ 跑测试一律 `NODE_OPTIONS= node …`（R39）；跑之前**先提交**；
 *    用全新的 `QQBOT_MUTATE_WORK` 目录（R46.1：复用旧目录会把工作树回滚）。
 */
const GS = 'src/gate-scan.js';
const EG = 'src/egress.js';
const INJ = 'src/injection.js';
const SF = 'src/safe-fetch.js';
const XS = 'src/ext-scope.js';
const IDX = 'src/index.js';
const MEM = 'src/memory.js';
const BRAIN = 'src/brain.js';

const GS_SENTINEL = /export const GATE_ERROR_KIND = '闸门规则异常';/;
const SCAN_EGRESS_FN = /export function scanEgress\(text\) \{/;
const TS_GUARD = /if \(typeof text === 'string' && hasRuntimeSecret\(text\)\) return RUNTIME_SECRET_KIND;/;

// ── G1：gate-scan 长出依赖 ──────────────────────────────────────────────────
const G1 = {
  id: 'G1',
  note: 'src/gate-scan.js 加一行 `import fs from \'node:fs\'` —— 它必须零依赖（被机器人进程与面板进程同时加载）。预期 BLOCKED（§10b 零依赖）',
  anchor: GS_SENTINEL,
  count: 1,
  file: GS,
  apply: (s) => s.replace(GS_SENTINEL, "import fs from 'node:fs';\nexport const GATE_ERROR_KIND = '闸门规则异常';"),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── G2：fail-open 的真值语义被改掉（本组重点之一）──────────────────────────
const G2 = {
  id: 'G2',
  note: 'isBlocking 不再排除哨兵（kind !== GATE_ERROR_KIND → 直接 !!kind）—— 注入闸门从 fail-open 悄悄变成 fail-closed（闸门一坏记忆无声停摆）。预期 BLOCKED（§10b ②b 本轮新增）',
  anchor: /return !!kind && kind !== GATE_ERROR_KIND;/,
  count: 1,
  file: GS,
  apply: (s) => s.replace(/return !!kind && kind !== GATE_ERROR_KIND;/, 'return !!kind;'),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── G3：egress 又长回一份遍历 ───────────────────────────────────────────────
const G3 = {
  id: 'G3',
  note: 'egress 里塞回一行"遍历规则表 + re.test" —— 唯一实现被复制回第二处。预期 BLOCKED（§10b ①）',
  anchor: SCAN_EGRESS_FN,
  count: 1,
  file: EG,
  apply: (s) => s.replace(SCAN_EGRESS_FN, "export function scanEgress(text) {\n  for (const r of EGRESS) if (r.re.test(text)) break;"),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── G4：injection 只 import 不调用（本组重点之一）──────────────────────────
const G4 = {
  id: 'G4',
  note: 'injection 的 looksInjected 不再调用 scanRules（改成 return null）—— import 行还在、也没有自写循环，**旧判据全绿**，而注入闸门彻底失效。预期 BLOCKED（§10b ①b 本轮新增）',
  anchor: /return kindOf\(scanRules\(INJECTION_PATTERNS, text\)\);/,
  count: 1,
  file: INJ,
  apply: (s) => s.replace(/return kindOf\(scanRules\(INJECTION_PATTERNS, text\)\);/, 'return null;'),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── G5：fail-open 调用点写成 if (kind) ─────────────────────────────────────
const G5 = {
  id: 'G5',
  note: 'src/memory.js 把 `if (isBlocking(kind))` 写成 `if (kind)` —— 哨兵被当成命中，注入闸门静默变成 fail-closed。预期 BLOCKED（§10b ②）',
  anchor: /if \(isBlocking\(kind\)\) \{/,
  count: 1,
  file: MEM,
  apply: (s) => s.replace(/if \(isBlocking\(kind\)\) \{/, 'if (kind) {'),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── G6：出口闸门被改成 fail-open ────────────────────────────────────────────
const G6 = {
  id: 'G6',
  note: 'src/brain.js 用上 isBlocking —— 出口闸门从 fail-closed 悄悄变成 fail-open（凭据可能真发出去）。预期 BLOCKED（§10b ③）',
  anchor: /const blocked = scanEgress\(chunks\.join\('\\n'\)\);/,
  count: 1,
  file: BRAIN,
  apply: (s) => s.replace(
    /const blocked = scanEgress\(chunks\.join\('\\n'\)\);/,
    "const blocked = scanEgress(chunks.join('\\n')); const _gateProbe = isBlocking(blocked);"
  ),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── E1：出口闸门不再做值匹配 ───────────────────────────────────────────────
const E1 = {
  id: 'E1',
  note: 'scanEgress 里把值匹配短路（if (false) return RUNTIME_SECRET_KIND）—— 模型复述真实 Key 时一路漏出去。预期 BLOCKED（§21 函数体检查）',
  anchor: TS_GUARD,
  count: 1,
  file: EG,
  apply: (s) => s.replace(TS_GUARD, 'if (false) return RUNTIME_SECRET_KIND;'),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── E2：日志脱敏不再消费阻断集 ─────────────────────────────────────────────
const E2 = {
  id: 'E2',
  note: 'maskSecrets 里的值替换循环被删掉 —— 真实 Key 原样落进日志（日志本身就是一次泄漏）。预期 BLOCKED（§21 maskSecrets 函数体）',
  anchor: /for \(const v of runtimeSecrets\) s = s\.split\(v\)\.join\('\*\*\*'\);/,
  count: 1,
  file: EG,
  apply: (s) => s.replace(/for \(const v of runtimeSecrets\) s = s\.split\(v\)\.join\('\*\*\*'\);/, '// 停跑值匹配'),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── E3：去掉坏输入的前置 ───────────────────────────────────────────────────
const E3 = {
  id: 'E3',
  note: 'scanEgress 去掉 `typeof text === \'string\'` 前置（直接调 hasRuntimeSecret）—— 坏输入在受保护扫描之前被强转，绕过 fail-closed 哨兵。预期 BLOCKED（§21）',
  anchor: TS_GUARD,
  count: 1,
  file: EG,
  apply: (s) => s.replace(TS_GUARD, 'if (hasRuntimeSecret(text)) return RUNTIME_SECRET_KIND;'),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── X1：ext-scope 长出依赖 ─────────────────────────────────────────────────
const X1 = {
  id: 'X1',
  note: 'src/ext-scope.js 加一行 import —— 边界判据必须是零依赖叶子。预期 BLOCKED（§14 ⑧e）',
  anchor: /export const SEND_ACTION_RE = \/\^send_\/;/,
  count: 1,
  file: XS,
  apply: (s) => s.replace(/export const SEND_ACTION_RE = \/\^send_\/;/, "import fs from 'node:fs';\nexport const SEND_ACTION_RE = /^send_/;"),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── X2：把裸 OneBot 客户端交给扩展包 ───────────────────────────────────────
const X2 = {
  id: 'X2',
  note: 'src/index.js 把 `onebot: scopedOnebot(bot, { log })` 换成裸 `onebot: bot` —— 扩展包绕过出口闸门/节奏/配额**直接发言**。预期 BLOCKED（§14 ⑧e 反向）',
  anchor: /onebot: scopedOnebot\(bot, \{ log \}\),/,
  count: 1,
  file: IDX,
  apply: (s) => s.replace(/onebot: scopedOnebot\(bot, \{ log \}\),/, 'onebot: bot,'),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── S1：safe-fetch 越界（自身依赖必须全是 node: 内置）──────────────────────
const S1 = {
  id: 'S1',
  note: 'src/safe-fetch.js 引入 `./net-rules.js` —— 它只许依赖 node: 内置（"能不能去"与"花不花钱"两份判据不许互相 import）。预期 BLOCKED（§10 自身依赖）',
  anchor: /import http from 'node:http';/,
  count: 1,
  file: SF,
  apply: (s) => s.replace(/import http from 'node:http';/, "import './net-rules.js';\nimport http from 'node:http';"),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── N1：只加注释（误报型）──────────────────────────────────────────────────
const N1 = {
  id: 'N1',
  note: '只往 gate-scan.js 加一行注释，注释里写出"遍历规则表 + re.test"的写法 —— 判据建立在已剥注释的源上，**不该**响。预期 NOT-BLOCKED（R44）',
  anchor: GS_SENTINEL,
  count: 1,
  file: GS,
  apply: (s) => s.replace(GS_SENTINEL, "// 反例说明：for (const r of rules) if (r.re.test(s)) return r.kind;\nexport const GATE_ERROR_KIND = '闸门规则异常';"),
  layer: 'check-wb',
  expect: 'NOT-BLOCKED',
};

// ── N2：只加注释（误报型）──────────────────────────────────────────────────
const N2 = {
  id: 'N2',
  note: '只往 egress.js 加一行注释，注释里写出被判为"绕过 fail-closed"的那个写法 —— 判据必须剥注释后才判，**不该**响。预期 NOT-BLOCKED（R44）',
  anchor: SCAN_EGRESS_FN,
  count: 1,
  file: EG,
  apply: (s) => s.replace(SCAN_EGRESS_FN, "// 历史：第一版在这里写了 String(text ?? '')，T80 当场变红。\nexport function scanEgress(text) {"),
  layer: 'check-wb',
  expect: 'NOT-BLOCKED',
};

export default [G1, G2, G3, G4, G5, G6, E1, E2, E3, X1, X2, S1, N1, N2];
