/**
 * P2 安装器布局的独立验收（2026-10-18）。
 *
 * 覆盖纯判据：路径包含、current/install 形状、进程身份、payload manifest、
 * 旧数据源识别、版本/appId 单一来源。不跑网络、不启动真机、不碰用户数据。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isOurBridge } from '../src/bridge-proc.js';
import { launchOfConfig } from '../src/launch-mode.js';
import { isNapcatProcess } from '../packaging/windows/tools/stop.mjs';
import { restoreJournal } from '../packaging/windows/tools/install-commit.mjs';
import {
  assertUserRootOutsideInstallRoot,
  classifyProcess,
  compareVersions,
  effectiveProgram,
  pathInside,
  readCurrentInfo,
  readInstallInfo,
  readPackageInfo,
  resolveImportSource,
  sha256FileSync,
  validateCurrent,
  verifyPayloadManifest,
  writeJsonAtomic,
} from '../packaging/windows/tools/lib/install-layout.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/* 当前产品版本从唯一来源读，不写死某一版 —— 发版升版本号时这组夹具要跟着走，
   写死会让一次合法的 0.1.4 升版把 launcher 用例判成红（2026-10-21 实测）。 */
const VER = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).version;
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
const tmp = (prefix = 'p2-') => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const pkgJson = (version = '0.1.3') => `${JSON.stringify({ name: 'x', version, appId: 'com.estrellabot.windows' }, null, 2)}\n`;
const COMMIT = path.join(REPO, 'packaging', 'windows', 'tools', 'install-commit.mjs');

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
  add('runtime/node/node.exe', 'fake node\n');
  add('tools/stop.mjs', '// fake tool\n');
  add('tools/lib/install-layout.mjs', '// fake layout\n');
  add('launcher/Estrella-Bot.vbs', "' fake vbs\n");
  add('README.html', '<html>readme</html>\n');
  add('LICENSE', 'Apache-2.0\n');
  add('THIRD-PARTY-NOTICES.md', 'notices\n');
  const list = [...files].map(([rel, full]) => ({ path: rel, size: fs.statSync(full).size, sha256: sha256FileSync(full) }));
  writeJsonAtomic(path.join(stage, 'payload-manifest.json'), {
    schema: 1, version, appId: 'com.estrellabot.windows', count: list.length, files: list,
  });
  return stage;
}

function runCommit(args) {
  return spawnSync(process.execPath, [COMMIT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, QQBOT_PANEL_PORT: '1', NODE_OPTIONS: '' },
    timeout: 60000,
  });
}

console.log('P2 installer/layout checks');

ck('版本与 appId 单一来源：package.json', () => {
  const info = readPackageInfo(REPO);
  assert.equal(info.version, VER);
  assert.equal(info.appId, 'com.estrellabot.windows');
});

ck('pathInside：POSIX 前缀不误判 / Windows 大小写不敏感', () => {
  assert.equal(pathInside('/a/b/c', '/a/b', { platform: 'linux' }), true);
  assert.equal(pathInside('/a/b2', '/a/b', { platform: 'linux' }), false);
  assert.equal(pathInside('/a/b', '/a/b', { platform: 'linux' }), false);
  assert.equal(pathInside('C:\\Users\\X\\AppData\\Local\\Programs\\Estrella-Bot', 'C:\\Users\\X', { platform: 'win32' }), true);
  assert.equal(pathInside('C:\\Users\\X2', 'C:\\Users\\X', { platform: 'win32' }), false);
  assert.equal(pathInside('c:\\users\\x\\a', 'C:\\Users\\X', { platform: 'win32' }), true);
});

ck('userRoot/installRoot：正常布局通过', () => {
  const r = assertUserRootOutsideInstallRoot({
    installRoot: 'C:\\Users\\X\\AppData\\Local\\Programs\\Estrella-Bot',
    userRoot: 'C:\\Users\\X\\AppData\\Local\\EstrellaBot\\userdata',
    platform: 'win32',
    env: { USERPROFILE: 'C:\\Users\\X', WINDIR: 'C:\\Windows' },
  });
  assert.deepEqual(r, { ok: true });
});

