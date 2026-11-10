/**
 * 导航上移/小屏缩放 + 加载动画深色常驻（§193 · 2026-11-08）的变异清单 —— 纯数据。
 * 跑法：
 *   NODE_OPTIONS= node scripts/mutate-lint.mjs
 *   NODE_OPTIONS= node scripts/mutate.mjs test/mutations/nav-gap-busy-dark-2026-11-08.mjs --layer check-wb
 * 纪律：anchor 必须在 pristine 文件里**恰好命中 count 次**；apply 必须返回不同且语法合法的内容。
 */
const CSS = 'panel/next/style.css';
const DOM = 'test/panel-dom.mjs';

export default [
  {
    id: 'M1',
    note: '跑道改回 36px（导航又沉下去）—— §193① 必须变红。预期 BLOCKED',
    file: CSS,
    anchor: /--nav-top-gap: 16px;/,
    count: 1,
    apply: (s) => s.replace(/--nav-top-gap: 16px;/, '--nav-top-gap: 36px;'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M2',
    note: '三球回弹行程改回 26px（顶进顶栏玻璃）—— §193① 必须变红。预期 BLOCKED',
    file: CSS,
    anchor: /calc\(-50% - 12px\)/,
    count: 1,
    apply: (s) => s.replace(/calc\(-50% - 12px\)/, 'calc(-50% - 26px)'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M3',
    note: '加载动画墨字改回浅色板（白纱上压蓝字的旧形态）—— §193③ 必须变红。预期 BLOCKED',
    file: CSS,
    anchor: /--ld-ink: #f2f7ff;/,
    count: 1,
    apply: (s) => s.replace(/--ld-ink: #f2f7ff;/, '--ld-ink: #31446c;'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M4',
    note: '≤900 缩放档令牌改回大尺寸（小屏依旧显大）—— §193② 必须变红。预期 BLOCKED',
    file: CSS,
    anchor: /--h-nav1: 42px; --h-nav-item: 33px;/,
    count: 1,
    apply: (s) => s.replace(/--h-nav1: 42px; --h-nav-item: 33px;/, '--h-nav1: 48px; --h-nav-item: 38px;'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M5',
    note: 'panel-dom 的跑道真渲染断言被摘 —— §193④ 必须变红。预期 BLOCKED',
    file: DOM,
    anchor: /导航跑道上移 16px/,
    count: 1,
    apply: (s) => s.replace(/导航跑道上移 16px/, '导航跑道位置检查'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M6',
    note: '暗纱幕改回主题软纱（浅色主题下白字 invisible）—— §193③ 必须变红。预期 BLOCKED',
    file: CSS,
    anchor: /background: rgba\(8, 12, 26, \.55\); backdrop-filter: blur\(3px\);/,
    count: 1,
    apply: (s) => s.replace(/background: rgba\(8, 12, 26, \.55\); backdrop-filter: blur\(3px\);/, 'background: var(--c-scrim-soft); backdrop-filter: blur(3px);'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
];