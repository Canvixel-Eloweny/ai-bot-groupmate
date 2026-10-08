/* ══════════════════════════════════════════════════════════════════════════
   liquid-toggle.js · 液态开关（双 blob metaball）
   ──────────────────────────────────────────────────────────────────────────
   方法论来源：bencho.dev「Liquid toggle」。原配方基于 framer-motion + React，
   本文件把它落到面板的零构建环境：改用 `motion.js`（同目录），
   **参数与手感刻意保持一致**，所以从Bencho 抄其它配方时也能原样搬。

   ── 这个组件演示的四条判据（Bencho 注释里最有价值的部分）──────────────

   ① **一个位置，两种写法**（ONE POSITION, WRITTEN TWO WAYS）
      滑块 x 是一个运动值。拖拽时手指直接 set（硬写、跟手），松手时弹簧接管。
      两者写同一个格子，互不通知，也**不触发重渲染**。
      位置若是组件 state，拖拽必然重渲染，手感立刻垮。

   ② **拖尾是弹簧跟随，不是延迟**
      后面那个小液滴是「**弹簧追着主滑块当前值跑**」，不是「和主滑块同一个目标 + 延迟」。
      这个区别是整个组件的灵魂：
        · 延迟 —— 描述的是"点击"，液滴迟一步出发，落到滑块早已离开的地方；
        · 弹簧 —— 永远在追"滑块此刻在哪"，所以**拖得慢两团始终是一个形状，
          甩得快才在后面拉出细颈**。拖尾的拉伸量恰好等于你的移动速度。
      ⚠️ 这是"延迟 vs 弹簧"最值得记住的一次判例：同样的视觉（后面拖一个），
        两种底层机制的体感天差地别。

   ③ **拉伸 ≠ 拖尾**（面积守恒）
      液体感来自"**这个东西自己在变形**"，不是"身后有个东西"。
      液滴沿运动方向拉长、垂直方向压扁，且 scaleY = 1/scaleX **面积守恒**。
      不守恒就是"鼓起来了 / 变胖了"，一眼假。

   ④ **goo 滤镜层上的东西必须不透明**
      feColorMatrix 对**alpha 做阈值**。半透明填充经过它 = 直接消失。
      而且抗锯齿的字会被同一道阈值吃掉。所以：
        · 承载滤镜的一层：只有**不透明**的纯色块，可合并；
        · 文字 / 描边 / 命中区：另起一层**不带滤镜**，架在上面。
      两层几何完全一致，所以描边可以"免费"描出下面那团的轮廓。

   ── 依赖：panel/next/motion.js（全局 window.Motion）。零构建，不引包。
   ══════════════════════════════════════════════════════════════════════════ */

