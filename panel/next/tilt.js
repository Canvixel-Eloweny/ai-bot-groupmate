/* ══════════════════════════════════════════════════════════════════════════
 * tilt.js · 卡片的光标微倾（零依赖）
 * ──────────────────────────────────────────────────────────────────────────
 * 参考形态：beui.dev「Tilt Card」（MIT）的**倾斜部分**。
 * ⚠️ **只取"光标位置 → 微小倾角"这一条**，其余一概不要（见下"用户裁定过的三条"）。
 *
 *   ── 依赖：panel/next/motion.js（`motionValue` / `animate` / `onSettle`）。
 *   ── 全局导出 `window.Tilt`，与页面里其它脚本一致；不参与 ESM 图。
 *
 * ── 用户裁定过的三条（2026-10-04 两轮反馈，**改回去之前先读这里**）────────────
 *   ① **不要高光 / 灯光**（原实现有 `cursor-tracked glare`）——
 *      已整层删除（含 CSS 的 `::after`、令牌 `--c-eg-glare`、本文件的 gx/gy）。
 *      ⚠️ 想加回来请先问：那不是"更完整"，那是用户明确否过一次的东西。
 *   ② **不要任何"翻转"感**。第一次报这个问题时我判定是 `transform-style: preserve-3d`
 *      （卡内子元素一起进 3D 空间），删了；**用户复验后翻转仍在** ⇒ 判定不全。
 *      真正的另一半在 `style.css`：`perspective` 是"观察者到卡片的距离"，
 *      我为了"小角度也有立体感"把它从 900px 缩到了 700px —— 而卡片本身可能高 600px
 *      ⇒ **观察距离只比卡片高一点，透视畸变被放到最大**，上下边缘大小差明显，
 *      读起来就是"卡片在往前倒"。⇒ 现在 **2400px**（接近正交投影）。
 *      **教训：把"更明显"当成"更对"，方向就反了。**
 *   ③ **幅度要极小**：1°（`MAX_DEG`）。参考实现默认 12°，这里连它的 1/10 都不到 ——
 *      职责只是"这块是可以碰的"这一丝反馈，不是表演。
 *
 * ── 与 `sortable.js` 的关键区别：**它为什么一个"重绘守卫"都不需要** ────────
 *   `paintPage()` 每 3 秒把整页 `innerHTML` 重建一次。sortable 必须自己挡重绘，
 *   因为它**把状态存在元素上**（正在拖的是哪个、动画走到哪了）。
 *   tilt 不持有跨渲染的状态，三条各自成立：
 *     ① 事件用**委托**绑在 `document` 上（不是绑在卡片上）——
 *        卡片被换掉、甚至整页重建，监听器都还在，一次都不用重挂；
 *     ② 每张卡的倾斜量存在**元素自己身上**（`el.__tilt`），元素被换掉时
 *        连同它的运动值一起被回收；
 *     ③ 光标不动就不写任何东西（没有轮询、没有常驻 rAF）。
 *   ⚠️ 但"委托"只解决"事件还收得到"，**不解决"状态丢了"** ——
 *      所以还有一个 `resync()`（见下），它不是重绘守卫，是"重绘后认回来"。
 *
 * ── 两条纪律 ────────────────────────────────────────────────────────────
 *   ① 一个 rAF 驱动全部：本文件**不起自己的 rAF** —— 跟手期间由指针事件驱动，
 *      回落交给 `motion.js` 的调度器。
 *   ② 只写 CSS 变量：真正的 `transform` 写在 `style.css` 里（`--tilt-rx/ry`）。
 *   ③ 减弱动效是尊重：`prefers-reduced-motion: reduce` 或触摸设备
 *      ⇒ **整个模块不挂**（`Tilt.enabled()` 如实返回 false，自检可问它）。
 * ══════════════════════════════════════════════════════════════════════════ */

