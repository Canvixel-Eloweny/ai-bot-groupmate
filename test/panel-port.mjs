/**
 * P3-1 · 系统分配端口（2026-10-24）
 *
 * 这一道门盯的是「端口不再写死」的四条真实行为：
 *   ① 8788 被别的进程占着时，面板仍能在系统分配的端口起来；
 *   ② 发现文件（USER_ROOT/panel/.panel.json）与 /api/health 说的是同一个 pid/端口；
 *   ③ Host/Origin 只认**本次实际端口**（错端口 403，对端口放行）；
 *   ④ 面板自重启沿用实际端口，而不是再分配一个（页面 origin 不会失效）。
 *
 * 用独立临时用户根 + QQBOT_SANDBOX=1，不碰真机面板/机器人/配置。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import panelDiscovery from '../src/panel-discovery.cjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PANEL = path.join(REPO, 'panel', 'server.js');
const LEGACY = panelDiscovery.LEGACY_PANEL_PORT;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function logTail(file, n = 24) {
  try {
    return fs.readFileSync(file, 'utf8').split(/\r?\n/).slice(-n).join('\n');
  } catch { return '(no panel log)'; }
}

function request(port, { method = 'GET', path: p = '/api/health', headers = {}, body = '' } = {}) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers, timeout: 4000 }, (res) => {
      let text = '';
      res.on('data', (d) => { text += d; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, text: 'timeout' }); });
    req.on('error', (e) => resolve({ status: 0, text: e.message }));
    if (body) req.write(body);
    req.end();
  });
}

function portOpen(port, timeout = 600) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: '127.0.0.1', timeout });
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('timeout', () => { s.destroy(); resolve(false); });
    s.once('error', () => resolve(false));
  });
}

function killPid(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 8000 });
  } else {
    try { process.kill(pid, 'SIGTERM'); } catch { /* 已退 */ }
  }
}

