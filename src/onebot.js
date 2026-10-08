import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import scoped from './logger.js';
import { probeForwardSegment } from './forward-probe.js';

const log = scoped('onebot');

/**
 * 触发判定该看的正文。
 *
 * D28（QQ-Agent 信号③ · 报告"@ 走 qq 集合，text 只作参考"）：
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

export class OneBotClient extends EventEmitter {
  /** @param {{wsUrl:string, accessToken:string, reconnectBackoffMs:number[]}} opts */
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
    // 待触发的重连定时器句柄。每次真的排了新的就把上一个清掉 ——
    // 否则连接失败时 error+close 反复触发，会排出多个各自独立的 setTimeout，
    // 它们全都到点各连一次；后连上的覆盖 this.ws，先到的成了孤儿，
    // 而孤儿的 close 又会再排一个 —— 级联放大。
    this.reconnectTimer = null;
  }

  start() {
    this.closedByUs = false;
    this.#connect();
    return this;
  }

  stop() {
    this.closedByUs = true;
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
      log.info('协议端已连接');
      this.emit('ready');
    });

    ws.on('message', (buf) => this.#onRaw(buf));

    ws.on('error', (err) => {
      log.warn(`WebSocket 错误: ${err.message}`);
    });

    ws.on('close', (code) => {
      this.connected = false;
      this.selfId = null;
      this.#rejectAllPending('连接已断开');
      if (this.closedByUs) return;
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
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

    if (payload.echo !== undefined && this.pending.has(payload.echo)) {
      const { resolve, reject, timer } = this.pending.get(payload.echo);
      clearTimeout(timer);
      this.pending.delete(payload.echo);
      if (payload.status === 'ok' || payload.retcode === 0) resolve(payload.data ?? payload);
      else reject(new Error(`API 返回失败: retcode=${payload.retcode} ${payload.message ?? ''}`));
      return;
    }

    if (payload.post_type === 'meta_event' && payload.meta_event_type === 'lifecycle') {
      this.selfId = String(payload.self_id);
      log.info(`登录账号 self_id=${this.selfId}`);
      return;
    }

    if (payload.self_id && !this.selfId) this.selfId = String(payload.self_id);

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
        reject(new Error('协议端未连接'));
        return;
      }
      const echo = `q${++this.seq}`;
      const timer = setTimeout(() => {
        this.pending.delete(echo);
        reject(new Error(`API 超时: ${action}`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(echo, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ action, params, echo }));
    });
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

/** QQ 内置表情段。id 是 QQ 的 face id（如 14 = 微笑、124 = 狗头） */
export function faceSegment(id) {
  return { type: 'face', data: { id: String(id) } };
}

/**
 * 图片段（D14）：`file` 既可以是 URL，也可以是协议端认识的资源标识。
 *
 * 为什么和 `faceSegment` 并列放在这里：**「文本里的标记 → OneBot 段」只有这一处**。
 * 收藏表情（QQ 收藏夹里的表情）**没有 face id 可寻址** —— 协议端给的是图片 URL，
 * 所以它只能走图片段；再在别处另写一个"发图"的构造器，就等于给同一件事开第二个口子。
 */
export function imageSegment(file) {
  return { type: 'image', data: { file: String(file) } };
}
