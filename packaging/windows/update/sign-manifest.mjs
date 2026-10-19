#!/usr/bin/env node
/**
 * 用 Ed25519 私钥签 latest.json 的**原始字节**，输出 base64 单行 .sig（P3）。
 *
 * 私钥路径由 --key 传入；脚本只读、不打印、不复制私钥。
 * 写盘前先用公钥验一遍，防止“签出来的东西自己都验不过”。
 */

import fs from 'node:fs';
import path from 'node:path';
import { createPrivateKey, sign } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  loadPublicKeyFile, verifyRawSignature, fingerprintOf,
} from '../../../panel/lib/update-signature.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..', '..');

function argOf(name, fallback = '') {
  const i = process.argv.indexOf(name);
  return i >= 0 ? String(process.argv[i + 1] || '') : fallback;
}
const has = (name) => process.argv.includes(name);

const manifestPath = path.resolve(argOf('--manifest'));
const keyPath = path.resolve(argOf('--key'));
const out = path.resolve(argOf('--out'));
const pubPath = path.resolve(REPO, argOf('--pub', 'resources/update-pubkey.pem'));
if (!argOf('--manifest') || !argOf('--key') || !argOf('--out')) {
  console.error('用法：node packaging/windows/update/sign-manifest.mjs --manifest <latest.json> --key <private.pem> --out <latest.json.sig> [--pub resources/update-pubkey.pem] [--force]');
  process.exit(2);
}
if (!has('--force') && fs.existsSync(out)) {
  console.error(`✗ 输出已存在，拒绝覆盖（要重签请加 --force）：${out}`);
  process.exit(1);
}

const raw = fs.readFileSync(manifestPath);
const privateKey = createPrivateKey(fs.readFileSync(keyPath, 'utf8'));
if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('私钥不是 Ed25519');
const sig = sign(null, raw, privateKey);
const publicKey = loadPublicKeyFile(pubPath);
if (!verifyRawSignature(raw, sig.toString('base64'), publicKey)) {
  throw new Error('自校验失败：新签名用公钥验不过（私钥/公钥不配对？）');
}
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `${sig.toString('base64')}\n`, { encoding: 'utf8', mode: 0o644 });
console.log(`✓ 签名：${out}（${sig.length} 字节）`);
console.log(`  公钥指纹：${fingerprintOf(publicKey)}`);
