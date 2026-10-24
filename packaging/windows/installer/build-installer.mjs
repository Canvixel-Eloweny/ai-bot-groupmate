#!/usr/bin/env node
/**
 * Windows 桌面构建的**单入口包装器**（P3-5 · 2026-10-24）。
 *
 * 手工链在 README 里是「stage → check-nsi → makensis」三步；CI 与本地预演必须走同一条，
 * 否则「本地能出包、CI 不能」会变成环境差异而不是代码差异。这里把三步串起来，并把
 * 「0 warning / 假 EXE / 源提交与 clean / 产物回执」变成硬失败。
 *
 * 用法：
 *   node packaging/windows/installer/build-installer.mjs \
 *     --build-dir <不存在目录> [--artifact-dir <目录>] \
 *     [--makensis <makensis.exe>] [--runtime-node <dir>] \
 *     [--electron-dir <dir> | --electron-zip <zip>] [--provenance <file>] \
 *     [--require-provenance] [--stage-only] [--skip-scan] [--allow-dirty]
 *
 * 退出码：0 = 成功；1 = 构建/校验失败；2 = 参数错误。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readBuildInfo } from '../tools/lib/build-info.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..', '..');
const PAYLOAD = path.join(HERE, 'make-installer-payload.mjs');
const CHECK_NSI = path.join(HERE, 'check-nsi.mjs');

const argOf = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? String(process.argv[i + 1] || '') : '';
};
const has = (...names) => names.some((n) => process.argv.includes(n));
const exists = (p) => { try { return fs.existsSync(p); } catch { return false; } };
const say = (s = '') => console.log(s);
const fail = (s) => { console.error(`✗ ${s}`); process.exitCode = 1; };

const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const walk = (root) => {
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
};

function git(args) {
  return spawnSync('git', ['-C', REPO, ...args], { encoding: 'utf8' });
}

function readProvenance(file, required) {
  if (!exists(file)) {
    if (required) throw new Error(`缺 PUBLISH-PROVENANCE.json：${file}（CI 构建必须带源提交）`);
    return null;
  }
  const p = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (p.schema !== 1 || !/^[0-9a-f]{40}$/i.test(String(p.sourceCommit || ''))) {
    throw new Error('PUBLISH-PROVENANCE.json 的 schema/sourceCommit 不合法');
  }
  if (!['clean', 'dirty'].includes(String(p.sourceWorktree))) {
    throw new Error('PUBLISH-PROVENANCE.json 的 sourceWorktree 不合法');
  }
  return p;
}

function findMakensis(explicit) {
  if (explicit) return explicit;
  if (process.env.MAKENSIS) return process.env.MAKENSIS;
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['makensis'], { encoding: 'utf8' });
  const p = String(r.stdout || '').split(/\r?\n/).map((s) => s.trim()).find(Boolean);
  return r.status === 0 ? p : '';
}

function assertPe(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(2);
    fs.readSync(fd, head, 0, 2, 0);
    if (head.toString('latin1') !== 'MZ') throw new Error('EXE 不以 MZ 开头');
    const off = Buffer.alloc(4);
    fs.readSync(fd, off, 0, 4, 0x3c);
    const peAt = off.readUInt32LE(0);
    const sig = Buffer.alloc(4);
    fs.readSync(fd, sig, 0, 4, peAt);
    if (sig.toString('latin1') !== 'PE\0\0') throw new Error('EXE 缺 PE 头');
  } finally {
    fs.closeSync(fd);
  }
}

function copyArtifact(src, artifactDir) {
  const dst = path.join(artifactDir, path.basename(src));
  fs.copyFileSync(src, dst);
  return dst;
}

function main() {
  const buildDir = path.resolve(argOf('--build-dir') || '');
  if (!buildDir) {
    console.error('用法：build-installer.mjs --build-dir <不存在目录> [--artifact-dir <目录>] [--makensis <exe>] [--require-provenance] [--stage-only]');
    process.exit(2);
  }
  if (exists(buildDir)) throw new Error(`--build-dir 已存在，拒绝覆盖/删除：${buildDir}`);
  const artifactDir = path.resolve(argOf('--artifact-dir') || path.join(buildDir, 'artifact'));
  const stageOnly = has('--stage-only');
  const skipScan = has('--skip-scan');
  const requireProvenance = has('--require-provenance') || process.env.GITHUB_ACTIONS === 'true';

  if (!has('--allow-dirty')) {
    const st = git(['status', '--porcelain']);
    if (st.status !== 0) throw new Error(`git status 失败：${st.stderr || st.status}`);
    if (String(st.stdout || '').trim()) {
      throw new Error('工作树不干净（BUILD-INFO 必须记 clean）；先提交，或本地预演显式加 --allow-dirty');
    }
  }

  const provenanceFile = path.resolve(argOf('--provenance') || path.join(REPO, 'PUBLISH-PROVENANCE.json'));
  const provenance = readProvenance(provenanceFile, requireProvenance);
  const gitHead = git(['rev-parse', 'HEAD']).stdout.trim();
  const buildCommit = process.env.GITHUB_SHA || gitHead;
  const buildRef = process.env.GITHUB_REF_NAME || '';
  const sourceCommit = provenance?.sourceCommit || gitHead;
  const sourceWorktree = provenance?.sourceWorktree || (has('--allow-dirty') ? 'dirty' : 'clean');
  if (sourceWorktree !== 'clean' && !has('--allow-dirty')) {
    throw new Error(`源工作树是 ${sourceWorktree}，拒绝出包（BUILD-INFO 要求 clean）`);
  }

  fs.mkdirSync(buildDir, { recursive: true });
  const stage = path.join(buildDir, 'stage');
  const payloadArgs = [PAYLOAD, '--out', stage, '--source-commit', sourceCommit,
    '--source-worktree', sourceWorktree, '--build-commit', buildCommit, '--build-ref', buildRef];
  for (const [flag, arg] of [['--runtime-node', argOf('--runtime-node')],
    ['--electron-dir', argOf('--electron-dir')], ['--electron-zip', argOf('--electron-zip')]]) {
    if (arg) payloadArgs.push(flag, path.resolve(arg));
  }
  if (skipScan) payloadArgs.push('--skip-scan');
  say(`① payload：${stage}`);
  const p = spawnSync(process.execPath, payloadArgs, { cwd: REPO, stdio: 'inherit' });
  if (p.status !== 0) throw new Error(`make-installer-payload 退出码 ${p.status}`);

  const buildInfoFile = path.join(stage, 'BUILD-INFO.txt');
  const info = readBuildInfo(buildInfoFile);
  if (info.sourceCommit !== sourceCommit) throw new Error(`BUILD-INFO sourceCommit=${info.sourceCommit} ≠ ${sourceCommit}`);
  if (info.sourceWorktree !== 'clean') throw new Error(`BUILD-INFO sourceWorktree=${info.sourceWorktree} ≠ clean`);
  if (info.version !== JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).version) {
    throw new Error(`BUILD-INFO version=${info.version} 与 package.json 不一致`);
  }

  say('② check-nsi');
  const c = spawnSync(process.execPath, [CHECK_NSI, '--nsi', path.join(buildDir, 'Estrella-Bot.nsi'), '--stage', stage], {
    cwd: REPO, stdio: 'inherit',
  });
  if (c.status !== 0) throw new Error(`check-nsi 退出码 ${c.status}`);

  const manifestFile = path.join(stage, 'payload-manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  const stageFiles = walk(stage);
  const stageBytes = stageFiles.reduce((n, f) => n + fs.statSync(f).size, 0);
  fs.mkdirSync(artifactDir, { recursive: true });
  const receipt = {
    schema: 1,
    version: info.version,
    appId: info.appId,
    sourceCommit,
    sourceCommitShort: info.sourceCommitShort,
    sourceWorktree,
    buildCommit,
    buildRef,
    builtAt: new Date().toISOString(),
    stage: {
      files: stageFiles.length,
      bytes: stageBytes,
      manifestCount: manifest.count,
      manifestSha256: sha256(manifestFile),
    },
    nodeRuntime: info.nodeRuntime,
    electronRuntime: info.electronRuntime,
    electronFiles: info.electronFiles,
    electronBytes: info.electronBytes,
    signing: 'none',
    nsis: null,
    exe: null,
  };

  if (stageOnly) {
    say('③ --stage-only：跳过 makensis');
    receipt.stageOnly = true;
    fs.writeFileSync(path.join(artifactDir, 'build-receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
    copyArtifact(manifestFile, artifactDir);
    copyArtifact(buildInfoFile, artifactDir);
    say(`✓ stage-only 回执：${path.join(artifactDir, 'build-receipt.json')}`);
    return;
  }

  const makensis = findMakensis(argOf('--makensis'));
  if (!makensis || !exists(makensis)) throw new Error('找不到 makensis（用 --makensis 显式指定）');
  const ver = spawnSync(makensis, ['-VERSION'], { encoding: 'utf8', windowsHide: true });
  const verText = `${ver.stdout || ''}${ver.stderr || ''}`.trim();
  if (ver.status !== 0 || !/3\.13/.test(verText)) {
    throw new Error(`makensis 版本不是 3.13：${verText || `退出码 ${ver.status}`}`);
  }
  say(`③ makensis ${verText} · cwd=${buildDir}`);
  const logFile = path.join(buildDir, 'makensis.log');
  const mk = spawnSync(makensis, ['/WX', '/V2', 'Estrella-Bot.nsi'], {
    cwd: buildDir, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024,
  });
  const log = `${mk.stdout || ''}${mk.stderr || ''}`;
  fs.writeFileSync(logFile, log, 'utf8');
  if (mk.status !== 0) throw new Error(`makensis 退出码 ${mk.status}（/WX 会把 warning 当错误）`);
  const warnings = log.split('\n').filter((l) => /warning/i.test(l));
  if (warnings.length) throw new Error(`makensis 有 ${warnings.length} 条 warning：\n${warnings.slice(0, 5).join('\n')}`);

  const exes = fs.readdirSync(buildDir).filter((f) => /^Estrella-Bot-Setup-.*\.exe$/i.test(f));
  if (exes.length !== 1) throw new Error(`期望恰好 1 个 Estrella-Bot-Setup-*.exe，实得 ${exes.length}`);
  const exeFile = path.join(buildDir, exes[0]);
  const exeBytes = fs.statSync(exeFile).size;
  const minBytes = Math.max(8 * 1024 * 1024, Math.floor(stageBytes * 0.02));
  if (exeBytes < minBytes) throw new Error(`EXE 只有 ${exeBytes} B，低于假件下限 ${minBytes} B`);
  assertPe(exeFile);
  const exeSha = sha256(exeFile);
  receipt.nsis = { version: verText, warnings: warnings.length, logSha256: sha256(logFile) };
  receipt.exe = { name: exes[0], bytes: exeBytes, sha256: exeSha };
  fs.writeFileSync(path.join(artifactDir, 'build-receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  copyArtifact(exeFile, artifactDir);
  copyArtifact(manifestFile, artifactDir);
  copyArtifact(buildInfoFile, artifactDir);
  copyArtifact(logFile, artifactDir);

  const sums = walk(artifactDir)
    .filter((f) => path.basename(f) !== 'ARTIFACT-SHA256SUMS.txt')
    .map((f) => `${sha256(f)}  ${path.relative(artifactDir, f).split(path.sep).join('/')}`);
  fs.writeFileSync(path.join(artifactDir, 'ARTIFACT-SHA256SUMS.txt'), `${sums.join('\n')}\n`, 'utf8');

  say(`✓ EXE ${exes[0]} · ${exeBytes} B · sha256 ${exeSha.slice(0, 16)}… · 0 warning`);
  say(`✓ 回执：${path.join(artifactDir, 'build-receipt.json')}`);
}

try {
  main();
} catch (e) {
  fail(e && e.message ? e.message : String(e));
  process.exit(process.exitCode || 1);
}
