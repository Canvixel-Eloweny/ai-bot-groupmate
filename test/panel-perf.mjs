/**
 * 面板重画性能基线（2026-10-22 · 只测量，不改产品代码）
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么需要它：`panel/next/app.js` 每 3 秒 `refresh()` 一次，`softPaint()` 会
 * 经 `paintPage(false)` 重建整个 `#page`。以前只有“重画次数”和 FPS 判据，
 * 没有“一次重画到底花多久 / 100 次后堆涨多少”的基线；说“优化”没有量具。
 *
 * 做法：起一个隔离沙箱面板（随机端口 + 临时 user root + QQBOT_SANDBOX=1），
 * 用 Edge headless 通过 CDP 打开页面，暂停 3 秒轮询，固定到第一页，预热后
 * 连打 20 次 `window.__nextRepaint()`，记录同步耗时 p50/p95/max、2-rAF 帧耗时，
 * 再跑 100 次看 JSHeapUsedSize / Nodes / LayoutCount 增量。
 *
 * 判据（与 plan 的决策门一致）：
 *   · p95 ≤ 16.7ms 且 100 次堆增长 ≤ 2MB → VERDICT: WITHIN-BUDGET
 *   · 否则 → VERDICT: OVER-BUDGET（exit 2；先复测再决定是否改产品代码）
 *   · 本机没有 Chromium 系浏览器 → SKIP + exit 0（与 panel-dom 同一条纪律）
 *
 * ── 换域切换探针（2026-10-28 · 报表，不参与上面的 VERDICT）──────────────
 * 维护者反馈「从运行/发言切到人设，一级栏与二级栏明显卡顿」。这段量的是
 * **导航动画窗口内有多少内容工作在抢同一批帧**，核心数 `anims_during_dock`
 * = dock 停稳前开始播放的 `psn-*` 入场动画数（应随解耦降到 0），
 * 以及 `page_commit` 落在 dock 开始/停稳之间的哪个位置。
 * A/B 行用运行时开关做归因：背景停 / 玻璃关 / 页级去 blur / 图表动画停；
 * 每一行的数字只用于同一台机器上的横向对比，**不设阈值**。
 *
 * ⚠️ headless 数字 ≠ 真实窗口的绝对帧率；它只用于同一台机器上的前后对比。
 * ⚠️ 不挂进 `npm run verify`：浏览器计时波动不适合当硬门。
 * 跑法：`NODE_OPTIONS= node test/panel-perf.mjs`
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const NODE = process.execPath;
const EDGE = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
const CHROME_CANDIDATES = [
  EDGE,
  ...(fs.existsSync(`${process.env.HOME}/Library/Caches/ms-playwright`)
    ? fs.readdirSync(`${process.env.HOME}/Library/Caches/ms-playwright`)
      .filter((d) => d.startsWith('chromium'))
      .map((d) => `${process.env.HOME}/Library/Caches/ms-playwright/${d}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`)
    : []),
];
const BROWSER = CHROME_CANDIDATES.find((p) => fs.existsSync(p));
if (!BROWSER) {
  console.log('SKIP：本机没有可用的 Chromium 系内核，跳过面板性能基线');
  process.exit(0);
}

const BUDGET_MS = 16.7;
const BUDGET_HEAP_BYTES = 2 * 1024 * 1024;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

const tcpUp = (port, ms = 800) => new Promise((resolve) => {
  const sock = net.connect({ port, host: '127.0.0.1' });
  const done = (v) => { sock.destroy(); resolve(v); };
  sock.setTimeout(ms);
  sock.on('connect', () => done(true));
  sock.on('timeout', () => done(false));
  sock.on('error', () => done(false));
});

const panelPort = await freePort();
const cdpPort = await freePort();
const BASE = `http://127.0.0.1:${panelPort}`;
const profile = path.join(os.tmpdir(), `panel-perf-${process.pid}-${Date.now()}`);
const USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-perf-userdata-'));

/* 人设总览的图表夹具（与 panel-dom 同形状）。没有它，换域探针量到的是空态页面
   —— 雷达/环形/折线全走 `chart-empty`，入场动画少一大半，归因会失真。 */
{
  const now = Date.now();
  fs.mkdirSync(path.join(USERDATA, 'data'), { recursive: true });
  fs.writeFileSync(path.join(USERDATA, 'data', 'bot-state.json'), JSON.stringify({
    mood: 68, arousal: 42, acuteStress: 18, chronicStress: 2.4,
    radar: { warmth: 62, initiative: 48, sensitivity: 56, stability: 71, expressiveness: 43 },
    energy: { physical: 62, cognitive: 71, emotional: 58, will: 66 },
    emotions: { joy: 12, gratitude: 18, hope: 28, curiosity: 42, surprise: 6, anxiety: 4 },
    intent: '守着书房那盏灯，等一句值得接的话。',
    lastEvent: { kind: '被夸', note: '有人夸了它一句。', chatKey: 'group:100000001', at: now - 12000 },
    trend: [54, 55, 56, 52, 58, 60, 57, 62, 66, 61, 64, 63, 68],
    trendAt: now - 12000, updatedAt: now - 12000,
  }, null, 2), 'utf8');
}

