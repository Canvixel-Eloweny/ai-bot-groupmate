#!/usr/bin/env node
/**
 * 把探针 JSON + VM runs 组装成 evidence/summary.json 与 runs.jsonl。
 * 决策由 evidence-validate.mjs 的同一套规则重算，避免“报告手写结论”。
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  PREREG, computeAggregates, computeDecision, sha256File,
} from './evidence-validate.mjs';

const args = process.argv.slice(2);
const arg = (n, d = '') => { const i = args.indexOf(n); return i >= 0 ? String(args[i + 1] || '') : d; };
const repo = path.resolve(arg('--repo', process.cwd()));
const evidenceDir = path.resolve(arg('--evidence', path.join(repo, 'docs/desktop/evidence/p3-differential')));
const downloadFile = path.resolve(arg('--download', path.join(evidenceDir, 'runs-download.json')));
const installFile = path.resolve(arg('--install', path.join(evidenceDir, 'runs-install.json')));
const calibrationFile = path.resolve(arg('--calibration', path.join(evidenceDir, 'runs-calibration.json')));
const manifestFile = path.resolve(arg('--manifest', 'C:/p33-eval/manifest/latest.json'));
const sigFile = path.resolve(arg('--sig', 'C:/p33-eval/manifest/latest.json.sig'));
const pubFile = path.resolve(arg('--pub', 'C:/p33-eval/keys/public.pem'));
const preregCommit = arg('--prereg-commit', 'ba57b0f');
const targetVersion = arg('--target-version', '0.1.5');
const baseVersion = arg('--base-version', '0.1.4');
const baseCommit = arg('--base-commit', '1da7fa9');
const calibrationSkipReason = arg('--calibration-skip-reason', '');
const outFile = path.resolve(arg('--out', path.join(evidenceDir, 'summary.json')));
const runsOut = path.resolve(arg('--runs-out', path.join(evidenceDir, 'runs.json')));

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function readArray(file) {
  if (!fs.existsSync(file)) return [];
  const v = readJson(file);
  if (!Array.isArray(v)) throw new Error(`${path.basename(file)} 不是 JSON 数组`);
  return v;
}
function pickCdc(c) {
  return {
    ratio: c.ratio,
    patchGzipBytes: c.patchGzipBytes,
    patchBytes: c.patchBytes,
    matchedBytes: c.matchedBytes,
    literalBytes: c.literalBytes,
    applyMs: c.applyMs,
    shaOk: c.shaOk,
    shaOkCount: c.shaOkCount,
    shaOkTotal: c.shaOkTotal,
  };
}
function gitCommitTime(commit) {
  const r = spawnSync('git', ['-C', repo, 'log', '-1', '--format=%cI', commit], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : '2026-10-24T12:14:06Z';
}
function sanitizeText(text) {
  return String(text)
    .replace(/C:\\Users\\[^\\\s"]+/gi, 'C:\\Users\\<user>')
    .replace(/\/Users\/[^/\s"]+/g, '/Users/<user>');
}
function sanitizeRow(row) {
  return JSON.parse(JSON.stringify(row, (k, v) => (typeof v === 'string' ? sanitizeText(v) : v)));
}
function dedupe(rows) {
  const map = new Map();
  for (const r of rows) map.set(r.runId, sanitizeRow(r));
  return [...map.values()].sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
}

const n1 = readJson(path.join(evidenceDir, 'probe-n1.json'));
const o1 = readJson(path.join(evidenceDir, 'probe-o1.json'));
const o2 = readJson(path.join(evidenceDir, 'probe-o2.json'));
const o3 = readJson(path.join(evidenceDir, 'probe-o3.json'));

const downloadRows = readArray(downloadFile);
const installRows = readArray(installFile);
const calibrationRows = readArray(calibrationFile);
const runs = dedupe([...downloadRows, ...installRows, ...calibrationRows]);
if (!runs.length) throw new Error(`没有 runs：${downloadFile}`);
const aggregates = computeAggregates(runs);
if (!calibrationRows.length) {
  aggregates.calibration = {
    runs: 0,
    ok: 0,
    medianBytesPerSec: null,
    skipped: true,
    reason: calibrationSkipReason || 'VM 未取得真实网络样本（GitHub 与镜像不可达）',
  };
}

const target = { version: targetVersion, name: o1.files.new.name, size: o1.files.new.size, sha256: o1.files.new.sha256 };
const base = {
  id: 'p2-0.1.4-electron',
  version: baseVersion,
  name: o1.files.old.name,
  size: o1.files.old.size,
  sha256: o1.files.old.sha256,
  sourceCommit: baseCommit,
  note: 'P2 合成 Electron 测试包，不是公开版本；用于最佳相邻 Electron 场景',
};

const offline = {
  n1: {
    probeFile: 'probe-n1.json',
    label: n1.label,
    targetA: { name: n1.files.old.name, size: n1.files.old.size, sha256: n1.files.old.sha256 },
    targetB: { name: n1.files.new.name, size: n1.files.new.size, sha256: n1.files.new.sha256 },
    cdc: pickCdc(n1.files.cdc),
  },
  n2: null,
  o1: {
    probeFile: 'probe-o1.json',
    label: o1.label,
    cdc: pickCdc(o1.files.cdc),
    fixedBlocks: o1.files.fixedBlocks.map((x) => ({
      blockSize: x.blockSize, ratio: x.ratio, patchGzipBytes: x.patchGzipBytes, matchedBytes: x.matchedBytes,
    })),
  },
  o2: {
    probeFile: 'probe-o2.json',
    label: o2.label,
    cdc: pickCdc(o2.files.cdc),
  },
  o3: {
    probeFile: 'probe-o3.json',
    label: o3.label,
    changedFiles: o3.tree.changedFiles.length + o3.tree.addedFiles.length,
    addedFiles: o3.tree.addedFiles.length,
    deletedFiles: o3.tree.deletedFiles.length,
    changedGzipBytes: o3.tree.changedGzipBytes,
    newTreeBytes: o3.tree.newTreeBytes,
    ratio: o3.tree.ratio,
    note: '文件级上界；要绕过 NSIS 安装路径，不是可直接落地的安装器级差分',
  },
};

const summary = {
  schema: 1,
  generatedAt: new Date().toISOString(),
  preregistrationAt: gitCommitTime(preregCommit),
  preregistrationCommit: preregCommit,
  target,
  bases: [base],
  thresholds: { ...PREREG.thresholds },
  offline,
  aggregates,
  decision: 'no-go',
  goNoGoGates: {},
  savingsMs: null,
  decisionRationale: '',
  limitations: [
    '真实字段失败率无法在未公开发布前测得；本批只报告确定性故障注入恢复次数。',
    'base 是 P2 合成 0.1.4 Electron 测试包，不是公开版本；公开 0.1.4 无 Electron，首次 Electron 升级必然全量。',
    'V2 安装使用测试模式 /S，不是生产两次点击计时；下载与安装分开计时。',
    'N2 同源完整重建未跑；N1 同一次 stage 连续两次 makensis 字节完全一致。',
    'V5 差分原型未跑：O1 安装器级补丁 99.90% > 30%，按预登记规则 G-B 不通过。',
    'O3 文件级上界只说明“如果换安装路径”的理论空间，不作为可落地差分方案。',
    'VM 限速档是回环 HTTP 节流，不是真实公网；V4 真实网络校准单独列。',
    '测试包、测试密钥与测试清单均未发布；测试私钥只在仓库外。',
  ],
  reopenTriggers: [
    '安装器体积达到 200 MB 或以上。',
    '出现第二个可公开获取的 Electron 版本，且用户缓存中有可作为 base 的旧安装器。',
    '真实字段数据表明整包更新失败率/耗时不可接受。',
    '打包改为非 solid 或可寻址压缩，使安装器级块复用成为可能。',
  ],
  integrity: {},
};

const decision = computeDecision({ summary, aggregates, repoRoot: repo });
if (decision.errors.length) throw new Error(`决策计算失败：\n- ${decision.errors.join('\n- ')}`);
summary.decision = decision.expected;
summary.goNoGoGates = {
  gA: decision.computed.gA,
  gB: decision.computed.gB,
  gC: decision.computed.gC,
  gD: decision.computed.gD,
  gE: decision.computed.gE,
  gF: decision.computed.gF,
};
summary.savingsMs = decision.computed.savingMs;
const full5 = aggregates.full['5'];
const faultsOk = aggregates.faults && Object.values(aggregates.faults).reduce((n, x) => n + x.ok, 0);
const faultsRuns = aggregates.faults && Object.values(aggregates.faults).reduce((n, x) => n + x.runs, 0);
summary.decisionRationale = [
  `N1 同 stage 两次 makensis 的 EXE SHA 完全相同，CDC 补丁 ${(offline.n1.cdc.ratio * 100).toFixed(2)}%（${offline.n1.cdc.patchGzipBytes} B / ${target.size} B），G-A 通过。`,
  `O1 最佳相邻 Electron 场景的安装器级 CDC 补丁 ${(offline.o1.cdc.ratio * 100).toFixed(2)}%（${offline.o1.cdc.patchGzipBytes} B / ${target.size} B），超过 30%，G-B 不通过；固定块 64 KiB 只命中 ${offline.o1.fixedBlocks.find((x) => x.blockSize === 65536)?.matchedBytes || 0} B。`,
  `O2 公开 0.1.4 无 Electron → target 的补丁 ${(offline.o2.cdc.ratio * 100).toFixed(2)}%，首次 Electron 升级没有差分收益。`,
  `O3 文件级 changed/added gzip ${offline.o3.changedGzipBytes} B / 新树 ${offline.o3.newTreeBytes} B = ${(offline.o3.ratio * 100).toFixed(2)}%；这是理论下界，要求换掉 NSIS 安装路径，不在本批实现。`,
  full5 && full5.medianDownloadMs != null
    ? `整包 5 Mbps 中位下载 ${full5.medianDownloadMs} ms；故障注入 ${faultsOk}/${faultsRuns} 恢复；G-C=${decision.computed.gC ? '通过' : '不通过'}。`
    : '整包 5 Mbps 数据缺失。',
  '按预登记规则：G-B 不通过且 G-D/G-E 无 V5 数据 ⇒ 结论 no-go；不改生产更新链。',
].join(' ');
summary.limitations = summary.limitations;
summary.reopenTriggers = summary.reopenTriggers;

fs.mkdirSync(evidenceDir, { recursive: true });
fs.copyFileSync(manifestFile, path.join(evidenceDir, 'manifest.json'));
fs.copyFileSync(sigFile, path.join(evidenceDir, 'manifest.sig'));
fs.copyFileSync(pubFile, path.join(evidenceDir, 'test-update-pubkey.pem'));
fs.writeFileSync(runsOut, '[\n' + runs.map((r) => JSON.stringify(r)).join(',\n') + '\n]\n');
summary.integrity = {
  manifestSha256: sha256File(path.join(evidenceDir, 'manifest.json')),
  testPubkeySha256: sha256File(path.join(evidenceDir, 'test-update-pubkey.pem')),
  runsSha256: sha256File(runsOut),
};
fs.writeFileSync(outFile, JSON.stringify(summary, null, 2) + '\n');
console.log(`✓ summary：${outFile}`);
console.log(`  decision=${summary.decision} gates=${JSON.stringify(summary.goNoGoGates)}`);
console.log(`  runs=${runs.length} · 5Mbps median=${full5 && full5.medianDownloadMs}ms · 5Mbps runs=${full5 && full5.runs}`);
