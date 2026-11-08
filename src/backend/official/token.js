/**
 * access_token 生命周期（2026-11-06）。
 *
 * 官方口径：`expires_in` 约 7200 秒，**有效期内重复获取会返回同一个值**，
 * 临近过期 60 秒内再取才会拿到新的。所以这里做三件事：
 *   ① 提前 `TOKEN_REFRESH_SKEW_MS`（120 秒）换 —— 卡在边界上发不出去最难查；
 *   ② **单飞**：并发请求共用一次取 token。各取各的表现不是报错，而是"莫名其妙多打了几次鉴权"，
 *      而鉴权接口是有频控的；
 *   ③ 鉴权失败时由调用方 `invalidate()`，下一条消息重新取 —— 而不是在这里无限重试。
 *
 * ⚠️ 快照**不含 token 本体**：`/api/state` 是不鉴权的只读口，token 一旦进快照就等于外流。
 */

import { TOKEN_FALLBACK_TTL_MS, TOKEN_REFRESH_SKEW_MS } from './constants.js';
import { OFFICIAL_CODE, officialError } from './errors.js';

export function createTokenManager({ appId, appSecret, http, now = () => Date.now() }) {
  const id = String(appId ?? '').trim();
  const secret = String(appSecret ?? '').trim();
  const configured = Boolean(id && secret);

  let token = '';
  let expiresAt = 0;
  let pending = null;
  const stats = { fetches: 0, failures: 0, lastError: '', lastErrorCode: '', lastFetchAt: 0 };

  function needsRefresh() {
    return !token || now() >= expiresAt - TOKEN_REFRESH_SKEW_MS;
  }

  async function refresh() {
    stats.fetches += 1;
    stats.lastFetchAt = now();
    const got = await http.fetchAccessToken(id, secret);
    token = got.token;
    // 回包没给 expires_in 时按 1 小时算 —— 宁可早一点换，也不要卡到 401 才发现。
    expiresAt = now() + (got.expiresIn > 0 ? got.expiresIn * 1000 : TOKEN_FALLBACK_TTL_MS);
    return token;
  }

  async function get() {
    if (!configured) {
      throw officialError(OFFICIAL_CODE.unconfigured, '官方通道还没有配置 AppID / AppSecret');
    }
    if (!needsRefresh()) return token;
    // 单飞：第二个调用者等同一个 promise，而不是自己再取一次。
    if (!pending) {
      pending = refresh()
        .then((t) => { pending = null; return t; })
        .catch((err) => {
          pending = null;
          stats.failures += 1;
          stats.lastError = String(err?.message || err);
          stats.lastErrorCode = String(err?.code || '');
          // 取不到 token 就把旧值作废：留着"半个 token"会让下一条消息带着必死的凭据出去。
          token = '';
          expiresAt = 0;
          throw err;
        });
    }
    return pending;
  }

  /** 鉴权失败后作废，下一次调用重新取。 */
  function invalidate() {
    token = '';
    expiresAt = 0;
  }

  function snapshot() {
    return {
      configured,
      expiresAt: token ? expiresAt : 0,
      msLeft: token ? Math.max(0, expiresAt - now()) : 0,
      fetches: stats.fetches,
      failures: stats.failures,
      lastError: stats.lastError,
      lastErrorCode: stats.lastErrorCode,
      lastFetchAt: stats.lastFetchAt,
    };
  }

  return { get, invalidate, snapshot, needsRefresh };
}
