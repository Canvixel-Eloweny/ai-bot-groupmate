/**
 * 界面动画帧率上限（2026-11-01）。
 *
 * 默认 0 = 不限：直接走原生 requestAnimationFrame，本文件对现有行为零影响。
 * 设成 30–120 时，把**脚本驱动的**动画回调按目标帧率分批执行；CSS / 毛玻璃 /
 * WAAPI 仍由浏览器合成器按显示器刷新率运行（这一点在设置卡里如实写明）。
 *
 * ⚠️ 三个容易写错的地方：
 *   ① fps=0 必须走原生快路径；给所有 rAF 加一层队列会把一次性回调也延迟一帧；
 *   ② 包装器发出的 id 用高位段（0x40000000 起），与原生 id 隔离 ——
 *      cancelAnimationFrame 不能把"取消自己的排队回调"错取消成原生句柄；
 *   ③ 单条回调抛错不能停掉整个 ticker；逐条 try/catch，异常异步上报。
 */
(() => {
  'use strict';
  if (window.UIFrameRate) return;

  const KEY = 'qqbot-ui-fps';
  const MIN = 30;
  const MAX = 120;
  const ID_BASE = 0x40000000;
  const nativeRAF = window.requestAnimationFrame.bind(window);
  const nativeCAF = window.cancelAnimationFrame.bind(window);

  let fps = 0;
  let nextId = ID_BASE;
  let rafId = 0;
  let lastRun = 0;
  const queue = new Map();

  const normalize = (value) => {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return 0;
    if (n < MIN) return MIN;
    if (n > MAX) return MAX;
    return Math.round(n);
  };

  const read = () => {
    try { return normalize(localStorage.getItem(KEY)); } catch { return 0; }
  };

  const persist = (value) => {
    try {
      if (value === 0) localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, String(value));
    } catch { /* 隐私模式：本次会话仍生效 */ }
  };

  const report = (err) => {
    if (typeof window.reportError === 'function') {
      window.reportError(err);
      return;
    }
    setTimeout(() => { throw err; }, 0);
  };

  function schedule() {
    if (rafId || !queue.size) return;
    rafId = nativeRAF(tick);
  }

  function tick(ts) {
    rafId = 0;
    if (!queue.size) return;
    if (fps > 0) {
      const interval = 1000 / fps;
      if (lastRun && ts - lastRun < interval - 1.5) {
        schedule();
        return;
      }
    }
    lastRun = ts;
    const ids = [...queue.keys()];
    for (const id of ids) {
      const fn = queue.get(id);
      if (!fn) continue; // 同批里被 cancel 掉了
      queue.delete(id);
      try {
        fn(ts);
      } catch (err) {
        report(err);
      }
    }
    if (queue.size) schedule();
  }

  function raf(fn) {
    if (typeof fn !== 'function') return 0;
    if (fps === 0) return nativeRAF(fn);
    const id = ++nextId;
    queue.set(id, fn);
    schedule();
    return id;
  }

  function caf(id) {
    if (typeof id !== 'number') return;
    if (id >= ID_BASE) {
      queue.delete(id);
      return;
    }
    nativeCAF(id);
  }

  function setFps(value) {
    const next = normalize(value);
    if (next === fps) return fps;
    fps = next;
    lastRun = 0;
    persist(fps);
    schedule();
    document.dispatchEvent(new CustomEvent('ui:fps', { detail: { fps } }));
    return fps;
  }

  function measure({ ms = 700 } = {}) {
    return new Promise((resolve) => {
      const duration = Math.max(120, Math.min(3000, Number(ms) || 700));
      const t0 = performance.now();
      let frames = 0;
      let done = false;
      const finish = (hidden = false) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        const elapsedMs = hidden ? 0 : Math.max(0, performance.now() - t0);
        resolve({
          fps: elapsedMs > 0 ? Math.round((frames / elapsedMs) * 1000) : 0,
          frames, elapsedMs, cap: fps,
          ...(hidden ? { hidden: true } : {}),
        });
      };
      const timer = setTimeout(() => finish(true), duration + 600);
      if (document.hidden) { finish(true); return; }
      const step = () => {
        if (done) return;
        frames += 1;
        if (performance.now() - t0 >= duration) { finish(); return; }
        raf(step);
      };
      raf(step);
    });
  }

  window.requestAnimationFrame = raf;
  window.cancelAnimationFrame = caf;
  window.UIFrameRate = {
    KEY, MIN, MAX,
    get: () => fps,
    set: setFps,
    measure,
    stats: () => ({ fps, queued: queue.size, nativeRaf: !!rafId, lastRun }),
  };

  /* 同源 iframe 也会收到 storage 事件 —— 父页改上限后，工厂帧自动跟上。 */
  window.addEventListener('storage', (event) => {
    if (!event || event.key !== KEY) return;
    const next = normalize(event.newValue);
    if (next === fps) return;
    fps = next;
    lastRun = 0;
    schedule();
    document.dispatchEvent(new CustomEvent('ui:fps', { detail: { fps } }));
  });

  document.addEventListener('visibilitychange', () => {
    lastRun = 0;
    if (!document.hidden) schedule();
  });

  document.addEventListener('ui:fps', (event) => {
    const v = event && event.detail ? event.detail.fps : fps;
    try { document.documentElement.setAttribute('data-ui-fps', String(v || 0)); } catch { /* ignore */ }
  });

  fps = read();
  try { document.documentElement.setAttribute('data-ui-fps', String(fps)); } catch { /* ignore */ }
})();
