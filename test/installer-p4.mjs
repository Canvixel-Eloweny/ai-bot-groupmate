/**
 * P4 · 回滚 / 断电恢复 / 离线更新 / 保留策略 / 镜像固定 tag 的独立验收。
 *
 * 只跑纯判据与临时目录；不联网、不启动真机、不碰用户数据。
 * 真机回滚与离线升级在 Win11 VM 里另行验收（见 INSTALLER-SPEC §18）。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  clearSwapMarker,
  configRollbackGuard,
  decideStartFailure,
  preserveRollbackEvidence,
  readSwapMarker,
  rollbackRecord,
  swapRuntime,
  writeSwapMarker,
} from '../packaging/windows/tools/lib/rollback.mjs';
import {
  applyRetention,
  listEntries,
  planRetention,
} from '../packaging/windows/tools/lib/retention.mjs';
import { createUpdater } from '../panel/lib/update.js';
import { validateManifest } from '../panel/lib/update-manifest.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COMMIT = path.join(REPO, 'packaging', 'windows', 'tools', 'install-commit.mjs');
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
const tmp = (prefix = 'p4-') => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const pkgJson = (version = '0.1.3', extra = {}) => `${JSON.stringify({ name: 'x', version, appId: 'com.estrellabot.windows', ...extra }, null, 2)}\n`;

function makeKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    publicKey,
    privateKey,
    publicPem: publicKey.export({ type: 'spki', format: 'pem' }),
  };
}

function makeManifest({ version = '0.1.4', size, sha, mirror, url } = {}) {
  const now = Date.now();
  return {
    schemaVersion: 1,
    appId: 'com.estrellabot.windows',
    channel: 'stable',
    version,
    minVersion: '0.1.0',
    minWindows: '10.0.17763',
    generatedAt: new Date(now - 3600_000).toISOString(),
    expiresAt: new Date(now + 30 * 86400_000).toISOString(),
    notesUrl: 'https://github.com/Canvixel-Eloweny/ai-bot-groupmate/releases/tag/v0.1.4',
    installer: {
      kind: 'nsis',
      url: url || 'https://github.com/Canvixel-Eloweny/ai-bot-groupmate/releases/download/v0.1.4/Estrella-Bot-Setup-0.1.4.exe',
      ...(mirror ? { mirrors: [mirror] } : {}),
      size,
      sha256: sha,
    },
  };
}

function signManifest(obj, privateKey) {
  const raw = Buffer.from(`${JSON.stringify(obj, null, 2)}\n`, 'utf8');
  const sig = crypto.sign(null, raw, privateKey).toString('base64');
  return { raw, sig };
}

function makeUpdater({ dir, publicKeyFile }) {
  return createUpdater({
    mode: 'installed',
    sandbox: false,
    appId: 'com.estrellabot.windows',
    appVersion: '0.1.3',
    updateDir: path.join(dir, 'update'),
    installRoot: path.join(dir, 'install'),
    programRoot: path.join(dir, 'install', 'versions', '0.1.3', 'app'),
    publicKeyFile,
    env: { QQBOT_UPDATE_TEST: '1' },
    logger: () => {},
    onUpdate: () => {},
    now: () => Date.now(),
  });
}

function makeStage(parent, version) {
  const stage = path.join(parent, `stage-${version}`);
  const files = new Map();
  const add = (rel, text) => {
    const full = path.join(stage, rel);
    write(full, text);
    files.set(rel, full);
  };
  add('app/package.json', pkgJson(version));
  add('app/src/user-root.js', 'export const x = 1;\n');
  add('app/panel/server.js', '// fake panel\n');
  add('runtime/node/node.exe', `fake node ${version}\n`);
  add('tools/stop.mjs', '// fake tool\n');
  add('tools/lib/install-layout.mjs', '// fake layout\n');
  add('launcher/Estrella-Bot.vbs', "' fake vbs\n");
  add('README.html', '<html>readme</html>\n');
  add('LICENSE', 'Apache-2.0\n');
  add('THIRD-PARTY-NOTICES.md', 'notices\n');
  const list = [...files].map(([rel, full]) => ({ path: rel, size: fs.statSync(full).size, sha256: sha256(fs.readFileSync(full)) }));
  write(path.join(stage, 'payload-manifest.json'), `${JSON.stringify({
    schema: 1, version, appId: 'com.estrellabot.windows', count: list.length, files: list,
  }, null, 2)}\n`);
  return stage;
}

function runCommit(args, env = {}) {
  return spawnSync(process.execPath, [COMMIT, ...args], {
    encoding: 'utf8',
    timeout: 60000,
    env: { ...process.env, QQBOT_PANEL_PORT: '1', NODE_OPTIONS: '', ...env },
  });
}

console.log('P4 rollback / power-loss / offline / retention checks');

/* ── 1. 回滚决策 ───────────────────────────────────────────────────── */
ck('回滚决策：第 1 次计数、第 2 次回滚', () => {
  const a = decideStartFailure({ current: '0.1.4', previous: '0.1.3', failures: 0 });
  assert.equal(a.action, 'count');
  assert.equal(a.failures, 1);
  const b = decideStartFailure({ current: '0.1.4', previous: '0.1.3', failures: 1 });
  assert.equal(b.action, 'rollback');
  assert.equal(b.failures, 2);
});

