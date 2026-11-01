/**
 * 常规页安全内缩（§175 · 2026-11-01）的变异清单 —— 纯数据。
 * 跑法：
 *   NODE_OPTIONS= node scripts/mutate-lint.mjs
 *   NODE_OPTIONS= node scripts/mutate.mjs test/mutations/page-safe-inset-1101.mjs --layer check-wb
 * 纪律：anchor 必须在 pristine 文件里**恰好命中 count 次**；apply 必须返回不同且语法合法的内容。
 * ⚠️ 跑之前先本地提交（干净树），且串行；跑时不许编辑被测文件。
 *
 * 这一族盯的是"安全带被悄悄拆掉"的三种形状 —— 它们都**不会报错、不会白屏**，
 * 只会让用户在窄窗口里重新看到"齿轮压在卡片信息上"（用户截图的图 2）：
 *   M1 安全值改回 24（等于没有安全带）
 *   M2 页面/页脚不再消费安全值（只有变量还活着）
 *   M3 ≤900 分组把左右内边距写回 16（变量活着但被覆盖 —— 最常见的一类回归）
 */
const CSS = 'panel/next/style.css';

export default [
  {
    id: 'M1',
    note: '基础安全内缩 136 → 24（齿轮右缘与内容左缘几乎贴死）—— §175② 必须变红。预期 BLOCKED',
    file: CSS,
    anchor: /--page-safe-inline: 136px;/,
    count: 1,
    apply: (s) => s.replace('--page-safe-inline: 136px;', '--page-safe-inline: 24px;'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M2',
    note: '.page 与 .foot 不再消费 --page-pad-inline（变量还在、没人用）—— §175④⑤ 必须变红。预期 BLOCKED',
    file: CSS,
    anchor: /padding-inline: var\(--page-pad-inline\);/g,
    count: 2,
    apply: (s) => s.replaceAll('padding-inline: var(--page-pad-inline);', 'padding-inline: var(--s5);'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M3',
    note: '≤900 分组重新把 .page/.foot 的左右内边距写回 var(--s4)（覆盖安全带）—— §175⑥ 必须变红。预期 BLOCKED',
    file: CSS,
    anchor: /\.page \{ gap: var\(--s3\); padding-top: var\(--s4\); \}/,
    count: 1,
    apply: (s) => s.replace(
      '.page { gap: var(--s3); padding-top: var(--s4); }',
      '.page, .banners:not(:empty), .foot { padding-left: var(--s4); padding-right: var(--s4); }\n'
      + '  .page { gap: var(--s3); padding-top: var(--s4); }',
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
];
