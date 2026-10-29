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
  const skillIds = ['sk01', 'sk02'];
  ex.custom = ex.custom && typeof ex.custom === 'object' ? ex.custom : {};
  ex.custom.extensions = {
    plugins: { enabled: ids, settings: { qa01: { mode: 'def' } } },
    skills: { enabled: skillIds, settings: {} },
    max: 20,
    hookTimeoutMs: 5000,
  };
  ex.custom.tools = { max: 64 };
  for (const id of ids) {
    const dir = path.join(USERDATA, 'plugins', id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({
      id, name: `QA ${id}`, version: '1.0.0', apiVersion: 1, entry: 'index.js',
      capabilities: [], permissions: [], requires: [],
      category: id === 'qa01' ? '工具' : (id === 'qa02' ? '数据' : ''),
      settings: id === 'qa01' ? { mode: 'def' } : {},
      configSchema: id === 'qa01' ? { mode: { label: '模式', description: '测试用设置' } } : {},
    }, null, 2), 'utf8');
    fs.writeFileSync(path.join(dir, 'index.js'), 'export function setup() {}\n', 'utf8');
  }
  for (const id of skillIds) {
    const dir = path.join(USERDATA, 'skills', id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'skill.json'), JSON.stringify({
      id, name: `Skill ${id}`, version: '1.0.0', apiVersion: 1, entry: 'index.js',
      capabilities: [], permissions: [], requires: [],
      settings: {}, configSchema: {},
      prompt: { sections: [{ id: `${id}-note`, title: `Skill ${id} 指引`, priority: 40, content: `${id} 的提示词正文。` }] },
    }, null, 2), 'utf8');
    fs.writeFileSync(path.join(dir, 'index.js'), id === 'sk01' ? 'export {};\n' : 'export function setup(api) { api.registerTool({ id: "ping", execute: () => "pong" }); }\n', 'utf8');
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
  const skillRt = [
    {
      id: 'sk01', dirName: 'sk01', kind: 'skill', name: 'Skill sk01', version: '1.0.0', state: 'loaded',
      tools: [], hooks: [], hookErrors: [], toolErrors: [], empty: false, promptOnly: true, mixed: false,
      promptSections: [{ id: 'sk01-note', title: 'Skill sk01 指引', priority: 40, content: 'sk01 的提示词正文。' }],
    },
    {
      id: 'sk02', dirName: 'sk02', kind: 'skill', name: 'Skill sk02', version: '1.0.0', state: 'loaded',
      tools: ['sk02__ping'], hooks: [], hookErrors: [], toolErrors: [], empty: false, promptOnly: false, mixed: false,
      promptSections: [{ id: 'sk02-note', title: 'Skill sk02 指引', priority: 40, content: 'sk02 的提示词正文。' }],
    },
  ];
  fs.mkdirSync(path.join(USERDATA, 'panel'), { recursive: true });
  fs.writeFileSync(path.join(USERDATA, 'panel', 'effective.json'), JSON.stringify({
    pid: process.pid, alive: true,
    extensions: {
      items: [...rtItems, ...overItems, ...skillRt],
      sum: { total: 27, loaded: 22, pending: 0, skipped: 0, failed: 0, over: 5, tools: 21, hooks: 20, empty: 1, promptOnly: 1, mixed: 0, promptSections: 2 },
      limits: { plugins: 20, tools: 64, toolsUsed: 21 },
    },
  }, null, 2), 'utf8');

  fs.writeFileSync(path.join(USERDATA, 'config.json'), JSON.stringify(ex, null, 2));
  fs.writeFileSync(path.join(USERDATA, 'github-star.fixture.json'), JSON.stringify({ count: 4242 }), 'utf8');

  /* 人设域图表夹具（2026-10-26）：给心情页/总览一份真实形状的状态，
     否则雷达、环形、折线与 21 项柱子只有空态，交互断言没法验。
     只写临时 USERDATA/data，不碰用户真实 data/。 */
  const now = Date.now();
  fs.mkdirSync(path.join(USERDATA, 'data'), { recursive: true });
  fs.writeFileSync(path.join(USERDATA, 'data', 'bot-state.json'), JSON.stringify({
    mood: 68, arousal: 42, acuteStress: 18, chronicStress: 2.4,
    radar: { warmth: 62, initiative: 48, sensitivity: 56, stability: 71, expressiveness: 43 },
    energy: { physical: 62, cognitive: 71, emotional: 58, will: 66 },
    emotions: {
      joy: 12, gratitude: 18, hope: 28, curiosity: 42, surprise: 6, anxiety: 4,
    },
    intent: '守着书房那盏灯，等一句值得接的话。',
    lastEvent: { kind: '被夸', note: '有人夸了它一句。', chatKey: 'group:100000001', at: now - 12000 },
    trend: [54, 55, 56, 52, 58, 60, 57, 62, 66, 61, 64, 63, 68],
    trendAt: now - 12000, updatedAt: now - 12000,
  }, null, 2), 'utf8');
} catch { /* 缺模板就按默认 */ }

