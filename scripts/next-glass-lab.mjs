/**
 * 生成「v2 控制台 · 液态玻璃终轮实验室」——**单文件 HTML**，双击即可用浏览器打开。
 *
 * 它抽的是**真件**（与上一版预览同一个姿势，不手写模拟）：
 *   · panel/next/style.css   逐字（含本轮优化后的令牌与玻璃区块）
 *   · panel/next/glass.js    逐字（真折射引擎）
 *   · 两侧 DOM 用面板的真实类名（.topbar / .card / .savebar / .metric / .rows）
 * 只补三样：① 顶部说明（总工程进度 + 分维度改进表）；② 控制条（A/B 视图、深浅、四个滑块）；
 *          ③ 实验室专有的一点定位覆盖（.topbar 是 sticky、.savebar 是 fixed，
 *             放进并排两栏里必须改成 relative/absolute，否则两条会叠在视口上）。
 *
 * ⚠️ A 侧（优化前）的令牌取值**不是凭记忆写的**：它一次是从
 *    ~/Desktop/v2控制台-液态玻璃预览-1003.html（上一轮交付物，含当时的 style.css 快照）
 *    里抠出来的；这里再写成一份显式覆盖，改哪一行都能被下面的自检对上。
 *
 * 用法： node scripts/next-glass-lab.mjs [输出路径]
 * ⚠️ 抽件后先自证（三个 includes），否则抽错了会静默产出半成品。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const NEXT = path.join(ROOT, 'panel/next');
/* ⚠️ 默认输出路径**不许**写死本机绝对路径 —— 本机用户名会随文件一起进版本控制，
   而它在 `known-real` 里是一条**真值**，审计会直接判阻断（不是告警）。
   ⚠️ 本注释**故意不写出那个用户名**：写出来的那一刻，这条注释自己就成了新的泄漏口
   —— 与台账 Q26o 记过的"登记一条含真值的缺陷，结果把自己变成第 5 个泄漏口"同款。
   这里按既有的"不写死本机路径"先例改成 `os.homedir()` 推导，
   并保留 argv[2] 覆盖 + `GLASS_LAB_OUT` 环境变量，本机用法一点不变。 */
const OUT = process.argv[2]
  || process.env.GLASS_LAB_OUT
  || path.join(os.homedir(), 'Desktop', 'v2液态玻璃-终轮实验室-1003.html');

const css = fs.readFileSync(path.join(NEXT, 'style.css'), 'utf8');
const engine = fs.readFileSync(path.join(NEXT, 'glass.js'), 'utf8');

if (!css.includes('body.eg-on::before')) throw new Error('样式表里没有玻璃区块，抽错了');
if (!engine.includes('function initGlass(')) throw new Error('引擎抽错了');
if (!css.includes('--c-eg-blur-1')) throw new Error('模糊令牌没抽到（实验室靠它调滑块）');

/* ── 改进说明的数据 ──────────────────────────────────────────────────────────
   OLD / NEW 的**唯一来源**：glass.js 里的 G_DEFAULTS 前后两版。
   CSS 令牌的前后值另见下面的 ROWS（浅 / 深两侧各一列）。
   ⚠️ 这两个对象同时被实验室脚本用来给 A 侧挂旧参数的透镜 —— 改了这里 A 侧就跟着变。 */
const OLD = { scale: -70, chroma: 4, border: 0.06, mapBlur: 18, core: 0.42, blur: 14, saturate: 150, brightness: 1.03 };
const NEW = { scale: -85, chroma: 5, border: 0.06, mapBlur: 18, core: 0.38, blur: 16, saturate: 140, brightness: 1.02 };

