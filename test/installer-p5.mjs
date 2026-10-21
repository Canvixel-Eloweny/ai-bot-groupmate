/**
 * P5 · 正式密钥轮换 / 当前版本清单 / 发布资产校验的独立验收。
 *
 * 只跑本地临时目录与 CLI；不联网、不启动真机、不碰用户数据。
 * 真机新装与离线升级在 Win11 VM 里另行验收（见 INSTALLER-SPEC §19）。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadPublicKey, fingerprintOf } from '../panel/lib/update-signature.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/* 当前版本从唯一来源读；写死会在合法升版后把"拒绝当前版本"测成另一个错误。 */
const VER = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).version;
const KEYGEN = path.join(REPO, 'packaging', 'windows', 'update', 'keygen.mjs');
const MAKE = path.join(REPO, 'packaging', 'windows', 'update', 'make-manifest.mjs');
const CHECK = path.join(REPO, 'packaging', 'windows', 'update', 'release-check.mjs');
const GH = 'Canvixel-Eloweny/ai-bot-groupmate';
let failures = 0;
let checks = 0;

function ck(name, fn) {
  checks += 1;
  try { fn(); console.log(`  PASS  ${name}`); }
  catch (e) { failures += 1; console.log(`  FAIL  ${name} — ${e.message}`); }
}
const tmp = (prefix = 'p5-') => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const run = (script, args) => spawnSync(process.execPath, [script, ...args], { cwd: REPO, encoding: 'utf8' });

function makeKey() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    privateKey,
    publicPem: publicKey.export({ type: 'spki', format: 'pem' }),
  };
}

function fixtureManifest({ version = '0.1.3', size, sha } = {}) {
  const now = Date.now();
  return {
    schemaVersion: 1,
    appId: 'com.estrellabot.windows',
    channel: 'stable',
    version,
    minVersion: '0.1.0',
    minWindows: '10.0.17763',
    generatedAt: new Date(now - 3600_000).toISOString(),
    expiresAt: new Date(now + 365 * 86400_000).toISOString(),
    notesUrl: `https://github.com/${GH}/releases/tag/v${version}`,
    installer: {
      kind: 'nsis',
      url: `https://github.com/${GH}/releases/download/v${version}/Estrella-Bot-Setup-${version}.exe`,
      mirrors: [],
      size,
      sha256: sha,
    },
  };
}

function writeFixtureRelease({ version = '0.1.3', key = makeKey(), tamper } = {}) {
  const root = tmp();
  const dir = path.join(root, 'release');
  fs.mkdirSync(dir, { recursive: true });
  const exeName = `Estrella-Bot-Setup-${version}.exe`;
  const exe = Buffer.from(`fake installer ${version}`);
  fs.writeFileSync(path.join(dir, exeName), exe);
  const manifest = fixtureManifest({ version, size: exe.length, sha: sha256(exe) });
  const raw = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  const sig = crypto.sign(null, raw, key.privateKey).toString('base64');
  fs.writeFileSync(path.join(dir, 'latest.json'), raw);
  fs.writeFileSync(path.join(dir, 'latest.json.sig'), `${sig}\n`);
  const sums = [
    `${sha256(exe)}  ${exeName}`,
    `${sha256(raw)}  latest.json`,
    `${sha256(Buffer.from(`${sig}\n`))}  latest.json.sig`,
  ].join('\n') + '\n';
  fs.writeFileSync(path.join(dir, 'SHA256SUMS'), sums);
  const pub = path.join(root, 'pub.pem');
  fs.writeFileSync(pub, key.publicPem);
  if (tamper) tamper({ dir, exeName, raw, sig, key });
  return { root, dir, pub, exeName, manifest, raw, sig, key };
}

function runCheck(fx) {
  return run(CHECK, ['--dir', fx.dir, '--pub', fx.pub, '--expect-version', '0.1.3']);
}

/* ── 1. make-manifest 的当前版本闸 ─────────────────────────────────── */
ck(`make-manifest 默认拒绝当前版本（${VER}）`, () => {
  const t = tmp();
  const exe = path.join(t, `Estrella-Bot-Setup-${VER}.exe`);
  fs.writeFileSync(exe, 'exe');
  const out = path.join(t, 'latest.json');
  const r = run(MAKE, ['--exe', exe, '--version', VER, '--out', out]);
  assert.notEqual(r.status, 0);
  assert.match(`${r.stdout}\n${r.stderr}`, /--allow-current/);
  assert.equal(fs.existsSync(out), false);
});

ck('make-manifest --allow-current 放行且字段与 EXE 一致', () => {
  const t = tmp();
  const exeName = `Estrella-Bot-Setup-${VER}.exe`;
  const exe = path.join(t, exeName);
  const bytes = Buffer.from('release-exe');
  fs.writeFileSync(exe, bytes);
  const out = path.join(t, 'latest.json');
  const r = run(MAKE, ['--exe', exe, '--version', VER, '--out', out, '--allow-current']);
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  const m = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(m.version, VER);
  assert.equal(m.installer.size, bytes.length);
  assert.equal(m.installer.sha256, sha256(bytes));
  assert.equal(m.installer.url, `https://github.com/${GH}/releases/download/v${VER}/${exeName}`);
  assert.equal(m.notesUrl, `https://github.com/${GH}/releases/tag/v${VER}`);
});

