/**
 * Win-v0.1.2 移植 · §125「判据叶子与配置地基」的定向变异（2026-10-21）。
 * 这组证明新加的叶子零依赖、配置默认值/往返、patrol/nightly 登记这几条真的会红。
 */
export default [
  {
    id: 'L1',
    note: '把 readCustom 的峰谷默认改成关 —— §125 的「默认开」判据应红',
    file: 'src/custom-config.js',
    anchor: /peak: readPeak\(c\.peak\),/g,
    count: 1,
    apply: (s) => s.replace('peak: readPeak(c.peak),', 'peak: { enabled: false, muteUnmentioned: true },'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'L2',
    note: '把 patrol 从决策种类里删掉 —— §125 的 tier 登记判据应红',
    file: 'src/tier.js',
    anchor: /export const DECISION_KINDS = \['private', 'named', 'keyword', 'interject', 'patrol'\];/g,
    count: 1,
    apply: (s) => s.replace("export const DECISION_KINDS = ['private', 'named', 'keyword', 'interject', 'patrol'];", "export const DECISION_KINDS = ['private', 'named', 'keyword', 'interject'];"),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'L3',
    note: '把 nightly 从用量来源里删掉 —— §125 的账务来源判据应红',
    file: 'src/usage.js',
    anchor: /  nightly: 'nightly',/g,
    count: 1,
    apply: (s) => s.replace("  nightly: 'nightly',", ''),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'C1',
    note: '对照组：只给 peak.js 加一行注释，不应被拦截',
    file: 'src/peak.js',
    anchor: /export const PEAK_WINDOWS/g,
    count: 1,
    apply: (s) => s.replace('export const PEAK_WINDOWS', '// p125 control\nexport const PEAK_WINDOWS'),
    layer: 'check-wb',
    expect: 'NOT-BLOCKED',
  },
];
