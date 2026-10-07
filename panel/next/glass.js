/**
 * glass.js · 液态玻璃光学引擎（v2 控制台版）
 * ─────────────────────────────────────────────────────────────────────────────
 * 上游：自研库 `estrella-glass.js`（作者本机另一个项目内的私有库，不随本仓库分发；
 *   路径与用户名此处**不写**，见 scripts/known-real.mjs 的哨兵表 —— 绝对路径会带出本机用户名）。
 *   `NEUTRAL=128` / `MAP_SCALE=0.5` / `EDGE_CLAMP=0.04` 与上游 `L166-168` 逐字一致，
 *   `buildMap` / `buildLensFilter` / `channelMatrix` / `roundRectPath` 是同名函数的改名移植。
 *   ⚠️ 2026-10-03 才把这条出处补上—— 此前只写"来自旧控制台"，而旧控制台那份本身也是
 *   从同一个库搬的，于是**上游被追丢了两跳**。调参前先看库的比这里的准。
 *   （库无 LICENSE 文件、自研自用，无许可障碍；本项目 Apache-2.0 不受影响。）
 *
 * 中间来源：旧控制台（`panel/parts/`）液态玻璃支线，2026-10-03 移植进 v2。
 * 三处适配，其余逐字保留：
 *   ① 候选从['.topbar','.tabs','.toast'] 改为 ['.topbar','.savebar'] ——
 *     v2 的真折射悬浮层只有这两个。⚠️ 灵动岛**不在**候选里，但理由 B29 已换过：
 *       旧理由是"纯黑是它自己的硬要求"（用户 B28 当时说"保留英雄栏现有效果"）——
 *       B29 用户明确要求「改为跟随当前主题配色」，那条理由已作废。
 *       现理由：岛是 `fit-content` 的**胶囊**，宽度随选中项与内容变，
 *       而折射贴图要按元素尺寸重建 —— 收益不抵成本。
 *     toast 是动态创建的瞬时件，走 style.css 里的纯 CSS 磨砂即可，不占逐帧滤镜名额。
 *   ② 接线方式：旧面板在启动序列里手动调 initGlass()；这里改成**文件尾部直接执行**
 *     （本文件在 index.html 里位于 body 底部、app.js 之前 —— 静态候选元素此时已在），
 *     app.js **零改动**。第 2/3 档（卡片/控件）是纯 CSS，挂在 body.eg-on 门控下，
 *     动态创建的卡片/弹窗自动生效，不需要任何 JS 标注。
 *   ③ 不需要 MutationObserver：唯一需要 JS 的第 1 档候选都是 index.html 里的
 *     静态元素，永远不会被重建。轮询（3s refresh）与切页都与本引擎无关。
 *
 * 它做的是**真折射**（不是 CSS 的 blur() 假毛玻璃）：
 *   Canvas 画一张位移贴图（R 通道=水平斜坡、B 通道=垂直斜坡，中性 128 = 不位移）
 *   → 塞进 SVG feDisplacementMap，用 R/B 通道当 X/Y 位移量
 *   → 再经 3 次分离 + 2 次 screen 混合做出边缘色散
 *   → 整张滤镜由 backdrop-filter: url(#id) 作用在元素**背后的内容**上。
 *
 * ⚠️ 本文件内**禁止** innerHTML / outerHTML / insertAdjacentHTML / document.write。
 * ⚠️ **无 rAF、无 setInterval**：滤镜是一张静态图，只在元素尺寸变化时重建。
 * ⚠️ 一键开关 G_ENABLED：false → initGlass() 直接返回 → 不加 body.eg-on
 *    → style.css 里那一整段玻璃样式一条都不生效，页面回到原始外观。
 */

const G_ENABLED = true;

const G_SVG_NS = 'http://www.w3.org/2000/svg';
const G_NEUTRAL = 128;      // 位移贴图的中性值：该像素不产生位移
const G_MAP_SCALE = 0.5;    // 贴图按半分辨率生成：肉眼够用、省一半像素
const G_EDGE_CLAMP = 0.04;  // 最外 4% 回中性：防把元素外的像素拉进来

/* 真折射的候选者，按优先级排列（前面的先拿透镜）。上限留 2、候选只有 2 个 ——
   队列满了转磨砂的路径仍然存在（面积闸也可能挡掉一个），上限不是装饰。 */