const panel = spawn(NODE, ['panel/server.js'], {
  cwd: ROOT,
  env: {
    ...process.env,
    QQBOT_PANEL_PORT: String(panelPort),
    QQBOT_SANDBOX: '1',
    QQBOT_MODE: 'dev',
    QQBOT_USER_ROOT: USERDATA,
    NODE_OPTIONS: '',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let panelOut = '';
panel.stdout.on('data', (d) => { panelOut += d; });
panel.stderr.on('data', (d) => { panelOut += d; });

const browser = spawn(BROWSER, [
  '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
  '--headless', `--remote-debugging-port=${cdpPort}`,
  `--user-data-dir=${profile}`, '--window-size=1440,1100',
  '--hide-scrollbars', '--no-first-run', '--no-default-browser-check', 'about:blank',
], { stdio: 'ignore', detached: true });
browser.unref();

let ws = null;

/* 与 panel-boot / panel-dom 同一套纪律：被 Ctrl-C 打断时 finally 不保证执行。 */
let cleaned = false;
function hardCleanup() {
  if (cleaned) return;
  cleaned = true;
  try { ws && ws.close(); } catch { /* 已断 */ }
  try { process.kill(-browser.pid, 'SIGKILL'); } catch { try { browser.kill('SIGKILL'); } catch { /* 已退 */ } }
  try { panel.kill('SIGKILL'); } catch { /* 已退 */ }
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* 清不掉就留给 tmp */ }
  try { fs.rmSync(USERDATA, { recursive: true, force: true }); } catch { /* 清不掉就留给 tmp */ }
}
for (const [sig, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]]) {
  process.once(sig, () => { hardCleanup(); process.exit(code); });
}
process.on('exit', hardCleanup);

try {
  let up = false;
  for (let i = 0; i < 90 && !up; i++) { up = await tcpUp(panelPort); if (!up) await sleep(200); }
  if (!up) throw new Error(`沙箱面板没起来（端口 ${panelPort}）。启动输出：\n${panelOut.slice(-800)}`);

  let target = null;
  for (let i = 0; i < 80 && !target; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
      target = list.find((x) => x.type === 'page' && x.webSocketDebuggerUrl);
    } catch { /* 还没起来 */ }
    if (!target) await sleep(300);
  }
  if (!target) throw new Error('浏览器的 CDP 目标没出现（渲染进程没起来？）');

  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let seq = 0;
  const pend = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
  };
  const send = (method, params = {}) => new Promise((r) => {
    const id = ++seq;
    pend.set(id, r);
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evalJs = async (expression) => {
    const m = await send('Runtime.evaluate', {
      expression: `(async () => { ${expression} })()`,
      returnByValue: true,
      awaitPromise: true,
    });
    if (m.result?.exceptionDetails) {
      throw new Error('页面里求值抛错：' + JSON.stringify(m.result.exceptionDetails).slice(0, 400));
    }
    return m.result?.result?.value;
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Performance.enable');
  await send('HeapProfiler.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 2, mobile: false });
  await send('Page.navigate', { url: `${BASE}/` });

  let ready = false;
  for (let i = 0; i < 80 && !ready; i++) {
    ready = await evalJs(`
      return document.querySelectorAll('#page .card').length > 0
        && !!(window.__next && window.__next.state && window.__nextRepaint);
    `).catch(() => false);
    if (!ready) await sleep(250);
  }
  if (!ready) throw new Error('首屏 20 秒内没渲染出卡片，或 __next/__nextRepaint 观察孔不在');

  const fixed = await evalJs(`
    window.__nextPauseRefresh(true);
    window.__next.gi = 0;
    window.__next.si = 0;
    window.__nextRepaint();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    return { title: document.querySelector('#page h1')?.textContent || '', cards: document.querySelectorAll('#page .card').length };
  `);
  if (!fixed.title || fixed.cards < 1) throw new Error(`固定页失败：${JSON.stringify(fixed)}`);

  const sample = await evalJs(`
    const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    for (let i = 0; i < 5; i++) { window.__nextRepaint(); await frame(); }
    const rows = [];
    for (let i = 0; i < 20; i++) {
      const t0 = performance.now();
      window.__nextRepaint();
      const t1 = performance.now();
      await frame();
      const t2 = performance.now();
      rows.push({ sync: t1 - t0, frame: t2 - t0, nodes: document.querySelectorAll('#page *').length });
    }
    const pick = (a, p) => a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))];
    const sync = rows.map((r) => r.sync);
    const frames = rows.map((r) => r.frame);
    return {
      title: document.querySelector('#page h1')?.textContent || '',
      cards: document.querySelectorAll('#page .card').length,
      nodes: rows[rows.length - 1].nodes,
      syncP50: pick(sync, 0.5),
      syncP95: pick(sync, 0.95),
      syncMax: Math.max(...sync),
      frameP95: pick(frames, 0.95),
    };
  `);

  const metricOf = async (name) => {
    const m = await send('Performance.getMetrics');
    return Number((m.result?.metrics || []).find((x) => x.name === name)?.value || 0);
  };
  await send('HeapProfiler.collectGarbage');
  await sleep(100);
  const before = {
    heap: await metricOf('JSHeapUsedSize'),
    nodes: await metricOf('Nodes'),
    layout: await metricOf('LayoutCount'),
    style: await metricOf('RecalcStyleCount'),
  };
  await evalJs(`
    const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    for (let i = 0; i < 100; i++) window.__nextRepaint();
    await frame();
  `);
  await send('HeapProfiler.collectGarbage');
  await sleep(100);
  const after = {
    heap: await metricOf('JSHeapUsedSize'),
    nodes: await metricOf('Nodes'),
    layout: await metricOf('LayoutCount'),
    style: await metricOf('RecalcStyleCount'),
  };
  const heapDelta = after.heap - before.heap;
  const nodesDelta = after.nodes - before.nodes;
  const layoutDelta = after.layout - before.layout;
  const over = sample.syncP95 > BUDGET_MS || heapDelta > BUDGET_HEAP_BYTES;

  console.log(`PANEL_PERF page="${sample.title}" cards=${sample.cards} nodes=${sample.nodes}`);
  console.log(`PANEL_PERF sync_p50_ms=${sample.syncP50.toFixed(2)} sync_p95_ms=${sample.syncP95.toFixed(2)} sync_max_ms=${sample.syncMax.toFixed(2)} frame_p95_ms=${sample.frameP95.toFixed(2)}`);
  console.log(`PANEL_PERF heap_before=${before.heap} heap_after=${after.heap} heap_delta_bytes=${heapDelta} nodes_delta=${nodesDelta} layout_delta=${layoutDelta} style_delta=${after.style - before.style}`);
  console.log(`PANEL_PERF budget_ms=${BUDGET_MS} budget_heap_bytes=${BUDGET_HEAP_BYTES}`);
  console.log(`VERDICT: ${over ? 'OVER-BUDGET' : 'WITHIN-BUDGET'}`);

  /* ══════════════════════════════════════════════════════════════════════
     换域切换探针（2026-10-28 · 只出报表，不参与上面的 VERDICT）
     ══════════════════════════════════════════════════════════════════════
     读法：
       · `anims_during_dock` —— dock 宽度动画停稳**之前**开始播放的 `psn-*`
         入场动画数。换域卡顿的主判据：解耦后它应当接近 0（内容在停稳后才起播）。
       · `page_commit` vs `dock_start`/`dock_settle` —— 页面 HTML 落在导航动画
         的哪个位置。现在只让开两帧（≈33ms），而 dock 跑 380ms ⇒ 必然重叠。
       · `during_p95` / `during_max` / `longtask_*` —— 重叠窗口里的帧开销。
       · A/B 行（运行时开关）用来归因：背景停 / 玻璃关 / 页级去 blur / 图表动画停。
     每行跑完立刻还原开关；数字仅用于同一台机器的横向对比，**没有阈值**。 */
  const med = (a) => {
    const v = a.filter((x) => Number.isFinite(x)).sort((x, y) => x - y);
    return v.length ? v[Math.floor(v.length / 2)] : null;
  };
  const r1 = (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : null);
  const SWITCH_ROWS = [
    { id: 'R0', label: '基线', shader: true, glass: true, css: '' },
    { id: 'R1', label: '背景停', shader: false, glass: true, css: '' },
    { id: 'R2', label: '玻璃关', shader: true, glass: false, css: '' },
    { id: 'R3', label: '页级去 blur', shader: true, glass: true, css: 'pagein' },
    { id: 'R4', label: '图表动画停', shader: true, glass: true, css: 'charts' },
  ];
  const trialJs = (row) => `
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const page = document.getElementById('page');
    const nav2wrap = document.getElementById('nav2wrap');
    const inner = document.getElementById('navInner');
    const nav2 = document.getElementById('nav2');
    const groups = () => [...document.querySelectorAll('#nav1 .grp')];
    const byLabel = (txt) => groups().find((b) => String(b.title || b.textContent || '').includes(txt));
    if (!byLabel('运行') || !(byLabel('人格') || byLabel('人设'))) {
      return { err: '找不到一级按钮：' + groups().map((b) => b.title).join(' | ') };
    }

    const hadGlass = document.body.classList.contains('eg-on');
    if (!${row.glass} && hadGlass) document.body.classList.remove('eg-on');
    const bgSpeed = window.ShaderBG ? window.ShaderBG.speed : null;
    if (!${row.shader} && window.ShaderBG) window.ShaderBG.setSpeed(0);
    const cssText = {
      pagein: '@keyframes psn-page-in{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}',
      charts: '.psn .radar-orbit,.psn .radar-grid,.psn .radar-axis,.psn .radar-shape,.psn .radar-point,'
        + '.psn .radar-label,.psn .radar-legend .legend-item,.psn .cyl,.psn .cyl-val,.psn .cyl-label,'
        + '.psn .line-area,.psn .line-path,.psn .line-point,.psn .line-pulse,.psn .pri-row,'
        + '.psn .pri-bar i,.psn .pri-pct{animation:none!important}',
    }[${JSON.stringify(row.css)}] || '';
    const styleEl = document.createElement('style');
    styleEl.id = '__perfSwitchCss';
    if (cssText) { styleEl.textContent = cssText; document.head.appendChild(styleEl); }

    /* 先回到「运行」并等它的 dock 停稳，避免上一次的尾巴污染本次量测。
       ⚠️ 按钮引用不能跨这次点击：renderNav1 会把所有 .grp 摘掉重插，
       点完「运行」之后先前抓到的「人格」已经是游离节点（点了不冒泡、也没报错）。 */
    byLabel('运行').click();
    await sleep(820);
    const persona = byLabel('人格') || byLabel('人设');
    if (!persona || !persona.isConnected) return { err: '换域按钮在「运行」重建后不可用' };
    const cardsBefore = page.querySelectorAll('.card').length;

    const marks = [];
    const mark = (ev) => marks.push([performance.now(), ev]);
    const mo = new MutationObserver((ms) => {
      for (const m of ms) {
        if (m.target === inner) mark('nav1');
        else if (m.target === nav2) mark('nav2');
        else if (m.target === page) mark(m.type === 'childList' ? 'pageChild' : 'pageAttr');
        else if (m.target === nav2wrap) mark('wrap');
      }
    });
    mo.observe(inner, { childList: true, subtree: false });
    mo.observe(nav2, { childList: true, subtree: false });
    mo.observe(page, { childList: true, subtree: false, attributes: true, attributeFilter: ['class', 'data-domain'] });
    mo.observe(nav2wrap, { attributes: true, attributeFilter: ['style'] });
    const onAnim = (e) => { if (/^psn-/.test(e.animationName)) mark('anim'); };
    document.addEventListener('animationstart', onAnim, true);
    const lt = [];
    let po = null;
    try {
      po = new PerformanceObserver((l) => { for (const e of l.getEntries()) lt.push(e.duration); });
      po.observe({ entryTypes: ['longtask'] });
    } catch { po = null; }
    const frames = [];
    let prev = performance.now();
    let stop = false;
    const raf = () => {
      const t = performance.now();
      frames.push([t, t - prev]);
      prev = t;
      if (!stop) requestAnimationFrame(raf);
    };
    requestAnimationFrame(raf);

    const clickT = performance.now();
    persona.click();
    await sleep(1400);
    stop = true;
    await sleep(60);

    mo.disconnect();
    document.removeEventListener('animationstart', onAnim, true);
    if (po) { try { po.disconnect(); } catch { /* 已断 */ } }
    styleEl.remove();
    if (!${row.glass} && hadGlass) document.body.classList.add('eg-on');
    if (!${row.shader} && window.ShaderBG && bgSpeed != null) window.ShaderBG.setSpeed(bgSpeed);

    const at = (ev) => {
      const v = marks.filter((x) => x[1] === ev).map((x) => x[0]);
      return v.length ? v : null;
    };
    const firstAt = (v) => (v ? v[0] - clickT : null);
    const lastAt = (v) => (v ? v[v.length - 1] - clickT : null);
    const anims = at('anim') || [];
    const dockSettle = lastAt(at('wrap'));
    const settleEdge = dockSettle == null ? 420 : dockSettle;
    const during = anims.filter((t) => t - clickT < settleEdge).length;
    const gapStat = (from, to) => {
      const v = frames.filter(([t]) => t >= clickT + from && t <= clickT + to)
        .map(([, g]) => g).sort((a, b) => a - b);
      if (!v.length) return null;
      const pick = (p) => v[Math.min(v.length - 1, Math.floor(v.length * p))];
      return { p50: pick(0.5), p95: pick(0.95), max: v[v.length - 1], n: v.length };
    };
    const duringGap = gapStat(0, settleEdge);
    const afterGap = gapStat(settleEdge, 1400);
    return {
      nav1: firstAt(at('nav1')), nav2: firstAt(at('nav2')),
      pageCommit: firstAt(at('pageChild')), pageAttr: firstAt(at('pageAttr')),
      dockStart: firstAt(at('wrap')), dockSettle,
      animTotal: anims.length, animsDuringDock: during, animsAfterDock: anims.length - during,
      lastAnim: lastAt(at('anim')),
      duringP50: duringGap && duringGap.p50, duringP95: duringGap && duringGap.p95,
      duringMax: duringGap && duringGap.max, afterP95: afterGap && afterGap.p95,
      longTaskN: lt.length, longTaskMax: lt.length ? Math.max(...lt) : 0,
      cardsBefore,
      cards: page.querySelectorAll('.card').length,
      slots: page.querySelectorAll('[data-psn-slot]').length,
      nav2W: Math.round(nav2wrap.getBoundingClientRect().width),
    };
  `;

  const switchRows = [];
  for (const row of SWITCH_ROWS) {
    const n = row.id === 'R0' ? 10 : 6;
    const before = {
      layout: await metricOf('LayoutCount'),
      style: await metricOf('RecalcStyleCount'),
      layoutDur: await metricOf('LayoutDuration'),
      styleDur: await metricOf('StyleDuration'),
    };
    const trials = [];
    for (let i = 0; i < n; i++) {
      const t = await evalJs(trialJs(row));
      if (!t || t.err) throw new Error(`换域探针失败（${row.id}）：${t && t.err ? t.err : '无返回'}`);
      trials.push(t);
    }
    const afterM = {
      layout: await metricOf('LayoutCount'),
      style: await metricOf('RecalcStyleCount'),
      layoutDur: await metricOf('LayoutDuration'),
      styleDur: await metricOf('StyleDuration'),
    };
    const agg = {
      id: row.id,
      label: row.label,
      n,
      nav1: med(trials.map((t) => t.nav1)),
      nav2: med(trials.map((t) => t.nav2)),
      pageCommit: med(trials.map((t) => t.pageCommit)),
      dockStart: med(trials.map((t) => t.dockStart)),
      dockSettle: med(trials.map((t) => t.dockSettle)),
      animTotal: med(trials.map((t) => t.animTotal)),
      animsDuringDock: med(trials.map((t) => t.animsDuringDock)),
      animsAfterDock: med(trials.map((t) => t.animsAfterDock)),
      lastAnim: med(trials.map((t) => t.lastAnim)),
      duringP50: med(trials.map((t) => t.duringP50)),
      duringP95: med(trials.map((t) => t.duringP95)),
      duringMax: med(trials.map((t) => t.duringMax)),
      afterP95: med(trials.map((t) => t.afterP95)),
      longTaskN: med(trials.map((t) => t.longTaskN)),
      longTaskMax: med(trials.map((t) => t.longTaskMax)),
      cards: med(trials.map((t) => t.cards)),
      cardsBefore: med(trials.map((t) => t.cardsBefore)),
      slots: med(trials.map((t) => t.slots)),
      nav2W: med(trials.map((t) => t.nav2W)),
      layoutPerTrial: r1((afterM.layout - before.layout) / n),
      stylePerTrial: r1((afterM.style - before.style) / n),
      layoutDurPerTrial: r1(((afterM.layoutDur - before.layoutDur) / n) * 1000),
      styleDurPerTrial: r1(((afterM.styleDur - before.styleDur) / n) * 1000),
    };
    switchRows.push(agg);
    console.log(`PANEL_PERF_SWITCH row=${agg.id} label=${agg.label} trials=${n} run_cards=${agg.cardsBefore} persona_cards=${agg.cards} slots=${agg.slots} nav2w=${agg.nav2W}`);
    console.log(`PANEL_PERF_SWITCH_TIMELINE row=${agg.id} nav1_ms=${r1(agg.nav1)} nav2_ms=${r1(agg.nav2)} page_commit_ms=${r1(agg.pageCommit)} dock_start_ms=${r1(agg.dockStart)} dock_settle_ms=${r1(agg.dockSettle)} last_anim_ms=${r1(agg.lastAnim)}`);
    console.log(`PANEL_PERF_SWITCH_ANIM row=${agg.id} total=${agg.animTotal} during_dock=${agg.animsDuringDock} after_dock=${agg.animsAfterDock}`);
    console.log(`PANEL_PERF_SWITCH_FRAME row=${agg.id} during_p50_ms=${r1(agg.duringP50)} during_p95_ms=${r1(agg.duringP95)} during_max_ms=${r1(agg.duringMax)} after_p95_ms=${r1(agg.afterP95)} longtask_n=${agg.longTaskN} longtask_max_ms=${r1(agg.longTaskMax)}`);
    console.log(`PANEL_PERF_SWITCH_COST row=${agg.id} layout_per_trial=${agg.layoutPerTrial} style_per_trial=${agg.stylePerTrial} layout_ms_per_trial=${agg.layoutDurPerTrial} style_ms_per_trial=${agg.styleDurPerTrial}`);
  }
  console.log('PANEL_PERF_SWITCH_TABLE 行 | during_p95 | during_max | longtask_max | anims_during_dock | page_commit | dock_settle');
  for (const x of switchRows) {
    console.log(`PANEL_PERF_SWITCH_TABLE ${x.id} ${x.label} | ${r1(x.duringP95)} | ${r1(x.duringMax)} | ${r1(x.longTaskMax)} | ${x.animsDuringDock} | ${r1(x.pageCommit)} | ${r1(x.dockSettle)}`);
  }

  process.exitCode = over ? 2 : 0;
} catch (e) {
  console.error(`✗ 面板性能基线失败：${e && e.message ? e.message : e}`);
  process.exitCode = 1;
} finally {
  try { ws && ws.close(); } catch { /* 已断 */ }
  try { process.kill(-browser.pid, 'SIGKILL'); } catch { try { browser.kill('SIGKILL'); } catch { /* 已退 */ } }
  panel.kill('SIGTERM');
  for (let i = 0; i < 30 && panel.exitCode === null; i++) await sleep(100);
  if (panel.exitCode === null) panel.kill('SIGKILL');
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* 清不掉就算了 */ }
  try { fs.rmSync(USERDATA, { recursive: true, force: true }); } catch { /* 清不掉就留给 tmp */ }
  cleaned = true;
}