const ROWS = [
  ['通透性', '四档白纱（浅 / 深）',
    '卡片 .58→.52 / .52→.46 · 控件 .46→.42 / .05→.04 · 悬浮条 .20→.16 / .05→.035 · 反相 .74→.70',
    '−10%（悬浮条 −20%）',
    '白纱每薄一分，透出来的色团就多一分。悬浮条是"要透"的那一档，降得最多'],
  ['通透性', '环境层加一层远景',
    '4 层色团 → 5 层（新增 --c-eg-bg-e，铺满、更淡）', '+1 层（+25% 层数）',
    '纵深来自"有近有远"，不是"一起更糊"。只有四个近景团时，玻璃后面像贴了一层纸'],
  ['通透性', '近景色团浓度',
    '浅 bg-a .08→.09 · bg-c .10→.11 ／ 深 .10→.09 · .12→.11', '浅 +12% ／ 深 −10%',
    '方向相反才对：浅底本来就淡要补，深底本来就重该收'],
  ['通透性', '网格线', '浅 .05→.04 ／ 深 .06→.05', '−20% ／ −17%',
    '网格是"折射的参照物"不是图案，太显眼就抢戏'],
  ['通透性', '第 2 档模糊（卡片）', '8px → 6px', '−25%',
    '卡片是贴着背景的一层，糊多了反而假（前一轮反馈"还是偏模糊"的落点之一）'],
  ['通透性', '第 1 档模糊（悬浮条）', '14px → 16px', '+14%',
    '悬浮条离背景最远 → 物理上就该最糊。与第 2 档拉开到近 3 倍'],
  ['观感', '噪点强度', '浅 .05 → .035（深色档保持 .05 未动）', '−30%（浅）',
    '噪点是材质感，过强就变"脏"。深色档不动：深底上它是唯一的颗粒来源，降了会发死'],
  ['观感', '饱和度', '150% → 140%', '−7%',
    '高饱和把透出来的色团压成实色块 —— 直接对应"色彩纯净度"'],
  ['观感', '提亮', '1.03 → 1.02', '−1%',
    '提亮叠白纱就是发白；两者一起收才换得来纯净'],
  ['观感', '内缘辉光 / 暗角',
    '浅 辉光 .55→.50 · 暗角 .06→.05 ／ 深 .12→.10 · .28→.26', '−9% ／ −17%',
    '明暗两侧一起收 = 过渡带变宽，硬边自然消失'],
  ['观感', '锐 / 柔 两档高光', '浅 锐 .55→.48（收）· 柔 .20→.26（开）', '−13% ／ +30%',
    '锐档收、柔档开：从"一条硬亮的边"变成"一段渐弱的反射"'],
  ['边缘', '1px 描边令牌', '无 → --c-eg-edge（浅 .28 / 深 .16）', '新增',
    '压住 backdrop-filter 在圆角处的采样毛刺。1px 不改尺寸、不增滤镜 → 零性能代价'],
  ['边缘', '弯折带 / 折射 / 色散', 'core .42→.38 · scale −70→−85 · chroma 4→5', '−10% / +21% / +25%',
    'core 收 = 弯折带变宽 → 过渡更柔，直接对应"消除破面"；折射要看得出来才叫折射'],
  ['整体', '模糊层次比', '14/8 = 1.75× → 16/6 = 2.67×', '+52%',
    '纵深感来自**层次差**，不是把两个数一起调大'],
];

const rowHtml = ROWS.map((r) => `<tr><td>${r[0]}</td><td>${r[1]}</td><td class="n">${r[2]}</td><td class="d">${r[3]}</td><td>${r[4]}</td></tr>`).join('\n');

