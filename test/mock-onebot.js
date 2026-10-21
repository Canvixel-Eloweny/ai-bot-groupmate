import { WebSocketServer } from 'ws';

/**
 * 最小 OneBot v11 服务端（正向 WS）。
 * 只实现自测需要的东西：接收 API 调用并记录，可主动推事件。
 *
 * 故障形态（2026-10-20 · B1）：真实后端不只会"立刻答 ok" ——
 *   · `heartbeatMs`  连上后按周期推 `meta_event/heartbeat`（有的家可配、有的家不推）；
 *   · `delayMs`      每条动作延迟回包（测超时边界与慢后端）；
 *   · `silentActions` 指定的动作**永不应答**（socket 还在，但 echo 永远不回来 ——
 *                    这是"半断连"的真实形状，也是客户端 echo 超时唯一的试金石）；
 *   · `muteAfter`    第 N 条动作之后所有动作都不再应答（进程活着、连接也活着）。
 * 四个默认值都不改变既有用例的行为（0 / 0 / [] / 0）。
 */
export function startMockOneBot({
  port, selfId = '10001', onForward = null,
  heartbeatMs = 0, delayMs = 0, silentActions = [], muteAfter = 0,
}) {
  const wss = new WebSocketServer({ port });
  const sent = [];
  const actions = [];
  // D23-2：合并转发展开要调 `get_forward_msg`。这里把**每一次调用的入参**留下来 ——
  // 断言"用没用 message_id（而不是段里那个 res_id）"只有靠它才看得见。
  const forwardCalls = [];
  const silent = new Set(Array.isArray(silentActions) ? silentActions : []);
  let client = null;
  let seq = 0;
  let actionCount = 0;

  const heartbeatEvent = () => ({
    post_type: 'meta_event',
    meta_event_type: 'heartbeat',
    sub_type: 'heartbeat',
    self_id: selfId,
    status: { online: true, good: true },
    interval: heartbeatMs,
    time: Math.floor(Date.now() / 1000),
  });

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

    // 心跳：连上就开始推，断开就停（`unref` —— 它不该成为进程退出的理由）。
    let hbTimer = null;
    if (heartbeatMs > 0) {
      hbTimer = setInterval(() => {
        try { ws.send(JSON.stringify(heartbeatEvent())); } catch { /* 已经断了 */ }
      }, heartbeatMs);
      hbTimer.unref?.();
    }
    ws.on('close', () => { if (hbTimer) { clearInterval(hbTimer); hbTimer = null; } });

    ws.on('message', (buf) => {
      let msg;
      try {
        msg = JSON.parse(buf.toString());
      } catch {
        return;
      }
      actions.push(msg.action);
      actionCount += 1;
      // 半断连：连接还在，但这条（以及之后的）动作永远没有回包。
      if (silent.has(msg.action) || (muteAfter > 0 && actionCount > muteAfter)) return;

      const reply = () => {
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
      };
      if (delayMs > 0) setTimeout(reply, delayMs);
      else reply();
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
    /** 手动推一条心跳（不必等周期）—— 测"消费到心跳"时用它把时序钉死。 */
    pushHeartbeat(extra = {}) {
      if (!client) throw new Error('桥接还没连上来');
      client.send(JSON.stringify({ ...heartbeatEvent(), ...extra }));
    },
    get actionCount() {
      return actionCount;
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
