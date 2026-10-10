/**
 * ══════════════════════════════════════════════════════════════════════════
 *  新前端的**真实浏览器自检**（零依赖，走 CDP 直连）
 * ══════════════════════════════════════════════════════════════════════════
 *  jsdom 测不出 ES module、也测不出排版；而这个页面两样都用到了。
 *  所以这里直接驱动本机已有的 Edge（headless）跑一遍真渲染：
 *
 *    ① 每个一级域 × 每个页面**都点一遍** —— 抓"白屏 / 点了没反应 / 控件类型没实现"
 *    ② 收集页面控制台与运行时异常 —— 抓"初始化时抛了异常但页面看起来还行"
 *    ③ 整页重复 id 扫描 —— 复制粘贴改结构时最容易出，出了就是"某个控件失灵"
 *    ④ 真实交互一条：草稿页改一个字段 → 底部保存条出现 → 丢弃 → 消失
 *    ⑤ 出整页截图（给"看起来对不对"留证据，不是给逻辑下结论）
 *    ⑥ 灵动岛导航四条（2026-10-02 本轮）：指示器唯一且跟着选中项 · 切换**途中**
 *       确实有形变（逐帧取峰值，不取"90ms 那一帧"）· 三组颜色对**纯黑**的对比度过 AA
 *       —— 全是"坏了不会抛异常、只会看起来不对劲"的那一类。
 *
 *  用法：
 *      node panel/next/verify.mjs            # 默认验 http://127.0.0.1:8788/（控制台就在根上）
 *      node panel/next/verify.mjs --url http://127.0.0.1:8788/
 *      node panel/next/verify.mjs --shot     # 额外出整页截图（默认关，见下）
 *  可选：--url / --out / --width / --shot
 *
 *  ⚠️⚠️ **改这个文件时最容易踩的一脚：`evalJs(\`…\`)` 里不许出现反引号。**
 *      探针是模板字符串，注释里写一个 `` `标识符` `` 就会**提前结束字符串**，
 *      报 `SyntaxError: missing ) after argument list`，而报错行指向探针的**开头**
 *      —— 看起来像"探针写崩了"，其实是几行之后一个装饰性反引号。
 *      本项目在 B30 / B31 两轮各踩一次。要强调标识符就用 `**粗体**`，或用单引号。
 *  ⚠️ 截图**默认关闭**：本机 headless（软件光栅化）在流体层真渲染之后
 *      `Page.captureScreenshot` 会挂起（报 `Detected unsettled top-level await`），
 *      代价不是"少几张图"而是**整条自检跑不到汇总**。要图时显式加 `--shot`，
 *      那时仍有 9 秒超时兜底。
 *
 *  ⚠️ 它验的是**面板自己发的那条路径**（`GET /`）—— 那正是用户点控制台图标
 *     会落到的地址。所以"这里全绿"和"用户能进去"是同一件事，不是两件事。
 *     （2026-10-02 之前控制台挂在 `/next/`，现在唯一控制台挂在**根**上；
 *      老地址由面板做一次 302 兜底，本脚本有一条断言专门盯它。）
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ARG = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
/* 默认指向**面板自己发的那个路由**（不是另起的小服务）：同源、自带 token、
   而且验的就是用户真的会打开的那一条路径（控制台在根上）。 */
const URL_ = ARG('url', 'http://127.0.0.1:8788/');
const OUT = ARG('out', '/tmp/next-verify');
const WIDTH = Number(ARG('width', 1440));
const HEIGHT = 1100;
const DPORT = 9333 + (process.pid % 200);
const PROFILE = `/tmp/cdp-next-${process.pid}`;

const EDGE = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
const CHROME_CANDIDATES = [
  EDGE,
  ...(fs.existsSync(`${process.env.HOME}/Library/Caches/ms-playwright`)
    ? fs.readdirSync(`${process.env.HOME}/Library/Caches/ms-playwright`).filter((d) => d.startsWith('chromium')).map((d) => `${process.env.HOME}/Library/Caches/ms-playwright/${d}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`) : []),
];
const BIN = CHROME_CANDIDATES.find((p) => fs.existsSync(p));
if (!BIN) { console.log('SKIP：本机没有可用的 Chromium 系内核，跳过真实渲染自检'); process.exit(0); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 20000, step = 300) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() - t0 > ms) return null;
    await sleep(step);
  }
}

const results = [];
const check = (name, ok, extra = '') => { results.push({ name, ok: !!ok, extra }); console.log(`${ok ? '✓' : '✗'} ${name}${extra ? ` — ${extra}` : ''}`); };
/**
 * **显式跳过**（第 57 轮 B1+ · 与文件头"没有 Chromium 就 SKIP"同一条纪律）。
 *
 * 什么时候该用它：**断言的前提在这个环境里根本不成立**，而不是"这次碰巧没数据"。
 * 本文件的用法只有一处 —— 插件板那 5 条要求「≥1 块板」，而沙箱
 * （`test/sandbox.sh:121` `--exclude '/plugins/' --exclude '/skills/'`，第 44 轮 B12d 起）
 * 里 `state.extensions.items` 恒为 0 ⇒ 那 5 条**在这个路径上永远不可能成立**。
 *
 * 为什么不用"让它红着"：常驻假红 = 训练人忽略红，而本项目在别处明确反对这件事。
 * 为什么**不许**把它算成通过：那正是本项目最贵的那一类 —— "真空里通过"打出来
 * 和真通过一模一样，下一个人会以为这 5 条验过了。所以它单独计数、单独打印。
 *
 * ⚠️ 代价要如实写：这 5 条在沙箱路径上**从此不再被验**。它们只在**真机**
 * （仓库里有 `plugins/`）跑本脚本时才真的生效 —— 想恢复，改沙箱的排除清单。
 */
const skip = (name, reason) => { results.push({ name, ok: true, skipped: true, extra: reason }); console.log(`⏭ ${name} — **跳过**：${reason}`); };

fs.mkdirSync(OUT, { recursive: true });

/* ── ⓪ 纯 HTTP 预检：不启浏览器就能抓住"HTML 到了但资产 404"这一类白屏 ──────
   为什么必须有这一步（实测踩到过）：入口页里的资产是**相对路径**（`./app.js`）。
   当 URL 是 `/next`（末尾没斜杠）时，浏览器把 `./app.js` 解析成 `/app.js` ——
   而 `curl /next` 是 200、`curl /next/app.js` 也是 200，**两个都对**，
   坏的是"它们之间的相对关系"。这种故障只有按**浏览器的算法**重算一次才发现得了。
   所以这里用 `new URL(ref, resp.url)`（resp.url 是跟随跳转后的最终地址）来解析。 */
async function preflight() {
  let entry;
  try {
    entry = await fetch(URL_, { redirect: 'follow' });
  } catch (e) {
    check('入口页能取到', false, `${URL_} —— ${e.message}`);
    return;
  }
  if (!entry.ok) { check('入口页能取到', false, `HTTP ${entry.status}`); return; }
  const html = await entry.text();
  const refs = [...html.matchAll(/(?:src|href)="\.\/([\w.-]+)"/g)].map((m) => m[1]);
  const bad = [];
  for (const r of refs) {
    const u = new URL(r, entry.url);   // ← 与浏览器同一套解析算法（用最终 URL 当基准）
    const res = await fetch(u, { method: 'HEAD' }).catch(() => null);
    if (!res || !res.ok) bad.push(`${r} → ${u.pathname} HTTP ${res ? res.status : '连接失败'}`);
  }
  check('入口页的相对资产都能取到（按最终 URL 解析）', refs.length > 0 && bad.length === 0,
    bad.length ? bad.join(' · ') : `${refs.join(' / ')} 全部 200`);
  /* 结尾斜杠是这条链的**前提**：少了它上面那条就会红 —— 但红得看不懂（".../app.js 404"）。
     所以单独说清一次，让下一个人一眼知道该改哪儿。 */
  if (!entry.url.endsWith('/')) {
    check('带斜杠的入口（相对资产的前提）', false, `最终地址是 ${entry.url} —— 少了结尾斜杠`);
  } else check('带斜杠的入口（相对资产的前提）', true);

  /* 老地址 `/next/` 必须**跳**到根上（2026-10-02 控制台搬家）。
     不跳的话：书签、浏览器里开着的那个旧标签、以及更早版本的启动器都会打到 404 ——
     而我们自己的验证脚本也曾经默认用那个地址，所以这条要能自己站住。
     判据取**不跟随跳转**的那一次响应：跟到底拿到 200 并不能证明中途对了。 */
  const legacy = await fetch(new URL('/next/', entry.url), { redirect: 'manual' }).catch(() => null);
  const loc = legacy ? (legacy.headers.get('location') || '') : '';
  check('老地址 /next/ 被 302 到根（书签不会打到 404）',
    !!legacy && [301, 302, 307, 308].includes(legacy.status) && (loc === '/' || loc.endsWith('/') && !loc.includes('/next')),
    legacy ? `HTTP ${legacy.status} → ${loc || '(无 Location)'}` : '取不到 /next/');
  /* 反向也要判：根上的资产由面板**分发**，取不到就是白屏（而 HTML 可能照样 200）。
     这里只探一个（`app.js`）—— 全量由浏览器那一段断言。 */
  const js = await fetch(new URL('app.js', entry.url), { method: 'HEAD' }).catch(() => null);
  check('根上的资产真的可达（app.js）', !!js && js.ok, js ? `HTTP ${js.status}` : '连接失败');
}
await preflight();

/* ── 起浏览器 ─────────────────────────────────────────────────────────── */
const chrome = spawn(BIN, [
  '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
  '--headless', `--remote-debugging-port=${DPORT}`,
  `--user-data-dir=${PROFILE}`, `--window-size=${WIDTH},${HEIGHT}`,
  '--hide-scrollbars', '--no-first-run', '--no-default-browser-check', 'about:blank',
], { stdio: 'ignore', detached: true });
chrome.unref();

const cleanup = () => { try { process.kill(-chrome.pid, 'SIGKILL'); } catch { /* 已退 */ } try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch { /* 忽略 */ } };
process.on('exit', cleanup);

const page = await waitFor(async () => {
  const l = await (await fetch(`http://127.0.0.1:${DPORT}/json/list`)).json();
  return l.find((x) => x.type === 'page' && x.webSocketDebuggerUrl);
}, 25000, 400);
if (!page) { console.log('SKIP：浏览器起来了但没拿到调试页（受限环境常见），跳过真实渲染自检'); cleanup(); process.exit(0); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let seq = 0; const pend = new Map();
const errors = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return; }
  if (m.method === 'Runtime.exceptionThrown') errors.push('异常：' + (m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text || ''));
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push('console.error：' + m.params.args.map((a) => a.value ?? a.description).join(' '));
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'warning') errors.push('console.warn：' + m.params.args.map((a) => a.value ?? a.description).join(' '));
};
const send = (method, params = {}) => new Promise((r) => { const id = ++seq; pend.set(id, r); ws.send(JSON.stringify({ id, method, params })); });

/** 在页面里求值。⚠️ 顶层 let/const 不是 window 的属性，所以表达式里不带 window. 前缀。
 *
 *  ⚠️⚠️ 外包函数必须是 **async**：`Runtime.evaluate` 的表达式**不在 async 上下文**里，
 *      写成 `(() => { … })()` 时，探针里任何一句 `await` 都会变成
 *      `SyntaxError: await is only valid in async functions`。
 *      那报错**发生在页面侧**，把整条自检脚本打崩在 evalJs 上 ——
 *      看起来像"被测功能坏了"，实际是探针写不出来。本项目踩过一次
 *      （六团流体那一轮的 `Page.captureScreenshot` 之后，这里又踩）。
 *      配 `awaitPromise: true` 之后，`(async () => {…})()` 让"表达式里能写 await"
 *      变成一件不需要每次绕的事。 */
async function evalJs(expr) {
  const m = await send('Runtime.evaluate', { expression: `(async () => { ${expr} })()`, returnByValue: true, awaitPromise: true });
  if (m.result?.exceptionDetails) throw new Error(m.result.exceptionDetails.exception?.description || m.result.exceptionDetails.text);
  return m.result?.result?.value;
}

await send('Page.enable'); await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, deviceScaleFactor: 2, mobile: false });
await send('Page.navigate', { url: URL_ });

/* ⚠️ 必须等到**首屏那次 /api/state 回来**再读状态：只等"导航与卡片出来了"是不够的
   （骨架先渲染、数据后到），那时 `S.state` 还是 null、`S.online` 还是 false，
   会把"在线"误判成"演示模式"。这不是产品的问题，是等待窗口开早了。 */
const ready = await waitFor(() => evalJs('return document.querySelectorAll("#nav1 .grp").length > 0 && document.querySelectorAll("#page .card").length > 0 && !!(window.__next && (window.__next.online || window.__next.state))'), 25000, 400);
if (!ready) { check('页面渲染出导航与卡片', false, '首屏没起来 —— 可能是白屏或后端不通'); }
else check('页面渲染出导航与卡片', true);

/* ── ① 每个域 × 每个页面都点一遍 ─────────────────────────────────────── */
const nav = await evalJs(`return {
  groups: [...document.querySelectorAll('#nav1 .grp')].map(b => b.textContent.trim()),
  hasHook: typeof window.__next === 'object' && !!window.__next,
  online: !!(window.__next && window.__next.online),
  provider: (window.__next && window.__next.state && window.__next.state.config) ? window.__next.state.config.provider : null,
  model: (window.__next && window.__next.state && window.__next.state.effective) ? window.__next.state.effective.model : null,
  demoBanner: !!document.querySelector('.banner.info'),
  staleAttrs: document.querySelectorAll('[data-act]').length,
}`);
const groupCount = (nav?.groups || []).length;
check('一级域数量 = 8', groupCount === 8, `实测 ${groupCount}`);
check('拿到真实后端数据（非演示模式）', !!nav?.online,
  `__next=${nav?.hasHook ? '有' : '无'} provider=${nav?.provider ?? '?'} model=${nav?.model ?? '?'} 演示条=${nav?.demoBanner}`);
check('静态标记里没有失效的 data-act 属性', nav?.staleAttrs === 0, `data-act=${nav?.staleAttrs}`);

let pagesChecked = 0; let cardsTotal = 0; const badPages = [];
for (let g = 0; g < groupCount; g += 1) {
  await evalJs(`document.querySelectorAll('#nav1 .grp')[${g}].click(); return 1;`);
  await sleep(120);
  const subCount = await evalJs(`return document.querySelectorAll('#nav2 .sub').length`);
  for (let s = 0; s < subCount; s += 1) {
    await evalJs(`document.querySelectorAll('#nav2 .sub')[${s}].click(); return 1;`);
    await sleep(160);
    const r = await evalJs(`return {
      cards: document.querySelectorAll('#page .card').length,
      text: (document.getElementById('page').textContent || '').length,
      broke: [...document.querySelectorAll('#page .card')].filter(c => c.textContent.includes('没有实现的控件类型') || c.textContent.includes('渲染「')).length,
      title: (document.querySelector('#page h1')?.textContent || '').trim(),
    }`);
    pagesChecked += 1; cardsTotal += r.cards;
    if (!r.cards || !r.text || r.broke) badPages.push(`${nav.groups[g]}/${r.title}(cards=${r.cards}, broke=${r.broke})`);
  }
}
check('每个页面都渲染出了卡片', badPages.length === 0, badPages.length ? badPages.join(' · ') : `共 ${pagesChecked} 页 / ${cardsTotal} 张卡`);

