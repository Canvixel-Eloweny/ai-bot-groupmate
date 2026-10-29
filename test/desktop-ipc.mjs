/**
 * P3-2 · Electron IPC 重启/退出真机测试（需要本机 Electron）。
 *
 * 覆盖判据里的两条：
 *   ① 后端未起、窗口已开：错误页有明确表达，并能从窗口里把后端重新拉起；
 *   ② 面板重启 / 退出走 IPC；浏览器仍能通过原 HTTP 路由完成同样动作。
 *
 * 用独立临时用户根 + QQBOT_SANDBOX=1，不碰真机面板/机器人/配置。
 * 跑法：NODE_OPTIONS= node test/desktop-ipc.mjs
 * 没有 Electron 时 SKIP + exit 0（与 panel-dom 的浏览器缺失同一取向）。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import panelDiscovery from '../src/panel-discovery.cjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IS_WIN = process.platform === 'win32';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const EVIDENCE = process.env.P3_IPC_EVIDENCE_DIR || path.join(os.tmpdir(), 'p3-2-ipc-evidence');
/** Electron 输出在 catch 里也要能读 —— 放进 try 的块级作用域会让失败诊断本身抛 ReferenceError。 */
let shellLog = '';

function findElectron() {
  const override = String(process.env.P3_IPC_ELECTRON || '').trim();
  if (override && fs.existsSync(override)) return override;
  const dist = path.join(ROOT, 'node_modules', 'electron', 'dist');
  if (IS_WIN) return fs.existsSync(path.join(dist, 'electron.exe')) ? path.join(dist, 'electron.exe') : '';
  if (process.platform === 'darwin') {
    const p = path.join(dist, 'Electron.app', 'Contents', 'MacOS', 'Electron');
    return fs.existsSync(p) ? p : '';
  }
  return fs.existsSync(path.join(dist, 'electron')) ? path.join(dist, 'electron') : '';
}

const ELECTRON = findElectron();
if (!ELECTRON) {
  console.log('SKIP P3-2 Electron IPC：本机没有 node_modules/electron 运行时（npm ci 后会跑）。');
  process.exit(0);
}

function freePort() {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.on('error', rej);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
  });
}

function tcpUp(port, ms = 500) {
  return new Promise((res) => {
    const s = net.connect({ port, host: '127.0.0.1' });
    const done = (v) => { s.destroy(); res(v); };
    s.setTimeout(ms); s.on('connect', () => done(true));
    s.on('timeout', () => done(false)); s.on('error', () => done(false));
  });
}

async function waitFor(fn, ms, what) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < ms) {
    try { const v = await fn(); if (v) return v; last = v; } catch (e) { last = e; }
    await sleep(250);
  }
  throw new Error(`等待超时：${what}${last instanceof Error ? `（${last.message}）` : ''}`);
}

function killPid(pid, tree = true) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (IS_WIN) {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 8000 });
  } else {
    try { process.kill(pid, 'SIGTERM'); } catch { /* 已退 */ }
    if (tree) setTimeout(() => { try { process.kill(pid, 'SIGKILL'); } catch { /* 已退 */ } }, 3000).unref?.();
  }
}

async function http(port, route, { method = 'GET', token = '', origin = '', body = '' } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (origin) headers.Origin = origin;
  if (body) headers['Content-Type'] = 'application/json';
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 8000);
  try {
    const res = await fetch(`http://127.0.0.1:${port}${route}`, { method, headers, body: body || undefined, signal: ac.signal });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { json = null; }
    return { status: res.status, text, json };
  } catch (e) {
    return { status: 0, text: e && e.message ? e.message : String(e), json: null };
  } finally { clearTimeout(timer); }
}

