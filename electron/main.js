/**
 * Estrella Bot Electron 壳（B1a · 2026-10-23）。
 *
 * 壳只做窗口 / 托盘 / 通知 / 生命周期；后端仍是外部 Node 的 panel/server.js。
 * 不切 ELECTRON_RUN_AS_NODE（那会把换 runtime 变成重写后端），也不换更新器。
 */

if (!process.versions.electron || process.env.ELECTRON_RUN_AS_NODE === '1') {
  console.error('[shell] 必须由 Electron 启动；不要设置 ELECTRON_RUN_AS_NODE=1');
  process.exit(2);
}

const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const {
  app, BrowserWindow, Tray, Menu, Notification, dialog, ipcMain, screen, shell, session, nativeImage, nativeTheme, crashReporter,
} = require('electron');

const panelDiscovery = require('../src/panel-discovery.cjs');

const APP_ID = process.env.QQBOT_APP_ID || 'com.estrellabot.windows';
const APP_VERSION = String(process.env.QQBOT_APP_VERSION || '').trim();
const INSTALL_ROOT = process.env.QQBOT_INSTALL_ROOT ? path.resolve(process.env.QQBOT_INSTALL_ROOT) : '';
const USER_ROOT = process.env.QQBOT_USER_ROOT
  ? path.resolve(process.env.QQBOT_USER_ROOT)
  : (process.platform === 'win32'
    ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'EstrellaBot', 'userdata')
    : path.join(os.homedir(), '.estrella-bot', 'userdata'));
// P3-1：端口不再写死。启动器会传 QQBOT_PANEL_URL；手动起壳时读发现文件；最后才是 legacy 8788
// （仅 dev/旧安装兜底，产品启动链不会走到这里）。
let PANEL_URL = normalizePanelUrl(process.env.QQBOT_PANEL_URL || '') || discoveryPanelUrl() || legacyPanelUrl();
const USER_DATA = process.env.QQBOT_ELECTRON_USERDATA
  ? path.resolve(process.env.QQBOT_ELECTRON_USERDATA)
  : path.join(USER_ROOT, 'electron');
const SHELL_STATE_FILE = path.join(USER_ROOT, 'panel', '.shell.json');
const QUIT_INTENT_FILE = path.join(USER_ROOT, 'panel', '.quit-intent.json');
const CRASH_DIR = path.join(USER_DATA, 'crashes');
const SHELL_EVENTS_FILE = path.join(CRASH_DIR, 'shell-events.jsonl');
const SHELL_EXIT_FILE = path.join(USER_DATA, 'shell-exit.json');
const CLOSE_ACTION = String(process.env.QQBOT_CLOSE_ACTION || '').trim();
const CONFIG_FILE = process.env.QQBOT_CONFIG
  ? path.resolve(process.env.QQBOT_CONFIG)
  : path.join(USER_ROOT, 'config.json');
const TRAY_FORCE = String(process.env.QQBOT_TRAY_FORCE_UNAVAILABLE || '').trim();
const TRAY_THROW = process.env.QQBOT_TRAY_THROW === '1';
let crashRecord = null;
const HIDDEN = process.argv.includes('--hidden') || process.env.QQBOT_START_HIDDEN === '1';
const SMOKE_CLOSE = process.argv.includes('--smoke-close') || process.env.QQBOT_SMOKE_CLOSE === '1';
const SMOKE_QUIT = process.argv.includes('--smoke-quit') || process.env.QQBOT_SMOKE_QUIT === '1';
const SMOKE_NOTIFY = process.argv.includes('--smoke-notify') || process.env.QQBOT_SMOKE_NOTIFY === '1';
const SMOKE_CRASH = String(process.env.QQBOT_SMOKE_CRASH || '').trim();
const REPO_ROOT = path.resolve(__dirname, '..');

app.setName('Estrella Bot');
app.setPath('userData', USER_DATA);
try { fs.mkdirSync(USER_DATA, { recursive: true }); } catch { /* 写日志时再报 */ }
if (process.platform === 'win32') app.setAppUserModelId(APP_ID);

let win = null;
let tray = null;
let desktop = null;
let isQuitting = false;
let pendingShow = false;
let windowReady = false;
let saveTimer = null;
let trayDegraded = false;
let trayFailed = false;
let trayHealthTimer = null;
let trayHidden = false;   // 只有 hideToTray/隐藏启动为真；最小化不算
let notifyAreaCache = { at: 0, value: false };

function normalizePanelUrl(raw) {
  try {
    const u = new URL(String(raw));
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('bad protocol');
    if (!u.pathname.endsWith('/')) u.pathname += '/';
    return u.href;
  } catch {
    return '';
  }
}

function discoveryPanelUrl() {
  const info = panelDiscovery.readDiscovery(USER_ROOT);
  if (!info || !panelDiscovery.isLive(info)) return '';
  return normalizePanelUrl(info.url);
}

function legacyPanelUrl() {
  return `http://127.0.0.1:${panelDiscovery.LEGACY_PANEL_PORT}/`;
}

/** 面板在别的端口回来后，把壳指向新的发现文件地址。返回是否变了。 */
function refreshPanelUrl() {
  const next = discoveryPanelUrl();
  if (!next || next === PANEL_URL) return false;
  log(`panel url refreshed ${PANEL_URL} -> ${next}`);
  PANEL_URL = next;
  return true;
}

function log(line) {
  try {
    const file = path.join(USER_DATA, 'shell.log');
    try {
      if (fs.statSync(file).size > 2 * 1024 * 1024) {
        try { fs.rmSync(`${file}.1`, { force: true }); } catch { /* 旧轮转件 */ }
        fs.renameSync(file, `${file}.1`);
      }
    } catch { /* 文件还不存在 */ }
    fs.appendFileSync(file, `[${new Date().toISOString()}] ${line}\n`);
  } catch { /* 日志写不进去不阻断壳 */ }
}

function recordShellEvent(kind, fields = {}) {
  try {
    fs.mkdirSync(CRASH_DIR, { recursive: true });
    const base = {
      kind,
      at: new Date().toISOString(),
      appVersion: APP_VERSION,
      electronVersion: process.versions.electron,
      nodeVersion: process.versions.node,
      pid: process.pid,
      isQuitting,
      ...fields,
    };
    const line = crashRecord ? crashRecord.serializeShellEvent(base) : `${JSON.stringify(base)}\n`;
    fs.appendFileSync(SHELL_EVENTS_FILE, line);
  } catch (e) { log(`crash record failed: ${e && e.message ? e.message : e}`); }
}

