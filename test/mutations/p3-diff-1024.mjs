/**
 * P3-3 差分评估的定向变异（2026-10-24）。
 *
 * 每条都打在 §158 上：变异后 `check-wb` 必须 BLOCKED。
 * 跑法（串行；会改写真实工作树，失败后用 --restore）：
 *   NODE_OPTIONS= node scripts/mutate.mjs test/mutations/p3-diff-1024.mjs
 */

const SUMMARY = 'docs/desktop/evidence/p3-differential/summary.json';
const RUNS = 'docs/desktop/evidence/p3-differential/runs.json';
const REPORT = 'docs/desktop/P3-DIFFERENTIAL.md';
const MANIFEST_TOOL = 'packaging/windows/update/make-manifest.mjs';
const TEST_PUB = 'docs/desktop/evidence/p3-differential/test-update-pubkey.pem';

export default [
  {
    id: 'DF1',
    note: '把 no-go 改成 go 但不补 V5 数据 —— §158 决策规则必须变红',
    file: SUMMARY,
    anchor: /"decision": "no-go"/g,
    count: 1,
    apply: (s) => s.replace('"decision": "no-go"', '"decision": "go"'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'DF2',
    note: '把一条 5 Mbps 运行改成 10 Mbps —— §158 重复次数/聚合必须变红',
    file: RUNS,
    anchor: /"runId":"full-5-1"[^\n]*?"bandMbps":5/,
    count: 1,
    apply: (s) => s.replace(/("runId":"full-5-1"[^\n]*?"bandMbps"):5/, '$1:10'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'DF3',
    note: '改报告里的 target SHA —— §158 报告与 summary 一致性必须变红',
    file: REPORT,
    anchor: /dbf5d2c659ee004120f7524fec9ff34aac95c5f73e018f1d3872e2417bb6c437/g,
    count: 1,
    apply: (s) => s.replace(
      'dbf5d2c659ee004120f7524fec9ff34aac95c5f73e018f1d3872e2417bb6c437',
      'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'DF4',
    note: '给生产清单生成器加 delta 字段 —— §158 no-go 时生产无 delta 必须变红',
    file: MANIFEST_TOOL,
    anchor: /const manifest = \{/g,
    count: 1,
    apply: (s) => s.replace('const manifest = {', 'const manifest = {\n    delta: false,'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'DF5',
    note: '删掉报告的预登记标题 —— §158 预登记存在性必须变红',
    file: REPORT,
    anchor: /## 2\. 预登记判据/g,
    count: 1,
    apply: (s) => s.replace('## 2. 预登记判据', '## 2. 预登记（删）'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'DF6',
    note: '把一条成功运行改成失败 —— §158 场景成功判据必须变红',
    file: RUNS,
    anchor: /"runId":"full-10-1"[^\n]*?"outcome":\{"ok":true/,
    count: 1,
    apply: (s) => s.replace(
      /("runId":"full-10-1"[^\n]*?"outcome":\{"ok":)true/,
      '$1false',
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'DF7',
    note: '破坏测试公钥 PEM —— §158 清单验签必须变红',
    file: TEST_PUB,
    anchor: /-----BEGIN PUBLIC KEY-----/g,
    count: 1,
    apply: (s) => s.replace('-----BEGIN PUBLIC KEY-----', '-----BEGIN NOPE-----'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
];
