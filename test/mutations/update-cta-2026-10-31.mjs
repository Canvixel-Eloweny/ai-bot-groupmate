/**
 * 设置层「更新」入口与齿轮蓝点（§154④ · 2026-10-31）的变异清单 —— 纯数据。
 * 跑法：
 *   NODE_OPTIONS= node scripts/mutate-lint.mjs
 *   NODE_OPTIONS= node scripts/mutate.mjs test/mutations/update-cta-2026-10-31.mjs --layer check-wb
 * 纪律：anchor 必须在 pristine 文件里**恰好命中 count 次**；apply 必须返回不同且语法合法的内容。
 */
const JS = 'panel/next/settings.js';
const HTML = 'panel/next/index.html';
const APP = 'panel/next/app.js';

export default [
  {
    id: 'M1',
    note: 'phase 集合改成 up_to_date（有新版时不出现）—— §154④ 必须变红。预期 BLOCKED',
    file: JS,
    anchor: /const UPDATE_CTA_PHASES = new Set\(\['available', 'downloading', 'ready'\]\);/,
    count: 1,
    apply: (s) => s.replace(
      /const UPDATE_CTA_PHASES = new Set\(\['available', 'downloading', 'ready'\]\);/,
      "const UPDATE_CTA_PHASES = new Set(['up_to_date']);",
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M2',
    note: 'show 判据恒真（按钮与蓝点常亮）—— §154④ 必须变红。预期 BLOCKED',
    file: JS,
    anchor: /const show = u\.enabled === true && UPDATE_CTA_PHASES\.has\(String\(u\.phase \|\| ''\)\);/,
    count: 1,
    apply: (s) => s.replace(
      /const show = u\.enabled === true && UPDATE_CTA_PHASES\.has\(String\(u\.phase \|\| ''\)\);/,
      'const show = true;',
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M3',
    note: '蓝点 hidden 恒假（按钮隐了蓝点还亮）—— §154④ 必须变红。预期 BLOCKED',
    file: JS,
    anchor: /const dot = \$\('setGearDot'\);\n    if \(dot\) dot\.hidden = !show;/,
    count: 1,
    apply: (s) => s.replace(
      /const dot = \$\('setGearDot'\);\n    if \(dot\) dot\.hidden = !show;/,
      "const dot = $('setGearDot');\n    if (dot) dot.hidden = false;",
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M4',
    note: '蓝点默认不隐藏（首帧就亮）—— §154④ 必须变红。预期 BLOCKED',
    file: HTML,
    anchor: /id="setGearDot" aria-hidden="true" hidden/,
    count: 1,
    apply: (s) => s.replace(
      /id="setGearDot" aria-hidden="true" hidden/,
      'id="setGearDot" aria-hidden="true"',
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M5',
    note: '横幅不再看 updDismissed（删了通知还会弹）—— §154④ 必须变红。预期 BLOCKED',
    file: APP,
    anchor: /&& !updDismissed/,
    count: 1,
    apply: (s) => s.replace(/&& !updDismissed/, ''),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M6',
    note: '关闭按钮不再走 update.dismiss（点了变成查看更新）—— §154④ 必须变红。预期 BLOCKED',
    file: APP,
    anchor: /data-a="update\.dismiss"/,
    count: 1,
    apply: (s) => s.replace(/data-a="update\.dismiss"/, 'data-a="update.goto"'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
];
