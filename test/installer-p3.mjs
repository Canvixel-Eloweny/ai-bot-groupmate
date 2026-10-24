/**
 * P3 更新协议测试（2026-10-18）。
 *
 * 复跑：NODE_OPTIONS= node test/installer-p3.mjs
 * 覆盖：版本对照、清单 schema/URL/过期、Ed25519 原始字节验签、下载续传/镜像/
 * 哈希/尺寸/取消、状态机、updater 端到端与状态恢复。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { Readable } from 'node:stream';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';

import {
  compareVersions as panelCompare, parseVersion, isNewerVersion,
} from '../panel/lib/update-version.js';
import {
  validateManifest, isAllowedUrl, ALLOWED_HOSTS,
  MANIFEST_MAX_BYTES, SIGNATURE_MAX_BYTES, OFFLINE_INSTALLER_MAX_BYTES, INSTALLER_MAX_BYTES,
} from '../panel/lib/update-manifest.js';
import {
  loadPublicKey, verifyRawSignature, fingerprintOf,
} from '../panel/lib/update-signature.js';
import { fetchCapped, downloadWithProgress, diskBudgetOk } from '../panel/lib/update-download.js';
import { readBodyBuffer, readBodyToFile } from '../panel/lib/http-io.js';
import { createUpdater, canTransition, PHASES, sweepUpdateCache } from '../panel/lib/update.js';
import { compareVersions as installerCompare } from '../packaging/windows/tools/lib/install-layout.mjs';

const APP_ID = 'com.estrellabot.windows';
let passed = 0;
let failed = 0;

function ck(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (e) {
    failed += 1;
    console.log(`  FAIL  ${name}: ${e && e.message ? e.message : e}`);
  }
}
async function ckA(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (e) {
    failed += 1;
    console.log(`  FAIL  ${name}: ${e && e.message ? e.message : e}`);
  }
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function baseManifest(over = {}) {
  const installer = {
    kind: 'nsis',
    url: 'https://github.com/Canvixel-Eloweny/ai-bot-groupmate/releases/download/v0.1.4/Estrella-Bot-Setup-0.1.4.exe',
    mirrors: [],
    size: 123,
    sha256: 'a'.repeat(64),
    ...(over.installer || {}),
  };
  return {
    schemaVersion: 1,
    appId: APP_ID,
    channel: 'stable',
    version: '0.1.4',
    minVersion: '0.1.0',
    minWindows: '10.0.17763',
    generatedAt: '2026-10-18T00:00:00.000Z',
    expiresAt: '2026-11-18T00:00:00.000Z',
    notesUrl: 'https://github.com/Canvixel-Eloweny/ai-bot-groupmate/releases/tag/v0.1.4',
    ...over,
    installer,
  };
}

const ctx = {
  currentVersion: '0.1.3',
  appId: APP_ID,
  windowsVersion: '10.0.26200',
  now: Date.parse('2026-10-18T12:00:00.000Z'),
};

function serve(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function fileHandler(files) {
  return (req, res) => {
    const hit = files[req.url];
    if (!hit) { res.writeHead(404); res.end('not found'); return; }
    const buf = Buffer.isBuffer(hit) ? hit : Buffer.from(hit);
    const m = /^bytes=(\d+)-/.exec(req.headers.range || '');
    if (m) {
      const start = Number(m[1]);
      res.writeHead(206, {
        'content-type': 'application/octet-stream',
        'content-range': `bytes ${start}-${buf.length - 1}/${buf.length}`,
        'content-length': buf.length - start,
      });
      res.end(buf.subarray(start));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': buf.length });
    res.end(buf);
  };
}

function makeFixture({ version = '0.1.4-p3.1', exeBytes = null, tamper = false } = {}) {
  const exe = exeBytes || Buffer.from('P3 updater fixture\n'.repeat(1024));
  const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const manifest = baseManifest({
    version,
    minVersion: '0.1.0',
    installer: {
      kind: 'nsis',
      url: `http://127.0.0.1:1/Estrella-Bot-Setup-${version}.exe`,
      mirrors: [],
      size: exe.length,
      sha256: sha256(exe),
    },
    notesUrl: 'http://127.0.0.1:1/notes',
  });
  const raw = Buffer.from(JSON.stringify(manifest, null, 2));
  const sig = sign(null, raw, privateKey).toString('base64');
  const servedRaw = tamper ? Buffer.concat([raw, Buffer.from(' ')]) : raw;
  return { exe, manifest, raw, servedRaw, sig, publicKey, privateKey, version };
}

async function main() {
  console.log('── 版本比较 ──');
  ck('预发布 < 同核心版本正式版；0.1.4-p3.1 > 0.1.3', () => {
    assert.equal(panelCompare('0.1.4-p3.1', '0.1.3'), 1);
    assert.equal(panelCompare('0.1.3-p3.1', '0.1.3'), -1);
    assert.equal(panelCompare('0.1.3', '0.1.3'), 0);
    assert.equal(panelCompare('bad', '0.1.3'), null);
    assert.equal(isNewerVersion('0.1.4-p3.1', '0.1.3'), true);
    assert.equal(parseVersion('v0.1.3').parts.join('.'), '0.1.3');
  });
  ck('面板与安装器的版本比较逐项一致', () => {
    const table = ['0.1.3', '0.1.4', '0.1.4-p3.1', '0.1.3-p3.1', 'v0.1.3', '1.0.0', '0.9.9'];
    for (const a of table) for (const b of table) {
      assert.equal(panelCompare(a, b), installerCompare(a, b), `${a} vs ${b}`);
    }
  });

  console.log('── 清单校验 ──');
  ck('合法清单通过', () => assert.equal(validateManifest(baseManifest(), ctx).ok, true));
  ck('相同版本允许（up_to_date），不误报降级', () => {
    assert.equal(validateManifest(baseManifest({ version: '0.1.3' }), ctx).ok, true);
  });
  ck('低版本拒绝', () => {
    const r = validateManifest(baseManifest({ version: '0.1.2' }), ctx);
    assert.equal(r.ok, false);
    assert.match(r.errors.join('；'), /拒绝降级/);
  });
  ck('错 appId / channel / schema 拒绝', () => {
    for (const over of [{ appId: 'x' }, { channel: 'beta' }, { schemaVersion: 2 }]) {
      assert.equal(validateManifest(baseManifest(over), ctx).ok, false, JSON.stringify(over));
    }
  });
  ck('过期清单拒绝', () => {
    const r = validateManifest(baseManifest({ expiresAt: '2026-10-17T00:00:00.000Z' }), ctx);
    assert.equal(r.ok, false);
    assert.match(r.errors.join('；'), /过期/);
  });
  ck('minVersion 过高拒绝；minWindows 过高拒绝', () => {
    assert.equal(validateManifest(baseManifest({ minVersion: '0.1.4' }), ctx).ok, false);
    assert.equal(validateManifest(baseManifest({ minWindows: '10.0.99999' }), ctx).ok, false);
  });
  ck('生产拒绝 http / 非白名单 host；测试允许回环 http', () => {
    const httpManifest = baseManifest({
      installer: { url: 'http://example.com/x.exe' },
      notesUrl: 'http://example.com/notes',
    });
    assert.equal(validateManifest(httpManifest, ctx).ok, false);
    assert.equal(isAllowedUrl('https://evil.example/x', {}).ok, false);
    assert.equal(isAllowedUrl('http://127.0.0.1:8080/x', { testMode: true }).ok, true);
    assert.equal(isAllowedUrl('http://127.0.0.1:8080/x', {}).ok, false);
    /* GitHub release 资产的最终重定向 host。final URL 不要求
       `/releases/download/<tag>/` 形状（名单里是 CDN 的签名 URL），
       所以这里不传 requireFixedTag。 */
    assert.equal(isAllowedUrl('https://release-assets.githubusercontent.com/github-production-release-asset/1/x', {}).ok, true);
    assert.equal(isAllowedUrl('https://release-assets.githubusercontent.com.evil.example/x', {}).ok, false);
  });
  ck('坏 sha256 / size 拒绝', () => {
    assert.equal(validateManifest(baseManifest({ installer: { sha256: 'xyz' } }), ctx).ok, false);
    assert.equal(validateManifest(baseManifest({ installer: { size: 0 } }), ctx).ok, false);
    assert.equal(validateManifest(baseManifest({ installer: { size: INSTALLER_MAX_BYTES + 1 } }), ctx).ok, false);
  });
  ck('地址白名单常量符合规格', () => {
    assert.equal(MANIFEST_MAX_BYTES, 64 * 1024);
    assert.equal(SIGNATURE_MAX_BYTES, 8 * 1024);
    assert.deepEqual([...ALLOWED_HOSTS], [
      'github.com',
      'objects.githubusercontent.com',
      'release-assets.githubusercontent.com',
      'gh-proxy.com',
      'ghproxy.net',
    ]);
    assert.equal(ALLOWED_HOSTS.includes('*'), false);
    assert.equal(OFFLINE_INSTALLER_MAX_BYTES, 256 * 1024 * 1024);
  });

  console.log('── Ed25519 原始字节验签 ──');
  ck('原始字节签名通过；篡改字节/换密钥/短签名均拒绝', () => {
    const raw = Buffer.from('{"hello":"world"}');
    const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const key = loadPublicKey(publicKey);
    const sig = sign(null, raw, privateKey).toString('base64');
    assert.equal(verifyRawSignature(raw, sig, key), true);
    assert.equal(verifyRawSignature(Buffer.from('{"hello":"worle"}'), sig, key), false);
    const other = generateKeyPairSync('ed25519', {
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    assert.equal(verifyRawSignature(raw, sig, loadPublicKey(other.publicKey)), false);
    assert.equal(verifyRawSignature(raw, 'AAAA', key), false);
    assert.match(fingerprintOf(key), /^sha256:[0-9a-f]{64}$/);
  });
  ck('仓库公钥与 UPDATE-KEY-INFO 指纹一致', () => {
    const repo = path.resolve('.');
    const key = loadPublicKey(fs.readFileSync(path.join(repo, 'resources/update-pubkey.pem'), 'utf8'));
    const info = fs.readFileSync(path.join(repo, 'resources/UPDATE-KEY-INFO.txt'), 'utf8');
    const expected = (info.match(/^fingerprint=(.+)$/m) || [])[1];
    assert.equal(fingerprintOf(key), expected.trim());
  });

  console.log('── 下载器 ──');
  const payload = Buffer.from('0123456789abcdef'.repeat(16384)); // 256 KiB
  const payloadSha = sha256(payload);
  const fileSrv = await serve(fileHandler({
    '/payload.bin': payload,
    '/manifest.json': '{"ok":true}',
  }));
  const base = `http://127.0.0.1:${fileSrv.port}`;

  await ckA('fetchCapped 正常读取；超上限拒绝', async () => {
    const r = await fetchCapped(`${base}/manifest.json`, { maxBytes: 1024 });
    assert.equal(r.buffer.toString(), '{"ok":true}');
    await assert.rejects(
      () => fetchCapped(`${base}/payload.bin`, { maxBytes: 1024 }),
      /超过上限/,
    );
  });

  await ckA('重定向后校验最终 URL（不是初始 URL）', async () => {
    const seen = [];
    const srv = await serve((req, res) => {
      if (req.url === '/redirect') {
        res.writeHead(302, { location: '/manifest.json' });
        res.end();
        return;
      }
      if (req.url === '/manifest.json') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
        return;
      }
      res.writeHead(404);
      res.end('not found');
    });
    try {
      const r = await fetchCapped(`http://127.0.0.1:${srv.port}/redirect`, {
        maxBytes: 1024,
        validateUrl: (u) => { seen.push(u); return { ok: true }; },
      });
      assert.equal(r.buffer.toString(), '{"ok":true}');
      assert.equal(seen.length, 1);
      assert.match(seen[0], /\/manifest\.json$/);
    } finally {
      srv.server.close();
    }
  });

  await ckA('离线上限可容纳 >64 MiB 安装包', async () => {
    const size = 65 * 1024 * 1024;
    const buf = Buffer.alloc(size, 0x41);
    const underOld = await readBodyBuffer(Readable.from([buf]), { maxBytes: 64 * 1024 * 1024 });
    assert.equal(underOld.ok, false);
    assert.equal(underOld.error, 'too-large');
    const underNew = await readBodyBuffer(Readable.from([buf]), { maxBytes: OFFLINE_INSTALLER_MAX_BYTES });
    assert.equal(underNew.ok, true);
    assert.equal(underNew.buf.length, size);
  });

  await ckA('readBodyToFile：流式落盘；超限删半份', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p3-bodyfile-'));
    const f = path.join(dir, 'ok.bin');
    const r = await readBodyToFile(Readable.from([Buffer.from('abc'), Buffer.from('def')]), { file: f, maxBytes: 10 });
    assert.equal(r.ok, true);
    assert.equal(r.size, 6);
    assert.equal(fs.readFileSync(f, 'utf8'), 'abcdef');
    const f2 = path.join(dir, 'too.bin');
    const r2 = await readBodyToFile(Readable.from([Buffer.alloc(11, 1)]), { file: f2, maxBytes: 10 });
    assert.equal(r2.ok, false);
    assert.equal(r2.error, 'too-large');
    assert.equal(fs.existsSync(f2), false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  ck('磁盘预算：2× 包体 + 64 MB 保留', () => {
    assert.equal(diskBudgetOk({ freeBytes: 1000, size: 100 }), false);
    assert.equal(diskBudgetOk({ freeBytes: 64 * 1024 * 1024 + 200, size: 100 }), true);
    assert.equal(diskBudgetOk({ freeBytes: 0, size: 100 }), false);
  });

  await ckA('cache 清理：只保留最近 2 份 EXE 与配套 json/sig', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p3-cache-'));
    for (const [name, t] of [['0.1.1', 1000], ['0.1.2', 2000], ['0.1.3', 3000]]) {
      for (const ext of ['exe', 'json', 'sig']) {
        const file = path.join(dir, `${name}.${ext}`);
        fs.writeFileSync(file, 'x');
        fs.utimesSync(file, new Date(t), new Date(t));
      }
    }
    const r = sweepUpdateCache({ cacheDir: dir, keep: 2 });
    assert.deepEqual(r.kept.sort(), ['0.1.2.exe', '0.1.3.exe']);
    assert.equal(fs.existsSync(path.join(dir, '0.1.1.exe')), false);
    assert.equal(fs.existsSync(path.join(dir, '0.1.1.json')), false);
    assert.equal(fs.existsSync(path.join(dir, '0.1.1.sig')), false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await ckA('完整下载 + 进度回调 + 哈希校验', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p3-dl-'));
    const dest = path.join(dir, 'payload.bin');
    let last = null;
    const r = await downloadWithProgress({
      urls: [`${base}/payload.bin`],
      dest,
      expectedSha256: payloadSha,
      expectedSize: payload.length,
      onProgress: (p) => { last = p; },
    });
    assert.equal(fs.statSync(dest).size, payload.length);
    assert.equal(r.sha256, payloadSha);
    assert.equal(last.percent, 100);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await ckA('续传：已有 .part 用 Range 补齐', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p3-dl-'));
    const dest = path.join(dir, 'payload.bin');
    fs.writeFileSync(`${dest}.part`, payload.subarray(0, 1000));
    fs.writeFileSync(`${dest}.part.json`, `${JSON.stringify({
      version: '', size: payload.length, sha256: payloadSha, at: new Date().toISOString(),
    })}\n`);
    const r = await downloadWithProgress({
      urls: [`${base}/payload.bin`],
      dest,
      expectedSha256: payloadSha,
      expectedSize: payload.length,
    });
    assert.equal(r.bytes, payload.length);
    assert.equal(fs.readFileSync(dest).equals(payload), true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await ckA('同版本重打：.part sidecar 版本/哈希不匹配则从 0 重下', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p3-dl-part-'));
    const dest = path.join(dir, 'payload.bin');
    fs.writeFileSync(`${dest}.part`, Buffer.alloc(1000, 0x42));
    fs.writeFileSync(`${dest}.part.json`, `${JSON.stringify({
      version: '0.1.0-old', size: payload.length, sha256: '0'.repeat(64), at: new Date().toISOString(),
    })}\n`);
    let sawRange = null;
    const srv = await serve((req, res) => {
      sawRange = req.headers.range || '';
      res.writeHead(200, { 'content-length': payload.length, 'content-type': 'application/octet-stream' });
      res.end(payload);
    });
    try {
      await downloadWithProgress({
        urls: [`http://127.0.0.1:${srv.port}/payload.bin`],
        dest,
        expectedSha256: payloadSha,
        expectedSize: payload.length,
        expectedVersion: '0.1.5-test',
      });
      assert.equal(sawRange, '');
      assert.equal(fs.readFileSync(dest).equals(payload), true);
    } finally {
      srv.server.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await ckA('镜像回退：第一个 404，第二个成功', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p3-dl-'));
    const dest = path.join(dir, 'payload.bin');
    await downloadWithProgress({
      urls: [`${base}/missing.bin`, `${base}/payload.bin`],
      dest,
      expectedSha256: payloadSha,
      expectedSize: payload.length,
    });
    assert.equal(fs.readFileSync(dest).equals(payload), true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await ckA('坏哈希/坏尺寸拒绝且不落成 .exe', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p3-dl-'));
    const dest = path.join(dir, 'payload.bin');
    await assert.rejects(() => downloadWithProgress({
      urls: [`${base}/payload.bin`],
      dest,
      expectedSha256: 'b'.repeat(64),
      expectedSize: payload.length,
    }), /SHA-256/);
    assert.equal(fs.existsSync(dest), false);
    await assert.rejects(() => downloadWithProgress({
      urls: [`${base}/payload.bin`],
      dest,
      expectedSha256: payloadSha,
      expectedSize: payload.length + 1,
    }), /大小不符|不完整/);
    assert.equal(fs.existsSync(dest), false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await ckA('取消下载：中止并删除 .part', async () => {
    const slow = await serve((req, res) => {
      if (req.url !== '/slow.bin') { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': 1024 * 1024 });
      let sent = 0;
      const timer = setInterval(() => {
        if (sent >= 1024 * 1024) { clearInterval(timer); res.end(); return; }
        res.write(Buffer.alloc(16 * 1024));
        sent += 16 * 1024;
      }, 20);
      req.on('close', () => clearInterval(timer));
    });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p3-dl-'));
    const dest = path.join(dir, 'slow.bin');
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 60);
    await assert.rejects(() => downloadWithProgress({
      urls: [`http://127.0.0.1:${slow.port}/slow.bin`],
      dest,
      signal: ctl.signal,
    }), /取消/);
    assert.equal(fs.existsSync(`${dest}.part`), false);
    slow.server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  fileSrv.server.close();

  console.log('── 状态机 ──');
  ck('合法/非法转换', () => {
    assert.equal(PHASES.includes('ready'), true);
    assert.equal(canTransition('idle', 'checking'), true);
    assert.equal(canTransition('ready', 'installing'), true);
    assert.equal(canTransition('available', 'installing'), false);
    assert.equal(canTransition('installing', 'ready'), false);
  });

  console.log('── updater 端到端 ──');
  const fixture = makeFixture();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p3-upd-'));
  const installRoot = path.join(tmp, 'install');
  const programRoot = path.join(installRoot, 'versions', '0.1.3', 'app');
  const userRoot = path.join(tmp, 'userdata');
  fs.mkdirSync(path.join(installRoot, 'resources'), { recursive: true });
  fs.mkdirSync(programRoot, { recursive: true });
  fs.mkdirSync(userRoot, { recursive: true });
  fs.writeFileSync(path.join(installRoot, 'resources', 'update-pubkey.pem'), fixture.publicKey);

  const live = { raw: Buffer.alloc(0), sig: '' };
  const updSrv = await serve((req, res) => {
    if (req.url === '/latest.json') { res.writeHead(200); res.end(live.raw); return; }
    if (req.url === '/latest.json.sig') { res.writeHead(200); res.end(live.sig); return; }
    if (req.url === `/Estrella-Bot-Setup-${fixture.version}.exe`) {
      const m = /^bytes=(\d+)-/.exec(req.headers.range || '');
      if (m) {
        const start = Number(m[1]);
        res.writeHead(206, {
          'content-range': `bytes ${start}-${fixture.exe.length - 1}/${fixture.exe.length}`,
          'content-length': fixture.exe.length - start,
        });
        res.end(fixture.exe.subarray(start));
        return;
      }
      res.writeHead(200, { 'content-length': fixture.exe.length });
      res.end(fixture.exe);
      return;
    }
    res.writeHead(404); res.end();
  });
  const updBase = `http://127.0.0.1:${updSrv.port}`;
  const liveManifest = {
    ...fixture.manifest,
    installer: {
      ...fixture.manifest.installer,
      url: `${updBase}/Estrella-Bot-Setup-${fixture.version}.exe`,
    },
    notesUrl: `${updBase}/notes`,
  };
  live.raw = Buffer.from(JSON.stringify(liveManifest, null, 2));
  live.sig = sign(null, live.raw, fixture.privateKey).toString('base64');
  const env = {
    QQBOT_UPDATE_TEST: '1',
    QQBOT_UPDATE_MANIFEST_URL: `${updBase}/latest.json`,
  };
  let spawned = null;
  let shutdowns = 0;
  const updater = createUpdater({
    mode: 'installed',
    sandbox: false,
    appVersion: '0.1.3',
    appId: APP_ID,
    updateDir: path.join(userRoot, 'update'),
    installRoot,
    programRoot,
    env,
    publicKeyFile: path.join(installRoot, 'resources', 'update-pubkey.pem'),
    spawnInstaller: async (file, opt) => { spawned = { file, opt }; },
    requestShutdown: () => { shutdowns += 1; },
    logger: () => {},
  });

  await ckA('check → available；download → ready；restore 仍 ready', async () => {
    const s1 = await updater.check({ manual: true });
    assert.equal(s1.phase, 'available');
    assert.equal(s1.latest.version, fixture.version);
    assert.equal(updater.startDownload().phase, 'downloading');
    let ready = null;
    for (let i = 0; i < 100; i += 1) {
      await new Promise((r) => setTimeout(r, 30));
      const s = updater.snapshot();
      if (s.phase === 'ready') { ready = s; break; }
      if (s.phase === 'error') throw new Error(s.error);
    }
    assert.ok(ready, '没有到 ready');
    const restored = createUpdater({
      mode: 'installed',
      sandbox: false,
      appVersion: '0.1.3',
      appId: APP_ID,
      updateDir: path.join(userRoot, 'update'),
      installRoot,
      programRoot,
      env,
      publicKeyFile: path.join(installRoot, 'resources', 'update-pubkey.pem'),
      spawnInstaller: async () => {},
      logger: () => {},
    });
    await restored.restore();
    assert.equal(restored.snapshot().phase, 'ready');
  });

  await ckA('install 只在 ready 且显式调用时 spawn；调用后 installing', async () => {
    const s = await updater.install({ silent: true });
    assert.equal(s.phase, 'installing');
    assert.ok(spawned);
    assert.equal(spawned.opt.silent, true);
    assert.equal(shutdowns, 0); // requestShutdown 在 1.2s 后才触发
    await assert.rejects(() => updater.install({ silent: true }), /还没有下载完成/);
  });

  await ckA('坏签名清单：manual check 报错且不进入 available', async () => {
    const bad = makeFixture({ tamper: true });
    const badSrv = await serve(fileHandler({
      '/latest.json': bad.servedRaw,
      '/latest.json.sig': bad.sig,
    }));
    const u2 = createUpdater({
      mode: 'installed',
      sandbox: false,
      appVersion: '0.1.3',
      appId: APP_ID,
      updateDir: path.join(userRoot, 'update-bad'),
      installRoot,
      programRoot,
      env: { QQBOT_UPDATE_TEST: '1', QQBOT_UPDATE_MANIFEST_URL: `http://127.0.0.1:${badSrv.port}/latest.json` },
      publicKeyFile: path.join(installRoot, 'resources', 'update-pubkey.pem'),
      spawnInstaller: async () => {},
      logger: () => {},
    });
    const s = await u2.check({ manual: true });
    assert.equal(s.phase, 'error');
    assert.match(s.error, /签名无效/);
    badSrv.server.close();
  });

  updSrv.server.close();
  fs.rmSync(tmp, { recursive: true, force: true });

  console.log(`\n${passed}/${passed + failed} passed`);
  if (failed) process.exitCode = 1;
}

main().catch((e) => {
  console.error(`✗ 测试崩溃：${e && e.stack ? e.stack : e}`);
  process.exitCode = 1;
});