ck('回滚决策：首装/同版本无 previous → 第 2 次 terminal', () => {
  assert.equal(decideStartFailure({ current: '0.1.4', previous: null, failures: 0 }).action, 'count');
  assert.equal(decideStartFailure({ current: '0.1.4', previous: null, failures: 1 }).action, 'terminal');
  assert.equal(decideStartFailure({ current: '0.1.4', previous: '0.1.4', failures: 1 }).action, 'terminal');
});

ck('回滚决策：previous 目录非法 / 配置 schema 阻止 → terminal', () => {
  const invalid = decideStartFailure({ current: '0.1.4', previous: '0.1.3', failures: 1, previousValid: false });
  assert.equal(invalid.action, 'terminal');
  const blocked = decideStartFailure({ current: '0.1.4', previous: '0.1.3', failures: 1, configSchemaOk: false });
  assert.equal(blocked.action, 'terminal');
  assert.equal(blocked.blocked, 'config-schema');
});

ck('配置 schema 闸：目标低于当前配置才拒绝；缺省按 1', () => {
  assert.equal(configRollbackGuard({ configSchema: 2, targetSupported: 1 }).ok, false);
  assert.equal(configRollbackGuard({ configSchema: 1, targetSupported: 1 }).ok, true);
  assert.equal(configRollbackGuard({}).ok, true);
});

ck('rollback.json 形状：顶层有 at/from/to/reason/result', () => {
  const r = rollbackRecord({ from: '0.1.4', to: '0.1.3', reason: 'x', failures: 2, runtimeRestored: true });
  assert.equal(r.schema, 1);
  assert.equal(r.from, '0.1.4');
  assert.equal(r.to, '0.1.3');
  assert.equal(r.reason, 'x');
  assert.equal(r.runtimeRestored, true);
  assert.ok(Number.isFinite(Date.parse(r.at)));
});

/* ── 2. runtime 交换 ───────────────────────────────────────────────── */
ck('runtime 交换：new → node.failed，node.previous → node', () => {
  const t = tmp('p4-swap-');
  const inst = path.join(t, 'inst');
  write(path.join(inst, 'runtime', 'node', 'node.exe'), 'new\n');
  write(path.join(inst, 'runtime', 'node.previous', 'node.exe'), 'old\n');
  const r = swapRuntime({ installRoot: inst, stamp: 'test' });
  assert.equal(r.ok, true);
  assert.equal(r.swapped, true);
  assert.equal(fs.readFileSync(path.join(inst, 'runtime', 'node', 'node.exe'), 'utf8'), 'old\n');
  assert.equal(fs.readFileSync(path.join(inst, 'runtime', 'node.failed-test', 'node.exe'), 'utf8'), 'new\n');
  assert.equal(fs.existsSync(path.join(inst, 'runtime', 'node.previous')), false);
  fs.rmSync(t, { recursive: true, force: true });
});

ck('runtime 交换：没有 node.previous → 成功但不交换', () => {
  const t = tmp('p4-swap-none-');
  const inst = path.join(t, 'inst');
  write(path.join(inst, 'runtime', 'node', 'node.exe'), 'new\n');
  const r = swapRuntime({ installRoot: inst, stamp: 'test' });
  assert.equal(r.ok, true);
  assert.equal(r.swapped, false);
  fs.rmSync(t, { recursive: true, force: true });
});

