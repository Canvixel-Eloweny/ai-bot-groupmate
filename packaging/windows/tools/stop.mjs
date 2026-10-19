#!/usr/bin/env node
/**
 * 安装/卸载前的停止链（P2 · 2026-10-18）。
 *
 * 为什么不能只调 `/api/panel/quit`：面板的 `shutdown()` **刻意不杀机器人**
 * （机器人是独立进程），而机器人是从 `<InstallRoot>\runtime\node\node.exe`
 * 起的 —— 不停它，安装器就替换不了共享 runtime。
 *
 * 顺序（固定）：
 *   ① 带 token 调 `/api/bridge/stop`（让机器人自己走正常退出/落盘）
 *   ② 调 `/api/panel/quit`
 *   ③ 等端口与锁释放
 *   ④ 仍有残留 ⇒ 按 `install-layout.classifyProcess` 的**精确身份**兜底杀
 *   ⑤ 可选 `--stop-napcat`：只杀命令行落在 `<UserRoot>\napcat` 的进程
 *
 * 只依赖 node: 内置 + 同目录 `lib/install-layout.mjs`；不 import 面板/机器人。
 */

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  classifyProcess,
  isMainModule,
  readCurrentInfo,
  readInstallInfo,
} from './lib/install-layout.mjs';
import { say, sayErr } from './lib/common.mjs';

const DEFAULT_PORT = Number(process.env.QQBOT_PANEL_PORT) || 8788;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));


function argOf(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? String(process.argv[i + 1] || '') : '';
}
const has = (...names) => names.some((n) => process.argv.includes(n));

function portOpen(port, timeout = 800) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: '127.0.0.1' });
    const done = (v) => { s.destroy(); resolve(v); };
    s.setTimeout(timeout);
    s.once('connect', () => done(true));
    s.once('timeout', () => done(false));
    s.once('error', () => done(false));
  });
}

function readToken(userRoot) {
  try {
    return String(fs.readFileSync(path.join(userRoot, 'panel', '.token'), 'utf8')).trim();
  } catch {
    return '';
  }
}

