/**
 * Windows VM 的 P0 低层验收（B0）。
 *
 * 用法：node verify-p0.mjs <beforeDir> [afterDir]
 * beforeDir 放旧版 update-manifest.js + update-version.js；afterDir 放当前三件套。
 * 不验 Ed25519 签名，也不点 UI —— 只验 URL 白名单与真实 302 终点。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const beforeDir = path.resolve(process.argv[2] || '../before');
const afterDir = path.resolve(process.argv[3] || '.');
const load = (dir, file) => import(pathToFileURL(path.join(dir, file)).href);

const before = await load(beforeDir, 'update-manifest.js');
const after = await load(afterDir, 'update-manifest.js');
const dl = await load(afterDir, 'update-download.js');

const finalHostUrl = 'https://release-assets.githubusercontent.com/github-production-release-asset/1/x';
const beforeCheck = before.isAllowedUrl(finalHostUrl, {});
const afterCheck = after.isAllowedUrl(finalHostUrl, {});
const result = { step: 'host', before: beforeCheck, after: afterCheck };
console.log(JSON.stringify(result));
if (beforeCheck.ok) throw new Error('before 版本不应放行 release-assets');
if (!afterCheck.ok) throw new Error('after 版本没有放行 release-assets');

let beforeError = '';
try {
  await dl.fetchCapped(before.MANIFEST_URL, {
    maxBytes: before.MANIFEST_MAX_BYTES,
    timeoutMs: 30000,
    validateUrl: (u) => before.isAllowedUrl(u, {}),
  });
} catch (e) {
  beforeError = e && e.message ? e.message : String(e);
}
console.log(JSON.stringify({ step: 'before-fetch', error: beforeError }));
if (!/host 不在白名单/.test(beforeError)) {
  throw new Error(`before 的失败原因不是 host（可能是 TLS/网络）：${beforeError}`);
}

let finalUrl = '';
const manifestRes = await dl.fetchCapped(after.MANIFEST_URL, {
  maxBytes: after.MANIFEST_MAX_BYTES,
  timeoutMs: 30000,
  validateUrl: (u) => { finalUrl = u; return after.isAllowedUrl(u, {}); },
});
const manifest = JSON.parse(manifestRes.buffer.toString('utf8'));
console.log(JSON.stringify({
  step: 'manifest',
  finalUrl,
  version: manifest.version,
  size: manifest.installer.size,
  sha256: manifest.installer.sha256,
}));
if (!/^https:\/\/release-assets\.githubusercontent\.com\//.test(finalUrl)) {
  throw new Error(`清单最终 URL 不在 release-assets：${finalUrl}`);
}

const head = await fetch(manifest.installer.url, { method: 'HEAD', redirect: 'follow' });
console.log(JSON.stringify({
  step: 'installer-head',
  status: head.status,
  finalUrl: head.url,
  length: head.headers.get('content-length'),
}));
if (head.status !== 200) throw new Error(`installer HEAD 不是 200：${head.status}`);
if (!/^https:\/\/release-assets\.githubusercontent\.com\//.test(head.url)) {
  throw new Error(`installer 最终 URL 不在 release-assets：${head.url}`);
}

const dest = path.join(os.tmpdir(), `p0-installer-${process.pid}.exe`);
let installFinalUrl = '';
try {
  const got = await dl.downloadWithProgress({
    urls: [manifest.installer.url],
    dest,
    expectedSha256: manifest.installer.sha256,
    expectedSize: manifest.installer.size,
    validateUrl: (u) => { installFinalUrl = u; return after.isAllowedUrl(u, {}); },
  });
  const stat = fs.statSync(dest);
  console.log(JSON.stringify({
    step: 'installer-download',
    finalUrl: installFinalUrl,
    bytes: stat.size,
    sha256: got.sha256,
  }));
  if (stat.size !== manifest.installer.size) throw new Error(`下载尺寸不符：${stat.size}`);
  if (got.sha256 !== manifest.installer.sha256.toLowerCase()) throw new Error('下载 SHA-256 不符');
} finally {
  try { fs.rmSync(dest, { force: true }); } catch { /* 已删 */ }
}

console.log(JSON.stringify({ step: 'ok' }));