ck('userRoot/installRoot：双向包含、盘根、用户主目录、Windows 目录都拒绝', () => {
  const base = { platform: 'win32', env: { USERPROFILE: 'C:\\Users\\X', WINDIR: 'C:\\Windows' } };
  assert.equal(assertUserRootOutsideInstallRoot({ ...base, installRoot: 'C:\\Apps\\E', userRoot: 'C:\\Apps\\E\\userdata' }).ok, false);
  assert.equal(assertUserRootOutsideInstallRoot({ ...base, installRoot: 'C:\\Apps\\E', userRoot: 'C:\\Apps' }).ok, false);
  assert.equal(assertUserRootOutsideInstallRoot({ ...base, installRoot: 'C:\\', userRoot: 'C:\\Users\\X\\u' }).ok, false);
  assert.equal(assertUserRootOutsideInstallRoot({ ...base, installRoot: 'C:\\Apps\\E', userRoot: 'C:\\Users\\X' }).ok, false);
  assert.equal(assertUserRootOutsideInstallRoot({ ...base, installRoot: 'C:\\Apps\\E', userRoot: 'C:\\Windows\\u' }).ok, false);
});

ck('版本比较：升级/同版/降级/预发布', () => {
  assert.equal(compareVersions('0.1.3', '0.1.2'), 1);
  assert.equal(compareVersions('0.1.3', '0.1.3'), 0);
  assert.equal(compareVersions('0.1.2', '0.1.3'), -1);
  assert.equal(compareVersions('0.1.3-beta', '0.1.3'), -1);
  assert.equal(compareVersions('x', '0.1.3'), null);
});

ck('current.json：合法/版本漂移/坏 schema/previous 回退', () => {
  const t = tmp();
  const inst = path.join(t, 'inst');
  for (const v of ['0.1.3', '0.1.2']) write(path.join(inst, 'versions', v, 'app', 'package.json'), pkgJson(v));
  const good = { schema: 1, current: '0.1.3', previous: '0.1.2', health: 'ok', failures: 0 };
  assert.equal(validateCurrent({ installRoot: inst, current: good, expectedAppId: 'com.estrellabot.windows' }).ok, true);
  assert.equal(validateCurrent({ installRoot: inst, current: { ...good, current: '0.1.3', schema: 2 } }).ok, false);
  assert.equal(validateCurrent({ installRoot: inst, current: { ...good, current: '9.9.9' } }).ok, false);
  const eff = effectiveProgram({ installRoot: inst, current: { ...good, current: '9.9.9' }, expectedAppId: 'com.estrellabot.windows' });
  assert.equal(eff.ok, true);
  assert.equal(eff.fallback, true);
  assert.equal(eff.version, '0.1.2');
  fs.rmSync(t, { recursive: true, force: true });
});

ck('install.json/current.json 原子读写', () => {
  const t = tmp();
  const inst = path.join(t, 'inst');
  writeJsonAtomic(path.join(inst, 'install.json'), { schema: 1, userRoot: path.join(t, 'u') });
  writeJsonAtomic(path.join(inst, 'current.json'), { schema: 1, current: '0.1.3', previous: null, health: 'pending' });
  assert.equal(readInstallInfo(inst).userRoot, path.join(t, 'u'));
  assert.equal(readCurrentInfo(inst).current, '0.1.3');
  assert.equal(fs.readdirSync(inst).some((n) => n.includes('.tmp-')), false);
  fs.rmSync(t, { recursive: true, force: true });
});

