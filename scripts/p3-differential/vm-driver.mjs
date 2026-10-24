#!/usr/bin/env node
/**
 * P3-3 VM 测量驱动（评估工具，不属于生产更新链）。
 *
 * download 模式：在 VM 上起一个限速/故障 HTTP 服务，用 target 的 update.js 直跑
 *   createUpdater → check → download；不安装。用于整包下载耗时与故障恢复。
 * install 模式：把 base 快照恢复出来，跑 target NSIS /S，再启动 target 面板读 /api/health；
 *   用于整包安装耗时与 current/previous/health/数据保留。
 *
 * 所有产物只写 --work/--out 指定的测试根；不碰真实安装。
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const PORT = 39443;
const MANIFEST_URL = `http://127.0.0.1:${PORT}/latest.json`;
const RUN_TIMEOUT_MS = 20 * 60 * 1000;
const TOKEN = 'p33-test-token';

const args = process.argv.slice(2);
const has = (n) => args.includes(n);
const arg = (n, d = '') => { const i = args.indexOf(n); return i >= 0 ? String(args[i + 1] || '') : d; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowIso = () => new Date().toISOString();

function appendJsonl(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(obj)}\n`);
}

function parseBands(s) {
  return String(s || '5:5,10:5,20:3,0:3').split(',').map((x) => {
    const [mbps, repeats] = x.split(':').map(Number);
    if (!Number.isFinite(mbps) || !Number.isFinite(repeats) || repeats <= 0) throw new Error(`bad band ${x}`);
    return { mbps, repeats };
  });
}

function rateBps(mbps) {
  return mbps > 0 ? (mbps * 1_000_000) / 8 : 0;
}

function makeServer({ targetFile, manifestFile, sigFile, control }) {
  const buf = fs.readFileSync(targetFile);
  const manifest = fs.readFileSync(manifestFile);
  const sig = fs.readFileSync(sigFile);
  const stats = { requests: 0, fileRequests: 0, bytesSent: 0, ranges: 0, faultActions: [] };
  const state = { dropped: false, corrupted: false, stalled: false };
  const server = http.createServer(async (req, res) => {
    const rate = rateBps(control.bandMbps);
    stats.requests += 1;
    const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
    if (u.pathname === '/latest.json') {
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': manifest.length });
      res.end(manifest);
      return;
    }
    if (u.pathname === '/latest.json.sig') {
      res.writeHead(200, { 'content-type': 'text/plain', 'content-length': sig.length });
      res.end(sig);
      return;
    }
    if (u.pathname !== '/file') { res.writeHead(404); res.end('not found'); return; }
    stats.fileRequests += 1;
    const src = u.searchParams.get('src') || 'primary';
    const range = /^bytes=(\d+)-/.exec(req.headers.range || '');
    const start = range ? Number(range[1]) : 0;
    if (range) stats.ranges += 1;
    if (src === 'primary' && control.fault === 'mirror-500') {
      stats.faultActions.push('mirror-500:primary');
      res.writeHead(500); res.end('primary 500'); return;
    }
    if (src === 'primary' && control.fault === 'drop-resume' && !state.dropped) {
      state.dropped = true;
      const half = Math.max(1, Math.floor(buf.length / 2));
      stats.faultActions.push('drop-resume:first-half');
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': buf.length });
      await sendChunked(res, buf.subarray(0, half), rate, stats);
      res.destroy();
      return;
    }
    if (src === 'primary' && control.fault === 'idle-stall' && !state.stalled) {
      state.stalled = true;
      stats.faultActions.push('idle-stall:30s');
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': buf.length });
      await sleep(31_000);
      try { res.destroy(); } catch { /* client aborted */ }
      return;
    }
    const body = start > 0 ? buf.subarray(start) : buf;
    if (src === 'primary' && control.fault === 'corrupt-first' && !state.corrupted && start === 0) {
      state.corrupted = true;
      stats.faultActions.push('corrupt-first:full');
      const bad = Buffer.from(body);
      for (let i = 0; i < Math.min(4096, bad.length); i += 1) bad[i] ^= 0xff;
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': bad.length });
      await sendChunked(res, bad, rate, stats);
      return;
    }
    const headers = {
      'content-type': 'application/octet-stream',
      'content-length': body.length,
    };
    if (range) {
      headers['content-range'] = `bytes ${start}-${buf.length - 1}/${buf.length}`;
      res.writeHead(206, headers);
    } else {
      res.writeHead(200, headers);
    }
    await sendChunked(res, body, rate, stats);
  });
  return { server, stats, state, control };
}

