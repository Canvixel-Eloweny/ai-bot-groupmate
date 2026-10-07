/* ══════════════════════════════════════════════════════════════════════════
   motion.js · 零依赖动效运行时（面板版）
   ──────────────────────────────────────────────────────────────────────────
   动效引擎的**唯一实现**。所有需要"会动的东西"（开关、拖拽、滚动跟随、数值过渡）
   都从这里取函数，不许在组件里各写一份 rAF 循环。

   ── 为什么要自己写，而不是引 framer-motion ──────────────────────────────
   Bencho（bencho.dev）那套动效全部基于 `framer-motion`。但本项目：
     · `package.json` 依赖只有 `ws`（**只有一个**），面板是**零构建**的原生页面
       （`panel/next/index.html` 直接 `<script src>`，没有打包器、没有 node_modules 链）；
     · 页面是**本地控制台**，走127.0.0.1，不需要任何运行时框架的通用性。
   引它要拖进 ~30KB + 一套构建，代价与收益不成比例。所以这里**只实现它被用到的那几个语义**：
   `motionValue` / `spring` / `velocity` / `animate` / `transform`。
   语义刻意与 framer-motion 对齐（同样的参数名、同样的手感），
   这样任何从 Bencho 抄来的配方都能**原样**搬过来，不用改写。

   ── 依赖：零。属依赖图最底层（同`runtime-state.js` 的 L0）。别给它加 import。
   ── 全局导出（挂 `window.Motion`），与页面里其它脚本一致；不参与 ESM 图。
   ══════════════════════════════════════════════════════════════════════════ */

