/**
 * 更新 API 的 5 个 handler 工厂（P3 · 2026-10-18）。
 *
 * 约定：业务失败也回 HTTP 200 + `ok:false`（与项目里「原因可读、不谎报成功」一致）；
 * 只有未知动作/真正的服务端异常才用非 2xx。POST 的鉴权与审计由 server.js 的
 * WRITE_ROUTES 统一挂载，这里不重复做。
 */

import { readBody, sendJson } from './http-io.js';

export function makeUpdateRoute({ updater, action }) {
  return async function updateRoute(req, res, url) {
    void url;
    try {
      if (action === 'state') {
        return sendJson(res, { ok: true, ...updater.snapshot() });
      }
      if (action === 'check') {
        const s = await updater.check({ manual: true });
        return sendJson(res, { ok: s.phase !== 'error', ...s });
      }
      if (action === 'download') {
        const s = updater.startDownload();
        return sendJson(res, { ok: true, ...s });
      }
      if (action === 'cancel') {
        const s = await updater.cancel();
        return sendJson(res, { ok: true, ...s });
      }
      if (action === 'install') {
        const body = await readBody(req);
        const s = await updater.install({ silent: body && body.silent === true });
        return sendJson(res, { ok: true, ...s });
      }
      return sendJson(res, { ok: false, error: '未知更新动作' }, 404);
    } catch (e) {
      return sendJson(res, { ok: false, error: e && e.message ? e.message : String(e) }, 200);
    }
  };
}
