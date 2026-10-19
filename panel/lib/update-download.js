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

export const IDLE_TIMEOUT_MS = 30_000;

function sha256File(file) {
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
    const res = await fetch(url, {
      signal: ctl.signal,
      redirect: 'follow',
      headers: { 'user-agent': userAgent },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (validateUrl) {
      const v = validateUrl(res.url || url);
      if (!v.ok) throw new Error(v.reason);
    }
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
    return { buffer: Buffer.concat(chunks), url: res.url || url, bytes: total };
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
export async function downloadWithProgress({
  urls,
  dest,
  expectedSha256 = '',
  expectedSize = 0,
  signal,
  onProgress,
  validateUrl,
}) {
  if (!Array.isArray(urls) || urls.length === 0) throw new Error('没有可用的下载地址');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const part = `${dest}.part`;
  const errors = [];

  for (const url of urls) {
    for (let round = 0; round < 2; round += 1) {
      if (round === 1) {
        try { fs.rmSync(part, { force: true }); } catch { /* 下一轮用 'w' 截断也能盖掉 */ }
      }
      let startAt = round === 0 && fs.existsSync(part) ? fs.statSync(part).size : 0;
      if (expectedSize && startAt > expectedSize) {
        try { fs.rmSync(part, { force: true }); } catch { /* ignore */ }
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
        const res = await fetch(url, { signal: ctl.signal, headers });
        if (!res.ok) {
          errors.push(`${url} → HTTP ${res.status}`);
          break;
        }
        if (validateUrl) {
          const v = validateUrl(res.url || url);
          if (!v.ok) {
            errors.push(`${url} → ${v.reason}`);
            break;
          }
        }

        let start = 0;
        if (startAt > 0 && res.status === 206) {
          const cr = res.headers.get('content-range') || '';
          const m = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(cr);
          if (!m || Number(m[1]) !== startAt) {
            try { fs.rmSync(part, { force: true }); } catch { /* ignore */ }
            errors.push(`${url} → Content-Range 与续传位置不符`);
            break;
          }
          start = startAt;
        } else if (startAt > 0) {
          // 服务端忽略了 Range：从头写，别把两段拼成坏文件。
          try { fs.rmSync(part, { force: true }); } catch { /* ignore */ }
        }

        const totalHeader = Number(res.headers.get('content-length') || 0);
        const total = start + totalHeader;
        if (expectedSize && totalHeader > 0 && total !== expectedSize) {
          errors.push(`${url} → 大小不符（${total} ≠ ${expectedSize}）`);
          break;
        }

        const out = fs.createWriteStream(part, start > 0 ? { flags: 'a' } : { flags: 'w' });
        let got = start;
        const t0 = Date.now();
        try {
          for await (const chunk of res.body) {
            clearTimeout(idle);
            idle = setTimeout(() => ctl.abort(new Error('空闲超时')), IDLE_TIMEOUT_MS);
            if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
            got += chunk.length;
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
          errors.push(`${url} → 不完整（${got}/${expectedSize}）`);
          break;
        }
        const sha256 = await sha256File(part);
        if (expectedSha256 && sha256 !== expectedSha256.toLowerCase()) {
          if (round === 0) continue; // 残段可能被改过/来自别的版本：丢掉重下一次
          errors.push(`${url} → SHA-256 校验不过`);
          break;
        }
        fs.renameSync(part, dest);
        return { url, bytes: got, sha256 };
      } catch (e) {
        if (signal?.aborted || e?.code === 'ABORTED') {
          try { fs.rmSync(part, { force: true }); } catch { /* ignore */ }
          throw abortError(signal?.reason, '下载已取消');
        }
        errors.push(`${url} → ${e && e.message ? e.message : e}`);
        break; // 网络层错误：换下一个源
      } finally {
        clearTimeout(idle);
        if (signal) signal.removeEventListener('abort', onAbort);
      }
    }
  }
  throw new Error(`所有下载源都失败了：\n  - ${errors.join('\n  - ')}`);
}
