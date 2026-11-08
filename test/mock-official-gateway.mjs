/**
 * 本地假官方网关（2026-11-06 · 只在回归里用）。
 *
 * 它同时扮演两件事：
 *   ① HTTP：`/app/getAppAccessToken`、`/users/@me`、`/v2/groups|users/.../messages`、`/files`、`/info`
 *   ② WebSocket：Hello(op 10) → 收 identify/resume → 下发 READY / 事件
 *
 * 为什么必须有它：官方那半边**离线什么都测不出来**，而"接缝形状错了"这一类缺陷
 * 恰好是纯函数单测看不见的 —— 教程里那条真机事故（把官方原始事件裸投给大脑，
 * 大脑不认、不回 ack、10 秒无限重投）就是离线全绿、真机才炸的典型。
 * 这里把"原始事件 → 大脑"这一段真的跑一遍，只是对端换成本机环回。
 *
 * ⚠️ 只监听 127.0.0.1，且**不校验凭据内容**（它的工作是记账，不是鉴权）。
 */

import http from 'node:http';
import { WebSocketServer } from 'ws';

const OP = { DISPATCH: 0, HEARTBEAT: 1, IDENTIFY: 2, RESUME: 6, HELLO: 10, ACK: 11 };

export async function startMockOfficialGateway({ heartbeatIntervalMs = 2000 } = {}) {
  const log = {
    requests: [],      // 每个 REST 请求 { method, url, body, headers }
    identifies: [],    // 每个 identify 帧
    resumes: [],       // 每个 resume 帧
    heartbeats: 0,
    sockets: 0,
  };
  /** 用例可以改写这些返回值；默认是"一切正常"。 */
  const reply = {
    token: { code: 0, data: { access_token: 'MOCK-TOKEN', expires_in: 7200 } },
    bot: { code: 0, data: { id: 'BOTOPENID', username: 'mock-bot', bot: true } },
    send: { code: 0, data: { id: 'MOCK-MSG-1', timestamp: '2026-11-06T10:00:00+08:00' } },
    files: { code: 0, data: { file_info: 'MOCK-FILE-INFO', ttl: 300 } },
    groupInfo: { code: 0, data: { group_openid: 'G', group_name: 'mock 群', group_member_num: 7 } },
    // 下一次 send 想注入的失败（{ httpStatus, body }），用完即清
    sendFailure: null,
  };
  let wsPort = 0;

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
      log.requests.push({ method: req.method, url: req.url, body, headers: req.headers });

      const json = (obj, status = 200) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      if (req.url === '/app/getAppAccessToken') return json(reply.token);
      if (req.url === '/users/@me') return json(reply.bot);
      if (/^\/v2\/groups\/[^/]+\/files$/.test(req.url)) return json(reply.files);
      if (/^\/v2\/groups\/[^/]+\/info$/.test(req.url)) return json(reply.groupInfo);
      if (/\/messages$/.test(req.url)) {
        if (reply.sendFailure) {
          const f = reply.sendFailure;
          reply.sendFailure = null;
          return json(f.body ?? { code: 40054005, message: '消息被去重' }, f.httpStatus ?? 200);
        }
        // 每次发送换一条消息号，方便断言"回执被归一成 message_id"
        const n = log.requests.filter((r) => /\/messages$/.test(r.url)).length;
        return json({ ...reply.send, data: { ...reply.send.data, id: `MOCK-MSG-${n}` } });
      }
      return json({ code: 404, message: 'mock 网关没有这条路由' }, 404);
    });
  });

  const wss = new WebSocketServer({ server });
  wss.on('connection', (socket) => {
    log.sockets += 1;
    let seq = 0;
    const send = (obj) => { try { socket.send(JSON.stringify(obj)); } catch { /* 已关 */ } };
    send({ op: OP.HELLO, d: { heartbeat_interval: heartbeatIntervalMs } });
    socket.on('message', (raw) => {
      let frame;
      try { frame = JSON.parse(raw.toString('utf8')); } catch { return; }
      if (frame.op === OP.IDENTIFY) {
        log.identifies.push(frame.d);
        seq += 1;
        send({
          op: OP.DISPATCH, s: seq, t: 'READY',
          d: { session_id: 'MOCK-SESSION', user: { id: 'BOTOPENID', username: 'mock-bot' }, shard: [0, 1] },
        });
        return;
      }
      if (frame.op === OP.RESUME) {
        log.resumes.push(frame.d);
        seq += 1;
        send({ op: OP.DISPATCH, s: seq, t: 'RESUMED', d: {} });
        return;
      }
      if (frame.op === OP.HEARTBEAT) {
        log.heartbeats += 1;
        send({ op: OP.ACK, d: 1 });
      }
    });
    socket.__mock = {
      /** 用例用它推事件；seq 由网关自己递增（客户端要按 s 记账）。 */
      push: (t, d) => { seq += 1; send({ op: OP.DISPATCH, s: seq, t, d }); },
      closeLikePlatform: (code) => socket.close(code, 'mock'),
    };
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  wsPort = server.address().port;

  return {
    httpBase: `http://127.0.0.1:${wsPort}`,
    wsUrl: `ws://127.0.0.1:${wsPort}/websocket/`,
    log,
    reply,
    /** 最近一条连上来的 socket（推事件用）。 */
    socket: () => [...wss.clients][0]?.__mock || null,
    /** 平台单方面要求重连（op 7）。 */
    requestReconnect: () => { const s = [...wss.clients][0]; if (s) s.send(JSON.stringify({ op: 7, d: null })); },
    /** 会话作废（op 9，d=true 表示可续传）。 */
    invalidSession: (resumable = true) => {
      const s = [...wss.clients][0];
      if (s) s.send(JSON.stringify({ op: 9, d: resumable }));
    },
    close: async () => {
      for (const c of wss.clients) { try { c.close(); } catch { /* 已关 */ } }
      await new Promise((resolve) => wss.close(resolve));
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
