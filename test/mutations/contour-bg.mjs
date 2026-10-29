/**
 * 等高线背景（§163 · 2026-10-26）的变异清单。
 *
 * 目标：证明 §163 不是"写完就绿"的静态描述。每一条都打成一个真实会发生的
 * 静默失效形状（视频属性丢了/默认档没切/旧引擎没停/媒体表漂/没有 Range），
 * 期望全部由 check-wb 的 §163 报 BLOCKED。
 *
 *   | 条 | 打的是 | 期望 |
 *   |---|---|---|
 *   | C1 | 删视频 loop | BLOCKED |
 *   | C2 | 删视频 muted | BLOCKED |
 *   | C3 | preload=none → auto | BLOCKED |
 *   | C4 | 默认档 contour → shader | BLOCKED |
 *   | C5 | 默认档不暂停旧引擎 | BLOCKED |
 *   | C6 | startLoop 失去 !active 守卫 | BLOCKED |
 *   | C7 | 删 CSP media-src | BLOCKED |
 *   | C8 | 206 退化成 200 | BLOCKED |
 *   | C9 | 删速度事件监听 | BLOCKED |
 *   | C10 | reduced-motion 判据失效 | BLOCKED |
 *   | C11 | 自定义背景不暂停等高线 | BLOCKED |
 */
const IDX = 'panel/next/index.html';
const CBG = 'panel/next/contour-bg.js';
const SBG = 'panel/next/shader-bg.js';
const NEXTPAGE = 'panel/lib/next-page.js';
const SERVER = 'panel/server.js';
const SETJS = 'panel/next/settings.js';

const C1 = {
  id: 'C1',
  note: '删掉等高线视频的 loop —— 30s 循环变成播完即停，背景变成静态。预期 BLOCKED（§163②）',
  anchor: / muted playsinline loop preload="none"/,
  count: 1,
  file: IDX,
  apply: (s) => s.replace(' muted playsinline loop preload="none"', ' muted playsinline preload="none"'),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

const C2 = {
  id: 'C2',
  note: '删掉 muted —— 移动端/自动播放策略会拒绝播放，且手机可能出声。预期 BLOCKED（§163②）',
  anchor: /id="contourVideo"[^>]* muted/,
  count: 1,
  file: IDX,
  apply: (s) => s.replace(' muted playsinline ', ' playsinline '),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

const C3 = {
  id: 'C3',
  note: 'preload="none" → auto —— 首屏就下载整段 10MB 视频，saveData/reduced-motion 用户也被下载。预期 BLOCKED（§163②/④）',
  anchor: /id="contourVideo"[^>]*preload="none"/,
  count: 1,
  file: IDX,
  /* ⚠️ 不能裸 replace('preload="none"')：HTML 注释里也有一处，先命中的会是注释，
     视频标签本身没变 —— 这就是第一轮 C3 报 NOT-BLOCKED 的原因。 */
  apply: (s) => s.replace(
    /(<video[^>]*id="contourVideo"[^>]*?)preload="none"/,
    '$1preload="auto"',
  ),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

const C4 = {
  id: 'C4',
  note: '默认档 contour → shader —— 用户升级后看到的还是旧流光，新背景等于没上线。预期 BLOCKED（§163③）',
  anchor: /const DEFAULT_MODE = 'contour';/,
  count: 1,
  file: CBG,
  apply: (s) => s.replace("const DEFAULT_MODE = 'contour';", "const DEFAULT_MODE = 'shader';"),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

const C5 = {
  id: 'C5',
  note: '默认档不调用 ShaderBG.setActive(false)（两处都改成 true）—— 旧引擎继续每帧重画，低端机白烧 GPU。预期 BLOCKED（§163③）',
  anchor: /window\.ShaderBG\.setActive\(false\)/,
  count: 3,
  file: CBG,
  apply: (s) => s.split('window.ShaderBG.setActive(false)').join('window.ShaderBG.setActive(true)'),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

const C6 = {
  id: 'C6',
  note: 'startLoop 去掉 !active 守卫 —— setSpeed/visibility 会在等高线档重新起旧 rAF。预期 BLOCKED（§163③）',
  anchor: /if \(!active \|\| reduced\(\) \|\| raf \|\| bootHold \|\| !curSpeed \|\| curSpeed\.mul <= 0\) return;/,
  count: 1,
  file: SBG,
  apply: (s) => s.replace('if (!active || reduced() || raf || bootHold', 'if (reduced() || raf || bootHold'),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

const C7 = {
  id: 'C7',
  note: '删掉 CSP media-src —— 同源视频仍能播，但策略兜底少一条；未来换成 blob/跨源就会被静默拦。预期 BLOCKED（§163⑤）',
  anchor: /"media-src 'self'",/,
  count: 1,
  file: NEXTPAGE,
  apply: (s) => s.replace("  \"media-src 'self'\",\n", ''),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

const C8 = {
  id: 'C8',
  note: 'Range 分支退化成 200 —— 浏览器换主题/循环会反复整段下载，播放头也不能 seek。预期 BLOCKED（§163⑤）',
  anchor: /status: 206,/,
  count: 1,
  file: SERVER,
  apply: (s) => s.replace('status: 206,', 'status: 200,'),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

const C9 = {
  id: 'C9',
  note: '删掉 bgfx:speed 监听 —— 设置里的速度只改旧引擎，等高线永远 1x。预期 BLOCKED（§163④）',
  anchor: /document\.addEventListener\('bgfx:speed'/,
  count: 1,
  file: CBG,
  apply: (s) => s.replace("document.addEventListener('bgfx:speed'", "document.addEventListener('bgfx:speedx'"),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

const C10 = {
  id: 'C10',
  note: 'reduced-motion 的 reduce 判据改成 no-preference —— 系统要求静止时视频照播。预期 BLOCKED（§163④）',
  anchor: /prefers-reduced-motion: reduce/,
  count: 2,
  file: CBG,
  apply: (s) => s.split('(prefers-reduced-motion: reduce)').join('(prefers-reduced-motion: no-preference)'),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

const C11 = {
  id: 'C11',
  note: '自定义背景启用时不 setSuppressed(true)（两条路径都改成 false）—— 等高线视频在自定义层后面继续解码。预期 BLOCKED（§163④）',
  anchor: /window\.ContourBG\.setSuppressed\(true\)/,
  count: 2,
  file: SETJS,
  apply: (s) => s.split('window.ContourBG.setSuppressed(true)').join('window.ContourBG.setSuppressed(false)'),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

export default [C1, C2, C3, C4, C5, C6, C7, C8, C9, C10, C11];