const G_LENS_CANDIDATES = ['.topbar', '.savebar'];
const G_MAX_LENS = 2;
/* 面积/单边闸（经验值）：GPU 成本正比于填充面积，主判据用面积。 */
const G_MAX_AREA = 640000;  // ≈ 800 × 800
const G_MAX_SIDE = 2400;    // 单边健全上限（防病态宽高比把贴图画爆）

/* 折射参数。
   ⚠️⚠️ **2026-10-03 修正一处"注释描述的是打算试到的值、不是现役值"**：
      这段注释原来写「scale −70 → −85 → **−140**（幅度轮）」、「−140 是逐档试出来的
      经验值」—— 而**代码一直是 `scale: -85`**（`git log -p` 确认从未改成 −140）。
      一个不存在的调参结论被写成了既成事实，下一个人照着"再往上调会出 Moiré"去推理，
      起点就错了。**本项目里"注释里的数字"必须能在代码或 git log 里对上**，
      否则它比没有注释更坏。

   现役值与**上游库** `Estrella glass` 的对照（这一列才是调参的起点）：
     |  参数   | 上游库 | 本文件 | 说明 |
     |---------|--------|--------|------|
     | scale   | −45    | −85    | ��文件近 2 倍 → 边缘弯折过强 |
     | core| .25    | .38    | 库的中性区覆盖 75%，本文件 62% |
     | chroma  | 16     | 5      | 色散偏弱 |
     | border  | .05    | .06    | 折射带宽度，接近 |
     | mapBlur | 27     | 18     | 贴图糊化，偏锐 |
     | blur    | 3      | 16     | ⚠️ 见下|
     | saturate| 190    | 140    | 透出的颜色发灰 |
     |brightness| 1.06| 1.02   | 偏暗 |

   ⚠️ **`blur` 那一项有个容易看错的地方**：上游有**两个** blur ——
      `blur: 3`（真折射路径）与 `fallbackBlur: 16`（不支持折射时的磨砂兜底），
      两者**永远不同时生效**（上游 `L405-409` 的分叉）。而 `style.css` 的
      `--c-eg-blur-1` 对应的是 **`fallbackBlur`**，不是 `blur: 3` ——
      真正偏大的是卡片那档 `--c-eg-blur-2`（6px，对标上游的 `blur: 3`）。

   ⚠️⚠️ **B29：这里的 `blur` 16 → 8，`style.css` 的兜底 `blur(8px)` 同步**
      （顶栏那一行）。理由是用户要顶栏与二级 tab 栏「融为一体化」——
      **相同的模糊半径是"融合"最强的知觉信号**（16 与 8 会被读成两种材质）。
      ⚠️ **这两处必须一起改**（就是下面那条纪律）：`apply()` 写的是**行内样式**，
      优先级高于任何 `body.eg-on .topbar` 规则 —— 只改 CSS 会被它盖掉，
      而表现是"我改了但没生效"。（实测：改 CSS 后顶栏 computed 仍是 `blur(16px)`，
      就是被这里覆盖的。）
      ⚠️ 降模糊**不影响顶栏文字对比度** —— 底色由白纱决定，不由模糊决定
      （实测 tb-titles 8.86:1 / pill 8.67:1），只影响"顶栏背后内容的可辨度"。 */
const G_DEFAULTS = {
  scale: -85, chroma: 5, border: 0.06, mapBlur: 18,
  core: 0.38, blur: 8, saturate: 140, brightness: 1.02,
};

/* ── 「这个环境到底能不能真折射」——三个独立信号，任一不过就转磨砂 ──────────
   ① G_LENS_PARSE —— CSS.supports 说这条值语法上收不收（偏松：jsdom 连 url(#x) 都收）。
   ② G_CAN_REFRACT —— 引擎族判据（挡"Safari 解析成功但不渲染"那一类）。
   ③ gProbeLens() —— 最硬的一条：真往一个游离元素上写一次再读回来；
      值被拒时 CSSOM 静默丢弃，getPropertyValue 拿到空串。不依赖 UA 表。 */
const G_PROBE_VALUE = 'blur(1px) url(#g-probe)';

const G_LENS_PARSE = (() => {
  if (typeof CSS === 'undefined' || typeof CSS.supports !== 'function') return false;
  if (CSS.supports('backdrop-filter', G_PROBE_VALUE)) return true;
  return CSS.supports('-webkit-backdrop-filter', G_PROBE_VALUE);
})();

