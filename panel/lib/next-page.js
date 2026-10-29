/**
 * 新版前端的**唯一读盘口**（2026-10-02 · 前端初步重构的接线）
 * ══════════════════════════════════════════════════════════════════════════
 *  这个模块回答一个问题：**"新版页面由哪些文件构成"**，并且是唯一回答它的地方。
 *
 *      NEXT_ASSETS            新版页面由哪些文件构成（名单）
 *      resolveNextAsset()     名字 → 绝对路径（三道闸，反目录穿越）
 *      readNextAsset()        读进来（**唯一读盘口**）
 *
 * ──────────────────────────────────────────────────────────────────────────
 *  为什么需要一份"页面清单"
 * ──────────────────────────────────────────────────────────────────────────
 *  在 2026-10-02「换主」之前，页面走的是另一套：**16 个 HTML 片段拼成一份**，
 *  由服务端 join 起来一次发出去（那份清单叫 `PARTS`，住在 `page-parts.js` 里）。
 *  那套东西连同 `panel/parts/` 已在 **S-12 第六批（2026-10-05）整块删除** ——
 *  本模块现在是**唯一**一份页面清单。
 *
 *  新版页面不是"拼装"形状：它是**独立的静态资产**（`index.html` + `style.css` +
 *  两个 ES module），必须由浏览器**分别请求** —— 因为 `<script type="module">`
 *  不能内联跨文件，而"把四个文件拼成一个 HTML"就等于引入一次构建。
 *  本项目是**零构建**的（页面每次请求从磁盘读、改完立刻生效），这条不能破。
 *
 *  所以本模块与已删除的 `PARTS` 是**另一类**清单，分工写清楚：
 *    · `PARTS`（已删） —— 拼装用；名单缺一个 = 页面少一块
 *    · 本模块             —— 分发用；名单缺一个 = 那个请求 404
 *  ⚠️ **不许再造一个"既能拼又能发"的东西**：那正是两份语义糊在一起的老路。
 *
 * ──────────────────────────────────────────────────────────────────────────
 *  ⚠️ 三道闸（白名单 → 名字形状 → `path.relative` 复核）与已删除的那套完全同形
 * ──────────────────────────────────────────────────────────────────────────
 *  这是本项目第二次由**服务端**按名字取前端文件，而"按名字取文件"正是目录穿越的
 *  经典入口。所以名字的校验不能靠"调用方不会传坏名字"：
 *    ① `path.basename(n) === n` —— 挡住 `a/b.html` 与 `/etc/passwd`
 *    ② 形状正则 + **白名单**    —— 白名单是主闸；正则只是第二道（挡住 `..`、`%2e%2e%2f`）
 *    ③ `path.relative` 复核     —— 前两道将来被放松，这一道仍要求结果在目录内
 *
 *  ⚠️ **白名单不是"宽松一点更方便"**：这里同时挡着两件事 ——
 *    · `README.md` / `verify.mjs` / `serve.mjs` 之类**不该被浏览器取到**的文件
 *      （文档与自检脚本没有理由出现在 HTTP 面上）
 *    · 将来有人往 `panel/next/` 里放一个 `config.json` 或 `.env` 备份，
 *      它**自动**就不可达，不需要谁记得去加一条排除
 *
 *  ⚠️ 缺文件 / 读失败 → **当场抛**，由调用方回 404/500 并说清原因。
 *     "静默回空"会让浏览器拿到一份空模块，表现是页面白屏而服务端一片安静。
 *
 *  依赖：只 import `node:fs` / `node:path` / `./paths.js`（L0）。本模块是 **L1**。
 *  ⚠️ **不许 import `server.js`**，也不许引 `src/` 的模块。
 */

import fs from 'node:fs';
import path from 'node:path';
import { NEXT_DIR } from './paths.js';

/**
 * 新版页面由哪些文件构成。**这是"新版页面有哪些资产"的唯一声明处。**
 *
 * 形状：`文件名 → Content-Type`。
 * 加一个资产只改这张表；`check-wb` 会拿 `readdirSync` 交叉核对**磁盘上有没有多出来的东西**
 * （多一个没登记的文件 = 它永远取不到，而页面看起来"只是少了个东西"）。
 *
 * ⚠️ `README.md` 与 `verify.mjs` **故意不在表里** —— 它们是给人看的与给 CI 跑的，
 *    没有理由出现在 HTTP 面上。
 */