ck('classifyProcess：只认本安装根的精确 node 入口', () => {
  const inst = 'C:\\Users\\X\\AppData\\Local\\Programs\\Estrella-Bot';
  const node = `${inst}\\runtime\\node\\node.exe`;
  const panel = `${inst}\\versions\\0.1.3\\app\\panel\\server.js`;
  const bridge = `${inst}\\versions\\0.1.3\\app\\src\\index.js`;
  assert.deepEqual(classifyProcess({ cmd: `"${node}" "${panel}"`, execPath: node, installRoot: inst, versions: ['0.1.3'] }),
    { ours: true, reason: 'ok', version: '0.1.3', kind: 'panel' });
  assert.equal(classifyProcess({ cmd: `"${node}" --max-old-space-size=384 "${bridge}"`, execPath: node, installRoot: inst, versions: ['0.1.3'] }).kind, 'bridge');
  assert.equal(classifyProcess({ cmd: `"${node}" "${panel}"`, execPath: node, installRoot: inst, versions: ['0.1.3'] }).ours, true);
  // 别的包（只差一个字符）、别的 node、相对入口都不算
  assert.equal(classifyProcess({ cmd: `"${node}" "${inst}2\\versions\\0.1.3\\app\\panel\\server.js"`, execPath: node, installRoot: inst, versions: ['0.1.3'] }).ours, false);
  assert.equal(classifyProcess({ cmd: `"C:\\Other\\node.exe" "${panel}"`, execPath: 'C:\\Other\\node.exe', installRoot: inst, versions: ['0.1.3'] }).ours, false);
  assert.equal(classifyProcess({ cmd: '"C:\\Other\\node.exe" "src\\index.js"', execPath: 'C:\\Other\\node.exe', installRoot: inst, versions: ['0.1.3'] }).ours, false);
});

ck('classifyProcess：壳只认本安装根 versions/<ver>/app/electron 的主进程', () => {
  const inst = 'C:\\Users\\X\\AppData\\Local\\Programs\\Estrella-Bot';
  const shellExe = `${inst}\\versions\\0.1.3\\app\\electron\\electron.exe`;
  const appDir = `${inst}\\versions\\0.1.3\\app\\electron`;
  assert.deepEqual(
    classifyProcess({ cmd: `"${shellExe}" "${appDir}"`, execPath: shellExe, installRoot: inst, versions: ['0.1.3'] }),
    { ours: true, reason: 'ok', version: '0.1.3', kind: 'shell' },
  );
  // 渲染/GPU 子进程带 --type=：不单杀，交给主进程 /T 树杀
  assert.equal(classifyProcess({
    cmd: `"${shellExe}" "${appDir}" --type=renderer`, execPath: shellExe, installRoot: inst, versions: ['0.1.3'],
  }).ours, false);
  // 同机其它 Electron、别的 app 目录、旧式 installRoot/electron 都不认
  assert.equal(classifyProcess({
    cmd: `"C:\\Other\\electron.exe" "${appDir}"`, execPath: 'C:\\Other\\electron.exe', installRoot: inst, versions: ['0.1.3'],
  }).ours, false);
  assert.equal(classifyProcess({
    cmd: `"${shellExe}" "C:\\Other\\app"`, execPath: shellExe, installRoot: inst, versions: ['0.1.3'],
  }).ours, false);
  assert.equal(classifyProcess({
    cmd: `"${inst}\\electron\\electron.exe" "${inst}\\electron"`,
    execPath: `${inst}\\electron\\electron.exe`, installRoot: inst, versions: ['0.1.3'],
  }).ours, false);
});

ck('launch defaultMode：无显式 mode 用 window，显式配置永远优先', () => {
  assert.equal(launchOfConfig({}, { defaultMode: 'window' }).mode, 'window');
  assert.equal(launchOfConfig({ launch: { openOnStart: false } }, { defaultMode: 'window' }).mode, 'window');
  assert.equal(launchOfConfig({ launch: { mode: 'browser' } }, { defaultMode: 'window' }).mode, 'browser');
  assert.equal(launchOfConfig({ launch: { mode: 'window' } }, { defaultMode: 'browser' }).mode, 'window');
});

