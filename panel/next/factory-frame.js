/**
 * 工厂帧控制器（2026-10-27 · 工厂三页）
 * ══════════════════════════════════════════════════════════════════════
 *   · visual  = 液态玻璃制作工厂（visual-factory.html）
 *   · persona = 人设工厂（persona-factory.html）
 *   · plugin  = 插件工厂（plugin-factory.html）
 *
 * 三份 iframe 常驻、只显隐不重建；切换用 0.22s 上浮淡入。
 * 唯一状态源是 `#page[data-frame]`：app.js 的 paintPage 按当前 schema 子页写入，
 * 本文件只负责把那个 src 映射到帧、预热、显隐；3 秒轮询同值不会重播入场。
 * 顶栏不再有工厂圆钮，入口只在「工厂」的二级导航。
 */

const FRAMES = {
  visual: {
    src: 'visual-factory.html', label: '液态玻璃制作工厂',
    loading: '正在准备液态玻璃制作工厂…', probe: '#app',
  },
  persona: {
    src: 'persona-factory.html', label: '人设工厂',
    loading: '正在准备人设工厂…', probe: '.site-header',
  },
  plugin: {
    src: 'plugin-factory.html', label: '插件工厂',
    loading: '正在准备插件工厂…', probe: '.app',
  },
};
const ORDER = ['visual', 'persona', 'plugin'];
const KEY_OF_SRC = Object.fromEntries(ORDER.map((k) => [FRAMES[k].src, k]));
const $ = (id) => document.getElementById(id);
const body = document.body;

let host = null;
let active = 'visual';
let shownActive = null;
let enterTimer = 0;
let enterCount = 0;
const panes = new Map();

function paneOf(key) {
  let p = panes.get(key);
  if (p) return p;
  const spec = FRAMES[key];
  const wrap = document.createElement('div');
  wrap.className = 'factory-pane';
  wrap.dataset.factory = key;
  wrap.hidden = key !== active;
  const loading = document.createElement('div');
  loading.className = 'factory-loading';
  loading.textContent = spec.loading;
  const frame = document.createElement('iframe');
  frame.className = 'factory-frame';
  frame.dataset.frame = spec.src;
  frame.title = spec.label;
  frame.allow = 'clipboard-write; fullscreen';
  frame.addEventListener('load', () => {
    if (!frame.getAttribute('src')) return;
    /* 光标跟随桥：同源帧把指针坐标/悬停位交给父层，工厂文件保持零改动。
       放在探针检查之前 —— 即使探针缺失，桥仍可工作。 */
    try { window.CursorFollow?.attachFrame?.(frame); } catch { /* 桥不参与加载判定 */ }
    p.loadCount += 1;
    let doc = null;
    try { doc = frame.contentDocument; } catch { /* 跨域就保持未 ready */ }
    if (!doc || !doc.querySelector(spec.probe)) return;
    p.ready = true;
    if (active === key && body.classList.contains('is-frame-page')) {
      body.classList.add('factory-frame-ready');
    }
  });
  wrap.appendChild(loading);
  wrap.appendChild(frame);
  p = { key, spec, wrap, frame, loading, ready: false, warmStarted: false, loadCount: 0 };
  panes.set(key, p);
  if (host) host.appendChild(wrap);
  return p;
}

function build() {
  if (host) return;
  host = document.createElement('div');
  host.className = 'factory-host';
  host.id = 'factoryHost';
  host.setAttribute('aria-hidden', 'true');
  document.body.appendChild(host);
  for (const key of ORDER) paneOf(key);
}

function warm(key) {
  const k = FRAMES[key] ? key : 'visual';
  build();
  const p = paneOf(k);
  if (p.warmStarted) return;
  p.warmStarted = true;
  p.frame.src = './' + p.spec.src;
}

function restartEnter(wrap) {
  wrap.classList.remove('is-enter');
  /* 读一次布局，让同一帧里移除再添加能重新触发动画。 */
  void wrap.offsetWidth;
  wrap.classList.add('is-enter');
  enterCount += 1;
  clearTimeout(enterTimer);
  enterTimer = setTimeout(() => wrap.classList.remove('is-enter'), 260);
}

/* 页面切到哪个 frame，就只显示哪个 pane。
   `shownActive` 是"上一次真正显示过的帧"：轮询重复同步时它不变，入场不会重播。 */
function sync() {
  build();
  const page = $('page');
  const src = page ? (page.dataset.frame || '') : '';
  const key = KEY_OF_SRC[src] || '';
  if (!key) {
    shownActive = null;
    body.classList.remove('factory-frame-ready');
    for (const k of ORDER) paneOf(k).wrap.hidden = true;
    host.setAttribute('aria-hidden', 'true');
    return;
  }
  active = key;
  warm(key);
  const animate = shownActive !== key;
  shownActive = key;
  for (const k of ORDER) paneOf(k).wrap.hidden = k !== key;
  const p = paneOf(key);
  if (animate) restartEnter(p.wrap);
  host.setAttribute('aria-hidden', 'false');
  body.classList.toggle('factory-frame-ready', p.ready);
}

build();
const pageEl = $('page');
if (pageEl) {
  new MutationObserver(sync).observe(pageEl, { attributes: true, attributeFilter: ['data-frame'] });
}
sync();

/* 二级页签悬停/聚焦时预热对应工厂；renderNav2 每次重建子节点，所以委托到 document。 */
function warmFromNav(ev) {
  const b = ev.target && ev.target.closest ? ev.target.closest('#nav2 .sub[data-frame]') : null;
  if (!b) return;
  const key = KEY_OF_SRC[b.dataset.frame];
  if (key) warm(key);
}
document.addEventListener('pointerover', warmFromNav, { passive: true });
document.addEventListener('focusin', warmFromNav);

/* 首屏让给控制台；开屏期间连空闲预热也不做（iframe 加载会抢主线程与网络）。
   整层隐藏后再空闲预热玻璃工厂；人设/插件等到悬停、聚焦或真正切页时再装载。 */
function idleWarm(key, delay) {
  const run = () => warm(key);
  const later = () => {
    if ('requestIdleCallback' in window) requestIdleCallback(run, { timeout: 4000 });
    else setTimeout(run, 400);
  };
  setTimeout(later, delay);
}
function warmFirstFrame() {
  const gate = window.__bootGate;
  if (gate && gate.on && !gate.done && typeof gate.whenDone === 'function') {
    gate.whenDone(() => idleWarm('visual', 300));
  } else {
    idleWarm('visual', 1500);
  }
}
if (document.readyState === 'complete') {
  warmFirstFrame();
} else {
  window.addEventListener('load', warmFirstFrame, { once: true });
}

/* 真实浏览器门禁用：只读状态 + 预热/入场计数（轮询与重开时 loadCount/enterCount 不应增长）。 */
window.__factoryFrame = {
  state: () => {
    const page = $('page');
    const src = page ? (page.dataset.frame || '') : '';
    const p = paneOf(active);
    return {
      active,
      open: !!KEY_OF_SRC[src],
      src,
      ready: p.ready,
      warmStarted: p.warmStarted,
      loadCount: p.loadCount,
      enterCount,
      frames: Object.fromEntries(ORDER.map((k) => {
        const x = paneOf(k);
        return [k, { ready: x.ready, warmStarted: x.warmStarted, loadCount: x.loadCount, src: x.frame.getAttribute('src') || '' }];
      })),
    };
  },
  warm: () => warm(active),
};
