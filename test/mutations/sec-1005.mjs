/**
 * 开源前审查（2026-10-05）· S-05 的变异清单 —— 纯数据，
 * 供 `NODE_OPTIONS= node scripts/mutate.mjs test/mutations/sec-1005.mjs` 复跑。
 *
 * 打的对象：面板的 **Host 白名单 + 跨源闸**（`panel/server.js`，判据在 check-wb §3g）。
 *
 * 为什么这条链值得专门配一组变异：
 *   面板只绑 `127.0.0.1`，但**绑回环 ≠ 没有远程入口** —— 恶意站点 DNS Rebinding 之后
 *   浏览器判它同源，`fetch('/')` 能读走 `<meta name="panel-token">` 里的 token，
 *   拿着它打 22 条写路由，最坏一条是插件安装（落目录 + 宿主动态 import ⇒ 本机 RCE）。
 *   而 **token 那一关挡不住它**：重绑之后攻击者就是同源、且能读到 token。
 *   ⇒ 这类"防线看起来还在、其实已经绕过去了"的失效**不报错**，只能靠变异证明有人盯着。
 *
 *   | 条  | 打的是 | 该由哪一条判据拦住 | 期望 |
 *   |---|---|---|---|
 *   | S1  | 删掉 Host 校验块 | §3g「没有校验 Host」 | BLOCKED |
 *   | S2  | `LOOPBACK_HOST_RE` 放宽成"什么都匹配" | §3g「常量必须锚定且含 127.0.0.1」 | BLOCKED |
 *   | S3  | Host 校验**挪到鉴权之后** | §3g「Host 排在鉴权之后」（顺序） | BLOCKED |
 *   | S4  | `sameSiteWrite()` 恒 `true` | §3g「从不拒绝」 | BLOCKED |
 *   | S5  | `sameSiteWrite()` 恒 `false` | §3g「两个头都不带时没有放行」 | BLOCKED |
 *   | S6  | 跨源闸**挪到鉴权之前** | §3g「跨源闸排在鉴权之前」（顺序） | BLOCKED |
 *   | S7  | 只把注释里的 `Origin` 说清楚、代码不动 | 防线**不该**响（无改动） | NOT-BLOCKED |
 *
 * ⚠️ **S2 / S3 / S6 是这一组真正有价值的三条**：
 *    · S2 证明"只验调用点存在"是**不够的**（常量本身被放宽时调用点一个字没动）——
 *      这正是本项目 R38 记过的形状：新写的判据也会被自己的弱形状骗过。
 *      契约为此专门加了一条"常量必须锚定且含 127.0.0.1"。
 *    · S3 / S6 证明**顺序也是判据**：两道闸装反了位置，字符串全在、却是两个真实事故
 *      （一个不留痕、一个误杀 curl 与 launcher.sh）。
 *
 * ⚠️ **S7 是误报型**（R44）：期望 NOT-BLOCKED。它验证判据不会因为"注释里提到 Origin"
 *    就自证式报红 —— 契约读的是 `stripComments` 之后的代码。
 *
 * 期望：S1–S6 `BLOCKED`，S7 `NOT-BLOCKED`，`INVALID` 为 0。
 * ⚠️ 跑测试一律 `NODE_OPTIONS= node …`（R39）。
 * ⚠️ 跑之前**先提交**，并用全新的 `QQBOT_MUTATE_WORK` 目录（R46.1：复用会把工作树回滚）。
 */
const SRV = 'panel/server.js';
// 第 18 轮新增：「保存配置」那条路由的实现搬进了它（S-08 的执行点随之搬走）。
const CR = 'panel/lib/config-route.js';
// 第 19 轮：/api/state 的组装搬进了这里
const STCOL = 'panel/lib/state-collector.js';

const HOST_BLOCK = `  if (!LOOPBACK_HOST_RE.test(String(req.headers.host || ''))) {
    audit.done(403);
    return sendJson(res, { ok: false, error: 'bad host', reason: 'host-not-loopback' }, 403);
  }`;

const CROSS_BLOCK = `    if (isWriteRequest(p, req.method) && !sameSiteWrite(req.headers)) {
      pushLog(\`✗ 写操作被拒（\${p}）—— 跨源请求（Origin 不是本机），已挡下可能的 DNS Rebinding\`);
      return sendJson(res, { ok: false, error: 'cross-site write rejected', reason: 'cross-site' }, 403);
    }`;

