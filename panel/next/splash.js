/* ══════════════════════════════════════════════════════════════════════════
   splash.js · 首屏同步启动层
   ──────────────────────────────────────────────────────────────────────────
   在 <head> 里同步执行（CSP 是 `script-src 'self'`，不能用内联脚本），
   唯一职责：把本地偏好先写到 <html> 上，避免首屏先画默认值再跳一下。

   键名只在这里写一次；app.js / settings.js 通过对应的观察孔读写，
   避免多个文件各存一份会静默漂移的字符串。
   ══════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  var THEME_KEY = 'next-theme';
  var ACCENT_KEY = 'next-accent';
  var FONT_KEY = 'next-font-style';
  var ACCENTS = ['ocean', 'lagoon', 'pine', 'amber', 'coral', 'berry', 'violet'];

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

  applyTheme();
  applyAccent();
  applyFont();

  window.__themeBoot = { key: THEME_KEY, values: ['light', 'dark'], apply: applyTheme };
  window.__accentBoot = { key: ACCENT_KEY, values: ACCENTS.slice(), apply: applyAccent };
  window.__fontBoot = { key: FONT_KEY, values: ['sans', 'serif'], apply: applyFont };
})();
