/**
 * 实测「面板旧代码自检 + 一键重启」这一整条链：
 *   页面出黄条 → 点「重启面板」→ 后端换成新代码 → 页面自动回来 → 黄条消失。
 *
 * 场景是**真的**：磁盘上的 server.js 刚被改过，而进程还是改之前起的那个
 * （/api/state 此刻 panel.stale = true）。
 *
 * ⚠️ 第 11 轮（M-07）：CDP 脚手架**搬到 `lib/cdp.mjs`**，与 `browser-verify.mjs` 共用一份
 *    （此前两边各抄了一份逐字重复的实现）。各自不同的那几项（端口 / 视口铺法 / 裁切夹取）
 *    全部走显式参数，原行为逐字保留。
 * ⚠️ 本脚本需要面板正在 `127.0.0.1:8788` 上跑，且**磁盘上的 server.js 比进程新**；
 *    **不进 `npm test`**。
 */
import { launchCdp, makeCounter, sleep } from './lib/cdp.mjs';

const PORT = 9336;
const PANEL = 'http://127.0.0.1:8788';
const OUT = '/tmp/qqbot-shots';

const { check, counts } = makeCounter();

const { evalJs, shot, waitFor, close } = await launchCdp({
  port: PORT,
  panelUrl: PANEL,
  outDir: OUT,
  userDataDir: '/tmp/cdp-profile-qqbot2',
  readyTimeoutMs: 20000,
  readyStepMs: 250,
  postOverrideMs: 3000,
  clampClip: true,
});

const pidBefore = await evalJs('lastState.panel && lastState.panel.pid');
console.log(`\n当前面板进程 pid = ${pidBefore}`);

console.log('\n【实测 1】页面自动认出「服务端跑着旧代码」');
{
  check('后端报 stale = true', await evalJs('lastState.panel.stale === true'), JSON.stringify(await evalJs('lastState.panel')));
  check('★ 页面顶部出现黄条', await evalJs("document.getElementById('panelStale').style.display !== 'none'"));
  check('★ 黄条上写明原因（磁盘上的 server.js 比进程新）',
    await evalJs("document.getElementById('panelStale').textContent.includes('比正在跑的进程新')"));
  check('黄条上有「重启面板」按钮', await evalJs("!!document.getElementById('btnPanelRestart')"));
  await evalJs('document.getElementById("panelStale").scrollIntoView({block:"center"})');
  await sleep(500);
  await shot('4-旧代码提示条.png', '#panelStale');
}

console.log('\n【实测 2】点「重启面板」→ 后端真的换成了新代码');
{
  await evalJs('document.getElementById("btnPanelRestart").click()');
  // 新进程起来后页面会自己 location.reload()；等 pid 变化
  const ok = await waitFor(async () => {
    const pid = await evalJs('(typeof lastState !== "undefined" && lastState.panel) ? lastState.panel.pid : null');
    return pid && pid !== pidBefore ? pid : null;
  }, 45000, 700).catch(() => null);
  check('★ 面板进程被换成了新的 pid', !!ok, `${pidBefore} → ${ok}`);
  const stale = await evalJs('lastState.panel && lastState.panel.stale');
  check('★ 新进程自检 stale = false（磁盘代码已生效）', stale === false, String(stale));
  check('★ 黄条自动消失', await evalJs("document.getElementById('panelStale').style.display === 'none'"));
}

console.log('\n【实测 3】新代码生效后，两处能力开关文字一致（这是刚才那个改动）');
{
  const r = await evalJs(`(() => {
    const ls = (id) => [...document.querySelectorAll('#' + id + ' label.chk span:not(.dotmini)')].map((s) => s.textContent.trim());
    return { a: ls('featRow'), b: ls('wbFeatRow'), hint: lastState.featureLabels };
  })()`);
  check('机器人设置：' + r.a.join(' / '), r.a.length === 4);
  check('工作台：' + r.b.join(' / '), r.b.length === 4);
  check('★ 两处文字逐字一致', JSON.stringify(r.a) === JSON.stringify(r.b), JSON.stringify(r));
  check('★ 文字来自后端下发的 featureLabels',
    r.hint.webSearch === r.a[0] && r.hint.vision === r.a[1] && r.hint.stickers === r.a[2], JSON.stringify(r.hint));
}

const { pass, fail } = counts();
console.log(`\n──────── 自检与一键重启实测：${pass} 通过 / ${fail} 失败 ────────`);
close();
process.exit(fail ? 1 : 0);