async function sendChunked(res, body, rate, stats) {
  const chunk = 64 * 1024;
  for (let off = 0; off < body.length; off += chunk) {
    const part = body.subarray(off, Math.min(off + chunk, body.length));
    if (!res.write(part)) await new Promise((r) => res.once('drain', r));
    stats.bytesSent += part.length;
    if (rate > 0) await sleep((part.length / rate) * 1000);
  }
  await new Promise((resolve) => res.end(resolve));
}

async function makeUpdater({ stage, updateDir, publicKeyFile }) {
  const modPath = path.join(stage, 'app', 'panel', 'lib', 'update.js');
  const mod = await import(pathToFileURL(modPath).href);
  return mod.createUpdater({
    mode: 'installed',
    sandbox: false,
    appId: 'com.estrellabot.windows',
    appVersion: '0.1.4',
    updateDir,
    installRoot: 'C:\\p33-base',
    programRoot: path.join(stage, 'app'),
    env: { QQBOT_UPDATE_TEST: '1', QQBOT_UPDATE_MANIFEST_URL: MANIFEST_URL },
    publicKeyFile,
    spawnInstaller: async () => {},
    requestShutdown: () => {},
    logger: () => {},
  });
}

async function runDownload({ stage, pub, work, out, band, fault, repeat }) {
  const runId = `${fault || 'full'}-${band}-${repeat}`;
  const runDir = path.join(work, 'runs', runId);
  fs.rmSync(runDir, { recursive: true, force: true });
  fs.mkdirSync(runDir, { recursive: true });
  if (serverRef) resetServer(serverRef, { fault: fault || 'none', bandMbps: band });
  const updater = await makeUpdater({ stage, updateDir: path.join(runDir, 'update'), publicKeyFile: pub });
  const transitions = [];
  const startedAt = nowIso();
  const t0 = Date.now();
  let error = '';
  let check;
  try {
    check = await updater.check({ manual: true });
    transitions.push({ phase: 'checked', atMs: Date.now() - t0, phaseName: check.phase });
    if (check.phase === 'available') {
      const tDownload = Date.now();
      updater.startDownload();
      const deadline = Date.now() + RUN_TIMEOUT_MS;
      let s = updater.snapshot();
      while (s.phase === 'downloading' && Date.now() < deadline) {
        await sleep(100);
        s = updater.snapshot();
      }
      if (s.phase === 'downloading') {
        error = 'download timeout';
        updater.cancel();
        await sleep(300);
        s = updater.snapshot();
      }
      const tEnd = Date.now();
      const received = s.progress && Number.isFinite(s.progress.received) ? s.progress.received : 0;
      const ok = s.phase === 'ready';
      if (!ok && !error) error = s.error || `phase=${s.phase}`;
      const row = {
        schema: 1,
        runId,
        scenario: fault ? 'fault' : 'full',
        fault: fault || null,
        baseId: 'p2-0.1.4-electron',
        bandMbps: band,
        repeat,
        startedAt,
        endedAt: nowIso(),
        targetSha256: check.latest && check.latest.sha256,
        transitions,
        timings: {
          checkMs: tDownload - t0,
          downloadMs: tEnd - tDownload,
          totalMs: tEnd - t0,
        },
        bytes: {
          downloaded: ok ? (check.latest && check.latest.size) : received,
          total: check.latest && check.latest.size,
        },
        outcome: { ok, finalVersion: ok ? '0.1.5' : null, health: ok ? 'ready' : null, error },
        server: serverRef ? { ...serverRef.stats } : null,
      };
      appendJsonl(out, row);
      fs.rmSync(runDir, { recursive: true, force: true });
      return row;
    }
    error = check.error || `phase=${check.phase}`;
  } catch (e) {
    error = e && e.message ? e.message : String(e);
  }
  const row = {
    schema: 1,
    runId,
    scenario: fault ? 'fault' : 'full',
    fault: fault || null,
    baseId: 'p2-0.1.4-electron',
    bandMbps: band,
    repeat,
    startedAt,
    endedAt: nowIso(),
    targetSha256: null,
    transitions,
    timings: { checkMs: Date.now() - t0, downloadMs: null, totalMs: Date.now() - t0 },
    bytes: { downloaded: 0, total: null },
    outcome: { ok: false, finalVersion: null, health: null, error },
    server: serverRef ? { ...serverRef.stats } : null,
  };
  appendJsonl(out, row);
  fs.rmSync(runDir, { recursive: true, force: true });
  return row;
}

let serverRef = null;