export const NEXT_ASSETS = {
  'index.html': 'text/html; charset=utf-8',
  'style.css': 'text/css; charset=utf-8',
  /* 左下角设置层（2026-10-23 · P2）：外观 / 启动 / 关于 / 数据。 */
  'settings.css': 'text/css; charset=utf-8',
  'settings.js': 'text/javascript; charset=utf-8',
  'app.js': 'text/javascript; charset=utf-8',
  'schema.js': 'text/javascript; charset=utf-8',
  'demo-state.js': 'text/javascript; charset=utf-8',
  /* `splash.js`（2026-10-22）：`<head>` 里的同步启动层，先把本地字体偏好写到
     `<html>` 上再让样式表生效。必须登记 —— 否则 §58① 的双向比对会把它判成
     "永远取不到的孤儿文件"。 */
  'splash.js': 'text/javascript; charset=utf-8',
  'boot-splash.css': 'text/css; charset=utf-8',
  'boot-splash.js': 'text/javascript; charset=utf-8',

  /* ── 动效三件套 + 实验室（2026-10-02 · UI 升级轮）────────────────────────
     `motion.js` / `liquid-toggle.js` / `liquid-toggle.css` 是**动效能力层**。
     ⚠️ 2026-10-20 订正：旧注释写「只被实验室页引用，产品页尚未接入任何液态控件」——
     **与实物相反**。产品页早已直引：`index.html` 的 `src="./motion.js"` 与
     `src="./liquid-toggle.js"`，且 `app.js` 里 `LIQUID_ON = true`、`switch` 渲染会挂 `liq-host`。
     留着旧说法会误导下一个以为"接入还没做"的人。

     ⚠️ 为什么现在就登记、而不是等接入产品页再登记：
     这张表同时是「HTTP 面」和「磁盘上不许有孤儿文件」的判据
     （check-wb 第 58 节拿它和 readdirSync 双向比对）。
     不登记 ⇒ 契约判红；把文件挪出 `panel/next/` ⇒ 又要动 paths.js 的目录推导。
     登记的代价只是多三条 MIME 映射，收益是这个能力层有个正式位置。
     ⚠️ **接入产品页时不需要改这张表**（名字已就位），
        但要记得 `index.html` 里 <script> 的**顺序**：
        `motion.js` 必须在 `liquid-toggle.js` 之前 ——
        后者启动时要读 window.Motion，反了就是静默空组件。 */
  'motion.js': 'text/javascript; charset=utf-8',
  'icons.js': 'text/javascript; charset=utf-8',
  /* HUD 信息岛（2026-10-23）：顶栏状态岛 + 它的样式。玻璃材质跟随主题，
     不含 HUD 核；设置存浏览器 localStorage，由「维护 → HUD调整」页读写。 */
  'island.js': 'text/javascript; charset=utf-8',
  'island.css': 'text/css; charset=utf-8',
  'morph.js': 'text/javascript; charset=utf-8',
  'liquid-toggle.js': 'text/javascript; charset=utf-8',
  'liquid-toggle.css': 'text/css; charset=utf-8',
  'ticks.css': 'text/css; charset=utf-8',
  /* 人设域六页（2026-10-25）：整页视觉层。全部规则作用域在 `.psn`，
     与主面板的 `--c-*` 令牌互不覆盖；`index.html` 里排在 style.css 之后。
     ⚠️ 磁盘↔HTTP 面是双向比对（check-wb §58①）—— 这个文件不在表里就是 404，
        而页面只是"少了样式"，不会报错。 */
  'persona.css': 'text/css; charset=utf-8',
  /* 运行总览三栏（2026-10-27）：只作用于 `.ov*` / `#card-chain|dash|side` / `.ov-fold`，
     颜色仍走 `--c-*`。磁盘↔HTTP 双向比对见 check-wb §58①。 */
  'overview.css': 'text/css; charset=utf-8',
  /* `sortable.js`（2026-10-03 · 模型线路拖拽排序）：可排序列表引擎，接在
     `app.js` 的 `mountRouteSort()` 上（唯一接线点）。⚠️ 顺序仍然是硬要求：
     它启动时读 `window.Motion`，排在 `motion.js` 之后 —— 反了就是
     `console.warn('[sortable] 需要先加载 motion.js')` 之后**整个不挂载**，
     而页面照常工作、按钮照常能点（只是没有拖拽与让位动画），**不抛异常**。
     契约见 `check-wb` 第 61 节「模型线路的拖拽排序」。 */
  'sortable.js': 'text/javascript; charset=utf-8',
  /* `tilt.js`（2026-10-04 · 卡片的 3D 倾斜 + 跟随高光）：引擎只做一件事 ——
     光标 → `--tilt-rx/ry/gx/gy` 四个 CSS 变量（弹簧驱动）；`transform` 与高光层
     都在 `style.css` 里。⚠️ 它**没有重挂逻辑**：事件委托在 document 上，
     所以整页每 3 秒重建一次也不用管（与 `sortable.js` 刚好相反，别照抄那套）。
     ⚠️ 顺序硬要求：它启动时读 `window.Motion`，必须排在 `motion.js` 之后。
     契约见 `check-wb` 第 62 节「卡片的 3D 倾斜」。 */
  'tilt.js': 'text/javascript; charset=utf-8',
  /* `cursor-follow.js/.css`（2026-10-28 · 全局光标跟随层）：纯装饰环 + 点，
     点实时跟手、环弹簧拖尾并钳在 14px；悬停可点元素放大并换强调色。
     工厂 iframe 由 `factory-frame.js` 在帧 load 时调用 `CursorFollow.attachFrame`。
     契约见 `check-wb` §168（资产/层级/指针面/降级/时钟纪律/桥接线）。 */
  'cursor-follow.css': 'text/css; charset=utf-8',
  'cursor-follow.js': 'text/javascript; charset=utf-8',
  'lab-liquid-toggle.html': 'text/html; charset=utf-8',
  'lab-ticks.html': 'text/html; charset=utf-8',
  /* `lab-motion-spec.html`（2026-10-03）：交互与动效判据的实验室。
     与另两个 lab 同类 —— 都是"判据的可视化"，都靠双击/file:// 打开，
     不接产品页。登记它的理由是 §58① 的**磁盘↔名单双向比对**：
     没登记的 .html 会被判成"永远取不到的孤儿文件"（而页面看起来只是少了个东西）。 */
  'lab-motion-spec.html': 'text/html; charset=utf-8',
  /* `lab-liquid-glass.html`（2026-10-22）：液态玻璃制作站。隐藏实验页，
     不挂产品导航；与另三个 lab 同类，双击/file:// 可开。
     ⚠️ 它加载真实的 `style.css` 取产品令牌，不复制一套颜色。 */
  'lab-liquid-glass.html': 'text/html; charset=utf-8',
  'glass-station.css': 'text/css; charset=utf-8',
  'glass-station.js': 'text/javascript; charset=utf-8',
  /* `visual-factory.html`（2026-10-25）：工厂 → 视觉工厂的整页工具。
     它是**独立单文件**（自带 CSS/JS/SVG，无外部请求），由 factory-frame.js 用全幅常驻
     iframe 承载，不是普通 schema 卡片页。源是仓库外的独立工厂工程，构建后原样复制；
     当前 286,170 B · sha256 `06f9039c…`。工厂保留独立外观（不设 data-embed）；
     桌面单文件外观不变。⚠️ 更新时：改源 → rebuild → 覆盖本文件 → 同步这里的哈希。 */
  'visual-factory.html': 'text/html; charset=utf-8',
  /* `plugin-factory.html`（2026-10-27）：工厂 → 插件工厂的整页工具。
     独立单文件、整面结构、无玻璃卡；数据读 /api/state，入口 postMessage 回控制台。 */
  'plugin-factory.html': 'text/html; charset=utf-8',
  /* `persona-factory.html`（2026-10-27）：工厂 → 人设工厂的整页工具。
     独立单文件（自带 CSS/JS/SVG，零外部请求），作为「工厂」二级页在常驻 iframe 里打开。
     源在 `panel/next/persona-studio/`，改源后跑
     `scripts/build-persona-factory.mjs` 重建，不要手改产物。 */
  'persona-factory.html': 'text/html; charset=utf-8',
  /* `persona-entry.css`（2026-10-27）：只补 `.factory-pane` 的绝对定位与
     0.22s 切换入场；`.factory-host` 仍由 style.css 定义。 */
  'persona-entry.css': 'text/css; charset=utf-8',
  /* `factory-frame.js`（2026-10-25）：工厂帧控制器 —— 把 iframe 常驻在 #page
     之外的固定层，悬停/切页时预热，只显隐不重载；由 `#page[data-frame]` 选帧。
     独立模块，不进 app.js 的渲染主链。 */
  'factory-frame.js': 'text/javascript; charset=utf-8',
  /* `glass-scrim.css`（2026-10-22）：弹窗的渐进模糊遮罩，产品页与制作站共用。
     它只消费 style.css 的令牌，不定义 --c-*。 */
  'glass-scrim.css': 'text/css; charset=utf-8',
  /* `glass.js`（2026-10-03 01:28 出现）：液态玻璃光学引擎，从旧控制台移植进 v2。
     ⚠️ 登记它的理由是 §58① 的**双向比对**：`.html/.css/.js` 只要落在磁盘上就必须登记，
        否则被判成"永远取不到的孤儿文件"（而页面看起来只是少了个东西）。
     ✅ 2026-10-03 补记：登记后不久，`index.html` 里已接上 `<script src="./glass.js">`，
        位置在 `motion.js` / `icons.js` 之前、`app.js` 之前 —— 与它自身注释里写的
        "body 底部、app.js 之前"一致。**现在登记与接线两处都对上了。**
     ⚠️ 顺序仍然重要：它在 `app.js` 之前，因为要的就是"静态候选元素此刻已在 DOM 里"；
        挪到 app.js 之后会拿到空候选（不报错，只是玻璃效果一条都不生效）。 */
  'glass.js': 'text/javascript; charset=utf-8',
  /* `shader-bg.js`（2026-10-04 · 背景引擎：canvas 颗粒渐变，接替六团流体）。
     自执行模块：自己找 #shaderBg 起循环、按 VARIANTS 数据建 #bgPickList 的 swatch。
     ⚠️ 预设色是**数据**（VARIANTS 常量），不进 style.css —— 那边有"零就地色值"契约。
     ⚠️ 顺序不依赖 Motion（零依赖），但要在 app.js 的 DOM 语义无关位置即可；
        reduced-motion 下只画一帧；WebGL 不可用退 2D 渐变（fail-open）。
     契约见 `check-wb`「新版背景」⑥/⑦ 与 `panel/next/verify.mjs` ②·。 */
  'shader-bg.js': 'text/javascript; charset=utf-8',
  /* `contour-bg.js`（2026-10-26 · 等高线背景）：默认档的视频/海报控制器。
     它复用 shader-bg.js 的 SPEEDS 与 `bgfx:speed` 事件，自己不写速度键；
     模式键 `qqbot-bg-mode`（缺省 contour），旧流光的 `qqbot-bgfx` 原样保留。
     契约见 check-wb §163 与 panel/next/verify.mjs。 */
  'contour-bg.js': 'text/javascript; charset=utf-8',
  /* `url-safe.js`（2026-10-05 · 开源前审查第 10 轮 · H-01）：`href` 的协议白名单。
     它**只被 `app.js` 当 ES 模块 import**（不是 `<script src>`）；
     登记它的理由与上面几条一样，是 §58① 的**磁盘↔名单双向比对** ——
     落盘的 `.js` 不登记就会被判成"永远取不到的孤儿文件"。
     ⚠️ 为什么它是**独立文件**而不是写在 app.js 里：那个文件一 import 就建 DOM、
        起定时器、发请求，node 里跑不起来 ⇒ 护栏只能退化成"在源码里 grep 正则"。
        抽成零依赖叶子后，smoke 能直接 import 它跑真值表（行为级护栏）。
        理由的完整版写在它自己的文件头，别在这儿再抄一遍。 */
  'url-safe.js': 'text/javascript; charset=utf-8',
};

