/* ══════════════════════════════════════════════════════════════════════════
   全局光标跟随层（2026-10-28）
   ──────────────────────────────────────────────────────────────────────────
   · 黑点**实时**写真实指针坐标；圆环由弹簧追同一个目标，因此自然落在点后面。
   · 环心到点的距离**硬钳在 MAX_LAG**：甩鼠标时不会拉出一条长尾巴。
   · 停手 IDLE_MS 后缩环；悬停可点元素时只放大，保持黑白（悬停优先于静止）。
   · 一个本地 rAF 推进全部弹簧（先例 liquid-toggle.js）；静止即归还时钟。
     弹簧公式只用 `Motion.springStep`，不在这里抄第二份。
   · 热路径只存数 + 每帧一次写；点没移动时跳过 transform；idle 只保留一个
     自续计时器，不在每次 pointermove 上 clear/set 计时器。
   · 不替换原生光标；`prefers-reduced-motion` 或 coarse pointer 下一个监听都不加。
   · 三个工厂 iframe 是独立 document：由父页面向帧 document 挂同源桥，
     坐标按帧矩形换算后交给同一套环/点，工厂文件零改动。
   · 测试钩子：window.CursorFollow / window.__cursorFollow.state()。
   ────────────────────────────────────────────────────────────────────────── */

