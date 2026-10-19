#!/usr/bin/env node
/**
 * 校验本地发布资产（P5 · 2026-10-18）。
 *
 * 发布前必须同时满足：
 *   · latest.json 的原始字节能被仓库公钥验签；
 *   · 清单版本 = package.json 版本 = EXE 文件名 = 固定 tag；
 *   · EXE 的 size / sha256 与清单一致；
 *   · SHA256SUMS 覆盖 EXE / latest.json / latest.json.sig 且哈希一致；
 *   · 清单未过期；
 *   · 发布目录不含私钥。
 *
 * 只读本地文件，不联网。退出码 0 = 全过，1 = 有任一项失败，2 = 用法错误。
 *
 * 用法：
 *   node packaging/windows/update/release-check.mjs \
 *     --dir ~/Desktop/estrella-dist/release-v0.1.3 \
 *     --pub resources/update-pubkey.pem \
 *     --expect-version 0.1.3
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  loadPublicKeyFile, verifyRawSignature, fingerprintOf,
} from '../../../panel/lib/update-signature.js';
import {
  validateManifest, MANIFEST_MAX_BYTES, SIGNATURE_MAX_BYTES, MIN_WINDOWS,
} from '../../../panel/lib/update-manifest.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..', '..');
const GH = 'Canvixel-Eloweny/ai-bot-groupmate';

function argOf(name, fallback = '') {
  const i = process.argv.indexOf(name);
  return i >= 0 ? String(process.argv[i + 1] || '') : fallback;
}

const dirArg = argOf('--dir');
if (!dirArg) {
  console.error('用法：node packaging/windows/update/release-check.mjs --dir <发布目录> [--pub resources/update-pubkey.pem] [--expect-version 0.1.3] [--sums <SHA256SUMS>]');
  process.exit(2);
}
const dir = path.resolve(dirArg);
const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
const version = argOf('--expect-version', pkg.version);
const pubPath = path.resolve(REPO, argOf('--pub', 'resources/update-pubkey.pem'));
const sumsPath = path.resolve(argOf('--sums', path.join(dir, 'SHA256SUMS')));
const exeName = `Estrella-Bot-Setup-${version}.exe`;
const manifestPath = path.join(dir, 'latest.json');
const sigPath = path.join(dir, 'latest.json.sig');
const exePath = path.join(dir, exeName);

const problems = [];
const bad = (msg) => { problems.push(msg); console.error(`✗ ${msg}`); };
const ok = (msg) => console.log(`✓ ${msg}`);
const sha256File = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

if (!fs.existsSync(dir)) {
  console.error(`✗ 发布目录不存在：${dir}`);
  process.exit(2);
}

for (const [label, file] of [['EXE', exePath], ['latest.json', manifestPath], ['latest.json.sig', sigPath], ['SHA256SUMS', sumsPath]]) {
  if (!fs.existsSync(file)) bad(`缺文件：${label}（${file}）`);
}

let publicKey = null;
if (fs.existsSync(pubPath)) {
  publicKey = loadPublicKeyFile(pubPath);
  ok(`公钥：${pubPath}（${fingerprintOf(publicKey)}）`);
} else {
  bad(`缺公钥：${pubPath}`);
}

let manifestRaw = null;
let manifest = null;
if (fs.existsSync(manifestPath)) {
  manifestRaw = fs.readFileSync(manifestPath);
  if (manifestRaw.length > MANIFEST_MAX_BYTES) bad(`latest.json 超过上限 ${MANIFEST_MAX_BYTES} 字节`);
  try {
    manifest = JSON.parse(manifestRaw.toString('utf8'));
  } catch (e) {
    bad(`latest.json 解析失败：${e.message}`);
  }
}

let sigText = '';
if (fs.existsSync(sigPath)) {
  sigText = fs.readFileSync(sigPath, 'utf8');
  if (Buffer.byteLength(sigText, 'utf8') > SIGNATURE_MAX_BYTES) bad(`latest.json.sig 超过上限 ${SIGNATURE_MAX_BYTES} 字节`);
  if (sigText.trim().split(/\s+/).filter(Boolean).length !== 1) bad('latest.json.sig 必须是单行 base64');
}

if (manifestRaw && sigText && publicKey) {
  if (!verifyRawSignature(manifestRaw, sigText, publicKey)) {
    bad('latest.json 签名无效（公钥与私钥不配对，或清单在签名后被改动）');
  } else {
    ok(`签名有效（原始字节 ${manifestRaw.length} 字节）`);
  }
}

if (manifest) {
  const check = validateManifest(manifest, {
    currentVersion: version,
    appId: pkg.appId,
    windowsVersion: MIN_WINDOWS,
  });
  for (const e of check.errors) bad(`清单校验：${e}`);

  if (manifest.version !== version) bad(`清单版本 ${manifest.version} ≠ 期望 ${version}`);
  else ok(`清单版本：${version}`);

  try {
    const u = new URL(manifest.installer.url);
    const expected = `/${GH}/releases/download/v${version}/${exeName}`;
    if (u.pathname !== expected) bad(`installer.url 路径不是固定 tag 正式资产：${u.pathname}（期望 ${expected}）`);
    else ok(`installer.url：固定 tag v${version}`);
  } catch {
    bad(`installer.url 无法解析：${manifest.installer.url}`);
  }
  try {
    const n = new URL(manifest.notesUrl);
    const expected = `/${GH}/releases/tag/v${version}`;
    if (n.pathname !== expected) bad(`notesUrl 不是 v${version} 的 release：${n.pathname}`);
  } catch {
    bad(`notesUrl 无法解析：${manifest.notesUrl}`);
  }

  const expires = Date.parse(manifest.expiresAt);
  if (!(expires > Date.now())) bad(`清单已过期：${manifest.expiresAt}`);
  else ok(`清单有效期至：${manifest.expiresAt}`);
}

if (fs.existsSync(exePath)) {
  const size = fs.statSync(exePath).size;
  const sha = sha256File(exePath);
  ok(`EXE：${size} 字节 / ${sha}`);
  if (manifest) {
    if (manifest.installer.size !== size) bad(`EXE 大小不一致：清单 ${manifest.installer.size} / 实际 ${size}`);
    if (manifest.installer.sha256 !== sha) bad(`EXE SHA-256 不一致：清单 ${manifest.installer.sha256} / 实际 ${sha}`);
  }
}

if (fs.existsSync(sumsPath)) {
  const sums = new Map();
  for (const line of fs.readFileSync(sumsPath, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const m = /^([a-f0-9]{64})\s+\*?(.+)$/.exec(line.trim());
    if (!m) { bad(`SHA256SUMS 行格式无效：${line}`); continue; }
    if (sums.has(m[2])) bad(`SHA256SUMS 重复条目：${m[2]}`);
    sums.set(m[2], m[1]);
  }
  for (const name of [exeName, 'latest.json', 'latest.json.sig']) {
    const file = path.join(dir, name);
    if (!sums.has(name)) { bad(`SHA256SUMS 缺少 ${name}`); continue; }
    if (!fs.existsSync(file)) continue;
    const actual = sha256File(file);
    if (sums.get(name) !== actual) bad(`SHA256SUMS 哈希不一致：${name}`);
  }
  ok(`SHA256SUMS：${sums.size} 条`);
}

for (const name of fs.readdirSync(dir)) {
  const file = path.join(dir, name);
  let st;
  try { st = fs.statSync(file); } catch { continue; }
  if (!st.isFile()) continue;
  if (/^private.*\.pem$/i.test(name) || /\.key$/i.test(name)) {
    bad(`发布目录含疑似私钥文件：${name}`);
  }
  if (st.size <= 1024 * 1024) {
    const text = fs.readFileSync(file, 'utf8');
    if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text)) {
      bad(`发布目录文件含私钥内容：${name}`);
    }
  }
}

if (problems.length) {
  console.error(`\n✗ 发布资产校验失败：${problems.length} 项`);
  process.exit(1);
}
console.log(`\n✓ 发布资产校验通过 · version=${version} · 公钥指纹=${publicKey ? fingerprintOf(publicKey) : 'n/a'}`);