function cdpConnect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let seq = 0;
  const pend = new Map();
  ws.onmessage = (e) => {
    let m;
    try { m = JSON.parse(e.data); } catch { return; }
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
  };
  const ready = new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const send = (method, params = {}, timeout = 15000) => new Promise((resolve) => {
    const id = ++seq;
    const timer = setTimeout(() => { pend.delete(id); resolve({ __timeout: true }); }, timeout);
    pend.set(id, (m) => { clearTimeout(timer); resolve(m); });
    ws.send(JSON.stringify({ id, method, params }));
  });
  return {
    ws,
    ready,
    send,
    close: () => { try { ws.close(); } catch { /* 已断 */ } },
    async evalJs(expression, timeout = 15000) {
      const m = await send('Runtime.evaluate', {
        expression, returnByValue: true, awaitPromise: true,
      }, timeout);
      if (m.__timeout) throw new Error('CDP 求值超时');
      if (m.result?.exceptionDetails) {
        throw new Error(`页面求值抛错：${JSON.stringify(m.result.exceptionDetails).slice(0, 300)}`);
      }
      return m.result?.result?.value;
    },
  };
}

async function shot(cdp, name) {
  try {
    fs.mkdirSync(EVIDENCE, { recursive: true });
    const m = await cdp.send('Page.captureScreenshot', { format: 'png' }, 10000);
    if (m.result?.data) {
      const file = path.join(EVIDENCE, name);
      fs.writeFileSync(file, Buffer.from(m.result.data, 'base64'));
      return file;
    }
  } catch { /* 隐藏窗口可能截不到，不影响功能判据 */ }
  return '';
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'estrella-p3-ipc-'));
const config = path.join(tmp, 'config.json');
fs.copyFileSync(path.join(ROOT, 'config.example.json'), config);

let electron = null;
let cdp = null;
let panelPid = 0;
let passed = false;