/* ── 实验室专有样式（不属于面板）────────────────────────────────────────── */
const labCss = `
  .lab-head { max-width: 1560px; margin: 0 auto; padding: 20px 24px 8px; }
  .lab-head h1 { font-size: 24px; margin: 0 0 6px; }
  .lab-head p { margin: 4px 0; color: var(--c-text-2); font-size: 13px; line-height: 1.7; }
  .lab-note { background: var(--c-sunken); border: 1px solid var(--c-line); border-left: 3px solid var(--c-accent);
    border-radius: var(--r2); padding: 10px 14px; margin: 10px 0 4px; font-size: 12.5px; color: var(--c-text-2); line-height: 1.7; }
  .lab-table { width: 100%; border-collapse: collapse; margin: 8px 0 0; font-size: 12.5px; }
  .lab-table th { text-align: left; padding: 6px 8px; color: var(--c-text-3); font-weight: 500;
    border-bottom: 1px solid var(--c-line-strong); white-space: nowrap; }
  .lab-table td { padding: 6px 8px; border-bottom: 1px solid var(--c-line); vertical-align: top; color: var(--c-text-2); }
  .lab-table td.n { font-family: var(--mono); font-size: 11.5px; color: var(--c-text-1); }
  .lab-table td.d { color: var(--c-accent); font-weight: 600; white-space: nowrap; }

  .lab-bar { position: sticky; top: 0; z-index: 120; display: flex; flex-wrap: wrap; gap: 14px; align-items: center;
    padding: 10px 24px; background: color-mix(in srgb, var(--c-surface) 92%, transparent);
    -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px);
    border-top: 1px solid var(--c-line); border-bottom: 1px solid var(--c-line); }
  .lab-bar .grp { display: flex; align-items: center; gap: 6px; }
  .lab-bar label { font-size: 12px; color: var(--c-text-2); white-space: nowrap; }
  .lab-bar input[type=range] { width: 120px; accent-color: var(--c-accent); }
  .lab-bar .val { font-family: var(--mono); font-size: 11.5px; color: var(--c-text-1); min-width: 46px; }
  .lab-bar .sep { width: 1px; height: 20px; background: var(--c-line-strong); }
  .lab-bar .rd { font-family: var(--mono); font-size: 11.5px; background: var(--c-sunken); padding: 2px 7px; border-radius: 4px; }
  .lab-bar .rd.lens { background: var(--c-accent-weak); color: var(--c-accent); font-weight: 600; }
  .lab-bar2 { max-width: 1560px; margin: 0 auto; padding: 6px 24px 0; font-size: 12px; color: var(--c-text-3); line-height: 1.7; }

  .lab-stage { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; max-width: 1560px;
    margin: 0 auto; padding: 14px 24px 60px; align-items: start; }
  body[data-view="old"] .lab-stage, body[data-view="new"] .lab-stage { grid-template-columns: 1fr; }
  body[data-view="old"] .side-b { display: none; }
  body[data-view="new"] .side-a { display: none; }

  .side { position: relative; min-width: 0; padding: 14px; padding-bottom: 62px;
    border-radius: var(--r3); border: 1px dashed var(--c-line-strong); }
  .side-tag { position: absolute; top: -1px; left: -1px; z-index: 5; font-size: 11.5px; font-weight: 600;
    padding: 3px 10px; border-radius: var(--r3) 0 var(--r2) 0; background: var(--c-accent); color: var(--c-on-accent); }
  .side-b .side-tag { background: var(--c-ok); color: #fff; }
  /* ⚠️ 面板里 .topbar 是 sticky、.savebar 是 fixed —— 放进两栏会各自叠到视口上。
     这里改成在 .side 内定位：仍是"浮在内容之上"，背后有卡片 → 折射照样成立。 */
  .side .topbar { position: relative; top: auto; height: 52px; margin-bottom: 14px; }
  .side .savebar { position: absolute; left: 50%; bottom: 12px; transform: translateX(-50%);
    min-width: auto; width: calc(100% - 28px); }
  .side .card { margin-bottom: 0; }

  .lab-foot { max-width: 1560px; margin: 0 auto; padding: 0 24px 40px; color: var(--c-text-3); font-size: 12px; line-height: 1.7; }
`;

/* ── A 侧 = 优化前的取值（对照基线，滑块不动它）───────────────────────────────
   取值来源：上一轮交付物 ~/Desktop/v2控制台-液态玻璃预览-1003.html 里的 style.css 快照
   （浅 / 深两块），逐个抄在这里。**不写 bg-e**：那是本轮新增的层，A 侧本就没有
   （也关不掉——环境层是整页共用一层，见页脚说明，改用顶部"远景层"开关来对比）。 */