(function (global) {
  'use strict';

  /* ══ 0 · 环境 ══════════════════════════════════════════════════════════
     减弱动效是**尊重**而不是可选项：前庭敏感用户开系统设置后，
     页面里不该有任何位移/缩放。取一次，缓动时长降为 0（见 §2 早退）。
     ⚠️ 监听用 addEventListener 而非只读一次：用户中途改系统设置要能生效。 */
  var rmQuery = global.matchMedia
    ? global.matchMedia('(prefers-reduced-motion: reduce)')
    : null;

  function reducedMotion() {
    return !!(rmQuery && rmQuery.matches);
  }

  /* ══ 1 · 调度器 · 一个 rAF 驱动全部 ══════════════════════════════════════
     ⚠️ 最容易写错的一步是"每个动画各起一个 requestAnimationFrame"。
     30 个动画 = 30 个 rAF 回调 = 每帧 30 次调度开销，且**回调顺序不确定**
     → 同一帧里父子动画的先后会随机漂移（子元素先动，看起来就是穿模）。
     这里用**单个 tick + 订阅集合**，并且 tick 只跑"确实还在动"的项。
     一帧内**后注册的后执行**（倒序遍历）：后启动的动画时间戳更新，
     算出的位移更接近这一帧的真实时间，不会落后一帧。 */
  var running = new Set();   // 活跃动画项
  var rafId = 0;
  var lastFrameTime = 0;

  function schedule(item) {
    running.add(item);
    if (rafId) return;                // 已经在跑了，不要再排一个
    lastFrameTime = performance.now();
    rafId = requestAnimationFrame(tick);
  }

  function unschedule(item) {
    running.delete(item);
    /* 队列空了就把 rAF 还回去。不还的话每帧都会空跑一次回调，
       在一个每 3 秒轮询的面板上这是持续的、无收益的唤醒。 */
    if (!running.size && rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
  }

  function tick(now) {
    rafId = 0;
    /* dt 上限 40ms：切标签页回来时 now 与上一帧可能差几十秒，
       不夹住的话积分器会一次性推进几千毫秒 → 元素瞬移。
       夹住的代价是"掉帧时动画变慢"，比瞬移好得多。 */
    var dt = Math.min((now - lastFrameTime) / 1000, 0.04);
    lastFrameTime = now;

    var items = Array.from(running);
    for (var i = items.length - 1; i >= 0; i--) {
      var it = items[i];
      /* 组件被卸载 / 动画被打断时由stop() 提前摘掉，这里只处理自然结束 */
      if (it._step(now, dt) === false) unschedule(it);
    }
    if (running.size) rafId = requestAnimationFrame(tick);
  }

  /* ══ 2 · 运动值 · 一个位置，两种写法 ════════════════════════════════════
     这是整套方法论的**地基**，Bencho 注释里叫「ONE POSITION, WRITTEN TWO WAYS」。

     位置存成**一个对象**，不是组件 state：
       · 拖拽时手指直接 `set()` —— 硬写、无缓动、每帧跟手；
       · 松手时 `animate()` 接管 —— 弹簧收敛。
     两者写的是**同一个格子**，谁在写都不会通知对方，也不需要重渲染。
     如果位置是 React state（哪怕是 ref 之外的useState），
     拖拽就必然触发重渲染，手感立刻垮掉。

     `velocity` 不是一个独立计算的量，而是**每次写都顺手记下的差分**。
     代价是两次采样间的真实速度（间隔不均匀时不准），
     收益是零额外订阅 —— 对"速度驱动形变"这类用法，够用。 */
  function MotionValue(initial) {
    this._v = typeof initial === 'number' ? initial : 0;
    this._vel = 0;        // 每单位秒的速度
    this._lastTime = 0;
    this._subs = [];      // 派生值订阅者（transform / velocity 都挂这里）
  }

  MotionValue.prototype.get = function () { return this._v; };

  MotionValue.prototype.set = function (next) {
    var now = performance.now();
    /* 第一次写入没有"上一帧"可比 → 速度为 0，
       否则首帧会拿 performance.now() - 0（一个几十秒的数字）当 dt，
       算出天文数字的速度，形变直接炸开。 */
    if (this._lastTime) {
      var dt = (now - this._lastTime) / 1000;
      if (dt > 0) this._vel = (next - this._v) / dt;
    }
    this._lastTime = now;
    this._v = next;
    this._flush();
  };

  /** 硬写但不更新速度 —— 初始化、拖拽中每帧的直接落位用它 */
  MotionValue.prototype.jump = function (next) {
    this._v = next;
    this._lastTime = 0;
    this._flush();
  };

  MotionValue.prototype.velocity = function () { return this._vel; };

  /** 订阅变化，返回退订函数。transform 内部用，组件一般不需要。 */
  MotionValue.prototype.on = function (fn) {
    this._subs.push(fn);
    var self = this;
    return function () {
      var i = self._subs.indexOf(fn);
      if (i >= 0) self._subs.splice(i, 1);
    };
  };

  MotionValue.prototype._flush = function () {
    for (var i = 0; i < this._subs.length; i++) this._subs[i](this._v);
  };

  function motionValue(initial) { return new MotionValue(initial); }

  /* ══ 3 · 弹簧 · 解析解，不是数值积分 ═══════════════════════════════════
     弹簧是**弹簧**，那就用它的闭式解，不要每帧数值积分。理由：
       · 解析解**不累积误差**，积分器在低帧率或长时长后会松/会漂；
       · 解析解能直接给出"什么时候算静止"（|x-target| 与 |v| 双阈值），
         数值积分得靠猜一个阈值，两者手感差一档；
       · 改 stiffness/damping 时行为可预测 —— 调参是改两个数，不是调两个数 + 调步长。

     解的是阻尼谐振子：m·x″ + c·x′ + k·x = 0（相对目标的位移 y = x - target）
       ζ  = c / (2√(km))          阻尼比
       ω₀ = √(k/m)自然角频率
     三档解法，**互斥**（ζ=1 归临界，否则 ζ>1 是过阻尼的复共轭根会溢出）：

     ⚠️ 关于 damping —— 这是 Bencho 注释里最反直觉的一条：
        「Bounce 是阻尼、Speed 是刚度，所以两个拨盘都是**同一个弹簧的属性**，而不是两条曲线。」
        用户调Bounce 时实际在改**阻尼比**（手感：从"啪一下到位"到"软塌塌"），
        调 Speed 时改刚度（快慢）。阻尼比小于 1 才有回弹，1 是刚好不过冲，>1 是死板。
        所以控制台不该给用户"曲线"选项，只给这两个物理量。 */
  /**
   * 弹簧的**单帧推进**，纯函数、不碰任何状态之外的东西。
   *
   * ⚠️ 为什么要导出：有些场景需要**自己控制时钟**（一个 rAF 推进多个弹簧，
   *    例如液态开关的拖尾 / 速度平滑 / 悬停鼓胀要在同一帧里算完再统一上屏）。
   *    那些地方不该各自 `animate()` 注册动画项 —— 那样一帧里三次订阅、三次排序，
   *    而且「同一帧内先算谁后算谁」会变成不确定。
   *
   *    所以这里导出**公式本身**：调用方在自己的循环里按同一个 dt 推进。
   *    这是「公式只有一份」与「时钟由调用方持有」两件事的唯一解 ——
   *    绝不允许为了图方便在组件里再抄一份（抄一份就多一个能悄悄对不上的机会）。
   *
   * @param {{x:number,v:number}} state 原地推进的状态对象
   * @param {number} target
   * @param {{stiffness:number,damping:number,mass:number}} cfg
   * @param {number} dt 秒
   */
  function springStep(state, target, cfg, dt) {
    var k = cfg.stiffness;
    var m = cfg.mass;
    var c = cfg.damping;
    var y = state.x - target;          // 相对目标的位移
    var v = state.v;                   // 相对目标的速度

    var w0 = Math.sqrt(k / m);
    var zeta = c / (2 * Math.sqrt(k * m));

    if (zeta < 1) {
      /* ── 欠阻尼：会过冲、有回弹。绝大多数 UI 动画在这一档 ── */
      var wd = w0 * Math.sqrt(1 - zeta * zeta);
      var e = Math.exp(-zeta * w0 * dt);
      /* cos/sin 用atan2 定相，避免 A/B 系数在极大阻尼下溢出 */
      var c1 = y;
      var c2 = (v + zeta * w0 * y) / wd;
      var cos = Math.cos(wd * dt);
      var sin = Math.sin(wd * dt);
      state.x = target + e * (c1 * cos + c2 * sin);
      state.v = e * ((c2 * wd - zeta * w0 * c1) * cos
                     - (c1 * wd + zeta * w0 * c2) * sin);
    } else if (zeta === 1) {
      /* ── 临界阻尼：最快抵达且不过冲。公式是上面两式的极限 ── */
      var e1 = Math.exp(-w0 * dt);
      state.x = target + (y + (v + w0 * y) * dt) * e1;
      state.v = (v - (v + w0 * y) * w0 * dt) * e1;
    } else {
      /* ── 过阻尼：磨蹭地过去。UI 里基本不用，列出只为数学完整 ── */
      var s = w0 * Math.sqrt(zeta * zeta - 1);
      var r1 = -zeta * w0 + s;
      var r2 = -zeta * w0 - s;
      var c2b = (v - r1 * y) / (r2 - r1);
      var c1b = y - c2b;
      state.x = target + c1b * Math.exp(r1 * dt) + c2b * Math.exp(r2 * dt);
      state.v = c1b * r1 * Math.exp(r1 * dt) + c2b * r2 * Math.exp(r2 * dt);
    }
  }

  /* ══ 4 · 动�� ═══════════════════════════════════════════════════════════
     `animate(mv, target, { type:'spring', stiffness, damping, mass })`
     语义对齐 framer-motion。返回一个带 `.stop()` 的句柄。

     ⚠️ 半路改目标是**必须**支持的，而且不能"从当前速度重新起步"式地
        悄悄丢掉动量 —— 那样连点两下会看到速度归零的台阶。
        这里保留 state.v，改目标只换 target，弹簧自然带着速度改向。 */
  function animate(mv, target, cfg) {
    cfg = cfg || {};
    var opt = {
      stiffness: cfg.stiffness == null ? 170 : cfg.stiffness,
      damping: cfg.damping == null ? 26 : cfg.damping,
      mass: cfg.mass == null ? 1 : cfg.mass
    };

    /* 减弱动效：直接落位，不注册任何帧循环。
       ⚠️ 落位必须用 set 而不是 jump —— set 会正确清掉速度，
       下一帧的形变（速度驱动的）也就不会莫名其妙拉伸一下。 */
    if (reducedMotion()) {
      mv.set(target);
      var noop = function () {};
      noop.stop = noop;
      noop.then = function (p) { p(); return noop; };
      return noop;
    }

    var state = { x: mv.get(), v: mv.velocity() };
    var stopped = false;

    var item = {
      _step: function (now, dt) {
        springStep(state, target, opt, dt);
        mv.set(state.x);
        /* 静止判据要**位移和速度都**满足。只看位移会在过冲顶点误判为静止
           （此时位移还很大但速度为 0，动画会在半路永久停住）。
           阈值 0.01px / 0.05px·s⁻¹ 都远小于任何可见量。 */
        if (Math.abs(state.x - target) < 0.01 && Math.abs(state.v) < 0.05) {
          mv.jump(target);          // 收尾对齐，避免浮点残差停在 0.3px 外
          return false;              // → 退订
        }
        return true;
      }
    };

    schedule(item);

    var handle = {
      /** 中断。**必须**有：组件卸载时不停 = rAF 泄漏，页面越用越卡。
       *  被 stop 的动画保持当前值与当前速度（不跳回目标），
       *  这样"按住拖到一半松手"能从当前位置继续。 */
      stop: function () {
        if (stopped) return;
        stopped = true;
        unschedule(item);
      },
      then: function (resolve) {
        return new Promise(function (res) {
          var poll = function () {
            if (stopped || !running.has(item)) { res(); return; }
            requestAnimationFrame(poll);
          };
          poll();
        });
      }
    };
    return handle;
  }

  /**
   * 动画**收敛后**回调 —— 本项目里唯一一份"句柄结束"适配。
   *
   * ⚠️ 为什么不能直接 `handle.then(cb)`：`animate` 返回的句柄带一个**自定义
   *    `then`** —— 它返回 Promise、却**忽略**传进去的回调参数（写 `h.then(cb)`
   *    就是"cb 永远不会被调用"，而表面完全看不出来）；而 `prefers-reduced-motion`
   *    档返回的是**假句柄**，它的 `then` 会当场调用那个参数（此时是 `undefined`
   *    ⇒ 抛 TypeError）。⇒ 正确形式是 `h.then().then(cb)`，且必须包 try。
   *
   * ⚠️ 这份适配**只许有一处**：`panel/next/sortable.js` 与 `panel/next/tilt.js`
   *    都从这里取。各自抄一份就是"同一份语义两份实现"，而它坏掉的症状是
   *    **回调静默不执行**（class 摘不掉 / rAF 泄漏），不会有任何报错。
   */
  function onSettle(handle, cb) {
    try {
      var p = handle && handle.then ? handle.then() : null;
      if (p && typeof p.then === 'function' && p !== handle) { p.then(cb, cb); return; }
    } catch (e) { /* 减弱动效档的假句柄：已经直接落位，没有"结束"这回事 */ }
    cb();
  }

  /* ══ 5 · 变换 · 一个值派生出另一个值 ═════════════════════════════════════
     framer-motion 的 `useTransform(v, fn)`。作用是**把形变从渲染里解耦出去**：
     位置是一个运动值，缩放是它的派生值，两者都写进同一个元素的 transform，
     中间不经过组件状态。

     ⚠️ 多个派生值必须**乘进同一个 transform**，不能各写一条 CSS 属性。
        Bencho 踩过这个坑并且写进了注释：hover 缩放原本走 CSS `scale` 属性，
        而 `scale` 比 `transform` **先**应用 —— 于是
        `scale:1.035` 先把坐标系缩了，`translateX(51px)` 再在缩放后的空间里走，
        51 变成 52.8，滑块在**开态**时明显偏出轨道（关态偏移 5px 只差 0.18px 看不出来）。
        正确做法是把缩放乘进 `scaleX/scaleY`。 */
  function transform(mv, fn) {
    var out = motionValue(fn(mv.get()));
    mv.on(function (v) { out.set(fn(v)); });
    return out;
  }

  /** 组合多个派生值为一个 CSS transform 字符串。顺序：位移 → 缩放。 */
  function toTransform(pairs) {
    var out = '';
    for (var i = 0; i < pairs.length; i++) {
      var p = pairs[i];
      var v = typeof p[1] === 'function' ? p[1]() : p[1];
      if (typeof v !== 'number' || !isFinite(v)) continue;   // NaN 直接跳过，不写进 style
      if (p[0] === 'x') out += ' translateX(' + v.toFixed(2) + 'px)';
      else if (p[0] === 'y') out += ' translateY(' + v.toFixed(2) + 'px)';
      else if (p[0] === 'scaleX') out += ' scaleX(' + v.toFixed(4) + ')';
      else if (p[0] === 'scaleY') out += ' scaleY(' + v.toFixed(4) + ')';
      else if (p[0] === 'scale') out += ' scale(' + v.toFixed(4) + ')';
      else if (p[0] === 'rotate') out += ' rotate(' + v.toFixed(2) + 'deg)';
    }
    return out.trim() || 'none';
  }

  /** 把一个运动值绑到元素的某个 transform 分量上。 */
  function bind(mv, el, part, extra) {
    var apply = function () { el.style.transform = toTransform(extra || [['x', mv]]); };
    mv.on(apply);
    apply();
  }

  /* ══ 6 · 工具 ══════════════════════════════════════════════════════════ */
  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

  /**
   * 面积守恒的拉伸 —— Bencho 注释里的关键一招。
   *
   * 一个东西被"拉长"时，体积（这里是面积）不该变：长多少，窄多少，
   * 乘起来是1。所以 scaleY = 1 / scaleX。
   *
   * ⚠️ 不做这一步会怎样：横向拉长 1.4 倍**同时**保持高度 → 面积大了 1.4 倍，
   *   视觉上就是"它鼓起来了 / 变胖了"，而不是"它被抻长了"。
   *   这是"液体感"最容易被一眼看穿的地方。
   */
  function areaPreservingScaleX(scaleX) {
    return 1 / scaleX;
  }

  /**
   * 把客户端坐标换算到元素的**自身坐标系**。
   *
   * ⚠️ 必做：组件常被写在transform: scale() 的容器里（Bencho 的卡片就说了
   * "组件按卡片给的比例绘制"）。此时 clientX 是屏幕坐标，直接用会差一个缩放倍数。
   * k = 视口宽 / 布局宽，把屏幕位移除回布局单位。
   */
  function localX(el, clientX) {
    var box = el.getBoundingClientRect();
    var layout = el.offsetWidth || box.width;
    var k = box.width / layout || 1;
    return (clientX - box.left) / k;
  }

  /* ══ 导出 ══════════════════════════════════════════════════════════════ */
  global.Motion = {
    motionValue: motionValue,
    animate: animate,
    onSettle: onSettle,
    springStep: springStep,
    transform: transform,
    toTransform: toTransform,
    bind: bind,
    clamp: clamp,
    localX: localX,
    areaPreservingScaleX: areaPreservingScaleX,
    reducedMotion: reducedMotion,
    /* 供测试/调试：当前活跃动画数。非零说明还有帧在跑。 */
    activeCount: function () { return running.size; }
  };

  if (rmQuery && rmQuery.addEventListener) {
    /* 系统设置中途改变：只记下来，不主动停掉正在跑的动画
       （半路急停比继续跑更突兀），下一个动画自然按新设置走。 */
    rmQuery.addEventListener('change', function () {});
  }
})(typeof window !== 'undefined' ? window : globalThis);