/** 页面入口（`GET /next` 发的那一个）。**只此一处**声明，别处不许再写死文件名。 */
export const NEXT_ENTRY = 'index.html';

/**
 * 入口页的 `Content-Security-Policy`（2026-10-05 · 开源前审查第 10 轮 · H-02）。
 *
 * 为什么需要它：`esc()` / `safeHref()` 都是**逐点**的防御（改一处、防一处），
 * 而 CSP 是**兜底** —— 哪天有人又写出一个没转义的插值，它决定那段脚本能不能执行。
 * 它是 S-07 / H-01 那类"绕过转义"缺陷的最后一道网。
 *
 * ⚠️ 它为什么住在**本模块**（而不是 `server.js`）：本模块是唯一"零副作用、能被
 *    `import` 的叶子"，而 `server.js` 一 import 就会起 HTTP 服务 ⇒ 策略里到底写了什么
 *    只能靠 grep 源码去看。放这里，smoke 能直接把这份策略**读出来断言**。
 *
 * ⚠️ 为什么只有**入口页**用它：CSP 只对**文档**生效（JS/CSS 资产不是文档），
 *    而 `panel/next/` 下的 `lab-*.html` 是自带内联 `<style>` 的独立实验室页 ——
 *    套同一份策略会把它们当场打坏。所以接线处只在 `asset.name === NEXT_ENTRY` 那一支发它。
 *
 * 逐条为什么这么写（**改它之前先读完**）：
 *  · `script-src 'self'` —— 页面的 9 个 `<script>` 全是 `src=` 外链、零内联脚本、
 *    零 `eval` / `new Function`（逐项 grep 实测为 0）。**故意不给 `unsafe-eval`**：
 *    给了就等于把"绕过转义"重新变回一条可执行路径。
 *  · `style-src 'self' 'unsafe-inline'` —— 这个 `unsafe-inline` 是**必需**的：
 *    `app.js` 有 55 处内联 `style="…"`（进度条宽度、二维码尺寸、滑块位置…），
 *    去掉它整页版式会**静默**塌掉，而 DOM 级断言看不见版式。
 *    样式注入的危害等级远低于脚本注入，这个取舍是有意的。
 *  · `img-src 'self' data: blob:` —— `data:` 是 `style.css` 的颗粒噪点
 *    （`data:image/svg+xml;…`）；**`blob:` 是登录二维码**：二维码弹窗把
 *    `/api/qrcode` 的响应体装成 Blob、再用 `URL.createObjectURL()` 渲染。
 *    少了 `blob:` 的症状非常具体（2026-10-13 真机截图）：接口通、日志显示
 *    「✔ 已换一张新二维码」，页面上却是一张**裂图** —— 因为 CSP 把 blob: 拦了，
 *    而裂图与"取不到"长得一样，光看页面分不出是接口坏了还是策略拦了。
 *  · `connect-src 'self'` —— `app.js` 只 fetch 同源的 `/api/…`。
 *  · `object-src` / `base-uri` / `frame-ancestors` 三条是零成本的加固：
 *    页面不嵌插件对象、不写 `<base>`、也不该被别的页面 iframe 套走。
 */
