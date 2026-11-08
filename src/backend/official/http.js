/**
 * 官方 OpenAPI 的**唯一 HTTP 出口**（2026-11-06）。
 *
 * 三条硬规矩，都是本仓反复踩出来的形状：
 *   ① 主机固定：`assertOfficialBase` 只放行 `api.bot.qq.com` 与环回（环回服务本地假网关测试）。
 *      AppSecret 会随取 token 的请求离开本机，这里松一寸，就等于把凭据外送做成一个功能。
 *   ② 每次调用都有超时（AbortController）：没有超时的 fetch 会把主链路挂成"点了没反应"。
 *   ③ 失败一律走 `classifyOfficialReply` 归一后**抛出带码的 Error**：
 *      调用方按 `err.code` 分支，不比对中文文案，也不许自己再看一眼 HTTP 状态码。
 *
 * ⚠️ 本模块**不 import config / logger**：它要能被面板、机器人和测试三处直接喂假 fetch 跑起来。
 */

import {
  OFFICIAL_BASE, REQUEST_TIMEOUT_MS, TOKEN_PATH, assertOfficialBase,
} from './constants.js';
import { OFFICIAL_CODE, classifyOfficialReply, officialError } from './errors.js';

/**
 * @param {{base?:string, fetchImpl?:Function, timeoutMs?:number, onWarn?:Function}} [options]
 */
export function createOfficialHttp({
  base = OFFICIAL_BASE,
  fetchImpl = globalThis.fetch,
  timeoutMs = REQUEST_TIMEOUT_MS,
  onWarn = null,
} = {}) {
  const origin = assertOfficialBase(base);
  if (typeof fetchImpl !== 'function') throw new Error('官方通道需要一个可用的 fetch');

  const stats = { requests: 0, failures: 0, lastError: '', lastErrorCode: '', lastAt: 0 };

  /**
   * @param {string} method
   * @param {string} path 以 / 开头的路径
   * @param {{body?:unknown, token?:string, timeoutMs?:number, expectEmpty?:boolean}} [opts]
   * @returns {Promise<unknown>} 成功时返回回包的 `data`（没有 data 就返回整个回包）
   */
  async function request(method, path, opts = {}) {
    const url = `${origin}${path}`;
    const headers = { Accept: 'application/json' };
    if (opts.token) headers.Authorization = `QQBot ${opts.token}`;
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    const limit = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : timeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), limit);
    if (typeof timer.unref === 'function') timer.unref();
    stats.requests += 1;
    stats.lastAt = Date.now();

    let response;
    let rawText = '';
    try {
      response = await fetchImpl(url, {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: controller.signal,
        redirect: 'manual',
      });
      rawText = await response.text();
    } catch (err) {
      clearTimeout(timer);
      const aborted = err?.name === 'AbortError';
      const code = aborted ? OFFICIAL_CODE.timeout : OFFICIAL_CODE.transport;
      const message = aborted ? `请求超过 ${limit}ms 未返回` : String(err?.message || err);
      return fail(code, message, null);
    }
    clearTimeout(timer);

    // 官方文档没给重定向语义，而"跟随 302 到另一台机器"正是凭据外送的通道 ——
    // 这里**不跟随**（fetch 已按 redirect:manual），3xx 一律当失败。
    if (response.status >= 300 && response.status < 400) {
      return fail(OFFICIAL_CODE.transport, `官方接口返回重定向（${response.status}），已按失败处理`, null);
    }

    let body = null;
    try { body = rawText ? JSON.parse(rawText) : null; } catch { body = null; }
    const reply = classifyOfficialReply({ httpStatus: response.status, body, rawText });
    if (!reply.businessOk) return fail(reply.code, reply.message || `HTTP ${response.status}`, reply);
    if (opts.expectEmpty && body && typeof body === 'object' && Object.keys(body).length === 0) return null;
    if (body && typeof body === 'object' && 'data' in body) return body.data ?? null;
    return body;
  }

  function fail(code, message, reply) {
    stats.failures += 1;
    stats.lastError = message;
    stats.lastErrorCode = code;
    if (onWarn) onWarn(`${code}: ${message}`);
    throw officialError(code, message, {
      officialCode: reply?.officialCode ?? null,
      retryable: reply?.retryable ?? false,
    });
  }

  /** 取 access_token：这条接口**没有** Authorization，凭据在 body 里。 */
  async function fetchAccessToken(appId, appSecret, { timeoutMs: ms } = {}) {
    const data = await request('POST', TOKEN_PATH, {
      body: { appId, clientSecret: appSecret },
      timeoutMs: ms,
    });
    const token = String(data?.access_token ?? '').trim();
    const expiresIn = Number(data?.expires_in);
    if (!token) throw officialError(OFFICIAL_CODE.auth, '取 token 成功但回包里没有 access_token');
    return { token, expiresIn: Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 0 };
  }

  return { origin, request, fetchAccessToken, stats };
}
