#!/usr/bin/env node
/**
 * 真实面板的等高线背景截图与播放状态采集（开发工具，不参与运行时）。
 *
 *   node scripts/contour-bg/panel-shot.mjs [--out <目录>]
 *
 * 独立随机端口 + 临时 QQBOT_USER_ROOT，不碰真机 8788 / 沙箱 8790 / mock 39992。
 * 输出：panel-light.png / panel-dark.png / panel-1024x768.png / panel-accept.json
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.once('error', reject);
  srv.listen(0, '127.0.0.1', () => {
    const { port } = srv.address();
    srv.close(() => resolve(port));
  });
});

const edgePath = () => {
  const list = [
    process.env.EDGE_PATH,
    process.env.PANEL_DOM_BROWSER,
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  for (const p of list) {
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { /* next */ }
  }
  throw new Error('找不到 Chromium 系浏览器');
};

class CDP {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.seq = 0;
    this.pending = new Map();
  }
  async open() {
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', () => reject(new Error('CDP WebSocket error')), { once: true });
    });
    this.ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)); } catch { return; }
      const slot = msg.id && this.pending.get(msg.id);
      if (!slot) return;
      this.pending.delete(msg.id);
      if (msg.error) slot.reject(new Error(msg.error.message || 'CDP error'));
      else slot.resolve(msg.result);
    });
  }
  send(method, params = {}) {
    const id = ++this.seq;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

const evalJs = async (cdp, expression) => {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || 'evaluate failed');
  return r.result ? r.result.value : undefined;
};

const waitPage = async (cdp, ms = 15000) => {
  for (let i = 0; i < ms / 100; i++) {
    const ready = await evalJs(cdp, 'document.readyState === "complete" && !!(window.ContourBG && window.ShaderBG)').catch(() => false);
    if (ready) return true;
    await sleep(100);
  }
  return false;
};

const waitVideo = async (cdp, ms = 12000) => {
  for (let i = 0; i < ms / 150; i++) {
    const st = await evalJs(cdp, '(window.ContourBG && ContourBG.state) || "off"').catch(() => 'off');
    if (st === 'video' || st === 'poster') return st;
    await sleep(150);
  }
  return 'timeout';
};

const stateOf = (cdp) => evalJs(cdp, `(() => {
  const v = document.getElementById('contourVideo');
  const q = v && v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality() : null;
  return {
    theme: document.documentElement.dataset.theme,
    mode: window.ContourBG ? ContourBG.mode : '',
    rendition: window.ContourBG ? ContourBG.rendition : '',
    state: window.ContourBG ? ContourBG.state : '',
    shaderActive: window.ShaderBG ? ShaderBG.active : null,
    shaderFrames: window.ShaderBG ? ShaderBG.frames : -1,
    bgContour: document.documentElement.classList.contains('bg-contour'),
    bgDark: document.documentElement.classList.contains('bg-dark'),
    poster: document.getElementById('contourPoster').style.backgroundImage,
    video: v ? {
      readyState: v.readyState, videoWidth: v.videoWidth, videoHeight: v.videoHeight,
      currentTime: Number(v.currentTime.toFixed(2)),
      duration: Number.isFinite(v.duration) ? Number(v.duration.toFixed(2)) : null,
      playbackRate: v.playbackRate, paused: v.paused,
      src: v.getAttribute('src') || '', error: v.error ? v.error.code : null,
      dropped: q ? q.droppedVideoFrames : null, decoded: q ? q.totalVideoFrames : null,
    } : null,
  };
})()`);

const shot = async (cdp, file, width, height) => {
  /* 2x DPR：面板是 CSS 矢量，2K 视频又已经是原生 2560×1440；
     用 1x 截图会把"分辨率加高"这件事拍没。 */
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: false });
  await sleep(900);
  const r = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  await fsp.writeFile(file, Buffer.from(r.data, 'base64'));
  return file;
};