/* ── 2. release-check 正向与负向 ───────────────────────────────────── */
ck('release-check 好夹具通过', () => {
  const fx = writeFixtureRelease();
  const r = runCheck(fx);
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /发布资产校验通过/);
  assert.match(r.stdout, /签名有效/);
});

ck('release-check 拒绝清单版本不符', () => {
  const fx = writeFixtureRelease({ version: '0.1.2' });
  const r = runCheck(fx);
  assert.notEqual(r.status, 0);
  assert.match(`${r.stdout}\n${r.stderr}`, /版本|降级/);
});

ck('release-check 拒绝 EXE 被篡改', () => {
  const fx = writeFixtureRelease({
    tamper: ({ dir, exeName }) => fs.appendFileSync(path.join(dir, exeName), Buffer.from('x')),
  });
  const r = runCheck(fx);
  assert.notEqual(r.status, 0);
  assert.match(`${r.stdout}\n${r.stderr}`, /大小不一致|SHA-256 不一致|哈希不一致/);
});

ck('release-check 拒绝坏签名', () => {
  const fx = writeFixtureRelease({
    tamper: ({ dir, manifest, key }) => {
      const other = makeKey();
      const raw = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
      const sig = crypto.sign(null, raw, other.privateKey).toString('base64');
      fs.writeFileSync(path.join(dir, 'latest.json.sig'), `${sig}\n`);
    },
  });
  const r = runCheck(fx);
  assert.notEqual(r.status, 0);
  assert.match(`${r.stdout}\n${r.stderr}`, /签名无效/);
});

ck('release-check 拒绝缺 SHA256SUMS', () => {
  const fx = writeFixtureRelease({
    tamper: ({ dir }) => fs.rmSync(path.join(dir, 'SHA256SUMS')),
  });
  const r = runCheck(fx);
  assert.notEqual(r.status, 0);
  assert.match(`${r.stdout}\n${r.stderr}`, /缺文件.*SHA256SUMS/);
});

ck('release-check 拒绝发布目录中的私钥', () => {
  const fx = writeFixtureRelease({
    tamper: ({ dir }) => {
      // 运行时拼接：源码里不出现完整 PEM 头，避免发布面密钥扫描误报。
      const begin = ['-----BEGIN', 'PRIVATE', 'KEY-----'].join(' ');
      const end = ['-----END', 'PRIVATE', 'KEY-----'].join(' ');
      fs.writeFileSync(path.join(dir, 'private.pem'), `${begin}\nAAAA\n${end}\n`);
    },
  });
  const r = runCheck(fx);
  assert.notEqual(r.status, 0);
  assert.match(`${r.stdout}\n${r.stderr}`, /私钥/);
});

/* ── 3. keygen 轮换 ────────────────────────────────────────────────── */
ck('keygen 无 --rotate 拒绝覆盖，--rotate 归档旧公钥并更换指纹', () => {
  const t = tmp();
  const keys1 = path.join(t, 'keys1');
  const pub = path.join(t, 'update-pubkey.pem');
  const info = path.join(t, 'UPDATE-KEY-INFO.txt');
  const first = run(KEYGEN, ['--out', keys1, '--pub', pub, '--info', info, '--purpose', 'test']);
  assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);
  const oldPub = fs.readFileSync(pub, 'utf8');
  const oldFp = (fs.readFileSync(info, 'utf8').match(/^fingerprint=(.+)$/m) || [])[1];

  const keys2 = path.join(t, 'keys2');
  const denied = run(KEYGEN, ['--out', keys2, '--pub', pub, '--info', info, '--purpose', 'test']);
  assert.notEqual(denied.status, 0);
  assert.match(`${denied.stdout}\n${denied.stderr}`, /--rotate/);
  assert.equal(fs.readFileSync(pub, 'utf8'), oldPub);

  const rotated = run(KEYGEN, ['--out', keys2, '--pub', pub, '--info', info, '--purpose', 'test', '--rotate']);
  assert.equal(rotated.status, 0, `${rotated.stdout}\n${rotated.stderr}`);
  assert.equal(fs.readFileSync(path.join(keys2, 'previous', 'update-pubkey.pem'), 'utf8'), oldPub);
  assert.equal(fs.existsSync(path.join(keys2, 'previous', 'UPDATE-KEY-INFO.txt')), true);
  const newFp = (fs.readFileSync(info, 'utf8').match(/^fingerprint=(.+)$/m) || [])[1];
  assert.match(newFp, /^sha256:[0-9a-f]{64}$/);
  assert.notEqual(newFp, oldFp);
  assert.notEqual(fs.readFileSync(pub, 'utf8'), oldPub);
  assert.equal(fingerprintOf(loadPublicKey(fs.readFileSync(pub, 'utf8'))), newFp);
});

console.log('');
console.log(`${checks - failures}/${checks} passed`);
if (failures) process.exit(1);
