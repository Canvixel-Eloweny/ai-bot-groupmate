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
