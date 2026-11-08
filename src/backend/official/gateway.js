/**
 * 官方事件网关（WebSocket）客户端（2026-11-06）。
 *
 * 与 `src/onebot.js` 的关系：**同形但不同家**。两条通道同一时间只跑一条，
 * 所以"重连入口唯一"这条契约（check-wb §24）在各自文件里各自成立 ——
 * 这里也遵守同一个纪律：
 *   · 只有 `#connect()` 一处创建 socket；
 *   · 看门狗**只 terminate**，不自己调 `#connect()`（重连只从 close 那一条路走）；
 *   · 自己 `stop()` 关的，绝不自动连回来。
 *
 * 官方网关比 OneBot 多了三件事，每一件都会变成"看着在线、其实哑了"：
 *   ① **鉴权在连接内完成**：先收 op 10 Hello 拿 `heartbeat_interval`，再发 op 2 identify；
 *      token 过期不是"发不出去"，而是网关直接关你 —— 所以要能识别并重新鉴权。
 *   ② **心跳要带 seq**：op 1 的 `d` 是最近一次事件序号，不带的话平台认为你还活着但没在听。
 *   ③ **可以续传**：短断线用 op 6 resume 带 `session_id + seq`，平台会补发中间漏掉的事件；
 *      补回来的事件必须走同一套去重，否则用户会看到"重启一次它把昨天的话又回一遍"。
 */

import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import {
  INTENT_GROUP_AND_C2C, OP, RECONNECT_BACKOFF_MS, TERMINAL_WS_CODES,
} from './constants.js';

/** 帧停摆阈值：官方心跳 45 秒一次，两拍半没东西就是这条流死了。 */
const DEFAULT_STALE_MS = 120_000;

export class OfficialGateway extends EventEmitter {
  /**
   * @param {{getToken:()=>Promise<string>, wsUrl?:string, intents?:number,
   *          shard?:[number,number], backoffMs?:number[], staleMs?:number,
   *          WebSocketImpl?:typeof WebSocket, now?:()=>number}} options
   */
  constructor(options = {}) {
    super();
    this.getToken = options.getToken;
    this.wsUrl = options.wsUrl;
    this.intents = Number.isFinite(options.intents) ? options.intents : INTENT_GROUP_AND_C2C;
    this.shard = Array.isArray(options.shard) ? options.shard : [0, 1];
    this.WebSocketImpl = options.WebSocketImpl || WebSocket;
    this.backoff = Array.isArray(options.backoffMs) && options.backoffMs.length
      ? options.backoffMs : RECONNECT_BACKOFF_MS;
    this.staleMs = Number.isFinite(options.staleMs) && options.staleMs > 0
      ? options.staleMs : DEFAULT_STALE_MS;

    this.ws = null;
    this.connected = false;
    this.closedByUs = false;
    this.started = false;
    this.attempt = 0;
    this.seq = 0;
    this.sessionId = '';
    this.heartbeatIntervalMs = 0;
    this.heartbeatTimer = null;
    this.reconnectTimer = null;
    this.watchdogTimer = null;
    this.lastFrameAt = 0;
    this.lastAckAt = 0;
    this.connectedAt = 0;
    this.readyAt = 0;
    this.resumes = 0;
    this.reconnects = 0;
    this.watchdogKills = 0;
    this.identifySent = 0;
    this.badFrames = 0;
    this.lastDropReason = '';
    this.terminalCode = 0;
    this.terminalReason = '';
    this.lastError = '';
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.closedByUs = false;
    this.terminalCode = 0;
    this.terminalReason = '';
    this.#connect();
  }

  stop() {
    this.closedByUs = true;
    this.started = false;
    this.#clearTimers();
    const ws = this.ws;
    this.ws = null;
    this.connected = false;
    if (!ws) return;
    try { ws.close(); } catch { /* 已经断了 */ }
  }

  /** 让外部（token 刷新失败、手动重连按钮）主动断开重连；仍然只从 close 那一条路连回去。 */
  requestReconnect(reason = '') {
    this.lastDropReason = reason || '主动要求重连';
    const ws = this.ws;
    if (!ws) return;
    try { ws.terminate(); } catch { /* 已断开 */ }
  }

