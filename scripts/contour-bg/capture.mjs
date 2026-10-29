#!/usr/bin/env node
/**
 * Deterministic capture for the contour preview.
 *
 * The preview is the single source of truth for the baked background. This
 * script only drives headed/headless Chromium over raw CDP (Node 24 has a
 * global WebSocket), so the repo stays dependency-free.
 *
 *   node scripts/contour-bg/capture.mjs --selftest
 *   node scripts/contour-bg/capture.mjs --posters /tmp/contour-posters
 *   node scripts/contour-bg/capture.mjs --theme light --quality standard --dir /tmp/contour-light
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PREVIEW = path.join(HERE, 'preview.html');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      out._.push(a);
      continue;
    }
    const key = a.slice(2);
    if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
      out[key] = argv[++i];
    } else {
      out[key] = true;
    }
  }
  return out;
}

function edgePath() {
  const candidates = [
    process.env.EDGE_PATH,
    process.env.PANEL_DOM_BROWSER,
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);
  for (const p of candidates) {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {
      /* try next */
    }
  }
  throw new Error('找不到 Chromium 系浏览器；设置 EDGE_PATH 或 PANEL_DOM_BROWSER');
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

async function waitForTarget(port) {
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 150; i++) {
    try {
      const res = await fetch(`${base}/json/list`);
      if (res.ok) {
        const list = await res.json();
        const page = list.find((t) => t.type === 'page' && /^file:/.test(t.url || ''));
        if (page && page.webSocketDebuggerUrl) return page;
      }
    } catch {
      /* browser not up yet */
    }
    await sleep(100);
  }
  throw new Error(`浏览器调试端口 ${port} 没出现页面目标`);
}

class CDP {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.seq = 0;
    this.pending = new Map();
  }

  async open() {
    await new Promise((resolve, reject) => {
      const ok = () => resolve();
      const bad = (e) => reject(e instanceof Error ? e : new Error('WebSocket error'));
      this.ws.addEventListener('open', ok, { once: true });
      this.ws.addEventListener('error', bad, { once: true });
    });
    this.ws.addEventListener('message', (ev) => {
      let msg;
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
      } catch {
        return;
      }
      if (!msg.id) return;
      const slot = this.pending.get(msg.id);
      if (!slot) return;
      this.pending.delete(msg.id);
      if (msg.error) slot.reject(new Error(`${msg.error.message || 'CDP error'} (${msg.error.code})`));
      else slot.resolve(msg.result);
    });
    this.ws.addEventListener('close', () => {
      for (const slot of this.pending.values()) slot.reject(new Error('CDP socket closed'));
      this.pending.clear();
    });
  }

  send(method, params = {}) {
    const id = ++this.seq;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  close() {
    try { this.ws.close(); } catch { /* ignore */ }
  }
}

async function evaluate(cdp, expr) {
  const res = await cdp.send('Runtime.evaluate', {
    expression: expr,
    returnByValue: true,
    awaitPromise: true,
  });
  if (res.exceptionDetails) {
    const text = res.exceptionDetails.exception?.description
      || res.exceptionDetails.text
      || 'Runtime.evaluate 失败';
    throw new Error(text);
  }
  return res.result ? res.result.value : undefined;
}

function decodeDataUrl(url) {
  const m = /^data:image\/(?:png|jpeg);base64,([\s\S]+)$/.exec(String(url || ''));
  if (!m) throw new Error('截图返回的不是 base64 data URL');
  return Buffer.from(m[1], 'base64');
}