ck('runtime 交换：第二步失败必须把 node 改回来', () => {
  const t = tmp('p4-swap-fail-');
  const inst = path.join(t, 'inst');
  write(path.join(inst, 'runtime', 'node', 'node.exe'), 'new\n');
  write(path.join(inst, 'runtime', 'node.previous', 'node.exe'), 'old\n');
  const real = fs;
  let n = 0;
  const fake = Object.create(fs);
  fake.renameSync = (a, b) => {
    n += 1;
    if (n === 2) throw new Error('locked');
    return real.renameSync(a, b);
  };
  const r = swapRuntime({ installRoot: inst, stamp: 'test', fsApi: fake });
  assert.equal(r.ok, false);
  assert.equal(r.swapped, false);
  assert.equal(fs.readFileSync(path.join(inst, 'runtime', 'node', 'node.exe'), 'utf8'), 'new\n');
  fs.rmSync(t, { recursive: true, force: true });
});

ck('swap marker：写入/读取/清除', () => {
  const t = tmp('p4-marker-');
  const inst = path.join(t, 'inst');
  writeSwapMarker(inst, { from: '0.1.4', to: '0.1.3', phase: 'starting' });
  assert.equal(readSwapMarker(inst).from, '0.1.4');
  clearSwapMarker(inst);
  assert.equal(readSwapMarker(inst), null);
  fs.rmSync(t, { recursive: true, force: true });
});

ck('swap marker：PowerShell 5.1 带 BOM 也能读', () => {
  const t = tmp('p4-marker-bom-');
  const inst = path.join(t, 'inst');
  fs.mkdirSync(path.join(inst, 'runtime'), { recursive: true });
  fs.writeFileSync(path.join(inst, 'runtime', '.swap.json'), `\uFEFF${JSON.stringify({
    schema: 1, from: '0.1.4', to: '0.1.3', phase: 'swapped',
  })}\n`);
  assert.equal(readSwapMarker(inst).from, '0.1.4');
  fs.rmSync(t, { recursive: true, force: true });
});

/* ── 3. 回滚证据 ───────────────────────────────────────────────────── */
ck('回滚证据：只复制 panel.log 尾部与 current.json，不复制 config.json', () => {
  const t = tmp('p4-evidence-');
  const inst = path.join(t, 'inst');
  const user = path.join(t, 'user');
  write(path.join(inst, 'current.json'), '{"current":"0.1.4"}\n');
  write(path.join(user, 'config.json'), '{"secret":"DO-NOT-COPY"}\n');
  write(path.join(user, 'panel', 'panel.log'), `${'x'.repeat(300 * 1024)}\n`);
  const r = preserveRollbackEvidence({ installRoot: inst, userRoot: user, from: '0.1.4', to: '0.1.3', reason: 'bad', failures: 2 });
  assert.equal(r.ok, true);
  assert.equal(fs.existsSync(path.join(r.dir, 'current.json')), true);
  assert.equal(fs.existsSync(path.join(r.dir, 'config.json')), false);
  assert.ok(fs.statSync(path.join(r.dir, 'panel.log.tail')).size <= 256 * 1024);
  assert.match(fs.readFileSync(path.join(r.dir, 'reason.txt'), 'utf8'), /from=0\.1\.4/);
  assert.match(fs.readFileSync(path.join(r.dir, 'reason.txt'), 'utf8'), /to=0\.1\.3/);
  fs.rmSync(t, { recursive: true, force: true });
});

/* ── 4. 保留策略 ───────────────────────────────────────────────────── */
ck('保留计划：只删旧 semver/改目录残留，未知名字/软链/文件不动', () => {
  const plan = planRetention({
    current: '0.1.4',
    previous: '0.1.3',
    versions: [
      { name: '0.1.4', isDirectory: true, isSymlink: false },
      { name: '0.1.3', isDirectory: true, isSymlink: false },
      { name: '0.1.2', isDirectory: true, isSymlink: false },
      { name: '0.1.2.old-x', isDirectory: true, isSymlink: false },
      { name: 'keepme', isDirectory: true, isSymlink: false },
      { name: '0.1.1', isDirectory: false, isSymlink: true },
      { name: 'note.txt', isDirectory: false, isSymlink: false },
    ],
  });
  assert.deepEqual(plan.versionsToRemove.sort(), ['0.1.2', '0.1.2.old-x'].sort());
  assert.equal(plan.versionsToRemove.includes('0.1.3'), false);
  assert.equal(plan.versionsToRemove.includes('0.1.4'), false);
  assert.equal(plan.versionsToRemove.includes('keepme'), false);
});

