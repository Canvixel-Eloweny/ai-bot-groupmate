/**
 * 第 10 轮（开源前审查 · **P1 收口**）的变异清单 —— 纯数据，
 * 供 `NODE_OPTIONS= node scripts/mutate.mjs test/mutations/sec-r10-1005.mjs` 复跑。
 *
 * 打的对象：本轮新加的那几道门本身。**每一条新契约 / 新断言都配一组只打它的变异**
 * （本项目第 4.0.3 条纪律）—— 否则分不清它是真有牙，还是恰好绿着。
 *
 * | 条 | 打的是 | 该由哪一层拦住 | 期望 |
 * |---|---|---|---|
 * | M1 | 把 href 改回只 `esc(it.url)` | check-wb（H-01 正/反两条） | BLOCKED |
 * | M2 | 把 `safeHref` 的白名单拆掉（原样返回） | smoke T377（行为真值表） | BLOCKED |
 * | M3 | 不再发 CSP（改发一个无害头） | check-wb（H-02 接线） | BLOCKED |
 * | M4 | 给 `script-src` 补上 `unsafe-eval` | smoke T377c（断言的是**内容**不是名字） | BLOCKED |
 *
 * ⚠️ M2 / M4 是这批里最值钱的两条：它们证明这组护栏拦的是**行为**，
 *    而不是"源码里出现过那个名字"（本项目 §6 第 32 条那一族）。
 * ⚠️ 跑测试一律 `NODE_OPTIONS= node …`（R39）；跑之前**先提交**；
 *    用全新的 `QQBOT_MUTATE_WORK` 目录（R46.1：复用旧目录会把工作树回滚）。
 */
const APP = 'panel/next/app.js';
const LEAF = 'panel/next/url-safe.js';
const SRV = 'panel/server.js';
// 第 19 轮（H-10 第二半收尾）：`buildExport` 的实现搬进了这里。
const EXPB = 'panel/lib/export-bundle.js';
const NEXTPAGE = 'panel/lib/next-page.js';

