/* ══════════════════════════════════════════════════════════════════════════
 * sortable.js · 可拖拽排序列表（零依赖）
 * ──────────────────────────────────────────────────────────────────────────
 * 让一组列表项**拖一下就换位**，换位过程是弹簧动画而不是瞬移。
 *
 * 参考形态：[beui.dev「Sortable List」](https://beui.dev/components/motion/sortable-stack)
 * （Composable sortable list，MIT）。⚠️ **只取交互语义，不取包**：
 *   取的是 ① 拖拽把手（不是整行都能拖，避免与行内按钮抢点击）② 拖动时
 *   **其余项让位**（不是"插进来时其它项瞬间跳开"）③ 键盘重排 ④ 位置变化
 *   **播报**给读屏。撤销由调用方持有（它才知道"上一次"是什么）。
 *   本项目零构建（无打包器、`package.json` 依赖只有 `ws`），
 *   它那套 React + `motion` 依赖链引不进来，所以落成原生实现。
 *
 *   ── 依赖：panel/next/motion.js（弹簧）。零构建、零依赖、零服务。
 *   ── 全局导出 `window.Sortable`，与页面里其它脚本一致；不参与 ESM 图。
 *
 * ── 引擎约定（`docs/MOTION-METHODOLOGY.md` §3 三条不许破的约定）────────────
 *   ① 一份语义一份实现：弹簧只在 `motion.js` 里存在一次（`springStep`），
 *      本文件**只调 `Motion.animate`**，绝不自己积分一条曲线。
 *   ② 一个 rAF 驱动全部：`motion.js` 的单 tick + 订阅集合。本文件**不起
 *      自己的 requestAnimationFrame 循环** —— 拖动时逐帧的是指针事件，
 *      而它写的是运动值（`mv.set`），不注册动画项。
 *   ③ 减弱动效是尊重：`Motion.animate` 在 `prefers-reduced-motion: reduce`
 *      下直接落位、不注册帧循环，本文件无需（也不该）另写一份判断。
 *
 * ── 为什么它必须自带「重绘守卫」─────────────────────────────────────────
 *   本项目页面每 3 秒 `innerHTML` 重建一次（`paintPage`）。于是：
 *     · **拖动中**重建 → 指针正在拖的节点被换掉，拖拽当场断掉；
 *     · **让位/落位动画中**重建 → 动画元素被换掉，看起来像"闪一下"。
 *   两种都不是"少见情况"，是每 3 秒必然撞上一次。所以本模块：
 *     · 暴露 `busy()`（正在拖**或**还有动画在跑），由 `app.js` 的 `softPaint`
 *       在轮询重绘前查它 —— 那是**唯一**的接线点；
 *     · 动画自然收敛时回调 `onSettled`，让调用方**补一次重绘**。
 *       没有它，被守卫挡掉的那次重绘要等到下一个 3 秒周期，标签文案会晚一拍。
 * ══════════════════════════════════════════════════════════════════════════ */