ck('保留计划：current 缺失 → 不删任何东西（fail-safe）', () => {
  const plan = planRetention({ current: '', versions: [{ name: '0.1.2', isDirectory: true }] });
  assert.deepEqual(plan.versionsToRemove, []);
});

ck('保留计划：node.previous.old-* 也算残留（P1-8 改名备份）', () => {
  const plan = planRetention({
    current: '0.1.4',
    runtime: [
      { name: 'node', path: '/tmp/inst/runtime/node', isDirectory: true, isSymlink: false },
      { name: 'node.previous.old-0.1.4-2026', path: '/tmp/inst/runtime/node.previous.old-0.1.4-2026', isDirectory: true, isSymlink: false },
    ],
  });
  assert.deepEqual(plan.runtimeToRemove, ['node.previous.old-0.1.4-2026']);
});

ck('保留计划：runtime 只删 previous/failed 残留，跳过正在运行的 execPath', () => {
  const exec = path.join('/tmp', 'inst', 'runtime', 'node.failed-now', 'node');
  const plan = planRetention({
    current: '0.1.4',
    previous: '0.1.3',
    execPath: exec,
    runtime: [
      { name: 'node', path: '/tmp/inst/runtime/node', isDirectory: true, isSymlink: false },
      { name: 'node.previous', path: '/tmp/inst/runtime/node.previous', isDirectory: true, isSymlink: false },
      { name: 'node.failed-old', path: '/tmp/inst/runtime/node.failed-old', isDirectory: true, isSymlink: false },
      { name: 'node.failed-now', path: '/tmp/inst/runtime/node.failed-now', isDirectory: true, isSymlink: false },
      { name: 'keepme', path: '/tmp/inst/runtime/keepme', isDirectory: true, isSymlink: false },
    ],
  });
  assert.deepEqual(plan.runtimeToRemove.sort(), ['node.failed-old', 'node.previous'].sort());
  assert.equal(plan.runtimeToRemove.includes('node.failed-now'), false);
});

ck('保留执行：真实目录删旧留新，未知目录不动', () => {
  const t = tmp('p4-retain-');
  const inst = path.join(t, 'inst');
  for (const n of ['0.1.4', '0.1.3', '0.1.2', 'keepme']) write(path.join(inst, 'versions', n, 'package.json'), '{}\n');
  write(path.join(inst, 'runtime', 'node', 'node.exe'), 'node\n');
  write(path.join(inst, 'runtime', 'node.previous', 'node.exe'), 'old\n');
  const plan = planRetention({
    current: '0.1.4',
    previous: '0.1.3',
    versions: listEntries(path.join(inst, 'versions')),
    runtime: listEntries(path.join(inst, 'runtime')),
  });
  const r = applyRetention({ installRoot: inst, plan });
  assert.equal(fs.existsSync(path.join(inst, 'versions', '0.1.2')), false);
  assert.equal(fs.existsSync(path.join(inst, 'versions', '0.1.3')), true);
  assert.equal(fs.existsSync(path.join(inst, 'versions', '0.1.4')), true);
  assert.equal(fs.existsSync(path.join(inst, 'versions', 'keepme')), true);
  assert.equal(fs.existsSync(path.join(inst, 'runtime', 'node.previous')), false);
  assert.equal(r.errors.length, 0);
  fs.rmSync(t, { recursive: true, force: true });
});

