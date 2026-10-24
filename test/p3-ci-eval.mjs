// P3-5 · CI 构建对账的纯判据（2026-10-24）。
//
// 目标：映射表、BUILD-INFO 与对账器的 fail-closed 不靠"手工跑过一次"。
// 跑法：NODE_OPTIONS= node test/p3-ci-eval.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseBuildInfo, writeBuildInfo, shortCommit } from '../packaging/windows/tools/lib/build-info.mjs';
import { stageTarget, portableKind } from '../packaging/windows/installer/build-map.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COMPARE = path.join(ROOT, 'packaging', 'windows', 'installer', 'compare-builds.mjs');
let pass = 0;
const fails = [];
const ok = (name, fn) => {
  try { fn(); pass += 1; console.log(`  PASS  ${name}`); }
  catch (e) { fails.push(`${name}: ${e.message}`); console.log(`  FAIL  ${name} — ${e.message}`); }
};

ok('BUILD-INFO roundtrip 保留 sourceCommit/sourceWorktree', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p35-bi-'));
  try {
    const file = path.join(tmp, 'BUILD-INFO.txt');
    writeBuildInfo(file, {
      version: '0.1.4', appId: 'com.estrellabot.windows',
      sourceCommit: 'a'.repeat(40), sourceWorktree: 'clean',
      buildCommit: 'b'.repeat(40), builtAt: '2026-10-24T00:00:00.000Z',
    });
    const got = parseBuildInfo(fs.readFileSync(file, 'utf8'));
    assert.equal(got.schema, '1');
    assert.equal(got.sourceCommit, 'a'.repeat(40));
    assert.equal(got.sourceWorktree, 'clean');
    assert.equal(got.version, '0.1.4');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

ok('shortCommit：全哈希取 7 位，短哈希原样', () => {
  assert.equal(shortCommit('abcdef0123456789'), 'abcdef0');
  assert.equal(shortCommit('abcdef0'), 'abcdef0');
});

ok('stage → ④ 映射：README/许可/启动器/Electron 壳与运行时', () => {
  assert.equal(stageTarget('README.html').to, 'README-installed.html');
  assert.equal(stageTarget('LICENSE').to, 'app/LICENSE');
  assert.equal(stageTarget('THIRD-PARTY-NOTICES.md').to, 'app/THIRD-PARTY-NOTICES.md');
  assert.equal(stageTarget('launcher/Estrella-Bot.vbs').to, 'Estrella-Bot.vbs');
  assert.equal(stageTarget('app/electron/main.js').kind, 'mapped');
  assert.equal(stageTarget('app/electron/electron.exe').kind, 'stage-only');
  assert.equal(stageTarget('resources/update-pubkey.pem').kind, 'stage-only');
  assert.equal(stageTarget('BUILD-INFO.txt').kind, 'stage-only');
  assert.equal(stageTarget('nope.txt').kind, 'unexpected');
});

ok('④ 分类：dotfiles/docs 可解释，strict 面之外未分类才算错', () => {
  const mapped = new Map([['app/panel/server.js', {}]]);
  assert.equal(portableKind('app/.gitignore', mapped), 'portable-only');
  assert.equal(portableKind('app/docs/ARCHITECTURE.md', mapped), 'portable-only');
  assert.equal(portableKind('app/panel/server.js', mapped), 'mapped');
  assert.equal(portableKind('app/panel/extra.js', mapped), 'unexpected');
});

ok('对账器：哈希不符必须 exit 1（不许假绿）', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p35-cmp-'));
  try {
    const portable = path.join(tmp, 'portable');
    fs.mkdirSync(path.join(portable, 'app'), { recursive: true });
    fs.writeFileSync(path.join(portable, 'app', 'package.json'), '{"v":2}\n');
    writeBuildInfo(path.join(portable, 'BUILD-INFO.txt'), {
      version: '0.1.4', appId: 'com.estrellabot.windows',
      sourceCommit: 'c'.repeat(40), sourceWorktree: 'clean', nodeRuntime: '22.23.3',
    });
    fs.writeFileSync(path.join(portable, 'SHA256SUMS.txt'), '');
    const manifest = path.join(tmp, 'payload-manifest.json');
    fs.writeFileSync(manifest, JSON.stringify({
      schema: 1, version: '0.1.4', appId: 'com.estrellabot.windows', count: 1,
      files: [{ path: 'app/package.json', size: 8, sha256: '0'.repeat(64) }],
    }));
    const bi = path.join(tmp, 'BUILD-INFO.txt');
    writeBuildInfo(bi, {
      version: '0.1.4', appId: 'com.estrellabot.windows',
      sourceCommit: 'c'.repeat(40), sourceWorktree: 'clean', nodeRuntime: '22.23.3 (copied)',
      electronRuntime: '44.9.3 (cached)',
    });
    const r = spawnSync(process.execPath, [COMPARE, '--portable', portable, '--payload-manifest', manifest, '--build-info', bi], {
      encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' },
    });
    assert.equal(r.status, 1, `期望 exit 1，实得 ${r.status}\n${r.stdout}\n${r.stderr}`);
    assert.match(`${r.stdout}${r.stderr}`, /哈希不符|清单缺项/);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

ok('对账器：stage 未分类路径必须 exit 1', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p35-cmp2-'));
  try {
    const portable = path.join(tmp, 'portable');
    fs.mkdirSync(portable, { recursive: true });
    writeBuildInfo(path.join(portable, 'BUILD-INFO.txt'), {
      version: '0.1.4', appId: 'com.estrellabot.windows',
      sourceCommit: 'd'.repeat(40), sourceWorktree: 'clean', nodeRuntime: '22.23.3',
    });
    fs.writeFileSync(path.join(portable, 'SHA256SUMS.txt'), '');
    const manifest = path.join(tmp, 'payload-manifest.json');
    fs.writeFileSync(manifest, JSON.stringify({ schema: 1, files: [{ path: 'weird.txt', size: 1, sha256: '0'.repeat(64) }] }));
    const bi = path.join(tmp, 'BUILD-INFO.txt');
    writeBuildInfo(bi, {
      version: '0.1.4', appId: 'com.estrellabot.windows',
      sourceCommit: 'd'.repeat(40), sourceWorktree: 'clean', nodeRuntime: '22.23.3',
    });
    const r = spawnSync(process.execPath, [COMPARE, '--portable', portable, '--payload-manifest', manifest, '--build-info', bi], {
      encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' },
    });
    assert.equal(r.status, 1);
    assert.match(`${r.stdout}${r.stderr}`, /未分类路径/);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

if (fails.length) {
  console.error(`\n✗ p3-ci-eval：${pass} 通过 / ${fails.length} 失败`);
  for (const f of fails) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`\n✓ p3-ci-eval：${pass}/${pass} 通过`);
