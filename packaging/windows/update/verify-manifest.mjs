#!/usr/bin/env node
/**
 * 校验 latest.json + latest.json.sig（+ 可选 EXE）的独立工具（P3）。
 * 与面板共用 update-manifest/update-signature 的判据，不抄第二份。
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { validateManifest } from '../../../panel/lib/update-manifest.js';
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

async function sha256File(file) {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function main() {
  const manifestPath = path.resolve(argOf('--manifest'));
  const sigPath = path.resolve(argOf('--sig'));
  const pubPath = path.resolve(REPO, argOf('--pub', 'resources/update-pubkey.pem'));
  if (!argOf('--manifest') || !argOf('--sig')) {
    console.error('用法：node packaging/windows/update/verify-manifest.mjs --manifest <latest.json> --sig <latest.json.sig> [--pub ...] [--exe ...] [--current 0.1.3] [--test]');
    process.exit(2);
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
  const raw = fs.readFileSync(manifestPath);
  const sig = fs.readFileSync(sigPath, 'utf8');
  const publicKey = loadPublicKeyFile(pubPath);
  if (!verifyRawSignature(raw, sig, publicKey)) {
    throw new Error('签名无效（原始字节 + 公钥验不过）');
  }
  const obj = JSON.parse(raw.toString('utf8'));
  const check = validateManifest(obj, {
    currentVersion: argOf('--current', pkg.version),
    appId: pkg.appId,
    windowsVersion: '10.0.17763',
    testMode: has('--test'),
  });
  if (!check.ok) throw new Error(`清单校验失败：\n  - ${check.errors.join('\n  - ')}`);

  const exePath = argOf('--exe');
  if (exePath) {
    const file = path.resolve(exePath);
    const st = fs.statSync(file);
    if (st.size !== obj.installer.size) throw new Error(`EXE 大小不符：${st.size} ≠ ${obj.installer.size}`);
    const hash = await sha256File(file);
    if (hash !== obj.installer.sha256) throw new Error(`EXE SHA-256 不符：${hash} ≠ ${obj.installer.sha256}`);
    console.log(`✓ EXE 校验通过：${st.size} 字节 · ${hash.slice(0, 16)}…`);
  }
  console.log(`✓ 签名有效 · version=${obj.version} · 公钥指纹=${fingerprintOf(publicKey)}`);
}

main().catch((e) => {
  console.error(`✗ ${e && e.message ? e.message : e}`);
  process.exitCode = 1;
});