  #clearTimers() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    this.watchdogTimer = null;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  #connect() {
    if (this.closedByUs || !this.started) return;
    let token = '';
    // 取 token 失败**不能**让 start() 抛：那会把整个机器人进程带崩。
    // 这里的形状是"记一次原因 + 按退避再试"，面板看到的是 connecting/auth-failed 而不是没进程。
    Promise.resolve()
      .then(() => this.getToken())
      .then((t) => {
        token = String(t ?? '');
        if (!token) throw new Error('没有拿到 access_token');
        if (this.closedByUs || !this.started) return;
        this.#openSocket(token);
      })
      .catch((err) => {
        this.lastError = String(err?.message || err);
        this.emit('auth-error', { message: this.lastError, code: err?.code || '' });
        this.#scheduleReconnect(`取凭据失败：${this.lastError}`);
      });
  }

  #openSocket(token) {
    const ws = new this.WebSocketImpl(this.wsUrl);
    this.ws = ws;
    // 每次连接都换掉上一任的定时器，否则旧连接的 close 会用新连接的句柄排重连。
    this.#clearTimers();

    ws.on('open', () => {
      if (this.ws !== ws) return;
      this.connected = true;
      this.connectedAt = Date.now();
      this.attempt = 0;
      this.lastFrameAt = Date.now();
      this.emit('open', { connectedAt: this.connectedAt });
      // identify 的 token 走 `QQBot <token>`，与 REST 同一个格式。
      this.#send({
        op: OP.IDENTIFY,
        d: { token: `QQBot ${token}`, intents: this.intents, shard: this.shard, properties: {} },
      });
      this.identifySent += 1;
    });

    ws.on('message', (raw) => {
      if (this.ws !== ws) return;
      this.lastFrameAt = Date.now();
      let payload;
      try { payload = JSON.parse(raw.toString('utf8')); } catch { this.badFrames += 1; return; }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) { this.badFrames += 1; return; }
      this.#handleFrame(payload, ws);
    });

    ws.on('close', (code, reason) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.connected = false;
      this.#clearTimers();
      if (this.closedByUs || !this.started) return;
      const why = `${code} ${String(reason || '').trim()}`.trim();
      if (TERMINAL_WS_CODES.includes(Number(code))) {
        // 下架 / 封禁：重试没有意义，而且白烧一次鉴权。停手，把原因交出去。
        this.terminalCode = Number(code);
        this.terminalReason = why;
        this.emit('terminal', { code: this.terminalCode, reason: why });
        return;
      }
      this.lastDropReason = `连接被关闭（${why}）`;
      this.emit('close', { code, reason: why });
      this.#scheduleReconnect(this.lastDropReason);
    });

    ws.on('error', (err) => {
      this.lastError = String(err?.message || err);
      // error 之后一定跟着 close，重连交给 close —— 两处都排定时器就是"两条连接循环"。
      this.emit('error', { message: this.lastError });
    });
  }

  #handleFrame(payload, ws) {
    const op = Number(payload.op);
    const d = payload.d;

    if (op === OP.HELLO) {
      const interval = Number(d?.heartbeat_interval);
      this.heartbeatIntervalMs = Number.isFinite(interval) && interval > 0 ? interval : 41_000;
      this.#startHeartbeat();
      this.#startWatchdog();
      // 先续传再鉴权：有 session_id 就尽量让平台补发漏掉的事件。
      // token 必须**现取**：resume 可能发生在一次长断线之后，用 open 时那份旧 token
      // 的表现是"连上就被踢下来"，而日志里只看到反复 close，看不出是凭据过期。
      if (this.sessionId) {
        this.#resumeWithFreshToken();
      }
      return;
    }

    if (op === OP.DISPATCH) {
      const s = Number(payload.s);
      if (Number.isFinite(s)) this.seq = s;
      const t = String(payload.t ?? '');
      if (t === 'READY') {
        this.sessionId = String(d?.session_id ?? '');
        this.readyAt = Date.now();
        this.#startHeartbeat();
        this.#startWatchdog();
        this.emit('ready', { sessionId: this.sessionId, user: d?.user ?? null, shard: d?.shard ?? null });
        return;
      }
      if (t === 'RESUMED') {
        this.emit('resumed', { sessionId: this.sessionId });
        return;
      }
      if (t) this.emit('event', { t, d });
      return;
    }

    if (op === OP.ACK) {
      this.lastAckAt = Date.now();
      this.emit('heartbeat', { ackAt: this.lastAckAt });
      return;
    }

    if (op === OP.RECONNECT) {
      this.lastDropReason = '网关要求重连（op 7）';
      this.emit('reconnect-requested', {});
      try { ws.terminate(); } catch { /* 已断开 */ }
      return;
    }

    if (op === OP.INVALID_SESSION) {
      const resumable = d === true;
      this.emit('invalid-session', { resumable });
      if (!resumable) {
        // 会话作废：seq/session 都不再可信，带着它们续传只会再被拒一次。
        this.sessionId = '';
        this.seq = 0;
      }
      try { ws.terminate(); } catch { /* 已断开 */ }
      return;
    }

    if (op === OP.HEARTBEAT) {
      this.#send({ op: OP.ACK, d: null });
    }
  }

  #startHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    const interval = this.heartbeatIntervalMs || 41_000;
    this.lastAckAt = Date.now();
    this.heartbeatTimer = setInterval(() => {
      if (!this.connected) return;
      // 两拍半没 ACK = 这条连接只是"没报错"，不是"还活着"。
      if (Date.now() - this.lastAckAt > interval * 2.5) {
        this.watchdogKills += 1;
        this.lastDropReason = `心跳连续 ${Math.round((Date.now() - this.lastAckAt) / 1000)} 秒没有 ACK`;
        this.emit('stale', { reason: this.lastDropReason });
        try { this.ws?.terminate(); } catch { /* 已断开 */ }
        return;
      }
      this.#send({ op: OP.HEARTBEAT, d: this.seq || null });
    }, interval);
    if (typeof this.heartbeatTimer.unref === 'function') this.heartbeatTimer.unref();
  }

  #startWatchdog() {
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    this.watchdogTimer = setInterval(() => {
      if (!this.connected) return;
      const idle = Date.now() - Math.max(this.lastFrameAt, this.connectedAt);
      if (idle <= this.staleMs) return;
      this.watchdogKills += 1;
      this.lastDropReason = `事件流停摆 ${Math.round(idle / 1000)} 秒`;
      this.emit('stale', { idleMs: idle, staleMs: this.staleMs });
      // 只 terminate：重连仍然只有 close 一条路（与 §24 同一条纪律）。
      try { this.ws?.terminate(); } catch { /* 已断开 */ }
    }, Math.max(10_000, Math.floor(this.staleMs / 3)));
    if (typeof this.watchdogTimer.unref === 'function') this.watchdogTimer.unref();
  }

  #scheduleReconnect(reason) {
    if (this.reconnectTimer) return;
    const delay = this.backoff[Math.min(this.attempt, this.backoff.length - 1)];
    this.attempt += 1;
    this.lastDropReason = reason || this.lastDropReason;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnects += 1;
      this.#connect();
    }, delay);
    if (typeof this.reconnectTimer.unref === 'function') this.reconnectTimer.unref();
    this.emit('scheduled', { delayMs: delay, attempt: this.attempt, reason: this.lastDropReason });
  }

  #send(obj) {
    if (!this.ws || this.ws.readyState !== 1) return false;
    try { this.ws.send(JSON.stringify(obj)); return true; } catch { return false; }
  }

  async #resumeWithFreshToken() {
    let token = '';
    try { token = String(await this.getToken() ?? ''); } catch (err) {
      this.lastError = String(err?.message || err);
      this.emit('auth-error', { message: this.lastError, code: err?.code || '' });
      return;
    }
    if (!token || !this.connected) return;
    this.#send({ op: OP.RESUME, d: { token: `QQBot ${token}`, session_id: this.sessionId, seq: this.seq } });
    this.resumes += 1;
  }

  snapshot() {
    return {
      connected: this.connected,
      connectedAt: this.connectedAt,
      readyAt: this.readyAt,
      lastFrameAt: this.lastFrameAt,
      lastAckAt: this.lastAckAt,
      heartbeatIntervalMs: this.heartbeatIntervalMs,
      sessionId: this.sessionId,
      seq: this.seq,
      attempt: this.attempt,
      reconnects: this.reconnects,
      resumes: this.resumes,
      identifySent: this.identifySent,
      watchdogKills: this.watchdogKills,
      badFrames: this.badFrames,
      lastDropReason: this.lastDropReason,
      lastError: this.lastError,
      terminalCode: this.terminalCode,
      terminalReason: this.terminalReason,
      staleMs: this.staleMs,
    };
  }
}
