#!/usr/bin/env node
/**
 * CI 安装器产物 ↔ 本地 ④ 便携包的逐条对账（P3-5 · 2026-10-24）。
 *
 * 判据（P3-5 原文）：CI 产物与本地 ④ 包内容可逐条对齐，含 BUILD-INFO 的源提交
 * 与 clean 标记。两包分发面不同，映射写在 `build-map.mjs`，这里只做比较与报错。
 *
 * 用法：
 *   node packaging/windows/installer/compare-builds.mjs \
 *     --portable <④目录> --payload-manifest <artifact>/payload-manifest.json \
 *     --build-info <artifact>/BUILD-INFO.txt [--receipt <artifact>/build-receipt.json] \
 *     [--json-out <file>]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256FileSync } from '../tools/lib/install-layout.mjs';
import { readBuildInfo } from '../tools/lib/build-info.mjs';
import {
  stageTarget, portableKind,
  PORTABLE_STRICT_PREFIXES,
} from './build-map.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..', '..');
const argOf = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? String(process.argv[i + 1] || '') : '';
};
const exists = (p) => { try { return fs.existsSync(p); } catch { return false; } };
const fail = (msg) => { console.error(`✗ ${msg}`); process.exitCode = 1; };

function walk(root) {
  const out = [];
  const visit = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === '.DS_Store' || e.name === 'Thumbs.db') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) visit(full);
      else if (e.isFile()) out.push(path.relative(root, full).split(path.sep).join('/'));
    }
  };
  visit(root);
  return out.sort();
}

function nodeVersion(text) {
  return String(text || '').trim().split(/\s+/)[0];
}

function sumsItems() {
  const file = path.join(REPO, 'packaging', 'windows', 'make-sums.py');
  if (!exists(file)) return [];
  const text = fs.readFileSync(file, 'utf8');
  const block = text.match(/ITEMS\s*=\s*\[([\s\S]*?)\n\]/);
  if (!block) return [];
  return [...block[1].matchAll(/^\s*"([^"]+)",\s*$/gm)].map((m) => m[1]);
}

function main() {
  const portable = path.resolve(argOf('--portable') || '');
  const manifestFile = path.resolve(argOf('--payload-manifest') || '');
  const buildInfoFile = path.resolve(argOf('--build-info') || '');
  const receiptFile = path.resolve(argOf('--receipt') || '');
  if (!portable || !manifestFile || !buildInfoFile) {
    console.error('用法：compare-builds.mjs --portable <④> --payload-manifest <json> --build-info <txt> [--receipt <json>]');
    process.exit(2);
  }
  if (!exists(portable) || !exists(manifestFile) || !exists(buildInfoFile)) {
    fail('输入路径不存在');
    return;
  }
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  const mapped = new Map();
  const stageOnly = [];
  const unexpectedStage = [];
  const duplicateMismatch = [];
  for (const f of manifest.files || []) {
    const m = stageTarget(f.path);
    if (m.kind === 'mapped') {
      if (mapped.has(m.to)) {
        const prev = mapped.get(m.to);
        if (prev.sha256 !== f.sha256 || prev.size !== f.size) {
          duplicateMismatch.push({ target: m.to, a: prev.stage, b: f.path });
        }
      } else {
        mapped.set(m.to, { stage: f.path, size: f.size, sha256: f.sha256 });
      }
    } else if (m.kind === 'stage-only') stageOnly.push(f.path);
    else unexpectedStage.push(f.path);
  }

  const portableFiles = walk(portable);
  const missingInPortable = [];
  const hashMismatch = [];
  for (const [rel, want] of mapped) {
    const full = path.join(portable, rel);
    if (!exists(full)) { missingInPortable.push(rel); continue; }
    const size = fs.statSync(full).size;
    const sha = sha256FileSync(full);
    if (size !== want.size || sha !== want.sha256) {
      hashMismatch.push({ path: rel, stage: want.stage, wantSize: want.size, gotSize: size, wantSha: want.sha256, gotSha: sha });
    }
  }
  const portableOnly = [];
  const missingInStage = [];
  const unexpectedPortable = [];
  for (const rel of portableFiles) {
    if (mapped.has(rel)) continue;
    const kind = portableKind(rel, mapped);
    if (kind === 'portable-only') portableOnly.push(rel);
    else if (PORTABLE_STRICT_PREFIXES.some((p) => rel.startsWith(p))) missingInStage.push(rel);
    else unexpectedPortable.push(rel);
  }

  const ciInfo = readBuildInfo(buildInfoFile);
  const portableInfo = exists(path.join(portable, 'BUILD-INFO.txt'))
    ? readBuildInfo(path.join(portable, 'BUILD-INFO.txt')) : null;
  const buildInfo = { ci: ciInfo, portable: portableInfo };
  const infoMismatch = [];
  if (!portableInfo) {
    infoMismatch.push('④ 缺 BUILD-INFO.txt');
  } else {
    for (const k of ['version', 'appId', 'sourceCommit', 'sourceWorktree']) {
      if (String(ciInfo[k] ?? '') !== String(portableInfo[k] ?? '')) {
        infoMismatch.push(`${k}: CI=${ciInfo[k]} ≠ ④=${portableInfo[k]}`);
      }
    }
    if (ciInfo.sourceWorktree !== 'clean' || portableInfo.sourceWorktree !== 'clean') {
      infoMismatch.push(`worktree 不是 clean：CI=${ciInfo.sourceWorktree} ④=${portableInfo.sourceWorktree}`);
    }
    if (nodeVersion(ciInfo.nodeRuntime) !== nodeVersion(portableInfo.nodeRuntime)) {
      infoMismatch.push(`nodeRuntime: CI=${ciInfo.nodeRuntime} ≠ ④=${portableInfo.nodeRuntime}`);
    }
  }

  const receiptArg = argOf('--receipt');
  const receipt = receiptArg && exists(receiptFile) ? JSON.parse(fs.readFileSync(receiptFile, 'utf8')) : null;
  if (receipt && (receipt.sourceCommit !== ciInfo.sourceCommit
    || receipt.sourceWorktree !== 'clean' || receipt.version !== ciInfo.version)) {
    infoMismatch.push('build-receipt 与 BUILD-INFO 的 sourceCommit/clean/version 不一致');
  }

  const sumsFile = path.join(portable, 'SHA256SUMS.txt');
  const sums = { entries: 0, mismatches: [], missing: [], extra: [] };
  if (!exists(sumsFile)) {
    sums.mismatches.push('④ 缺 SHA256SUMS.txt');
  } else {
    const lines = fs.readFileSync(sumsFile, 'utf8').split('\n').filter((l) => /^[0-9a-f]{64} {2}/.test(l));
    sums.entries = lines.length;
    const seen = new Set();
    for (const line of lines) {
      const m = line.match(/^([0-9a-f]{64}) {2}(.+)$/);
      const rel = m[2].replace(/\\/g, '/');
      seen.add(rel);
      const full = path.join(portable, rel);
      if (!exists(full)) { sums.missing.push(rel); continue; }
      const got = sha256FileSync(full);
      if (got !== m[1]) sums.mismatches.push(rel);
    }
    const items = sumsItems();
    for (const item of items) if (!seen.has(item)) sums.missing.push(item);
    for (const rel of seen) if (items.length && !items.includes(rel)) sums.extra.push(rel);
  }

  const ok = !missingInPortable.length && !hashMismatch.length && !unexpectedStage.length
    && !duplicateMismatch.length && !missingInStage.length && !unexpectedPortable.length
    && !infoMismatch.length && !sums.mismatches.length && !sums.missing.length && !sums.extra.length;
  const report = {
    schema: 1,
    ok,
    counts: {
      stageMapped: mapped.size,
      stageOnly: stageOnly.length,
      portableFiles: portableFiles.length,
      portableOnly: portableOnly.length,
      matched: mapped.size - missingInPortable.length - hashMismatch.length,
    },
    missingInPortable,
    hashMismatch,
    missingInStage,
    unexpectedStage,
    unexpectedPortable,
    duplicateMismatch,
    buildInfo,
    infoMismatch,
    expectedDiff: {
      builtAt: [ciInfo.builtAt, portableInfo?.builtAt],
      buildCommit: [ciInfo.buildCommit, portableInfo?.buildCommit],
      electronRuntime: [ciInfo.electronRuntime, portableInfo?.electronRuntime],
    },
    shasums: sums,
  };
  const jsonOut = argOf('--json-out');
  if (jsonOut) fs.writeFileSync(path.resolve(jsonOut), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`CI↔④ 对账：${ok ? '✓ 通过' : '✗ 有问题'}`);
  console.log(`  stage 映射 ${mapped.size} · stage-only ${stageOnly.length} · ④ 文件 ${portableFiles.length} · ④ 独有 ${portableOnly.length}`);
  for (const [label, list] of [
    ['④ 缺 CI 文件', missingInPortable], ['哈希不符', hashMismatch], ['④ 比 stage 多（严格面）', missingInStage],
    ['stage 里有未分类路径', unexpectedStage], ['④ 里有未分类路径', unexpectedPortable],
    ['同目标重复映射但哈希不同', duplicateMismatch], ['BUILD-INFO 不一致', infoMismatch],
    ['④ 清单哈希不符', sums.mismatches], ['④ 清单缺项', sums.missing], ['④ 清单多项', sums.extra],
  ]) {
    if (list.length) console.log(`  ✗ ${label}：${JSON.stringify(list).slice(0, 800)}`);
  }
  if (ok) console.log(`  ✓ sourceCommit=${ciInfo.sourceCommit.slice(0, 7)} · clean · ④ 清单 ${sums.entries} 项全过`);
  process.exit(ok ? 0 : 1);
}

try {
  main();
} catch (e) {
  fail(e && e.message ? e.message : String(e));
  process.exit(process.exitCode || 1);
}