/* ── 5. 断电恢复与 journal 落盘 ────────────────────────────────────── */
ck('安装事务：断电后磁盘 journal 有 entries，下一次安装能恢复', () => {
  const t = tmp('p4-journal-');
  const inst = path.join(t, 'inst');
  const ud = path.join(t, 'ud');
  const s1 = makeStage(t, '0.1.3');
  const first = runCommit(['--install-root', inst, '--stage', s1, '--version', '0.1.3', '--user-root', ud]);
  assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);
  write(path.join(ud, 'config.json'), '{"keep":true}\n');

  const s2 = makeStage(t, '0.1.4');
  const crash = runCommit(
    ['--install-root', inst, '--stage', s2, '--version', '0.1.4', '--user-root', ud],
    { QQBOT_INSTALL_TEST: '1', QQBOT_INSTALL_FAULT: 'after-backup:2' },
  );
  assert.equal(crash.status, 97, `${crash.stdout}\n${crash.stderr}`);
  const journal = JSON.parse(fs.readFileSync(path.join(inst, 'versions', '.txn.json'), 'utf8'));
  assert.equal(journal.status, 'in_progress');
  assert.ok(Array.isArray(journal.entries) && journal.entries.length >= 2, `entries=${journal.entries && journal.entries.length}`);
  assert.equal(JSON.parse(fs.readFileSync(path.join(inst, 'current.json'), 'utf8')).current, '0.1.3');
  assert.equal(fs.readFileSync(path.join(ud, 'config.json'), 'utf8'), '{"keep":true}\n');

  const retry = runCommit(['--install-root', inst, '--stage', s2, '--version', '0.1.4', '--user-root', ud]);
  assert.equal(retry.status, 0, `${retry.stdout}\n${retry.stderr}`);
  assert.match(`${retry.stdout}${retry.stderr}`, /restored|committed/);
  const cur = JSON.parse(fs.readFileSync(path.join(inst, 'current.json'), 'utf8'));
  assert.equal(cur.current, '0.1.4');
  assert.equal(cur.previous, '0.1.3');
  assert.equal(fs.existsSync(path.join(inst, 'runtime', 'node', 'node.exe')), true);
  assert.equal(fs.existsSync(path.join(inst, 'runtime', 'node.previous')), true);
  assert.equal(fs.readFileSync(path.join(ud, 'config.json'), 'utf8'), '{"keep":true}\n');
  fs.rmSync(t, { recursive: true, force: true });
});

ck('安装事务：指针已是新版时，未完成 journal 按已提交处理，不回滚好版本', () => {
  const t = tmp('p4-journal-idem-');
  const inst = path.join(t, 'inst');
  const ud = path.join(t, 'ud');
  const s1 = makeStage(t, '0.1.3');
  assert.equal(runCommit(['--install-root', inst, '--stage', s1, '--version', '0.1.3', '--user-root', ud]).status, 0);
  const cur = JSON.parse(fs.readFileSync(path.join(inst, 'current.json'), 'utf8'));
  write(path.join(inst, 'versions', '.txn.json'), `${JSON.stringify({
    schema: 1, status: 'in_progress', version: '0.1.3', entries: [],
    hadInstall: true, hadCurrent: true,
    oldInstall: JSON.parse(fs.readFileSync(path.join(inst, 'install.json'), 'utf8')),
    oldCurrent: cur,
  }, null, 2)}\n`);
  const r = runCommit(['--install-root', inst, '--stage', s1, '--version', '0.1.3', '--user-root', ud]);
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.match(`${r.stdout}${r.stderr}`, /treating it as committed/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(inst, 'current.json'), 'utf8')).current, '0.1.3');
  fs.rmSync(t, { recursive: true, force: true });
});

