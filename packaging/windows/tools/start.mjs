/**
 * 日常启动入口（`2-START.bat` 与**桌面快捷方式**都调它）。
 * 一句话：**把协议端和控制台都弄起来，然后把浏览器开到控制台页面。**
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  这一版改了什么（2026-10-11）
 * ══════════════════════════════════════════════════════════════════════════
 *  ① **全程无窗口。** 以前它会 `stdio:'inherit'` 地把项目启动器跑到前台 ——
 *     于是桌面上多一个黑框，而那个黑框正是用户报的"关不掉、删不掉"。
 *     现在面板由 `lib/console.mjs` 起（detached + windowsHide），协议端也是后台 + 隐藏。
 *  ② **协议端走快速登录。** 把已登录的 QQ 号传给 NapCat 的启动器，
 *     登录态还在时**直接进**，不再每次弹二维码（细节见 `start-napcat.mjs`）。
 *  ③ 机器人**仍然不自动开始说话**（与项目一直以来的规矩一致）：
 *     起控制台 ≠ 让机器人开口，那由用户在页面里点「一键启动」决定。
 */

import { CONFIG_JSON, say, ok, warn, bad, title, dim, exists, isMain, portOpen } from './lib/common.mjs';
import { ensureConsole, PANEL_URL } from './lib/console.mjs';
import { startNapcat } from './start-napcat.mjs';

const PROTOCOL_PORT = 3001;

async function main() {
  const open = !process.argv.includes('--no-browser');
  title('Estrella Bot —— 启动');

  if (!exists(CONFIG_JSON)) {
    bad('还没有完成首次安装（找不到 app\\config.json）');
    say('  请先双击 一键安装.bat，大约一分钟。');
    process.exitCode = 1;
    return;
  }

  // ① 控制台**先**起来（2026-10-13 真机反馈：以前先等协议端，而协议端没登录时
  //    3001 永远不开 ⇒ 每次都白等满 60 秒，且这条启动链是**隐藏**的，
  //    用户眼前一片黑，只会反复双击 ⇒ 起好几个实例）。
  //    现在顺序倒过来：页面立刻出来（带着"正在连接控制台…"和三个状态灯），
  //    协议端在后台等，状态由页面自己轮询展示 —— 反馈即时，且不会重复启动。
  const c = await ensureConsole({ open });
  if (!c.url) {
    bad('控制台没能起来。看 app\\panel\\panel.log 里的报错。');
    process.exitCode = 2;
    return;
  }
  say('');
  ok(c.opened ? `已打开浏览器：${PANEL_URL}` : `控制台地址：${PANEL_URL}`);
  say('  控制台在后台跑，**没有黑窗口**；要停它就在页面里点「退出控制台」。');
  say('  机器人不会自己开口 —— 到页面里点右上角「一键启动」。');

  // ② 协议端：没在跑就后台拉起，**不阻塞**（页面上的灯自己会变）
  if (await portOpen(PROTOCOL_PORT)) {
    ok(`协议端已在运行（${PROTOCOL_PORT}）`);
    return;
  }
  dim('  协议端没在跑，正在后台拉起（首次需要扫码，二维码在控制台里）…');
  const r = await startNapcat();
  if (r.error === 'no-launcher') {
    warn('协议端（NapCat）还没装好 —— 控制台照样打开，但机器人连不上 QQ');
    dim('      装它：双击 一键安装.bat');
    return;
  }
  if (r.started) {
    ok('协议端已拉起（无窗口）。二维码：控制台 →「打开二维码登录」。');
    dim('      协议端完全就绪要等它启动完（几秒到几十秒），页面上的灯会变绿。');
  }
}

if (isMain(import.meta.url)) {
  try {
    await main();
  } catch (e) {
    say('');
    bad(`启动失败：${e && e.message ? e.message : e}`);
    process.exitCode = 2;
  }
}
