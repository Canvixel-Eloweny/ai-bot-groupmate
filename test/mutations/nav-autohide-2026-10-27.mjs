/**
 * 工厂域导航自动上收（§166 · 2026-10-27）的变异清单 —— 纯数据。
 * 供 `NODE_OPTIONS= node scripts/mutate.mjs test/mutations/nav-autohide-2026-10-27.mjs --layer check-wb` 复跑。
 *
 * 背景：工厂页的导航在过场后自动上收，顶部热区呼出，离开导航 2.5s 再收。
 * 下面五条分别破坏计时、页面守卫、命中测试交接、tab 序与热区，必须全部 BLOCKED。
 *
 * 写法约定：anchor 必须在 pristine 文件里**恰好命中 count 次**；命中数不对时
 * `mutate-lint` 判 INVALID。⚠️ 跑之前先本地提交（干净树），且串行。
 */
const APP = 'panel/next/app.js';
const CSS = 'panel/next/style.css';

export default [
  {
    id: 'M1',
    note: '把 2.5s 自动收回改成 0 —— §166④ 必须变红（离开导航立刻上收）。预期 BLOCKED',
    anchor: /const NAV_HIDE_DELAY = 2500;/,
    count: 1,
    file: APP,
    apply: (s) => s.replace(/const NAV_HIDE_DELAY = 2500;/, 'const NAV_HIDE_DELAY = 0;'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M2',
    note: '去掉 paintPage 的工厂域守卫 —— §166④ 必须变红（自动上收会错误地作用于其它域）。预期 BLOCKED',
    anchor: /syncNavAuto\(!!frameSrc && S\.gi === FACTORY_GI\);/,
    count: 1,
    file: APP,
    apply: (s) => s.replace(/syncNavAuto\(!!frameSrc && S\.gi === FACTORY_GI\);/, 'syncNavAuto(false);'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M3',
    note: '隐藏态的 dock 仍可点 —— §166③ 必须变红（上收后的导航会挡住工厂且能被误点）。预期 BLOCKED',
    anchor: /body\.is-frame-page\.nav-auto-hidden \.nav-dock-wrap \{ pointer-events: none; \}/,
    count: 1,
    file: CSS,
    apply: (s) => s.replace(
      /body\.is-frame-page\.nav-auto-hidden \.nav-dock-wrap \{ pointer-events: none; \}/,
      'body.is-frame-page.nav-auto-hidden .nav-dock-wrap { pointer-events: auto; }'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M4',
    note: '隐藏后不把 nav 移出 tab 序 —— §166⑤ 必须变红（键盘会聚焦到看不见的导航）。预期 BLOCKED',
    anchor: /row\.inert = true;/,
    count: 1,
    file: APP,
    apply: (s) => s.replace(/row\.inert = true;/, 'row.inert = false;'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M5',
    note: '隐藏后热区不收 pointer —— §166③ 必须变红（鼠标放到红框区域呼不出导航）。预期 BLOCKED',
    anchor: /body\.is-frame-page\.nav-auto-hidden \.nav-hotzone \{\s*pointer-events: auto;/,
    count: 1,
    file: CSS,
    apply: (s) => s.replace(
      /body\.is-frame-page\.nav-auto-hidden \.nav-hotzone \{\s*pointer-events: auto;/,
      'body.is-frame-page.nav-auto-hidden .nav-hotzone { pointer-events: none;'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
];