const G_CAN_REFRACT = (() => {
  const ua = navigator.userAgent;
  if (/Firefox|FxiOS/.test(ua) || /iPhone|iPad|iPod/.test(ua)) return false;
  if (/Edg/i.test(ua)) return true;                 // Edge 是 Chromium 内核
  return /Chrome|Chromium|OPR|SamsungBrowser/.test(ua);
})();

function gProbeLens() {
  const probe = document.createElement('div');
  probe.style.setProperty('backdrop-filter', G_PROBE_VALUE);
  if (probe.style.getPropertyValue('backdrop-filter') !== '') return true;
  probe.style.setProperty('-webkit-backdrop-filter', G_PROBE_VALUE);
  return probe.style.getPropertyValue('-webkit-backdrop-filter') !== '';
}

const G_LENS_OK = G_LENS_PARSE && G_CAN_REFRACT && gProbeLens();

let gUid = 0;
let gDefsRoot = null;
const gInstances = [];

/** 隐藏的 SVG 容器：所有滤镜都挂这儿，不参与布局、不进无障碍树 */
function gDefs() {
  if (gDefsRoot && document.body.contains(gDefsRoot)) return gDefsRoot;
  gDefsRoot = document.createElementNS(G_SVG_NS, 'svg');
  gDefsRoot.setAttribute('width', '0');
  gDefsRoot.setAttribute('height', '0');
  gDefsRoot.setAttribute('aria-hidden', 'true');
  gDefsRoot.setAttribute('data-g-defs', '1');
  gDefsRoot.style.cssText = 'position:absolute;left:-9999px;width:0;height:0;overflow:hidden;pointer-events:none;';
  document.body.appendChild(gDefsRoot);
  return gDefsRoot;
}

/** 圆角矩形路径：贴图里那块"不位移"的中性区用它裁 */
function gRoundRectPath(ctx, x, y, w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y + r, x + r, y, r);
  ctx.closePath();
}

/** 位移贴图（引擎的心脏）。
 *  R 通道 = 水平斜坡、B 通道 = 垂直斜坡、中性 128；内部用羽化圆角矩形压成中性区 ——
 *  于是"边缘被弯折、中心保持原样"，这正是玻璃透镜的观感。
 *  失败信号：拿不到 2D 上下文 / 贴图导出抛错 → 返回 null（调用方据此降级为磨砂）。 */
function gBuildMap(w, h, radius, o) {
  const cw = Math.max(2, Math.round(w * G_MAP_SCALE));
  const ch = Math.max(2, Math.round(h * G_MAP_SCALE));
  const c = document.createElement('canvas');
  c.width = cw; c.height = ch;
  const ctx = c.getContext('2d');
  if (!ctx) return null;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, cw, ch);
  ctx.globalCompositeOperation = 'lighter';
  const gx = ctx.createLinearGradient(0, 0, cw, 0);
  gx.addColorStop(0, 'rgb(' + G_NEUTRAL + ',0,0)');
  gx.addColorStop(G_EDGE_CLAMP, 'rgb(255,0,0)');
  gx.addColorStop(1 - G_EDGE_CLAMP, 'rgb(0,0,0)');
  gx.addColorStop(1, 'rgb(' + G_NEUTRAL + ',0,0)');
  ctx.fillStyle = gx;
  ctx.fillRect(0, 0, cw, ch);
  const gy = ctx.createLinearGradient(0, 0, 0, ch);
  gy.addColorStop(0, 'rgb(0,0,' + G_NEUTRAL + ')');
  gy.addColorStop(G_EDGE_CLAMP, 'rgb(0,0,255)');
  gy.addColorStop(1 - G_EDGE_CLAMP, 'rgb(0,0,0)');
  gy.addColorStop(1, 'rgb(0,0,' + G_NEUTRAL + ')');
  ctx.fillStyle = gy;
  ctx.fillRect(0, 0, cw, ch);
  ctx.globalCompositeOperation = 'source-over';
  ctx.filter = 'blur(' + (o.mapBlur * G_MAP_SCALE).toFixed(2) + 'px)';
  const inset = Math.min(cw, ch) * o.border;
  ctx.fillStyle = 'rgba(' + G_NEUTRAL + ',' + G_NEUTRAL + ',' + G_NEUTRAL + ',' + Math.max(0, Math.min(1, 1 - o.core)).toFixed(3) + ')';
  gRoundRectPath(ctx, inset, inset, cw - inset * 2, ch - inset * 2, radius * G_MAP_SCALE);
  ctx.fill();
  ctx.filter = 'none';
  // 唯一一处 try/catch：画布被外部图片污染时 toDataURL 会抛，那是"降级"不是"bug"。
  try { return c.toDataURL('image/png'); } catch { return null; }
}

