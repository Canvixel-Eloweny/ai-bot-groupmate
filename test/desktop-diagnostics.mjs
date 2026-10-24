/**
 * 诊断包验收（P1-10 · 2026-10-23）。
 *
 * 只碰临时目录：固定清单、凭据/QQ 脱敏、fail-closed 二次扫描、ZIP 可回读。
 * 真机三类崩溃在 VM 验收里另行跑；这里保证“包本身不会带凭据/号码出去”。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildDiagnosticsBundle, buildDiagnosticsZip } from '../panel/lib/diagnostics.js';
import { readZip } from '../panel/lib/zip.js';
import { maskSecrets } from '../src/egress.js';

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

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

const t = fs.mkdtempSync(path.join(os.tmpdir(), 'diag-'));
try {
  const userRoot = path.join(t, 'userdata');
  const installRoot = path.join(t, 'inst');
  const programRoot = path.join(t, 'app');

  write(path.join(programRoot, 'package.json'), `${JSON.stringify({
    name: 'estrella-bot', version: '0.1.4', appId: 'com.estrellabot.windows',
  })}\n`);
  write(path.join(installRoot, 'install.json'), `${JSON.stringify({ schema: 1, installedVersion: '0.1.4', userRoot })}\n`);
  write(path.join(installRoot, 'current.json'), `${JSON.stringify({ schema: 1, current: '0.1.4', previous: '0.1.3', health: 'ok' })}\n`);
  write(path.join(installRoot, 'BUILD-INFO.txt'), 'version=0.1.4\n');
  write(path.join(userRoot, 'panel', 'panel.log'), '正常一行\nself_id=123456789 群 987654321\nsk-abcdefghijklmnopqrstuvwxyz\n');
  write(path.join(userRoot, 'panel', 'bridge-journal.log'), '主人 123456789 退出\n');
  write(path.join(userRoot, 'panel', '.last-exit.json'), `${JSON.stringify({ schema: 1, code: 1, reason: 'addr-in-use' })}\n`);
  write(path.join(userRoot, 'electron', 'shell.log'), 'ready\nquit: panel=42\n');
  write(path.join(userRoot, 'electron', 'shell-exit.json'), `${JSON.stringify({ schema: 1, code: 0 })}\n`);
  write(path.join(userRoot, 'electron', 'crashes', 'shell-events.jsonl'), `${JSON.stringify({ kind: 'renderer-gone', reason: 'crashed', exitCode: 5 })}\n`);
  write(path.join(userRoot, 'update', 'rollback.json'), `${JSON.stringify({ from: '0.1.4', to: '0.1.3', result: 'ok' })}\n`);
  write(path.join(userRoot, 'update', 'logs', 'install-1.log'), 'install 0.1.4 123456789\n');
  // 下面这些文件必须在包外：凭据、聊天正文、配置、群号存档。
  write(path.join(userRoot, 'panel', '.token'), 'SECRET-TOKEN-VALUE\n');
  write(path.join(userRoot, 'panel', 'bridge.log'), '聊天正文 123456789\n');
  write(path.join(userRoot, 'config.json'), '{"apiKey":"sk-abcdefghijklmnop"}\n');
  write(path.join(userRoot, 'panel', 'config-history.jsonl'), `{"apiKey":"sk-${'z'.repeat(16)}"}\n`);
  write(path.join(userRoot, 'panel', 'session-archive.json'), '{"groupId":987654321}\n');
  write(path.join(userRoot, 'napcat', 'config', 'x.json'), '{"token":"SECRET-TOKEN-VALUE"}\n');

  const bundle = buildDiagnosticsBundle({ userRoot, installRoot, programRoot, maskSecrets });
  const all = Object.entries(bundle.files).map(([n, body]) => `${n}\n${body}`).join('\n');

  ck('固定清单：summary/日志/退出/崩溃/更新日志都在', () => {
    for (const name of ['summary.json', 'panel.log', 'bridge-journal.log', 'shell.log', 'shell-exit.json', 'shell-events.jsonl', 'panel-exit.json', 'rollback.json', 'manifest.json']) {
      assert.ok(bundle.files[name], `缺 ${name}`);
    }
    assert.match(bundle.files['summary.json'], /"appVersion": "0.1.4"/);
  });

  ck('排除凭据/聊天/配置/群号存档', () => {
    assert.equal(all.includes('SECRET-TOKEN-VALUE'), false);
    assert.equal(all.includes('sk-abcdefghijklmnop'), false);
    assert.equal(all.includes('聊天正文'), false);
    assert.equal(all.includes('987654321'), false);
    assert.equal(all.includes('123456789'), false);
    assert.equal(all.includes('"apiKey"'), false);
    assert.equal(bundle.files['bridge.log'], undefined);
    assert.equal(bundle.files['config.json'], undefined);
    assert.equal(bundle.files['.token'], undefined);
  });

  ck('正常诊断内容仍在（不是把所有日志都抹空）', () => {
    assert.match(bundle.files['panel.log'], /正常一行/);
    assert.match(bundle.files['shell.log'], /quit: panel=42/);
    assert.match(bundle.files['shell-events.jsonl'], /renderer-gone/);
  });

  ck('ZIP 可回读，条目名固定', () => {
    const zip = buildDiagnosticsZip(bundle);
    const r = readZip(zip);
    assert.equal(r.ok, true, r.error);
    const names = r.entries.map((e) => e.name);
    assert.ok(names.includes('summary.json'));
    assert.ok(names.includes('manifest.json'));
  });
} finally {
  fs.rmSync(t, { recursive: true, force: true });
}

console.log(`\n${passed}/${passed + failed} passed`);
if (failed) process.exitCode = 1;
