/**
 * B2 守卫定向变异（2026-11-05 · §184）。
 *
 * 三个洞的共同点是「**入口还在，守卫被摘掉后照常工作**」：
 *   · OneBot 少一行形状守卫 → 一个 JSON null 就能让机器人进程退出；
 *   · /api/try 归回只读 → 无 token、无 Origin、无单飞，连点就多烧模型费；
 *   · 重定向只验首/尾 → 中间跳已经打到禁止目标上了。
 *
 * 跑法（串行；会改写真实工作树，失败后用 `--restore`）：
 *   NODE_OPTIONS= node scripts/mutate.mjs test/mutations/audit-b2-2026-11-05.mjs
 */

const OB = 'src/onebot.js';
const SRV = 'panel/server.js';
const DL = 'panel/lib/update-download.js';
const SF = 'src/safe-fetch.js';
const EXT = 'src/ext-fetch.js';
const PKG = 'package.json';
const DOC = 'docs/API_CONTRACT.md';

export default [
  {
    id: 'M1',
    note: 'OneBot 摘掉形状守卫 —— §184① 必须变红（JSON null 复活直接崩溃）',
    file: OB,
    anchor: /if \(payload === null \|\| typeof payload !== 'object' \|\| Array\.isArray\(payload\)\) \{/g,
    count: 1,
    apply: (s) => s.replace(
      "if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {",
      'if (false) {',
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M2',
    note: '脏帧计数被摘掉 —— §184① 必须变红（无效流量不再可观测）',
    file: OB,
    anchor: /this\.badFrames \+= 1;/g,
    count: 1,
    apply: (s) => s.replace('this.badFrames += 1;', 'this.badFrames += 0;'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M3',
    note: '/api/try 从写路由摘掉 —— §184② 必须变红（无 token 也能真调模型）',
    file: SRV,
    anchor: /^  '\/api\/try',$/m,
    count: 1,
    apply: (s) => s.replace("  '/api/try',\n", ''),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M4',
    note: '单飞闸被摘掉 —— §184② 必须变红（连点就并发调模型）',
    file: SRV,
    anchor: /if \(!tryGate\.acquire\(\)\) \{/g,
    count: 1,
    apply: (s) => s.replace('if (!tryGate.acquire()) {', 'if (false) {'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M5',
    note: '试跑错误输出不再脱敏 —— §184② 必须变红（原始输出可能带凭据）',
    file: SRV,
    anchor: /const detail = maskSecrets\(\(r\.stdout \+ r\.stderr\)\.slice\(-DRYRUN_TAIL_CHARS\)\);/g,
    count: 1,
    apply: (s) => s.replace(
      'const detail = maskSecrets((r.stdout + r.stderr).slice(-DRYRUN_TAIL_CHARS));',
      'const detail = (r.stdout + r.stderr).slice(-DRYRUN_TAIL_CHARS);',
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M6',
    note: '更新下载退回 redirect:follow —— §184③ 必须变红（只验最终 URL）',
    file: DL,
    anchor: /redirect: 'manual'/g,
    count: 1,
    apply: (s) => s.replace("redirect: 'manual'", "redirect: 'follow'"),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M7',
    note: 'safeFetch 不再执行逐跳 urlGuard —— §184④ 必须变红（扩展浏览可被重定向绕过）',
    file: SF,
    anchor: /if \(typeof opts\.urlGuard === 'function'\) \{/g,
    count: 1,
    apply: (s) => s.replace("if (typeof opts.urlGuard === 'function') {", 'if (false) {'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M8',
    note: 'ext-fetch 不再把 urlGuard 交给 safeFetch —— §184④ 必须变红',
    file: EXT,
    anchor: /const r = await safeFetchImpl\(url, \{ urlGuard \}\);/g,
    count: 1,
    apply: (s) => s.replace('const r = await safeFetchImpl(url, { urlGuard });', 'const r = await safeFetchImpl(url);'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M9',
    note: 'B2 回归从 check:features 摘掉 —— §184⑤ 必须变红',
    file: PKG,
    anchor: /node test\/check-onebot-frames\.mjs && node test\/check-try-auth\.mjs && node test\/check-fetch-redirect\.mjs && /g,
    count: 1,
    apply: (s) => s.replace(
      'node test/check-onebot-frames.mjs && node test/check-try-auth.mjs && node test/check-fetch-redirect.mjs && ',
      'node test/check-fetch-redirect.mjs && ',
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M10',
    note: 'API 契约退回"只读"口径 —— §184⑤ 必须变红（外部调用方会裸调）',
    file: DOC,
    anchor: /\*\*写路由\*\*（`WRITE_ROUTES`/g,
    count: 1,
    apply: (s) => s.replace(
      '**写路由**（`WRITE_ROUTES`',
      '**只读 POST**（`READ_ONLY_POST`',
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
];
