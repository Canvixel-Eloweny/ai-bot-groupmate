
(function () {
  'use strict';

  var boot = document.getElementById('bootSplash');
  var intro = document.getElementById('bootSplashStage');
  var gridVeil = document.getElementById('bootGridVeil');
  if (!boot || !intro) return;
  var reduceMQ = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };

  function detectOS() {
    var data = navigator.userAgentData;
    var plat = (data && data.platform) || navigator.platform || '';
    var ua = navigator.userAgent || '';
    if (/win/i.test(plat) || /windows/i.test(ua)) return 'Windows';
    if (/mac/i.test(plat) || /mac os x/i.test(ua)) return 'macOS';
    return 'your device';
  }
  var detectedName = detectOS();

  var T = {
    run: 0,
    timers: [],
    finished: false,
    gridRAF: 0,
    gridCleanup: null,
    grid: null,
    bootDone: false,
    hideTimer: 0,
    begun: false,
    lowEnd: false
  };

  try {
    T.lowEnd = (navigator.hardwareConcurrency || 8) <= 4 || (navigator.deviceMemory || 8) <= 4;
  } catch (e) { T.lowEnd = false; }
  if (T.lowEnd) document.documentElement.classList.add('bs-lite');

  function preferReduced() {
    return reduceMQ.matches;
  }

  function host() {
    return detectedName || 'your device';
  }

  function clearTimers() {
    T.timers.forEach(function (id) { clearTimeout(id); });
    T.timers = [];
    if (T.gridRAF) {
      cancelAnimationFrame(T.gridRAF);
      T.gridRAF = 0;
    }
    if (T.gridCleanup) {
      try { T.gridCleanup(); } catch (e) { /* ignore */ }
      T.gridCleanup = null;
    }
  }

  function later(fn, ms) {
    var id = setTimeout(fn, ms);
    T.timers.push(id);
    return id;
  }

  function clock() {
    var d = new Date();
    return [d.getHours(), d.getMinutes(), d.getSeconds()].map(function (n) {
      return String(n).padStart(2, '0');
    }).join(':');
  }

  function skipHtml() {
    return '<button class="skip" type="button" data-skip aria-label="跳过开屏" title="跳过（Esc）"><span aria-hidden="true">→</span></button>';
  }

  function cosHtml() {
    if (preferReduced()) return '';
    return '' +
      '<div class="cos" aria-hidden="true">' +
        '<span class="cos-base"></span>' +
        '<span class="cos-orb cos-orb-l"><i></i></span>' +
        '<span class="cos-orb cos-orb-r"><i></i></span>' +
      '</div>';
  }

  function gridHtml() {
    return '' +
      '<canvas class="grid-canvas" id="bootGridCanvas" aria-hidden="true"></canvas>' +
      cosHtml() +
      '<div class="grid-copy" aria-hidden="true">' +
        '<p class="eyebrow"><span class="spark">✦</span> LOCAL AI CONSOLE</p>' +
        '<h1 class="grid-title" aria-label="Welcome to Estrella">' +
          '<span class="grid-line grid-line-1" data-split>Welcome to</span>' +
          '<span class="grid-hero">' +
            '<span class="grid-flip" id="gridFlip">' +
              '<span class="grid-flip-front">' +
                '<span class="grid-line grid-line-2" data-split>Estrella</span>' +
              '</span>' +
              '<span class="grid-flip-back" aria-hidden="true"><span class="grid-flip-word" id="flipHost"></span></span>' +
            '</span>' +
          '</span>' +
        '</h1>' +
        '<p class="grid-tagline"><span class="grid-tag-dot"></span>本机控制台 · 已就绪</p>' +
        '<div class="grid-meta"><span id="gridOs">macOS</span><i></i><span id="gridTime">00:00:00</span></div>' +
      '</div>';
  }

  /* 逐字拆开只为让 line-2 的渐变按字符裁切；入场动画整行做（见 CSS bs-title-line-in），
     不再给单字设延迟 —— 左起逐字会出现"先偏左、再补齐"的错位感。 */
  function splitLine(el) {
    var text = el.textContent;
    el.dataset.text = text;
    el.textContent = '';
    el.setAttribute('aria-hidden', 'true');
    var frag = document.createDocumentFragment();
    Array.from(text).forEach(function (ch) {
      var s = document.createElement('span');
      s.className = 'ch';
      s.textContent = ch === ' ' ? '\u00a0' : ch;
      frag.appendChild(s);
    });
    el.appendChild(frag);
  }

  /* ── 格栅揭示 ─────────────────────────────────────────────────────
     递归把画面一分为二，按面积优先挑块；子块从父块里裂开，缝里露出
     背后的真实面板。切到细密后，块按中心向外淡出，让面板接管。 */
  var GRID = {
    FLIP_START: 2000,
    FLIP_OUT_MS: 150,
    FLIP_IN_MS: 300,
    SPLIT_START: 2000,
    SPLIT_DUR: 1150,
    GROW: 170,
    HOLE_FADE: 220,
    TITLE_FADE: 3280,
    DISSOLVE_START: 3870,
    DISSOLVE_MS: 340,
    END_MS: 4250
  };

  function clamp01(v) { return Math.max(0, Math.min(1, v)); }
  function easeOutCubic(p) { return 1 - Math.pow(1 - p, 3); }
  function smoothstep(p) { p = clamp01(p); return p * p * (3 - 2 * p); }
  function hash01(n) {
    var x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
    return x - Math.floor(x);
  }

  function parseCssColor(v) {
    var m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(v || '').trim());
    if (!m) return { r: 0, g: 0, b: 0 };
    var h = m[1];
    if (h.length === 3) h = h.charAt(0) + h.charAt(0) + h.charAt(1) + h.charAt(1) + h.charAt(2) + h.charAt(2);
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16)
    };
  }

  function readGridTheme() {
    var cs = getComputedStyle(intro || document.documentElement);
    var stops = [0, 1, 2, 3].map(function (i) {
      return parseCssColor(cs.getPropertyValue('--grid-stop-' + i));
    });
    return {
      stops: stops,
      stroke: cs.getPropertyValue('--grid-stroke').trim()
    };
  }

  function cssRgb(c) {
    return 'rgb(' + Math.round(c.r) + ',' + Math.round(c.g) + ',' + Math.round(c.b) + ')';
  }

  function buildGridTree(W, H) {
    var target = T.lowEnd ? 64 : (W < 700 ? 64 : 108);
    var aspect = Math.max(0.2, W / Math.max(1, H));
    var root = {
      id: 0,
      depth: 0,
      rect: { x: 0, y: 0, w: 1, h: 1 },
      splitTime: Infinity,
      children: null
    };
    var leaves = [root];
    var id = 0;
    var splits = target - 1;

    for (var i = 0; i < splits; i++) {
      var best = 0;
      var bestScore = -1;
      for (var j = 0; j < leaves.length; j++) {
        var l = leaves[j];
        var score = l.rect.w * l.rect.h * (1 + 0.26 * hash01(l.id + 3));
        if (score > bestScore) { bestScore = score; best = j; }
      }
      var leaf = leaves.splice(best, 1)[0];
      var vertical = leaf.rect.w * aspect >= leaf.rect.h;
      var ratio = 0.36 + 0.28 * hash01(leaf.id * 5 + 9);
      var a, b;
      if (vertical) {
        a = { x: leaf.rect.x, y: leaf.rect.y, w: leaf.rect.w * ratio, h: leaf.rect.h };
        b = { x: leaf.rect.x + leaf.rect.w * ratio, y: leaf.rect.y, w: leaf.rect.w * (1 - ratio), h: leaf.rect.h };
      } else {
        a = { x: leaf.rect.x, y: leaf.rect.y, w: leaf.rect.w, h: leaf.rect.h * ratio };
        b = { x: leaf.rect.x, y: leaf.rect.y + leaf.rect.h * ratio, w: leaf.rect.w, h: leaf.rect.h * (1 - ratio) };
      }
      var ca = { id: ++id, depth: leaf.depth + 1, rect: a, splitTime: Infinity, children: null };
      var cb = { id: ++id, depth: leaf.depth + 1, rect: b, splitTime: Infinity, children: null };
      leaf.children = [ca, cb];
      leaf.splitTime = GRID.SPLIT_START + (splits <= 1 ? 0 : (i / (splits - 1)) * GRID.SPLIT_DUR);
      leaves.push(ca, cb);
    }
    return root;
  }

  function sizeGridCanvas(canvas) {
    var W = Math.max(1, window.innerWidth);
    var H = Math.max(1, window.innerHeight);
    /* 4K@DPR2 的满尺寸画布是 33MP；开屏格栅只是半透明几何层，按像素预算封顶即可。
       高/低端分别 3.5MP / 1.2MP，文字仍是 HTML，不受影响。 */
    var cap = T.lowEnd ? 1200000 : 3500000;
    var dpr = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(cap / (W * H)));
    dpr = Math.max(0.35, dpr);
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    var ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx: ctx, W: W, H: H, dpr: dpr };
  }

  function frameGradient(ctx, W, H, theme) {
    var grad = ctx.createLinearGradient(0, 0, W, H);
    theme.stops.forEach(function (c, i) {
      grad.addColorStop(i / (theme.stops.length - 1), cssRgb(c));
    });
    return grad;
  }

  function gridTileGeom(node, rect, W, H) {
    var x = rect.x * W;
    var y = rect.y * H;
    var w = rect.w * W;
    var h = rect.h * H;
    var gapMax = (T.grid && T.grid.gap) || 3;
    var gap = Math.min(gapMax, Math.min(w, h) * 0.12);
    var left = x > 0.5 ? gap / 2 : 0;
    var top = y > 0.5 ? gap / 2 : 0;
    var right = (x + w) < W - 0.5 ? gap / 2 : 0;
    var bottom = (y + h) < H - 0.5 ? gap / 2 : 0;
    var rx = x + left;
    var ry = y + top;
    var rw = w - left - right;
    var rh = h - top - bottom;
    if (rw < 1 || rh < 1) return null;
    return {
      rx: rx,
      ry: ry,
      rw: rw,
      rh: rh,
      radius: node.depth === 0 ? 0 : Math.min(10, Math.min(rw, rh) * 0.12)
    };
  }

  function gridTilePath(ctx, node, rect, W, H) {
    var g = gridTileGeom(node, rect, W, H);
    if (!g) return null;
    ctx.beginPath();
    if (g.radius > 0.5 && ctx.roundRect) ctx.roundRect(g.rx, g.ry, g.rw, g.rh, g.radius);
    else ctx.rect(g.rx, g.ry, g.rw, g.rh);
    return g;
  }

  function collectGridLeaves(node, t, rect, out) {
    if (!node.children || t < node.splitTime) {
      out.push({ node: node, rect: rect });
      return;
    }
    var grow = clamp01((t - node.splitTime) / GRID.GROW);
    var e = easeOutCubic(grow);
    for (var i = 0; i < node.children.length; i++) {
      var child = node.children[i];
      var cr = child.rect;
      collectGridLeaves(child, t, {
        x: rect.x + (cr.x - rect.x) * e,
        y: rect.y + (cr.y - rect.y) * e,
        w: rect.w + (cr.w - rect.w) * e,
        h: rect.h + (cr.h - rect.h) * e
      }, out);
    }
  }

  /* 主题框铺满画布，再按叶节点挖出透明洞：主页只在洞里出现，
     洞与洞之间的框保持主题色，不露主页。 */
  function drawGridFrame(ctx, t, theme, leaves, frameAlpha, holeAlpha) {
    var W = T.grid ? T.grid.W : 0;
    var H = T.grid ? T.grid.H : 0;
    if (!W || !H) return;
    ctx.clearRect(0, 0, W, H);
    ctx.globalAlpha = frameAlpha;
    ctx.fillStyle = (T.grid && T.grid.grad) || frameGradient(ctx, W, H, theme);
    ctx.fillRect(0, 0, W, H);
    if (leaves.length && holeAlpha > 0.001) {
      ctx.globalCompositeOperation = 'destination-out';
      ctx.globalAlpha = holeAlpha;
      leaves.forEach(function (leaf) {
        if (gridTilePath(ctx, leaf.node, leaf.rect, W, H)) ctx.fill();
      });
      ctx.globalCompositeOperation = 'source-over';
      if (theme.stroke && !T.lowEnd) {
        ctx.globalAlpha = frameAlpha * holeAlpha;
        ctx.strokeStyle = theme.stroke;
        ctx.lineWidth = 1;
        leaves.forEach(function (leaf) {
          if (gridTilePath(ctx, leaf.node, leaf.rect, W, H)) ctx.stroke();
        });
      }
    }
    ctx.globalAlpha = 1;
  }

  function renderGrid(t) {
    var g = T.grid;
    if (!g) return;
    var p = clamp01((t - GRID.SPLIT_START) / (GRID.SPLIT_DUR + GRID.GROW));
    g.gap = 3 + 6 * smoothstep(p);
    if (g.veil) {
      var op = 1;
      if (t >= GRID.DISSOLVE_START) {
        var d = clamp01((t - GRID.DISSOLVE_START) / GRID.DISSOLVE_MS);
        op = 1 - smoothstep(d);
      }
      g.veil.style.opacity = String(op);
    }
    var frameAlpha = 1;
    if (t >= GRID.DISSOLVE_START) {
      var d2 = clamp01((t - GRID.DISSOLVE_START) / GRID.DISSOLVE_MS);
      frameAlpha = 1 - smoothstep(d2);
    }
    var holeAlpha = 0;
    if (t >= GRID.SPLIT_START) {
      holeAlpha = smoothstep(clamp01((t - GRID.SPLIT_START) / GRID.HOLE_FADE));
    }
    var leaves = [];
    if (holeAlpha > 0.001) {
      collectGridLeaves(g.tree, t, { x: 0, y: 0, w: 1, h: 1 }, leaves);
    }
    drawGridFrame(g.ctx, t, g.theme, leaves, frameAlpha, holeAlpha);
  }

  function renderGridQuiet() {
    var g = T.grid;
    if (!g) return;
    g.gap = 9;
    var leaves = [];
    collectGridLeaves(g.tree, GRID.END_MS, { x: 0, y: 0, w: 1, h: 1 }, leaves);
    drawGridFrame(g.ctx, GRID.END_MS, g.theme, leaves, 1, 1);
  }

  /* 逐字符共享同一张渐变：按字符在整词中的横向位置裁切，
     每个字符自己带渐变，入场时不会出现“先纯色”的中间态。 */
  function paintWordGradient(line) {
    if (!line) return;
    var chars = line.querySelectorAll('.ch');
    if (!chars.length) return;
    var first = chars[0].getBoundingClientRect();
    var last = chars[chars.length - 1].getBoundingClientRect();
    var total = Math.max(1, last.right - first.left);
    chars.forEach(function (ch) {
      var r = ch.getBoundingClientRect();
      ch.style.backgroundSize = total.toFixed(2) + 'px 100%';
      ch.style.backgroundPositionX = (first.left - r.left).toFixed(2) + 'px';
    });
  }

  /* 长主机名只缩字号，不把标题撑出版心；超长名允许缩到 10px 上下，
     并在整个文字块接近视口边缘时再收一档，避免第三行被切。 */
  function fitFlipHost() {
    var copy = intro.querySelector('.grid-copy');
    var word = intro.querySelector('.grid-flip-word');
    if (!copy || !word) return;
    word.style.fontSize = '';
    var cs = getComputedStyle(copy);
    var is = getComputedStyle(intro);
    var baseW = Math.min(980, intro.clientWidth - parseFloat(is.paddingLeft || 0) - parseFloat(is.paddingRight || 0));
    var avail = baseW - parseFloat(cs.paddingLeft || 0) - parseFloat(cs.paddingRight || 0) - 2;
    if (!(avail > 80)) avail = Math.max(80, window.innerWidth - 48);
    avail = Math.min(avail, window.innerWidth - 32);

    function naturalWidth() {
      var range = document.createRange();
      range.selectNodeContents(word);
      var rw = range.getBoundingClientRect().width;
      return Math.max(word.scrollWidth || 0, rw || 0);
    }

    var base = parseFloat(getComputedStyle(word).fontSize) || 40;
    var cur = base;
    for (var i = 0; i < 3; i++) {
      var w = naturalWidth();
      if (w <= avail || cur <= 8) break;
      cur = Math.max(8, cur * avail / w);
      word.style.fontSize = cur.toFixed(2) + 'px';
    }

    var copyRect = copy.getBoundingClientRect();
    var pad = 12;
    if (copyRect.height > window.innerHeight - pad * 2) {
      var scale = Math.max(.55, (window.innerHeight - pad * 2) / copyRect.height);
      cur = Math.max(8, cur * scale);
      word.style.fontSize = cur.toFixed(2) + 'px';
    }
  }

  function buildGrid() {
    var canvas = intro.querySelector('#bootGridCanvas');
    var h = host();
    var flip = intro.querySelector('.grid-flip');
    var titleEl = intro.querySelector('.grid-title');
    var flipHost = intro.querySelector('#flipHost');
    var cosEl = intro.querySelector('.cos');
    var osEl = intro.querySelector('#gridOs');
    var timeEl = intro.querySelector('#gridTime');
    if (osEl) osEl.textContent = detectedName;
    if (timeEl) timeEl.textContent = clock();
    if (flipHost) {
      flipHost.textContent = h;
      flipHost.dataset.text = h;
    }
    if (!canvas) return;

    var sized = sizeGridCanvas(canvas);
    var theme = readGridTheme();
    var start = performance.now();
    var run = T.run;
    T.grid = {
      canvas: canvas,
      veil: gridVeil,
      ctx: sized.ctx,
      W: sized.W,
      H: sized.H,
      tree: buildGridTree(sized.W, sized.H),
      theme: theme,
      grad: frameGradient(sized.ctx, sized.W, sized.H, theme),
      staticDrawn: false
    };
    T.finished = false;

    function syncTitle() {
      paintWordGradient(intro.querySelector('.grid-line-2'));
      fitFlipHost();
    }
    syncTitle();
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(function () {
        if (run === T.run && T.grid) syncTitle();
      });
    }

    function onResize() {
      if (!T.grid || T.grid.canvas !== canvas) return;
      var s2 = sizeGridCanvas(canvas);
      T.grid.ctx = s2.ctx;
      T.grid.W = s2.W;
      T.grid.H = s2.H;
      T.grid.grad = frameGradient(s2.ctx, s2.W, s2.H, T.grid.theme);
      syncTitle();
      renderGrid(performance.now() - start);
    }
    window.addEventListener('resize', onResize);
    T.gridCleanup = function () { window.removeEventListener('resize', onResize); };

    function finishGrid() {
      finishBoot();
    }

    if (preferReduced()) {
      if (flip) flip.classList.add('is-flipping', 'is-flipped');
      if (titleEl) titleEl.setAttribute('aria-label', 'Welcome to ' + h);
      renderGridQuiet();
      later(function () { if (run === T.run) finishBoot(); }, 1600);
      return;
    }

    if (cosEl) {
      later(function () { if (run === T.run) intro.classList.add('is-cos-in'); }, 900);
      later(function () { if (run === T.run) intro.classList.add('is-cos-out'); }, GRID.FLIP_START);
      later(function () {
        if (run !== T.run) return;
        intro.querySelectorAll('.cos-orb').forEach(function (el) { el.style.willChange = 'auto'; });
      }, 1800);
    }

    /* veil 在 canvas 不透明渐变帧下面完全不可见 —— 等 2000ms 真正要挖洞时再启用，
       省掉前 2 秒的全屏 backdrop-filter。 */
    renderGrid(0);
    later(function () {
      if (run !== T.run || !T.grid) return;
      if (gridVeil) {
        gridVeil.hidden = false;
        gridVeil.classList.remove('is-out');
        gridVeil.style.opacity = '1';
      }
      T.gridRAF = requestAnimationFrame(frame);
    }, GRID.SPLIT_START);

    if (flip) {
      later(function () {
        if (run !== T.run) return;
        fitFlipHost();
        flip.classList.add('is-flipping');
        later(function () {
          if (run !== T.run) return;
          fitFlipHost();
          flip.classList.add('is-flipped');
          later(function () {
            if (run !== T.run) return;
            if (titleEl) titleEl.setAttribute('aria-label', 'Welcome to ' + h);
          }, GRID.FLIP_IN_MS);
        }, Math.max(0, GRID.FLIP_OUT_MS - 70));
      }, GRID.FLIP_START);
    }

    later(function () {
      if (run !== T.run) return;
      intro.classList.add('is-title-out');
      /* 从这里开始面板已经能从格栅洞里看见：提前把 23MB 背景视频拉起来（只加载不播），
         否则整层隐藏后还要等首帧，用户会看到"桌面已出现、背景却定住"的空窗。 */
      if (window.__bootGate) window.__bootGate.reveal();
    }, GRID.TITLE_FADE);
    later(function () {
      if (run !== T.run) return;
      intro.classList.add('is-dissolving');
    }, GRID.DISSOLVE_START);
    /* 动画中途卡死（rAF 不回调 / 合成器异常）也要退出：finishBoot 幂等。 */
    later(function () { if (run === T.run) finishBoot(); }, GRID.END_MS + 2000);

    function frame(now) {
      if (run !== T.run || !T.grid) return;
      var t = now - start;
      var splitEnd = GRID.SPLIT_START + GRID.SPLIT_DUR + GRID.GROW;
      if (t >= splitEnd) {
        if (!T.grid.staticDrawn) { renderGrid(splitEnd); T.grid.staticDrawn = true; }
        if (t < GRID.DISSOLVE_START) { T.gridRAF = requestAnimationFrame(frame); return; }
      }
      renderGrid(t);
      if (t < GRID.END_MS) {
        T.gridRAF = requestAnimationFrame(frame);
      } else {
        T.gridRAF = 0;
        finishGrid();
      }
    }
  }

  function onIntroClick() {
    finishBoot();
  }
  function onKeyDown(e) {
    if (e.key === 'Escape') finishBoot();
  }

  function finishBoot() {
    if (T.bootDone) return;
    T.bootDone = true;
    if (T.hideTimer) { clearTimeout(T.hideTimer); T.hideTimer = 0; }
    clearTimers();
    T.grid = null;
    intro.removeEventListener('click', onIntroClick);
    document.removeEventListener('keydown', onKeyDown);
    if (gridVeil) {
      gridVeil.hidden = true;
      gridVeil.classList.remove('is-out');
      gridVeil.style.opacity = '1';
    }
    boot.classList.add('is-out');
    T.hideTimer = setTimeout(function () {
      boot.hidden = true;
      boot.classList.remove('is-out');
      boot.setAttribute('aria-hidden', 'true');
      document.documentElement.classList.remove('boot-on');
      /* 真正的"开屏结束"是整层隐藏之后：重活（视频 / 轮询 / HUD 入场）从这一刻开始。 */
      if (window.__bootGate) window.__bootGate.finish();
      intro.innerHTML = '';
      intro.className = 'intro';
      T.bootDone = false;
      T.hideTimer = 0;
    }, 460);
  }

  function play() {
    T.run++;
    var run = T.run;
    clearTimers();
    T.finished = false;
    T.grid = null;
    intro.className = 'intro';
    intro.innerHTML = '';
    if (gridVeil) {
      gridVeil.hidden = true;
      gridVeil.classList.remove('is-out');
      gridVeil.style.opacity = '1';
    }
    var h = host();
    intro.innerHTML =
      '<p class="sr-only" id="introSr" role="status"></p>' +
      gridHtml() +
      skipHtml();
    var sr = intro.querySelector('#introSr');
    if (sr) sr.textContent = 'Welcome to Estrella. This system: ' + h + '.';
    intro.querySelectorAll('[data-split]').forEach(splitLine);
    buildGrid();
  }

  function start() {
    if (!boot || !intro) return;
    document.documentElement.classList.add('boot-on');
    if (T.hideTimer) { clearTimeout(T.hideTimer); T.hideTimer = 0; }
    T.bootDone = false;
    T.begun = false;
    boot.hidden = false;
    boot.classList.remove('is-out');
    boot.setAttribute('aria-hidden', 'false');
    intro.removeEventListener('click', onIntroClick);
    document.removeEventListener('keydown', onKeyDown);
    intro.addEventListener('click', onIntroClick);
    document.addEventListener('keydown', onKeyDown);
    var gate = window.__bootGate;
    if (gate) gate.started = true;

    var waitPoll = 0;
    function begin() {
      if (T.begun) return;
      T.begun = true;
      if (waitPoll) { clearInterval(waitPoll); waitPoll = 0; }
      if (gate) gate.waiting = false;
      play();
      boot.classList.add('is-ready');
    }
    function waitVisible() {
      /* Electron：从 show:false 到真正可见之间开屏不能先播，否则用户看到的第一帧
         已是中间态。visibilitychange 不受隐藏窗口定时器节流影响，优先挂它；
         再用壳现有的 isWindowVisible 兜底（有些隐藏方式不触发该事件）。 */
      if (document.hidden) {
        var onVis = function () {
          if (document.hidden) return;
          document.removeEventListener('visibilitychange', onVis);
          begin();
        };
        document.addEventListener('visibilitychange', onVis);
      }
      if (window.estrellaShell && typeof window.estrellaShell.isWindowVisible === 'function') {
        waitPoll = setInterval(function () {
          window.estrellaShell.isWindowVisible().then(function (v) {
            if (v) begin();
          }).catch(function () { begin(); });
        }, 400);
        return;
      }
      if (document.hidden) return;
      begin();
    }
    if (gate) gate.waiting = true;
    if (document.hidden || (window.estrellaShell && typeof window.estrellaShell.isWindowVisible === 'function')) waitVisible();
    else begin();
  }

  window.__bootSplash = { start: start, stop: finishBoot };

  if (document.documentElement.classList.contains('boot-on')) {
    try { sessionStorage.setItem('boot-splash-played', '1'); } catch (e) { /* 隐私模式 */ }
    start();
  }
})();