function writeShellExit(code) {
  try {
    fs.mkdirSync(path.dirname(SHELL_EXIT_FILE), { recursive: true });
    fs.writeFileSync(SHELL_EXIT_FILE, `${JSON.stringify({
      schema: 1,
      code: Number.isFinite(Number(code)) ? Number(code) : 0,
      at: new Date().toISOString(),
      pid: process.pid,
      appVersion: APP_VERSION,
      electronVersion: process.versions.electron,
    }, null, 2)}\n`);
  } catch { /* 退出路径尽力 */ }
}

function tokenOf() {
  if (process.env.QQBOT_PANEL_TOKEN) return String(process.env.QQBOT_PANEL_TOKEN).trim();
  const candidates = [
    path.join(USER_ROOT, 'panel', '.token'),
    path.join(REPO_ROOT, 'panel', '.token'),
  ];
  for (const file of candidates) {
    try {
      const token = fs.readFileSync(file, 'utf8').trim();
      if (token) return token;
    } catch { /* 下一处 */ }
  }
  return '';
}

async function postPanel(route, timeoutMs = 5000) {
  refreshPanelUrl();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('timeout')), timeoutMs);
  const token = tokenOf();
  try {
    const res = await fetch(new URL(route, PANEL_URL).href, {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: ac.signal,
    });
    return { status: res.status, body: (await res.text()).slice(0, 300) };
  } catch (e) {
    return { status: 0, body: e && e.message ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}

function waitPortClosed(timeoutMs = 8000) {
  const target = new URL(PANEL_URL);
  const port = Number(target.port) || (target.protocol === 'https:' ? 443 : 80);
  return new Promise((resolve) => {
    const t0 = Date.now();
    const tick = () => {
      // 固定 127.0.0.1：PANEL_URL 若写 localhost，可能解析到 ::1 而面板只绑 127.0.0.1，
      // 会把“端口已关”误判成关闭，从而跳过 stop.mjs 兜底。
      const s = net.connect({ port, host: '127.0.0.1' });
      let settled = false;
      const done = (closed) => {
        if (settled) return;
        settled = true;
        s.destroy();
        if (closed) resolve(true);
        else if (Date.now() - t0 >= timeoutMs) resolve(false);
        else setTimeout(tick, 250);
      };
      s.setTimeout(400);
      s.once('connect', () => done(false));
      s.once('timeout', () => done(true));
      s.once('error', () => done(true));
    };
    tick();
  });
}

function readPidFile(file) {
  try {
    const n = Number.parseInt(String(fs.readFileSync(file, 'utf8')).trim(), 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch { return 0; }
}

function readJsonPid(file) {
  try {
    const obj = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    const n = Number(obj && obj.pid);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch { return 0; }
}

function pidAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function writeShellState() {
  try {
    fs.mkdirSync(path.dirname(SHELL_STATE_FILE), { recursive: true });
    fs.writeFileSync(SHELL_STATE_FILE, `${JSON.stringify({
      pid: process.pid,
      exe: process.execPath,
      appVersion: APP_VERSION,
      electronVersion: process.versions.electron,
      nodeVersion: process.versions.node,
      programRoot: process.env.QQBOT_PROGRAM_ROOT || REPO_ROOT,
      startedAt: new Date().toISOString(),
    }, null, 2)}\n`);
  } catch (e) { log(`shell-state write failed: ${e && e.message ? e.message : e}`); }
}

function clearShellState() {
  try {
    const obj = JSON.parse(fs.readFileSync(SHELL_STATE_FILE, 'utf8').replace(/^\uFEFF/, ''));
    if (Number(obj && obj.pid) === process.pid) fs.rmSync(SHELL_STATE_FILE, { force: true });
  } catch { /* 不是自己的或已删 */ }
}

function writeQuitIntent() {
  try {
    fs.mkdirSync(path.dirname(QUIT_INTENT_FILE), { recursive: true });
    fs.writeFileSync(QUIT_INTENT_FILE, `${JSON.stringify({ pid: process.pid, at: new Date().toISOString() })}\n`);
  } catch { /* 退出链不因标记失败而中断 */ }
}

function clearQuitIntent() {
  try { fs.rmSync(QUIT_INTENT_FILE, { force: true }); } catch { /* 已删 */ }
}

/**
 * Windows Toast 的身份链：`setAppUserModelId` 只给进程贴标签，
 * 系统还要一个**带同名 AUMID 的开始菜单快捷方式**才会把通知算到这个应用头上。
 * NSIS 创建的快捷方式指向 wscript→launcher（稳定入口），这里只补 AUMID，不改 target/args。
 */
function ensureToastShortcut() {
  if (process.platform !== 'win32' || !INSTALL_ROOT) return;
  const appData = process.env.APPDATA || app.getPath('appData');
  const dir = path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Estrella Bot');
  const lnk = path.join(dir, 'Estrella Bot.lnk');
  try {
    if (fs.existsSync(lnk)) {
      const cur = shell.readShortcutLink(lnk);
      if (cur && String(cur.appUserModelId || '') === APP_ID) {
        log(`toast shortcut ok ${lnk}`);
        return;
      }
      const ok = shell.writeShortcutLink(lnk, 'update', { appUserModelId: APP_ID });
      log(`toast shortcut update=${ok} ${lnk}`);
      return;
    }
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wscript.exe');
    const vbs = path.join(INSTALL_ROOT, 'launcher', 'Estrella-Bot.vbs');
    const icon = path.join(INSTALL_ROOT, 'launcher', 'estrella-bot.ico');
    const ok = shell.writeShortcutLink(lnk, 'create', {
      target, args: `"${vbs}"`, icon, iconIndex: 0, appUserModelId: APP_ID, description: 'Estrella Bot',
    });
    log(`toast shortcut create=${ok} ${lnk}`);
  } catch (e) {
    log(`toast shortcut failed: ${e && e.message ? e.message : e}`);
  }
}

async function runStopFallback() {
  if (!INSTALL_ROOT) return { ok: true, skipped: 'no-install-root' };
  const nodeExe = path.join(INSTALL_ROOT, 'runtime', 'node', process.platform === 'win32' ? 'node.exe' : 'node');
  const stopFile = path.join(INSTALL_ROOT, 'tools', 'stop.mjs');
  if (!fs.existsSync(nodeExe) || !fs.existsSync(stopFile)) return { ok: true, skipped: 'no-stop-script' };
  log('quit: stop.mjs fallback');
  return new Promise((resolve) => {
    const child = spawn(nodeExe, [
      stopFile, '--install-root', INSTALL_ROOT, '--user-root', USER_ROOT,
      '--exclude-pid', String(process.pid),
    ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const take = (d) => { if (out.length < 8000) out += String(d); };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* 已退出 */ }
      resolve({ ok: false, timeout: true, out });
    }, 40000);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, code, signal, out });
    });
    child.once('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, error: e && e.message ? e.message : String(e), out });
    });
  });
}