(function (global) {
  'use strict';

  var M = global.Motion;
  if (!M) { console.warn('[sortable] 需要先加载 motion.js'); return; }

  /* ══ 1 · 两档弹簧 · 参数按 ζ 算出来的，不是"看着差不多" ═══════════════
     判据⑥（Bounce = 阻尼 / Speed = 刚度，两者都是同一个弹簧的属性）。
     **让位与落位是两件不同的事**，所以给两档，不是"一个值到处用"：

       · 让位（别人被挤开，且手指还在拖）：要能读出"被推了一下" ⇒ 略软
       · 落位（顺序已定、各就各位）：要干净⇒ 略硬

     行高约 34px ⇒ 2.45% 过冲 ≈ 0.83px：**看得见一丝弹性，肉眼不会读成"晃"**。
     这组数字是**由行高反推**的：想让过冲恰好落在"能感知但不刺眼"这一档，
     就先定 ζ，再核对 `过冲% × 行高` 落在 0.5–1px。 */
  var GIVE_SPRING = { stiffness: 620, damping: 38, mass: 1 };  /* ζ=0.763 过冲 2.45% · 时间常数 53ms */
  var SETTLE_SPRING = { stiffness: 900, damping: 50, mass: 1 }; /* ζ=0.833 过冲 0.88% · 时间常数 40ms */

  /** 全局挂载表：`Sortable.busy()` 遍历它（只要有一个列表在忙就得挡重绘）。 */
  var mounted = [];

  /* ══ 2 · 几何 · 两套坐标必须分清 ══════════════════════════════════════
     ⚠️ **本项目最容易写错的一处**：位置有两套坐标，混用必然错位一截。

       · `offsetTop` = **布局位置**（不含 transform）。让位/落位补偿要用它，
         因为那问的是"离原布局位多远"，与当前动画走到哪一步无关。
       · `getBoundingClientRect().top` = **视觉位置**（含 transform）。
         FLIP 的 First/Last 与插入位判定要用它，因为那问的是"眼睛现在看到哪儿"。

     各给一个具名函数而不是内联 `getBoundingClientRect()`：写错不会报错，
     只会让列表整体偏半个行高 —— 而那正是"看起来像动画没做完"的成因。 */
  function layoutTop(el) { return el.offsetTop; }             // 不含 transform
  function visualTop(el) { return el.getBoundingClientRect().top; }  // 含 transform
  function centerOf(el) { return visualTop(el) + el.offsetHeight / 2; }

  /* ══ 3 · 一个可排序列表 ════════════════════════════════════════════════ */
  /**
   * @param {object} opt
   * @param {Element} opt.root      列表容器。**必须**已有 `position: relative`，
   *                                 否则 `offsetTop` 的参照物不是它（见 §2）
   * @param {string}  opt.item      项选择器
   * @param {string}  opt.handle    把手选择器（只有它能起拖）
   * @param {string}  opt.idAttr    项的身份属性名（值的唯一性由调用方保证）
   * @param {string}  [opt.live]    播报区选择器；`null` = 不要播报，缺省 = 自动建一个
   * @param {Function} [opt.labelOf] 取一项的可读名（播报用）；缺省取文本内容
   * @param {Function} [opt.onCommit] 顺序定下来时回调 `(ids, meta)`
   * @param {Function} [opt.onSettled] 动画全部收敛后回调（补被守卫挡掉的重绘）
   * @param {boolean} [opt.enabled=true] 总闸：false ⇒ 挂载但不接受拖拽与键盘
   */
  function create(opt) {
    opt = opt || {};
    var root = opt.root;
    if (!root) return null;

    var api = {
      el: root,
      enabled: opt.enabled !== false,
      drag: null,        // 非空 = 正在拖
      anims: new Map(),  // el → 动画句柄（`stop()` 用；也是"忙"的判据）
      generation: 0,     // 每次顺序变更 +1：`onSettled` 靠它认出"我是不是过期了"
      dead: false,
    };

    /* ── 3.1 取项 · 每次都以 DOM 顺序为准 ─────────────────────────────────
       ⚠️ 不缓存元素数组：`paintPage` 整页重建后元素全是新对象，
          任何跨渲染的缓存都会指向已不在文档里的节点（本项目的老坑）。 */
    function items() {
      return Array.prototype.slice.call(root.querySelectorAll(opt.item));
    }
    function idOf(el) { return el.getAttribute(opt.idAttr); }
    function ids() { return items().map(idOf); }
    function labelOf(el) {
      if (opt.labelOf) return String(opt.labelOf(el) || '');
      return (el.textContent || '').replace(/\s+/g, ' ').trim();
    }

    /* ── 3.2 播报 · 位置变化是**状态**，读屏用户必须听得见 ────────────────
       为什么不是把 `aria-live` 挂在每一项上：那样每次重绘都会把整张列表念一遍。
       单独一个 `role=status` 区，只在**真的换了位**时写一句。

       ⚠️⚠️ 三态，**不是两态**（第一版写成两态，播报区永远建不出来）：
         · `opt.live` 是选择器字符串 → 用它找现成的；
         · `opt.live` **没传**（`undefined`）→ **自己建一个**（默认行为）；
         · `opt.live === null` → 调用方明确说"不要播报" → 不建。
       `undefined` 与 `null` 在这里语义不同，所以判据必须把两者分开写 ——
       写成 `if (!live && opt.live !== null)` 时，"没传"与"传了但没找到"混在一起，
       前者会静默退化成"不播报"，而症状是**页面完全正常、只是读屏一声不吭**。 */
    var live = (opt.live == null) ? null : root.querySelector(opt.live);
    var liveOwned = false;
    if (!live && opt.live !== null) {
      live = document.createElement('p');
      live.className = 'srt-live';
      live.setAttribute('role', 'status');
      live.setAttribute('aria-live', 'polite');
      root.appendChild(live);
      liveOwned = true;
    }
    function announce(text) {
      if (!live) return;
      /* 同一句连写两遍读屏不会念（内容没变），所以先清一下再写。 */
      live.textContent = '';
      live.textContent = text;
    }
    function announceSlot(el, list) {
      var i = list.indexOf(el);
      if (i < 0) return;
      announce(`「${labelOf(el)}」现在是第 ${i + 1} 位，共 ${list.length} 位`);
    }

    /* ── 3.3 运动值 · 一个元素一个，transform 由它独占 ───────────────────
       `will-change` 只在挂上值那一刻设、`destroy` 时撤 —— 常开会让每一行
       各占一层合成纹理，行数一多反而更卡。 */
    var mvs = new Map();
    function mvOf(el) {
      var rec = mvs.get(el);
      if (rec) return rec.mv;
      var mv = M.motionValue(0);
      var unsub = mv.on(function (v) {
        el.style.transform = M.toTransform([['y', v]]);
      });
      mvs.set(el, { mv: mv, unsub: unsub });
      el.style.willChange = 'transform';
      return mv;
    }
    function stopAnim(el) {
      var h = api.anims.get(el);
      if (h) { h.stop(); api.anims.delete(el); }
    }
    /**
     * 动画收敛后回调。
     * ⚠️ 实现已上移到 `motion.js` 的 `M.onSettle` —— 那是本项目**唯一**一份
     * "句柄结束"适配（`tilt.js` 也从那里取）。本文件只留一个转发名，
     * 是为了让调用点读起来仍然贴着"这一步在等动画收敛"这件事。
     */
    function whenDone(h, cb) { M.onSettle(h, cb); }
    /**
     * 起一段动画并登记进 `api.anims`。
     *
     * ⚠️⚠️ 关键是收敛后**必须自己摘掉**：`api.anims` 同时是 `busy()` 的判据，
     * 而 `busy()` 是 `softPaint` 轮询重绘的**唯一**守卫。只增不减 ⇒ `busy()`
     * 恒为 true ⇒ 每 3 秒的重绘被**永久**挡掉，页面看起来"卡在旧数据上"
     * —— 而按钮、把手、拖拽全都正常，没有任何异常会提示这件事。
     * （verify 实测抓到的就是它：`busyAfter=true`。）
     */
    function play(el, target, spring) {
      var h = M.animate(mvOf(el), target, spring || SETTLE_SPRING);
      api.anims.set(el, h);
      whenDone(h, function () { if (api.anims.get(el) === h) api.anims.delete(el); });
      return h;
    }
    function settleTo(el, target, spring) {
      stopAnim(el);
      var rec = mvs.get(el);
      if (!rec) { el.style.transform = ''; return; }
      if (Math.abs(rec.mv.get() - target) < 0.01) { rec.mv.jump(target); return; }
      play(el, target, spring);
    }

    /* ── 3.4 换序（FLIP）· 所有顺序变化的**唯一**实现 ─────────────────────
       FLIP = First（量旧位置）· Last（改 DOM）· Invert（反向补偿）· Play（弹到 0）。

       为什么可以省掉一半测量：**Invert 的量就是"当前 transform"**。
       因为恒等式 `视觉位置 = 布局位置 + transform` 成立，改完 DOM 之后
       布局位置变了、transform 还在，于是"停在新布局的 transform=0 处"
       所需的初值恰好是 `旧视觉 − 新视觉`。⇒ 拖动项之外**不必再量一次几何**。

       ⚠️ 拖动项是唯一例外：它要停在**手指下面**，不是新布局位。
          所以它被排除在 FLIP 之外，由 §3.5 的公式接管。 */
    function applyOrder(nextEls, meta) {
      var cur = items();
      if (nextEls.length !== cur.length) return false;
      var same = true;
      for (var k = 0; k < cur.length; k++) { if (cur[k] !== nextEls[k]) { same = false; break; } }
      if (same) return false;

      var dragging = !!api.drag;
      var dragEl = dragging ? api.drag.el : null;
      /* 让位 vs 落位：拖动中用软的那档（还要继续被推），其余时候用硬的那档。 */
      var spring = dragging ? GIVE_SPRING : SETTLE_SPRING;

      var before = cur.map(visualTop);

      /* Last：改 DOM。只动 `appendChild`，不写样式 —— 顺序是数据的形状、
         样式是状态的形状；一旦让动画层碰 `display`/`order`，就会与
         `offsetTop` 打架（且这类错不会报错，只会错位）。 */
      for (var i = 0; i < nextEls.length; i++) root.appendChild(nextEls[i]);

      var after = cur.map(visualTop);
      for (var j = 0; j < cur.length; j++) {
        var el = cur[j];
        if (el === dragEl) continue;
        var invert = before[j] - after[j];
        /* ⚠️⚠️ `mvOf(el)` 返回的是**运动值本身**，不是 Map 里那条记录
           （记录要用 `mvs.get(el)`，见 `settleTo`）。
           这里曾经写成 `var rec = mvOf(el); … rec.mv.jump(invert)` ——
           `rec.mv` 恒为 `undefined` ⇒ 第一次遇到"位移超过 0.5px 的那一项"就抛
           `TypeError: Cannot read properties of undefined (reading 'jump')`。
           后果非常隐蔽，三条叠加：
             · 异常抛在 FLIP 循环**中间**，而 `appendChild`（改 DOM）在循环**之前**
               ⇒ 顺序**已经改好了**，"改顺序"看上去完全正常；
             · 让位动画**从未产生过** —— 只有被拖的那一项跟着手指在动，
               于是"拖起来有点生硬"会被读成手感问题，而不是缺陷；
             · 监听器里抛的异常**不会传给 `dispatchEvent` 的调用方**，
               页面照常工作、按钮照常能点，只有真浏览器的控制台里多一条 uncaught。
           它是 `panel/next/verify.mjs` 的「键盘重排 + 撤销」那一组红出来的
           （用 `window.addEventListener('error')` 抓到原文）。 */
        var mv = mvOf(el);
        if (Math.abs(invert) < 0.5) { settleTo(el, 0, spring); continue; }
        mv.jump(invert);              // 视觉位置原地不动
        play(el, 0, spring);
      }

      /* 拖动项：改完 DOM 立刻把它按在新布局下重新对到手指上（见 §3.5）。 */
      if (dragging) api.drag.relayout();

      api.generation += 1;
      var gen = api.generation;

      /* `onSettled` 的作用是**补一次被守卫挡掉的重绘**。`.then` 在动画自然
         结束时兑现，被打断也会兑现，所以还要用 generation 认一遍
         "我是不是过期的那一次" —— 连点两下时只有最后一次该触发。 */
      if (opt.onSettled) {
        var pending = [];
        api.anims.forEach(function (h) { pending.push(h); });
        var fire = function () {
          if (!api.dead && api.generation === gen && opt.onSettled) opt.onSettled();
        };
        if (!pending.length) fire();
        else {
          Promise.all(pending.map(function (h) {
            return h && h.then ? h.then(function () { }) : null;
          })).then(fire, fire);
        }
      }

      /* `silent` = 拖动过程中的**中间态**：位置确实变了，但用户手指还压着，
         此刻写配置等于每越过一条线就发一次请求。持久化只在 `pointerup`
         与键盘重排时发生（§3.5 / §3.6）。 */
      if (opt.onCommit && !(meta && meta.silent)) opt.onCommit(nextEls.map(idOf), meta || {});
      return true;
    }

    /** 按 id 顺序重排（撤销 / 「恢复最优」走这条）。对不上的 id 追加到末尾。 */
    function applyIds(want, meta) {
      var byId = new Map();
      items().forEach(function (el) { byId.set(idOf(el), el); });
      var next = [];
      for (var i = 0; i < want.length; i++) { var el = byId.get(want[i]); if (el) next.push(el); }
      var cur = items();
      for (var j = 0; j < cur.length; j++) if (next.indexOf(cur[j]) < 0) next.push(cur[j]);
      return applyOrder(next, meta || { via: 'applyIds' });
    }

    /* ── 3.5 拖动 · 位置是**一个格子**，两种写法 ─────────────────────────
       判据①：拖动时 `mv.set()`（硬写、每帧跟手），松手时 `animate()` 接管。
       两者写同一个 motionValue，谁在写都不会通知对方。

       transform 的算法（写成公式，是为了让"重排改变了布局"这件事显式）：
           transform = 起手偏移 + 手指位移 + (起手布局位置 − 此刻布局位置)
         · 第二项让它跟手；
         · 第三项是**重排补偿** —— 重排把它的布局位置挪走了，这一项把它
           留在手指底下，否则每次越过一条线都会跳一下；
         · 第一项是起手那一刻它已有的偏移。⚠️ 不能省：若起手时上一段 FLIP
           还没收敛（连点两下 ↑ 就是这样），省掉它会在按下瞬间跳一下。
       ⚠️ 布局位置**只在重排那一刻**读一次（`relayout`），不是每帧读：
          `offsetTop` 强制同步布局，每帧读就是持续的布局抖动。 */
    var DRAG_THRESHOLD = 3;   // px。小于此位移当"没拖" ⇒ 点一下把手只聚焦，不改顺序
    var NO_SELECT = 'srt-noselect';

    function onDown(ev) {
      /* ⚠️ 排查期的唯一一条自证：把每次 pointerdown 的**判定过程**记下来。
         为什么需要它：这一层失效时**没有任何症状** —— 页面照常工作、
         行照常渲染、按钮照常能改顺序，只是拖拽静默不起作用，
         而 `data-dragging` 一直是 null。看代码读到怀疑也没用，
         必须知道它是在**哪一道门**返回的。形如 `[gate, …]`。
         ⚠️ 它会随每次拖拽增长，所以 `destroy()` 里清掉。 */
      api.trace = ['enter'];
      if (!api.enabled) { api.trace.push('disabled'); return; }
      if (api.drag) { api.trace.push('busy'); return; }
      if (ev.button != null && ev.button > 0) { api.trace.push('button=' + ev.button); return; }
      var handle = ev.target.closest(opt.handle);
      if (!handle) { api.trace.push('no-handle:' + (ev.target && ev.target.className)); return; }
      if (!root.contains(handle)) { api.trace.push('handle-outside-root'); return; }
      var el = handle.closest(opt.item);
      if (!el) { api.trace.push('no-item'); return; }

      /* 起手前先把这一项身上未收敛的动画停掉：动画与拖动同时写同一个
         运动值会互相拉扯（每帧各写一次），症状是"拖起来一顿一顿的"。 */
      stopAnim(el);
      var mv = mvOf(el);

      var d = {
        el: el,
        handle: handle,
        pointerId: ev.pointerId,
        startY: ev.clientY,
        startLayout: layoutTop(el),
        startOff: mv.get(),
        cur: 0,
        moved: false,
        cancelled: false,
      };
      d.relayout = function () {
        mvOf(el).set(d.startOff + d.cur + (d.startLayout - layoutTop(el)));
      };
      api.drag = d;
      api.trace.push('grabbed:' + idOf(el));

      /* 捕获失败不影响功能：事件绑在 window 上，用 pointerId 认领人。 */
      try { handle.setPointerCapture(ev.pointerId); } catch { /* 指针已不在元素上 */ }
      ev.preventDefault();
    }

    function onMove(ev) {
      var d = api.drag;
      if (!d || ev.pointerId !== d.pointerId) return;
      var dy = ev.clientY - d.startY;
      /* ⚠️⚠️ `el` 必须**先于** `if (!d.moved)` 取 —— 这里曾经把它声明在
         `d.cur = dy` 之后（本函数下半段），而 JS 的 `var` 会提升到函数顶部、
         初值却是 `undefined`。于是"第一次真正的移动"那一帧：
             `d.moved = true` 与 `data-dragging` 都已写入，
             紧接着 `el.setAttribute('data-drag','1')` 抛 TypeError
             ⇒ 这一帧的**换序判定整段没跑**（异常从监听器里冒出去）。
         症状极其隐蔽：拖拽**看起来能用**（后续帧照常换序），
         而"抬起"的投影标记**一次都没出现过**、让位位移也少一截
         （verify 实测：`data-drag` 从未出现 + 让位峰值 2.00px）。 */
      var el = d.el;
      if (!d.moved) {
        if (Math.abs(dy) < DRAG_THRESHOLD) return;
        d.moved = true;
        root.setAttribute('data-dragging', '1');
        el.setAttribute('data-drag', '1');
        document.body.classList.add(NO_SELECT);
      }
      ev.preventDefault();
      d.cur = dy;
      d.cancelled = false;

      var cur = items();
      var from = cur.indexOf(el);
      var to = insertionIndex(el, ev.clientY);
      if (to !== from && to >= 0) {
        /* 让位与落位一起算：插入位变了就把别人挤开（弹簧），
           同时把拖动项按到新布局下 —— 两步之间没有静帧。 */
        var next = cur.slice();
        next.splice(from, 1);
        next.splice(to, 0, el);
        applyOrder(next, { via: 'drag', silent: true });
        announceSlot(el, items());
        return;
      }
      d.relayout();
    }

    /** 指针 y 落在第几个位置。判据是**其余项的视觉中心**，不是行号。 */
    function insertionIndex(self, clientY) {
      var cur = items();
      var from = cur.indexOf(self);
      var to = from;
      for (var i = 0; i < cur.length; i++) {
        if (i === from) continue;
        if (clientY < centerOf(cur[i])) {
          if (i < from) { to = i; break; }     // 往上：插到这一项**之前**
        } else if (i > from) {
          to = i;                                // 往下：插到这一项**之后**（继续往下扫）
        }
      }
      return to < 0 ? from : to;
    }

    function onUp(ev) {
      var d = api.drag;
      if (!d || ev.pointerId !== d.pointerId) return;
      /* ⚠️ 清理动作排在状态恢复**之前**且自己 try/catch（判据 §2①）：
         `releasePointerCapture` 在"从未成功捕获"时必抛，而它抛在前面
         就意味着后面的收尾全都不执行 —— 症状是"这一行之后再也拖不动"。 */
      try { d.handle.releasePointerCapture(ev.pointerId); } catch { /* 从未捕获成功 */ }
      api.drag = null;
      root.removeAttribute('data-dragging');
      d.el.removeAttribute('data-drag');
      document.body.classList.remove(NO_SELECT);

      if (!d.moved) return;                        // 只是点了一下把手：保留聚焦，不改顺序
      if (d.cancelled) { settleTo(d.el, 0); return; }
      /* 落位：其余项已在 FLIP 里归位，拖动项由这一句收尾（带着当前速度）。 */
      settleTo(d.el, 0);
      /* `movedId` = 被挪动的那一条。调用方要拿它写撤销说明
         （"你把 X挪到了第几位"），而它只能由引擎给 ——
         调用方拿到的 `ids` 里已经看不出是哪条动了。 */
      if (opt.onCommit) opt.onCommit(ids(), { via: 'drag', movedId: idOf(d.el) });
      announceSlot(d.el, items());
    }

    /* ── 3.6 键盘重排 · 把手是真 button，所以焦点与读屏都拿得到 ───────────
       ↑/↓ 移一位，Home/End 到两端。**播报必须发生**：屏幕上看得很清楚的
       变化，读屏用户完全感知不到 —— 无障碍里最常被漏掉的一类。 */
    function onKey(ev) {
      if (!api.enabled || api.drag) return;
      var isHome = ev.key === 'Home', isEnd = ev.key === 'End';
      var dir = ev.key === 'ArrowUp' ? -1 : ev.key === 'ArrowDown' ? 1 : 0;
      if (!dir && !isHome && !isEnd) return;
      var handle = ev.target.closest(opt.handle);
      if (!handle || !root.contains(handle)) return;
      var el = handle.closest(opt.item);
      if (!el) return;
      ev.preventDefault();

      var cur = items();
      var from = cur.indexOf(el);
      var to = isHome ? 0 : isEnd ? cur.length - 1 : from + dir;
      if (to < 0 || to >= cur.length || to === from) return;

      var next = cur.slice();
      next.splice(from, 1);
      next.splice(to, 0, el);
      applyOrder(next, { via: 'key', key: ev.key, movedId: idOf(el) });
      /* 焦点必须跟着走：`appendChild` 会把焦点甩到 body 上，
         于是"连按两次 ↓"第二次就不知道自己在哪儿了。 */
      var h2 = el.querySelector(opt.handle);
      if (h2 && h2.focus) h2.focus({ preventScroll: true });
      announceSlot(el, items());
    }

    /** 拖出列表上下边界 24px = 取消（回原位）。触屏上等于"滑回去"。 */
    function onOver(ev) {
      var d = api.drag;
      if (!d || !d.moved) return;
      var r = root.getBoundingClientRect();
      var out = ev.clientY < r.top - 24 || ev.clientY > r.bottom + 24;
      if (out === d.cancelled) return;
      d.cancelled = out;
      if (out) settleTo(d.el, 0);
      else d.relayout();
    }

    /* ── 3.7 挂载 · 指针事件绑在 window 上而不是 root ─────────────────────
       为什么：指针滑到列表之外时 `pointermove` 不会到达 root，
       而"滑出去再滑回来"必须连续。绑 window + 用 `pointerId` 认领人即可，
       不依赖 `setPointerCapture` 真的成功。 */
    /* ⚠️⚠️ **签名必须是三参** —— `addEventListener(type, listener, options)`。
       这里曾经写成 `function on(t, fn) { t.addEventListener(fn, {passive:false}) }`：
       于是 `type` 收下了函数、`listener` 收下了 `{passive:false}` 那个**对象**，
       而对象不是函数 ⇒ 浏览器**静默忽略**这条注册（不抛异常、不报错）。
       症状是**页面完全正常**：把手在、↑↓ 按钮照常改顺序、无控制台异常，
       只是拖拽与键盘重排**全都不起作用**。
       它被 `panel/next/verify.mjs` 的合成 PointerEvent 抓出来（7 条断言同时红：
       顺序没变 / 让位峰值 0 / 抬起标记没出现 / 播报为空 / 撤销条没出现 / 键盘没变 / 没拦到写）。
       ⇒ 这正是"接线挂上了只有真进程能证明"的又一例：挂载数=1、把手数=7 全绿也说明不了任何事。 */
    function on(t, type, fn) { t.addEventListener(type, fn, { passive: false }); }
    on(root, 'pointerdown', onDown);
    on(global, 'pointermove', onMove);
    on(global, 'pointerup', onUp);
    on(global, 'pointercancel', onUp);
    on(root, 'keydown', onKey);
    on(root, 'pointerover', onOver);

    api.destroy = function () {
      if (api.dead) return;
      api.dead = true;
      root.removeEventListener('pointerdown', onDown);
      global.removeEventListener('pointermove', onMove);
      global.removeEventListener('pointerup', onUp);
      global.removeEventListener('pointercancel', onUp);
      /* ⚠️ keydown 绑在 `root`、就**必须卸在 `root`** —— 与挂载点逐字对称。
         卸错目标不会报错，只是这条监听永远留在节点上（重挂 N 次就叠 N 份）。 */
      root.removeEventListener('keydown', onKey);
      root.removeEventListener('pointerover', onOver);
      root.removeAttribute('data-dragging');
      /* ⚠️ `data-drag` 也要清：若在**拖动途中**被 destroy（切页 / 重绘），
         那一行会永远带着"被抬起"的投影 —— 而拖动已经不存在了。
         同理 `api.drag` 要置空，否则 `busy()` 永远返回 true，
         于是 `softPaint` 的守卫会把重绘**永久**挡掉（页面看着卡在旧数据上）。 */
      if (api.drag) { api.drag.el.removeAttribute('data-drag'); api.drag = null; }
      document.body.classList.remove(NO_SELECT);
      api.anims.forEach(function (h) { h.stop(); });
      api.anims.clear();
      mvs.forEach(function (rec, el) { rec.unsub(); el.style.transform = ''; el.style.willChange = ''; });
      mvs.clear();
      if (liveOwned && live && live.parentNode) live.parentNode.removeChild(live);
      var k = mounted.indexOf(api);
      if (k >= 0) mounted.splice(k, 1);
    };

    api.ids = ids;
    /* 引擎自证：这一层失效时**页面完全正常**（行在、把手在、按钮能点），
       只是拖拽静默不起作用。所以必须能从外面问出"引擎绑的是哪个节点"。
       `rootIsCurrent` 为 false ⇒ 引擎挂在一个已被 `innerHTML` 换掉的旧节点上，
       事件派发到新节点它一无所知—— 而没有任何异常会告诉你这件事。 */
    api.diagnose = function (currentRoot) {
      return {
        sameRoot: currentRoot ? (root === currentRoot) : null,
        rootConnected: root.isConnected,
        dead: api.dead,
        enabled: api.enabled,
        trace: (api.trace || []).join(' > '),
      };
    };
    api.applyOrder = applyOrder;
    api.applyIds = applyIds;
    api.announce = announce;
    /** 正在拖**或**还有动画在跑 ⇒ 调用方（轮询重绘）必须让路。 */
    api.busy = function () { return !!api.drag || api.anims.size > 0; };

    mounted.push(api);
    return api;
  }

  /* ══ 4 · 导出 ══════════════════════════════════════════════════════════ */
  global.Sortable = {
    create: create,
    GIVE_SPRING: GIVE_SPRING,
    SETTLE_SPRING: SETTLE_SPRING,
    /** 页面上**任何一个**列表在忙吗？（`softPaint` 的重绘守卫读它） */
    busy: function () {
      for (var i = 0; i < mounted.length; i++) if (mounted[i].busy()) return true;
      return false;
    },
    /** 当前挂载了几个（自检与排查用；正常运行时恒为 0 或 1）。 */
    count: function () { return mounted.length; },
    /** 最近一次 `pointerdown` 的判定轨迹（自检与排查读它；见 onDown 里的说明）。 */
    trace: function () {
      if (!mounted.length) return '(没有挂载实例)';
      return (mounted[mounted.length - 1].trace || []).join(' > ');
    },
  };
})(typeof window !== 'undefined' ? window : globalThis);