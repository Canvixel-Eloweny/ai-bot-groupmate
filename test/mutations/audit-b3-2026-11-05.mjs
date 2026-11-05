/**
 * B3 回合管线定向变异（2026-11-05 · §185）。
 *
 * 两条都是"看起来还在跑、结果已经错了"：
 *   · 合并缓存只留文字 → 先图后文时模型只看到 `[图片]`；
 *   · 用量写回共享 `llm.lastUsage` → 并发两轮互相覆盖账本。
 *
 * 跑法（串行；会改写真实工作树，失败后用 `--restore`）：
 *   NODE_OPTIONS= node scripts/mutate.mjs test/mutations/audit-b3-2026-11-05.mjs
 */

const WAIT = 'src/waiting.js';
const IDX = 'src/index.js';
const PKG = 'package.json';
const WAIT_TEST = 'test/check-wait-images.mjs';

export default [
  {
    id: 'M1',
    note: 'mergeImageLists 被改名 —— §185① 必须变红（合并图片只剩整包去猜）',
    file: WAIT,
    anchor: /export function mergeImageLists\(/g,
    count: 1,
    apply: (s) => s.replace('export function mergeImageLists(', 'export function mergeImageListsX('),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M2',
    note: '合并缓存不再保留前序事件 —— §185② 必须变红（先图后文丢图的原缺陷复活）',
    file: IDX,
    anchor: /const events = prev \? \[\.\.\.\(prev\.events \|\| \[\]\), prev\.evt\] : \[\];/g,
    count: 1,
    apply: (s) => s.replace(
      'const events = prev ? [...(prev.events || []), prev.evt] : [];',
      'const events = [];',
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M3',
    note: '前序图片不再并入当前轮 —— §185② 必须变红（缓存留了事件但没人读）',
    file: IDX,
    anchor: /parsed\.images = mergeImageLists\(\[priorImages, parsed\.images\], 3\);/g,
    count: 1,
    apply: (s) => s.replace(
      'parsed.images = mergeImageLists([priorImages, parsed.images], 3);',
      'parsed.images = parsed.images || [];',
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M4',
    note: '用量写回共享 llm.lastUsage —— §185③ 必须变红（并发串账复活）',
    file: IDX,
    anchor: /turnUsage = run\.usage;/g,
    count: 1,
    apply: (s) => s.replace('turnUsage = run.usage;', 'llm.lastUsage = run.usage;'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M5',
    note: '账本改回读共享字段 —— §185③ 必须变红',
    file: IDX,
    anchor: /if \(turnUsage\) recordUsage\(\{ \.\.\.turnUsage,/g,
    count: 1,
    apply: (s) => s.replace(
      'if (turnUsage) recordUsage({ ...turnUsage,',
      'if (llm.lastUsage) recordUsage({ ...llm.lastUsage,',
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M6',
    note: '用量归属回归从 check:features 摘掉 —— §185④ 必须变红',
    file: PKG,
    anchor: /node test\/check-usage-attribution\.mjs && /g,
    count: 1,
    apply: (s) => s.replace('node test/check-usage-attribution.mjs && ', ''),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M7',
    note: '合并纯函数回归被摘掉 —— §185④ 必须变红',
    file: WAIT_TEST,
    anchor: /mergeImageLists/g,
    count: 5,
    apply: (s) => s.replaceAll('mergeImageLists', 'mergeImageListsX'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
];
