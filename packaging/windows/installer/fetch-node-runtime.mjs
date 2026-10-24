#!/usr/bin/env node
/**
 * 取一份**可复现**的 Windows x64 Node 运行时（P2 · 2026-10-18）。
 *
 * 运行时不入库；版本与官方 zip 的 SHA-256 钉在 `toolchain.json`。
 * 优先用镜像，直连兜底；下载后必须整份哈希匹配才解压。
 *
 * 用法：
 *   node packaging/windows/installer/fetch-node-runtime.mjs --out <dir> [--from <已有 runtime>]
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sha256FileSync, isMainModule } from '../tools/lib/install-layout.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOLCHAIN = JSON.parse(fs.readFileSync(path.join(HERE, 'toolchain.json'), 'utf8'));

function argOf(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? String(process.argv[i + 1] || '') : '';
}

async function download(url, dest) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 180000);
  try {
    const res = await fetch(url, { signal: ac.signal, redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const out = fs.createWriteStream(dest);
    for await (const chunk of res.body) {
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
    }
    await new Promise((r) => out.end(r));
  } finally {
    clearTimeout(timer);
  }
}

function extractZip(zip, extractDir) {
  fs.mkdirSync(extractDir, { recursive: true });
  if (process.platform === 'win32') {
    const r = spawnSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      `Expand-Archive -LiteralPath ${JSON.stringify(zip)} -DestinationPath ${JSON.stringify(extractDir)} -Force`,
    ], { encoding: 'utf8', windowsHide: true });
    if (r.error || r.status !== 0) throw new Error(`解压失败：${r.error ? r.error.message : r.stderr || `退出码 ${r.status}`}`);
    return;
  }
  const r = spawnSync('unzip', ['-q', zip, '-d', extractDir], { encoding: 'utf8' });
  if (r.error || r.status !== 0) {
    throw new Error(`解压失败：${r.error ? r.error.message : r.stderr || `退出码 ${r.status}`}`);
  }
}

async function main() {
  const out = path.resolve(argOf('--out') || path.join(HERE, '..', '..', 'runtime-node'));
  const from = argOf('--from');
  const version = argOf('--version') || TOOLCHAIN.node.version;
  const sha = argOf('--sha256') || TOOLCHAIN.node.sha256;
  if (fs.existsSync(path.join(out, 'node.exe'))) {
    console.log(`✓ 运行时已在位：${out}`);
    return;
  }
  if (from) {
    const src = path.resolve(from);
    if (!fs.existsSync(path.join(src, 'node.exe'))) throw new Error(`--from 里没有 node.exe：${src}`);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.cpSync(src, out, { recursive: true, force: true });
    console.log(`✓ 已复制运行时：${src} → ${out}`);
    return;
  }

  fs.mkdirSync(path.dirname(out), { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'estrella-node-'));
  const zip = path.join(tmp, TOOLCHAIN.node.zip);
  const urls = [
    TOOLCHAIN.node.mirror.replace(TOOLCHAIN.node.version, version),
    TOOLCHAIN.node.url.replace(TOOLCHAIN.node.version, version),
  ].filter((u, i, a) => u && a.indexOf(u) === i);
  const errors = [];
  let got = false;
  for (const url of urls) {
    try {
      console.log(`下载 Node ${version}：${url}`);
      await download(url, zip);
      const real = sha256FileSync(zip);
      if (sha && real !== sha) {
        errors.push(`${url} → SHA-256 不符（期望 ${sha.slice(0, 12)}… 实测 ${real.slice(0, 12)}…）`);
        continue;
      }
      got = true;
      break;
    } catch (e) {
      errors.push(`${url} → ${e.message}`);
    }
  }
  if (!got) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw new Error(`所有 Node 下载源都失败：\n  - ${errors.join('\n  - ')}\n`
      + '  可改用 --from <已有 runtime/node>（例如 ④b 里那份）。');
  }

  const extract = path.join(tmp, 'extract');
  fs.mkdirSync(extract, { recursive: true });
  extractZip(zip, extract);
  const entries = fs.readdirSync(extract, { withFileTypes: true }).filter((e) => e.isDirectory());
  const src = entries.length === 1 ? path.join(extract, entries[0].name) : extract;
  fs.cpSync(src, out, { recursive: true, force: true });
  fs.rmSync(tmp, { recursive: true, force: true });
  if (!fs.existsSync(path.join(out, 'node.exe'))) throw new Error(`解压后没有 node.exe：${out}`);
  console.log(`✓ 运行时已就位：${out}（Node ${version} · sha256 ${sha.slice(0, 12)}…）`);
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(`✗ ${e && e.message ? e.message : e}`);
    process.exitCode = 1;
  });
}