async function quitResidual({ panelPid, botPid }) {
  const portOpen = await new Promise((resolve) => {
    const s = net.connect({ port: Number(new URL(PANEL_URL).port) || panelDiscovery.LEGACY_PANEL_PORT, host: '127.0.0.1' });
    const done = (v) => { s.destroy(); resolve(v); };
    s.setTimeout(500);
    s.once('connect', () => done(true));
    s.once('timeout', () => done(false));
    s.once('error', () => done(false));
  });
  const lockPid = readJsonPid(path.join(USER_ROOT, 'panel', '.bridge.lock'));
  return {
    portOpen,
    panelPid: panelPid && pidAlive(panelPid) ? panelPid : 0,
    botPid: botPid && pidAlive(botPid) ? botPid : 0,
    lockPid: lockPid && pidAlive(lockPid) ? lockPid : 0,
  };
}

async function healthPid() {
  const h = await panelHealth(2000);
  return h.ok ? (Number(h.body && h.body.pid) || 0) : 0;
}

async function panelHealthAt(port, timeoutMs = 2000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${Number(port)}/api/health`, { signal: ac.signal });
    let body = null;
    try { body = await res.json(); } catch { body = null; }
    return { ok: res.status === 200 && Boolean(body && body.ok), status: res.status, body };
  } catch (e) {
    return { ok: false, status: 0, body: null, error: e && e.message ? e.message : String(e) };
  } finally { clearTimeout(timer); }
}

async function panelHealth(timeoutMs = 2000) {
  refreshPanelUrl();
  let port = 0;
  try { port = Number(new URL(PANEL_URL).port) || 0; } catch { port = 0; }
  if (!port) return { ok: false, status: 0, body: null, port: 0, url: PANEL_URL };
  return { ...(await panelHealthAt(port, timeoutMs)), port, url: PANEL_URL };
}

function programRoot() {
  return path.resolve(process.env.QQBOT_PROGRAM_ROOT || REPO_ROOT);
}

function ipcSenderUrl(event) {
  try {
    if (event && event.senderFrame && event.senderFrame.url) return event.senderFrame.url;
  } catch { /* frame disposed */ }
  try { return event && event.sender ? event.sender.getURL() : ''; } catch { return ''; }
}

function trustedIpc(event) {
  const pc = desktop && desktop.panelControl;
  if (!pc) return false;
  return pc.isTrustedRendererUrl(ipcSenderUrl(event), {
    panelUrl: PANEL_URL,
    errorFile: path.join(__dirname, 'error.html'),
  });
}

/** 等发现文件里出现**新 pid**且 /api/health 身份匹配的面板。 */
async function waitForNewPanel(oldPid, timeoutMs = 30000) {
  const pc = desktop && desktop.panelControl;
  if (!pc) return null;
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const info = panelDiscovery.readDiscovery(USER_ROOT);
    if (info && Number(info.pid) !== Number(oldPid) && panelDiscovery.isLive(info)) {
      const h = await panelHealthAt(info.port, 1500);
      if (pc.healthMatches({ body: h.body, appId: APP_ID, version: APP_VERSION, pid: info.pid })) {
        PANEL_URL = info.url;
        return info;
      }
    }
    await sleep(300);
  }
  return null;
}

function panelCommandLine(pid) {
  try {
    if (process.platform === 'win32') {
      const ps = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}").CommandLine`],
      { encoding: 'utf8', timeout: 5000, windowsHide: true });
      return String(ps.stdout || '').trim();
    }
    const ps = spawnSync('ps', ['-o', 'command=', '-p', String(Number(pid))], { encoding: 'utf8', timeout: 3000 });
    return String(ps.stdout || '').trim();
  } catch { return ''; }
}

async function stopProcessTree(pid) {
  if (!pidAlive(pid)) return true;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 10000 });
    } else {
      try { process.kill(-pid, 'SIGTERM'); } catch { try { process.kill(pid, 'SIGTERM'); } catch { /* 已退 */ } }
    }
  } catch { /* 已退或权限不足 */ }
  const t0 = Date.now();
  while (Date.now() - t0 < 8000) {
    if (!pidAlive(pid)) return true;
    await sleep(200);
  }
  if (process.platform !== 'win32') {
    try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* 已退 */ } }
  }
  await sleep(300);
  return !pidAlive(pid);
}

/**
 * 半死恢复：面板进程还在但不健康时，先确认命令行确实指向本程序的 panel/server.js 再收掉；
 * 身份不可确认就**不杀**，宁可多起一个系统端口上的新面板，也不误杀同机其它 node。
 */
