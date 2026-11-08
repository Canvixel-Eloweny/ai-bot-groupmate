/**
 * 更新清单/安装包的网络与会话层（P3 · 2026-10-18）。
 *
 * 为什么不是直接复用 `packaging/windows/tools/lib/common.mjs` 的
 * `downloadWithMirrors`：
 *   · 那个文件在包的 `tools/` 里，**不在 app payload 里**，面板 import 不到；
 *   · 它没有进度回调、取消、总超时/空闲超时与 64 KiB 清单上限。
 * 这里保留它的核心语义（.part 续传、镜像回退、整份重算哈希），并补上面板需要的
 * 可取消与进度。两份实现不互相 import，避免把打包层拖进运行时依赖。
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { stripBom } from '../../src/plugin-manifest.js';

export const IDLE_TIMEOUT_MS = 30_000;
/** 连续 15 秒低于 15 KB/s 就换源；残留 .part 由下一轮续传。 */
export const LOW_SPEED_MS = 15_000;
export const LOW_SPEED_BYTES_SEC = 15_000;

export function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function abortError(reason, fallback) {
  const err = new Error(fallback);
  err.code = 'ABORTED';
  err.cause = reason;
  return err;
}

/** 错误信息里只留 origin + path：签名 URL 的查询参数不能进日志。 */
function displayUrl(raw) {
  try {
    const u = new URL(String(raw));
    return `${u.origin}${u.pathname}`;
  } catch {
    return String(raw);
  }
}

function errorText(e) {
  const msg = e && e.message ? e.message : String(e);
  const cause = e && e.cause ? (e.cause.code || e.cause.message) : '';
  return cause && !String(msg).includes(String(cause)) ? `${msg} (${cause})` : msg;
}

/**
 * 手动跟重定向：**每一跳先过 validateUrl，再发请求**（2026-11-05 · 外部评估 P2）。
 *
 * `redirect:'follow'` 只会把最终 URL 交回来 —— 中间那几跳已经发出去了，
 * 白名单只能事后拒绝，攻击者要的"请求到达禁止目标"已经发生。这里把
 * `Location` 解析、白名单、协议检查全放在下一次 `fetch` 之前。
 *
 * @returns {{res:Response, finalUrl:string}}
 */
export async function fetchCheckedRedirects(rawUrl, {
  fetchImpl = fetch,
  signal,
  headers = null,
  validateUrl,
  maxRedirects = 5,
} = {}) {
  let current = String(rawUrl);
  let currentHeaders = headers && typeof headers === 'object' ? { ...headers } : {};
  const seen = new Set();
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    if (seen.has(current)) throw new Error(`重定向循环：${displayUrl(current)}`);
    seen.add(current);
    if (validateUrl) {
      const v = validateUrl(current);
      if (!v.ok) throw new Error(v.reason || `URL 不在白名单：${displayUrl(current)}`);
    }
    const res = await fetchImpl(current, { signal, headers: currentHeaders, redirect: 'manual' });
    const status = Number(res.status) || 0;
    if (status >= 300 && status < 400) {
      const loc = res.headers && typeof res.headers.get === 'function' ? res.headers.get('location') : '';
      // 旧响应体必须关掉，否则连接会被一直占着。
      try { await res.body?.cancel?.(); } catch { /* ignore */ }
      if (!loc) throw new Error(`重定向缺少 Location（HTTP ${status}）`);
      let next;
      try { next = new URL(String(loc), current); } catch { throw new Error('重定向 Location 解析失败'); }
      if (next.protocol !== 'https:' && next.protocol !== 'http:') {
        throw new Error(`重定向到不允许的协议：${next.protocol}`);
      }
      if (next.host !== new URL(current).host) {
        // 跨主机不传播敏感头；Range 不是凭据，保留以支持断点续传。
        delete currentHeaders.authorization;
        delete currentHeaders.cookie;
      }
      current = next.href;
      continue;
    }
    return { res, finalUrl: current };
  }
  throw new Error(`重定向超过 ${maxRedirects} 跳`);
}

/**
 * 取一个小文件（清单/签名）并施加硬上限。
 * 跟随重定向，但最终 URL 必须通过调用方的 validateUrl。
 */