export const PANEL_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ');

/** 合法资产名的形状。**不含 `/`** —— 于是 `..` 与编码后的分隔符都进不来。 */
const SAFE_ASSET_NAME = /^[a-z0-9][a-z0-9.-]*\.(?:html|css|js)$/;

/**
 * 资产名 → 绝对路径，**并保证结果没有逃出 `panel/next/`**。
 * 三道闸逐条可断言：白名单 → 形状 → `path.relative` 复核。
 */
export function resolveNextAsset(name, dir = NEXT_DIR) {
  const n = String(name == null ? '' : name);
  if (!n) throw new Error('资产名为空');
  if (!Object.prototype.hasOwnProperty.call(NEXT_ASSETS, n)) {
    throw new Error(`不是登记过的资产：${n}（只许取 ${Object.keys(NEXT_ASSETS).join(' / ')}）`);
  }
  if (path.basename(n) !== n || path.isAbsolute(n)) {
    throw new Error(`资产名不许带路径：${n}`);
  }
  if (!SAFE_ASSET_NAME.test(n)) {
    throw new Error(`资产名形状不合规：${n}`);
  }
  const base = path.resolve(dir);
  const abs = path.resolve(base, n);
  const rel = path.relative(base, abs);
  if (rel !== n || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`资产路径逃出了 next 目录：${n}`);
  }
  return abs;
}