async function waitFor(fn, ms, what) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await fn();
    if (v) return v;
    await sleep(250);
  }
  throw new Error(`等待超时：${what}`);
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'estrella-p3-port-'));
  const config = path.join(tmp, 'config.json');
  fs.copyFileSync(path.join(REPO, 'config.example.json'), config);
  const logFile = path.join(tmp, 'panel.log');

  // 接受判据②的现场：8788 若空着就自己占住；已被真面板占着也算同一场景（不碰它）。
  let decoy = null;
  let decoyOwned = false;
  if (!(await portOpen(LEGACY, 300))) {
    decoy = net.createServer((s) => s.end('decoy'));
    await new Promise((resolve, reject) => {
      decoy.once('error', reject);
      decoy.listen(LEGACY, '127.0.0.1', resolve);
    });
    decoyOwned = true;
  }

  const logFd = fs.openSync(logFile, 'a');
  const child = spawn(process.execPath, [PANEL], {
    cwd: REPO,
    windowsHide: true,
    stdio: ['ignore', logFd, logFd],
    env: {
      ...process.env,
      NODE_OPTIONS: '',
      QQBOT_SANDBOX: '1',
      QQBOT_USER_ROOT: tmp,
      QQBOT_CONFIG: config,
      QQBOT_PANEL_PORT: '0',
    },
  });
  child.unref();
  let panelPid = Number(child.pid) || 0;
  let passed = false;

  try {
    const first = await waitFor(() => {
      const info = panelDiscovery.readDiscovery(tmp);
      return info && panelDiscovery.isLive(info) ? info : null;
    }, 20000, '面板写出发现文件');
    const port = first.port;

    assert.notEqual(port, LEGACY, '8788 被占用时仍然用了 8788 —— 系统分配端口没有生效');
    assert.equal(first.url, `http://127.0.0.1:${port}/`);
    assert.equal(first.pid, panelPid, '发现文件 pid 不是本次启动的面板');
    const health = await request(port);
    assert.equal(health.status, 200);
    const hb = JSON.parse(health.text);
    assert.equal(hb.ok, true);
    assert.equal(hb.pid, first.pid);
    assert.equal(hb.appId, first.appId);
    assert.equal(hb.version, first.version);

    // Host：只认实际端口。
    assert.equal((await request(port, { headers: { Host: `127.0.0.1:${LEGACY}` } })).status, 403);
    assert.equal((await request(port, { headers: { Host: `127.0.0.1:${port}` } })).status, 200);

    // Origin：写路由错端口 403、对端口放行；不带 Origin 的本机脚本仍放行（原有契约）。
    const token = fs.readFileSync(path.join(tmp, 'panel', '.token'), 'utf8').trim();
    const body = JSON.stringify({ w: 800, h: 600, x: 0, y: 0 });
    const writeHeaders = (origin) => ({
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(origin ? { Origin: origin } : {}),
    });
    const wrong = await request(port, {
      method: 'POST', path: '/api/panel/window', headers: writeHeaders(`http://127.0.0.1:${LEGACY}`), body,
    });
    assert.equal(wrong.status, 403, '错 Origin 的写请求没有被拦下');
    const right = await request(port, {
      method: 'POST', path: '/api/panel/window', headers: writeHeaders(`http://127.0.0.1:${port}`), body,
    });
    assert.equal(right.status, 200, `对 Origin 的写请求被误杀：${right.text}`);
    const noOrigin = await request(port, {
      method: 'POST', path: '/api/panel/window', headers: writeHeaders(''), body,
    });
    assert.equal(noOrigin.status, 200, `不带 Origin 的本机脚本被误杀：${noOrigin.text}`);

    // 自重启：端口必须沿用（页面 origin 不失效），pid 必须换。
    const serverFile = path.join(REPO, 'panel', 'server.js');
    const stat = fs.statSync(serverFile);
    fs.utimesSync(serverFile, new Date(), new Date());
    const restart = await request(port, {
      method: 'POST', path: '/api/panel/restart', headers: writeHeaders(`http://127.0.0.1:${port}`), body: '',
    });
    assert.equal(restart.status, 200, restart.text);
    assert.equal(JSON.parse(restart.text).restarted, true, `面板没进入重启：${restart.text}`);
    const second = await waitFor(() => {
      const info = panelDiscovery.readDiscovery(tmp);
      return info && panelDiscovery.isLive(info) && info.pid !== first.pid ? info : null;
    }, 15000, '重启后的面板写出发现文件');
    assert.equal(second.port, port, '重启换了端口 —— 页面 origin 会失效');
    panelPid = second.pid;
    assert.equal((await request(port)).status, 200);
    fs.utimesSync(serverFile, stat.atime, stat.mtime);

    // 正常退出：发现文件要收掉，端口要关。
    const token2 = fs.readFileSync(path.join(tmp, 'panel', '.token'), 'utf8').trim();
    await request(port, {
      method: 'POST', path: '/api/panel/quit', headers: {
        Authorization: `Bearer ${token2}`, Origin: `http://127.0.0.1:${port}`,
      },
    });
    await waitFor(async () => !(await portOpen(port, 300)), 8000, '面板退出后端口关闭');
    assert.equal(fs.existsSync(path.join(tmp, 'panel', '.panel.json')), false, '退出后发现文件没清掉');

    console.log(`✓ P3-1 系统分配端口：8788 ${decoyOwned ? '被占用（本测试注入）' : '已被占用（沿用现场）'} · `
      + `面板选到 ${port} · 发现文件/健康一致 · Host/Origin 按实际端口 · 重启保端口 · 退出清发现`);
    passed = true;
  } finally {
    if (!passed) console.error(logTail(logFile));
    try { if (fs.existsSync(path.join(tmp, 'panel', '.panel.json'))) killPid(panelDiscovery.readDiscovery(tmp)?.pid || panelPid); } catch { /* 尽力 */ }
    killPid(panelPid);
    fs.closeSync(logFd);
    if (decoy && decoyOwned) await new Promise((r) => decoy.close(r));
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 尽力 */ }
  }
}

main().catch((e) => {
  console.error(`✗ P3-1 系统分配端口：${e && e.message ? e.message : e}`);
  process.exitCode = 1;
});
