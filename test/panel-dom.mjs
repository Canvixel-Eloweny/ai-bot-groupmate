/**
 * 前端 DOM 常驻守卫 —— 用真浏览器把**每个页面都渲染一遍**（2026-10-14 新增）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  它补的是四层门禁的**空档**
 * ══════════════════════════════════════════════════════════════════════════
 *   · `check-wb` 是**静态**扫描：只抓形状，抓不到白屏；
 *   · `smoke` 不渲染页面、不起浏览器；
 *   · `panel-boot.mjs` 只验后端"答不答得上"，**不执行页面脚本**；
 *   · `verify-panel.mjs`（旧面板那 403 条断言）已在 S-12 第六批随旧页一起删除。
 *   ⇒ 「白屏 / TDZ / 点了没反应 / 某个页面的控件集体消失」这一类，
 *     **四层全绿也照样漏**。这个文件就是补它。
 *
 * ⚠️⚠️ **找不到浏览器一律 SKIP + exit 0**（绝不产生"假失败"）。
 *     理由：一个会因环境缺失而报红的门禁，迟早被人从流程里摘掉 ——
 *     而那比没有它更糟，因为大家会以为还有覆盖。
 *     三条路径都要实测过才算能用：**有浏览器且对 → 0 / 有浏览器且错 → 1 / 找不到 → SKIP 0**。
 *
 * ⚠️ **不许改用 jsdom**：`panel/next/index.html` 用 `<script type="module" src="./app.js">`，
 *     而 jsdom **不执行 ES 模块** ⇒ 表现是"零报错、零内容"（2026-10-14 实测：
 *     `.steps` 数出 0，极易误判成"我的改动没生效"）。这里走 **CDP 直连真 Chromium**。
 *
 * ⚠️ 隔离（每一条都对着一个踩过的坑）：
 *   · 面板用**随机空闲端口** + `QQBOT_SANDBOX=1`（不碰真机 8788、不接管真机器人）；
 *   · `NODE_OPTIONS` 清空（shell 注入的 shim 会把 `err.code` 改写成别的）；
 *   · 浏览器用**独立的临时 user-data-dir**，且收尾按**进程组**杀
 *     （Chromium 是主进程 + 一堆子进程，只杀主进程会留下渲染进程占着 profile）；
 *   · 错误收集器挂在**页面脚本之前**（`Page.addScriptToEvaluateOnNewDocument`）——
 *     模块加载期抛错只有它看得见。
 *
 * 用法：`node test/panel-dom.mjs`
 *   指定浏览器：`PANEL_DOM_BROWSER=/path/to/chrome node test/panel-dom.mjs`
 * @returns {Promise<number>} 0 = 通过或 SKIP；1 = 真有断言失败
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const NODE = process.execPath;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── 找浏览器：找不到就 SKIP（不是失败）────────────────────────────────── */
function findBrowser() {
  if (process.env.PANEL_DOM_BROWSER) {
    return fs.existsSync(process.env.PANEL_DOM_BROWSER) ? process.env.PANEL_DOM_BROWSER : null;
  }
  const home = os.homedir();
  const fixed = process.platform === 'darwin'
    ? [
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    ]
    : process.platform === 'win32'
      ? [
        path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      ]
      : [];
  for (const p of fixed) if (p && fs.existsSync(p)) return p;

  // Playwright 缓存里的 chrome-headless-shell（本机常见的"浏览器其实早就在"）
  const cache = path.join(home, 'Library', 'Caches', 'ms-playwright');
  try {
    for (const d of fs.readdirSync(cache)) {
      for (const sub of ['chrome-headless-shell-mac-arm64/chrome-headless-shell',
        'chrome-headless-shell-mac-x64/chrome-headless-shell',
        'chrome-headless-shell-linux64/chrome-headless-shell']) {
        const p = path.join(cache, d, sub);
        if (fs.existsSync(p)) return p;
      }
    }
  } catch { /* 没这个目录就继续 */ }

  for (const cmd of ['google-chrome', 'chromium', 'chromium-browser', 'chrome']) {
    const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { encoding: 'utf8' });
    const p = String(r.stdout || '').split('\n')[0].trim();
    if (r.status === 0 && p) return p;
  }
  return null;
}

const freePort = () => new Promise((res, rej) => {
  const s = net.createServer();
  s.on('error', rej);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
});
const tcpUp = (p, ms = 700) => new Promise((res) => {
  const s = net.connect({ port: p, host: '127.0.0.1' });
  const done = (v) => { s.destroy(); res(v); };
  s.setTimeout(ms); s.on('connect', () => done(true));
  s.on('timeout', () => done(false)); s.on('error', () => done(false));
});