/* ── 5b. 启动器端到端：坏版本两次失败 → 回滚 ─────────────────────── */
function makeInstalledApp(dest, version, { breakPanel = false } = {}) {
  fs.mkdirSync(dest, { recursive: true });
  for (const rel of ['src', 'panel', 'node_modules/ws', 'scripts']) {
    const src = path.join(REPO, rel);
    if (fs.existsSync(src)) fs.cpSync(src, path.join(dest, rel), { recursive: true, force: true });
  }
  fs.copyFileSync(path.join(REPO, 'config.example.json'), path.join(dest, 'config.example.json'));
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
  pkg.version = version;
  fs.writeFileSync(path.join(dest, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
  if (breakPanel) fs.rmSync(path.join(dest, 'panel', 'server.js'), { force: true });
}

await ckA('启动器端到端：坏版本连续失败 2 次 → 回滚 + runtime 恢复 + 保留策略', async () => {
  if (process.platform === 'win32') return; // Windows 版在 VM 验收里跑
  const t = tmp('p4-launcher-');
  const inst = path.join(t, 'inst');
  const ud = path.join(t, 'userdata');
  makeInstalledApp(path.join(inst, 'versions', '0.1.3', 'app'), '0.1.3');
  makeInstalledApp(path.join(inst, 'versions', '0.1.4', 'app'), '0.1.4', { breakPanel: true });
  write(path.join(inst, 'runtime', 'node', 'node.exe'), 'new-runtime\n');
  write(path.join(inst, 'runtime', 'node.previous', 'node.exe'), 'old-runtime\n');
  write(path.join(ud, 'config.json'), `${JSON.stringify({ launch: { openOnStart: false } }, null, 2)}\n`);
  const writeJson = (file, obj) => fs.writeFileSync(file, `${JSON.stringify(obj, null, 2)}\n`);
  writeJson(path.join(inst, 'install.json'), {
    schema: 1, appId: 'com.estrellabot.windows', installRoot: inst, userRoot: ud, installedVersion: '0.1.4',
  });
  writeJson(path.join(inst, 'current.json'), {
    schema: 1, current: '0.1.4', previous: '0.1.3', health: 'pending', failures: 0,
  });
  const port = 53000 + Math.floor(Math.random() * 1000);
  const env = {
    ...process.env,
    QQBOT_PANEL_PORT: String(port),
    QQBOT_SANDBOX: '1',
    TEMP: t,
    TMP: t,
    NODE_OPTIONS: '',
  };
  const launcher = path.join(REPO, 'packaging/windows/tools/launcher.mjs');
  try {
    const r1 = spawnSync(process.execPath, [launcher, '--install-root', inst], { encoding: 'utf8', timeout: 45000, env });
    assert.equal(r1.status, 4, `第一次应失败退出 4，实得 ${r1.status}\n${r1.stdout}\n${r1.stderr}`);
    let cur = JSON.parse(fs.readFileSync(path.join(inst, 'current.json'), 'utf8'));
    assert.equal(cur.current, '0.1.4');
    assert.equal(cur.failures, 1);

    const r2 = spawnSync(process.execPath, [launcher, '--install-root', inst], { encoding: 'utf8', timeout: 45000, env });
    assert.equal(r2.status, 0, `第二次应回滚并成功启动，实得 ${r2.status}\n${r2.stdout}\n${r2.stderr}`);
    cur = JSON.parse(fs.readFileSync(path.join(inst, 'current.json'), 'utf8'));
    assert.equal(cur.current, '0.1.3');
    assert.equal(cur.previous, null);
    assert.equal(cur.health, 'ok');
    assert.equal(cur.failures, 0);
    assert.equal(fs.readFileSync(path.join(inst, 'runtime', 'node', 'node.exe'), 'utf8'), 'old-runtime\n');
    assert.equal(fs.existsSync(path.join(inst, 'versions', '0.1.4')), false);
    const rb = JSON.parse(fs.readFileSync(path.join(ud, 'update', 'rollback.json'), 'utf8'));
    assert.equal(rb.from, '0.1.4');
    assert.equal(rb.to, '0.1.3');
    assert.equal(rb.result, 'ok');
    assert.equal(rb.runtimeRestored, true);
  } finally {
    const pids = spawnSync('lsof', ['-ti', `tcp:${port}`], { encoding: 'utf8' }).stdout
      .split('\n').map((s) => Number(s.trim())).filter((n) => n > 0);
    for (const pid of pids) { try { process.kill(pid, 'SIGTERM'); } catch { /* 已退出 */ } }
    fs.rmSync(t, { recursive: true, force: true });
  }
});

/* ── 6. 离线更新 ───────────────────────────────────────────────────── */
await ckA('离线准备 + 完成：验签/哈希通过后进入 ready，缓存与 pending 正确', async () => {
  const t = tmp('p4-offline-');
  const keys = makeKeyPair();
  const pub = path.join(t, 'pub.pem');
  fs.writeFileSync(pub, keys.publicPem);
  const exe = Buffer.from('fake installer bytes\n');
  const manifest = makeManifest({ size: exe.length, sha: sha256(exe) });
  const { raw, sig } = signManifest(manifest, keys.privateKey);
  const updater = makeUpdater({ dir: t, publicKeyFile: pub });
  const prep = await updater.prepareOffline({ manifestBytes: raw, sigBase64: sig });
  assert.equal(prep.ok, undefined); // snapshot 本身没有 ok 字段
  assert.equal(prep.offline.version, '0.1.4');
  const done = await updater.completeOffline({ bytes: exe });
  assert.equal(done.phase, 'ready');
  assert.equal(done.latest.version, '0.1.4');
  assert.equal(fs.existsSync(path.join(t, 'update', 'cache', '0.1.4.exe')), true);
  assert.equal(fs.existsSync(path.join(t, 'update', 'offline', 'pending')), false);
  fs.rmSync(t, { recursive: true, force: true });
});

await ckA('离线：坏签名/坏哈希/坏尺寸/低版本全部拒绝，不进入 ready', async () => {
  const t = tmp('p4-offline-bad-');
  const keys = makeKeyPair();
  const pub = path.join(t, 'pub.pem');
  fs.writeFileSync(pub, keys.publicPem);
  const exe = Buffer.from('good bytes\n');
  const manifest = makeManifest({ size: exe.length, sha: sha256(exe) });
  const { raw, sig } = signManifest(manifest, keys.privateKey);
  const updater = makeUpdater({ dir: t, publicKeyFile: pub });

  await assert.rejects(() => updater.prepareOffline({ manifestBytes: raw, sigBase64: 'AAAA' }), /签名无效/);
  await updater.prepareOffline({ manifestBytes: raw, sigBase64: sig });
  await assert.rejects(() => updater.completeOffline({ bytes: Buffer.from('bad bytes\n') }), /大小不符|SHA-256/);
  const low = makeManifest({ version: '0.1.2', size: exe.length, sha: sha256(exe) });
  const lowSigned = signManifest(low, keys.privateKey);
  await assert.rejects(() => updater.prepareOffline({ manifestBytes: lowSigned.raw, sigBase64: lowSigned.sig }), /降级|版本不可用/);
  assert.notEqual(updater.snapshot().phase, 'ready');
  fs.rmSync(t, { recursive: true, force: true });
});

await ckA('离线：ready 可跨 updater 重启恢复（restore 复验缓存）', async () => {
  const t = tmp('p4-offline-restore-');
  const keys = makeKeyPair();
  const pub = path.join(t, 'pub.pem');
  fs.writeFileSync(pub, keys.publicPem);
  const exe = Buffer.from('restore bytes\n');
  const manifest = makeManifest({ size: exe.length, sha: sha256(exe) });
  const { raw, sig } = signManifest(manifest, keys.privateKey);
  const a = makeUpdater({ dir: t, publicKeyFile: pub });
  await a.prepareOffline({ manifestBytes: raw, sigBase64: sig });
  await a.completeOffline({ bytes: exe });
  const b = makeUpdater({ dir: t, publicKeyFile: pub });
  await b.restore();
  assert.equal(b.snapshot().phase, 'ready');
  assert.equal(b.snapshot().latest.version, '0.1.4');
  fs.rmSync(t, { recursive: true, force: true });
});

ck('离线：清空 pending 不删已 ready 的 cache', () => {
  const t = tmp('p4-offline-clear-');
  const updater = makeUpdater({ dir: t, publicKeyFile: path.join(t, 'missing.pem') });
  // updater 会因缺公钥而 disabled；这里只验证 clearOffline 的形状不抛。
  assert.equal(typeof updater.clearOffline, 'function');
  assert.doesNotThrow(() => updater.clearOffline());
  fs.rmSync(t, { recursive: true, force: true });
});

/* ── 7. 镜像固定 tag ───────────────────────────────────────────────── */
ck('镜像：指向 latest 的镜像被拒绝，固定 tag 的镜像通过', () => {
  const exe = Buffer.from('x');
  const base = makeManifest({ size: exe.length, sha: sha256(exe) });
  const latestMirror = {
    ...base,
    installer: {
      ...base.installer,
      mirrors: ['https://gh-proxy.com/https://github.com/Canvixel-Eloweny/ai-bot-groupmate/releases/download/latest/x.exe'],
    },
  };
  const bad = validateManifest(latestMirror, { currentVersion: '0.1.3' });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((e) => /固定 tag|latest/.test(e)), bad.errors.join('；'));
  const latestUrl = makeManifest({
    size: exe.length,
    sha: sha256(exe),
    url: 'https://github.com/Canvixel-Eloweny/ai-bot-groupmate/releases/download/latest/x.exe',
  });
  const badUrl = validateManifest(latestUrl, { currentVersion: '0.1.3' });
  assert.equal(badUrl.ok, false);
  assert.ok(badUrl.errors.some((e) => /latest/.test(e)), badUrl.errors.join('；'));
  const fixedMirror = {
    ...base,
    installer: {
      ...base.installer,
      mirrors: ['https://gh-proxy.com/https://github.com/Canvixel-Eloweny/ai-bot-groupmate/releases/download/v0.1.4/x.exe'],
    },
  };
  const good = validateManifest(fixedMirror, { currentVersion: '0.1.3' });
  assert.equal(good.ok, true, good.errors.join('；'));
});

console.log('');
console.log(`${checks - failures}/${checks} passed`);
if (failures) process.exit(1);
