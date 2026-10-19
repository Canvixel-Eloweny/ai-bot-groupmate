/**
 * 更新清单的 Ed25519 验签（P3 · 2026-10-18）。
 *
 * ⚠️ 签名覆盖的是 **manifest 的原始字节**，不是 `JSON.stringify(JSON.parse(...))`。
 *    重新序列化会改变空白/键序，签名必然不过；更危险的是有人为了“让它过”
 *    去改规范化逻辑，等于把签名对象从“发布者签的这份字节”换成“解析后的对象”。
 */

import fs from 'node:fs';
import { createHash, createPublicKey, verify } from 'node:crypto';

export function loadPublicKey(pem) {
  const key = createPublicKey(String(pem));
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new Error(`更新公钥不是 Ed25519（收到 ${key.asymmetricKeyType}）`);
  }
  return key;
}

export function loadPublicKeyFile(file) {
  return loadPublicKey(fs.readFileSync(file, 'utf8'));
}

/** @returns {boolean} 签名有效才为 true；任何异常都按无效处理。 */
export function verifyRawSignature(rawBytes, sigBase64, publicKey) {
  try {
    const sig = Buffer.from(String(sigBase64 || '').trim(), 'base64');
    // Ed25519 签名固定 64 字节；先挡掉空串/乱码，避免把“格式错”当成“验签不过”。
    if (sig.length !== 64) return false;
    return verify(null, Buffer.isBuffer(rawBytes) ? rawBytes : Buffer.from(rawBytes), publicKey, sig);
  } catch {
    return false;
  }
}

export function fingerprintOf(publicKey) {
  const der = publicKey.export({ type: 'spki', format: 'der' });
  return `sha256:${createHash('sha256').update(der).digest('hex')}`;
}