const sideOldCss = `
  .side-a {
    --c-eg-surface: rgba(255, 255, 255, .58);
    --c-eg-surface-2: rgba(255, 255, 255, .46);
    --c-eg-surface-hero: rgba(255, 255, 255, .20);
    --c-eg-surface-inv: rgba(16, 24, 40, .74);
    --c-eg-rim-sharp: rgba(255, 255, 255, .55);
    --c-eg-rim-soft: rgba(255, 255, 255, .20);
    --c-eg-edge: rgba(255, 255, 255, 0);
    --c-eg-vol-top: rgba(255, 255, 255, .55);
    --c-eg-vol-bottom: rgba(0, 0, 0, .06);
    --c-eg-grid: rgba(37, 99, 235, .05);
    --c-eg-bg-a: rgba(37, 99, 235, .08);
    --c-eg-bg-c: rgba(124, 132, 255, .10);
    --c-eg-blur-1: 14px;
    --c-eg-blur-2: 8px;
    --c-eg-sat: 150%;
    --c-eg-noise: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='120'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2'/%3E%3CfeColorMatrix type='matrix' values='0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0.05 0 0 0 0'/%3E%3C/filter%3E%3Crect width='120' height='120' filter='url(%23n)'/%3E%3C/svg%3E");
  }
  html[data-theme="dark"] .side-a {
    --c-eg-surface: rgba(21, 27, 35, .52);
    --c-eg-surface-2: rgba(255, 255, 255, .05);
    --c-eg-surface-hero: rgba(255, 255, 255, .05);
    --c-eg-surface-inv: rgba(233, 237, 243, .74);
    --c-eg-rim-sharp: rgba(255, 255, 255, .22);
    --c-eg-rim-soft: rgba(255, 255, 255, .07);
    --c-eg-edge: rgba(255, 255, 255, 0);
    --c-eg-vol-top: rgba(255, 255, 255, .12);
    --c-eg-vol-bottom: rgba(0, 0, 0, .28);
    --c-eg-grid: rgba(122, 162, 255, .06);
    --c-eg-bg-a: rgba(122, 162, 255, .10);
    --c-eg-bg-c: rgba(90, 110, 255, .12);
  }
`;

const sideHtml = (tag) => `
<section class="side side-${tag === '优化前' ? 'a' : 'b'}">
  <div class="side-tag">${tag}</div>
  <div class="topbar">
    <div class="tb-brand"><span class="logo">QQ</span>
      <div class="tb-titles"><b>QQ-BOT-CONTROL</b><span class="tb-sub">顶栏 · 第 1 档（悬浮条）</span></div></div>
    <div class="tb-pills"><span class="pill on"><span class="dot"></span>就绪</span><span class="pill"><span class="dot"></span>容器</span></div>
    <div class="tb-actions"><button class="btn btn-primary">一键启动</button></div>
  </div>
  <div class="card">
    <div class="card-h"><h2>卡片 · 第 2 档材质</h2><span class="spacer"></span><span class="tag accent">只读</span></div>
    <div class="card-b">
      <div class="metrics">
        <div class="metric"><div class="n">74%</div><div class="l">内存</div></div>
        <div class="metric"><div class="n">0.5G</div><div class="l">已用</div></div>
        <div class="metric"><div class="n">38</div><div class="l">本轮调用</div></div>
      </div>
      <div class="grid2">
        <div class="f"><div class="f-lb">触发概率</div><input type="number" value="0.35"></div>
        <div class="f"><div class="f-lb">冷却（秒）</div><input type="number" value="90"></div>
      </div>
      <div class="f"><div class="f-lb">人格摘要</div><textarea rows="2">它说话简短，不主动寒暄。</textarea></div>
      <div class="f-inline"><button class="btn btn-primary">保存并生效</button><button class="btn btn-ghost">丢弃改动</button></div>
      <div class="rows">
        <div class="row flat f-inline"><span class="tag ok">免费</span><span class="grow">智谱 GLM 额度</span><span class="hint">2000 万 token</span></div>
        <div class="row flat f-inline"><span class="tag warn">截止</span><span class="grow">硅基流动体验额度</span><span class="hint">10-08</span></div>
      </div>
    </div>
  </div>
  <div class="savebar"><span class="savebar-txt">保存条 · 第 1 档（反相）</span><span class="spacer"></span>
    <button class="btn btn-primary btn-sm">保存</button></div>
</section>`;

