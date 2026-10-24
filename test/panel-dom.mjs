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
const USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-dom-userdata-'));
try {
  const ex = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.example.json'), 'utf8'));
  ex.llm = ex.llm || {};
  // 大脑页至少演示「一颗自定义模型 + 一颗添加」；只用脱敏 fixture，不碰真机 Key。
  ex.llm.customBrains = {
    'fixture-brain': {
      id: 'fixture-brain', name: '测试模型', baseUrl: 'https://api.example.com/v1',
      model: 'test-model', apiKey: '', fallbackModels: [], features: {},
      maxTokens: 400, temperature: 1,
    },
  };
  ex.llm.activeCustomId = 'fixture-brain';

  /* ── 插件页夹具（2026-10-23）────────────────────────────────────────────
     25 个真实目录 + `plugins.max=20` ⇒ 静态扫描 20 load / 5 over；
     再伪造一份 effective.json 让运行期卡片有钩子/工具/空载/告警可显示。
     ⚠️ 只写临时 USERDATA，不碰真机 `plugins/`（那份是 gitignore 的用户数据）。 */
  const ids = Array.from({ length: 25 }, (_, i) => `qa${String(i + 1).padStart(2, '0')}`);
  ex.custom = ex.custom && typeof ex.custom === 'object' ? ex.custom : {};
  ex.custom.plugins = { enabled: ids, settings: { qa01: { mode: 'def' } }, max: 20 };
  ex.custom.tools = { max: 64 };
  for (const id of ids) {
    const dir = path.join(USERDATA, 'plugins', id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({
      id, name: `QA ${id}`, version: '1.0.0', apiVersion: 1, entry: 'index.js',
      capabilities: [], permissions: [], requires: [],
      settings: id === 'qa01' ? { mode: 'def' } : {},
      configSchema: {},
    }, null, 2), 'utf8');
    fs.writeFileSync(path.join(dir, 'index.js'), 'export function setup() {}\n', 'utf8');
  }
  const rtItems = ids.slice(0, 20).map((id) => ({
    id, dirName: id, kind: 'plugin', name: `QA ${id}`, version: '1.0.0', state: 'loaded',
    tools: [`${id}__ping`], hooks: [['before-llm-messages', 1]], hookErrors: [], toolErrors: [], empty: false,
  }));
  rtItems[1] = { ...rtItems[1], tools: [], hooks: [], empty: true };
  rtItems[2] = { ...rtItems[2], tools: [], hooks: [], empty: true, hookErrors: [{ point: 'bogus-hook', reason: '未知钩子点' }] };
  rtItems[3] = { ...rtItems[3], toolErrors: [{ id: 'ping', reason: '工具数已达上限 64（不再注册「ping」）' }] };
  const overItems = ids.slice(20).map((id, i) => ({
    id, dirName: id, kind: 'plugin', name: `QA ${id}`, version: '1.0.0', state: 'over',
    tools: [], hooks: [], hookErrors: [], toolErrors: [], empty: false,
    detail: `白名单第 ${21 + i} 个，超过上限 20，本次未加载`,
  }));
  fs.mkdirSync(path.join(USERDATA, 'panel'), { recursive: true });
  fs.writeFileSync(path.join(USERDATA, 'panel', 'effective.json'), JSON.stringify({
    pid: 0, alive: true,
    extensions: {
      items: [...rtItems, ...overItems],
      sum: { total: 25, loaded: 20, pending: 0, skipped: 0, failed: 0, over: 5, tools: 20, hooks: 20, empty: 1 },
      limits: { plugins: 20, tools: 64, toolsUsed: 20 },
    },
  }, null, 2), 'utf8');

  fs.writeFileSync(path.join(USERDATA, 'config.json'), JSON.stringify(ex, null, 2));
} catch { /* 缺模板就按默认 */ }