(function (global) {
  'use strict';

  var M = global.Motion;
  if (!M) { console.warn('[tilt] 需要先加载 motion.js'); return; }

  /* ══ 1 · 两个数决定手感 ══════════════════════════════════════════════════
     · MAX_DEG  倾角上限 **1°**。用户两轮反馈都要"更小"，第一次 6° → 3° → 现在 1°。
       参考实现默认 12°，这里是它的 1/12。
       ⚠️ 要让倾斜"更有感觉"，**不许加这个数** —— 加它立刻会回到"翻转感"那条老路。
     · SPRING   回落弹簧。ζ≈0.72：慢一点才像"卡片浮回原位"，
       而不是"被弹了一下"（这里是环境氛围，不是操作反馈）。 */
  var MAX_DEG = 1;
  var SPRING = { stiffness: 150, damping: 20, mass: 1 };

  /** 当前正在倾斜的那一张（全局最多一张 —— 多张同斜会互相抢注意力）。 */
  var active = null;

  /**
   * 取/建一张卡的两个运动值。**存在元素自己身上**（`el.__tilt`），
   * 不用 Map —— 整页每 3 秒重建一次，Map 会随元素一起变成垃圾却清不掉，
   * 而挂在元素上的属性是随元素一起消失的。
   *
   * ⚠️ 一个订阅里写全两个变量：`rx` 与 `ry` 是**两个**运动值，各自订阅一次
   * 会把每帧的 style 写放大成两次（并且两次之间有一帧不一致的中间态）。
   */
  function motionOf(el) {
    var r = el.__tilt;
    if (r) return r;
    r = el.__tilt = { rx: M.motionValue(0), ry: M.motionValue(0), hs: null };
    var write = function () {
      el.style.setProperty('--tilt-rx', r.rx.get().toFixed(2) + 'deg');
      el.style.setProperty('--tilt-ry', r.ry.get().toFixed(2) + 'deg');
    };
    r.rx.on(write); r.ry.on(write);
    return r;
  }

  /**
   * 停掉这张卡**所有**在跑的动画句柄。
   *
   * ⚠️⚠️ 这里必须管住**两个**句柄（rx 一个、ry 一个），而不是只记一个：
   *    第一版写成 `r.h = h1`（只记 rx 的）⇒ **ry 的动画永远不会被 stop**，
   *    于是"在两张卡之间快速来回穿梭"这个动作会**每穿梭一次就留下一条动画**：
   *    verify 实测穿梭 30 次之后 `Motion.activeCount()` 读到 **30**。
   *    后果有两条，都不报错：
   *      · 30 条动画每帧各写一次同一个运动值 ⇒ 值在多条相位不同的衰减曲线之间跳（视觉抖动）；
   *      · 每一帧多 30 次 style 写入（合成器负担），而这页有 50+ 张卡。
   *    ⇒ 句柄一律存进数组，`enter` / `leave` / 收尾都走这一个函数。
   */
  function stopAll(r) {
    if (!r || !r.hs) return;
    for (var i = 0; i < r.hs.length; i++) { try { r.hs[i].stop(); } catch (e) { /* 已结束 */ } }
    r.hs = null;
  }

  function enter(el) {
    if (active === el) return;
    if (active) leave(active);          // 前一张同时往回走，允许短暂重叠（比"瞬间跳回"自然）
    active = el;
    var r = motionOf(el);
    stopAll(r);
    /* `tilt-on` 管一件事：`will-change: transform`。
       ⚠️ 它只在这一刻设、离开时撤 —— 常开会让**每一张**卡各占一层合成纹理，
       而这一页有 50+ 张卡（本项目已有同款教训）。 */
    el.classList.add('tilt-on');
  }

  function move(e) {
    var el = active;
    if (!el) return;
    var r = el.__tilt;
    if (!r) return;
    /* ⚠️ 每帧量一次 rect：滚动 / 重绘之后它都会变，用缓存会让角度整体偏移。
       代价可控 —— 同帧内浏览器会复用布局结果，而本函数里没有任何触发布局的写入。 */
    var b = el.getBoundingClientRect();
    if (!b.width || !b.height) return;
    var px = (e.clientX - b.left) / b.width;
    var py = (e.clientY - b.top) / b.height;
    if (px < 0) px = 0; else if (px > 1) px = 1;
    if (py < 0) py = 0; else if (py > 1) py = 1;
    /* 上边缘 → 卡片向后仰（rotateX 取正），与参考实现同向。 */
    r.rx.set((0.5 - py) * 2 * MAX_DEG);
    r.ry.set((px - 0.5) * 2 * MAX_DEG);
  }

  function leave(el) {
    if (active === el) active = null;
    var r = el.__tilt;
    if (!r) { el.classList.remove('tilt-on'); return; }
    stopAll(r);
    var done = function () {
      /* ⚠️ 只有"仍然不是当前那张"才摘 class：快速划过一排卡片时，
         前一张的回落回调可能在后一张早已 `tilt-on` 之后才到 ——
         那时摘掉的是**后一张**的 will-change（症状是"偶尔掉一帧"）。 */
      if (active !== el) el.classList.remove('tilt-on');
    };
    /* ⚠️ **两个句柄都存进 `r.hs`** —— 详见 `stopAll` 的说明（漏一个就是 30 条并发）。 */
    r.hs = [M.animate(r.rx, 0, SPRING), M.animate(r.ry, 0, SPRING)];
    /* `onSettle` 是 motion.js 里**唯一**那份"句柄结束"适配（不许在这里另写一份）。 */
    M.onSettle(r.hs[1], done);
  }

  /* ══ 2 · 委托 · 唯一的一组监听器（绑在 document，不随卡片重建失效）══════ */
  function tiltOf(node) {
    return node && node.closest ? node.closest('[data-tilt]') : null;
  }

  /** 最后一次指针位置。⚠️ **即使当前没有倾斜的卡片也要记** —— 见 `resync()`。 */
  var lastPt = null;

  function onOver(e) {
    var el = tiltOf(e.target);
    if (!el || el === active) return;
    enter(el);
  }

  function onOut(e) {
    var el = tiltOf(e.target);
    if (!el || el !== active) return;
    /* ⚠️ `pointerover` / `pointerout` **会冒泡**，所以卡片内部元素之间移动
       也会派发一对 —— 这时 `relatedTarget` 还在同一张卡里，不该回落。
       （用不冒泡的 `pointerenter/leave` 就没这个问题，但那样得给**每张卡**
       各挂两个监听，而卡片每 3 秒全部重建一次。） */
    var to = e.relatedTarget;
    if (to && el.contains(to)) return;
    /* ⚠️ 真的离开了就**清掉指针位置**：`resync()` 是按位置找卡片的，
       留着它会让"鼠标已经走了、但下一次重绘又把卡片斜起来"
       —— 而用户看到的是"我没碰它，它自己动了"。 */
    lastPt = null;
    leave(el);
  }

  function onMove(e) {
    lastPt = { clientX: e.clientX, clientY: e.clientY };
    move(e);
  }

  /**
   * 整页重绘之后把倾斜**认回来** —— 由 `app.js` 的 `markTiltables()` 在
   * `onPageShown` 里调一次。
   *
   * ⚠️⚠️ **为什么它必须存在**（这条是本轮实测才发现、并且推翻了我上一版的判断）：
   *    `paintPage()` 每 3 秒 `innerHTML` 重建一次，**正在倾斜的那张卡会被换成
   *    一个全新的节点**。事件委托确实解决了"事件还收得到"，但**状态是新的**：
   *    `--tilt-rx` 被打回 0、`tilt-on` 也不在。
   *    表现是「鼠标停在卡片上不动时，卡片每 3 秒自己正一下再斜回来」——
   *    静态判据看不见、截图看不见，只有真浏览器里连续观察才认得出。
   *    ⇒ 所以 tilt **不是"完全不需要钩子"**，它需要的是**重绘后重算一次**，
   *      而不是 sortable 那种"重绘前挡住"。两者别混。
   */
  function resync() {
    if (!lastPt) return;
    var el = tiltOf(document.elementFromPoint(lastPt.clientX, lastPt.clientY));
    if (!el || el === active) return;
    if (active) leave(active);
    enter(el);
    /* ⚠️ 只 `enter` 不重算角度的话，卡片会"斜着，但角度停留在上一次" ——
       新节点的变量起点是 0，而 `enter` 只加 class 不改变量。 */
    move(lastPt);
  }

  /* ══ 3 · 挂载条件 · 不满足就一个监听都不加 ══════════════════════════════ */
  var enabled = !M.reducedMotion() && !global.matchMedia('(pointer: coarse)').matches;

  global.Tilt = {
    MAX_DEG: MAX_DEG,
    SPRING: SPRING,
    /** 自检用：模块到底挂上了没有、当前斜的是哪一个。 */
    enabled: function () { return enabled; },
    activeEl: function () { return active; },
    /** 只有测试与排查会用：运行期关掉它（页面不会因此丢任何状态）。 */
    setEnabled: function (v) {
      enabled = !!v;
      if (!enabled && active) leave(active);
    },
    /** 整页重绘之后由调用方喊一声（见 `resync()` 的说明）。 */
    resync: resync,
  };

  if (!enabled) return;

  document.addEventListener('pointerover', onOver, { passive: true });
  document.addEventListener('pointermove', onMove, { passive: true });
  document.addEventListener('pointerout', onOut, { passive: true });
})(typeof window !== 'undefined' ? window : globalThis);