function resetServer(srv, { fault = 'none', bandMbps = 0 } = {}) {
  srv.control.fault = fault;
  srv.control.bandMbps = bandMbps;
  srv.state.dropped = false;
  srv.state.corrupted = false;
  srv.state.stalled = false;
  srv.stats.requests = 0;
  srv.stats.fileRequests = 0;
  srv.stats.bytesSent = 0;
  srv.stats.ranges = 0;
  srv.stats.faultActions = [];
}

async function mainDownload() {
  const stage = path.resolve(arg('--stage'));
  const target = path.resolve(arg('--target'));
  const manifest = path.resolve(arg('--manifest'));
  const sig = path.resolve(arg('--sig'));
  const pub = path.resolve(arg('--pub', path.join(stage, 'resources', 'update-pubkey.pem')));
  const out = path.resolve(arg('--out', 'runs-download.jsonl'));
  const work = path.resolve(arg('--work', 'C:\\p33-eval'));
  const bands = parseBands(arg('--bands'));
  let faults = String(arg('--faults', 'drop-resume,corrupt-first,mirror-500,idle-stall')).split(',').map((s) => s.trim()).filter(Boolean);
  if (faults.length === 1 && faults[0] === 'none') faults = [];
  const faultBand = Number(arg('--fault-band', 10));
  const faultRepeats = Number(arg('--fault-repeats', 5));
  const control = { fault: 'none', bandMbps: 0 };
  const srv = makeServer({ targetFile: target, manifestFile: manifest, sigFile: sig, control });
  serverRef = srv;
  await new Promise((resolve, reject) => {
    srv.server.once('error', reject);
    srv.server.listen(PORT, '127.0.0.1', resolve);
  });
  try {
    for (const band of bands) {
      resetServer(srv, { fault: 'none', bandMbps: band.mbps });
      for (let i = 1; i <= band.repeats; i += 1) {
        const row = await runDownload({ stage, pub, work, out, band: band.mbps, fault: '', repeat: i });
        console.log(`  ${row.runId}: ${row.outcome.ok ? 'OK' : 'FAIL'} ${row.timings.downloadMs}ms ${row.outcome.error || ''}`);
      }
    }
    for (const fault of faults) {
      resetServer(srv, { fault, bandMbps: faultBand });
      for (let i = 1; i <= faultRepeats; i += 1) {
        const row = await runDownload({ stage, pub, work, out, band: faultBand, fault, repeat: i });
        console.log(`  ${row.runId}: ${row.outcome.ok ? 'OK' : 'FAIL'} ${row.timings.downloadMs}ms ${row.outcome.error || ''} ${row.server ? JSON.stringify(row.server.faultActions) : ''}`);
      }
    }
  } finally {
    await new Promise((resolve) => {
      srv.server.close(resolve);
      if (typeof srv.server.closeAllConnections === 'function') srv.server.closeAllConnections();
    });
  }
}

function psQuote(s) {
  return String(s).replace(/'/g, "''");
}

function runPowerShell(script, timeoutMs = 600000) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
  });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '', error: r.error ? r.error.message : '' };
}

function killBaseProcesses(base) {
  const quoted = psQuote(base);
  runPowerShell(
    `foreach ($n in @('node.exe','electron.exe')) { ` +
    `Get-CimInstance Win32_Process -Filter "Name='$n'" | ` +
    `Where-Object { $_.ExecutablePath -like '${quoted}\\*' } | ` +
    `ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } }`,
    60_000,
  );
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}

async function waitHealth(user, timeoutMs = 60000) {
  const disc = path.join(user, 'panel', '.panel.json');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const d = readJson(disc);
      const url = d.url || `http://127.0.0.1:${d.port}/`;
      const res = await fetch(new URL('api/health', url));
      if (res.ok) {
        const body = await res.json();
        if (body && body.ok && body.version === '0.1.5') return { url, body };
      }
    } catch { /* not up yet */ }
    await sleep(250);
  }
  return null;
}

