/**
 * 进程 / 网络 / 内存 工具（第 38 轮 B11b-2 · AR-SERVERSPLIT · 依赖图 L2）
 * ══════════════════════════════════════════════════════════════════════════
 *  这个模块装的是"**面板要怎么跟外部世界打交道**"：
 *
 *      跑一条外部命令、按进程组收进程、探端口、发一个 HTTP 请求、
 *      探一次 WebSocket、看一眼内存、拉/停 Docker Desktop。
 *
 *  它们的共同特征：**没有业务语义，只被业务调用**。
 *  以前它们和业务代码挤在一个文件里，于是"谁调谁"变成了双向的：
 *
 *      · `bridge` 控制段要用 `killTree` / `pidAlive`；
 *      · `local model` 控制段要用 `portOpen` / `httpGet` / `waitFor`；
 *      · 而这两个段自己又定义在同一个文件里 → `BRIDGE ⇄ UTIL` / `LOCAL ⇄ UTIL`。
 *
 *  抽出来之后它们变成**被依赖的一端**，不再依赖任何业务代码。
 *  （依赖矩阵实测：本模块的跨模块出边 **只有** `paths` 与 `runtime-state` 两个 L0。）
 *
 *  ⚠️ 三条不许破的纪律：
 *
 *  1. **`sh()` 绝不抛异常**。命令失败、`spawn` 被系统策略拦下，都只能返回 `ok:false`。
 *     一旦让它抛，`/api/state` 会整个 500，面板直接白屏 —— 这是它存在的全部理由。
 *  2. **`killTree()` 先 TERM 再 KILL，且走进程组**（`process.kill(-pid, …)`）。
 *     不走进程组会留下占着端口的僵尸，下次启动 bind 失败。
 *  3. **三个缓存是 module-level `let`，只由本文件的读函数赋值**。
 *     谁要把它们搬到别处，先 grep"有没有被赋值" —— ESM 的 import 绑定只读，
 *     别处赋值会当场 `TypeError: Assignment to constant variable`（B11b-1 的真实事故）。
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { DOCKER, DOCKER_APP } from './paths.js';
import { state } from './runtime-state.js';

/**
 * 跑外部命令。两种情况都要兜住：
 *   - 命令失败了（Docker 没装、没权限…）→ 返回 ok:false，绝不能抛
 *   - spawn 同步抛异常（沙箱 / 系统策略禁止起子进程）→ 同样吞掉
 * 否则一次命令失败就会让 /api/state 整个 500，面板直接白屏。
 */
export function sh(cmd, args, timeoutMs = 15000) {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
        resolve({ ok: !err, stdout: stdout || '', stderr: stderr || '', err });
      });
    } catch (err) {
      resolve({ ok: false, stdout: '', stderr: String(err?.message || err), err });
    }
  });
}

export function shBuffer(cmd, args, timeoutMs = 8000) {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, encoding: 'buffer' }, (err, stdout) => {
        resolve({ ok: !err, buf: stdout || Buffer.alloc(0), err });
      });
    } catch (err) {
      resolve({ ok: false, buf: Buffer.alloc(0), err });
    }
  });
}

/**
 * 按进程组收进程：先 TERM，超时再 KILL。
 * 用进程组是为了连子进程一起带走，否则会留下占着端口的僵尸，
 * 下次启动 bind 失败 —— 之前两个规格互相打架就是这个原因。
 */
export async function killTree(pid, graceMs = 3000) {
  if (!pid || !Number.isFinite(pid)) return false;
  const signal = (sig) => {
    try {
      process.kill(-pid, sig);
      return true;
    } catch {
      try {
        process.kill(pid, sig);
        return true;
      } catch {
        return false;
      }
    }
  };
  if (!signal('SIGTERM')) return false;
  await new Promise((s) => setTimeout(s, graceMs));
  if (pidAlive(pid)) signal('SIGKILL');
  return true;
}

/**
 * Docker 后台守护进程在不在。
 * daemon 没起来时 docker 命令会长时间挂住或静默失败，
 * 这就是「点重启容器按钮没反应」的真正原因 —— 必须先探再调。
 */