/* ── 实验室脚本 ──────────────────────────────────────────────────────────── */
const labJs = `
var OLD = ${JSON.stringify(OLD)};
var NEW = ${JSON.stringify(NEW)};
var cur = Object.assign({}, NEW);

/* B 侧四个滑块的**基准值**：必须与 style.css 里本轮的新值逐个对上，
   否则"拉回 100%"就不是交付值了（自检会盯这一条）。 */
var BASE = {
  light: { s: ['255, 255, 255', .52], s2: ['255, 255, 255', .42], hero: ['255, 255, 255', .16],
           sharp: ['255, 255, 255', .48], soft: ['255, 255, 255', .26], edge: ['255, 255, 255', .28],
           far: 'rgba(37, 99, 235, .05)' },
  dark:  { s: ['21, 27, 35', .46], s2: ['255, 255, 255', .04], hero: ['255, 255, 255', .035],
           sharp: ['255, 255, 255', .18], soft: ['255, 255, 255', .10], edge: ['255, 255, 255', .16],
           far: 'rgba(122, 162, 255, .05)' },
};
var FAR = { light: 'rgba(37, 99, 235, .05)', dark: 'rgba(122, 162, 255, .05)' };

function theme() { return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light'; }

var aInsts = [], bInsts = [];

function mount(side, opts) {
  var out = [];
  ['.topbar', '.savebar'].forEach(function (sel) {
    var el = side.querySelector(sel);
    if (!el) return;
    // ⚠️ 闸门必须自己守一遍：initGlass 里那个 G_LENS_OK 判断只管它自己那一轮，
    //    这里按侧挂载是另一条路径 —— 不重复判一次，非 Chromium 上也会被硬挂上滤镜
    //    （表现：Safari 上写着 lens、实际没有弯折，还没法归因）。
    var inst = G_LENS_OK ? gMakeGlass(el, opts) : null;
    if (inst) {
      out.push(inst);
      el.setAttribute('data-eg-mode', 'lens');
      el.setAttribute('data-eg-lens-support', 'lens');
    } else {
      el.setAttribute('data-eg-mode', 'frost');
      el.setAttribute('data-eg-lens-support', !G_LENS_PARSE ? 'no-parse'
        : (!G_CAN_REFRACT ? 'no-engine' : (!G_LENS_OK ? 'no-probe' : 'no-map')));
    }
  });
  return out;
}
function mountAll() {
  aInsts.concat(bInsts).forEach(function (i) { if (i.destroy) i.destroy(); });
  aInsts = mount(document.querySelector('.side-a'), OLD);
  bInsts = mount(document.querySelector('.side-b'), cur);
  document.body.dataset.egEngine = (aInsts.length + bInsts.length) ? 'lens' : 'frost';
  applyBlur();   // 首屏也要下发：滑块值就是交付值，右侧不能等拉动了才拿到
  setVars();
  read();
}
function read() {
  var e = document.getElementById('rdEngine');
  e.textContent = document.body.dataset.egEngine || '—';
  e.className = document.body.dataset.egEngine === 'lens' ? 'rd lens' : 'rd';
  var t = document.querySelector('.side-b .topbar');
  var w = t && t.getAttribute('data-eg-lens-support');
  var why = document.getElementById('rdWhy');
  why.textContent = w || '—';
  why.className = w === 'lens' ? 'rd lens' : 'rd';
}

/* 四个滑块只作用于**右侧（优化后）** —— 左侧固定为优化前的取值，
   所以它永远是一条不动的对照基线；拉滑块看的是"在新版基础上还能往哪走"。 */
function setVars() {
  var b = document.querySelector('.side-b');
  var B = BASE[theme()];
  var ka = Number(document.getElementById('sAlpha').value) / 100;
  var ke = Number(document.getElementById('sRim').value) / 100;
  function px(t, k) { return 'rgba(' + t[0] + ', ' + Math.min(.95, t[1] * k).toFixed(3) + ')'; }
  b.style.setProperty('--c-eg-surface', px(B.s, ka));
  b.style.setProperty('--c-eg-surface-2', px(B.s2, ka));
  b.style.setProperty('--c-eg-surface-hero', px(B.hero, ka));
  b.style.setProperty('--c-eg-rim-sharp', px(B.sharp, ke));
  b.style.setProperty('--c-eg-rim-soft', px(B.soft, ke));
  b.style.setProperty('--c-eg-edge', px(B.edge, ke));
}
/* 第 2 档跟着第 1 档按比例走（面板里两个数是 16 / 6 ≈ 0.375），
   这样拉"模糊"时层次比不会塌 —— 层次差才是纵深感的来源。 */
function applyBlur() {
  var b = document.querySelector('.side-b');
  b.style.setProperty('--c-eg-blur-1', cur.blur + 'px');
  b.style.setProperty('--c-eg-blur-2', Math.max(2, Math.round(cur.blur * 0.375)) + 'px');
}
function applyFar() {
  var on = document.getElementById('ckFar').checked;
  document.documentElement.style.setProperty('--c-eg-bg-e', on ? FAR[theme()] : 'transparent');
}
function onSlide() {
  cur.blur = Number(document.getElementById('sBlur').value);
  cur.scale = -Number(document.getElementById('sRefract').value);
  applyBlur();
  setVars();
  document.getElementById('vBlur').textContent = cur.blur + 'px';
  document.getElementById('vRefract').textContent = cur.scale;
  document.getElementById('vAlpha').textContent = document.getElementById('sAlpha').value + '%';
  document.getElementById('vRim').textContent = document.getElementById('sRim').value + '%';
  mountAll();
}

['sBlur', 'sRefract', 'sAlpha', 'sRim'].forEach(function (id) {
  document.getElementById(id).addEventListener('input', onSlide);
});
document.getElementById('ckFar').addEventListener('change', applyFar);
document.getElementById('btnView').addEventListener('click', function () {
  var order = ['both', 'old', 'new'];
  var i = (order.indexOf(document.body.dataset.view || 'both') + 1) % 3;
  document.body.dataset.view = order[i];
  this.textContent = ({ both: '并排 A/B', old: '只看优化前', new: '只看优化后' })[order[i]];
  mountAll();
});
document.getElementById('btnTheme').addEventListener('click', function () {
  var dark = theme() === 'dark';
  document.documentElement.dataset.theme = dark ? 'light' : 'dark';
  this.textContent = dark ? '深色背景' : '浅色背景';
  applyFar();
  mountAll();
});
document.getElementById('btnReset').addEventListener('click', function () {
  document.getElementById('sBlur').value = NEW.blur;
  document.getElementById('sRefract').value = -NEW.scale;
  document.getElementById('sAlpha').value = 100;
  document.getElementById('sRim').value = 100;
  onSlide();
});

initGlass();     // 面板那一条路径（加 eg-on 类 + 环境层）跑一次，证明接线照旧
gDestroyAll();   // 它整页只找到第一侧的候选；拆掉，交给 mountAll 按侧各挂一套
mountAll();
applyFar();
document.getElementById('tip').textContent = G_LENS_OK
  ? '当前浏览器走真折射（lens）：两侧悬浮条背后都有逐帧位移滤镜，边缘会弯折并把背板拉伸。'
  : '当前浏览器不走真折射，已自动转磨砂（frost）。原因看右侧读数：no-engine = 不是 Chromium 内核；'
    + 'no-probe = 值写进去又被丢掉了。材质、噪点、对角高光都还在，只是没有弯折 —— 建议用 Chrome / Edge 打开本页。';
`;

