#!/usr/bin/env node
/**
 * 人设工厂 · 主树二级导航集成验收（真浏览器 + 真沙箱面板）。
 *
 * 覆盖：
 *  · 工厂域二级栏 = 视觉 / 人设 / 插件三个 frame 页 + 插件管理 / Skill 两个普通页，顶栏三颗圆钮已删除；
 *  · 打开人设工厂：同一 host、persona 帧 ready，导航压在工厂之上且可点；
 *  · 人设 ↔ 视觉 ↔ 插件切换不重建 iframe，loadCount 不增长；
 *  · 离开工厂域再重进，两帧都不重载、厂内状态保留；
 *  · 1024 / 768 / 390 工厂铺满、导航可点、厂内不横向溢出；
 *  · 无脚本异常、无工厂资产 404。
 *
 * 找不到 Chromium 系浏览器时 SKIP + exit 0（环境缺失不该变成假红）。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const NODE = process.execPath;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  const cache = path.join(home, 'Library', 'Caches', 'ms-playwright');
  try {
    for (const d of fs.readdirSync(cache)) {
      for (const sub of ['chrome-headless-shell-mac-arm64/chrome-headless-shell', 'chrome-headless-shell-mac-x64/chrome-headless-shell']) {
        const p = path.join(cache, d, sub);
        if (fs.existsSync(p)) return p;
      }
    }
  } catch { /* 没这个目录 */ }
  return null;
}
const BROWSER = findBrowser();
if (!BROWSER) {
  console.log('SKIP 人设工厂面板集成：本机没有找到 Chromium 系浏览器。');
  process.exit(0);
}

const freePort = () => new Promise((res, rej) => {
  const s = net.createServer();
  s.on('error', rej);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
});
const tcpUp = (p, ms = 800) => new Promise((res) => {
  const s = net.connect({ port: p, host: '127.0.0.1' });
  const done = (v) => { s.destroy(); res(v); };
  s.setTimeout(ms); s.on('connect', () => done(true));
  s.on('timeout', () => done(false)); s.on('error', () => done(false));
});

const panelPort = await freePort();
const cdpPort = await freePort();
const BASE = `http://127.0.0.1:${panelPort}`;
const USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-panel-user-'));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-panel-browser-'));
const fails = [];
const ok = (cond, msg) => { console.log(`${cond ? '  ✓' : '  ✗'} ${msg}`); if (!cond) fails.push(msg); };

function prepareUserRoot() {
  const ex = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.example.json'), 'utf8'));
  ex.persona = ex.persona || {};
  ex.persona.name = '沙箱小星';
  ex.persona.file = 'persona/qq-chat.md';
  ex.custom = ex.custom && typeof ex.custom === 'object' ? ex.custom : {};
  ex.custom.persona = { ...(ex.custom.persona || {}), role: '沙箱里的测试角色', traits: '温柔、慢热', tone: '说话轻一点。' };
  ex.custom.enhance = { ...(ex.custom.enhance || {}), limits: '不拿家人开玩笑。' };
  ex.custom.replyStyle = { ...(ex.custom.replyStyle || {}), length: 'normal' };
  fs.writeFileSync(path.join(USERDATA, 'config.json'), JSON.stringify(ex, null, 2), 'utf8');
  fs.mkdirSync(path.join(USERDATA, 'persona'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'persona', 'qq-chat.md'), path.join(USERDATA, 'persona', 'qq-chat.md'));
  fs.mkdirSync(path.join(USERDATA, 'data'), { recursive: true });
}

