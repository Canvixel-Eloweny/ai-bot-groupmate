// 单独量「推理通道」那排（它在智谱预设下是隐藏的，先强制显形）。
const puppeteer = (await import(`${process.env.HOME}/.dsh/profiles/web/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js`)).default;

const EXEC = `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const TAG = process.argv[2] || '';

const browser = await puppeteer.launch({
  executablePath: EXEC, headless: true, args: ['--no-proxy-server', '--no-sandbox'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 1200, deviceScaleFactor: 2 });
await page.goto('http://127.0.0.1:8790', { waitUntil: 'networkidle0', timeout: 30000 });
await new Promise((r) => setTimeout(r, 1200));

const res = await page.evaluate(() => {
  const row = document.querySelector('#channelRow');
  // 隐藏它的可能是**祖先**（整块"本机模型"卡在其它预设下不显示），
  // 只把 row 自己设成 flex 是量不到的 —— 要一路往上把 display:none 清掉。
  for (let p = row; p && p !== document.body; p = p.parentElement) {
    if (getComputedStyle(p).display === 'none') p.style.display = p === row ? 'flex' : 'block';
  }
  row.style.display = 'flex';
  const kids = [...row.children].map((e) => {
    const r = e.getBoundingClientRect();
    return { t: (e.textContent || '').trim().slice(0, 12), h: +r.height.toFixed(1), top: +r.top.toFixed(1) };
  });
  const hs = kids.map((k) => k.h), ts = kids.map((k) => k.top);
  return { kids, hSpread: +(Math.max(...hs) - Math.min(...hs)).toFixed(1), tSpread: +(Math.max(...ts) - Math.min(...ts)).toFixed(1) };
});
console.log(`${TAG}推理通道那一排：`);
for (const k of res.kids) console.log(`   ${k.t.padEnd(16)} 高 ${String(k.h).padStart(5)}  顶 ${k.top}`);
console.log(`   → 高度极差 ${res.hSpread}px，顶线极差 ${res.tSpread}px`);
await browser.close();
