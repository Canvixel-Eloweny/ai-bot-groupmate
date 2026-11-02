/**
 * 插件创建提示词与 tags 的定向变异（2026-11-01）。
 *
 * 每条都打在 §177 上：变异后 `check-wb` 必须 BLOCKED。
 * 跑法：
 *   NODE_OPTIONS= node scripts/mutate.mjs test/mutations/ext-create-prompt-1101.mjs
 * ⚠️ 串行；会改写真实工作树，失败后用 `--restore`。
 */

const PROMPT = 'src/extension-create-prompt.js';
const MANIFEST = 'src/plugin-manifest.js';
const EXTENSIONS = 'panel/lib/extensions.js';
const FACTORY = 'panel/next/plugin-factory.html';
const SERVER = 'panel/server.js';
const API_DOC = 'docs/API_CONTRACT.md';

export default [
  {
    id: 'BP1',
    note: 'manifest 不再归一化 tags —— §177② 必须变红（列表标签会绕过 8×20 限制）',
    file: MANIFEST,
    anchor: /normalizeTagList\(raw\.tags\)/g,
    count: 1,
    apply: (s) => s.replace('normalizeTagList(raw.tags)', '[]'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'BP2',
    note: 'extensions.js 不再把 tags 投影给页面 —— §177② 必须变红（标签显示不出来）',
    file: EXTENSIONS,
    anchor: /    tags: normalizeTagList\(p\.manifest\?\.tags\),\n/g,
    count: 1,
    apply: (s) => s.replace('    tags: normalizeTagList(p.manifest?.tags),\n', ''),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'BP3',
    note: '提示词模板删掉 execute(ctx, args) —— §177① 必须变红（外部 AI 会写错工具签名）',
    file: PROMPT,
    anchor: /execute\(ctx, args\)/g,
    count: 1,
    apply: (s) => s.replace('execute(ctx, args)', 'execute()'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'BP4',
    note: 'prompt 路由漏 READ_ONLY_POST —— §177④ 必须变红（只读 POST 被当成写路由/或未分类）',
    file: SERVER,
    anchor: /  '\/api\/extensions\/prompt',\n/g,
    count: 1,
    apply: (s) => s.replace("  '/api/extensions/prompt',\n", ''),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'BP5',
    note: '复制按钮被改回安装 —— §177③ 必须变红（用户点安装没有任何外部 AI 步骤）',
    file: FACTORY,
    anchor: /data-create="copy"/g,
    count: 1,
    apply: (s) => s.replace('data-create="copy"', 'data-create="install"'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'BP6',
    note: '剪贴板兜底被删 —— §177③ 必须变红（安全上下文不可用时无法复制）',
    file: FACTORY,
    anchor: /document\.execCommand\('copy'\)/g,
    count: 1,
    apply: (s) => s.replace("document.execCommand('copy')", 'false'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'BP7',
    note: '列表不再显示清单 tags —— §177③ 必须变红（创造时写的标签没人看）',
    file: FACTORY,
    anchor: /it\.tags/g,
    count: 2,
    apply: (s) => s.replaceAll('it.tags', 'it.labels'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'BP8',
    note: 'API 契约总表删掉 prompt 路由 —— §135/§177⑤ 必须变红（文档与实现分家）',
    file: API_DOC,
    anchor: /\| POST \| `\/api\/extensions\/prompt` \|\n/g,
    count: 1,
    apply: (s) => s.replace('| POST | `/api/extensions/prompt` |\n', ''),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
];