ck('isOurBridge：current + previous 两个程序根都认', () => {
  const inst = 'C:\\Users\\X\\AppData\\Local\\Programs\\Estrella-Bot';
  const node = `${inst}\\runtime\\node\\node.exe`;
  const cur = `${inst}\\versions\\0.1.3\\app`;
  const prev = `${inst}\\versions\\0.1.2\\app`;
  const prevCmd = `"${node}" "${prev}\\src\\index.js"`;
  assert.equal(isOurBridge({ cmd: prevCmd, execPath: node, cwd: '', roots: [cur, prev] }).reason, 'ok-abs-entry');
  assert.equal(isOurBridge({ cmd: prevCmd, execPath: node, cwd: prev, roots: [cur, prev] }).reason, 'ok');
  assert.equal(isOurBridge({ cmd: prevCmd, execPath: node, cwd: '', roots: [cur] }).ours, false);
});

await ckA('launcher：全新安装根能起面板、写 health=ok、按配置不自动开窗', async () => {
  if (process.platform === 'win32') return; // Windows 版在 VM 验收里跑
  const t = tmp('p2-launcher-');
  const inst = path.join(t, 'inst');
  const ud = path.join(t, 'userdata');
  const app = path.join(inst, 'versions', VER, 'app');
  fs.mkdirSync(app, { recursive: true });
  // ESM 会解析 symlink 到真实路径，import.meta.url 就不再是安装根 ⇒ 这里必须真复制。
  for (const rel of ['src', 'panel', 'node_modules/ws', 'scripts']) {
    const src = path.join(REPO, rel);
    if (fs.existsSync(src)) fs.cpSync(src, path.join(app, rel), { recursive: true, force: true });
  }
  for (const rel of ['package.json', 'config.example.json']) {
    fs.copyFileSync(path.join(REPO, rel), path.join(app, rel));
  }
  writeJsonAtomic(path.join(inst, 'install.json'), {
    schema: 1, appId: 'com.estrellabot.windows', installRoot: inst, userRoot: ud,
    installedVersion: VER,
  });
  writeJsonAtomic(path.join(inst, 'current.json'), {
    schema: 1, current: VER, previous: null, health: 'pending', failures: 0,
  });
  writeJsonAtomic(path.join(ud, 'config.json'), { launch: { openOnStart: false } });
  const port = 52000 + Math.floor(Math.random() * 1000);
  const r = spawnSync(process.execPath, [path.join(REPO, 'packaging/windows/tools/launcher.mjs'),
    '--install-root', inst], {
    encoding: 'utf8',
    timeout: 45000,
    env: { ...process.env, QQBOT_PANEL_PORT: String(port), TEMP: t, TMP: t, NODE_OPTIONS: '' },
  });
  let health;
  try {
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    health = readCurrentInfo(inst).health;
  } finally {
    const pids = spawnSync('lsof', ['-ti', `tcp:${port}`], { encoding: 'utf8' }).stdout
      .split('\n').map((s) => Number(s.trim())).filter((n) => n > 0);
    for (const pid of pids) { try { process.kill(pid, 'SIGTERM'); } catch { /* 已退出 */ } }
    await new Promise((res) => setTimeout(res, 600));
    fs.rmSync(t, { recursive: true, force: true });
  }
  assert.equal(health, 'ok');
});