/* 只浏览不该产生"未保存改动"。列表类渲染器会把当前数组快照进草稿，
   如果拿"草稿有几个键"当改动计数，光打开页面就会显示脏、并且让轮询永久停更。
   —— 这条断言就是钉住那个 bug 的。 */
const dirtyAfterTour = await evalJs('return window.__next ? window.__next.dirty.size : -1');
check('只浏览不产生未保存改动（列表快照不算改动）', dirtyAfterTour === 0, `dirty=${dirtyAfterTour}`);

/* ── ② 重复 id ───────────────────────────────────────────────────────── */
await evalJs(`document.querySelectorAll('#nav1 .grp')[0].click(); document.querySelectorAll('#nav2 .sub')[0].click(); return 1;`);
await sleep(150);
const dupIds = await evalJs(`const all=[...document.querySelectorAll('[id]')].map(e=>e.id); return all.filter((x,i)=>all.indexOf(x)!==i);`);
check('整页没有重复 id', (dupIds || []).length === 0, (dupIds || []).join(', '));

/* ── ②b 灵动岛导航（2026-10-02 · 本轮）────────────────────────────────────
   四条，全是"坏了不会报错"的那种：
     · 指示器存在且**唯一** / 同时只有一个选中项 —— 两个滑块或两个 aria-selected
       都不会抛异常，只是看起来"高亮跑到别的地方去了"；
     · 指示器真的**跟着选中项**（位移与宽度对齐）—— 位置由 JS 写上去，
       算错坐标系它只会安静地停在别处，看起来像"动画没做完"；
     · 切换**途中**确实有形变（速度→拉伸，且面积守恒）—— 这是从 GooeyNav 取来的
       唯一视觉内核，它坏了没有任何别的症状（滑块照样到位，只是"不液体"）；
     · 三个前景色对**纯黑**的对比度都过 AA —— 这三处是全页唯一自带反色的组件，
       没有"深色下自动变浅"的退路，只能按黑底算。 */
const island = await evalJs(`return {
  ind: !!document.getElementById('navInd'),
  inds: document.querySelectorAll('#nav1 .nav-ind').length,
  sels: document.querySelectorAll('#nav1 .grp[aria-selected="true"]').length,
}`);
check('灵动岛：指示器在且**唯一**，同时只有一个选中项',
  island?.ind && island.inds === 1 && island.sels === 1, JSON.stringify(island));

/* 灵动岛对比度 —— ⚠️⚠️ 2026-10-03 B29 **整条重写**。
 * 旧版的两个缺陷（都是"看起来在守着，实际什么都没查"）：
 *   ① `hex()` 只认 6 位纯 hex ⇒ `--c-nav-bg` 一旦改成 rgba()（玻璃化之后必然如此）
 *      就返回 null ⇒ 断言报「取不到 --c-nav-* 令牌」。**那是误导性的红**：
 *      令牌好好地定义着，只是解析器不认它的格式。
 *   ② 底色与前景色**都从同一套令牌现算** ⇒ 只要成对改成任何过 4.5 的组合就永远绿。
 *      它验证的是"令牌自洽"，不是"页面上看得见"。
 * 现在改成：真读 **computed style**，并按 alpha **合成到实测背板**上再算。
 * 这样三种失效都会红：令牌忘了 alpha / background 被后规则覆盖 / `eg-on` 没加上
 * （玻璃态整条不生效）—— 旧版对这三种**全部沉默**。
 * ⚠️ 抽成函数是刻意的：深浅两个主题要用**同一条**判据逻辑，
 *    复制一份就是本项目明令禁止的「同一份语义两份拷贝」。 */
const islandContrast = () => evalJs(`
  const parse = (v) => {
    const s = String(v || '').trim();
    let m = s.match(/^#([0-9a-f]{6})$/i);
    if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)).concat([1]);
    m = s.match(/^rgba?\\(([^)]+)\\)$/i);
    if (!m) return null;
    const p = m[1].split(/[,\\s/]+/).filter(Boolean).map(Number);
    return p.length >= 3 ? [p[0], p[1], p[2], p.length > 3 ? p[3] : 1] : null;
  };
  const lum = (c) => { const f = (x) => { const s = x / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
  const ratio = (a, b) => { const l1 = lum(a), l2 = lum(b); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); };
  const over = (fg, bg) => fg.slice(0, 3).map((v, i) => v * fg[3] + bg[i] * (1 - fg[3]));

  const isle= getComputedStyle(document.getElementById('navInner'));
  /*⚠️ **默认项与选中项必须分别取，且默认项要排除选中项** ——
     首次渲染时 \`S.gi = 0\`，所以 \`querySelector('.grp')\` 取到的**就是选中项**
     （实测：三个值会全都是同一个，判据变成"自己和自己比"）。
     这类"看起来在验、其实没验"的形态必须当场抓出来，而不是等它变成假绿。 */
  const on   = document.querySelector('#navInner .grp[aria-selected="true"]');
  const off  = document.querySelector('#navInner .grp[aria-selected="false"]');
  const ind  = getComputedStyle(document.getElementById('navInd'));
  const body = getComputedStyle(document.body);
  if (!on || !off) return { err: '未同时找到选中项与未选中项', has: { on: !!on, off: !!off } };

  // 背板：body 的 computed backgroundColor（青调底）。⚠️ 玻璃是半透明的，
  // 所以岛底要先合成到背板上，得到的才是**眼睛真正看到的那个 rgb**。
  const back = parse(body.backgroundColor) || [255, 255, 255, 1];
  const base = over(parse(isle.backgroundColor) || [0, 0, 0, 0], back);
  const ringOn = over(parse(ind.borderTopColor) || [0, 0, 0, 0], base);
  return {
    base: 'rgb(' + base.slice(0, 3).map(Math.round).join(',') + ')',
    veil: isle.backgroundColor,
    filter: isle.backdropFilter === 'none' ? '无（玻璃未生效！）' : isle.backdropFilter.slice(0, 22),
    fg:ratio(parse(getComputedStyle(off).color), base),
    on:  ratio(parse(getComputedStyle(on).color),  base),
    ring: ratio(ringOn, base),
  };
`);
const islandLight = await islandContrast();
check('灵动岛对比度（浅色 · 对实测合成底）：默认字 ≥4.5 · 选中字 ≥4.5 · 描边 ≥3',
  !!islandLight && !islandLight.err
    && islandLight.fg >= 4.5 && islandLight.on >= 4.5 && islandLight.ring >= 3
    /* ⚠️ 默认字必须**严格弱于**选中字（`on` 是更深的墨 ⇒ 对亮底比值更高）。
       这条不写，"默认与选中取到同一个元素"那种假绿就又回来了（实测踩过：
       首次渲染 S.gi=0，`querySelector('.grp')` 取到的就是选中项，三值全同）。 */
    && islandLight.on > islandLight.fg,
  islandLight && islandLight.err ? `取源失败：${islandLight.err}（有选中 ${islandLight.has?.on} / 有未选中 ${islandLight.has?.off}）`
    : islandLight ? `合成底 ${islandLight.base}（veil ${islandLight.veil} · ${islandLight.filter}）`
      + ` · 默认 ${islandLight.fg.toFixed(2)}:1 · 选中 ${islandLight.on.toFixed(2)}:1 · 描边 ${islandLight.ring.toFixed(2)}:1`
    : '取不到灵动岛的 computed 样式');

/* 深色主题：**用同一个函数**跑一遍（不复制判据逻辑）—— 灵动岛现在跟随主题，
   只在浅色下验等于深色下完全没验，而深色的取值是独立写的。
   ⚠️⚠️ **必须切回 light**：后续二十多条断言（含帧率那条）跑在深色下
   会测完全不同的负载，帧率与逐帧探针的结果全部不可比。 */
await evalJs(`document.documentElement.dataset.theme = 'dark'; return 1;`);
await sleep(360);   /* 等 backdrop-filter 在新底色上重采样一帧 */
const islandDark = await islandContrast();
check('灵动岛对比度（深色 · 对实测合成底）：默认字 ≥4.5 · 选中字 ≥4.5 · 描边 ≥3',
  !!islandDark && !islandDark.err
    && islandDark.fg >= 4.5 && islandDark.on >= 4.5 && islandDark.ring >= 3
    && islandDark.on > islandDark.fg,
  islandDark ? `合成底 ${islandDark.base}（veil ${islandDark.veil}）`
    + ` · 默认 ${islandDark.fg.toFixed(2)}:1 · 选中 ${islandDark.on.toFixed(2)}:1 · 描边 ${islandDark.ring.toFixed(2)}:1`
    : '取不到灵动岛的 computed 样式');
await evalJs(`document.documentElement.dataset.theme = 'light'; return 1;`);
await sleep(360);


/* 从第 1 项跳到第 8 项（跨半屏），逐帧取 transform 的**峰值**形变。
   逐帧而不是取某一时刻：弹簧在 ~230ms 内收敛，"90ms 那一帧"只是经验值；
   逐帧取 max 与帧率无关，这个判据才不会随机器快慢飘。 */
await evalJs(`document.querySelectorAll('#nav1 .grp')[0].click(); return 1;`);
await sleep(700);
await evalJs(`document.querySelectorAll('#nav1 .grp')[7].click(); return 1;`);
const flight = await evalJs(`
  const ind = document.getElementById('navInd');
  return (async () => {
    let best = { sx: 1, sy: 1, tx: 0 };
    for (let i = 0; i < 24; i += 1) {
      const m = new DOMMatrixReadOnly(getComputedStyle(ind).transform);
      if (m.a > best.sx) best = { sx: m.a, sy: m.d, tx: m.e };
      await new Promise((r) => requestAnimationFrame(r));
    }
    return best;
  })();
`);
check('切换途中有速度驱动的形变（横向拉伸 · 纵向压缩 · 面积守恒）',
  !!flight && flight.sx > 1.002 && flight.sy < 0.999 && Math.abs(flight.sx * flight.sy - 1) < 0.01,
  flight ? `峰值 scaleX=${flight.sx.toFixed(4)} scaleY=${flight.sy.toFixed(4)} 乘积=${(flight.sx * flight.sy).toFixed(4)}` : '取不到');

await sleep(600);
const indFit = await evalJs(`
  const ind = document.getElementById('navInd');
  const sel = document.querySelector('#navInner .grp[aria-selected="true"]');
  if (!ind || !sel) return null;
  const m = new DOMMatrixReadOnly(getComputedStyle(ind).transform);
  return { tx: m.e, x: sel.offsetLeft, sx: m.a, w: parseFloat(getComputedStyle(ind).width), sw: sel.offsetWidth,
    label: sel.textContent.trim(), ready: ind.classList.contains('ready') };
`);
check('指示器停在选中项上（位移与宽度都对得上）',
  !!indFit && indFit.ready && Math.abs(indFit.tx - indFit.x) < 1.5 && Math.abs(indFit.w - indFit.sw) < 1.5,
  indFit ? `${indFit.label} · tx=${indFit.tx.toFixed(1)} vs x=${indFit.x} · w=${indFit.w.toFixed(1)} vs ${indFit.sw}` : '取不到');

/* 文案里的 `**粗体**` 必须被渲染成 <b>；漏了会在页面上留下字面量星号。 */
const starText = await evalJs(`return (document.body.innerText.match(/\\*\\*[^*\\n]{1,40}\\*\\*/g) || []).slice(0,3)`);
check('页面上没有未渲染的字面量星号', !starText || starText.length === 0, (starText || []).join(' | '));

/* ── ②· 背景引擎（canvas 颗粒渐变）+ 玻璃背板（2026-10-04 · 接替六团流体）──────
 * ⚠️ 这组断言查的是 **DOM 与计算样式**（层序、pointer-events、预设闭集合、
 *    帧计数递增），证明"结构接上了、真的在动"；"好不好看"靠人眼与截图。
 * ⚠️ 帧计数（window.ShaderBG.frames）是引擎自己暴露的只读计数器 ——
 *    取 900ms 内的增量证明 rAF 循环真的在跑，比查动画名更硬
 *    （canvas 没有可查的 animation-name，且 toDataURL 在无 preserveDrawingBuffer
 *    的 WebGL 上读不到像素）。 */
const backplate = await evalJs(`
  const env = getComputedStyle(document.body, "::before");
  const root = getComputedStyle(document.documentElement);
  const cv = document.getElementById('shaderBg');
  if (!cv) return { missing: true };
  const cs = getComputedStyle(cv);
  const sb = window.ShaderBG || null;
  return {
    egZ: env.zIndex === "auto" ? 0 : Number(env.zIndex),
    egLayers: (env.backgroundImage.match(/gradient\\(/g) || []).length,
    egBg: env.backgroundImage !== "none",
    bgHex: root.getPropertyValue("--c-bg").trim(),
    z: cs.zIndex, pe: cs.pointerEvents, pos: cs.position,
    hasSB: !!sb, variants: sb ? sb.VARIANTS.length : 0,
    ids: sb ? sb.VARIANTS.map(v => v.id) : [],
    frames: sb ? sb.frames : -1,
    swatches: document.querySelectorAll('#bgPickList [role="radio"]').length,
    checked: document.querySelectorAll('#bgPickList [aria-checked="true"]').length,
  };
`);
check('背景 canvas 真的挂进 DOM 且是 fixed + z=-2 + 不吃点击（层序与旧流体层同规）',
  !!backplate && !backplate.missing && backplate.pos === 'fixed'
    && Number(backplate.z) === -2 && backplate.pe === 'none',
  backplate && !backplate.missing
    ? 'pos=' + backplate.pos + ' · z=' + backplate.z + ' · pe=' + backplate.pe
    : 'DOM 里没有 #shaderBg');
check('玻璃背板仍在内容之下（z=-1）且真的有层次（删掉玻璃就读成半透明纸）',
  !!backplate && !backplate.missing && backplate.egZ === -1
    && backplate.egBg && backplate.egLayers >= 5,
  backplate && !backplate.missing
    ? '玻璃背板=' + backplate.egZ + ' · 背景层=' + backplate.egLayers + ' · 页面底=' + backplate.bgHex
    : '取不到');
check('背景引擎已接线：window.ShaderBG 在、预设 ≥6 且两个重点预设（粉彩/落日）在闭集合里',
  !!backplate && !backplate.missing && backplate.hasSB && backplate.variants >= 6
    && backplate.ids.indexOf('grain-pastel') >= 0 && backplate.ids.indexOf('grain-sunset') >= 0,
  backplate && !backplate.missing
    ? 'variants=' + backplate.variants + ' · ' + backplate.ids.join(',')
    : '取不到');
