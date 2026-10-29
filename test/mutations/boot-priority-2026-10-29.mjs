/**
 * 启动首屏与静态缓存（§170 · 2026-10-29）的变异清单 —— 纯数据。
 * 跑法：
 *   NODE_OPTIONS= node scripts/mutate-lint.mjs
 *   NODE_OPTIONS= node scripts/mutate.mjs test/mutations/boot-priority-2026-10-29.mjs --layer check-wb
 * 纪律：anchor 必须在 pristine 文件里恰好命中 count 次；apply 必须返回不同且语法合法的内容。
 */
const BOOT_CSS = 'panel/next/boot-splash.css';
const BOOT_JS = 'panel/next/boot-splash.js';
const APP = 'panel/next/app.js';
const ISLAND = 'panel/next/island.js';
const SETJS = 'panel/next/settings.js';
const SERVER = 'panel/server.js';
const MAIN = 'electron/main.js';

export default [
  {
    id: 'M1',
    note: '开屏 z-index 掉回 95（被 ov-tip 140 / psn 提示 125 盖住）—— §170⑤ 必须变红。预期 BLOCKED',
    file: BOOT_CSS,
    anchor: /position: fixed; inset: 0; z-index: 200;/,
    count: 1,
    apply: (s) => s.replace('position: fixed; inset: 0; z-index: 200;', 'position: fixed; inset: 0; z-index: 95;'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M2',
    note: '开屏结束不调用 gate.finish（视频/轮询/HUD 永远不放行）—— §170④ 必须变红。预期 BLOCKED',
    file: BOOT_JS,
    anchor: /if \(window\.__bootGate\) window\.__bootGate\.finish\(\);/,
    count: 1,
    apply: (s) => s.replace(
      'if (window.__bootGate) window.__bootGate.finish();',
      'void 0;',
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M3',
    note: '删掉中途 watchdog（rAF 卡死时开屏永不退出）—— §170④ 必须变红。预期 BLOCKED',
    file: BOOT_JS,
    anchor: /GRID\.END_MS \+ 2000/,
    count: 1,
    apply: (s) => s.replace('GRID.END_MS + 2000', 'GRID.END_MS'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M4',
    note: '3 秒轮询不再等开屏（第二次 refresh 落进格栅 canvas）—— §170④ 必须变红。预期 BLOCKED',
    file: APP,
    anchor: /bootGate\.whenDone\(startRefreshTimer\);/,
    count: 1,
    apply: (s) => s.replace('bootGate.whenDone(startRefreshTimer);', 'startRefreshTimer();'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M5',
    note: 'HUD 入场不等开屏（12–16 条 WAAPI 与格栅抢帧）—— §170④ 必须变红。预期 BLOCKED',
    file: ISLAND,
    anchor: /bootGate\.whenDone\(beginHud\);/,
    count: 1,
    apply: (s) => s.replace('bootGate.whenDone(beginHud);', 'beginHud();'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M6',
    note: 'IDB 迁移不等开屏（读库 + 上传与 canvas 抢主线程）—— §170④ 必须变红。预期 BLOCKED',
    file: SETJS,
    anchor: /gate\.whenDone\(resolve\)/,
    count: 1,
    apply: (s) => s.replace('gate.whenDone(resolve)', 'resolve()'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M7',
    note: '静态资产退回 no-store（ETag/304 失效，每次全量重传）—— §170① 必须变红。预期 BLOCKED',
    file: SERVER,
    anchor: /'Cache-Control': isEntry \? 'no-store' : 'no-cache',/,
    count: 1,
    apply: (s) => s.replace("'Cache-Control': isEntry ? 'no-store' : 'no-cache',", "'Cache-Control': 'no-store',"),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M8',
    note: '删掉 gzip 响应头（压缩包算了但标成明文，浏览器直接解析失败）—— §170① 必须变红。预期 BLOCKED',
    file: SERVER,
    anchor: /if \(useGzip\) headers\['Content-Encoding'\] = 'gzip';/,
    count: 1,
    apply: (s) => s.replace("if (useGzip) headers['Content-Encoding'] = 'gzip';", 'void 0;'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M9',
    note: 'Electron 窗口底色退回旧值（首绘前先露浅灰空窗）—— §170⑤ 必须变红。预期 BLOCKED',
    file: MAIN,
    anchor: /backgroundColor: dark \? '#050812' : '#dfeeff',/,
    count: 1,
    apply: (s) => s.replace(
      "backgroundColor: dark ? '#050812' : '#dfeeff',",
      "backgroundColor: dark ? '#0b1226' : '#f5f7fc',",
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M10',
    note: '轮询跳重建退化成只比 HTML（不校验页面键，切页后可能误跳）—— §170③ 必须变红。预期 BLOCKED',
    file: APP,
    anchor: /html === S\.extra\.pageHtml && S\.extra\.pageHtmlKey === htmlKey/,
    count: 1,
    apply: (s) => s.replace(
      'html === S.extra.pageHtml && S.extra.pageHtmlKey === htmlKey',
      'html === S.extra.pageHtml',
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M11',
    note: 'Electron 未首绘也直接 show（先出空窗再出开屏）—— §170⑤ 必须变红。预期 BLOCKED',
    file: MAIN,
    anchor: /if \(!windowReady && !force\) \{ pendingShow = true; return; \}/,
    count: 1,
    apply: (s) => s.replace(
      'if (!windowReady && !force) { pendingShow = true; return; }',
      'if (false) { pendingShow = true; return; }',
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
];
