/**
 * P3-3 评估工具的纯函数测试（不跑 VM、不读真实安装）。
 * 复跑：NODE_OPTIONS= node test/p3-differential-eval.mjs
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

import {
  sha256, chunkCdc, diffFixed, diffCdc, diffTrees,
} from '../scripts/p3-differential/delta-probe.mjs';

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

function randomBuf(n, seed = 1) {
  const buf = Buffer.allocUnsafe(n);
  let x = seed >>> 0;
  for (let i = 0; i < n; i += 1) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    buf[i] = x >>> 24;
  }
  return buf;
}

function mutate(oldBuf) {
  const parts = [
    oldBuf.subarray(0, 300 * 1024),
    Buffer.from('P3-3-CHANGED-BYTES'),
    oldBuf.subarray(300 * 1024 + 18),
    Buffer.from('P3-3-INSERTED-SEGMENT'.repeat(50)),
    oldBuf.subarray(700 * 1024),
  ];
  return Buffer.concat(parts);
}

function expectedSha(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

console.log('── CDC 分块 ──');
ck('CDC 覆盖整个输入，且除末块外不超过 max', () => {
  const buf = randomBuf(300 * 1024);
  const chunks = chunkCdc(buf, { min: 2048, avg: 8192, max: 65536 });
  assert.ok(chunks.length > 0);
  assert.equal(chunks[0].start, 0);
  assert.equal(chunks[chunks.length - 1].end, buf.length);
  for (let i = 0; i < chunks.length - 1; i += 1) {
    assert.ok(chunks[i].end - chunks[i].start <= 65536);
    assert.equal(chunks[i].end, chunks[i + 1].start);
  }
});

console.log('── 固定块差分 ──');
ck('固定块：重建 SHA 一致，且确实复用旧块', () => {
  const oldBuf = randomBuf(1024 * 1024, 7);
  const newBuf = mutate(oldBuf);
  const r = diffFixed(oldBuf, newBuf, 64 * 1024);
  assert.equal(r.shaOk, true);
  assert.equal(r.rebuiltSha256, expectedSha(newBuf));
  assert.equal(r.matchedBytes + r.literalBytes, newBuf.length);
  assert.ok(r.matchedBytes > 0);
  assert.ok(r.patchGzipBytes < newBuf.length);
});

ck('固定块：完全相同输入时 literal=0', () => {
  const oldBuf = randomBuf(256 * 1024, 9);
  const r = diffFixed(oldBuf, oldBuf, 64 * 1024);
  assert.equal(r.shaOk, true);
  assert.equal(r.literalBytes, 0);
  assert.equal(r.matchedBytes, oldBuf.length);
  assert.ok(r.patchGzipBytes < 1024);
});

console.log('── CDC 差分 ──');
ck('CDC：重建 SHA 一致，且确实复用旧块', () => {
  const oldBuf = randomBuf(1024 * 1024, 11);
  const newBuf = mutate(oldBuf);
  const r = diffCdc(oldBuf, newBuf, { min: 2048, avg: 8192, max: 65536 });
  assert.equal(r.shaOk, true);
  assert.equal(r.rebuiltSha256, expectedSha(newBuf));
  assert.equal(r.matchedBytes + r.literalBytes, newBuf.length);
  assert.ok(r.matchedBytes > 0);
  assert.ok(r.patchGzipBytes < newBuf.length);
});

ck('CDC：完全相同输入时 literal=0', () => {
  const oldBuf = randomBuf(256 * 1024, 13);
  const r = diffCdc(oldBuf, oldBuf, { min: 2048, avg: 8192, max: 65536 });
  assert.equal(r.shaOk, true);
  assert.equal(r.literalBytes, 0);
  assert.equal(r.matchedBytes, oldBuf.length);
  assert.ok(r.patchGzipBytes < 1024);
});

console.log('── 文件树 diff ──');
ck('文件树：changed / added / deleted 分类与字节统计', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p33-tree-'));
  const oldRoot = path.join(tmp, 'old');
  const newRoot = path.join(tmp, 'new');
  fs.mkdirSync(path.join(oldRoot, 'sub'), { recursive: true });
  fs.mkdirSync(path.join(newRoot, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(oldRoot, 'same.txt'), 'same\n');
  fs.writeFileSync(path.join(newRoot, 'same.txt'), 'same\n');
  fs.writeFileSync(path.join(oldRoot, 'sub', 'changed.txt'), 'old\n');
  fs.writeFileSync(path.join(newRoot, 'sub', 'changed.txt'), 'new-content\n');
  fs.writeFileSync(path.join(oldRoot, 'deleted.txt'), 'gone\n');
  fs.writeFileSync(path.join(newRoot, 'added.txt'), 'added\n');
  const r = diffTrees(oldRoot, newRoot);
  assert.equal(r.changedFiles.length, 1);
  assert.equal(r.changedFiles[0].rel, 'sub/changed.txt');
  assert.equal(r.addedFiles.length, 1);
  assert.equal(r.addedFiles[0].rel, 'added.txt');
  assert.equal(r.deletedFiles.length, 1);
  assert.equal(r.deletedFiles[0].rel, 'deleted.txt');
  assert.equal(r.unchangedFiles, 1);
  assert.ok(r.changedBytes > 0);
  assert.ok(r.deletedBytes > 0);
  assert.ok(r.changedGzipBytes > 0);
  assert.ok(r.ratio > 0);
  fs.rmSync(tmp, { recursive: true, force: true });
});

ck('文件树：完全相同则 changedGzipBytes=0', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p33-tree-same-'));
  const a = path.join(tmp, 'a');
  const b = path.join(tmp, 'b');
  fs.mkdirSync(a);
  fs.mkdirSync(b);
  fs.writeFileSync(path.join(a, 'x'), 'x');
  fs.writeFileSync(path.join(b, 'x'), 'x');
  const r = diffTrees(a, b);
  assert.equal(r.unchangedFiles, 1);
  assert.equal(r.changedGzipBytes, 0);
  assert.equal(r.ratio, 0);
  fs.rmSync(tmp, { recursive: true, force: true });
});

console.log(`\n${passed}/${passed + failed} passed`);
if (failed) process.exitCode = 1;
