/**
 * Win-v0.1.2 移植 · §126「人格按群 + 记忆按卡 + 十维分级」的定向变异（2026-10-21）。
 */
export default [
  {
    id: 'P1',
    note: '把「按人」的优先级降到全局之后 —— §126 的选卡优先级判据应红',
    file: 'src/skills.js',
    anchor: /const rank = \(s\) => \(s\.scope\?\.type === 'user' \? 0 : s\.scope\?\.type === 'group' \? 1 : 2\);/g,
    count: 1,
    apply: (s) => s.replace(
      /const rank = \(s\) => \(s\.scope\?\.type === 'user' \? 0 : s\.scope\?\.type === 'group' \? 1 : 2\);/,
      "const rank = (s) => (s.scope?.type === 'group' ? 0 : s.scope?.type === 'user' ? 1 : 2);"
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'P2',
    note: '把角色卡重新塞回技能段 —— §126 的「卡不进技能段」判据应红',
    file: 'src/skills.js',
    anchor: /const picked = live\.filter\(\(s\) => s\.kind === 'pack' && packHit\(s, text\)\);/g,
    count: 1,
    apply: (s) => s.replace(
      "const picked = live.filter((s) => s.kind === 'pack' && packHit(s, text));",
      "const picked = live.filter((s) => (s.kind === 'pack' && packHit(s, text)) || s.kind === 'persona');"
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'P3',
    note: '把相关度排序关掉 —— §126 的「给了 hint 相关记忆排前面」判据应红',
    file: 'src/memory-record.js',
    anchor: /const hTerms = termsOf\(opts\.hint\);/g,
    count: 1,
    apply: (s) => s.replace('const hTerms = termsOf(opts.hint);', 'const hTerms = new Set();'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'P4',
    note: '把面板的 personaCards 置空 —— §126 的分级状态下发判据应红',
    file: 'panel/lib/state-collector.js',
    anchor: /personaCards: \(custom\.skills \|\| \[\]\)/g,
    count: 1,
    apply: (s) => s.replace('personaCards: (custom.skills || [])', 'personaCards: []'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
];