async function spawnPanelDirect() {
  const pc = desktop && desktop.panelControl;
  if (!pc) return { ok: false, error: '面板控制模块没有加载' };
  const before = panelDiscovery.readDiscovery(USER_ROOT);
  if (before && panelDiscovery.isLive(before)) {
    const cmd = panelCommandLine(before.pid);
    if (cmd && pc.panelCmdlineBelongsToProgram(cmd, programRoot())) {
      log(`panel recover: stopping unresponsive panel pid=${before.pid}`);
      const stopped = await stopProcessTree(before.pid);
      if (!stopped) return { ok: false, error: `旧面板 pid ${before.pid} 停不下来` };
    } else {
      log(`panel recover: discovery pid=${before.pid} 身份不可确认（${cmd ? '命令行不匹配' : '读不到命令行'}），不杀，改起新面板`);
    }
  } else if (before) {
    try { panelDiscovery.clearDiscovery(USER_ROOT, before.pid); } catch { /* 陈旧文件尽力清 */ }
  }

  let spec;
  try {
    spec = pc.buildPanelSpawnSpec({
      installRoot: INSTALL_ROOT,
      programRoot: programRoot(),
      userRoot: USER_ROOT,
      configFile: CONFIG_FILE,
      env: process.env,
    });
  } catch (e) { return { ok: false, error: `拉起参数不合法：${e.message}` }; }
  if (!fs.existsSync(spec.panelFile)) return { ok: false, error: `找不到面板入口：${spec.panelFile}` };
  if (path.isAbsolute(spec.command) && !fs.existsSync(spec.command)) {
    return { ok: false, error: `找不到运行时：${spec.command}` };
  }

  fs.mkdirSync(path.dirname(spec.logFile), { recursive: true });
  let fd;
  try {
    fd = fs.openSync(spec.logFile, 'a');
    const child = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      detached: true,
      windowsHide: true,
      stdio: ['ignore', fd, fd],
      env: spec.env,
    });
    const spawnedPid = Number(child.pid) || 0;
    child.once('error', (e) => log(`panel recover spawn error: ${e && e.message ? e.message : e}`));
    child.unref();
    log(`panel recover: spawned pid=${spawnedPid} ${spec.command} ${spec.args.join(' ')}`);
    const info = await waitForNewPanel(0, 30000);
    if (!info) {
      return { ok: false, error: `面板 30 秒内没有通过健康检查（日志：${spec.logFile}）`, pid: spawnedPid };
    }
    return { ok: true, pid: info.pid, port: info.port, url: info.url, spawnedPid };
  } catch (e) {
    return { ok: false, error: `控制台起不来：${e.message}` };
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* 已关 */ } }
  }
}

function reloadPanelWindow() {
  refreshPanelUrl();
  if (!win || win.isDestroyed()) return;
  win.loadURL(PANEL_URL).catch((e) => log(`reload panel failed: ${e && e.message ? e.message : e}`));
}

let panelRestarting = false;
let lastPanelRecoveryError = '';

async function restartPanelIpc() {
  if (panelRestarting) {
    return { ok: true, restarted: true, pending: true, msg: '面板正在重启中，稍等它自己回来' };
  }
  const pc = desktop && desktop.panelControl;
  if (!pc) return { ok: false, error: '面板控制模块没有加载' };
  panelRestarting = true;
  lastPanelRecoveryError = '';
  try {
    const disc = panelDiscovery.readDiscovery(USER_ROOT);
    const beforeUrl = PANEL_URL;
    const h = await panelHealth(2000);
    const oldPid = (h.ok && Number(h.body && h.body.pid)) || (disc && disc.pid) || 0;
    // 面板可能被别的入口重启到新端口：窗口还停在旧 origin，这里直接接上新地址。
    if (h.ok && PANEL_URL !== beforeUrl) {
      reloadPanelWindow();
      return {
        ok: true, restarted: true, adopted: true,
        pid: Number(h.body && h.body.pid) || 0,
        port: h.port || 0, url: PANEL_URL,
        msg: '面板已在新端口，窗口已接上',
      };
    }
    const mode = pc.decideRestartMode({ restarting: false, healthOk: h.ok });
    if (mode === 'http') {
      const r = await postPanel('/api/panel/restart', 10000);
      const outcome = pc.parseRestartResponse({ status: r.status, text: r.body });
      if (outcome.ok) {
        if (!outcome.restarted) {
          return { ok: true, restarted: false, msg: outcome.msg || '面板已是最新代码，没有重启' };
        }
        const info = await waitForNewPanel(outcome.oldPid || oldPid, 30000);
        if (!info) {
          lastPanelRecoveryError = '面板重启后 30 秒内没有回来';
          return { ok: false, error: lastPanelRecoveryError };
        }
        reloadPanelWindow();
        return { ok: true, restarted: true, pid: info.pid, port: info.port, url: info.url, msg: '面板已重启' };
      }
      if (outcome.terminal) return { ok: false, error: outcome.error || '面板拒绝重启' };
      log(`panel restart route failed (${outcome.error}); falling back to direct spawn`);
    }
    const rec = await spawnPanelDirect();
    if (!rec.ok) {
      lastPanelRecoveryError = rec.error || '面板没有起来';
      return rec;
    }
    reloadPanelWindow();
    return {
      ok: true, restarted: true, recovered: true,
      pid: rec.pid, port: rec.port, url: rec.url, msg: '面板已重新拉起',
    };
  } catch (e) {
    lastPanelRecoveryError = e && e.message ? e.message : String(e);
    return { ok: false, error: lastPanelRecoveryError };
  } finally {
    panelRestarting = false;
  }
}

/**
 * 只退控制台：停面板 + 退壳，**不碰机器人**（与 /api/panel/quit 的语义一致）。
 * 托盘「退出」仍走 quitChain（整程序退出，会停机器人）。
 */
async function stopPanelOnly() {
  const pc = desktop && desktop.panelControl;
  let intent = null;
  try {
    intent = JSON.parse(fs.readFileSync(path.join(USER_ROOT, 'panel', '.restart.json'), 'utf8').replace(/^\uFEFF/, ''));
  } catch { intent = null; }
  const watchdog = Number(intent && intent.watchdogPid) || 0;
  if (watchdog && pidAlive(watchdog)) {
    const at = Date.parse(String(intent && intent.at || ''));
    const fresh = Number.isFinite(at) && Date.now() - at < 10 * 60 * 1000;
    const cmd = panelCommandLine(watchdog);
    const ours = Boolean(pc && cmd && pc.panelCmdlineBelongsToProgram(cmd, programRoot()));
    if (ours || fresh) {
      log(`quit-console: stopping restart watchdog pid=${watchdog}`);
      await stopProcessTree(watchdog);
    } else {
      log(`quit-console: watchdog pid=${watchdog} 身份不可确认，不杀`);
    }
  }

  const info = panelDiscovery.readDiscovery(USER_ROOT);
  if (info && panelDiscovery.isLive(info)) {
    const cmd = panelCommandLine(info.pid);
    if (pc && cmd && pc.panelCmdlineBelongsToProgram(cmd, programRoot())) {
      log(`quit-console: stopping panel pid=${info.pid}`);
      await stopProcessTree(info.pid);
    } else {
      log(`quit-console: panel pid=${info.pid} 身份不可确认，不杀`);
    }
  } else if (info) {
    try { panelDiscovery.clearDiscovery(USER_ROOT, info.pid); } catch { /* 陈旧文件尽力清 */ }
  }
  try { fs.rmSync(path.join(USER_ROOT, 'panel', '.restart.json'), { force: true }); } catch { /* 已删 */ }
}