check('顶栏背景选择器已挂载：swatch 数 == 预设数，且恰有一个选中',
  !!backplate && !backplate.missing && backplate.swatches === backplate.variants
    && backplate.variants >= 6 && backplate.checked === 1,
  backplate && !backplate.missing
    ? 'swatches=' + backplate.swatches + ' · checked=' + backplate.checked
    : '取不到');

/* 逐帧证据：背景**真的在动** —— 900ms 内帧计数必须前进。
 * ⚠️ 用引擎暴露的 frames 计数，而不是读像素：WebGL canvas 默认不带
 *    preserveDrawingBuffer，toDataURL 会拿到空白；计数器不撒谎。 */
const flow = await evalJs(`
  return (async () => await new Promise(res => {
    const sb = window.ShaderBG;
    if (!sb) return res(null);
    const a = sb.frames;
    const t0 = performance.now();
    setTimeout(() => res({ delta: sb.frames - a, cv: !!document.getElementById('shaderBg') }), 900);
  }))();
`);
check('背景真的在动（900ms 内帧计数前进；WebGL 或 2D 兜底都在走）',
  !!flow && flow.cv && flow.delta >= 2,
  flow ? '900ms 内帧增量=' + flow.delta : '取不到');

/* 切换真的生效：点一个 swatch → ShaderBG.current 变、aria-checked 跟着走、
 * localStorage 落了盘。选**最后一个**预设，避免与默认值同 id 造成假绿。 */
const pick = await evalJs(`
  return (async () => await new Promise(res => {
    const sb = window.ShaderBG;
    const list = document.getElementById('bgPickList');
    if (!sb || !list) return res(null);
    const before = sb.current;
    const btns = [...list.querySelectorAll('[role="radio"]')];
    const target = btns[btns.length - 1];
    const want = target.dataset.id;
    if (want === before) return res({ skip: true, want });
    target.click();
    setTimeout(() => {
      const after = sb.current;
      res({
        before, want, after,
        checkedOk: target.getAttribute('aria-checked') === 'true',
        stored: (function () { try { return localStorage.getItem('qqbot-bgfx'); } catch (e) { return null; } })(),
        ring: !!list.querySelector('.bg-ring'),
        darkCls: document.documentElement.classList.contains('bg-dark'),
      });
    }, 120);
  }))();
`);
check('点 swatch 真的切换背景（current 变 + aria-checked 跟随 + localStorage 持久化）',
  !!pick && !pick.skip && pick.after === pick.want && pick.checkedOk && pick.stored === pick.want,
  pick ? (pick.skip ? '目标即当前项，跳过（预设在首位时会这样）' : 'before=' + pick.before + ' → after=' + pick.after + ' · stored=' + pick.stored) : '取不到');
check('深底档挂上 html.bg-dark（最后一档 grain-dawn 是深底 —— 卡片外的字要翻浅色）',
  !!pick && !pick.skip && pick.darkCls === true,
  pick ? 'bg-dark=' + pick.darkCls : '取不到');
/* 清理：把选择还原成默认（本节的副作用不许留给后面的用例） */
await evalJs(`
  (function () {
    try { localStorage.removeItem('qqbot-bgfx'); } catch (e) {}
    if (window.ShaderBG) window.ShaderBG.set(window.ShaderBG.VARIANTS[0].id);
    const list = document.getElementById('bgPickList');
    if (list) { const b = list.querySelector('[data-id="' + window.ShaderBG.current + '"]'); if (b) b.click(); }
  })();
  return true;
`);
check('还原浅底档后 html.bg-dark 摘掉（这条副作用不许过夜）',
  await evalJs(`return !document.documentElement.classList.contains('bg-dark')`), '');

/* ── ②'' resize 防抖（B32 · 2026-10-04 新增）─────────────────────────────────
 * 判据不是"有没有 setTimeout"（那判据写完就绿，谁都能过），而是**行为层**：
 * 连续触发 24 次 resize，量"因 resize 而多画了几帧"。
 *
 * ⚠️⚠️ **量之前必须先停掉 rAF 主循环** —— 这是本条第一版踩的坑：
 *   第一版直接量 frames 增量，拿到 **47**（比 24 还多），一度以为防抖写错了。
 *   真因是**主循环本身每帧都在画**（96ms 里正常画了 47 帧），
 *   混在里面根本分不清谁贡献的 —— 量错了对象，判据就永远红。
 *   正确做法：`Emulation.setEmulatedMedia` 模拟 reduced-motion，主循环会自己
 *   停在 `startLoop()` 的第一行（真停，不是放慢）⇒ 之后的 frames 只由 resize 贡献。
 *   ⚠️ 这条依赖引擎的 reduced 接线是真的（契约 ②' 另有 reduced 判据），
 *   若哪天主循环不再听 reduced，本条会退化成"增量 0"从而假绿 —— 故给下限 1。
 *
 * 防抖生效时：24 次连发只落地 1 次尾帧 ⇒ 增量 1–6。
 * 不防抖时：24 次各画一次 ⇒ 增量 ≈24，差一个数量级，噪声压不住。 */
const rzMedia = await send('Emulation.setEmulatedMedia', {
  features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
}).catch(() => null);
await sleep(500);                       // 等 matchMedia 变化事件把主循环停掉
const rz = await evalJs(`
  return (async () => await new Promise(res => {
    const sb = window.ShaderBG;
    const cv = document.getElementById('shaderBg');
    if (!sb || !cv) return res(null);
    const f0 = sb.frames;
    let i = 0;
    /* 每次 dispatch 之间隔 4ms：同步连发会被浏览器合并成一次事件，
       量到的 frames 增量会是 0 —— 那是"事件没分开"而不是"防抖住了"。 */
    const tick = () => {
      window.dispatchEvent(new Event('resize'));
      i += 1;
      if (i < 24) return setTimeout(tick, 4);
      setTimeout(() => res({ delta: sb.frames - f0, reducedNow: matchMedia('(prefers-reduced-motion: reduce)').matches }), 450);
    };
    tick();
  }))();
`);
check('resize 防抖真的生效（24 次连发 → 重画次数是个位数，不是 24 次）',
  !!rz && rz.reducedNow && rz.delta >= 1 && rz.delta <= 6,
  rz ? 'frames 增量=' + rz.delta + ' 次（不防抖会是 24 次）· reduced=' + rz.reducedNow : '取不到');
/* 复原：撤掉模拟的 reduced，否则后面的组全在"不动"状态下跑（会假绿）。 */
await send('Emulation.setEmulatedMedia', { features: [] }).catch(() => null);
await sleep(300);

/* ── ②''' 预设对象缓存与 currentId 同步（B32）───────────────────────────────
 * 这条判的是**上一条优化的正确性**，不是它的性能。
 * 隐患很具体：主循环用缓存的 `curVariant` 取 speed 与配色，
 * 若 `setVariant` 忘了同步它，currentId 变了而画面不变 ——
 * 症状是「点落日、还是粉彩的流动」，字段全对、只有画面不对，最难查的那一类。
 * 判法：切到与默认**不同**的预设，取 canvas 像素 —— WebGL canvas 不带
 * preserveDrawingBuffer，故不能读像素；改用**引擎自报**：暴露当前预设的 id。 */
const sync = await evalJs(`
  return (async () => await new Promise(res => {
    const sb = window.ShaderBG;
    if (!sb) return res(null);
    const other = sb.VARIANTS.find(v => v.id !== sb.current);
    if (!other) return res({ skip: true });
    sb.set(other.id);
    setTimeout(() => {
      const got = sb.variantId;
      const want = other.id;
      sb.set(sb.VARIANTS[0].id);          // 还原，别把后续组留在别的预设上
      res({ want, got, ok: got === want });
    }, 120);
  }))();
`);
check('预设缓存与 currentId 同步（切预设后引擎自报的 id 真的跟着变）',
  !sync || sync.skip || sync.ok,
  sync && !sync.skip ? '切到 ' + sync.want + ' → 引擎自报 ' + sync.got : '只有一个预设，跳过');

/* ── ②' 液态玻璃（2026-10-03 强化轮）──────────────────────────────────────────
 * 这一组判的是**玻璃真的生效**，而不是"CSS 里有这些字"。
 * ⚠️ 为什么必须用**计算样式**而不是截图：本机 headless 是 `--disable-gpu` 软件
 *    光栅化，`Page.captureScreenshot` 在流体层真渲染后会挂起（实测连跑两次
 *    稳定失败）。计算样式是浏览器**已经算完**的值 —— 它回答"规则有没有落地"，
 *    比截图更直接；"好不好看"才是截图的事。
 *
 * 静态层（§60 ⑥f）保证这些值不会被静默改掉、不会漏配深色；
 * 本组保证它们**真的作用到了元素上** —— 两者缺一，就是本项目头号风险
 * 「断言存在 ≠ 断言接线」。 */
const glass = await evalJs(`
  const g = function (sel) {
    const el = document.querySelector(sel);
    if (!el) return null;
    const cs = getComputedStyle(el);
    return { bg: cs.backgroundColor, bf: cs.backdropFilter || cs.webkitBackdropFilter || '',
             insets: (cs.boxShadow.match(/inset/g) || []).length,
             shadow: cs.boxShadow };
  };
  const env = getComputedStyle(document.body, '::before');
  const modal = getComputedStyle(document.querySelector('.modal'));
  const root = getComputedStyle(document.documentElement);
  const alphaOf = (rgb) => { const m = /[\\d.]+,\\s*([\\d.]+)\\)/.exec(rgb || ''); return m ? Number(m[1]) : null; };
  return {
    card: g('.card'), topbar: g('.topbar'), modalbox: g('.modal-box'),
    modalBackdrop: modal.backdropFilter || modal.webkitBackdropFilter || 'none',
    envLayers: (env.backgroundImage.match(/gradient\\(/g) || []).length,
    envSizes: env.backgroundSize.split(',').length,
    envBg: env.backgroundImage !== 'none',
    veil: alphaOf(root.getPropertyValue('--c-eg-surface')),
    blur1: root.getPropertyValue('--c-eg-blur-1').trim(),
    blur2: root.getPropertyValue('--c-eg-blur-2').trim(),
    cardVeil: alphaOf(g('.card') ? g('.card').bg : ''),
  };
`);
check('玻璃：两档模糊真的不同且都落地（层次差在计算样式上成立）',
  !!glass && glass.blur1 !== glass.blur2
    && /blur/.test(glass.card.bf) && /blur/.test(glass.topbar.bf),
  glass ? `第1档=${glass.blur1}（${glass.topbar.bf.slice(0, 22)}）· 第2档=${glass.blur2}（${glass.card.bf.slice(0, 22)}）` : '取不到');

check('玻璃：卡片的 backdrop-filter 真的落地（不是被浏览器丢弃）',
  !!glass && glass.card && glass.card.bf !== '' && glass.card.bf !== 'none'
    && glass.card.bg !== 'rgba(0, 0, 0, 0)',
  glass && glass.card ? `bg=${glass.card.bg} · bf=${glass.card.bf}` : '取不到');

check('玻璃：卡片的边缘高光有厚度层且是成对的 inset（"润"与"厚度"）',
  !!glass && glass.card && glass.card.insets >= 6
    && /inset/.test(glass.card.shadow) && /rgba\(0, 0, 0, 0\.[0-9]+\)/.test(glass.card.shadow),
  glass && glass.card ? `inset 层数=${glass.card.insets}（应 ≥6：4 对角 +vol-top + 厚度）` : '取不到');

check('玻璃：白纱真的薄到 .40–.52（"透亮感"的唯一杠杆）',
  !!glass && glass.cardVeil !== null && glass.cardVeil >= 0.40 && glass.cardVeil <= 0.52,
  glass ? `卡片实测白纱 alpha=${glass.cardVeil}（令牌 ${glass.veil}）` : '取不到');

check('玻璃：环境层的层数 == 尺寸数（多出的层会静默退回 auto）',
  !!glass && glass.envBg && glass.envLayers === glass.envSizes && glass.envLayers >= 5,
  glass ? `渐变层=${glass.envLayers} · 尺寸项=${glass.envSizes}` : '取不到');

check('玻璃：弹窗没被背景根掐断（.modal 不许有 backdrop-filter）',
  !!glass && glass.modalBackdrop === 'none',
  glass ? `.modal 的 backdrop-filter=${glass.modalBackdrop}（必须 none，否则 .modal-box 只采样到 scrim）` : '取不到');

/* 帧率：本轮只加纹理与阴影（不新增图层），帧时间应与上轮持平。
 * ⚠️ 阈值 90ms 是**软件光栅化**下定的（上轮实测 46ms），真机 GPU 远低于此。 */
const fps = await evalJs(`
  return (async () => await new Promise(res => {
    const g = []; let last = performance.now(); let n = 0;
    (function loop() {
      const t = performance.now(); g.push(t - last); last = t;
      if (++n < 25) requestAnimationFrame(loop);
      else { const q = g.slice(2).sort((a, b) => a - b);
        res({ p50: +q[Math.floor(q.length * 0.5)].toFixed(1) }); }
    })();
  }))();
`);
check('玻璃强化后帧率不回退（软件光栅化下 p50 < 90ms）',
  !!fps && fps.p50 < 90,
  fps ? `p50=${fps.p50}ms（约 ${Math.round(1000 / fps.p50)}fps · 软件光栅化，真机 GPU 远快于此）` : '取不到');

/* ── ③ 截图（趁状态干净先出图） ──────────────────────────────────────── */
/** 截图之前先量一遍"有没有看不见的遮罩"：全屏遮罩会毁掉整张图，
 *  而它在 DOM 里只是一个 `hidden=false`，肉眼扫代码扫不出来。
 *
 *  ⚠️ 2026-10-03 补一条判据维度：**层号**。
 *     这条判据原来是"fixed + 可见 + 铺满 80% 视口"三条，而当时的背景流光
 *     （`.aurora` 六团）三条全中 —— 它确实是 fixed、确实铺满视口、也确实可见，
 *     于是刚接入时**每次跑都被报成"有遮罩"**。但它声明 `z-index:-2`：负层号在
 *     根层叠上下文里位于**所有内容之下**，像素上不可能盖住任何东西，
 *     而截图毁不毁只看像素。
 *     → 所以判据必须问"会不会真的遮挡"，而"在内容之下"就是不会遮挡的证明。
 *     ⚠️ 这条维度在 B28 之后**依然必要**：玻璃背板（`body.eg-on::before`）也是
 *     fixed + 铺满视口 + `z-index:-1`，没有层号维度它每次都会被误报成遮罩。
 *     ⚠️ 排掉的**只有负层号**，pointer-events 不参与：截图是像素渲染，
 *        一个 `pointer-events:none` 的元素照样能把画面盖住（它只是不 eat 事件）。
 *        早先漏这一维时报的是"结论对、理由错"，比直接漏报更难查。 */
