/**
 * B2 · 落盘与面板数据安全（§121 · 2026-10-21）的变异清单。
 * 每条只改一处、只打红 §121；跑法：
 *   NODE_OPTIONS= node scripts/mutate.mjs test/mutations/datasafe-1021.mjs
 */

const MEM = 'src/memory.js';
const SRV = 'panel/server.js';
const AW = 'src/atomic-write.js';
const CB = 'src/custom-brain.js';
const ZIP = 'panel/lib/zip.js';
const IO = 'panel/lib/http-io.js';
const EX = 'panel/lib/export-bundle.js';

export default [
  {
    id: 'D1',
    note: '自动记忆整份写不再 reverse —— §121① 必须变红（删一条就把磁盘顺序永久反转）',
    file: MEM,
    anchor: /\[\.\.\.list\]\.reverse\(\)/,
    count: 1,
    apply: (s) => s.replace('[...list].reverse()', '[...list]'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'D2',
    note: '清空自动记忆退回非原子写 —— §121② 必须变红',
    file: MEM,
    anchor: /writeTextAtomic\(AUTO_MEMORY_FILE, ''\);/,
    count: 1,
    apply: (s) => s.replace("writeTextAtomic(AUTO_MEMORY_FILE, '');", "fs.writeFileSync(AUTO_MEMORY_FILE, '');"),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'D3',
    note: '面板删除记忆绕开唯一写口直接写盘 —— §121③ 必须变红',
    file: SRV,
    anchor: /    writeAutoMemory\(rows\);/,
    count: 1,
    apply: (s) => s.replace(
      '    writeAutoMemory(rows);',
      "    fs.writeFileSync(AUTO_MEMORY_PATH, rows.map((m) => JSON.stringify(m)).join('\\n') + (rows.length ? '\\n' : ''));"
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'D4',
    note: '原子写不再重试 EBUSY（Windows 瞬时占用直接丢写）—— §121④ 必须变红',
    file: AW,
    anchor: / && e\.code !== 'EBUSY'\)/,
    count: 1,
    apply: (s) => s.replace(" && e.code !== 'EBUSY'", ''),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'D5',
    note: '自定义大脑容器退回普通对象 —— §121⑤ 必须变红',
    file: CB,
    anchor: /const brains = Object\.create\(null\);/,
    count: 1,
    apply: (s) => s.replace('const brains = Object.create(null);', 'const brains = {};'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'D6',
    note: '面板自定义大脑退回原型属性判存在 —— §121⑥ 必须变红',
    file: SRV,
    anchor: /Object\.hasOwn\(allBrains, id\) \? allBrains\[id\] : null/,
    count: 1,
    apply: (s) => s.replace('Object.hasOwn(allBrains, id) ? allBrains[id] : null', 'allBrains[id] || null'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'D7',
    note: 'ZIP 解压不再传 maxOutputLength —— §121⑦ 必须变红',
    file: ZIP,
    anchor: /inflateRawSync\(raw, \{ maxOutputLength: Math\.max\(1, Math\.min\(fileMax, usize\)\) \+ 1 \}\)/,
    count: 1,
    apply: (s) => s.replace(
      'inflateRawSync(raw, { maxOutputLength: Math.max(1, Math.min(fileMax, usize)) + 1 })',
      'inflateRawSync(raw)'
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'D8',
    note: 'readBody 不再监听 close（超限 Promise 永不返回）—— §121⑧ 必须变红',
    file: IO,
    anchor: /    req\.on\('close', \(\) => finish\(\{\}\)\);\n/,
    count: 1,
    apply: (s) => s.replace("    req.on('close', () => finish({}));\n", ''),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'D9',
    note: '导出脱敏退回宽泛键名匹配 —— §121⑨ 必须变红（maxTokens 被清空）',
    file: EX,
    anchor: /const SECRET_KEYS = new Set\(\[/,
    count: 1,
    apply: (s) => s.replace('const SECRET_KEYS = new Set([', 'const SECRET_KEYS_OLD = new Set(['),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'D10',
    note: '记忆导出不再掩码 chatKey —— §121⑩ 必须变红',
    file: EX,
    anchor: /mask \? maskChatKey\(scopeRaw\) : scopeRaw/,
    count: 1,
    apply: (s) => s.replace('mask ? maskChatKey(scopeRaw) : scopeRaw', 'scopeRaw'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
];
