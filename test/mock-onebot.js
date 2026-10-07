import { WebSocketServer } from 'ws';

/**
 * 最小 OneBot v11 服务端（正向 WS）。
 * 只实现自测需要的东西：接收 API 调用并记录，可主动推事件。
 */
export function startMockOneBot({ port, selfId = '10001', onForward = null }) {
  const wss = new WebSocketServer({ port });
  const sent = [];
  const actions = [];
  // D23-2：合并转发展开要调 `get_forward_msg`。这里把**每一次调用的入参**留下来 ——
  // 断言"用没用 message_id（而不是段里那个 res_id）"只有靠它才看得见。
  const forwardCalls = [];
  let client = null;
  let seq = 0;

  let resolveClient;
  const clientReady = new Promise((r) => {
    resolveClient = r;
  });

  wss.on('connection', (ws) => {
    client = ws;
    ws.send(
      JSON.stringify({
        post_type: 'meta_event',
        meta_event_type: 'lifecycle',
        sub_type: 'connect',
        self_id: selfId,
        time: Math.floor(Date.now() / 1000),
      })
    );
    resolveClient();

    ws.on('message', (buf) => {
      let msg;
      try {
        msg = JSON.parse(buf.toString());
      } catch {
        return;
      }
      actions.push(msg.action);
      let data = { message_id: ++seq };
      let ok = true;
      let message = '';
      if (msg.action === 'get_forward_msg') {
        forwardCalls.push(msg.params || {});
        // 默认回一个**空壳**（等价于协议端说"没有内容"）—— 于是"没配 onForward 的用例"
        // 走的就是 fail-open 那条路，不会静默变成"展开成功"。
        const r = typeof onForward === 'function' ? onForward(msg.params || {}) : null;
        if (r && r.ok === false) { ok = false; message = String(r.message || 'mock 拒绝'); data = {}; }
        else if (r && r.data) data = r.data;
        else data = {};
      }
      if (msg.action === 'send_group_msg' || msg.action === 'send_private_msg') {
        sent.push({ action: msg.action, params: msg.params });
      }
      ws.send(
        JSON.stringify({
          status: ok ? 'ok' : 'failed',
          retcode: ok ? 0 : 1,
          data,
          message,
          echo: msg.echo,
        })
      );
    });
  });

  const listening = new Promise((r) => wss.on('listening', r));

  return {
    sent,
    actions,
    forwardCalls,
    listening,
    clientReady,
    get connected() {
      return client !== null;
    },
    pushEvent(evt) {
      if (!client) throw new Error('桥接还没连上来');
      client.send(JSON.stringify(evt));
    },
    close() {
      return new Promise((r) => wss.close(() => r()));
    },
  };
}

/** 造一条群消息事件。`extraSegments` 追加在正文之后（D23-2：用来带一条 forward 段）。 */
export function groupMessage({
  groupId,
  userId,
  selfId,
  text,
  messageId,
  nickname = '路人',
  mentionSelf = false,
  extraSegments = [],
}) {
  const message = [];
  if (mentionSelf) message.push({ type: 'at', data: { qq: String(selfId) } });
  message.push({ type: 'text', data: { text } });
  message.push(...(Array.isArray(extraSegments) ? extraSegments : []));
  return {
    post_type: 'message',
    message_type: 'group',
    sub_type: 'normal',
    message_id: messageId ?? Math.floor(Math.random() * 1e6),
    group_id: groupId,
    user_id: userId,
    self_id: selfId,
    raw_message: text,
    message,
    sender: { user_id: userId, nickname, card: '' },
    time: Math.floor(Date.now() / 1000),
  };
}

export function privateMessage({ userId, selfId, text, messageId, nickname = '路人' }) {
  return {
    post_type: 'message',
    message_type: 'private',
    sub_type: 'friend',
    message_id: messageId ?? Math.floor(Math.random() * 1e6),
    user_id: userId,
    self_id: selfId,
    raw_message: text,
    message: [{ type: 'text', data: { text } }],
    sender: { user_id: userId, nickname, card: '' },
    time: Math.floor(Date.now() / 1000),
  };
}
