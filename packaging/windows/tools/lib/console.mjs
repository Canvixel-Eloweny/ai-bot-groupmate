/**
 * 控制台（面板）的**拉起 / 探活 / 关闭** —— 一键安装与日常启动共用同一份实现。
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  这个文件解决的是用户报上来的那个具体毛病
 * ══════════════════════════════════════════════════════════════════════════
 *  「控制端命令窗运行结束后**关不掉、也删不掉**」—— 因为它是一个**前台 cmd 窗口**：
 *  窗口在，进程就在；进程在，`app/` 下的文件就被占着，目录删不掉。
 *
 *  正解不是"教用户怎么关窗口"，而是**不再需要那个窗口**：
 *    · 面板以 `detached + windowsHide` 起 —— **没有窗口**（进程在后台，页面上能看见它）
 *    · 输出进 `app\panel\panel.log`，网页里的「终端」页实时显示同一份内容
 *    · 要停就从页面里点「退出控制台」—— 进程真退，目录随即可以删
 *
 *  ⚠️ 与 `app/scripts/win-launcher.mjs` 的关系：那是**仓库内**开发树的启动器
 *     （双击用它时，用户本来就在开发仓里）。本文件是**便携包**这一侧的实现：
 *     它必须用**包内的** node.exe，且必须不带窗口。两者语义一致、场景不同，
 *     谁也不调谁 —— 便携包里根本没有 `app/scripts/win-launcher.mjs` 之外的开发环境。
 */

import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { APP, USER_ROOT, MODE, CONFIG_JSON, NODE_EXE, IS_WIN, exists, ok, warn, dim, say } from './common.mjs';

function normalizePort(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : 0;
}

/** 显式覆盖（测试/多实例）；默认 0 = 系统分配，实际端口从发现文件读。 */
const PORT_OVERRIDE = normalizePort(process.env.QQBOT_PANEL_PORT);

// 发现模块从**当前程序根**加载（与 launcher 同理）：工具层顶层 `tools/` 与 `app/` 的
// 相对层级在便携包与开发树里不同，静态 import 会在真机上找不到文件。
const requireApp = createRequire(path.join(APP, 'package.json'));
let discoveryCache = null;
function panelDiscovery() {
  if (!discoveryCache) discoveryCache = requireApp(path.join(APP, 'src', 'panel-discovery.cjs'));
  return discoveryCache;
}
export const PANEL_LOG = path.join(USER_ROOT, 'panel', 'panel.log');

/** 指定端口上有没有东西应答（与面板自己的判据同一口径：只问在不在）。 */
export function panelUp(port, timeout = 1500) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: '127.0.0.1' });
    const done = (v) => { s.destroy(); resolve(v); };
    s.setTimeout(timeout);
    s.once('connect', () => done(true));
    s.once('timeout', () => done(false));
    s.once('error', () => done(false));
  });
}

async function healthAt(port) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 2000);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: ac.signal });
    const body = JSON.parse(await res.text());
    return { ok: res.status === 200 && body && body.ok === true, body };
  } catch {
    return { ok: false, body: null };
  } finally {
    clearTimeout(timer);
  }
}

/** 等**本次 spawn 的那个 pid** 写出发现文件并通过 /api/health。 */
export async function waitPanelUp(ms = 25000, childPid = 0) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const d = panelDiscovery();
    const info = d.readDiscovery(USER_ROOT);
    if (info && d.isLive(info) && (!childPid || info.pid === childPid)) {
      const h = await healthAt(info.port);
      if (h.ok) return info;
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return null;
}

/**
 * 起面板。**没有窗口**（这是本文件存在的理由）。
 *
 * ⚠️ 三个参数缺一不可，且都是刻意的：
 *   `detached`      —— 它必须活过"双击完就退"的那个 bat
 *   `windowsHide`   —— **不要**控制台窗口（缺了它就是用户抱怨的那个黑框）
 *   `stdio→文件`    —— 输出必须有地方去，否则会静默丢掉，排障时手上什么都没有
 */
export async function startPanel() {
  if (!exists(path.join(APP, 'panel', 'server.js'))) {
    throw new Error(`这里不像是本包（找不到 app\\panel\\server.js）`);
  }
  fs.mkdirSync(path.dirname(PANEL_LOG), { recursive: true });
  const log = fs.openSync(PANEL_LOG, 'a');
  const exe = exists(NODE_EXE) && IS_WIN ? NODE_EXE : process.execPath;
  const child = spawn(exe, [path.join(APP, 'panel', 'server.js')], {
    cwd: APP,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', log, log],
    env: {
      ...process.env,
      QQBOT_USER_ROOT: USER_ROOT,
      QQBOT_MODE: MODE,
      QQBOT_CONFIG: CONFIG_JSON,
      // 显式写进去：继承到的空/非法值不会让面板回落到 8788。
      QQBOT_PANEL_PORT: String(PORT_OVERRIDE),
    },
  });
  child.once('error', (e) => {
    try { fs.appendFileSync(PANEL_LOG, `[${new Date().toISOString()}] ✗ 控制台起不来：${e.message}\n`); } catch { /* 兜底 */ }
  });
  child.unref();
  const info = await waitPanelUp(25000, Number(child.pid) || 0);
  return {
    up: Boolean(info),
    pid: child.pid,
    port: info ? info.port : 0,
    url: info ? info.url : '',
  };
}

/** 用系统默认浏览器打开。打不开不算失败 —— 页面上还会给出地址。 */
export function openBrowser(url) {
  if (!IS_WIN) { say(`  请在浏览器打开：${url}`); return false; }
  try {
    // ⚠️ `start` 是 cmd 内建命令；那个空串是**窗口标题**位，少了它 URL 会被当成标题、
    //    浏览器根本不开，而且**没有任何报错**。
    spawn('cmd.exe', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    return true;
  } catch {
    return false;
  }
}

/**
 * 「把控制台弄起来」的**一次调用**：已经在跑就复用，没在跑就起，起完开浏览器。
 * @returns {Promise<{url:string, reused:boolean, opened:boolean}>}
 */
export async function ensureConsole({ open = true } = {}) {
  const d = panelDiscovery();
  const live = d.readDiscovery(USER_ROOT);
  if (live && d.isLive(live) && await panelUp(live.port)) {
    ok(`控制台已在运行（系统分配端口 ${live.port}）`);
    const opened = open ? openBrowser(live.url) : false;
    return { url: live.url, reused: true, opened };
  }
  dim('  正在拉起控制台（后台运行，**不会有黑窗口**）…');
  const r = await startPanel();
  if (!r.up) {
    warn(`控制台 25 秒内没应答 —— 看 ${path.relative(USER_ROOT, PANEL_LOG)} 里的报错`);
    return { url: '', reused: false, opened: false };
  }
  ok(`控制台已就绪（系统分配端口 ${r.port}）`);
  const opened = open ? openBrowser(r.url) : false;
  return { url: r.url, reused: false, opened };
}
