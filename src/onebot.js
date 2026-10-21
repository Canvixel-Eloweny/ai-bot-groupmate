import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import scoped from './logger.js';
import { probeForwardSegment } from './forward-probe.js';
// L3 归一层（2026-10-20）：`status === 'ok' || retcode === 0` 这条判据会把
// 「业务失败仍回 retcode 200」的后端当成成功（Lagrange 实证）；归一判据只有一份。
import { classifyOneBotReply } from './backend/normalize.js';

const log = scoped('onebot');

/**
 * 触发判定该看的正文。
 *
 * D28（信号③ · 报告"@ 走 qq 集合，text 只作参考"）：
 * `text` 是**给人/模型看**的那一份，@ 段会被渲染成显示名（「@摸鱼小能手 」）——
 * 群里 @ 一个名字里带「鱼」的群友，别名「小鱼」与关键词「肥鱼」就都会被误命中，
 * 于是它以为有人在叫它。而"是不是在叫我"这件事，**只看 qq 号集合**（`mentionedSelf`）
 * —— 显示名会重名、会改，qq 号不会。
 *
 * 所以触发判据只看 `bareText`（@ 段的显示名**不**进这一份），正文该怎么显示还怎么显示。
 *
 * ⚠️ 没有 `bareText` 时回落到 `text`：那意味着这条消息没有 @ 段信息，
 *    此时正文就是全部正文（两者本该相等），不是"降级掩盖问题"。
 */
export function triggerTextOf(parsed) {
  const bare = parsed?.bareText;
  return typeof bare === 'string' ? bare : String(parsed?.text ?? '');
}

/**
 * 把 OneBot v11 消息段数组拍平成可读文本，并记录是否被 @ 了。
 *
 * @param {unknown} segments OneBot 段数组（或一个已经是字符串的正文）
 * @param {string|number} selfId 机器人自己的 QQ 号
 * @param {{forwardText?:string, probe?:boolean}} [opts]
 *   · `forwardText`（D23-2）：合并转发**展开后**的文本，由调用方先调一次
 *     `get_forward_msg` 拿到（见 `forward-expand.js` 文件头）。
 *     ⚠️ 它**只进 `text`，不进 `bareText`**：展开内容若进了触发判据，
 *     一段转发记录里出现「小鱼」就会把它叫出来（D28 同一条理由）。
 *   · `probe`：默认 true，走 D23-1 的量数探针；渲染转发的**内部节点**时必须传
 *     `false`（那是二次渲染，记进去会让探针的形态统计虚高）。
 */
