/* ══════════════════════════════════════════════════════════════════════════
   splash.js · 首屏同步启动层
   ──────────────────────────────────────────────────────────────────────────
   在 <head> 里同步执行（CSP 是 `script-src 'self'`，不能用内联脚本），
   职责：把本地偏好先写到 <html> 上，避免首屏先画默认值再跳一下；
   同时同步决定开屏要不要从首帧就盖住控制台。

   ⚠️ 开屏判定必须在这里做，不能等 app.js/settings.js：那两个模块加起来
   近 500KB，等它们执行完，控制台早就画出来了，开屏再盖上去就是"先闪一下
   控制台"。这里的 `boot-on` 类名是首帧可见性的唯一开关。

   键名只在这里写一次；app.js / settings.js 通过对应的观察孔读写，
   避免多个文件各存一份会静默漂移的字符串。
   ══════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  var THEME_KEY = 'next-theme';
  var ACCENT_KEY = 'next-accent';
  var FONT_KEY = 'next-font-style';
  var SPLASH_KEY = 'next-splash';
  var BG_MODE_KEY = 'qqbot-bg-mode';
  var ACCENTS = ['ocean', 'lagoon', 'pine', 'amber', 'coral', 'berry', 'violet', 'mono', 'graphite'];

  function read(key, allowed, fallback) {
    try {
      var v = localStorage.getItem(key);
      return allowed.indexOf(v) >= 0 ? v : fallback;
    } catch (e) { return fallback; }
  }

  function applyTheme() {
    document.documentElement.setAttribute('data-theme', read(THEME_KEY, ['light', 'dark'], 'light'));
  }
  function applyAccent() {
    document.documentElement.setAttribute('data-accent', read(ACCENT_KEY, ACCENTS, 'ocean'));
  }
  function applyFont() {
    document.documentElement.setAttribute('data-font-style', read(FONT_KEY, ['sans', 'serif'], 'sans'));
  }
  /* 等高线是默认档。首帧就要决定显示哪一层：等 contour-bg.js 执行再切，
     流光用户会先看到一层纯色 / 等高线闪一下。`bg-dark` 也在这里预挂，
     否则夜间主题的首帧是深字压黑底，随后才被脚本翻浅。 */
  function applyBgMode() {
    var mode = read(BG_MODE_KEY, ['contour', 'shader'], 'contour');
    document.documentElement.setAttribute('data-bg-mode', mode);
    document.documentElement.classList.toggle('bg-contour', mode === 'contour');
    if (mode === 'contour') {
      document.documentElement.classList.toggle(
        'bg-dark',
        document.documentElement.getAttribute('data-theme') === 'dark',
      );
    }
  }
  function splashOn() {
    try { return localStorage.getItem(SPLASH_KEY) !== 'off'; } catch (e) { return true; }
  }
  function splashPlayable() {
    try {
      if (localStorage.getItem(SPLASH_KEY) === 'off') return false;
      if (sessionStorage.getItem('boot-splash-played') === '1') return false;
    } catch (e) { /* 隐私模式：照常播放 */ }
    try {
      if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return false;
    } catch (e) { /* 旧浏览器没有 matchMedia */ }
    return true;
  }

  applyTheme();
  applyAccent();
  applyFont();
  applyBgMode();

  var bootOn = splashPlayable();
  document.documentElement.classList.toggle('boot-on', bootOn);
  window.__bootGate = {
    on: bootOn,
    started: false,
    done: !bootOn,
    waiting: false,
    queue: [],
    /** 开屏结束后再跑；没开屏或已经结束则立刻跑。 */
    whenDone: function (fn) {
      if (typeof fn !== 'function') return;
      if (!this.on || this.done) { fn(); return; }
      this.queue.push(fn);
    },
    /** 只由 boot-splash.js 在整层真正隐藏后调用；重复调用无副作用。 */
    finish: function () {
      if (this.done) return;
      this.done = true;
      var q = this.queue;
      this.queue = [];
      for (var i = 0; i < q.length; i++) {
        try { q[i](); } catch (e) { /* 单个延后回调失败不阻断其它 */ }
      }
    },
  };
  if (bootOn) {
    // 兜底：boot-splash.js 没加载/抛错时，别让静态首帧永久盖住控制台。
    // waiting = 脚本还活着、在等窗口真正可见 —— 那种情况不许拆（否则隐藏启动会先露控制台）。
    setTimeout(function () {
      var g = window.__bootGate;
      if (!g || (!g.started && !g.waiting && !g.done)) {
        document.documentElement.classList.remove('boot-on');
      }
    }, 5000);
  }

  window.__themeBoot = { key: THEME_KEY, values: ['light', 'dark'], apply: applyTheme };
  window.__accentBoot = { key: ACCENT_KEY, values: ACCENTS.slice(), apply: applyAccent };
  window.__fontBoot = { key: FONT_KEY, values: ['sans', 'serif'], apply: applyFont };
  window.__splashBoot = { key: SPLASH_KEY, values: ['on', 'off'], on: splashOn };
  window.__bgModeBoot = {
    key: BG_MODE_KEY,
    values: ['contour', 'shader'],
    defaultValue: 'contour',
    apply: applyBgMode,
  };
})();
