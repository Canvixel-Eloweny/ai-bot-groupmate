/**
 * Shader Background · 背景引擎（2026-10-04 · 替换 .aurora 六团流体）
 * ══════════════════════════════════════════════════════════════════════════
 *  一句话：一个 <canvas> + WebGL 片元着色器，画出「颗粒渐变（grain gradient）」
 *  背景 —— 多团颜色被噪声场揉在一起、带胶片颗粒、缓慢流动。
 *  参考对象是 beui 的 ShaderBackground（mesh-gradient / grain-gradient 两族），
 *  **不引它的依赖**（React / motion / tailwind 一概不要）—— 本项目零构建。
 *
 *  ⚠️ 三条硬约束（与旧流体层同样的纪律）：
 *  ① 层序：canvas 固定 `z-index:-2`，排在 `<body>` 最前 ——
 *     负层号之间比"谁先声明"，玻璃背板（body.eg-on::before）是 -1，
 *     排后面它会浮到玻璃背板之上，两层光效叠成脏块。
 *  ② 装饰不吃点击：`pointer-events:none` + `aria-hidden`，铺满视口不进无障碍树。
 *  ③ 关动效就真停：`prefers-reduced-motion: reduce` → 只画一帧、不进 rAF 循环
 *     （不是"放慢"，是停）。
 *
 *  性能：一帧只画一次全屏三角形；DPR 封顶 1.5；document.hidden 时暂停 rAF；
 *  **resize 防抖 160ms**（B32：拖窗口时 `canvas.width=` 每次都重分配显存，不防抖会顿）。
 *  实测（Edge headless 1440×1000 软件光栅；绝对值是真机 GPU 的**上限**，比例有效）：
 *    背景动 + 玻璃开 p50 = 29ms ｜ 背景停 + 玻璃开 p50 = 16.7ms（满帧）
 *    ⇒ 成本**全部**来自"每帧重画"；静止时 GPU 层缓存直接复用、一分不花。
 *    对照上一代 `.aurora` 六团纯 CSS：同环境 45ms，且它停不下来（纯 CSS 循环）。
 *  兜底：拿不到 WebGL 上下文 → 退到 2D 渐变（静态但颜色一致），fail-open。
 *  持久化：localStorage `qqbot-bgfx`（只影响这一页，不改机器人任何行为）。
 */

