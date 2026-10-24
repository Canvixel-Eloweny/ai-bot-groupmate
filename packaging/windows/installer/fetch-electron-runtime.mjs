#!/usr/bin/env node
/**
 * 取一份**可复现**的 Windows x64 Electron 运行时（P1-7 · 2026-10-23）。
 *
 * Electron 的壳二进制必须与 app 一起进 `versions/<ver>/app/electron`，
 * 不能像 Node runtime 那样共享 —— 回滚时旧 app 要连同旧壳一起回去。
 *
 * 版本、zip 名与 SHA-256 钉在 `toolchain.json`；镜像优先、官方兜底。
 * 用法：
 *   node fetch-electron-runtime.mjs --out <dir> [--from <已解压 dist>] [--zip <本地 zip>]
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
  const timer = setTimeout(() => ac.abort(), 300000);
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

function extract(zip, extractDir) {
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

function copyExtracted(extractDir, out) {
  const dirs = fs.readdirSync(extractDir, { withFileTypes: true }).filter((e) => e.isDirectory());
  const src = dirs.length === 1 ? path.join(extractDir, dirs[0].name) : extractDir;
  fs.cpSync(src, out, { recursive: true, force: true });
  for (const rel of ['electron.exe', 'version', path.join('resources', 'default_app.asar')]) {
    if (!fs.existsSync(path.join(out, rel))) throw new Error(`解压后缺 ${rel}：${out}`);
  }
  const ver = fs.readFileSync(path.join(out, 'version'), 'utf8').trim();
  if (!/^44\.9\.3(?:$|[.-])/.test(ver)) throw new Error(`Electron version 文件不是 44.9.3：${ver}`);
}

async function main() {
  const out = path.resolve(argOf('--out') || path.join(HERE, '..', '..', 'electron-win32-x64'));
  const from = argOf('--from');
  const zipArg = argOf('--zip');
  const version = argOf('--version') || TOOLCHAIN.electron.version;
  const sha = argOf('--sha256') || TOOLCHAIN.electron.sha256;

  if (fs.existsSync(path.join(out, 'electron.exe'))) {
    console.log(`✓ Electron 运行时已在位：${out}`);
    return;
  }
  if (from) {
    const src = path.resolve(from);
    for (const rel of ['electron.exe', 'version', path.join('resources', 'default_app.asar')]) {
      if (!fs.existsSync(path.join(src, rel))) throw new Error(`--from 里缺 ${rel}：${src}`);
    }
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.cpSync(src, out, { recursive: true, force: true });
    console.log(`✓ 已复制 Electron 运行时：${src} → ${out}`);
    return;
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'estrella-electron-'));
  const zip = zipArg ? path.resolve(zipArg) : path.join(tmp, TOOLCHAIN.electron.zip);
  try {
    if (zipArg) {
      if (!fs.existsSync(zip)) throw new Error(`--zip 不存在：${zip}`);
      const real = sha256FileSync(zip);
      if (sha && real !== sha) throw new Error(`--zip SHA-256 不符（期望 ${sha.slice(0, 12)}… 实测 ${real.slice(0, 12)}…）`);
    } else {
      const urls = [
        TOOLCHAIN.electron.mirror,
        TOOLCHAIN.electron.url,
      ].filter((u, i, a) => u && a.indexOf(u) === i);
      const errors = [];
      let got = false;
      for (const url of urls) {
        try {
          console.log(`下载 Electron ${version}：${url}`);
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
      if (!got) throw new Error(`所有 Electron 下载源都失败：\n  - ${errors.join('\n  - ')}\n`
        + '  可改用 --from <已解压 dist> 或 --zip <本地 zip>。');
    }

    const extractDir = path.join(tmp, 'extract');
    extract(zip, extractDir);
    copyExtracted(extractDir, out);
    console.log(`✓ Electron 运行时已就位：${out}（${version} · sha256 ${sha.slice(0, 12)}…）`);
  } finally {
    if (!zipArg) fs.rmSync(tmp, { recursive: true, force: true });
    else fs.rmSync(path.join(tmp, 'extract'), { recursive: true, force: true });
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 已清 */ }
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(`✗ ${e && e.message ? e.message : e}`);
    process.exitCode = 1;
  });
}
