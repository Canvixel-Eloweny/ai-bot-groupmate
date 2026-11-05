// OneBot 入站脏帧守卫（2026-11-05 · 外部评估 P2）
//   真 WS 连续发：坏 JSON / null / 数组 / 数字 / 未知对象 → 合法群消息 + 合法 echo。
//   断言：进程不退出、合法事件照收、echo 照答、脏帧有计数且不会把连接标成健康。
import { WebSocketServer } from 'ws';
import { OneBotClient } from '../src/onebot.js';

let pass = 0;
const fails = [];
const ok = (name, cond, extra = '') => {
  if (cond) { pass += 1; return; }
  fails.push(`${name}${extra ? `  → ${extra}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fn()) return true;
    await sleep(20);
  }
  throw new Error(`等待超时：${label}`);
}

const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
await new Promise((r) => wss.once('listening', r));
const port = wss.address().port;
let client = null;
const messages = [];
const actions = [];

const bot = new OneBotClient({
  wsUrl: `ws://127.0.0.1:${port}`,
  accessToken: '',
  reconnectBackoffMs: [50, 100],
  statusProbeMs: 0,
  staleMs: 60_000,
});
bot.on('message', (evt) => messages.push(evt));
bot.start();

wss.on('connection', (ws) => {
  client = ws;
  ws.on('message', (buf) => {
    let obj = null;
    try { obj = JSON.parse(buf.toString()); } catch { return; }
    actions.push(obj);
    if (obj && obj.echo) {
      ws.send(JSON.stringify({ status: 'ok', retcode: 0, data: { good: true, online: true }, echo: obj.echo }));
    }
  });
});

try {
  await waitFor(() => client && bot.connected, 3000, 'WS 连接');

  // 五种脏帧：解析失败 / null / 数组 / 数字 / 未知对象。
  client.send('this is not json');
  client.send('null');
  client.send('[]');
  client.send('42');
  client.send('{}');
  await sleep(80);

  client.send(JSON.stringify({
    post_type: 'message',
    message_type: 'group',
    group_id: 10001,
    user_id: 20002,
    message_id: 1,
    message: [{ type: 'text', data: { text: '脏帧之后的合法消息' } }],
  }));
  await waitFor(() => messages.length === 1, 2000, '合法群消息');
  ok('脏帧之后合法消息照收', messages.length === 1 && messages[0].group_id === 10001,
    `messages=${messages.length}`);
  ok('脏帧有计数（坏 JSON/null/数组/数字）', bot.badFrames === 4, `badFrames=${bot.badFrames}`);
  ok('脏帧不把连接标成健康', bot.connected === true && bot.lastFrameAt > 0,
    `connected=${bot.connected} lastFrameAt=${bot.lastFrameAt}`);

  const echo = await bot.call('get_status', {}, 2000);
  ok('脏帧之后合法 echo 仍能完成', echo && echo.good === true, JSON.stringify(echo));
  ok('echo 回包计入了动作记录', actions.some((a) => a.action === 'get_status'),
    actions.map((a) => a.action).join(','));
} finally {
  bot.stop();
  await new Promise((r) => wss.close(r));
}

if (fails.length) {
  console.log(`OneBot 脏帧判据：${pass} 项通过，${fails.length} 项失败`);
  for (const f of fails) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`OneBot 脏帧判据：${pass} 项通过，0 项失败`);
