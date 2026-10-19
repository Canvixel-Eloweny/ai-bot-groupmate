/**
 * 更新清单的 schema / 版本 / 平台 / URL 校验（P3 · 2026-10-18）。
 *
 * 唯一入口：面板的 updater 与 `packaging/windows/update/*` 的构建脚本共用。
 * 这里**只做纯判据**：不读盘、不发网络、不碰密钥；调用方把 ctx 填好。
 */

import { compareVersions } from './update-version.js';

export const MANIFEST_URL =
  'https://github.com/Canvixel-Eloweny/ai-bot-groupmate/releases/latest/download/latest.json';
export const SIGNATURE_URL = `${MANIFEST_URL}.sig`;
export const MANIFEST_MAX_BYTES = 64 * 1024;
export const SIGNATURE_MAX_BYTES = 8 * 1024;
/** 离线安装包上传上限（经验值：当前 EXE 25.6 MB，留一倍余量）。 */
export const OFFLINE_INSTALLER_MAX_BYTES = 64 * 1024 * 1024;
/** 离线暂存过期时间：超过 1 小时且未完成上传就清掉。 */
export const OFFLINE_PENDING_MAX_AGE_MS = 60 * 60 * 1000;
export const MIN_WINDOWS = '10.0.17763';
export const CHANNEL = 'stable';
export const ALLOWED_HOSTS = Object.freeze([
  'github.com',
  'objects.githubusercontent.com',
  'gh-proxy.com',
  'ghproxy.net',
]);

function isLocalTestHost(hostname) {
  return hostname === '127.0.0.1' || hostname === 'localhost';
}

/**
 * 更新相关 URL 的白名单。生产只允许 HTTPS + 固定 host；测试模式额外允许
 * `http://127.0.0.1` / `http://localhost`，且只能由 `QQBOT_UPDATE_TEST=1` 打开。
 */
export function isAllowedUrl(raw, { testMode = false, requireFixedTag = false } = {}) {
  let u;
  try {
    u = new URL(String(raw));
  } catch {
    return { ok: false, reason: 'URL 解析失败' };
  }
  const localTest = testMode && u.protocol === 'http:' && isLocalTestHost(u.hostname);
  if (!localTest) {
    if (u.protocol !== 'https:') return { ok: false, reason: `只允许 HTTPS（收到 ${u.protocol}）` };
    if (!ALLOWED_HOSTS.includes(u.hostname)) {
      return { ok: false, reason: `host 不在白名单：${u.hostname}` };
    }
    if (requireFixedTag) {
      const m = /\/releases\/download\/([^/]+)\//.exec(u.pathname);
      if (!m) return { ok: false, reason: '安装包 URL 必须指向固定 tag（不能用 latest）' };
      if (m[1].toLowerCase() === 'latest') {
        return { ok: false, reason: '安装包 URL 不能指向 latest' };
      }
    }
  }
  return { ok: true };
}

/**
 * @param {object} obj 解析后的清单
 * @param {object} [ctx]
 * @param {string} [ctx.currentVersion] 当前程序版本
 * @param {string} [ctx.appId]
 * @param {string} [ctx.windowsVersion] 例如 `10.0.26200`
 * @param {boolean} [ctx.testMode]
 * @param {number} [ctx.now] 毫秒时间戳（测试注入）
 * @returns {{ok:boolean, errors:string[]}}
 */
export function validateManifest(obj, ctx = {}) {
  const errors = [];
  const {
    currentVersion = '',
    appId = 'com.estrellabot.windows',
    windowsVersion = '',
    testMode = false,
    now = Date.now(),
  } = ctx;

  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { ok: false, errors: ['清单不是 JSON 对象'] };
  }

  if (obj.schemaVersion !== 1) errors.push(`schemaVersion 必须是 1（收到 ${obj.schemaVersion}）`);
  if (obj.appId !== appId) errors.push(`appId 不匹配（收到 ${obj.appId}，期望 ${appId}）`);
  if (obj.channel !== CHANNEL) errors.push(`channel 必须是 ${CHANNEL}（收到 ${obj.channel}）`);

  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(String(obj.version || ''))) {
    errors.push('version 不是语义化版本');
  }
  const cmp = compareVersions(obj.version, currentVersion);
  if (cmp === null) errors.push(`version 与当前版本无法比较（${obj.version} / ${currentVersion}）`);
  else if (cmp < 0) errors.push(`拒绝降级（${obj.version} < ${currentVersion}）`); // 相等由 updater 判为 up_to_date

  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(String(obj.minVersion || ''))) {
    errors.push('minVersion 不是语义化版本');
  } else {
    const c = compareVersions(currentVersion, obj.minVersion);
    if (c === null || c < 0) errors.push(`当前版本 ${currentVersion} 低于 minVersion ${obj.minVersion}`);
  }

  if (!/^\d+\.\d+\.\d+$/.test(String(obj.minWindows || ''))) {
    errors.push('minWindows 必须是 x.y.z');
  } else if (windowsVersion) {
    const c = compareVersions(windowsVersion, obj.minWindows);
    if (c === null || c < 0) errors.push(`Windows ${windowsVersion} 低于 minWindows ${obj.minWindows}`);
  }

  const generated = Date.parse(obj.generatedAt);
  const expires = Date.parse(obj.expiresAt);
  if (!Number.isFinite(generated)) errors.push('generatedAt 不是有效时间');
  if (!Number.isFinite(expires)) errors.push('expiresAt 不是有效时间');
  if (Number.isFinite(expires) && expires <= now) errors.push('清单已过期');
  if (Number.isFinite(generated) && Number.isFinite(expires) && expires <= generated) {
    errors.push('expiresAt 必须晚于 generatedAt');
  }

  const installer = obj.installer;
  if (!installer || typeof installer !== 'object' || Array.isArray(installer)) {
    errors.push('installer 不是对象');
  } else {
    if (installer.kind !== 'nsis') errors.push('installer.kind 必须是 nsis');
    const url = isAllowedUrl(installer.url, { testMode, requireFixedTag: true });
    if (!url.ok) errors.push(`installer.url ${url.reason}`);
    if (!Number.isInteger(installer.size) || installer.size <= 0) {
      errors.push('installer.size 必须是正整数');
    }
    if (!/^[a-f0-9]{64}$/.test(String(installer.sha256 || ''))) {
      errors.push('installer.sha256 必须是 64 位小写十六进制');
    }
    const mirrors = installer.mirrors == null ? [] : installer.mirrors;
    if (!Array.isArray(mirrors)) {
      errors.push('installer.mirrors 必须是数组');
    } else {
      if (mirrors.length > 5) errors.push('installer.mirrors 最多 5 个');
      for (const mirror of mirrors) {
        // 镜像也不能指向 latest：镜像只换下载路径，不换“这一版到底是哪一版”。
        const r = isAllowedUrl(mirror, { testMode, requireFixedTag: true });
        if (!r.ok) errors.push(`installer.mirrors ${r.reason}`);
      }
    }
  }

  const notes = isAllowedUrl(obj.notesUrl, { testMode });
  if (!notes.ok) errors.push(`notesUrl ${notes.reason}`);

  return { ok: errors.length === 0, errors };
}