async function waitReady(cdp) {
  for (let i = 0; i < 120; i++) {
    const ready = await evaluate(cdp, '!!(window.ContourPreview && window.ContourPreview.ready)').catch(() => false);
    if (ready) return;
    await sleep(100);
  }
  throw new Error('preview 没有在 12 秒内就绪');
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.selftest && !args.posters && !args.dir) {
    console.log('用法：');
    console.log('  node scripts/contour-bg/capture.mjs --selftest [--legacy]');
    console.log('  node scripts/contour-bg/capture.mjs --posters <目录> [--legacy]');
    console.log('  node scripts/contour-bg/capture.mjs --theme light|dark --quality standard|lite --dir <目录> [--seconds 30] [--limit N] [--legacy]');
    process.exitCode = 1;
    return;
  }

  const exe = edgePath();
  const port = await freePort();
  const profile = await fsp.mkdtemp(path.join(os.tmpdir(), 'contour-edge-'));
  const pageUrl = `${pathToFileURL(PREVIEW).href}?capture=1${args.legacy ? '&legacy=1' : ''}`;
  const stderr = [];
  const child = spawn(exe, [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--allow-file-access-from-files',
    '--remote-allow-origins=*',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--window-size=1600,900',
    '--force-device-scale-factor=1',
    pageUrl,
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  child.stderr.on('data', (chunk) => {
    stderr.push(String(chunk));
    if (stderr.length > 40) stderr.shift();
  });

  let cdp = null;
  try {
    const target = await waitForTarget(port);
    cdp = new CDP(target.webSocketDebuggerUrl);
    await cdp.open();
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await waitReady(cdp);

    if (args.selftest) {
      const h0 = await evaluate(cdp, 'ContourPreview.frameHash(0,"light")');
      const h1 = await evaluate(cdp, 'ContourPreview.frameHash(1,"light")');
      const h30 = await evaluate(cdp, 'ContourPreview.frameHash(30,"light")');
      const d0 = await evaluate(cdp, 'ContourPreview.frameHash(0,"dark")');
      const d30 = await evaluate(cdp, 'ContourPreview.frameHash(30,"dark")');
      const out = { h0, h1, h30, d0, d30, loopLight: h0 === h30, loopDark: d0 === d30, changes: h0 !== h1 };
      console.log(JSON.stringify(out, null, 2));
      if (!out.loopLight || !out.loopDark || !out.changes) process.exitCode = 1;
      return;
    }

    if (args.posters) {
      const outDir = path.resolve(String(args.posters));
      await fsp.mkdir(outDir, { recursive: true });
      for (const theme of ['light', 'dark']) {
        const data = await evaluate(cdp, `ContourPreview.jpg(8,${JSON.stringify(theme)},2560,1440,0.90)`);
        const file = path.join(outDir, `contour-${theme}-v2.jpg`);
        await fsp.writeFile(file, decodeDataUrl(data));
        console.log(`poster ${theme} -> ${file} (${fs.statSync(file).size} B)`);
      }
      return;
    }

    const theme = args.theme === 'dark' ? 'dark' : 'light';
    const quality = args.quality === 'lite' ? 'lite' : 'standard';
    const fps = quality === 'lite' ? 20 : 24;
    const width = quality === 'lite' ? 1280 : 2560;
    const height = quality === 'lite' ? 720 : 1440;
    const seconds = Number(args.seconds || 30);
    const total = Math.max(1, Math.min(
      Number(args.limit || Math.round(fps * seconds)),
      fps * 30,
    ));
    const outDir = path.resolve(String(args.dir));
    await fsp.mkdir(outDir, { recursive: true });
    console.log(`capture ${theme}/${quality} ${width}x${height}@${fps} · ${total} frames -> ${outDir}`);
    const started = Date.now();
    for (let i = 0; i < total; i++) {
      const t = i / fps;
      const data = await evaluate(cdp, `ContourPreview.png(${t},${JSON.stringify(theme)},${width},${height})`);
      const file = path.join(outDir, `${String(i).padStart(5, '0')}.png`);
      await fsp.writeFile(file, decodeDataUrl(data));
      if (i === 0 || (i + 1) % 60 === 0 || i + 1 === total) {
        const elapsed = ((Date.now() - started) / 1000).toFixed(1);
        const rate = ((i + 1) / Math.max(0.1, Date.now() - started) * 1000).toFixed(1);
        console.log(`  ${i + 1}/${total} · ${elapsed}s · ${rate} fps`);
      }
    }
    console.log(`done ${total} frames in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  } finally {
    if (cdp) cdp.close();
    child.kill('SIGTERM');
    await sleep(250);
    if (child.exitCode == null) child.kill('SIGKILL');
    await fsp.rm(profile, { recursive: true, force: true }).catch(() => {});
    if (process.exitCode && stderr.length) {
      console.error('--- browser stderr ---');
      console.error(stderr.join('').slice(-2000));
    }
  }
}

run().catch((e) => {
  console.error(`✗ ${e.message}`);
  process.exitCode = 1;
});
