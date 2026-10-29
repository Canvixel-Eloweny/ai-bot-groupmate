/**
 * 0.1.5 接口收尾（§169 · 2026-10-28）的变异清单 —— 纯数据。
 * 跑法：
 *   NODE_OPTIONS= node scripts/mutate-lint.mjs
 *   NODE_OPTIONS= node scripts/mutate.mjs test/mutations/interfaces-2026-10-28.mjs --layer check-wb
 * 纪律：anchor 必须在 pristine 文件里恰好命中 count 次；apply 必须返回不同且语法合法的内容。
 */
const SRV = 'panel/server.js';
const BG = 'panel/lib/backgrounds.js';
const STAR = 'panel/lib/github-star.js';
const EXT = 'panel/lib/extensions.js';
const PS = 'src/plugin-settings.js';
const ZIP = 'panel/lib/zip.js';
const APP = 'panel/next/app.js';
const PF = 'panel/next/plugin-factory.html';

export default [
  {
    id: 'M1',
    note: '删掉星标路由表项（前端仍调 /api/github/star）—— §169 必须变红。预期 BLOCKED',
    file: SRV,
    anchor: /  \{ path: '\/api\/github\/star', handler: apiGithubStar \},\n/,
    count: 1,
    apply: (s) => s.replace(/  \{ path: '\/api\/github\/star', handler: apiGithubStar \},\n/, ''),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M2',
    note: '背景上传不再嗅探魔数（SVG/伪造类型可进）—— §169 必须变红。预期 BLOCKED',
    file: SRV,
    anchor: /sniffBackground\(readFileHead\(tmp\)\)/g,
    count: 2,
    apply: (s) => s.replace(/sniffBackground\(readFileHead\(tmp\)\)/g, 'null'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M3',
    note: '背景媒体不解析 Range（视频循环反复整段下载）—— §169 必须变红。预期 BLOCKED',
    file: SRV,
    anchor: /const range = parseByteRange\(req\.headers\.range, stat\.size\);\n  const headers = \{\n    'Content-Type': media\.type,/,
    count: 1,
    apply: (s) => s.replace(
      /const range = parseByteRange\(req\.headers\.range, stat\.size\);\n  const headers = \{\n    'Content-Type': media\.type,/,
      "const range = null;\n  const headers = {\n    'Content-Type': media.type,",
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M4',
    note: '背景索引改回非原子写（读到半份 JSON）—— §169 必须变红。预期 BLOCKED',
    file: BG,
    anchor: /writeJsonAtomic\(indexFile, next\);/,
    count: 1,
    apply: (s) => s.replace(/writeJsonAtomic\(indexFile, next\);/, 'fs.writeFileSync(indexFile, JSON.stringify(next));'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M5',
    note: '星标缓存 TTL 改成 30 秒（打爆未认证额度）—— §169 必须变红。预期 BLOCKED',
    file: STAR,
    anchor: /export const STAR_TTL_MS = 5 \* 60 \* 1000;/,
    count: 1,
    apply: (s) => s.replace(/export const STAR_TTL_MS = 5 \* 60 \* 1000;/, 'export const STAR_TTL_MS = 30 * 1000;'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M6',
    note: '扩展投影删掉 category（分类树全归 other）—— §169 必须变红。预期 BLOCKED',
    file: EXT,
    anchor: /category: String\(p\.manifest\?\.category \|\| ''\)\.slice\(0, 40\),/,
    count: 1,
    apply: (s) => s.replace(/category: String\(p\.manifest\?\.category \|\| ''\)\.slice\(0, 40\),/, "category: '',"),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M7',
    note: 'settingsSpec 删掉 label（重新显示原始键名）—— §169 必须变红。预期 BLOCKED',
    file: PS,
    anchor: /label: typeof meta\[key\]\?\.label === 'string' \? meta\[key\]\.label : '',/,
    count: 1,
    apply: (s) => s.replace(/label: typeof meta\[key\]\?\.label === 'string' \? meta\[key\]\.label : '',/, "label: '',"),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M8',
    note: 'makeZip 只认文本（文件夹里的图片被写成空文件）—— §169 必须变红。预期 BLOCKED',
    file: ZIP,
    anchor: /Buffer\.isBuffer\(e\.data\)/,
    count: 1,
    apply: (s) => s.replace(/Buffer\.isBuffer\(e\.data\)/, 'false'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M9',
    note: '覆盖安装重试被删（撞名永远装不上）—— §169 必须变红。预期 BLOCKED',
    file: APP,
    anchor: /installZip\(file, kind, \{ overwrite: true \}\)/,
    count: 1,
    apply: (s) => s.replace(/installZip\(file, kind, \{ overwrite: true \}\)/, 'installZip(file, kind)'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M10',
    note: '文件夹导入误走 create 模式（选了文件夹却生成空模板）—— §169 必须变红。预期 BLOCKED',
    file: PF,
    anchor: /mode: 'folder', kind: 'plugin', root, files: entries,/,
    count: 1,
    apply: (s) => s.replace(/mode: 'folder', kind: 'plugin', root, files: entries,/, "mode: 'create', kind: 'plugin', root, files: entries,"),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
];