const overlay = await evalJs(`return [...document.querySelectorAll('body *')]
  .filter(el => { const cs = getComputedStyle(el); const r = el.getBoundingClientRect();
    if (!(cs.position === 'fixed' && cs.display !== 'none' && cs.visibility !== 'hidden'
          && r.width >= innerWidth * 0.8 && r.height >= innerHeight * 0.8)) return false;
    const z = cs.zIndex === 'auto' ? 0 : Number(cs.zIndex);
    return !Number.isFinite(z) ? true : z >= 0; })
  .map(el => (el.id || el.className) + ' ' + JSON.stringify(el.getBoundingClientRect().toJSON()))`);
check('截图前没有全屏遮罩（负层号的背景装饰不算）', (overlay || []).length === 0, (overlay || []).join(' | ') || '干净');

async function shot(name, group, sub, full = false) {
  await evalJs(`document.querySelectorAll('#nav1 .grp')[${group}].click();
    const s=document.querySelectorAll('#nav2 .sub')[${sub}]; if(s) s.click(); return 1;`);
  await sleep(500);
  /* ⚠️⚠️ `Page.captureScreenshot` 在本机 headless（软件光栅化 `--disable-gpu`）上
     **会挂起**：流体层真渲染之后它不再返回，报 `Detected unsettled top-level await`。
     ⇒ 必须用超时兜底。没有这一步的代价不是"少一张图"，而是**整条自检挂在截图这一行**
     —— 后面的汇总、退出码全都出不来，而人会把"SIGKILL / 卡住"读成"被测功能坏了"。
     截图只是"看起来对不对"的证据，逻辑判据一条都不依赖它。 */
  const m = await Promise.race([
    send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: full }),
    sleep(9000).then(() => null),
  ]);
  if (!m || !m.result || !m.result.data) return `（截图超时，跳过 ${name}）`;
  const file = path.join(OUT, `${name}.png`);
  fs.writeFileSync(file, Buffer.from(m.result.data, 'base64'));
  return file;
}
/* 线路板只在**云端大脑**下渲染（schema.js 里 route 卡的 `when` 是
   `provider ∈ {zhipu, qwen}` —— 2026-10-07 接千问时从"只给智谱"放宽成"两家云端都给"）；
   而它在「大脑」域的哪一页**会随 schema 变动**，所以不写死页码 ——
   逐页点一遍找到为止。写死页码的后果是：往后有人在前面插一页，
   这组断言就落到别的页上"什么都没查"却照样全绿（本项目头号风险：
   「断言存在」≠「断言接线」）。找不到时下面每条都带 `err` 报红。
   ⚠️ 沙箱里当前大脑恒为智谱，所以 `when` 放宽**不会**影响这组断言的触发条件；
      放宽的收益是：哪天有人把沙箱默认大脑改成千问，这里**照样找得到**。 */
await evalJs(`document.querySelectorAll('#nav1 .grp')[1].click(); return 1;`);
await sleep(200);
for (let s = 0; s < 6; s += 1) {
  await evalJs(`const x=document.querySelectorAll('#nav2 .sub')[${s}]; if(x) x.click(); return 1;`);
  await sleep(260);
  const has = await evalJs(`return !!document.querySelector('[data-rb] .srt-item');`);
  if (has) break;
}

/* ① 引擎挂上了吗 —— 判据是「把手在 + Sortable 存在 + 挂载数 ≤1」 */
const rbMount = await evalJs(`
  const root=document.querySelector('[data-rb]');
  if(!root) return {err:'这一页没有线路板（provider 不是 zhipu）'};
  const grips=root.querySelectorAll('.srt-grip');
  const items=root.querySelectorAll('.srt-item');
  return {
    grips: grips.length, items: items.length,
    hasEngine: typeof window.Sortable==='object',
    count: window.Sortable?window.Sortable.count():-1,
    live: !!root.querySelector('.srt-live[role="status"]'),
    liveDisplay: root.querySelector('.srt-live')?getComputedStyle(root.querySelector('.srt-live')).display:'none',
    posRel: getComputedStyle(root).position,
    ids: [...items].map(e=>e.getAttribute('data-srt-id')),
  };
`);
check('排序引擎真的挂上了（把手与引擎都在，且只挂了一挂）',
  !!rbMount && rbMount.hasEngine && rbMount.count <= 1 && rbMount.grips === rbMount.items && rbMount.items >= 2,
  rbMount?.err || `项=${rbMount?.items} 把手=${rbMount?.grips} 挂载数=${rbMount?.count}`);
check('播报区是真读屏元素（role=status 且**不是** display:none——那会让它一声不吭）',
  !!rbMount && rbMount.live && rbMount.liveDisplay !== 'none',
  `display=${rbMount?.liveDisplay}`);
check('线路容器是定位元素（offsetTop 的参照物必须是它，否则整列补偿差一个容器高）',
  !!rbMount && rbMount.posRel === 'relative', `position=${rbMount?.posRel}`);

/* ② 拖拽：合成指针事件走真实引擎。逐帧采样位移峰值 —— 判「让位」不能只看终点，
     瞬移的实现同样有正确的终点。
     ⚠️⚠️ **必须先把写路径隔离掉**：拖完会触发 `saveRoute` →真 POST
     `/api/config`，那是**用户真的模型降级链**。自检不许改用户配置
     （本文件此前的写断言特意挑了零副作用的 `/api/logs/clear`，同一条纪律）。
     所以这里临时替换 `fetch`，只放过 `/api/config` 之外的请求，测完原样装回去。 */
const rbDrag = await evalJs(`
  /* ⚠️ \`evalJs\` 包的是**非 async** 箭头函数（\`(() => { … })()\`），
     所以这里不能直接写 \`await\` —— 会当场语法报错。
     既有写法是 \`return (async () => …)()\`：交一个 Promise 出去，
     \`Runtime.evaluate\` 的 \`awaitPromise: true\` 会替我们等它。照它来。 */
  return (async () => {
  const root=document.querySelector('[data-rb]');
  if(!root) return {err:'线路板不在这一页'};
  const items=()=>[...root.querySelectorAll('.srt-item')];
  const before=items().map(e=>e.getAttribute('data-srt-id'));

  /* 写路径隔离：只挡 POST /api/config，其余（轮询 GET）照常放行，
     否则连不上后端会把页面打成演示模式，后面所有断言都失去意义。 */
  const realFetch=window.fetch;
  let blocked=0;
  window.fetch=function(url,opts){
    const u=String(url&&url.url||url||'');
    if((opts&&opts.method||'GET')!=='GET' && /\\/api\\/config/.test(u)){ blocked++; 
      return Promise.resolve(new Response(JSON.stringify({ok:true}),{status:200,headers:{'content-type':'application/json'}})); }
    return realFetch.apply(this,arguments);
  };

  const grip=items()[2].querySelector('.srt-grip');
  const r=grip.getBoundingClientRect();
  const y0=r.top+r.height/2;
  const fire=(type,y)=>{
    const e=new PointerEvent(type,{bubbles:true,cancelable:true,pointerId:7,
      pointerType:'mouse',button:0,buttons:type==='pointerup'?0:1,clientX:r.left+8,clientY:y});
    (type==='pointerdown'?grip:window).dispatchEvent(e);
  };

  fire('pointerdown',y0);
  /* ⚠️ 「让位」判的是**除拖动项以外**的项有没有位移。
     拖动项自己也在动（它跟着手指走），把它算进"最大位移"里，
     这条判据就**恒为真** —— 实测踩过：修好之前让位动画从来没产生过，
     而"全体最大位移"照样能读到 2.00px（那是拖动项自己的）。 */
  const dragItem = () => root.querySelector('[data-drag="1"]') || grip.closest('.srt-item');
  let peak=0, peakOther=0, liftedSeen=false, draggingSeen=false;
  const t0=performance.now();
  const res=await new Promise(done=>{
    (function step(){
      const p=performance.now()-t0;
      const y=y0+Math.min(p*1.2, 70);           /* 往下拖 70px ≈ 两行 */
      fire('pointermove',y);
      draggingSeen = draggingSeen || root.getAttribute('data-dragging')==='1';
      liftedSeen  = liftedSeen  || !!root.querySelector('[data-drag="1"]');
      const dNow = dragItem();
      for(const el of items()){
        const m=new DOMMatrixReadOnly(getComputedStyle(el).transform);
        const v=Math.abs(m.f);
        peak=Math.max(peak,v);
        if(el!==dNow) peakOther=Math.max(peakOther,v);
      }
      if(p<420) requestAnimationFrame(step);
      else{
        fire('pointerup',y0+70);
        done({
          before, after: items().map(e=>e.getAttribute('data-srt-id')),
          peak, peakOther, draggingSeen, liftedSeen, blocked,
          dragging:root.getAttribute('data-dragging'),
          lifted:!!root.querySelector('[data-drag="1"]'),
          announce:(root.querySelector('.srt-live')||{}).textContent||'',
        });
      }
    })();
  });
  /* 让落位动画跑完再量busy()：松手那一刻它**必然**还忙着，
     此刻量"应当不忙"量到的是时序而不是实现。 */
  await new Promise(r=>setTimeout(r,700));
  res.busyAfter = window.Sortable.busy();
  res.countAfter = window.Sortable.count();
  window.fetch=realFetch;
  return res;
  })();
`);
check('拖拽真的换了顺序（DOM 顺序变了，且不是"拖回原位"）',
  !!rbDrag && rbDrag.before.join('|') !== rbDrag.after.join('|'),
  `前=${(rbDrag?.before||[]).join('→')} 后=${(rbDrag?.after||[]).join('→')}`);
check('让位过程有真实位移（**除拖动项之外**的项也动了 > 2px）',
  !!rbDrag && rbDrag.peakOther > 2,
  `让位峰值=${(rbDrag?.peakOther || 0).toFixed(2)}px · 全体最大（含拖动项，只作参考）=${(rbDrag?.peak || 0).toFixed(2)}px`);
check('拖动中那一项被"抬起来"（投影标记 data-drag 由引擎打，且此刻确实在）',
  !!rbDrag && rbDrag.draggingSeen && rbDrag.liftedSeen,
  `data-dragging 出现过=${rbDrag?.draggingSeen} · 抬起项出现过=${rbDrag?.liftedSeen}`);
check('拖完不留拖动态（data-dragging / data-drag 都已摘掉）',
  !!rbDrag && !rbDrag.dragging && !rbDrag.lifted,
  `data-dragging=${rbDrag?.dragging} 抬起项=${rbDrag?.lifted}`);
check('换位有播报给读屏（不是只动画面不出声）',
  !!rbDrag && /第\s*\d+\s*位/.test(rbDrag.announce), `播报="${rbDrag?.announce}"`);
check('落位动画跑完后引擎不忙了（busy() 归零 —— 否则 softPaint 的守卫会永久挡掉重绘）',
  !!rbDrag && rbDrag.busyAfter === false && rbDrag.countAfter <= 1,
  `busy=${rbDrag?.busyAfter} 挂载数=${rbDrag?.countAfter}`);
check('自检没有真改用户配置（写路径被隔离，且确实拦到了这次提交）',
  !!rbDrag && rbDrag.blocked >= 1,
  `拦下 ${rbDrag?.blocked} 次 POST /api/config`);

/* ③ 键盘重排 + 焦点跟随 + 撤销（可访问路径，不依赖指针） */
const kb = await evalJs(`
  const root=document.querySelector('[data-rb]');
  const items=()=>[...root.querySelectorAll('.srt-item')];
  const before=items().map(e=>e.getAttribute('data-srt-id'));
  const h=items()[0].querySelector('.srt-grip');
  /* 写路径隔离（与拖拽探针同一条纪律）：只挡 POST /api/config，
     其余（3 秒一次的 GET /api/state 轮询）照常放行 —— 否则会把页面打成演示模式。 */
  const realFetch=window.fetch;
  let blocked=0;
  window.fetch=function(url,opts){
    const u=String(url&&url.url||url||'');
    if((opts&&opts.method||'GET')!=='GET' && /\\/api\\/config/.test(u)){ blocked++;
      return Promise.resolve(new Response(JSON.stringify({ok:true}),{status:200,headers:{'content-type':'application/json'}})); }
    return realFetch.apply(this,arguments);
  };
  /* ⚠️⚠️ 监听器里抛的异常**不会**传给 dispatchEvent 的调用方（浏览器只把它报告成
     uncaught）⇒ 必须自己挂一个 error 监听才看得见。
     实测：applyOrder 里一个 undefined.jump 就这样藏住了 ——
     改 DOM 在前、抛异常在后，于是**顺序照常改好、页面照常工作**，
     唯一症状是"让位动画从来没发生"，而这条原文只有这个监听拿得到。
     ⚠️ 本段是模板字符串：注释里不许出现反引号。 */
  const errs=[];
  window.addEventListener('error', (e)=>{ errs.push(String((e&&e.message)||(e&&e.error)||e)); });
  h.focus();
  const focused=document.activeElement===h;
  h.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true,cancelable:true}));
  const mid=items().map(e=>e.getAttribute('data-srt-id'));
  const stillOnHandle=document.activeElement===items()[1].querySelector('.srt-grip');
  const live1=(root.querySelector('.srt-live')||{}).textContent||'';
  /* ⚠️ 撤销条**不能在这里同步查**：提交之后 saveRoute 要先 await 一次 POST、
     再 refresh() 重绘，撤销条是**重绘之后**才出现在 DOM 里的。
     同步查必然查到 false —— 那是时序不是实现（第一版就这么误报过一条）。
     ⚠️ 本段是模板字符串：注释里不许出现反引号。 */
  await new Promise(r=>setTimeout(r,400));
  window.fetch=realFetch;
  return {before,mid,focused,stillOnHandle,live1,blocked,errs};
`);
check('键盘能重排（↑↓ 在把手上），且焦点跟着走（否则连按两次就不知道自己在哪）',
  !!kb && kb.focused && kb.before.join('|') !== kb.mid.join('|') && kb.stillOnHandle,
  `${(kb?.before||[]).join('→')} ⇒ ${(kb?.mid||[]).join('→')} · 把手拿到焦点=${kb?.focused} · 焦点跟随=${kb?.stillOnHandle}`);
check('排序交互里没有未捕获异常（监听器里抛的不会传给 dispatchEvent，只能这样抓）',
  !!kb && (kb.errs || []).length === 0, (kb?.errs || []).join(' | ') || '无');
check('键盘重排也播报（读屏用户看不到位移）',
  !!kb && /第\s*\d+\s*位/.test(kb.live1), `播报="${kb?.live1}"`);