async function main() {
  const outDir = path.resolve(arg('--out', path.join(os.homedir(), 'Desktop', 'contour-preview', 'panel')));
  await fsp.mkdir(outDir, { recursive: true });
  const userRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'contour-panel-user-'));
  const panelPort = await freePort();
  const base = `http://127.0.0.1:${panelPort}/`;
  const server = spawn(process.execPath, ['panel/server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      QQBOT_PANEL_PORT: String(panelPort),
      QQBOT_SANDBOX: '1',
      QQBOT_MODE: 'dev',
      QQBOT_USER_ROOT: userRoot,
      NODE_OPTIONS: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverOut = '';
  server.stdout.on('data', (d) => { serverOut += d; });
  server.stderr.on('data', (d) => { serverOut += d; });

  let edge = null;
  let cdp = null;
  try {
    let up = false;
    for (let i = 0; i < 100 && !up; i++) {
      try {
        const r = await fetch(`${base}api/health`, { signal: AbortSignal.timeout(1000) });
        up = r.ok;
      } catch { /* wait */ }
      if (!up) await sleep(200);
    }
    if (!up) throw new Error(`面板没起来：\n${serverOut.slice(-800)}`);

    const debugPort = await freePort();
    const profile = await fsp.mkdtemp(path.join(os.tmpdir(), 'contour-panel-edge-'));
    edge = spawn(edgePath(), [
      '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
      '--no-default-browser-check', '--remote-allow-origins=*',
      `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`,
      '--window-size=1440,900', '--force-device-scale-factor=1', 'about:blank',
    ], { stdio: 'ignore' });

    let target = null;
    for (let i = 0; i < 150 && !target; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
        target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      } catch { /* wait */ }
      if (!target) await sleep(100);
    }
    if (!target) throw new Error('浏览器调试端口没出现页面目标');

    cdp = new CDP(target.webSocketDebuggerUrl);
    await cdp.open();
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `try {
        localStorage.setItem('next-theme', 'light');
        localStorage.setItem('next-splash', 'off');
        localStorage.setItem('qqbot-bg-mode', 'contour');
        localStorage.setItem('qqbot-bgfx-speed', '66');
      } catch (e) {}`,
    });

    await cdp.send('Page.navigate', { url: base });
    if (!await waitPage(cdp)) throw new Error('面板页面没在 15 秒内就绪');
    const lightState = await waitVideo(cdp);
    await sleep(1800);
    const light = await stateOf(cdp);
    await shot(cdp, path.join(outDir, 'panel-light.png'), 1440, 900);

    await evalJs(cdp, `document.documentElement.dataset.theme = 'dark'; true`);
    await sleep(2200);
    const dark = await stateOf(cdp);
    await shot(cdp, path.join(outDir, 'panel-dark.png'), 1440, 900);

    await evalJs(cdp, `document.documentElement.dataset.theme = 'light'; true`);
    await sleep(1800);
    const narrow = await shot(cdp, path.join(outDir, 'panel-1024x768.png'), 1024, 768);
    const narrowState = await stateOf(cdp);

    const report = {
      base,
      lightWait: lightState,
      light,
      dark,
      narrowState,
      shots: {
        light: path.join(outDir, 'panel-light.png'),
        dark: path.join(outDir, 'panel-dark.png'),
        narrow,
      },
    };
    await fsp.writeFile(path.join(outDir, 'panel-accept.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({
      light: { state: light.state, rendition: light.rendition, theme: light.theme, shaderActive: light.shaderActive, video: light.video },
      dark: { state: dark.state, theme: dark.theme, bgDark: dark.bgDark, video: dark.video },
    }, null, 2));
    console.log(`shots -> ${outDir}`);
  } finally {
    if (cdp) cdp.close();
    if (edge) {
      edge.kill('SIGTERM');
      await sleep(300);
      if (edge.exitCode == null) edge.kill('SIGKILL');
    }
    server.kill('SIGTERM');
    await sleep(400);
    if (server.exitCode == null) server.kill('SIGKILL');
    await fsp.rm(userRoot, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((e) => {
  console.error(`✗ ${e.message}`);
  process.exitCode = 1;
});