async function dockerDaemonUp(timeoutMs = 8000) {
  // 快路径：Docker Desktop 的 unix socket 文件不存在，那 daemon 一定没跑。
  // 少了这一步，Docker 没启动时会白等一整轮超时，面板每几秒卡一次。
  const sock = path.join(process.env.HOME || '', '.docker', 'run', 'docker.sock');
  if (!fs.existsSync(sock)) return false;

  const r = await sh(DOCKER, ['info', '--format', '{{.ServerVersion}}'], timeoutMs);
  return r.ok && !!r.stdout.trim();
}

/** 拉起 Docker Desktop，并一直等到 daemon 真的可用（最长 waitMs） */
export async function ensureDocker(waitMs = 150000, onProgress) {
  // 刚点过「结束运行」的话，Docker 可能正在退出 —— 先等它退干净再拉起来。
  // 不等的话会撞上"守护进程正在死"的那几秒：docker info 还能通、docker start 却失败，
  // 报出来的错很难懂。这是「不等 Docker 退出」这个优化必须配的安全带。
  if (state.dockerQuitAt && Date.now() - state.dockerQuitAt < 120000) {
    onProgress?.('Docker 刚在退出，先等它退干净…');
    await waitFor(async () => !(await dockerDaemonUp(4000)), 60000, 1500);
    state.dockerQuitAt = 0;
  }
  if (await dockerDaemonUp()) return { ok: true, waitedMs: 0 };

  if (!fs.existsSync(DOCKER_APP)) {
    return { ok: false, msg: `没找到 ${DOCKER_APP}，请手动启动 Docker Desktop` };
  }

  onProgress?.('Docker 没在运行，正在启动 Docker Desktop…');
  execFile('/usr/bin/open', ['-a', 'Docker'], () => {});

  const t0 = Date.now();
  let lastReport = 0;
  while (Date.now() - t0 < waitMs) {
    await new Promise((s) => setTimeout(s, 2000));
    if (await dockerDaemonUp(6000)) return { ok: true, waitedMs: Date.now() - t0 };
    const sec = Math.round((Date.now() - t0) / 1000);
    if (sec - lastReport >= 5) {
      lastReport = sec;
      onProgress?.(`等待 Docker 就绪… ${sec} 秒`);
    }
  }
  return { ok: false, msg: `等了 ${Math.round(waitMs / 1000)} 秒 Docker 还没起来` };
}

function sumRssKb(psOut, re) {
  let kb = 0;
  for (const line of String(psOut).split('\n')) {
    if (!re.test(line)) continue;
    const m = line.trim().match(/^(\d+)/);
    if (m) kb += Number(m[1]);
  }
  return kb;
}

/**
 * 内存总览。16GB 机器上本机模型(约 2.9G) + Docker(约 2-3G) 就已经很挤了，
 * 挤到极限 macOS 会直接把 Docker 虚拟机杀掉 —— 表现就是「容器凭空消失」。
 * 这里把占用摆到明面上，用户才知道该关哪个。
 */
