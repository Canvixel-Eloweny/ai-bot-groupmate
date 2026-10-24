#!/usr/bin/env node
/**
 * P3-3 离线差分探针（评估工具，不属于生产更新链）。
 *
 * 三种口径：
 *   1) 固定块：按 64/256/1024 KiB 对齐比较块哈希，估计“块级复用”补丁；
 *   2) CDC：内容定义分块（gear hash），估计错位后仍能复用的补丁；
 *   3) 文件树：按文件哈希比较，给出“文件级替换”上界（只作参考）。
 *
 * 补丁只用于测量：ref = 13 字节（类型 + offset + length），literal = 1 字节类型 + 原始字节；
 * patchGzipBytes 是补丁再 gzip 后的字节数，作为“实际要下载的补丁”口径。
 * 每次都会用旧文件 + 补丁重建新文件并核对 SHA-256；不做真实分发。
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const DEFAULT_BLOCK_SIZES = [64 * 1024, 256 * 1024, 1024 * 1024];
const DEFAULT_CDC = { min: 2 * 1024, avg: 8 * 1024, max: 64 * 1024 };

const GEAR = (() => {
  const table = new Uint32Array(256);
  let x = 0x9e3779b9 >>> 0;
  for (let i = 0; i < 256; i += 1) {
    x ^= (x << 13) >>> 0;
    x ^= x >>> 17;
    x ^= (x << 5) >>> 0;
    table[i] = x >>> 0;
  }
  return table;
})();

export function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function nowMs() {
  return Number(process.hrtime.bigint() / 1000000n);
}

export function chunkCdc(buf, { min = DEFAULT_CDC.min, avg = DEFAULT_CDC.avg, max = DEFAULT_CDC.max } = {}) {
  if (!(min > 0 && avg >= min && max >= avg)) throw new Error('CDC 参数必须满足 0 < min <= avg <= max');
  const bits = Math.ceil(Math.log2(avg));
  const mask = (1 << bits) - 1;
  const chunks = [];
  let start = 0;
  let h = 0;
  for (let i = 0; i < buf.length; i += 1) {
    h = (Math.imul(h, 2) + GEAR[buf[i]]) >>> 0;
    const len = i - start + 1;
    if (len >= min && ((h & mask) === 0 || len >= max)) {
      chunks.push({ start, end: i + 1 });
      start = i + 1;
      h = 0;
    }
  }
  if (start < buf.length) chunks.push({ start, end: buf.length });
  return chunks;
}

function serializeOps(ops) {
  const parts = [];
  for (const op of ops) {
    if (op.type === 'ref') {
      const b = Buffer.allocUnsafe(13);
      b[0] = 1;
      b.writeBigUInt64LE(BigInt(op.offset), 1);
      b.writeUInt32LE(op.length, 9);
      parts.push(b);
    } else {
      const b = Buffer.allocUnsafe(1 + op.data.length);
      b[0] = 0;
      op.data.copy(b, 1);
      parts.push(b);
    }
  }
  return Buffer.concat(parts);
}

function applyOps(oldBuf, ops, expectedSize) {
  const parts = [];
  let total = 0;
  for (const op of ops) {
    const part = op.type === 'ref' ? oldBuf.subarray(op.offset, op.offset + op.length) : op.data;
    parts.push(part);
    total += part.length;
  }
  if (total !== expectedSize) throw new Error(`补丁重建长度不符：${total} != ${expectedSize}`);
  return Buffer.concat(parts, total);
}

function finishMeasure({ ops, oldBuf, newBuf, newSha, t0, t1, t2 }) {
  const patch = serializeOps(ops);
  const patchGzip = zlib.gzipSync(patch, { level: 9 });
  const applyRuns = [];
  let shaOkCount = 0;
  let rebuiltSha = '';
  for (let i = 0; i < 5; i += 1) {
    const tApply0 = nowMs();
    const rebuilt = applyOps(oldBuf, ops, newBuf.length);
    const tApply1 = nowMs();
    applyRuns.push(tApply1 - tApply0);
    rebuiltSha = sha256(rebuilt);
    if (rebuiltSha === newSha) shaOkCount += 1;
  }
  applyRuns.sort((a, b) => a - b);
  const matchedBytes = ops.filter((o) => o.type === 'ref').reduce((n, o) => n + o.length, 0);
  const literalBytes = ops.filter((o) => o.type === 'lit').reduce((n, o) => n + o.data.length, 0);
  return {
    ops: ops.length,
    matchedBytes,
    literalBytes,
    patchBytes: patch.length,
    patchGzipBytes: patchGzip.length,
    ratio: newBuf.length ? patchGzip.length / newBuf.length : 0,
    rawRatio: newBuf.length ? patch.length / newBuf.length : 0,
    diffMs: t1 - t0,
    serializeMs: t2 - t1,
    applyMs: applyRuns[2],
    applyRuns,
    rebuiltSha256: rebuiltSha,
    shaOkCount,
    shaOkTotal: 5,
    shaOk: shaOkCount === 5,
  };
}

export function diffFixed(oldBuf, newBuf, blockSize) {
  if (!Number.isInteger(blockSize) || blockSize <= 0) throw new Error('blockSize 必须是正整数');
  const t0 = nowMs();
  const oldMap = new Map();
  for (let off = 0; off < oldBuf.length; off += blockSize) {
    const end = Math.min(off + blockSize, oldBuf.length);
    const h = sha256(oldBuf.subarray(off, end));
    if (!oldMap.has(h)) oldMap.set(h, { offset: off, length: end - off });
  }
  const ops = [];
  for (let off = 0; off < newBuf.length; off += blockSize) {
    const end = Math.min(off + blockSize, newBuf.length);
    const chunk = newBuf.subarray(off, end);
    const hit = oldMap.get(sha256(chunk));
    if (hit && hit.length === chunk.length) ops.push({ type: 'ref', offset: hit.offset, length: chunk.length });
    else ops.push({ type: 'lit', data: chunk });
  }
  const t1 = nowMs();
  const t2 = nowMs();
  return { blockSize, ...finishMeasure({ ops, oldBuf, newBuf, newSha: sha256(newBuf), t0, t1, t2 }) };
}

export function diffCdc(oldBuf, newBuf, cdc = DEFAULT_CDC) {
  const opts = { ...DEFAULT_CDC, ...cdc };
  const t0 = nowMs();
  const oldChunks = chunkCdc(oldBuf, opts);
  const oldMap = new Map();
  for (const c of oldChunks) {
    const data = oldBuf.subarray(c.start, c.end);
    const h = sha256(data);
    if (!oldMap.has(h)) oldMap.set(h, { offset: c.start, length: data.length });
  }
  const newChunks = chunkCdc(newBuf, opts);
  const ops = [];
  for (const c of newChunks) {
    const chunk = newBuf.subarray(c.start, c.end);
    const hit = oldMap.get(sha256(chunk));
    const same = hit && hit.length === chunk.length
      && oldBuf.subarray(hit.offset, hit.offset + hit.length).equals(chunk);
    if (same) ops.push({ type: 'ref', offset: hit.offset, length: chunk.length });
    else ops.push({ type: 'lit', data: chunk });
  }
  const t1 = nowMs();
  const t2 = nowMs();
  return {
    ...opts,
    oldChunks: oldChunks.length,
    newChunks: newChunks.length,
    ...finishMeasure({ ops, oldBuf, newBuf, newSha: sha256(newBuf), t0, t1, t2 }),
  };
}

function walkTree(root) {
  const out = new Map();
  const visit = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) visit(full);
      else if (e.isFile()) {
        const rel = path.relative(root, full).split(path.sep).join('/');
        out.set(rel, { full, size: fs.statSync(full).size, sha256: sha256(fs.readFileSync(full)) });
      }
    }
  };
  visit(root);
  return out;
}

export function diffTrees(oldRoot, newRoot) {
  const t0 = nowMs();
  const oldMap = walkTree(oldRoot);
  const newMap = walkTree(newRoot);
  const changed = [];
  const added = [];
  const deleted = [];
  let unchangedBytes = 0;
  let changedBytes = 0;
  let deletedBytes = 0;
  let changedGzipBytes = 0;
  let newTreeBytes = 0;
  for (const [rel, n] of newMap) {
    newTreeBytes += n.size;
    const o = oldMap.get(rel);
    if (!o) {
      added.push({ rel, size: n.size });
      changedBytes += n.size;
      changedGzipBytes += zlib.gzipSync(fs.readFileSync(n.full), { level: 9 }).length + 64;
    } else if (o.size !== n.size || o.sha256 !== n.sha256) {
      changed.push({ rel, oldSize: o.size, newSize: n.size });
      changedBytes += n.size;
      changedGzipBytes += zlib.gzipSync(fs.readFileSync(n.full), { level: 9 }).length + 64;
    } else {
      unchangedBytes += n.size;
    }
  }
  for (const [rel, o] of oldMap) {
    if (!newMap.has(rel)) { deleted.push({ rel, size: o.size }); deletedBytes += o.size; }
  }
  return {
    oldFiles: oldMap.size,
    newFiles: newMap.size,
    unchangedFiles: newMap.size - changed.length - added.length,
    changedFiles: changed,
    addedFiles: added,
    deletedFiles: deleted,
    unchangedBytes,
    changedBytes,
    deletedBytes,
    newTreeBytes,
    changedGzipBytes,
    ratio: newTreeBytes ? changedGzipBytes / newTreeBytes : 0,
    elapsedMs: nowMs() - t0,
  };
}

export function diffFiles(oldFile, newFile, { blockSizes = DEFAULT_BLOCK_SIZES, cdc = DEFAULT_CDC, label = '' } = {}) {
  const oldBuf = fs.readFileSync(oldFile);
  const newBuf = fs.readFileSync(newFile);
  const result = {
    schema: 1,
    label,
    generatedAt: new Date().toISOString(),
    old: { name: path.basename(oldFile), size: oldBuf.length, sha256: sha256(oldBuf) },
    new: { name: path.basename(newFile), size: newBuf.length, sha256: sha256(newBuf) },
    fixedBlocks: [],
    cdc: null,
  };
  for (const blockSize of blockSizes) result.fixedBlocks.push(diffFixed(oldBuf, newBuf, blockSize));
  result.cdc = diffCdc(oldBuf, newBuf, cdc);
  return result;
}

function argOf(name, fallback = '') {
  const i = process.argv.indexOf(name);
  return i >= 0 ? String(process.argv[i + 1] || '') : fallback;
}
const has = (name) => process.argv.includes(name);

async function main() {
  if (has('--help') || process.argv.length <= 2) {
    console.log('用法：node scripts/p3-differential/delta-probe.mjs --old <old> --new <new> [--out <json>] [--label <id>] [--block-sizes 65536,262144,1048576] [--cdc-min 2048 --cdc-avg 8192 --cdc-max 65536]');
    console.log('   或：--old-tree <dir> --new-tree <dir> [--out <json>] [--label <id>]');
    return;
  }
  const label = argOf('--label');
  const out = argOf('--out');
  const oldFile = argOf('--old');
  const newFile = argOf('--new');
  const oldTree = argOf('--old-tree');
  const newTree = argOf('--new-tree');
  const blockSizes = argOf('--block-sizes')
    ? argOf('--block-sizes').split(',').map((s) => Number(s.trim())).filter((n) => n > 0)
    : DEFAULT_BLOCK_SIZES;
  const cdc = {
    min: Number(argOf('--cdc-min', DEFAULT_CDC.min)),
    avg: Number(argOf('--cdc-avg', DEFAULT_CDC.avg)),
    max: Number(argOf('--cdc-max', DEFAULT_CDC.max)),
  };
  if (!(oldFile && newFile) && !(oldTree && newTree)) throw new Error('必须给 --old/--new 或 --old-tree/--new-tree');
  const result = { schema: 1, label, generatedAt: new Date().toISOString() };
  if (oldFile && newFile) result.files = diffFiles(oldFile, newFile, { blockSizes, cdc, label });
  if (oldTree && newTree) {
    const labelOf = (p) => `${path.basename(path.dirname(p))}/${path.basename(p)}`;
    result.tree = { oldRoot: labelOf(oldTree), newRoot: labelOf(newTree), ...diffTrees(oldTree, newTree) };
  }
  const text = `${JSON.stringify(result, null, 2)}\n`;
  if (out) fs.writeFileSync(out, text);
  else process.stdout.write(text);
  if (result.files) {
    const c = result.files.cdc;
    console.log(`✓ ${label || path.basename(newFile)}：CDC 补丁 ${c.patchGzipBytes} B / 全包 ${result.files.new.size} B = ${(c.ratio * 100).toFixed(2)}% · apply ${c.applyMs}ms · sha=${c.shaOk}`);
  }
  if (result.tree) {
    console.log(`✓ tree：changed ${result.tree.changedFiles.length} / added ${result.tree.addedFiles.length} / deleted ${result.tree.deletedFiles.length} · gzip changed ${result.tree.changedGzipBytes} B / new ${result.tree.newTreeBytes} B = ${(result.tree.ratio * 100).toFixed(2)}%`);
  }
}

const invoked = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invoked) {
  main().catch((e) => {
    console.error(`✗ delta-probe：${e && e.message ? e.message : e}`);
    process.exitCode = 1;
  });
}
