#!/usr/bin/env node
/**
 * P3-3 证据校验器（纯校验 + CLI）。
 *
 * 它只做两件事：
 *   1) 证明“预登记先于测量、场景/重复次数齐全、target SHA 一致、决策符合预登记规则”；
 *   2) 证明“决策不是 go 时，生产更新链没有偷偷长出 delta 字段”。
 *
 * 不把会漂的实测数字写死在契约里；契约只要求证据自洽。
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { spawnSync } from 'node:child_process';

export const PREREG = Object.freeze({
  schema: 1,
  fullBands: Object.freeze([
    { mbps: 5, repeats: 5, key: '5' },
    { mbps: 10, repeats: 5, key: '10' },
    { mbps: 20, repeats: 3, key: '20' },
    { mbps: 0, repeats: 3, key: '0' },
  ]),
  faultScenarios: Object.freeze(['drop-resume', 'corrupt-first', 'mirror-500', 'idle-stall']),
  faultRepeats: 5,
  installFaultRepeats: 3,
  installRepeats: 3,
  calibrationRepeats: 3,
  deltaNormalRepeats: 3,
  deltaFaultRepeats: 3,
  thresholds: Object.freeze({
    sameSourcePatchRatioMax: 0.10,
    bestPatchRatioMax: 0.30,
    applyMsMax: 30_000,
    full5MbpsMedianMsMax: 320_000,
    savingsMsMin: 120_000,
    targetShaChecksMin: 5,
  }),
  requiredReportHeadings: Object.freeze([
    '## 2. 预登记判据',
    '## 4. 测量矩阵',
    '## 7. 重开触发条件',
    '## 8. 结果',
  ]),
});

export function sha256File(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

export function median(nums) {
  const a = nums.filter((n) => Number.isFinite(n)).sort((x, y) => x - y);
  if (!a.length) return null;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readArray(file) {
  const v = readJson(file);
  if (!Array.isArray(v)) throw new Error(`${path.basename(file)} 不是 JSON 数组`);
  return v;
}

function near(a, b, tol = 1) {
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tol;
}

function sameCount(a, b) {
  return Number(a) === Number(b);
}

function rowsOf(runs, scenario, extra = () => true) {
  return runs.filter((r) => r.scenario === scenario && extra(r));
}

export function computeAggregates(runs) {
  const full = {};
  for (const band of PREREG.fullBands) {
    const rows = rowsOf(runs, 'full', (r) => Number(r.bandMbps) === band.mbps);
    full[band.key] = {
      runs: rows.length,
      ok: rows.filter((r) => r.outcome && r.outcome.ok).length,
      medianDownloadMs: median(rows.map((r) => r.timings && r.timings.downloadMs)),
      medianTotalMs: median(rows.map((r) => r.timings && r.timings.totalMs)),
      bytes: rows.length ? (rows[0].bytes && rows[0].bytes.downloaded) : null,
    };
  }
  const installRows = rowsOf(runs, 'install');
  const faults = {};
  for (const f of PREREG.faultScenarios) {
    const rows = rowsOf(runs, 'fault', (r) => r.fault === f);
    faults[f] = { runs: rows.length, ok: rows.filter((r) => r.outcome && r.outcome.ok).length };
  }
  const installFaultRows = rowsOf(runs, 'install-fault');
  const calibrationRows = rowsOf(runs, 'calibration');
  const deltaRows = rowsOf(runs, 'delta', (r) => !r.fault);
  const deltaFaults = {};
  for (const f of PREREG.faultScenarios) {
    const rows = rowsOf(runs, 'delta-fault', (r) => r.fault === f);
    deltaFaults[f] = {
      runs: rows.length,
      ok: rows.filter((r) => r.outcome && r.outcome.ok).length,
      fallback: rows.filter((r) => r.outcome && r.outcome.fallback === true).length,
    };
  }
  return {
    full,
    install: {
      runs: installRows.length,
      ok: installRows.filter((r) => r.outcome && r.outcome.ok).length,
      medianInstallMs: median(installRows.map((r) => r.timings && r.timings.installMs)),
      medianTotalMs: median(installRows.map((r) => r.timings && r.timings.totalMs)),
    },
    faults,
    installFaults: {
      runs: installFaultRows.length,
      ok: installFaultRows.filter((r) => r.outcome && r.outcome.ok).length,
    },
    calibration: {
      runs: calibrationRows.length,
      ok: calibrationRows.filter((r) => r.outcome && r.outcome.ok).length,
      medianBytesPerSec: median(calibrationRows.map((r) => r.bytes && r.bytes.bytesPerSec)),
    },
    delta: {
      normal: {
        runs: deltaRows.length,
        ok: deltaRows.filter((r) => r.outcome && r.outcome.ok).length,
        medianDownloadMs: median(deltaRows.map((r) => r.timings && r.timings.downloadMs)),
        medianApplyMs: median(deltaRows.map((r) => r.timings && r.timings.applyMs)),
      },
      faults: deltaFaults,
    },
  };
}

function checkManifest({ evidenceDir, target, errors }) {
  const manifestFile = path.join(evidenceDir, 'manifest.json');
  const sigFile = path.join(evidenceDir, 'manifest.sig');
  const pubFile = path.join(evidenceDir, 'test-update-pubkey.pem');
  for (const f of [manifestFile, sigFile, pubFile]) {
    if (!fs.existsSync(f)) { errors.push(`缺证据文件：${path.relative(process.cwd(), f)}`); }
  }
  if (errors.length) return;
  let manifest;
  try { manifest = readJson(manifestFile); } catch (e) { errors.push(`manifest.json 不是 JSON：${e.message}`); return; }
  const raw = fs.readFileSync(manifestFile);
  const sig = Buffer.from(fs.readFileSync(sigFile, 'utf8').trim(), 'base64');
  let pub;
  try { pub = createPublicKey(fs.readFileSync(pubFile, 'utf8')); } catch (e) { errors.push(`测试公钥读不出来：${e.message}`); return; }
  let ok = false;
  try { ok = verify(null, raw, pub, sig); } catch (e) { errors.push(`清单验签异常：${e.message}`); }
  if (!ok) errors.push('测试清单 Ed25519 验签失败');
  if (manifest.schemaVersion !== 1) errors.push('测试清单 schemaVersion 不是 1');
  if (manifest.version !== target.version) errors.push(`测试清单 version=${manifest.version} 与 target=${target.version} 不一致`);
  if (!manifest.installer || manifest.installer.size !== target.size) errors.push('测试清单 installer.size 与 target 不一致');
  if (!manifest.installer || manifest.installer.sha256 !== target.sha256) errors.push('测试清单 installer.sha256 与 target 不一致');
}

function checkProbeFiles({ evidenceDir, summary, errors }) {
  const offline = summary.offline || {};
  for (const key of ['n1', 'o1', 'o2']) {
    const item = offline[key];
    if (!item) { errors.push(`summary.offline 缺 ${key}`); continue; }
    if (!item.probeFile) { errors.push(`summary.offline.${key} 缺 probeFile`); continue; }
    const file = path.join(evidenceDir, item.probeFile);
    if (!fs.existsSync(file)) { errors.push(`缺探针文件：${item.probeFile}`); continue; }
    let probe;
    try { probe = readJson(file); } catch (e) { errors.push(`${item.probeFile} 不是 JSON：${e.message}`); continue; }
    if (!probe.files || !probe.files.cdc) { errors.push(`${item.probeFile} 缺 files.cdc`); continue; }
    const p = probe.files.cdc;
    if (!p.shaOk || !(p.shaOkCount >= PREREG.thresholds.targetShaChecksMin)) errors.push(`${key} 的探针重建 target SHA 未达到 5/5`);
    if (!near(p.ratio, item.cdc && item.cdc.ratio, 0.00001)) errors.push(`${key} 的 summary ratio 与探针不一致`);
    if (!sameCount(p.patchGzipBytes, item.cdc && item.cdc.patchGzipBytes)) errors.push(`${key} 的 summary patchGzipBytes 与探针不一致`);
    if (probe.files.new && probe.files.new.sha256 !== summary.target.sha256) errors.push(`${key} 探针的 new SHA 与 target 不一致`);
  }
  const n2 = offline.n2;
  if (n2) {
    const file = path.join(evidenceDir, n2.probeFile || '');
    if (!n2.probeFile || !fs.existsSync(file)) errors.push('summary.offline.n2 缺可读探针文件');
    else {
      const probe = readJson(file);
      if (!probe.files || !probe.files.cdc || !probe.files.cdc.shaOk) errors.push('n2 探针缺有效的 cdc.shaOk');
      if (!near(probe.files.cdc.ratio, n2.cdc && n2.cdc.ratio, 0.00001)) errors.push('n2 summary ratio 与探针不一致');
    }
  }
  const o3 = offline.o3;
  if (!o3) errors.push('summary.offline 缺 o3');
  else if (!o3.probeFile || !fs.existsSync(path.join(evidenceDir, o3.probeFile))) errors.push('o3 缺可读探针文件');
  else {
    const probe = readJson(path.join(evidenceDir, o3.probeFile));
    if (!probe.tree) errors.push('o3 探针缺 tree');
    else {
      if (!sameCount(probe.tree.changedGzipBytes, o3.changedGzipBytes)) errors.push('o3 summary changedGzipBytes 与探针不一致');
      if (!near(probe.tree.ratio, o3.ratio, 0.00001)) errors.push('o3 summary ratio 与探针不一致');
    }
  }
}

function checkRuns({ runs, summary, aggregates, errors }) {
  const target = summary.target;
  const base = (summary.bases && summary.bases[0]) || {};
  if (!target || !target.version || !target.sha256 || !Number.isFinite(target.size)) {
    errors.push('summary.target 缺 version/size/sha256');
    return;
  }
  const first = runs.map((r) => Date.parse(r.startedAt || '')).filter(Number.isFinite).sort((a, b) => a - b)[0];
  const prereg = Date.parse(summary.preregistrationAt || '');
  if (!Number.isFinite(first)) errors.push('runs.jsonl 没有可解析的 startedAt');
  else if (!Number.isFinite(prereg) || !(prereg < first)) errors.push('preregistrationAt 没有早于第一次运行');

  for (const r of runs) {
    if (r.targetSha256 && r.targetSha256 !== target.sha256) errors.push(`run ${r.runId} 的 targetSha256 与 summary 不一致`);
  }
  for (const band of PREREG.fullBands) {
    const rows = rowsOf(runs, 'full', (r) => Number(r.bandMbps) === band.mbps);
    if (rows.length < band.repeats) errors.push(`full ${band.mbps}Mbps 只有 ${rows.length} 次，要求 ${band.repeats}`);
    for (const r of rows) {
      if (!r.outcome || !r.outcome.ok) errors.push(`full ${band.mbps}Mbps run ${r.runId} 失败`);
      if (!Number.isFinite(r.timings && r.timings.downloadMs)) errors.push(`full ${band.mbps}Mbps run ${r.runId} 缺 downloadMs`);
      if (r.bytes && r.bytes.downloaded !== target.size) errors.push(`full ${band.mbps}Mbps run ${r.runId} 下载字节不等于 target.size`);
    }
  }
  const install = rowsOf(runs, 'install');
  if (install.length < PREREG.installRepeats) errors.push(`install 只有 ${install.length} 次，要求 ${PREREG.installRepeats}`);
  for (const r of install) {
    if (!r.outcome || !r.outcome.ok) errors.push(`install run ${r.runId} 失败`);
    if (r.outcome && r.outcome.finalVersion !== target.version) errors.push(`install run ${r.runId} finalVersion 不是 target`);
    if (r.outcome && base.version && r.outcome.previousVersion !== base.version) errors.push(`install run ${r.runId} previousVersion 不是 base`);
    if (r.outcome && r.outcome.health !== 'ok') errors.push(`install run ${r.runId} health 不是 ok`);
  }
  for (const f of PREREG.faultScenarios) {
    const rows = rowsOf(runs, 'fault', (r) => r.fault === f);
    if (rows.length < PREREG.faultRepeats) errors.push(`fault ${f} 只有 ${rows.length} 次，要求 ${PREREG.faultRepeats}`);
    for (const r of rows) if (!r.outcome || !r.outcome.ok) errors.push(`fault ${f} run ${r.runId} 未恢复`);
  }
  const installFaults = rowsOf(runs, 'install-fault');
  if (installFaults.length < PREREG.installFaultRepeats) errors.push(`install-fault 只有 ${installFaults.length} 次，要求 ${PREREG.installFaultRepeats}`);
  for (const r of installFaults) {
    if (!r.outcome || !r.outcome.ok) errors.push(`install-fault run ${r.runId} 未恢复`);
    if (r.outcome && r.outcome.finalVersion !== target.version) errors.push(`install-fault run ${r.runId} finalVersion 不是 target`);
  }
  const cal = aggregates.calibration;
  const calSkipped = summary.aggregates && summary.aggregates.calibration && summary.aggregates.calibration.skipped === true;
  if (!calSkipped) {
    if (cal.runs < PREREG.calibrationRepeats) errors.push(`calibration 只有 ${cal.runs} 次，要求 ${PREREG.calibrationRepeats} 或 skipped`);
    if (cal.runs && cal.ok !== cal.runs) errors.push('calibration 有失败运行');
  } else if (cal.runs !== 0) errors.push('calibration 标记 skipped 但仍有运行');
  if (summary.aggregates && summary.aggregates.calibration && summary.aggregates.calibration.skipped === true
    && !summary.aggregates.calibration.reason) errors.push('calibration skipped 缺 reason');
}

export function computeDecision({ summary, aggregates, repoRoot = summary.repoRoot || process.cwd() }) {
  const errors = [];
  const t = summary.thresholds || {};
  for (const [k, v] of Object.entries(PREREG.thresholds)) {
    if (t[k] !== v) errors.push(`summary.thresholds.${k}=${t[k]} 与预登记 ${v} 不一致`);
  }
  const offline = summary.offline || {};
  const n1 = offline.n1 && offline.n1.cdc;
  const n2 = offline.n2 && offline.n2.cdc;
  const stable = n2 || n1;
  const gA = Boolean(stable && stable.ratio <= PREREG.thresholds.sameSourcePatchRatioMax
    && stable.shaOk && stable.shaOkCount >= PREREG.thresholds.targetShaChecksMin);
  const o1 = offline.o1 && offline.o1.cdc;
  const gB = Boolean(o1 && o1.ratio <= PREREG.thresholds.bestPatchRatioMax
    && o1.applyMs <= PREREG.thresholds.applyMsMax && o1.shaOk
    && o1.shaOkCount >= PREREG.thresholds.targetShaChecksMin);
  const full5 = aggregates.full['5'];
  const faultsOk = PREREG.faultScenarios.every((f) => aggregates.faults[f] && aggregates.faults[f].ok === aggregates.faults[f].runs
    && aggregates.faults[f].runs >= PREREG.faultRepeats);
  const gC = Boolean(full5 && full5.runs >= 5 && full5.ok === full5.runs
    && full5.medianDownloadMs <= PREREG.thresholds.full5MbpsMedianMsMax && faultsOk);
  const deltaNormal = aggregates.delta.normal;
  const deltaFaultsOk = PREREG.faultScenarios.every((f) => {
    const x = aggregates.delta.faults[f];
    return x && x.runs >= PREREG.deltaFaultRepeats && x.ok === x.runs && x.fallback === x.runs;
  });
  const gD = Boolean(deltaNormal.runs >= PREREG.deltaNormalRepeats && deltaNormal.ok === deltaNormal.runs && deltaFaultsOk);
  const savingMs = (full5 && full5.medianDownloadMs != null && deltaNormal.medianDownloadMs != null && deltaNormal.medianApplyMs != null)
    ? full5.medianDownloadMs - (deltaNormal.medianDownloadMs + deltaNormal.medianApplyMs)
    : null;
  const gE = Boolean(savingMs != null && savingMs >= PREREG.thresholds.savingsMsMin);
  const gF = productionClean(repoRoot, errors);
  const computed = { gA, gB, gC, gD, gE, gF, savingMs };
  const expected = (gA && gB && gD && gF && !gC && gE) ? 'go' : 'no-go';
  return { computed, expected, errors };
}

function checkGates({ summary, aggregates, errors }) {
  const r = computeDecision({ summary, aggregates, repoRoot: summary.repoRoot || process.cwd() });
  for (const e of r.errors) errors.push(e);
  if (summary.decision !== r.expected) errors.push(`summary.decision=${summary.decision}，按预登记规则应为 ${r.expected}`);
  const claimed = summary.goNoGoGates || {};
  for (const k of ['gA', 'gB', 'gC', 'gD', 'gE', 'gF']) {
    if (Boolean(claimed[k]) !== Boolean(r.computed[k])) errors.push(`summary.goNoGoGates.${k}=${claimed[k]}，重算为 ${r.computed[k]}`);
  }
  return { computed: r.computed, expected: r.expected };
}

export function productionClean(repoRoot, errors = []) {
  const files = [
    'panel/lib/update.js',
    'panel/lib/update-download.js',
    'panel/lib/update-manifest.js',
    'packaging/windows/update/make-manifest.mjs',
  ];
  let clean = true;
  for (const rel of files) {
    const file = path.join(repoRoot, rel);
    if (!fs.existsSync(file)) { errors.push(`生产文件不在位：${rel}`); clean = false; continue; }
    const text = fs.readFileSync(file, 'utf8');
    if (/\bdelta\b/i.test(text)) { errors.push(`${rel} 出现 delta 字段/字样（未批准的差分实现）`); clean = false; }
    if (/electron-updater/i.test(text)) { errors.push(`${rel} 出现 electron-updater`); clean = false; }
  }
  const pkg = path.join(repoRoot, 'package.json');
  if (fs.existsSync(pkg)) {
    const obj = readJson(pkg);
    const deps = { ...(obj.dependencies || {}), ...(obj.devDependencies || {}) };
    if (deps['electron-updater']) { errors.push('package.json 依赖出现 electron-updater'); clean = false; }
  }
  const main = path.join(repoRoot, 'electron/main.js');
  if (fs.existsSync(main) && /electron-updater/i.test(fs.readFileSync(main, 'utf8'))) {
    errors.push('electron/main.js 出现 electron-updater'); clean = false;
  }
  return clean;
}

function checkReport({ reportPath, summary, offline, errors }) {
  if (!fs.existsSync(reportPath)) { errors.push('缺报告 docs/desktop/P3-DIFFERENTIAL.md'); return; }
  const text = fs.readFileSync(reportPath, 'utf8');
  for (const h of PREREG.requiredReportHeadings) if (!text.includes(h)) errors.push(`报告缺标题：${h}`);
  if (!text.includes(summary.target.sha256)) errors.push('报告没有写 target SHA-256');
  if (!text.includes(summary.decision)) errors.push(`报告没有写决策 ${summary.decision}`);
  const ratio = offline.o1 && offline.o1.cdc && Number.isFinite(offline.o1.cdc.ratio)
    ? (offline.o1.cdc.ratio * 100).toFixed(2)
    : null;
  if (ratio && !text.includes(ratio)) errors.push(`报告没有写 O1 CDC 补丁比例 ${ratio}%`);
  if (/BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY/.test(text)) errors.push('报告含私钥字样');
  if (/x-panel-token\s*[:=]\s*\S+/i.test(text)) errors.push('报告含面板 token 值');
  if (/C:\\\\Users\\\\/i.test(text)) errors.push('报告含 Windows 用户绝对路径');
}

export function validateRepository({ repo = process.cwd(), evidenceDir = '', reportPath = '' } = {}) {
  const errors = [];
  const warnings = [];
  const ev = evidenceDir || path.join(repo, 'docs/desktop/evidence/p3-differential');
  const summaryFile = path.join(ev, 'summary.json');
  const runsFile = path.join(ev, 'runs.json');
  const report = reportPath || path.join(repo, 'docs/desktop/P3-DIFFERENTIAL.md');
  if (!fs.existsSync(summaryFile)) return { ok: false, errors: ['缺 summary.json'], warnings };
  if (!fs.existsSync(runsFile)) return { ok: false, errors: ['缺 runs.jsonl'], warnings };
  let summary;
  let runs;
  try { summary = readJson(summaryFile); } catch (e) { return { ok: false, errors: [`summary.json 不是 JSON：${e.message}`], warnings }; }
  try { runs = readArray(runsFile); } catch (e) { return { ok: false, errors: [e.message], warnings }; }
  summary.repoRoot = repo;
  if (summary.schema !== PREREG.schema) errors.push('summary.schema 不是 1');
  if (!summary.preregistrationAt || !summary.preregistrationCommit) errors.push('summary 缺 preregistrationAt/preregistrationCommit');
  if (summary.preregistrationCommit) {
    const inside = spawnSync('git', ['-C', repo, 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf8' });
    const has = inside.status === 0
      ? spawnSync('git', ['-C', repo, 'cat-file', '-e', `${summary.preregistrationCommit}^{commit}`], { encoding: 'utf8' })
      : null;
    if (inside.status !== 0 || !has || has.status !== 0) {
      warnings.push('预登记 commit 祖先校验跳过：当前目录没有完整 git 历史（pre-commit 临时门禁树）');
    } else {
      const r = spawnSync('git', ['-C', repo, 'merge-base', '--is-ancestor', summary.preregistrationCommit, 'HEAD'], { encoding: 'utf8' });
      if (r.status !== 0) errors.push(`预登记 commit ${summary.preregistrationCommit} 不在当前 HEAD 的祖先链上`);
    }
  }
  checkManifest({ evidenceDir: ev, target: summary.target || {}, errors });
  checkProbeFiles({ evidenceDir: ev, summary, errors });
  const aggregates = computeAggregates(runs);
  checkRuns({ runs, summary, aggregates, errors });
  if (summary.aggregates) {
    for (const key of ['5', '10', '20', '0']) {
      const a = summary.aggregates.full && summary.aggregates.full[key];
      const b = aggregates.full[key];
      if (!a) { errors.push(`summary.aggregates.full.${key} 缺失`); continue; }
      if (!sameCount(a.runs, b.runs)) errors.push(`aggregates.full.${key}.runs 不一致`);
      if (!sameCount(a.ok, b.ok)) errors.push(`aggregates.full.${key}.ok 不一致`);
      if (!near(a.medianDownloadMs, b.medianDownloadMs)) errors.push(`aggregates.full.${key}.medianDownloadMs 不一致`);
    }
    const ai = summary.aggregates.install;
    if (!ai || !sameCount(ai.runs, aggregates.install.runs) || !sameCount(ai.ok, aggregates.install.ok)) errors.push('aggregates.install 不一致');
    for (const f of PREREG.faultScenarios) {
      const a = summary.aggregates.faults && summary.aggregates.faults[f];
      const b = aggregates.faults[f];
      if (!a || !sameCount(a.runs, b.runs) || !sameCount(a.ok, b.ok)) errors.push(`aggregates.faults.${f} 不一致`);
    }
    if (summary.aggregates.installFaults && (!sameCount(summary.aggregates.installFaults.runs, aggregates.installFaults.runs)
      || !sameCount(summary.aggregates.installFaults.ok, aggregates.installFaults.ok))) errors.push('aggregates.installFaults 不一致');
  } else {
    errors.push('summary.aggregates 缺失');
  }
  checkGates({ summary, aggregates, errors });
  checkReport({ reportPath: report, summary, offline: summary.offline || {}, errors });
  const integrity = summary.integrity || {};
  if (!integrity.manifestSha256 || integrity.manifestSha256 !== sha256File(path.join(ev, 'manifest.json'))) errors.push('integrity.manifestSha256 不匹配');
  if (!integrity.testPubkeySha256 || integrity.testPubkeySha256 !== sha256File(path.join(ev, 'test-update-pubkey.pem'))) errors.push('integrity.testPubkeySha256 不匹配');
  if (!integrity.runsSha256 || integrity.runsSha256 !== sha256File(runsFile)) errors.push('integrity.runsSha256 不匹配');
  return { ok: errors.length === 0, errors, warnings, summary, aggregates };
}

function main() {
  const args = process.argv.slice(2);
  const has = (n) => args.includes(n);
  const arg = (n, d = '') => { const i = args.indexOf(n); return i >= 0 ? String(args[i + 1] || '') : d; };
  if (has('--help')) {
    console.log('用法：node scripts/p3-differential/evidence-validate.mjs [--repo <repo>] [--evidence <dir>] [--report <file>]');
    return;
  }
  const repo = path.resolve(arg('--repo', process.cwd()));
  const result = validateRepository({
    repo,
    evidenceDir: arg('--evidence', ''),
    reportPath: arg('--report', ''),
  });
  if (has('--json')) console.log(JSON.stringify(result, null, 2));
  else {
    if (result.ok) console.log(`✓ P3-3 证据通过：${Object.keys(result.aggregates?.full || {}).length} 个带宽档 · decision=${result.summary.decision}`);
    else for (const e of result.errors) console.log(`✗ ${e}`);
  }
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) main();