/* 等写入链路跑完（POST → refresh → 重绘）再查撤销条。 */
await sleep(900);
const undoNow = await evalJs(`
  const btn=document.querySelector('[data-a="route.undo"]');
  return { undo:!!btn, text:(btn||{}).textContent||'',
           hint:(document.querySelector('.btn-row .hint')||{}).textContent||'' };
`);
check('改完顺序出现「撤销上一次改顺序」（撤销点存在，且已写进自检隔离区）',
  !!kb && undoNow?.undo === true && kb.blocked >= 1,
  `撤销按钮=${undoNow?.undo} · 拦下 ${kb?.blocked} 次写 · 说明="${(undoNow?.hint || '').trim()}"`);

/* ④ 无 rAF 泄漏：反复重挂后活跃动画必须归零。这是本项目的既有纪律
   （README「实测重渲染 5 次后 Motion.activeCount() === 0」），排序层同样适用。
   ⚠️ 先等动画自然收敛再量 —— 刚改完顺序时它**必然**还在动。 */
await sleep(800);
const leak = await evalJs(`
  const subs=[...document.querySelectorAll('#nav2 .sub')];
  for(let k=0;k<3;k++){
    subs[0].click(); await new Promise(r=>setTimeout(r,90));
    subs[1].click(); await new Promise(r=>setTimeout(r,90));
  }
  return { after: window.Motion.activeCount(), count: window.Sortable.count() };
`);
check('反复切页重挂后无 rAF 泄漏（Motion 活跃动画归零、排序实例不累积）',
  !!leak && leak.after === 0 && leak.count <= 1,
  `活跃动画=${leak?.after} · 排序实例=${leak?.count}`);

/* ── ③'' 卡片的 3D 倾斜 + 跟随高光（2026-10-04 · `tilt.js`）──────────────
 * 这四条打的都是**「坏了完全看不出来」**：
 *   · 模块没挂（`<script>` 顺序反了 / 被 reduced-motion 挡掉）→ 页面照常；
 *   · 变量写了但样式没消费（`transform` 里没引用 `--tilt-rx`）→ 变量在、画面不动；
 *   · 离开时不回落 → 鼠标走后卡片**永久歪着**（最容易被当成"设计如此"）；
 *   · 带输入控件的卡片也被挂上 → 点击坐标随倾斜偏移（表单卡上代价很高）。
 * ⚠️ 一律用**合成 PointerEvent** 走真实引擎：直接给元素加 class 只证明"class 能加"。
 * ⚠️ `relatedTarget` 必须给 —— 它是"卡内移动不回落"那条逻辑的唯一输入。 */
await goto(0, 0);
await sleep(420);
const tilt = await evalJs(`
  /* ⚠️⚠️ 每次都**重新取节点**：整页每 3 秒 innerHTML 重建一次，
     探针只要活过 3 秒，一开始抓到的那个 el 就成了游离节点 ——
     而游离节点的 getComputedStyle 返回**空串**、class 也停留在旧值。
     首版就是抓着旧节点读到"高光没淡入""离开没回落"两条**假红**。
     ⚠️ 顺带：这个写法同时验证了 tilt.js 的 resync()（重绘后把倾斜认回来）。 */
  const cur = () => document.querySelector('section.card[data-tilt]') || document.querySelector('[data-tilt]');
  if (!cur()) return { err: '页面上没有 [data-tilt] 元素' };
  const read = () => {
    const e = cur();
    return e
      ? { rx: parseFloat(getComputedStyle(e).getPropertyValue('--tilt-rx')) || 0, on: e.classList.contains('tilt-on') }
      : { rx: 0, on: false };
  };
  const r = cur().getBoundingClientRect();
  const pt = (x, y) => ({ clientX: r.left + r.width * x, clientY: r.top + r.height * y });
  const fire = (t, o) => cur().dispatchEvent(new PointerEvent(t, Object.assign({ bubbles: true }, o)));
  fire('pointerover', pt(0.1, 0.1));
  fire('pointermove', pt(0.9, 0.1));
  const hot = read();
  const tr = getComputedStyle(cur()).transform;
  /* ⚠️ 用户两次要求删掉"鼠标放上去的灯光" ⇒ 这里判**反过来**：
     没有伪元素高光层时，它的 computed content 是 none。
     （原来那三行"等 240ms 过渡再读 opacity"整段删掉了 —— 对象没了。）
     ⚠️ 本段是模板字符串：注释里不许出现反引号。 */
  const glareLayer = getComputedStyle(cur(), '::after').content;
  /* 卡内移动：relatedTarget 仍在卡里 ⇒ 不该回落 */
  fire('pointerout', Object.assign({ relatedTarget: cur().firstElementChild || cur() }, pt(0.9, 0.1)));
  const stay = read();
  /* ⚠️ **跨过一次 3 秒轮询**：整页重绘会把卡片换成新节点，倾斜必须被认回来
     （tilt.js 的 resync）。这条是本轮实测发现的真问题 —— 不认回来时
     "鼠标停着不动，卡片每 3 秒自己正一下"，而任何静态判据都看不见它。 */
  fire('pointerover', pt(0.1, 0.1));
  fire('pointermove', pt(0.25, 0.8));
  const beforeRedraw = read();
  await new Promise(res => setTimeout(res, 3600));
  const afterRedraw = read();
  /* 真正离开：relatedTarget 到卡外 */
  fire('pointerout', Object.assign({ relatedTarget: document.body }, pt(0.9, 0.1)));
  await new Promise(res => setTimeout(res, 1100));
  const cold = read();
  return {
    enabled: !!(window.Tilt && window.Tilt.enabled()),
    maxDeg: window.Tilt && window.Tilt.MAX_DEG,
    hot, stay, beforeRedraw, afterRedraw, cold, tr, glareLayer, err: '',
    /* ⚠️ transform-style 必须是 flat：preserve-3d 会让卡内子元素一起进 3D 空间
       —— 用户实测的两条抱怨（"里面的小方块也动" + "莫名其妙的翻转"）是同一个根因。
       ⚠️ 本段是模板字符串：注释里不许出现反引号。 */
    flat: getComputedStyle(cur()).transformStyle,
    count: document.querySelectorAll('[data-tilt]').length,
    cards: document.querySelectorAll('section.card').length,
    inner: document.querySelectorAll('.metric[data-tilt]').length,
  };
`);
check('倾斜模块真的挂上了（不是"标签在、引擎不在"）',
  !!tilt && tilt.enabled === true, `Tilt.enabled()=${tilt?.enabled} · 最大倾角=${tilt?.maxDeg}° · 已标注 ${tilt?.count ?? 0} 个元素`);
check('**每一个大板块**都挂了倾斜（用户反馈「有些有效果、有些没有」—— 那是第一版按"卡里含输入控件"整张跳过造成的）',
  !!tilt && tilt.cards > 0 && tilt.count === tilt.cards,
  `已挂 ${tilt?.count} / 共 ${tilt?.cards} 张大板块`);
check('卡内小块一个都没挂（用户：「不希望里面的小方块也动」）',
  !!tilt && tilt.inner === 0, `被误挂的 .metric = ${tilt?.inner}`);
check('卡片没有 `preserve-3d`（`transform-style` 实测 = flat）—— 它是"里面的方块也动 + 莫名翻转"的同一个根因',
  !!tilt && tilt.flat === 'flat', `transform-style=${tilt?.flat}`);
check('光标移过卡片真的斜了（变量 + 计算样式都变 —— 只写变量而样式不消费等于没做）',
  !!tilt && tilt.hot?.on === true && Math.abs(tilt.hot?.rx || 0) > 0.3 && /matrix3d/.test(tilt?.tr || ''),
  `倾角=${tilt?.hot?.rx}°（上限 ${tilt?.maxDeg}°）· class=${tilt?.hot?.on} · transform=${(tilt?.tr || '').slice(0, 28)}…`);
check('卡片上**没有**高光层（用户两次要求删掉"鼠标放上去的灯光"：`::after` 的实测 content = none）',
  !!tilt && tilt.glareLayer === 'none',
  `::after content=${tilt?.glareLayer}（没有这条规则时就是 none）`);
check('光标在卡内移动**不**回落（子元素会冒泡出一对 over/out，判错就会在自己文字上抖）',
  !!tilt && tilt.stay?.on === true, `class=${tilt?.stay?.on} · 倾角=${tilt?.stay?.rx}°`);
check('跨过一次整页重绘后倾斜仍在（`resync`）—— 不回认的症状是"鼠标不动、卡片每 3 秒自己正一下"',
  !!tilt && tilt.beforeRedraw?.on === true && tilt.afterRedraw?.on === true
    && Math.abs(tilt.afterRedraw?.rx || 0) > 0.3,
  `重绘前 倾角=${tilt?.beforeRedraw?.rx}° · 重绘后 倾角=${tilt?.afterRedraw?.rx}° class=${tilt?.afterRedraw?.on}（等了 3.6s ≈ 一个轮询周期）`);
check('光标离开后回落到 0（不回落的症状是"卡片永久歪着"，最容易被当成设计如此）',
  !!tilt && tilt.cold?.on === false && Math.abs(tilt?.cold?.rx || 0) < 0.15,
  `倾角=${tilt?.cold?.rx}° · class=${tilt?.cold?.on}（1.1s 后）`);

/* ── ③''' 快速穿梭：用户报"在两块玻璃板之间来回快速移动时大幅翻面" ────────
 * ⚠️ `MAX_DEG` 是 1°，**结构上不可能**产生用户截图里那种幅度的旋转。
 *    所以先不加"应该怎样"的判断，只把**实测峰值**打出来 ——
 *    先拿到数，再决定是"我漏了一条路径"还是"别的东西在动它"。 */
const tiltFast = await evalJs(`
  const cards = [...document.querySelectorAll('section.card[data-tilt]')];
  if (cards.length < 2) return { err: '这一页只有 ' + cards.length + ' 张可倾斜卡，测不了穿梭' };
  const A = cards[0], B = cards[1];
  const ra = A.getBoundingClientRect(), rb = B.getBoundingClientRect();
  const readOf = (el) => ({
    rx: parseFloat(getComputedStyle(el).getPropertyValue('--tilt-rx')) || 0,
    ry: parseFloat(getComputedStyle(el).getPropertyValue('--tilt-ry')) || 0,
  });
  let peakA = 0, peakB = 0, over = [], maxActive = 0;
  for (let i = 0; i < 30; i++) {
    const el = (i % 2 === 0) ? A : B;
    const r = (i % 2 === 0) ? ra : rb;
    const cx = r.left + r.width * 0.25, cy = r.top + r.height * 0.75;
    el.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, clientX: cx, clientY: cy }));
    el.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: cx, clientY: cy }));
    /* ⚠️ 并发动画数的**峰值**才是"句柄有没有管全"的判据 ——
       只看穿梭**结束后**的读数会漏掉：漏掉的句柄会自然收敛，最终也是 0。
       实测（修之前）这个峰值是 **30**：leave() 只 stop 了 rx 的句柄，
       ry 的那条每穿梭一次就多留一条。
       ⚠️ 本段是模板字符串：注释里不许出现反引号。 */
    maxActive = Math.max(maxActive, window.Motion.activeCount());
    const va = readOf(A), vb = readOf(B);
    peakA = Math.max(peakA, Math.abs(va.rx), Math.abs(va.ry));
    peakB = Math.max(peakB, Math.abs(vb.rx), Math.abs(vb.ry));
    if (Math.abs(va.rx) > 1.2 || Math.abs(va.ry) > 1.2 || Math.abs(vb.rx) > 1.2 || Math.abs(vb.ry) > 1.2) {
      over.push(i + ':A(' + va.rx.toFixed(2) + ',' + va.ry.toFixed(2) + ') B(' + vb.rx.toFixed(2) + ',' + vb.ry.toFixed(2) + ')');
    }
  }
  return { peakA, peakB, maxDeg: window.Tilt.MAX_DEG, over: over.slice(0, 5), overN: over.length,
           maxActive, mvCount: window.Motion.activeCount() };
`);
check('快速穿梭时角度不越界（实测峰值 —— MAX_DEG 是 1°，峰值若远大于它就是真 bug）',
  !!tiltFast && !tiltFast.err && tiltFast.peakA <= 1.2 && tiltFast.peakB <= 1.2,
  tiltFast?.err
    ? tiltFast.err
    : `A 峰值=${tiltFast?.peakA?.toFixed(2)}° · B 峰值=${tiltFast?.peakB?.toFixed(2)}° · 上限=${tiltFast?.maxDeg}° · 越界 ${tiltFast?.overN} 次`
      + (tiltFast?.over?.length ? ' · ' + tiltFast.over.join(' | ') : ''));
check('快速穿梭时**并发动画数不累积**（漏管一个句柄就是每次穿梭多留一条 —— 实测修前峰值 30）',
  !!tiltFast && !tiltFast.err && tiltFast.maxActive <= 4,
  tiltFast?.err ? tiltFast.err
    : `并发峰值=${tiltFast?.maxActive}（正常 ≤4：两张卡 × rx/ry）· 穿梭后残留=${tiltFast?.mvCount}`);

/**
 * 截图 = **给人看**的证据，逻辑判据一条都不依赖它。
 *
 * ⚠️⚠️ 默认**不截**。原因不是"截图没用"，而是本机 headless（软件光栅化
 * `--disable-gpu`）在流体层真渲染之后 `Page.captureScreenshot` 会**挂起**
 * —— 它不再返回，Node 报 `Detected unsettled top-level await` 然后进程直接退出。
 * 后果不是"少几张图"，而是**整条自检跑不到末尾的汇总**（"结果：x/y 通过"打不出来），
 * 而人会把"SIGKILL / 卡住"读成"被测功能坏了"。
 * 要图的时候显式加 `--shot`；那时也仍然有 9 秒超时兜底。
 */
const WITH_SHOT = process.argv.includes('--shot');
const maybeShot = (name, g, s, full = false) =>
  (WITH_SHOT ? shot(name, g, s, full) : Promise.resolve(`（未截图 · 加 --shot 打开）`));

const shot1 = await maybeShot('01-run-overview', 0, 0);
const shotEmotion = await maybeShot('04-emotion', 4, 0);
const shotSleep = await maybeShot('05-sleep', 5, 3);

/* ── ④ 真实交互：草稿机制 ─────────────────────────────────────────────── */
await evalJs(`document.querySelectorAll('#nav1 .grp')[2].click(); return 1;`); // 人格
await sleep(150);
await evalJs(`document.querySelectorAll('#nav2 .sub')[0].click(); return 1;`);
await sleep(200);
const draft = await evalJs(`
  const inp = document.querySelector('[data-id="p.name"]');
  const bar = document.getElementById('savebar');
  /* 判据取**算出来的 display**，不是 hidden 属性 —— 属性可以是 true
     而元素照样铺满屏幕（组件的 display 会压过 UA 的 [hidden]），这正是实测踩到的那一个。 */
  const shown = () => getComputedStyle(bar).display !== 'none';
  if (!inp) return { err: '找不到昵称输入框' };
  const before = shown();
  inp.value = '自检改一下';
  inp.dispatchEvent(new Event('change', { bubbles: true }));
  const after = shown();
  const n = document.getElementById('savebarTxt').textContent;
  document.querySelector('[data-a="draft-discard"]').click();
  return { before, after, n, cleared: !shown(), attr: bar.hidden };
`);
check('草稿页改动 → 底部保存条出现（按计算样式判定）', draft?.before === false && draft?.after === true, draft?.n || draft?.err || '');
check('丢弃改动 → 保存条真正消失', draft?.cleared === true, `hidden 属性=${draft?.attr}`);

