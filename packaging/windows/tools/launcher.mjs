#!/usr/bin/env node
/**
 * 安装版启动器（P2 · 2026-10-18）。
 *
 * 双击 `launcher\Estrella-Bot.vbs` → 隐藏运行本文件：
 *   ① 读 current.json（坏了回退 previous）；
 *   ② 先建 USER_ROOT/panel 等目录（否则面板的 token 写不出来，stop/卸载都会跟着坏）；
 *   ③ 已有同版本面板 ⇒ 直接开窗；旧版本/陌生端口 ⇒ 明确报错，不猜；
 *   ④ 没跑 ⇒ 用共享 runtime/node 起面板，轮询 `/api/health`；
 *   ⑤ 健康成功后写 current.json.health=ok，再用 Edge/Chrome `--app` 开独立窗口。
 *
 * 只依赖 node: 内置 + install-layout；app 侧模块用 pathToFileURL 动态 import。
 */

import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  effectiveProgram,
  isMainModule,
  readCurrentInfo,
  readInstallInfo,
  readPackageInfo,
  writeJsonAtomic,
} from './lib/install-layout.mjs';
import {
  clearSwapMarker,
  configBackupPath,
  configRollbackGuard,
  decideStartFailure,
  preserveRollbackEvidence,
  readConfigSchema,
  readSwapMarker,
  rollbackRecord,
  swapRuntime,
  writeSwapMarker,
} from './lib/rollback.mjs';
import { applyRetention, listEntries, planRetention } from './lib/retention.mjs';

const IS_WIN = process.platform === 'win32';
const HERE = path.dirname(fileURLToPath(import.meta.url));

function normalizePort(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : 0;
}

/**
 * 传给面板的端口：显式 `QQBOT_PANEL_PORT` 优先（测试/多实例），否则 **0 = 系统分配**。
 * P3-1 之后启动器不再预设 8788；实际端口从 `USER_ROOT/panel/.panel.json` 读。
 * 发现模块自身**按当前程序根动态加载**（下面 main 里）—— 顶层 tools/ 与 versions/<ver>/app
 * 的相对层级在安装包里与开发树不同，静态相对 import 会在真机上直接找不到文件。
 */
const PORT_OVERRIDE = normalizePort(process.env.QQBOT_PANEL_PORT);
const WANT_HIDDEN = process.argv.includes('--hidden');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function argOf(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? String(process.argv[i + 1] || '') : '';
}

function tempLog() {
  return path.join(process.env.TEMP || process.env.TMP || os.tmpdir(), 'Estrella-Bot-launch.log');
}

function logLine(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try { fs.appendFileSync(tempLog(), line); } catch { /* 日志写不进去不阻断启动 */ }
  console.error(line.trimEnd());
}

function releaseLock(file, acquired) {
  if (!acquired || !file) return;
  try { fs.rmSync(file, { force: true }); } catch { /* 下次按陈旧锁处理 */ }
}

function pidAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function killPidTree(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return;
  if (IS_WIN) {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 10000 });
    return;
  }
  try { process.kill(pid, 'SIGTERM'); } catch { /* 已退出 */ }
}

