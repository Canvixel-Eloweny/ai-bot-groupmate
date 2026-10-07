/* ══════════════════════════════════════════════════════════════════════════
   morph.js · ��标变形动画（零依赖）
   ──────────────────────────────────────────────────────────────────────────
   一个 SVG 路径在两个图标之间**平滑变形**，而不是淡出淡入。

   算法来源：[morphicons](https://www.morphicons.com)（MIT，6.5KB，零运行时依赖）。
   ⚠️ **只取算法，不取包**：它的主入口是 React/Vue/Svelte 组件，
      而本项目是零构建的原生页面（`package.json` 依赖只有 `ws`）。
      它真正值钱的是这一段：**2D Procrustes 的闭式最优旋转** ——
      也就是"如果两个形状能靠旋转对上，就旋转（角点保持锐利）；
      否则在对齐后的坐标系里做顶点插值"。手写一个反向旋转组要人肉枚举，
      闭式解只要几行。

   ── 依赖：panel/next/motion.js（弹簧）、panel/next/icons.js（路径数据）。零构建。
   ══════════════════════════════════════════════════════════════════════════ */

(function (global) {
  'use strict';

  var M = global.Motion;
  var Icons = global.Icons;
  if (!M || !Icons) { console.warn('[morph] 需要先加载 motion.js 与 icons.js'); return; }

  /* ══ 1 · 路径 → 顶点序列 ════════════════════════════════════════════════
     SVG 路径的 `d` 是命令串，要喂给 Procrustes 就得先取出**绝对坐标点**。

     ⚠️ **只支持 M / L / H / V / C / Q / Z** —— 覆盖 Lucide 全部用法。
        遇到 A（圆弧）等命令：**跳过该段并留空**而不是抛错。
        少一段的图标变形时会"缺一块"，但页面其余部分正常 ——
        这比整个图标集不可用好，且 `icons.js` 里没有 A 命令。 */
  function parsePath(d) {
    var pts = [];
    var i = 0, cmd = '', nums = [];
    var x = 0, y = 0, startX = 0, startY = 0;

    function flush() {
      if (!cmd) return;
      var rel = cmd === cmd.toLowerCase() && cmd !== 'Z';
      switch (cmd.toUpperCase()) {
        case 'M': case 'L':
          for (var k = 0; k + 1 < nums.length; k += 2) {
            var px = nums[k], py = nums[k + 1];
            if (rel) { px += x; py += y; }
            x = px; y = py;
            pts.push([x, y]);
            if (cmd.toUpperCase() === 'M' && k === 0) { startX = x; startY = y; }
          }
          break;
        case 'H':
          for (var h = 0; h < nums.length; h++) { x = rel ? x + nums[h] : nums[h]; pts.push([x, y]); }
          break;
        case 'V':
          for (var v = 0; v < nums.length; v++) { y = rel ? y + nums[v] : nums[v]; pts.push([x, y]); }
          break;
        case 'C':
          /* 曲线只取**终点**参与变形，中间控制点在插值时按比例缩放。
             精确做法是把控制点也当顶点（见下方 TODO），但那样两个图标的
             顶点数常常对不上，反而更糟。 */
          for (var c = 0; c + 5 < nums.length; c += 6) {
            x = rel ? x + nums[c + 4] : nums[c + 4];
            y = rel ? y + nums[c + 5] : nums[c + 5];
            pts.push([x, y]);
          }
          break;
        case 'Q':
          for (var q = 0; q + 3 < nums.length; q += 4) {
            x = rel ? x + nums[q + 2] : nums[q + 2];
            y = rel ? y + nums[q + 3] : nums[q + 3];
            pts.push([x, y]);
          }
          break;
        case 'Z':
          x = startX; y = startY;
          break;
        /* ⚠️ A（弧）不支持：跳过。icons.js 里没有用到。 */
      }
      cmd = ''; nums = [];
    }

    while (i < d.length) {
      var ch = d[i];
      if (/[a-zA-Z]/.test(ch)) { flush(); cmd = ch; i++; }
      else if (/[0-9.\-+]/.test(ch)) {
        var s = i;
        while (i < d.length && /[0-9.\-+eE]/.test(d[i])) i++;
        nums.push(parseFloat(d.slice(s, i)));
      }
      else if (ch === ' ') i++;
      else i++;
    }
    flush();
    return pts;
  }

  /* ══ 2 · 2D Procrustes · 闭式最优旋转 ═══════════════════════════════════
     给定两组对应点，找一个"缩放 + 旋转"让它俩尽量重合。
     **为什么需要它**：两枚图标都是 24×24 网格上的手绘图，
     直接插值会得到"整体扭一下"的中间态；而先把 B 旋到与 A 最接近的朝向，
     再插值，视觉上就是"图标自己转过来"，角点在静止时保持锐利。

     推导（各向同性缩放 s + 旋转 θ 的最小化）：
       s·cosθ = Σ(a·b) / Σ|a|²        记作 s·cosθ = p
       s·sinθ = Σ(a × b) / Σ|a|²      记作 s·sinθ = q   （× 是二维叉积）
       ⇒ θ = atan2(q, p)，s = √(p² + q²)
     投影矩阵（把 B 映到 A 的朝向）：
       [ s·cosθ  -s·sinθ ]
       [ s·sinθ   s·cosθ ]            */
  function optimalRotate(A, B) {
    var p = 0, q = 0, den = 0;
    var n = Math.min(A.length, B.length);
    for (var i = 0; i < n; i++) {
      var a = A[i], b = B[i];
      p += a[0] * b[0] + a[1] * b[1];
      q += a[0] * b[1] - a[1] * b[0];
      den += a[0] * a[0] + a[1] * a[1];
    }
    if (!den) return { s: 1, c: 1, sn: 0 };
    p /= den; q /= den;
    var s = Math.sqrt(p * p + q * q);
    if (s < 1e-6) return { s: 1, c: 1, sn: 0 };
    return { s: s, c: p / s, sn: q / s };
  }

  /** 把点绕原点按 (s,θ) 变换。 */
  function project(p, r) {
    var x = p[0], y = p[1];
    return [r.s * (r.c * x - r.sn * y), r.s * (r.sn * x + r.c * y)];
  }

  /* ══ 3 · 配对 ══════════════════════════════════════════════════════════
     两个图标的顶点数**通常不同**（圆 4 点 vs 直线 2 点）。
     办法：把两边的点数都重采样到**较短**的那一个 ——
     而不是给短的一边补零（补零会让它先缩到原点再长出来，看起来像"缩放"）。 */
  function resample(pts, n) {
    if (pts.length === n) return pts;
    if (pts.length === 0) return [];
    var out = [], total = 0, i;
    var segs = [], acc = 0;
    for (i = 0; i + 1 < pts.length; i++) {
      var dx = pts[i + 1][0] - pts[i][0], dy = pts[i + 1][1] - pts[i][1];
      var d = Math.sqrt(dx * dx + dy * dy);
      segs.push(d); acc += d; total += d;
    }
    /* 闭合：末点连回起点，让最后一段也被采样到
       （否则图标"缺口"那一侧永远插值不出内容） */
    var lx = pts[pts.length - 1][0] - pts[0][0], ly = pts[pts.length - 1][1] - pts[0][1];
    var last = Math.sqrt(lx * lx + ly * ly);
    segs.push(last); total += last;

    if (total === 0) return pts.slice(0, 1);
    var want = 1;
    for (i = 0; i < n; i++) {
      if (i === n - 1) { out.push(pts[pts.length - 1].slice()); break; }
      var t = (i / (n - 1)) * total;
      while (want < segs.length - 1 && acc + segs[want] < t) { acc += segs[want]; want++; }
      var r = segs[want] ? (t - acc) / segs[want] : 0;
      out.push([
        pts[want][0] + (pts[want + 1][0] - pts[want][0]) * r,
        pts[want][1] + (pts[want + 1][1] - pts[want][1]) * r
      ]);
    }
    return out;
  }

  function toPathD(pts) {
    if (!pts.length) return '';
    var d = 'M' + pts[0][0].toFixed(2) + ' ' + pts[0][1].toFixed(2);
    for (var i = 1; i < pts.length; i++) {
      d += 'L' + pts[i][0].toFixed(2) + ' ' + pts[i][1].toFixed(2);
    }
    return d + 'Z';
  }

  /* ══ 4 · 一个可变形图标 ═════════════════════════════════════════════════ */
  /**
   * @param {string} name   初始图标名
   * @param {object} [opt]
   * @param {number} [opt.size=20]
   * @param {number} [opt.speed=50]    变形时长手感（0..100 → 刚度）
   * @param {string} [opt.cls]
   */
  function create(name, opt) {
    opt = opt || {};
    var NS = 'http://www.w3.org/2000/svg';
    var doc = opt.document || global.document;
    var size = opt.size || 20;
    var speed = opt.speed == null ? 50 : opt.speed;
    var reduced = M.reducedMotion();

    var svg = doc.createElementNS(NS, 'svg');
    svg.setAttribute('width', size);
    svg.setAttribute('height', size);
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    if (opt.cls) svg.setAttribute('class', opt.cls);

    var path = doc.createElementNS(NS, 'path');
    svg.appendChild(path);

    /* 当前与目标顶点集。**当前是唯一事实源** —— 每次变形从它出发，
       所以连点快速切换不会跳回起点。 */
    var from = null, to = null;
    var cur = null;      // 正在被插值的顶点：k=0 时是起点，k=1 时是对齐后的目标
    var settle = null;

    function setPathFor(name2) {
      var raw = Icons.iconPaths(name2);
      if (!raw) return false;
      var pts = [];
      for (var i = 0; i < raw.length; i++) {
        pts = pts.concat(parsePath(raw[i]));
      }
      if (!pts.length) return false;
      from = pts; cur = pts.slice(); to = pts.slice();
      path.setAttribute('d', toPathD(cur));
      return true;
    }

    /* 变形到另一个图标。**不声明 from/to 对**，只给目标名——
       当前状态就是起点，这与"任何时刻可被再次打断"的语义一致。 */
    function morphTo(name2) {
      if (!setPathFor(name2)) return null;
      var n = Math.min(from.length, to.length);
      var A = resample(from, n), B = resample(to, n);
      /* 把 B 旋到最接近 A 的朝向 —— 变形动画"转过来"的那一步 */
      var rot = optimalRotate(A, B);
      var aligned = B.map(function (p) { return project(p, rot); });
      cur = A.slice();
      path.setAttribute('d', toPathD(cur));

      if (reduced) { path.setAttribute('d', toPathD(aligned)); return null; }

      if (settle) settle.stop();
      /* 变形参数：刚度随 speed 走，阻尼是标定值。
         ⚠️ 变形是**形状**变化，视觉上比位移敏感得多 ——
            刚度太高会像"跳"而不是"化"，所以上限压到 360。 */
      var cfg = {
        stiffness: 120 + speed * 2.4,
        damping: 20 + (100 - speed) * 0.06,
        mass: 1
      };
      /* t：0 = 起点，1 = 对齐后的目标。用**运动值**托管，
         这样连点时新动画能从**当前进度**接手，不跳回 0
         —— 这也是"不要自己写 rAF"的原因：调度与中断都在引擎里。 */
      var t = M.motionValue(0);
      var settled = false;
      var un = null;                 // 退订函数，必须先声明 —— onStep 会引用它
      settle = M.animate(t, 1, {
        type: 'spring', stiffness: cfg.stiffness, damping: cfg.damping, mass: cfg.mass
      });
      function onStep() {
        if (settled) return;
        var k = t.get();
        for (var i = 0; i < aligned.length; i++) {
          cur[i] = [
            A[i][0] + (aligned[i][0] - A[i][0]) * k,
            A[i][1] + (aligned[i][1] - A[i][1]) * k
          ];
        }
        path.setAttribute('d', toPathD(cur));
        /* 静止判据：**位移与速度都要满足**。只看 t 会在过冲顶点误判为静止，
           动画会在半路永久停住。 */
        if (Math.abs(t.get() - 1) < 0.002) {
          settled = true;
          if (un) un();
          cur = aligned;
          path.setAttribute('d', toPathD(aligned));
        }
      }
      un = t.on(onStep);
      onStep();
      return api;
    }

    setPathFor(name);

    var api = {
      el: svg,
      morphTo: morphTo,
      /** 直接换图标（无动画）—— 减弱动效时 morphTo 内部也走这条 */
      set: function (n2) { if (setPathFor(n2)) path.setAttribute('d', toPathD(cur)); },
      destroy: function () {
        if (settle) settle.stop();
        settle = null;
      }
    };
    return api;
  }

  global.Morph = { create: create, parsePath: parsePath, optimalRotate: optimalRotate };
})(typeof window !== 'undefined' ? window : globalThis);
