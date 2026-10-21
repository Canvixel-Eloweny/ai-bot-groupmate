/**
 * Win-v0.1.2 移植 · §130「数据与门禁收口」的定向变异（2026-10-21）。
 */
export default [
  {
    id: 'G1',
    note: '热度账本去掉原子写与 0600 —— §130 的落盘纪律判据应红',
    file: 'src/index.js',
    anchor: /writeJsonAtomic\(HEAT_FILE, heatState, \{ mode: 0o600 \}\);/g,
    count: 1,
    apply: (s) => s.replace('writeJsonAtomic(HEAT_FILE, heatState, { mode: 0o600 });', 'writeJsonAtomic(HEAT_FILE, heatState);'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'G2',
    note: '把 waiting 自检从 check:features 里换掉 —— §130 的 10 项自检判据应红',
    file: 'package.json',
    anchor: /node test\/check-wait-images\.mjs"/g,
    count: 1,
    apply: (s) => s.replace('node test/check-wait-images.mjs"', 'node test/check-missing.mjs"'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'G3',
    note: '把 images-out 预建目录改名 —— §130 的图片目录自建判据应红',
    file: 'src/user-root.js',
    anchor: /path\.join\(roots\.dataDir, 'images-out'\)/g,
    count: 1,
    apply: (s) => s.replace("path.join(roots.dataDir, 'images-out')", "path.join(roots.dataDir, 'images')"),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'G4',
    note: '沙箱不再排除 /data/ —— §130 的沙箱隔离判据应红',
    file: 'test/sandbox.sh',
    anchor: /--exclude '\/data\/'/g,
    count: 1,
    apply: (s) => s.replace("--exclude '/data/'", "--exclude '/nope/'"),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
];