export async function fetchCapped(url, {
  maxBytes,
  timeoutMs = 10_000,
  signal,
  validateUrl,
  userAgent = 'estrella-bot-updater',
  fetchImpl = fetch,
} = {}) {
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) throw new Error('fetchCapped 需要正整数 maxBytes');
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(new Error('timeout')), timeoutMs);
  const onAbort = () => ctl.abort(signal.reason);
  if (signal) {
    if (signal.aborted) ctl.abort(signal.reason);
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    const { res, finalUrl } = await fetchCheckedRedirects(url, {
      fetchImpl,
      signal: ctl.signal,
      headers: { 'user-agent': userAgent },
      validateUrl,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const len = Number(res.headers.get('content-length') || 0);
    if (len > maxBytes) throw new Error(`响应超过上限 ${maxBytes} 字节`);
    const chunks = [];
    let total = 0;
    for await (const chunk of res.body) {
      total += chunk.length;
      if (total > maxBytes) {
        ctl.abort();
        throw new Error(`响应超过上限 ${maxBytes} 字节`);
      }
      chunks.push(chunk);
    }
    return { buffer: Buffer.concat(chunks), url: finalUrl, bytes: total };
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

/**
 * 下载安装包到 dest，支持 `.part` 断点续传与镜像回退。
 *
 * @param {object} opt
 * @param {string[]} opt.urls 候选 URL（第一个为主，其后为镜像）
 * @param {string} opt.dest 最终文件路径
 * @param {string} [opt.expectedSha256] 64 位小写十六进制
 * @param {number} [opt.expectedSize] 字节数
 * @param {AbortSignal} [opt.signal]
 * @param {(p:{received:number,total:number,percent:number|null,bytesPerSec:number})=>void} [opt.onProgress]
 * @param {(url:string)=>{ok:boolean,reason?:string}} [opt.validateUrl]
 * @returns {Promise<{url:string,bytes:number,sha256:string}>}
 */
export function diskBudgetOk({ freeBytes, size, reserveBytes = 64 * 1024 * 1024 } = {}) {
  if (!Number.isFinite(freeBytes) || freeBytes <= 0) return false;
  if (!Number.isFinite(size) || size <= 0) return false;
  return freeBytes >= size * 2 + reserveBytes;
}

export async function downloadWithProgress({
  urls,
  dest,
  expectedSha256 = '',
  expectedSize = 0,
  expectedVersion = '',
  signal,
  onProgress,
  validateUrl,
  fetchImpl = fetch,
}) {
  if (!Array.isArray(urls) || urls.length === 0) throw new Error('没有可用的下载地址');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const part = `${dest}.part`;
  const partMeta = `${part}.json`;
  const metaOf = () => ({
    version: String(expectedVersion || ''),
    size: Number(expectedSize) || 0,
    sha256: String(expectedSha256 || ''),
    at: new Date().toISOString(),
  });

  // 半包的“归属”必须一起校验：同版本重打后，旧 .part 会被当成新包的前缀续上，
  // 直到最后 sha 不符才整份重下（一次 200 MB 的白下载）。
  if (fs.existsSync(part)) {
    let saved = null;
    try { saved = JSON.parse(stripBom(fs.readFileSync(partMeta, 'utf8'))); } catch { saved = null; }
    const want = metaOf();
    const same = saved
      && Number(saved.size) === want.size
      && String(saved.sha256 || '') === want.sha256
      && (!want.version || String(saved.version || '') === want.version);
    if (!same) {
      try { fs.rmSync(part, { force: true }); } catch { /* ignore */ }
      try { fs.rmSync(partMeta, { force: true }); } catch { /* ignore */ }
    }
  } else {
    try { fs.rmSync(partMeta, { force: true }); } catch { /* ignore */ }
  }
  try { fs.writeFileSync(partMeta, `${JSON.stringify(metaOf())}\n`); } catch { /* 写不进去只影响续传，不阻断下载 */ }

  const errors = [];
  const dropPart = () => {
    try { fs.rmSync(part, { force: true }); } catch { /* ignore */ }
    try { fs.rmSync(partMeta, { force: true }); } catch { /* ignore */ }
  };

  /* 两轮：第一轮按顺序试完所有源；全部失败后隔 1 秒再试一轮，
     .part 保留，第二轮用 Range 续传（同源重试）。 */
  for (let pass = 0; pass < 2; pass += 1) {
  for (const url of urls) {
    for (let round = 0; round < 2; round += 1) {
      if (round === 1) {
        dropPart();
      }
      let startAt = round === 0 && fs.existsSync(part) ? fs.statSync(part).size : 0;
      if (expectedSize && startAt > expectedSize) {
        dropPart();
        startAt = 0;
      }

      const ctl = new AbortController();
      const onAbort = () => ctl.abort(signal.reason);
      if (signal) {
        if (signal.aborted) throw abortError(signal.reason, '下载已取消');
        signal.addEventListener('abort', onAbort, { once: true });
      }
      let idle = setTimeout(() => ctl.abort(new Error('空闲超时')), IDLE_TIMEOUT_MS);
      try {
        const headers = { 'user-agent': 'estrella-bot-updater' };
        if (startAt > 0) headers.Range = `bytes=${startAt}-`;
        const { res, finalUrl } = await fetchCheckedRedirects(url, {
          fetchImpl,
          signal: ctl.signal,
          headers,
          validateUrl,
        });
        if (!res.ok) {
          errors.push(`${displayUrl(url)} → HTTP ${res.status}`);
          break;
        }

        let start = 0;
        if (startAt > 0 && res.status === 206) {
          const cr = res.headers.get('content-range') || '';
          const m = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(cr);
          if (!m || Number(m[1]) !== startAt) {
            dropPart();
            errors.push(`${displayUrl(url)} → Content-Range 与续传位置不符`);
            break;
          }
          start = startAt;
        } else if (startAt > 0) {
          // 服务端忽略了 Range：从头写，别把两段拼成坏文件。
          dropPart();
        }

        const totalHeader = Number(res.headers.get('content-length') || 0);
        const total = start + totalHeader;
        if (expectedSize && totalHeader > 0 && total !== expectedSize) {
          errors.push(`${displayUrl(url)} → 大小不符（${total} ≠ ${expectedSize}）`);
          break;
        }

        const out = fs.createWriteStream(part, start > 0 ? { flags: 'a' } : { flags: 'w' });
        let got = start;
        let speedAt = Date.now();
        let speedGot = start;
        const t0 = Date.now();
        try {
          for await (const chunk of res.body) {
            clearTimeout(idle);
            idle = setTimeout(() => ctl.abort(new Error('空闲超时')), IDLE_TIMEOUT_MS);
            if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
            got += chunk.length;
            const nowTs = Date.now();
            if (nowTs - speedAt >= LOW_SPEED_MS) {
              const bps = (got - speedGot) / ((nowTs - speedAt) / 1000);
              if (bps < LOW_SPEED_BYTES_SEC) {
                ctl.abort(new Error('速度过低'));
                throw new Error(`速度过低（${Math.max(0, Math.round(bps / 1024))} KB/s）`);
              }
              speedAt = nowTs;
              speedGot = got;
            }
            if (expectedSize && got > expectedSize) {
              ctl.abort(new Error('超过预期大小'));
              break;
            }
            if (onProgress) {
              const elapsed = Math.max((Date.now() - t0) / 1000, 0.001);
              onProgress({
                received: got,
                total: total || expectedSize || 0,
                percent: (total || expectedSize) ? Math.min(100, Math.round((got / (total || expectedSize)) * 100)) : null,
                bytesPerSec: Math.round((got - start) / elapsed),
              });
            }
          }
          await new Promise((resolve, reject) => out.end((e) => (e ? reject(e) : resolve())));
        } catch (e) {
          try { out.destroy(); } catch { /* ignore */ }
          throw e;
        }

        if (signal?.aborted) throw abortError(signal.reason, '下载已取消');
        if (expectedSize && got !== expectedSize) {
          errors.push(`${displayUrl(url)} → 不完整（${got}/${expectedSize}）`);
          break;
        }
        const sha256 = await sha256File(part);
        if (expectedSha256 && sha256 !== expectedSha256.toLowerCase()) {
          if (round === 0) continue; // 残段可能被改过/来自别的版本：丢掉重下一次
          errors.push(`${displayUrl(url)} → SHA-256 校验不过`);
          break;
        }
        fs.renameSync(part, dest);
        try { fs.rmSync(partMeta, { force: true }); } catch { /* ignore */ }
        return { url: finalUrl, bytes: got, sha256 };
      } catch (e) {
        if (signal?.aborted || e?.code === 'ABORTED') {
          dropPart();
          throw abortError(signal?.reason, '下载已取消');
        }
        errors.push(`${displayUrl(url)} → ${errorText(e)}`);
        break; // 网络层错误：换下一个源；全部失败后还有第二轮续传
      } finally {
        clearTimeout(idle);
        if (signal) signal.removeEventListener('abort', onAbort);
      }
    }
  }
    if (pass === 0) await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`所有下载源都失败了：\n  - ${errors.join('\n  - ')}`);
}