// ── S1：删掉 Host 校验块 ───────────────────────────────────────────────────
const S1 = {
  id: 'S1',
  note: '整个 Host 校验块删掉 —— 面板重新对任意 Host 开放，DNS Rebinding 长驱直入。预期 BLOCKED',
  // ⚠️ 锚点必须是**这一块**独有的：`LOOPBACK_HOST_RE.test(` 在文件里有 2 处
  //    （另一处在 sameSiteWrite 内部判 Origin），用它会命中 2/1 → INVALID。
  anchor: /String\(req\.headers\.host \|\| ''\)/,
  count: 1,
  file: SRV,
  apply: (s) => s.replace(HOST_BLOCK, ''),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── S2：把常量本身放宽（调用点一个字没动） ─────────────────────────────────
const S2 = {
  id: 'S2',
  note: '`LOOPBACK_HOST_RE` 放宽成 `/.*/` —— 调用点 `LOOPBACK_HOST_RE.test(` 完全没变，只验"调用了没"的判据会假绿。预期 BLOCKED（由"常量必须锚定且含 127.0.0.1"那条拦）',
  anchor: /const LOOPBACK_HOST_RE = \/\^\(\?:127/,
  count: 1,
  file: SRV,
  apply: (s) => s.replace(/const LOOPBACK_HOST_RE = [^;\n]+;/, 'const LOOPBACK_HOST_RE = /.*/;'),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── S3：Host 校验挪到鉴权之后（顺序错） ────────────────────────────────────
const S3 = {
  id: 'S3',
  note: '把 Host 校验挪到 `authDecision` 之后 —— 字符串全在，但被拒的那一次不再进审计，且顺序反了说明它不是门禁。预期 BLOCKED（§3g 判顺序）',
  anchor: /String\(req\.headers\.host \|\| ''\)/,
  count: 1,
  file: SRV,
  apply: (s) => {
    const moved = s.replace(HOST_BLOCK, '');
    // 插到鉴权块之后（`if (!verdict.allow) return denyUnauthorized(...);` 那一行后面）
    return moved.replace(
      /(\n    if \(!verdict\.allow\) return denyUnauthorized\(res, p, verdict\);\n)/,
      `$1${HOST_BLOCK.replace(/^  /, '    ')}\n`,
    );
  },
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── S4：sameSiteWrite 恒 true（闸形同虚设） ────────────────────────────────
const S4 = {
  id: 'S4',
  note: '`sameSiteWrite()` 开头直接 `return true` —— 跨源闸还在、也还在被调用，但什么也不挡。预期 BLOCKED（§3g「从不拒绝」）',
  anchor: /function sameSiteWrite\(/,
  count: 1,
  file: SRV,
  apply: (s) => s.replace(
    /function sameSiteWrite\(headers = \{\}\) \{/,
    'function sameSiteWrite(headers = {}) {\n  return true;',
  ),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── S5：sameSiteWrite 恒 false（误杀本机脚本） ─────────────────────────────
const S5 = {
  id: 'S5',
  note: '`sameSiteWrite()` 开头直接 `return false` —— 会把 curl / launcher.sh 这类不带 Origin 的本机脚本一起拒掉，面板控制脚本全废。预期 BLOCKED（§3g「两个头都不带时没有放行」）',
  anchor: /function sameSiteWrite\(/,
  count: 1,
  file: SRV,
  apply: (s) => s.replace(
    /function sameSiteWrite\(headers = \{\}\) \{/,
    'function sameSiteWrite(headers = {}) {\n  return false;',
  ),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── S6：跨源闸挪到鉴权之前（顺序错） ───────────────────────────────────────
const S6 = {
  id: 'S6',
  note: '把跨源闸挪到 `authDecision` 之前 —— 不带 Origin 的本机脚本会在过 token 之前就被拒，launcher.sh 直接失效。预期 BLOCKED（§3g 判顺序）',
  anchor: /sameSiteWrite\(req\.headers\)/,
  count: 1,
  file: SRV,
  apply: (s) => {
    const moved = s.replace(CROSS_BLOCK, '');
    return moved.replace(
      // ⚠️ 正则字面量里的 `/` 必须转义：`// 鉴权` 那两个斜杠会**提前终止正则**，
      //    未转义时报错是 "Unterminated group"（本项目本轮刚踩到一次）。
      /(\n  \/\/ 鉴权（B9c · AUTH-PANEL）)/,
      `\n  {\n${CROSS_BLOCK.replace(/^    /, '    ')}\n  }\n$1`,
    );
  },
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── S7：只动注释（误报型） ─────────────────────────────────────────────────
const S7 = {
  id: 'S7',
  note: '只在注释里补一句关于 Origin 的说明，代码一字不动 —— 防线**不该**响（契约读的是剥注释后的源码）。预期 NOT-BLOCKED（R44：误报型的期望与别的相反）',
  anchor: /function sameSiteWrite\(/,
  count: 1,
  file: SRV,
  apply: (s) => s.replace(
    'function sameSiteWrite(headers = {}) {',
    '// 注意：Origin 与 Sec-Fetch-Site 都由浏览器附加，本机脚本没有。\nfunction sameSiteWrite(headers = {}) {',
  ),
  layer: 'check-wb',
  expect: 'NOT-BLOCKED',
};


// ══ S-07~S-10：面板侧四处点状修复（2026-10-05）══════════════════════════════
//
// 这一组顺带补上一个更老的洞：`panel/next/`（**现役控制台**）此前在 check-wb 里
// **零命中** —— 所有面板契约都打在已下线的 `panel/parts/` 上（M-1）。
// 下面是第一次给现役前端上判据，所以要连变异一起配，否则不知道它拦不拦得住。

const APP = 'panel/next/app.js';

// ── X1：把"含 < 就原样插"的分支加回去（存储型 XSS 回归） ──────────────────
const X1 = {
  id: 'X1',
  note: 'kv 渲染器恢复 `val.includes(\'<\') ? val : esc(val)` —— 服务端下发的值（effective.baseUrl，可由 /api/config 写入）就能原样插进 innerHTML。预期 BLOCKED（§3g S-07）',
  anchor: /<dd>\$\{esc\(val\)\}<\/dd>/,
  count: 1,
  file: APP,
  apply: (s) => s.replace(
    '<dd>${esc(val)}</dd>',
    '<dd>${typeof val === \'string\' && val.includes(\'<\') ? val : esc(val)}</dd>',
  ),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── X2：把 baseUrl 的校验整块删掉 ──────────────────────────────────────────
// ⚠️ 第 18 轮（`apiConfig` 搬进 `lib/config-route.js`）：这条变异打的是
//    **S-08 那道闸的执行点**，而执行点跟着整块搬到了新家。
//    锚点与apply 都必须改指 `panel/lib/config-route.js` ——
//    留在 server.js 上会让锚点命中 0（判 INVALID），**一跑就拿不到干净结论**。
//    （判据本身没坏：§3g 与 §83 ④ 都已改成「新家 + 主文件」两处都判。）
const X2 = {
  id: 'X2',
  note: '删掉写baseUrl 前的 baseUrlReject 校验（现在在 lib/config-route.js 里）—— 接口地址重新变成"填什么发什么"，API Key 会跟着请求头发到任意地址。预期 BLOCKED（§3g S-08 + §83 ④）',
  anchor: /const why = baseUrlReject\(wantBase\);/,
  count: 1,
  file: CR,
  // ⚠️ 缩进历史：第 15 轮体缩进 6/8 → 2/4；第 18 轮搬进工厂壳后又 +2 ⇒ 现在是 4/6。
  apply: (s) => s.replace(
    /\n    if \(wantBase\) \{\n      const why = baseUrlReject\(wantBase\);[\s\S]*?\n    \}\n/,
    '\n',
  ),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── X3：只去掉"厂商与域名对不对得上"那一问 ───────────────────────────────
const X3 = {
  id: 'X3',
  note: '从 baseUrlReject 里删掉 providerHostOk 那一问 —— `https://deepseek.com.evil.com` 会重新被当成官方地址放过。预期 BLOCKED（§3g S-08 反向）',
  anchor: /if \(!providerHostOk\(text\)\)/,
  count: 1,
  file: SRV,
  apply: (s) => s.replace(
    /\n  if \(!providerHostOk\(text\)\) \{\n    return '[^']*';\n  \}\n/,
    '\n',
  ),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── X4：把 NapCat WebUI token 加回 /api/state ─────────────────────────────
const X4 = {
  id: 'X4',
  note: '/api/state 恢复下发 `token: napcatToken()` —— 那是 QQ 登录会话凭据，而该路由不鉴权。预期 BLOCKED（§3g S-09）',
  // ⚠️ 第 19 轮：/api/state 的组装随collectState 搬进了 panel/lib/state-collector.js ⇒ 锚点改指新家
  anchor: /webui: \{ url:/,
  count: 1,
  file: STCOL,
  apply: (s) => s.replace(
    'webui: { url: `http://localhost:6099/webui` },',
    'webui: { token: napcatToken(), url: `http://localhost:6099/webui` },',
  ),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── X5：keyMasked 恢复成给出真实字符 ──────────────────────────────────────
const X5 = {
  id: 'X5',
  note: 'keyMasked 恢复 `slice(0, 6) + … + slice(-4)` —— Key 的真实字符重新出现在不鉴权的 /api/state 里。预期 BLOCKED（§3g S-10）',
  // ⚠️ 实际文本是 keyMasked: llmKey ? `${'•'.repeat(8)}… —— 反引号容易被漏掉，
  //    漏了就 0 命中（INVALID）。这里只锚字段名，够唯一也够稳。
  // ⚠️ 第 19 轮：同 X4，随 collectState 搬进了 state-collector.js
  anchor: /keyMasked: llmKey \? /,
  count: 1,
  file: STCOL,
  apply: (s) => s.replace(
    /keyMasked: llmKey \? [^\n]+,/,
    "keyMasked: llmKey ? llmKey.slice(0, 6) + '…' + llmKey.slice(-4) : '',",
  ),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── X6：只动注释（误报型） ─────────────────────────────────────────────────
const X6 = {
  id: 'X6',
  note: '在 app.js 注释里提到 `includes(\'<\')` 这个旧写法，代码一字不动 —— 防线**不该**响（契约读的是剥注释后的源码）。预期 NOT-BLOCKED（R44）',
  anchor: /<dd>\$\{esc\(val\)\}<\/dd>/,
  count: 1,
  file: APP,
  apply: (s) => s.replace(
    '  kv: (x) =>',
    "  // 旧写法 `val.includes('<') ? val : esc(val)` 已删除，别再抄回来。\n  kv: (x) =>",
  ),
  layer: 'check-wb',
  expect: 'NOT-BLOCKED',
};

export default [S1, S2, S3, S4, S5, S6, S7, X1, X2, X3, X4, X5, X6];