/* ── ⑤ 主题切换 ────────────────────────────────────────────────────────
   2026-10-04 换成圆形按钮（beui circle-blur 移植，原 #themeSel 下拉退役）：
   点一下 → 深浅翻转 + html 上短暂挂 data-vt（VT 揭开动画的接线证据）。
   ⚠️ toggleTheme 是 async：主题写在 startViewTransition 的 update 回调里，
      要**轮询等它落地**再读 —— 读早了会拿到旧值，看起来像"点了没反应"。 */
const theme = await evalJs(`
  const btn = document.getElementById('themeBtn');
  if (!btn) return { err: '找不到 #themeBtn —— 主题没有切换入口' };
  const before = document.documentElement.dataset.theme;
  const want = before === 'dark' ? 'light' : 'dark';
  btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  const vtMark = document.documentElement.dataset.vt;   /* 点击瞬间同步置上 */
  for (let i = 0; i < 40 && document.documentElement.dataset.theme !== want; i++) {
    await new Promise((r) => setTimeout(r, 50));
  }
  const mid = document.documentElement.dataset.theme;
  const bg = getComputedStyle(document.body).backgroundColor;
  for (let i = 0; i < 40 && document.documentElement.dataset.vt; i++) {
    await new Promise((r) => setTimeout(r, 50));
  }
  const vtCleared = !document.documentElement.dataset.vt;
  btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  for (let i = 0; i < 40 && document.documentElement.dataset.theme !== before; i++) {
    await new Promise((r) => setTimeout(r, 50));
  }
  return { before, want, vtMark, vtCleared, mid, bg, after: document.documentElement.dataset.theme };
`);
check('主题切换生效（点一下翻面、再点翻回）',
  theme?.mid === theme?.want && theme?.after === theme?.before, `深色底=${theme?.bg || theme?.err}`);
check('VT 揭开动画真的接线（data-vt 挂上且动画后摘掉）',
  theme?.vtMark === 'circle-blur' && theme?.vtCleared === true,
  `点击瞬间=${theme?.vtMark || '(无)'}`);

/* ── ⑥ **真写一次**（唯一一条端到端写路径验证）────────────────────────────
   为什么必须真写：读路径全绿**完全不证明**写路径是通的 —— token 没注入、方法写错、
   URL 拼错，三种情况都只表现为"点了没反应"，而读一切正常。
   选的动作用 `POST /api/logs/clear`（清空面板内存里的日志环形缓冲）：**零副作用** ——
   不改配置、不碰 QQ、不重启任何进程，清掉的是本来就会自己折半丢掉的 1200 行缓冲。
   判据用页面自己的 `logCursor`（哨兵 12345 → 成功后才归零）：
   它不是"接口能通"，而是"这次写请求真的被服务端受理了"。 */
await evalJs(`document.querySelectorAll('#nav1 .grp')[0].click(); return 1;`);
await sleep(150);
await evalJs(`document.querySelectorAll('#nav2 .sub')[4].click(); return 1;`);
await sleep(400);
const write = await evalJs(`
  const n = window.__next;
  if (!n) return { err: '拿不到页面状态' };
  n.logCursor = 12345;
  const btn = document.querySelector('[data-a="logs.clear"]');
  if (!btn) return { err: '日志页上没有「清空」按钮' };
  btn.click();
  return { clicked: true, hasToken: !!document.querySelector('meta[name="panel-token"]').content.match(/^[^_]/) };
`);
await sleep(1200);
const wrote = await evalJs(`return { cursor: window.__next.logCursor, toast: (document.querySelector('.toasts')||{}).textContent || '' }`);
check('真写一次（清空日志）：写路径 + token 端到端可用',
  wrote?.cursor === 0 && !/失败/.test(wrote?.toast || ''),
  `logCursor=${wrote?.cursor}（成功才归零）· toast=${(wrote?.toast || '').trim()} · 页面带 token=${write?.hasToken}`);

/* ── ⑦ 页面里不许再有"旧界面"的残留入口（2026-10-02 旧页面已删除）────────
   判据**反过来了**：那个「旧界面」入口曾经是必须存在的（两套并存时期），
   旧页面连同它的拼装模块删掉之后它就没有对象了 —— 而"指向一个不存在的地址"
   不会报错，只是点下去 404。所以从"必须有一个"翻成"必须一个都没有"。 */
const legacyLink = await evalJs(`
  return [...document.querySelectorAll('a[href]')]
    .map((a) => a.getAttribute('href'))
    .filter((h) => h === '/' || h === '/next' || h === '/next/');
`);
check('页面上没有指向已删除旧页面的残留入口', (legacyLink || []).length === 0, (legacyLink || []).join(' · ') || '无');

/* ── ⑧ "添加+优化"那一批的落点（2026-10-02 第二批）──────────────────────
   这一批把三张骨架页换成了真数据，并把两处"存不住"的红标撤掉换成真控件。
   断言只盯**页面有没有真的显示出数字/条目**，不盯具体数值 —— 数值会随机器人的
   心情和抓取结果变，写死它就成了"用户一改配置测试就假失败"。 */
async function goto(group, sub) {
  await evalJs(`document.querySelectorAll('#nav1 .grp')[${group}].click(); return 1;`);
  await sleep(120);
  await evalJs(`const s=document.querySelectorAll('#nav2 .sub')[${sub}]; if(s) s.click(); return 1;`);
  await sleep(320);
}
const newPages = {};
// 情绪世界（第 5 个域 · 第 1 页）：应当有 mood 的真数字，而不是骨架说明
await goto(4, 0);
newPages.emotion = await evalJs(`return {
  title: (document.querySelector('#page h1')||{}).textContent || '',
  nums: [...document.querySelectorAll('#page .metric .n')].map(e=>e.textContent.trim()).filter(Boolean),
  skeleton: /读不到|还没下发/.test(document.getElementById('page').textContent),
}`);
// 群友档案（记忆与知识 · 第 3 页）：目录为空时应当给"还没被用到过"的人话，而不是报错
await goto(3, 2);
newPages.people = await evalJs(`return {
  title: (document.querySelector('#page h1')||{}).textContent || '',
  text: (document.getElementById('page').textContent||'').slice(0,200),
}`);
// 免费额度情报（大脑 · 第 4 页）：新页，应当有条目
await goto(1, 3);
newPages.deals = await evalJs(`return {
  title: (document.querySelector('#page h1')||{}).textContent || '',
  rows: document.querySelectorAll('#page .row').length,
  tag: (document.querySelector('#page .tag.accent')||{}).textContent || '',
}`);
// 世界日历 → 节假日表：那一格**必须可编辑**了（此前是 disabled）
await goto(4, 1);
newPages.holidays = await evalJs(`
  const btn = [...document.querySelectorAll('#page button')].find(b=>b.textContent.trim()==='添加');
  const dateInp = document.getElementById('holiDate');
  return { hasBtn: !!btn, btnDisabled: btn ? btn.disabled : null, hasDate: !!dateInp, dateDisabled: dateInp ? dateInp.disabled : null };
`);
check('情绪页显示真数字（不再是骨架）', newPages.emotion?.nums?.length > 0 && !newPages.emotion?.skeleton,
  `${newPages.emotion?.title} 数字=${(newPages.emotion?.nums || []).join('/')}`);
check('群友档案页有说明或列表（不报错）', /群友档案/.test(newPages.people?.title || '') && (newPages.people?.text || '').length > 10,
  (newPages.people?.text || '').replace(/\s+/g, ' ').slice(0, 60));
check('免费额度情报页渲染出条目', (newPages.deals?.rows || 0) > 0, `${newPages.deals?.title} · ${newPages.deals?.tag} · ${newPages.deals?.rows} 行`);
check('节假日表可以编辑了（添加按钮与日期框都不再禁用）',
  newPages.holidays?.hasBtn === true && newPages.holidays?.btnDisabled === false
  && newPages.holidays?.hasDate === true && newPages.holidays?.dateDisabled === false,
  JSON.stringify(newPages.holidays));

/* ── ⑧'' 长列表封顶（2026-10-04）───────────────────────────────────────────
   背景：结构化记忆 / 群友档案 / 历史存量 / 额度情报 这类列表会**随数据一直长**，
   卡片能长到几千像素；而倾斜挂在 `section.card` 上（`markTiltables`）——
   卡片越高，"同样 1°"的上下边缘位移越大，观感就是「鼠标放上去倾斜很大」。
   ⇒ 修的是**长度**（`capRows`），`tilt.js` 一行没动。

   三条断言全是"坏了不抛异常、只看起来不对"的那一类：
     ① 40 条进来，卡片**默认只画前 N 条**
     ② 尾部「展开剩下 N 条」里的 N 与**真实缺口**一致（写死过就永远对，所以从实测算）
     ③ 点展开 → 真的画全；点收起 → 回到前 N 条

   ⚠️ 夹具是**注入**的：额度情报页的真实条数随插件变（今天是 40，明天可能 0），
      拿它当夹具会变成"用户一换插件这条就假红"。注入 40 条 = 与真实数据解耦。
   ⚠️ 注入后必须**自己调 `__nextRepaint()`** 强制重画：干等 3 秒轮询会被
      `refresh()` 用服务端数据覆盖回去（那时断言测的是"没封顶的真实数据"）。 */
const LIST_CAP_EXPECTED = 15;   // 与 `app.js` 的 `LIST_CAP` 同源 —— 改那边要同步这里
await goto(1, 3);
const cap = await evalJs(`
  const S = window.__next, repaint = window.__nextRepaint;
  if (!S || !repaint) return { err: '拿不到页面状态或重绘钩子' };
  const N = 40;
  const items = Array.from({ length: N }, (_, i) => ({ free: true, source: '测试', title: '夹具条目 ' + i, url: '' }));
  const keep = S.state.apiDeals;
  S.state.apiDeals = { ok: true, count: N, items, lastRefresh: Date.now() };
  S.extra.open = {};
  repaint();
  const rowsOf = () => document.querySelectorAll('#page .row').length;
  const byA = (a) => [...document.querySelectorAll('#page button')].find((b) => b.dataset.a === a);
  const more = byA('list.more');
  const folded = rowsOf();
  const moreTxt = more ? more.textContent.replace(/\\s+/g, ' ').trim() : '';
  if (more) more.click();
  await new Promise((r) => setTimeout(r, 80));
  const opened = rowsOf();
  const fold = byA('list.fold');
  if (fold) fold.click();
  await new Promise((r) => setTimeout(r, 80));
  const refolded = rowsOf();
  S.state.apiDeals = keep; S.extra.open = {}; repaint();
  return { folded, moreTxt, opened, refolded, hasMore: !!more, hasFold: !!fold };
`);
const capGap = String(40 - LIST_CAP_EXPECTED);
check('长列表默认只画前 N 条（卡片不再随数据无限变长）', cap?.folded === LIST_CAP_EXPECTED,
  cap?.err || `注入 40 条 → 实画 ${cap?.folded} 条（上限 ${LIST_CAP_EXPECTED}）`);
check('「展开剩下 N 条」的 N 与真实缺口一致', cap?.hasMore && cap?.moreTxt.includes(capGap),
  `按钮文案=「${cap?.moreTxt}」· 期望含 ${capGap}`);
check('展开真的画全、收起回到前 N 条', cap?.opened === 40 && cap?.refolded === LIST_CAP_EXPECTED,
  `展开后 ${cap?.opened} 条 · 收起后 ${cap?.refolded} 条 · 收起键=${cap?.hasFold}`);

/* ── ⑧''' 跨重绘的状态保持（2026-10-04）───────────────────────────────────
   用户第二条反馈：「滚到一半被强制拉回去」「展开后几秒自己收回去了」。
   两者同源 —— `paintPage()` 每 3 秒重建 `#page`，而 `scrollTop` 与
   `<details>.open` 都是**元素属性**，重建即丢。修法是"重建前采集、重建后恢复"。

   ⚠️ 所以断言必须**主动触发一次重绘**（`__nextRepaint()`）——
      只测"点一下展开了"是测不到这条 bug 的（它要等 3 秒才发作）。
   ⚠️ 三条各钉一件事：
      ① 长列表展开态跨重绘仍在（状态在 `S.extra`，不在 DOM 上）
      ② `<details>` 展开跨重绘仍在 ★ 用户截图点名的就是它
      ③ 容器 `scrollTop` 跨重绘保持（**先验"它本来可滚"**，否则 0 == 0 是假绿） */
const keepA = await evalJs(`
  const S = window.__next, repaint = window.__nextRepaint;
  if (!S || !repaint) return { err: '拿不到页面状态或重绘钩子' };
  const N = 40;
  const items = Array.from({ length: N }, (_, i) => ({ free: true, source: '测试', title: '夹具条目 ' + i, url: '' }));
  const keepDeals = S.state.apiDeals;
  S.state.apiDeals = { ok: true, count: N, items, lastRefresh: Date.now() };
  S.extra.open = {};
  repaint();
  const more = [...document.querySelectorAll('#page button')].find((b) => b.dataset.a === 'list.more');
  if (!more) { S.state.apiDeals = keepDeals; S.extra.open = {}; repaint(); return { err: '没有展开按钮' }; }
  more.click();
  await new Promise((r) => setTimeout(r, 80));
  const box = () => document.querySelector('#page .rows.scroll-y');
  const openedBefore = document.querySelectorAll('#page .row').length;
  const el = box();
  const scrollable = el ? el.scrollHeight - el.clientHeight : 0;
  if (el) el.scrollTop = 100;
  const scrolled = el ? el.scrollTop : -1;
  repaint();
  await new Promise((r) => setTimeout(r, 140));
  const el2 = box();
  const openedAfter = document.querySelectorAll('#page .row').length;
  const stillOpen = !!document.querySelector('#page [data-a="list.fold"]');
  const scAfter = el2 ? el2.scrollTop : -1;
  S.state.apiDeals = keepDeals; S.extra.open = {}; repaint();
  return { openedBefore, openedAfter, stillOpen, scrolled, scAfter, scrollable };
`);
check('长列表展开态跨重绘不被收回（状态在 S.extra，不在 DOM 上）',
  keepA?.openedBefore === 40 && keepA?.openedAfter === 40 && keepA?.stillOpen === true,
  keepA?.err || `重绘前 ${keepA?.openedBefore} 条 → 重绘后 ${keepA?.openedAfter} 条 · 收起键在=${keepA?.stillOpen}`);