(function (global) {
  'use strict';

  var M = global.Motion;
  if (!M) { console.warn('[liquid-toggle] 需要先加载 motion.js'); return; }

  /* ══ 几何档位 ══════════════════════════════════════════════════════════
     ⚠️ 一条纪律：滑块尺寸**只在 JS 里定义一次**。
        圆的直径和它要走的距离必须来自同一个数 ——
        写成两份（CSS 一份、JS 一份）就是「两份必须相等的数字」，
        而两份必须相等的数字，多一份就多一个能悄悄对不上的机会。
        尺寸通过 CSS 变量 `--liq-thumb` 交给样式表。

     ── 为什么是「档位」而不是单个常量（2026-10-02 接产品页时改的）──────
     最初只有一个 92×46 的卡片尺寸。控制台的 `.sw .track` 是 **40×22**，
     硬塞会撑破行高；而在 CSS 里写小一号的值又会让 JS 的旅行距离算错
     （液滴走 46px 却按 18px 算 ⇒ 滑块飞出轨道）。

     所以几何是**一个档位表**，每档自带 (轨道/液滴/留白/拖尾比/模糊) ——
     **模糊半径必须跟着尺寸走**：40px 的轨道上用 7px 的模糊会把两团糊成一片，
     这是 goo 效果最常见的失效原因。**换档时这几个数是一套的，别单改一个。 */
  var SIZES = {
    /* 卡片尺寸：给实验��页与将来的大控件 */
    card: { track: 92, thumb: 36, pad: 5, chase: 0.66, blur: 7, minify: 1 },
    /* 控制台档：`.sw` 是 40×22。液滴 15 → 拖尾 10.8，
       模糊降到 2.6（≈ 15px 液滴的 1/6，与 36px 配 7px 同比例）。 */
    mini: { track: 40, thumb: 15, pad: 3.5, chase: 0.72, blur: 2.6, minify: 1 }
  };
  var DEFAULT_SIZE = 'card';

  /* 拖尾的尺寸比例。拖尾**必须**比主液滴小 ——
     两者等大时中间不会收细，就是两个圆而不是一腰胶囊。
     实际值走档位（SIZES[x].chase），这里只保留默认档的说明。 */
  /* 拖尾弹簧。**比主滑块的落位弹簧更紧**（这是"拖尾"而非"跟随抖动"的来源）：
     追得慢 = 拖得更长 = 快速甩动时拉成一条线（那就是"轨迹"了，不是液体）。 */
  var CHASE = { stiffness: 520, damping: 34, mass: 0.6 };

  var REDUCED = M.reducedMotion();

  /* ══ goo 滤镜 ═══════════════════════════════════════════════════════════
     feGaussianBlur 抹开 → feColorMatrix 对 alpha 做硬阈值 → 重切出实心团。
     两个数是全部调参空间：
       stdDeviation  糊多少。越大越"融"，但过大会让小液滴整个消失
                     （糊掉的 alpha 峰值撑不到阈值线）。
       末行的 K 与偏置把 alpha 拉回硬边界。K 越大对比越强（边缘越硬），
                     偏置决定"多大 alpha 算实心"。

     ⚠️ **模糊半径必须跟着尺寸走**：小液滴糊过之后峰值 alpha 会掉，
        掉到阈值以下就**整个消失**。所以滤镜**按 stdDeviation 分档缓存**，
        不同尺寸各有一个 —— 共用一个会在换档时静默失效。 */
  var gooCache = {};   // stdDeviation → filterId
  function ensureGooFilter(doc, sd) {
    var key = String(sd);
    if (gooCache[key] && doc.getElementById(gooCache[key])) return gooCache[key];
    var filterId = 'liq-goo-' + key.replace('.', '_');
    var NS = 'http://www.w3.org/2000/svg';
    var svg = doc.createElementNS(NS, 'svg');
    svg.setAttribute('width', '0');
    svg.setAttribute('height', '0');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    /* position:absolute 而不是 display:none ——
       某些浏览器对 display:none 的 SVG 子树不建滤镜图，滤镜会静默失效。 */
    svg.style.position = 'absolute';
    svg.style.pointerEvents = 'none';
    svg.style.left = '0';
    svg.style.top = '0';

    var defs = doc.createElementNS(NS, 'defs');
    var filter = doc.createElementNS(NS, 'filter');
    filter.setAttribute('id', filterId);
    filter.setAttribute('x', '-50%');
    filter.setAttribute('y', '-50%');
    filter.setAttribute('width', '200%');
    filter.setAttribute('height', '200%');
    /* sRGB：不写的话浏览器会用 linearRGB 做颜色插值，
       实心块的颜色会偏 —— 这是"同样的值看起来不一样"的常见原因。 */
    filter.setAttribute('color-interpolation-filters', 'sRGB');

    var blur = doc.createElementNS(NS, 'feGaussianBlur');
    blur.setAttribute('in', 'SourceGraphic');
    blur.setAttribute('stdDeviation', String(sd));
    blur.setAttribute('result', 'smear');

    var matrix = doc.createElementNS(NS, 'feColorMatrix');
    matrix.setAttribute('in', 'smear');
    matrix.setAttribute('type', 'matrix');
    /* 末行 "0 0 0 K B"：alpha' = K·alpha + B。K=20 B=-10 → alpha 0.5 处切齐 */
    matrix.setAttribute('values', '1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 20 -10');

    filter.appendChild(blur);
    filter.appendChild(matrix);
    defs.appendChild(filter);
    svg.appendChild(defs);
    doc.body.appendChild(svg);
    gooCache[key] = filterId;
    return filterId;
  }

  /* ══ 组件 ══════════════════════════════════════════════════════════════ */
  /**
   * @param {object} opts
   * @param {number} opts.stretch 0..100  液滴沿运动方向的拉长程度（Bencho 的 Stretch）
   * @param {number} opts.speed   0..100  滑块穿越速度（Bencho 的 Speed）
   * @param {boolean} opts.on     初始状态
   * @param {Function} opts.onChange 状态变化回调
   * @param {string}  opts.label  无障碍标签
   */
  function create(opts) {
    opts = opts || {};
    var doc = opts.document || global.document;
    var stretchKnob = M.clamp(opts.stretch == null ? 36 : opts.stretch, 0, 100);
    var speedKnob = M.clamp(opts.speed == null ? 50 : opts.speed, 0, 100);

    /* ── 取档位 ──
       ⚠️ 几何全部从档位读，**不再有任何模块级常量**参与计算。
          早期版本用模块级 TRACK/THUMB/PAD，CSS 改小了就与JS 的旅行距离脱节
          （液滴走46px 但按 18px 算 ⇒ 滑块飞出轨道）。 */
    var sizeKey = opts.size && SIZES[opts.size] ? opts.size : DEFAULT_SIZE;
    var S = SIZES[sizeKey];
    var TRACK = S.track, THUMB = S.thumb, PAD = S.pad, CHASE_RATIO = S.chase;
    var SHUT_X = PAD;                          // 关态位置
    var OPEN_X = TRACK - THUMB - PAD;          // 开态位置
    var MID_X = (SHUT_X + OPEN_X) / 2;

    var filterId = ensureGooFilter(doc, S.blur);

    /* ── 状态 ── */
    var on = !!opts.on;
    var held = false;      // 被按住：落位弹簧必须让位，别跟手指抢
    var hot = false;       // 悬停：驱动那一记轻微鼓胀
    var grab = null;       // { id, grabX, moved }

    /* ── DOM ──
       结构上刻意分三层，对应判据④：
         .liq-track       轨道，承载状态配色
         .liq-goo-layer   **带滤镜**，只有不透明色块 → 这一层负责"融"
         .liq-ink-layer   **不带滤镜**，将来放描边/文字
    */
    var root = doc.createElement('div');
    root.className = 'liq-toggle' + (sizeKey === 'card' ? '' : ' ' + sizeKey);
    root.setAttribute('data-size', sizeKey);

    var track = doc.createElement('button');
    track.type = 'button';
    track.className = 'liq-track';
    track.setAttribute('role', 'switch');
    track.setAttribute('aria-checked', String(on));
    track.setAttribute('aria-label', opts.label || 'Liquid toggle');
    /* 这是一条可沿轨道推的滑块，不是只有点击的按钮 */
    track.style.touchAction = 'none';

    var gooLayer = doc.createElement('span');
    gooLayer.className = 'liq-goo-layer';
    gooLayer.setAttribute('aria-hidden', 'true');
    gooLayer.style.filter = 'url(#' + filterId + ')';

    var thumb = doc.createElement('span');
    thumb.className = 'liq-blob liq-blob-main';
    gooLayer.appendChild(thumb);

    var chase = doc.createElement('span');
    chase.className = 'liq-blob liq-blob-chase';
    chase.style.width = THUMB * CHASE_RATIO + 'px';
    chase.style.height = THUMB * CHASE_RATIO + 'px';
    chase.style.marginTop = (-THUMB * CHASE_RATIO / 2) + 'px';
    gooLayer.appendChild(chase);

    var inkLayer = doc.createElement('span');
    inkLayer.className = 'liq-ink-layer';
    inkLayer.setAttribute('aria-hidden', 'true');

    track.appendChild(gooLayer);
    track.appendChild(inkLayer);
    root.appendChild(track);

    /* ── 运动值 ── */
    var x = M.motionValue(on ? OPEN_X : SHUT_X);
    /* 拖尾弹簧：独立跟随 x。它自己是一个被 spring 驱动的运动值。 */
    var chaseX = M.motionValue(x.get());
    var chaseSpring = null;   // 每帧推进的弹簧状态

    /* ── 速度驱动的形变 ──
       拉伸量 = f(|速度|)。速度本身经一个弹簧平滑，
       否则原始速度是帧间差分，抖动会让液滴持续抽搐。 */
    var vel = M.motionValue(0);
    var eased = M.motionValue(0);
    var easedSpring = { x: 0, v: 0 };

    /* 悬停鼓胀的平滑量。与拉伸**乘进同一个 transform**（判据：不能各走CSS 属性） */
    var swell = M.motionValue(1);
    var swellSpring = { x: 1, v: 0 };

    /* Bencho 注释里的那条关键数字：
       「除数就是全部调参空间」。44px 行程峰值约 150px/s，
       除以 1400 时峰值拉伸只有 1.039 —— 算术上存在，视觉上不可见。
       除以 600 → 峰值约 1.09，才是"恰好能看出来的弹性"，
       且 0.4 的上限给旋钮留出余量。 */
    var VELOCITY_DIVISOR = 600;
    var STRETCH_CAP = 0.4;
    function lengthen() {
      return 1 + Math.min(STRETCH_CAP, Math.abs(eased.get()) / VELOCITY_DIVISOR)
                  * (stretchKnob / 100);
    }

    function applyTransform() {
      var len = lengthen();
      /* 面积守恒：长多少就窄多少，两者的乘积恒为 1 */
      thumb.style.transform =
        'translateX(' + x.get().toFixed(2) + 'px) scaleX(' + (len * swell.get()).toFixed(4) + ')'
        + ' scaleY(' + (swell.get() / len).toFixed(4) + ')';
      chase.style.transform =
        'translateX(' + chaseX.get().toFixed(2) + 'px)';
    }

    /* ── 每帧推进三个弹簧 ──
       ⚠️ 不能各起一个 rAF（见 motion.js 的调度器注释）。
          这里一个 rAF 推进全部，与 engine 共用同一帧时钟。 */
    var rafId = 0;
    var lastT = 0;
    function step(now) {
      var dt = Math.min((now - lastT) / 1000, 0.04);
      lastT = now;
      if (dt <= 0) { rafId = requestAnimationFrame(step); return; }

      /* 拖尾追主滑块。**无论主滑块是被拖着还是被弹簧弹着**，
         拖尾都只认"x 此刻的值"—— 这就是判据②。
         ⚠️ 用 `M.springStep`（唯一那份公式）而不是本地副本：
         需要自己控制时钟 ≠ 需要自己实现公式。抄一份就多一个能悄悄对不上的机会。 */
      if (chaseSpring) {
        M.springStep(chaseSpring, x.get(), CHASE, dt);
        chaseX.set(chaseSpring.x);
      } else {
        chaseX.jump(x.get());
      }

      /* 速度平滑 → 拉伸量 */
      vel.set(x.velocity());
      M.springStep(easedSpring, vel.get(), { stiffness: 320, damping: 40, mass: 0.6 }, dt);
      eased.jump(easedSpring.x);

      /* 悬停鼓胀平滑 */
      M.springStep(swellSpring, hot ? 1.035 : 1, { stiffness: 520, damping: 34, mass: 0.6 }, dt);
      swell.jump(swellSpring.x);

      applyTransform();

      /* 静止判据：三个弹簧都到位且速度都低，才停帧。
         ⚠️ 少判任何一个都会看到「松手后还抖两下」。 */
      var still =
        !held &&
        Math.abs(x.get() - (on ? OPEN_X : SHUT_X)) < 0.05 &&
        Math.abs(x.velocity()) < 0.1 &&
        Math.abs(chaseSpring ? chaseSpring.v : 0) < 0.1 &&
        Math.abs(easedSpring.v) < 0.5 &&
        Math.abs(swellSpring.v) < 0.002;

      if (still) {
        rafId = 0;
        x.jump(on ? OPEN_X : SHUT_X);
        chaseX.jump(x.get());
        eased.jump(0);
        applyTransform();
        return;
      }
      rafId = requestAnimationFrame(step);
    }

    function kick() {
      if (!rafId) { lastT = performance.now(); rafId = requestAnimationFrame(step); }
    }

    /* ── 落位弹簧 ──
       Bencho：**Bounce 是阻尼，Speed 是刚度**，两个拨盘都是**同一个弹簧的属性**，
       不是两条不同的曲线。
       damping 写死（21.5，ζ≈0.87）：开关不该有"回弹旋钮"——
       从死板到活泼的整个范围，区别只在"一个能用的控件"和"一个在表演的控件"之间，
       21.5 就是答案。Speed 仍可调，因为"多快"是个真问题。 */
    function settleConfig() {
      return { stiffness: 170 - (50 - speedKnob) * 1.1, damping: 21.5, mass: 0.9 };
    }
    var settle = null;

    function startSettle() {
      if (settle) settle.stop();
      var target = on ? OPEN_X : SHUT_X;
      if (REDUCED) { x.jump(target); applyTransform(); return; }
      settle = M.animate(x, target, settleConfig());
      kick();
    }

    /* ── 交互 ── */
    function setOn(next, fromUser) {
      next = !!next;
      if (next === on) return;
      on = next;
      track.setAttribute('aria-checked', String(on));
      root.setAttribute('data-on', String(on));
      if (!held) startSettle();
      else kick();
      if (fromUser && typeof opts.onChange === 'function') opts.onChange(on);
    }

    function onDown(e) {
      if (e.button != null && e.button !== 0) return;
      grab = { id: e.pointerId, grabX: null, moved: false };
      held = true;
      kick();
      /* setPointerCapture 会**抛**——指针已经不在了（测试里的合成事件、
        真实场景里指针已离开页面）就是这个。
        try/catch 是必须的：捕获失败不该让整个拖拽失效。 */
      try { track.setPointerCapture(e.pointerId); } catch (err) { /* 非活动指针 */ }
    }

    function onMove(e) {
      if (!grab || grab.id !== e.pointerId) return;
      var at = M.localX(track, e.clientX);
      /* ⚠️ 抓取偏移在**第一次 move** 才取，不在 down 里取。这是 Bencho 修掉的一个真 bug：
         原本在 down 里取，命中滑块外时偏移取"半颗滑块宽"、意图是"液滴主动靠到手指下"，
         但 x.set() 是无弹簧的硬写 → 首次 pointermove 一步之内把液滴挪 46px（瞬移）。
         改成第一次 move 取偏移后，**那次 move 位移为 0**，之后每一步只跟增量 ——
         于是拖拽永远从液滴真实所在处开始，这个控件上**任何一处**按下都不可能跳。 */
      if (grab.grabX === null) grab.grabX = at - x.get();
      var next = M.clamp(at - grab.grabX, SHUT_X, OPEN_X);
      if (Math.abs(next - x.get()) > 0.4) grab.moved = true;
      x.set(next);
      /* 越过中线就翻转状态 —— 让轨道在**手指底下**就给出回应，
         而不是等松手。这是"跟手"和"响应"的分界。 */
      setOn(next > MID_X, true);
      kick();
    }

    function onUp(e) {
      if (!grab) return;
      var wasClick = !grab.moved;
      grab = null;
      /* releasePointerCapture 同样会抛：指针若从未被成功捕获（down 里的捕获失败了）
         这里必然抛。而不catch 的话它会在 setOn **之前**抛出去，
         于是 held 永远为 true —— 落位弹簧被 held 拆掉，液滴停在拖拽处再也不落位。
         ⚠️ "held 永不松开"的表现是"开关卡住了"，但根因在一次未捕获的异常里。 */
      try { track.releasePointerCapture(e.pointerId); } catch (err) { /* 从未捕获 */ }
      /* 没移动过的按下 = 点击，点击必须切换 —— 开关还得是个开关 */
      if (wasClick) setOn(!on, true);
      held = false;
      startSettle();
    }

    function onKeyDown(e) {
      if (e.key !== ' ' && e.key !== 'Enter') return;
      e.preventDefault();
      setOn(!on, true);
    }

    track.addEventListener('pointerdown', onDown);
    track.addEventListener('pointermove', onMove);
    track.addEventListener('pointerup', onUp);
    track.addEventListener('pointercancel', onUp);
    track.addEventListener('keydown', onKeyDown);
    track.addEventListener('pointerenter', function () { hot = true; kick(); });
    track.addEventListener('pointerleave', function () { hot = false; kick(); });

    /* 键盘焦点也要有可见反馈 */
    track.addEventListener('focus', function () { root.setAttribute('data-focus', '1'); });
    track.addEventListener('blur', function () { root.removeAttribute('data-focus'); });

    /* ── 初始态 ── */
    root.setAttribute('data-on', String(on));
    root.style.setProperty('--liq-thumb', THUMB + 'px');
    applyTransform();
    if (!REDUCED) { chaseSpring = { x: x.get(), v: 0 }; kick(); }

    return {
      el: root,
      /** 外部改状态，**当作"用户操作"**（会触发 onChange）。 */
      set: function (v) { setOn(v, true); },
      /** 外部改状态，**当作"镜像/同步"**（不触发 onChange）。
       *
       *  ⚠️ 这两个必须分开，且这个是接入界面层的**唯一正确选择**：
       *  装饰层订阅的是原生 checkbox 的 change，它只是**跟随**，不是用户操作。
       *  用 `set()` 会在同步时反过来触发 onChange ⇒ 如果调用方把 onChange
       * 接到"保存"上，就会变成"读一次状态写一次配置"的回环。
       *  （`setOn` 里有 `if (next === on) return` 挡了同值重入，
       *    但**回环风险不该靠那个早退来兜** —— 语义上它就是一次用户操作。） */
      sync: function (v) { setOn(v, false); },
      get: function () { return on; },
      /** 实时改旋钮，不重挂组件 —— 对应 Bencho 右侧那个面板 */
      setKnobs: function (k) {
        if (k && k.stretch != null) stretchKnob = M.clamp(k.stretch, 0, 100);
        if (k && k.speed != null) {
          speedKnob = M.clamp(k.speed, 0, 100);
          if (!held) startSettle();
        }
        kick();
      },
      /** 组件卸载时**必须**调用：停掉弹簧与帧循环，否则 rAF 泄漏 */
      destroy: function () {
        if (rafId) cancelAnimationFrame(rafId);
        rafId = 0;
        if (settle) settle.stop();
      }
    };
  }

  /* 导出 **SIZES 档位表本身**（不是某档的常量）——
     几何随档位走，导出一个固定数字只会让人拿到不属于任何实例的值。
     要读某档的几何：`LiquidToggle.SIZES.mini.thumb`。 */
  global.LiquidToggle = { create: create, SIZES: SIZES };
})(typeof window !== 'undefined' ? window : globalThis);