async function runInstall({ installer, baseClean, base, userClean, user, out, repeat }) {
  const runId = `install-${repeat}`;
  const startedAt = nowIso();
  killBaseProcesses(base);
  fs.rmSync(base, { recursive: true, force: true });
  fs.rmSync(user, { recursive: true, force: true });
  fs.cpSync(baseClean, base, { recursive: true });
  fs.cpSync(userClean, user, { recursive: true });
  fs.mkdirSync(path.join(user, 'data'), { recursive: true });
  fs.writeFileSync(path.join(user, 'data', 'p33-marker.txt'), `p3-3 ${runId}\n`);
  const targetSha256 = createHash('sha256').update(fs.readFileSync(installer)).digest('hex');
  const t0 = Date.now();
  const r = runPowerShell(
    `$env:QQBOT_INSTALL_TEST='1'; $env:QQBOT_USER_ROOT='${psQuote(user)}'; ` +
    `$p = Start-Process -FilePath '${psQuote(installer)}' -ArgumentList '/S','/D=${psQuote(base)}' -Wait -PassThru; ` +
    `Write-Output ('INSTALL_EXIT=' + $p.ExitCode)`,
    15 * 60 * 1000,
  );
  const installMs = Date.now() - t0;
  let current = null;
  try { current = readJson(path.join(base, 'current.json')); } catch { /* absent */ }
  const runtime = path.join(base, 'runtime', 'node', 'node.exe');
  const panel = path.join(base, 'versions', '0.1.5', 'app', 'panel', 'server.js');
  let child = null;
  let health = null;
  let healthMs = null;
  try {
    child = spawn(runtime, [panel], {
      detached: false,
      windowsHide: true,
      env: {
        ...process.env,
        QQBOT_MODE: 'installed',
        QQBOT_USER_ROOT: user,
        QQBOT_PANEL_TOKEN: TOKEN,
        QQBOT_CONFIG: path.join(user, 'config.json'),
      },
      stdio: 'ignore',
    });
    const tHealth = Date.now();
    health = await waitHealth(user, 90_000);
    healthMs = Date.now() - tHealth;
  } finally {
    try {
      spawnSync(runtime, [path.join(base, 'tools', 'stop.mjs'), '--install-root', base, '--user-root', user, '--include-shell'], {
        timeout: 60_000, windowsHide: true, encoding: 'utf8',
      });
    } catch { /* best effort */ }
    if (child) {
      try { child.kill(); } catch { /* ignore */ }
    }
    killBaseProcesses(base);
  }
  const marker = fs.existsSync(path.join(user, 'data', 'p33-marker.txt'));
  const row = {
    schema: 1,
    runId,
    scenario: 'install',
    baseId: 'p2-0.1.4-electron',
    bandMbps: null,
    repeat,
    startedAt,
    endedAt: nowIso(),
    targetSha256,
    timings: { installMs, healthMs, totalMs: installMs + (healthMs || 0) },
    bytes: {},
    outcome: {
      ok: Boolean(r.code === 0 && current && current.current === '0.1.5' && health && marker),
      finalVersion: current && current.current,
      previousVersion: current && current.previous,
      health: health ? 'ok' : 'fail',
      marker,
      error: r.code === 0 ? '' : `installer exit ${r.code}: ${r.stderr || r.stdout}`.slice(0, 500),
    },
    installer: { exitCode: r.code, stdout: (r.stdout || '').slice(0, 500), stderr: (r.stderr || '').slice(0, 500) },
  };
  appendJsonl(out, row);
  return row;
}

async function mainInstall() {
  const installer = path.resolve(arg('--installer'));
  const baseClean = path.resolve(arg('--base-clean'));
  const base = path.resolve(arg('--base'));
  const userClean = path.resolve(arg('--user-clean'));
  const user = path.resolve(arg('--user'));
  const out = path.resolve(arg('--out', 'runs-install.jsonl'));
  const repeats = Number(arg('--repeats', 3));
  for (let i = 1; i <= repeats; i += 1) {
    const row = await runInstall({ installer, baseClean, base, userClean, user, out, repeat: i });
    console.log(`  ${row.runId}: ${row.outcome.ok ? 'OK' : 'FAIL'} install=${row.timings.installMs}ms health=${row.timings.healthMs}ms current=${row.outcome.finalVersion} prev=${row.outcome.previousVersion} marker=${row.outcome.marker}`);
  }
}

async function main() {
  if (has('--help') || args.length === 0) {
    console.log('download: node vm-driver.mjs download --stage <stage> --target <exe> --manifest <json> --sig <sig> --pub <pem> --out <jsonl> [--bands 5:5,10:5,20:3,0:3] [--faults ...] [--fault-band 10] [--fault-repeats 5]');
    console.log('install:  node vm-driver.mjs install --installer <exe> --base-clean <dir> --base <dir> --user-clean <dir> --user <dir> --out <jsonl> [--repeats 3]');
    return;
  }
  const mode = args[0];
  if (mode === 'download') return mainDownload();
  if (mode === 'install') return mainInstall();
  throw new Error(`unknown mode ${mode}`);
}

main().catch((e) => {
  console.error(`✗ vm-driver：${e && e.stack ? e.stack : e}`);
  process.exitCode = 1;
});