// ── M1：href 退回"只 esc、不过白名单" ────────────────────────────────────────
const APP_HREF = /href="\$\{esc\(safeHref\(it\.url\)\)\}"/;
const M1 = {
  id: 'M1',
  note: '把额度情报的「原文」链接改回只 esc(it.url) —— `javascript:` 不含任何待转义字符，',
  anchor: APP_HREF,
  count: 1,
  file: APP,
  apply: (s) => s.replace(APP_HREF, 'href="${esc(it.url)}"'),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M2：白名单被拆掉（行为层）────────────────────────────────────────────────
// 只改**唯一实现**里的那一行 —— 这正是"正向变异"的形状（§6.6 第 4 条）：
// 它若拦不住，说明护栏只是"名字还在"，而 `javascript:` 已经能过。
const LEAF_GUARD = /return SAFE_HREF_SCHEME\.test\(s\) \? s : '#';/;
const M2 = {
  id: 'M2',
  note: '把 safeHref 的白名单拆掉（原样返回候选值）—— 叶子还在、调用点还在、check-wb 全绿，',
  anchor: LEAF_GUARD,
  count: 1,
  file: LEAF,
  apply: (s) => s.replace(LEAF_GUARD, 'return s;'),
  layer: 'smoke',
  expect: 'BLOCKED',
};

// ── M3：不再发 CSP ───────────────────────────────────────────────────────────
const SRV_CSP = /if \(asset\.name === NEXT_ENTRY\) headers\['Content-Security-Policy'\] = PANEL_CSP;/;
const M3 = {
  id: 'M3',
  note: '把入口页那条 CSP 换成另一个无害的响应头（NEXT_ENTRY 守卫仍在）——',
  anchor: SRV_CSP,
  count: 1,
  file: SRV,
  apply: (s) => s.replace(SRV_CSP, "if (asset.name === NEXT_ENTRY) headers['X-Panel-Entry'] = '1';"),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M4：给 script-src 开 unsafe-eval ────────────────────────────────────────
const LEAF_SCRIPT_SRC = /"script-src 'self'",/;
const M4 = {
  id: 'M4',
  note: '给 script-src 补上 unsafe-eval —— 常量还在、名字还在、check-wb 全绿，',
  anchor: LEAF_SCRIPT_SRC,
  count: 1,
  file: NEXTPAGE,
  apply: (s) => s.replace(LEAF_SCRIPT_SRC, `"script-src 'self' 'unsafe-eval'",`),
  layer: 'smoke',
  expect: 'BLOCKED',
};

// ── M5：人格文件的包含性闸被拆掉（H-03）─────────────────────────────────────
const SRV_PERSONA = /const personaSafe = !!personaFile && isSafeRelPath\(personaFile\);/;
const M5 = {
  id: 'M5',
  note: '把 buildExport 里的人格路径包含性判据拆掉（只留"有没有填"）——',
  anchor: SRV_PERSONA,
  count: 1,
  // ⚠️ 第 19 轮（H-10 第二半收尾）：`buildExport` 整块搬进了
  //    `panel/lib/export-bundle.js` ⇒ 锚点必须改指新家，否则命中 0（判 INVALID）。
  //    ⚠️ 判据本身没坏 —— 那是「变异的前提过时」，两者必须分开认定。
  file: EXPB,
  apply: (s) => s.replace(SRV_PERSONA, 'const personaSafe = !!personaFile;'),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M6：`--` 分隔符被摘掉（H-04 的接线侧）───────────────────────────────────
const SRV_DASH = /'--json', '--', text/;
const M6 = {
  id: 'M6',
  note: '把「试一句」那个 `--` 分隔符摘掉（回到"用户输入直接追加进 argv"）——',
  anchor: SRV_DASH,
  count: 1,
  file: SRV,
  apply: (s) => s.replace(SRV_DASH, "'--json', text"),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M7：拆分器无视 `--`（H-04 的行为侧）─────────────────────────────────────
const CLI_IDX = /const i = a\.indexOf\('--'\);/;
const M7 = {
  id: 'M7',
  note: '让 splitCliArgs 无视 `--`（永远认为没出现）—— 函数还在、被调用着、check-wb 全绿，',
  anchor: CLI_IDX,
  count: 1,
  file: 'scripts/lib/cli-args.mjs',
  apply: (s) => s.replace(CLI_IDX, 'const i = -1;'),
  layer: 'smoke',
  expect: 'BLOCKED',
};

// ── M8：权限判据被摘成恒真（H-08）──────────────────────────────────────────
const CFG_PERM_GUARD = /if \(!Number\.isFinite\(m\) \|\| \(m & 0o077\) === 0\) return '';/;
const M8 = {
  id: 'M8',
  note: '把 configPermNotice 的判据摘掉（恒返回空串）—— 函数名还在、被调用着，',
  anchor: CFG_PERM_GUARD,
  count: 1,
  file: 'src/config.js',
  apply: (s) => s.replace(CFG_PERM_GUARD, "if (true) return '';"),
  layer: 'smoke',
  expect: 'BLOCKED',
};

// ── M9：兜底里加了 process.exit（H-09 · "两侧对称"那条错路）─────────────────
const SRV_FOLD = /fatalFold\.n = 1;/;
const M9 = {
  id: 'M9',
  note: '给 onPanelFatal 补一个 process.exit(1)（"与机器人侧对称"那条错路）——',
  anchor: SRV_FOLD,
  count: 1,
  file: SRV,
  apply: (s) => s.replace(SRV_FOLD, 'fatalFold.n = 1;\n  process.exit(1);'),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M10：兜底不再脱敏（H-09 · 从后门交出凭据）──────────────────────────────
const SRV_MASK = /maskSecrets\(String\(\(e && \(e\.stack \|\| e\.message\)\) \|\| e\)\)/;
const M10 = {
  id: 'M10',
  note: '把 onPanelFatal 的脱敏摘掉（异常正文原样进 /api/logs）——',
  anchor: SRV_MASK,
  count: 1,
  file: SRV,
  apply: (s) => s.replace(SRV_MASK, 'String((e && (e.stack || e.message)) || e)'),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M11：`.env.*` 那条兜底被注释掉（H-05）────────────────────────────────────
// 锚点要**转义那个星号**：写 `.env.*` 当正则的话，`.*` 会变成"任意字符"，
// 于是它会同时命中文件里别的行 —— 计数 1 就会变成 INVALID（脚手架会当场拦住，但更省事的是写对）。
const GI_ENV_STAR = /^\.env\.\*$/m;
const M11 = {
  id: 'M11',
  note: '把 .gitignore 里那条 `.env.*` 注释掉（`.env.local` / `.env.bak` 又不受管了）——',
  anchor: GI_ENV_STAR,
  count: 1,
  file: '.gitignore',
  apply: (s) => s.replace(GI_ENV_STAR, '# .env.*'),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M12：把死链塞回 Issue 配置（H-06）───────────────────────────────────────
const ISSUE_TAIL = /^blank_issues_enabled: false$/m;
const M12 = {
  id: 'M12',
  note: '给 Issue 配置塞回一条保留占位域的 contact_link（漏洞上报的入口又变成死链）——',
  anchor: ISSUE_TAIL,
  count: 1,
  file: '.github/ISSUE_TEMPLATE/config.yml',
  apply: (s) => s.replace(ISSUE_TAIL,
    'contact_links:\n  - name: 安全漏洞\n    url: https://example.invalid/security\n    about: x\nblank_issues_enabled: false'),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M13：上报入口的锚点文本被拿掉（H-06）────────────────────────────────────
const SEC_ENTRY = /Report a vulnerability/;
const M13 = {
  id: 'M13',
  note: '把 SECURITY.md 里那条**可执行的上报路径**换成一句空话 —— 文件还在、章节还在，',
  anchor: SEC_ENTRY,
  count: 1,
  file: 'SECURITY.md',
  apply: (s) => s.replace(SEC_ENTRY, '联系维护者'),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M14：README 不再引用 SECURITY.md（M-01）────────────────────────────────
const RD_SEC = /\[`SECURITY\.md`\]\(\.\/SECURITY\.md\)/;
const M14 = {
  id: 'M14',
  note: '把 README「参与本项目」里对 SECURITY.md 的引用换成不带文件名的散文 ——',
  anchor: RD_SEC,
  count: 1,
  file: 'README.md',
  apply: (s) => s.replace(RD_SEC, '安全策略'),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M15：WebUI 端口又裸露出去（M-03）───────────────────────────────────────
const CMP_PORT = /"127\.0\.0\.1:6099:6099"/;
const M15 = {
  id: 'M15',
  note: '把 WebUI 的端口映射改回裸的（等于绑 0.0.0.0，局域网里谁都能连）——',
  anchor: CMP_PORT,
  count: 1,
  file: 'docker-compose.yml',
  apply: (s) => s.replace(CMP_PORT, '"6099:6099"'),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

export default [M1, M2, M3, M4, M5, M6, M7, M8, M9, M10, M11, M12, M13, M14, M15];