let consoleQuitting = false;
async function quitConsoleOnly() {
  if (consoleQuitting || isQuitting) return;
  consoleQuitting = true;
  isQuitting = true;
  saveWindowState();
  writeQuitIntent();
  log('quit-console: panel + shell only (bot stays)');
  try {
    const h = await panelHealth(1500);
    if (h.ok) {
      const p = await postPanel('/api/panel/quit', 8000);
      log(`quit-console: panel/quit → ${p.status}`);
      await waitPortClosed(5000);
    }
    await stopPanelOnly();
  } catch (e) {
    log(`quit-console: ${e && e.message ? e.message : e}`);
  } finally {
    clearQuitIntent();
    clearShellState();
    writeShellExit(0);
    app.exit(0);
  }
}

async function quitChain() {
  if (isQuitting) return;
  isQuitting = true;
  saveWindowState();
  writeQuitIntent();
  const panelPid = await healthPid();
  const botPid = readPidFile(path.join(USER_ROOT, 'panel', '.bridge.pid'));
  log(`quit: panel=${panelPid || '-'} bot=${botPid || '-'}`);
  log('quit: /api/bridge/stop');
  const b = await postPanel('/api/bridge/stop', 25000);
  log(`quit: bridge/stop → ${b.status}`);
  log('quit: /api/panel/quit');
  const p = await postPanel('/api/panel/quit', 10000);
  log(`quit: panel/quit → ${p.status}`);
  const closed = await waitPortClosed(12000);
  log(`quit: port closed=${closed}`);
  // 端口关 ≠ 机器人已退：面板 shutdown 刻意不杀机器人，而端口一关就可能先返回。
  // 所以安装版**无条件**跑一次 stop.mjs（排除壳自己），再核对四件。
  const stop = await runStopFallback();
  log(`quit: stop.mjs ${JSON.stringify({ ok: stop.ok, skipped: stop.skipped, code: stop.code, signal: stop.signal, timeout: stop.timeout, error: stop.error })}`);
  if (stop.out) log(`quit: stop.mjs out=${stop.out.replace(/\s+/g, ' ').slice(0, 1200)}`);
  // 面板 shutdown 有 1 秒兜底退出；立刻核对会把“正在退出”误报成残留。
  await new Promise((r) => setTimeout(r, 600));
  const residual = await quitResidual({ panelPid, botPid });
  log(`quit: residual ${JSON.stringify(residual)}`);
  clearQuitIntent();
  clearShellState();
  writeShellExit(0);
  app.exit(0);
}

function windowStateFile() {
  return path.join(USER_DATA, 'desktop-window-state.json');
}

function readWindowState() {
  try {
    const text = fs.readFileSync(windowStateFile(), 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(text);
  } catch { return null; }
}

function saveWindowState() {
  if (!win || win.isDestroyed()) return;
  try {
    const maximized = win.isMaximized();
    const b = maximized ? win.getNormalBounds() : win.getBounds();
    fs.writeFileSync(windowStateFile(), `${JSON.stringify({ ...b, maximized, v: 1 }, null, 2)}\n`);
  } catch { /* 状态写不进去不影响运行 */ }
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveWindowState, 500);
}

function trayIcon() {
  const candidates = [
    INSTALL_ROOT ? path.join(INSTALL_ROOT, 'launcher', 'estrella-bot.ico') : '',
    path.join(REPO_ROOT, 'packaging', 'windows', 'launcher', 'estrella-bot.ico'),
  ].filter(Boolean);
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    const img = nativeImage.createFromPath(file);
    if (!img.isEmpty()) return { image: img, degraded: false };
  }
  // 1×1 透明 PNG：托盘不可见，但至少让 Tray 构造成功。这里必须标记 degraded ——
  // 构造成功 + getBounds 非零不等于用户看得见图标；不标记就会在图标缺失时
  // 把窗口藏到一个没有入口的托盘里。
  return {
    image: nativeImage.createFromDataURL(
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    ),
    degraded: true,
  };
}

function readClosePreference() {
  try {
    const text = fs.readFileSync(CONFIG_FILE, 'utf8').replace(/^\uFEFF/, '');
    const cfg = JSON.parse(text);
    const v = cfg && cfg.launch && cfg.launch.closeAction;
    return v === 'quit' ? 'quit' : 'tray';
  } catch { return 'tray'; }
}

/** Explorer 不在时托盘图标没有宿主；此时 getBounds 仍可能残留非零值。 */
function explorerRunning() {
  if (process.platform !== 'win32') return true;
  try {
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq explorer.exe', '/NH'], {
      encoding: 'utf8', timeout: 1200, windowsHide: true,
    });
    return /explorer\.exe/i.test(out);
  } catch { return true; }   // 查不到就 fail-open，不因探测失败把窗口误判成不可用
}

/** 通知区域被策略整体关闭时，Tray 仍可能有 bounds，但用户看不到图标。 */
function notificationAreaDisabled() {
  if (process.platform !== 'win32') return false;
  const now = Date.now();
  if (now - notifyAreaCache.at < 10000) return notifyAreaCache.value;
  let value = false;
  try {
    const out = execFileSync('reg', [
      'query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Policies\\Explorer',
      '/v', 'NoTrayItemsDisplay',
    ], { encoding: 'utf8', timeout: 1200, windowsHide: true });
    value = /NoTrayItemsDisplay\s+REG_DWORD\s+0x1\b/i.test(out);
  } catch { value = false; }
  notifyAreaCache = { at: now, value };
  return value;
}

