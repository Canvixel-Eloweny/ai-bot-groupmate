#!/usr/bin/env node
/**
 * 开屏性能探针（2026-10-28 · 0.1.5 收尾）
 * ══════════════════════════════════════════════════════════════════════════
 * 只测量，不改产品。量的是**真实开屏 0–5.2s**：
 *   · rAF 相邻帧间隔 p50/p95/max、>20ms / >50ms 帧数
 *   · longtask 条数与最长耗时
 *   · 首屏同源资源 transferSize 合计（gzip 后）
 *   · `__paintStats` 的 builds/skips 与开屏是否已隐藏
 *
 * 做法与 panel-perf 同源：随机端口沙箱面板 + headless Chromium CDP，
 * 但**不跳过开屏**（导航带 `?__splashTest=1`，与 panel-dom 的开屏用例同一开关）。
 *
 * ⚠️ headless 是软件光栅，绝对数字 ≠ 真实窗口帧率；只用同一台机器的前后对比。
 * ⚠️ 不进 `npm run verify`。跑法：`npm run perf:splash`
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
const CANDIDATES = [
  EDGE,
  ...(fs.existsSync(`${process.env.HOME}/Library/Caches/ms-playwright`)
    ? fs.readdirSync(`${process.env.HOME}/Library/Caches/ms-playwright`)
      .filter((d) => d.startsWith('chromium'))
      .map((d) => `${process.env.HOME}/Library/Caches/ms-playwright/${d}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`)
    : []),
];
const BROWSER = CANDIDATES.find((p) => fs.existsSync(p));
if (!BROWSER) {
  console.log('SKIP：本机没有可用的 Chromium 系内核，跳过开屏性能探针');
  process.exit(0);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
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
const profile = path.join(os.tmpdir(), `panel-splash-perf-${process.pid}-${Date.now()}`);
const USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-splash-userdata-'));

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
  if (!target) throw new Error('浏览器的 CDP 目标没出现');

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
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `window.__spFrames = [];
      window.__spLong = [];
      (function tick(t) { window.__spFrames.push(t); requestAnimationFrame(tick); })(performance.now());
      try {
        new PerformanceObserver(function (l) {
          l.getEntries().forEach(function (e) { window.__spLong.push(e.duration); });
        }).observe({ entryTypes: ['longtask'] });
      } catch (e) {}`,
  });
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 2, mobile: false });
  await send('Page.navigate', { url: `${BASE}/?__splashTest=1` });

  /* 4.25s 动画 + 0.46s 淡出 + 余量；这段时间不做任何驱动，只让页面自己跑。 */
  await sleep(5600);

  const out = await evalJs(`
    const frames = Array.isArray(window.__spFrames) ? window.__spFrames.slice() : [];
    const t0 = frames.length ? frames[0] : 0;
    const rel = frames.map((t) => t - t0).filter((t) => t <= 5200);
    const deltas = [];
    for (let i = 1; i < rel.length; i++) deltas.push(rel[i] - rel[i - 1]);
    const sorted = deltas.slice().sort((a, b) => a - b);
    const pick = (q) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] : 0;
    const res = performance.getEntriesByType('resource').filter((e) => e.name.indexOf(location.origin) === 0);
    const sum = (key) => res.reduce((n, e) => n + (Number(e[key]) || 0), 0);
    const splash = document.getElementById('bootSplash');
    return {
      frames: rel.length,
      frame_p50: +pick(0.5).toFixed(2),
      frame_p95: +pick(0.95).toFixed(2),
      frame_max: +(deltas.length ? Math.max.apply(null, deltas) : 0).toFixed(2),
      over20: deltas.filter((d) => d > 20).length,
      over50: deltas.filter((d) => d > 50).length,
      longtasks: window.__spLong.length,
      long_max: +(window.__spLong.length ? Math.max.apply(null, window.__spLong) : 0).toFixed(2),
      transfer: sum('transferSize'),
      encoded: sum('encodedBodySize'),
      decoded: sum('decodedBodySize'),
      builds: window.__paintStats ? window.__paintStats.builds : null,
      skips: window.__paintStats ? window.__paintStats.skips : null,
      splashHidden: splash ? !!splash.hidden : null,
    };
  `);

  console.log(`SPLASH_PERF page=running-overview frames=${out.frames} frame_p50_ms=${out.frame_p50} frame_p95_ms=${out.frame_p95} frame_max_ms=${out.frame_max}`);
  console.log(`SPLASH_PERF over20=${out.over20} over50=${out.over50} longtasks=${out.longtasks} long_max_ms=${out.long_max}`);
  console.log(`SPLASH_PERF transfer_bytes=${out.transfer} encoded_bytes=${out.encoded} decoded_bytes=${out.decoded}`);
  console.log(`SPLASH_PERF paint_builds=${out.builds} paint_skips=${out.skips} splash_hidden=${out.splashHidden}`);
  if (!out.splashHidden) {
    console.log('⚠️ 5.6s 时开屏仍未隐藏 —— 探针数字不能代表完整开屏');
    process.exitCode = 1;
  }
} catch (e) {
  console.error('SPLASH_PERF 失败：', e && e.message ? e.message : e);
  process.exitCode = 1;
} finally {
  hardCleanup();
}
