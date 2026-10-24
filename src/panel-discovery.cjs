/**
 * 面板端口的**发现文件**契约（P3-1 · 2026-10-24）。
 *
 * 面板在 installed / portable 形态下监听系统分配的端口（0），启动成功后把**实际端口**
 * 原子写进 `USER_ROOT/panel/.panel.json`。启动器、Electron 壳、停止链、诊断工具都读
 * 这一份文件，而不是猜 8788。
 *
 * 三条纪律：
 *   ① 文件里**不放 token**。token 仍然只在 `panel/.token`（0600），发现文件只是地址。
 *   ② 读方必须校验 pid 活着 + 端口/URL 形状合法；pid 已死的是**陈旧发现**，不是"面板在跑"。
 *   ③ `LEGACY_PANEL_PORT` 只用于识别/停掉 P3-1 之前的面板，**绝不用来启动或打开页面**。
 *
 * 用 CJS 是因为 Electron 主进程（electron/main.js）是 CommonJS；ESM 侧默认导入即可。
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DISCOVERY_SCHEMA = 1;
const PANEL_HOST = '127.0.0.1';
const LEGACY_PANEL_PORT = 8788;
const DISCOVERY_NAME = '.panel.json';

function normalizePort(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : 0;
}

function urlOf(port) {
  return `http://${PANEL_HOST}:${normalizePort(port)}/`;
}

function discoveryFile(userRoot) {
  return path.join(String(userRoot || ''), 'panel', DISCOVERY_NAME);
}

function normalizeInfo(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (Number(raw.schema) !== DISCOVERY_SCHEMA) return null;
  const port = normalizePort(raw.port);
  const pid = Number(raw.pid);
  const appId = String(raw.appId || '').trim();
  const version = String(raw.version || '').trim();
  if (!port || !Number.isInteger(pid) || pid <= 0 || !appId || !version) return null;
  if (String(raw.host || PANEL_HOST) !== PANEL_HOST) return null;
  let u;
  try { u = new URL(String(raw.url || urlOf(port))); } catch { return null; }
  if (u.protocol !== 'http:' || u.hostname !== PANEL_HOST || Number(u.port) !== port || u.pathname !== '/') return null;
  return {
    schema: DISCOVERY_SCHEMA,
    pid,
    port,
    host: PANEL_HOST,
    url: urlOf(port),
    appId,
    version,
    mode: String(raw.mode || ''),
    startedAt: String(raw.startedAt || ''),
  };
}

/** 读发现文件。任何形状问题都返回 null（fail-closed：坏文件不猜端口）。 */
function readDiscovery(userRoot) {
  try {
    const text = fs.readFileSync(discoveryFile(userRoot), 'utf8');
    return normalizeInfo(JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text));
  } catch {
    return null;
  }
}

function pidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try { process.kill(n, 0); return true; } catch { return false; }
}

/** pid 还活着才算"当前面板"；端口上有没有人应答由调用方再探（这里不造 IO）。 */
function isLive(info) {
  return Boolean(info && pidAlive(info.pid));
}

function writeDiscovery(userRoot, info) {
  const normalized = normalizeInfo({ ...info, schema: DISCOVERY_SCHEMA, url: urlOf(info && info.port) });
  if (!normalized) throw new Error('发现文件字段不合法（pid/port/appId/version）');
  const file = discoveryFile(userRoot);
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `${DISCOVERY_NAME}.tmp-${process.pid}`);
  const body = `${JSON.stringify(normalized, null, 2)}\n`;
  try {
    fs.writeFileSync(tmp, body, { mode: 0o600 });
    try {
      fs.renameSync(tmp, file);
    } catch {
      // Windows 上目标已存在时极少数文件系统会拒绝 rename：先移除再换，读方容忍这个空窗。
      fs.rmSync(file, { force: true });
      fs.renameSync(tmp, file);
    }
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch { /* 已改名 */ }
  }
  return normalized;
}

/**
 * 只清掉**自己的**发现文件。pid 不匹配说明这份文件已经是新面板写的 —— 老进程退出时
 * 绝不能把它删掉，否则页面/壳会突然找不到正在跑的那个端口。
 */
function clearDiscovery(userRoot, pid) {
  const cur = readDiscovery(userRoot);
  if (!cur) return false;
  const own = Number(pid);
  if (Number.isInteger(own) && own > 0 && cur.pid !== own) return false;
  try {
    fs.rmSync(discoveryFile(userRoot), { force: true });
    return true;
  } catch {
    return false;
  }
}

function legacyPanelUrl() {
  return urlOf(LEGACY_PANEL_PORT);
}

module.exports = {
  DISCOVERY_SCHEMA,
  PANEL_HOST,
  LEGACY_PANEL_PORT,
  DISCOVERY_NAME,
  discoveryFile,
  normalizePort,
  urlOf,
  normalizeInfo,
  readDiscovery,
  isLive,
  pidAlive,
  writeDiscovery,
  clearDiscovery,
  legacyPanelUrl,
};
