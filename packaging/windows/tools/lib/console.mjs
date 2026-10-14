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
import { spawn } from 'node:child_process';
import { APP, NODE_EXE, IS_WIN, exists, ok, warn, dim, say } from './common.mjs';

export const PANEL_PORT = Number(process.env.QQBOT_PANEL_PORT) || 8788;
export const PANEL_URL = `http://127.0.0.1:${PANEL_PORT}/`;
export const PANEL_LOG = path.join(APP, 'panel', 'panel.log');

/** 端口上有没有东西应答（与面板自己的判据同一口径：只问在不在）。 */
export function panelUp(timeout = 1500) {
  return new Promise((resolve) => {
    const s = net.connect({ port: PANEL_PORT, host: '127.0.0.1' });
    const done = (v) => { s.destroy(); resolve(v); };
    s.setTimeout(timeout);
    s.once('connect', () => done(true));
    s.once('timeout', () => done(false));
    s.once('error', () => done(false));
  });
}

export async function waitPanelUp(ms = 25000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await panelUp(1500)) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
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
    cwd: APP, detached: true, windowsHide: true, stdio: ['ignore', log, log],
  });
  child.once('error', (e) => {
    try { fs.appendFileSync(PANEL_LOG, `[${new Date().toISOString()}] ✗ 控制台起不来：${e.message}\n`); } catch { /* 兜底 */ }
  });
  child.unref();
  const up = await waitPanelUp(25000);
  return { up, pid: child.pid, url: PANEL_URL };
}

/** 用系统默认浏览器打开。打不开不算失败 —— 页面上还会给出地址。 */
export function openBrowser(url = PANEL_URL) {
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
  if (await panelUp()) {
    ok(`控制台已在运行（${PANEL_PORT}）`);
    const opened = open ? openBrowser() : false;
    return { url: PANEL_URL, reused: true, opened };
  }
  dim('  正在拉起控制台（后台运行，**不会有黑窗口**）…');
  const r = await startPanel();
  if (!r.up) {
    warn(`控制台 25 秒内没应答 —— 看 ${path.relative(APP, PANEL_LOG)} 里的报错`);
    return { url: PANEL_URL, reused: false, opened: false };
  }
  ok('控制台已就绪');
  const opened = open ? openBrowser() : false;
  return { url: PANEL_URL, reused: false, opened };
}