/** SVG 元素工厂 */
function gSvgEl(name, attrs) {
  const n = document.createElementNS(G_SVG_NS, name);
  for (const k in attrs) n.setAttribute(k, attrs[k]);
  return n;
}

/** 单通道分离矩阵：只留一个分量、其余清零 */
function gChannelMatrix(ch) {
  const v = ['0 0 0 0 0', '0 0 0 0 0', '0 0 0 0 0', '0 0 0 1 0'];
  v[ch] = ch === 0 ? '1 0 0 0 0' : (ch === 1 ? '0 1 0 0 0' : '0 0 1 0 0');
  return v.join('  ');
}

/** 折射滤镜：三个位移量依次放大（R/G/B 各一份）再 screen 合成 —— 边缘出现色散。
 *  ⚠️ color-interpolation-filters 必须显式写 sRGB：默认的 linearRGB 会让
 *     整块内容产生一个恒定位移（表现像"没对齐"而不是"滤镜坏了"）。 */
function gBuildLensFilter(inst) {
  const o = inst.opts;
  const f = gSvgEl('filter', {
    id: inst.id, x: '-25%', y: '-25%', width: '150%', height: '150%',
    primitiveUnits: 'userSpaceOnUse', 'color-interpolation-filters': 'sRGB',
  });
  const img = gSvgEl('feImage', {
    x: '0', y: '0', width: inst.w, height: inst.h,
    preserveAspectRatio: 'none', result: 'map',
  });
  img.setAttribute('href', inst.mapURL);
  f.appendChild(img);
  const chroma = Math.max(0, o.chroma) / 100;
  const scales = [o.scale, o.scale * (1 + chroma), o.scale * (1 + chroma * 2)];
  const dN = ['dR', 'dG', 'dB'];
  const cN = ['cR', 'cG', 'cB'];
  for (let i = 0; i < 3; i += 1) {
    f.appendChild(gSvgEl('feDisplacementMap', {
      in: 'SourceGraphic', in2: 'map', scale: scales[i],
      xChannelSelector: 'R', yChannelSelector: 'B', result: dN[i],
    }));
  }
  for (let j = 0; j < 3; j += 1) {
    f.appendChild(gSvgEl('feColorMatrix', {
      in: dN[j], result: cN[j], type: 'matrix', values: gChannelMatrix(j),
    }));
  }
  f.appendChild(gSvgEl('feBlend', { in: 'cR', in2: 'cG', mode: 'screen', result: 'rg' }));
  f.appendChild(gSvgEl('feBlend', { in: 'rg', in2: 'cB', mode: 'screen' }));
  return f;
}

/** 给一个元素挂透镜。成功返回实例，失败返回 null（调用方据此写 frost）。 */
function gMakeGlass(el, extra) {
  const inst = {
    el,
    id: 'g-lg-' + (++gUid),
    // extra 是**可选的覆盖项**（实验室页拿它给 A/B 两侧挂不同参数）——
    // 不传就是面板那一套默认值，行为与原来完全一致。
    opts: Object.assign({}, G_DEFAULTS, extra || {}),
    w: 0, h: 0, mapURL: null, ro: null,
  };

  const measure = () => {
    const r = el.getBoundingClientRect();
    inst.w = Math.max(1, Math.round(r.width));
    inst.h = Math.max(1, Math.round(r.height));
  };
  // 圆角从计算样式读：玻璃用元素自己的圆角，改 --r-* 时两边不会走散
  const radius = () => parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0;

  const build = () => {
    const old = document.getElementById(inst.id);
    if (old && old.parentNode) old.parentNode.removeChild(old);
    if (!inst.mapURL) inst.mapURL = gBuildMap(inst.w, inst.h, radius(), inst.opts);
    if (!inst.mapURL) return false;
    gDefs().appendChild(gBuildLensFilter(inst));
    return true;
  };
  const apply = () => {
    const o = inst.opts;
    const v = 'blur(' + o.blur + 'px) saturate(' + o.saturate + '%) brightness(' + o.brightness + ') url(#' + inst.id + ')';
    el.style.setProperty('-webkit-backdrop-filter', v);
    el.style.setProperty('backdrop-filter', v);
    el.setAttribute('data-eg-mode', 'lens');   // 降级可观测：人眼与断言都靠它
  };

  measure();
  if (!build()) return null;
  apply();

  // 尺寸真的变了才重建贴图。轮询不碰它 → 不会被高频调用。
  inst.refresh = () => {
    const pw = inst.w;
    const ph = inst.h;
    measure();
    if (pw === inst.w && ph === inst.h) return;
    inst.mapURL = null;
    build();
    apply();
  };
  inst.destroy = () => {
    if (inst.ro) inst.ro.disconnect();
    const f = document.getElementById(inst.id);
    if (f && f.parentNode) f.parentNode.removeChild(f);
    el.style.removeProperty('backdrop-filter');
    el.style.removeProperty('-webkit-backdrop-filter');
    el.removeAttribute('data-eg-mode');
    inst.mapURL = null;
  };
  // jsdom 没有 ResizeObserver：缺它只是不自动重算，不影响首屏，所以用 typeof 守卫。
  if (typeof ResizeObserver !== 'undefined') {
    let t = 0;
    inst.ro = new ResizeObserver(() => { clearTimeout(t); t = setTimeout(inst.refresh, 90); });
    inst.ro.observe(el);
  }
  gInstances.push(inst);
  return inst;
}

