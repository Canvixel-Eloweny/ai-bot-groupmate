// 假 QQ 虚拟入口（面板页）判据 —— 接线 + 一次真会话。
//
// 盯三件事：
//   ① 面板侧的四条路由都登记了、三条写路由**进了 WRITE_ROUTES**（漏了会绕过鉴权与审计）；
//   ② 拒绝路径：会话没在跑时不许发；真机器人在跑且没勾沙箱 ⇒ 不许起；
//   ③ 真起一次会话（离线假模型 + 空沙箱数据），说一句，它必须回 —— 这条才是"入口是通的"。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeSnapshot, fakeStart, fakeSend, fakeStop, fakeDispose, FAKE_SCRIPT } from '../panel/lib/fake-session.js';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0;
const fails = [];
function ok(name, cond) {
  if (cond) { pass += 1; return; }
  fails.push(name);
}
const read = (rel) => fs.readFileSync(path.join(APP, rel), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms, why) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await sleep(100);
  }
  throw new Error(`等待超时：${why}`);
}
const texts = () => fakeSnapshot(0).lines.map((l) => l.text).join('\n');

// ── ① 模块与路由接线 ─────────────────────────────────────────────────────
ok('脚本就在 scripts/fake-qq.mjs', fs.existsSync(FAKE_SCRIPT));
const idle = fakeSnapshot(0);
ok('空闲快照的形状', idle.running === false && idle.seq === 0 && Array.isArray(idle.lines));

const serverSrc = read('panel/server.js');
for (const r of ['/api/fake-qq/state', '/api/fake-qq/start', '/api/fake-qq/send', '/api/fake-qq/stop']) {
  ok(`API_ROUTES 登记了 ${r}`, new RegExp(`path: '${r.replace(/\//g, '\\/')}'`).test(serverSrc));
}
const writeBlock = serverSrc.slice(serverSrc.indexOf('const WRITE_ROUTES'), serverSrc.indexOf('function isWriteRequest'));
for (const r of ['/api/fake-qq/start', '/api/fake-qq/send', '/api/fake-qq/stop']) {
  ok(`WRITE_ROUTES 收下了 ${r}`, writeBlock.includes(`'${r}'`));
}
ok('只读状态路由**没有**被误收进写路由', !writeBlock.includes("'/api/fake-qq/state'"));
ok('面板退出时收掉会话（不留孤儿）', /function shutdown\([^)]*\)[\s\S]{0,800}fakeDispose\(\)/.test(serverSrc));
ok('起会话前问过真机器人在不在跑', /apiFakeStart[\s\S]{0,400}bridgeRunning\(\)/.test(serverSrc));

// ── ② 面板界面接线 ───────────────────────────────────────────────────────
const schema = read('panel/next/schema.js');
const appjs = read('panel/next/app.js');
ok('页面存在（假 QQ）', /id: 'fake', label: '假 QQ'/.test(schema));
ok('页面用它自己的渲染器', /id: 'fake', title: '会话（打字 = 发消息）'[\s\S]{0,800}t: 'fakeView'/.test(schema));
ok('输入框是 volatile（整页重画不抹字）', /id: 'fake\.text'[\s\S]{0,120}volatile: true/.test(schema));
for (const a of ['fake.start', 'fake.stop', 'fake.send', 'fake.cmd', 'fake.clear', 'fake.opt']) {
  ok(`动作 ${a} 在 ACTIONS 里`, new RegExp(`'${a.replace('.', '\\.')}':`).test(appjs));
}
ok('渲染器 fakeView 在 RENDER 里', /fakeView: \(\) =>/.test(appjs));
ok('页面显示时挂轮询', /ids\.has\('fakeView'\)\) mountFake\(\)/.test(appjs));
ok('轮询打的是只读状态路由', /\/api\/fake-qq\/state\?since=/.test(appjs));
ok('说话打的是 send 路由', /\/api\/fake-qq\/send/.test(appjs));
ok('真机器人在跑时前端先拦一道（提示沙箱）', /fake\.start'[\s\S]{0,400}sandbox/.test(appjs));

// ── ③ 拒绝路径 ───────────────────────────────────────────────────────────
ok('没在跑时不许发', fakeSend('在吗').ok === false);
ok('真机器人在跑 + 没沙箱 ⇒ 拒绝启动', fakeStart({}, { bridgeRunning: true }).ok === false
  && fakeStart({ sandbox: false }, { bridgeRunning: true }).msg.includes('沙箱'));
// ── ④ 真起一次会话（离线假模型 + 空沙箱数据）─────────────────────────────
const cfgOk = fs.existsSync(path.join(APP, 'config.json')) || fs.existsSync(path.join(APP, 'config.example.json'));
ok('有可用的配置来源（config.json / config.example.json）', cfgOk);
const started = fakeStart({ offline: true, sandbox: true }, { bridgeRunning: false });
ok('启动被接受', started.ok === true);
try {
  await waitFor(() => texts().includes('开始说话吧'), 30000, '会话连上并进入可打字状态');
  ok('启动日志里有"开始说话吧"', texts().includes('开始说话吧'));
  ok('会话标记为在跑', fakeSnapshot(0).running === true);
  const empty = fakeSend('   ');
  ok('空的一句不发（真会话）', empty.ok === false);
  const sent = fakeSend('在吗');
  ok('一句话写得进去', sent.ok === true);
  await waitFor(() => texts().includes('离线假回话'), 30000, '机器人回一句「离线假回话」');
  ok('会话层回显了机器人的回复', /机器人（群）▸ .*离线假回话/.test(texts()));
  const sec = fakeSnapshot(0).seq;
  const delta = fakeSnapshot(sec);
  ok('since 游标只回新行', delta.lines.length === 0 && delta.seq === sec);
} finally {
  fakeStop();
  try { await waitFor(() => !fakeSnapshot(0).running, 8000, '会话进程退出'); } catch { /* 下一句会报出来 */ }
  ok('停止之后真的没在跑了', fakeSnapshot(0).running === false);
  fakeDispose();
}

if (fails.length) {
  console.error(`✗ check-fake-panel：${pass} 项通过，${fails.length} 项失败`);
  for (const f of fails) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`✓ check-fake-panel：${pass} 项通过`);
