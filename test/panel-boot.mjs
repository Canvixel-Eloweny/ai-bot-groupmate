/**
 * 面板启动自检（2026-10-06 · 事故后新增）
 * ══════════════════════════════════════════════════════════════════════════
 * 它防的是一类**四层门禁都看不见**的失效：**面板起得来，但一个请求都答不上来**。
 *
 * 事故实录（2026-10-06 晚）：`panel/lib/audit-log.js` 的工厂 `makeBeginAudit`
 * 定义了 `beginAudit` 却**没 return** → 主文件 `const beginAudit = makeBeginAudit(…)`
 * 拿到 `undefined` → 每个请求在 `server.js` 的第一行抛 `TypeError`，
 * 而那一行在 try 之外，只被 `unhandledRejection` 记一笔 ⇒ **响应永远写不出去**。
 * 表现：Dock 图标点了、浏览器转圈、`panel.log` 干干净净、四层门禁全绿。
 * 同一批搬家还有第二处：`state-collector.js` 用了 `fs.` 却没 import → `/api/state` 500。
 *
 * 为什么**必须真起进程、真发请求**：
 *   · 静态契约只能钉住"这一个形状"（漏 return / 漏 import），钉不住第三种、第四种；
 *   · 而"页面打不开"是**用户唯一能感知**的失败面 —— 它值得一条端到端的断言。
 *   · `check-wb` 不启进程（它是静态扫描器），`smoke` 不接管面板端口（会与真机互踢），
 *     所以这道口子之前是空的。
 *
 * 隔离（每一条都对应历史踩过的坑）：
 *   · 端口**随机取空闲口**（不碰 8788，不抢真机面板）；
 *   · `QQBOT_SANDBOX=1` ⇒ `adoptExistingBridge()` 直接返回，**绝不接管真机器人**；
 *   · `NODE_OPTIONS` 清空（shell 注入的 language-shim 会把 err.code 改写成别的）；
 *   · stdout/stderr 收进内存，不落 `panel/panel.log`（不覆盖真机的日志）。
 *
 * 用法：`node test/panel-boot.mjs`
 * @returns {Promise<number>} 0 = 通过
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const NODE = process.execPath;

/** 取一个当前空闲的端口（拿到就放手，给面板用）。 */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

const get = async (url, ms = 6000) => {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(url, { signal: ac.signal });
    const body = await r.text();
    return { status: r.status, body };
  } catch (e) {
    return { status: 0, body: String(e && e.message) };
  } finally {
    clearTimeout(timer);
  }
};

/** 端口连得上没有。**只做 TCP 握手** —— 面板坏掉时 HTTP 会一直挂着，
 *  拿 HTTP 当"起来了没有"的探针，等的就是一个永远不来的响应（本脚本第一版
 *  正是这么写的：100 次 × 2 秒 = 220 秒才放弃，看起来像"脚本卡死"）。 */
const tcpUp = (p, ms = 800) => new Promise((resolve) => {
  const sock = net.connect({ port: p, host: '127.0.0.1' });
  const done = (v) => { sock.destroy(); resolve(v); };
  sock.setTimeout(ms);
  sock.on('connect', () => done(true));
  sock.on('timeout', () => done(false));
  sock.on('error', () => done(false));
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const problems = [];
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const child = spawn(NODE, ['panel/server.js'], {
  cwd: ROOT,
  env: { ...process.env, QQBOT_PANEL_PORT: String(port), QQBOT_SANDBOX: '1', NODE_OPTIONS: '' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let out = '';
child.stdout.on('data', (d) => { out += d; });
child.stderr.on('data', (d) => { out += d; });

const stop = async () => {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM');
    for (let i = 0; i < 40 && child.exitCode === null; i++) await sleep(100);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
};

try {
  // ① 等监听起来（最多约 15 秒）。启动期要读配置、扫扩展包，慢一点是正常的。
  //    ⚠️ 这里只探 **TCP**，不探 HTTP：面板坏掉时 HTTP 请求会永远挂着
  //    （那正是本脚本要抓的失效），用它当就绪探针会等到一个不存在的响应。
  let up = false;
  for (let i = 0; i < 75 && !up; i++) {
    up = await tcpUp(port);
    if (!up) await sleep(200);
  }
  if (!up) {
    problems.push(`面板在 20 秒内没起来（端口 ${port}）。启动输出：\n${out.slice(-800)}`);
  } else {
    // ② 入口页：200 + 真的是 HTML + token 已注入（页面靠它才写得动）
    const root = await get(`${base}/`);
    if (root.status !== 200) problems.push(`GET / 返回 ${root.status}（应 200）`);
    else {
      if (!/<!doctype html|<html/i.test(root.body)) problems.push('GET / 返回的不是 HTML');
      if (!/<meta\s+name="panel-token"/i.test(root.body)) problems.push('入口页没有注入 panel-token（页面会写不动）');
    }
    // ③ 资产：入口在根，相对引用必须同层可取（不同层 = 白屏，而两个 200 各自都绿）
    for (const a of ['/app.js', '/style.css']) {
      const r = await get(`${base}${a}`);
      if (r.status !== 200) problems.push(`GET ${a} 返回 ${r.status}（应 200）—— 控制台会白屏`);
    }
    // ④ 状态接口：200 且**不是** `{"error":…}` —— 500 会被包成这个形状
    const st = await get(`${base}/api/state`, 15000);
    if (st.status !== 200) problems.push(`GET /api/state 返回 ${st.status}（应 200）`);
    else if (/^\s*\{\s*"error"/.test(st.body)) problems.push(`/api/state 回的是错误体：${st.body.slice(0, 200)}`);
    else {
      try {
        const j = JSON.parse(st.body);
        if (!j || typeof j !== 'object') problems.push('/api/state 不是对象');
      } catch { problems.push('/api/state 不是合法 JSON'); }
    }
    // ⑤ 启动输出里不许有"未捕获异常"那一行 —— 那是"请求挂住"的唯一在服务端可见的痕迹
    if (/is not defined|is not a function/.test(out)) {
      problems.push(`面板启动日志里出现了未定义错误（搬家漏接线的典型形状）：\n    ${out.split('\n').filter((l) => /is not defined|is not a function/.test(l)).slice(0, 3).join('\n    ')}`);
    }
  }
} finally {
  await stop();
}

if (problems.length) {
  for (const p of problems) console.log(`✗ ${p}`);
  console.log(`── ${problems.length} 处问题 ──`);
  process.exit(1);
}
console.log(`✓ 面板启动自检通过（端口 ${port} · / · /app.js · /style.css · /api/state 全部 200）`);
process.exit(0);