(function (global) {
  'use strict';

  var M = global.Motion;
  var document = global.document;
  if (!M || !document) return;

  var root = document.getElementById('cfRoot');
  var ring = root && root.querySelector('.cf-ring');
  var dot = root && root.querySelector('.cf-dot');

  var MAX_LAG = 9;
  var IDLE_MS = 650;
  var IDLE_SCALE = 0.8;
  var MOVE_SCALE = 1;
  var HOVER_SCALE = 1.2;
  var POS_SPRING = { stiffness: 450, damping: 30, mass: 0.5 };
  var SCALE_SPRING = { stiffness: 320, damping: 26, mass: 0.6 };
  var CLICKABLE = 'a[href],button,input,select,textarea,label,summary,'
    + '[role="button"],[role="tab"],[role="switch"],[data-a],[data-go],'
    + '.btn,.grp,.sub,.chip,.sw,.seg label,.isle,.sg-cell[data-go],'
    + '.row[data-a],.ov-cell,.ov-btn,.srt-grip,.set-rail-item,.set-rail-sub-item,'
    + '.set-switch,.set-seg button,.set-font,.set-acc,#cbgDrop';

  var coarse = !!(global.matchMedia && global.matchMedia('(pointer: coarse)').matches);
  var enabled = !M.reducedMotion() && !coarse;

  var dotX = 0;
  var dotY = 0;
  var lastX = 0;
  var lastY = 0;
  var ps = { x: 0, v: 0 };
  var py = { x: 0, v: 0 };
  var psc = { x: IDLE_SCALE, v: 0 };
  var hover = false;
  var idle = true;
  var visible = false;
  var frameActive = false;
  var idleTimer = 0;
  var hideTimer = 0;
  var orphanTimer = 0;
  var rafId = 0;
  var lastT = 0;
  var lastActive = 0;
  var lastDotX = NaN;
  var lastDotY = NaN;
  var scrollAt = 0;
  var seenDocs = typeof WeakSet === 'function' ? new WeakSet() : null;

  function isElement(t) { return !!(t && t.nodeType === 1); }

  function hitTest(t) {
    if (!isElement(t) || !t.closest) return false;
    try { return !!t.closest(CLICKABLE); } catch (e) { return false; }
  }

  function flag(name, on) {
    var v = on ? 'true' : 'false';
    if (root.dataset[name] !== v) root.dataset[name] = v;
  }

  function wantScale() {
    return hover ? HOVER_SCALE : (idle ? IDLE_SCALE : MOVE_SCALE);
  }

  function paint() {
    if (dotX !== lastDotX || dotY !== lastDotY) {
      dot.style.transform = 'translate3d(' + dotX.toFixed(2) + 'px,' + dotY.toFixed(2) + 'px,0)';
      lastDotX = dotX;
      lastDotY = dotY;
    }
    ring.style.transform = 'translate3d(' + ps.x.toFixed(2) + 'px,'
      + py.x.toFixed(2) + 'px,0) scale(' + psc.x.toFixed(4) + ')';
  }

  function cancelOrphan() {
    if (orphanTimer) { clearTimeout(orphanTimer); orphanTimer = 0; }
  }

  function show(x, y) {
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = 0; }
    cancelOrphan();
    if (!visible) {
      visible = true;
      flag('on', true);
      dotX = x;
      dotY = y;
      ps.x = x;
      py.x = y;
      ps.v = 0;
      py.v = 0;
      psc.x = wantScale();
      psc.v = 0;
      lastT = 0;
      paint();
    }
    dotX = x;
    dotY = y;
    lastX = x;
    lastY = y;
  }

  function hide() {
    if (!visible && root.dataset.on !== 'true') return;
    visible = false;
    flag('on', false);
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = 0; }
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = 0; }
    cancelOrphan();
    lastT = 0;
  }

  function hideSoon(ms) {
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(function () { hideTimer = 0; hide(); }, ms || 160);
  }

  function setHover(next) {
    if (hover === next) return;
    hover = next;
    flag('hover', hover);
    kick();
  }

  function refreshHover() {
    var el = document.elementFromPoint && document.elementFromPoint(lastX, lastY);
    setHover(hitTest(el));
  }

  function idleCheck() {
    idleTimer = 0;
    var rest = IDLE_MS - (performance.now() - lastActive);
    if (rest > 16) {
      idleTimer = setTimeout(idleCheck, rest);
      return;
    }
    if (!visible) return;
    /* 页面每 3 秒重建一次：指针不动时元素可能已经换了，收环前重算一次悬停。 */
    refreshHover();
    if (!idle) {
      idle = true;
      flag('idle', true);
      kick();
    }
  }

  function wake() {
    if (idle) {
      idle = false;
      flag('idle', false);
    }
    lastActive = performance.now();
    if (!idleTimer) idleTimer = setTimeout(idleCheck, IDLE_MS);
  }

  function step(now) {
    rafId = 0;
    if (!visible) return;
    var dt = lastT ? Math.min((now - lastT) / 1000, 0.04) : 0.016;
    lastT = now;
    if (dt <= 0) { rafId = requestAnimationFrame(step); return; }

    M.springStep(ps, dotX, POS_SPRING, dt);
    M.springStep(py, dotY, POS_SPRING, dt);

    var dx = ps.x - dotX;
    var dy = py.x - dotY;
    var d = Math.sqrt(dx * dx + dy * dy);
    if (d > MAX_LAG) {
      var k = MAX_LAG / d;
      ps.x = dotX + dx * k;
      py.x = dotY + dy * k;
      ps.v = 0;
      py.v = 0;
    }

    var target = wantScale();
    M.springStep(psc, target, SCALE_SPRING, dt);
    paint();

    var still = Math.abs(ps.x - dotX) < 0.05 && Math.abs(py.x - dotY) < 0.05
      && Math.abs(ps.v) < 0.8 && Math.abs(py.v) < 0.8
      && Math.abs(psc.x - target) < 0.002 && Math.abs(psc.v) < 0.02;
    if (still) {
      ps.x = dotX;
      py.x = dotY;
      ps.v = 0;
      py.v = 0;
      psc.x = target;
      psc.v = 0;
      paint();
      lastT = 0;
      return;
    }
    rafId = requestAnimationFrame(step);
  }

  function kick() {
    if (!enabled || !visible || rafId) return;
    lastT = performance.now();
    rafId = requestAnimationFrame(step);
  }

  function onMove(e) {
    if (e.pointerType === 'touch') return;
    frameActive = false;
    show(e.clientX, e.clientY);
    wake();
    kick();
  }

  function onOver(e) {
    if (e.pointerType === 'touch') return;
    frameActive = false;
    show(e.clientX, e.clientY);
    setHover(hitTest(e.target));
    wake();
    kick();
  }

  function onOut(e) {
    if (e.pointerType === 'touch') return;
    setHover(hitTest(e.relatedTarget));
  }

  function onLeave(e) {
    if (e.relatedTarget) return;
    var under = document.elementFromPoint && document.elementFromPoint(lastX, lastY);
    if (under && under.tagName === 'IFRAME') {
      /* 进入工厂帧：父文档收不到帧内的移动。给桥 200ms 报到，否则先隐藏，
         避免环冻在 iframe 边缘。帧内一动就会取消这个计时。 */
      cancelOrphan();
      orphanTimer = setTimeout(function () {
        orphanTimer = 0;
        if (!frameActive) hide();
      }, 200);
      return;
    }
    hideSoon(160);
  }

  function onScroll() {
    if (!visible) return;
    var now = performance.now();
    if (now - scrollAt < 120) return;
    scrollAt = now;
    refreshHover();
  }

  function onBlur() { hide(); }

  function onVisibility() {
    if (document.hidden) hide();
  }

  function onResize() {
    if (visible) refreshHover();
  }

  function mapFrame(frame, e) {
    var r = frame.getBoundingClientRect();
    /* is-enter 期间 pane 有 translateY + scale(.997)：现读矩形并做比例校正。 */
    var sx = frame.clientWidth ? r.width / frame.clientWidth : 1;
    var sy = frame.clientHeight ? r.height / frame.clientHeight : 1;
    return { x: r.left + e.clientX * sx, y: r.top + e.clientY * sy };
  }

  function attachFrame(frame) {
    if (!enabled || !frame) return;
    var d = null;
    try { d = frame.contentDocument; } catch (e) { return; }
    if (!d || (seenDocs && seenDocs.has(d))) return;
    if (seenDocs) seenDocs.add(d);

    function frameMove(e) {
      if (e.pointerType === 'touch') return;
      var pt = mapFrame(frame, e);
      frameActive = true;
      show(pt.x, pt.y);
      wake();
      kick();
    }

    function frameOver(e) {
      if (e.pointerType === 'touch') return;
      var pt = mapFrame(frame, e);
      frameActive = true;
      show(pt.x, pt.y);
      setHover(hitTest(e.target));
      wake();
      kick();
    }

    function frameOut(e) {
      if (e.pointerType === 'touch') return;
      setHover(hitTest(e.relatedTarget));
    }

    function frameLeave() {
      frameActive = false;
      hideSoon(160);
    }

    /* 捕获阶段：工厂自己的 pointer 处理器即使 stopPropagation 也拦不住桥。 */
    d.addEventListener('pointermove', frameMove, { passive: true, capture: true });
    d.addEventListener('pointerover', frameOver, { passive: true, capture: true });
    d.addEventListener('pointerout', frameOut, { passive: true, capture: true });
    d.addEventListener('pointerleave', frameLeave);
    if (d.documentElement) d.documentElement.addEventListener('pointerleave', frameLeave);
  }

  function state() {
    var dx = ps.x - dotX;
    var dy = py.x - dotY;
    return {
      enabled: enabled,
      x: dotX,
      y: dotY,
      ringX: ps.x,
      ringY: py.x,
      lag: Math.sqrt(dx * dx + dy * dy),
      scale: psc.x,
      hover: hover,
      idle: idle,
      visible: visible,
      raf: !!rafId,
      frameActive: frameActive,
    };
  }

  global.CursorFollow = { attachFrame: attachFrame };
  global.__cursorFollow = { state: state };

  if (!root || !ring || !dot) {
    enabled = false;
    return;
  }
  if (!enabled) return;

  document.addEventListener('pointermove', onMove, { passive: true, capture: true });
  document.addEventListener('pointerover', onOver, { passive: true, capture: true });
  document.addEventListener('pointerout', onOut, { passive: true, capture: true });
  document.documentElement.addEventListener('pointerleave', onLeave);
  document.addEventListener('scroll', onScroll, { passive: true, capture: true });
  document.addEventListener('visibilitychange', onVisibility);
  global.addEventListener('blur', onBlur);
  global.addEventListener('resize', onResize, { passive: true });
})(typeof window !== 'undefined' ? window : globalThis);