/**
 * 读一个资产。**唯一读盘口** —— 别处不许再 `fs.readFileSync` 读这个目录。
 * 读失败当场抛（形态与已删除的片段装载器 `loadParts()` 一致）。
 *
 * 进程内按绝对路径缓存：`mtimeMs + size` 同时不变才复用，改文件立刻失效。
 * `etag` 由同一组指纹生成，服务端拿它做 304 协商（见 server.js 的资产分发块）。
 *
 * @returns {{name: string, type: string, raw: string, etag: string}}
 */
const ASSET_CACHE = new Map();

function assetEtagOf(st) {
  return '"' + Math.round(st.mtimeMs).toString(16) + '-' + st.size.toString(16) + '"';
}

export function readNextAsset(name, dir = NEXT_DIR) {
  const abs = resolveNextAsset(name, dir);
  let st;
  try {
    st = fs.statSync(abs);
  } catch (e) {
    throw new Error(`新版页面资产读不到：${name}（${abs}）—— ${e.message}`);
  }
  const etag = assetEtagOf(st);
  const hit = ASSET_CACHE.get(abs);
  if (hit && hit.etag === etag) {
    return { name, type: NEXT_ASSETS[name], raw: hit.raw, etag };
  }
  let raw;
  try {
    raw = fs.readFileSync(abs, 'utf8');
  } catch (e) {
    throw new Error(`新版页面资产读不到：${name}（${abs}）—— ${e.message}`);
  }
  if (!raw.trim()) throw new Error(`新版页面资产是空的：${name} —— 空资产发出去必然白屏`);
  ASSET_CACHE.set(abs, { etag, raw });
  return { name, type: NEXT_ASSETS[name], raw, etag };
}

