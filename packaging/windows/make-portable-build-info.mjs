#!/usr/bin/env node
/**
 * ④ 便携包 BUILD-INFO 的生成/核对入口（P3-5 · 2026-10-24）。
 *
 * 此前 README 第 8 步要求**手写**这份文件，于是源提交会随着时间变成一句
 * “上次是谁写的”。CI 产物要与本地 ④ 逐条对齐，就必须让 ④ 也有一份机器可读、
 * 可复核的来源信息 —— 这里用与安装器 payload 同一个 `build-info.mjs`。
 *
 * 用法：
 *   node packaging/windows/make-portable-build-info.mjs --pkg <④目录> [--check]
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readBuildInfo, writeBuildInfo, shortCommit } from './tools/lib/build-info.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const argOf = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? String(process.argv[i + 1] || '') : '';
};
const exists = (p) => { try { return fs.existsSync(p); } catch { return false; } };
const checkOnly = process.argv.includes('--check');

const pkgDir = path.resolve(argOf('--pkg') || '');
if (!pkgDir || !exists(path.join(pkgDir, 'app', 'package.json'))) {
  console.error('用法：node packaging/windows/make-portable-build-info.mjs --pkg <④目录> [--check]');
  process.exit(2);
}
const appPkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'app', 'package.json'), 'utf8'));
const rootPkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
if (appPkg.version !== rootPkg.version) {
  console.error(`✗ ④ app/package.json=${appPkg.version} ≠ 仓库 package.json=${rootPkg.version}`);
  process.exit(1);
}
if (!exists(path.join(pkgDir, 'runtime', 'node', 'node.exe'))) {
  console.error('✗ ④ 缺 runtime/node/node.exe —— 不是完整包');
  process.exit(1);
}

const provenanceFile = argOf('--provenance') || path.join(pkgDir, 'PUBLISH-PROVENANCE.json');
let provenance = null;
if (exists(provenanceFile)) {
  provenance = JSON.parse(fs.readFileSync(provenanceFile, 'utf8'));
  if (provenance.schema !== 1 || !/^[0-9a-f]{40}$/i.test(String(provenance.sourceCommit || ''))) {
    console.error('✗ PUBLISH-PROVENANCE.json schema/sourceCommit 不合法');
    process.exit(1);
  }
}
const gitHead = spawnSync('git', ['-C', REPO, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
const dirty = spawnSync('git', ['-C', REPO, 'status', '--porcelain'], { encoding: 'utf8' }).stdout.trim() ? 'dirty' : 'clean';
const sourceCommit = provenance?.sourceCommit || gitHead;
const sourceWorktree = provenance?.sourceWorktree || dirty;

let ws = '';
try {
  ws = String(JSON.parse(fs.readFileSync(path.join(pkgDir, 'app', 'node_modules', 'ws', 'package.json'), 'utf8')).version || '');
} catch { /* 缺 ws 时留空；④ 自证/安装前检查会另行报 */ }
let listItems = '';
try {
  listItems = fs.readFileSync(path.join(pkgDir, 'SHA256SUMS.txt'), 'utf8')
    .split('\n').filter((l) => /^[0-9a-f]{64} {2}/.test(l)).length;
} catch { /* 未生成清单时留空 */ }

const fields = {
  version: appPkg.version,
  appId: appPkg.appId,
  sourceCommit,
  sourceCommitShort: shortCommit(sourceCommit),
  sourceWorktree,
  buildCommit: gitHead,
  commit: shortCommit(gitHead),
  builtAt: new Date().toISOString(),
  nodeRuntime: JSON.parse(fs.readFileSync(path.join(HERE, 'installer', 'toolchain.json'), 'utf8')).node.version,
  ws,
  listItems,
  signing: 'none',
};
const target = path.join(pkgDir, 'BUILD-INFO.txt');

if (checkOnly) {
  const cur = readBuildInfo(target);
  const mismatches = [];
  for (const k of ['version', 'appId', 'sourceCommit', 'sourceWorktree', 'nodeRuntime']) {
    if (String(cur[k] ?? '') !== String(fields[k] ?? '')) mismatches.push(`${k}: ${cur[k]} ≠ ${fields[k]}`);
  }
  if (mismatches.length) {
    console.error(`✗ ④ BUILD-INFO 与当前来源不一致：\n  - ${mismatches.join('\n  - ')}`);
    process.exit(1);
  }
  console.log(`✓ ④ BUILD-INFO 一致：${sourceCommit.slice(0, 7)} · ${sourceWorktree} · ${appPkg.version}`);
  process.exit(0);
}

writeBuildInfo(target, fields);
console.log(`✓ 已写 ④ BUILD-INFO：${target}（${sourceCommit.slice(0, 7)} · ${sourceWorktree} · ${appPkg.version}）`);
