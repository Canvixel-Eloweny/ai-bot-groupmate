/**
 * P6「NapCat 获取与离线放包」的独立验收（2026-10-18）。
 *
 * 覆盖三件事，全都是**行为**而不是文案：
 *   ① 下载器的五道时间上限（连接 / 空闲 / 存活速率 / 单源 / 总预算）真的会在
 *      慢源与挂死源上收工并回退，且"先哈希后改名""续传核 Content-Range""尺寸不符判死"
 *      三条真的生效；
 *   ② knownGood **按哈希反查**（这是 2026-10-18 之前"手放包必红"那个缺陷的正解）；
 *   ③ 离线放包 zip/目录两条路：装得上、原件没被动过、拒绝清单真的拒绝、
 *      并且**一次网络都不碰**（用一个只计数的本机假 API 证明，不靠读代码顺序）。
 *
 * ⚠️ 不打 GitHub：所有"网络"都是 127.0.0.1 上的假服务器 —— 把拷进临时安装根的
 *    `tools/napcat.json` 的 `api` 改指本机即可。预算用注入的 `budgetMs` 缩到毫秒级，
 *    所以这套用例跑完是秒级，不是 5 分钟。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { makeZip } from '../panel/lib/zip.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOLS = path.join(REPO, 'packaging', 'windows', 'tools');
const {
  downloadWithMirrors, CONNECT_TIMEOUT_MS, STALL_TIMEOUT_MS, MIN_ALIVE_BYTES_SEC,
  PER_SOURCE_BUDGET_MS, TOTAL_BUDGET_MS,
} = await import('../packaging/windows/tools/lib/common.mjs');
const {
  assertNapcatSourceSafe, napcatSourceVerdict, napcatKnownDigests, lookupNapcatDigest, napcatOfflineDefault,
} = await import('../packaging/windows/tools/lib/napcat-local.mjs');
const { napcatDigestForTag } = await import('../packaging/windows/tools/lib/versions.mjs');

let failures = 0;
let checks = 0;
function ck(name, fn) {
  checks += 1;
  try { fn(); console.log(`  PASS  ${name}`); }
  catch (e) { failures += 1; console.log(`  FAIL  ${name} — ${e.message}`); }
}
async function ckA(name, fn) {
  checks += 1;
  try { await fn(); console.log(`  PASS  ${name}`); }
  catch (e) { failures += 1; console.log(`  FAIL  ${name} — ${e.message}`); }
}
const tmp = (prefix = 'p6-') => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const QUICK = { connectMs: 400, stallMs: 500, minAliveBytesPerSec: 2000, perSourceMs: 2500, totalMs: 5000 };

// ── 本机假服务器 ─────────────────────────────────────────────────────────────
// 一台服务器多种行为，按 URL 前缀分派；同时记请求次数（离线路径要证明"次数 = 0"）。
function makeServer() {
  const state = { hits: {}, stall: false, badRange: false, wrongSize: false, corruptFirst: false };
  const body = Buffer.alloc(64 * 1024, 7);
  const srv = http.createServer((req, res) => {
    const key = req.url.split('?')[0];
    state.hits[key] = (state.hits[key] || 0) + 1;
    const n = state.hits[key];
    if (key.startsWith('/api/')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ tag_name: 'v9.9.9', assets: [{ name: 'NapCat.Shell.zip', digest: `sha256:${sha(body)}`, size: body.length }] }));
      return;
    }
    if (key.startsWith('/notfound')) { res.writeHead(404); res.end('nope'); return; }
    if (key.startsWith('/stall')) {
      res.writeHead(200, { 'content-length': String(body.length * 2) });
      res.write(body.subarray(0, 8192)); // 发一点就再也不发：模拟"连着但不动"的镜像
      return;
    }
    if (key.startsWith('/badrange')) {
      const range = /bytes=(\d+)-/.exec(req.headers.range || '');
      if (range) { res.writeHead(206, { 'content-range': 'bytes 0-0/1', 'content-length': '1' }); res.end(Buffer.alloc(1)); return; }
      res.writeHead(200, { 'content-length': String(body.length) }); res.end(body); return;
    }
    if (key.startsWith('/wrongsiz')) {
      res.writeHead(200, { 'content-length': String(body.length) });
      res.end(body.subarray(0, 1024)); return; // 声明的总长与实际给的不一致 → 尺寸判死
    }
    if (key.startsWith('/corrupt')) {
      if (n === 1) { res.writeHead(200, { 'content-length': String(body.length) }); res.end(Buffer.alloc(body.length, 9)); return; }
      res.writeHead(200, { 'content-length': String(body.length) }); res.end(body); return;
    }
    if (key.startsWith('/offset')) {
      const m = /bytes=(\d+)-/.exec(req.headers.range || '');
      const from = m ? Number(m[1]) : 0;
      const rest = body.subarray(from);
      res.writeHead(m ? 206 : 200, {
        'content-length': String(rest.length),
        ...(m ? { 'content-range': `bytes ${from}-${body.length - 1}/${body.length}` } : {}),
      });
      res.end(rest); return;
    }
    res.writeHead(200, { 'content-length': String(body.length) }); res.end(body);
  });
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => {
      const base = `http://127.0.0.1:${srv.address().port}`;
      resolve({
        base, state, body, sha256: sha(body),
        url: (p) => `${base}${p}`,
        close: () => new Promise((r) => srv.close(r)),
      });
    });
  });
}

console.log('P6 NapCat 获取 / 离线放包 checks');

// ══ ① 下载器的时间上限与后置动作 ══════════════════════════════════════════════
const srv = await makeServer();
try {
  await ckA('正常下载：字节、尺寸、哈希三者都对，且不留 .part', async () => {
    const t = tmp('p6-dl-');
    const dest = path.join(t, 'NapCat.Shell.zip');
    const r = await downloadWithMirrors([srv.url('/full')], dest, {
      expectedSha256: srv.sha256, expectedSize: srv.body.length, budgetMs: QUICK,
    });
    assert.equal(r.sha256, srv.sha256);
    assert.equal(r.bytes, srv.body.length);
    assert.equal(fs.existsSync(dest), true);
    assert.equal(fs.existsSync(`${dest}.part`), false, '成功后不该留残段');
    fs.rmSync(t, { recursive: true, force: true });
  });

  await ckA('挂死源在空闲超时处被放弃并回退到好源（不是永远等）', async () => {
    const t = tmp('p6-dl-');
    const dest = path.join(t, 'x.zip');
    const t0 = Date.now();
    const r = await downloadWithMirrors([srv.url('/stall'), srv.url('/full')], dest, {
      expectedSha256: srv.sha256, expectedSize: srv.body.length, budgetMs: QUICK,
    });
    const spent = Date.now() - t0;
    assert.equal(r.url, srv.url('/full'));
    assert.ok(spent < QUICK.perSourceMs * 3, `回退花了 ${spent}ms，说明空闲计时没生效`);
    fs.rmSync(t, { recursive: true, force: true });
  });

  await ckA('总预算耗尽 → 抛 code=DOWNLOAD_BUDGET，并且**保留 .part**（下次能续传，不是从头再来）', async () => {
    const t = tmp('p6-dl-');
    const dest = path.join(t, 'x.zip');
    let code = '';
    try {
      await downloadWithMirrors([srv.url('/stall'), srv.url('/stall2')], dest, {
        budgetMs: { ...QUICK, totalMs: 1, stallMs: 300 },
      });
    } catch (e) { code = e.code || ''; }
    assert.equal(code, 'DOWNLOAD_BUDGET');
    assert.ok(fs.existsSync(`${dest}.part`), '被预算收工时应留着残段供下次续传');
    fs.rmSync(t, { recursive: true, force: true });
  });

  await ckA('全部源都是网络错 → code=DOWNLOAD_FAILED（与"太慢"分开说）', async () => {
    const t = tmp('p6-dl-');
    let code = '';
    try {
      await downloadWithMirrors([srv.url('/notfound'), srv.url('/notfound2')], path.join(t, 'x.zip'), { budgetMs: QUICK });
    } catch (e) { code = e.code || ''; }
    assert.equal(code, 'DOWNLOAD_FAILED');
    fs.rmSync(t, { recursive: true, force: true });
  });

  await ckA('续传：Content-Range 起点与残段不符 ⇒ 丢弃残段整份重下（不接错件）', async () => {
    const t = tmp('p6-dl-');
    const dest = path.join(t, 'x.zip');
    write(`${dest}.part`, 'X'.repeat(4096)); // 一段"来历不明"的残段
    const r = await downloadWithMirrors([srv.url('/badrange')], dest, {
      expectedSha256: srv.sha256, expectedSize: srv.body.length, budgetMs: QUICK,
    });
    assert.equal(r.sha256, srv.sha256);
    assert.equal(fs.statSync(dest).size, srv.body.length);
    fs.rmSync(t, { recursive: true, force: true });
  });

  await ckA('续传：起点相符就真接上（只请求后半段）', async () => {
    const t = tmp('p6-dl-');
    const dest = path.join(t, 'x.zip');
    write(`${dest}.part`, srv.body.subarray(0, 16384));
    const before = srv.state.hits['/offset'] || 0;
    const r = await downloadWithMirrors([srv.url('/offset')], dest, {
      expectedSha256: srv.sha256, expectedSize: srv.body.length, budgetMs: QUICK,
    });
    assert.equal(r.sha256, srv.sha256);
    assert.ok((srv.state.hits['/offset'] || 0) > before);
    fs.rmSync(t, { recursive: true, force: true });
  });

  await ckA('尺寸与官方记录不符 → 当场判死，不写 dest', async () => {
    const t = tmp('p6-dl-');
    const dest = path.join(t, 'x.zip');
    let msg = '';
    try {
      // 服务器声明 65536 总长；期望值给一个别的数 ⇒ 在下载当场就该认出"这不是那份件"
      await downloadWithMirrors([srv.url('/wrongsiz')], dest, { expectedSize: srv.body.length + 7, budgetMs: QUICK });
    } catch (e) { msg = e.message; }
    assert.match(msg, /尺寸|大小/);
    assert.equal(fs.existsSync(dest), false, '尺寸不对的件绝不能落到目标路径');
    fs.rmSync(t, { recursive: true, force: true });
  });

  await ckA('哈希不过 → 同源丢弃残段从头重下一次并成功（自愈）', async () => {
    const t = tmp('p6-dl-');
    const dest = path.join(t, 'x.zip');
    const r = await downloadWithMirrors([srv.url('/corrupt')], dest, {
      expectedSha256: srv.sha256, expectedSize: srv.body.length, budgetMs: QUICK,
    });
    assert.equal(r.sha256, srv.sha256);
    assert.ok((srv.state.hits['/corrupt'] || 0) >= 2, '应重试过第二轮');
    fs.rmSync(t, { recursive: true, force: true });
  });

  await ckA('截断流不算成功：宁可报错也不把半份件放到目标路径', async () => {
    const t = tmp('p6-dl-');
    const dest = path.join(t, 'x.zip');
    let threw = false;
    try {
      await downloadWithMirrors([srv.url('/wrongsiz')], dest, { budgetMs: QUICK, expectedSha256: srv.sha256 });
    } catch { threw = true; }
    assert.equal(threw, true, '半份件必须报错');
    assert.equal(fs.existsSync(dest), false, '报错时不许把残件落到 dest');
    fs.rmSync(t, { recursive: true, force: true });
  });

  // ══ ② 时间常量是"具名且在合理区间"（与 §114 同一口径，双向钉）══════════════
  ck('四个具名常量都在区间内（改了值就必须同时改判据，不许悄悄放宽）', () => {
    assert.ok(CONNECT_TIMEOUT_MS >= 5000 && CONNECT_TIMEOUT_MS <= 20000);
    assert.ok(STALL_TIMEOUT_MS >= 10000 && STALL_TIMEOUT_MS <= 60000);
    assert.ok(PER_SOURCE_BUDGET_MS >= 30000 && PER_SOURCE_BUDGET_MS <= 600000);
    assert.ok(TOTAL_BUDGET_MS >= 60000 && TOTAL_BUDGET_MS <= 900000);
    assert.ok(TOTAL_BUDGET_MS >= PER_SOURCE_BUDGET_MS);
    assert.ok(MIN_ALIVE_BYTES_SEC >= 1000);
  });

  // ══ ③ knownGood 按哈希反查（那个既有缺陷的回归钉）═══════════════════════════
  ck('knownGood 反查：命中给版本、不命中给 null（离线件的唯一认法）', () => {
    const src = { knownGood: [{ tag: 'v1.2.3', sha256: 'a'.repeat(64), size: 10 }, { tag: 'v9.9.9', sha256: 'b'.repeat(64), size: 20 }] };
    assert.equal(lookupNapcatDigest(src, 'A'.repeat(64)).tag, 'v1.2.3', '大小写必须归一');
    assert.equal(lookupNapcatDigest(src, 'c'.repeat(64)), null);
    assert.equal(napcatKnownDigests({ knownGood: [{ tag: 'x', sha256: '短' }] }).length, 0, '坏行要被过滤掉');
  });

  ck('napcatOfflineDefault 取语义最新的一行（不是数组最后一行，也不是 fallbackTag）', () => {
    const src = { knownGood: [
      { tag: 'v4.18.9', sha256: 'a'.repeat(64), size: 1 },
      { tag: 'v4.18.38', sha256: 'b'.repeat(64), size: 2 },
      { tag: 'v4.18.35', sha256: 'c'.repeat(64), size: 3 },
    ] };
    assert.equal(napcatOfflineDefault(src).tag, 'v4.18.38');
    assert.equal(napcatOfflineDefault({ knownGood: [] }), null);
  });

  ck('发布清单本身：assetMinBytes ≥ 8,000,000 且 fallback 与 knownGood 同源', () => {
    const cfg = JSON.parse(fs.readFileSync(path.join(TOOLS, 'napcat.json'), 'utf8'));
    assert.ok(cfg.assetMinBytes >= 8_000_000, 'OneKey 壳 994,134 字节，地板被 lowers 就等于放行错件');
    const list = napcatKnownDigests(cfg);
    assert.ok(list.length >= 2 && list.length <= 6);
    assert.ok(list.some((e) => e.sha256 === String(cfg.fallbackSha256).toLowerCase()));
    assert.ok(list.some((e) => e.tag === cfg.fallbackTag));
    assert.equal(cfg.asset, 'NapCat.Shell.zip');
  });

  await ckA('napcatDigestForTag：API 拿不到时对**任何**清单内版本都给哈希与尺寸（缺陷回归）', async () => {
    const cfg = {
      api: `${srv.base}/api/none`, asset: 'NapCat.Shell.zip', repo: 'NapNeko/NapCatQQ',
      fallbackTag: 'v0.0.1', fallbackSha256: 'f'.repeat(64),
      knownGood: [{ tag: 'v4.18.35', sha256: '0'.repeat(64).replace(/0/g, '0'), size: 29484382 }],
    };
    cfg.knownGood[0].sha256 = '0'.repeat(64);
    const got = await napcatDigestForTag(cfg, 'v4.18.35');
    assert.ok(got, '以前这里返回 null ⇒ 一份没校验的 35MB 可执行件');
    assert.equal(got.sha256, '0'.repeat(64));
    assert.equal(got.size, 29484382);
    const none = await napcatDigestForTag(cfg, 'v1.1.1');
    assert.equal(none, null, '清单里没有的版本不许编造哈希');
  });

  // ══ ④ 选取路径的安全拒绝（纯函数，按 win32 形状判）══════════════════════════
  const INST = 'C:\\Users\\Moon\\AppData\\Local\\Programs\\Estrella-Bot';
  const UD = 'C:\\Users\\Moon\\AppData\\Local\\EstrellaBot\\userdata';
  const env = { USERPROFILE: 'C:\\Users\\Moon', WINDIR: 'C:\\Windows' };
  const guard = (srcPath, kind = 'zip') => assertNapcatSourceSafe(srcPath, {
    kind, installRoot: INST, userRoot: UD, napcatDir: `${UD}\\napcat`, env, platform: 'win32',
  });
  ck('拒绝清单：盘根 / 个人目录 / 桌面 / Windows 目录 / 安装根 / 用户根 / 协议端目录本身与其内部', () => {
    for (const badOne of [
      'C:\\', 'C:\\Users\\Moon', 'C:\\Users\\Moon\\Desktop', 'C:\\Windows',
      INST, UD, `${UD}\\napcat`, `${UD}\\napcat\\NapCat.Shell.zip`, `${INST}\\versions`,
      '\\\\nas\\share\\NapCat.Shell.zip',
    ]) {
      const r = guard(badOne);
      assert.equal(r.ok, false, `这个路径本应被拒：${badOne}`);
    }
  });
  ck('拒绝清单：太长（MAX_PATH 会在复制中途炸）与形状不对（zip 必须是文件、folder 必须是目录）', () => {
    assert.equal(guard(`D:\\${'a'.repeat(250)}`).ok, false);
    const r = guard('C:\\Windows\\System32\\drivers\\etc\\hosts', 'zip');
    assert.equal(r.ok, false, 'Windows 目录本身就该被拒');
  });
  ck('纯判据：个人目录的子目录放行，根本身 / 桌面根 / Windows 目录仍拒（win32 形状）', () => {
    const v = (raw) => napcatSourceVerdict(raw, {
      platform: 'win32', installRoot: INST, userRoot: UD, napcatDir: `${UD}\\napcat`,
      profile: 'C:\\Users\\Moon', windir: 'C:\\Windows',
    });
    // 2026-10-19 群友真机：这两条正是"按提示解压到下载/桌面"的真实路径，以前必拒。
    for (const good of [
      'C:\\Users\\Moon\\Downloads\\NapCat.Shell',
      'C:\\Users\\Moon\\Desktop\\NapCat.Shell',
      'D:\\NapCat\\NapCat.Shell',
    ]) {
      const r = v(good);
      assert.equal(r.ok, true, `这个路径本应放行：${good}（实测 ${r.code || 'ok'}）`);
    }
    for (const badOne of [
      'C:\\Users\\Moon', 'C:\\Users', 'C:\\Users\\Moon\\Desktop', 'C:\\Windows',
      'C:\\Windows\\System32', INST, UD, `${UD}\\napcat`, `${INST}\\versions`,
      'C:\\', '\\\\nas\\share\\NapCat.Shell',
    ]) {
      const r = v(badOne);
      assert.equal(r.ok, false, `这个路径本应被拒：${badOne}`);
    }
  });
  ck('放行：用户 %USERPROFILE%\\Downloads 里的正常一件（带真实 HOME，防"env 为空"假绿）', () => {
    const t = tmp('p6-guard-');
    const home = path.join(t, 'home');
    const okFile = path.join(home, 'Downloads', 'NapCat.Shell.zip');
    write(okFile, 'x');
    const r = assertNapcatSourceSafe(okFile, {
      kind: 'zip', installRoot: path.join(t, 'inst'), userRoot: path.join(t, 'ud'),
      napcatDir: path.join(t, 'ud', 'napcat'),
      env: { USERPROFILE: home, WINDIR: path.join(t, 'windows') }, platform: process.platform,
    });
    assert.equal(r.ok, true, r.error);
    // 同一棵树里，个人目录根本身必须仍拒。
    const rootPick = assertNapcatSourceSafe(home, {
      kind: 'folder', installRoot: path.join(t, 'inst'), userRoot: path.join(t, 'ud'),
      napcatDir: path.join(t, 'ud', 'napcat'),
      env: { USERPROFILE: home, WINDIR: path.join(t, 'windows') }, platform: process.platform,
    });
    assert.equal(rootPick.ok, false, '选个人目录根本身必须拒绝');
    fs.rmSync(t, { recursive: true, force: true });
  });
  ck('pathEq 与 pathInside 都要用：相等不算 inside（只调一个会漏掉"正好选到 NAPCAT_DIR"）', () => {
    const t = tmp('p6-guard-');
    const dir = path.join(t, 'ud', 'napcat');
    fs.mkdirSync(dir, { recursive: true });
    const zip = path.join(dir, 'NapCat.Shell.zip');
    write(zip, 'x');
    const r = assertNapcatSourceSafe(zip, {
      kind: 'zip', installRoot: path.join(t, 'inst'), userRoot: path.join(t, 'ud'),
      napcatDir: dir, env: {}, platform: process.platform,
    });
    assert.equal(r.ok, false, '选到我们自己的协议端目录里那份 zip，必须拒');
    fs.rmSync(t, { recursive: true, force: true });
  });
} finally {
  await srv.close();
}

// ══ ⑤ 离线放包端到端（子进程，装进临时"安装根"，零网络）═══════════════════════
function makeInstall(prefix = 'p6-inst-') {
  const t = tmp(prefix);
  const inst = path.join(t, 'inst');
  const ud = path.join(t, 'userdata');
  const app = path.join(inst, 'versions', '0.1.3', 'app');
  fs.mkdirSync(app, { recursive: true });
  for (const rel of ['src']) fs.cpSync(path.join(REPO, rel), path.join(app, rel), { recursive: true });
  for (const rel of ['package.json', 'config.example.json']) fs.copyFileSync(path.join(REPO, rel), path.join(app, rel));
  fs.cpSync(TOOLS, path.join(inst, 'tools'), { recursive: true });
  fs.writeFileSync(path.join(inst, 'install.json'), JSON.stringify({
    schema: 1, appId: 'com.estrellabot.windows', installRoot: inst, userRoot: ud, installedVersion: '0.1.3',
  }, null, 2));
  fs.writeFileSync(path.join(inst, 'current.json'), JSON.stringify({ schema: 1, current: '0.1.3', previous: null, health: 'ok', failures: 0 }, null, 2));
  return { t, inst, ud, app };
}

// 假 NapCat：目录形状照官方的来（launcher-user.bat + napcat.mjs 带版本串）。
// filler 那条是故意的：真实官方包 28–34MB，夹具必须**高于** assetMinBytes 地板，
// 否则它会被尺寸闸正确地拒掉 —— 那就不再是在测"能不能装上"了。
function napcatZipBuffer(version = '4.18.35') {
  return makeZip([
    { name: 'NapCat.Shell/launcher-user.bat', text: '@echo off\r\nrem napcat launcher\r\n' },
    { name: 'NapCat.Shell/NapCatWinBootMain.exe', text: 'MZ-fake' },
    { name: 'NapCat.Shell/napcat.mjs', text: `const Qj = {}; const V = "${version}";\n` },
    { name: 'NapCat.Shell/config/onebot11.json', text: '{}' },
    { name: 'NapCat.Shell/assets/filler.txt', text: 'x'.repeat(6000) },
  ]);
}

function rewriteNapcatCfg(inst, { api, knownGood, assetMinBytes = 2000 }) {
  const cfg = {
    repo: 'NapNeko/NapCatQQ', api,
    asset: 'NapCat.Shell.zip', assetMinBytes,
    fallbackTag: (knownGood[0] || {}).tag || 'v0.0.0',
    fallbackSha256: (knownGood[0] || {}).sha256 || 'f'.repeat(64),
    knownGood,
    downloadTemplate: 'https://github.com/{repo}/releases/download/{tag}/{asset}',
    mirrors: [], manual: { page: 'x', asset: 'NapCat.Shell.zip', note: 'x' },
  };
  fs.writeFileSync(path.join(inst, 'tools', 'napcat.json'), JSON.stringify(cfg, null, 2));
  return cfg;
}

function runChild(inst, ud, scriptRel, args) {
  return spawnSync(process.execPath, [path.join(inst, 'tools', scriptRel), ...args], {
    cwd: inst, encoding: 'utf8', timeout: 60000,
    env: {
      ...process.env, QQBOT_MODE: 'installed', QQBOT_USER_ROOT: ud,
      QQBOT_CONFIG: path.join(ud, 'config.json'), NODE_OPTIONS: '',
    },
  });
}

function childJson(r) {
  const line = String(r.stdout || '').split('\n').find((l) => l.startsWith('JSON:'));
  if (!line) throw new Error(`子进程没给 JSON：status=${r.status}\n${r.stdout}\n${r.stderr}`);
  return JSON.parse(line.slice(5));
}

// 放包用的子进程脚本（写进拷贝出来的 tools/ 里，相对 import 才对）
const PLACER = `
import { placeNapcatFromLocal } from './lib/napcat-local.mjs';
import { napcatInstalled } from './lib/versions.mjs';
const [kind, src, installRoot, userRoot] = process.argv.slice(2);
const r = await placeNapcatFromLocal({ kind, src, installRoot, userRoot });
const cur = napcatInstalled();
console.log('JSON:' + JSON.stringify({
  status: r.status, state: r.state, tag: r.tag, verification: r.verification,
  error: r.error || '', note: r.note || '',
  found: cur.found, inferred: cur.inferredFrom, version: cur.version,
}));
`;

ck('放置：清单内的 zip → OK + 写 tag + 原件一字节没动（这是"只复制"的硬证）', () => {
  const { t, inst, ud } = makeInstall();
  try {
    const zipBuf = napcatZipBuffer('4.18.35');
    const srcDir = path.join(t, 'downloads');
    write(path.join(srcDir, 'NapCat.Shell.zip'), zipBuf);
    const srcFile = path.join(srcDir, 'NapCat.Shell.zip');
    const before = sha(fs.readFileSync(srcFile));
    rewriteNapcatCfg(inst, { api: 'http://127.0.0.1:1/api/latest', knownGood: [{ tag: 'v4.18.35', sha256: sha(zipBuf), size: zipBuf.length, provenance: 'test' }] });
    write(path.join(inst, 'tools', 'p6-placer.mjs'), PLACER);
    const r = runChild(inst, ud, 'p6-placer.mjs', ['zip', srcFile, inst, ud]);
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    const j = childJson(r);
    assert.equal(j.status, 'OK');
    assert.equal(j.tag, 'v4.18.35');
    assert.equal(j.verification, 'official-digest');
    assert.equal(j.found, true);
    assert.equal(sha(fs.readFileSync(srcFile)), before, '用户带来的原件被改动过 —— 这是纪律 ①');
    // 官方 zip 里若套着一层目录，装完必须是**平**的：启动器直接住在 userdata\napcat\。
    // 2026-10-18 VM 实测踩到过反例：rename(staging) 把包装目录一起带进来，
    // 装得上但起不来（napcat\NapCat.Shell\launcher-user.bat）。
    assert.equal(fs.existsSync(path.join(ud, 'napcat', 'launcher-user.bat')), true, '启动器必须落在 napcat 根');
    assert.equal(fs.existsSync(path.join(ud, 'napcat', 'NapCat.Shell')), false, '包装目录必须被压平');
    assert.equal(fs.readdirSync(ud).filter((n) => n.startsWith('napcat.new-')).length, 0, '暂存目录没清');
  } finally { fs.rmSync(t, { recursive: true, force: true }); }
});

ck('放置：清单外的 zip → MISMATCH 但装上，tag 留空（于是日后不会被自动覆盖）', () => {
  const { t, inst, ud } = makeInstall();
  try {
    const zipBuf = napcatZipBuffer('4.18.99');
    write(path.join(t, 'd', 'NapCat.Shell.zip'), zipBuf);
    rewriteNapcatCfg(inst, { api: 'http://127.0.0.1:1/api/latest', knownGood: [{ tag: 'v4.18.35', sha256: 'a'.repeat(64), size: 5000, provenance: 'test' }] });
    write(path.join(inst, 'tools', 'p6-placer.mjs'), PLACER);
    const r = runChild(inst, ud, 'p6-placer.mjs', ['zip', path.join(t, 'd', 'NapCat.Shell.zip'), inst, ud]);
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    const j = childJson(r);
    assert.equal(j.status, 'MISMATCH');
    assert.equal(j.tag, '');
    assert.equal(j.inferred, '', '未证明版本的件不能被认成"本包装的"（否则升级会自动覆盖它）');
    const rec = JSON.parse(fs.readFileSync(path.join(ud, 'napcat', 'INSTALLED.json'), 'utf8'));
    assert.equal(rec.verification, 'unverified-mismatch');
    assert.equal(rec.sourceKind, 'zip');
    assert.ok(rec.sourcePath.length > 0, '没记下原件路径，日后无法回答"这东西哪来的"');
  } finally { fs.rmSync(t, { recursive: true, force: true }); }
});

ck('放置：994KB 那种"安装壳"尺寸 → 直接拒，且点名 OneKey', () => {
  const { t, inst, ud } = makeInstall();
  try {
    write(path.join(t, 'd', 'NapCat.Shell.Windows.OneKey.zip'), 'z'.repeat(900));
    rewriteNapcatCfg(inst, { api: 'http://127.0.0.1:1/api/latest', knownGood: [{ tag: 'v4.18.35', sha256: 'a'.repeat(64), size: 5000, provenance: 'test' }] });
    write(path.join(inst, 'tools', 'p6-placer.mjs'), PLACER);
    const r = runChild(inst, ud, 'p6-placer.mjs', ['zip', path.join(t, 'd', 'NapCat.Shell.Windows.OneKey.zip'), inst, ud]);
    const j = childJson(r);
    assert.equal(j.status, 'REFUSED');
    assert.match(String(j.error), /OneKey/);
    assert.equal(fs.existsSync(path.join(ud, 'napcat')), false, '拒了就不该在用户根里留下任何东西');
  } finally { fs.rmSync(t, { recursive: true, force: true }); }
});

ck('放置：已解压目录（有启动器）→ UNVERIFIED 装上；没有启动器的目录 → 拒', () => {
  const { t, inst, ud } = makeInstall();
  try {
    const good = path.join(t, 'unzipped', 'NapCat.Shell');
    write(path.join(good, 'launcher-user.bat'), '@echo off\r\n');
    write(path.join(good, 'napcat.mjs'), 'const V = "4.18.35";\n');
    write(path.join(good, 'NapCatWinBootMain.exe'), 'MZ');
    write(path.join(good, 'NapCatInstaller.exe'), 'MZ'); // 这一份必须不被当启动器
    write(path.join(good, 'config', 'onebot11.json'), '{}');
    rewriteNapcatCfg(inst, { api: 'http://127.0.0.1:1/api/latest', knownGood: [{ tag: 'v4.18.35', sha256: 'a'.repeat(64), size: 5000, provenance: 'test' }] });
    write(path.join(inst, 'tools', 'p6-placer.mjs'), PLACER);
    const r = runChild(inst, ud, 'p6-placer.mjs', ['folder', good, inst, ud]);
    const j = childJson(r);
    assert.equal(j.status, 'UNVERIFIED', `${r.stdout}${r.stderr}`);
    assert.equal(j.found, true);
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
    const placed = walk(path.join(ud, 'napcat')).map((p) => path.basename(p));
    assert.ok(placed.includes('launcher-user.bat'), `复制后启动器不见了：${placed.join(',')}`);
    assert.equal(fs.existsSync(path.join(ud, 'napcat', 'launcher-user.bat')), true, '目录形态也要落在 napcat 根');
    // 用户选**外层目录**（里面套一层 NapCat.Shell/）也要压平 —— 实测这条以前会套两层
    const outer = path.join(t, 'unzipped');
    const t3 = makeInstall('p6-inst3-');
    rewriteNapcatCfg(t3.inst, { api: 'http://127.0.0.1:1/api/latest', knownGood: [{ tag: 'v4.18.35', sha256: 'a'.repeat(64), size: 5000, provenance: 'test' }] });
    write(path.join(t3.inst, 'tools', 'p6-placer.mjs'), PLACER);
    const r3 = runChild(t3.inst, t3.ud, 'p6-placer.mjs', ['folder', outer, t3.inst, t3.ud]);
    assert.equal(childJson(r3).status, 'UNVERIFIED', '选外层目录仍然要能装（自动找到含启动器的那一层）');
    assert.equal(fs.existsSync(path.join(t3.ud, 'napcat', 'launcher-user.bat')), true, '外层目录必须被压平到 napcat 根');
    fs.rmSync(t3.t, { recursive: true, force: true });
    assert.ok(placed.includes('NapCatInstaller.exe'), '原件里有的文件要一并保住（复制整棵子树）');

    const t2 = makeInstall('p6-inst2-');
    const junk = path.join(t2.t, 'junk');
    write(path.join(junk, 'package.json'), '{}');
    write(path.join(junk, 'README.md'), 'x');
    rewriteNapcatCfg(t2.inst, { api: 'http://127.0.0.1:1/api/latest', knownGood: [{ tag: 'v4.18.35', sha256: 'a'.repeat(64), size: 5000, provenance: 'test' }] });
    write(path.join(t2.inst, 'tools', 'p6-placer.mjs'), PLACER);
    const r2 = runChild(t2.inst, t2.ud, 'p6-placer.mjs', ['folder', junk, t2.inst, t2.ud]);
    assert.equal(childJson(r2).status, 'REFUSED', '没有启动器的目录不能当 NapCat 装');
    fs.rmSync(t2.t, { recursive: true, force: true });
  } finally { fs.rmSync(t, { recursive: true, force: true }); }
});

// ── P11 面板「自动查找并安装」：扫描常见目录 → 复用放置逻辑（只复制）────────────
const PROBE_INSTALLED = `
import { napcatInstalled } from './lib/versions.mjs';
console.log('JSON:' + JSON.stringify(napcatInstalled()));
`;

ck('自动查找：Downloads 里已解压的 NapCat → 一键装进 userdata\\napcat（原件不动）', () => {
  const { t, inst, ud } = makeInstall();
  try {
    const src = path.join(t, 'home', 'Downloads', 'NapCat.Shell');
    write(path.join(src, 'launcher-user.bat'), '@echo off\r\n');
    write(path.join(src, 'NapCatWinBootMain.exe'), 'MZ-fake');
    write(path.join(src, 'napcat.mjs'), 'const V = "4.18.38";\n');
    const r = runChild(inst, ud, 'import-napcat.mjs', ['--install-root', inst, '--user-root', ud, '--roots', path.join(t, 'home', 'Downloads')]);
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    const j = childJson(r);
    assert.equal(j.action, 'imported');
    assert.equal(j.from, src);
    assert.equal(j.status, 'UNVERIFIED', '自己带来的文件夹没有官方哈希，应记未校验');
    assert.equal(fs.existsSync(path.join(ud, 'napcat', 'launcher-user.bat')), true, '启动器必须落进 userdata\\napcat');
    assert.equal(fs.existsSync(path.join(src, 'launcher-user.bat')), true, '原件被移动/删除了 —— 纪律 ①');
    write(path.join(inst, 'tools', 'p6-probe.mjs'), PROBE_INSTALLED);
    const p = childJson(runChild(inst, ud, 'p6-probe.mjs', []));
    assert.equal(p.found, true, '导入之后"装没装"必须立即为真');
  } finally { fs.rmSync(t, { recursive: true, force: true }); }
});

ck('自动查找：已经装好时不覆盖（第二次只回 already）', () => {
  const { t, inst, ud } = makeInstall();
  try {
    const src = path.join(t, 'home', 'Desktop', 'NapCat.Shell');
    write(path.join(src, 'launcher-user.bat'), '@echo off\r\n');
    const roots = path.join(t, 'home', 'Desktop');
    const first = childJson(runChild(inst, ud, 'import-napcat.mjs', ['--install-root', inst, '--user-root', ud, '--roots', roots]));
    assert.equal(first.action, 'imported');
    write(path.join(ud, 'napcat', 'config', 'keep.txt'), 'login state');
    const second = childJson(runChild(inst, ud, 'import-napcat.mjs', ['--install-root', inst, '--user-root', ud, '--roots', roots]));
    assert.equal(second.action, 'already', '已装好时不许再复制一遍');
    assert.equal(fs.existsSync(path.join(ud, 'napcat', 'config', 'keep.txt')), true, '已装的那份配置被覆盖了');
  } finally { fs.rmSync(t, { recursive: true, force: true }); }
});

ck('自动查找：找不到时如实说 not-found（不凭空建目录）', () => {
  const { t, inst, ud } = makeInstall();
  try {
    const roots = path.join(t, 'empty');
    fs.mkdirSync(roots, { recursive: true });
    const r = runChild(inst, ud, 'import-napcat.mjs', ['--install-root', inst, '--user-root', ud, '--roots', roots]);
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    const j = childJson(r);
    assert.equal(j.action, 'not-found');
    assert.equal(fs.existsSync(path.join(ud, 'napcat')), false, '没找到就不该在用户根里留下目录');
  } finally { fs.rmSync(t, { recursive: true, force: true }); }
});

// ── bootstrap 分派：skip / zip / auto 三条 + 零网络证明 ──────────────────────
ck('bootstrap --napcat-mode skip：不联网、状态 SKIPPED、setup-state 记的是事实（没装）', () => {
  const { t, inst, ud } = makeInstall();
  try {
    const apiCount = 5; // 指向一个没人听的端口；真去访问会立刻失败，不会等 8 秒
    rewriteNapcatCfg(inst, { api: 'http://127.0.0.1:1/api/latest', knownGood: [{ tag: 'v4.18.35', sha256: 'a'.repeat(64), size: 5000, provenance: 'test' }] });
    void apiCount;
    const r = runChild(inst, ud, 'bootstrap.mjs', ['--install-root', inst, '--user-root', ud, '--napcat-mode', 'skip']);
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    const st = fs.readFileSync(path.join(ud, 'update', 'napcat-status.txt'), 'utf8').trim().split('\n');
    assert.equal(st[0], 'SKIPPED');
    const mark = JSON.parse(fs.readFileSync(path.join(ud, 'setup-state.json'), 'utf8'));
    assert.equal(mark.napcatInstalled, false);
    assert.equal(mark.napcatMode, 'skip');
    assert.equal(fs.existsSync(path.join(ud, 'napcat')), false);
  } finally { fs.rmSync(t, { recursive: true, force: true }); }
});

ckA('bootstrap --napcat-mode zip：全程零 API 请求（离线可用的硬证，不靠读代码顺序）', async () => {
  const { t, inst, ud } = makeInstall();
  const srv2 = await makeCountingServer();
  try {
    const zipBuf = napcatZipBuffer('4.18.35');
    write(path.join(t, 'd', 'NapCat.Shell.zip'), zipBuf);
    rewriteNapcatCfg(inst, {
      api: `${srv2.base}/api/latest`,
      knownGood: [{ tag: 'v4.18.35', sha256: sha(zipBuf), size: zipBuf.length, provenance: 'test' }],
    });
    const r = runChild(inst, ud, 'bootstrap.mjs', [
      '--install-root', inst, '--user-root', ud,
      '--napcat-mode', 'zip', '--napcat-src', path.join(t, 'd', 'NapCat.Shell.zip'),
    ]);
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.equal(srv2.hits, 0, `本地件这条路请求了 ${srv2.hits} 次 GitHub API（应恒为 0）`);
    const st = fs.readFileSync(path.join(ud, 'update', 'napcat-status.txt'), 'utf8').trim().split('\n');
    assert.equal(st[0], 'OK');
    assert.equal(JSON.parse(fs.readFileSync(path.join(ud, 'setup-state.json'), 'utf8')).napcatInstalled, true);
  } finally { await srv2.close(); fs.rmSync(t, { recursive: true, force: true }); }
});

ck('毒目录回归：napcat 里只有旧 .part 时，auto 路必须真的尝试，不许报 OK/unchanged', () => {
  const { t, inst, ud } = makeInstall();
  try {
    // 2026-10-19 VM 真机的原样状态：协议端目录里只有一个下载残片。
    fs.mkdirSync(path.join(ud, 'napcat'), { recursive: true });
    write(path.join(ud, 'napcat', 'NapCat.Shell.zip.part'), 'x'.repeat(1024));
    const cfg = rewriteNapcatCfg(inst, {
      api: 'http://127.0.0.1:1/api/latest',
      knownGood: [{ tag: 'v4.18.35', sha256: 'a'.repeat(64), size: 5000, provenance: 'test' }],
    });
    // ⚠️ 不能挂本地假服务器：runChild 是 spawnSync，父进程被阻塞时假服务器接不了连接，
    //    那条路会被误判成"超时"(SLOW)。端口 1 必然立刻 ECONNREFUSED → DOWNLOAD_FAILED。
    cfg.downloadTemplate = 'http://127.0.0.1:1/dl/{repo}/releases/download/{tag}/{asset}';
    fs.writeFileSync(path.join(inst, 'tools', 'napcat.json'), JSON.stringify(cfg, null, 2));
    const r = runChild(inst, ud, 'bootstrap.mjs', [
      '--install-root', inst, '--user-root', ud, '--napcat-mode', 'auto', '--install-napcat', '1',
    ]);
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    const st = fs.readFileSync(path.join(ud, 'update', 'napcat-status.txt'), 'utf8').trim().split('\n');
    assert.notEqual(st[0], 'OK', `毒目录下不许写 OK（这就是群友看到的"假成功"）—— 实际 ${st[0]}`);
    assert.equal(st[0], 'FAILED', `连不上源应记 FAILED（不是"太慢"）；实际 ${st[0]}`);
    assert.equal(JSON.parse(fs.readFileSync(path.join(ud, 'setup-state.json'), 'utf8')).napcatInstalled, false);
    assert.equal(fs.existsSync(path.join(ud, 'napcat', 'NapCat.Shell.zip.part')), false, '旧残片应被清理');
    assert.deepEqual(fs.readdirSync(path.join(ud, 'napcat')), [], '协议端目录里不该再出现新的下载残片');
    assert.equal(fs.existsSync(path.join(ud, 'update', 'downloads')), true, '下载临时区应落在 update\\downloads');
  } finally { fs.rmSync(t, { recursive: true, force: true }); }
});

ck('bootstrap 老写法 --install-napcat 0：等价于 skip（向后兼容，且不会因此变红）', () => {
  const { t, inst, ud } = makeInstall();
  try {
    rewriteNapcatCfg(inst, { api: 'http://127.0.0.1:1/api/latest', knownGood: [{ tag: 'v4.18.35', sha256: 'a'.repeat(64), size: 5000, provenance: 'test' }] });
    const r = runChild(inst, ud, 'bootstrap.mjs', ['--install-root', inst, '--user-root', ud, '--install-napcat', '0']);
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.equal(fs.readFileSync(path.join(ud, 'update', 'napcat-status.txt'), 'utf8').trim().split('\n')[0], 'SKIPPED');
  } finally { fs.rmSync(t, { recursive: true, force: true }); }
});

console.log(`\n${failures ? '✗' : '✓'} ${checks - failures}/${checks} passed${failures ? ` · 失败 ${failures}` : ''}`);
if (failures) process.exitCode = 1;

async function makeCountingServer() {
  const srv = http.createServer((req, res) => { srv.hits += 1; res.writeHead(500); res.end('{}'); });
  srv.hits = 0;
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return {
    base: `http://127.0.0.1:${srv.address().port}`,
    get hits() { return srv.hits; },
    close: () => new Promise((r) => srv.close(r)),
  };
}