/**
 * MBTI 人设页的 16 张官方场景图（2026-10-26 · 维护者授权随包分发）。
 *
 * ⚠️ 它们**刻意不在 `NEXT_ASSETS` 里**：那张表是"顶层 html/css/js"的 UTF-8 文本面，
 *    而这里是二进制 jpg、放在 `panel/next/assets/mbti/` 子目录，由 `server.js` 的
 *    `/assets/mbti/<name>` 显式路由发送。`unregisteredAssets()` 只筛顶层
 *    html/css/js/mjs/md，因此不会把 `assets/` 目录误判成孤儿。
 *    加图/换图只改这一份名单与磁盘文件，别在路由里再抄一份文件名。
 */
export const MBTI_ART_NAMES = Object.freeze([
  'intj.jpg', 'intp.jpg', 'entj.jpg', 'entp.jpg',
  'infj.jpg', 'infp.jpg', 'enfj.jpg', 'enfp.jpg',
  'istj.jpg', 'isfj.jpg', 'estj.jpg', 'esfj.jpg',
  'istp.jpg', 'isfp.jpg', 'estp.jpg', 'esfp.jpg',
]);

/** 读一张 MBTI 场景图。名字必须在 16 名单内，且结果不能逃出 assets/mbti。 */
export function readMbtiArt(name, dir = NEXT_DIR) {
  const n = String(name == null ? '' : name).toLowerCase();
  if (!MBTI_ART_NAMES.includes(n)) throw new Error(`不是登记过的 MBTI 场景图：${n}`);
  if (path.basename(n) !== n || path.isAbsolute(n)) throw new Error(`MBTI 图名不许带路径：${n}`);
  const base = path.resolve(dir, 'assets', 'mbti');
  const abs = path.resolve(base, n);
  if (path.relative(base, abs) !== n) throw new Error(`MBTI 图路径逃出 assets/mbti：${n}`);
  let raw;
  try {
    raw = fs.readFileSync(abs);
  } catch (e) {
    throw new Error(`MBTI 场景图读不到：${n}（${abs}）—— ${e.message}`);
  }
  if (raw.length < 4 || raw[0] !== 0xff || raw[1] !== 0xd8 || raw[raw.length - 2] !== 0xff || raw[raw.length - 1] !== 0xd9) {
    throw new Error(`MBTI 场景图不是完整 JPEG：${n}`);
  }
  return { name: n, type: 'image/jpeg', raw };
}

/**
 * **挂在根上之后**的路径 → 资产名（2026-10-02 · 新版成为唯一控制台）。
 *
 * 为什么这个映射要住在**叶子**里、而不是 `server.js`：
 *   它和 `NEXT_ASSETS` 是同一件事的两面（"哪些路径可取" ←→ "哪些文件可发"），
 *   而白名单是**安全主闸**。把映射写在路由里，等于在闸门外面又摆了一张"允许的路径"表 ——
 *   两张表就会漂：多一条路径 = 多一个可取的入口，而**页面照常工作**。
 *   所以这里从 `NEXT_ASSETS` **派生**，不重抄一遍名字。
 *
 * ⚠️ 只认**一级**路径（`/style.css`），不认 `/a/b`。
 *    多级路径要立刻否决 —— 否则 `/x/../style.css` 这类形态就得靠下面的
 *    `basename` 复核去兜，而那本该是"根本进不来"的事。
 *
 * @returns {string|null} 命中则返回 `NEXT_ASSETS` 里的资产名；否则 `null`
 */
