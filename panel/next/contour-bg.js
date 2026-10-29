/**
 * Contour Background · 等高线背景（2026-10-26）
 * ══════════════════════════════════════════════════════════════════════════
 * 一句话：一个 30s 无缝循环的 H.264 视频 + 同主题海报，浅色黑线白底、
 * 深色白线黑底；默认档，旧流光仍在设置里完整保留。
 *
 * 硬约束：
 *  ① 层序：`.contour-bg` 与旧 `.shader-bg` 同为 z-index:-2，声明在旧 canvas
 *     之后、自定义背景之前；`html.bg-contour` 是唯一的显示开关。
 *  ② 不抢点击：wrapper `aria-hidden` + CSS `pointer-events:none`。
 *  ③ 省资源：`preload="none"`；只有真正要播时才设 `src`。reduced-motion /
 *     saveData / 无速度 / 设置层打开 / 自定义背景激活时一律暂停。
 *  ④ 低端机：deviceMemory<=4 或 hardwareConcurrency<=4 → 1280×720/20fps 轻量片；
 *     标准片解码失败先退轻量片，再失败退静态海报（海报带极慢 CSS 漂移）。
 *  ⑤ 主题：跟随 `html[data-theme]`；换主题先铺新海报再换源，避免白闪/黑闪。
 *
 * 持久化：`qqbot-bg-mode`（contour|shader，缺省 contour）；速度仍用旧键
 * `qqbot-bgfx-speed`，由 `ShaderBG.setSpeed` 唯一写入，本模块只监听
 * `bgfx:speed` 事件 —— 不给速度开第二个来源。
 */