const panel = spawn(NODE, ['panel/server.js'], {
  cwd: ROOT,
  env: {
    ...process.env,
    QQBOT_PANEL_PORT: String(panelPort),
    QQBOT_SANDBOX: '1',
    QQBOT_MODE: 'dev',
    QQBOT_USER_ROOT: USERDATA,
    QQBOT_GITHUB_STAR_FIXTURE: path.join(USERDATA, 'github-star.fixture.json'),
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
  ...(process.platform === 'win32'
    // Windows CI 实测：旧 `--headless` 会把页面当后台窗口节流，样式/脚本与 rAF 不落地。
    // 只在 Windows 换现代 headless 并关掉后台节流/遮挡检测；Mac 保持已通过的旧参数。
    ? ['--headless=new', '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows', '--disable-features=CalculateNativeWinOcclusion']
    : ['--headless']),
  `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`,
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
      if (!location.search.includes('__splashTest')) { try { sessionStorage.setItem('boot-splash-played', '1'); } catch (e) {} }
      addEventListener('error', (e) => window.__errs.push(String((e && e.message) || e)));
      addEventListener('unhandledrejection', (e) => window.__errs.push('unhandled: ' + String(e && e.reason)));`,
  });
  await send('Page.navigate', { url: `${BASE}/?__splashTest=1` });

  /* Windows Edge 冷启动时 HTML 先到、样式表/脚本后到；不等 load 就抓元素会拿到未样式化状态。
     这里只等就绪，不改变后面的任何断言。 */
  let splashLoaded = false;
  for (let i = 0; i < 300 && !splashLoaded; i++) {
    splashLoaded = await evalJs(`document.readyState === 'complete'`).catch(() => false);
    if (!splashLoaded) await sleep(100);
  }

  /* ── 开屏真渲染：第一显示、最高层、铺满视口、canvas 就位 ────────────────
     这一段**不跳过**开屏；拍完立刻点跳过，后续用例照旧在正常页面上跑。 */
  let splashFirst = null;
  /* Windows CI 冷启动可能 >4s；给到 20s，断言本身不变。 */
  for (let i = 0; i < 200 && !splashFirst; i++) {
    splashFirst = await evalJs(`(() => {
      const b = document.getElementById('bootSplash');
      if (!b || b.hidden) return null;
      const cs = getComputedStyle(b);
      if (cs.display === 'none' || cs.visibility === 'hidden') return null;
      if (cs.position !== 'fixed') return null;
      const el = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
      const others = [...document.querySelectorAll('.topbar, #navrow, .toast, .busy, .settings-layer, #cfRoot, .fx-wipe, .psn-help-tip, .psn-art-modal, .ov-tip')]
        .map((x) => getComputedStyle(x))
        .filter((s) => s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity || 1) > 0)
        .map((s) => Number(s.zIndex) || 0);
      return {
        first: !!(document.body.firstElementChild && document.body.firstElementChild.id === 'bootSplash'),
        inside: !!(el && b.contains(el)),
        z: Number(cs.zIndex) || 0,
        maxOther: Math.max(0, ...others),
        width: Math.round(b.getBoundingClientRect().width),
        iw: innerWidth,
      };
    })()`).catch(() => null);
    if (!splashFirst) await sleep(100);
  }
  if (!splashFirst) throw new Error('开屏没有在首帧出现（或 4 秒内就被跳过了）');
  ok(splashFirst.first && splashFirst.inside && splashFirst.z >= 200 && splashFirst.z > splashFirst.maxOther,
    `开屏第一显示且最高层（z=${splashFirst.z} · 其它最高=${splashFirst.maxOther} · 中心命中=${splashFirst.inside}）`);
  ok(splashFirst.width === splashFirst.iw, `开屏铺满视口（${splashFirst.width}/${splashFirst.iw}）`);
  let splashCanvas = false;
  for (let i = 0; i < 60 && !splashCanvas; i++) {
    splashCanvas = await evalJs(`!!document.getElementById('bootGridCanvas')`).catch(() => false);
    if (!splashCanvas) await sleep(100);
  }
  ok(splashCanvas, '开屏格栅 canvas 已创建');
  await evalJs(`(() => { const s = document.querySelector('#bootSplash .skip'); if (s) s.click(); return 1; })()`).catch(() => {});
  let splashGone = false;
  for (let i = 0; i < 30 && !splashGone; i++) {
    splashGone = await evalJs(`document.getElementById('bootSplash') ? document.getElementById('bootSplash').hidden : true`).catch(() => false);
    if (!splashGone) await sleep(100);
  }
  ok(splashGone, `跳过开屏后整层隐藏（hidden=${splashGone}）`);

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
      ovGroups: document.querySelectorAll('#card-chain .ov-group').length,
      ovGroupsOpen: [...document.querySelectorAll('#card-chain .ov-group')].filter((d) => d.open).length,
      ovCells: document.querySelectorAll('.ov-cell').length,
      ovKpis: document.querySelectorAll('.ov-kpi[data-ov-kpi]').length,
      ovKpiSparks: document.querySelectorAll('.ov-kpi[data-ov-kpi] .ov-kpi-spark svg path.line').length,
      ovKpiDeltas: document.querySelectorAll('.ov-kpi[data-ov-kpi] .ov-kpi-delta').length,
      ovKpiPts: document.querySelectorAll('.ov-kpi[data-ov-kpi] .ov-kpi-pt').length,
      ovSubs: document.querySelectorAll('#card-chain .ov-sub').length,
      ovSubRings: document.querySelectorAll('#card-chain .ov-sub-ring').length,
      ovSubPct: document.querySelectorAll('#card-chain .ov-sub-pct').length,
      ovSubDone: document.querySelectorAll('#card-chain .ov-sub.done').length,
      ovSubBad: document.querySelectorAll('#card-chain .ov-sub.bad').length,
      ovNodeChecks: document.querySelectorAll('#card-chain .ov-node-check').length,
      ovDoneGroups: document.querySelectorAll('#card-chain .ov-group[data-state="done"]').length,
      ovCheckShown: [...document.querySelectorAll('#card-chain .ov-group[data-state="done"] .ov-node-check')].filter((x) => getComputedStyle(x).display !== 'none').length,
      ovFocusExtra: document.querySelectorAll('.ov-focus-extra > div').length,
      ovFocusLabels: [...document.querySelectorAll('.ov-focus-extra .k')].map((x) => x.textContent).join(','),
      ovFocusBg: (() => { const el = document.querySelector('.ov-focus'); return el ? getComputedStyle(el).backgroundImage : ''; })(),
      ovFocusColor: (() => { const el = document.querySelector('.ov-focus'); return el ? getComputedStyle(el).backgroundColor : ''; })(),
      ovHeatBg: (() => { const el = document.querySelector('.ov-heat-panel'); return el ? getComputedStyle(el).backgroundImage : ''; })(),
      ovHeatColor: (() => { const el = document.querySelector('.ov-heat-panel'); return el ? getComputedStyle(el).backgroundColor : ''; })(),
      ovActionOrder: [...document.querySelectorAll('.ov-act-grid .ov-btn')].map((b) => b.dataset.a || '').join(','),
      ovStopGhost: (() => { const b = document.querySelector('.ov-act-grid .ov-btn[data-a="onekey.stop"]'); return b ? b.classList.contains('ov-btn-ghost') : null; })(),
      ovLineCard: !!document.querySelector('#card-side .ov-line'),
      ovGauge: !!document.querySelector('.ov-gauge-wrap'),
      ovGaugeRows: document.querySelectorAll('[data-ov-gauge-row]').length,
      ovGaugeSegs: document.querySelectorAll('.ov-gauge-seg').length,
      ovGaugePctSum: [...document.querySelectorAll('[data-ov-gauge-row] .pc')].reduce((n, el) => n + (parseInt(el.textContent, 10) || 0), 0),
      ovGaugeCountSum: [...document.querySelectorAll('[data-ov-gauge-row] .n')].reduce((n, el) => n + (parseInt(el.textContent, 10) || 0), 0),
      ovGaugeTotal: Number((document.querySelector('[data-ov-gauge]') || {}).dataset ? document.querySelector('[data-ov-gauge]').dataset.total : 0),
      ovStatSides: document.querySelectorAll('.ov-stat-side').length,
      ovStatSideRows: document.querySelectorAll('.ov-stat-side > span').length,
      ovStatHero: (() => { const el = document.querySelector('.ov-stat b.v'); return el ? parseFloat(getComputedStyle(el).fontSize) : 0; })(),
      ovKpiEdge: (() => {
        const p = document.querySelector('.ov-kpi .ov-kpi-spark path.line');
        if (!p) return null;
        const nums = (p.getAttribute('d') || '').match(/-?[0-9.]+/g);
        if (!nums || nums.length < 2) return null;
        return { start: Number(nums[0]), end: Number(nums[nums.length - 2]) };
      })(),
      ovActions: document.querySelectorAll('#card-side .ov-btn').length,
      ovDetailTag: (document.querySelector('#card-details') || {}).tagName || '',
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

  console.log('\n── 运行总览三栏 ──');
  ok(first.ovGroups === 3, `启动链路 = 3 个主节点（实得 ${first.ovGroups}）`);
  ok(first.ovGroupsOpen === 3, `3 个主节点默认全部展开（实得 ${first.ovGroupsOpen}）`);
  ok(first.ovCells === 371, `发言热力图 = 53 周 × 7 天（实得 ${first.ovCells} 格）`);
  ok(first.ovKpis === 3, `KPI 三张卡（实得 ${first.ovKpis}）`);
  ok(first.ovKpiSparks === 3 && first.ovKpiDeltas === 3, `三张 KPI 都有缩略曲线和增幅（曲线 ${first.ovKpiSparks} / 增幅 ${first.ovKpiDeltas}）`);
  ok(first.ovKpiPts >= 42, `三张 KPI 各有 14 个可悬停数据点（实得 ${first.ovKpiPts}）`);
  ok(first.ovSubRings === first.ovSubs && first.ovSubPct === first.ovSubs, `启动链每个子项都有圆圈进度和右侧百分比（子项 ${first.ovSubs} / 圈 ${first.ovSubRings} / 百分比 ${first.ovSubPct}）`);
  ok(first.ovSubDone >= 1 && first.ovSubBad >= 1, `启动链同时有已完成和未完成子项（done ${first.ovSubDone} / bad ${first.ovSubBad}）`);
  ok(first.ovNodeChecks === first.ovGroups, `每个主节点都有父级勾槽（实得 ${first.ovNodeChecks} / ${first.ovGroups}）`);
  ok(first.ovCheckShown === first.ovDoneGroups, `只有全部子项完成的主节点显示父级勾（可见 ${first.ovCheckShown} / 就绪组 ${first.ovDoneGroups}）`);
  ok(first.ovFocusExtra === 3 && first.ovFocusLabels === '运行内存,网络延迟,已运行', `今日小结补齐运行内存/网络延迟/已运行（实得 ${first.ovFocusExtra}：${first.ovFocusLabels}）`);
  ok(first.ovFocusBg === first.ovHeatBg && first.ovFocusColor === first.ovHeatColor, '今日小结与相邻卡片同材质（背景图与底色逐字一致，不再自带渐变）');
  ok(first.ovActionOrder.includes('protocol.start'), '运行控制里有「拉起协议端」');
  ok(first.ovStopGhost === null || first.ovStopGhost === true, '「结束本次运行」是空白幽灵按钮（不是绿色实心）');
  {
    const order = first.ovActionOrder.split(',');
    const pIdx = order.indexOf('protocol.start');
    const sIdx = order.indexOf('onekey.stop');
    ok(sIdx < 0 || (pIdx >= 0 && sIdx > pIdx), `「结束本次运行」排在「拉起协议端」之后（实得 ${first.ovActionOrder}）`);
  }
  ok(first.ovKpiEdge && first.ovKpiEdge.start === 0 && first.ovKpiEdge.end === 100, `KPI 缩略曲线横向贴边、两侧不留白缝（实得 ${first.ovKpiEdge ? first.ovKpiEdge.start + ' → ' + first.ovKpiEdge.end : 'null'}）`);
  ok(first.ovStatSides === 4 && first.ovStatSideRows === 8, `四张信息卡都有右侧副读数（卡 ${first.ovStatSides} / 行 ${first.ovStatSideRows}）`);
  ok(first.ovStatHero >= 34, `信息卡主数字放大到 34px 以上（实得 ${first.ovStatHero}px）`);
  ok(first.ovLineCard === true, '右栏 Token / 花费卡在位（空数据也要有卡）');
  ok(first.ovGauge === true, '右栏插件 Gauge 在位（空插件也要有轨道）');
  ok(first.ovGaugeRows >= 2 && first.ovGaugeRows === first.ovGaugeSegs, `Gauge 每段都有对应图例行（段 ${first.ovGaugeSegs} / 行 ${first.ovGaugeRows}）`);
  ok(first.ovGaugeCountSum === first.ovGaugeTotal, `图例计数之和 = 中心总数，未加载不再重复计（${first.ovGaugeCountSum} / ${first.ovGaugeTotal}）`);
  ok(first.ovGaugePctSum === 100, `图例百分比整数相加正好 100（实得 ${first.ovGaugePctSum}）`);
  ok(first.ovActions >= 4, `右栏主操作至少 4 颗（实得 ${first.ovActions}）`);
  ok(first.ovDetailTag === 'DETAILS', '底部运行详情是可折叠 DETAILS');
  const kpiHover = await evalJs(`(() => {
    const card = document.querySelector('.ov-kpi[data-ov-kpi]');
    if (!card) return null;
    const r = card.getBoundingClientRect();
    card.dispatchEvent(new PointerEvent('pointermove', { clientX: r.left + r.width * 0.6, clientY: r.top + r.height - 8, bubbles: true }));
    const hit = card.querySelector('.ov-kpi-hit');
    const scan = card.querySelector('.ov-kpi-spark .scan');
    const dot = card.querySelector('.ov-kpi-spark .dot');
    const out = {
      hot: card.classList.contains('hot'),
      hit: !!hit && !hit.hidden && /条|tokens|¥/.test(hit.textContent || ''),
      scan: !!scan, dot: !!dot,
    };
    card.dispatchEvent(new PointerEvent('pointerleave', { bubbles: true }));
    return out;
  })()`);
  ok(kpiHover && kpiHover.hot === true && kpiHover.hit === true, '鼠标经过 KPI 出现竖向扫描条和读数');
  ok(kpiHover && kpiHover.scan === true && kpiHover.dot === true, '扫描条与数据点都挂在同一次悬停状态上');
  const gaugeHover = await evalJs(`(async () => {
    const card = document.querySelector('[data-ov-gauge]');
    const row = card && card.querySelector('[data-ov-gauge-row]');
    if (!card || !row) return null;
    const k = card.querySelector('[data-ov-gauge-k]');
    const v = card.querySelector('[data-ov-gauge-v]');
    const p = card.querySelector('[data-ov-gauge-p]');
    const label = (row.querySelector('.lb') || {}).textContent || '';
    const n = (row.querySelector('.n') || {}).textContent || '';
    const pc = (row.querySelector('.pc') || {}).textContent || '';
    row.dispatchEvent(new PointerEvent('pointerenter', { bubbles: true }));
    /* 悬停样式是 0.18s 过渡：固定 260ms 在负载高时可能读到过渡中的 opacity。
       改成条件等待（上限 1.2s），判据仍是 rowHot / 唯一 hot 段 / 其余段 opacity < .5。 */
    let segs = [];
    let off = null;
    for (let i = 0; i < 15; i++) {
      segs = [...card.querySelectorAll('.ov-gauge-seg')];
      off = segs.find((x) => !x.classList.contains('hot'));
      if (row.classList.contains('hot')
        && segs.filter((x) => x.classList.contains('hot')).length === 1
        && off && Number(getComputedStyle(off).opacity) < .5) break;
      await new Promise((r) => setTimeout(r, 80));
    }
    const out = {
      hot: card.dataset.hot === '1',
      k: k.textContent, v: v.textContent, p: p.textContent,
      label, n, pc,
      rowHot: row.classList.contains('hot'),
      segHot: segs.filter((x) => x.classList.contains('hot')).length,
      dim: off ? getComputedStyle(off).opacity : '1',
    };
    row.dispatchEvent(new PointerEvent('pointerleave', { bubbles: true }));
    out.resetHot = card.dataset.hot === '1';
    out.resetK = k.textContent;
    return out;
  })()`);
  ok(gaugeHover && gaugeHover.hot && gaugeHover.k === gaugeHover.label && gaugeHover.v.startsWith(gaugeHover.n) && gaugeHover.p.includes(gaugeHover.pc), '悬停 Gauge 图例行：中心读数切到该段（名称 / 数量 / 占比）');
  ok(gaugeHover && gaugeHover.rowHot && gaugeHover.segHot === 1 && Number(gaugeHover.dim) < .5, `悬停行出现灰底，且只强调对应弧段、其余段褪色（${JSON.stringify(gaugeHover)}）`);
  ok(gaugeHover && !gaugeHover.resetHot && gaugeHover.resetK === '总计', '鼠标移出后中心读数恢复总计');
  const chainSeg = await evalJs(`(() => {
    const g = document.querySelector('#card-chain .ov-node:not(:first-child) .ov-group');
    if (!g) return null;
    const s = getComputedStyle(g, '::before');
    return { h: s.height, w: s.width, bg: s.backgroundColor, content: s.content };
  })()`);
  ok(chainSeg && chainSeg.content !== 'none' && chainSeg.w === '2px' && chainSeg.h === '27px', '链路节点之间是分段绘制的连接线（不是贯穿整卡的渐变长线）');
  const chainProbe = await evalJs(`(() => {
    const g = document.querySelector('#card-chain .ov-group');
    if (!g) return null;
    const old = g.dataset.state;
    g.dataset.state = 'done';
    const c = g.querySelector('.ov-node-check');
    const out = { display: c ? getComputedStyle(c).display : '' };
    g.dataset.state = old;
    return out;
  })()`);
  ok(chainProbe && chainProbe.display === 'grid', '主节点进入 done 时父级勾可见（CSS 状态联动）');
  await evalJs(`window.__ovCell = document.querySelector('.ov-cell'); true`);
  await sleep(3400);
  const ovStable = await evalJs(`(() => {
    const doneRow = document.querySelector('#card-chain .ov-sub.done');
    const tx = doneRow ? doneRow.querySelector('.stp-tx') : null;
    const after = tx ? getComputedStyle(tx, '::after') : null;
    const disc = doneRow ? doneRow.querySelector('.ov-sub-ring .disc') : null;
    const pct = doneRow ? doneRow.querySelector('.ov-sub-pct') : null;
    return {
      same: window.__ovCell === document.querySelector('.ov-cell'),
      tag: (document.querySelector('#card-details') || {}).tagName || '',
      open: !!(document.querySelector('#card-details') || {}).open,
      strike: !!after && after.content !== 'none' && after.transform !== 'matrix(0, 0, 0, 0, 0, 0)',
      disc: disc ? getComputedStyle(disc).opacity : '',
      pct: pct ? pct.textContent : '',
    };
  })()`);
  ok(ovStable.same === true, '3.4 秒轮询后热力格仍是同一个节点（按卡补丁，不整页重建）');
  ok(ovStable.tag === 'DETAILS' && ovStable.open === false, '底部详情仍默认收起，未被轮询顶开');
  ok(ovStable.strike === true && ovStable.disc === '1' && ovStable.pct === '100%', `完成子项最终是勾+横线+100%（横线 ${ovStable.strike} / 圆盘 ${ovStable.disc} / 读数 ${ovStable.pct}）`);

  // ── 遍历每个功能域 × 每个子页（这才是这个守卫真正要抓的：某一页白屏）──
  console.log('\n── 逐页遍历 ──');
  const r = await evalJs(`(async () => {
    const out = [];
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const nGroups = document.querySelectorAll('#nav1 .grp').length;
    const errsBefore0 = () => (window.__errs || []).length;
    for (let g = 0; g < nGroups; g++) {
      /* 工厂域导航会自动上收；遍历前先呼出，否则 navrow 是 inert，子页点不动。 */
      if (document.body.classList.contains('nav-auto-hidden') && window.__navAutoHide) {
        window.__navAutoHide.reveal();
        await sleep(380);
      }
      document.querySelectorAll('#nav1 .grp')[g].click();
      await sleep(150);
      const nSubs = document.querySelectorAll('#nav2 .sub').length;
      for (let s = 0; s < nSubs; s++) {
        const before = errsBefore0();
        if (document.body.classList.contains('nav-auto-hidden') && window.__navAutoHide) {
          window.__navAutoHide.reveal();
          await sleep(380);
        }
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
          frame: document.body.classList.contains('is-frame-page'),
          blank: page.classList.contains('page--blank'),
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

  const blankPages = r.filter((x) => x.blank);
  const badBlank = r.filter((x) => !x.frame && !x.blank && x.textLen < 80);
  const frames = r.filter((x) => x.frame);
  const errored = r.filter((x) => x.newErrs > 0);
  /* ⚠️ 这条和上面那条不是一回事：`ctrlHtml()` 会把**渲染器自己抛的错**接住，
     然后在页面上写一行「渲染「xxx」时出错：…」—— 它**不进 window error**，
     所以"零运行时错误"那一栏对它**永远是绿的**（2026-10-14 实测踩到：
     readyChecklist 里漏了一行 `const botRunning`，表现就是 0 行 + 零报错）。
     ⇒ 只能靠扫页面文本。 */
  const renderErr = r.filter((x) => /渲染「.*」时出错/.test(x.sampleAll || ''));
  console.log(`  共遍历 ${r.length} 个页面`);
  ok(r.length >= 8, `页面数像个真的（实得 ${r.length}）—— 少于 8 说明导航没渲染全，"逐页遍历"这条判据在真空里`);
  ok(badBlank.length === 0, `没有白屏页（${badBlank.length} 页文字量 < 80）`);
  if (badBlank.length) for (const b of badBlank.slice(0, 6)) console.log(`     ✗ ${b.label} · ${b.textLen} 字符 · 「${b.sample}」`);
  const frameLabels = frames.map((x) => x.label.replace(/（\d+\s*页）/g, '').replace(/\s+/g, ''));
  ok(blankPages.length === 0,
    `没有空白页（工厂三页改为 frame 页，实得 ${blankPages.map((x) => x.label).join(' · ') || '无'}）`);
  ok(frames.length === 3 && frameLabels.includes('工厂/视觉工厂')
    && frameLabels.includes('工厂/人设工厂') && frameLabels.includes('工厂/插件工厂'),
    `工厂三页都挂 frame（实得 ${frameLabels.join(' · ') || '无'}）`);
  ok(errored.length === 0, `逐页点击零运行时错误（${errored.length} 页有错）`);
  if (errored.length) for (const b of errored.slice(0, 6)) console.log(`     ✗ ${b.label} · 新增 ${b.newErrs} 条错误`);
  ok(renderErr.length === 0, `没有"渲染时出错"的自带错误行（${renderErr.length} 页有）—— `
    + '这类错被 ctrlHtml 接住写进页面，window error 看不见，只能扫文本');
  if (renderErr.length) for (const b of renderErr.slice(0, 6)) console.log(`     ✗ ${b.label} · 「${(b.sampleAll || '').slice(0, 120)}」`);

  const counts = r.map((x) => `${x.label.trim()}=${x.cards}`).join(' ');
  console.log(`  每页卡片数：${counts}`);

  /* ── 工厂五页（2026-10-27 · 二级导航驱动）──────────────────────────────
     工厂不再是顶栏圆钮 + 空白占位：三个二级页各挂一份常驻 iframe，
     由 #page[data-frame] 选帧；另有插件管理 / Skill 两个普通页。这里必须验：
     五页都在、导航真的能点、导航压在工厂之上、轮询不重载也不重播入场、
     切帧不重载、离开收起、重进保留，以及从普通页切回 frame 页时鼠标在导航上不收回。 */
  console.log('\n── 工厂五页（二级导航驱动）──');
  /* 让真实指针先离开导航：下面的首轮自动上收要求鼠标不在 dock 上。 */
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 20, y: 600 });
  const fx = await evalJs(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const groups = () => [...document.querySelectorAll('#nav1 .grp')];
    const subs = () => [...document.querySelectorAll('#nav2 .sub')];
    const subOf = (name) => subs().find((b) => (b.title || b.textContent || '').includes(name));
    const grp0 = groups().find((b) => (b.title || b.textContent || '').includes('工厂'));
    if (!grp0) return { err: '找不到工厂域' };
    /* 页面遍历可能停在工厂且导航已上收：先呼出，再回运行，保证这次是"从别处进工厂"。 */
    if (document.body.classList.contains('nav-auto-hidden') && window.__navAutoHide) {
      window.__navAutoHide.reveal();
      await sleep(420);
    }
    groups()[0].click(); await sleep(650);
    const grp = groups().find((b) => (b.title || b.textContent || '').includes('工厂'));
    if (!grp) return { err: '进工厂前找不到工厂域' };
    grp.click(); await sleep(620);
    const hiddenWait = async (ms) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        if (document.body.classList.contains('nav-auto-hidden')) return true;
        await sleep(100);
      }
      return false;
    };
    const autoHidden = await hiddenWait(3000);
    const row = document.getElementById('navrow');
    const hot = document.getElementById('navHotzone');
    /* visibility 是 0.34s 延迟切换；负载下固定 sleep 会读到还在过渡中的 visible。 */
    for (let i = 0; i < 15; i++) {
      if (getComputedStyle(row).visibility === 'hidden') break;
      await sleep(100);
    }
    await sleep(80);
    const hiddenState = {
      body: document.body.classList.contains('nav-auto-hidden'),
      inert: row.inert === true,
      opacity: getComputedStyle(row).opacity,
      transform: getComputedStyle(row).transform,
      visibility: getComputedStyle(row).visibility,
      hotPointer: getComputedStyle(hot).pointerEvents,
      hotW: Math.round(hot.getBoundingClientRect().width),
      hotTop: Math.round(hot.getBoundingClientRect().top),
      topbarBottom: Math.round(document.querySelector('.topbar').getBoundingClientRect().bottom),
    };
    const st0 = window.__navAutoHide ? window.__navAutoHide.state() : null;
    if (st0 && !st0.armed) hot.dispatchEvent(new PointerEvent('pointerleave', { bubbles: true }));
    hot.dispatchEvent(new PointerEvent('pointerenter', { bubbles: true }));
    await sleep(420);
    const shownState = {
      body: document.body.classList.contains('nav-auto-hidden'),
      inert: row.inert === true,
      opacity: getComputedStyle(row).opacity,
      transform: getComputedStyle(row).transform,
      visibility: getComputedStyle(row).visibility,
    };
    const labels = subs().map((b) => (b.title || b.textContent || '').trim());
    const framesAttr = subs().map((b) => b.dataset.frame || '');
    const sub = subOf('视觉工厂');
    if (!sub) return { err: '找不到视觉工厂页', labels, framesAttr };
    sub.click();
    let frame = null;
    for (let i = 0; i < 120; i++) {
      frame = document.querySelector('#factoryHost iframe[data-frame="visual-factory.html"]');
      if (frame && document.body.classList.contains('factory-frame-ready')) break;
      await sleep(100);
    }
    if (!frame) return { err: '视觉工厂 iframe 未就绪', labels, framesAttr };
    await sleep(300);
    const doc = frame.contentDocument;
    if (doc && doc.defaultView) doc.defaultView.__factoryKeep = 1;
    const page = document.getElementById('page');
    const host = document.getElementById('factoryHost');
    const nav = document.getElementById('navrow');
    const topbar = document.querySelector('.topbar');
    const gear = document.getElementById('setGear');
    const hs = getComputedStyle(host), ns = getComputedStyle(nav);
    const ts = getComputedStyle(topbar), gs = getComputedStyle(gear);
    const hb = host.getBoundingClientRect(), tb = topbar.getBoundingClientRect();
    const st = window.__factoryFrame.state();
    const sr = sub.getBoundingClientRect();
    const hitSub = document.elementFromPoint(Math.round(sr.left + sr.width / 2), Math.round(sr.top + sr.height / 2));
    const navBottom = Math.round(nav.getBoundingClientRect().bottom);
    const hitBelow = document.elementFromPoint(Math.round(innerWidth / 2), Math.min(innerHeight - 4, navBottom + 24));
    const open = {
      pageCls: page.className, pageText: (page.textContent || '').length, pageCards: page.querySelectorAll('.card').length,
      bodyFrame: document.body.classList.contains('is-frame-page'), dataFrame: page.dataset.frame || '',
      hostVis: hs.visibility, hostAria: host.getAttribute('aria-hidden'),
      hostZ: Number(hs.zIndex) || 0, navZ: Number(ns.zIndex) || 0,
      topbarZ: Number(ts.zIndex) || 0, gearZ: Number(gs.zIndex) || 0,
      top: Math.round(hb.top), bottom: Math.round(hb.bottom), w: Math.round(hb.width), h: Math.round(hb.height),
      topbarBottom: Math.round(tb.bottom), innerW: innerWidth, innerH: innerHeight,
      active: st.active, src: st.src, ready: st.ready, enterCount: st.enterCount, loads: st.loadCount,
      selected: (subs().find((b) => b.getAttribute('aria-selected') === 'true') || {}).textContent || '',
      btnIds: ['factoryBtn', 'personaFactoryBtn', 'pluginFactoryBtn'].filter((id) => !!document.getElementById(id)),
      toggleAction: !!document.querySelector('[data-a="factory.toggle"]'),
      brandDisplay: doc && doc.querySelector('.brand') ? getComputedStyle(doc.querySelector('.brand')).display : null,
      brandText: doc ? ((doc.querySelector('.brand-copy b') || {}).textContent || '') : '',
      embed: doc ? (doc.documentElement.dataset.embed || '') : '',
      hitSubOk: !!(hitSub && hitSub.closest && hitSub.closest('#nav2 .sub')),
      hitIframe: !!(hitBelow && (hitBelow.tagName === 'IFRAME' || (hitBelow.closest && hitBelow.closest('#factoryHost')))),
      navHidden: document.body.classList.contains('nav-auto-hidden'),
      navInert: row.inert === true,
    };
    await sleep(3600);
    const same = frame === document.querySelector('#factoryHost iframe[data-frame="visual-factory.html"]');
    const st1 = window.__factoryFrame.state();
    const keep1 = frame.contentDocument && frame.contentDocument.defaultView ? frame.contentDocument.defaultView.__factoryKeep : 0;
    const poll = { same, loads: st1.loadCount, enterCount: st1.enterCount, navHidden: document.body.classList.contains('nav-auto-hidden') };

    /* 悬停面是整个导航 dock（一级 + 二级）：停在上面超过 2.5s 不许收回；
       离开 dock 后才开始 2.5s 计时。 */
    const dock = document.getElementById('navDockWrap');
    dock.dispatchEvent(new PointerEvent('pointerenter', { bubbles: true }));
    await sleep(3000);
    const hoverStay = !document.body.classList.contains('nav-auto-hidden');
    const timerT0 = Date.now();
    dock.dispatchEvent(new PointerEvent('pointerleave', { bubbles: true, relatedTarget: document.body }));
    const autoHiddenAgain = await hiddenWait(5000);
    const timerMs = Date.now() - timerT0;
    await sleep(420);
    const st2 = window.__navAutoHide ? window.__navAutoHide.state() : null;
    if (st2 && !st2.armed) hot.dispatchEvent(new PointerEvent('pointerleave', { bubbles: true }));
    hot.dispatchEvent(new PointerEvent('pointerenter', { bubbles: true }));
    await sleep(420);

    /* 回归（2026-10-28）：从普通页（插件管理）切回 frame 页会重新武装 navAuto；
       此时鼠标仍在二级栏上，120ms 后不许收回。 */
    const normal = subOf('插件管理');
    if (!normal) return { err: '找不到插件管理页' };
    normal.click(); await sleep(450);
    const dockRect = dock.getBoundingClientRect();
    dock.dispatchEvent(new PointerEvent('pointermove', {
      bubbles: true,
      clientX: dockRect.left + dockRect.width / 2,
      clientY: dockRect.top + dockRect.height / 2,
    }));
    subOf('视觉工厂').click(); await sleep(3000);
    const stayAfterRearm = !document.body.classList.contains('nav-auto-hidden');
    dock.dispatchEvent(new PointerEvent('pointerleave', { bubbles: true, relatedTarget: document.body }));
    const hiddenAfterRearm = await hiddenWait(5000);
    await sleep(420);
    const stRearm = window.__navAutoHide ? window.__navAutoHide.state() : null;
    if (stRearm && !stRearm.armed) hot.dispatchEvent(new PointerEvent('pointerleave', { bubbles: true }));
    hot.dispatchEvent(new PointerEvent('pointerenter', { bubbles: true }));
    await sleep(420);

    const subP = subOf('人设工厂');
    if (!subP) return { err: '找不到人设工厂页', labels, framesAttr };
    subP.click();
    let pFrame = null;
    for (let i = 0; i < 300; i++) {
      pFrame = document.querySelector('#factoryHost iframe[data-frame="persona-factory.html"]');
      const stP0 = window.__factoryFrame.state();
      if (pFrame && stP0.active === 'persona' && stP0.frames.persona.ready) break;
      await sleep(100);
    }
    const stP = window.__factoryFrame.state();
    const persona = {
      active: stP.active, open: stP.open,
      personaHidden: !!document.querySelector('#factoryHost .factory-pane[data-factory="persona"]').hidden,
      visualHidden: !!document.querySelector('#factoryHost .factory-pane[data-factory="visual"]').hidden,
      src: pFrame ? pFrame.getAttribute('src') : '',
      header: !!(pFrame && pFrame.contentDocument && pFrame.contentDocument.querySelector('.site-header')),
      visualLoads: stP.frames.visual.loadCount,
      personaLoads: stP.frames.persona.loadCount,
    };

    const subG = subOf('插件工厂');
    if (!subG) return { err: '找不到插件工厂页', labels, framesAttr };
    subG.click();
    let gFrame = null;
    for (let i = 0; i < 300; i++) {
      gFrame = document.querySelector('#factoryHost iframe[data-frame="plugin-factory.html"]');
      const stG0 = window.__factoryFrame.state();
      if (gFrame && stG0.active === 'plugin' && stG0.frames.plugin.ready) break;
      await sleep(100);
    }
    const stG = window.__factoryFrame.state();
    const plugin = {
      active: stG.active, open: stG.open,
      pluginHidden: !!document.querySelector('#factoryHost .factory-pane[data-factory="plugin"]').hidden,
      personaHidden: !!document.querySelector('#factoryHost .factory-pane[data-factory="persona"]').hidden,
      src: gFrame ? gFrame.getAttribute('src') : '',
      app: !!(gFrame && gFrame.contentDocument && gFrame.contentDocument.querySelector('.app')),
      personaLoads: stG.frames.persona.loadCount,
    };
    let tree = { cats: [], labels: [], folderText: '', createOpen: false, createFields: 0 };
    if (gFrame && gFrame.contentDocument) {
      const pd = gFrame.contentDocument;
      for (let i = 0; i < 40; i++) {
        if (pd.querySelectorAll('#treeRows .row-btn[data-cat]').length >= 2) break;
        await sleep(100);
      }
      const rows = [...pd.querySelectorAll('#treeRows .row-btn[data-cat]')];
      tree = {
        cats: rows.map((b) => b.getAttribute('data-cat')),
        labels: rows.map((b) => ((b.querySelector('.lbl') || {}).textContent || '')),
        folderText: ((pd.querySelector('[data-imp="folder"]') || {}).textContent || ''),
        createOpen: false,
        createFields: pd.querySelectorAll('#createScrim input, #createScrim select, #createScrim textarea').length,
      };
      const createBtn = pd.querySelector('[data-act="create"]');
      if (createBtn) {
        createBtn.click();
        await sleep(120);
        tree.createOpen = !!pd.getElementById('createScrim') && pd.getElementById('createScrim').hidden === false;
        const close = pd.querySelector('[data-create="close"]');
        if (close) close.click();
        await sleep(80);
      }
    }

    subOf('视觉工厂').click(); await sleep(500);
    const stBack = window.__factoryFrame.state();
    const back = {
      active: stBack.active,
      sameFrame: frame === document.querySelector('#factoryHost iframe[data-frame="visual-factory.html"]'),
      visualHidden: !!document.querySelector('#factoryHost .factory-pane[data-factory="visual"]').hidden,
      loads: stBack.frames.visual.loadCount,
      keep: frame.contentDocument && frame.contentDocument.defaultView ? frame.contentDocument.defaultView.__factoryKeep : 0,
    };

    groups()[0].click(); await sleep(700);
    const left = {
      bodyFrame: document.body.classList.contains('is-frame-page'), dataFrame: page.dataset.frame || '',
      pageCls: page.className, hostVis: getComputedStyle(host).visibility,
      hostAria: host.getAttribute('aria-hidden'),
      ready: document.body.classList.contains('factory-frame-ready'),
      navHidden: document.body.classList.contains('nav-auto-hidden'),
      navInert: row.inert === true,
      navVis: getComputedStyle(row).visibility,
    };

    const grpBack = groups().find((b) => (b.title || b.textContent || '').includes('工厂'));
    if (!grpBack) return { err: '重进时找不到工厂域', labels, framesAttr };
    grpBack.click(); await sleep(620);
    const reHidden = await hiddenWait(3000);
    await sleep(420);
    const st3 = window.__navAutoHide ? window.__navAutoHide.state() : null;
    if (st3 && !st3.armed) hot.dispatchEvent(new PointerEvent('pointerleave', { bubbles: true }));
    hot.dispatchEvent(new PointerEvent('pointerenter', { bubbles: true }));
    await sleep(420);
    const stRe = window.__factoryFrame.state();
    const reFrame = document.querySelector('#factoryHost iframe[data-frame="visual-factory.html"]');
    const re = {
      active: stRe.active, open: stRe.open, ready: document.body.classList.contains('factory-frame-ready'),
      hostVis: getComputedStyle(host).visibility,
      same: reFrame === frame, loads: stRe.frames.visual.loadCount,
      keep: reFrame && reFrame.contentDocument && reFrame.contentDocument.defaultView ? reFrame.contentDocument.defaultView.__factoryKeep : 0,
      navHidden: document.body.classList.contains('nav-auto-hidden'),
      navInert: row.inert === true,
    };
    groups()[0].click(); await sleep(500);
    return { labels, framesAttr, autoHidden, hiddenState, shownState, open, poll, autoHiddenAgain, timerMs, hoverStay, stayAfterRearm, hiddenAfterRearm, persona, plugin, tree, back, left, re, reHidden };
  })()`);
  ok(fx && !fx.err, `工厂三页可进入（${fx?.err || 'ok'}）`);
  if (fx && !fx.err) {
    ok(fx.autoHidden && fx.hiddenState.body && fx.hiddenState.inert
      && fx.hiddenState.opacity === '0' && fx.hiddenState.transform !== 'none'
      && fx.hiddenState.visibility === 'hidden'
      && fx.hiddenState.hotPointer === 'auto' && Math.abs(fx.hiddenState.hotW - 150) <= 1
      && Math.abs(fx.hiddenState.hotTop - (fx.hiddenState.topbarBottom + 4)) <= 1,
    `进入工厂后导航自动上收（${JSON.stringify(fx.hiddenState)}）`);
    ok(!fx.shownState.body && !fx.shownState.inert
      && fx.shownState.visibility === 'visible' && Number(fx.shownState.opacity) >= 0.99,
    `热区呼出导航（${JSON.stringify(fx.shownState)}）`);
    ok(fx.labels.length === 5 && fx.labels.join('|') === '视觉工厂|人设工厂|插件工厂|插件管理|Skill'
      && fx.framesAttr.filter(Boolean).join('|') === 'visual-factory.html|persona-factory.html|plugin-factory.html',
    `工厂二级栏 = 三 frame + 插件管理 / Skill（${JSON.stringify({ labels: fx.labels, frames: fx.framesAttr })}）`);
    ok(fx.open.bodyFrame && fx.open.dataFrame === 'visual-factory.html'
      && /page--frame/.test(fx.open.pageCls) && fx.open.pageText === 0 && fx.open.pageCards === 0
      && fx.open.hostVis === 'visible' && fx.open.hostAria === 'false'
      && fx.open.active === 'visual' && /visual-factory\.html/.test(fx.open.src) && fx.open.ready
      && fx.open.selected === '视觉工厂' && fx.open.navHidden === false && fx.open.navInert === false,
    `视觉工厂页 = 全幅 frame，host 已显示（${JSON.stringify(fx.open)}）`);
    ok(fx.open.btnIds.length === 0 && !fx.open.toggleAction,
      `顶栏三颗工厂圆钮与 factory.toggle 已删除（${JSON.stringify({ ids: fx.open.btnIds, toggle: fx.open.toggleAction })}）`);
    ok(Math.abs(fx.open.top - fx.open.topbarBottom) <= 1
      && Math.abs(fx.open.bottom - fx.open.innerH) <= 20
      && Math.abs(fx.open.w - fx.open.innerW) <= 20 && fx.open.h > 100
      && fx.open.hostZ < fx.open.navZ && fx.open.navZ < fx.open.topbarZ && fx.open.gearZ > fx.open.hostZ,
    `工厂铺满顶栏以下、导航浮在工厂之上（${JSON.stringify({ top: fx.open.top, h: fx.open.h, z: [fx.open.hostZ, fx.open.navZ, fx.open.topbarZ, fx.open.gearZ] })}）`);
    ok(fx.open.hitSubOk && fx.open.hitIframe,
      `二级按钮真的可点、导航条空白处让给工厂（hitSub=${fx.open.hitSubOk} · hitIframe=${fx.open.hitIframe}）`);
    ok(fx.open.brandDisplay !== 'none' && /Estrella Glass Lab/.test(fx.open.brandText) && fx.open.embed === '',
      `工厂独立品牌可见、不设 embed（${JSON.stringify({ brand: fx.open.brandText, embed: fx.open.embed })}）`);
    ok(fx.poll.same && fx.poll.loads === fx.open.loads && fx.poll.enterCount === fx.open.enterCount
      && fx.poll.navHidden === false,
      `3.6s 轮询后同一 iframe 未重载、入场未重播、导航未误收（same=${fx.poll.same} · loads=${fx.open.loads}→${fx.poll.loads} · enter=${fx.open.enterCount}→${fx.poll.enterCount}）`);
    ok(fx.hoverStay === true, '鼠标停在导航一级/二级上超过 2.5s 不收回（离开才开始计时）');
    ok(fx.stayAfterRearm === true, '普通页切回 frame 页重新武装时，鼠标在二级栏上不收回');
    ok(fx.hiddenAfterRearm === true, '离开二级栏后仍会按 2.5s 收回');
    ok(fx.autoHiddenAgain && fx.timerMs >= 2300 && fx.timerMs <= 3100,
      `离开导航 2.5s 后自动收回（${fx.timerMs}ms）`);
    ok(fx.persona.open && !fx.persona.personaHidden && fx.persona.visualHidden
      && /persona-factory\.html/.test(fx.persona.src) && fx.persona.header
      && fx.persona.visualLoads === fx.open.loads,
    `视觉 → 人设只切帧不重载（${JSON.stringify(fx.persona)}）`);
    ok(fx.plugin.open && !fx.plugin.pluginHidden && fx.plugin.personaHidden
      && /plugin-factory\.html/.test(fx.plugin.src) && fx.plugin.app
      && fx.plugin.personaLoads === fx.persona.personaLoads,
    `人设 → 插件只切帧不重载（${JSON.stringify(fx.plugin)}）`);
    ok(fx.tree.cats.includes('工具') && fx.tree.cats.includes('数据') && fx.tree.cats.includes('other')
      && fx.tree.labels.includes('其他'),
    `插件工厂分类树来自清单 category（${JSON.stringify(fx.tree.cats)} / ${JSON.stringify(fx.tree.labels)}）`);
    ok(/选择文件夹/.test(fx.tree.folderText) && !/不支持/.test(fx.tree.folderText),
      `文件夹导入不再写死不支持（${JSON.stringify(fx.tree.folderText)}）`);
    ok(fx.tree.createOpen && fx.tree.createFields >= 7,
      `创造插件弹窗能打开且有完整字段（open=${fx.tree.createOpen} · fields=${fx.tree.createFields}）`);
    ok(fx.back.active === 'visual' && fx.back.sameFrame && !fx.back.visualHidden
      && fx.back.loads === fx.open.loads && fx.back.keep === 1,
    `插件 → 视觉回到原帧、状态保留（${JSON.stringify(fx.back)}）`);
    ok(!fx.left.bodyFrame && !fx.left.dataFrame && !/page--frame/.test(fx.left.pageCls)
      && fx.left.hostVis === 'hidden' && fx.left.hostAria === 'true' && !fx.left.ready
      && !fx.left.navHidden && !fx.left.navInert && fx.left.navVis === 'visible',
    `离开工厂域后工厂层收起、页面类与导航复位（${JSON.stringify(fx.left)}）`);
    ok(fx.re.active === 'visual' && fx.re.open && fx.re.ready && fx.re.hostVis === 'visible'
      && fx.re.same && fx.re.loads === fx.open.loads && fx.re.keep === 1
      && fx.reHidden && !fx.re.navHidden && !fx.re.navInert,
    `重进工厂落视觉工厂、同一 iframe 不重载，且再次上收后可呼出（${JSON.stringify({ re: fx.re, reHidden: fx.reHidden })}）`);
  }

  /* ── 插件设置中文名（2026-10-28）──────────────────────────────────────
     前端早就是 f.label || f.key；后端把 configSchema.label 透传之后，
     qa01 的设置区必须真的出现「模式」，而不是原始键名 mode。 */
  console.log('\n── 插件设置中文名 ──');
  const labelUi = await evalJs(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    if (document.body.classList.contains('nav-auto-hidden') && window.__navAutoHide) {
      window.__navAutoHide.reveal();
      await sleep(420);
    }
    const groups = () => [...document.querySelectorAll('#nav1 .grp')];
    const subs = () => [...document.querySelectorAll('#nav2 .sub')];
    const grp = groups().find((b) => (b.title || b.textContent || '').includes('工厂'));
    if (!grp) return { error: '找不到工厂域' };
    grp.click();
    await sleep(600);
    const sub = subs().find((b) => (b.title || b.textContent || '').includes('插件管理'));
    if (!sub) return { error: '找不到插件管理页' };
    sub.click();
    await sleep(1400);
    const page = document.getElementById('page');
    const text = page ? page.textContent || '' : '';
    return {
      hasLabel: text.includes('模式'),
      hasCard: !!page.querySelector('[data-plugin="qa01"]'),
      setting: !!page.querySelector('[data-p="plugin|qa01|mode"]'),
    };
  })()`);
  ok(labelUi && !labelUi.error && labelUi.hasCard && labelUi.setting && labelUi.hasLabel,
    `扩展设置项显示中文名（${JSON.stringify(labelUi)}）`);

  /* ── 人设域六页 + MBTI 四轴滑块（2026-10-25）──────────────────────────
     回复设置页已按维护者决定移出六页 IA（后续重做），所以这里不再钉 `.tkx`。
     改钉两件**改坏了不会报错**的事：
       ① 六个二级页真的都在、旧的「回复设置」不再出现；
       ② 拖 MBTI 滑块时，液面 / 读数 / 类型水印 / 注入片段必须**同帧跟着变**。
     第二条尤其要真拖：只检查"滑块存在"抓不到"拖了没反应"。 */
  console.log('\n── 人设域六页与 MBTI 滑块 ──');
  const psn = await evalJs(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const groups = [...document.querySelectorAll('#nav1 .grp')];
    const gi = groups.findIndex((g) => (g.textContent || '').includes('人格'));
    if (gi < 0) return { err: '找不到「人格」功能域' };
    groups[gi].click(); await sleep(150);
    const subs = [...document.querySelectorAll('#nav2 .sub')];
    const labels = subs.map((s) => (s.title || s.textContent || '').trim());
    const mbtiAt = subs.findIndex((s) => /MBTI/.test(s.title || s.textContent || ''));
    if (mbtiAt < 0) return { err: '找不到 MBTI 子页', labels };
    subs[mbtiAt].click(); await sleep(220);
    const rows = [...document.querySelectorAll('.psn [data-axis-row]')];
    const ei = document.querySelector('.psn [data-axis-row="EI"]');
    if (!ei) return { err: 'MBTI 页没有四轴滑块', labels, rows: rows.length };
    const range = ei.querySelector('[data-psn-axis]');
    const fill = ei.querySelector('.axis-fill');
    const knob = ei.querySelector('.axis-knob');
    if (!range || !fill || !knob) return { err: '滑块缺少轨道/液面/把手', labels, rows: rows.length };
    const before = {
      type: document.querySelector('.psn [data-psn-type-code2]')?.textContent || '',
      snippet: document.querySelector('.psn [data-psn-mbti-snippet]')?.textContent || '',
      head: ei.querySelector('.axis-head')?.textContent || '',
      fill: fill.style.width,
      knob: knob.style.left,
    };
    range.value = '20';
    range.dispatchEvent(new Event('input', { bubbles: true }));
    const reduced = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    /* 弹簧第一帧在慢机上可能晚于固定 40ms（2026-10-27 全链复跑实测读到 62%→62%）：
       改成等第一次变化（上限 240ms）；判据仍是"中途帧既不等于起点也不等于终点"。 */
    let mid = fill.style.width;
    if (!reduced) {
      for (let i = 0; i < 12; i++) {
        await sleep(20);
        mid = fill.style.width;
        if (mid !== before.fill) break;
      }
    } else {
      await sleep(40);
    }
    /* 弹簧落位按**帧**推进（Motion 的 dt 上限 40ms），慢机上 900ms 墙钟可能只走到一半
       （2026-10-28 实测读到 16.5% 就已读表，判据假红）。改成条件等待：连续两次读数
       相同即视为落位，上限 2.5s —— 判据（终值 near20 且中途帧不同）一个字没放宽。 */
    const settled = async (read, ms) => {
      const t0 = performance.now();
      let last = read();
      while (performance.now() - t0 < ms) {
        await sleep(80);
        const now = read();
        if (now === last) return now;
        last = now;
      }
      return last;
    };
    await settled(() => fill.style.width, 2500);
    const after = {
      type: document.querySelector('.psn [data-psn-type-code2]')?.textContent || '',
      snippet: document.querySelector('.psn [data-psn-mbti-snippet]')?.textContent || '',
      head: ei.querySelector('.axis-head')?.textContent || '',
      fill: fill.style.width,
      knob: knob.style.left,
      mid,
      reduced,
      dirty: [...window.__next.dirty],
    };
    /* 点一个和当前不同的类型：四轴与头图必须一起换。
       ⚠️ 点完必须**重新查一遍**按钮：paintPage 会重建 DOM，旧数组里的节点已经脱离文档，
         在旧节点上读 aria-pressed 永远读到点击前的值（这条本轮实测踩过）。 */
    const cells = [...document.querySelectorAll('.psn [data-a="psn.type"]')];
    const other = cells.find((c) => c.getAttribute('aria-pressed') !== 'true' && c.dataset.p === 'ENFP') || cells[0];
    other.click(); await sleep(160);
    const typeAfter = document.querySelector('.psn [data-psn-type-code2]')?.textContent || '';
    const pressed = [...document.querySelectorAll('.psn [data-a="psn.type"][aria-pressed="true"]')].map((c) => c.dataset.p);
    const dis = document.querySelector('[data-a="draft-discard"]');
    if (dis) dis.click();
    return { labels, rows: rows.length, before, after, typeAfter, pressed, want: other?.dataset.p || '' };
  })()`);
  ok(psn && !psn.err, `人设域六页可进入（${psn?.err || (psn?.labels || []).join(' / ')}）`);
  if (psn && !psn.err) {
    ok(psn.labels.length === 6
      && ['总览', '人设', 'MBTI', '增强项', '心情值', '系统提示词'].every((t) => psn.labels.some((l) => l.includes(t)))
      && !psn.labels.some((l) => l.includes('回复设置')),
    `六页 IA 与顺序正确、回复设置已移出（${psn.labels.join(' / ')}）`);
    ok(psn.rows === 4, `MBTI 四轴滑块都在（实得 ${psn.rows}）`);
    const near20 = (s) => Math.abs(parseFloat(s) - 20) < 0.6;
    ok(near20(psn.after.fill) && near20(psn.after.knob) && /E 外向 80%/.test(psn.after.head)
      && (psn.after.reduced || (psn.after.mid !== psn.before.fill && psn.after.mid !== psn.after.fill)),
      `拖轴时液面 / 把手 / 读数跟手且带弹簧（${psn.before.fill} → ${psn.after.mid} → ${psn.after.fill} · ${psn.after.head.trim()}）`);
    ok(psn.after.type !== psn.before.type && /未注入|已注入/.test(psn.after.snippet),
      `拖轴会实时换类型与注入片段（${psn.before.type} → ${psn.after.type}）`);
    ok(psn.after.dirty.some((k) => k === 'c:mbti.axes.EI'),
      `拖轴写进草稿（dirty=${psn.after.dirty.join(',') || '空'}）`);
    ok(psn.typeAfter === psn.want && psn.pressed.length === 1 && psn.pressed[0] === psn.want,
      `点类型按钮对齐四轴并只选中一颗（${psn.typeAfter} / pressed=${psn.pressed.join(',')}）`);
  }

  /* ── MBTI 场景卡 / 规则编辑 / 心情页不再挂插件设置（2026-10-25）────────
     这三件事都是"页面看着正常、实际缺了一块"的形状：
     场景卡被删掉只剩文字、规则解锁按钮点了没反应、心情页又把插件设置塞回来。 */
  console.log('\n── MBTI 场景卡 / 规则编辑 / 心情页去插件化 ──');
  const psnExtra = await evalJs(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const subs = () => [...document.querySelectorAll('#nav2 .sub')];
    const go = async (re) => {
      const i = subs().findIndex((s) => re.test(s.title || s.textContent || ''));
      if (i < 0) return false;
      subs()[i].click(); await sleep(220); return true;
    };
    await go(/MBTI/);
    const art = document.querySelector('.psn .mbti-art');
    const scene = !!document.querySelector('.psn .mbti-art .psn-art-svg');
    const img = document.querySelector('.psn .mbti-art-img');
    const imgOk = !!(img && img.complete && img.naturalWidth > 0);
    const tag = (document.querySelector('.psn .mbti-art-tag') || {}).textContent || '';
    const tag2 = (document.querySelector('.psn [data-psn-type-tag2]') || {}).textContent || '';
    const traits = document.querySelectorAll('.psn [data-psn-type-traits2] .chip').length;
    if (art) art.click();
    await sleep(140);
    const modal = !document.getElementById('psnArtModal')?.hidden && !!document.querySelector('#psnArtModal .psn-art-img');
    const close = document.querySelector('#psnArtModal [data-a="psn.art.close"]');
    if (close) close.click();
    await sleep(80);

    await go(/增强项/);
    const unlock = document.querySelector('.psn [data-a="psn.rules.unlock"]');
    const before = document.querySelectorAll('.psn [data-psn-rule-index]').length;
    if (unlock) unlock.click();
    await sleep(180);
    const rowsEdit = document.querySelectorAll('.psn [data-psn-rule-index]').length;
    const add = document.querySelector('.psn [data-a="psn.rules.add"]');
    if (add) add.click();
    await sleep(180);
    const afterAdd = document.querySelectorAll('.psn [data-psn-rule-index]').length;
    const dels = [...document.querySelectorAll('.psn [data-a="psn.rules.del"]')];
    const del = dels[dels.length - 1];
    if (del) del.click();
    await sleep(180);
    const afterDel = document.querySelectorAll('.psn [data-psn-rule-index]').length;
    const reset = document.querySelector('.psn [data-a="psn.rules.reset"]');
    if (reset) reset.click();
    await sleep(180);
    const afterReset = document.querySelectorAll('.psn [data-psn-rule-index]').length;
    const lock = document.querySelector('.psn [data-a="psn.rules.lock"]');
    if (lock) lock.click();
    await sleep(120);
    const dis = document.querySelector('[data-a="draft-discard"]');
    if (dis) dis.click();

    await go(/心情值/);
    const pageText = (document.getElementById('page') || {}).textContent || '';
    return {
      art: !!art, scene, imgOk, tag, tag2, traits, modal,
      before, rowsEdit, afterAdd, afterDel, afterReset,
      pluginCard: /插件设置/.test(pageText),
      builtin: /项目内建|不需要安装任何插件/.test(pageText),
    };
  })()`);
  ok(psnExtra && psnExtra.art && psnExtra.scene && psnExtra.imgOk && /·/.test(psnExtra.tag || '')
    && (psnExtra.tag2 || '').length > 2 && psnExtra.traits > 0 && psnExtra.modal,
  `MBTI 场景卡 / 官方图 / 看大图弹窗都在（${psnExtra?.tag} · 图=${psnExtra?.imgOk} · 特质=${psnExtra?.traits} · modal=${psnExtra?.modal}）`);
  ok(psnExtra && psnExtra.before === 0 && psnExtra.rowsEdit === 10
    && psnExtra.afterAdd === 11 && psnExtra.afterDel === 10 && psnExtra.afterReset === 10,
  `扮演规则可解锁 / 加一条 / 删一条 / 恢复默认 10 条（${psnExtra?.before}→${psnExtra?.rowsEdit}→${psnExtra?.afterAdd}→${psnExtra?.afterDel}→${psnExtra?.afterReset}）`);
  ok(psnExtra && psnExtra.pluginCard === false && psnExtra.builtin === true,
  `心情页不再渲染插件设置，并明确写「项目内建 / 不需要安装插件」（插件卡=${psnExtra?.pluginCard} · 内建=${psnExtra?.builtin}）`);

  /* ── 页眉 / 字段帮助 / 图表交互 / 轮询稳定 / 其他域隔离（2026-10-26）── */
  console.log('\n── 人设页眉 / 帮助 / 图表交互 / 轮询稳定 ──');
  const psnParity = await evalJs(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const subs = () => [...document.querySelectorAll('#nav2 .sub')];
    const go = async (re) => {
      const i = subs().findIndex((s) => re.test(s.title || s.textContent || ''));
      if (i < 0) return false;
      subs()[i].click(); await sleep(300); return true;
    };
    await go(/MBTI/);
    const head = document.querySelector('.psn .page-head');
    const badge = document.querySelector('.psn .page-head .layer-badge');
    const eyebrow = (document.querySelector('.psn .page-head .eyebrow') || {}).textContent || '';
    const wrap = document.querySelector('#page > .wrap-head');
    const wrapHidden = !!wrap && getComputedStyle(wrap).display === 'none';
    const navLabels = subs().map((x) => (x.textContent || '').trim());
    const typeChip = (document.querySelector('.psn [data-psn-type-chip]') || {}).textContent || '';
    const mbtiPsn = document.querySelector('.psn');
    const pageLc = mbtiPsn ? getComputedStyle(mbtiPsn).getPropertyValue('--page-lc').trim() : '';
    const badgeBg = badge ? getComputedStyle(badge).backgroundColor : '';

    await go(/人设/);
    const helps = [...document.querySelectorAll('.psn [data-help-tip]')];
    if (helps[0]) helps[0].click();
    await sleep(120);
    const helpOn = !document.getElementById('psnHelpTip')?.hidden;
    const helpText = (document.getElementById('psnHelpTip') || {}).textContent || '';
    document.body.click();
    await sleep(80);
    const helpOff = !!document.getElementById('psnHelpTip')?.hidden;

    await go(/总览/);
    await sleep(220);
    const sector = document.querySelector('.psn .radar-sector');
    const sr = sector?.getBoundingClientRect();
    if (sector && sr) sector.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, clientX: sr.left + sr.width / 2, clientY: sr.top + sr.height / 2 }));
    await sleep(100);
    const radarTip = !document.getElementById('psnChartTip')?.hidden && /热情|主动|感性|稳定|表达/.test(document.getElementById('psnChartTip')?.textContent || '');
    if (sector) sector.dispatchEvent(new PointerEvent('pointerout', { bubbles: true }));
    await sleep(80);
    const radarTipOff = !!document.getElementById('psnChartTip')?.hidden;

    const hit = document.querySelector('.psn .donut-hit');
    const hr = hit?.getBoundingClientRect();
    if (hit && hr) hit.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, clientX: hr.left + hr.width / 2, clientY: hr.top + hr.height / 2 }));
    await sleep(120);
    const donutLabel = (document.querySelector('.psn .donut-center-label') || {}).textContent || '';
    if (hit) hit.dispatchEvent(new PointerEvent('pointerout', { bubbles: true }));
    await sleep(120);
    const donutBack = (document.querySelector('.psn .donut-center-label') || {}).textContent || '';

    const zone = document.querySelector('.psn .line-hover-zone');
    const zr = zone?.getBoundingClientRect();
    if (zone && zr) zone.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: zr.left + zr.width * 0.55, clientY: zr.top + zr.height / 2 }));
    await sleep(160);
    const crossOn = !!document.querySelector('.psn .line-cross.is-on');
    const lineTip = !document.getElementById('psnChartTip')?.hidden;
    if (zone) zone.dispatchEvent(new PointerEvent('pointerout', { bubbles: true }));
    await sleep(100);
    const crossOff = !document.querySelector('.psn .line-cross.is-on');

    const pri = document.querySelector('.psn .priority-card');
    if (pri) pri.scrollIntoView({ block: 'center' });
    await sleep(380);
    const priIn = !!document.querySelector('.psn .priority-card.is-in');

    const firstCard = document.querySelector('.psn .layer-card');
    await sleep(3400);
    const sameCard = !!firstCard && firstCard.isConnected && document.querySelector('.psn .layer-card') === firstCard;

    const groups = [...document.querySelectorAll('#nav1 .grp')];
    const run = groups.find((g) => (g.textContent || '').includes('运行'));
    if (run) run.click();
    await sleep(300);
    const runWrap = document.querySelector('#page > .wrap-head');
    const runWrapShown = !!runWrap && getComputedStyle(runWrap).display !== 'none';
    const noPsnHead = !document.querySelector('.psn .page-head');
    const overlaysOff = !!document.getElementById('psnHelpTip')?.hidden && !!document.getElementById('psnChartTip')?.hidden;
    return {
      head: !!head, badge: (badge || {}).textContent || '', eyebrow, wrapHidden, navLabels, typeChip,
      pageLc, badgeBg,
      helps: helps.length, helpOn, helpText, helpOff,
      radarTip, radarTipOff, donutLabel, donutBack, crossOn, lineTip, crossOff, priIn, sameCard,
      runWrapShown, noPsnHead, overlaysOff,
    };
  })()`);
  ok(psnParity && psnParity.head && psnParity.badge === '②' && /人格\s*\/\s*辅助层/.test(psnParity.eyebrow)
    && psnParity.wrapHidden && psnParity.typeChip === 'infj'.toUpperCase()
    && ['增强项', '心情值', '系统提示词'].every((x) => psnParity.navLabels.includes(x)),
  `页眉 1:1 + 全称二级导航（badge=${psnParity?.badge} · eyebrow=${psnParity?.eyebrow} · wrap 隐藏=${psnParity?.wrapHidden} · nav=${(psnParity?.navLabels || []).join('/')}）`);
  ok(psnParity && psnParity.helps > 0 && psnParity.helpOn && /顶层 personaName|他怎么想|决策/.test(psnParity.helpText || '') && psnParity.helpOff,
  `字段帮助 ? 可开可关（按钮 ${psnParity?.helps} 个 · 开=${psnParity?.helpOn} · 关=${psnParity?.helpOff}）`);
  ok(psnParity && psnParity.radarTip && psnParity.radarTipOff && psnParity.donutLabel !== '四层合计'
    && psnParity.donutBack === '四层合计' && psnParity.crossOn && psnParity.lineTip && psnParity.crossOff,
  `图表交互：雷达 tip=${psnParity?.radarTip}/${psnParity?.radarTipOff} · 环形=${psnParity?.donutLabel}→${psnParity?.donutBack} · 十字线=${psnParity?.crossOn}/${psnParity?.crossOff} · tip=${psnParity?.lineTip}`);
  ok(psnParity && psnParity.priIn && psnParity.sameCard,
  `优先级揭示 + 3.4s 轮询不重建（is-in=${psnParity?.priIn} · 同节点=${psnParity?.sameCard}）`);
  ok(psnParity && psnParity.runWrapShown && psnParity.noPsnHead && psnParity.overlaysOff,
  `其他一级域隔离：运行页 wrap-head 在=${psnParity?.runWrapShown} · 无 persona head=${psnParity?.noPsnHead} · 浮层已收=${psnParity?.overlaysOff}`);
  ok(psnParity && psnParity.pageLc === '#6b5bd2',
  `页级主题色跟随子页（MBTI --page-lc=${psnParity?.pageLc} · badge bg=${psnParity?.badgeBg}）`);

  /* ── 原型卡片排版 / 左上色条 / 快捷入口 / 图表动效（2026-10-26）──────
     这一段盯的是"看起来像但没动"的三件事：内容被偷偷收窄、色条与快捷键只画了静态、
     图表动画只有容器淡入。全部用真渲染 + 真鼠标悬停量，不 grep 源码。
     ⚠️ 宽度判据必须固定 1440：Headless 偶尔会以 500×320 的窗口起来（实测一次，
        同一机器同一参数），那时 1352 判据会无故变红。 */
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await sleep(220);
  console.log('\n── 人设原型：宽度 / 卡片色条 / 快捷入口 / 图表动效 ──');
  const psnLayout = await evalJs(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const groups = [...document.querySelectorAll('#nav1 .grp')];
    const g = groups.find((x) => (x.textContent || '').includes('人格'));
    if (!g) return { err: '找不到人格域' };
    g.click(); await sleep(180);
    const subs = [...document.querySelectorAll('#nav2 .sub')];
    const s = subs.find((x) => (x.title || x.textContent || '').includes('总览'));
    if (!s) return { err: '找不到总览子页' };
    s.click(); await sleep(500);
    scrollTo(0, 0); await sleep(260);
    /* 量几何前先等入场动画跑完：柱顶数字的 psn-chart-fade 自带 5px 位移，
       动画中途量出来的柱顶间距会偏小（2026-10-28 负载下实测 5.45 vs 落位后的 8）。
       条件等待（上限 2.5s、跳过 infinite 的折线脉冲），不放大固定 sleep。 */
    await new Promise((resolve) => {
      const t0 = performance.now();
      const tick = () => {
        const busy = document.getAnimations().some((a) => {
          if (!/^psn-/.test(a.animationName || '') || a.playState !== 'running') return false;
          const it = a.effect && a.effect.getTiming().iterations;
          return it !== Infinity;
        });
        if (!busy || performance.now() - t0 > 2500) resolve();
        else setTimeout(tick, 50);
      };
      tick();
    });
    const psn = document.querySelector('.psn[data-psn-page="overview"]');
    const card = document.querySelector('.psn .layer-card');
    const foot = card?.querySelector('.layer-foot .linklike');
    if (!psn || !card || !foot) return { err: '缺少 .psn/.layer-card/.linklike' };
    const bar = getComputedStyle(card, '::before');
    const fs = getComputedStyle(foot);
    const anim = (sel) => { const el = document.querySelector(sel); return el ? getComputedStyle(el).animationName : ''; };
    const rr = (el) => { const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; };
    const cyl = document.querySelector('.psn .cyl');
    const cylVal = document.querySelector('.psn .cyl-val');
    const cylTrack = document.querySelector('.psn .cyl-track');
    const cylStyle = cyl ? getComputedStyle(cyl) : null;
    const cylCap = cyl ? getComputedStyle(cyl, '::before') : null;
    const valRect = cylVal?.getBoundingClientRect();
    const trackRect = cylTrack?.getBoundingClientRect();
    const cylValDx = valRect && trackRect
      ? (valRect.x + valRect.width / 2) - (trackRect.x + trackRect.width / 2) : null;
    const cylValGap = valRect && trackRect ? trackRect.top - valRect.bottom : null;
    const priList = document.querySelector('.psn .priority-card .pri-list');
    return {
      psnW: psn.getBoundingClientRect().width, psnMax: getComputedStyle(psn).maxWidth,
      cardW: card.getBoundingClientRect().width, cardRect: rr(card), footRect: rr(foot),
      barW: bar.width, barH: bar.height, barBg: bar.backgroundColor,
      footH: foot.getBoundingClientRect().height, footMinH: fs.minHeight,
      footBorderLeft: fs.borderLeftWidth, footBg: fs.backgroundColor,
      orbit: !!document.querySelector('.psn .radar-orbit'),
      radarAnim: anim('.psn .radar-shape'), radarPointAnim: anim('.psn .radar-point'),
      cylAnim: anim('.psn .cyl'), lineAnim: anim('.psn .line-path'), linePointAnim: anim('.psn .line-point'),
      cylFlat: !!cylStyle && cylStyle.backgroundImage === 'none'
        && !String(cylStyle.boxShadow || '').includes('inset')
        && !!cylCap && cylCap.content === 'none',
      cylValDx, cylValGap,
      valTranslate: cylVal ? getComputedStyle(cylVal).translate : '',
      valBottom: cylVal ? getComputedStyle(cylVal).bottom : '',
      priJustify: priList ? getComputedStyle(priList).justifyContent : '',
    };
  })()`);
  ok(psnLayout && !psnLayout.err
    && psnLayout.psnMax === '1352px' && Math.abs(psnLayout.psnW - 1352) <= 1
    && Math.abs(psnLayout.cardW - 329) <= 1
    && psnLayout.barW === '40px' && psnLayout.barH === '3px' && psnLayout.barBg !== 'rgba(0, 0, 0, 0)'
    && Math.abs(psnLayout.footH - 30) <= 0.5 && psnLayout.footMinH === '30px'
    && psnLayout.footBorderLeft === '2px' && psnLayout.footBg !== 'rgba(0, 0, 0, 0)'
    && psnLayout.orbit
    && psnLayout.radarAnim === 'psn-radar-in' && psnLayout.radarPointAnim === 'psn-point-pop'
    && psnLayout.cylAnim === 'psn-bar-grow' && psnLayout.lineAnim === 'psn-line-draw'
    && psnLayout.linePointAnim === 'psn-point-pop'
    && psnLayout.cylFlat
    && Math.abs(psnLayout.cylValDx) <= 0.75
    && psnLayout.cylValGap >= 6 && psnLayout.cylValGap <= 12
    && psnLayout.priJustify === 'flex-start',
  `原型排版/色条/快捷入口/图表动效：宽 ${psnLayout?.psnW}（max ${psnLayout?.psnMax}）· 卡 ${psnLayout?.cardW} · 色条 ${psnLayout?.barW}×${psnLayout?.barH} · 入口 ${psnLayout?.footH}px/左边 ${psnLayout?.footBorderLeft} · radar=${psnLayout?.radarAnim}/${psnLayout?.radarPointAnim} · cyl=${psnLayout?.cylAnim} · line=${psnLayout?.lineAnim}/${psnLayout?.linePointAnim} · orbit=${psnLayout?.orbit} · 平面柱=${psnLayout?.cylFlat} · 数字居中=${psnLayout?.cylValDx}px/距柱顶 ${psnLayout?.cylValGap}px · translate=${psnLayout?.valTranslate} · 优先级=${psnLayout?.priJustify}${psnLayout?.err ? ' · ' + psnLayout.err : ''}`);

  if (psnLayout && !psnLayout.err) {
    await send('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: Math.round(psnLayout.cardRect.x + 30), y: Math.round(psnLayout.cardRect.y + 80), button: 'none', buttons: 0,
    });
    await sleep(460);
    const psnHover = await evalJs(`(() => {
      const card = document.querySelector('.psn .layer-card');
      const foot = card?.querySelector('.layer-foot .linklike');
      if (!card || !foot) return { err: 'missing' };
      return {
        barW: getComputedStyle(card, '::before').width,
        border: getComputedStyle(card).borderTopColor,
        footFill: getComputedStyle(foot, '::before').transform,
      };
    })()`);
    ok(psnHover && psnHover.barW === '96px' && psnHover.border !== 'rgb(216, 230, 238)',
      `悬停卡片：左上色条 40→${psnHover?.barW} · 边框变主题色 ${psnHover?.border}`);

    await send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: Math.round(psnLayout.footRect.x + psnLayout.footRect.w / 2),
      y: Math.round(psnLayout.footRect.y + psnLayout.footRect.h / 2),
      button: 'none', buttons: 0,
    });
    await sleep(420);
    const psnFootHover = await evalJs(`(() => {
      const foot = document.querySelector('.psn .layer-card .layer-foot .linklike');
      if (!foot) return { err: 'missing' };
      return { fill: getComputedStyle(foot, '::before').transform, self: getComputedStyle(foot).transform };
    })()`);
    ok(psnFootHover && /^matrix\(1,\s*0,\s*0,\s*1,\s*0,\s*0\)$/.test(psnFootHover.fill || '')
      && /^matrix\(1,\s*0,\s*0,\s*1,\s*0,\s*-1\)$/.test(psnFootHover.self || ''),
    `悬停快捷入口：中心填充 ${psnFootHover?.fill} · 抬升 ${psnFootHover?.self}`);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 8, y: 8, button: 'none', buttons: 0 });
    await sleep(120);
  }

  /* ── 人设页轮询稳定性（2026-10-26）──────────────────────────────────
     这一条盯的是真实踩到的 bug：psnField 的 input id 每次渲染都自增（PSN_UID），
     于是同一页每次生成的 HTML 都不同，3 秒轮询永远判"内容变了" → 整页 page-in
     每 3 秒重播；二级切换若撞上这一拍，就会看到"弹两次"。
     判据必须落在**有字段的页**（人设页 12 个 psnField）上：总览页没有字段，
     上一批的 3.4s 同节点断言因此漏掉了它。 */
  if (psnLayout && !psnLayout.err) {
    const psnIdle = await evalJs(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const page = document.getElementById('page');
      /* 前面的 MBTI 拖轴留下了草稿；softPaint 遇到脏草稿会直接 return，3 秒轮询
         便不会走到 paintPage —— 那会让"轮询稳定"测试变成假绿。先按真实用户路径丢弃。 */
      const savebar = document.getElementById('savebar');
      const discard = document.querySelector('#savebar [data-a="draft-discard"]');
      if (savebar && !savebar.hidden && discard) { discard.click(); await sleep(250); }
      const anims = [];
      const onAnim = (e) => { if (e.animationName === 'psn-page-in') anims.push(Math.round(performance.now())); };
      document.addEventListener('animationstart', onAnim, true);
      const subs = [...document.querySelectorAll('#nav2 .sub')];
      const s = subs.find((x) => (x.title || x.textContent || '').includes('人设'));
      if (!s) { document.removeEventListener('animationstart', onAnim, true); return { err: '找不到人设子页' }; }
      anims.length = 0;
      s.click();
      await sleep(1200);
      const psn1 = document.querySelector('.psn');
      const clickedAnims = anims.length;
      const enterName = psn1 ? getComputedStyle(psn1).animationName : '';
      const fields = document.querySelectorAll('.psn [data-id]').length;
      /* 字段卡紧凑化（2026-10-26）：同一页上真量 6 行的间距/边框/底色。
         之前全局 .row 的边框 + 末卡 space-between 把行距拉到 34px、行高 24px。 */
      const mapCard = [...document.querySelectorAll('.psn .card')]
        .find((c) => (c.querySelector('.card-title') || {}).textContent?.trim() === '字段怎么起作用');
      const mapList = mapCard?.querySelector('.mini-list');
      const mapRows = [...(mapList?.querySelectorAll('.row') || [])];
      const mapGaps = mapRows.slice(1).map((r, i) => r.getBoundingClientRect().top - mapRows[i].getBoundingClientRect().bottom);
      const rowCount = mapRows.length;
      const rowGapMax = mapGaps.length ? Math.max(...mapGaps) : -1;
      const rowBorders = mapRows.map((r) => getComputedStyle(r).borderTopWidth);
      const rowBgs = mapRows.map((r) => getComputedStyle(r).backgroundColor);
      const listJustify = mapList ? getComputedStyle(mapList).justifyContent : '';
      const listH = mapList ? mapList.getBoundingClientRect().height : 0;
      const cardH = mapCard ? mapCard.getBoundingClientRect().height : 0;
      const html1 = page.innerHTML;
      anims.length = 0;
      await sleep(3400);
      const psn2 = document.querySelector('.psn');
      const idleAnims = anims.length;
      const sameNode = !!psn1 && psn1 === psn2;
      const sameHtml = page.innerHTML === html1;
      /* 再强制一次"非切页但内容真的变了"的重画（改一个字段 → __nextRepaint）：
         这一拍必须不播整页入场。顺带丢弃草稿，别把脏数据留给后面的提示词测试。 */
      const input = document.querySelector('.psn input[data-id="p.name"]');
      let softAnims = -1, softName = '', noEnter = false, discardOk = false;
      if (input) {
        input.value = String(input.value || '') + 'x';
        input.dispatchEvent(new Event('change', { bubbles: true }));
        await sleep(180);
        anims.length = 0;
        window.__nextRepaint?.();
        await sleep(520);
        softAnims = anims.length;
        const psn3 = document.querySelector('.psn');
        softName = psn3 ? getComputedStyle(psn3).animationName : '';
        noEnter = page.classList.contains('psn-no-enter');
        const savebar2 = document.getElementById('savebar');
        const discard2 = document.querySelector('#savebar [data-a="draft-discard"]');
        if (savebar2 && !savebar2.hidden && discard2) { discard2.click(); discardOk = true; await sleep(220); }
      }
      document.removeEventListener('animationstart', onAnim, true);
      return {
        clickedAnims, idleAnims, fields, sameNode, sameHtml, enterName, softAnims, softName, noEnter, discardOk,
        rowCount, rowGapMax, rowBorders, rowBgs, listJustify, listH, cardH,
      };
    })()`);
    ok(psnIdle && !psnIdle.err && psnIdle.fields >= 10
      && psnIdle.clickedAnims === 1 && psnIdle.idleAnims === 0
      && psnIdle.sameNode && psnIdle.sameHtml
      && psnIdle.enterName === 'psn-page-in'
      && psnIdle.softAnims === 0 && psnIdle.softName === 'none' && psnIdle.noEnter && psnIdle.discardOk,
    `人设页轮询稳定：字段=${psnIdle?.fields} · 点击 page-in=${psnIdle?.clickedAnims} 次（${psnIdle?.enterName}） · 静置 3.4s 追加=${psnIdle?.idleAnims} 次 · 同节点=${psnIdle?.sameNode} · 同 HTML=${psnIdle?.sameHtml} · 强改重画不播入场=${psnIdle?.softAnims} 次/${psnIdle?.softName} · 已丢草稿=${psnIdle?.discardOk}${psnIdle?.err ? ' · ' + psnIdle.err : ''}`);
    ok(psnIdle && !psnIdle.err && psnIdle.rowCount === 6
      && psnIdle.rowGapMax >= 0 && psnIdle.rowGapMax <= 8
      && psnIdle.rowBorders.every((x) => x === '0px')
      && psnIdle.rowBgs.every((x) => x === 'rgba(0, 0, 0, 0)')
      && psnIdle.listJustify === 'flex-start'
      && psnIdle.listH > 0 && psnIdle.listH <= 200
      && psnIdle.cardH > 0 && psnIdle.cardH <= 320,
    `字段卡紧凑：${psnIdle?.rowCount} 行 · 最大行距=${psnIdle?.rowGapMax}px · 边框=${(psnIdle?.rowBorders || []).join('/')} · 底色=${(psnIdle?.rowBgs || []).join('/')} · justify=${psnIdle?.listJustify} · 列表=${psnIdle?.listH}px / 卡=${psnIdle?.cardH}px`);
  }

  /* ── 导航切换：同 group 的二级页只改选中态，不重建 nav1/nav2（2026-10-26）──
     旧版每次点二级都 renderNav1 + renderNav2 + 重启动 380ms dock 宽度动画；
     结构没变却白重建，是二级切换卡顿的主因。这里用 MutationObserver 盯 childList：
     二级 = 0/0，换域 = 两个都 >0。 */
  console.log('\n── 导航切换：二级不重建 nav1/nav2 ──');
  const navSwitch = await evalJs(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const nav1 = document.getElementById('navInner');
    const nav2 = document.getElementById('nav2');
    if (!nav1 || !nav2) return { err: '缺少 nav1/nav2' };
    const g0 = document.querySelector('#navInner .grp');
    const s0 = document.querySelector('#nav2 .sub');
    let c1 = 0, c2 = 0;
    const m1 = new MutationObserver((ms) => { c1 += ms.filter((m) => m.type === 'childList').length; });
    const m2 = new MutationObserver((ms) => { c2 += ms.filter((m) => m.type === 'childList').length; });
    m1.observe(nav1, { childList: true, subtree: false });
    m2.observe(nav2, { childList: true, subtree: false });
    const subs = [...document.querySelectorAll('#nav2 .sub')];
    const mbti = subs.find((x) => (x.title || x.textContent || '').trim() === 'MBTI');
    if (!mbti) return { err: '找不到 MBTI 子页' };
    mbti.click(); await sleep(500);
    const subCounts = { c1, c2 };
    const subSelected = (document.querySelector('#nav2 .sub[aria-selected="true"]') || {}).title || '';
    const subSameGrp = document.querySelector('#navInner .grp') === g0;
    const subSameSub = document.querySelector('#nav2 .sub') === s0;
    c1 = 0; c2 = 0;
    const groups = [...document.querySelectorAll('#nav1 .grp')];
    const run = groups.find((g) => (g.textContent || '').includes('运行'));
    if (!run) return { err: '找不到运行域' };
    run.click(); await sleep(500);
    const grpCounts = { c1, c2 };
    const grpSameGrp = document.querySelector('#navInner .grp') === g0;
    m1.disconnect(); m2.disconnect();
    const back = [...document.querySelectorAll('#nav1 .grp')].find((g) => (g.textContent || '').includes('人格'));
    if (back) { back.click(); await sleep(500); }
    /* 2026-10-28：滚动状态必须按「上一份 DOM 的归属」盖章；这里只验盖章确实跟着页走
       （真正的串味路径要两页在同路径上都有 .scroll-y/pre，面板里没有这种组合）。 */
    const X = window.__next;
    const keyVal = String(X.extra.paintKey) + ' / ' + X.gi + '/' + X.si;
    return { subCounts, subSelected, subSameGrp, subSameSub, grpCounts, grpSameGrp,
      keyOk: X.extra.paintKey === X.gi + '/' + X.si, keyVal };
  })()`);
  ok(navSwitch && !navSwitch.err
    && navSwitch.subCounts.c1 === 0 && navSwitch.subCounts.c2 === 0
    && navSwitch.subSelected === 'MBTI'
    && navSwitch.subSameGrp && navSwitch.subSameSub
    && navSwitch.grpCounts.c1 > 0 && navSwitch.grpCounts.c2 > 0
    && !navSwitch.grpSameGrp && navSwitch.keyOk,
  `导航切换：二级 nav1/nav2 重建=${navSwitch?.subCounts?.c1}/${navSwitch?.subCounts?.c2}（应 0/0，选中=${navSwitch?.subSelected}）· 换域 nav1/nav2 重建=${navSwitch?.grpCounts?.c1}/${navSwitch?.grpCounts?.c2}（应 >0）· 节点同=${navSwitch?.subSameGrp}/${navSwitch?.subSameSub} · 页面盖章=${navSwitch?.keyVal}${navSwitch?.err ? ' · ' + navSwitch.err : ''}`);

  /* ── 分段渲染：壳先图后（2026-10-28）──────────────────────────────────
     维护者反馈「从运行/发言切到人设，一级栏与二级栏明显卡顿」。成因实测：
     页面提交落在 dock 380ms 动画的前 ~38ms，53 条 psn-* 入场里有 15 条与导航同窗起播。
     修法是把导航与内容切成两条时间线：壳（卡框/文案/图例）双 rAF 后落，
     图表体与全部入场动画等 dock 停稳后一起起跑。
     这里断言的是**顺序与结构**（不量墙钟）：壳够完整、槽位是空的、放行严格晚于
     dock 最后一次宽度写入、放行前没有任何 psn-* 动画起播。 */
  console.log('\n── 分段渲染：壳先图后 ──');
  const stagedShell = await evalJs(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const page = document.getElementById('page');
    const wrap = document.getElementById('nav2wrap');
    const groups = () => [...document.querySelectorAll('#nav1 .grp')];
    const byLabel = (t) => groups().find((b) => String(b.title || b.textContent || '').includes(t));
    if (!byLabel('运行') || !(byLabel('人格') || byLabel('人设'))) return { err: '找不到运行/人格一级按钮' };
    byLabel('运行').click();
    await sleep(700);
    const dockMarks = [];
    const moDock = new MutationObserver(() => dockMarks.push(performance.now()));
    moDock.observe(wrap, { attributes: true, attributeFilter: ['style'] });
    const animT = [];
    const onAnim = (e) => { if (/^psn-/.test(e.animationName)) animT.push(performance.now()); };
    document.addEventListener('animationstart', onAnim, true);
    const btn = byLabel('人格') || byLabel('人设');
    if (!btn || !btn.isConnected) {
      moDock.disconnect(); document.removeEventListener('animationstart', onAnim, true);
      return { err: '人格按钮在运行域重建后不可用' };
    }
    const t0 = performance.now();
    btn.click();
    let shell = null;
    for (let i = 0; i < 120; i++) {
      await sleep(16);
      if (!page.querySelector('.psn[data-psn-page="overview"]')) continue;
      shell = {
        t: performance.now(),
        cards: page.querySelectorAll('.card').length,
        textLen: (page.textContent || '').length,
        slots: page.querySelectorAll('[data-psn-slot]').length,
        emptySlots: [...page.querySelectorAll('[data-psn-slot]')].filter((x) => !x.firstElementChild && !x.textContent).length,
        staged: page.classList.contains('psn-stage'),
        h: Math.round(page.getBoundingClientRect().height * 10) / 10,
        rects: [...page.querySelectorAll('.card')].slice(0, 3).map((c) => Math.round(c.getBoundingClientRect().height * 10) / 10),
      };
      break;
    }
    let armT = 0;
    for (let i = 0; i < 200; i++) {
      if (page.classList.contains('psn-armed')) { armT = performance.now(); break; }
      await sleep(16);
    }
    /* animationstart 是在**下一帧**才派发的：刚看到 psn-armed 就撤监听，
       这批事件会落进下一段的监听窗口里（实测被误记成"轮询重播 25 条"）。
       这里多等两帧，把放行那一批事件收干净。 */
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    await sleep(60);
    moDock.disconnect();
    document.removeEventListener('animationstart', onAnim, true);
    const dockLast = dockMarks.length ? dockMarks[dockMarks.length - 1] : 0;
    return {
      shell, armT, clickT: t0, dockLast,
      armAfterDock: armT > 0 && dockLast > 0 && armT >= dockLast,
      animBeforeDock: dockLast ? animT.filter((t) => t < dockLast).length : -1,
      animTotal: animT.length,
    };
  })()`);
  ok(stagedShell && !stagedShell.err
    && stagedShell.shell && stagedShell.shell.cards === 10 && stagedShell.shell.textLen > 400
    && stagedShell.shell.slots === 4 && stagedShell.shell.emptySlots === 4 && stagedShell.shell.staged
    && stagedShell.armT > 0 && stagedShell.armAfterDock && stagedShell.animBeforeDock === 0,
  `分段渲染：壳先图后（壳 ${stagedShell?.shell?.cards} 卡/${stagedShell?.shell?.textLen} 字 · 空槽 ${stagedShell?.shell?.emptySlots}/${stagedShell?.shell?.slots} · 闸门=${stagedShell?.shell?.staged} · 壳 ${Math.round((stagedShell?.shell?.t || 0) - (stagedShell?.clickT || 0))}ms · 放行 ${Math.round((stagedShell?.armT || 0) - (stagedShell?.clickT || 0))}ms · dock 停稳 ${Math.round((stagedShell?.dockLast || 0) - (stagedShell?.clickT || 0))}ms · 停稳后放行=${stagedShell?.armAfterDock} · 停稳前入场动画=${stagedShell?.animBeforeDock}/${stagedShell?.animTotal}）${stagedShell?.err ? ' · ' + stagedShell.err : ''}`);

  /* ── 分段渲染：真落图与零位移（2026-10-28）────────────────────────────
     第二段盯两件事：① 图真的落进去了（不是永远空着）；② 壳与落图后**逐像素同高**
     —— 用 viewBox 比例给空壳预留高度，任何一处留空没预留都会在这里差出来。
     顺带钉住「3 秒轮询不会把落好的图重排/重播」（人设页 skip-redraw 的老判据）。 */
  console.log('\n── 分段渲染：真落图与零位移 ──');
  const stagedFill = await evalJs(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const page = document.getElementById('page');
    let filled = 0;
    for (let i = 0; i < 150; i++) {
      filled = [...page.querySelectorAll('[data-psn-slot]')].filter((x) => x.firstElementChild || x.textContent).length;
      if (filled >= 4) break;
      await sleep(16);
    }
    const radar = !!page.querySelector('.psn [data-psn-slot="radar"] .radar-orbit');
    const shape = !!page.querySelector('.psn [data-psn-slot="radar"] .radar-shape');
    const cyls = page.querySelectorAll('.psn [data-psn-slot="cyl"] .cyl').length;
    const linePath = page.querySelector('.psn [data-psn-slot="line"] .line-path');
    const donut = !!page.querySelector('.psn [data-psn-slot="donut"] .donut-track');
    const h = Math.round(page.getBoundingClientRect().height * 10) / 10;
    const rects = [...page.querySelectorAll('.card')].slice(0, 3).map((c) => Math.round(c.getBoundingClientRect().height * 10) / 10);
    const anims = [];
    const onAnim = (e) => { if (/^psn-/.test(e.animationName)) anims.push(e.animationName); };
    /* 放行后的入场是错开的（柱 .18s / 点 .34s / 图例 .55s…，最长 ≈1.4s）。
       先等这批跑完再装监听，否则会把"入场尾巴"误记成"轮询重播"。
       条件等待（跳过 infinite 的折线脉冲），上限 3s。 */
    await new Promise((resolve) => {
      const t0 = performance.now();
      const tick = () => {
        const busy = document.getAnimations().some((a) => {
          if (!/^psn-/.test(a.animationName || '') || a.playState !== 'running') return false;
          const it = a.effect && a.effect.getTiming().iterations;
          return it !== Infinity;
        });
        if (!busy || performance.now() - t0 > 3000) resolve();
        else setTimeout(tick, 50);
      };
      tick();
    });
    /* 再空转两帧：上一批 animationstart 可能还在队列里。 */
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    await sleep(80);
    document.addEventListener('animationstart', onAnim, true);
    let kids = 0;
    const mo = new MutationObserver((ms) => { kids += ms.filter((m) => m.type === 'childList').length; });
    mo.observe(page, { childList: true, subtree: false });
    const clsBefore = page.className;
    const htmlBefore = page.innerHTML;
    window.__nextRepaint();
    await sleep(420);
    mo.disconnect();
    document.removeEventListener('animationstart', onAnim, true);
    return { filled, radar, shape, cyls, lineD: linePath ? linePath.getAttribute('d') : '', donut, h, rects,
      repaintAnims: anims.length, repaintNames: [...new Set(anims)].slice(0, 8),
      repaintKids: kids, htmlSame: page.innerHTML === htmlBefore,
      clsBefore, clsAfter: page.className, armed: page.classList.contains('psn-armed') };
  })()`);
  const shellH = stagedShell?.shell?.h;
  const shellRects = stagedShell?.shell?.rects || [];
  ok(stagedFill && stagedFill.filled === 4 && stagedFill.radar && stagedFill.shape
    && stagedFill.cyls === 3 && String(stagedFill.lineD || '').length > 10 && stagedFill.donut
    && stagedFill.armed
    && Number.isFinite(shellH) && Math.abs(stagedFill.h - shellH) < 0.5
    && shellRects.length === 3 && stagedFill.rects.every((v, i) => Math.abs(v - shellRects[i]) < 0.5)
    && stagedFill.repaintAnims === 0 && stagedFill.repaintKids === 0,
  `分段渲染：真落图与零位移（槽 ${stagedFill?.filled}/4 · 雷达 ${stagedFill?.radar}/${stagedFill?.shape} · 柱 ${stagedFill?.cyls} · 折线 ${String(stagedFill?.lineD || '').length} · 环形 ${stagedFill?.donut} · 页高 ${shellH}→${stagedFill?.h} · 卡高 ${JSON.stringify(shellRects)}→${JSON.stringify(stagedFill?.rects)} · 轮询重排 ${stagedFill?.repaintKids}/动画 ${stagedFill?.repaintAnims}${stagedFill?.repaintAnims ? '「' + (stagedFill.repaintNames || []).join(' · ') + '」' : ''} · html 同=${stagedFill?.htmlSame} · cls ${stagedFill?.clsBefore}→${stagedFill?.clsAfter}）`);

  /* ── 系统提示词的“解锁 → 改一段 → 保存 → 恢复全部自动”（2026-10-25）────
     这是六页里唯一会**写配置**的交互。它失效的形态很安静：页面照常显示、
     按钮照常能点，只是下一轮提示词里没有那段文字。所以这里真写临时 config，
     再从盘上读回来 —— 不信页面自己的 toast。 */
  console.log('\n── 系统提示词覆盖写入 ──');
  const pEdit = await evalJs(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    window.__nextPauseRefresh?.(true);
    const groups = [...document.querySelectorAll('#nav1 .grp')];
    const gi = groups.findIndex((g) => (g.textContent || '').includes('人格'));
    groups[gi].click(); await sleep(150);
    const subs = [...document.querySelectorAll('#nav2 .sub')];
    const si = subs.findIndex((s) => /系统提示词/.test(s.title || s.textContent || ''));
    if (si < 0) return { err: '找不到系统提示词子页' };
    subs[si].click(); await sleep(220);
    const bang = document.querySelector('.psn [data-a="psn.prompt.unlock"]');
    if (!bang) return { err: '没有 ! 解锁按钮' };
    bang.click(); await sleep(120);
    const go = [...document.querySelectorAll('#modal [data-a="__modal"]')].find((b) => b.textContent.includes('开始编辑'));
    if (!go) return { err: '确认弹窗里没有「开始编辑」' };
    go.click(); await sleep(220);
    const ta = document.querySelector('.psn [data-psn-sec="persona"]');
    if (!ta) return { err: '解锁后没有 persona 段编辑器' };
    ta.value += '\\n【QA覆盖】';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(60);
    const save = document.querySelector('.psn [data-a="psn.prompt.save"]');
    if (!save) return { err: '编辑条里没有「保存全部」' };
    save.click(); await sleep(1200);
    return {
      ok: document.body.textContent.includes('【QA覆盖】'),
      editGone: !document.querySelector('.psn [data-a="psn.prompt.save"]'),
      overriddenChip: [...document.querySelectorAll('.psn .chip')].some((c) => /已改/.test(c.textContent || '')),
      err: '',
    };
  })()`);
  ok(pEdit && !pEdit.err && pEdit.ok && pEdit.editGone,
    `提示词分段可解锁、编辑并保存（${pEdit?.err || `页面已显示覆盖=${pEdit?.ok} · 编辑态已退出=${pEdit?.editGone}`}）`);
  let writtenPrompt = null;
  try { writtenPrompt = JSON.parse(fs.readFileSync(path.join(USERDATA, 'config.json'), 'utf8')); } catch { /* 读不到就红 */ }
  ok(String(writtenPrompt?.custom?.promptSections?.persona || '').includes('【QA覆盖】'),
    `覆盖真的写进临时根 config.json（persona=${JSON.stringify(String(writtenPrompt?.custom?.promptSections?.persona || '').slice(-20))}）`);

  const pReset = await evalJs(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const bang = document.querySelector('.psn [data-a="psn.prompt.unlock"]');
    if (!bang) return { err: '保存后没有 ! 按钮' };
    bang.click(); await sleep(120);
    const go = [...document.querySelectorAll('#modal [data-a="__modal"]')].find((b) => b.textContent.includes('开始编辑'));
    if (!go) return { err: '第二次确认弹窗里没有「开始编辑」' };
    go.click(); await sleep(220);
    const reset = document.querySelector('.psn [data-a="psn.prompt.reset"]');
    if (!reset) return { err: '编辑条里没有「恢复全部自动」' };
    reset.click(); await sleep(1200);
    window.__nextPauseRefresh?.(false);
    return { ok: !document.body.textContent.includes('【QA覆盖】') };
  })()`);
  ok(pReset && !pReset.err && pReset.ok, `恢复全部自动后页面不再显示覆盖（${pReset?.err || `已清除=${pReset?.ok}`}）`);
  let afterReset = null;
  try { afterReset = JSON.parse(fs.readFileSync(path.join(USERDATA, 'config.json'), 'utf8')); } catch { /* 读不到就红 */ }
  ok(!afterReset?.custom?.promptSections?.persona,
    `恢复全部自动真的从盘上清掉了覆盖（persona=${JSON.stringify(afterReset?.custom?.promptSections?.persona)}）`);

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
     ⚠️ 必须回到模型页再点 —— 上面的遍历停在最后一页（工厂 / Skill）。 */
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
    for (let i = 0; i < 30; i++) {
      const t = (document.getElementById('repoStars') || {}).textContent || '';
      if (t && t !== '—') break;
      await sleep(100);
    }
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
      gearAura: q('.gear-aura'),
      panelDots: q('#panelDots'),
      subnav: document.querySelectorAll('#settingsPanel .set-rail-sub').length,
      hooks: document.querySelectorAll('#settingsPanel .set-hook-rail').length,
      railHp: q('.set-rail-hp'),
      customBg: q('#cbgDrop') && q('#cbgGrid') && q('#cropEditor'),
      customInputs: document.querySelectorAll('#cbgImageInput, #cbgVideoInput, #cbgAnyInput').length,
      splash: q('#splashStage') && q('#replaySplash') && q('#setSplash'),
      supporters: document.querySelectorAll('#supportersGrid .supporter-badge').length,
      supporterCount: (document.getElementById('supporterCount') || {}).textContent || '',
      supporterNames: [...document.querySelectorAll('#supportersGrid .badge-name')].map((x) => x.textContent.trim()),
      supporterRoles: [...document.querySelectorAll('#supportersGrid .badge-role')].map((x) => x.textContent.trim()),
      star: q('#repoStar') && q('#repoStars')
        && String((document.getElementById('repoStars') || {}).textContent || '').trim().length > 0,
      starText: String((document.getElementById('repoStars') || {}).textContent || '').trim(),
      feedback: q('#feedbackForm') && q('#fbText') && q('#fbSubmit') && q('#fbError'),
      feedbackUploads: [...document.querySelectorAll('#feedbackForm [name], #feedbackForm input[type="file"]')].length,
      railNav: [],
    };
    for (const id of ['sec-startup', 'sec-about', 'sec-supporters', 'sec-data', 'sec-appearance']) {
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
    ok(shellUi.sections.join(',') === 'sec-appearance,sec-startup,sec-about,sec-supporters,sec-data'
      && shellUi.rail === 5,
      `五个分区与侧栏齐全（${shellUi.sections.join(' / ')} · rail=${shellUi.rail}）`);
    ok(shellUi.cards >= 12 && shellUi.theme && shellUi.accents === 9 && shellUi.fonts === 2,
      `外观控件齐全（card=${shellUi.cards} · accent=${shellUi.accents} · font=${shellUi.fonts}）`);
    ok(shellUi.gearAura && shellUi.panelDots && shellUi.railHp,
      `预览版外壳在位（光晕=${shellUi.gearAura} · 点阵=${shellUi.panelDots} · 二级高亮=${shellUi.railHp}）`);
    ok(shellUi.subnav === 3 && shellUi.hooks === 6,
      `二级目录与虚线钩齐全（subnav=${shellUi.subnav} · hooks=${shellUi.hooks}）`);
    ok(shellUi.customBg && shellUi.customInputs === 3,
      `自定义背景入口齐全（drop/grid/crop=${shellUi.customBg} · inputs=${shellUi.customInputs}）`);
    ok(shellUi.splash, '开屏动画预览 / 开关 / 重播齐全');
    const bootUi = await evalJs(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const replay = document.getElementById('replaySplash');
      if (!replay) return { error: '找不到重播' };
      replay.click();
      await sleep(320);
      const b = document.getElementById('bootSplash');
      const st = document.getElementById('bootSplashStage');
      const out = {
        hidden: !!b && b.hidden,
        aria: b && b.getAttribute('aria-hidden'),
        canvas: !!document.getElementById('bootGridCanvas'),
        orbs: st ? st.querySelectorAll('.cos-orb').length : 0,
        copy: !!st && !!st.querySelector('.grid-copy'),
        skip: !!st && !!st.querySelector('.skip'),
      };
      const skip = st && st.querySelector('.skip');
      if (skip) skip.click();
      await sleep(620);
      out.gone = !!b && b.hidden;
      return out;
    })()`);
    ok(bootUi && !bootUi.error && bootUi.hidden === false && bootUi.canvas && bootUi.orbs === 2
      && bootUi.copy && bootUi.skip && bootUi.gone,
      `最终版开屏可从设置重播（canvas=${bootUi?.canvas} · orbs=${bootUi?.orbs} · gone=${bootUi?.gone}）`);
    ok(shellUi.supporters === 6 && /共 6 席/.test(shellUi.supporterCount)
      && shellUi.supporterNames.length === 6 && shellUi.supporterNames.every((n) => n === '虚位以待')
      && shellUi.supporterRoles.length === 6 && shellUi.supporterRoles.every((r) => r === '待定'),
      `鸣谢名单 6 个虚位席位（${shellUi.supporters} 席 · ${shellUi.supporterCount} · ${shellUi.supporterNames.join('/')}）`);
    ok(shellUi.star && /4,242/.test(shellUi.starText),
      `GitHub 星标来自同源夹具（${JSON.stringify(shellUi.starText)}）`);
    ok(shellUi.feedback && shellUi.feedbackUploads === 0,
      `意见箱是预填表单且没有文件/上传字段（uploads=${shellUi.feedbackUploads}）`);
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

  /* ── 设置层：自定义背景服务端化（2026-10-28）──────────────────────────
     不经过文件选择器：DataTransfer 造一个真实 File 塞进 #cbgAnyInput，
     走的就是用户点「添加图片」那条 change 路径。断言图片 URL 是服务端同源地址
     （不是 blob:），并覆盖启用 → 取消 → 删除三步。 */
  console.log('\n── 设置层：自定义背景服务端化 ──');
  const bgUi = await evalJs(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const gear = document.getElementById('setGear');
    const layer = document.getElementById('settingsLayer');
    if (!gear || !layer) return { error: '找不到设置层' };
    if (layer.dataset.open !== 'true') gear.click();
    await sleep(500);
    const input = document.getElementById('cbgAnyInput');
    if (!input) return { error: '找不到自定义背景输入框' };
    const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nVQAAAAASUVORK5CYII=';
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const file = new File([bytes], 'qa-bg.png', { type: 'image/png' });
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    let item = null;
    for (let i = 0; i < 80; i++) {
      await sleep(100);
      item = document.querySelector('#cbgGrid .cbg-item');
      if (item) break;
    }
    const img = item && item.querySelector('img');
    const out = {
      item: !!item,
      src: img ? (img.getAttribute('src') || '') : '',
      tag: (document.getElementById('cbgTag') || {}).textContent || '',
      status: (document.getElementById('cbgStatus') || {}).textContent || '',
    };
    const clear = document.getElementById('cbgClearBtn');
    if (clear) { clear.click(); await sleep(500); }
    out.tagAfterClear = (document.getElementById('cbgTag') || {}).textContent || '';
    const del = document.querySelector('#cbgGrid .cbg-del');
    if (del) { del.click(); await sleep(800); }
    out.itemsAfterDelete = document.querySelectorAll('#cbgGrid .cbg-item').length;
    if (layer.dataset.open === 'true') gear.click();
    await sleep(200);
    return out;
  })()`);
  ok(bgUi && !bgUi.error && bgUi.item && /^\/api\/backgrounds\/media/.test(bgUi.src) && !/^blob:/.test(bgUi.src),
    `自定义背景上传后走同源 URL（${JSON.stringify(bgUi)}）`);
  ok(bgUi && bgUi.tag === '图片' && bgUi.tagAfterClear === '未启用' && bgUi.itemsAfterDelete === 0,
    `自定义背景启用 → 取消 → 删除（tag=${JSON.stringify(bgUi && bgUi.tag)} · afterClear=${JSON.stringify(bgUi && bgUi.tagAfterClear)} · left=${bgUi && bgUi.itemsAfterDelete}）`);

  /* ── 设置层：旧 IndexedDB 背景自动迁移（2026-10-28）──────────────────
     维护者选择「自动迁移并清浏览器副本」。这里先往 IDB 种一条旧记录，reload 后
     验证：服务端列表出现、页面 URL 是同源地址、IDB 行被删、旧 active 键被清。 */
  console.log('\n── 设置层：旧 IndexedDB 背景自动迁移 ──');
  const migSeed = await evalJs(`(async () => {
    const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nVQAAAAASUVORK5CYII=';
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open('estrella-panel-bg', 1);
      r.onupgradeneeded = () => {
        const d = r.result;
        if (!d.objectStoreNames.contains('items')) d.createObjectStore('items', { keyPath: 'id' });
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    await new Promise((res, rej) => {
      const tx = db.transaction('items', 'readwrite');
      tx.objectStore('items').put({
        id: 'cbg-legacy-1', type: 'image', name: '旧背景',
        blob: new Blob([bytes], { type: 'image/png' }),
        displayBlob: null, crop: null, createdAt: 1,
      });
      tx.oncomplete = res;
      tx.onerror = () => rej(tx.error);
    });
    localStorage.setItem('estrella-panel-bg-active', 'cbg-legacy-1');
    return true;
  })()`);
  await send('Page.reload');
  let migReady = false;
  for (let i = 0; i < 50 && !migReady; i++) {
    await sleep(300);
    migReady = await evalJs('document.readyState === "complete" && document.querySelectorAll("#page *").length > 5');
  }
  let migUi = null;
  for (let i = 0; i < 60; i++) {
    migUi = await evalJs(`(async () => {
      const items = document.querySelectorAll('#cbgGrid .cbg-item');
      const img = items[0] && items[0].querySelector('img');
      const dbCount = await new Promise((res) => {
        const r = indexedDB.open('estrella-panel-bg', 1);
        r.onsuccess = () => {
          try {
            const tx = r.result.transaction('items', 'readonly');
            const c = tx.objectStore('items').count();
            c.onsuccess = () => res(c.result);
            c.onerror = () => res(-1);
          } catch { res(-1); }
        };
        r.onerror = () => res(-1);
      });
      const token = (document.querySelector('meta[name="panel-token"]') || {}).content || '';
      const list = await fetch('/api/backgrounds', { headers: { Authorization: 'Bearer ' + token } })
        .then((r) => r.json()).catch(() => ({ items: [] }));
      return {
        items: items.length,
        src: img ? (img.getAttribute('src') || '') : '',
        dbCount,
        serverItems: Array.isArray(list.items) ? list.items.length : -1,
        active: list.activeId || '',
        legacyActive: localStorage.getItem('estrella-panel-bg-active') || '',
      };
    })()`);
    if (migUi && migUi.items > 0) break;
    await sleep(300);
  }
  ok(migSeed === true && migUi && migUi.items > 0 && /^\/api\/backgrounds\/media/.test(migUi.src)
    && migUi.dbCount === 0 && migUi.serverItems >= 1 && migUi.legacyActive === '',
  `旧 IndexedDB 背景自动迁移并清理（${JSON.stringify(migUi)}）`);
  await evalJs(`(async () => {
    const token = (document.querySelector('meta[name="panel-token"]') || {}).content || '';
    const list = await fetch('/api/backgrounds', { headers: { Authorization: 'Bearer ' + token } }).then((r) => r.json());
    for (const it of list.items || []) {
      await fetch('/api/backgrounds/delete', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: it.id }),
      });
    }
    return true;
  })()`);

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
    const modeNow = document.getElementById('setThemeSeg').dataset.mode;
    for (let i = 0; i < 40 && root.dataset.theme !== 'dark'; i++) await sleep(50);
    for (let i = 0; i < 40 && root.dataset.vt; i++) await sleep(50);
    const dark = {
      theme: root.dataset.theme || '',
      stored: stored('next-theme'),
      vtCleared: !root.dataset.vt,
      modeNow,
      mode: document.getElementById('setThemeSeg').dataset.mode,
      darkPressed: document.querySelector('[data-theme-opt="dark"]').getAttribute('aria-pressed'),
    };
    const monoBtn = document.querySelector('[data-accent-opt="mono"]');
    if (monoBtn) monoBtn.click();
    await sleep(80);
    const mono = {
      accent: root.dataset.accent || '',
      stored: stored('next-accent'),
      css: getComputedStyle(root).getPropertyValue('--c-accent').trim(),
      pressed: monoBtn ? monoBtn.getAttribute('aria-pressed') : '',
    };
    const graphiteBtn = document.querySelector('[data-accent-opt="graphite"]');
    if (graphiteBtn) graphiteBtn.click();
    await sleep(80);
    const graphite = {
      accent: root.dataset.accent || '',
      stored: stored('next-accent'),
      css: getComputedStyle(root).getPropertyValue('--c-accent').trim(),
      pressed: graphiteBtn ? graphiteBtn.getAttribute('aria-pressed') : '',
    };
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
    return { before, serif, dark, mono, graphite, lagoon, bg };
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
    ok(appearance.dark.modeNow === 'dark' && appearance.dark.mode === 'dark'
      && appearance.dark.darkPressed === 'true',
      `夜间按钮即时翻面（点击瞬间=${appearance.dark.modeNow} · 落定=${appearance.dark.mode} · pressed=${appearance.dark.darkPressed}）`);
    ok(appearance.mono.accent === 'mono' && appearance.mono.stored === 'mono'
      && appearance.mono.pressed === 'true' && /rgb|#/.test(appearance.mono.css),
      `黑白主题色可用（accent=${appearance.mono.accent} · stored=${appearance.mono.stored} · --c-accent=${appearance.mono.css}）`);
    ok(appearance.graphite.accent === 'graphite' && appearance.graphite.stored === 'graphite'
      && appearance.graphite.pressed === 'true' && appearance.graphite.css === '#c2cad6',
      `石墨主题色可用（accent=${appearance.graphite.accent} · stored=${appearance.graphite.stored} · --c-accent=${appearance.graphite.css}）`);
    ok(appearance.lagoon.accent === 'lagoon' && appearance.lagoon.stored === 'lagoon'
      && appearance.lagoon.pressed === 'true' && /rgb|#/.test(appearance.lagoon.css),
      `主题色切到青碧（accent=${appearance.lagoon.accent} · stored=${appearance.lagoon.stored} · --c-accent=${appearance.lagoon.css}）`);
    ok(appearance.bg.current === appearance.bg.want && appearance.bg.stored === appearance.bg.want && appearance.bg.checked === 1,
      `背景切到最后一套并持久化（${appearance.bg.current} · checked=${appearance.bg.checked}）`);
  }

  /* ── 设置层：右侧滚动 → 左侧二级目录联动（2026-10-28）────────────── */
  console.log('\n── 设置层：二级目录跟随右侧滚动 ──');
  const spy = await evalJs(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const gear = document.getElementById('setGear');
    const layer = document.getElementById('settingsLayer');
    if (!gear || !layer) return { error: '找不到设置层入口' };
    if (layer.dataset.open !== 'true') gear.click();
    await sleep(420);
    const rail = document.querySelector('.set-rail-item[data-target="sec-appearance"]');
    if (!rail) return { error: '找不到外观分区' };
    rail.click();
    await sleep(650);
    const scroll = document.getElementById('settingsScroll');
    const target = document.getElementById('card-appearance-cbg');
    if (!scroll || !target) return { error: '找不到滚动容器或自定义背景卡' };
    const mark = () => {
      const on = document.querySelector('.set-rail-sub.is-open .set-rail-sub-item[aria-current="location"]');
      return on ? on.getAttribute('data-target') : '';
    };
    const top = target.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop - 12;
    scroll.scrollTop = Math.max(0, top);
    await sleep(280);
    const atCbg = mark();
    scroll.scrollTop = 0;
    await sleep(280);
    const atTop = mark();
    gear.click();
    await sleep(220);
    return { atCbg, atTop };
  })()`);
  ok(spy && !spy.error && spy.atCbg === 'card-appearance-cbg' && spy.atTop === 'card-appearance-mode',
    `右侧滚到自定义背景时左侧跟随（${spy?.error || `滚到=${spy?.atCbg} · 回顶=${spy?.atTop}`}）`);

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

  /* ── 背景模式：等高线默认 / 切流光 / 速度 / 主题 ───────────────────── */
  console.log('\n── 背景模式：等高线默认、流光保留与速度/主题联动 ──');
  const contourUi = await evalJs(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const gear = document.getElementById('setGear');
    const layer = document.getElementById('settingsLayer');
    if (!gear || !layer) return { error: '找不到设置层入口' };
    if (layer.dataset.open !== 'true') gear.click();
    await sleep(520);
    const root = document.documentElement;
    const v = document.getElementById('contourVideo');
    const poster = document.getElementById('contourPoster');
    const bg = document.getElementById('contourBg');
    const pick = document.getElementById('bgPick');
    const name = document.getElementById('setBgName');
    const cb = window.ContourBG;
    const sb = window.ShaderBG;
    if (!v || !poster || !bg || !cb || !sb) return { error: '等高线 DOM/API 缺失' };
    const click = (sel) => { const el = document.querySelector(sel); if (el) el.click(); return !!el; };
    const css = getComputedStyle(bg);
    const out = {
      default: {
        mode: cb.mode, rendition: cb.rendition, state: cb.state,
        z: css.zIndex, pos: css.position, pe: css.pointerEvents,
        bgContour: root.classList.contains('bg-contour'),
        aria: bg.getAttribute('aria-hidden'),
        modes: document.querySelectorAll('#setBgMode [data-bgmode-opt]').length,
        modePressed: document.querySelectorAll('#setBgMode [aria-pressed="true"]').length,
        rowLayout: (() => {
          const seg = document.getElementById('setBgMode');
          const row = seg && seg.closest('.set-row');
          const txt = row && row.querySelector('.txt');
          const card = seg && seg.closest('.set-card');
          if (!seg || !row || !txt || !card) return null;
          const sr = seg.getBoundingClientRect();
          const tr = txt.getBoundingClientRect();
          const cr = card.getBoundingClientRect();
          return {
            segW: Math.round(sr.width), txtW: Math.round(tr.width),
            inside: sr.left >= cr.left && sr.right <= cr.right - 8,
            wrapped: tr.height > 60,
          };
        })(),
        pickerHidden: pick.hidden,
        label: (name || {}).textContent || '',
        muted: v.muted, playsInline: v.playsInline, loop: v.loop,
        preload: v.getAttribute('preload'),
        controls: v.hasAttribute('controls'), autoplay: v.hasAttribute('autoplay'),
        src: v.getAttribute('src') || '',
        poster: poster.style.backgroundImage,
      },
    };
    click('[data-bgmode-opt="shader"]');
    await sleep(300);
    out.shader = {
      mode: cb.mode, active: sb.active, pickerHidden: pick.hidden,
      label: (name || {}).textContent || '',
      stored: (() => { try { return localStorage.getItem('qqbot-bg-mode') || ''; } catch { return ''; } })(),
      contourOff: cb.state,
    };
    click('[data-bgmode-opt="contour"]');
    await sleep(300);
    out.contourBack = {
      mode: cb.mode, active: sb.active, pickerHidden: pick.hidden,
      label: (name || {}).textContent || '',
      stored: (() => { try { return localStorage.getItem('qqbot-bg-mode') || ''; } catch { return ''; } })(),
    };
    click('#bgSpeed [data-speed="0"]');
    await sleep(240);
    out.speed0 = { shader: sb.speed, contour: cb.speed, state: cb.state, paused: v.paused };
    click('#bgSpeed [data-speed="100"]');
    await sleep(280);
    out.speed100 = { shader: sb.speed, contour: cb.speed, rate: v.playbackRate, state: cb.state, src: v.getAttribute('src') || '' };
    out.quality = {
      saveData: cb.pickQuality({ saveData: true }),
      lowMem: cb.pickQuality({ deviceMemory: 2 }),
      lowCpu: cb.pickQuality({ hardwareConcurrency: 2 }),
      normal: cb.pickQuality({ deviceMemory: 8, hardwareConcurrency: 8 }),
    };
    // 设置层打开时视频按设计暂停；关掉后再验播放倍率。
    gear.click();
    await sleep(700);
    out.afterClose = { state: cb.state, rate: v.playbackRate, paused: v.paused, src: v.getAttribute('src') || '' };
    gear.click();
    await sleep(420);
    click('[data-theme-opt="dark"]');
    for (let i = 0; i < 40 && root.dataset.theme !== 'dark'; i++) await sleep(50);
    await sleep(120);
    out.dark = { theme: cb.theme, bgDark: root.classList.contains('bg-dark'), poster: poster.style.backgroundImage };
    click('[data-theme-opt="light"]');
    for (let i = 0; i < 40 && root.dataset.theme !== 'light'; i++) await sleep(50);
    await sleep(120);
    out.light = { theme: cb.theme, bgDark: root.classList.contains('bg-dark'), poster: poster.style.backgroundImage };
    click('#bgSpeed [data-speed="66"]');
    await sleep(220);
    try {
      localStorage.removeItem('qqbot-bg-mode');
      localStorage.removeItem('qqbot-bgfx-speed');
    } catch (e) { /* 隐私模式 */ }
    gear.click();
    await sleep(280);
    return out;
  })()`);
  ok(contourUi && !contourUi.error, `等高线背景可操作（${contourUi?.error || 'ok'}）`);
  if (contourUi && !contourUi.error) {
    const d = contourUi.default;
    ok(d.mode === 'contour' && d.bgContour && d.aria === 'true' && d.z === '-2' && d.pos === 'fixed' && d.pe === 'none',
      `等高线是默认层且不抢点击（mode=${d.mode} · z=${d.z} · pos=${d.pos} · pe=${d.pe}）`);
    ok(d.modes === 2 && d.modePressed === 1 && d.pickerHidden === true && d.label === '等高线',
      `模式选择器两态、默认等高线、流光色板隐藏（modes=${d.modes} · pressed=${d.modePressed} · hidden=${d.pickerHidden} · label=${d.label}）`);
    ok(d.rowLayout && d.rowLayout.segW <= 220 && d.rowLayout.txtW >= 160 && d.rowLayout.inside && !d.rowLayout.wrapped,
      `背景模式行不挤压说明列（seg=${d.rowLayout?.segW}px · txt=${d.rowLayout?.txtW}px · inside=${d.rowLayout?.inside} · wrapped=${d.rowLayout?.wrapped}）`);
    ok(d.muted && d.playsInline && d.loop && !d.controls && !d.autoplay && ['none', 'auto'].includes(d.preload),
      `视频属性安全（muted=${d.muted} · inline=${d.playsInline} · loop=${d.loop} · preload=${d.preload} · controls=${d.controls} · autoplay=${d.autoplay}）`);
    ok(/\?v=4/.test(d.poster) && (!d.src || /\?v=4/.test(d.src)),
      `媒体带统一缓存版本（src=${d.src || '（未加载）'} · poster=${String(d.poster).slice(0, 80)}）`);
    ok(contourUi.shader.mode === 'shader' && contourUi.shader.active === true && contourUi.shader.pickerHidden === false
      && contourUi.shader.stored === 'shader' && contourUi.shader.label !== '等高线',
      `切流光：旧引擎恢复、色板出现、标签与持久化正确（active=${contourUi.shader.active} · hidden=${contourUi.shader.pickerHidden} · label=${contourUi.shader.label}）`);
    ok(contourUi.contourBack.mode === 'contour' && contourUi.contourBack.active === false
      && contourUi.contourBack.pickerHidden === true && contourUi.contourBack.label === '等高线',
      `切回等高线：旧引擎暂停、色板隐藏（active=${contourUi.contourBack.active} · hidden=${contourUi.contourBack.pickerHidden}）`);
    ok(contourUi.speed0.shader === 0 && contourUi.speed0.contour && contourUi.speed0.contour.mul === 0
      && contourUi.speed0.state === 'poster' && contourUi.speed0.paused === true,
      `速度无：视频暂停并退海报（shader=${contourUi.speed0.shader} · state=${contourUi.speed0.state} · paused=${contourUi.speed0.paused}）`);
    ok(contourUi.speed100.shader === 100 && contourUi.speed100.contour && contourUi.speed100.contour.mul === 2
      && (!contourUi.afterClose.src || contourUi.afterClose.state === 'poster' || contourUi.afterClose.rate === 2),
      `速度快：关闭设置后播放倍率 2（mul=${contourUi.speed100.contour?.mul} · state=${contourUi.afterClose?.state} · rate=${contourUi.afterClose?.rate}）`);
    ok(contourUi.dark.theme === 'dark' && contourUi.dark.bgDark === true && /contour-dark-v2\.jpg\?v=4/.test(contourUi.dark.poster)
      && contourUi.light.theme === 'light' && contourUi.light.bgDark === false && /contour-light-v2\.jpg\?v=4/.test(contourUi.light.poster),
      `主题换源与 bg-dark 正确（dark=${contourUi.dark.bgDark} · light=${contourUi.light.bgDark}）`);
    ok(contourUi.quality && contourUi.quality.saveData === 'poster'
      && contourUi.quality.lowMem === 'lite' && contourUi.quality.lowCpu === 'lite'
      && contourUi.quality.normal === 'standard',
      `低端判定：saveData→海报 / 低内存→轻量 / 低核心→轻量 / 正常→标准（${JSON.stringify(contourUi.quality)}）`);
  }

  /* ── 等高线 reduced-motion：系统要求静止时必须退海报并暂停视频 ───────── */
  await send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
  });
  await sleep(550);
  const reducedContour = await evalJs(`(() => {
    const cb = window.ContourBG;
    const v = document.getElementById('contourVideo');
    const po = document.getElementById('contourPoster');
    return cb && v ? {
      state: cb.state, rendition: cb.rendition, paused: v.paused,
      poster: po ? po.style.backgroundImage : '',
    } : null;
  })()`);
  await send('Emulation.setEmulatedMedia', { features: [] });
  await sleep(450);
  ok(reducedContour && reducedContour.state === 'poster' && reducedContour.rendition === 'poster'
    && reducedContour.paused === true && /contour-light-v2\.jpg\?v=4/.test(reducedContour.poster),
    `等高线 reduced-motion：退海报并暂停视频（state=${reducedContour?.state} · rendition=${reducedContour?.rendition} · paused=${reducedContour?.paused}）`);

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
       ① 二级宽度必须**按内容自适应**（运行 2 页签明显窄于发言 6 页签，
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
      if (!findGroup(/运行/) || !findGroup(/发言/)) return { error: '没找到「运行 / 发言」分组' };
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
      findGroup(/运行/).click(); await sleep(520);
      const narrowM = measure();
      findGroup(/发言/).click(); await sleep(520);
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
      && m.narrowW < m.wideW - 40                 // 2 页签必须明显窄于 6 页签
      && m.narrowW <= m.narrowScrollW + 12        // 窄条不能比自身内容多出一大截
      && m.dockW <= m.viewport + 1
      && m.stacked === false
      && m.islandCentered === true
      && m.narrowSelVisible === true
      && m.wideSelVisible === true;
    ok(pass, `${w}px：二级自适应（运行 ${m && m.narrowW ? m.narrowW.toFixed(1) : '?'} / 发言 ${m && m.wideW ? m.wideW.toFixed(1) : '?'}）`
      + ` · 运行内容 ${m && m.narrowScrollW ? m.narrowScrollW.toFixed(0) : '?'} · dock ${m && m.dockW ? m.dockW.toFixed(0) : '?'}`
      + ` · 两级选中可见 ${m && m.narrowSelVisible}/${m && m.wideSelVisible}`
      + `${m && m.error ? ' · ' + m.error : ''}`);
  }
  /* 维护域已回到岛内：先回到桌面宽度（上一段量到 390） */
  await send('Emulation.clearDeviceMetricsOverride');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await sleep(250);
  /* 维护域：岛内 7 个可见域（新增「工厂」），顶栏不再有单独入口 */
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
    && maint.visible === 7 && maint.topbarBtn === false
    && maint.selected === 'true' && maint.hiddenSys === false
    && maint.nav2 === 4 && /安全红线/.test(maint.first) && /HUD调整/.test(maint.last)
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

  /* ── 插件管理页：上限 / 运行期可观测 / 设置保存与回填（2026-10-23）──────────
     上面的制作站已经跳到了 `lab-liquid-glass.html`，先回控制台再进工厂 → 插件管理。 */
  try {
    await send('Page.navigate', { url: `${BASE}/` });
    await sleep(1200);
    await evalJs(`(() => {
      const fac = [...document.querySelectorAll('#nav1 .grp')].find((x) => (x.getAttribute('aria-label') || '').startsWith('工厂'));
      fac?.click();
      return true;
    })()`);
    await sleep(350);
    await evalJs(`(() => { window.__navAutoHide && window.__navAutoHide.reveal(); return 1; })()`);
    await sleep(420);
    const went = await evalJs(`(() => {
      const s = [...document.querySelectorAll('#nav2 .sub')].find((x) => /插件管理/.test(x.title || x.textContent || ''));
      if (s) s.click();
      return !!s;
    })()`);
    await sleep(450);
    ok(went, '插件管理页可进入（工厂 → 插件管理）');

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
    /* 工具额度是**全局共享**的（插件与 Skill 同一张工具表）⇒ 这里读的是 21（20 插件工具 + 1 Skill 工具）。 */
    ok(/工具\s*21\s*\/\s*上限\s*64/.test(plug.text.replace(/\s+/g, ' ')), '总览显示「工具 21 / 上限 64」');
    ok(plug.overTags >= 5, `至少 5 张卡标了超上限（实际 ${plug.overTags}）`);
    ok(plug.emptyTags >= 1, '空载卡有显式标记');
    ok(plug.bogus, '钩子未挂的原因出现在卡片 title 上');
    ok(plug.toolErr, '工具注册失败的原因出现在卡片 title 上');
    ok(plug.plugMax === '20' && plug.toolMax === '64', `两个上限控件回显 20 / 64（实际 ${plug.plugMax} / ${plug.toolMax}）`);

    // 设置保存：输入 → change → 保存 → 读临时根 config.json；reload 后回显。
    const saved = await evalJs(`(async () => {
      const inp = document.querySelector('[data-p="plugin|qa01|mode"]');
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
    ok(written?.custom?.extensions?.plugins?.settings?.qa01?.mode === 'abc',
      `保存后临时根 config.json 里 qa01.mode=abc（实际 ${JSON.stringify(written?.custom?.extensions?.plugins?.settings?.qa01?.mode)}）`);

    await send('Page.reload');
    await sleep(1400);
    await evalJs(`(() => {
      const fac = [...document.querySelectorAll('#nav1 .grp')].find((x) => (x.getAttribute('aria-label') || '').startsWith('工厂'));
      fac?.click();
      return true;
    })()`);
    await sleep(350);
    await evalJs(`(() => { window.__navAutoHide && window.__navAutoHide.reveal(); return 1; })()`);
    await sleep(420);
    await evalJs(`(() => {
      const s = [...document.querySelectorAll('#nav2 .sub')].find((x) => /插件管理/.test(x.title || x.textContent || ''));
      if (s) s.click(); return !!s;
    })()`);
    await sleep(450);
    /* 刷新后首次 /api/state 实测可达 ~1.5s（测试根 25 插件、状态包 ~89KB）。
       固定等待会让控件还没落位就被断言；轮询到控件出现为止，判据本身不变。 */
    for (let i = 0; i < 50; i += 1) {
      const ready = await evalJs(`!!document.querySelector('[data-p="plugin|qa01|mode"]')`);
      if (ready) break;
      await sleep(300);
    }
    const back = await evalJs(`document.querySelector('[data-p="plugin|qa01|mode"]')?.value ?? ''`);
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
    ok(writtenHook?.custom?.extensions?.hookTimeoutMs === 6000,
      `保存后临时根 config.json 里 hookTimeoutMs=6000（实际 ${JSON.stringify(writtenHook?.custom?.extensions?.hookTimeoutMs)}）`);

    /* ── Skill 页（2026-10-28 · Plugin/Skill 综合优化；现在位于工厂 → Skill）────
       与插件页共用卡片/开关/设置行；额外要能解释纯提示词型、工具型与模型可见预览。 */
    await evalJs(`(() => {
      const s = [...document.querySelectorAll('#nav2 .sub')].find((x) => /Skill/i.test(x.title || x.textContent || ''));
      if (s) s.click(); return !!s;
    })()`);
    await sleep(450);
    const sk = await evalJs(`(() => {
      const page = document.getElementById('page');
      const text = page ? (page.textContent || '') : '';
      return {
        cards: document.querySelectorAll('.pcard').length,
        text,
        promptOnly: /提示词型/.test(text),
        toolBadge: /工具\\s*1/.test(text),
        preview: text.includes('sk01 的提示词正文。') && text.includes('sk02__ping'),
        empty: /还没有装 Skill/.test(text),
      };
    })()`);
    ok(sk.cards === 2, `Skill 板数 = 2（实际 ${sk.cards}）`);
    ok(sk.promptOnly, '纯提示词 Skill 卡显示「提示词型」');
    ok(sk.toolBadge, '工具型 Skill 显示「工具 1」');
    ok(sk.preview, 'Skill 预览含提示词正文与真实工具名');
    ok(!sk.empty, '有 Skill 时不应显示空态');
    const skSaved = await evalJs(`(async () => {
      const el = document.querySelector('[data-a="plugin.toggle"][data-k="skill"][data-p="sk01"]');
      if (!el) return { error: 'no-skill-toggle' };
      /* 真用户路径是 click（浏览器随后才发 change）；面板的 toggle 分支挂在 click 上。 */
      el.click();
      await new Promise((r) => setTimeout(r, 150));
      document.querySelector('[data-a="draft-save"]')?.click();
      await new Promise((r) => setTimeout(r, 1500));
      return { ok: true };
    })()`);
    ok(skSaved && !skSaved.error, `Skill 开关可写并保存（${skSaved?.error || 'ok'}）`);
    let writtenSk = null;
    try { writtenSk = JSON.parse(fs.readFileSync(path.join(USERDATA, 'config.json'), 'utf8')); } catch { /* 读不到就红 */ }
    ok(Array.isArray(writtenSk?.custom?.extensions?.skills?.enabled)
      && !writtenSk.custom.extensions.skills.enabled.includes('sk01'),
      `保存后 extensions.skills.enabled 不含 sk01（实际 ${JSON.stringify(writtenSk?.custom?.extensions?.skills?.enabled)}）`);

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
    ok(false, `插件管理/Skill/记忆/技能页冒烟失败：${e && e.message ? e.message : e}`);
  }
  await send('Emulation.clearDeviceMetricsOverride');

  /* ── 全局光标跟随层（2026-10-28）────────────────────────────────────── */
  console.log('\n── 光标跟随层 ──');
  const cfBase = await evalJs(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const raf2 = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const CLICKABLE = 'a[href],button,input,select,textarea,label,summary,[role="button"],[role="tab"],[role="switch"],[data-a],[data-go],.btn,.grp,.sub,.chip,.sw,.seg label,.isle,.sg-cell[data-go],.row[data-a],.ov-cell,.ov-btn,.srt-grip,.set-rail-item,.set-rail-sub-item,.set-switch,.set-seg button,.set-font,.set-acc,#cbgDrop';
    const root = document.getElementById('cfRoot');
    const ring = root && root.querySelector('.cf-ring');
    const dot = root && root.querySelector('.cf-dot');
    if (!window.__cursorFollow || !root || !ring || !dot) return { error: 'missing' };
    const style = (el) => getComputedStyle(el);
    const matrix = (el) => new DOMMatrix(style(el).transform);
    const alpha = (c) => {
      let m = c.match(/rgba?\\([^)]*,\\s*([\\d.]+)\\)/);
      if (m) return parseFloat(m[1]);
      m = c.match(/\\/\\s*([\\d.]+)\\s*\\)/);
      return m ? parseFloat(m[1]) : 1;
    };
    const neutralAt = (from) => {
      let first = null;
      let best = null;
      let bestD = -1;
      for (let x = 8; x < innerWidth - 8; x += 16) {
        for (let y = 170; y < innerHeight - 90; y += 32) {
          const el = document.elementFromPoint(x, y);
          if (!el || (el.closest && el.closest(CLICKABLE))) continue;
          if (!first) first = { x, y };
          const d = from ? Math.abs(x - from.x) + Math.abs(y - from.y) : 0;
          if (d > bestD) { bestD = d; best = { x, y }; }
        }
      }
      return (from ? best : first) || { x: 8, y: 300 };
    };
    const move = (x, y) => document.dispatchEvent(new PointerEvent('pointermove', {
      bubbles: true, clientX: x, clientY: y,
    }));
    const over = (x, y, target) => target.dispatchEvent(new PointerEvent('pointerover', {
      bubbles: true, clientX: x, clientY: y,
    }));
    const out = (target, related) => target.dispatchEvent(new PointerEvent('pointerout', {
      bubbles: true, clientX: 0, clientY: 0, relatedTarget: related,
    }));

    const near = neutralAt(null);
    const far = neutralAt(near);
    move(near.x, near.y);
    await raf2();
    await sleep(40);
    const dotM = matrix(dot);
    const hit = document.elementFromPoint(near.x, near.y);
    const base = {
      parent: root.parentElement === document.body,
      fixed: style(root).position,
      z: Number(style(root).zIndex),
      aria: root.getAttribute('aria-hidden'),
      pe: [style(root).pointerEvents, style(ring).pointerEvents, style(dot).pointerEvents],
      overlayHit: !!(hit && hit.closest && hit.closest('#cfRoot')),
      dotX: dotM.m41,
      dotY: dotM.m42,
      fillA: alpha(style(ring).backgroundColor),
      lineA: alpha(style(ring).borderTopColor),
    };

    move(far.x, far.y);
    await raf2();
    await sleep(40);
    const jump = window.__cursorFollow.state();

    await sleep(1000);
    const idle = window.__cursorFollow.state();

    const chip = document.querySelector('#nav1 .grp');
    if (!chip) return { error: 'no-nav-group', base, jump, idle };
    const cr = chip.getBoundingClientRect();
    const cx = cr.left + cr.width / 2;
    const cy = cr.top + cr.height / 2;
    const probe = document.createElement('span');
    probe.style.color = 'var(--c-accent)';
    document.body.appendChild(probe);
    const accent = getComputedStyle(probe).color;
    probe.remove();
    move(cx, cy);
    over(cx, cy, chip);
    await raf2();
    await sleep(500);
    const hot = window.__cursorFollow.state();
    const hotColor = style(ring).borderTopColor;
    const hotBg = style(ring).backgroundColor;
    /* 真实移出：out → move → over 到中性点；只派发 out 会让指针坐标仍停在按钮上，
       空闲重算会把 hover 又拉回 true。 */
    out(chip, document.body);
    move(near.x, near.y);
    over(near.x, near.y, document.body);
    await sleep(260);
    const cool = window.__cursorFollow.state();
    return {
      base, jump, idle, hot, hotColor, hotBg, accent, cool, near,
      hotLineA: alpha(hotColor), hotFillA: alpha(hotBg),
    };
  })()`);
  ok(cfBase && !cfBase.error, `跟随层存在且可测（${cfBase?.error || 'ok'}）`);
  if (cfBase && !cfBase.error) {
    ok(cfBase.base.parent && cfBase.base.fixed === 'fixed' && cfBase.base.z === 81 && cfBase.base.aria === 'true',
      `根节点是 body 直接子节点、fixed、z=81、aria-hidden（${cfBase.base.fixed} · z=${cfBase.base.z}）`);
    ok(cfBase.base.pe.every((v) => v === 'none') && cfBase.base.overlayHit === false,
      `三层不吃指针，命中落在页面（${cfBase.base.pe.join('/')}）`);
    ok(Math.abs(cfBase.base.dotX - cfBase.near.x) <= 0.6 && Math.abs(cfBase.base.dotY - cfBase.near.y) <= 0.6,
      `黑点实时跟到指针（${cfBase.base.dotX.toFixed(1)},${cfBase.base.dotY.toFixed(1)} vs ${cfBase.near.x},${cfBase.near.y}）`);
    const jl = cfBase.jump?.lag;
    ok(Number.isFinite(jl) && jl > 0.5 && jl <= 9.6,
      `大跨度移动后环有拖尾但被钳在 9px（lag=${String(jl)}）`);
    ok(cfBase.idle?.idle === true && cfBase.idle.scale <= 0.82 && cfBase.idle.lag < 1.5 && cfBase.idle.raf === false,
      `停手后缩环并归还时钟（scale=${String(cfBase.idle?.scale)} · lag=${String(cfBase.idle?.lag)} · raf=${cfBase.idle?.raf}）`);
    ok(cfBase.hot?.hover === true && cfBase.hot.scale > 1.15 && cfBase.hot.scale < 1.3
      && cfBase.hotColor !== cfBase.accent && cfBase.hotBg !== cfBase.accent
      && cfBase.hotLineA > cfBase.base.lineA && cfBase.hotFillA > cfBase.base.fillA,
      `悬停只放大、保持黑白（scale=${String(cfBase.hot?.scale)} · border=${cfBase.hotColor} · fill=${cfBase.hotBg} · accent=${cfBase.accent}）`);
    ok(cfBase.cool?.hover === false && cfBase.cool.scale < 1.45,
      `移出后可点元素恢复（hover=${cfBase.cool?.hover} · scale=${String(cfBase.cool?.scale)}）`);
    ok(cfBase.base.fillA < cfBase.base.lineA,
      `环填充比描边更淡（fillAlpha=${String(cfBase.base.fillA)} < lineAlpha=${String(cfBase.base.lineA)}）`);
  }

  /* 工厂 iframe：合成事件走真实桥接与坐标换算（真鼠标路径另记手动验收） */
  const cfFrame = await evalJs(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const raf2 = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const group = [...document.querySelectorAll('#nav1 .grp')].find((x) => /工厂/.test(x.title || x.textContent || ''));
    if (!group) return { error: 'no-factory-group' };
    group.click();
    await sleep(360);
    const sub = [...document.querySelectorAll('#nav2 .sub')].find((x) => /视觉工厂/.test(x.title || x.textContent || ''));
    if (!sub) return { error: 'no-visual-sub' };
    sub.click();
    let frame = null;
    let ready = false;
    for (let i = 0; i < 60; i++) {
      frame = document.querySelector('#factoryHost iframe[data-frame="visual-factory.html"]');
      if (frame && frame.contentDocument && frame.contentDocument.body
        && document.body.classList.contains('factory-frame-ready')) { ready = true; break; }
      await sleep(250);
    }
    if (!ready) return { error: 'frame-not-ready' };
    const r = frame.getBoundingClientRect();
    const doc = frame.contentDocument;
    const ev = (type, target, x, y) => target.dispatchEvent(new frame.contentWindow.PointerEvent(type, {
      bubbles: type !== 'pointerleave', clientX: x, clientY: y,
    }));
    ev('pointermove', doc.body, 40, 60);
    await raf2();
    await sleep(60);
    const moved = window.__cursorFollow.state();
    const sx = frame.clientWidth ? r.width / frame.clientWidth : 1;
    const sy = frame.clientHeight ? r.height / frame.clientHeight : 1;
    const wantX = r.left + 40 * sx;
    const wantY = r.top + 60 * sy;
    const btn = doc.querySelector('button,a[href],[role="button"],input,select,textarea,label,summary,[data-a],[data-go]');
    let hovered = null;
    if (btn) {
      const br = btn.getBoundingClientRect();
      ev('pointerover', btn, br.left + Math.min(8, br.width / 2), br.top + Math.min(8, br.height / 2));
      await raf2();
      await sleep(90);
      hovered = window.__cursorFollow.state();
    }
    ev('pointerleave', doc, 0, 0);
    await sleep(340);
    const left = window.__cursorFollow.state();
    return { ready, moved, wantX, wantY, hovered, left, hasBtn: !!btn };
  })()`);
  ok(cfFrame && !cfFrame.error && cfFrame.ready,
    `工厂帧可作为桥接目标（${cfFrame?.error || 'ready'}）`);
  if (cfFrame && !cfFrame.error && cfFrame.ready) {
    ok(Math.abs(cfFrame.moved.x - cfFrame.wantX) <= 1.5 && Math.abs(cfFrame.moved.y - cfFrame.wantY) <= 1.5,
      `帧内坐标换算到父层（${cfFrame.moved.x.toFixed(1)},${cfFrame.moved.y.toFixed(1)} vs ${cfFrame.wantX.toFixed(1)},${cfFrame.wantY.toFixed(1)}）`);
    ok(cfFrame.moved.frameActive === true, `帧内移动标记 frameActive（${cfFrame.moved.frameActive}）`);
    ok(!cfFrame.hasBtn || cfFrame.hovered?.hover === true,
      `帧内可点元素触发悬停放大（${cfFrame.hasBtn ? cfFrame.hovered?.hover : '无按钮，跳过'}）`);
    ok(cfFrame.left.frameActive === false && cfFrame.left.visible === false,
      `离开工厂帧后桥收起（frameActive=${cfFrame.left.frameActive} · visible=${cfFrame.left.visible}）`);
  }

  /* 减弱动效：重载后模块必须完全不启用，且 CSS 双保险隐藏 */
  await send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
  });
  await send('Page.navigate', { url: `${BASE}/` });
  let cfReducedBoot = false;
  for (let i = 0; i < 50 && !cfReducedBoot; i++) {
    cfReducedBoot = await evalJs('!!document.getElementById("cfRoot") && document.querySelectorAll("#page *").length > 5');
    if (!cfReducedBoot) await sleep(300);
  }
  const cfReduced = await evalJs(`(() => {
    const api = window.__cursorFollow;
    const root = document.getElementById('cfRoot');
    if (!api || !root) return { api: !!api, root: !!root };
    document.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 240, clientY: 240 }));
    const st = api.state();
    return {
      api: true,
      enabled: st.enabled,
      raf: st.raf,
      x: st.x,
      on: root.dataset.on,
      display: getComputedStyle(root).display,
    };
  })()`);
  await send('Emulation.setEmulatedMedia', { features: [] });
  ok(cfReducedBoot && cfReduced.api && cfReduced.enabled === false && cfReduced.raf === false
    && cfReduced.x === 0 && cfReduced.on === 'false' && cfReduced.display === 'none',
    `减弱动效下跟随层完全不启用（enabled=${cfReduced.enabled} · display=${cfReduced.display} · raf=${cfReduced.raf} · x=${cfReduced.x}）`);

  /* ── UI 身份锁（§171）：官方态无横幅；移除核心外壳后出现非官方横幅，恢复后回到官方 ── */
  console.log('\n── UI 身份锁 ──');
  const idOfficial = await evalJs(`(() => ({
    banner: !!document.querySelector('#banners [data-ui-identity="unofficial"]'),
    mark: document.documentElement.dataset.uiIdentity || '',
    nav: document.querySelectorAll('#nav1 .grp').length,
    page: document.querySelectorAll('#page *').length,
  }))()`);
  ok(!idOfficial.banner && idOfficial.mark === 'official' && idOfficial.nav === 7 && idOfficial.page > 0,
    `官方界面不显示非官方横幅（mark=${idOfficial.mark} · 域=${idOfficial.nav} · 页内容=${idOfficial.page}）`);
  const idBad = await evalJs(`(() => {
    const top = document.querySelector('.topbar');
    const navrow = document.getElementById('navrow');
    if (!top || !navrow) return { skip: true };
    top.remove();
    window.__uiIdentity.check();
    const b = document.querySelector('#banners [data-ui-identity="unofficial"]');
    const bad = { text: (b && b.textContent) || '', mark: document.documentElement.dataset.uiIdentity || '' };
    document.body.insertBefore(top, navrow);
    window.__uiIdentity.check();
    const after = document.querySelector('#banners [data-ui-identity="unofficial"]');
    return {
      skip: false,
      bad,
      after: { banner: !!after, mark: document.documentElement.dataset.uiIdentity || '', page: document.querySelectorAll('#page *').length },
    };
  })()`);
  ok(!idBad.skip && /非官方界面/.test(idBad.bad.text) && idBad.bad.mark === 'unofficial',
    `移除核心外壳后出现非官方横幅（${idBad.bad && idBad.bad.text.slice(0, 48)}）`);
  ok(!idBad.skip && !idBad.after.banner && idBad.after.mark === 'official' && idBad.after.page > 0,
    `恢复外壳后回到官方态且页面仍可操作（mark=${idBad.after && idBad.after.mark} · 页内容=${idBad.after && idBad.after.page}）`);

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
console.log('\n✓ 前端 DOM 守卫通过：首屏 + 检查表 + 逐页遍历（含零运行时错误 / 无白屏页）+ 工厂五页（三 frame + 插件管理 / Skill，二级导航驱动 / 导航浮层可点 / 切帧不重载）+ 插话冷却进度条 + 设置层外观/持久化/窄屏入口 + 二级随内容收缩 + 岛内维护域（7 域，30 页）');
process.exit(0);