function trayUsableReason() {
  if (TRAY_FORCE) return TRAY_FORCE;
  if (TRAY_THROW) return 'throw';
  if (trayFailed) return 'throw';
  if (!tray) return 'missing';
  if (trayDegraded) return 'icon';
  try { if (tray.isDestroyed && tray.isDestroyed()) return 'explorer'; } catch { return 'explorer'; }
  if (!explorerRunning()) return 'explorer';
  if (notificationAreaDisabled()) return 'notify-area';
  let bounds = null;
  try { bounds = tray.getBounds(); } catch { return 'explorer'; }
  return desktop.shellState.trayUsable(bounds, {
    degraded: trayDegraded, createFailed: trayFailed, notificationAreaDisabled: false,
  }) ? 'ok' : 'bounds';
}

function trayUsableNow() {
  return trayUsableReason() === 'ok';
}

function startTrayHealthGuard() {
  if (trayHealthTimer) return;
  trayHealthTimer = setInterval(() => {
    // ⚠️ 最小化的窗口 isVisible() 也是 false —— 只认"我们自己藏到托盘"这一种。
    // 少了 trayHidden 这层，P2-1 的最小化会在 10 秒内被守护自己拉回来。
    if (isQuitting || !win || win.isDestroyed() || !trayHidden || win.isVisible()) return;
    const reason = trayUsableReason();
    if (reason === 'ok') return;
    log(`tray lost while hidden (${reason}) -> show`);
    showWindow();
  }, 10000);
  trayHealthTimer.unref?.();
}

function showWindow(force = false) {
  if (!win || win.isDestroyed()) { pendingShow = true; return; }
  /* 页面还没首绘就 show 会先露底色（用户看到的就是"白窗/空窗闪一下"）。
     二实例、托盘、通知点击都可能早于 ready-to-show；先排队，等首绘后再显示。
     4 秒兜底是唯一例外（force）：底色已与开屏同色，宁可出窗口也不留"点了没反应"。 */
  if (!windowReady && !force) { pendingShow = true; return; }
  trayHidden = false;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  try { win.setSkipTaskbar(false); } catch { /* 老版本无此 API */ }
}

function hideToTray() {
  if (!win || win.isDestroyed()) return;
  trayHidden = true;
  win.hide();
  try { win.setSkipTaskbar(true); } catch { /* 老版本无此 API */ }
  startTrayHealthGuard();
}

function confirmBackgroundClose() {
  if (SMOKE_CLOSE) return true;
  const marker = path.join(USER_DATA, 'background-close-confirmed');
  if (fs.existsSync(marker)) return true;
  const response = dialog.showMessageBoxSync(win, {
    type: 'info',
    title: 'Estrella Bot',
    message: '关闭窗口 = 驻留托盘',
    detail: '程序会继续在后台运行；可从托盘重新打开，或在托盘菜单里退出。'
      + '托盘不可用时，关闭会自动最小化到任务栏。'
      + '想改成“关闭即退出”，可在左下角「设置 → 启动」里切换。',
    buttons: ['取消', '隐藏到托盘'],
    defaultId: 1,
    cancelId: 0,
    noLink: true,
  });
  if (response !== 1) return false;
  try { fs.writeFileSync(marker, `${new Date().toISOString()}\n`); } catch { /* 标记写不进去下次再问 */ }
  return true;
}

function showNotification(payload) {
  const title = String((payload && payload.title) || 'Estrella Bot').slice(0, 120);
  const body = String((payload && payload.body) || '').slice(0, 1000);
  if (!body) return { ok: false, error: '空通知' };
  if (Notification.isSupported()) {
    const n = new Notification({ title, body });
    n.on('click', showWindow);
    n.show();
    return { ok: true, channel: 'native' };
  }
  if (tray && process.platform === 'win32') {
    tray.displayBalloon({ title, content: body });
    return { ok: true, channel: 'balloon' };
  }
  return { ok: false, error: '当前系统不支持通知' };
}

function loadError(message) {
  if (!win || win.isDestroyed()) return;
  const text = String(message || '控制台没有响应').slice(0, 300);
  win.loadFile(path.join(__dirname, 'error.html'), { query: { message: text } })
    .catch(() => { /* 本地错误页都打不开时只剩日志 */ });
}

function displaysForWindow() {
  const primary = screen.getPrimaryDisplay();
  const all = screen.getAllDisplays();
  return [primary, ...all.filter((d) => d.id !== primary.id)].map((d) => ({
    id: d.id,
    workArea: d.workArea,
    scaleFactor: d.scaleFactor,
    rotation: d.rotation,
  }));
}

function reflowWindow() {
  if (!win || win.isDestroyed()) return;
  const displays = displaysForWindow();
  const before = win.getBounds();
  const r = desktop.windowBounds.reflowForDisplays({
    bounds: before,
    normalBounds: win.getNormalBounds(),
    maximized: win.isMaximized(),
    displays,
  });
  // 最大化且原屏还在：不动。对最大化窗口 setBounds 会把它还原，反而破坏状态。
  if (win.isMaximized() && !r.unmaximize) {
    log(`reflow keep maximized displays=${JSON.stringify(displays.map((d) => d.workArea))}`);
    return;
  }
  try {
    if (r.unmaximize && win.isMaximized()) win.unmaximize();
    win.setBounds(r.bounds);
    if (r.remaximize) win.maximize();
  } catch { /* 窗口正在关闭 */ }
  log(`reflow displays=${JSON.stringify(displays.map((d) => ({
    workArea: d.workArea, scaleFactor: d.scaleFactor, rotation: d.rotation,
  })))} before=${JSON.stringify(before)} after=${JSON.stringify(r)}`);
}

