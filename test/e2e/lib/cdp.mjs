/**
 * CDP 脚手架 —— **唯一实现**（M-07 · 第 11 轮 · 2026-10-05）。
 *
 * 为什么要有这个文件：`browser-verify.mjs` 与 `browser-restart-verify.mjs` 此前**各自抄了一份**
 * 这套东西 —— Chrome 启动参数、等 `json/list` 出目标、`WebSocket` 连接、`send` / `evalJs` / `shot`、
 * 收尾的 `ws.close()` + `process.kill(-chrome.pid)`，合计约 70–90 行逐字重复。
 *
 * ⚠️ 这类重复的代价是**静默的**：两边只改一边时，表现是"某支脚本的截图与断言悄悄跑在另一套参数上"
 *   （端口 / 视口 / 等待时机），而**没有任何东西会因此报警**。这与本项目在 `fnBody` 上吃过的亏同型
 *   （见 `scripts/lib/scan-utils.mjs` 文件头：逐字复制 6 份，改 2 处漏 6 处）。
 *
 * ⚠️ 用法约束：这批脚本**碰真机 / 真浏览器**，不进 `npm test`（见 `test/e2e/README.md`）；
 *   它们各自需要面板正在 `127.0.0.1:8788` 上跑。本模块**不做**任何断言，只提供驱动能力。
 */
import fs from 'node:fs';
import { spawn } from 'node:child_process';

/** Chromium headless shell（playwright 只缓存了浏览器二进制，npm 包没装 —— 所以直连 CDP）。 */
export const CHROME = `${process.env.HOME}/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell`;

/** 小睡一会儿（两支脚本里这一段也各写了一份）。 */
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 通过 / 失败计数 + `check()`（原先两支脚本各写一份逐字相同的实现）。 */
export function makeCounter() {
  let pass = 0;
  let fail = 0;
  const check = (name, cond, extra = '') => {
    if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
    else { fail += 1; console.log(`  ✗ ${name}${extra ? '  → ' + extra : ''}`); }
  };
  return { check, counts: () => ({ pass, fail }) };
}

/**
 * 起一个 headless Chromium、连上 CDP、导航到面板、把视口铺成桌面宽度，
 * 返回驱动器 `{ send, evalJs, shot, waitFor, close }`。
 *
 * 那些"两支脚本各调各的"的差别全部做成**显式参数**（默认值 = `browser-verify.mjs` 的取值），
 * 于是两边的原始行为都被逐字保留，而实现只有这一份。
 */
export async function launchCdp({
  port,
  panelUrl,
  outDir,
  userDataDir,
  windowSize = '1440,1100',
  extraArgs = [],
  readyExpr = "document.readyState === 'complete' && typeof lastState !== 'undefined' && !!lastState",
  readyTimeoutMs = 15000,
  readyStepMs = 200,
  preOverrideMs = 0,       // 「铺视口**之前**」那一段等待（首屏 refresh + 轮询铺工作台）
  postOverrideMs = 0,      // 铺完视口之后那一段等待
  captureBeyondViewport = false,
  clampClip = false,       // 裁切坐标是否夹到 0（元素在视口外时为负）
  verbose = true,
}) {
  fs.mkdirSync(outDir, { recursive: true });

  const chrome = spawn(CHROME, [
    // --no-sandbox / --disable-gpu 是必须的：这个执行环境不允许 Chromium 建自己的渲染沙箱
    // （报 "sandbox initialization failed: Operation not permitted"），不开它连 about:blank
    // 都渲染不出来。页面是 127.0.0.1 的本地控制台，关掉 Chromium 自带沙箱不影响验证的有效性。
    '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--headless',
    `--remote-debugging-port=${port}`, `--user-data-dir=${userDataDir}`,
    `--window-size=${windowSize}`, '--hide-scrollbars', '--no-first-run',
    ...extraArgs, 'about:blank',
  ], { stdio: 'ignore', detached: true });
  chrome.unref();

  const waitFor = async (fn, ms = readyTimeoutMs, step = readyStepMs) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      try { const v = await fn(); if (v) return v; } catch { /* 还没起来 */ }
      await sleep(step);
    }
    throw new Error('等待超时');
  };

  const target = await waitFor(async () => {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    return list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  });
  if (verbose) console.log('浏览器已就绪，开始驱动页面\n');

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let seq = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const send = (method, params = {}) => new Promise((res) => {
    const id = ++seq;
    pending.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
  });

  /** 在页面里跑一段 JS，拿回它的值（支持 await） */
  const evalJs = async (expr) => {
    const m = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (m.result?.exceptionDetails) throw new Error(m.result.exceptionDetails.text + ' :: ' + String(expr).slice(0, 80));
    return m.result?.result?.value;
  };

  /** 截一张图。给了 selector 就只截那个元素的范围。 */
  const shot = async (file, selector) => {
    const params = { format: 'png' };
    if (captureBeyondViewport) params.captureBeyondViewport = true;
    if (selector) {
      const box = await evalJs(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.x + window.scrollX, y: r.y + window.scrollY, w: r.width, h: r.height };
      })()`);
      if (box) {
        const x = clampClip ? Math.max(0, box.x - 8) : box.x - 8;
        const y = clampClip ? Math.max(0, box.y - 8) : box.y - 8;
        params.clip = { x, y, width: box.w + 16, height: box.h + 16, scale: 2 };
      }
    }
    const m = await send('Page.captureScreenshot', params);
    fs.writeFileSync(`${outDir}/${file}`, Buffer.from(m.result.data, 'base64'));
    console.log(`  · 截图 ${file}`);
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.navigate', { url: panelUrl });
  await waitFor(async () => await evalJs(readyExpr));
  if (preOverrideMs) await sleep(preOverrideMs);
  // 把窗口拉宽，保证两列都展开（headless 默认 800 宽会触发窄屏布局）
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 2, mobile: false });
  if (postOverrideMs) await sleep(postOverrideMs);

  /** 收尾：断 WS + **杀整个进程组**（`detached` 起的那棵 Chromium 树）。 */
  const close = () => {
    ws.close();
    try { process.kill(-chrome.pid, 'SIGKILL'); } catch { /* 已退出 */ }
  };

  return { send, evalJs, shot, waitFor, close };
}