function processCommandLine(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return '';
  try {
    if (IS_WIN) {
      const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`],
      { encoding: 'utf8', windowsHide: true, timeout: 8000 });
      return String(r.stdout || '').trim();
    }
    const r = spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8', timeout: 3000 });
    return String(r.stdout || '').trim();
  } catch { return ''; }
}

/**
 * 8788 上的面板是不是**本安装根**的旧面板。
 * P3-1 的 legacy 回退只在"确认是自己的"时才拒绝启动/才允许停止；否则同机别的回环服务
 * （例如开发树里正在跑的面板）会被误认成旧版，轻则挡住启动，重则被停止链杀掉。
 * 命令行查询失败时按"可能是我们的"处理（fail-closed），宁可让用户先退出旧控制台。
 */
function legacyPanelBelongsToInstall(cmd, installRoot, versions) {
  const text = String(cmd || '').replace(/\\/g, '/').toLowerCase();
  if (!text) return true;
  const root = path.resolve(installRoot).replace(/\\/g, '/').toLowerCase();
  if (!text.includes(root) || !text.includes('/panel/server.js')) return false;
  const list = versions.map((v) => String(v || '').toLowerCase()).filter(Boolean);
  return list.length === 0 || list.some((v) => text.includes(`/versions/${v}/app/`));
}

/**
 * 旧壳接管：新版本启动前，若 .shell.json 里的壳是**另一个 exe 路径**（旧版本目录），
 * 先让它退出。否则 Electron 的单实例锁会按共享 userData 判定“已有实例”，新壳直接退出，
 * 用户看到的是旧壳配新面板。同一路径则不杀——第二次启动交给 second-instance 唤起。
 */
async function stopStaleShell({ userRoot, targetExe }) {
  const file = path.join(userRoot, 'panel', '.shell.json');
  let info = null;
  try { info = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return { ok: true, skipped: 'no-shell' }; }
  const pid = Number(info && info.pid) || 0;
  const exe = String((info && info.exe) || '');
  if (!pid || !pidAlive(pid)) return { ok: true, skipped: 'stale' };
  if (!exe || !/electron(?:\.exe)?$/i.test(exe)) return { ok: true, skipped: 'unknown-exe' };
  if (path.resolve(exe) === path.resolve(targetExe)) return { ok: true, reused: true, pid };
  logLine(`⚠ 发现旧壳 pid ${pid}（${exe}），先退出再启动新壳`);
  killPidTree(pid);
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && pidAlive(pid)) await sleep(200);
  if (pidAlive(pid)) return { ok: false, reason: `旧壳 pid ${pid} 5 秒内没有退出` };
  return { ok: true, killed: pid };
}

/**
 * 双击竞态锁：同一个 USER_ROOT 同时只让一个 launcher 走启动流程。
 * 另一个正在启动 ⇒ 直接成功退出（它会把窗口开出来）。
 */
function acquireLock(userRoot) {
  const file = path.join(userRoot, 'panel', 'launch.lock');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(file, 'wx');
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
      fs.closeSync(fd);
      return { ok: true, held: true, file };
    } catch (e) {
      if (!e || e.code !== 'EEXIST') throw e;
      let info = null;
      try { info = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* 坏锁按陈旧处理 */ }
      const fresh = info && Number.isFinite(info.at) && Date.now() - info.at < 60000;
      if (fresh && pidAlive(Number(info.pid))) return { ok: true, held: false, file };
      try { fs.rmSync(file, { force: true }); } catch { /* 下面重试 */ }
    }
  }
  return { ok: false, held: false, file, error: '启动锁抢不到（可能有两个启动器同时卡住）' };
}

async function healthAt(port) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 2500);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: ac.signal });
    const text = (await res.text()).slice(0, 2000);
    let body = null;
    try { body = JSON.parse(text); } catch { /* 非 JSON 由调用方按“旧面板/陌生服务”处理 */ }
    return { status: res.status, body, text };
  } catch (e) {
    return { status: 0, body: null, text: e && e.message ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}

function patchCurrent(installRoot, patch) {
  try {
    const cur = readCurrentInfo(installRoot);
    if (!cur) return;
    writeJsonAtomic(path.join(installRoot, 'current.json'), { ...cur, ...patch, updatedAt: new Date().toISOString() });
  } catch (e) {
    logLine(`⚠ 写 current.json 失败（不影响本次启动）：${e.message}`);
  }
}

async function startPanel({ installRoot, programRoot, userRoot, configFile, discovery }) {
  const nodeExe = path.join(installRoot, 'runtime', 'node', IS_WIN ? 'node.exe' : 'node');
  if (IS_WIN && !fs.existsSync(nodeExe)) return { up: false, error: `缺共享运行时：${nodeExe}` };
  const panelFile = path.join(programRoot, 'panel', 'server.js');
  if (!fs.existsSync(panelFile)) return { up: false, error: `程序目录不完整：找不到 ${panelFile}` };
  const log = path.join(userRoot, 'panel', 'panel.log');
  fs.mkdirSync(path.dirname(log), { recursive: true });
  let fd;
  let childPid = 0;
  try {
    fd = fs.openSync(log, 'a');
    const child = spawn(IS_WIN ? nodeExe : process.execPath, [panelFile], {
      cwd: programRoot,
      detached: true,
      windowsHide: true,
      stdio: ['ignore', fd, fd],
      env: {
        ...process.env,
        QQBOT_MODE: 'installed',
        QQBOT_USER_ROOT: userRoot,
        QQBOT_CONFIG: configFile,
        // 显式写进去：即使继承到的 QQBOT_PANEL_PORT 是空/非法，也不会回落到 8788。
        QQBOT_PANEL_PORT: String(PORT_OVERRIDE),
      },
    });
    childPid = Number(child.pid) || 0;
    child.once('error', (e) => logLine(`✗ 控制台起不来：${e.message}`));
    child.unref();
  } catch (e) {
    return { up: false, error: `控制台起不来：${e.message}`, pid: childPid };
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* 已关 */ } }
  }

  const t0 = Date.now();
  while (Date.now() - t0 < 30000) {
    const info = discovery.readDiscovery(userRoot);
    if (info && info.pid === childPid && discovery.isLive(info)) {
      const h = await healthAt(info.port);
      if (h.status === 200 && h.body && h.body.ok) {
        return { up: true, health: h.body, pid: childPid, port: info.port, url: info.url };
      }
    }
    await sleep(350);
  }
  return { up: false, error: `控制台 30 秒内没有通过 /api/health（日志：${log}）`, pid: childPid };
}

/** 停掉本次 spawn 的面板（含子进程树），并等它真的退出。 */
async function stopPanel(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return { ok: true, reason: '本次没有 spawn 出面板' };
  if (IS_WIN) {
    try {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 10000 });
    } catch (e) {
      logLine(`⚠ 停止面板 ${pid} 失败：${e.message}`);
    }
  } else {
    try { process.kill(-pid, 'SIGTERM'); } catch { try { process.kill(pid, 'SIGTERM'); } catch { /* 已退出 */ } }
  }
  const t0 = Date.now();
  while (Date.now() - t0 < 10000) {
    if (!pidAlive(pid)) return { ok: true };
    await sleep(200);
  }
  if (!IS_WIN) {
    try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* 已退出 */ } }
  }
  return { ok: !pidAlive(pid), reason: `面板 ${pid} 10 秒内没有退出` };
}

/**
 * 有 Electron 壳就走壳；没有就回落 Edge --app。壳在**版本目录内**：
 * `versions/<ver>/app/electron/`，这样回滚时旧 app 自带旧壳。
 * `QQBOT_DESKTOP_DIR` / `QQBOT_ELECTRON_EXE` 只作显式覆盖（dev/救急）。
 * 这里必须删掉 ELECTRON_RUN_AS_NODE：一旦继承，Electron 会以 Node 跑而不是开窗。
 */
async function openShell({ installRoot, programRoot, userRoot, configFile, panelUrl, hidden = WANT_HIDDEN }) {
  let desktopDir = path.join(programRoot, 'electron');
  let shellExe = '';
  try {
    const sp = await import(pathToFileURL(path.join(programRoot, 'src', 'desktop', 'shell-path.js')).href);
    const paths = sp.shellPaths({ programRoot, env: process.env });
    desktopDir = paths.desktopDir;
    shellExe = paths.exe;
  } catch { /* 老版本没有 shell-path.js：回落到 programRoot/electron */ }
  const exe = shellExe || (process.env.QQBOT_ELECTRON_EXE
    ? path.resolve(process.env.QQBOT_ELECTRON_EXE)
    : path.join(desktopDir, IS_WIN ? 'electron.exe' : 'electron'));
  if (!fs.existsSync(exe) || !fs.existsSync(path.join(desktopDir, 'package.json'))) {
    return { ok: false, reason: 'no-shell' };
  }
  const stale = await stopStaleShell({ userRoot, targetExe: exe });
  if (!stale.ok) logLine(`⚠ 旧壳没退干净：${stale.reason || '未知原因'}`);
  let pkg;
  try { pkg = readPackageInfo(programRoot); } catch (e) { return { ok: false, error: e.message }; }
  const env = {
    ...process.env,
    QQBOT_PANEL_URL: panelUrl,
    QQBOT_USER_ROOT: userRoot,
    QQBOT_CONFIG: configFile,
    QQBOT_INSTALL_ROOT: installRoot,
    QQBOT_PROGRAM_ROOT: programRoot,
    QQBOT_APP_ID: pkg.appId,
    QQBOT_APP_VERSION: pkg.version,
    QQBOT_DESKTOP_DIR: desktopDir,
    ...(hidden ? { QQBOT_START_HIDDEN: '1' } : {}),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const args = [desktopDir];
  if (hidden) args.push('--hidden');
  try {
    const child = spawn(exe, args, {
      cwd: programRoot, detached: true, windowsHide: true, stdio: 'ignore', env,
    });
    const result = await new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve({ ok: true, pid: child.pid });
      }, 800);
      child.once('error', (e) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ ok: false, error: `桌面壳起不来：${e.message}` });
      });
    });
    child.unref();
    if (!result.ok) return result;
    try {
      const lm = await import(pathToFileURL(path.join(programRoot, 'src', 'launch-mode.js')).href);
      await lm.recordLaunch(path.join(userRoot, 'panel', 'launch-log.jsonl'), {
        entry: 'win-shell', kind: 'electron',
        opened: !hidden,
        ...(hidden ? { skipped: true, hidden: true } : {}),
        used: 'electron', pid: result.pid,
      });
    } catch (e) { logLine(`⚠ 壳启动跟踪写不进去：${e.message}`); }
    return {
      ok: true,
      result: {
        opened: !hidden,
        ...(hidden ? { skipped: true, hidden: true } : {}),
        kind: 'electron', used: 'electron', pid: result.pid,
      },
    };
  } catch (e) {
    return { ok: false, error: `桌面壳起不来：${e.message}` };
  }
}

async function openWindow({ installRoot, programRoot, userRoot, configFile, panelUrl }) {
  const modPath = path.join(programRoot, 'src', 'launch-mode.js');
  let lm = null;
  try { lm = await import(pathToFileURL(modPath).href); } catch { lm = null; }
  let launch = null;
  try { launch = lm ? lm.readLaunchFile(configFile) : null; } catch { launch = null; }
  // `--hidden`（登录自启）与 launch.openOnStart=false 任一成立都留在后台；
  // 老版本 app 没有 shouldStartHidden 时只认 --hidden（fail-open，不因升级顺序把窗口吞掉）。
  const hidden = lm && typeof lm.shouldStartHidden === 'function'
    ? lm.shouldStartHidden({ wantHidden: WANT_HIDDEN, openOnStart: launch ? launch.openOnStart : true })
    : WANT_HIDDEN;
  if (hidden) logLine(`ℹ 启动后留在后台（${WANT_HIDDEN ? '--hidden' : 'launch.openOnStart=false'}）`);

  const shell = await openShell({ installRoot, programRoot, userRoot, configFile, panelUrl, hidden });
  if (shell.ok) return { ok: true, result: shell.result };
  if (shell.reason !== 'no-shell' && shell.error) logLine(`⚠ ${shell.error}`);
  if (hidden) return { ok: true, skipped: true, reason: 'hidden-without-shell' };
  if (!lm) return { ok: false, error: `缺启动方式模块：${modPath}` };

  const hiddenVbs = path.join(installRoot, 'launcher', 'run-hidden.vbs');
  const r = lm.openPanelFromConfig({
    configPath: configFile,
    url: panelUrl,
    entry: 'win-installed',
    defaultMode: 'window',
    logFile: path.join(userRoot, 'panel', 'launch-log.jsonl'),
    hiddenVbs: fs.existsSync(hiddenVbs) ? hiddenVbs : '',
    log: (m) => logLine(m),
  });
  if (!r || r.opened === false) {
    if (r && r.skipped) return { ok: true, skipped: true };
    return { ok: false, error: r && r.error ? r.error : '独立窗口没有打开' };
  }
  return { ok: true, result: r };
}

function currentInfoOf(installRoot) {
  try { return readCurrentInfo(installRoot) || {}; } catch { return {}; }
}

function readUserConfigSchema(userRoot) {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(userRoot, 'config.json'), 'utf8'));
    const n = Number(cfg && cfg.schemaVersion);
    return Number.isInteger(n) && n > 0 ? n : 1;
  } catch {
    return 1;
  }
}

/** 回滚指针必须写成功；失败时调用方要能把 runtime 换回去。 */
function writeCurrentStrict(installRoot, patch) {
  const cur = currentInfoOf(installRoot);
  const next = { ...cur, ...patch, updatedAt: new Date().toISOString() };
  writeJsonAtomic(path.join(installRoot, 'current.json'), next);
  return next;
}

function previousProgramOk({ installRoot, previous, appId }) {
  const prev = typeof previous === 'string' ? previous.trim() : '';
  if (!prev) return { ok: false, error: '没有 previous' };
  const r = effectiveProgram({
    installRoot,
    current: { schema: 1, current: prev, previous: null, health: 'pending' },
    expectedAppId: appId,
  });
  return r.ok ? { ok: true, ...r } : { ok: false, error: r.error };
}

function retentionAfterSuccess(installRoot) {
  try {
    const plan = planRetention({
      versions: listEntries(path.join(installRoot, 'versions')),
      runtime: listEntries(path.join(installRoot, 'runtime')),
      current: currentInfoOf(installRoot).current,
      previous: currentInfoOf(installRoot).previous,
      execPath: process.execPath,
    });
    const r = applyRetention({ installRoot, plan, log: (m) => logLine(m) });
    if (r.errors.length) logLine(`· 保留策略有 ${r.errors.length} 项未清理（下次再试）：${r.errors.join('；')}`);
    return r;
  } catch (e) {
    logLine(`⚠ 保留策略失败（不影响启动）：${e.message}`);
    return { removed: [], errors: [e.message] };
  }
}

async function attemptLaunch({ installRoot, programRoot, userRoot, configFile, appId, discovery }) {
  let pkg;
  try { pkg = readPackageInfo(programRoot); } catch (e) {
    return { ok: false, pid: 0, error: `程序目录不可用：${e.message}` };
  }
  if (pkg.appId !== appId) {
    return { ok: false, pid: 0, error: `程序目录 appId 不对：${pkg.appId} ≠ ${appId}` };
  }
  const started = await startPanel({ installRoot, programRoot, userRoot, configFile, discovery });
  if (!started.up) return { ok: false, pid: started.pid || 0, error: started.error };
  const h = started.health;
  if (!h || h.appId !== pkg.appId || h.version !== pkg.version) {
    return {
      ok: false,
      pid: started.pid || 0,
      error: `面板起来了，但健康身份不对：${JSON.stringify(h)}`,
      identity: true,
    };
  }
  return { ok: true, pid: started.pid || 0, health: h, pkg, port: started.port, url: started.url };
}

/**
 * Windows 专用：把 runtime 交换交给一个在启动器退出后才运行的 PowerShell 助手。
 *
 * 实测（Win11 ARM64）：启动器正跑在 `runtime/node/node.exe` 里时，`Move-Item
 * runtime/node runtime/node.failed-*` 直接 EPERM —— “运行中的 exe 可以改名”这条
 * 只对 exe 文件成立，对包含它的目录不成立。因此必须让启动器先退出，再由助手交换。
 */
function taskState(name) {
  if (!name) return '';
  try {
    const r = spawnSync('schtasks', ['/Query', '/TN', name, '/FO', 'LIST'], {
      encoding: 'utf8', windowsHide: true, timeout: 10000,
    });
    if (r.error || r.status !== 0) return '';
    const m = /Status:\s*([^\r\n]+)/i.exec(r.stdout || '');
    return m ? m[1].trim() : '';
  } catch {
    return '';
  }
}

/**
 * Windows 专用：把 runtime 交换交给一个独立计划任务里的 PowerShell 助手。
 *
 * 实测（Win11 ARM64）：
 *   · 启动器正跑在 runtime/node 里时，目录改名直接 EPERM；
 *   · 直接 `spawn` 的助手会随启动器/桥的作业对象一起被杀（连日志都来不及写）。
 * 计划任务由 Task Scheduler 持有，不随父进程退出 —— 这是唯一可靠的存活方式。
 */
function spawnRollbackHelper({ installRoot, userRoot, from, to, failures, reason, evidenceDir, stamp }) {
  const helper = path.join(HERE, 'rollback-restore.ps1');
  if (!fs.existsSync(helper)) return { ok: false, error: `缺回滚助手：${helper}` };
  const taskName = `Estrella-Rollback-${process.pid}`;
  const tempCmd = path.join(userRoot, 'update', `rollback-${process.pid}.cmd`);
  try {
    writeJsonAtomic(path.join(userRoot, 'update', 'rollback-request.json'), {
      schema: 1,
      from,
      to,
      failures,
      reason,
      evidenceDir: evidenceDir || '',
      launcherPid: process.pid,
      installRoot,
      userRoot,
      stamp,
      taskName,
      tempCmd,
      at: new Date().toISOString(),
    });
    writeSwapMarker(installRoot, {
      from, to, failures, phase: 'requested', evidenceDir: evidenceDir || '', stamp, taskName,
    });
    const ps = [
      'powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
      '-File', `"${helper}"`,
      '-InstallRoot', `"${installRoot}"`,
      '-UserRoot', `"${userRoot}"`,
      '-LauncherPid', String(process.pid),
      '-Stamp', `"${stamp}"`,
      '-TaskName', `"${taskName}"`,
      '-TempCmd', `"${tempCmd}"`,
    ].join(' ');
    fs.mkdirSync(path.dirname(tempCmd), { recursive: true });
    fs.writeFileSync(tempCmd, `@echo off\r\n${ps}\r\n`, 'ascii');
    const action = `cmd.exe /c "${tempCmd}"`;
    let r = spawnSync('schtasks', [
      '/Create', '/TN', taskName, '/TR', action, '/SC', 'ONCE', '/ST', '23:59',
      '/F', '/RL', 'LIMITED', '/IT',
    ], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    if (r.error || r.status !== 0) {
      r = spawnSync('schtasks', [
        '/Create', '/TN', taskName, '/TR', action, '/SC', 'ONCE', '/ST', '23:59',
        '/F', '/RL', 'LIMITED',
      ], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    }
    if (r.error || r.status !== 0) {
      return { ok: false, error: `回滚任务创建失败：${(r.stderr || r.stdout || r.error || '').trim()}` };
    }
    const run = spawnSync('schtasks', ['/Run', '/TN', taskName], {
      encoding: 'utf8', windowsHide: true, timeout: 15000,
    });
    if (run.error || run.status !== 0) {
      return { ok: false, error: `回滚任务启动失败：${(run.stderr || run.stdout || run.error || '').trim()}` };
    }
    writeSwapMarker(installRoot, {
      from, to, failures, phase: 'requested', evidenceDir: evidenceDir || '', stamp, taskName,
    });
    return { ok: true, taskName };
  } catch (e) {
    return { ok: false, error: `回滚任务起不来：${e.message}` };
  }
}

/**
 * 连续失败达到阈值后的回滚：证据 → runtime 交换 → 翻指针 → rollback.json。
 * runtime 交换失败时**不翻指针**；指针写失败时尽量把 runtime 换回去。
 * Windows 上交换必须延后到启动器退出之后（见 spawnRollbackHelper）。
 */
async function applyRollback({ installRoot, userRoot, appId, decision }) {
  const fresh = currentInfoOf(installRoot);
  const from = String(fresh.current || '');
  const to = String(fresh.previous || '');
  const stamp = `${to}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  patchCurrent(installRoot, { health: 'failed', failures: decision.failures });
  const evidence = preserveRollbackEvidence({
    installRoot,
    userRoot,
    from,
    to,
    reason: decision.reason,
    failures: decision.failures,
  });
  if (!evidence.ok) logLine(`⚠ 回滚证据没写成：${evidence.error}`);

  if (IS_WIN) {
    const helper = spawnRollbackHelper({
      installRoot,
      userRoot,
      from,
      to,
      failures: decision.failures,
      reason: decision.reason,
      evidenceDir: evidence.dir || '',
      stamp,
    });
    if (!helper.ok) {
      logLine(`✗ ${helper.error}`);
      try {
        writeJsonAtomic(path.join(userRoot, 'update', 'rollback.json'), rollbackRecord({
          from, to, reason: helper.error, failures: decision.failures,
          runtimeRestored: false, result: 'failed', evidenceDir: evidence.dir || '',
        }));
      } catch { /* 证据尽力 */ }
      clearSwapMarker(installRoot);
      return { ok: false, reason: helper.error, exitCode: 4 };
    }
    logLine(`↩ 回滚任务已交接（${helper.taskName}）：启动器退出后恢复 runtime 并重启 ${to}`);
    return { ok: true, deferred: true, to };
  }

  writeSwapMarker(installRoot, {
    from, to, failures: decision.failures, phase: 'starting', evidenceDir: evidence.dir || '',
  });
  const sw = swapRuntime({ installRoot, stamp });
  if (!sw.ok) {
    logLine(`✗ runtime 交换失败，拒绝翻指针：${sw.reason}`);
    if (!sw.swapped) clearSwapMarker(installRoot);
    try {
      writeJsonAtomic(path.join(userRoot, 'update', 'rollback.json'), rollbackRecord({
        from, to, reason: sw.reason, failures: decision.failures,
        runtimeRestored: false, result: 'failed', evidenceDir: evidence.dir || '',
      }));
    } catch { /* 证据尽力 */ }
    patchCurrent(installRoot, { health: 'failed', failures: decision.failures });
    return { ok: false, reason: sw.reason, exitCode: 4 };
  }
  // `swapped:false` = 没有 runtime/node.previous。此时翻指针会变成“旧 app + 新 runtime”，
  // 与 Windows helper 的 throw 对齐：宁可不回滚，也不制造错配。
  if (!sw.swapped) {
    const reason = sw.reason || '没有 runtime/node.previous';
    logLine(`✗ ${reason}，拒绝翻指针（避免旧 app + 新 runtime）`);
    clearSwapMarker(installRoot);
    try {
      writeJsonAtomic(path.join(userRoot, 'update', 'rollback.json'), rollbackRecord({
        from, to, reason, failures: decision.failures,
        runtimeRestored: false, result: 'blocked', evidenceDir: evidence.dir || '',
      }));
    } catch { /* 证据尽力 */ }
    patchCurrent(installRoot, { health: 'failed', failures: decision.failures });
    return { ok: false, reason, exitCode: 4 };
  }
  writeSwapMarker(installRoot, {
    from, to, failures: decision.failures, phase: 'swapped',
    runtimeRestored: sw.swapped, evidenceDir: evidence.dir || '',
  });

  try {
    writeCurrentStrict(installRoot, { current: to, previous: null, health: 'pending', failures: 0 });
  } catch (e) {
    // 指针没写进去：若 runtime 已换过，尽量换回“新 runtime + 新指针”，别留下旧 runtime 跑新版。
    if (sw.swapped) {
      try {
        const runtime = path.join(installRoot, 'runtime');
        const node = path.join(runtime, 'node');
        const back = path.join(runtime, 'node.previous');
        if (fs.existsSync(node) && sw.failedDir && fs.existsSync(sw.failedDir)) {
          fs.renameSync(node, back);
          fs.renameSync(sw.failedDir, node);
        }
      } catch (e2) {
        logLine(`✗ 指针写失败且 runtime 回退也失败：${e2.message}；保留 .swap.json 供下次启动处理`);
      }
    }
    logLine(`✗ 回滚指针写入失败：${e.message}`);
    try {
      writeJsonAtomic(path.join(userRoot, 'update', 'rollback.json'), rollbackRecord({
        from, to, reason: `指针写入失败：${e.message}`, failures: decision.failures,
        runtimeRestored: false, result: 'failed', evidenceDir: evidence.dir || '',
      }));
    } catch { /* 证据尽力 */ }
    patchCurrent(installRoot, { health: 'failed', failures: decision.failures });
    return { ok: false, reason: e.message, exitCode: 4 };
  }

  clearSwapMarker(installRoot);
  try {
    writeJsonAtomic(path.join(userRoot, 'update', 'rollback.json'), rollbackRecord({
      from, to, reason: decision.reason, failures: decision.failures,
      runtimeRestored: sw.swapped, result: 'ok', evidenceDir: evidence.dir || '',
    }));
  } catch (e) {
    logLine(`⚠ rollback.json 写入失败（不影响启动）：${e.message}`);
  }
  logLine(`↩ 已回滚：${from} → ${to}（runtime ${sw.swapped ? '已恢复' : '未替换'}）`);
  return { ok: true, to, runtimeRestored: sw.swapped };
}

async function handleStartFailure({ installRoot, userRoot, configFile, appId, error, pid, discovery }) {
  const stop = await stopPanel(pid);
  if (!stop.ok) logLine(`⚠ ${stop.reason || '面板没有停干净'}`);

  const fresh = currentInfoOf(installRoot);
  const prevInfo = previousProgramOk({ installRoot, previous: fresh.previous, appId });
  const userSchema = readUserConfigSchema(userRoot);
  const targetSchema = prevInfo.ok ? readConfigSchema(prevInfo.programRoot) : 1;
  const guard = configRollbackGuard({ configSchema: userSchema, targetSupported: targetSchema });
  const decision = decideStartFailure({
    current: fresh.current,
    previous: fresh.previous,
    failures: fresh.failures,
    previousValid: prevInfo.ok,
    configSchemaOk: guard.ok,
  });
  logLine(`✗ ${error}（连续失败 ${decision.failures} 次）`);

  if (decision.action === 'count') {
    patchCurrent(installRoot, { health: 'failed', failures: decision.failures });
    return 4;
  }
  if (decision.action === 'terminal') {
    patchCurrent(installRoot, { health: 'failed', failures: decision.failures });
    if (decision.blocked === 'config-schema') {
      const backup = configBackupPath(userRoot, fresh.previous);
      logLine(`✗ ${decision.reason}；配置备份路径：${backup}`);
      try {
        writeJsonAtomic(path.join(userRoot, 'update', 'rollback.json'), rollbackRecord({
          from: fresh.current, to: fresh.previous, reason: decision.reason,
          failures: decision.failures, result: 'blocked', configBackup: backup,
        }));
      } catch { /* 证据尽力 */ }
    }
    logLine('✗ 已达到终止条件，不再自动重试；请重新安装或修复。');
    return 4;
  }

  const rb = await applyRollback({ installRoot, userRoot, appId, decision });
  if (!rb.ok) return rb.exitCode || 4;
  if (rb.deferred) {
    logLine('回滚助手将在启动器退出后恢复 runtime 并重启上一版');
    return 0;
  }

  const cur = currentInfoOf(installRoot);
  const eff = effectiveProgram({ installRoot, current: cur, expectedAppId: appId });
  if (!eff.ok) {
    logLine(`✗ 回滚后版本目录不可用：${eff.error}`);
    return 2;
  }
  const second = await attemptLaunch({ installRoot, programRoot: eff.programRoot, userRoot, configFile, appId, discovery });
  if (!second.ok) {
    await stopPanel(second.pid);
    patchCurrent(installRoot, { health: 'failed', failures: 1 });
    logLine(`✗ 上一版也起不来，不再自动重试：${second.error}`);
    return 4;
  }
  patchCurrent(installRoot, { health: 'ok', failures: 0 });
  retentionAfterSuccess(installRoot);
  const w = await openWindow({ installRoot, programRoot: eff.programRoot, userRoot, configFile, panelUrl: second.url });
  if (!w.ok) { logLine(`✗ 回滚成功，但窗口打不开：${w.error}`); return 5; }
  return 0;
}

function clearRollbackRequest(userRoot) {
  try { fs.rmSync(path.join(userRoot, 'update', 'rollback-request.json'), { force: true }); } catch { /* 下次覆盖 */ }
}

function finishRollbackPointer({ installRoot, userRoot, marker, reason }) {
  writeCurrentStrict(installRoot, {
    current: marker.to, previous: null, health: 'pending', failures: 0,
  });
  try {
    writeJsonAtomic(path.join(userRoot, 'update', 'rollback.json'), rollbackRecord({
      from: marker.from,
      to: marker.to,
      reason: reason || '启动时发现回滚已交换 runtime 但指针未写，按已交换完成',
      failures: Number(marker.failures) || 0,
      runtimeRestored: true,
      result: 'recovered',
      evidenceDir: marker.evidenceDir || '',
    }));
  } catch { /* 证据尽力 */ }
  clearSwapMarker(installRoot);
  clearRollbackRequest(userRoot);
}

/**
 * 上次回滚若停在“runtime 已换、指针未写”或“助手未跑完”，启动时把它收口。
 * 返回 `{exit}` 时 main 直接退出（把舞台让给回滚助手）；返回 undefined 则继续正常启动。
 */
function reconcileSwapMarker(installRoot, userRoot) {
  const marker = readSwapMarker(installRoot);
  if (!marker) return undefined;
  const cur = currentInfoOf(installRoot);
  const node = path.join(installRoot, 'runtime', 'node');
  const prev = path.join(installRoot, 'runtime', 'node.previous');

  if (marker.phase === 'failed') {
    logLine(`✗ 上次 runtime 恢复失败：${marker.error || '未知原因'}；请重装或查看 ${path.join(userRoot, 'update', 'logs')}`);
    return { exit: 4 };
  }

  if (marker.phase === 'requested' || marker.phase === 'swapped') {
    if (cur.current === marker.to) {
      clearSwapMarker(installRoot);
      clearRollbackRequest(userRoot);
      return undefined;
    }
    if (cur.current !== marker.from) {
      logLine(`⚠ 回滚 marker 与 current.json 不一致（${cur.current} / from=${marker.from} / to=${marker.to}），清掉陈旧 marker`);
      clearSwapMarker(installRoot);
      clearRollbackRequest(userRoot);
      return undefined;
    }
    // runtime 已是旧版、node.previous 已消失 ⇒ 交换完成，只差指针。
    if (fs.existsSync(node) && !fs.existsSync(prev)) {
      try {
        finishRollbackPointer({ installRoot, userRoot, marker });
        logLine(`⚠ 修复上次中断的回滚：${marker.from} → ${marker.to}`);
        return undefined;
      } catch (e) {
        logLine(`✗ 修复回滚指针失败：${e.message}；保留 ${path.join(installRoot, 'runtime', '.swap.json')}`);
        return { exit: 2 };
      }
    }
    if (fs.existsSync(prev)) {
      const task = marker.taskName ? taskState(marker.taskName) : '';
      if (task && /^Running$/i.test(task)) {
        logLine(`回滚任务 ${marker.taskName} 正在运行，本次启动器退出等待它重启`);
        return { exit: 0 };
      }
      const helperPid = Number(marker.helperPid) || 0;
      if (helperPid && pidAlive(helperPid)) {
        logLine(`回滚助手 pid ${helperPid} 仍在运行，本次启动器退出等待它重启`);
        return { exit: 0 };
      }
      const stamp = String(marker.stamp || `${marker.to}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
      const helper = spawnRollbackHelper({
        installRoot,
        userRoot,
        from: marker.from,
        to: marker.to,
        failures: Number(marker.failures) || 0,
        reason: '启动时重试上次未完成的回滚',
        evidenceDir: marker.evidenceDir || '',
        stamp,
      });
      if (helper.ok) {
        logLine(`回滚任务已重新交接（${helper.taskName}）；本次启动器退出`);
        return { exit: 0 };
      }
      logLine(`✗ ${helper.error}`);
      return { exit: 4 };
    }
    logLine(`✗ 回滚 marker 存在但 runtime/node 与 node.previous 都不在；请用安装器修复：${path.join(installRoot, 'runtime', '.swap.json')}`);
    return { exit: 2 };
  }

  if (marker.phase === 'starting' && !fs.existsSync(node)) {
    logLine(`✗ 上次回滚的 .swap.json 存在但 runtime/node 不在；请用安装器修复：${path.join(installRoot, 'runtime', '.swap.json')}`);
    return { exit: 2 };
  }
  clearSwapMarker(installRoot);
  clearRollbackRequest(userRoot);
  return undefined;
}

async function main() {
  const installRoot = path.resolve(argOf('--install-root') || path.join(HERE, '..'));
  const install = readInstallInfo(installRoot);
  const userRoot = path.resolve(
    install && install.userRoot
      ? path.resolve(installRoot, String(install.userRoot))
      : (process.env.LOCALAPPDATA
        ? path.join(process.env.LOCALAPPDATA, 'EstrellaBot', 'userdata')
        : path.join(os.homedir(), 'AppData', 'Local', 'EstrellaBot', 'userdata'))
  );
  const configFile = path.join(userRoot, 'config.json');

  // 安装器解出的 .stage-* 在 bootstrap 后应被 NSIS 删除；Defender/文件句柄偶尔会让它留下。
  // 启动器顺手清掉安装根下的陈旧 stage（只删这一层、只删 .stage- 前缀；不碰版本/数据）。
  try {
    for (const name of fs.readdirSync(installRoot)) {
      if (!name.startsWith('.stage-')) continue;
      try { fs.rmSync(path.join(installRoot, name), { recursive: true, force: true }); } catch { /* 下次再清 */ }
    }
  } catch { /* 读不到安装根时后面的错误会如实报出来 */ }

  const rec = reconcileSwapMarker(installRoot, userRoot);
  if (rec && rec.exit !== undefined) return rec.exit;
  const current = readCurrentInfo(installRoot);
  const eff = effectiveProgram({ installRoot, current });
  if (!eff.ok) {
    logLine(`✗ current.json 无效：${eff.error}`);
    return 2;
  }
  let pkg;
  try { pkg = readPackageInfo(eff.programRoot); } catch (e) {
    logLine(`✗ 程序目录不可用：${e.message}`);
    return 2;
  }
  if (install && install.appId && install.appId !== pkg.appId) {
    logLine(`✗ appId 不一致：install.json=${install.appId} / package.json=${pkg.appId}`);
    return 2;
  }
  if (eff.fallback) {
    logLine(`⚠ current=${current && current.current} 不可用，回退 previous=${eff.version}`);
    patchCurrent(installRoot, { current: eff.version, previous: null, health: 'pending', failures: 0 });
  }

  process.env.QQBOT_MODE = 'installed';
  process.env.QQBOT_USER_ROOT = userRoot;
  process.env.QQBOT_CONFIG = configFile;
  try {
    const rootMod = await import(pathToFileURL(path.join(eff.programRoot, 'src', 'user-root.js')).href);
    rootMod.ensureUserDirs();
  } catch (e) {
    logLine(`✗ 建用户目录失败：${e.message}`);
    return 2;
  }

  // 发现模块从**当前程序根**加载：顶层 tools/ 与 versions/<ver>/app 的相对层级在安装包里
  // 与开发树不同，静态 import 会在真机上找不到文件（P3-1 施工时实际踩到）。
  let panelDiscovery;
  try {
    panelDiscovery = await import(pathToFileURL(path.join(eff.programRoot, 'src', 'panel-discovery.cjs')).href);
  } catch (e) {
    logLine(`✗ 缺端口发现模块（app/src/panel-discovery.cjs）：${e.message}`);
    return 2;
  }

  const lock = acquireLock(userRoot);
  if (!lock.ok) {
    logLine(`✗ ${lock.error}`);
    return 2;
  }
  if (!lock.held) {
    logLine('另一个启动器正在拉起控制台，本次直接退出');
    return 0;
  }

  try {
    // P3-1：先认发现文件。它是唯一能告诉我们"面板在哪个端口"的东西。
    const disc = panelDiscovery.readDiscovery(userRoot);
    const running = disc && panelDiscovery.isLive(disc) ? disc : null;
    if (running) {
      const h = await healthAt(running.port);
      if (h.status === 200 && h.body && h.body.ok) {
        if (h.body.appId === pkg.appId && h.body.version === eff.version) {
          patchCurrent(installRoot, { health: 'ok', failures: 0 });
          retentionAfterSuccess(installRoot);
          const w = await openWindow({
            installRoot, programRoot: eff.programRoot, userRoot, configFile, panelUrl: running.url,
          });
          if (!w.ok) { logLine(`✗ 控制台已在运行，但窗口打不开：${w.error}`); return 5; }
          return 0;
        }
        logLine(`✗ 正在跑的控制台版本不同（appId=${h.body.appId} version=${h.body.version}，期望 ${eff.version}）；`
          + '请先在旧控制台里点「退出控制台」，再重新打开。');
        return 3;
      }
      logLine(`⚠ 发现文件指向 pid ${running.pid}、端口 ${running.port}，但 /api/health 不通 —— 按陈旧发现处理`);
    }

    // 旧版（P3-1 之前）没有发现文件，只可能占着 legacy 8788。
    // 这里**只做识别**：让用户先退出旧面板；绝不把 8788 当成新面板的端口，也不拿它开窗。
    // 关键：必须确认它属于**本安装根** —— 同机开发树面板也可能在 8788，不能把它当旧版。
    const legacyPort = panelDiscovery.LEGACY_PANEL_PORT;
    const legacy = await healthAt(legacyPort);
    if (legacy.status === 200 && legacy.body && legacy.body.ok) {
      const legacyPid = Number(legacy.body.pid) || 0;
      const legacyVersions = [current && current.current, current && current.previous].filter(Boolean);
      const legacyCmd = processCommandLine(legacyPid);
      if (legacyPanelBelongsToInstall(legacyCmd, installRoot, legacyVersions)) {
        logLine(`✗ 检测到本安装根的旧版控制台仍在 ${legacyPort}（version=${legacy.body.version || '?'}）；`
          + '请先在旧控制台里点「退出控制台」，再重新打开。');
        return 3;
      }
      logLine(`· ${legacyPort} 上有一个不属于本安装根的面板（pid ${legacyPid}），忽略；`
        + '新面板使用系统分配端口。');
    }
    // 8788 被别的程序占着（没有 /api/health）不挡路：新面板会用系统分配的端口，两者互不影响。

    const started = await attemptLaunch({
      installRoot, programRoot: eff.programRoot, userRoot, configFile, appId: pkg.appId, discovery: panelDiscovery,
    });
    if (started.ok) {
      patchCurrent(installRoot, { health: 'ok', failures: 0 });
      retentionAfterSuccess(installRoot);
      const w = await openWindow({
        installRoot, programRoot: eff.programRoot, userRoot, configFile, panelUrl: started.url,
      });
      if (!w.ok) {
        logLine(`✗ 控制台已启动，但窗口打不开：${w.error}。可手动打开 ${started.url}`);
        return 5;
      }
      return 0;
    }
    return await handleStartFailure({
      installRoot,
      userRoot,
      configFile,
      appId: pkg.appId,
      error: started.error,
      pid: started.pid,
      discovery: panelDiscovery,
    });
  } finally {
    releaseLock(lock.file, lock.held);
  }
}

if (isMainModule(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }).catch((e) => {
    logLine(`✗ 启动器异常：${e && e.message ? e.message : e}`);
    process.exitCode = 1;
  });
}