function createWindow() {
  const displays = displaysForWindow();
  const saved = desktop.windowBounds.normalizeWindowState(readWindowState());
  const bounds = desktop.windowBounds.clampBounds(
    saved || desktop.windowBounds.defaultBounds(displays[0] ? displays[0].workArea : null),
    displays,
  );
  const dark = nativeTheme.shouldUseDarkColors;
  windowReady = false;
  win = new BrowserWindow({
    ...bounds,
    minWidth: desktop.windowBounds.MIN_WIDTH,
    minHeight: desktop.windowBounds.MIN_HEIGHT,
    show: false,
    title: 'Estrella Bot',
    backgroundColor: dark ? '#050812' : '#dfeeff',
    /* 原生窗口框：Windows 用系统标题栏（最小化/最大化/关闭都在自己的条里），macOS 用标准标题栏。
       不再用 titleBarStyle:'hidden' + titleBarOverlay —— 那会把系统按钮叠进网页顶栏。 */
    frame: true,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webviewTag: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      /* 隐藏窗口也要按真实时钟跑开屏：否则 rAF/定时器被节流，窗口一显示就是中间态。 */
      backgroundThrottling: false,
      paintWhenInitiallyHidden: true,
      devTools: !INSTALL_ROOT,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  log(`window bounds ${JSON.stringify(win.getBounds())} displays=${JSON.stringify(displays.map((d) => ({
    workArea: d.workArea, scaleFactor: d.scaleFactor, rotation: d.rotation,
  })))}`);
  // 隐藏窗口在某些会话里不触发首绘 ⇒ ready-to-show 永远不来（真机安装版实测）。
  // 这不是“再点一次就好”的小毛病：第一次双击必须出窗口。4 秒兜底只在应显示时补。
  const showFallback = setTimeout(async () => {
    if (!win || win.isDestroyed() || isQuitting) return;
    const decision = desktop.shellState.decideStartVisibility({ hidden: HIDDEN, trayUsable: trayUsableNow() });
    if (!((decision === 'show' || pendingShow) && !win.isVisible())) return;
    log('fallback show (ready-to-show timeout)');
    /* 先让渲染进程产出一帧再 show：VM 首装/杀毒扫描时 ready-to-show 可能晚到十几秒，
       直接 show 会先露出 backgroundColor（表现为“空窗/白窗闪一下”）。
       最多等 800ms，渲染进程真卡死时仍要出窗口。 */
    try {
      await Promise.race([
        win.webContents.executeJavaScript(
          'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))',
          true,
        ),
        new Promise((r) => setTimeout(r, 800)),
      ]);
    } catch { /* 页面还没就绪：仍然尝试 show，至少不是永久无窗口 */ }
    if (!win || win.isDestroyed() || isQuitting) return;
    if ((decision === 'show' || pendingShow) && !win.isVisible()) showWindow(true);
  }, 4000);
  win.once('ready-to-show', () => {
    clearTimeout(showFallback);
    windowReady = true;
    if (saved && saved.maximized) win.maximize();
    const decision = desktop.shellState.decideStartVisibility({ hidden: HIDDEN, trayUsable: trayUsableNow() });
    if (decision === 'hidden') trayHidden = true;
    if (decision === 'show' || pendingShow) {
      showWindow();
      // ready-to-show 里的 show() 在个别会话（由安装器拉起、窗口站刚切换）会晚一拍才映射；
      // 600ms 后再补一次，避免“第一次双击没窗口、再点一次才出来”。
      setTimeout(() => {
        if (win && !win.isDestroyed() && !win.isVisible()) showWindow();
      }, 600);
    }
    /* 开屏期需要满速 rAF；窗口稳定显示后恢复后台节流，避免常驻托盘时空转。 */
    setTimeout(() => {
      if (!win || win.isDestroyed()) return;
      try { win.webContents.setBackgroundThrottling(true); } catch { /* 老版本无此 API */ }
    }, 12000);
    log(`start decision=${decision} visible=${win.isVisible()}`);
    if (SMOKE_NOTIFY) {
      setTimeout(() => {
        const sent = showNotification({ title: 'Estrella Bot', body: '通知通道工作正常' });
        log(`smoke-notify ${JSON.stringify(sent)}`);
      }, 1200);
    }
    if (SMOKE_CLOSE) {
      setTimeout(() => {
        log(`smoke-close before visible=${win.isVisible()} minimized=${win.isMinimized()}`);
        win.close();
        setTimeout(() => {
          if (win && !win.isDestroyed()) {
            log(`smoke-close after visible=${win.isVisible()} minimized=${win.isMinimized()}`);
          }
        }, 600);
      }, 1500);
    }
    if (SMOKE_QUIT) setTimeout(() => { log('smoke-quit'); void quitChain(); }, 1500);
    if (SMOKE_CRASH) {
      setTimeout(() => {
        if (SMOKE_CRASH === 'renderer' && win && !win.isDestroyed()) {
          log('smoke-crash renderer');
          win.webContents.forcefullyCrashRenderer();
        } else if (SMOKE_CRASH === 'main') {
          log('smoke-crash main');
          if (typeof process.crash === 'function') process.crash();
          else app.exit(1);
        }
      }, 2000);
    }
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    const verdict = desktop.urlPolicy.classifyExternal(url);
    if (verdict.ok) void shell.openExternal(verdict.url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (desktop.urlPolicy.isPanelUrl(url, PANEL_URL)) return;
    event.preventDefault();
    const verdict = desktop.urlPolicy.classifyExternal(url);
    if (verdict.ok) void shell.openExternal(verdict.url);
  });
  win.webContents.on('will-redirect', (event, url) => {
    if (!desktop.urlPolicy.isPanelUrl(url, PANEL_URL)) event.preventDefault();
  });
  win.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    if (!isMainFrame) return;
    log(`did-fail-load ${code} ${description}`);
    recordShellEvent('did-fail-load', { reason: description || String(code), exitCode: code, url });
    loadError(`控制台没有连上（${description || code}）`);
  });
  win.webContents.on('render-process-gone', (_event, details) => {
    const reason = details && details.reason;
    const code = details && details.exitCode;
    log(`renderer gone: ${reason} code=${code}`);
    recordShellEvent('renderer-gone', {
      reason,
      exitCode: code,
      url: win && !win.isDestroyed() ? win.webContents.getURL() : '',
    });
    if (!isQuitting) loadError(`界面进程退出：${reason || 'unknown'}`);
  });

  win.on('close', (event) => {
    if (isQuitting) return;
    event.preventDefault();
    // 面板两态开关写 config.json；env 只作测试覆盖。读不到偏好按 tray（fail-open）。
    const preference = CLOSE_ACTION === 'quit' ? 'quit'
      : CLOSE_ACTION === 'tray' ? 'tray'
        : readClosePreference();
    const usable = trayUsableNow();
    const reason = trayUsableReason();
    const action = desktop.shellState.decideCloseAction({ quitting: false, trayUsable: usable, preference });
    log(`close action=${action} preference=${preference} trayUsable=${usable} reason=${reason}`);
    if (action === 'quit') {
      saveWindowState();
      void quitChain();
      return;
    }
    if (action === 'hide') {
      if (!confirmBackgroundClose()) return;
      saveWindowState();
      hideToTray();
      return;
    }
    trayHidden = false;
    saveWindowState();
    win.minimize();
    try { win.setSkipTaskbar(false); } catch { /* 老版本无此 API */ }
  });
  win.on('closed', () => { win = null; windowReady = false; });
  for (const ev of ['resize', 'move', 'maximize', 'unmaximize']) win.on(ev, scheduleSave);

  screen.on('display-removed', reflowWindow);
  screen.on('display-metrics-changed', reflowWindow);
  win.loadURL(PANEL_URL);
}

function createTray() {
  if (TRAY_THROW) {
    trayFailed = true;
    tray = null;
    log('tray create skipped (QQBOT_TRAY_THROW=1)');
    return;
  }
  try {
    const icon = trayIcon();
    trayDegraded = icon.degraded;
    tray = new Tray(icon.image);
    tray.setToolTip('Estrella Bot');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '打开控制台', click: showWindow },
      { label: '测试通知', click: () => { showNotification({ title: 'Estrella Bot', body: '通知通道工作正常' }); } },
      { type: 'separator' },
      { label: '退出', click: () => { void quitChain(); } },
    ]));
    tray.on('click', showWindow);
    tray.on('double-click', showWindow);
  } catch (e) {
    tray = null;
    trayFailed = true;
    log(`tray create failed: ${e && e.message ? e.message : e}`);
  }
  log(`tray usable=${trayUsableNow()} reason=${trayUsableReason()}`);
}