ck('bootstrap：安装根内用新 runtime 生成 config.json 与 setup marker', () => {
  const t = tmp('p2-bootstrap-');
  const inst = path.join(t, 'inst');
  const ud = path.join(t, 'userdata');
  const app = path.join(inst, 'versions', VER, 'app');
  fs.mkdirSync(app, { recursive: true });
  for (const rel of ['src']) fs.cpSync(path.join(REPO, rel), path.join(app, rel), { recursive: true });
  for (const rel of ['package.json', 'config.example.json']) fs.copyFileSync(path.join(REPO, rel), path.join(app, rel));
  fs.cpSync(path.join(REPO, 'packaging', 'windows', 'tools'), path.join(inst, 'tools'), { recursive: true });
  writeJsonAtomic(path.join(inst, 'install.json'), {
    schema: 1, appId: 'com.estrellabot.windows', installRoot: inst, userRoot: ud, installedVersion: VER,
  });
  writeJsonAtomic(path.join(inst, 'current.json'), { schema: 1, current: VER, previous: null, health: 'ok', failures: 0 });
  const r = spawnSync(process.execPath, [path.join(inst, 'tools', 'bootstrap.mjs'), '--install-root', inst, '--user-root', ud], {
    encoding: 'utf8',
    timeout: 30000,
    env: { ...process.env, QQBOT_MODE: 'installed', QQBOT_USER_ROOT: ud, QQBOT_CONFIG: path.join(ud, 'config.json'), NODE_OPTIONS: '' },
  });
  try {
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.equal(fs.existsSync(path.join(ud, 'config.json')), true);
    assert.equal(fs.existsSync(path.join(ud, 'setup-state.json')), true);
    // P7：默认改 browser —— window（Edge --app + 专用 profile）首跑必出灰色空窗，见 §22
    assert.equal(JSON.parse(fs.readFileSync(path.join(ud, 'config.json'), 'utf8')).launch.mode, 'browser');
  } finally {
    fs.rmSync(t, { recursive: true, force: true });
  }
});

ck('isNapcatProcess：只认 userRoot/napcat 下的非 node 进程', () => {
  const userRoot = 'C:\\Users\\X\\AppData\\Local\\EstrellaBot\\userdata';
  assert.equal(isNapcatProcess(`cmd.exe /c "${userRoot}\\napcat\\launcher-user.bat"`, userRoot), true);
  assert.equal(isNapcatProcess('"C:\\Other\\napcat\\launcher.bat"', userRoot), false);
  assert.equal(isNapcatProcess(`"C:\\Program Files\\nodejs\\node.exe" "${userRoot}\\napcat\\x.js"`, userRoot), false);
});

ck('resolveImportSource：旧包根/userdata/app 三形态', () => {
  const t = tmp();
  write(path.join(t, 'pkg', 'userdata', 'config.json'), '{}');
  assert.equal(resolveImportSource(path.join(t, 'pkg')).layout, 'userdata');
  write(path.join(t, 'old', 'app', 'config.json'), '{}');
  assert.equal(resolveImportSource(path.join(t, 'old')).layout, 'app');
  fs.mkdirSync(path.join(t, 'bare'));
  assert.equal(resolveImportSource(path.join(t, 'bare')).layout, 'root');
  fs.rmSync(t, { recursive: true, force: true });
});

