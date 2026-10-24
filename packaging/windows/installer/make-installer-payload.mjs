#!/usr/bin/env node
/**
 * 生成 NSIS 安装器的 payload（P2 · 2026-10-18）。
 *
 * 目标不是“把仓库全部塞进去”，而是**显式白名单**：
 *   app/（package.json + panel + src + scripts/check-onebot.js + node_modules/ws）
 *   app/electron/（桌面壳代码 + Electron 44.9.3 win32-x64 完整运行时）
 *   runtime/node/ · tools/ · launcher/ · resources/
 *   README.html · LICENSE · THIRD-PARTY-NOTICES.md · BUILD-INFO.txt
 *
 * 硬闸：版本必须等于 package.json；拒绝 NapCat/user data/test/docs/packaging；
 * 生成 payload-manifest.json 后先用安装器同一份 verifier 自校验，再跑 scan-package。
 *
 * 用法：
 *   node packaging/windows/installer/make-installer-payload.mjs \
 *     --out <buildDir>/stage [--runtime-node <已有 runtime/node>] \
 *     [--electron-dir <已解压 win32-x64 dist>] [--electron-zip <本地 zip>] \
 *     [--source-commit <本地源提交>] [--source-worktree clean|dirty] [--skip-scan]
 *
 * `out` 必须不存在（不删除已有目录）。`version.nsh` 与 .nsi 副本写到 buildDir（stage 的父级）。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, createPublicKey } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  readPackageInfo,
  sha256FileSync,
  verifyPayloadManifest,
  writeJsonAtomic,
} from '../tools/lib/install-layout.mjs';
import { writeBuildInfo, shortCommit } from '../tools/lib/build-info.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..', '..');
const LAUNCHER_ALLOW = ['Estrella-Bot.vbs', 'run-hidden.vbs', 'launch-napcat-hidden.vbs', 'estrella-bot.ico'];

function argOf(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? String(process.argv[i + 1] || '') : '';
}
const has = (...names) => names.some((n) => process.argv.includes(n));
const exists = (p) => { try { return fs.existsSync(p); } catch { return false; } };
const say = (s = '') => console.log(s);

function copyDir(src, dest, { filter } = {}) {
  if (!exists(src)) throw new Error(`缺目录：${src}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, { recursive: true, force: true, errorOnExist: false, filter });
}
function copyFile(src, dest) {
  if (!exists(src)) throw new Error(`缺文件：${src}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}
function walk(root) {
  const out = [];
  const visit = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === '.DS_Store' || e.name === 'Thumbs.db') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) visit(full);
      else if (e.isFile()) out.push(full);
    }
  };
  visit(root);
  return out.sort();
}

async function main() {
  const out = path.resolve(argOf('--out') || '');
  if (!out) {
    console.error('用法：node packaging/windows/installer/make-installer-payload.mjs --out <buildDir>/stage [--runtime-node <dir>] [--electron-dir <dir>|--electron-zip <zip>] [--source-commit <sha>] [--skip-scan]');
    process.exitCode = 2;
    return;
  }
  if (exists(out)) throw new Error(`--out 已存在，拒绝覆盖/删除：${out}`);
  const pkg = readPackageInfo(REPO);
  const toolchain = JSON.parse(fs.readFileSync(path.join(HERE, 'toolchain.json'), 'utf8'));
  const version = argOf('--version') || pkg.version;
  if (version !== pkg.version) throw new Error(`--version=${version} 与 package.json=${pkg.version} 不一致`);
  const buildDir = path.dirname(out);
  fs.mkdirSync(buildDir, { recursive: true });
  fs.mkdirSync(out, { recursive: true });

  say(`构建 payload：Estrella Bot ${version}（appId=${pkg.appId}）`);
  say(`输出：${out}`);

  // ① 用发布面拷贝生成 app（git ls-files 为准），再按显式白名单落进 payload。
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'estrella-payload-'));
  const appFull = path.join(tmp, 'app');
  let electronMeta = { version: toolchain.electron.version, files: 0, bytes: 0, source: '' };
  try {
    execFileSync(process.execPath, [path.join(REPO, 'scripts', 'make-publish-copy.mjs'), appFull], { stdio: 'inherit' });
    const appOut = path.join(out, 'app');
    fs.mkdirSync(appOut, { recursive: true });
    for (const rel of ['package.json', 'package-lock.json', 'config.example.json']) {
      const src = path.join(appFull, rel);
      if (exists(src)) copyFile(src, path.join(appOut, rel));
    }
    copyDir(path.join(appFull, 'panel'), path.join(appOut, 'panel'));
    copyDir(path.join(appFull, 'src'), path.join(appOut, 'src'));
    // 运行时脚本白名单：面板的假 QQ / AI 认领会在运行时 spawn 它们。
    // 漏一个的症状是"点了按钮进程起不来"，而安装与启动都正常。
    fs.mkdirSync(path.join(appOut, 'scripts', 'lib'), { recursive: true });
    for (const rel of ['check-onebot.js', 'fake-qq.mjs', 'adopt-card.mjs', 'dev-sim.mjs']) {
      copyFile(path.join(appFull, 'scripts', rel), path.join(appOut, 'scripts', rel));
    }
    copyFile(path.join(appFull, 'scripts', 'lib', 'fake-host.mjs'), path.join(appOut, 'scripts', 'lib', 'fake-host.mjs'));
    copyDir(path.join(REPO, 'node_modules', 'ws'), path.join(appOut, 'node_modules', 'ws'));
    if (!exists(path.join(appOut, 'node_modules', 'ws', 'package.json'))) {
      throw new Error('node_modules/ws 没有复制进 payload（机器人会起不来）');
    }
    say(`✓ app/：${walk(appOut).length} 个文件`);

    // ② 桌面壳：代码 + win32-x64 完整运行时，放进 app/electron/。壳必须随版本目录回滚，
    //    不能放共享的 <InstallRoot>/electron（否则回滚会变成“旧 app + 新壳”）。
    const electronOut = path.join(appOut, 'electron');
    const electronArg = argOf('--electron-dir');
    const electronZip = argOf('--electron-zip');
    const electronCache = path.join(os.homedir(), '.cache', 'estrella-bot', 'electron', toolchain.electron.version, 'win32-x64');
    const electronFromRepo = path.join(REPO, 'node_modules', 'electron', 'dist');
    let electronSrc = electronArg ? path.resolve(electronArg) : '';
    if (!electronSrc && exists(path.join(electronFromRepo, 'electron.exe'))) electronSrc = electronFromRepo;
    if (!electronSrc && exists(path.join(electronCache, 'electron.exe'))) electronSrc = electronCache;
    if (electronSrc) {
      say(`✓ Electron 运行时来源：${electronSrc}`);
      copyDir(electronSrc, electronOut);
    } else if (electronZip) {
      say(`✓ Electron 运行时来源：${path.resolve(electronZip)}`);
      execFileSync(process.execPath, [path.join(HERE, 'fetch-electron-runtime.mjs'), '--zip', path.resolve(electronZip), '--out', electronOut], { stdio: 'inherit' });
    } else {
      say(`· 本地没有现成 Electron ${toolchain.electron.version} win32-x64，按 toolchain.json 下载…`);
      execFileSync(process.execPath, [path.join(HERE, 'fetch-electron-runtime.mjs'), '--out', electronOut], { stdio: 'inherit' });
    }
    for (const name of ['main.js', 'preload.js', 'error.html', 'package.json']) {
      copyFile(path.join(REPO, 'electron', name), path.join(electronOut, name));
    }
    for (const rel of ['electron.exe', 'version', path.join('resources', 'default_app.asar'), 'main.js', 'package.json']) {
      if (!exists(path.join(electronOut, rel))) throw new Error(`app/electron 缺 ${rel}：${electronOut}`);
    }
    const electronVersionFile = fs.readFileSync(path.join(electronOut, 'version'), 'utf8').trim();
    if (!/^44\.9\.3(?:$|[.-])/.test(electronVersionFile)) {
      throw new Error(`app/electron/version 不是 44.9.3：${electronVersionFile}`);
    }
    const electronFiles = walk(electronOut);
    const electronBytes = electronFiles.reduce((n, f) => n + fs.statSync(f).size, 0);
    electronMeta = {
      version: electronVersionFile,
      files: electronFiles.length,
      bytes: electronBytes,
      source: electronArg ? 'copied' : electronSrc ? 'cached' : electronZip ? 'copied-zip' : 'downloaded',
    };
    say(`✓ app/electron/：${electronFiles.length} 个文件 · ${(electronBytes / 1024 / 1024).toFixed(1)} MiB · Electron ${electronVersionFile}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // ② 稳定工具与启动件。
  copyDir(path.join(REPO, 'packaging', 'windows', 'tools'), path.join(out, 'tools'), {
    filter: (p) => !p.split(path.sep).includes('.DS_Store') && !p.split(path.sep).includes('diag-out'),
  });
  fs.mkdirSync(path.join(out, 'launcher'), { recursive: true });
  for (const name of LAUNCHER_ALLOW) {
    copyFile(path.join(REPO, 'packaging', 'windows', 'launcher', name), path.join(out, 'launcher', name));
  }
  // P10：安装版有自己的使用说明（桌面图标那条链）。便携版 README.html 里教的
  // 「解压到纯英文路径 / 一键安装.bat / 2-START.bat」在安装版里**一个都不存在**，
  // 群友照着找不到东西（2026-10-19 截图）。安装形态必须拷 README-installed.html。
  copyFile(path.join(REPO, 'packaging', 'windows', 'launcher', 'README-installed.html'), path.join(out, 'README.html'));
  copyFile(path.join(REPO, 'LICENSE'), path.join(out, 'LICENSE'));
  copyFile(path.join(REPO, 'THIRD-PARTY-NOTICES.md'), path.join(out, 'THIRD-PARTY-NOTICES.md'));
  fs.mkdirSync(path.join(out, 'resources'), { recursive: true });
  copyFile(path.join(REPO, 'packaging', 'windows', 'launcher', 'estrella-bot.ico'), path.join(out, 'resources', 'estrella-bot.ico'));

  // 更新公钥（P3）：必须随安装器落到 <InstallRoot>/resources；与 UPDATE-KEY-INFO 的指纹对账。
  const pubSrc = path.join(REPO, 'resources', 'update-pubkey.pem');
  if (!exists(pubSrc)) throw new Error(`缺更新公钥：${pubSrc}`);
  const pubKey = createPublicKey(fs.readFileSync(pubSrc, 'utf8'));
  if (pubKey.asymmetricKeyType !== 'ed25519') throw new Error('更新公钥不是 Ed25519');
  const pubFingerprint = `sha256:${createHash('sha256').update(pubKey.export({ type: 'spki', format: 'der' })).digest('hex')}`;
  const keyInfo = path.join(REPO, 'resources', 'UPDATE-KEY-INFO.txt');
  if (exists(keyInfo)) {
    const expected = (fs.readFileSync(keyInfo, 'utf8').match(/^fingerprint=(.+)$/m) || [])[1];
    if (expected && expected.trim() !== pubFingerprint) {
      throw new Error(`update-pubkey 与 UPDATE-KEY-INFO 指纹不一致：${pubFingerprint} ≠ ${expected.trim()}`);
    }
  }
  copyFile(pubSrc, path.join(out, 'resources', 'update-pubkey.pem'));
  say(`✓ 更新公钥：resources/update-pubkey.pem（${pubFingerprint.slice(0, 23)}…）`);

  // ③ 运行时：显式 --runtime-node → ④b 现有 → 官方下载（pin 哈希）。
  const runtimeOut = path.join(out, 'runtime', 'node');
  const runtimeArg = argOf('--runtime-node');
  const defaultRuntime = path.join(os.homedir(), 'Desktop', 'estrella-dist', 'Estrella-Bot-napcat', 'runtime', 'node');
  const runtimeSrc = runtimeArg || (exists(defaultRuntime) ? defaultRuntime : '');
  if (runtimeSrc) {
    say(`✓ 运行时来源：${runtimeSrc}`);
    copyDir(runtimeSrc, runtimeOut);
  } else {
    say('· 本地没有现成 runtime，按 toolchain.json 下载…');
    execFileSync(process.execPath, [path.join(HERE, 'fetch-node-runtime.mjs'), '--out', runtimeOut], { stdio: 'inherit' });
  }
  if (!exists(path.join(runtimeOut, 'node.exe'))) throw new Error(`runtime/node/node.exe 不在位：${runtimeOut}`);

  // ④ 构建信息与 NSIS 常量（version.nsh 放在 buildDir，不进安装 payload）。
  const gitCommit = spawnSync('git', ['-C', REPO, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
  const gitShort = spawnSync('git', ['-C', REPO, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
  const dirty = spawnSync('git', ['-C', REPO, 'status', '--porcelain'], { encoding: 'utf8' }).stdout.trim() ? 'dirty' : 'clean';
  // 跨血缘溯源：公开仓的提交号 ≠ 本地源提交。发布拷贝根带 PUBLISH-PROVENANCE.json，
  // CI 构建读它把 sourceCommit 记成**本地**那一笔；本地构建没有该文件时回退当前 HEAD。
  const provenanceFile = argOf('--provenance') || path.join(REPO, 'PUBLISH-PROVENANCE.json');
  let provenance = null;
  if (exists(provenanceFile)) {
    try {
      provenance = JSON.parse(fs.readFileSync(provenanceFile, 'utf8'));
    } catch (e) {
      throw new Error(`PUBLISH-PROVENANCE.json 解析失败：${e.message}`);
    }
    if (provenance.schema !== 1 || !/^[0-9a-f]{40}$/i.test(String(provenance.sourceCommit || ''))) {
      throw new Error('PUBLISH-PROVENANCE.json 的 schema/sourceCommit 不合法');
    }
  }
  const sourceCommit = argOf('--source-commit') || provenance?.sourceCommit || gitCommit;
  const sourceWorktree = argOf('--source-worktree') || provenance?.sourceWorktree || dirty;
  const buildCommit = argOf('--build-commit') || process.env.GITHUB_SHA || gitCommit;
  const buildRef = argOf('--build-ref') || process.env.GITHUB_REF_NAME || '';
  writeBuildInfo(path.join(out, 'BUILD-INFO.txt'), {
    version,
    appId: pkg.appId,
    sourceCommit,
    sourceCommitShort: shortCommit(sourceCommit),
    sourceWorktree,
    buildCommit,
    buildRef,
    commit: shortCommit(buildCommit) || gitShort,
    builtAt: new Date().toISOString(),
    nodeRuntime: `${toolchain.node.version} (${runtimeSrc ? 'copied' : 'downloaded'})`,
    electronRuntime: `${electronMeta.version} (${electronMeta.source})`,
    electronFiles: electronMeta.files,
    electronBytes: electronMeta.bytes,
    signing: 'none',
  });
  fs.writeFileSync(path.join(buildDir, 'version.nsh'), [
    `!define APP_ID "${pkg.appId}"`,
    `!define APP_VERSION "${version}"`,
    '',
  ].join('\n'), 'utf8');
  copyFile(path.join(HERE, 'Estrella-Bot.nsi'), path.join(buildDir, 'Estrella-Bot.nsi'));
  copyFile(path.join(HERE, 'uninstall-stop.ps1'), path.join(buildDir, 'uninstall-stop.ps1'));

  // ⑤ manifest + 同一份 verifier 自校验。
  const files = walk(out)
    .filter((p) => path.basename(p) !== 'payload-manifest.json')
    .map((p) => {
      const rel = path.relative(out, p).split(path.sep).join('/');
      return { path: rel, size: fs.statSync(p).size, sha256: sha256FileSync(p) };
    });
  writeJsonAtomic(path.join(out, 'payload-manifest.json'), {
    schema: 1,
    version,
    appId: pkg.appId,
    count: files.length,
    files,
  });
  const check = verifyPayloadManifest(out, { expectedVersion: version, expectedAppId: pkg.appId });
  if (!check.ok) throw new Error(`payload 自校验失败：\n  - ${check.errors.join('\n  - ')}`);
  say(`✓ payload-manifest：${check.count} 个文件，哈希/白名单通过`);

  // ⑥ 真值复扫（凭据/本机路径）；这一步不是 NapCat 闸，NapCat 由白名单挡。
  if (!has('--skip-scan')) {
    const scan = spawnSync(process.execPath, [path.join(REPO, 'packaging', 'windows', 'scan-package.mjs'), out], {
      stdio: 'inherit',
    });
    if (scan.error || scan.status !== 0) throw new Error(`scan-package 失败（退出码 ${scan.status}）`);
  } else {
    say('· 跳过 scan-package（--skip-scan）');
  }

  say('');
  say(`✓ payload 完成：${out}`);
  say(`  ${files.length} 个文件 · runtime ${toolchain.node.version} · ${sourceWorktree}`);
  say(`  NSIS：${path.join(buildDir, 'Estrella-Bot.nsi')}`);
}

main().catch((e) => {
  console.error(`✗ ${e && e.message ? e.message : e}`);
  process.exitCode = 1;
});