function setupIpc() {
  ipcMain.handle('shell:notify', (event, payload) => {
    if (!trustedIpc(event)) return { ok: false, error: '不信任的调用来源' };
    return showNotification(payload);
  });
  ipcMain.handle('shell:retry', (event) => {
    if (!trustedIpc(event)) return { ok: false, error: '不信任的调用来源' };
    refreshPanelUrl();
    if (win && !win.isDestroyed()) win.loadURL(PANEL_URL);
    return { ok: true };
  });
  ipcMain.handle('shell:quit', (event) => {
    if (!trustedIpc(event)) return { ok: false, error: '不信任的调用来源' };
    void quitChain();
    return { ok: true, quitting: true };
  });
  ipcMain.handle('shell:quit-console', (event) => {
    if (!trustedIpc(event)) return { ok: false, error: '不信任的调用来源' };
    void quitConsoleOnly();
    return { ok: true, quitting: true };
  });
  ipcMain.handle('shell:restart-panel', async (event) => {
    if (!trustedIpc(event)) return { ok: false, error: '不信任的调用来源' };
    return await restartPanelIpc();
  });
  ipcMain.handle('shell:panel-state', async (event) => {
    if (!trustedIpc(event)) return { ok: false, error: '不信任的调用来源' };
    const h = await panelHealth(1500);
    return {
      ok: true,
      alive: h.ok,
      pid: h.ok ? (Number(h.body && h.body.pid) || 0) : 0,
      port: h.port || 0,
      url: PANEL_URL,
      restarting: panelRestarting,
      lastError: lastPanelRecoveryError,
    };
  });
  ipcMain.handle('shell:visible', (event) => {
    if (!trustedIpc(event)) return false;
    return Boolean(win && !win.isDestroyed() && win.isVisible());
  });
}

function main() {
  app.on('second-instance', () => { pendingShow = true; showWindow(); });
  app.on('before-quit', (event) => {
    if (isQuitting) return;
    event.preventDefault();
    void quitChain();
  });
  app.on('will-quit', () => { isQuitting = true; clearShellState(); });
  app.on('session-end', () => { writeQuitIntent(); void quitChain(); });
  app.on('window-all-closed', () => { /* 留在托盘，不因窗口关闭退出 */ });
  app.on('child-process-gone', (_event, details) => {
    recordShellEvent('child-process-gone', {
      type: details && details.type,
      reason: details && details.reason,
      exitCode: details && details.exitCode,
    });
  });
  app.on('activate', () => showWindow());
  process.on('uncaughtException', (e) => {
    const msg = e && e.stack ? e.stack : String(e);
    log(`uncaught: ${msg}`);
    recordShellEvent('main-uncaught', { message: msg });
    writeShellExit(1);
    app.exit(1);
  });
  process.on('unhandledRejection', (e) => {
    const msg = e && e.stack ? e.stack : String(e);
    log(`unhandled: ${msg}`);
    recordShellEvent('main-unhandled', { message: msg });
  });
  process.on('exit', (code) => { writeShellExit(code); });

  app.whenReady().then(async () => {
    try { app.setPath('crashDumps', CRASH_DIR); } catch { /* 老 Electron 无此路径 */ }
    try {
      crashReporter.start({ uploadToServer: false, compress: true });
    } catch (e) { log(`crashReporter start failed: ${e && e.message ? e.message : e}`); }
    try { crashRecord = await import('../src/desktop/crash-record.js'); } catch { crashRecord = null; }
    desktop = {
      urlPolicy: await import('../src/desktop/url-policy.js'),
      windowBounds: await import('../src/desktop/window-bounds.js'),
      shellState: await import('../src/desktop/shell-state.js'),
      panelControl: await import('../src/desktop/panel-control.js'),
    };
    session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
      callback(permission === 'clipboard-sanitized-write');
    });
    /* Windows/Linux：去掉 Electron 默认 File/Edit/View/Window 菜单，只留系统标题栏；
       macOS 保留标准应用菜单（系统惯例）。 */
    if (process.platform !== 'darwin') Menu.setApplicationMenu(null);
    createWindow();
    createTray();
    startTrayHealthGuard();
    setupIpc();
    writeShellState();
    ensureToastShortcut();
    log(`ready electron=${process.versions.electron} node=${process.versions.node} app=${APP_VERSION || 'dev'} programRoot=${process.env.QQBOT_PROGRAM_ROOT || REPO_ROOT} panel=${PANEL_URL}`);
  }).catch((e) => {
    log(`fatal: ${e && e.stack ? e.stack : e}`);
    dialog.showErrorBox('Estrella Bot', `壳启动失败：${e && e.message ? e.message : e}`);
    app.exit(1);
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  main();
}
