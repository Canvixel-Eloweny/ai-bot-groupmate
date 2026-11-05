/**
 * P1 封堵定向变异（2026-11-05 · §183）。
 *
 * 两项 P1 的共同形状是「**门看起来还在，实际保护已经被换掉**」：
 *   · ZIP 侧 —— 顶层 `.` 变成扩展根、别名条目让预检与落盘不一致、覆盖确认丢绑定；
 *   · PEM 侧 —— 只遮标头、分段后才扫、trace/dryrun 原样落原文。
 * 每条变异都只改一处，跑 `check-wb` 必须变红；否则 §183 就只是装饰。
 *
 * 跑法（串行；会改写真实工作树，失败后用 `--restore`）：
 *   NODE_OPTIONS= node scripts/mutate.mjs test/mutations/audit-p1-2026-11-05.mjs
 */

const MANIFEST = 'src/plugin-manifest.js';
const EXT = 'panel/lib/ext-install.js';
const APP = 'panel/next/app.js';
const EG = 'src/egress.js';
const BRAIN = 'src/brain.js';
const PRO = 'src/proactive.js';
const BRIDGE = 'src/bridge-io.js';
const PKG = 'package.json';

export default [
  {
    id: 'M1',
    note: 'canonicalZipPath 被改名/删除 —— §183① 必须变红（ZIP 专用规范化消失）',
    file: MANIFEST,
    anchor: /export function canonicalZipPath\(/g,
    count: 1,
    apply: (s) => s.replace('export function canonicalZipPath(', 'export function canonicalZipPathX('),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M2',
    note: '安装口不再调用 canonicalZipPath —— §183② 必须变红（回到按原始条目算顶层）',
    file: EXT,
    anchor: /const canon = canonicalZipPath\(e\.name\);/g,
    count: 1,
    apply: (s) => s.replace(
      'const canon = canonicalZipPath(e.name);',
      'const canon = { ok: true, segments: e.name.split(/[\\\\/]/) };',
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M3',
    note: '顶层 . 的拒绝被摘掉 —— §183② 必须变红（原始 P1 复活）',
    file: EXT,
    anchor: /pkgDir === '\.' \|\| /g,
    // 两处：planInstall 的顶层判定 + safeInstallTarget 的纵深防御。两处都摘掉才算复活 P1。
    count: 2,
    apply: (s) => s.replaceAll("pkgDir === '.' || ", "'' || "),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M4',
    note: '目标严格子目录检查被摘掉 —— §183② 必须变红',
    file: EXT,
    anchor: /if \(path\.dirname\(target\) !== rootDir\) return \{ ok: false, error: '目标不在扩展根下，拒绝安装' \};/g,
    count: 1,
    apply: (s) => s.replace(
      "if (path.dirname(target) !== rootDir) return { ok: false, error: '目标不在扩展根下，拒绝安装' };",
      "// 变异：目标不在扩展根下，拒绝安装",
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M5',
    note: '规范化重名判据被摘掉 —— §183② 必须变红（别名包让预检与落盘不一致）',
    file: EXT,
    anchor: /if \(prev\) \{/g,
    count: 1,
    apply: (s) => s.replace('if (prev) {', 'if (false && prev) {'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M6',
    note: '目标符号链接检查被摘掉 —— §183② 必须变红',
    file: EXT,
    anchor: /if \(st\?\.isSymbolicLink\?\.\(\)\) return \{ ok: false, error: '目标目录是符号链接，拒绝覆盖' \};/g,
    count: 1,
    apply: (s) => s.replace(
      "if (st?.isSymbolicLink?.()) return { ok: false, error: '目标目录是符号链接，拒绝覆盖' };",
      "// 变异：目标目录是符号链接，拒绝覆盖",
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M7',
    note: '覆盖重试不再带服务端摘要 —— §183③ 必须变红（确认与实际覆盖目标解绑）',
    file: APP,
    anchor: /const bindDigest = .*b\.digest.*;/g,
    count: 1,
    apply: (s) => s.replace(/const bindDigest = .*b\.digest.*;/, "const bindDigest = '';"),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M8',
    note: 'PEM 擦除入口被改名 —— §183④ 必须变红（回复/主动/trace 失去同一份判据）',
    file: EG,
    anchor: /export function redactCredentialsBeforeShape\(/g,
    count: 1,
    apply: (s) => s.replace(
      'export function redactCredentialsBeforeShape(',
      'export function redactCredentialsBeforeShapeX(',
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M9',
    note: 'brain 退回分段后才扫 —— §183⑤ 必须变红（长 Key 被 hardWrap 切开）',
    file: BRAIN,
    anchor: /const pre = redactCredentialsBeforeShape\(String\(raw \?\? ''\)\);/g,
    count: 1,
    apply: (s) => s.replace(
      "const pre = redactCredentialsBeforeShape(String(raw ?? ''));",
      "const pre = { text: String(raw ?? ''), rules: [] };",
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M10',
    note: '主动链退回分句后才扫 —— §183⑥ 必须变红（与主链路口径分叉）',
    file: PRO,
    anchor: /const pre = redactCredentialsBeforeShape\(String\(text\)\);/g,
    count: 1,
    apply: (s) => s.replace(
      'const pre = redactCredentialsBeforeShape(String(text));',
      'const pre = { text: String(text), rules: [] };',
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M11',
    note: 'trace 原样落盘 —— §183⑦ 必须变红（PEM 正文进 local-trace.jsonl）',
    file: BRIDGE,
    anchor: /const safe = maskSecretsDeep\(rec\);/g,
    count: 1,
    apply: (s) => s.replace('const safe = maskSecretsDeep(rec);', 'const safe = rec;'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M12',
    note: 'P1 回归从 check:features 摘掉 —— §183⑧ 必须变红',
    file: PKG,
    anchor: /node test\/check-ext-archive\.mjs && node test\/check-pem-mask\.mjs && /g,
    count: 1,
    apply: (s) => s.replace(
      'node test/check-ext-archive.mjs && node test/check-pem-mask.mjs && ',
      'node test/check-pem-mask.mjs && ',
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
];