/** 拆掉全部实例与 SVG 容器（initGlass 的重入先拆再建就靠这一点）。 */
function gDestroyAll() {
  for (const g of gInstances) g.destroy();
  gInstances.length = 0;
  if (gDefsRoot && gDefsRoot.parentNode) gDefsRoot.parentNode.removeChild(gDefsRoot);
  gDefsRoot = null;
}

/** 唯一入口：给第 1 档的元素挂真折射；其余档位是纯 CSS（见 style.css 玻璃区块）。
 *
 *  ⚠️ 本文件**只在尾部调用这一次**。绝不许挂进 app.js 的 refresh() ——
 *     那是每 3 秒跑一次的轮询，挂进去就是每 3 秒重建一批 GPU 滤镜。
 *  ⚠️ body.eg-on 是 style.css 玻璃区块的**总闸**：不加它，卡片/控件/环境层
 *     一条都不生效 —— "加了类"这件事本身就是接线点，不是副作用。
 *  ⚠️ 每个候选元素都要留下 data-eg-mode（lens/frost/unsupported）与
 *     data-eg-lens-support（闭集合原因）：没有它，"这台机器走没走真折射"只能靠肉眼猜。
 */
function initGlass(root) {
  if (!G_ENABLED) return;                   // 一键关闭：类不加 → 全站玻璃样式全部失效
  const scope = root || document;           // 🔧 实验室页按"侧"调用（A/B 各一套 DOM），
                                            //    不传就是整页 —— 面板的默认行为完全不变
  gDestroyAll();                            // 幂等：重复调用先拆再建，不泄漏实例与滤镜
  document.body.classList.add('eg-on');

  let lens = 0;
  for (const sel of G_LENS_CANDIDATES) {
    const el = scope.querySelector(sel);
    if (!el) continue;                      // 元素不在就跳过（savebar hidden 时仍存在于 DOM）
    const r = el.getBoundingClientRect();
    const tooBig = r.width * r.height > G_MAX_AREA || Math.max(r.width, r.height) > G_MAX_SIDE;
    const inst = G_LENS_OK && !tooBig && lens < G_MAX_LENS ? gMakeGlass(el) : null;
    if (inst) lens += 1;
    else el.setAttribute('data-eg-mode', G_LENS_OK ? 'frost' : 'unsupported');
    // 逐元素记下为什么是这个结果（闭集合）：出问题时不靠猜，一眼能读。
    if (!G_LENS_PARSE) el.setAttribute('data-eg-lens-support', 'no-parse');
    else if (!G_CAN_REFRACT) el.setAttribute('data-eg-lens-support', 'no-engine');
    else if (!G_LENS_OK) el.setAttribute('data-eg-lens-support', 'no-probe');
    else if (tooBig) el.setAttribute('data-eg-lens-support', 'too-big');
    else if (!inst) el.setAttribute('data-eg-lens-support', 'cap');
    else el.setAttribute('data-eg-lens-support', 'lens');
  }
  // 页面级总信号：这一屏到底走没走真折射，一眼可读（也供断言观察）
  document.body.dataset.egEngine = lens ? 'lens' : 'frost';
}

// 本文件在 index.html 里位于 body 底部（app.js 之前）—— 静态候选元素此刻已在 DOM 里，
// 直接执行即可。savebar 虽然常态 hidden，但元素存在、hidden 只是不显示，标注照常工作。
initGlass();