async function readMemory() {
  const [vm, psOut, memsize, swap] = await Promise.all([
    sh('/usr/bin/vm_stat', [], 5000),
    sh('/bin/ps', ['-Ao', 'rss=,args='], 8000),
    sh('/usr/sbin/sysctl', ['-n', 'hw.memsize'], 4000),
    sh('/usr/sbin/sysctl', ['-n', 'vm.swapusage'], 4000),
  ]);

  // 这些命令查不到就算了，内存卡片空着也不能拖垮整个状态接口
  if (!vm.ok || !memsize.ok) return null;

  const ps = vm.stdout;
  const pageSize = Number((ps.match(/page size of (\d+)/) || [])[1] || 16384);
  const pages = (name) => Number((ps.match(new RegExp(`Pages ${name}:\\s+(\\d+)`)) || [])[1] || 0);
  const GB = (bytes) => Math.round((bytes / 1073741824) * 10) / 10;

  const totalBytes = Number(memsize.stdout.trim()) || 0;
  const free = (pages('free') + pages('speculative')) * pageSize;
  const inactive = pages('inactive') * pageSize;
  const compressed = pages('occupied by compressor') * pageSize;
  const wired = pages('wired down') * pageSize;
  const active = pages('active') * pageSize;
  // 「能被回收的」（不活动+缓存）不算真占着
  const used = active + wired + compressed;

  const swapUsed = Number((swap.stdout.match(/used\s*=\s*([\d.]+)M/) || [])[1] || 0) / 1024;

  return {
    totalGB: GB(totalBytes),
    usedGB: GB(used),
    freeGB: GB(free),
    cachedGB: GB(inactive),
    swapGB: Math.round(swapUsed * 10) / 10,
    // 压力 = 真占着 / 总量。超过 85% 就该考虑关掉点东西了
    pressure: totalBytes ? Math.round((used / totalBytes) * 100) : 0,
    procs: {
      bridgeMB: Math.round(sumRssKb(psOut.stdout, /src\/index\.js/) / 1024),
      // 本机模型的占用：两条通道的进程名不一样，都要算进去，否则内存卡片会漏报。
      //   MLX 通道   → mlx_lm.server（qwen-server 脚本 exec 出来）
      //   QwenChat 通道 → 由 QwenChat.app 启动的 python 跑 models/app/server.py
      localModelMB: Math.round(sumRssKb(psOut.stdout, /mlx_lm\.server|qwen-server|models\/app\/server\.py/) / 1024),
      dockerMB: Math.round(sumRssKb(psOut.stdout, /Docker\.app|com\.docker/) / 1024),
      panelMB: Math.round(sumRssKb(psOut.stdout, /panel\/server\.js/) / 1024),
    },
  };
}

export function portOpen(port, host = '127.0.0.1', timeout = 800) {
  return new Promise((resolve) => {
    const s = new net.Socket();
    let done = false;
    const fin = (v) => {
      if (done) return;
      done = true;
      s.destroy();
      resolve(v);
    };
    s.setTimeout(timeout);
    s.once('connect', () => fin(true));
    s.once('timeout', () => fin(false));
    s.once('error', () => fin(false));
    s.connect(port, host);
  });
}

/** 真去问一下 OneBot HTTP 接口，比只看端口可靠（Docker 端口转发会假装端口是开的） */
export function httpGet(port, pathname, timeout = 2500) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: pathname, timeout }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve({ ok: res.statusCode === 200, status: res.statusCode, body: b }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, status: 0, body: '' }); });
    req.on('error', () => resolve({ ok: false, status: 0, body: '' }));
  });
}

/**
 * 发一个带 body / 自定义头的本地请求（NapCat WebUI 的接口是 POST + 凭证头）。
 * 失败一律 resolve 成 { ok:false }，调用方不必包 try/catch。
 */
export function httpJson(port, pathname, { method = 'POST', body = null, headers = {}, timeout = 10000 } = {}) {
  return new Promise((resolve) => {
    const payload = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: pathname,
        method,
        timeout,
        headers: {
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
          ...headers,
        },
      },
      (res) => {
        let b = '';
        res.on('data', (c) => (b += c));
        res.on('end', () => {
          let data = null;
          try { data = JSON.parse(b); } catch { /* 不是 JSON 就留 null */ }
          resolve({ ok: res.statusCode === 200, status: res.statusCode, body: b, data });
        });
      }
    );
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, status: 0, body: '', data: null }); });
    req.on('error', () => resolve({ ok: false, status: 0, body: '', data: null }));
    if (payload) req.write(payload);
    req.end();
  });
}