(() => {
  'use strict';

  const boot = window.__bgModeBoot || {};
  const MODE_KEY = boot.key || 'qqbot-bg-mode';
  const MODES = ['contour', 'shader'];
  const DEFAULT_MODE = 'contour';
  const SPEED_KEY = 'qqbot-bgfx-speed';
  const DEFAULT_SPEED = 66;

  /* 客户端媒体表。服务端 `panel/lib/next-page.js` 的 CONTOUR_MEDIA 是安全主闸，
     这里是引用；两份键与 MIME 由 check-wb §163 逐项比对，别只改一边。 */
  const MEDIA = Object.freeze({
    'contour-light-standard-v2.mp4': 'video/mp4',
    'contour-dark-standard-v2.mp4': 'video/mp4',
    'contour-light-lite-v2.mp4': 'video/mp4',
    'contour-dark-lite-v2.mp4': 'video/mp4',
    'contour-light-v2.jpg': 'image/jpeg',
    'contour-dark-v2.jpg': 'image/jpeg',
  });

  const mediaUrl = (name) => {
    if (!Object.prototype.hasOwnProperty.call(MEDIA, name)) return '';
    /* 2026-10-27 HUD 三处定位调整后浅/深两套内容都变了；文件名仍是 v2
       （媒体表不动），统一用 ?v=4 让 immutable 缓存失效。 */
    return `/assets/contour/${name}?v=4`;
  };
  const videoName = (theme, quality) => `contour-${theme}-${quality}-v2.mp4`;
  const posterName = (theme) => `contour-${theme}-v2.jpg`;

  const readMode = () => {
    try {
      return localStorage.getItem(MODE_KEY) === 'shader' ? 'shader' : 'contour';
    } catch {
      return DEFAULT_MODE;
    }
  };

  const speedList = () => (window.ShaderBG && Array.isArray(window.ShaderBG.SPEEDS)
    ? window.ShaderBG.SPEEDS
    : []);

  const readSpeed = () => {
    let raw = null;
    try { raw = localStorage.getItem(SPEED_KEY); } catch { /* 隐私模式 */ }
    const n = raw == null ? NaN : Number(raw);
    const list = speedList();
    return list.find((s) => s.v === n)
      || list.find((s) => s.v === DEFAULT_SPEED)
      || { v: DEFAULT_SPEED, mul: 1 };
  };

  const pickQuality = (env) => {
    const e = env || {};
    if (e.saveData) return 'poster';
    const mem = Number(e.deviceMemory || 0);
    const cpu = Number(e.hardwareConcurrency || 0);
    if ((mem && mem <= 4) || (cpu && cpu <= 4)) return 'lite';
    return 'standard';
  };

  const envOf = () => ({
    saveData: !!(navigator.connection && navigator.connection.saveData),
    deviceMemory: navigator.deviceMemory,
    hardwareConcurrency: navigator.hardwareConcurrency,
  });

  let layer = null;
  let poster = null;
  let video = null;
  let mode = readMode();
  let theme = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
  let speed = readSpeed();
  let speedMul = speed.mul;
  let quality = 'standard';
  let reduced = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  let hidden = document.hidden;
  let bootHold = false;
  let suppressed = false;
  let settingsOpen = false;
  let srcTheme = null;
  let srcQuality = null;
  let failed = false;
  let triedLite = false;
  let playToken = 0;
  let retryArmed = false;
  let posterTheme = null;
  let state = 'off';

  /* 解析阶段就把旧引擎停掉：此时 canvas 还没初始化，setActive 只置标志，
     旧引擎的 DOMContentLoaded init 会看到 active=false，不会画第一帧。 */
  if (mode === 'contour' && window.ShaderBG && typeof window.ShaderBG.setActive === 'function') {
    window.ShaderBG.setActive(false);
  }

  const expectedSrc = () => {
    if (!srcTheme || !srcQuality) return '';
    return mediaUrl(videoName(srcTheme, srcQuality));
  };
  const srcMatches = () => {
    const want = expectedSrc();
    if (!want || !video) return false;
    const current = String(video.currentSrc || '');
    const attr = String(video.getAttribute('src') || '');
    return (current && current.endsWith(want)) || attr.endsWith(want);
  };

  const setState = (next) => {
    state = next;
    if (layer) layer.dataset.contourState = next;
  };

  const shouldPlay = () => mode === 'contour'
    && !suppressed
    && !settingsOpen
    && !hidden
    && !bootHold
    && speedMul > 0
    && !reduced
    && quality !== 'poster'
    && !failed;

  const pauseVideo = () => {
    if (!video) return;
    try { video.pause(); } catch { /* ignore */ }
    if (layer) layer.classList.remove('is-playing');
  };

  const armRetry = () => {
    if (retryArmed) return;
    retryArmed = true;
    const retry = () => {
      document.removeEventListener('pointerdown', retry, true);
      retryArmed = false;
      if (state === 'poster' && mode === 'contour' && !suppressed) apply();
    };
    document.addEventListener('pointerdown', retry, { capture: true });
  };

  const fallback = () => {
    if (!triedLite && quality === 'standard') {
      triedLite = true;
      quality = 'lite';
      srcTheme = null;
      apply();
      return;
    }
    failed = true;
    quality = 'poster';
    apply();
  };

  const setSource = (nextTheme, nextQuality) => {
    if (!video) return false;
    const url = mediaUrl(videoName(nextTheme, nextQuality));
    if (!url) {
      failed = true;
      return false;
    }
    try { video.pause(); } catch { /* ignore */ }
    if (layer) layer.classList.remove('is-playing');
    srcTheme = nextTheme;
    srcQuality = nextQuality;
    video.preload = 'auto';
    video.src = url;
    try { video.load(); } catch { /* ignore */ }
    setState('loading');
    return true;
  };

  const playVideo = () => {
    if (!video || !video.src) return;
    const token = ++playToken;
    const p = video.play();
    if (p && p.catch) {
      p.catch((err) => {
        if (token !== playToken) return;
        if (err && (err.name === 'NotAllowedError' || err.name === 'AbortError')) {
          pauseVideo();
          setState('poster');
          armRetry();
          return;
        }
        fallback();
      });
    }
  };

  const apply = () => {
    if (!layer || !video) return;
    const active = mode === 'contour' && !suppressed;
    document.documentElement.classList.toggle('bg-contour', active);
    if (active) document.documentElement.classList.toggle('bg-dark', theme === 'dark');

    if (active && poster && posterTheme !== theme) {
      const url = mediaUrl(posterName(theme));
      if (url) poster.style.backgroundImage = `url("${url}")`;
      posterTheme = theme;
    }

    if (!shouldPlay()) {
      pauseVideo();
      layer.classList.remove('is-playing');
      layer.classList.toggle('is-static', active && !reduced && speedMul > 0);
      if (active) {
        const dur = Math.max(16, Math.round(48 / Math.max(0.5, speedMul)));
        layer.style.setProperty('--contour-drift-dur', `${dur}s`);
      }
      const posterState = quality === 'poster' || failed || reduced || speedMul <= 0;
      setState(active ? (posterState ? 'poster' : 'idle') : 'off');
      return;
    }

    if (srcTheme !== theme || srcQuality !== quality) {
      if (!setSource(theme, quality)) {
        fallback();
        return;
      }
    }
    layer.classList.remove('is-static');
    if (video.playbackRate !== speedMul) video.playbackRate = speedMul;
    /* 已经在播时不要再走一次 play()：重复 apply（速度事件、主题 no-op 等）会没有
       新的 playing 事件，状态就会永远停在 loading，而画面其实在动。 */
    if (!video.paused && video.readyState >= 2) {
      layer.classList.add('is-playing');
      setState('video');
    } else {
      setState('loading');
      playVideo();
    }
  };

  const setMode = (next) => {
    const m = next === 'shader' ? 'shader' : 'contour';
    if (m === mode) { apply(); return; }
    mode = m;
    try { localStorage.setItem(MODE_KEY, m); } catch { /* ignore */ }
    document.documentElement.setAttribute('data-bg-mode', m);
    if (m === 'shader') {
      document.documentElement.classList.remove('bg-contour');
      if (window.ShaderBG && typeof window.ShaderBG.setActive === 'function') {
        window.ShaderBG.setActive(true);
      }
    } else if (window.ShaderBG && typeof window.ShaderBG.setActive === 'function') {
      window.ShaderBG.setActive(false);
    }
    apply();
  };

  const setSuppressed = (on) => {
    suppressed = !!on;
    apply();
  };

  const setSettingsOpen = (on) => {
    settingsOpen = !!on;
    apply();
  };

  const init = () => {
    layer = document.getElementById('contourBg');
    poster = document.getElementById('contourPoster');
    video = document.getElementById('contourVideo');
    if (!layer || !poster || !video) return;

    theme = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
    quality = reduced ? 'poster' : pickQuality(envOf());
    if (mode === 'contour' && window.ShaderBG && typeof window.ShaderBG.setActive === 'function') {
      window.ShaderBG.setActive(false);
    }

    video.muted = true;
    video.playsInline = true;
    video.loop = true;
    video.preload = 'none';
    if ('disablePictureInPicture' in video) video.disablePictureInPicture = true;

    video.addEventListener('playing', () => {
      if (!srcMatches()) return;
      if (mode !== 'contour' || suppressed || settingsOpen || hidden || speedMul <= 0) {
        pauseVideo();
        return;
      }
      if (video.playbackRate !== speedMul) video.playbackRate = speedMul;
      layer.classList.add('is-playing');
      layer.classList.remove('is-static');
      setState('video');
    });

    video.addEventListener('error', () => {
      if (!video.error || mode !== 'contour' || !srcMatches()) return;
      fallback();
    });

    if (window.matchMedia) {
      const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
      const onReduce = () => {
        reduced = mq.matches;
        quality = reduced ? 'poster' : (quality === 'poster' ? pickQuality(envOf()) : quality);
        apply();
      };
      if (mq.addEventListener) mq.addEventListener('change', onReduce);
      else if (mq.addListener) mq.addListener(onReduce);
    }

    new MutationObserver(() => {
      const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
      if (next === theme) return;
      theme = next;
      apply();
    }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

    document.addEventListener('visibilitychange', () => {
      hidden = document.hidden;
      apply();
    });

    document.addEventListener('bgfx:speed', (e) => {
      const detail = e && e.detail;
      if (!detail || typeof detail.mul !== 'number') return;
      speed = { v: Number(detail.v), mul: detail.mul };
      speedMul = detail.mul;
      apply();
    });

    /* 开屏期间不加载 24MB 视频：只显示 poster / 静态漂移，整层隐藏后再 load + play。 */
    if (window.__bootGate && window.__bootGate.on && !window.__bootGate.done && typeof window.__bootGate.whenDone === 'function') {
      bootHold = true;
      window.__bootGate.whenDone(function () { bootHold = false; apply(); });
    }

    apply();
  };

  window.ContourBG = {
    MODE_KEY,
    MODES: MODES.slice(),
    DEFAULT_MODE,
    MEDIA,
    get mode() { return mode; },
    get theme() { return theme; },
    get state() { return state; },
    get rendition() { return quality; },
    get speed() { return speed; },
    get video() { return video; },
    get poster() { return poster; },
    pickQuality,
    setMode,
    setSuppressed,
    setSettingsOpen,
    refresh: apply,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
