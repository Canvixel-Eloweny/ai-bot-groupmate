/**
 * 离线更新 API（P4 · 2026-10-18 · 规格 §8.8）。
 *
 * 两个写路由，**都不联网**：
 *   · prepare   ：JSON `{manifestBase64, sigBase64}` → 先验签、再解析/校验清单；
 *   · installer ：原始 EXE 字节 → 交给 updater 校 size+sha256，通过后才置 ready。
 *
 * 约定与 `update-routes.js` 一致：业务失败 HTTP 200 + `ok:false`；
 * 只有“包太大/上传中断”这类传输层失败才用 413/400。
 */

import { readBody, readBodyBuffer, sendJson } from './http-io.js';
import {
  MANIFEST_MAX_BYTES,
  SIGNATURE_MAX_BYTES,
  OFFLINE_INSTALLER_MAX_BYTES,
} from './update-manifest.js';

function decodeBase64Bytes(value, maxBytes, label) {
  const text = String(value || '').trim();
  if (!text) throw new Error(`缺少${label}内容`);
  if (!/^[A-Za-z0-9+/=\s]+$/.test(text)) throw new Error(`${label}不是合法 base64`);
  const buf = Buffer.from(text, 'base64');
  if (!buf.length) throw new Error(`${label}解码为空`);
  if (buf.length > maxBytes) throw new Error(`${label}超过 ${maxBytes} 字节`);
  return buf;
}

export function makeOfflinePrepareRoute({ updater } = {}) {
  return async function offlinePrepare(req, res, url) {
    void url;
    try {
      if (!updater || typeof updater.prepareOffline !== 'function') {
        throw new Error('更新器不可用');
      }
      const body = await readBody(req);
      const manifestBytes = decodeBase64Bytes(body && body.manifestBase64, MANIFEST_MAX_BYTES, '离线清单');
      const sig = String((body && body.sigBase64) || '').trim();
      if (!sig) throw new Error('缺少离线签名内容');
      if (!/^[A-Za-z0-9+/=\s]+$/.test(sig)) throw new Error('离线签名不是合法 base64');
      if (Buffer.byteLength(sig, 'utf8') > SIGNATURE_MAX_BYTES) {
        throw new Error(`离线签名超过 ${SIGNATURE_MAX_BYTES} 字节`);
      }
      const s = await updater.prepareOffline({ manifestBytes, sigBase64: sig });
      return sendJson(res, { ok: true, ...s });
    } catch (e) {
      return sendJson(res, { ok: false, error: e && e.message ? e.message : String(e) }, 200);
    }
  };
}

export function makeOfflineInstallerRoute({ updater } = {}) {
  return async function offlineInstaller(req, res, url) {
    void url;
    let got;
    try {
      got = await readBodyBuffer(req, { maxBytes: OFFLINE_INSTALLER_MAX_BYTES });
    } catch (e) {
      return sendJson(res, { ok: false, error: `读取上传失败：${e.message}` }, 400);
    }
    if (!got.ok) {
      const tooBig = got.error === 'too-large';
      return sendJson(
        res,
        {
          ok: false,
          error: tooBig
            ? `离线安装包太大（上限 ${Math.round(OFFLINE_INSTALLER_MAX_BYTES / 1024 / 1024)} MB）`
            : '离线安装包上传中断',
        },
        tooBig ? 413 : 400,
      );
    }
    if (!got.buf || !got.buf.length) {
      return sendJson(res, { ok: false, error: '离线安装包为空' }, 400);
    }
    try {
      if (!updater || typeof updater.completeOffline !== 'function') {
        throw new Error('更新器不可用');
      }
      const s = await updater.completeOffline({ bytes: got.buf });
      return sendJson(res, { ok: true, ...s });
    } catch (e) {
      return sendJson(res, { ok: false, error: e && e.message ? e.message : String(e) }, 200);
    }
  };
}