check('容器滚动位置真的守得住（不是"滚一半被拉回去"）',
  keepA?.scrollable > 40 && keepA?.scrolled === 100 && keepA?.scAfter === 100,
  keepA?.err || `可滚余量 ${keepA?.scrollable}px · 滚到 ${keepA?.scrolled} → 重绘后 ${keepA?.scAfter}`);

await goto(2, 4);   // 人格 → 扮演规则（用户截图那张卡）
const keepD = await evalJs(`
  const repaint = window.__nextRepaint;
  if (!repaint) return { err: '没有重绘钩子' };
  const d = document.querySelector('#page details');
  if (!d) return { err: '这一页没有 details' };
  const title = (document.querySelector('#page h1') || {}).textContent || '';
  d.querySelector('summary').click();
  await new Promise((r) => setTimeout(r, 80));
  const afterClick = document.querySelector('#page details').open;
  repaint();
  await new Promise((r) => setTimeout(r, 140));
  const afterRepaint = document.querySelector('#page details').open;
  const box = document.querySelector('#page details > .rows');
  const cs = box ? getComputedStyle(box) : null;
  return { title, afterClick, afterRepaint, hasBox: !!box, maxH: cs ? cs.maxHeight : null, ovf: cs ? cs.overflowY : null };
`);
check('展开的折叠块跨重绘不被收回（用户截图点名的那一个）',
  /扮演规则/.test(keepD?.title || '') && keepD?.afterClick === true && keepD?.afterRepaint === true,
  keepD?.err || `${keepD?.title} · 点开 open=${keepD?.afterClick} → 重绘后 open=${keepD?.afterRepaint}`);
/* ⚠️「声明了样式」≠「样式落到了元素上」（本项目反复踩过）。这条读的是**计算样式** ——
   选择器一旦因为结构变化而落空，它是红的，而不是安安静静地不限高。 */
check('折叠块的内容容器真的被限高（选择器没落空）',
  keepD?.hasBox === true && keepD?.maxH !== 'none' && parseFloat(keepD?.maxH || '0') > 100 && keepD?.ovf === 'auto',
  keepD?.err || `内容容器 max-height=${keepD?.maxH} · overflow-y=${keepD?.ovf}`);

/* ── ⑧' 模型优先级线路的拖拽排序（2026-10-03 · sortable.js）──────────────
 * 这一组专治「坏了不会报错」的四类：
 *   ① **引擎没挂上** —— 少一个 <script> 或顺序错了，`sortable.js` 只 warn 一句
 *     就不挂载，页面照常工作、↑↓ 照常能改顺序，只是**没有拖拽**（无异常）；
 *   ② **守卫没接线** —— `softPaint` 不查 `Sortable.busy()`，于是每 3 秒的
 *     轮询把正在拖的行 innerHTML 换掉，拖拽"莫名其妙就断了"；
 *   ③ **FLIP 只做了 Invert 没做 Play** —— 顺序变了但行瞬移，没有让位；
 *   ④ **播报区是 `display:none`** —— 屏幕上看不出来，读屏也一声不吭。
 * ⚠️ 所以拖拽断言用**合成 PointerEvent**（`pointerdown/move/up`）而不是点按钮：
 *     点按钮走的是另一条路（applyIds），它绿了不代表拖拽绿了。 */
/* ── ⑨ 插件板：每块插件一块**独立玻璃板**，网格平铺（2026-10-04）─────────────
 * 这一组钉的是用户 2026-10-04 提的三条，每一条**坏了都不会报错**：
 *   ① **板数 == 插件数** —— 少画一块时页面照样正常，只是那个插件"不见了"；
 *      多画一块（板里套板）也一样不报错，只是多了一层没意义的框。
 *   ② **同排等宽** —— `1fr` 弹性列被换成 `auto` / `max-content` 时，只有最右一块
 *      变窄，肉眼几乎看不出，但"平铺"这件事已经没了。
 *   ③ **材质与全站卡片同源** —— 玻璃靠 `.pcard` 挂 `card` 类继承。若有人把材质
 *      抄一份写在 `.pcard` 上，这条会红：那时两份语义早晚会漂（玻璃每改一次，
 *      插件板就少跟一次，而没有任何测试会发现）。
 * ⚠️ 组号 6 = 「插件」域（GROUPS 里的第 7 个，0-based），子页 0 = 「插件」页。 */
await evalJs(`document.querySelectorAll('#nav1 .grp')[6].click(); return 1;`);
await sleep(200);
await evalJs(`document.querySelectorAll('#nav2 .sub')[0].click(); return 1;`);
await sleep(300);
const plug = await evalJs(`return (() => {
  const s = (window.__next && window.__next.state) ? window.__next.state : null;
  const n = s && s.extensions && Array.isArray(s.extensions.items) ? s.extensions.items.length : -1;
  const boards = [...document.querySelectorAll('#page .pgrid > .pcard')];
  const cs = boards.map((b) => b.getBoundingClientRect());
  /* 同排判定：top 相同（±1px 亚像素）才算同一排 */
  const rows = {};
  cs.forEach((r) => { const k = Math.round(r.top); (rows[k] = rows[k] || []).push(Math.round(r.width)); });
  const rowWidths = Object.values(rows).filter((w) => w.length > 1);
  const uneven = rowWidths.filter((w) => Math.max(...w) - Math.min(...w) > 1);
  /* gap **必须按"同一排内相邻两块"与"同一列内相邻两块"分别量**：
     拿 cs[1] / cs[2] 硬取第 2、3 块是错的 —— 网格换行后 cs[1] 可能就在**下一排**，
     那时算出来的"水平间隙"是负的（实测 -1357px），而板子其实排得好好的。

     ⚠️⚠️ **第二版又踩了一次**：改成"比较 cs[i-1] 与 cs[i]"仍然量不到垂直间隙 ——
     网格是**按行填充**的（索引 0,1,2 是第一排，3,4,5 是第二排），所以
     **索引相邻的两块永远不同列**，同列的那一对（0↔3）索引差 3，压根不相邻。
     实测表现：水平 8 对、垂直 **0 对**，gapY 恒为 -1。
     ⇒ 正确做法是**按坐标分组**：同一列 = left 相同；再在其中取 top 相邻的两块。
     这也是为什么"判据自己也要被反证"—— 一个量不到任何样本的判据，
     它给出的 -1 与"间距是负数"在输出上长得一模一样。 */
  const byCol = {};
  boards.forEach((b, i) => {
    const k = Math.round(cs[i].left);
    (byCol[k] = byCol[k] || []).push(i);
  });
  const gx = []; const gy = [];
  /* 水平：同一排内，left 递增方向的相邻两块 */
  for (const k of Object.keys(rows)) {
    const idx = boards.map((b, i) => i).filter((i) => Math.round(cs[i].top) === Number(k));
    for (let n = 1; n < idx.length; n++) gx.push(Math.round(cs[idx[n]].left - cs[idx[n - 1]].right));
  }
  /* 垂直：同一列内，top 递增方向的相邻两块 */
  for (const k of Object.keys(byCol)) {
    const idx = byCol[k].slice().sort((a, b) => cs[a].top - cs[b].top);
    for (let n = 1; n < idx.length; n++) gy.push(Math.round(cs[idx[n]].top - cs[idx[n - 1]].bottom));
  }
  const first = boards[0];
  return {
    declared: n,
    boards: boards.length,
    /* 间距：同一排内相邻两块的水平间隙 / 同一列内相邻两块的垂直间隙 */
    gapX: gx.length ? Math.max(...gx) : -1,
    gapY: gy.length ? Math.max(...gy) : -1,
    gapXN: gx.length,
    gapYN: gy.length,
    uneven: uneven.length,
    rows: Object.keys(rows).length,
    cols: Math.max(...Object.values(rows).map((w) => w.length), 0),
    /* ⚠️ **反向自证：真的有多列**。上面那条「同排等宽」在单列下会**假绿** ——
       一列时每排只有一个元素，rowWidths 过滤后长度 0，uneven 恒为 0。
       而"13 块板被 span 12 撑成 13 排"正是本轮真实踩到的那一个
       （.pcard 继承 .card 的 grid-column: span 12）—— 它不报错、板还在、
       玻璃还在，只有平铺没了。所以这里单独立一条判"列数 > 1"。
       窄视口（≤760px）本就设计为单列，故按视口宽度给下界。
       ⚠️⚠️ **本段是模板字符串：注释里不许出现反引号**（同 tilt.js 那段的纪律）——
       一个反引号就会提前闭合 evalJs 的模板，报出来的是"missing ) after argument
       list"，而真正的原因在几百行之外的注释里。 */
    minCols: window.innerWidth > 760 ? 2 : 1,
    /* 材质同源：backdrop-filter 必须**真的**落在计算样式上（不是被浏览器丢弃） */
    hasFilter: first ? getComputedStyle(first).backdropFilter !== 'none'
      || getComputedStyle(first).webkitBackdropFilter !== 'none' : false,
    /* 圆角与全站卡片一致 —— 同上，抄一份材质就会在这里分叉 */
    radius: first ? getComputedStyle(first).borderTopLeftRadius : '',
    toggleCount: document.querySelectorAll('#page [data-a="plugin.toggle"]').length,
    /* 外层容器检测：板**不该有 .card 祖先**。曾经整页套在一张 span-12 .card 里，
       视觉是「大玻璃板里切了 13 块」—— 而这条不报错、板还在、材质还在，
       唯一的症状就是「还是在一个大玻璃板里面」（用户 2026-10-04 截图点名）。
       只量 .pgrid 的父级不够：万一是 .card > .card-b > .pgrid 两层，
       最近父级是 .card-b 而真正的壳在上面一层，所以要 closest 向上找。 */
    outerCard: (() => {
      const g = document.querySelector('#page .pgrid');
      if (!g) return 'no-grid';
      const c = g.closest('.card');
      return c ? (c.id || 'card-without-id') : '';
    })(),
    bareExists: !!document.querySelector('#page .bare'),
    /* 命名统一：页面上不许再出现"扩展包 / 拓展"字样 */
    legacy: (document.getElementById('page').textContent || '').match(/扩展包|拓展|扩展功能/g) || [],
  };
})()`);
/* ⚠️ **这 5 条的前提是「至少有 1 块板」** —— 板上量出来的东西（列数 / 间隙 / 材质 /
 *   外层有没有 .card）在 0 块板时**没有样本可量**，判据会给出和"排版坏了"一模一样的
 *   输出（实测 `outerCard` 取到哨兵 `'no-grid'`、gap 恒 -1）。这不是"排版坏了"。
 *
 *   沙箱**刻意**不带插件：`test/sandbox.sh:121` `--exclude '/plugins/' --exclude '/skills/'`
 *   （第 44 轮 B12d · EX-PLUGIN 起的决定）⇒ `state.extensions.items` 恒为 0
 *   ⇒ `declared === 0` ⇒ 这 5 条在该路径上**永远不成立**。
 *
 *   第 57 轮之前它们是 5 条**常驻假红**。现在的处理是显式 SKIP（不是算通过）。
 *   代价如实写：此路径上这 5 条不再被验；想让它们真跑，改沙箱的排除清单，
 *   或在本机（`plugins/` 在位）直接跑 `node panel/next/verify.mjs --url …`。
 */
const plugNoSample = plug.declared === 0;
const PLUG_SKIP_REASON = `沙箱里 state.extensions.items = ${plug.declared} 个（test/sandbox.sh:121 排除 /plugins/ 与 /skills/）`
  + ` ⇒ 0 块板，这 5 条没有样本可量；真机（plugins/ 在位）跑本脚本才会真验`;

if (plugNoSample) {
  console.log(`\n⏭ 插件板 5 条**显式跳过**：${PLUG_SKIP_REASON}\n`);
  skip('插件板数 = 插件数（一个插件一块独立板，没被合并进大容器）', PLUG_SKIP_REASON);
  skip('插件板真的**横排多列**（`span 12` 没有被 `.card` 带进 `.pgrid`）', PLUG_SKIP_REASON);
  skip('插件板横向网格平铺（gap 来自 CSS，两轴同值且非零）', PLUG_SKIP_REASON);
  skip('插件板玻璃材质真的落地（backdrop-filter 在计算样式上，且圆角继承 .card）', PLUG_SKIP_REASON);
  skip('**插件板没有 .card 祖先**（外层大玻璃板已脱掉，板直接浮在背景上）', PLUG_SKIP_REASON);
} else {
  check('插件板数 = 插件数（一个插件一块独立板，没被合并进大容器）',
    plug.declared > 0 && plug.boards === plug.declared,
    `声明 ${plug.declared} 个 · 画出 ${plug.boards} 块板`);
  check('插件板真的**横排多列**（`span 12` 没有被 `.card` 带进 `.pgrid`）',
    plug.cols >= plug.minCols, `${plug.boards} 块板排成 ${plug.rows} 排 × 最多 ${plug.cols} 列（下界 ${plug.minCols}）`);
  check('插件板横向网格平铺（gap 来自 CSS，两轴同值且非零）',
    plug.gapX > 0 && plug.gapY > 0 && Math.abs(plug.gapX - plug.gapY) < 2,
    `${plug.cols} 列 × ${plug.rows} 排 · 水平间隙 ${plug.gapX}px（${plug.gapXN} 对）` +
    ` · 垂直间隙 ${plug.gapY}px（${plug.gapYN} 对）`);
  check('插件板玻璃材质真的落地（backdrop-filter 在计算样式上，且圆角继承 .card）',
    plug.hasFilter === true && /px/.test(plug.radius || ''), `border-radius=${plug.radius}`);
  check('**插件板没有 .card 祖先**（外层大玻璃板已脱掉，板直接浮在背景上）',
    plug.outerCard === '' && plug.bareExists === true,
    plug.outerCard
      ? `网格仍被 .card（id=${plug.outerCard}）包着 —— 看到的还是「一块大玻璃板里切了 N 块」`
      : (plug.bareExists ? '裸容器 .bare 在位，网格直接落在页面栅格上' : '⚠️ 找不到 .bare，插件网格这一页结构可能变了'));
}
/* 下面两条**不依赖"有没有板"**，照常判（0 块板时它们是真空绿，但判据本身不撒谎：
 *   不等宽的排数为 0、开关数等于板数，这两件事在 0 块板时本来就该成立）。 */
check('插件板同排等宽（`1fr` 弹性列真的在均分，不是 auto/max-content）',
  plug.uneven === 0, plug.rows > 0
    ? `${plug.rows} 排 × 最多 ${plug.cols} 列 · 不等宽的排 ${plug.uneven} 处 · 行间距 ${plug.gapY}px`
    : `板宽实测 ${JSON.stringify(plug)}`);
check('每个插件板都保留启用开关（改名后 data-a 已跟到 plugin.toggle）',
  plug.toggleCount === plug.boards, `开关 ${plug.toggleCount} 个 / 板 ${plug.boards} 块`);