ck('payload manifest：正常通过；篡改/白名单外/计数不符都拒绝', () => {
  const t = tmp();
  const stage = path.join(t, 'stage');
  write(path.join(stage, 'app', 'package.json'), pkgJson('0.1.3'));
  write(path.join(stage, 'app', 'src', 'user-root.js'), 'export const x=1;\n');
  const files = ['app/package.json', 'app/src/user-root.js'].map((rel) => {
    const full = path.join(stage, rel);
    return { path: rel, size: fs.statSync(full).size, sha256: sha256FileSync(full) };
  });
  const manifest = { schema: 1, version: '0.1.3', appId: 'com.estrellabot.windows', count: files.length, files };
  writeJsonAtomic(path.join(stage, 'payload-manifest.json'), manifest);
  assert.equal(verifyPayloadManifest(stage, { expectedVersion: '0.1.3', expectedAppId: 'com.estrellabot.windows' }).ok, true);

  const bad = { ...manifest, count: files.length + 1 };
  writeJsonAtomic(path.join(stage, 'payload-manifest.json'), bad);
  assert.equal(verifyPayloadManifest(stage).ok, false);

  write(path.join(stage, 'config.json'), '{}');
  const tampered = { ...manifest, files: [...files, { path: 'config.json', size: 2, sha256: '0'.repeat(64) }], count: 3 };
  writeJsonAtomic(path.join(stage, 'payload-manifest.json'), tampered);
  const r = verifyPayloadManifest(stage);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('白名单外') || e.includes('不在 payload 白名单') || e.includes('哈希不符')));

  write(path.join(stage, 'evil.txt'), 'x');
  const outside = { ...manifest, files: [...files, { path: 'evil.txt', size: 1, sha256: sha256FileSync(path.join(stage, 'evil.txt')) }], count: 3 };
  writeJsonAtomic(path.join(stage, 'payload-manifest.json'), outside);
  assert.ok(verifyPayloadManifest(stage).errors.some((e) => e.includes('不在 payload 白名单')));

  // runtime 里 npm 自带的 docs 不应被当成“用户文档”拒掉。
  write(path.join(stage, 'runtime', 'node', 'node_modules', 'npm', 'docs', 'x.md'), '# npm\n');
  const withRuntimeDocs = {
    ...manifest,
    files: [...files, {
      path: 'runtime/node/node_modules/npm/docs/x.md',
      size: fs.statSync(path.join(stage, 'runtime/node/node_modules/npm/docs/x.md')).size,
      sha256: sha256FileSync(path.join(stage, 'runtime/node/node_modules/npm/docs/x.md')),
    }],
    count: files.length + 1,
  };
  writeJsonAtomic(path.join(stage, 'payload-manifest.json'), withRuntimeDocs);
  assert.equal(verifyPayloadManifest(stage).ok, true);
  writeJsonAtomic(path.join(stage, 'payload-manifest.json'), manifest);

  const edited = fs.readFileSync(path.join(stage, 'app', 'package.json'), 'utf8');
  write(path.join(stage, 'app', 'package.json'), `${edited} `);
  writeJsonAtomic(path.join(stage, 'payload-manifest.json'), manifest);
  assert.equal(verifyPayloadManifest(stage).ok, false);
  fs.rmSync(t, { recursive: true, force: true });
});

ck('安装事务：全新安装落 versions/current/install/runtime', () => {
  const t = tmp('p2-commit-');
  const inst = path.join(t, 'inst');
  const ud = path.join(t, 'userdata');
  const stage = makeStage(t, '0.1.3');
  const r = runCommit(['--install-root', inst, '--stage', stage, '--version', '0.1.3', '--user-root', ud]);
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.equal(fs.existsSync(path.join(inst, 'versions', '0.1.3', 'app', 'package.json')), true);
  assert.equal(fs.existsSync(path.join(inst, 'runtime', 'node', 'node.exe')), true);
  assert.equal(fs.existsSync(path.join(inst, 'tools', 'stop.mjs')), true);
  const cur = readCurrentInfo(inst);
  assert.equal(cur.current, '0.1.3');
  assert.equal(cur.previous, null);
  assert.equal(cur.health, 'pending');
  const info = readInstallInfo(inst);
  assert.equal(info.userRoot, ud);
  assert.equal(fs.existsSync(path.join(ud, '.estrellabot-user-root')), true);
  assert.equal(fs.existsSync(path.join(ud, 'update', 'install-request.json')), true);
  fs.rmSync(t, { recursive: true, force: true });
});

ck('安装事务：升级保留数据、previous 指向旧版、runtime 有备份', () => {
  const t = tmp('p2-upgrade-');
  const inst = path.join(t, 'inst');
  const ud = path.join(t, 'userdata');
  const s1 = makeStage(t, '0.1.3');
  assert.equal(runCommit(['--install-root', inst, '--stage', s1, '--version', '0.1.3', '--user-root', ud]).status, 0);
  write(path.join(ud, 'config.json'), '{"keep":true}\n');
  const s2 = makeStage(t, '0.1.4');
  const r = runCommit(['--install-root', inst, '--stage', s2, '--version', '0.1.4', '--user-root', ud]);
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  const cur = readCurrentInfo(inst);
  assert.equal(cur.current, '0.1.4');
  assert.equal(cur.previous, '0.1.3');
  assert.equal(fs.readFileSync(path.join(ud, 'config.json'), 'utf8'), '{"keep":true}\n');
  assert.equal(fs.existsSync(path.join(inst, 'versions', '0.1.3', 'app', 'package.json')), true);
  assert.equal(fs.existsSync(path.join(inst, 'runtime', 'node.previous')), true);
  assert.equal(fs.existsSync(path.join(inst, 'runtime', 'node', '.runtime.json')), true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(inst, 'runtime', 'node', '.runtime.json'), 'utf8')).installedBy, '0.1.4');
  fs.rmSync(t, { recursive: true, force: true });
});