export function assetNameForRootPath(pathname) {
  const p = String(pathname == null ? '' : pathname);
  if (!p.startsWith('/')) return null;
  if (p.indexOf('/', 1) >= 0) return null;   // 只许一级：二级以上一律不认
  const name = p.slice(1);
  if (!name) return null;                    // `/` 由调用方按入口处理，不在这里兜
  return Object.prototype.hasOwnProperty.call(NEXT_ASSETS, name) ? name : null;
}

/**
 * 磁盘上有没有**没登记**的资产（供 `check-wb` 交叉核对）。
 * 只数文件、不读内容；目录不存在时返回空数组（新版页面被删掉不算错）。
 */
export function unregisteredAssets(dir = NEXT_DIR) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((f) => SAFE_ASSET_NAME.test(f) || /\.(?:html|css|js|mjs|md)$/.test(f))
    .filter((f) => !Object.prototype.hasOwnProperty.call(NEXT_ASSETS, f))
    .sort();
}

/**
 * 等高线背景的媒体白名单（2026-10-26）。
 *
 * 二进制素材**不进 `NEXT_ASSETS`**：那张表是顶层文本资产面，二进制由
 * `/assets/contour/<name>` 显式路由发送。客户端 `contour-bg.js` 里也有一份
 * 同名表 —— 服务端白名单是安全主闸，客户端只是引用；两份是否漂移由
 * `check-wb §163` 逐项比对，不靠人记。
 */
export const CONTOUR_MEDIA = Object.freeze({
  'contour-light-standard-v2.mp4': 'video/mp4',
  'contour-dark-standard-v2.mp4': 'video/mp4',
  'contour-light-lite-v2.mp4': 'video/mp4',
  'contour-dark-lite-v2.mp4': 'video/mp4',
  'contour-light-v2.jpg': 'image/jpeg',
  'contour-dark-v2.jpg': 'image/jpeg',
});

/** 媒体名 → { name, type, abs }。名字必须在白名单内，且结果不能逃出 assets/contour。 */
export function resolveContourMedia(name, dir = NEXT_DIR) {
  const n = String(name == null ? '' : name).toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(CONTOUR_MEDIA, n)) {
    throw new Error(`不是登记过的等高线媒体：${n}`);
  }
  if (path.basename(n) !== n || path.isAbsolute(n)) {
    throw new Error(`等高线媒体名不许带路径：${n}`);
  }
  const base = path.resolve(dir, 'assets', 'contour');
  const abs = path.resolve(base, n);
  if (path.relative(base, abs) !== n) {
    throw new Error(`等高线媒体路径逃出 assets/contour：${n}`);
  }
  return { name: n, type: CONTOUR_MEDIA[n], abs };
}

/**
 * 解析单段 Range。返回值：
 *   null           —— 没有 Range（发 200 全量）
 *   { start, end } —— 合法闭区间（发 206）
 *   { invalid: true } —— 乱码 / 多段 / 越界（发 416）
 * 只支持单段：多段会让流式发送与 Content-Length 的关系变复杂，而背景视频
 * 只需要浏览器做单段寻址。后缀 `bytes=-n` 超过文件大小时按整文件处理。
 */
export function parseByteRange(header, size) {
  if (header == null || String(header).trim() === '') return null;
  const raw = String(header).trim();
  const n = Number(size);
  if (!Number.isSafeInteger(n) || n <= 0) return { invalid: true };
  if (!raw.startsWith('bytes=')) return { invalid: true };
  const m = /^bytes=(\d*)-(\d*)$/.exec(raw);
  if (!m || (m[1] === '' && m[2] === '')) return { invalid: true };
  if (m[1] === '') {
    const suffix = Number(m[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return { invalid: true };
    return { start: Math.max(0, n - suffix), end: n - 1 };
  }
  const start = Number(m[1]);
  let end = m[2] === '' ? n - 1 : Number(m[2]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return { invalid: true };
  if (start >= n || start > end) return { invalid: true };
  end = Math.min(end, n - 1);
  return { start, end };
}
