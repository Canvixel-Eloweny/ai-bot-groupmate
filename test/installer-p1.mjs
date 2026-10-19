/**
 * P1 数据分离的独立验收（2026-10-18）。
 *
 * 覆盖：三模式根解析、覆盖优先级、QQBOT_DATA_DIR 子树、迁移只复制/幂等/冲突、
 * 只读程序目录、版本单一来源。不跑网络、不碰真机数据。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveRoots, ensureUserDirs } from '../src/user-root.js';
import { migrate } from '../packaging/windows/tools/migrate.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
let checks = 0;
function ck(name, fn) {
  checks += 1;
  try { fn(); console.log(`  PASS  ${name}`); }
  catch (e) { failures += 1; console.log(`  FAIL  ${name} — ${e.message}`); }
}
function tmp(prefix = 'p1-') { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }
function write(file, text) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); }

console.log('P1 installer/data-separation checks');

ck('dev：程序根/用户根重合，config 与 panel 仍在仓库', () => {
  const r = resolveRoots({ env: {}, programRoot: REPO });
  assert.equal(r.mode, 'dev');
  assert.equal(r.userRoot, REPO);
  assert.equal(r.configFile, path.join(REPO, 'config.json'));
  assert.equal(r.panelStateDir, path.join(REPO, 'panel'));
});

ck('portable：<pkg>/app + tools/runtime ⇒ <pkg>/userdata', () => {
  const t = tmp();
  const app = path.join(t, 'pkg', 'app');
  fs.mkdirSync(app, { recursive: true });
  fs.mkdirSync(path.join(t, 'pkg', 'tools'));
  fs.mkdirSync(path.join(t, 'pkg', 'runtime'));
  const r = resolveRoots({ env: {}, programRoot: app });
  assert.equal(r.mode, 'portable');
  assert.equal(r.installRoot, path.join(t, 'pkg'));
  assert.equal(r.userRoot, path.join(t, 'pkg', 'userdata'));
  assert.equal(r.napcatDir, path.join(t, 'pkg', 'userdata', 'napcat'));
  fs.rmSync(t, { recursive: true, force: true });
});

ck('installed：install.json.userRoot 优先；缺省落到 LOCALAPPDATA', () => {
  const t = tmp();
  const inst = path.join(t, 'inst');
  const app = path.join(inst, 'versions', '1.2.3', 'app');
  fs.mkdirSync(app, { recursive: true });
  write(path.join(inst, 'install.json'), JSON.stringify({ userRoot: path.join(t, 'ud') }));
  const r = resolveRoots({ env: {}, programRoot: app });
  assert.equal(r.mode, 'installed');
  assert.equal(r.userRoot, path.join(t, 'ud'));
  write(path.join(inst, 'install.json'), JSON.stringify({}));
  const r2 = resolveRoots({ env: { LOCALAPPDATA: path.join(t, 'local') }, programRoot: app });
  assert.equal(r2.userRoot, path.join(t, 'local', 'EstrellaBot', 'userdata'));
  fs.rmSync(t, { recursive: true, force: true });
});

ck('覆盖优先级：QQBOT_USER_ROOT > install.json；DATA_DIR 只改 data', () => {
  const t = tmp();
  const r = resolveRoots({
    env: { QQBOT_USER_ROOT: path.join(t, 'u'), QQBOT_DATA_DIR: path.join(t, 'only-data') },
    programRoot: REPO,
  });
  assert.equal(r.userRoot, path.join(t, 'u'));
  assert.equal(r.panelStateDir, path.join(t, 'u', 'panel'));
  assert.equal(r.dataDir, path.join(t, 'only-data'));
  fs.rmSync(t, { recursive: true, force: true });
});

ck('QQBOT_CONFIG 只改 config；非法 QQBOT_MODE 立刻抛', () => {
  const t = tmp();
  const r = resolveRoots({
    env: { QQBOT_CONFIG: path.join(t, 'cfg.json'), QQBOT_DATA_DIR: path.join(t, 'd') },
    programRoot: REPO,
  });
  assert.equal(r.configFile, path.join(t, 'cfg.json'));
  assert.equal(r.dataDir, path.join(t, 'd'));
  assert.throws(() => resolveRoots({ env: { QQBOT_MODE: 'nope' }, programRoot: REPO }), /QQBOT_MODE/);
  fs.rmSync(t, { recursive: true, force: true });
});

ck('cwd 不参与解析（传绝对 programRoot 时结果不变）', () => {
  const old = process.cwd();
  const t = tmp();
  try {
    process.chdir(t);
    const r = resolveRoots({ env: {}, programRoot: REPO });
    assert.equal(r.programRoot, REPO);
    assert.equal(r.userRoot, REPO);
  } finally {
    process.chdir(old);
    fs.rmSync(t, { recursive: true, force: true });
  }
});

ck('portable/installed 的 USER_ROOT 不在 PROGRAM_ROOT 内', () => {
  const t = tmp();
  const app = path.join(t, 'pkg', 'app');
  fs.mkdirSync(app, { recursive: true });
  fs.mkdirSync(path.join(t, 'pkg', 'tools'));
  fs.mkdirSync(path.join(t, 'pkg', 'runtime'));
  const r = resolveRoots({ env: {}, programRoot: app });
  assert.equal(path.relative(r.programRoot, r.userRoot).startsWith('..'), true);
  fs.rmSync(t, { recursive: true, force: true });
});

ck('只读程序目录：写 USER_ROOT 成功，写程序根失败', () => {
  if (process.platform === 'win32') {
    console.log('  SKIP  只读位在 Windows 上不按 POSIX chmod 语义生效，ReadOnly 由 P2 真机验收');
    return;
  }
  const t = tmp();
  const app = path.join(t, 'pkg', 'app');
  fs.mkdirSync(app, { recursive: true });
  fs.mkdirSync(path.join(t, 'pkg', 'tools'));
  fs.mkdirSync(path.join(t, 'pkg', 'runtime'));
  fs.chmodSync(app, 0o555);
  try {
    const r = resolveRoots({ env: {}, programRoot: app });
    ensureUserDirs({ roots: r });
    fs.writeFileSync(path.join(r.userRoot, 'probe'), 'ok');
    assert.throws(() => fs.writeFileSync(path.join(app, 'probe'), 'x'), /EACCES|EROFS|permission/i);
  } finally {
    fs.chmodSync(app, 0o755);
    fs.rmSync(t, { recursive: true, force: true });
  }
});

ck('cwd ≠ PROGRAM_ROOT：独立进程仍按模块位置解析根', () => {
  const t = tmp();
  try {
    const href = pathToFileURL(path.join(REPO, 'src', 'user-root.js')).href;
    const code = `import { resolveRoots } from ${JSON.stringify(href)};`
      + "const r = resolveRoots({ env: { QQBOT_MODE: 'dev' } });"
      + 'console.log(JSON.stringify({ programRoot: r.programRoot, userRoot: r.userRoot }));';
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', code], { cwd: t, encoding: 'utf8' });
    const j = JSON.parse(out.trim());
    assert.equal(j.programRoot, REPO);
    assert.equal(j.userRoot, REPO);
  } finally {
    fs.rmSync(t, { recursive: true, force: true });
  }
});

ck('迁移：只复制白名单，源不动，token/pid/日志不复制', () => {
  const t = tmp();
  const pkg = path.join(t, 'legacy');
  const app = path.join(pkg, 'app');
  const ud = path.join(t, 'ud');
  write(path.join(app, 'config.json'), '{"llm":{"apiKey":"sk-x"}}');
  write(path.join(app, 'panel', 'session-archive.json'), 'archive');
  write(path.join(app, 'panel', '.token'), 'secret');
  write(path.join(app, 'panel', '.bridge.pid'), '123');
  write(path.join(app, 'panel', 'usage-2026-10.jsonl'), 'usage');
  write(path.join(app, 'data', 'memory', 'people.json'), 'people');
  write(path.join(app, 'napcat', 'config', 'webui.json'), 'napcfg');
  write(path.join(app, 'napcat', 'QQ', 'u1'), 'login');
  write(path.join(app, 'napcat', 'napcat.log'), 'log');
  write(path.join(app, '.qqbot-portable-setup.json'), '{"version":"0.1.2"}');

  const r = migrate({ source: pkg, userRoot: ud });
  assert.equal(r.status, 'complete');
  assert.equal(fs.existsSync(path.join(ud, 'config.json')), true);
  assert.equal(fs.existsSync(path.join(ud, 'panel', 'session-archive.json')), true);
  assert.equal(fs.existsSync(path.join(ud, 'panel', '.token')), false);
  assert.equal(fs.existsSync(path.join(ud, 'panel', '.bridge.pid')), false);
  assert.equal(fs.existsSync(path.join(ud, 'napcat', 'QQ', 'u1')), true);
  assert.equal(fs.existsSync(path.join(ud, 'napcat', 'napcat.log')), false);
  assert.equal(fs.existsSync(path.join(ud, 'setup-state.json')), true);
  assert.equal(fs.existsSync(path.join(app, 'config.json')), true, '源必须保留');
  const marker = JSON.parse(fs.readFileSync(path.join(ud, 'migration.json'), 'utf8'));
  assert.equal(marker.status, 'complete');
  assert.equal(marker.counts.conflicts, 0);

  const again = migrate({ source: pkg, userRoot: ud });
  assert.equal(again.status, 'skipped');
  fs.rmSync(t, { recursive: true, force: true });
});

ck('迁移：目标优先，冲突进 .migration-conflicts；dry-run 不写', () => {
  const t = tmp();
  const pkg = path.join(t, 'legacy');
  const app = path.join(pkg, 'app');
  const ud = path.join(t, 'ud');
  write(path.join(app, 'config.json'), '{"from":"src"}');
  write(path.join(ud, 'config.json'), '{"from":"target"}');
  const dry = migrate({ source: pkg, userRoot: ud, dryRun: true });
  assert.equal(dry.status, 'dry-run');
  assert.equal(fs.existsSync(path.join(ud, 'migration.json')), false);
  const r = migrate({ source: pkg, userRoot: ud });
  assert.equal(r.status, 'complete');
  assert.equal(JSON.parse(fs.readFileSync(path.join(ud, 'config.json'), 'utf8')).from, 'target');
  assert.equal(r.conflicts.length, 1);
  const conflictFiles = fs.readdirSync(path.join(ud, '.migration-conflicts'), { recursive: true })
    .filter((x) => String(x).endsWith('config.json'));
  assert.equal(conflictFiles.length, 1);
  fs.rmSync(t, { recursive: true, force: true });
});

ck('迁移：源=目标（dev）skipped', () => {
  const r = migrate({ source: REPO, userRoot: REPO });
  assert.equal(r.status, 'skipped');
  assert.equal(r.reason, 'source-equals-target');
});

// async 检查单独跑，保证同步断言不被 Promise 吞掉
for (const [name, fn] of [['版本单一来源', async () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
  const common = await import('../packaging/windows/tools/lib/common.mjs');
  assert.equal(common.VERSION, pkg.version);
}]]) {
  checks += 1;
  try { await fn(); console.log(`  PASS  ${name}`); }
  catch (e) { failures += 1; console.log(`  FAIL  ${name} — ${e.message}`); }
}

console.log(`\n${checks - failures}/${checks} passed`);
process.exit(failures ? 1 : 0);