ck('安装事务：拒绝降级、userRoot 在安装根内、payload 篡改', () => {
  const t = tmp('p2-reject-');
  const inst = path.join(t, 'inst');
  const ud = path.join(t, 'ud');
  const s3 = makeStage(t, '0.1.3');
  assert.equal(runCommit(['--install-root', inst, '--stage', s3, '--version', '0.1.3', '--user-root', ud]).status, 0);
  const s2 = makeStage(t, '0.1.2');
  const down = runCommit(['--install-root', inst, '--stage', s2, '--version', '0.1.2', '--user-root', ud]);
  assert.notEqual(down.status, 0);
  assert.match(`${down.stdout}${down.stderr}`, /拒绝降级/);
  assert.equal(readCurrentInfo(inst).current, '0.1.3');

  const inst2 = path.join(t, 'inst2');
  const inside = runCommit(['--install-root', inst2, '--stage', s3, '--version', '0.1.3', '--user-root', path.join(inst2, 'userdata')]);
  assert.notEqual(inside.status, 0);
  assert.equal(fs.existsSync(path.join(inst2, 'current.json')), false);

  const badStage = path.join(t, 'bad-stage');
  fs.cpSync(s3, badStage, { recursive: true });
  fs.writeFileSync(path.join(badStage, 'app', 'package.json'), pkgJson('0.1.3').replace('0.1.3', '0.1.3 '));
  const bad = runCommit(['--install-root', path.join(t, 'inst3'), '--stage', badStage, '--version', '0.1.3', '--user-root', path.join(t, 'ud3')]);
  assert.notEqual(bad.status, 0);
  assert.equal(fs.existsSync(path.join(t, 'inst3', 'current.json')), false);
  fs.rmSync(t, { recursive: true, force: true });
});

ck('事务恢复：restoreJournal 把旧目录/指针放回', () => {
  const t = tmp('p2-restore-');
  const inst = path.join(t, 'inst');
  const target = path.join(inst, 'versions', '0.1.3');
  const backup = path.join(inst, 'versions', '0.1.3.old-ts');
  write(path.join(target, 'app', 'old.txt'), 'old\n');
  write(path.join(inst, 'install.json'), JSON.stringify({ schema: 1, installedVersion: '0.1.3' }));
  write(path.join(inst, 'current.json'), JSON.stringify({ schema: 1, current: '0.1.3', previous: null, health: 'ok' }));
  fs.renameSync(target, backup);
  write(path.join(target, 'app', 'new.txt'), 'new\n');
  restoreJournal(inst, {
    schema: 1,
    entries: [{ target, backup, created: false }],
    hadInstall: true,
    oldInstall: { schema: 1, installedVersion: '0.1.3' },
    hadCurrent: true,
    oldCurrent: { schema: 1, current: '0.1.3', previous: null, health: 'ok' },
  }, () => {});
  assert.equal(fs.readFileSync(path.join(target, 'app', 'old.txt'), 'utf8'), 'old\n');
  assert.equal(fs.existsSync(path.join(target, 'app', 'new.txt')), false);
  assert.equal(fs.existsSync(backup), false);
  assert.equal(readCurrentInfo(inst).current, '0.1.3');
  fs.rmSync(t, { recursive: true, force: true });
});

console.log(`\n${checks - failures}/${checks} passed`);
if (failures) process.exitCode = 1;
