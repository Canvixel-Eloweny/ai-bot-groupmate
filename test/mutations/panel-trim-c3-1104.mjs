/**
 * 批 C3 上半（界面裁剪 · 内置组件可隐藏）定向变异（2026-11-04 · 维护者要求
 * "我们自己的组件用户也可以删除"）。
 *
 * 这一屏的形状是**六个地方都得对，任何一处偷懒都不报错**：
 *   `readCustom` 是白名单投影 ⇒ 漏列 `panelHidden` 就是"用户在面板上点掉一张卡，
 *   下一次保存又回来了"（holidays 那个坑的同族）；
 *   导航必须用 `hidden` **属性**而不是滤数组 ⇒ `data-g`/`data-s` 与 `S.gi`/`S.si`
 *   按下标记账，滤掉会让"点第三个"变成"选中第二个域"，而且静默；
 *   当前域/页被隐藏时必须退到第一个可见的 ⇒ 否则用户停在一屏空白上；
 *   恢复入口那张卡必须**豁免于**名单（`c.id === 'trim' ||`）—— 写成 `c.id !== 'trim'`
 *   是"这张卡永不渲染"，比自锁更快的自锁，**本批真的踩过**（真渲染当场只剩三张卡）；
 *   最后一个可见域不许隐藏 ⇒ 零入口的控制台用户自己回不来；
 *   `panel-dom` 必须继续遍历隐藏项 ⇒ 那是"只隐藏不删除"这条纪律的可执行形式。
 * 所以十条各打一枪，分别打红 §180 的 ①①②③④④④⑤⑤⑥。
 *
 * 跑法（串行；会改写真实工作树，失败后用 `--restore`）：
 *   NODE_OPTIONS= node scripts/mutate.mjs test/mutations/panel-trim-c3-1104.mjs
 */

const CC = 'src/custom-config.js';
const APP = 'panel/next/app.js';
const SCH = 'panel/next/schema.js';
const DOM = 'test/panel-dom.mjs';

export default [
  {
    id: 'P1',
    note: 'readCustom 的白名单投影丢掉 panelHidden —— §180① 必须变红（面板保存一次就把隐藏名单抹掉）',
    file: CC,
    anchor: /panelHidden: panelHiddenFields\(c\.panelHidden\),/g,
    count: 1,
    apply: (s) => s.replace('    panelHidden: panelHiddenFields(c.panelHidden),\n', ''),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'P2',
    note: 'panelHiddenFields 只回 domains（subs/cards 恒空）—— §180① 必须变红（"改了 A 丢了 B"）',
    file: CC,
    anchor: /domains: ids\('domains'\), subs: ids\('subs'\), cards: ids\('cards'\)/g,
    count: 1,
    apply: (s) => s.replace(
      "return { domains: ids('domains'), subs: ids('subs'), cards: ids('cards') };",
      "return { domains: ids('domains'), subs: [], cards: [] };",
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'P3',
    note: 'renderNav1 不再上 hidden 属性 —— §180② 必须变红（隐藏一级域失效，或被人改成滤数组）',
    file: APP,
    anchor: /hs\.domains\.has\(g\.id\) \? ' hidden' : ''/g,
    count: 1,
    apply: (s) => s.replace("${hs.domains.has(g.id) ? ' hidden' : ''}", "${''}"),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'P4',
    note: 'paintPage 不再调用 ensureVisibleSelection —— §180③ 必须变红（隐藏当前页会停在空白页）',
    file: APP,
    anchor: /^\s+ensureVisibleSelection\(\);$/gm,
    count: 1,
    apply: (s) => s.replace('  ensureVisibleSelection();\n', ''),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'P5',
    note: '自锁判据写成"永不渲染"（本批真实踩过的形状）—— §180④⑤ 必须变红（裁剪卡自己消失，恢复入口没了）',
    file: APP,
    anchor: /const list = cards\.filter\(\(c\) => \(c\.id === 'trim' \|\| !hs\.cards\.has\(c\.id\)\)/g,
    count: 1,
    apply: (s) => s.replace(
      "cards.filter((c) => (c.id === 'trim' || !hs.cards.has(c.id))",
      "cards.filter((c) => (c.id !== 'trim' && !hs.cards.has(c.id))",
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'P6',
    note: '显示侧不再护住最后一个可见域 —— §180④ 必须变红（最后一个域也能被点掉 = 零入口）',
    file: APP,
    anchor: /const lastOne = !gHidden && visibleDomains <= 1;/g,
    count: 1,
    apply: (s) => s.replace(
      'const lastOne = !gHidden && visibleDomains <= 1;',
      'const lastOne = false;',
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'P7',
    note: '写侧不再拒绝隐藏最后一个可见域 —— §180④ 必须变红（显示侧灰了也拦不住手改 config.json）',
    file: APP,
    anchor: /if \(key === 'domains' && GROUPS\.filter\(\(g\) => g\.id !== id\)\.every/g,
    count: 1,
    apply: (s) => s.replace(
      "      if (key === 'domains' && GROUPS.filter((g) => g.id !== id).every((g) => lists.domains.includes(g.id))) {\n        toast('至少要留一个能看见的一级域 —— 全部隐藏会让控制台没有入口，自己也回不来。', 'warn');\n        return;\n      }\n",
      '',
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'P8',
    note: 'cardsHtml 完全不看名单（名单存了没人读）—— §180⑤ 必须变红（"写了没人读"）',
    file: APP,
    anchor: /const list = cards\.filter\(\(c\) => \(c\.id === 'trim' \|\| !hs\.cards\.has\(c\.id\)\)\n\s+&& \(!c\.when \|\| c\.when\(S\.state \|\| DEMO\)\)\);/g,
    count: 1,
    apply: (s) => s.replace(
      "  const list = cards.filter((c) => (c.id === 'trim' || !hs.cards.has(c.id))\n    && (!c.when || c.when(S.state || DEMO)));",
      '  const list = cards.filter((c) => !c.when || c.when(S.state || DEMO));',
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'P9',
    note: '面板删掉「界面裁剪」控件 —— §180⑤ 必须变红（功能只能靠手改 config.json，面板覆盖不到）',
    file: SCH,
    anchor: /\{ t: 'panelTrim' \},/g,
    count: 1,
    apply: (s) => s.replace("              { t: 'panelTrim' },\n", ''),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'P10',
    note: 'panel-dom 删掉整段界面裁剪断言 —— §180⑥ 必须变红（"隐藏项仍参与逐页遍历"从此没人守）',
    file: DOM,
    anchor: /── 界面裁剪（隐藏不删除 · 隐藏项仍在 DOM）──/g,
    count: 1,
    apply: (s) => s.replace(
      /  \/\* ── 界面裁剪（2026-11-03 · §180）[\s\S]*?不需要再按保存条）'\);\n/,
      '',
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
];