const out = `<!DOCTYPE html>
<html lang="zh-CN" data-theme="light">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>v2 控制台 · 液态玻璃终轮实验室</title>
<style>
${css}
${sideOldCss}
${labCss}
</style>
</head>
<body data-view="both">

<header class="lab-head">
  <h1>液态玻璃 · 终轮优化（第 4 轮 / 收尾）</h1>
  <p><b>总工程进度</b>：本支线把自家液态玻璃效果接进 QQ-BOT-Creative 控制面板。
     第 1–2 轮做参数与边缘（当时的对象是旧面板 <code>panel/parts/</code>）；
     第 3 轮发现<b>旧面板已在 10-02 下线</b>，把实现整体移植进现行界面 v2
     （<code>panel/next/</code>：引擎 <code>glass.js</code> + 样式令牌 + 三档分层）；
     <b>本轮（第 4 轮）只做参数与观感优化</b>——不动结构、不动交互、不引入依赖、不增加滤镜数量。</p>
  <p><b>还欠什么</b>：① 真机面板要看到效果需<b>重启面板进程</b>（玻璃引擎文件已登记进资产名单，
     但名单是进程启动时的快照，现在取不到 → 效果正确地全部不生效）；
     ② <code>panel/next/</code> 整个目录尚未提交；③ 像素验收仍需你在 Chrome / Edge 里过一眼。</p>

  <div class="lab-note">
    <b>怎么读下面这张表</b>：百分比一律是<b>参数幅度</b>（前后取值都在表里，可直接比对、可核对）。
    观感本身<b>不做百分比量化</b> —— 本机没有光度计，"通透性提升 37%"这种数字是编出来的。
    观感给的是这个<b>目视分级</b>（依据＝本页并排 A/B + 本机 Edge 截图对照，属主观估计）：
    通透性 <b>明显</b>（白纱再薄 10%、悬浮条 −20%，并多垫了一层远景）·
    观感 <b>轻微偏明显</b>（噪点、饱和、提亮都是"减负"型改动，方向对但幅度小）·
    边缘 <b>明显</b>（新增 1px 描边令牌压毛刺 + 弯折带加宽，这两条是新增手段不是调数值）·
    整体协调度 <b>轻微</b>（层次比 1.75×→2.67×，方向对但幅度保守）。
  </div>
  <table class="lab-table">
    <tr><th>维度</th><th>改了什么</th><th>前 → 后</th><th>幅度</th><th>为什么这么改（评估依据）</th></tr>
${rowHtml}
  </table>
</header>

<div class="lab-bar">
  <div class="grp"><button class="btn btn-sm" id="btnView">并排 A/B</button></div>
  <div class="grp"><button class="btn btn-sm" id="btnTheme">深色背景</button></div>
  <div class="grp"><label><input type="checkbox" id="ckFar" checked> 远景层</label></div>
  <span class="sep"></span>
  <div class="grp"><label>模糊</label><input type="range" id="sBlur" min="4" max="30" value="${NEW.blur}"><span class="val" id="vBlur">${NEW.blur}px</span></div>
  <div class="grp"><label>折射</label><input type="range" id="sRefract" min="0" max="140" value="${-NEW.scale}"><span class="val" id="vRefract">${NEW.scale}</span></div>
  <div class="grp"><label>透明度</label><input type="range" id="sAlpha" min="40" max="150" value="100"><span class="val" id="vAlpha">100%</span></div>
  <div class="grp"><label>边缘光</label><input type="range" id="sRim" min="0" max="200" value="100"><span class="val" id="vRim">100%</span></div>
  <span class="sep"></span>
  <div class="grp"><button class="btn btn-sm btn-ghost" id="btnReset">复位</button></div>
  <div class="grp"><label>引擎</label><span class="rd" id="rdEngine">—</span></div>
  <div class="grp"><label>原因</label><span class="rd" id="rdWhy">—</span></div>
</div>
<div class="lab-bar2">
  <span id="tip">正在探测…</span>
</div>

<div class="lab-stage">
${sideHtml('优化前')}
${sideHtml('优化后')}
</div>

<footer class="lab-foot">
  四个滑块只作用于<b>右侧（优化后）</b>；左侧固定为优化前的取值（那份取值是从上一轮交付的预览页里抠出来的，不是凭记忆写的），
  所以左侧始终是一条不动的对照基线 —— 拉到底能看出"还能往哪个方向走"，拉回 100% 就是本次交付的取值。
  <br><b>"远景层"这个开关是整页生效的，不是只管右侧</b>：环境层（背后那片色团与网格）是 <code>body::before</code>
  上的一层，铺满视口、A/B 两侧都浮在它上面，按侧关不掉。所以这一项要用开关做"开 / 关"对比，
  而不是左右对比 —— 其余 13 项都可以直接左右比。
  <br>左侧 <code>.topbar</code> / <code>.savebar</code> 上的折射滤镜走的是<b>旧参数</b>（scale −70 / chroma 4 / blur 14），
  右侧走<b>新参数</b>（−85 / 5 / 16）；两侧各一套实例，互不影响。
</footer>

<script>
${engine}
${labJs}
</script>
</body>
</html>
`;

fs.writeFileSync(OUT, out);
console.log('已写出 ' + OUT);
console.log('体积 ' + Buffer.byteLength(out) + ' B · 样式 ' + css.length + ' 字符 · 引擎 ' + engine.length + ' 字符');
