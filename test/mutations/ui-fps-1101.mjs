/**
 * 界面动画帧率上限 0–120 的定向变异（2026-11-01）。
 *
 * 每条都打在 §176 上：变异后 `check-wb` 必须 BLOCKED。
 * 跑法：
 *   NODE_OPTIONS= node scripts/mutate.mjs test/mutations/ui-fps-1101.mjs
 * ⚠️ 串行；会改写真实工作树，失败后用 `--restore`。
 */

const FRAME = 'panel/next/frame-rate.js';
const HTML = 'panel/next/index.html';
const SETTINGS = 'panel/next/settings.js';
const APP = 'panel/next/app.js';
const FF = 'panel/next/factory-frame.js';

export default [
  {
    id: 'UF1',
    note: '0 档不再走原生快路径 —— §176② 必须变红（默认设置给所有 rAF 加一帧延迟）',
    file: FRAME,
    anchor: /if \(fps === 0\) return nativeRAF\(fn\);/g,
    count: 1,
    apply: (s) => s.replace('if (fps === 0) return nativeRAF(fn);', 'if (false) return nativeRAF(fn);'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'UF2',
    note: '原生 cancel 被改名 —— §176② 必须变红（取消会撞到包装器 id）',
    file: FRAME,
    anchor: /nativeCAF/g,
    count: 2,
    apply: (s) => s.replaceAll('nativeCAF', 'nativeCancel'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'UF3',
    note: '包装 id 从 1 开始 —— §176② 必须变红（会和原生句柄撞号）',
    file: FRAME,
    anchor: /ID_BASE = 0x40000000/g,
    count: 1,
    apply: (s) => s.replace('ID_BASE = 0x40000000', 'ID_BASE = 1'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'UF4',
    note: '持久化键改名 —— §176② 必须变红（设置与 iframe 不同步）',
    file: FRAME,
    anchor: /KEY = 'qqbot-ui-fps'/g,
    count: 1,
    apply: (s) => s.replace("KEY = 'qqbot-ui-fps'", "KEY = 'qqbot-ui-fps-broken'"),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'UF5',
    note: '外观页流畅度卡被改名 —— §176③ 必须变红（用户找不到 0–120）',
    file: HTML,
    anchor: /id="card-appearance-perf"/g,
    count: 1,
    apply: (s) => s.replace('id="card-appearance-perf"', 'id="card-appearance-perf-broken"'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'UF6',
    note: 'softPaint 不再跳过设置层 —— §176③ 必须变红（调滑块时 3 秒整页重建）',
    file: APP,
    anchor: /  if \(document\.documentElement\.classList\.contains\('settings-open'\)\) return;\n/g,
    count: 1,
    apply: (s) => s.replace("  if (document.documentElement.classList.contains('settings-open')) return;\n", ''),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'UF7',
    note: '人设折线退回固定 1/60 —— §176③ 必须变红（高刷屏跑快、低刷屏跑慢）',
    file: APP,
    anchor: /const dt = st\.last \? Math\.min\(0\.05, Math\.max\(1 \/ 240, \(t - st\.last\) \/ 1000\)\) : 1 \/ 60;/g,
    count: 2,
    apply: (s) => s.replace(
      'const dt = st.last ? Math.min(0.05, Math.max(1 / 240, (t - st.last) / 1000)) : 1 / 60;',
      'const dt = 1 / 60;',
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'UF8',
    note: 'frame-rate.js 不再先于动画脚本加载 —— §176① 必须变红（部分 rAF 抓不到）',
    file: HTML,
    anchor: /<script src="\.\/frame-rate\.js"><\/script>/g,
    count: 1,
    apply: (s) => s.replace('<script src="./frame-rate.js"></script>', '<script src="./frame-rate-late.js"></script>'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'UF9',
    note: '工厂 iframe 不再注入上限 —— §176③ 必须变红（工厂页不受控）',
    file: FF,
    anchor: /    installFrameRate\(frame\);\n/g,
    count: 1,
    apply: (s) => s.replace('    installFrameRate(frame);\n', ''),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
];
