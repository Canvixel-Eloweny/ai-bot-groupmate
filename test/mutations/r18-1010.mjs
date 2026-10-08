/**
 * 第 18 轮（开源前审查 · **H-10 第二半第一块落地**）的变异清单 ——
 * 纯数据，供 `NODE_OPTIONS= QQBOT_MUTATE_WORK=/tmp/r18-mutate
 * node scripts/mutate.mjs test/mutations/r18-1010.mjs` 复跑。
 *
 * 本轮把「保存配置」这条路由（`apiConfig`，292 行）从 `panel/server.js` 搬进
 * `panel/lib/config-route.js`，四个共享判据走**注入**（它们在主文件里另有调用点），
 * 并把 `custom-config.js` / `injection.js` / `gate-scan.js` 登记进 `LIB_SRC_ALLOW`
 * （三者传递闭包实测不触达重型链：9 / 2 / 1 个模块）。
 *
 * 主文件 3963 → 3678 行（−285）。
 *
 * | 条 | 打的是 | 该由哪一层拦住 | 期望 |
 * |---|---|---|---|
 * | M1 | 新家删掉注入闸门的 `looksInjected(item?.text)` | §83 ④ | BLOCKED |
 * | M2 | 主文件又本地留一份 `apiConfig` 实现（搬一半） | §83 ① | BLOCKED |
 * | M3 | 接线里少注入 `waitEffectiveApplied` | §83 ② | BLOCKED |
 * | M4 | 把判据 `sameUrl` 搬进新家（两份实现各活一份） | §83 ② 反向 | BLOCKED |
 * | M5 | 主文件那份 `bridgeRunning` 被删（连带打坏另外 7 处） | §83 ③ | BLOCKED |
 * | M6 | 工厂导出被改成裸函数（注入点消失） | §83 ⑤ | BLOCKED |
 *
 * ⚠️ **M4 与 M2 是同一个失败模式的两个位置**（实现 / 判据）：
 *   两份实现各活一份，后改的那份不生效 —— 而页面上完全看不出来。
 *   只测M2 会漏掉「判据被顺手搬进新家」这一半。
 *
 * ⚠️ **M5 打的是反向自证**：§83 ② 的反向只判「不许搬进新家」，
 *   若不judge 主文件那份还在不在，把注入改成从别处取之后主文件那份可能被顺手删掉。
 *
 * ⚠️ 跑测试一律 `NODE_OPTIONS= node …`（R39）；用**全新**的 `QQBOT_MUTATE_WORK` 目录（R46.1）。
 */
const CWB = 'scripts/check-wb.mjs';
const CR = 'panel/lib/config-route.js';
const SRV = 'panel/server.js';

// ── M1：新家丢了一道闸门（注入闸门消失 ⇒ 用户能把提示词注入存进手动记忆）────
const M1 = {
  id: 'M1',
  note: 'config-route.js 里注入闸门的 looksInjected(item?.text) 被删 —— 手动记忆那条闸在新家不存在了 ——',
  anchor: /const kind = looksInjected\(item\?\.text\);/,
  count: 1,
  file: CR,
  apply: (s) => s.replace(
    'const kind = looksInjected(item?.text);',
    "const kind = 'none';"
  ),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M2：主文件又留一份实现（搬家只搬一半的经典漏）────────────────────────
const M2 = {
  id: 'M2',
  note: 'server.js 里又本地定义一份 apiConfig（实现留在原地，新家成了摆设）——',
  anchor: /const apiConfig = makeConfigRoute\(\{/,
  count: 1,
  file: SRV,
  apply: (s) => s.replace(
    'const apiConfig = makeConfigRoute({ baseUrlReject, sameUrl, bridgeRunning, waitEffectiveApplied });',
    'async function apiConfig(req, res, url) {\n  return sendJson(res, { ok: true });\n}'
  ),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M3：接线少注入一个判据（那个判断悄悄失效）─────────────────────────────
// ⚠️ 只写**合法**代码：注入一个别名而不是删掉整行（删掉会让 §83② 的形状正则
//    匹配不到，那是另一种红、不是这条要验的）。少注入 = 自由变量 undefined。
const M3 = {
  id: 'M3',
  note: '工厂接线里少注入 waitEffectiveApplied（保存后永远报「机器人还没确认」）——',
  anchor: /const apiConfig = makeConfigRoute\(\{/,
  count: 1,
  file: SRV,
  apply: (s) => s.replace(
    'const apiConfig = makeConfigRoute({ baseUrlReject, sameUrl, bridgeRunning, waitEffectiveApplied });',
    'const apiConfig = makeConfigRoute({ baseUrlReject, sameUrl, bridgeRunning });'
  ),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M4：判据被搬进新家（与主文件那份两份实现各活一份）──────────────────────
// ⚠️ 这条与 M2 同形、位置不同：M2 是「实现」重复，M4 是「判据」重复。
//    后者更隐蔽 —— 判据搬进 lib 看起来是"顺手清理主文件"。
const M4 = {
  id: 'M4',
  note: 'config-route.js 里自己定义了一份 sameUrl（主文件另有一份 ⇒ 两份实现各活一份）——',
  anchor: /export function makeConfigRoute\(deps\) \{/,
  count: 1,
  file: CR,
  apply: (s) => s.replace(
    'export function makeConfigRoute(deps) {',
    'function sameUrl(a, b) {\n  return String(a || "") === String(b || "");\n}\n\nexport function makeConfigRoute(deps) {'
  ),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M5：主文件那份判据被删（连带打坏另外 7 个调用点，报错点在别处）──────────
const M5 = {
  id: 'M5',
  note: 'server.js 里的 bridgeRunning 被删（它另有 7 个调用点，会连带打坏那些路由）——',
  anchor: /^function bridgeRunning\(\) \{$/m,
  count: 1,
  file: SRV,
  apply: (s) => s.replace(
    /function bridgeRunning\(\) \{[\s\S]*?\n\}\n/,
    ''
  ),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M6：工厂导出被改成裸函数（注入点消失 ⇒ 接线拿到 undefined）─────────────
const M6 = {
  id: 'M6',
  note: 'config-route.js 不再导出 makeConfigRoute(deps)（注入点没了）——',
  anchor: /export function makeConfigRoute\(deps\) \{/,
  count: 1,
  file: CR,
  apply: (s) => s.replace(
    'export function makeConfigRoute(deps) {',
    'export const makeConfigRoute = null;\nfunction unusedFactory(deps) {'
  ),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

export default [M1, M2, M3, M4, M5, M6];