/** 用 HTTP Upgrade 试一次 WebSocket 握手，返回 101 才算通道真开了 */
export function wsProbe(port, timeout = 2500) {
  return new Promise((resolve) => {
    // Sec-WebSocket-Key 必须是 16 字节的 base64，否则部分实现（NapCat）会拒握手
    const key = randomBytes(16).toString('base64');
    let settled = false;
    const fin = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/',
        timeout,
        headers: {
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Version': '13',
          'Sec-WebSocket-Key': key,
        },
      },
      (res) => fin({ ok: res.statusCode === 101, status: res.statusCode })
    );
    req.on('upgrade', (res, socket) => {
      // L-06（2026-10-05 · 第 12 轮）：空 catch **在这里是对的**，且这次写下来 ——
      // 这次探测只关心"端口上有没有一个能升级成 WebSocket 的东西"，答案已经拿到了；
      // socket 是要丢掉的那一端，destroy 成不成功都不改变结论（也无人可报）。
      // 与 `panel/server.js` 里 PIDFILE 那种"失败有后果"的空 catch 不同 —— 那个已改成留痕。
      try { socket.destroy(); } catch {}
      fin({ ok: true, status: 101 });
    });
    req.on('timeout', () => { req.destroy(); fin({ ok: false, status: 0 }); });
    req.on('error', () => fin({ ok: false, status: 0 }));
    req.end();
  });
}

// 前端每 3 秒拉一次状态。docker/ps 这类外部命令有开销，
// 尤其在 Docker 没起来时会卡满超时，所以按秒级缓存，别每次都真跑。
let memCache = { at: 0, data: null };
let dockerCache = { at: 0, up: false };
let dockerPsCache = { at: 0, line: '' };

export async function cachedMemory() {
  const now = Date.now();
  if (memCache.data && now - memCache.at < 5000) return memCache.data;
  const data = await readMemory();
  memCache = { at: now, data };
  return data;
}

export async function cachedDockerUp() {
  const now = Date.now();
  // 缓存时间要大于探测耗时，否则等于每次轮询都要重跑一遍
  if (now - dockerCache.at < 8000) return dockerCache.up;
  const up = await dockerDaemonUp(4000);
  dockerCache = { at: now, up };
  return up;
}

export function invalidateDockerCache() {
  dockerCache = { at: 0, up: false };
  dockerPsCache = { at: 0, line: '' };
}

export async function cachedDockerPs() {
  const now = Date.now();
  // 和 daemon 缓存同 TTL：容器状态只在 onekey / napcat 重启 / stop-all 这类动作后变了，
  // 而它们都会调 invalidateDockerCache()，所以 8 秒内复用上一次结果完全够用，
  // 省掉每 3 秒一次 docker ps 的进程开销（macOS 上 spawn 一次 200~800ms）。
  if (dockerPsCache.line !== null && now - dockerPsCache.at < 8000) return dockerPsCache.line;
  const up = await cachedDockerUp();
  const ps = up
    ? await sh(DOCKER, ['ps', '--filter', 'name=napcat', '--format', '{{.Names}}\t{{.Status}}'], 8000)
    : { stdout: '' };
  const line = ps.stdout.trim().split('\n').filter(Boolean)[0] || '';
  dockerPsCache = { at: now, line };
  return line;
}

export function pidAlive(pid) {
  if (!pid || !Number.isFinite(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM'; // 存在但没权限，也算活着
  }
}

/** 轮询等一个条件成立，最多 timeoutMs */
export async function waitFor(fn, timeoutMs = 60000, intervalMs = 1500) {
  const t0 = Date.now();
  // 固定间隔的毛病：东西 0.2 秒就好了，却要等到下一个整点才被发现 —— 白等最多一整轮
  // （这里原本是 1.5~2 秒，而实测 docker 命令只要 40~130ms，等得毫无必要）。
  //
  // 做法：**前 10 秒每 400ms 探一次，之后就退回调用方给的间隔**。
  // 为什么不是"逐步退避"（300ms 起、每次 ×1.6）：那样在"约 3 秒就绪"的场景**反而更慢** ——
  // 间隔涨到 4 秒后，就绪时刻会被整段跳过去（实测比原来慢 700ms+）。固定间隔没有这个毛病。
  // 为什么只密集 10 秒：要等一分钟的场景（Docker 冷启动、模型加载）没必要一直高频探。
  const DENSE_MS = 400;
  const DENSE_WINDOW_MS = 10000;
  while (Date.now() - t0 < timeoutMs) {
    if (await fn()) return true;
    const dense = Date.now() - t0 < DENSE_WINDOW_MS;
    await new Promise((s) => setTimeout(s, dense ? Math.min(DENSE_MS, intervalMs) : intervalMs));
  }
  return false;
}
