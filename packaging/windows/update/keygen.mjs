#!/usr/bin/env node
/**
 * 生成更新清单签名用的 Ed25519 密钥对（P3 · 2026-10-18）。
 *
 * 纪律：
 *   · 私钥 **必须在仓库外**；本脚本拒绝把 --out 指进仓库。
 *   · 私钥只在磁盘上，**不打印**、不入库、不入包、不进对话。
 *   · 公钥复制到 `--pub`（默认 resources/update-pubkey.pem），随程序发布。
 *   · `UPDATE-KEY-INFO.txt` 只记用途/时间/指纹/轮换点，不记私钥路径。
 *
 * 用法：
 *   node packaging/windows/update/keygen.mjs \
 *     --out ~/Desktop/estrella-dist/update-keys/p3-2026-10-18 \
 *     --pub resources/update-pubkey.pem
 *
 * 轮换（显式 --rotate；旧公钥/说明归档到 <out>/previous/）：
 *   node packaging/windows/update/keygen.mjs \
 *     --out ~/Desktop/estrella-dist/update-keys/p5-formal-2026-10-18 \
 *     --purpose "P5 formal release" --rotate-before 2027-10-18 --rotate
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateKeyPairSync } from 'node:crypto';
import { loadPublicKey, fingerprintOf } from '../../../panel/lib/update-signature.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..', '..');

function argOf(name, fallback = '') {
  const i = process.argv.indexOf(name);
  return i >= 0 ? String(process.argv[i + 1] || '') : fallback;
}
const has = (name) => process.argv.includes(name);

const out = path.resolve(argOf('--out'));
const rotate = has('--rotate');
const pubArg = argOf('--pub', 'resources/update-pubkey.pem');
const infoArg = argOf('--info', 'resources/UPDATE-KEY-INFO.txt');
const purpose = argOf('--purpose', 'P3 acceptance');
const rotateBefore = argOf('--rotate-before', 'P5');

if (!argOf('--out')) {
  console.error('用法：node packaging/windows/update/keygen.mjs --out <仓库外目录> [--pub resources/update-pubkey.pem]');
  process.exit(2);
}
const rel = path.relative(REPO, out);
if (!rel || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
  console.error(`✗ --out 必须在仓库外：${out}`);
  process.exit(1);
}

const pubPath = path.resolve(REPO, pubArg);
const infoPath = path.resolve(REPO, infoArg);
for (const target of [path.join(out, 'private.pem'), path.join(out, 'public.pem')]) {
  if (fs.existsSync(target)) {
    console.error(`✗ 目标已存在，拒绝覆盖：${target}`);
    process.exit(1);
  }
}
const replaceable = [pubPath, infoPath].filter((p) => fs.existsSync(p));
if (replaceable.length && !rotate) {
  console.error(`✗ 目标已存在，拒绝覆盖（要轮换请加 --rotate）：${replaceable.join(', ')}`);
  process.exit(1);
}

fs.mkdirSync(out, { recursive: true, mode: 0o700 });
fs.chmodSync(out, 0o700);
if (replaceable.length) {
  const prevDir = path.join(out, 'previous');
  fs.mkdirSync(prevDir, { recursive: true, mode: 0o700 });
  for (const src of replaceable) {
    const dst = path.join(prevDir, path.basename(src));
    if (fs.existsSync(dst)) {
      console.error(`✗ 归档目标已存在，拒绝覆盖：${dst}`);
      process.exit(1);
    }
    fs.copyFileSync(src, dst, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(dst, 0o644);
  }
  console.log(`✓ 旧公钥/说明已归档：${prevDir}`);
}
const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const privatePath = path.join(out, 'private.pem');
const publicPath = path.join(out, 'public.pem');
fs.writeFileSync(privatePath, privateKey, { mode: 0o600, flag: 'wx' });
fs.chmodSync(privatePath, 0o600);
fs.writeFileSync(publicPath, publicKey, { mode: 0o644, flag: 'wx' });
fs.chmodSync(publicPath, 0o644);

const key = loadPublicKey(publicKey);
const fingerprint = fingerprintOf(key);
fs.mkdirSync(path.dirname(pubPath), { recursive: true });
fs.writeFileSync(pubPath, publicKey, { mode: 0o644 });
fs.writeFileSync(infoPath, [
  `purpose=${purpose}`,
  `createdAt=${new Date().toISOString()}`,
  `fingerprint=${fingerprint}`,
  `rotateBefore=${rotateBefore}`,
  `publicKey=${path.relative(REPO, pubPath).split(path.sep).join('/')}`,
  '',
].join('\n'), { mode: 0o644 });

console.log(`✓ 私钥：${privatePath}（0600，仓库外；内容不打印）`);
console.log(`✓ 公钥：${publicPath}`);
console.log(`✓ 随程序发布：${pubPath}`);
console.log(`✓ 指纹：${fingerprint}`);
console.log(`✓ 说明：${infoPath}`);