try {
  const closedPort = await freePort();
  const cdpPort = await freePort();
  const env = {
    ...process.env,
    NODE_OPTIONS: '',
    QQBOT_MODE: 'dev',
    QQBOT_SANDBOX: '1',
    QQBOT_USER_ROOT: tmp,
    QQBOT_CONFIG: config,
    QQBOT_ELECTRON_USERDATA: path.join(tmp, 'electron'),
    QQBOT_PANEL_URL: `http://127.0.0.1:${closedPort}/`,
    QQBOT_PANEL_PORT: '0',
    QQBOT_APP_ID: 'com.estrellabot.windows',
    QQBOT_APP_VERSION: '0.1.4',
    QQBOT_START_HIDDEN: '1',
  };
  delete env.ELECTRON_RUN_AS_NODE;
  electron = spawn(ELECTRON, [
    `--remote-debugging-port=${cdpPort}`, '--hidden',
    ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
    path.join(ROOT, 'electron'),
  ], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  shellLog = '';
  electron.stdout.on('data', (d) => { shellLog += String(d); });
  electron.stderr.on('data', (d) => { shellLog += String(d); });
  electron.once('exit', (code) => { shellLog += `\n[electron exit ${code}]\n`; });

  const target = await waitFor(async () => {
    try {
      const list = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
      return list.find((x) => x.type === 'page' && x.webSocketDebuggerUrl) || null;
    } catch { return null; }
  }, 20000, 'Electron 的 CDP 目标出现');

  cdp = cdpConnect(target.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  /* ① 后端未起、窗口已开：错误页必须明确表达，并给出两条出口。 */
  const errPage = await waitFor(async () => {
    const text = await cdp.evalJs('document.body ? document.body.innerText : ""');
    return /控制台没有连上/.test(String(text || '')) ? text : null;
  }, 20000, '错误页出现');
  assert.match(errPage, /窗口还在/);
  assert.match(errPage, /ERR_CONNECTION_REFUSED|控制台没有连上/);
  assert.match(errPage, /重启控制台后端/);
  assert.match(errPage, /退出程序/);
  const errState = await waitFor(async () => {
    const st = await cdp.evalJs(`(async () => {
      const st = await window.estrellaShell.panelState();
      return {
        shell: window.estrellaShell && window.estrellaShell.isShell === true,
        alive: st && st.alive,
        restartVisible: !document.getElementById('restart').hidden,
        quitVisible: !document.getElementById('quit').hidden,
        hasRestart: typeof window.estrellaShell.restartPanel === 'function',
        hasQuitConsole: typeof window.estrellaShell.quitConsole === 'function',
      };
    })()`);
    return st && st.shell ? st : null;
  }, 10000, '错误页拿到壳 API');
  assert.equal(errState.alive, false);
  assert.equal(errState.restartVisible, true);
  assert.equal(errState.quitVisible, true);
  assert.equal(errState.hasRestart, true);
  assert.equal(errState.hasQuitConsole, true);
  const errShot = await shot(cdp, 'p3-2-error-page.png');

  /* ② 从错误页点「重启控制台后端」：主进程在半死状态下直接拉起面板。 */
  await cdp.evalJs(`document.getElementById('restart').click()`);
  const first = await waitFor(() => {
    const info = panelDiscovery.readDiscovery(tmp);
    return info && panelDiscovery.isLive(info) ? info : null;
  }, 40000, '错误页重启后面板写出发现文件');
  panelPid = first.pid;
  const firstHealth = await http(first.port, '/api/health');
  assert.equal(firstHealth.status, 200);
  assert.equal(firstHealth.json.pid, first.pid);
  const firstPage = await waitFor(async () => {
    const href = await cdp.evalJs('location.href');
    const ready = await cdp.evalJs('document.querySelectorAll("#page *").length');
    return String(href).startsWith(`http://127.0.0.1:${first.port}`) && Number(ready) > 5
      ? { href, ready } : null;
  }, 30000, '控制台页面加载出来');
  assert.equal(await cdp.evalJs('document.documentElement.dataset.shell'), 'electron');
  const onlineShot = await shot(cdp, 'p3-2-online.png');

  /* ③ 运行时后端退出：页面必须出现明确横幅，而不是一直转圈。 */
  killPid(first.pid, false);
  const offline = await waitFor(async () => {
    const text = await cdp.evalJs('document.body ? document.body.innerText : ""');
    return /控制台后端没有响应/.test(String(text || ''))
      ? {
        text,
        restart: (await cdp.evalJs('document.querySelectorAll(\'[data-a="panel.restart"]\').length')),
        quit: (await cdp.evalJs('document.querySelectorAll(\'[data-a="panel.quit"]\').length')),
        subline: await cdp.evalJs('document.getElementById("subline").textContent'),
      }
      : null;
  }, 20000, '运行时离线横幅出现');
  assert.ok(offline.restart >= 1, '离线横幅没有「重启面板」按钮');
  assert.ok(offline.quit >= 1, '离线横幅没有「退出控制台」按钮');
  assert.match(offline.subline, /后端未连接/);
  assert.equal(/演示模式/.test(offline.text), false, '壳内离线仍显示演示模式文案');
  const offlineShot = await shot(cdp, 'p3-2-runtime-offline.png');

  /* ④ 从横幅点「重启面板」：走 IPC，主进程直接拉起新面板并重载窗口。 */
  await cdp.evalJs(`document.querySelector('.banner [data-a="panel.restart"]').click()`);
  const second = await waitFor(() => {
    const info = panelDiscovery.readDiscovery(tmp);
    return info && panelDiscovery.isLive(info) && info.pid !== first.pid ? info : null;
  }, 40000, 'IPC 重启后的新面板');
  panelPid = second.pid;
  assert.equal((await http(second.port, '/api/health')).status, 200);
  await waitFor(async () => {
    try {
      const href = await cdp.evalJs('location.href');
      const ready = await cdp.evalJs('document.querySelectorAll("#page *").length');
      return String(href).startsWith(`http://127.0.0.1:${second.port}`) && Number(ready) > 5;
    } catch { return false; }
  }, 30000, 'IPC 重启后页面重新加载');

  /* ⑤ 浏览器仍能走 HTTP：重启路由响应正常，退出路由真的能让面板退出。 */
  const tokenFile = path.join(tmp, 'panel', '.token');
  const token = await waitFor(() => {
    try { return fs.readFileSync(tokenFile, 'utf8').trim() || null; } catch { return null; }
  }, 5000, '面板 token');
  const restartHttp = await http(second.port, '/api/panel/restart', {
    method: 'POST', token, origin: `http://127.0.0.1:${second.port}`,
  });
  assert.equal(restartHttp.status, 200, restartHttp.text);
  assert.equal(restartHttp.json.ok, true, restartHttp.text);
  const quitHttp = await http(second.port, '/api/panel/quit', {
    method: 'POST', token, origin: `http://127.0.0.1:${second.port}`,
  });
  assert.equal(quitHttp.status, 200, quitHttp.text);
  await waitFor(async () => !(await tcpUp(second.port)), 10000, '浏览器路径退出后面板端口关闭');
  panelPid = 0;

  /* ⑥ 页面「退出控制台」走 IPC：壳退出，但不会去停机器人（本测试没有机器人）。
     先把页面等回离线横幅，再点退出按钮；若后端已退，壳仍应能自行退出。 */
  await waitFor(async () => {
    const text = await cdp.evalJs('document.body ? document.body.innerText : ""');
    return /控制台后端没有响应/.test(String(text || '')) ? true : null;
  }, 20000, 'HTTP 退出后页面回到离线横幅');
  // 点下去后壳会立刻退出，CDP 的求值回执可能被一起掐断 —— 这不是失败。
  // 退出前有 confirm；自动化里直接放行（确认框本身不属于本测试的判据）。
  await cdp.evalJs('window.confirm = () => true');
  try {
    await cdp.evalJs(`document.querySelector('.banner [data-a="panel.quit"]').click()`, 1500);
  } catch { /* 窗口正在退出 */ }
  /* `panel.quit` 走站内确认卡（不是 window.confirm）：等它出现后点主按钮。 */
  await sleep(400);
  await cdp.evalJs(`(() => {
    const b = [...document.querySelectorAll('.toast-btn.primary')].pop();
    if (b) b.click();
    return !!b;
  })()`).catch(() => {});
  await waitFor(() => electron.exitCode !== null, 15000, 'IPC 退出控制台后 Electron 退出');
  assert.equal(fs.existsSync(path.join(tmp, 'panel', '.panel.json')), false, '退出后发现文件没清掉');

  console.log(`✓ P3-2 Electron IPC：错误页明确表达 · 半死拉起 ${first.port} · 运行时离线横幅 · `
    + `IPC 重启 ${second.port} · 浏览器 HTTP 重启/退出 · IPC 退出壳`);
  console.log(`  截图目录：${EVIDENCE}`);
  if (errShot || onlineShot || offlineShot) {
    console.log(`  ${[errShot, onlineShot, offlineShot].filter(Boolean).join(' · ')}`);
  }
  passed = true;
} catch (e) {
  console.error(`✗ P3-2 Electron IPC：${e && e.stack ? e.stack : e}`);
  try {
    if (cdp) {
      console.error(`  href=${await cdp.evalJs('location.href')}`);
      console.error(`  shell=${await cdp.evalJs('typeof window.estrellaShell')}`);
      console.error(`  body=${String(await cdp.evalJs('document.body ? document.body.innerText : ""')).slice(0, 500)}`);
    }
  } catch { /* 页面可能已经没了 */ }
  if (shellLog) console.error(`  electron log:\n${shellLog.slice(-3000)}`);
  process.exitCode = 1;
} finally {
  try { cdp && cdp.close(); } catch { /* 已断 */ }
  if (electron && electron.exitCode === null) {
    killPid(electron.pid, true);
    await sleep(800);
  }
  try {
    const info = panelDiscovery.readDiscovery(tmp);
    if (info && panelDiscovery.isLive(info)) killPid(info.pid, true);
  } catch { /* 尽力 */ }
  if (panelPid) killPid(panelPid, true);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 尽力 */ }
  if (!passed) process.exitCode = 1;
}
