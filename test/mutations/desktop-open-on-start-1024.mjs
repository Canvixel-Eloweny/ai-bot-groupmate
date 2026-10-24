/**
 * openOnStart 对 Electron 壳生效的定向变异（2026-10-24）。
 *
 * 每条都打在 §157 上：变异后 `check-wb` 必须 BLOCKED。
 * 跑法：
 *   NODE_OPTIONS= node scripts/mutate.mjs test/mutations/desktop-open-on-start-1024.mjs
 * ⚠️ 串行；会改写真实工作树，失败后用 `--restore`。
 */

const LM = 'src/launch-mode.js';
const LAUNCHER = 'packaging/windows/tools/launcher.mjs';

export default [
  {
    id: 'SL1',
    note: 'shouldStartHidden 只认 --hidden —— §157① 必须变红（openOnStart=false 又被绕过）',
    file: LM,
    anchor: /return Boolean\(wantHidden\) \|\| openOnStart === false;/g,
    count: 1,
    apply: (s) => s.replace('return Boolean(wantHidden) || openOnStart === false;', 'return Boolean(wantHidden);'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'SL2',
    note: 'openWindow 不读配置 —— §157③ 必须变红（有壳的主路径仍只看 --hidden）',
    file: LAUNCHER,
    anchor: /const hidden = lm && typeof lm\.shouldStartHidden === 'function'\n    \? lm\.shouldStartHidden\(\{ wantHidden: WANT_HIDDEN, openOnStart: launch \? launch\.openOnStart : true \}\)\n    : WANT_HIDDEN;/g,
    count: 1,
    apply: (s) => s.replace(
      "const hidden = lm && typeof lm.shouldStartHidden === 'function'\n"
      + "    ? lm.shouldStartHidden({ wantHidden: WANT_HIDDEN, openOnStart: launch ? launch.openOnStart : true })\n"
      + '    : WANT_HIDDEN;',
      'const hidden = WANT_HIDDEN;',
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'SL3',
    note: 'openShell 的 --hidden 仍只看 CLI —— §157② 必须变红（配置传不进壳）',
    file: LAUNCHER,
    anchor: /if \(hidden\) args\.push\('--hidden'\);/g,
    count: 1,
    apply: (s) => s.replace("if (hidden) args.push('--hidden');", "if (WANT_HIDDEN) args.push('--hidden');"),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'SL4',
    note: '隐藏启动仍记 opened:true —— §157② 必须变红（面板谎报“已打开”）',
    file: LAUNCHER,
    anchor: /opened: !hidden,/g,
    count: 2,
    apply: (s) => s.replaceAll('opened: !hidden,', 'opened: true,'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'SL5',
    note: '无壳回落只看 WANT_HIDDEN —— §157③ 必须变红（openOnStart=false 仍会开浏览器）',
    file: LAUNCHER,
    anchor: /if \(hidden\) return \{ ok: true, skipped: true, reason: 'hidden-without-shell' \};/g,
    count: 1,
    apply: (s) => s.replace(
      "if (hidden) return { ok: true, skipped: true, reason: 'hidden-without-shell' };",
      "if (WANT_HIDDEN) return { ok: true, skipped: true, reason: 'hidden-without-shell' };",
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'SL6',
    note: '老版本 app 不再 fail-open 到 --hidden —— §157④ 必须变红（回滚时窗口被吞）',
    file: LAUNCHER,
    anchor: /: WANT_HIDDEN;/g,
    count: 1,
    apply: (s) => s.replace(': WANT_HIDDEN;', ': false;'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'SL7',
    note: 'openWindow 不再读 launch 段 —— §157③ 必须变红（配置被彻底绕过）',
    file: LAUNCHER,
    anchor: /launch = lm \? lm\.readLaunchFile\(configFile\) : null;/g,
    count: 1,
    apply: (s) => s.replace('launch = lm ? lm.readLaunchFile(configFile) : null;', 'launch = null;'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'SL8',
    note: 'openWindow 传 visible 给 openShell —— §157③ 必须变红（算出 hidden 也不用）',
    file: LAUNCHER,
    anchor: /panelUrl, hidden \}\);/g,
    count: 1,
    apply: (s) => s.replace('panelUrl, hidden });', 'panelUrl, hidden: false });'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'SL9',
    note: '隐藏启动不记 skipped —— §157② 必须变红（面板结果与事实不符）',
    file: LAUNCHER,
    anchor: /\.\.\.\(hidden \? \{ skipped: true, hidden: true \} : \{\}\),/g,
    count: 2,
    apply: (s) => s.replaceAll('...(hidden ? { skipped: true, hidden: true } : {}),', ''),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'SL10',
    note: 'shouldStartHidden 不再导出 —— §157① 必须变红（启动器拿不到判据）',
    file: LM,
    anchor: /export function shouldStartHidden\(/g,
    count: 1,
    apply: (s) => s.replace('export function shouldStartHidden(', 'function shouldStartHidden('),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
];
