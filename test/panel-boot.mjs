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
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const NODE = process.execPath;
const USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-boot-userdata-'));

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

/** 带 JSON 体的 POST（窗口几何上报的端到端用；token 可空）。 */
const postJson = async (url, obj, token, ms = 6000) => {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(url, {
      method: 'POST',
      signal: ac.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(obj),
    });
    return { status: r.status, body: await r.text() };
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
  env: {
    ...process.env,
    QQBOT_PANEL_PORT: String(port),
    QQBOT_SANDBOX: '1',
    QQBOT_MODE: 'dev',
    QQBOT_USER_ROOT: USERDATA,
    NODE_OPTIONS: '',
  },
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

/* 被 Ctrl-C / 终端关闭打断时，上面的 `finally` 不保证会跑：Node 默认直接退出，
   子面板会被 init 收养（2026-10-20 五个 PPID-1 孤儿就是这么留下的）。
   这里注册同步硬清理；正常结束时 `finally` 仍走优雅 stop，最后把 cleaned 置真。
   ⚠️ SIGKILL 捕获不到 —— 这是无法兑现的承诺，不写。 */
let cleaned = false;
const hardCleanup = () => {
  if (cleaned) return;
  cleaned = true;
  try { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); } catch { /* 已退 */ }
  try { fs.rmSync(USERDATA, { recursive: true, force: true }); } catch { /* 清不掉就留给 tmp */ }
};
for (const [sig, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]]) {
  process.once(sig, () => { hardCleanup(); process.exit(code); });
}
process.on('exit', hardCleanup);

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
        // ⑥ 桌面端「启动方式」：`config.launch` 必须**下发结论**（缺省配置也要有）——
        //    面板上那两格控件靠它渲染；缺了会退回写死的默认值（看起来正常，其实失真）。
        //    ⚠️ 只判"是不是有效值"，不判等于哪一个 —— 真机配置可能已被用户改成 window。
        const l = j?.config?.launch;
        if (!l || !['browser', 'window'].includes(l.mode) || typeof l.openOnStart !== 'boolean') {
          problems.push(`/api/state 没有下发 config.launch（拿到的是 ${JSON.stringify(l)}）—— 控制台「启动方式」卡片会失真`);
        }
      } catch { problems.push('/api/state 不是合法 JSON'); }
    }
    // ④b 安装器/启动器就绪信号：200 + 身份正确 + **绝不泄露路径/token**
    const health = await get(`${base}/api/health`);
    if (health.status !== 200) problems.push(`GET /api/health 返回 ${health.status}（应 200）`);
    else {
      try {
        const h = JSON.parse(health.body);
        if (h.ok !== true || h.appId !== PKG.appId || h.version !== PKG.version) {
          problems.push(`/api/health 身份不对：${health.body.slice(0, 200)}`);
        }
        if (health.body.includes(USERDATA) || /"(token|userRoot|programRoot)"/i.test(health.body)) {
          problems.push('/api/health 泄露了路径或 token —— 启动器只需要 appId/version');
        }
        if (typeof h.pid !== 'number' || typeof h.uptimeSec !== 'number') problems.push('/api/health 缺 pid/uptimeSec');
      } catch { problems.push('/api/health 不是合法 JSON'); }
    }
    // ⑤ 启动输出里不许有"未捕获异常"那一行 —— 那是"请求挂住"的唯一在服务端可见的痕迹
    if (/is not defined|is not a function/.test(out)) {
      problems.push(`面板启动日志里出现了未定义错误（搬家漏接线的典型形状）：\n    ${out.split('\n').filter((l) => /is not defined|is not a function/.test(l)).slice(0, 3).join('\n    ')}`);
    }

    // ⑦ 窗口记忆（2026-10-16）：真 POST 一次 /api/panel/window —— 200 落盘、400 拒脏值。
    //    ⚠️ 这个路由**真写** `<仓库>/panel/window-state.json`（已 gitignore）：测试前先
    //    快照、结束时**还原** —— 测试几何绝不能留成"用户的上次窗口"（否则下一次真开窗
    //    会跑到测试坐标去，而那种现象看起来会像"窗口记忆坏了"）。
    const wsFile = path.join(USERDATA, 'panel', 'window-state.json');
    const wsBefore = fs.existsSync(wsFile) ? fs.readFileSync(wsFile, 'utf8') : null;
    try {
      const tok = ((/<meta\s+name="panel-token"[^>]*content="([^"]*)"/i.exec(root.body) || [])[1]
        || (fs.existsSync(path.join(USERDATA, 'panel', '.token')) ? fs.readFileSync(path.join(USERDATA, 'panel', '.token'), 'utf8').trim() : '')) || '';
      const good = tok && tok !== '__QQBOT_PANEL_TOKEN__' ? tok : '';
      const wr = await postJson(`${base}/api/panel/window`, { x: 111, y: 222, w: 900, h: 601 }, good);
      if (wr.status !== 200 || !/"ok":\s*true/.test(wr.body)) {
        problems.push(`POST /api/panel/window 返回 ${wr.status}：${wr.body.slice(0, 140)}`);
      } else {
        try {
          const j = JSON.parse(fs.readFileSync(wsFile, 'utf8'));
          if (j.w !== 900 || j.h !== 601 || j.x !== 111 || j.y !== 222) problems.push(`窗口状态落盘不对：${JSON.stringify(j)}`);
        } catch (e) { problems.push(`窗口状态文件写不出来 / 不是 JSON：${e.message}`); }
      }
      const wrBad = await postJson(`${base}/api/panel/window`, { w: 5, h: 5 }, good);
      if (wrBad.status !== 400) problems.push(`越界几何应回 400，实得 ${wrBad.status}（脏值可能被落盘）`);

      // ⑦b 应用内更新（P3）：GET 只读；POST 无 token 必须被拒；带 token 在沙箱/开发模式下返回 disabled。
      const us = await get(`${base}/api/update/state`);
      if (us.status !== 200) problems.push(`GET /api/update/state 返回 ${us.status}（应 200）`);
      else {
        try {
          const u = JSON.parse(us.body);
          if (u.ok !== true || typeof u.phase !== 'string' || typeof u.enabled !== 'boolean') {
            problems.push(`/api/update/state 形状不对：${us.body.slice(0, 200)}`);
          }
          if (u.enabled !== false || u.phase !== 'disabled') {
            problems.push(`沙箱/开发模式下 /api/update/state 应为 disabled：${us.body.slice(0, 200)}`);
          }
        } catch { problems.push('/api/update/state 不是合法 JSON'); }
      }
      const ucNo = await postJson(`${base}/api/update/check`, {}, '');
      if (ucNo.status !== 401 && ucNo.status !== 403) {
        problems.push(`POST /api/update/check 无 token 应 401/403，实得 ${ucNo.status}（写路由绕过鉴权）`);
      }
      if (good) {
        const uc = await postJson(`${base}/api/update/check`, {}, good);
        if (uc.status !== 200) problems.push(`POST /api/update/check 带 token 返回 ${uc.status}（应 200）`);
        else {
          try {
            const j = JSON.parse(uc.body);
            if (j.enabled !== false || j.phase !== 'disabled') {
              problems.push(`沙箱/开发模式下 update/check 应 disabled：${uc.body.slice(0, 200)}`);
            }
          } catch { problems.push('POST /api/update/check 不是合法 JSON'); }
        }
      }

      // ⑦c 离线更新（P4）：两条写路由都必须走 token；沙箱/开发模式下 handler 回 ok:false。
      for (const p of ['/api/update/offline/prepare', '/api/update/offline/installer']) {
        const no = await postJson(`${base}${p}`, {}, '');
        if (no.status !== 401 && no.status !== 403) {
          problems.push(`POST ${p} 无 token 应 401/403，实得 ${no.status}（写路由绕过鉴权）`);
        }
        if (good) {
          const yes = await postJson(`${base}${p}`, {}, good);
          if (yes.status !== 200) problems.push(`POST ${p} 带 token 返回 ${yes.status}（应 200）`);
          else {
            try {
              const j = JSON.parse(yes.body);
              if (j.ok !== false) problems.push(`沙箱/开发模式下 ${p} 应 ok:false：${yes.body.slice(0, 160)}`);
            } catch { problems.push(`POST ${p} 不是合法 JSON`); }
          }
        }
      }
    } finally {
      try {
        if (wsBefore === null) fs.rmSync(wsFile, { force: true });
        else fs.writeFileSync(wsFile, wsBefore);
      } catch { /* 还原尽力而为；该文件已 gitignore */ }
    }
  }
} finally {
  await stop();
  try { fs.rmSync(USERDATA, { recursive: true, force: true }); } catch { /* 清不掉就留给 tmp */ }
  cleaned = true;
}

if (problems.length) {
  for (const p of problems) console.log(`✗ ${p}`);
  console.log(`── ${problems.length} 处问题 ──`);
  process.exit(1);
}
console.log(`✓ 面板启动自检通过（端口 ${port} · / · /app.js · /style.css · /api/health · /api/state · /api/panel/window · /api/update/state 全部 200 · config.launch 已下发 · 更新/离线路由鉴权与 disabled 正确）`);
process.exit(0);