const panel = spawn(NODE, ['panel/server.js'], {
  cwd: ROOT,
  env: {
    ...process.env,
    QQBOT_PANEL_PORT: String(panelPort),
    QQBOT_SANDBOX: '1',
    QQBOT_MODE: 'dev',
    QQBOT_USER_ROOT: USERDATA,
    NODE_OPTIONS: '',
  },
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

/* 被 Ctrl-C / 终端关闭打断时，下面的 `finally` 不保证会跑：Node 默认直接退出，
   子面板会被 init 收养（2026-10-20 五个 PPID-1 孤儿就是这么留下的）。
   这里注册同步硬清理；正常结束时 `finally` 仍走优雅收尾，最后把 cleaned 置真。
   ⚠️ SIGKILL 捕获不到 —— 这是无法兑现的承诺，不写。 */
let cleaned = false;
const hardCleanup = () => {
  if (cleaned) return;
  cleaned = true;
  try { ws && ws.close(); } catch { /* 已断 */ }
  try { process.kill(-browser.pid, 'SIGKILL'); } catch { try { browser.kill('SIGKILL'); } catch { /* 已退 */ } }
  try { panel.kill('SIGKILL'); } catch { /* 已退 */ }
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* 清不掉就留给 tmp */ }
  try { fs.rmSync(USERDATA, { recursive: true, force: true }); } catch { /* 清不掉就留给 tmp */ }
};
for (const [sig, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]]) {
  process.once(sig, () => { hardCleanup(); process.exit(code); });
}
process.on('exit', hardCleanup);

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
  const shot = async (name) => {
    const m = await send('Page.captureScreenshot', { format: 'png' });
    const data = m.result?.data;
    if (data) fs.writeFileSync(path.join(os.tmpdir(), name), Buffer.from(data, 'base64'));
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
  ok(first.stepsRows.length >= 4, `检查表至少 4 行（协议端 / 协议端自报 / 控制台 / 群聊 / 机器人；云端大脑再加 Key 一行。实得 ${first.stepsRows.length}）`);
  /* 2026-10-20 补：「协议端自报」那一行必须**真的画出来**（数据来自 state-collector 的
     `/get_version_info` + `/get_status`）。只断言后端下发了字段不算接线 —— 这一层是
     全项目唯一会真渲染这个检查表的门禁，行没了不会有任何别的门变红。 */
  ok(first.stepsRows.some((r) => /协议端自报/.test(r.txt)), '「协议端自报」那一行在检查表里（协议端身份回读有接到界面上）');
  /* 2026-10-20 补：机器人侧健康（B4/B6）也必须在界面上**看得见** ——
     上一行是"面板此刻问到了什么"，这一行是"机器人守着的 WS / 心跳 / 超时"。
     两个观测面合成一句会让人以为是同一时刻的事实，所以它们是两行。 */
  ok(first.stepsRows.some((r) => /机器人心跳/.test(r.txt)), '「机器人心跳」那一行在检查表里（机器人侧健康快照接到了界面上）');
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
        const grp = document.querySelectorAll('#nav1 .grp')[g];
        const label = (grp.title || grp.textContent || '').replace(/（\d+ 页）$/, '') + ' / ' + (sub.title || sub.textContent || '');
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
          // 大脑页重做（2026-10-17）：切换标签与免费额度按钮都是**数据驱动**的，
          // 少一个不会报错、只会"看着少了一块"——所以单独记数量，由下面钉住。
          brainTags: page.querySelectorAll('.brain-tags .brain-tag').length,
          // 免费额度 2026-10-17 第二次改版：整块卡片 ⇒ 「一键切换」卡里**一颗按钮**。
          quotaBtn: page.querySelectorAll('.quota-btn').length,
          quotaCard: page.querySelectorAll('#card-quota').length,
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

  /* ── 「回复长短」必须是横向进度条（2026-10-21）────────────────────────
     为什么单钉这一格：它是**纯视觉改造**，改坏了不会抛异常、也不会白屏 ——
     最可能的失效是"又退回竖向刻度"或"液面没跟着点击走"，两者都不报错。
     判据取真实几何（轨道宽/高、液面宽度、刻线数）与一次真实指针点击。 */
  console.log('\n── 「回复长短」进度条 ──');
  const tick = await evalJs(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const groups = [...document.querySelectorAll('#nav1 .grp')];
    const gi = groups.findIndex((g) => (g.textContent || '').includes('人格'));
    if (gi < 0) return { err: '找不到「人格」功能域' };
    groups[gi].click(); await sleep(150);
    const subs = [...document.querySelectorAll('#nav2 .sub')];
    const si = subs.findIndex((s) => (s.title || '').includes('回复设置'));
    if (si < 0) return { err: '找不到「回复设置」子页' };
    subs[si].click(); await sleep(200);
    const box = document.querySelector('.tkx[data-tk="r.len"]');
    if (!box) return { err: '回复设置里没有 .tkx[data-tk="r.len"]' };
    const row = box.querySelector('.tkx-row');
    const fill = box.querySelector('.rng-fill');
    if (!row || !fill) return { err: '进度条缺少轨道或液面（.rng-track / .rng-fill）' };
    const rb = row.getBoundingClientRect();
    const fb = fill.getBoundingClientRect();
    const all = [...box.querySelectorAll('.tkx-native input[type=radio]')];
    const ci = all.findIndex((r) => r.checked);
    const ti = ci < 0 ? 0 : (ci + 1) % all.length;
    const before = {
      checked: all[ci]?.value || '',
      label: box.querySelector('.tkx-name')?.textContent || '',
      p: box.style.getPropertyValue('--p'),
    };
    /* 点**下一档**的中心（不写死 90%）：当前档可能是任意一档，
       写死位置会在"当前已经是最后一档"时点了也不变，把功能正常误判成红。
       用真实 PointerEvent，走和手指/鼠标同一条 pointerdown → pointerup → commit。 */
    const x = rb.left + rb.width * ((ti + 0.5) / all.length);
    const ev = { bubbles: true, clientX: x, pointerId: 1, pointerType: 'mouse' };
    row.dispatchEvent(new PointerEvent('pointerdown', ev));
    row.dispatchEvent(new PointerEvent('pointerup', ev));
    await sleep(300);
    const box2 = document.querySelector('.tkx[data-tk="r.len"]') || box;
    const all2 = [...box2.querySelectorAll('.tkx-native input[type=radio]')];
    const after = {
      checked: all2.find((r) => r.checked)?.value || '',
      label: box2.querySelector('.tkx-name')?.textContent || '',
      p: box2.style.getPropertyValue('--p'),
      want: all[ti]?.parentElement?.querySelector('span')?.textContent || '',
    };
    const out = {
      before, after,
      w: rb.width, h: rb.height, fw: fb.width,
      n: Number(box.dataset.n),
      radios: box.querySelectorAll('.tkx-native input[type=radio]').length,
      stops: box.querySelectorAll('.tkx-stop').length,
      legend: [...box.querySelectorAll('.tkx-legend > span')].map((s) => s.textContent.trim()),
    };
    const dis = document.querySelector('[data-a="draft-discard"]');
    if (dis) dis.click();
    return out;
  })()`);
  ok(tick && !tick.err, `回复长短控件是横向进度条（${tick?.err || '渲染出来了'}）`);
  if (tick && !tick.err) {
    ok(tick.h >= 20 && tick.w > 200, `进度条是真横条（宽 ${Math.round(tick.w)}px / 高 ${Math.round(tick.h)}px）`);
    ok(tick.radios === 3 && tick.n === 3, `三档与原生 radio 都在（radio=${tick.radios} · data-n=${tick.n}）`);
    ok(tick.stops === 2, `等分刻线是 2 条（实得 ${tick.stops}）`);
    ok(tick.legend.join(',') === '短,中等,长', `图例仍来自后端三档（${tick.legend.join(',')}）`);
    ok(tick.before.checked && tick.after.checked && tick.before.checked !== tick.after.checked,
      `点下一档的轨道中心会换档（${tick.before.checked} → ${tick.after.checked}）`);
    ok(tick.after.label === tick.after.want && tick.after.p !== tick.before.p,
      `液面与档名一起跟到新档（${tick.before.p} → ${tick.after.p} · ${tick.before.label} → ${tick.after.label}）`);
  }

  /* ── 大脑页的两块新东西（2026-10-17 · 维护者点名重做）──
     ⚠️ 它们**不是**业务逻辑，但正是那种"少一块也不报错"的形态：
        标签行没了 → 用户以为只能改配置改模型；免费额度没了 → 再没人发现它在哪。
        ⚠️ 标签数量 ≥5：本机（Mac）+ DeepSeek + 智谱 + 千问 + 添加 + 自定义若干。
        Windows 上本机不显示，所以下限取 5 已经留了余量。 */
  const brainPage = r.find((x) => /模型与线路/.test(x.label));
  ok(!!brainPage, '遍历里找到了「模型与线路」页');
  if (brainPage) {
    /* 2026-10-17 第二轮：标签行**只放用户自己建的模型**（本机 / DeepSeek / 智谱 / 千问
       这些预设标签已按维护者要求撤掉），所以下限是「至少一颗模型 + 一颗添加」。
       钉下限而不是钉具体数字：模型数量本来就随用户配置变。 */
    ok(brainPage.brainTags >= 2, `大脑标签行渲染出来了（实得 ${brainPage.brainTags} 颗：自定义模型 + 「＋ 自定义模型」，下限 2）`);
    /* 免费额度 2026-10-17 第二次点名：**不再单独占一块**，收成「一键切换」卡右下角的
       一颗按钮。所以这里两头都钉：卡没了、按钮在（少一个都不报错，只是"少了一块"）。 */
    ok(brainPage.quotaCard === 0, `「免费额度」不再单独成卡（实得 ${brainPage.quotaCard} 张）`);
    ok(brainPage.quotaBtn === 1, `免费额度收成**一颗按钮**（实得 ${brainPage.quotaBtn} 颗）`);
  }

  /* ── 添加模型的「云端 ⇄ 本地」切换 + 标签右键菜单（2026-10-17 第二轮）──
     这两件事都只有**点下去**才知道对不对：静态扫描只能看到按钮存在。
     ⚠️ 必须回到模型页再点 —— 上面的遍历停在最后一页（维护 / 插件）。 */
  const brainUi = await evalJs(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const groups = [...document.querySelectorAll('#nav1 .grp')];
    const g = groups.find((x) => /模型/.test(x.title || ''));
    if (!g) return { error: '没找到「模型」分组' };
    g.click(); await sleep(150);
    const subs = [...document.querySelectorAll('#nav2 .sub')];
    const sub = subs.find((x) => /模型与线路/.test(x.title || ''));
    if (!sub) return { error: '没找到「模型与线路」子页' };
    sub.click(); await sleep(220);
    const box = document.getElementById('modalBox');
    const modalEl = document.getElementById('modal');
    const add = document.querySelector('.brain-tag.add');
    if (!add) return { error: '没找到「＋ 自定义模型」标签' };
    add.click(); await sleep(120);
    const first = {
      open: modalEl.hidden === false,
      title: (box.querySelector('h3') || {}).textContent || '',
      head: (box.querySelector('[data-a="brain.mode"]') || {}).textContent || '',
      hasKey: !!box.querySelector('[data-bf="apiKey"]'),
      base: (box.querySelector('[data-bf="baseUrl"]') || {}).value || '',
      scrimVisible: !!document.getElementById('glassScrim') && !document.getElementById('glassScrim').hidden,
      scrimLayers: document.querySelectorAll('#glassScrim .gsc-blur').length,
      scrimBd: (() => {
        const b = document.querySelector('#glassScrim .gsc-blur-3');
        return b ? getComputedStyle(b).backdropFilter : '';
      })(),
      modalBg: getComputedStyle(modalEl).backgroundColor,
    };
    (box.querySelector('[data-a="brain.mode"]') || {}).click && box.querySelector('[data-a="brain.mode"]').click();
    await sleep(120);
    const second = {
      head: (box.querySelector('[data-a="brain.mode"]') || {}).textContent || '',
      hasKey: !!box.querySelector('[data-bf="apiKey"]'),
      base: (box.querySelector('[data-bf="baseUrl"]') || {}).value || '',
      hasWebSearch: !!box.querySelector('[data-bf="webSearch"]'),
    };
    const close = box.querySelector('[data-a="__modal-close"]');
    if (close) close.click();
    await sleep(80);
    const afterClose = {
      scrimHidden: document.getElementById('glassScrim').hidden,
      modalHidden: modalEl.hidden,
    };
    // 右键标签 → 与列表行同一份菜单（改名 / 改设置 / 删除）
    const tag = document.querySelector('.brain-tag[data-brain]');
    let menu = null;
    if (tag) {
      tag.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      await sleep(120);
      /* 2026-10-20：右键的呈现层从居中 modal 换成了锚点浮层（.ctxmenu），
         行为与三项动作不变。判据两者都接受 —— 它盯的是「右键能弹出带改名/删除的菜单」，
         不是「必须是哪种容器」（容器换了不该让这条变成假红）。
         ⚠️ 浮层挂在 document.body 上（不在 #page 里），且合成事件没有 clientX/Y（默认 0,0），
            夹紧逻辑会把它放进视口左上角 —— 不影响判据。
         ⚠️ 注释里**不许出现反引号**：这一段整体是一个 template literal，反引号会把字符串截断
            （本轮实测：node --check 直接报 missing ) after argument list）。 */
      const ctx = document.querySelector('.ctxmenu');
      const btns = ctx
        ? [...ctx.querySelectorAll('[data-ci]')].map((b) => b.textContent || '')
        : [...box.querySelectorAll('button')].map((b) => b.textContent || '');
      menu = {
        open: !!ctx || modalEl.hidden === false,
        floating: !!ctx,
        title: ctx ? (ctx.querySelector('.ctx-h') || {}).textContent || '' : (box.querySelector('h3') || {}).textContent || '',
        items: btns.join('|'),
      };
      if (ctx) ctx.remove();                      /* 别把浮层留给后面的断言 */
      const c2 = box.querySelector('[data-a="__modal-close"]');
      if (c2) c2.click();
    }
    return { first, second, menu, afterClose };
  })()`);
  console.log('\n── 添加模型：云端 ⇄ 本地 ──');
  ok(!brainUi.error, `打开「＋ 自定义模型」并读到表单（${brainUi.error || 'ok'}）`);
  if (!brainUi.error) {
    ok(brainUi.first.open && /添加自定义模型/.test(brainUi.first.title), `弹窗打开了（${brainUi.first.title}）`);
    ok(brainUi.first.head === '切换到本地模型', `云端模式下标题右侧写「切换到本地模型」（实得「${brainUi.first.head}」）`);
    ok(brainUi.first.hasKey, '云端模式有 API Key 输入框');
    ok(brainUi.first.scrimVisible && brainUi.first.scrimLayers === 3,
      `弹窗打开时三层渐进模糊遮罩出现（${brainUi.first.scrimLayers} 层）`);
    ok(/blur\(/.test(brainUi.first.scrimBd || ''),
      `遮罩层真的带 backdrop-filter（${brainUi.first.scrimBd || '空'}）`);
    ok(brainUi.first.modalBg === 'rgba(0, 0, 0, 0)',
      `.modal 在遮罩打开时交出 scrim（实得 ${brainUi.first.modalBg}）`);
    ok(brainUi.afterClose && brainUi.afterClose.scrimHidden && brainUi.afterClose.modalHidden,
      '关闭弹窗后遮罩与弹窗立即 hidden');
    brainUi.second && ok(brainUi.second.head === '切换到云端', `切到本地后按钮变成「切换到云端」（实得「${brainUi.second.head}」）`);
    ok(brainUi.second && brainUi.second.hasKey === false, '本地模式**没有** API Key 输入框（本地不需要 Key）');
    ok(brainUi.second && /127\.0\.0\.1:8080/.test(brainUi.second.base), `本地模式地址默认填本机（实得「${brainUi.second && brainUi.second.base}」）`);
    ok(brainUi.second && brainUi.second.hasWebSearch === false, '本地模式不摆「能联网」（web_search 是智谱形状，本地必然 400）');
  }
  if (brainUi.menu) {
    ok(brainUi.menu.open && /删除/.test(brainUi.menu.items) && /改名字/.test(brainUi.menu.items),
      `标签右键弹出改名 / 删除菜单（标题「${brainUi.menu.title}」· 按钮 ${brainUi.menu.items} · ${brainUi.menu.floating ? '锚点浮层' : '居中弹窗'}）`);
  }

  /* ── 切换的反馈：横幅 + 选中态 + 四行 kv 必须同时跟着换（2026-10-17 · 维护者点名）──
     ⚠️ **不改磁盘**：直接改页面里那份 `S.state`（`window.__next`）再让它重画。
        真去点标签会走 `/api/switch` —— 沙箱只挡机器人进程、**不挡 config.json**，
        那样这个守卫会改写本机真实配置。
     ⚠️ 造的状态里 `config` 与 `effective` **故意不一致**（正是用户截图那一刻：
        已经选了千问、机器人还停在 DeepSeek）。两者一致时"取对了源"与"取错了源"
        在页面上长得一模一样，只有不一致才分得出来。 */
  console.log('\n── 切换反馈：横幅 / 选中态同步 ──');
  const pickUi = await evalJs(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const g = [...document.querySelectorAll('#nav1 .grp')].find((x) => /模型/.test(x.title || ''));
    if (!g) return { error: '没找到「模型」分组' };
    g.click(); await sleep(120);
    const sub = [...document.querySelectorAll('#nav2 .sub')].find((x) => /模型与线路/.test(x.title || ''));
    if (!sub) return { error: '没找到「模型与线路」子页' };
    sub.click(); await sleep(220);
    const S = window.__next;
    if (!S || !S.state || !S.state.config) return { error: '页面没有 window.__next.state.config' };
    const cfg = S.state.config;
    const A = { id: 't-a', name: '测试甲', model: 'test-model-a',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', provider: 'qwen', fallbackModels: [] };
    const B = { id: 't-b', name: '测试乙', model: 'test-model-b',
      baseUrl: 'https://api.deepseek.com/v1', provider: 'deepseek', fallbackModels: [] };
    cfg.customBrains = [A, B];
    const keep = { activeCustomId: cfg.activeCustomId, model: cfg.model, baseUrl: cfg.baseUrl, provider: cfg.provider };
    // 机器人还停在上一套（用户截图那一刻的形状）
    S.state.effective = { alive: true, since: Date.now(), provider: 'deepseek', model: 'deepseek-flash',
      baseUrl: 'https://api.deepseek.com/v1', isLocal: false };
    const paint = (b) => {
      cfg.activeCustomId = b.id; cfg.model = b.model; cfg.baseUrl = b.baseUrl; cfg.provider = b.provider;
      window.__nextRepaint();
      return {
        bar: (document.querySelector('[data-mb="brain.now"] b') || {}).textContent || '',
        on: [...document.querySelectorAll('.brain-tag.on')].map((x) => x.getAttribute('data-brain')),
        useTag: document.querySelectorAll('.brain-tag.on .use-tag').length,
        pressed: [...document.querySelectorAll('.brain-tag[data-brain]')]
          .map((x) => x.getAttribute('aria-pressed')).join(','),
        pend: document.querySelectorAll('.brain-tag.pend, .pend-tag').length,
        page: (document.getElementById('page') || {}).textContent || '',
      };
    };
    const a = paint(A);
    const b = paint(B);
    Object.assign(cfg, keep);
    return { a, b };
  })()`);
  ok(!pickUi.error, `读到页面状态并重画（${pickUi.error || 'ok'}）`);
  if (!pickUi.error) {
    const a = pickUi.a, b = pickUi.b;
    ok(/千问云端/.test(a.bar) && /test-model-a/.test(a.bar) && !/deepseek/i.test(a.bar),
      `横幅跟着**已选定**那套走，没有留在机器人上次读到的旧模型上（实得「${a.bar}」）`);
    ok(a.on.length === 1 && a.on[0] === 't-a', `选中态只亮一颗，且是刚选的那颗（实得 ${JSON.stringify(a.on)}）`);
    ok(a.useTag === 1, `选中那颗带「在用」标记（实得 ${a.useTag} 个）`);
    ok(a.pend === 0, `没有「待生效」那种中间态（实得 ${a.pend} 个 pend 元素）`);
    ok(/当前厂商\s*千问云端/.test(a.page) && /正在使用\s*test-model-a/.test(a.page),
      '下面四行 kv 与横幅同源（同一页里不会出现两个人话说同一件事）');
    ok(b.on.length === 1 && b.on[0] === 't-b' && /test-model-b/.test(b.bar) && !/test-model-a/.test(b.bar),
      `再切一套：横幅与选中态一起换（实得 ${JSON.stringify(b.on)} ·「${b.bar}」）`);
    ok(/^false,true$|^true,false$/.test(b.pressed), `标签带 aria-pressed（实得 ${b.pressed}）`);
  }
  /* ── 优先级线路：主模型单独一行 + 别家的模型要标出来（2026-10-17 · 维护者截图）──
     截图里同一屏写着「正在使用 qwen3.8-max」和「主模型 GLM-4.5-Air」—— 因为列表存的
     其实是**备用链**（主模型由 `config.model` 承担），第 1 行却被标成了「主模型」。
     顺带把"这家的清单里没有的条目"标出来并给一键清掉（GLM 混进千问就是这么来的）。
     ⚠️ 同样只在内存里改 state 再重画，不写盘。 */
  console.log('\n── 优先级线路：主模型 / 别家模型 ──');
  const boardUi = await evalJs(`(() => {
    const S = window.__next;
    if (!S || !S.state || !S.state.config) return { error: '页面没有 window.__next.state.config' };
    const cfg = S.state.config;
    const keep = { model: cfg.model, provider: cfg.provider, chain: (cfg.fallbackModels || []).slice() };
    cfg.provider = 'qwen';
    cfg.model = 'qwen3.8-max';
    cfg.fallbackModels = ['glm-4.5-air', 'qwen3.7-flash'];
    window.__nextRepaint();
    const page = document.getElementById('page') || {};
    const rows = [...document.querySelectorAll('.srt-item')].map((r) => ({
      tag: (r.querySelector('.tag') || {}).textContent || '',
      txt: (r.textContent || '').replace(/\\s+/g, ' ').trim(),
    }));
    const out = {
      rows,
      clean: !!(page.querySelector && page.querySelector('[data-a="route.clean"]')),
      pageText: (page.textContent || ''),
    };
    cfg.model = keep.model; cfg.provider = keep.provider; cfg.fallbackModels = keep.chain;
    window.__nextRepaint();
    return out;
  })()`);
  ok(!boardUi.error, `读到线路板（${boardUi.error || 'ok'}）`);
  if (!boardUi.error) {
    ok(/主模型/.test(boardUi.pageText) && /qwen3\.8-max/.test(boardUi.pageText),
      '主模型单独一行、写的是真正在用的那个模型（不再把备用链第 1 条标成主模型）');
    ok(boardUi.rows.length === 2 && boardUi.rows[0].tag === '这家没有',
      `别家的模型被标成「这家没有」（实得 ${JSON.stringify(boardUi.rows.map((r) => r.tag))}）`);
    ok(boardUi.rows[1] && boardUi.rows[1].tag === '第 2 备用',
      `本家的条目按"第 N 备用"排（实得 ${boardUi.rows[1] && boardUi.rows[1].tag}）`);
    ok(boardUi.clean, '给了「清掉不属于这家的」入口（点了立即存）');
  }

  /* ── 插话冷却：进度条真的会动（2026-10-17 · 维护者点名）──────────────────
     为什么必须是真浏览器：静态扫描只能证明 `t:'range'` 写了、RENDER 里有实现，
     证明不了"液面跟着走、右上读数字跟着变" —— 而那两件才是用户点得到的东西。

     ⚠️ 只派发 `input`、**不派发 `change`**：`change` 会 `setValue()` 写进草稿，
        而草稿一旦非空，`softPaint()` 就不再重画 ⇒ 后面的断言会在冻结的旧 DOM 上跑。
     ⚠️ 也不点「保存」：沙箱只挡机器人进程、不挡 config.json。 */
  console.log('\n── 插话冷却：进度条 ──');
  const coolUi = await evalJs(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const g = [...document.querySelectorAll('#nav1 .grp')].find((x) => /发言/.test(x.title || ''));
    if (!g) return { error: '没找到「发言」分组' };
    g.click(); await sleep(150);
    const sub = [...document.querySelectorAll('#nav2 .sub')].find((x) => /触发方式/.test(x.title || ''));
    if (!sub) return { error: '没找到「触发方式」子页' };
    sub.click(); await sleep(250);
    const card = document.getElementById('card-cool');
    const el = document.querySelector('.rng-track input');
    if (!card || !el) return { error: '页面上没有插话冷却的进度条' };
    const read = () => ({
      val: (card.querySelector('.rng-val') || {}).textContent || '',
      p: getComputedStyle(card.querySelector('.rng')).getPropertyValue('--p').trim(),
    });
    const before = read();
    el.value = '600';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(80);
    return { before, after: read(), aria: el.getAttribute('aria-valuetext') || '' };
  })()`);
  ok(!coolUi.error, `「触发方式」页读得到插话冷却（${coolUi.error || 'ok'}）`);
  if (!coolUi.error) {
    /* ⚠️ 这里**不能写死**"默认 5 分钟"：读数跟着真机 config.json 走，
       维护者随时可能自己调过。把配置值写死进断言 = 断言会替用户撒谎。 */
    ok(/分钟|小时/.test(coolUi.before.val), `读数带单位、不是毫秒原值（实得「${coolUi.before.val}」）`);
    ok(coolUi.after.val !== coolUi.before.val, `拖动后读数跟着变（${coolUi.before.val} → ${coolUi.after.val}）`);
    ok(parseFloat(coolUi.after.p) > parseFloat(coolUi.before.p),
      `液面跟着变长（--p ${coolUi.before.p} → ${coolUi.after.p}）`);
    ok(coolUi.aria && coolUi.aria === coolUi.after.val, `读屏文案与读数同源（aria-valuetext「${coolUi.aria}」）`);
  }

  /* ── 左下角设置层：结构 / 启停控件 / 关于 / 数据 ───────────────────── */
  console.log('\n── 设置层：结构、启停控件与只读信息 ──');
  const shellUi = await evalJs(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const gear = document.getElementById('setGear');
    const layer = document.getElementById('settingsLayer');
    const panel = document.getElementById('settingsPanel');
    if (!gear || !layer || !panel) return { error: '找不到设置层入口' };
    if (layer.dataset.open !== 'true') gear.click();
    await sleep(420);
    const q = (sel) => !!document.querySelector(sel);
    const out = {
      open: layer.dataset.open,
      expanded: gear.getAttribute('aria-expanded'),
      sections: [...document.querySelectorAll('#settingsPanel .set-section')].map((x) => x.id),
      rail: document.querySelectorAll('#settingsPanel .set-rail-item').length,
      cards: document.querySelectorAll('#settingsPanel .set-card').length,
      theme: q('#setThemeSeg [data-theme-opt="light"]') && q('#setThemeSeg [data-theme-opt="dark"]'),
      accents: document.querySelectorAll('#accentGrid [data-accent-opt]').length,
      fonts: document.querySelectorAll('#fontGrid [data-font-opt]').length,
      bgSwatches: document.querySelectorAll('#bgPickList [role="radio"]').length,
      bgChecked: document.querySelectorAll('#bgPickList [aria-checked="true"]').length,
      speeds: document.querySelectorAll('#bgSpeed [data-speed]').length,
      mode: q('[data-mode-opt="browser"]') && q('[data-mode-opt="window"]'),
      closeBoth: q('[data-close-opt="tray"]') && q('[data-close-opt="quit"]'),
      autoStart: q('[data-set="autoStart"]'),
      autoProtocol: q('[data-set="autoProtocol"]'),
      openOnStart: q('[data-set="openOnStart"]'),
      updateBtn: q('[data-a="update.check"]'),
      exportAll: q('[data-a="export.all"]'),
      exportDiag: q('[data-a="export.diag"]'),
      repo: (document.getElementById('repoOpen') || {}).href || '',
      runtime: (document.getElementById('aboutRuntime') || {}).textContent || '',
      topbarInert: document.querySelector('.topbar').hasAttribute('inert'),
      railNav: [],
    };
    for (const id of ['sec-startup', 'sec-about', 'sec-data', 'sec-appearance']) {
      const b = document.querySelector('[data-target="' + id + '"]');
      if (!b) { out.railNav.push({ id, active: '', ok: false }); continue; }
      b.click();
      await sleep(650);
      const active = (document.querySelector('.set-rail-item.is-active') || {}).dataset?.target || '';
      out.railNav.push({ id, active, ok: active === id });
    }
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await sleep(380);
    out.closed = layer.dataset.open;
    out.expandedAfter = gear.getAttribute('aria-expanded');
    out.inertAfter = document.querySelector('.topbar').hasAttribute('inert');
    return out;
  })()`);
  ok(shellUi && !shellUi.error, `设置层能打开（${shellUi?.error || 'ok'}）`);
  if (shellUi && !shellUi.error) {
    ok(shellUi.open === 'true' && shellUi.expanded === 'true' && shellUi.topbarInert === true,
      `打开态正确（open=${shellUi.open} · aria-expanded=${shellUi.expanded} · 背景 inert=${shellUi.topbarInert}）`);
    ok(shellUi.sections.join(',') === 'sec-appearance,sec-startup,sec-about,sec-data' && shellUi.rail === 4,
      `四个分区与侧栏齐全（${shellUi.sections.join(' / ')} · rail=${shellUi.rail}）`);
    ok(shellUi.cards >= 8 && shellUi.theme && shellUi.accents === 7 && shellUi.fonts === 2,
      `外观控件齐全（card=${shellUi.cards} · accent=${shellUi.accents} · font=${shellUi.fonts}）`);
    ok(shellUi.bgSwatches === 8 && shellUi.bgChecked === 1 && shellUi.speeds === 4,
      `背景 8 套、恰有一个选中、速度 4 档（swatches=${shellUi.bgSwatches} · checked=${shellUi.bgChecked} · speed=${shellUi.speeds}）`);
    ok(shellUi.mode && shellUi.closeBoth && shellUi.autoStart && shellUi.autoProtocol && shellUi.openOnStart,
      '启动/关闭控件齐全（打开方式、关闭两态、自启、协议端、自动打开）');
    ok(shellUi.exportAll && shellUi.exportDiag && shellUi.updateBtn,
      '关于/数据入口齐全（检查更新、导出全部、诊断包）');
    ok(/^https:\/\/github\.com\//.test(shellUi.repo) && !!shellUi.runtime && shellUi.runtime !== '—',
      `关于卡有真实来源（repo=${shellUi.repo} · runtime=${shellUi.runtime}）`);
    ok(shellUi.railNav.every((x) => x.ok),
      `侧栏四分区都能跳到对应 section（${shellUi.railNav.map((x) => `${x.id.replace('sec-', '')}=${x.active || '?'}`).join(' / ')}）`);
    ok(shellUi.closed === 'false' && shellUi.expandedAfter === 'false' && shellUi.inertAfter === false,
      `Esc 能关闭并解除背景 inert（open=${shellUi.closed} · expanded=${shellUi.expandedAfter}）`);
  }

  /* ── 数据：按范围导出（大小来自服务端 dry）─────────────────────────── */
  console.log('\n── 设置层：按范围导出 ──');
  const exportUi = await evalJs(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const gear = document.getElementById('setGear');
    const layer = document.getElementById('settingsLayer');
    if (!gear || !layer) return { error: '找不到设置层入口' };
    if (layer.dataset.open !== 'true') gear.click();
    await sleep(900);
    const rows = [...document.querySelectorAll('#exportScopes .set-scope')];
    const out = {
      scopes: rows.length,
      ids: rows.map((r) => r.querySelector('input')?.dataset.scope).filter(Boolean),
      total: (document.getElementById('exportTotal') || {}).textContent || '',
      button: !!(document.getElementById('exportSelected') || {}).disabled === false,
    };
    gear.click();
    await sleep(260);
    return out;
  })()`);
  ok(exportUi && !exportUi.error && exportUi.scopes >= 6 && exportUi.ids.includes('config')
    && exportUi.ids.includes('log') && /合计/.test(exportUi.total) && exportUi.button,
    `按范围导出的范围和实际大小已渲染（scopes=${exportUi?.scopes} · ${exportUi?.ids?.join(',')} · ${exportUi?.total}）`);

  /* ── 外观：四件套真的生效 + 刷新后仍记得 ───────────────────────────── */
  console.log('\n── 设置层：外观持久化（主题/主题色/字体/背景）──');
  const appearance = await evalJs(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const gear = document.getElementById('setGear');
    const layer = document.getElementById('settingsLayer');
    if (!gear || !layer) return { error: '找不到设置层入口' };
    if (layer.dataset.open !== 'true') gear.click();
    await sleep(420);
    const root = document.documentElement;
    const stored = (k) => { try { return localStorage.getItem(k) || ''; } catch { return ''; } };
    const click = (sel) => { const b = document.querySelector(sel); if (b) b.click(); return !!b; };
    // 先归零，避免上一次运行留下的偏好让断言变成"碰巧"。
    click('[data-font-opt="sans"]');
    click('[data-accent-opt="ocean"]');
    click('[data-theme-opt="light"]');
    await sleep(700);
    const before = {
      font: root.dataset.fontStyle || '',
      accent: root.dataset.accent || '',
      theme: root.dataset.theme || '',
      bg: window.ShaderBG ? window.ShaderBG.current : '',
    };
    click('[data-font-opt="serif"]');
    await sleep(80);
    const serif = {
      style: root.dataset.fontStyle || '',
      font: getComputedStyle(root).getPropertyValue('--font'),
      stored: stored('next-font-style'),
      pressed: document.querySelector('[data-font-opt="serif"]').getAttribute('aria-pressed'),
    };
    click('[data-theme-opt="dark"]');
    for (let i = 0; i < 40 && root.dataset.theme !== 'dark'; i++) await sleep(50);
    for (let i = 0; i < 40 && root.dataset.vt; i++) await sleep(50);
    const dark = { theme: root.dataset.theme || '', stored: stored('next-theme'), vtCleared: !root.dataset.vt };
    click('[data-accent-opt="lagoon"]');
    await sleep(80);
    const lagoon = {
      accent: root.dataset.accent || '',
      stored: stored('next-accent'),
      css: getComputedStyle(root).getPropertyValue('--c-accent').trim(),
      pressed: document.querySelector('[data-accent-opt="lagoon"]').getAttribute('aria-pressed'),
    };
    const btns = [...document.querySelectorAll('#bgPickList [role="radio"]')];
    const target = btns[btns.length - 1];
    const wantBg = target && target.dataset.id;
    if (target) target.click();
    await sleep(120);
    const bg = {
      want: wantBg,
      current: window.ShaderBG ? window.ShaderBG.current : '',
      stored: stored('qqbot-bgfx'),
      checked: document.querySelectorAll('#bgPickList [aria-checked="true"]').length,
    };
    gear.click();
    await sleep(220);
    return { before, serif, dark, lagoon, bg };
  })()`);
  ok(appearance && !appearance.error, `外观控件可操作（${appearance?.error || 'ok'}）`);
  if (appearance && !appearance.error) {
    ok(appearance.serif.style === 'serif' && appearance.serif.pressed === 'true',
      `字体切到衬线（style=${appearance.serif.style} · aria-pressed=${appearance.serif.pressed}）`);
    ok(/Songti SC/.test(appearance.serif.font) && /SimSun/.test(appearance.serif.font),
      `衬线栈同时覆盖 macOS 宋体-简与 Windows 宋体（--font=${String(appearance.serif.font).slice(0, 120)}…）`);
    ok(appearance.serif.stored === 'serif', `字体偏好写进 localStorage（${appearance.serif.stored}）`);
    ok(appearance.dark.theme === 'dark' && appearance.dark.stored === 'dark' && appearance.dark.vtCleared,
      `夜间模式生效并持久化（theme=${appearance.dark.theme} · stored=${appearance.dark.stored}）`);
    ok(appearance.lagoon.accent === 'lagoon' && appearance.lagoon.stored === 'lagoon'
      && appearance.lagoon.pressed === 'true' && /rgb|#/.test(appearance.lagoon.css),
      `主题色切到青碧（accent=${appearance.lagoon.accent} · stored=${appearance.lagoon.stored} · --c-accent=${appearance.lagoon.css}）`);
    ok(appearance.bg.current === appearance.bg.want && appearance.bg.stored === appearance.bg.want && appearance.bg.checked === 1,
      `背景切到最后一套并持久化（${appearance.bg.current} · checked=${appearance.bg.checked}）`);
  }

  await send('Page.reload');
  await sleep(400);
  let appearanceBack = false;
  for (let i = 0; i < 60 && !appearanceBack; i++) {
    try {
      appearanceBack = await evalJs(`document.readyState === 'complete'
        && !!document.getElementById('setGear')
        && document.querySelectorAll('#page *').length > 5`);
    } catch { appearanceBack = false; }
    if (!appearanceBack) await sleep(200);
  }
  const persisted = await evalJs(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const gear = document.getElementById('setGear');
    const layer = document.getElementById('settingsLayer');
    if (gear && layer && layer.dataset.open !== 'true') gear.click();
    await sleep(420);
    const root = document.documentElement;
    const serifBtn = document.querySelector('[data-font-opt="serif"]');
    const lagoonBtn = document.querySelector('[data-accent-opt="lagoon"]');
    const out = {
      ok: !!gear && !!layer,
      font: root.dataset.fontStyle || '',
      theme: root.dataset.theme || '',
      accent: root.dataset.accent || '',
      bg: window.ShaderBG ? window.ShaderBG.current : '',
      fontPressed: serifBtn ? serifBtn.getAttribute('aria-pressed') : '',
      accentPressed: lagoonBtn ? lagoonBtn.getAttribute('aria-pressed') : '',
      errs: (window.__errs || []).slice(0, 3),
    };
    // 还原默认外观与 localStorage（测试副作用不许过夜）
    if (document.querySelector('[data-font-opt="sans"]')) document.querySelector('[data-font-opt="sans"]').click();
    if (document.querySelector('[data-accent-opt="ocean"]')) document.querySelector('[data-accent-opt="ocean"]').click();
    if (document.querySelector('[data-theme-opt="light"]')) document.querySelector('[data-theme-opt="light"]').click();
    if (window.ShaderBG) window.ShaderBG.set(window.ShaderBG.DEFAULT || window.ShaderBG.VARIANTS[0].id);
    await sleep(700);
    try {
      localStorage.removeItem('next-font-style');
      localStorage.removeItem('next-accent');
      localStorage.removeItem('next-theme');
      localStorage.removeItem('qqbot-bgfx');
    } catch (e) { /* 隐私模式 */ }
    if (gear && layer && layer.dataset.open === 'true') gear.click();
    out.restored = {
      font: root.dataset.fontStyle || '',
      theme: root.dataset.theme || '',
      accent: root.dataset.accent || '',
      bg: window.ShaderBG ? window.ShaderBG.current : '',
    };
    return out;
  })()`);
  ok(appearanceBack && persisted.ok && persisted.font === 'serif' && persisted.theme === 'dark'
    && persisted.accent === 'lagoon' && persisted.bg === appearance.bg.want
    && persisted.fontPressed === 'true' && persisted.accentPressed === 'true',
    `刷新后四件套都记得（font=${persisted.font} · theme=${persisted.theme} · accent=${persisted.accent} · bg=${persisted.bg}）`);
  ok((persisted.errs || []).length === 0,
    `刷新后的启动脚本零运行时错误${(persisted.errs || []).length ? '：' + persisted.errs.join(' | ') : ''}`);
  ok(persisted.restored && persisted.restored.font === 'sans' && persisted.restored.theme === 'light'
    && persisted.restored.accent === 'ocean',
    `测试结束后已还原默认外观（font=${persisted.restored?.font} · theme=${persisted.restored?.theme} · accent=${persisted.restored?.accent}）`);

  /* ── 设置层：窄屏入口 ────────────────────────────────────────────────
     旧断言盯的是顶栏「文」按钮在 ≤770px 收起；现在字体/主题/背景全部进了
     左下角设置，顶栏只剩启停。判据改为：四档下齿轮始终可见、顶栏不溢出、
     设置面板完整落在视口内且关闭按钮可达。 */
  console.log('\n── 设置层：窄屏入口 ──');
  for (const w of [800, 770, 760, 720]) {
    await send('Emulation.setDeviceMetricsOverride', { width: w, height: 1000, deviceScaleFactor: 1, mobile: false });
    await sleep(320);
    const m = await evalJs(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const gear = document.getElementById('setGear');
      const layer = document.getElementById('settingsLayer');
      const panel = document.getElementById('settingsPanel');
      const close = document.getElementById('settingsClose');
      const tb = document.querySelector('.topbar');
      if (!gear || !layer || !panel || !close || !tb) return { error: '缺少设置层/顶栏' };
      const gr = gear.getBoundingClientRect();
      const out = {
        gearVisible: getComputedStyle(gear).display !== 'none' && gr.width > 0 && gr.left >= 0 && gr.right <= innerWidth,
        overflow: tb.scrollWidth - tb.clientWidth,
      };
      if (layer.dataset.open !== 'true') gear.click();
      await sleep(420);
      const pr = panel.getBoundingClientRect();
      const cr = close.getBoundingClientRect();
      out.panelIn = pr.left >= -1 && pr.right <= innerWidth + 1 && pr.top >= -1 && pr.bottom <= innerHeight + 1;
      out.closeIn = cr.width > 0 && cr.left >= 0 && cr.right <= innerWidth && cr.top >= 0 && cr.bottom <= innerHeight;
      out.scrollH = document.getElementById('settingsScroll').clientHeight;
      gear.click();
      await sleep(200);
      return out;
    })()`);
    ok(m && !m.error && m.gearVisible && m.overflow <= 0 && m.panelIn && m.closeIn && m.scrollH > 60,
      `${w}px：齿轮可见、顶栏不溢出、设置面板完整、关闭按钮可达（overflow=${m?.overflow} · panel=${m?.panelIn} · close=${m?.closeIn} · scroll=${m?.scrollH}）`);
  }
  await send('Emulation.clearDeviceMetricsOverride');
  await sleep(200);

  /* ── P2-4 四档内容区：导航 / 顶栏 / 设置层一个都不许静默消失 ─────────
     外窗减 40 DIP 标题栏 = 内容区；这里直接按内容区尺寸量（Electron 的
     BrowserWindow 也按 DIP 给 workArea/ bounds，不再做 ×1.25 换算）。 */
  console.log('\n── P2-4 四档内容区：导航/顶栏/设置层 ──');
  const p24 = [
    { w: 1280, h: 680 },
    { w: 1024, h: 728 },
    { w: 800, h: 560 },
    { w: 600, h: 440 },
  ];
  for (const c of p24) {
    await send('Emulation.setDeviceMetricsOverride', {
      width: c.w, height: c.h, deviceScaleFactor: 1, mobile: false,
    });
    await sleep(520);
    const m = await evalJs(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const groups = [...document.querySelectorAll('#nav1 .grp')];
      const visible = groups.filter((x) => getComputedStyle(x).display !== 'none' && x.getBoundingClientRect().width > 0);
      const top = ['onekey-start', 'onekey-stop'].map((a) => {
        const el = document.querySelector('[data-a="' + a + '"]');
        if (!el) return { a, ok: false, why: 'missing' };
        const r = el.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return {
          a,
          ok: r.width > 0 && r.left >= -1 && r.right <= innerWidth + 1 && !!hit && (hit === el || el.contains(hit)),
          why: hit ? (hit.tagName + '.' + (hit.className || '')) : 'no-hit',
        };
      });
      const gear = document.getElementById('setGear');
      const gr = gear && gear.getBoundingClientRect();
      const gHit = gr ? document.elementFromPoint(gr.left + gr.width / 2, gr.top + gr.height / 2) : null;
      const out = {
        groups: groups.length,
        visible: visible.length,
        missing: groups.filter((x) => !visible.includes(x)).map((x) => x.title || x.textContent).slice(0, 3),
        top,
        gear: !!gear && !!gr && gr.width > 0 && gr.left >= -1 && gr.right <= innerWidth + 1
          && !!gHit && (gHit === gear || gear.contains(gHit)),
        gearWhy: gHit ? gHit.tagName : 'no-hit',
        overflowX: document.documentElement.scrollWidth - innerWidth,
      };
      if (gear) gear.click();
      await sleep(420);
      const panel = document.getElementById('settingsPanel');
      const close = document.getElementById('settingsClose');
      const pr = panel ? panel.getBoundingClientRect() : null;
      const cr = close ? close.getBoundingClientRect() : null;
      out.panel = !!pr && pr.left >= -1 && pr.right <= innerWidth + 1 && pr.top >= -1 && pr.bottom <= innerHeight + 1;
      out.close = !!cr && cr.width > 0 && cr.left >= 0 && cr.right <= innerWidth && cr.top >= 0 && cr.bottom <= innerHeight;
      out.scrollH = (document.getElementById('settingsScroll') || {}).clientHeight || 0;
      out.exportBox = !!document.getElementById('exportScopes');
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await sleep(260);
      out.closed = (document.getElementById('settingsLayer') || {}).dataset?.open === 'false';
      return out;
    })()`);
    await shot(`p2-${c.w}x${c.h}.png`);
    ok(m && m.groups >= 6 && m.visible === m.groups && m.top.every((x) => x.ok) && m.gear
      && m.overflowX <= 1 && m.panel && m.close && m.scrollH > 60 && m.exportBox && m.closed,
      `${c.w}×${c.h}：导航 ${m?.visible}/${m?.groups}、顶栏按钮 ${m?.top?.map((x) => `${x.a}=${x.ok}`).join('/')}、齿轮=${m?.gear}`
      + `、横溢 ${m?.overflowX}px、设置面板=${m?.panel}/关闭=${m?.close}/滚动 ${m?.scrollH}`
      + `${m?.missing?.length ? ' · 缺失 ' + m.missing.join(',') : ''}`);
  }
  // 设置层打开态截图（1280 / 600 两档；供人眼核对，不参与断言）
  for (const c of [{ w: 1280, h: 680 }, { w: 600, h: 440 }]) {
    await send('Emulation.setDeviceMetricsOverride', {
      width: c.w, height: c.h, deviceScaleFactor: 1, mobile: false,
    });
    await sleep(420);
    await evalJs(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const g = document.getElementById('setGear');
      const l = document.getElementById('settingsLayer');
      if (g && l && l.dataset.open !== 'true') g.click();
      await sleep(520);
      return true;
    })()`);
    await shot(`p2-${c.w}x${c.h}-settings.png`);
    await evalJs(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const g = document.getElementById('setGear');
      const l = document.getElementById('settingsLayer');
      if (g && l && l.dataset.open === 'true') g.click();
      await sleep(260);
      return true;
    })()`);
  }
  await send('Emulation.clearDeviceMetricsOverride');
  await sleep(200);

  /* ── 吸顶导航：一条 dock，一级在上、二级随内容收缩（2026-10-22 改版）──
     旧版是「二级在左、岛居中」的并排 grid；改版后两级上下叠压，二级宽度按当前域
     的内容收缩/展开。这里真渲染量三件事：
       ① 二级宽度必须**按内容自适应**（模型 3 页签明显窄于运行 4 页签，
          且窄条宽度不能比自身内容多出一大截）；
       ② dock 不越出视口，一级/二级各有横向滚动，选中项始终可见；
       ③ 吸顶行不再有「并排 ⇄ 上下两行」两态（那是旧结构的退路）。 */
  console.log('\n── 吸顶导航：一条 dock / 二级随内容收缩 ──');
  const navWidths = [2000, 1815, 1629, 1300, 900, 700, 520, 390];
  for (const w of navWidths) {
    await send('Emulation.setDeviceMetricsOverride', {
      width: w, height: 1000, deviceScaleFactor: 1, mobile: false,
    });
    await sleep(520);   // resize 防抖 120ms + 二级宽度过渡 380ms
    const m = await evalJs(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const findGroup = (re) => [...document.querySelectorAll('#nav1 .grp')]
        .find((x) => re.test(x.title || x.textContent));
      if (!findGroup(/模型/) || !findGroup(/运行/)) return { error: '没找到「模型 / 运行」分组' };
      const measure = () => {
        const row = document.getElementById('navrow');
        const dock = document.getElementById('navDock');
        const nav = document.getElementById('nav2');
        const wrap = document.getElementById('nav2wrap');
        const nav1 = document.getElementById('nav1');
        const inner = document.getElementById('navInner');
        const sel = nav.querySelector('.sub[aria-selected="true"]');
        const nr = nav.getBoundingClientRect();
        const sr = sel ? sel.getBoundingClientRect() : null;
        return {
          l2W: wrap.getBoundingClientRect().width,
          l2ScrollW: nav.scrollWidth,
          l2ClientW: nav.clientWidth,
          dockW: dock.getBoundingClientRect().width,
          stacked: row.classList.contains('is-stacked'),
          islandCentered: Math.abs((inner.getBoundingClientRect().left - nav1.getBoundingClientRect().left)
            - (nav1.getBoundingClientRect().right - inner.getBoundingClientRect().right)) < 1.5,
          selectedVisible: !!(sr && sr.left >= nr.left - 1 && sr.right <= nr.right + 1),
        };
      };
      findGroup(/模型/).click(); await sleep(520);
      const narrowM = measure();
      findGroup(/运行/).click(); await sleep(520);
      const wideM = measure();
      return {
        narrowW: narrowM.l2W,
        wideW: wideM.l2W,
        narrowScrollW: narrowM.l2ScrollW,
        wideScrollW: wideM.l2ScrollW,
        dockW: wideM.dockW,
        stacked: wideM.stacked,
        islandCentered: wideM.islandCentered,
        narrowSelVisible: narrowM.selectedVisible,
        wideSelVisible: wideM.selectedVisible,
        viewport: innerWidth,
      };
    })()`);
    const pass = !!m && !m.error
      && m.narrowW < m.wideW - 40                 // 3 页签必须明显窄于 4 页签
      && m.narrowW <= m.narrowScrollW + 12        // 窄条不能比自身内容多出一大截
      && m.dockW <= m.viewport + 1
      && m.stacked === false
      && m.islandCentered === true
      && m.narrowSelVisible === true
      && m.wideSelVisible === true;
    ok(pass, `${w}px：二级自适应（模型 ${m && m.narrowW ? m.narrowW.toFixed(1) : '?'} / 运行 ${m && m.wideW ? m.wideW.toFixed(1) : '?'}）`
      + ` · 模型内容 ${m && m.narrowScrollW ? m.narrowScrollW.toFixed(0) : '?'} · dock ${m && m.dockW ? m.dockW.toFixed(0) : '?'}`
      + ` · 两级选中可见 ${m && m.narrowSelVisible}/${m && m.wideSelVisible}`
      + `${m && m.error ? ' · ' + m.error : ''}`);
  }
  /* 维护域已回到岛内：先回到桌面宽度（上一段量到 390） */
  await send('Emulation.clearDeviceMetricsOverride');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await sleep(250);
  /* 维护域：岛内 6 个可见域，顶栏不再有单独入口 */
  console.log('\n── 岛内「维护」域 ──');
  const maint = await evalJs(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const groups = [...document.querySelectorAll('#nav1 .grp')];
    const visible = groups.filter((x) => !x.hidden && getComputedStyle(x).display !== 'none').length;
    const sys = groups.find((x) => (x.getAttribute('aria-label') || '').startsWith('维护'));
    const topbarBtn = !!document.querySelector('[data-a="nav.maint"]');
    if (!sys) return { error: '岛内没有维护域' };
    sys.click(); await sleep(240);
    /* 点击后 paintPage 重建了一级按钮：必须**重新查**，读旧元素的 aria-selected 会拿到 false。 */
    const groupsAfter = [...document.querySelectorAll('#nav1 .grp')];
    const sysAfter = groupsAfter.find((x) => (x.getAttribute('aria-label') || '').startsWith('维护'));
    const subs = [...document.querySelectorAll('#nav2 .sub')];
    const ind = document.getElementById('navInd');
    const out = {
      visible, topbarBtn,
      selected: sysAfter?.getAttribute('aria-selected'), hiddenSys: sysAfter?.hidden,
      nav2: subs.length, first: (subs[0]?.title || ''), last: (subs[subs.length - 1]?.title || ''),
      islandSelected: document.querySelectorAll('#nav1 .grp[aria-selected="true"]:not([hidden])').length,
      indOp: Number(getComputedStyle(ind).opacity),
    };
    groupsAfter[0].click(); await sleep(180);   // 回到运行，别把后续检查留在维护页
    return out;
  })()`);
  ok(maint && !maint.error
    && maint.visible === 6 && maint.topbarBtn === false
    && maint.selected === 'true' && maint.hiddenSys === false
    && maint.nav2 === 5 && /安全红线/.test(maint.first) && /HUD调整/.test(maint.last)
    && maint.islandSelected === 1 && maint.indOp > 0.9,
    maint?.error || `岛内可见 ${maint?.visible} 域 · 顶栏入口 ${maint?.topbarBtn} · `
      + `维护 tab selected=${maint?.selected} / hidden=${maint?.hiddenSys} · 二级 ${maint?.nav2} 页（首项 ${maint?.first} / 末项 ${maint?.last}） · `
      + `岛内可见选中 ${maint?.islandSelected} · 指示器 opacity=${maint?.indOp}`);
  /* ── 顶栏 HUD 信息岛：五颗胶囊已并入岛内，岛可见且顶栏不溢出 ── */
  await sleep(1400);
  const hudIsland = await evalJs(`(() => {
    const isle = document.getElementById('hudIsle');
    const tb = document.querySelector('.topbar');
    const ids = ['pillMode', 'pillBridge', 'pillContainer', 'pillLocal', 'pillMem'];
    return {
      exists: !!isle,
      pills: ids.filter((id) => document.getElementById(id)).length,
      w: isle ? Math.round(isle.getBoundingClientRect().width) : 0,
      overflow: tb.scrollWidth - tb.clientWidth,
      hasGlyph: !!isle && !!isle.querySelector('.plate svg'),
    };
  })()`);
  ok(hudIsland && hudIsland.exists && hudIsland.pills === 0 && hudIsland.w > 100 && hudIsland.overflow <= 0,
    `HUD 岛=${hudIsland?.exists ? '在' : '缺'} · 残留胶囊 ${hudIsland?.pills} · 宽 ${hudIsland?.w}px`
      + ` · 顶栏溢出 ${hudIsland?.overflow}px · 图标=${hudIsland?.hasGlyph ? '有' : '无'}`);
  /* ── 液态玻璃制作站（隐藏实验页）：能启动、模板都渲染、默认无遮罩、无运行时异常 ── */
  try {
    await send('Page.navigate', { url: new URL('/lab-liquid-glass.html', BASE).href });
    await sleep(400);
    const station = await evalJs(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const t0 = Date.now();
      while (Date.now() - t0 < 8000 && !(window.__glassLab && window.__glassLab.probe)) await sleep(120);
      const p = window.__glassLab ? window.__glassLab.probe() : null;
      return {
        p,
        templates: window.__glassLab ? window.__glassLab.templates : 0,
        specs: document.querySelectorAll('.gs-spec').length,
        errs: (window.__errs || []).length,
      };
    })()`);
    ok(!!station.p && station.templates >= 6, `制作站启动（${station.templates} 个模板）`);
    ok(station.specs >= 6, `模板与 A/B 示例都渲染了（${station.specs} 个 .gs-spec）`);
    ok(station.p && station.p.scrimHidden === true, '制作站的设置遮罩默认 hidden');
    ok(station.errs === 0, `制作站无运行时异常（${station.errs}）`);
    /* 2026-10-22 深改版：拖得动、对比是双层、弹层开得开关得上。
       这三条是用户当时点名“拖也拖不动、例子试不了”的反向守卫。 */
    const inter = await evalJs(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const el = document.querySelector('#gsWorldA .gs-spec[data-key="media"]');
      if (!el) return { error: 'no spec' };
      const before = el.getBoundingClientRect();
      const x = before.left + before.width / 2;
      const y = before.top + before.height / 2;
      el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: x, clientY: y, button: 0, pointerId: 91 }));
      document.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: x + 36, clientY: y + 18, pointerId: 91 }));
      document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: x + 36, clientY: y + 18, pointerId: 91 }));
      await sleep(140);
      const after = el.getBoundingClientRect();
      const dx = Math.round(after.left - before.left);
      document.querySelector('[data-view="compare"]').click();
      await sleep(280);
      const specs = document.querySelectorAll('#gsCanvas .gs-spec').length;
      document.querySelector('[data-gs="openModal"]').click();
      await sleep(240);
      const scrim = document.getElementById('gsScrim');
      const shown = !!scrim && !scrim.hidden && scrim.classList.contains('on');
      document.querySelector('#gsModal [data-gs="closeModal"]').click();
      await sleep(140);
      const closed = !!scrim && scrim.hidden;
      return { dx, specs, shown, closed };
    })()`);
    ok(inter && !inter.error && Math.abs(inter.dx) >= 20, `制作站玻璃可拖动（位移 ${inter?.dx}px）`);
    ok(inter && inter.specs >= 8, `对比视图同时渲染两侧（${inter?.specs} 个 .gs-spec）`);
    ok(inter && inter.shown && inter.closed, '制作站设置弹层可开可关');
    /* 2026-10-23 吸收的光影三件套：三条新控件必须真的改到计算样式，不是只改了数据。 */
    const absorb = await evalJs(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const setRange = (k, v) => {
        const el = document.querySelector('[data-param="' + k + '"]');
        if (!el) return false;
        el.value = String(v);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      };
      const setSel = (k, v) => {
        const el = document.querySelector('[data-select-param="' + k + '"]');
        if (!el) return false;
        el.value = v;
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      };
      const read = () => {
        const spec = document.querySelector('#gsWorldA .gs-spec');
        const rim = spec && spec.querySelector('.gs-rim');
        return {
          shadow: rim ? getComputedStyle(rim).boxShadow : '',
          spec: spec ? spec.dataset.spec : '',
        };
      };
      /* 上一条把视图留在 compare（A 侧是 current 变体，rim 走 --c-eg-inset-isle，
         壁/描边本来就不该影响它）—— 先切回场景，读精修侧。 */
      document.querySelector('[data-view="scene"]').click();
      await sleep(260);
      if (!setRange('wall', 0) || !setSel('bevel', 'off') || !setSel('spec', 'sweep')) return { err: 'controls-missing' };
      await sleep(220);
      const a = read();
      if (!setRange('wall', 0.5) || !setSel('bevel', 'raised') || !setSel('spec', 'corners')) return { err: 'controls-missing' };
      await sleep(220);
      const b = read();
      return { a, b, changedShadow: a.shadow !== b.shadow, changedSpec: a.spec !== b.spec };
    })()`);
    ok(absorb && !absorb.err && absorb.changedShadow && absorb.changedSpec,
      absorb?.err ? `光影三件套控件缺失（${absorb.err}）`
        : `光影三件套接到计算样式（shadow ${absorb?.changedShadow} / spec ${absorb?.changedSpec}）`);
  } catch (e) {
    ok(false, `制作站冒烟失败：${e && e.message ? e.message : e}`);
  }

  /* ── 插件页：上限 / 运行期可观测 / 设置保存与回填（2026-10-23）──────────
     上面的制作站已经跳到了 `lab-liquid-glass.html`，先回控制台再进维护 → 插件。 */
  try {
    await send('Page.navigate', { url: `${BASE}/` });
    await sleep(1200);
    await evalJs(`(() => {
      const sys = [...document.querySelectorAll('#nav1 .grp')].find((x) => (x.getAttribute('aria-label') || '').startsWith('维护'));
      sys?.click();
      return true;
    })()`);
    await sleep(350);
    const went = await evalJs(`(() => {
      const s = [...document.querySelectorAll('#nav2 .sub')].find((x) => /插件/.test(x.title || x.textContent || ''));
      if (s) s.click();
      return !!s;
    })()`);
    await sleep(450);
    ok(went, '插件页可进入（岛内维护 → 插件）');

    const plug = await evalJs(`(() => {
      const page = document.getElementById('page');
      const text = page ? (page.textContent || '') : '';
      const cards = [...document.querySelectorAll('.pcard')];
      const tags = [...document.querySelectorAll('.pcard .tag')];
      const titles = tags.map((t) => t.title || '');
      return {
        cards: cards.length,
        text,
        overTags: tags.filter((t) => /超上限/.test(t.textContent || '')).length,
        emptyTags: tags.filter((t) => /空载/.test(t.textContent || '')).length,
        bogus: titles.some((t) => /bogus-hook/.test(t)),
        toolErr: titles.some((t) => /工具数已达上限/.test(t)),
        plugMax: document.querySelector('[data-id="plug.max"]')?.value,
        toolMax: document.querySelector('[data-id="tool.max"]')?.value,
      };
    })()`);
    ok(plug.cards === 25, `插件板数 = 25（实际 ${plug.cards}）`);
    ok(/超过上限\s*5|超上限\s*5/.test(plug.text.replace(/\s+/g, ' ')), '总览显示超上限 5');
    ok(/已启用\s*25\s*\/\s*上限\s*20/.test(plug.text.replace(/\s+/g, ' ')), '总览显示「已启用 25 / 上限 20」');
    ok(/工具\s*20\s*\/\s*上限\s*64/.test(plug.text.replace(/\s+/g, ' ')), '总览显示「工具 20 / 上限 64」');
    ok(plug.overTags >= 5, `至少 5 张卡标了超上限（实际 ${plug.overTags}）`);
    ok(plug.emptyTags >= 1, '空载卡有显式标记');
    ok(plug.bogus, '钩子未挂的原因出现在卡片 title 上');
    ok(plug.toolErr, '工具注册失败的原因出现在卡片 title 上');
    ok(plug.plugMax === '20' && plug.toolMax === '64', `两个上限控件回显 20 / 64（实际 ${plug.plugMax} / ${plug.toolMax}）`);

    // 设置保存：输入 → change → 保存 → 读临时根 config.json；reload 后回显。
    const saved = await evalJs(`(async () => {
      const inp = document.querySelector('[data-p="qa01|mode"]');
      if (!inp) return { error: 'no-input' };
      inp.focus(); inp.value = 'abc';
      inp.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 150));
      const bar = document.getElementById('savebar');
      const dirty = !!bar && !bar.hidden && /1 处改动/.test(bar.textContent || '');
      document.querySelector('[data-a="draft-save"]')?.click();
      await new Promise((r) => setTimeout(r, 1500));
      return { dirty, errs: (window.__errs || []).length };
    })()`);
    ok(saved && !saved.error && saved.dirty, `输入后保存条出现「1 处改动」（${saved?.error || 'ok'}）`);
    let written = null;
    try { written = JSON.parse(fs.readFileSync(path.join(USERDATA, 'config.json'), 'utf8')); } catch { /* 读不到就红 */ }
    ok(written?.custom?.plugins?.settings?.qa01?.mode === 'abc',
      `保存后临时根 config.json 里 qa01.mode=abc（实际 ${JSON.stringify(written?.custom?.plugins?.settings?.qa01?.mode)}）`);

    await send('Page.reload');
    await sleep(1400);
    await evalJs(`(() => {
      const sys = [...document.querySelectorAll('#nav1 .grp')].find((x) => (x.getAttribute('aria-label') || '').startsWith('维护'));
      sys?.click();
      return true;
    })()`);
    await sleep(350);
    await evalJs(`(() => {
      const s = [...document.querySelectorAll('#nav2 .sub')].find((x) => /插件/.test(x.title || x.textContent || ''));
      if (s) s.click(); return !!s;
    })()`);
    await sleep(450);
    const back = await evalJs(`document.querySelector('[data-p="qa01|mode"]')?.value ?? ''`);
    ok(back === 'abc', `刷新后输入框回显 abc（实际 ${JSON.stringify(back)}）`);

    /* 2026-10-23：预算控件必须真的在页面上 + 能保存回临时根（不是只在 schema 里声明）。 */
    const hook0 = await evalJs(`document.querySelector('[data-id="plug.hookTimeout"]')?.value ?? ''`);
    ok(hook0 === '5000', `钩子超时控件回显 5000（实际 ${JSON.stringify(hook0)}）`);
    const hookSaved = await evalJs(`(async () => {
      const el = document.querySelector('[data-id="plug.hookTimeout"]');
      if (!el) return { error: 'no-hook-timeout' };
      el.value = '6000';
      el.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 150));
      document.querySelector('[data-a="draft-save"]')?.click();
      await new Promise((r) => setTimeout(r, 1500));
      return { ok: true };
    })()`);
    ok(hookSaved && !hookSaved.error, `钩子超时输入并保存（${hookSaved?.error || 'ok'}）`);
    let writtenHook = null;
    try { writtenHook = JSON.parse(fs.readFileSync(path.join(USERDATA, 'config.json'), 'utf8')); } catch { /* 读不到就红 */ }
    ok(writtenHook?.custom?.plugins?.hookTimeoutMs === 6000,
      `保存后临时根 config.json 里 hookTimeoutMs=6000（实际 ${JSON.stringify(writtenHook?.custom?.plugins?.hookTimeoutMs)}）`);

    await evalJs(`(() => {
      const g = [...document.querySelectorAll('#nav1 .grp')].find((x) => /记忆/.test(x.title || x.textContent || ''));
      if (g) g.click(); return !!g;
    })()`);
    await sleep(400);
    await evalJs(`(() => {
      const s = [...document.querySelectorAll('#nav2 .sub')].find((x) => /自我记忆/.test(x.title || x.textContent || ''));
      if (s) s.click(); return !!s;
    })()`);
    await sleep(450);
    const mem0 = await evalJs(`document.querySelector('[data-id="m.promptMax"]')?.value ?? ''`);
    ok(mem0 === '12', `记忆注入上限控件回显 12（实际 ${JSON.stringify(mem0)}）`);
    const memSaved = await evalJs(`(async () => {
      const el = document.querySelector('[data-id="m.promptMax"]');
      if (!el) return { error: 'no-memory-max' };
      el.value = '8';
      el.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 150));
      document.querySelector('[data-a="draft-save"]')?.click();
      await new Promise((r) => setTimeout(r, 1500));
      return { ok: true };
    })()`);
    ok(memSaved && !memSaved.error, `记忆注入上限输入并保存（${memSaved?.error || 'ok'}）`);
    let writtenMem = null;
    try { writtenMem = JSON.parse(fs.readFileSync(path.join(USERDATA, 'config.json'), 'utf8')); } catch { /* 读不到就红 */ }
    ok(writtenMem?.custom?.memory?.promptMax === 8,
      `保存后临时根 config.json 里 memory.promptMax=8（实际 ${JSON.stringify(writtenMem?.custom?.memory?.promptMax)}）`);

    await evalJs(`(() => {
      const s = [...document.querySelectorAll('#nav2 .sub')].find((x) => /知识包/.test(x.title || x.textContent || ''));
      if (s) s.click(); return !!s;
    })()`);
    await sleep(450);
    const skillBudget = await evalJs(`(() => ({
      max: document.querySelector('[data-id="skill.promptMax"]')?.value,
      chars: document.querySelector('[data-id="skill.promptChars"]')?.value,
    }))()`);
    ok(skillBudget && skillBudget.max === '3' && skillBudget.chars === '2000',
      `技能预算控件回显 3 / 2000（实际 ${skillBudget?.max} / ${skillBudget?.chars}）`);
  } catch (e) {
    ok(false, `插件/记忆/技能页冒烟失败：${e && e.message ? e.message : e}`);
  }
  await send('Emulation.clearDeviceMetricsOverride');

  /* ── P3-2：浏览器没有壳时必须仍走 HTTP；壳内离线要有明确横幅 ───────────── */
  console.log('\n── P3-2 重启/退出入口与半死界面 ──');
  await evalJs(`(() => {
    const g = [...document.querySelectorAll('#nav1 .grp')].find((x) => /维护/.test(x.title || x.textContent || ''));
    if (g) g.click();
    return !!g;
  })()`);
  await sleep(350);
  await evalJs(`(() => {
    const s = [...document.querySelectorAll('#nav2 .sub')].find((x) => /面板维护/.test(x.title || x.textContent || ''));
    if (s) s.click();
    return !!s;
  })()`);
  await sleep(450);
  const browserFallback = await evalJs(`(async () => {
    const orig = window.fetch;
    const calls = [];
    window.fetch = (url, opt = {}) => {
      calls.push(String(url));
      if (String(url).includes('/api/panel/restart')) {
        return Promise.resolve(new Response(JSON.stringify({ ok: true, restarted: false, msg: 'stub' }), {
          status: 200, headers: { 'content-type': 'application/json' },
        }));
      }
      return orig(url, opt);
    };
    const btn = document.querySelector('#page [data-a="panel.restart"]');
    if (!btn) { window.fetch = orig; return { error: 'no-restart-button' }; }
    btn.click();
    await new Promise((r) => setTimeout(r, 500));
    window.fetch = orig;
    return { calls, errs: (window.__errs || []).length };
  })()`);
  ok(browserFallback && !browserFallback.error, `浏览器模式有「重启面板」按钮（${browserFallback?.error || 'ok'}）`);
  ok((browserFallback?.calls || []).some((u) => u.includes('/api/panel/restart')),
    '浏览器模式点重启走的是 HTTP /api/panel/restart（没有壳时不能只剩 IPC）');
  ok((browserFallback?.errs || 0) === 0, '浏览器模式重启动作没有运行时错误');

  // 同一个页面在壳里：离线时横幅必须说清「后端没响应」并给出重启/退出。
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `window.estrellaShell = {
      isShell: true, platform: 'test',
      notify: () => Promise.resolve(), retry: () => Promise.resolve(),
      quit: () => Promise.resolve(), isWindowVisible: () => Promise.resolve(true),
      restartPanel: () => Promise.resolve({ ok: false, error: 'test' }),
      quitConsole: () => Promise.resolve({ ok: false, error: 'test' }),
      panelState: () => Promise.resolve({ ok: true, alive: false }),
    };`,
  });
  await send('Network.enable');
  await send('Page.navigate', { url: `${BASE}/` });
  let shellBooted = false;
  for (let i = 0; i < 50 && !shellBooted; i++) {
    shellBooted = await evalJs('document.querySelectorAll("#page *").length > 5');
    if (!shellBooted) await sleep(300);
  }
  ok(shellBooted, '注入壳 API 后首屏仍能渲染');
  await send('Network.setBlockedURLs', { urls: ['*api/state*'] });
  const shellOffline = await (async () => {
    for (let i = 0; i < 30; i++) {
      const v = await evalJs(`(() => {
        const banner = [...document.querySelectorAll('.banner')].find((x) => /控制台后端没有响应/.test(x.textContent || ''));
        if (!banner) return null;
        return {
          text: banner.textContent || '',
          restart: banner.querySelectorAll('[data-a="panel.restart"]').length,
          quit: banner.querySelectorAll('[data-a="panel.quit"]').length,
          subline: document.getElementById('subline')?.textContent || '',
          demo: /演示模式/.test(banner.textContent || ''),
        };
      })()`);
      if (v) return v;
      await sleep(300);
    }
    return null;
  })();
  ok(Boolean(shellOffline), '壳内后端断开后出现「控制台后端没有响应」横幅（不是一直转圈）');
  ok(shellOffline?.restart >= 1, '离线横幅有「重启面板」');
  ok(shellOffline?.quit >= 1, '离线横幅有「退出控制台」');
  ok(shellOffline && !shellOffline.demo, '壳内离线没有误显示「演示模式」');
  ok(/后端未连接/.test(shellOffline?.subline || ''), '顶栏副标题说明后端未连接');
  await send('Network.setBlockedURLs', { urls: [] });
} catch (e) {
  fails.push(`守卫自己出错：${e && e.message ? e.message : e}`);
} finally {
  try { ws && ws.close(); } catch { /* 已断 */ }
  try { process.kill(-browser.pid, 'SIGKILL'); } catch { try { browser.kill('SIGKILL'); } catch { /* 没了 */ } }
  panel.kill('SIGTERM');
  for (let i = 0; i < 30 && panel.exitCode === null; i++) await sleep(100);
  if (panel.exitCode === null) panel.kill('SIGKILL');
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* 清不掉就算了 */ }
  try { fs.rmSync(USERDATA, { recursive: true, force: true }); } catch { /* 清不掉就留给 tmp */ }
  cleaned = true;
}

if (fails.length) {
  for (const p of fails.slice(0, 12)) console.log(`✗ ${p}`);
  console.log(`── ${fails.length} 处问题 ──`);
  process.exit(1);
}
console.log('\n✓ 前端 DOM 守卫通过：首屏 + 检查表 + 逐页遍历（含零运行时错误 / 无白屏页）+ 插话冷却进度条 + 设置层外观/持久化/窄屏入口 + 二级随内容收缩 + 岛内维护域（6 域）');
process.exit(0);