async function post(port, route, token, timeoutMs = 20000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${port}${route}`, {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: ac.signal,
    });
    return { status: res.status, body: (await res.text()).slice(0, 500) };
  } catch (e) {
    return { status: 0, body: e && e.message ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}

function powershellExe() {
  const root = process.env.SystemRoot || 'C:\\Windows';
  const p = path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return fs.existsSync(p) ? p : 'powershell';
}

/** 读全量进程表（Windows 用 CIM；POSIX 用 ps，便于本机纯测试）。 */
export function listProcesses({ platform = process.platform } = {}) {
  if (platform === 'win32') {
    const ps = "$ErrorActionPreference='SilentlyContinue'; "
      + 'Get-CimInstance Win32_Process | '
      + 'Select-Object ProcessId,Name,ExecutablePath,CommandLine | '
      + 'ConvertTo-Json -Compress';
    const r = spawnSync(powershellExe(), ['-NoProfile', '-NonInteractive', '-Command', ps], {
      encoding: 'utf8', windowsHide: true, timeout: 20000, maxBuffer: 16 * 1024 * 1024,
    });
    if (r.error || r.status !== 0) {
      return { ok: false, rows: [], error: r.error ? r.error.message : `powershell 退出码 ${r.status}` };
    }
    let parsed;
    try { parsed = JSON.parse(String(r.stdout || '[]').trim() || '[]'); } catch (e) {
      return { ok: false, rows: [], error: `进程表 JSON 解析失败：${e.message}` };
    }
    const arr = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
    return {
      ok: true,
      rows: arr.map((x) => ({
        pid: Number(x.ProcessId),
        name: String(x.Name || ''),
        execPath: String(x.ExecutablePath || ''),
        cmd: String(x.CommandLine || ''),
      })).filter((x) => Number.isFinite(x.pid) && x.pid > 0),
    };
  }
  const r = spawnSync('ps', ['-Ao', 'pid=,comm=,args='], { encoding: 'utf8', timeout: 10000, maxBuffer: 8 * 1024 * 1024 });
  if (r.error || r.status !== 0) return { ok: false, rows: [], error: r.error ? r.error.message : `ps 退出码 ${r.status}` };
  const rows = String(r.stdout || '').split('\n').map((line) => {
    const m = /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!m) return null;
    return { pid: Number(m[1]), name: path.basename(m[2]), execPath: m[2], cmd: `${m[2]} ${m[3]}` };
  }).filter(Boolean);
  return { ok: true, rows };
}

function versionsOf(installRoot) {
  try {
    const cur = readCurrentInfo(installRoot);
    return [cur && cur.current, cur && cur.previous].filter((v) => typeof v === 'string' && v);
  } catch {
    return [];
  }
}

function killPid(pid, { platform = process.platform, tree = true } = {}) {
  if (platform === 'win32') {
    const args = tree ? ['/PID', String(pid), '/T', '/F'] : ['/PID', String(pid), '/F'];
    const r = spawnSync('taskkill', args, { windowsHide: true, timeout: 10000, encoding: 'utf8' });
    return { ok: !r.error && r.status === 0, out: `${r.stdout || ''}${r.stderr || ''}`.trim() };
  }
  try {
    process.kill(pid, tree ? 'SIGTERM' : 'SIGTERM');
    return { ok: true, out: '' };
  } catch (e) {
    return { ok: false, out: e.message };
  }
}

/** 读一个 pid 文件；读不出来就 0。 */
function readPid(file) {
  try {
    const n = Number.parseInt(String(fs.readFileSync(file, 'utf8')).trim(), 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

/** pid 还活着没有。Windows 用 tasklist（快，不碰 WMI）；POSIX 用 signal 0。 */
function pidAlive(pid, { platform = process.platform } = {}) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  if (platform === 'win32') {
    const r = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH'], {
      encoding: 'utf8', windowsHide: true, timeout: 5000,
    });
    return r.status === 0 && new RegExp(`(^|\\D)${pid}(\\D|$)`).test(r.stdout || '');
  }
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** 面板的 /api/health（2 秒超时；失败回 null）。 */
async function healthInfo(port) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 2000);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: ac.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** NapCat 的进程命令行是否落在 `<userRoot>\napcat` 下（只认这个前缀，不碰外部 NapCat）。 */
export function isNapcatProcess(cmd, userRoot) {
  const text = String(cmd || '');
  if (!text || !userRoot) return false;
  const nap = path.join(userRoot, 'napcat');
  const win = /^[A-Za-z]:[\\/]/.test(nap) || /^[A-Za-z]:[\\/]/.test(text);
  const p = win ? path.win32 : path;
  const needle = p.resolve(nap).toLowerCase();
  const hay = text.toLowerCase();
  if (!hay.includes(needle)) return false;
  // 不能把安装器/面板自己的 node（它可能只是读到这个路径）当成 NapCat。
  const first = (text.match(/"[^"]*"|\S+/) || [''])[0].replace(/^"|"$/g, '');
  const base = win ? path.win32.basename(first) : path.basename(first);
  return !/^node(?:js)?(?:\.exe)?$/i.test(base);
}

/**
 * 停掉本安装根的面板与机器人，可选停 NapCat。
 * @returns {Promise<{ok:boolean, killed:number[], remaining:number[], errors:string[], userRoot:string}>}
 */
export async function stopInstalledApp({
  installRoot,
  userRoot = '',
  timeoutMs = 20000,
  stopNapcat = false,
  port = DEFAULT_PORT,
  log = () => {},
  platform = process.platform,
} = {}) {
  if (!installRoot) return { ok: false, killed: [], remaining: [], errors: ['缺少 installRoot'], userRoot };
  const inst = path.resolve(installRoot);
  let root = userRoot;
  if (!root) {
    try { root = String(readInstallInfo(inst)?.userRoot || ''); } catch { root = ''; }
  }
  if (!root) {
    root = path.join(process.env.LOCALAPPDATA || '', 'EstrellaBot', 'userdata');
  }
  root = path.resolve(root);
  const errors = [];
  const warnings = [];
  const killed = [];
  const token = readToken(root);
  const versions = versionsOf(inst);
  const health = await healthInfo(port);
  const panelPid = health && Number(health.pid) ? Number(health.pid) : 0;
  const botPid = readPid(path.join(root, 'panel', '.bridge.pid'));

  log(`stopping app: installRoot=${inst}`);
  log(`user data root: ${root}`);
  if (panelPid) log(`panel pid: ${panelPid}`);

  if (await portOpen(port)) {
    if (token) {
      log('- asking the bot to quit gracefully (/api/bridge/stop)');
      const b = await post(port, '/api/bridge/stop', token, Math.max(5000, Math.floor(timeoutMs * 0.6)));
      // 机器人本来就没跑时该路由会回 400；非 200 一律只当告警 ——
      // 真正的成功判据是**最终状态**（面板/机器人 pid 与端口），不是 HTTP 码。
      if (b.status !== 200) warnings.push(`/api/bridge/stop 返回 ${b.status}：${b.body}`);
      log('- asking the panel to quit (/api/panel/quit)');
      const p = await post(port, '/api/panel/quit', token, 5000);
      if (p.status !== 200) warnings.push(`/api/panel/quit 返回 ${p.status}：${p.body}`);
    } else {
      warnings.push('面板端口在监听，但读不到 panel/.token —— 改走 PID/精确身份兜底');
    }
  } else {
    log('- panel port not listening');
  }

  // 等一会儿，让正常退出把锁/文件释放掉。
  const deadline = Date.now() + Math.max(2000, Math.floor(timeoutMs * 0.4));
  while (Date.now() < deadline) {
    if (!(await portOpen(port))) break;
    await sleep(250);
  }

  // 快速路径：health 给了面板 pid；/api/panel/quit 之后它必须退出。
  // 这一步不读 WMI —— 真机上 Get-CimInstance 可能慢到几十秒，会把安装器卡在
  // “停止应用”那一步（2026-10-18 VM 实测）。
  if (panelPid && pidAlive(panelPid, { platform })) {
    log(`- fallback stop of panel pid ${panelPid}`);
    const r = killPid(panelPid, { platform });
    if (r.ok) killed.push(panelPid);
    else errors.push(`结束面板 pid ${panelPid} 失败：${r.out}`);
  }
  for (let i = 0; i < 20 && panelPid && pidAlive(panelPid, { platform }); i += 1) await sleep(250);

  const botAlive = botPid && pidAlive(botPid, { platform });
  const portStill = await portOpen(port);
  const needSlowScan = portStill || Boolean(botAlive);

  // 只有快速路径没搞定才读全量进程表（精确身份仍然是唯一判据）。
  if (needSlowScan && versions.length) {
    const table = listProcesses({ platform });
    if (!table.ok) {
      errors.push(`读进程表失败：${table.error}`);
    } else {
      for (const proc of table.rows) {
        if (proc.pid === process.pid) continue;
        const verdict = classifyProcess({
          cmd: proc.cmd,
          execPath: proc.execPath,
          installRoot: inst,
          versions,
          platform: platform === 'win32' ? 'win32' : 'posix',
        });
        if (!verdict.ours) continue;
        log(`- fallback stop of ${verdict.kind} pid ${proc.pid} (${verdict.version})`);
        const r = killPid(proc.pid, { platform });
        if (r.ok) killed.push(proc.pid);
        else errors.push(`结束 pid ${proc.pid} 失败：${r.out}`);
      }
    }
  } else if (portStill && !versions.length) {
    errors.push(`面板端口 ${port} 仍在监听，但 current.json 不可用，无法精确识别进程`);
  }

  // 没装 NapCat 时不要读全量 WMI：真机 Get-CimInstance 可能慢到几十秒，
  // 而卸载器在等它。（装了才需要按 <userRoot>\napcat 前缀筛。）
  if (stopNapcat && fs.existsSync(path.join(root, 'napcat'))) {
    const table = listProcesses({ platform });
    if (!table.ok) errors.push(`读进程表失败（NapCat）：${table.error}`);
    else {
      for (const proc of table.rows) {
        if (proc.pid === process.pid) continue;
        if (!isNapcatProcess(proc.cmd, root)) continue;
        // 不杀面板/机器人自己的 node（它们的命令行里也可能出现 userRoot）。
        if (/[\\/]versions[\\/][^\\/]+[\\/]app[\\/]/.test(proc.cmd)) continue;
        log(`- stopping NapCat pid ${proc.pid}`);
        const r = killPid(proc.pid, { platform });
        if (r.ok) killed.push(proc.pid);
        else errors.push(`结束 NapCat pid ${proc.pid} 失败：${r.out}`);
      }
    }
  }

  // 复查：快速路径成功时不读 WMI；只有走过兜底扫描才再核一次。
  const remaining = [];
  if (needSlowScan && versions.length) {
    const table = listProcesses({ platform });
    if (table.ok) {
      for (const proc of table.rows) {
        if (proc.pid === process.pid) continue;
        const verdict = classifyProcess({
          cmd: proc.cmd,
          execPath: proc.execPath,
          installRoot: inst,
          versions,
          platform: platform === 'win32' ? 'win32' : 'posix',
        });
        if (verdict.ours) remaining.push(proc.pid);
      }
    }
  }
  if (remaining.length) errors.push(`仍有本安装根的进程未退出：${remaining.join(', ')}`);
  if (await portOpen(port)) errors.push(`面板端口 ${port} 仍在监听`);
  for (const w of warnings) log(`! ${w}`);
  return { ok: errors.length === 0, killed, remaining, errors, warnings, userRoot: root };
}

async function main() {
  const installRoot = argOf('--install-root') || process.argv[2];
  const userRoot = argOf('--user-root');
  const stopNapcat = has('--stop-napcat');
  const timeoutMs = Number(argOf('--timeout') || 20000);
  if (!installRoot) {
    sayErr('usage: node tools/stop.mjs --install-root <install-root> [--user-root <data-root>] [--stop-napcat]');
    process.exitCode = 2;
    return;
  }
  const r = await stopInstalledApp({
    installRoot,
    userRoot,
    timeoutMs,
    stopNapcat,
    log: (m) => say(m),
  });
  if (!r.ok) {
    for (const e of r.errors) sayErr(`[x] ${e}`);
    process.exitCode = 1;
    return;
  }
  say(`[ok] app stopped${r.killed.length ? ` (fallback-killed ${r.killed.length} processes)` : ''}`);
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    sayErr(`[x] stop failed: ${e && e.message ? e.message : e}`);
    process.exitCode = 1;
  });
}