let panel = null;
let browser = null;
let ws = null;
try {
  prepareUserRoot();
  panel = spawn(NODE, ['panel/server.js'], {
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
  let up = false;
  for (let i = 0; i < 80; i += 1) {
    if (await tcpUp(panelPort, 400)) { up = true; break; }
    await sleep(200);
  }
  ok(up, '沙箱面板已启动');
  if (!up) throw new Error('沙箱面板起不来：' + srvOut.slice(-800));

  browser = spawn(BROWSER, [
    '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--headless',
    `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`,
    '--window-size=1440,1000', '--hide-scrollbars', '--no-first-run', 'about:blank',
  ], { stdio: 'ignore', detached: true });
  browser.unref();

  let targets = null;
  for (let i = 0; i < 80; i += 1) {
    try {
      const r = await fetch(`http://127.0.0.1:${cdpPort}/json/list`);
      if (r.ok) { targets = await r.json(); if (targets.length) break; }
    } catch { /* not up */ }
    await sleep(150);
  }
  if (!targets || !targets.length) throw new Error('CDP 起不来');
  const page = targets.find((t) => t.type === 'page') || targets[0];
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  let seq = 0;
  const pending = new Map();
  const exceptions = [];
  const badResponses = [];
  ws.addEventListener('message', (ev) => {
    let m;
    try { m = JSON.parse(ev.data); } catch { return; }
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result);
    } else if (m.method === 'Runtime.exceptionThrown') {
      exceptions.push(m.params?.exceptionDetails?.text || 'exception');
    } else if (m.method === 'Network.responseReceived' && m.params?.response?.status >= 400) {
      badResponses.push({ url: m.params.response.url, status: m.params.response.status });
    }
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Network.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `window.__errs=[];addEventListener('error',e=>__errs.push(String(e.message)));addEventListener('unhandledrejection',e=>__errs.push(String(e.reason)));`,
  });
  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || ''));
    return r.result.value;
  };
  const wait = async (expr, ms = 12000) => {
    const t = Date.now();
    while (Date.now() - t < ms) {
      try { if (await ev(expr)) return true; } catch { /* navigating */ }
      await sleep(120);
    }
    return false;
  };
  const setViewport = async (w, h) => {
    await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
    await sleep(200);
  };


  await setViewport(1440, 1000);
  await send('Page.navigate', { url: BASE + '/' });
  const ready = await wait('document.readyState==="complete" && !!window.__factoryFrame && !!document.querySelector("#nav1 .grp")', 15000);
  ok(ready, '面板首屏可进入');
  await sleep(600);
  await wait(`(() => { const b=document.getElementById('bootSplash'); return !b || b.hidden === true; })()`, 15000);

  const personaSel = '#factoryHost iframe[data-frame="persona-factory.html"]';
  const visualSel = '#factoryHost iframe[data-frame="visual-factory.html"]';

  const clickFactoryGroup = async () => ev(`(() => {
    const g = [...document.querySelectorAll('#nav1 .grp')].find((b) => (b.title || b.textContent || '').includes('工厂'));
    if (!g) return false;
    g.click(); return true;
  })()`);
  const clickFactorySub = async (name) => ev(`(() => {
    const s = [...document.querySelectorAll('#nav2 .sub')].find((b) => (b.title || b.textContent || '').includes(${JSON.stringify(name)}));
    if (!s) return false;
    s.click(); return true;
  })()`);
  const leaveFactory = async () => { await ev(`document.querySelectorAll('#nav1 .grp')[0].click()`); await sleep(650); };
  const waitNavHidden = async () => {
    for (let i = 0; i < 30; i += 1) {
      if (await ev(`document.body.classList.contains('nav-auto-hidden')`)) return true;
      await sleep(100);
    }
    return false;
  };
  const revealNav = async () => {
    await ev(`(() => {
      const h = document.getElementById('navHotzone');
      if (window.__navAutoHide && !window.__navAutoHide.state().armed) h.dispatchEvent(new PointerEvent('pointerleave', { bubbles: true }));
      h.dispatchEvent(new PointerEvent('pointerenter', { bubbles: true }));
      return true;
    })()`);
    await sleep(420);
  };

  await clickFactoryGroup(); await sleep(620);
  const autoHidden = await waitNavHidden();
  ok(autoHidden, '进入工厂后导航自动上收');
  await revealNav();
  const nav = await ev(`(() => {
    const subs = [...document.querySelectorAll('#nav2 .sub')];
    const g = [...document.querySelectorAll('#nav1 .grp')].find((b) => (b.title || b.textContent || '').includes('工厂'));
    return { labels: subs.map((b) => (b.title || b.textContent || '').trim()), frames: subs.map((b) => b.dataset.frame || ''),
      count: g ? (g.querySelector('.cnt') || {}).textContent : '',
      topbarBtns: ['factoryBtn', 'personaFactoryBtn', 'pluginFactoryBtn'].filter((id) => !!document.getElementById(id)).length };
  })()`);
  ok(nav?.labels?.length === 5 && nav.labels.join('|') === '视觉工厂|人设工厂|插件工厂|插件管理|Skill'
    && nav.frames.filter(Boolean).join('|') === 'visual-factory.html|persona-factory.html|plugin-factory.html'
    && nav.count === '5' && nav.topbarBtns === 0,
    `工厂二级栏 = 三 frame + 插件管理 / Skill，顶栏圆钮已删除（${JSON.stringify(nav)}）`);

  ok(await clickFactorySub('人设工厂'), '人设工厂二级页可点');
  const personaReady = await wait(`(() => {
    const f=document.querySelector('${personaSel}'); const d=f?.contentDocument;
    return !!f && window.__factoryFrame.state().active === 'persona'
      && document.body.classList.contains('is-frame-page')
      && document.body.classList.contains('factory-frame-ready')
      && !!d?.querySelector('.site-header')
      && d.defaultView?.__personaStudio?.state?.().mode === 'online'
      && d.querySelectorAll('[data-start="preset"]').length === 6;
  })()`, 30000);
  const openState = await ev(`(() => {
    const host=document.getElementById('factoryHost'); const h=host.getBoundingClientRect();
    const nav=document.getElementById('navrow'); const nr=nav.getBoundingClientRect();
    const t=document.querySelector('.topbar'); const tr=t.getBoundingClientRect();
    const gear=document.getElementById('setGear');
    const hs=getComputedStyle(host), ns=getComputedStyle(nav), ts=getComputedStyle(t), gs=getComputedStyle(gear);
    const pp=document.querySelector('#factoryHost .factory-pane[data-factory="persona"]');
    const vp=document.querySelector('#factoryHost .factory-pane[data-factory="visual"]');
    const d=document.querySelector('${personaSel}').contentDocument;
    const subs=[...document.querySelectorAll('#nav2 .sub')];
    const sub=subs.find((b)=>(b.title||b.textContent||'').includes('人设工厂'));
    const sr=sub.getBoundingClientRect();
    const hit=document.elementFromPoint(Math.round(sr.left+sr.width/2), Math.round(sr.top+sr.height/2));
    return { open:document.body.classList.contains('is-frame-page'), active:window.__factoryFrame.state().active,
      ready:document.body.classList.contains('factory-frame-ready'),
      host:{ top:Math.round(h.top), bottom:Math.round(h.bottom), left:Math.round(h.left), w:Math.round(h.width), aria:host.getAttribute('aria-hidden'), vis:getComputedStyle(host).visibility, z:+hs.zIndex||0 },
      nav:{ z:+ns.zIndex||0 }, topbar:{ z:+ts.zIndex||0, bottom:Math.round(tr.bottom) }, gearZ:+gs.zIndex||0,
      innerW:innerWidth, innerH:innerHeight,
      pHidden:!!pp?.hidden, vHidden:!!vp?.hidden,
      src:document.querySelector('${personaSel}')?.getAttribute('src')||'',
      pageCls:document.getElementById('page').className,
      selected:(subs.find((b)=>b.getAttribute('aria-selected')==='true')||{}).textContent||'',
      navHit:!!(hit && hit.closest && hit.closest('#nav2 .sub')),
      docOverflow:d.documentElement.scrollWidth-d.documentElement.clientWidth,
      contentW:Math.round(d.querySelector('.workspace').getBoundingClientRect().width),
      loads:window.__factoryFrame.state().frames };
  })()`);
  ok(personaReady && openState.open && openState.active === 'persona' && openState.ready
    && openState.host.aria === 'false' && openState.host.vis === 'visible'
    && Math.abs(openState.host.top - openState.topbar.bottom) <= 1
    && Math.abs(openState.host.bottom - openState.innerH) <= 20
    && Math.abs(openState.host.w - openState.innerW) <= 20
    && openState.host.z < openState.nav.z && openState.nav.z < openState.topbar.z
    && openState.gearZ > openState.host.z && openState.navHit
    && !openState.pHidden && openState.vHidden
    && /persona-factory\.html/.test(openState.src)
    && openState.selected === '人设工厂',
    `人设工厂在工厂二级页打开、导航浮在工厂之上且可点（${JSON.stringify(openState)}）`);
  ok(openState.docOverflow <= 1 && openState.contentW <= 1364,
    `厂内不横向溢出、内容 1360 居中（溢出 ${openState.docOverflow} · 内容 ${openState.contentW}）`);

  await ev(`document.querySelector('${personaSel}').contentDocument.defaultView.__personaKeep = 1`);
  await ev(`(() => { const d=document.querySelector('${personaSel}').contentDocument; d.querySelector('[data-start="preset"]').click(); })()`);
  await sleep(450);
  await ev(`(() => { const d=document.querySelector('${personaSel}').contentDocument; d.getElementById('btnNext').click(); })()`);
  await sleep(260);
  const dir = await ev(`document.querySelector('${personaSel}').contentDocument.querySelector('.form-step').dataset.dir`);
  await ev(`(() => { const d=document.querySelector('${personaSel}').contentDocument; d.getElementById('btnPrev').click(); })()`);
  await sleep(220);
  ok(dir === 'next', `厂内步进仍走方向动画（${dir}）`);

  ok(await clickFactorySub('视觉工厂'), '视觉工厂二级页可点');
  const toVisual = await wait(`(() => {
    const f=document.querySelector('${visualSel}');
    return window.__factoryFrame.state().active === 'visual'
      && document.body.classList.contains('is-frame-page')
      && !!f?.contentDocument?.querySelector('#app');
  })()`, 30000);
  const switchState = await ev(`(() => {
    const pp=document.querySelector('#factoryHost .factory-pane[data-factory="persona"]');
    const vp=document.querySelector('#factoryHost .factory-pane[data-factory="visual"]');
    return { active:window.__factoryFrame.state().active,
      pHidden:!!pp?.hidden, vHidden:!!vp?.hidden,
      loads:window.__factoryFrame.state().frames };
  })()`);
  ok(toVisual && switchState.active === 'visual' && switchState.pHidden && !switchState.vHidden
    && switchState.loads.persona.loadCount === openState.loads.persona.loadCount,
    `人设 → 视觉只切帧不重载（persona loadCount ${openState.loads.persona.loadCount} → ${switchState.loads.persona.loadCount}）`);

  ok(await clickFactorySub('人设工厂'), '人设工厂可切回');
  await sleep(500);
  const back = await ev(`(() => {
    const pp=document.querySelector('#factoryHost .factory-pane[data-factory="persona"]');
    const vp=document.querySelector('#factoryHost .factory-pane[data-factory="visual"]');
    const f=document.querySelector('${personaSel}');
    return { active:window.__factoryFrame.state().active, pHidden:!!pp?.hidden, vHidden:!!vp?.hidden,
      keep:f?.contentDocument?.defaultView?.__personaKeep || 0,
      loads:window.__factoryFrame.state().frames };
  })()`);
  ok(back.active === 'persona' && !back.pHidden && back.vHidden && back.keep === 1
    && back.loads.persona.loadCount === openState.loads.persona.loadCount
    && back.loads.visual.loadCount === switchState.loads.visual.loadCount,
    `玻璃 → 人设切回：两帧都不重载、厂内状态保留（${JSON.stringify({ persona: back.loads.persona.loadCount, visual: back.loads.visual.loadCount, keep: back.keep })}）`);

  await ev(`window.__factoryTestFrames = { visual: document.querySelector('${visualSel}'), persona: document.querySelector('${personaSel}') }; true`);
  await leaveFactory();
  const closed = await ev(`(() => { const h=document.getElementById('factoryHost'); const n=document.getElementById('navrow'); return {
    open:document.body.classList.contains('is-frame-page'), frame:document.getElementById('page').dataset.frame||'',
    pageCls:document.getElementById('page').className, aria:h.getAttribute('aria-hidden'), vis:getComputedStyle(h).visibility,
    ready:document.body.classList.contains('factory-frame-ready'),
    navHidden:document.body.classList.contains('nav-auto-hidden'), navInert:n.inert===true, navVis:getComputedStyle(n).visibility }; })()`);
  ok(!closed.open && !closed.frame && !/page--frame/.test(closed.pageCls)
    && closed.aria === 'true' && closed.vis === 'hidden' && !closed.ready
    && !closed.navHidden && !closed.navInert && closed.navVis === 'visible',
    `离开工厂域后工厂层收起、导航复位为常显（${JSON.stringify(closed)}）`);

  await clickFactoryGroup(); await sleep(620);
  const reHidden = await waitNavHidden();
  await revealNav();
  const re = await ev(`(() => { const st=window.__factoryFrame.state(); const n=document.getElementById('navrow'); return {
    active:st.active, open:st.open, ready:document.body.classList.contains('factory-frame-ready'),
    hostVis:getComputedStyle(document.getElementById('factoryHost')).visibility,
    personaLoads:st.frames.persona.loadCount, visualLoads:st.frames.visual.loadCount,
    personaKeep:(document.querySelector('${personaSel}')?.contentDocument?.defaultView?.__personaKeep)||0,
    sameVisual:window.__factoryTestFrames.visual === document.querySelector('${visualSel}'),
    samePersona:window.__factoryTestFrames.persona === document.querySelector('${personaSel}'),
    navHidden:document.body.classList.contains('nav-auto-hidden'), navInert:n.inert===true }; })()`);
  ok(reHidden && re.active === 'visual' && re.open && re.ready && re.hostVis === 'visible'
    && re.sameVisual && re.samePersona
    && re.personaLoads === openState.loads.persona.loadCount
    && re.visualLoads === switchState.loads.visual.loadCount
    && re.personaKeep === 1
    && !re.navHidden && !re.navInert,
    `重进工厂再次上收后可呼出、两帧都不重载（${JSON.stringify({ re, reHidden })}）`);
  await leaveFactory();

  for (const [w, h] of [[1024, 900], [768, 900], [390, 844]]) {
    await setViewport(w, h);
    await clickFactoryGroup(); await sleep(620);
    const vHidden = await waitNavHidden();
    await revealNav();
    await clickFactorySub('人设工厂');
    const readyAt = await wait(`window.__factoryFrame.state().active === 'persona' && document.body.classList.contains('factory-frame-ready')`, 8000);
    const m = await ev(`(() => {
      const host=document.getElementById('factoryHost').getBoundingClientRect();
      const top=document.querySelector('.topbar').getBoundingClientRect();
      const subs=[...document.querySelectorAll('#nav2 .sub')];
      const sub=subs.find((b)=>(b.title||b.textContent||'').includes('人设工厂'));
      const sr=sub.getBoundingClientRect();
      const hit=document.elementFromPoint(Math.round(sr.left+sr.width/2), Math.round(sr.top+sr.height/2));
      const f=document.querySelector('${personaSel}'); const d=f?.contentDocument;
      return { open:document.body.classList.contains('is-frame-page'),
        topGap:Math.round(host.top-top.bottom), left:Math.round(host.left), right:Math.round(innerWidth-host.right), bottom:Math.round(innerHeight-host.bottom),
        overflow:document.documentElement.scrollWidth-innerWidth, innerW:innerWidth,
        navHit:!!(hit && hit.closest && hit.closest('#nav2 .sub')),
        innerOverflow:d?d.documentElement.scrollWidth-d.documentElement.clientWidth:-1 };
    })()`);
    ok(vHidden && readyAt && m.open && m.topGap === 0 && m.left === 0 && m.right === 0 && m.bottom === 0
      && m.navHit && m.innerOverflow <= 1 && (w < 700 || m.overflow <= 1),
      `${w}px 工厂铺满 / 导航自动上收后呼出可点 / 厂内不横向溢出（${JSON.stringify({ ...m, vHidden })}）`);
    await leaveFactory();
  }

  await setViewport(1440, 1000);
  const errs = await ev('window.__errs || []');
  const factoryFails = badResponses.filter((x) => /persona-factory|persona-entry|persona-studio/i.test(x.url));
  ok(errs.length === 0 && exceptions.length === 0 && factoryFails.length === 0,
    `无脚本异常 / 人设工厂资产无 404（${errs.join('|') || '0'} · ${exceptions.join('|') || '0'} · ${factoryFails.map((x) => x.url).join('|') || '0'}）`);

} catch (e) {
  console.error('VERIFY ERROR', e?.stack || e);
  fails.push(String(e?.message || e));
} finally {
  try { ws?.close(); } catch { /* ignore */ }
  try { if (browser) process.kill(-browser.pid, 'SIGKILL'); } catch { /* ignore */ }
  try { if (panel) process.kill(-panel.pid, 'SIGKILL'); } catch { /* ignore */ }
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
  try { fs.rmSync(USERDATA, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(fails.length ? `\n✗ 人设工厂主树集成失败 ${fails.length} 项` : '\n✓ 人设工厂主树集成通过');
process.exit(fails.length ? 1 : 0);
