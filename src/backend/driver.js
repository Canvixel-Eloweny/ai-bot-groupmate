/**
 * L3 聚合适配层 · 驱动（薄壳，不含判据）。
 * ══════════════════════════════════════════════════════════════════════════
 *  driver 只做三件事：认后端、转发 call、按后端表试合并转发参数。
 *  判据本身住 `registry.js` / `normalize.js` —— 这里再判一次就会长出第二份真相。
 *
 *  ⚠️ 刻意**不 import OneBotClient**：driver 只要求一个"有 call() 的对象"，
 *  这样测试能用假 client 精确记录调用顺序，面板侧将来也能用 HTTP 实现同一个接口。
 */

import {
  normalizeBackend, resolveBackend, backendLabel,
} from './registry.js';
import {
  forwardAttemptsFor, capabilitiesOf, selfReportTrustOf,
} from './normalize.js';

/**
 * @param {{call:(action:string,params?:object,timeoutMs?:number)=>Promise<any>,
 *          healthSnapshot?:()=>object|null}} client
 * @param {{backend?:string}} [opts] `auto` = 连上后问一次 `get_version_info`
 */
export function createOneBotDriver({ client, backend = 'auto' } = {}) {
  if (!client || typeof client.call !== 'function') {
    throw new Error('createOneBotDriver 需要一个有 call() 的 client');
  }
  const configured = normalizeBackend(backend);
  let resolved = configured === 'auto' ? 'generic' : configured;
  let detection = null;

  /**
   * 识别后端。只有 `auto` 会发请求；显式配置直接返回，**不问协议端**——
   * 用户已经说了接哪家，就不该被一条自报字符串改掉参数顺序。
   */
  async function detectBackend() {
    if (configured !== 'auto') {
      resolved = configured;
      detection = { ok: true, backend: resolved, configured };
      return resolved;
    }
    try {
      const selfReport = await client.call('get_version_info', {}, 5000);
      resolved = resolveBackend({ configured: 'auto', selfReport });
      detection = { ok: true, backend: resolved, selfReport };
    } catch (err) {
      resolved = 'generic';
      detection = { ok: false, backend: resolved, error: err.message, code: err.code || '' };
    }
    return resolved;
  }

  /**
   * 合并转发：按后端表的顺序逐条试，第一条成功就返回（调用方再判 nodes 是否为空）。
   * 这里**不吞掉最后一次错误**：全部失败时把 code 与尝试顺序一起抛给调用方留痕。
   */
  async function getForwardMsg({ messageId, resId } = {}, { timeoutMs = 5000 } = {}) {
    const attempts = forwardAttemptsFor(resolved, { messageId, resId });
    const vias = attempts.map((x) => x.via);
    if (!attempts.length) {
      const e = new Error('合并转发：没有可用的参数尝试（message_id 与 resId 都为空）');
      e.code = 'forward_no_attempt';
      e.attempts = [];
      throw e;
    }
    let last = null;
    for (const at of attempts) {
      try {
        const data = await client.call('get_forward_msg', at.params, timeoutMs);
        return { data, via: at.via, params: at.params, attempts: vias };
      } catch (err) {
        last = err;
      }
    }
    const e = new Error(last?.message || '合并转发：全部参数尝试都失败');
    e.code = last?.code || 'forward_all_attempts_failed';
    e.attempts = vias;
    throw e;
  }

  return {
    get backend() { return resolved; },
    get label() { return backendLabel(resolved); },
    get configured() { return configured; },
    get detection() { return detection; },
    get client() { return client; },
    detectBackend,
    call(action, params = {}, timeoutMs) {
      return client.call(action, params, timeoutMs);
    },
    getForwardMsg,
    forwardAttempts(ids = {}) {
      return forwardAttemptsFor(resolved, ids);
    },
    capabilities() {
      return capabilitiesOf(resolved);
    },
    selfReportTrust() {
      return selfReportTrustOf(resolved);
    },
    health() {
      return typeof client.healthSnapshot === 'function' ? client.healthSnapshot() : null;
    },
  };
}
