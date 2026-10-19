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
     ⚠️ 必须回到模型页再点 —— 上面的遍历停在最后一页（系统 / 面板维护）。 */
  const brainUi = await evalJs(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const groups = [...document.querySelectorAll('#nav1 .grp')];
    const g = groups.find((x) => /大脑/.test(x.textContent));
    if (!g) return { error: '没找到「大脑」分组' };
    g.click(); await sleep(150);
    const subs = [...document.querySelectorAll('#nav2 .sub')];
    const sub = subs.find((x) => /模型与线路/.test(x.textContent));
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
    // 右键标签 → 与列表行同一份菜单（改名 / 改设置 / 删除）
    const tag = document.querySelector('.brain-tag[data-brain]');
    let menu = null;
    if (tag) {
      tag.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      await sleep(120);
      const btns = [...box.querySelectorAll('button')].map((b) => b.textContent || '');
      menu = {
        open: modalEl.hidden === false,
        title: (box.querySelector('h3') || {}).textContent || '',
        items: btns.join('|'),
      };
      const c2 = box.querySelector('[data-a="__modal-close"]');
      if (c2) c2.click();
    }
    return { first, second, menu };
  })()`);
  console.log('\n── 添加模型：云端 ⇄ 本地 ──');
  ok(!brainUi.error, `打开「＋ 自定义模型」并读到表单（${brainUi.error || 'ok'}）`);
  if (!brainUi.error) {
    ok(brainUi.first.open && /添加自定义模型/.test(brainUi.first.title), `弹窗打开了（${brainUi.first.title}）`);
    ok(brainUi.first.head === '切换到本地模型', `云端模式下标题右侧写「切换到本地模型」（实得「${brainUi.first.head}」）`);
    ok(brainUi.first.hasKey, '云端模式有 API Key 输入框');
    brainUi.second && ok(brainUi.second.head === '切换到云端', `切到本地后按钮变成「切换到云端」（实得「${brainUi.second.head}」）`);
    ok(brainUi.second && brainUi.second.hasKey === false, '本地模式**没有** API Key 输入框（本地不需要 Key）');
    ok(brainUi.second && /127\.0\.0\.1:8080/.test(brainUi.second.base), `本地模式地址默认填本机（实得「${brainUi.second && brainUi.second.base}」）`);
    ok(brainUi.second && brainUi.second.hasWebSearch === false, '本地模式不摆「能联网」（web_search 是智谱形状，本地必然 400）');
  }
  if (brainUi.menu) {
    ok(brainUi.menu.open && /删除/.test(brainUi.menu.items) && /改名字/.test(brainUi.menu.items),
      `标签右键弹出改名 / 删除菜单（标题「${brainUi.menu.title}」· 按钮 ${brainUi.menu.items}）`);
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
    const g = [...document.querySelectorAll('#nav1 .grp')].find((x) => /大脑/.test(x.textContent));
    if (!g) return { error: '没找到「大脑」分组' };
    g.click(); await sleep(120);
    const sub = [...document.querySelectorAll('#nav2 .sub')].find((x) => /模型与线路/.test(x.textContent));
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
    const g = [...document.querySelectorAll('#nav1 .grp')].find((x) => /发言与时机/.test(x.textContent));
    if (!g) return { error: '没找到「发言与时机」分组' };
    g.click(); await sleep(150);
    const sub = [...document.querySelectorAll('#nav2 .sub')].find((x) => /触发方式/.test(x.textContent));
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
}

if (fails.length) {
  for (const p of fails.slice(0, 12)) console.log(`✗ ${p}`);
  console.log(`── ${fails.length} 处问题 ──`);
  process.exit(1);
}
console.log('\n✓ 前端 DOM 守卫通过：首屏 + 检查表 + 逐页遍历（含零运行时错误 / 无白屏页）+ 插话冷却进度条');
process.exit(0);
