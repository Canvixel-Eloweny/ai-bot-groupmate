/**
 * Windows 双击启动器的**实现**（2026-10-08 · Windows 适配）。
 * ══════════════════════════════════════════════════════════════════════════
 *  为什么真正的逻辑在这里，而不是写在 `.bat` 里
 * ══════════════════════════════════════════════════════════════════════════
 *  ① `.bat` 的换行**必须 CRLF** 才最稳，而本仓有一条硬契约：**全仓文本文件零 CRLF**
 *     （`check-wb` §77② —— 它同时是 `.gitattributes` 不产生全仓历史 diff 的前提）。
 *     两条规矩正面相撞时，本项目的解法是**把复杂度从危险的那一侧挪走**：
 *     `.bat` 只留三行、纯 ASCII、**没有 label / 没有括号块 / 没有 for** ——
 *     简单到这个程度，LF 也是安全的（LF 出问题的历来都是 `goto` 的按字节重定位）。
 *  ② `.bat` 里要显示中文得先 `chcp 65001`，而它会改掉整个控制台的代码页。
 *     文案放进 Node 就没有这个问题（Node 本来就是 UTF-8）。
 *
 *  与 macOS 的 `QQ-BOT-CONTROL.app` **语义逐条对齐**（这是有意的，别各自发挥）：
 *    · 控制台没在跑 → 起它（detached，日志进 panel/panel.log）
 *    · 起完**立刻**开浏览器 —— 不等 Docker、不等别的慢活
 *    · 机器人**不自动启动**：开控制台 ≠ 让机器人开始说话
 *
 *  ⚠️ **唯一有意的不一致**：macOS 那一支顺手会拉起 Docker Desktop；
 *     Windows 这条路线用的是**原生 NapCat**（不装 Docker），所以这里没有那一环。
 *     理由见用户手册第 9 节：NapCat 的 Windows 版是当期的，而 macOS 版白名单停在半年前 ——
 *     Docker 那条路本来就是为绕开 macOS 的版本问题才上的。
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** 仓库根：`.bat` 把 `%~dp0` 当第一个参数传进来；直接 `node` 跑就从本文件退一级。 */
const ROOT = path.resolve(
  process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
);
const PORT = Number(process.env.QQBOT_PANEL_PORT) || 8788;
const PANEL_URL = `http://127.0.0.1:${PORT}/`;

/** 探一次面板在不在。只判"端口上有没有东西应答"，与 `.app` 的 `panel_up` 同一口径。 */
function panelUp(timeout = 2000) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/api/state', timeout }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

async function waitPanelUp(ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await panelUp(1500)) return true;
    await new Promise((s) => setTimeout(s, 400));
  }
  return false;
}

/**
 * 用系统默认浏览器打开页面。
 *
 * ⚠️ `start` 是 cmd 的**内建命令**，不是 exe，所以必须经 `cmd.exe /c` 调用。
 * ⚠️ 那个空字符串参数是**必需的**：`start` 把**第一个带引号的参数**当成窗口标题，
 *    少了它，URL 会被当成标题、浏览器根本不开 —— 而且**没有任何报错**。
 */
function openBrowser(url) {
  try {
    spawn('cmd.exe', ['/c', 'start', '', url], {
      detached: true, stdio: 'ignore', windowsHide: true,
    }).unref();
  } catch { /* 开不了浏览器不该让启动器整体失败 —— 页面上会打印地址 */ }
}

async function main() {
  const already = await panelUp();
  if (!already) {
    if (!fs.existsSync(path.join(ROOT, 'panel', 'server.js'))) {
      console.log(`✗ 这里不像是项目根目录（找不到 panel/server.js）：${ROOT}`);
      process.exitCode = 1;
      return;
    }
    console.log('控制台没在跑，正在启动…');
    // ⚠️ detached + windowsHide + unref：面板必须活过这个启动器进程（它就是"双击完就退"
    //    的那个壳）。这与 `panel/server.js` 起机器人的姿势**刻意相同** —— 本项目里
    //    "怎么甩掉一个后台进程"只该有一种写法。
    const log = fs.openSync(path.join(ROOT, 'panel', 'panel.log'), 'a');
    const child = spawn(process.execPath, [path.join(ROOT, 'panel', 'server.js')], {
      cwd: ROOT, detached: true, windowsHide: true, stdio: ['ignore', log, log],
    });
    child.unref();
    if (!(await waitPanelUp(25000))) {
      console.log('✗ 控制台没能在 25 秒内起来。看一下 panel/panel.log 里的报错。');
      process.exitCode = 1;
      return;
    }
  }
  openBrowser(PANEL_URL);
  console.log(`已打开控制台：${PANEL_URL}`);
  console.log('机器人不会自动开始说话 —— 到页面里点右上角的「一键启动」。');
}

main().catch((e) => {
  console.log(`✗ 启动器出错：${e && e.message ? e.message : e}`);
  process.exitCode = 1;
});