check('界面上不再出现「扩展包 / 拓展」字样（命名已统一为插件）',
  plug.legacy.length === 0, plug.legacy.length ? `残留：${[...new Set(plug.legacy)].join('、')}` : '干净');

/* ── ⑩ 二级页签不许折行 / 不许被压扁（2026-10-04 · B43）─────────────────────
 * 用户实机截图：二级页签显示成**两行**、第二行只露上半截（"模型与线" + 半个"路"）。
 * 这一组专打它的**两个成因**，二者都是"页面完全照常工作、只是不好看"：
 *   ① **零余量**：`padding: 0 12px` + 5 个汉字 × 13px = 89px，而按钮实测**正好 89px**
 *      ⇒ 任何亚像素舍入 / 浏览器缩放 / 字体回退都能把最后一个字挤到第二行，
 *      而 `height: 26px` 是**定高** ⇒ 第二行被裁掉一半。
 *      判据见下面 `range` 那段注释（**不是** `scrollHeight`，理由写在那里）。
 *   ② **被压扁**：`flex: 0 1 auto` 在 `.navrow` 三列布局里左列被限宽时（1440 实测左列
 *      仅 302px）按钮被压到 **42px**、文字挤成三行。
 *      判据取 `scrollWidth ≤ clientWidth + 1`：**文字不许比内容盒还宽**。
 *   ⚠️ 两条必须**同时**在：只写 `nowrap` 不写 `flex: none` 仍会被压扁（② 红）；
 *      只写 `flex: none` 不写 `nowrap` 标签照样在临界宽度折行（① 红）。
 *   ⚠️ 探针**遍历全部 8 个域**：判据不能只在一个域上验 —— 别的域标签更短，
 *      只验「大脑」的话，改短某一个标签就能让整条判据失去意义。
 * ⚠️ 顺带量"装不下时是不是真的横向滚动"：溢出必须由 `.nav2` 接手（`scrollWidth > clientWidth`），
 *      否则 `nowrap` + `flex: none` 换来的就是**溢出玻璃条**而不是滚动。 */
const subFit = await evalJs(`
  const groups = [...document.querySelectorAll('#nav1 .grp')];
  const range = document.createRange();
  const out = [];
  for (let g = 0; g < groups.length; g += 1) {
    groups[g].click();
    await new Promise((r) => setTimeout(r, 160));
    const nav2 = document.getElementById('nav2');
    const subs = [...nav2.querySelectorAll('.sub')];
    const cs = subs[0] ? getComputedStyle(subs[0]) : null;
    /* ⚠️⚠️ 折行判据量的是「**文字排了几行**」—— Range 的每个 line box 给一个 rect。
       为什么不能量 scrollHeight（本项目实测踩过）：选中态的下划线是 bottom:-3px 的
       **绝对定位**元素，它向下溢出 3px，而 scrollHeight **把这段设计溢出也算进去**
       ⇒ 折行 29、不折行也 29（26+3）⇒ 这条判据会**恒红**且完全指不到"折行"。
       rects.length 量的正是它要量的那件事，且不依赖任何阈值常数。 */
    const wrapped = subs.filter((s) => {
      range.selectNodeContents(s);
      return range.getClientRects().length > 1;
    });
    /* ⚠️⚠️ 压扁判据量的是「**按钮有没有被 flex 压得比内容还窄**」——
       拿按钮宽度与它**自己的**内容盒比（**offsetWidth** vs **clientWidth − padding**）是**不够的**：
       两者永远相等（被压扁时内容盒跟着一起变小），实测注掉 **flex: none** 这条判据照样绿。
       真正量的地方在下面 natural 那段：**克隆一个同标签的探针按钮，让它不受
       .nav2 的宽度约束**，量出「这个标签本来该多宽」，再与真实按钮比。
       这也是为什么它必须在**多个宽度**下验 —— 压扁只在 .navrow 三列布局、
       左列被限宽的那档出现，单一宽度下可能压根不触发（= 判据落在真空里）。 */
    const squashed = [];
    const natural = [];
    const probeHost = document.createElement('div');
    /* 关键：探针宿主挂在 body 上、**position: fixed** 且**不设宽度上限**
       —— 只有脱离 .nav2wrap 的宽度约束，量出来的才是标签的自然宽度。 */
    probeHost.style.cssText = 'position:fixed;left:-99999px;top:0;visibility:hidden;';
    document.body.appendChild(probeHost);
    for (const s of subs) {
      const cs = getComputedStyle(s);
      const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
      const clone = document.createElement('span');
      clone.style.cssText = 'display:inline-block;white-space:nowrap;';
      clone.style.font = cs.font;
      clone.textContent = s.textContent.trim();
      probeHost.appendChild(clone);
      const nat = clone.getBoundingClientRect().width;
      clone.remove();
      /* 真实按钮可用宽 = 它自己的内容盒；比自然窄 ⇒ 被压扁 */
      if (s.clientWidth + 1 < nat) {
        squashed.push(s.textContent.trim() + '(可用 ' + (s.clientWidth - padX).toFixed(0)
          + 'px < 自然 ' + nat.toFixed(0) + 'px)');
      }
      natural.push(nat);
    }
    probeHost.remove();
    out.push({
      group: groups[g].textContent.replace(/\\d+$/, '').trim(),
      n: subs.length,
      ws: cs ? cs.whiteSpace : '',
      flex: cs ? cs.flex : '',
      wrapped: wrapped.map((s) => {
        range.selectNodeContents(s);
        return s.textContent.trim() + '(' + range.getClientRects().length + ' 行)';
      }),
      squashed: squashed,
      naturalMax: natural.length ? Math.max(...natural).toFixed(0) : '0',
      /* overflow接手：装不下时 scrollWidth > clientWidth（有横向滚动），否则是硬溢出。
         ⚠️ 判据方向见下面窄视口那条的注释（写反过一次）：sw > cw 是**接住了**的证据。 */
      scrolls: nav2.scrollWidth > nav2.clientWidth,
      sw: nav2.scrollWidth, cw: nav2.clientWidth,
      ox: getComputedStyle(nav2).overflowX,
    });
  }
  return out;
`);
const wsBad = (subFit || []).filter((r) => (r.wrapped || []).length > 0);
const sqBad = (subFit || []).filter((r) => (r.squashed || []).length > 0);
const decoBad = (subFit || []).filter((r) => r.ws !== 'nowrap' || !/^0 0 auto$/.test(r.flex || ''));
const spillBad = (subFit || []).filter((r) => !r.scrolls && r.sw > r.cw + 1 && !/auto|scroll/.test(r.ox || ''));
check('二级页签一律单行（`white-space: nowrap` 真的在计算样式上）',
  decoBad.length === 0 && wsBad.length === 0,
  decoBad.length
    ? `white-space/flex 不对：${decoBad.map((r) => r.group + '(' + r.ws + '/' + r.flex + ')').join('、')}`
    : wsBad.length
      ? `折行：${wsBad.map((r) => r.group + '→' + r.wrapped.join('、')).join(' · ')}`
      : `共 ${(subFit || []).reduce((a, r) => a + r.n, 0)} 个页签 / ${(subFit || []).length} 个域全部单行`);
check('二级页签不被压扁（`flex: none` 真的在计算样式上，文字没被挤成多行）',
  sqBad.length === 0,
  sqBad.length ? sqBad.map((r) => r.group + '→' + r.squashed.join('、')).join(' · ') : '全部保持自身宽度');
check('装不下的二级页签由横向滚动接手（不硬溢出玻璃条）',
  spillBad.length === 0,
  spillBad.length ? spillBad.map((r) => r.group + ` sw=${r.sw} cw=${r.cw}`).join(' · ') : '无溢出或已被 .nav2 接住');

/* ⚠️⚠️ **同一个探针再跑一遍窄视口** —— 上一组是在 verify 的默认宽度（1440）下跑的，
   而「被压扁」**只在 `.navrow` 的三列布局里发生**（B42：grid `1fr auto 1fr`，
   左列宽 = (视口 − 岛宽) / 2，1440 实测只有 302px）。
   ⇒ 只在 1440 验，注掉 `flex: none` 这条判据**照样绿**（= 判据落在真空里）。
   这里把视口收窄到**三列布局仍在的最小宽度**，让左列真的被限住：
   1280 是 B42 定的单列断点，所以 1300~1440 这一档才是三列布局的"最难一档"。 */
await send('Emulation.setDeviceMetricsOverride', { width: 1300, height: HEIGHT, deviceScaleFactor: 2, mobile: false });
await sleep(500);
const subFitNarrow = await evalJs(`
  const groups = [...document.querySelectorAll('#nav1 .grp')];
  const range = document.createRange();
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:-99999px;top:0;visibility:hidden;';
  document.body.appendChild(host);
  const out = [];
  for (let g = 0; g < groups.length; g += 1) {
    groups[g].click();
    await new Promise((r) => setTimeout(r, 160));
    const nav2 = document.getElementById('nav2');
    const subs = [...nav2.querySelectorAll('.sub')];
    const wrapped = subs.filter((s) => { range.selectNodeContents(s); return range.getClientRects().length > 1; });
    const squashed = [];
    for (const s of subs) {
      const cs = getComputedStyle(s);
      const clone = document.createElement('span');
      clone.style.cssText = 'display:inline-block;white-space:nowrap;';
      clone.style.font = cs.font;
      clone.textContent = s.textContent.trim();
      host.appendChild(clone);
      const nat = clone.getBoundingClientRect().width;
      clone.remove();
      if (s.clientWidth + 1 < nat) {
        squashed.push(s.textContent.trim() + '(可用 ' + (s.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)).toFixed(0)
          + 'px < 自然 ' + nat.toFixed(0) + 'px)');
      }
    }
    out.push({
      group: groups[g].textContent.replace(/\\d+$/, '').trim(),
      wrapped: wrapped.map((s) => s.textContent.trim()),
      squashed: squashed,
      /* 左列到底有多窄 —— 报出来才知道判据是真在难档位上跑的 */
      colW: Math.round(document.getElementById('nav2wrap').getBoundingClientRect().width),
      sw: nav2.scrollWidth, cw: nav2.clientWidth,
      /* overflow-x 必须真的是 auto/scroll：只写 nowrap + flex:none 而漏了它，
         装不下的部分就会**硬溢出玻璃条**（scrollWidth 照样 > clientWidth，
         所以光看 sw/cw 判断不出来 —— 这就是必须读 overflow-x 的原因）。 */
      ox: getComputedStyle(nav2).overflowX,
    });
  }
  host.remove();
  return out;
`);
const nWrapBad = (subFitNarrow || []).filter((r) => (r.wrapped || []).length > 0);
const nSqBad = (subFitNarrow || []).filter((r) => (r.squashed || []).length > 0);
check('窄视口（三列布局最窄那档）下二级页签仍不折行',
  nWrapBad.length === 0,
  nWrapBad.length ? nWrapBad.map((r) => r.group + '→' + r.wrapped.join('、')).join(' · ')
    : `1300 宽下 ${(subFitNarrow || []).length} 个域全部单行（左列实测 ${(subFitNarrow || [])[0]?.colW}px）`);
check('窄视口下二级页签不被压扁（`flex: none` 真的在难档位上生效）',
  nSqBad.length === 0,
  nSqBad.length ? nSqBad.map((r) => r.group + '→' + r.squashed.join('、')).join(' · ')
    : `1300 宽下全部保持自然宽度（左列 ${(subFitNarrow || [])[0]?.colW}px）`);
/* ⚠️ 判据方向：**溢出量 > 容器量**正是「.nav2 已经在横向滚动」的证据（`scrollWidth`
   只在真能滚时才大于 `clientWidth`）—— 所以要判的是「**溢出被接住了**」，
   不是「有没有溢出」。本条第一版写成 `sw > cw ⇒ 红`，结果 1300 宽下 8 个域全被误报
   （把"滚动正常工作"报成了故障）。真正该红的是"溢出但**接不住**"：
   `.nav2` 上没有 `overflow-x: auto` 时 scrollWidth 仍 > clientWidth，
   而用户看到的是文字**溢出玻璃条**。 */
const nNoScroll = (subFitNarrow || []).filter((r) => r.sw > r.cw + 1 && !/auto|scroll/.test(r.ox || ''));
check('窄视口下装不下的页签真的能横向滚动（不是溢出玻璃条）',
  nNoScroll.length === 0,
  nNoScroll.length ? nNoScroll.map((r) => r.group + ` sw=${r.sw} cw=${r.cw} overflowX=${r.ox}`).join(' · ')
    : `${(subFitNarrow || []).filter((r) => r.sw > r.cw + 1).length} 个域装不下，但都由 .nav2 横向滚动接住`);
/* 复原到默认宽度：后面那组「页面干净」断言在正常宽度下量才与历史可比。 */
await send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, deviceScaleFactor: 2, mobile: false });
await sleep(400);

/* ── ⑩ 交互完之后页面必须回到"干净"（没有残留的遮罩 / 脏草稿） ────────── */
await sleep(1500);
const clean = await evalJs(`return {
  busy: !document.getElementById('busy').hidden,
  savebar: !document.getElementById('savebar').hidden,
  dirty: window.__next ? [...window.__next.dirty] : [],
  modal: !document.getElementById('modal').hidden,
}`);
check('交互后没有残留遮罩 / 脏草稿 / 弹窗',
  !clean.busy && !clean.savebar && clean.dirty.length === 0 && !clean.modal,
  `busy=${clean.busy} savebar=${clean.savebar} modal=${clean.modal} dirty=[${clean.dirty.join(',')}]`);

/* ── ⑦ 页面运行时报错 ───────────────────────────────────────────────── */
const realErrors = errors.filter((e) => !/Not implemented|favicon|net::ERR/i.test(e));
check('页面无运行时异常', realErrors.length === 0, realErrors.slice(0, 3).join(' | '));

const shot2 = await maybeShot('02-persona-enhance', 2, 1);
const shot3 = await maybeShot('03-plugins', 6, 0);

/* ── 汇总 ───────────────────────────────────────────────────────────── */
const pass = results.filter((r) => r.ok && !r.skipped).length;
const skippedN = results.filter((r) => r.skipped).length;
// ⚠️ **跳过必须看得见，且不计入"通过"**：把 skip 算成 pass 就是"真空里通过"那一类 ——
//    它和真通过打出来一模一样，而下一个人会以为这 5 条**验过了**。
//    所以：总数（results.length）不变、通过数不含 skip，且单独打出跳过的条数与原因。
console.log(`\n结果：${pass}/${results.length} 通过`
  + (skippedN ? `（另有 ${skippedN} 条**显式跳过**：既非通过也非失败，见上面 ⏭ 行）` : ''));
console.log(`截图：${shot1}\n      ${shot2}\n      ${shot3}`);
console.log(`规模：${groupCount} 个域 · ${pagesChecked} 个页面 · ${cardsTotal} 张卡`);
ws.close(); cleanup();
process.exit(pass + skippedN === results.length ? 0 : 1);
