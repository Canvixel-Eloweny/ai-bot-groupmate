/**
 * 像素级「同排控件是否调平」审计 —— 真实浏览器渲染，只读不改任何配置。
 *
 * 为什么需要它：面板测试跑在 jsdom 上，而 jsdom **不做排版计算** ——
 * 规则读得到、像素量不出。"每排第一颗胶囊被抬高 6px" 这类纯视觉缺陷，
 * 在 jsdom 里永远测不出来（2026-09-18 就是这么漏掉的）。
 *
 * 判据（两个条件必须同时满足）：
 *   ① 同一排内所有控件**高度完全相同**
 *   ② 同一排内所有控件**顶线完全相同**
 * "同一排"的定义见下面 cluster(): 先按精确 top 聚类会把错位的那一颗自成一类、
 * 单成员被跳过 → 直接漏报（初版就是这么假绿的），所以改成"纵向区间重叠才算同一排"。
 *
 * 用法：
 *   node test/audit-align.mjs                       # 默认查 http://127.0.0.1:8788（本机面板）
 *   BASE=http://127.0.0.1:8790 node test/audit-align.mjs   # 查沙箱
 *   WIDTHS=1440,1064,768 node test/audit-align.mjs  # 自定义视口宽度
 *
 * 依赖：需要一个 Chromium 内核的无头浏览器 + puppeteer-core。
 * **找不到就打印 SKIP 并以 0 退出**，绝不造成"假失败" ——
 * 所以它适合挂在测试流程里，但默认不参与 npm test（要不要挂，由你定）。
 * 想指定浏览器：CHROME_PATH=/path/to/chrome（或 chromium / chrome-headless-shell）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const BASE = process.env.BASE || 'http://127.0.0.1:8788';
const WIDTHS = (process.env.WIDTHS || '1440,1280,1060,940,820,700').split(',').map(Number);
const HOME = process.env.HOME || '';

/** 按「环境变量 → 常见安装位置」找 Chromium 内核的浏览器，找不到返回 null */
function findChrome() {
  const explicit = process.env.CHROME_PATH;
  if (explicit && fs.existsSync(explicit)) return explicit;
  const cands = [
    `${HOME}/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
    `${HOME}/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell`,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ];
  return cands.find((p) => fs.existsSync(p)) || null;
}

/** puppeteer-core 允许装在项目外（本项目 node_modules 只装了 ws），所以多找几个位置 */
function findPuppeteer() {
  const require = createRequire(import.meta.url);
  const tries = [
    'puppeteer-core',
    `${HOME}/.dsh/profiles/web/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js`,
    `${HOME}/.dsh/profiles/web/node_modules/puppeteer-core`,
  ];
  for (const t of tries) {
    try { return require(t); } catch { /* 继续找下一个 */ }
  }
  return null;
}

const chromePath = findChrome();
const puppeteer = findPuppeteer();
if (!chromePath || !puppeteer) {
  console.log(`SKIP 像素级对齐审计：${!chromePath ? '没找到 Chromium 内核浏览器（可用 CHROME_PATH 指定）' : '没找到 puppeteer-core'}`);
  process.exit(0);
}

// 沙箱会把 127.0.0.1 的请求也塞进代理，得显式绕开
const launchPuppeteer = puppeteer.default || puppeteer;
const browser = await launchPuppeteer.launch({
  executablePath: chromePath,
  headless: true,
  args: ['--no-proxy-server', '--no-sandbox'],
});
const page = await browser.newPage();
await page.setViewport({ width: WIDTHS[0], height: 1000, deviceScaleFactor: 2 });

let problems = 0;
let checked = 0;
const heights = new Set();

for (const w of WIDTHS) {
  await page.setViewport({ width: w, height: 1000, deviceScaleFactor: 2 });
  await page.goto(BASE, { waitUntil: 'networkidle0', timeout: 30000 });
  await new Promise((r) => setTimeout(r, 900)); // 等首屏渲染稳定

  const rows = await page.evaluate(() => {
    // 只看每排的**直接子控件**，避免把卡片里的按钮混进来
    const SEL = [':scope > button', ':scope > .chk', ':scope > input', ':scope > select'].join(', ');
    const out = [];
    document.querySelectorAll('.row, .line').forEach((row) => {
      const kids = [...row.querySelectorAll(SEL)]
        .filter((e) => { const r = e.getBoundingClientRect(); return r.height > 0 && r.width > 0; })
        .map((e) => {
          const r = e.getBoundingClientRect();
          return { t: (e.textContent || e.value || e.type || '').trim().slice(0, 9), top: r.top, h: r.height };
        })
        .sort((a, b) => a.top - b.top);
      if (kids.length < 2) return;

      // 纵向区间重叠 → 同一视觉排。flex-wrap 换行出来的第二行区间不重叠，会被正确分开。
      const lines = [];
      for (const it of kids) {
        const hit = lines.find((ln) => it.top < Math.max(...ln.map((x) => x.top + x.h)) - 1);
        if (hit) hit.push(it); else lines.push([it]);
      }
      lines.filter((ln) => ln.length >= 2).forEach((ln, i) => {
        const hs = ln.map((x) => x.h);
        const ts = ln.map((x) => x.top);
        out.push({
          id: row.id || '(anon)', line: i,
          h: +hs[0].toFixed(1),
          hSpread: +(Math.max(...hs) - Math.min(...hs)).toFixed(1),
          tSpread: +(Math.max(...ts) - Math.min(...ts)).toFixed(1),
          members: ln.map((x) => `${x.t}=${x.h}`),
        });
      });
    });
    return out;
  });

  for (const r of rows) {
    checked++;
    heights.add(r.h);
    if (r.hSpread > 0 || r.tSpread > 0) {
      problems++;
      console.log(`⚠️  ${w}px  行 ${r.id}#${r.line}  高极差 ${r.hSpread} 顶线极差 ${r.tSpread}  [${r.members.join(' ')}]`);
    }
  }
  console.log(`${String(w).padStart(5)}px  视觉排 ${rows.length}  不一致 ${rows.filter((x) => x.hSpread || x.tSpread).length}`);
}

console.log(`\n真实渲染的控件高度取值：${[...heights].sort((a, b) => a - b).join(', ')} px`);
console.log(problems === 0
  ? `✅ 共 ${checked} 个视觉排：同排控件高度与顶线完全一致`
  : `❌ 共 ${problems} 处「同排没调平」`);

await browser.close();
process.exit(problems === 0 ? 0 : 1);
