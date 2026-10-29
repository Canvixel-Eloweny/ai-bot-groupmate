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

/** 媒体请求：拿状态、响应头与原始字节（视频 Range / 海报签名要按字节验）。 */
const fetchMedia = async (url, opts = {}, ms = 15000) => {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(url, { signal: ac.signal, ...opts });
    const buf = Buffer.from(await r.arrayBuffer());
    return { status: r.status, headers: r.headers, buf };
  } catch (e) {
    return { status: 0, headers: new Headers(), buf: Buffer.alloc(0), error: String(e && e.message) };
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

/** 带原始字节的 POST（背景上传 / ZIP 安装；token 可空）。 */
const postBlob = async (url, buf, token, opts = {}, ms = 30000) => {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(url, {
      method: 'POST',
      signal: ac.signal,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(opts.headers || {}),
      },
      body: buf,
    });
    return { status: r.status, body: await r.text(), headers: r.headers };
  } catch (e) {
    return { status: 0, body: String(e && e.message), headers: new Headers() };
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
const STAR_FIXTURE = path.join(USERDATA, 'github-star.fixture.json');
fs.writeFileSync(STAR_FIXTURE, JSON.stringify({ count: 4242 }), 'utf8');
const child = spawn(NODE, ['panel/server.js'], {
  cwd: ROOT,
  env: {
    ...process.env,
    QQBOT_PANEL_PORT: String(port),
    QQBOT_SANDBOX: '1',
    QQBOT_MODE: 'dev',
    QQBOT_USER_ROOT: USERDATA,
    QQBOT_GITHUB_STAR_FIXTURE: STAR_FIXTURE,
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

    // ③b 等高线媒体（2026-10-26）：MIME / Range 206 / 416 / 长缓存 / 404。
    // 这条必须真发请求：Range 写错时视频仍能整段播，但换主题/循环会反复整段下载，
    // 而静态扫描看不出来。MP4 文件本身的存在性/体积/结构由 check-wb §163 守。
    {
      const mediaDir = path.join(ROOT, 'panel', 'next', 'assets', 'contour');
      const videoFile = 'contour-light-standard-v2.mp4';
      const videoPath = path.join(mediaDir, videoFile);
      if (!fs.existsSync(videoPath)) {
        problems.push(`等高线媒体缺失：${videoFile} —— 背景会永远停在海报`);
      } else {
        const size = fs.statSync(videoPath).size;
        const head = await fetchMedia(`${base}/assets/contour/${videoFile}`, { method: 'HEAD' });
        if (head.status !== 200) problems.push(`HEAD 媒体返回 ${head.status}（应 200）`);
        else {
          if (head.headers.get('content-type') !== 'video/mp4') {
            problems.push(`媒体 Content-Type=${head.headers.get('content-type')}（应 video/mp4）`);
          }
          if (head.headers.get('accept-ranges') !== 'bytes') {
            problems.push('媒体缺 Accept-Ranges: bytes —— 部分浏览器会反复整段请求');
          }
          if (Number(head.headers.get('content-length')) !== size) {
            problems.push(`媒体 HEAD Content-Length=${head.headers.get('content-length')}（应 ${size}）`);
          }
        }

        const ranged = await fetchMedia(`${base}/assets/contour/${videoFile}`, {
          headers: { Range: 'bytes=0-1023' },
        });
        if (ranged.status !== 206) problems.push(`媒体 Range 返回 ${ranged.status}（应 206）`);
        else {
          if (ranged.buf.length !== 1024) problems.push(`媒体 Range 实收 ${ranged.buf.length} 字节（应 1024）`);
          if (!new RegExp(`^bytes 0-1023/${size}$`).test(ranged.headers.get('content-range') || '')) {
            problems.push(`媒体 Content-Range=${ranged.headers.get('content-range')}（应 bytes 0-1023/${size}）`);
          }
          if (ranged.headers.get('content-length') !== '1024') {
            problems.push(`媒体 Range Content-Length=${ranged.headers.get('content-length')}（应 1024）`);
          }
          if (!/immutable/.test(ranged.headers.get('cache-control') || '')) {
            problems.push('媒体缺少 immutable 长缓存 —— 版本化文件名白做');
          }
        }

        const bad = await fetchMedia(`${base}/assets/contour/${videoFile}`, {
          headers: { Range: 'bytes=999999999-' },
        });
        if (bad.status !== 416) problems.push(`越界 Range 返回 ${bad.status}（应 416）`);
        else if (!new RegExp(`^bytes \\*/${size}$`).test(bad.headers.get('content-range') || '')) {
          problems.push(`越界 Range 的 Content-Range=${bad.headers.get('content-range')}（应 bytes */${size}）`);
        }

        const poster = await fetchMedia(`${base}/assets/contour/contour-light-v2.jpg`);
        if (poster.status !== 200) problems.push(`海报返回 ${poster.status}（应 200）`);
        else {
          if (poster.headers.get('content-type') !== 'image/jpeg') {
            problems.push(`海报 Content-Type=${poster.headers.get('content-type')}（应 image/jpeg）`);
          }
          if (poster.buf[0] !== 0xff || poster.buf[1] !== 0xd8) problems.push('海报不是 JPEG 魔数');
        }

        const missing = await fetchMedia(`${base}/assets/contour/not-registered.mp4`);
        if (missing.status !== 404) problems.push(`未登记媒体返回 ${missing.status}（应 404）`);
      }
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
        // UI 身份：官方源码树必须验签通过，且锚点齐全
        const idn = j?.uiIdentity;
        if (!idn || typeof idn !== 'object') problems.push('/api/state 没有下发 uiIdentity');
        else if (!['official', 'unofficial', 'unknown'].includes(idn.state)) problems.push(`/api/state.uiIdentity.state 非法：${idn.state}`);
        else if (idn.state !== 'official') problems.push(`官方源码树的 uiIdentity 应为 official，实得 ${idn.state}（${idn.reason || ''}）`);
        else if (!idn.anchors || !Array.isArray(idn.anchors.domains) || idn.anchors.domains.length !== 7) problems.push('uiIdentity.anchors 域清单可疑');
      } catch { problems.push('/api/state 不是合法 JSON'); }
    }
    // UI 身份：坏清单必须进入 unofficial，而不是把 /api/state 拖崩
    try {
      const { uiIdentityState } = await import('../panel/lib/ui-identity.js');
      const badFile = path.join(USERDATA, 'bad-ui-identity.json');
      fs.writeFileSync(badFile, JSON.stringify({
        schema: 1, kind: 'ui-identity', appId: PKG.appId, domains: [], selectors: [], renderers: [],
      }, null, 2), 'utf8');
      fs.copyFileSync(path.join(ROOT, 'panel', 'ui-identity.json.sig'), `${badFile}.sig`);
      const bad = uiIdentityState({ QQBOT_SANDBOX: '1', QQBOT_MODE: 'dev', QQBOT_UI_IDENTITY_FILE: badFile });
      if (!bad || bad.state !== 'unofficial') problems.push(`坏 UI 身份清单应为 unofficial，实得 ${bad && bad.state}`);
    } catch (e) {
      problems.push(`UI 身份坏清单自检跑不起来：${e && e.message ? e.message : e}`);
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
      // ⑦d 0.1.5 接口收尾（2026-10-28）：星标 / 自定义背景 / 扩展包（全部走真 HTTP）。
      {
        const star = await get(`${base}/api/github/star`);
        if (star.status !== 200) problems.push(`GET /api/github/star 返回 ${star.status}（应 200）`);
        else {
          try {
            const j = JSON.parse(star.body);
            if (j.ok !== true || j.count !== 4242 || j.cached !== false) {
              problems.push(`星标夹具没生效：${star.body.slice(0, 160)}`);
            }
          } catch { problems.push('/api/github/star 不是合法 JSON'); }
        }
        fs.writeFileSync(STAR_FIXTURE, JSON.stringify({ fail: true }), 'utf8');
        const starFail = await get(`${base}/api/github/star`);
        if (starFail.status !== 502) problems.push(`星标上游失败应 502，实得 ${starFail.status}`);
        fs.writeFileSync(STAR_FIXTURE, JSON.stringify({ count: 4242 }), 'utf8');
      }
      if (good) {
        const pngHead = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489', 'hex');
        const png = Buffer.concat([pngHead, Buffer.alloc(32)]);
        const jpg = Buffer.concat([Buffer.from('ffd8ffe000104a4649460001', 'hex'), Buffer.alloc(32)]);

        const noTok = await postBlob(`${base}/api/backgrounds?slot=original&name=qa`, png, '');
        if (noTok.status !== 401 && noTok.status !== 403) {
          problems.push(`背景上传无 token 应 401/403，实得 ${noTok.status}（写路由绕过鉴权）`);
        }
        const cross = await postBlob(`${base}/api/backgrounds?slot=original&name=qa`, png, good, {
          headers: { Origin: 'http://evil.example' },
        });
        if (cross.status !== 403) problems.push(`背景上传跨源应 403，实得 ${cross.status}`);

        const up = await postBlob(`${base}/api/backgrounds?slot=original&name=qa`, png, good);
        let id = '';
        try {
          const j = JSON.parse(up.body);
          if (j.ok !== true || !j.item) problems.push(`背景上传失败：${up.body.slice(0, 200)}`);
          id = j.item && j.item.id;
        } catch { problems.push('背景上传不是合法 JSON'); }
        if (!id) problems.push('背景上传没有返回 id');
        else {
          const list = JSON.parse((await get(`${base}/api/backgrounds`)).body);
          if (!Array.isArray(list.items) || list.items.length !== 1 || list.activeId !== null) {
            problems.push(`背景列表形状不对：${JSON.stringify(list).slice(0, 200)}`);
          }
          const range = await fetchMedia(`${base}/api/backgrounds/media?id=${id}&v=original`, {
            headers: { Range: 'bytes=0-9' },
          });
          if (range.status !== 206 || range.buf.length !== 10
            || range.headers.get('content-range') !== `bytes 0-9/${png.length}`) {
            problems.push(`背景媒体 Range 不对：status=${range.status} len=${range.buf.length} cr=${range.headers.get('content-range')}`);
          }
          const badRange = await fetchMedia(`${base}/api/backgrounds/media?id=${id}&v=original`, {
            headers: { Range: 'bytes=99999-' },
          });
          if (badRange.status !== 416) problems.push(`背景媒体越界 Range 应 416，实得 ${badRange.status}`);

          const disp = await postBlob(`${base}/api/backgrounds?slot=display&id=${id}&zoom=1.2&x=0.1&y=-0.1`, jpg, good);
          try {
            const j = JSON.parse(disp.body);
            if (j.ok !== true || !j.item || !/v=display/.test(j.item.displayUrl || '')) {
              problems.push(`裁切图上传失败：${disp.body.slice(0, 200)}`);
            }
          } catch { problems.push('裁切图上传不是合法 JSON'); }
          const act = await postJson(`${base}/api/backgrounds/active`, { id }, good);
          if (act.status !== 200 || !new RegExp(`"activeId":"${id}"`).test(act.body)) {
            problems.push(`启用背景失败：${act.status} ${act.body.slice(0, 160)}`);
          }
          const svg = await postBlob(`${base}/api/backgrounds?slot=original&name=bad`, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), good);
          if (svg.status !== 415) problems.push(`SVG 背景应 415，实得 ${svg.status}`);
          const tooBig = await postBlob(`${base}/api/backgrounds?slot=original&name=big`, Buffer.concat([pngHead, Buffer.alloc(8 * 1024 * 1024 + 1)]), good, {}, 60000);
          if (tooBig.status !== 413) problems.push(`超限图片应 413，实得 ${tooBig.status}`);

          const del = await postJson(`${base}/api/backgrounds/delete`, { id }, good);
          if (del.status !== 200) problems.push(`删除背景失败：${del.status}`);
          const gone = await fetchMedia(`${base}/api/backgrounds/media?id=${id}&v=original`);
          if (gone.status !== 404) problems.push(`删除后媒体应 404，实得 ${gone.status}`);
        }

        const pack = await postJson(`${base}/api/extensions/package`, {
          mode: 'create',
          meta: { kind: 'plugin', id: 'qa-interface', name: 'QA Interface', toolName: 'qa_interface_tool' },
        }, good);
        let zip = null;
        try {
          const j = JSON.parse(pack.body);
          if (j.ok !== true || !j.zipBase64) problems.push(`扩展包生成失败：${pack.body.slice(0, 200)}`);
          else zip = Buffer.from(j.zipBase64, 'base64');
        } catch { problems.push('扩展包生成不是合法 JSON'); }
        if (zip) {
          const installNo = await postBlob(`${base}/api/extensions/install?kind=plugin`, zip, '');
          if (installNo.status !== 401 && installNo.status !== 403) {
            problems.push(`扩展安装无 token 应 401/403，实得 ${installNo.status}`);
          }
          const install1 = await postBlob(`${base}/api/extensions/install?kind=plugin`, zip, good);
          if (install1.status !== 200) problems.push(`模板插件安装失败：${install1.status} ${install1.body.slice(0, 160)}`);
          const install2 = await postBlob(`${base}/api/extensions/install?kind=plugin`, zip, good);
          if (install2.status !== 409) problems.push(`同名插件应 409，实得 ${install2.status}`);
          const install3 = await postBlob(`${base}/api/extensions/install?kind=plugin&overwrite=1`, zip, good);
          if (install3.status !== 200 || !/"replaced":\s*true/.test(install3.body)) {
            problems.push(`覆盖安装失败：${install3.status} ${install3.body.slice(0, 160)}`);
          }
          const manifestPath = path.join(USERDATA, 'plugins', 'qa-interface', 'plugin.json');
          if (!fs.existsSync(manifestPath)) problems.push('模板插件没有落到 USERDATA/plugins/qa-interface/');
        }
        const badFolder = await postJson(`${base}/api/extensions/package`, {
          mode: 'folder', kind: 'plugin', root: 'qa-folder',
          files: [
            { path: 'plugin.json', contentBase64: Buffer.from(JSON.stringify({ id: 'qa-folder', name: 'qa', version: '1.0.0', apiVersion: 1, entry: 'index.js' })).toString('base64') },
            { path: 'index.js', contentBase64: Buffer.from('export function setup(){}').toString('base64') },
            { path: '../evil.js', contentBase64: Buffer.from('x').toString('base64') },
          ],
        }, good);
        if (badFolder.status !== 400) problems.push(`文件夹打包的 ../ 路径应 400，实得 ${badFolder.status}`);
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