/* ── SKIP：不是失败 ────────────────────────────────────────────────────── */
const BROWSER = findBrowser();
if (!BROWSER) {
  console.log('SKIP 前端 DOM 守卫：本机没有找到 Chromium 系浏览器（Edge / Chrome / chromium / chrome-headless-shell）。');
  console.log('     装了任何一个就会自动跑起来；也可以显式指定：');
  console.log('       PANEL_DOM_BROWSER=/path/to/chrome node test/panel-dom.mjs');
  console.log('     ⇒ 这里**刻意算通过**（exit 0）：环境缺失不该变成假红，否则这道门会被摘掉。');
  process.exit(0);
}
console.log(`浏览器：${BROWSER}`);

const fails = [];
const ok = (cond, msg) => { console.log(`${cond ? '  ✓' : '  ✗'} ${msg}`); if (!cond) fails.push(msg); };

const panelPort = await freePort();
const cdpPort = await freePort();
const BASE = `http://127.0.0.1:${panelPort}`;
const profile = path.join(os.tmpdir(), `panel-dom-${process.pid}-${Date.now()}`);

const panel = spawn(NODE, ['panel/server.js'], {
  cwd: ROOT,
  env: { ...process.env, QQBOT_PANEL_PORT: String(panelPort), QQBOT_SANDBOX: '1', NODE_OPTIONS: '' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let srvOut = '';
panel.stdout.on('data', (d) => { srvOut += d; });
panel.stderr.on('data', (d) => { srvOut += d; });

const browser = spawn(BROWSER, [
  // `--no-sandbox --disable-gpu` 在受限环境里是**必须**的：不加会报
  // "sandbox initialization failed"，连 about:blank 都渲染不出来
  // （表现是 spawn 之后 CDP 端口一直不通，而错误在浏览器自己的 stderr 里）。
  '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
  '--headless', `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`,
  '--window-size=1440,1100', '--hide-scrollbars', '--no-first-run',
  'about:blank',
], { stdio: 'ignore', detached: true });
browser.unref();

let ws = null;
try {
  let up = false;
  for (let i = 0; i < 90 && !up; i++) { up = await tcpUp(panelPort); if (!up) await sleep(200); }
  if (!up) throw new Error(`沙箱面板没起来（端口 ${panelPort}）。启动输出：\n${srvOut.slice(-800)}`);

  let target = null;
  for (let i = 0; i < 80 && !target; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
      target = list.find((x) => x.type === 'page' && x.webSocketDebuggerUrl);
    } catch { /* 还没起来 */ }
    if (!target) await sleep(300);
  }
  if (!target) throw new Error('浏览器的 CDP 目标没出现（渲染进程没起来？）');

  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let seq = 0; const pend = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
  };
  const send = (method, params = {}) => new Promise((r) => {
    const id = ++seq; pend.set(id, r); ws.send(JSON.stringify({ id, method, params }));
  });
  const evalJs = async (expression) => {
    const m = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (m.result?.exceptionDetails) {
      throw new Error('页面里求值抛错：' + JSON.stringify(m.result.exceptionDetails).slice(0, 300));
    }
    return m.result?.result?.value;
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `window.__errs = [];
      addEventListener('error', (e) => window.__errs.push(String((e && e.message) || e)));
      addEventListener('unhandledrejection', (e) => window.__errs.push('unhandled: ' + String(e && e.reason)));`,
  });
  await send('Page.navigate', { url: `${BASE}/` });

  // 等首屏落到 #page（要先 fetch /api/state）
  let booted = false;
  for (let i = 0; i < 50 && !booted; i++) {
    booted = await evalJs('document.querySelectorAll("#page *").length > 5');
    if (!booted) await sleep(300);
  }
  if (!booted) throw new Error('首屏 15 秒内没渲染出内容 —— 页面脚本可能白屏了');

  console.log('\n── 首屏 ──');
  const first = await evalJs(`(() => {
    const stps = [...document.querySelectorAll('.steps .stp')];
    return {
      errs: (window.__errs || []).slice(0, 5),
      cards: document.querySelectorAll('#page .card').length,
      groups: document.querySelectorAll('#nav1 .grp').length,
      pageChars: (document.getElementById('page') || {}).textContent ? document.getElementById('page').textContent.length : 0,
      stepsRows: stps.map((el) => ({ txt: (el.querySelector('.stp-tx') || {}).textContent || '', cur: el.getAttribute('data-cur') })),
      emptyCount: document.querySelectorAll('.steps-empty').length,
    };
  })()`);
  ok((first.errs || []).length === 0, `首屏零运行时错误${(first.errs || []).length ? '：' + first.errs.join(' | ') : ''}`);
  ok(first.cards >= 1, `首屏渲染出卡片（${first.cards} 张）`);
  ok(first.groups >= 3, `功能域导航渲染出来（${first.groups} 个）`);
  ok(first.pageChars > 200, `首屏文字量正常（${first.pageChars} 字符，不是"有一层壳但没内容"）`);

  console.log('\n── 「启动链路」检查表 ──');
  ok(first.emptyCount === 0, '旧占位 .steps-empty 没出现');
  ok(first.stepsRows.length >= 4, `检查表至少 4 行（协议端 / 控制台 / 群聊 / 机器人；云端大脑再加 Key 一行 = 5。实得 ${first.stepsRows.length}）`);
  ok(first.stepsRows.filter((r) => r.cur === '1').length === 1, '恰好一行被点亮（data-cur="1"）');
  for (const r of first.stepsRows) console.log(`     [cur=${r.cur}] ${r.txt}`);
  const curTxt = (first.stepsRows.find((r) => r.cur === '1') || {}).txt || '';
  ok(!/：在跑$|：已填$|运行中$/.test(curTxt), '点亮的是「还没就绪的那一件」，不是已经好的');

  // ── 遍历每个功能域 × 每个子页（这才是这个守卫真正要抓的：某一页白屏）──
  console.log('\n── 逐页遍历 ──');
  const r = await evalJs(`(async () => {
    const out = [];
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const nGroups = document.querySelectorAll('#nav1 .grp').length;
    const errsBefore0 = () => (window.__errs || []).length;
    for (let g = 0; g < nGroups; g++) {
      document.querySelectorAll('#nav1 .grp')[g].click();
      await sleep(150);
      const nSubs = document.querySelectorAll('#nav2 .sub').length;
      for (let s = 0; s < nSubs; s++) {
        const before = errsBefore0();
        const sub = document.querySelectorAll('#nav2 .sub')[s];
        const label = (document.querySelectorAll('#nav1 .grp')[g].textContent || '').replace(/\\d+$/, '') + ' / ' + (sub.textContent || '');
        sub.click();
        await sleep(160);
        const page = document.getElementById('page');
        out.push({
          label,
          cards: page.querySelectorAll('.card').length,
          textLen: (page.textContent || '').length,
          newErrs: (window.__errs || []).length - before,
          sample: (page.textContent || '').trim().slice(0, 40),
          sampleAll: (page.textContent || ''),
        });
      }
    }
    return out;
  })()`);

  const blank = r.filter((x) => x.textLen < 80);
  const errored = r.filter((x) => x.newErrs > 0);
  /* ⚠️ 这条和上面那条不是一回事：`ctrlHtml()` 会把**渲染器自己抛的错**接住，
     然后在页面上写一行「渲染「xxx」时出错：…」—— 它**不进 window error**，
     所以"零运行时错误"那一栏对它**永远是绿的**（2026-10-14 实测踩到：
     readyChecklist 里漏了一行 `const botRunning`，表现就是 0 行 + 零报错）。
     ⇒ 只能靠扫页面文本。 */
  const renderErr = r.filter((x) => /渲染「.*」时出错/.test(x.sampleAll || ''));
  console.log(`  共遍历 ${r.length} 个页面`);
  ok(r.length >= 8, `页面数像个真的（实得 ${r.length}）—— 少于 8 说明导航没渲染全，"逐页遍历"这条判据在真空里`);
  ok(blank.length === 0, `没有白屏页（${blank.length} 页文字量 < 80）`);
  if (blank.length) for (const b of blank.slice(0, 6)) console.log(`     ✗ ${b.label} · ${b.textLen} 字符 · 「${b.sample}」`);
  ok(errored.length === 0, `逐页点击零运行时错误（${errored.length} 页有错）`);
  if (errored.length) for (const b of errored.slice(0, 6)) console.log(`     ✗ ${b.label} · 新增 ${b.newErrs} 条错误`);
  ok(renderErr.length === 0, `没有"渲染时出错"的自带错误行（${renderErr.length} 页有）—— `
    + '这类错被 ctrlHtml 接住写进页面，window error 看不见，只能扫文本');
  if (renderErr.length) for (const b of renderErr.slice(0, 6)) console.log(`     ✗ ${b.label} · 「${(b.sampleAll || '').slice(0, 120)}」`);

  const counts = r.map((x) => `${x.label.trim()}=${x.cards}`).join(' ');
  console.log(`  每页卡片数：${counts}`);
} catch (e) {
  fails.push(`守卫自己出错：${e && e.message ? e.message : e}`);
} finally {
  try { ws && ws.close(); } catch { /* 已断 */ }
  try { process.kill(-browser.pid, 'SIGKILL'); } catch { try { browser.kill('SIGKILL'); } catch { /* 没了 */ } }
  panel.kill('SIGTERM');
  for (let i = 0; i < 30 && panel.exitCode === null; i++) await sleep(100);
  if (panel.exitCode === null) panel.kill('SIGKILL');
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* 清不掉就算了 */ }
}

if (fails.length) {
  for (const p of fails.slice(0, 12)) console.log(`✗ ${p}`);
  console.log(`── ${fails.length} 处问题 ──`);
  process.exit(1);
}
console.log('\n✓ 前端 DOM 守卫通过：首屏 + 检查表 + 逐页遍历（含零运行时错误 / 无白屏页）');
process.exit(0);
