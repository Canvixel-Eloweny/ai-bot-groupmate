/**
 * 第 15 轮（开源前审查 · **H-10 巨型文件拆分第一半：`panel/server.js` 路由表化**）的
 * 变异清单 —— 纯数据，供 `NODE_OPTIONS= QQBOT_MUTATE_WORK=/tmp/r15-mutate
 * node scripts/mutate.mjs test/mutations/r15-1006.mjs` 复跑。
 *
 * 打的对象：本轮新加的 `§81`（路由表形状 / 分发器接线 / `return await` 兜底 /
 * 表↔handler 双向核对）+ 改指向后的 `§3e`（POST 路由改从路由表抽取、与
 * WRITE_ROUTES / READ_ONLY_POST 同源核对）。
 *
 * | 条 | 打的是 | 该由哪一层拦住 | 期望 |
 * |---|---|---|---|
 * | M1 | 路由表里 `/api/memory/review` 的表项整行被删 | check-wb §3e（WRITE_ROUTES 悬空规则） | BLOCKED |
 * | M2 | 分发器 `.find(` 改成 `.filter(`（查表变"全表都调"） | check-wb §81 ② | BLOCKED |
 * | M3 | `return await route.handler` 的 `await` 被删（拒绝绕过 500 兜底） | check-wb §81 ② | BLOCKED |
 * | M4 | 表项的 `handler: apiMemoryReview` 被改名成不存在的函数 | check-wb §81 ③（悬空引用） | BLOCKED |
 * | M5 | `/api/try` 表项的 `method: 'POST'` 被删（POST 路由从抽取面消失） | check-wb §3e（悬空规则） | BLOCKED |
 * | M6 | `/api/audit` 的表项被删（审计读取接口没了） | check-wb §3f ④ | BLOCKED |
 *
 * ⚠️ **如实登记的覆盖缺口**：无 —— §81 四条子判据全部配到了变异；
 *     「表项数是精确值 39/26」这条与 §80 的两条同形（判"数量"，构造反例 =
 *     增删一整条路由，M1/M5/M6 已等价覆盖"表项数变了会红"）。
 *
 * ⚠️ 跑测试一律 `NODE_OPTIONS= node …`（R39）；用**全新**的 `QQBOT_MUTATE_WORK` 目录（R46.1）。
 */
const SRV = 'panel/server.js';

// ── M1：§3e —— 写路由表项整行被删（登记了 WRITE_ROUTES 却没有这条 POST 路由）──
const M1 = {
  id: 'M1',
  note: '路由表里 /api/memory/review 的表项整行删掉（WRITE_ROUTES 里的登记变成悬空规则）——',
  anchor: /path: '\/api\/memory\/review', method: 'POST'/,
  count: 1,
  file: SRV,
  apply: (s) => s.replace("  { path: '/api/memory/review', method: 'POST', handler: apiMemoryReview },\n", ''),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M2：§81 ② —— 分发器不再"查表"，变成把整张表全调一遍 ────────────────────
const M2 = {
  id: 'M2',
  note: '分发器的 .find( 改成 .filter(（返回的是数组，route.handler 必然 TypeError）——',
  anchor: /API_ROUTES\.find\(\(r\) => r\.path === p/,
  count: 1,
  file: SRV,
  apply: (s) => s.replace(
    "const route = API_ROUTES.find((r) => r.path === p && (r.method || 'GET') === req.method);",
    "const route = API_ROUTES.filter((r) => r.path === p && (r.method || 'GET') === req.method);"
  ),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M3：§81 ② —— `return await` 的 await 被删（拒绝绕过本层 try/catch 的 500 兜底）──
const M3 = {
  id: 'M3',
  note: 'return await route.handler 的 await 删掉（handler 的拒绝静默掉进 unhandledRejection）——',
  anchor: /return await route\.handler\(req, res, url\);/,
  count: 1,
  file: SRV,
  apply: (s) => s.replace(
    'if (route) return await route.handler(req, res, url);',
    'if (route) return route.handler(req, res, url);'
  ),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M4：§81 ③ —— 表项引用的 handler 被改名（悬空引用，一调就 TypeError）──────
const M4 = {
  id: 'M4',
  note: '路由表里 handler: apiMemoryReview 改名成不存在的 apiMemoryReviewGhost ——',
  anchor: /handler: apiMemoryReview \}/,
  count: 1,
  file: SRV,
  apply: (s) => s.replace('handler: apiMemoryReview },', 'handler: apiMemoryReviewGhost },'),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M5：§3e —— POST 标记被删（这条 POST 路由从抽取面里消失，分类变悬空）────────
const M5 = {
  id: 'M5',
  note: '/api/try 表项的 method: \'POST\' 被删（它还登记在分类表里，抽取却找不到了）——',
  anchor: /path: '\/api\/try', method: 'POST'/,
  count: 1,
  file: SRV,
  apply: (s) => s.replace("{ path: '/api/try', method: 'POST', handler: apiTry },", "{ path: '/api/try', handler: apiTry },"),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M6：§3f ④ —— 审计读取接口的表项被删（审计无法被断言）────────────────────
const M6 = {
  id: 'M6',
  note: '路由表里 /api/audit 的表项整行删掉（审计日志从此没有读取接口）——',
  anchor: /path: '\/api\/audit', handler: apiAudit \}/,
  count: 1,
  file: SRV,
  apply: (s) => s.replace("  { path: '/api/audit', handler: apiAudit },\n", ''),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

export default [M1, M2, M3, M4, M5, M6];
