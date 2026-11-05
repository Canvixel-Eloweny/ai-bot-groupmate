// /api/try 鉴权与单飞（2026-11-05 · 外部评估 P2）
//   ① 真起面板：缺 token / 坏 token / 跨源 Origin 必须在启动 dryrun 之前被拒；
//   ② 单飞闸：同一时刻只允许一次试跑，额满返回 429，释放后可再次获取。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTryGate } from '../panel/lib/try-gate.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const NODE = process.execPath;
const USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-try-auth-'));
const TOKEN = 'try-auth-test-token';

let pass = 0;
const fails = [];
const ok = (name, cond, extra = '') => {
  if (cond) { pass += 1; return; }
  fails.push(`${name}${extra ? `  → ${extra}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

async function waitTcp(port, ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const up = await new Promise((resolve) => {
      const sock = net.connect({ port, host: '127.0.0.1' });
      const done = (v) => { sock.destroy(); resolve(v); };
      sock.setTimeout(500);
      sock.on('connect', () => done(true));
      sock.on('timeout', () => done(false));
      sock.on('error', () => done(false));
    });
    if (up) return true;
    await sleep(100);
  }
  return false;
}

const gate = createTryGate();
ok('单飞闸：第一次获取成功', gate.acquire() === true);
ok('单飞闸：在途时第二次被拒', gate.acquire() === false);
gate.release();
ok('单飞闸：释放后可再次获取', gate.acquire() === true);
gate.release();

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
    QQBOT_PANEL_TOKEN: TOKEN,
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
    for (let i = 0; i < 40 && child.exitCode === null; i += 1) await sleep(100);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  try { fs.rmSync(USERDATA, { recursive: true, force: true }); } catch { /* ignore */ }
};

async function post(headers = {}, body = { text: '测试一句' }) {
  const r = await fetch(`${base}/api/try`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  let data = null;
  try { data = await r.json(); } catch { data = null; }
  return { status: r.status, data };
}

try {
  ok('面板已监听', await waitTcp(port), out.slice(-300));

  const noToken = await post();
  ok('缺 token 在启动 dryrun 前被拒（401）',
    noToken.status === 401 && noToken.data && noToken.data.reason === 'missing',
    JSON.stringify(noToken));

  const badToken = await post({ authorization: 'Bearer wrong-token' });
  ok('坏 token 被拒（401）', badToken.status === 401, JSON.stringify(badToken));

  const cross = await post({ authorization: `Bearer ${TOKEN}`, origin: 'http://evil.example' });
  ok('跨源 Origin 的写请求被拒（403）', cross.status === 403 && cross.data && cross.data.reason === 'cross-site',
    JSON.stringify(cross));

  // 同源 + 正确 token 的请求必须穿过鉴权层（这里不真的调模型：故意给空文本，让 handler 自己 400）。
  const empty = await post({ authorization: `Bearer ${TOKEN}`, origin: base }, { text: '   ' });
  ok('同源 + 正确 token 能穿过鉴权（handler 自己判空返回 400）',
    empty.status === 400 && empty.data && /先说一句/.test(empty.data.error || ''),
    JSON.stringify(empty));
} finally {
  await stop();
}

if (fails.length) {
  console.log(`/api/try 鉴权判据：${pass} 项通过，${fails.length} 项失败`);
  for (const f of fails) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`/api/try 鉴权判据：${pass} 项通过，0 项失败`);