(() => {
  'use strict';

  /* ── 预设闭集合（选择器与持久化的唯一来源）──────────────────────────────
   * ⚠️ 颜色只住在这里（JS），不进 style.css —— 那边有"零就地色值"契约。
   * grain-* = 颗粒渐变（重点两档是 pastel / sunset）；mesh-* = 网格渐变。 */
  const VARIANTS = [
    {
      id: 'grain-pastel', label: '粉彩', kind: 'grain',
      colors: ['#ffd6e8', '#c9e4ff', '#fff3c4', '#d9c9ff'], back: '#ffffff',
      soft: 0.85, speed: 0.30, dist: 0.55, swirl: 0.10, grain: 0.085, scale: 2.1,
    },
    {
      id: 'grain-sunset', label: '落日', kind: 'grain',
      colors: ['#ff7a00', '#ff2e93', '#ffce54', '#8a2be2'], back: '#1a0500',
      soft: 0.70, speed: 0.40, dist: 0.65, swirl: 0.15, grain: 0.115, scale: 2.0,
    },
    {
      id: 'grain-ocean', label: '海雾', kind: 'grain',
      colors: ['#7fd8ff', '#2f509b', '#cdc8e6', '#00bfff'], back: '#eaf6ff',
      soft: 0.75, speed: 0.32, dist: 0.60, swirl: 0.12, grain: 0.09, scale: 2.1,
    },
    {
      id: 'grain-violet', label: '电紫', kind: 'grain',
      colors: ['#7300ff', '#eba8ff', '#00bfff', '#2a00ff'], back: '#05000c',
      soft: 0.60, speed: 0.45, dist: 0.70, swirl: 0.18, grain: 0.12, scale: 2.2,
    },
    {
      id: 'mesh-aurora', label: '极光', kind: 'grain',
      colors: ['#00ffb2', '#0072ff', '#a200ff', '#03303a'], back: '#001a2c',
      soft: 0.65, speed: 0.30, dist: 0.60, swirl: 0.30, grain: 0.07, scale: 1.9,
    },
    {
      id: 'mesh-citrus', label: '柑橘', kind: 'grain',
      colors: ['#fff200', '#ff8a00', '#ff3d00', '#ffe08a'], back: '#2b1600',
      soft: 0.70, speed: 0.50, dist: 0.70, swirl: 0.20, grain: 0.10, scale: 2.0,
    },
    {
      id: 'grain-ember', label: '余烬', kind: 'grain',
      colors: ['#ff5100', '#ffce00', '#7a1000', '#ffdca8'], back: '#0a0000',
      soft: 0.62, speed: 0.35, dist: 0.60, swirl: 0.14, grain: 0.13, scale: 2.1,
    },
    {
      id: 'grain-dawn', label: '拂晓', kind: 'grain',
      colors: ['#f6a1c8', '#7597de', '#2b1055', '#ffd6e8'], back: '#0d0221',
      soft: 0.70, speed: 0.30, dist: 0.55, swirl: 0.16, grain: 0.10, scale: 2.0,
    },
  ];
  const STORE_KEY = 'qqbot-bgfx';
  /* ── 动画速度（B33）：0~100 四档，滑条的唯一数据源 ───────────────────────
   * 用户原话：「范围为 0~100，也可以分为 4 个档：无、慢、中、快」，目前是中。
   * v = 滑条上的读数（吸附到这 4 个点）；mul = 引擎时间倍率 —— 两列分开存，
   * 改档位间隔（比如慢 33→40）不用重推引擎语义。
   * 倍率补全（经验值）：慢 0.5x / 中 1x（= 现行流速，默认档）/ 快 2x；
   * **无 = 0 = 真停**（cancel rAF，不是放慢 —— 与 reduced-motion 同一纪律，
   * 理由见 startLoop：每帧重画是背景成本的大头，静止就该一分不花）。 */
  const SPEEDS = [
    { v: 0, label: '无', mul: 0 },
    { v: 33, label: '慢', mul: 0.5 },
    { v: 66, label: '中', mul: 1 },
    { v: 100, label: '快', mul: 2 },
  ];
  const SPEED_STORE_KEY = 'qqbot-bgfx-speed';
  const SPEED_DEFAULT = 66;                            // 中 = 现行流速

  const hexToRgb = (hex) => {
    const n = parseInt(hex.slice(1), 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  };

  const VERT = 'attribute vec2 a;void main(){gl_Position=vec4(a,0.,1.);}';
  const FRAG = [
    'precision highp float;',
    'uniform vec2 uRes;uniform float uT;',
    'uniform vec3 uC0,uC1,uC2,uC3,uBack;',
    'uniform float uSoft,uDist,uSwirl,uGrain,uScale;',
    'float hash(vec2 p){p=fract(p*vec2(123.34,456.21));p+=dot(p,p+45.32);return fract(p.x*p.y);}',
    'float noise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);',
    ' float a=hash(i),b=hash(i+vec2(1.,0.)),c=hash(i+vec2(0.,1.)),d=hash(i+vec2(1.,1.));',
    ' return mix(mix(a,b,f.x),mix(c,d,f.x),f.y);}',
    'float fbm(vec2 p){float v=0.,a=.5;mat2 r=mat2(.8,.6,-.6,.8);',
    ' for(int i=0;i<5;i++){v+=a*noise(p);p=r*p*2.03+11.7;a*=.5;}return v;}',
    'void main(){',
    ' vec2 uv=(gl_FragCoord.xy-.5*uRes)/min(uRes.x,uRes.y);',
    ' vec2 p=uv*uScale;',
    ' float r=length(p);',
    ' float ang=uSwirl*.9*sin(uT*.3+r*3.);',
    ' float ca=cos(ang),sa=sin(ang);',
    ' p=mat2(ca,-sa,sa,ca)*p;',
    ' vec2 q=vec2(fbm(p+vec2(0.,uT*.35)),fbm(p+vec2(5.2,1.3)-uT*.28));',
    ' p+=uDist*(q-.5)*2.2;',
    ' float n1=fbm(p+vec2(uT*.22,0.));',
    ' float n2=fbm(p+vec2(3.7,2.9)+vec2(0.,-uT*.18));',
    ' float m1=smoothstep(.5-uSoft*.45,.5+uSoft*.45,n1);',
    ' float m2=smoothstep(.5-uSoft*.45,.5+uSoft*.45,n2);',
    ' m1=smoothstep(.18,.82,m1);m2=smoothstep(.18,.82,m2);',
    ' vec3 col=mix(mix(uC0,uC1,m1),mix(uC2,uC3,m1),m2);',
    ' float mask=smoothstep(.15,.85,fbm(p*1.4+vec2(-uT*.12,uT*.09)));',
    ' col=mix(uBack,col,clamp(mask*1.25,0.,1.));',
    ' float g=hash(gl_FragCoord.xy+fract(uT)*vec2(17.,113.))-.5;',
    ' col+=g*uGrain;',
    ' gl_FragColor=vec4(col,1.);',
    '}',
  ].join('\n');

  const reduced = () => window.matchMedia
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  let canvas = null;
  let gl = null;
  let uni = {};
  let currentId = null;
  /* 当前预设的**对象引用**缓存（B32 优化）。
   * ⚠️ 为什么需要它：主循环每帧要两次 `VARIANTS.find(...)`（一次取 speed、
   *    一次传给 drawOnce）。八元素的线性查找开销小到测不出来，但它是**每帧都做**，
   *    而 currentId 只在 setVariant 里变 —— 缓存成对象引用后这段查找彻底消失。
   *    ⚠️ 缓存必须与 currentId **同步更新**，否则切预设后会拿旧参数画：
   *      症状是「点了落日、还是粉彩的流动」但 current 字段已变 —— 最难查的那种。
   *    唯一读它的地方是 variantOf()，改预设走 setVariant → 那里同步。 */
  let curVariant = null;
  /* 当前速度档（B33）：与 curVariant 同一缓存纪律 —— 唯一写点是 setSpeed。 */
  let curSpeed = null;
  /* 速度滑条的绘制函数（buildSpeedUI 赋值；UI 没建出来时为 null）。
   * ⚠️ setSpeed 不直接摸 DOM：引擎层不该知道控件长什么样，只回调"画一下"。 */
  let paintSpeed = null;
  let t = 0;
  let raf = 0;
  let lastTs = 0;
  let frames = 0;            // 逐帧探针用：verify 取两帧差值证明"真的在动"
  let noiseTile = null;      // 2D 兜底用的颗粒贴图（懒生成一次）
  let resizeTimer = 0;       // resize 防抖句柄（B32）：拖窗口时别每帧重建画布

  /** 当前预设对象：唯一读 curVariant 的地方，兜底回第一档。 */
  const variantOf = () => curVariant || VARIANTS[0];

  /* ── WebGL 通路 ──────────────────────────────────────────────────────── */
  function initGL() {
    gl = canvas.getContext('webgl', { antialias: false, depth: false, stencil: false })
      || canvas.getContext('experimental-webgl');
    if (!gl) return false;
    const compile = (type, src) => {
      const sh = gl.createShader(type);
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        throw new Error(gl.getShaderInfoLog(sh) || 'shader compile failed');
      }
      return sh;
    };
    let prog;
    try {
      prog = gl.createProgram();
      gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
      gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        throw new Error(gl.getProgramInfoLog(prog) || 'link failed');
      }
    } catch (e) {
      return false;                       // 编译失败 → 2D 兜底（fail-open）
    }
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'a');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    for (const name of ['uRes', 'uT', 'uC0', 'uC1', 'uC2', 'uC3', 'uBack',
      'uSoft', 'uDist', 'uSwirl', 'uGrain', 'uScale']) {
      uni[name] = gl.getUniformLocation(prog, name);
    }
    return true;
  }

  function drawGL(v) {
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.uniform2f(uni.uRes, canvas.width, canvas.height);
    gl.uniform1f(uni.uT, t);
    gl.uniform3fv(uni.uC0, hexToRgb(v.colors[0]));
    gl.uniform3fv(uni.uC1, hexToRgb(v.colors[1]));
    gl.uniform3fv(uni.uC2, hexToRgb(v.colors[2]));
    gl.uniform3fv(uni.uC3, hexToRgb(v.colors[3]));
    gl.uniform3fv(uni.uBack, hexToRgb(v.back));
    gl.uniform1f(uni.uSoft, v.soft);
    gl.uniform1f(uni.uDist, v.dist);
    gl.uniform1f(uni.uSwirl, v.swirl);
    gl.uniform1f(uni.uGrain, v.grain);
    gl.uniform1f(uni.uScale, v.scale);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    frames += 1;
  }

  /* ── 2D 兜底（颜色一致、无动画；WebGL 不可用时才走）───────────────────── */
  function draw2D(v) {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const w = canvas.width; const h = canvas.height;
    ctx.fillStyle = v.back;
    ctx.fillRect(0, 0, w, h);
    const spots = [[0.22, 0.30, 0.55], [0.78, 0.24, 0.50], [0.30, 0.78, 0.55], [0.80, 0.76, 0.50]];
    v.colors.forEach((c, i) => {
      const [x, y, rr] = spots[i];
      const rad = rr * Math.max(w, h);
      const g = ctx.createRadialGradient(x * w, y * h, 0, x * w, y * h, rad);
      g.addColorStop(0, c);
      g.addColorStop(1, 'transparent');
      ctx.globalAlpha = 0.9;
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    });
    ctx.globalAlpha = 1;
    if (!noiseTile) {
      noiseTile = document.createElement('canvas');
      noiseTile.width = noiseTile.height = 128;
      const nctx = noiseTile.getContext('2d');
      const img = nctx.createImageData(128, 128);
      for (let i = 0; i < img.data.length; i += 4) {
        const val = 128 + (Math.random() - 0.5) * 255;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = val;
        img.data[i + 3] = 255;
      }
      nctx.putImageData(img, 0, 0);
    }
    ctx.globalAlpha = v.grain * 2;
    ctx.globalCompositeOperation = 'overlay';
    for (let y = 0; y < h; y += 128) {
      for (let x = 0; x < w; x += 128) ctx.drawImage(noiseTile, x, y);
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    frames += 1;
  }

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    const w = Math.max(1, Math.round(window.innerWidth * dpr));
    const h = Math.max(1, Math.round(window.innerHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w; canvas.height = h;
    }
  }

  const drawOnce = (v) => (gl ? drawGL(v) : draw2D(v));

  /* ── 主循环 ──────────────────────────────────────────────────────────── */
  function loop(ts) {
    raf = 0;
    if (document.hidden) { lastTs = 0; return; }        // 页签藏起来就停，回来再续
    const dt = lastTs ? Math.min((ts - lastTs) / 1000, 0.1) : 0;
    lastTs = ts;
    const v = variantOf();
    t += dt * v.speed * (curSpeed ? curSpeed.mul : 1);   // B33：速度档乘在时间上
    drawOnce(v);
    raf = requestAnimationFrame(loop);
  }

  function startLoop() {
    /* ⚠️ 三个都不进循环：reduced-motion（真停）· 已经在跑（raf 句柄在）·
       速度档 = 无（mul 0，B33 —— 循环空转重画同一帧是白烧 29ms/帧）。 */
    if (reduced() || raf || !curSpeed || curSpeed.mul <= 0) return;
    lastTs = 0;
    raf = requestAnimationFrame(loop);
  }

  function renderCurrent() {
    const v = variantOf();
    resize();
    drawOnce(v);
  }

  /* ── 选择器（仿 beui ColorSelector：swatch + 弹簧滑动的选中环）────────── */
  function buildPicker() {
    const list = document.getElementById('bgPickList');
    if (!list) return;
    list.innerHTML = '';
    VARIANTS.forEach((v, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'bg-sw';
      b.dataset.id = v.id;
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(v.id === currentId));
      b.setAttribute('aria-label', `背景样式：${v.label}`);
      b.title = v.label;
      b.tabIndex = v.id === currentId ? 0 : -1;
      // swatch 的颜色是**数据驱动**的运行时样式（来源=VARIANTS），不进样式表
      b.style.background = `linear-gradient(135deg, ${v.colors[0]}, ${v.colors[2]})`;
      b.addEventListener('click', () => setVariant(v.id, true));
      b.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
        e.preventDefault();
        const next = (i + (e.key === 'ArrowRight' ? 1 : VARIANTS.length - 1)) % VARIANTS.length;
        setVariant(VARIANTS[next].id, true);
        const el = list.children[next];
        if (el) el.focus();
      });
      list.appendChild(b);
    });
    const ring = document.createElement('span');
    ring.className = 'bg-ring';
    ring.setAttribute('aria-hidden', 'true');
    list.appendChild(ring);
    requestAnimationFrame(() => moveRing());             // 等布局稳定再落环
  }

  function moveRing() {
    const list = document.getElementById('bgPickList');
    if (!list) return;
    const sel = list.querySelector(`[data-id="${currentId}"]`);
    const ring = list.querySelector('.bg-ring');
    if (!sel || !ring) return;
    ring.style.width = `${sel.offsetWidth}px`;
    ring.style.transform = `translateX(${sel.offsetLeft}px)`;
  }

  /* ── 深底档的可读性补偿 ────────────────────────────────────────────────
   * 颗粒渐变是不透明 canvas，会整个盖住 --c-bg。浅底档（粉彩/海雾）没事，
   * 深底档（落日/极光/余烬/拂晓…）下，卡片外的页面标题与面包屑还是深色墨 ——
   * 深字压深底。所以按 back 色的相对亮度给 <html> 挂 `bg-dark` 类，
   * 由 CSS 把那几处翻成浅字（选择器见 style.css「深底档可读性」段）。
   * 阈值 0.35 是经验值：白 (.999) 与 #1a0500 (.013) 之间没有临界档，取中偏松。 */
  const lumOf = (hex) => {
    const [r, g, b] = hexToRgb(hex);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  function applyBackdrop(v) {
    document.documentElement.classList.toggle('bg-dark', lumOf(v.back) < 0.35);
  }

  function setVariant(id, persist) {
    const v = VARIANTS.find((x) => x.id === id);
    if (!v) return;
    currentId = id;
    curVariant = v;                          // ← 与 currentId 同步（B32：漏这行 = 切了不换色）
    applyBackdrop(v);
    renderCurrent();
    if (persist) {
      try { localStorage.setItem(STORE_KEY, id); } catch (e) { /* 隐私模式：不持久化而已 */ }
    }
    const list = document.getElementById('bgPickList');
    if (list) {
      [...list.querySelectorAll('[role="radio"]')].forEach((el) => {
        const on = el.dataset.id === id;
        el.setAttribute('aria-checked', String(on));
        el.tabIndex = on ? 0 : -1;
      });
      moveRing();
    }
  }

  /* ── 启动 ────────────────────────────────────────────────────────────── */
  function saved() {
    try { return localStorage.getItem(STORE_KEY); } catch (e) { return null; }
  }

  /* ── 动画速度（B33）─────────────────────────────────────────────────────
   * 引擎侧只有一个 setSpeed：UI（buildSpeedUI）与探针（window.ShaderBG）都走它。
   * ⚠️ 档位 = 无 时**取消 rAF 并补画一帧**：不是"把倍率乘成 0 让循环空转"——
   *    循环空转每帧仍在重画（实测 29ms/帧），cancel 掉才是真停、GPU 层缓存才生效。
   * ⚠️ 同值重入直接跳过持久化与回弹：拖动时 pointermove 会在同一档上连发。 */
  function setSpeed(v, persist) {
    const s = SPEEDS.find((x) => x.v === v);
    if (!s) return;
    const changed = !curSpeed || curSpeed.v !== v;
    curSpeed = s;
    if (paintSpeed) paintSpeed(changed);                 // 落**新**档才回弹
    if (persist && changed) {
      try { localStorage.setItem(SPEED_STORE_KEY, String(v)); } catch (e) { /* 隐私模式 */ }
    }
    if (s.mul <= 0) {
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
      lastTs = 0;
      renderCurrent();
    } else {
      startLoop();
    }
  }

  function savedSpeed() {
    try { return localStorage.getItem(SPEED_STORE_KEY); } catch (e) { return null; }
  }

  /* ── 动画速度控件（B33→B36）：顶栏下挂小三角 + 展开式步进器 ──────────────
   * B36 用户拍板："算了，用这种按钮效果就可以了"（beui Adaptive Stepper 的形：
   * 圆形 − / 椭圆值 / 圆形 +），中间值显示**档名**（无 / 慢 / 中 / 快，不是数字）。
   * 仍是零依赖原生事件（React / motion / tailwind 一概不要），与 bgpick 同一纪律：
   * 背景引擎自己建自己的控件，不新开文件。
   * ⚠️ 小三角**钉在「背景」色板正下方**（B34 用户原话"移到这儿"）：锚点用
   *    bgPick 的实测位置写 left —— 顶栏右侧内容宽度会漂，写死 right 必错位。 */
  function buildSpeedUI() {
    const anchor = document.getElementById('spdAnchor');
    if (!anchor) return;                                 // 页面没挂锚点 = 不需要控件
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = 'spd-tab';
    tab.setAttribute('aria-expanded', 'false');
    tab.setAttribute('aria-controls', 'spdPanel');
    tab.title = '动画速度';
    const tri = document.createElement('span');
    tri.className = 'spd-tri';
    tri.setAttribute('aria-hidden', 'true');
    tab.appendChild(tri);

    const panel = document.createElement('div');
    panel.className = 'spd-panel';
    panel.id = 'spdPanel';
    const row = document.createElement('div');
    row.className = 'spd-step';
    const dec = document.createElement('button');
    dec.type = 'button';
    dec.className = 'spd-btn';
    dec.textContent = '−';
    dec.setAttribute('aria-label', '调慢动画速度');
    const gear = document.createElement('span');
    gear.className = 'spd-gear';
    gear.setAttribute('aria-live', 'polite');            // 档名变化播给读屏
    const inc = document.createElement('button');
    inc.type = 'button';
    inc.className = 'spd-btn';
    inc.textContent = '+';
    inc.setAttribute('aria-label', '调快动画速度');
    row.append(dec, gear, inc);
    panel.appendChild(row);
    anchor.append(tab, panel);

    const paint = (bounce) => {
      const s = curSpeed;
      const i = SPEEDS.indexOf(s);
      gear.textContent = s.label;
      dec.disabled = i <= 0;                             // 到头就灰（Adaptive Stepper 同款）
      inc.disabled = i >= SPEEDS.length - 1;
      if (bounce) {                        // 换档小弹跳：reflow 强制 keyframes 从头放
        gear.classList.remove('spd-pop');
        void gear.offsetWidth;
        gear.classList.add('spd-pop');
      }
    };
    const step = (dir) => {
      const i = SPEEDS.indexOf(curSpeed) + dir;
      if (i < 0 || i >= SPEEDS.length) return;
      setSpeed(SPEEDS[i].v, true);
    };
    dec.addEventListener('click', () => step(-1));
    inc.addEventListener('click', () => step(1));
    const isOpen = () => anchor.classList.contains('open');
    tab.addEventListener('click', () => {
      anchor.classList.toggle('open');
      tab.setAttribute('aria-expanded', String(isOpen()));
    });
    /* 小三角钉在「背景」色板正下方：顶栏右侧宽度会随内容漂，实测定位最稳。 */
    const positionTab = () => {
      const bp = document.getElementById('bgPick');
      if (!bp) return;
      const r = bp.getBoundingClientRect();
      if (r.width > 0) anchor.style.left = `${Math.round(r.left + r.width / 2)}px`;
    };
    positionTab();
    window.addEventListener('resize', positionTab);
    paintSpeed = paint;
    paint(false);                                        // 首帧先画对，别等第一次交互
  }

  function init() {
    canvas = document.getElementById('shaderBg');
    if (!canvas) return;                                 // 没有画布 = 页面不需要背景（静默退出）
    currentId = saved() && VARIANTS.some((v) => v.id === saved())
      ? saved() : VARIANTS[0].id;
    curVariant = VARIANTS.find((x) => x.id === currentId) || VARIANTS[0];
    /* 速度档：先于 startLoop 恢复 —— 「无」存档时启动就不该进循环。
       ⚠️ 空档不能用裸 `Number(null)`：它**恰好等于 0 =「无」**，
          症状是"新用户打开页面背景永远静止"（B33 探针真踩过）。 */
    const raw = savedSpeed();
    const sv = raw == null ? NaN : Number(raw);
    curSpeed = SPEEDS.find((x) => x.v === sv)
      || SPEEDS.find((x) => x.v === SPEED_DEFAULT);
    if (!initGL()) gl = null;                            // 拿不到就整体走 2D
    applyBackdrop(curVariant);
    renderCurrent();
    buildSpeedUI();
    if (!raf) startLoop();                               // buildSpeedUI→setSpeed 已起过就别叠
    buildPicker();
    if (window.matchMedia) {
      try {
        window.matchMedia('(prefers-reduced-motion: reduce)')
          .addEventListener('change', () => {            // 用户中途开/关动效都要如实响应
            if (reduced()) { if (raf) { cancelAnimationFrame(raf); raf = 0; } renderCurrent(); }
            else startLoop();
          });
      } catch (e) { /* 旧浏览器无 addEventListener 版本：跳过即可 */ }
    }
    /* ⚠️⚠️ **resize 必须防抖（B32 · 2026-10-04）** ——
     *  `canvas.width = w` 不是"改个宽度"：它**清空画布并重新分配整块 GPU 内存**
     *  （规范如此），所以每触发一次就是一次显存申请 + 一次全屏重画。
     *  而拖动窗口边缘时 resize 每秒能来 50–100 次 —— 实测那种"一阵阵地卡"就是它。
     *  ⚠️ 为什么是 160ms：低于它拖动时仍能感到顿挫（画布跟不上窗口），
     *    高于它松手后画面迟迟不更新。160ms 是"跟手"与"不抖"之间的折中（经验值）。
     *  ⚠️ **尾帧必须真的画一次**（`resizeTimer` 归零前那一次 renderCurrent）：
     *    只做"节流首帧"的话，拖动过程中画面会停在旧尺寸上，屏幕上出现一条没画完的边。
     *  ⚠️ 还要顺带 startLoop()：reduced-motion 下画完就停，此时 resize 之后
     *    必须重新评估一次动效开关（用户在系统设置里改过就会走到这条）。 */
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => { resizeTimer = 0; renderCurrent(); startLoop(); }, 160);
    });
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) { renderCurrent(); startLoop(); }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // 探针/调试入口：只读暴露（frames 供 verify 采两帧差值证"在动"）
  window.ShaderBG = {
    VARIANTS,
    SPEEDS,
    get current() { return currentId; },
    /* ⚠️ `variantId` 是**给自检看的**：它读的是缓存 `curVariant` 而不是 currentId，
     *   所以"两者是否同步"这件事本身可被断言（契约 ②'''）。
     *   只暴露 currentId 的话，缓存没同步这件事永远测不出来。 */
    get variantId() { return curVariant ? curVariant.id : null; },
    get frames() { return frames; },
    /* B33：速度档同构暴露 —— `speed` 读缓存 curSpeed（可断言同步），
       setSpeed 走引擎唯一写点（verify 用它切档后取 frames 差值证"真停/真动"）。 */
    get speed() { return curSpeed ? curSpeed.v : null; },
    setSpeed: (v) => setSpeed(v, true),
    set: (id) => setVariant(id, true),
  };
})();