export function flattenMessage(segments, selfId, opts = {}) {
  let text = '';
  // D28：与 `text` 同步累加，唯一差别是 **@ 别人的显示名不进这一份**（见 `triggerTextOf`）。
  // 两者在同一个循环里一起维护 —— 分到两处写必然漂移。
  let bareText = '';
  // D23-2：整条消息**最多展开一次**。`get_forward_msg` 认的是这条消息自己的 id，
  // 一条消息里两个转发段拿到的是同一份内容 —— 再贴一遍只是把同样的话说两次。
  const forwardText = String(opts.forwardText ?? '');
  const probe = opts.probe !== false;
  let forwardUsed = false;
  let mentionedSelf = false;
  let replyTo = null;
  // 图片地址单独收集：开了识图之后要把它们喂给多模态模型
  const images = [];

  if (typeof segments === 'string') {
    return { text: segments, bareText: segments, mentionedSelf: false, replyTo: null, images };
  }
  if (!Array.isArray(segments)) {
    return { text: '', bareText: '', mentionedSelf: false, replyTo: null, images };
  }

  for (const seg of segments) {
    const type = seg?.type;
    const data = seg?.data ?? {};
    switch (type) {
      case 'text': {
        const t = String(data.text ?? '');
        text += t;
        bareText += t;
        break;
      }
      case 'at': {
        const qq = String(data.qq ?? '');
        if (qq === String(selfId)) {
          mentionedSelf = true;
        } else if (qq === 'all') {
          mentionedSelf = true;
          text += '@全体成员 ';
          bareText += '@全体成员 ';
        } else {
          // ⚠️ 只进 `text`（给人看），**不进** `bareText`（给触发判据看）
          text += `@${data.name || qq} `;
        }
        break;
      }
      case 'reply':
        replyTo = String(data.id ?? '');
        break;
      case 'image': {
        const url = String(data.url || data.file || '');
        if (/^https?:\/\//i.test(url)) images.push(url);
        text += '[图片]';
        bareText += '[图片]';
        break;
      }
      case 'face':
        text += '[表情]';
        bareText += '[表情]';
        break;
      case 'record':
        text += '[语音]';
        bareText += '[语音]';
        break;
      case 'video':
        text += '[视频]';
        bareText += '[视频]';
        break;
      case 'file':
        text += '[文件]';
        bareText += '[文件]';
        break;
      case 'forward':
      case 'node': {
        if (probe) probeForwardSegment(seg);
        // D23-2：有展开文本就用它（**只进 text** —— 见上面的 opts 注释）。
        const expanded = forwardText && !forwardUsed ? forwardText : '';
        if (expanded) forwardUsed = true;
        text += expanded || '[合并转发]';
        // ⚠️ `bareText` **恒为占位符**，无论有没有展开 —— 触发判据（别名 / 关键词 /
        //    叫醒词表）都不该因为"转发里提到过它"而变。
        bareText += '[合并转发]';
        break;
      }
      default:
        break;
    }
  }
  return { text: text.trim(), bareText: bareText.trim(), mentionedSelf, replyTo, images };
}

/**
 * 机器人自己问 `get_status` 的周期。
 * 为什么不能只靠事件里的 heartbeat：NapCat 的 `heartInterval` 只有 ws-server/ws-client
 * 两种模式可配，HTTP 内嵌 WS 那条是硬编码；LLBot/官方等后端更不保证推。
 * 周期探活是唯一不依赖后端配置的观测面（30s 与 NapCat 默认心跳同量级）。
 */
const STATUS_PROBE_MS = 30000;

export class OneBotClient extends EventEmitter {
  /** @param {{wsUrl:string, accessToken:string, reconnectBackoffMs:number[], statusProbeMs?:number}} opts */
  constructor(opts) {
    super();
    this.opts = opts;
    this.ws = null;
    this.selfId = null;
    this.connected = false;
    this.pending = new Map();
    this.seq = 0;
    this.attempt = 0;
    this.closedByUs = false;
    // ── 可观测面（B2/B3/B4 · 2026-10-20）──────────────────────────────────────
    // 进程内存里的"最近一次"时刻；面板通过 effective.json 读到它们（不另开端口）。
    this.lastFrameAt = 0;        // 任何入站帧（含 echo 回包）
    this.lastHeartbeatAt = 0;    // meta_event/heartbeat
    this.heartbeatIntervalMs = 0;// 后端自报的心跳间隔（0 = 没报过）
    this.lastStatusAt = 0;       // 最近一次周期探活实际发出的时刻
    this.lastStatusOk = null;    // null = 还没问过；true/false = 最近一次的结果
    this.statusTimer = null;
    this.stats = { calls: 0, timeouts: 0 };
    const probeMs = opts.statusProbeMs === undefined ? STATUS_PROBE_MS : Number(opts.statusProbeMs);
    this.statusProbeMs = Number.isFinite(probeMs) && probeMs > 0 ? probeMs : 0;
    // 待触发的重连定时器句柄。每次真的排了新的就把上一个清掉 ——
    // 否则连接失败时 error+close 反复触发，会排出多个各自独立的 setTimeout，
    // 它们全都到点各连一次；后连上的覆盖 this.ws，先到的成了孤儿，
    // 而孤儿的 close 又会再排一个 —— 级联放大。
    this.reconnectTimer = null;
    // ── 存活看门狗（B3 · 2026-10-21）──────────────────────────────────────
    // QQ 被腾讯踢下线时 NapCat 进程还活着、3001 还开着 —— 只靠 `close` 重连永远等不到。
    // 这里只做一件事：**连续收不到任何入站帧**时主动 terminate，把重连交回 close 里那唯一一条路。
    this.connectedAt = 0;
    this.botOffline = false;
    this.botOfflineAt = 0;
    this.reconnects = 0;
    this.watchdogKills = 0;
    this.lastDropReason = '';
    const stale = Number(opts.staleMs);
    this.staleMs = Number.isFinite(stale) && stale > 0 ? stale : 90000;
    this.watchdogTimer = null;
  }

  start() {
    this.closedByUs = false;
    this.#connect();
    this.#startStatusProbe();
    this.#startWatchdog();
    return this;
  }

  stop() {
    this.closedByUs = true;
    if (this.statusTimer) {
      clearInterval(this.statusTimer);
      this.statusTimer = null;
    }
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
    // 已经排出去的重连要撤掉：closedByUs 只在 close 回调里被读，
    // 而定时器到点时是一次全新的调用，那条路上根本不会经过那个判断。
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
    }
  }

  #connect() {
    const headers = this.opts.accessToken
      ? { Authorization: `Bearer ${this.opts.accessToken}` }
      : undefined;

    log.info(`正在连接协议端 ${this.opts.wsUrl}`);
    const ws = new WebSocket(this.opts.wsUrl, { headers });
    this.ws = ws;

    ws.on('open', () => {
      this.connected = true;
      this.attempt = 0;
      this.connectedAt = Date.now();
      this.lastFrameAt = Date.now();
      this.lastHeartbeatAt = 0;
      this.botOffline = false;
      this.botOfflineAt = 0;
      log.info('协议端已连接');
      this.emit('ready');
    });

    ws.on('message', (buf) => this.#onRaw(buf));

    ws.on('error', (err) => {
      log.warn(`WebSocket 错误: ${err.message}`);
    });

    ws.on('close', (code) => {
      // 旧 socket 的迟到 close 不许清掉新连接：先认"这条还是不是当前那条"。
      if (this.ws !== ws) return;
      this.connected = false;
      this.selfId = null;
      this.#rejectAllPending('连接已断开');
      if (this.closedByUs) return;
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
      this.reconnects += 1;
      const backoff = this.opts.reconnectBackoffMs;
      const delay = backoff[Math.min(this.attempt, backoff.length - 1)];
      this.attempt += 1;
      log.warn(`连接断开 (code=${code})，${delay}ms 后重连（第 ${this.attempt} 次）`);
      // 这里绝对不能 unref()：socket 一断，事件循环里就只剩这个定时器了，
      // unref 之后 Node 会认为没事可做直接退出，重连变成空话
      // （现象：协议端一重启，桥接进程就自己消失了）
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.#connect();
      }, delay);
    });
  }

  #onRaw(buf) {
    let payload;
    try {
      payload = JSON.parse(buf.toString());
    } catch {
      log.debug('收到非 JSON 报文，已忽略');
      return;
    }
    this.lastFrameAt = Date.now();

    if (payload.echo !== undefined && this.pending.has(payload.echo)) {
      const { resolve, reject, timer, action } = this.pending.get(payload.echo);
      clearTimeout(timer);
      this.pending.delete(payload.echo);
      const reply = classifyOneBotReply(payload);
      if (reply.businessOk) {
        resolve(reply.data ?? payload);
      } else {
        const err = new Error(`API 返回失败: retcode=${payload.retcode} ${payload.message ?? ''}`);
        // 把归一层的结果挂在错误上：调用方按 `code` 分支，不比中文文案。
        err.code = reply.code;
        err.transportOk = reply.transportOk;
        err.businessOk = false;
        err.action = action || '';
        reject(err);
      }
      return;
    }

    if (payload.post_type === 'meta_event' && payload.meta_event_type === 'lifecycle') {
      this.selfId = String(payload.self_id);
      log.info(`登录账号 self_id=${this.selfId}`);
      return;
    }

    // 心跳事件（B2）：只记录，不改连接状态 —— 它证明的是"对面还在推"，
    // 不能反过来当"连上了"（lifecycle/open 才是连接判据）。
    if (payload.post_type === 'meta_event' && payload.meta_event_type === 'heartbeat') {
      this.lastHeartbeatAt = Date.now();
      const iv = Number(payload.interval);
      if (Number.isFinite(iv) && iv > 0) this.heartbeatIntervalMs = iv;
      // NapCat 的 `status.online` 就是 QQ 账号在线状态。false 时**不重连** ——
      // 重连替代不了扫码/重新登录，只会多一次风控判定。
      const online = payload.status?.online;
      if (online === false && !this.botOffline) {
        this.botOffline = true;
        this.botOfflineAt = Date.now();
        this.lastDropReason = '账号已掉线（心跳 status.online=false）';
        log.warn('协议端心跳报告账号已掉线 —— 不重启协议端，等它自己重登或扫码');
        this.emit('offline', { at: this.botOfflineAt, reason: this.lastDropReason });
      } else if (online === true && this.botOffline) {
        this.botOffline = false;
        this.botOfflineAt = 0;
        log.info('协议端心跳报告账号已恢复在线');
      }
      this.emit('heartbeat', payload);
      return;
    }

    if (payload.self_id && !this.selfId) this.selfId = String(payload.self_id);

    // 账号掉线的另一条信号（NapCat：`notice/bot_offline`）。与心跳 status 同源，
    // 但有的后端只发这一条；两条都认，避免"面板一直绿、其实已经掉线"。
    if (payload.post_type === 'notice' && payload.notice_type === 'bot_offline') {
      this.botOffline = true;
      this.botOfflineAt = Date.now();
      this.lastDropReason = `账号已掉线${payload.message ? `：${payload.message}` : ''}`;
      this.emit('offline', { at: this.botOfflineAt, reason: this.lastDropReason });
    }

    if (payload.post_type === 'message') {
      this.emit('message', payload);
    } else {
      this.emit('notice', payload);
    }
  }

  #rejectAllPending(reason) {
    for (const [echo, { reject, timer }] of this.pending) {
      clearTimeout(timer);
      reject(new Error(reason));
      this.pending.delete(echo);
    }
  }

  /** 调用 OneBot v11 API */
  call(action, params = {}, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      if (!this.connected || !this.ws) {
        const err = new Error('协议端未连接');
        err.code = 'not_connected';
        reject(err);
        return;
      }
      const echo = `q${++this.seq}`;
      const timer = setTimeout(() => {
        this.pending.delete(echo);
        this.stats.timeouts += 1;
        const err = new Error(`API 超时: ${action}`);
        err.code = 'timeout';
        err.action = action;
        reject(err);
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(echo, { resolve, reject, timer, action });
      this.stats.calls += 1;
      this.ws.send(JSON.stringify({ action, params, echo }));
    });
  }

  /** 周期 `get_status`：不依赖后端推心跳，也不拿自报的 online/good 当健康判据。 */
  #startStatusProbe() {
    if (!this.statusProbeMs || this.statusTimer) return;
    this.statusTimer = setInterval(() => this.#probeStatus(), this.statusProbeMs);
    this.statusTimer.unref?.();
  }

  #probeStatus() {
    if (!this.connected) return;
    this.lastStatusAt = Date.now();
    this.call('get_status', {}, 5000)
      .then(() => { this.lastStatusOk = true; })
      .catch(() => { this.lastStatusOk = false; });
  }

  /**
   * 存活看门狗：每 tick 只看"最后入站帧"。
   * ⚠️ 只 `terminate()`，**绝不自己 `#connect()`** —— 重连仍只有 close 回调这一条实现。
   *   自己再连一份会绕过退避、并让旧 socket 的 close 与新连接互相踩。
   */
  #startWatchdog() {
    if (this.watchdogTimer || !(this.staleMs > 0)) return;
    const tick = Math.max(2000, Math.min(10000, Math.floor(this.staleMs / 3)));
    this.watchdogTimer = setInterval(() => this.#checkLiveness(), tick);
    this.watchdogTimer.unref?.();
  }

  #checkLiveness() {
    if (!this.connected || !this.ws) return;
    // 后端报过心跳间隔 ⇒ 以心跳为准（get_status 的回包也会刷新 lastFrameAt，
    // 只看帧会让"心跳停了但动作还答"永远不触发）；没报过心跳的后端才退回看任意帧。
    const beatKnown = this.heartbeatIntervalMs > 0 && this.lastHeartbeatAt > 0;
    const last = beatKnown
      ? this.lastHeartbeatAt
      : Math.max(this.lastFrameAt || 0, this.connectedAt || 0);
    if (!last) return;
    const idle = Date.now() - last;
    if (idle <= this.staleMs) return;
    this.watchdogKills += 1;
    this.lastDropReason = `事件流停摆 ${Math.round(idle / 1000)} 秒`;
    log.warn(`协议端 ${this.lastDropReason}（阈值 ${this.staleMs}ms）—— 主动断开，交给既有退避重连`);
    this.emit('stale', { lastFrameAt: last, idleMs: idle, staleMs: this.staleMs });
    try { this.ws.terminate(); } catch { /* 已断开 */ }
  }

  /**
   * 给面板的**只读**健康快照（B4）：机器人此刻看到的连接、心跳与超时。
   * ⚠️ 不含"健康/不健康"的结论 —— 判断留给面板与维护者；这里只摆时刻与计数。
   */
  healthSnapshot() {
    return {
      connected: this.connected,
      selfId: this.selfId || '',
      connectedAt: this.connectedAt,
      lastFrameAt: this.lastFrameAt,
      lastHeartbeatAt: this.lastHeartbeatAt,
      heartbeatIntervalMs: this.heartbeatIntervalMs,
      botOffline: this.botOffline,
      botOfflineAt: this.botOfflineAt,
      reconnects: this.reconnects,
      watchdogKills: this.watchdogKills,
      lastDropReason: this.lastDropReason,
      statusProbeIntervalMs: this.statusProbeMs,
      lastStatusAt: this.lastStatusAt,
      lastStatusOk: this.lastStatusOk,
      calls: this.stats.calls,
      timeouts: this.stats.timeouts,
      pending: this.pending.size,
    };
  }

  /**
   * 发送消息。message 传消息段数组而非字符串 —— 这样模型输出的文本里即使
   * 出现 "[CQ:at,qq=all]" 这类字面量也不会被协议端当成指令执行，从根上避免 CQ 注入。
   */
  sendGroupMsg(groupId, segments) {
    return this.call('send_group_msg', { group_id: toNum(groupId), message: segments });
  }

  sendPrivateMsg(userId, segments) {
    return this.call('send_private_msg', { user_id: toNum(userId), message: segments });
  }

  sendMsg(scene, id, segments) {
    return scene === 'group' ? this.sendGroupMsg(id, segments) : this.sendPrivateMsg(id, segments);
  }
}

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : v;
}

export function textSegment(text) {
  return { type: 'text', data: { text } };
}

export function atSegment(qq) {
  return { type: 'at', data: { qq: String(qq) } };
}

export function replySegment(messageId) {
  return { type: 'reply', data: { id: String(messageId) } };
}

/**
 * 图片段：`file` 既可以是 URL，也可以是协议端认识的资源标识。
 *
 * ⚠️ 这是**全项目唯一的图片段构造器** —— 发送循环、扩展工具、面板发图都从这里出。
 *    再在别处另写一个，就等于给同一件事开第二个口子。
 *    （`faceSegment` 已于 2026-10-17 随表情能力一起删除：出站不再构造 face 段。）
 */
export function imageSegment(file) {
  return { type: 'image', data: { file: String(file) } };
}
