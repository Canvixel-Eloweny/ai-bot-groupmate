/**
 * 开屏透出阶段背景预加载（§172 · 2026-10-30）的变异清单 —— 纯数据。
 * 跑法：
 *   NODE_OPTIONS= node scripts/mutate-lint.mjs
 *   NODE_OPTIONS= node scripts/mutate.mjs test/mutations/splash-preload-2026-10-30.mjs --layer check-wb
 * 纪律：anchor 必须在 pristine 文件里恰好命中 count 次；apply 必须返回不同且语法合法的内容。
 */
const SPLASH = 'panel/next/splash.js';
const BOOT = 'panel/next/boot-splash.js';
const CONTOUR = 'panel/next/contour-bg.js';

export default [
  {
    id: 'M1',
    note: 'finish() 不再补 reveal（点跳过/提前收尾时预加载整段丢失）—— §172① 必须变红。预期 BLOCKED',
    file: SPLASH,
    anchor: /this\.reveal\(\);/,
    count: 1,
    apply: (s) => s.replace('this.reveal();', 'void 0;'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M2',
    note: '标题淡出不再触发 reveal（23MB 视频退回整层隐藏后才加载）—— §172② 必须变红。预期 BLOCKED',
    file: BOOT,
    anchor: /if \(window\.__bootGate\) window\.__bootGate\.reveal\(\);/,
    count: 1,
    apply: (s) => s.replace('if (window.__bootGate) window.__bootGate.reveal();', 'void 0;'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M3',
    note: 'reveal 阶段不再直接开播（退回整层隐藏后才换帧）—— §172③ 必须变红。预期 BLOCKED',
    file: CONTOUR,
    anchor: /bootHold = false;\s*\n\s*apply\(\);/,
    count: 1,
    apply: (s) => s.replace(/bootHold = false;\s*\n\s*apply\(\);/, 'void 0;'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M4',
    note: '加载阶段就移除 is-static（海报在空窗里完全冻住）—— §172④ 必须变红。预期 BLOCKED',
    file: CONTOUR,
    anchor: /if \(video\.playbackRate !== speedMul\) video\.playbackRate = speedMul;\n    \/\* 已经在播时/,
    count: 1,
    apply: (s) => s.replace(
      'if (video.playbackRate !== speedMul) video.playbackRate = speedMul;\n    /* 已经在播时',
      "layer.classList.remove('is-static');\n    if (video.playbackRate !== speedMul) video.playbackRate = speedMul;\n    /* 已经在播时",
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M5',
    note: 'playing 时不再移除 is-static（海报漂移永不交棒）—— §172④ 必须变红。预期 BLOCKED',
    file: CONTOUR,
    anchor: /layer\.classList\.remove\('is-static'\);/,
    count: 2,
    apply: (s) => s.split("layer.classList.remove('is-static');").join('void 0;'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M6',
    note: '标题又给单字设延迟（左起逐字，开头重新出现偏左/抽帧）—— §172⑥ 必须变红。预期 BLOCKED',
    file: BOOT,
    anchor: /s\.className = 'ch';/,
    count: 1,
    apply: (s) => s.replace("s.className = 'ch';", "s.className = 'ch';\n      s.style.animationDelay = '0ms';"),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
];
