/**
 * 打开方式立即切换 / modeExplicit 迁移的定向变异（2026-11-01）。
 *
 * 每条都打在 §104 / §156 上：变异后 `check-wb` 必须 BLOCKED。
 * 跑法：
 *   NODE_OPTIONS= node scripts/mutate.mjs test/mutations/desktop-launch-mode-2026-11-01.mjs
 * ⚠️ 串行；会改写真实工作树，失败后用 `--restore`。
 */

const MAIN = 'electron/main.js';
const PRELOAD = 'electron/preload.js';
const SETTINGS = 'panel/next/settings.js';
const SCHEMA = 'panel/next/schema.js';
const CFG_ROUTE = 'panel/lib/config-route.js';

export default [
  {
    id: 'LM1',
    note: 'second-instance 不再按 browser 分支 —— §104 必须变红（窗口可见时二次启动不会开浏览器）',
    file: MAIN,
    anchor: /readLaunchPreference\(\)\.mode === 'browser'/g,
    count: 1,
    apply: (s) => s.replace("readLaunchPreference().mode === 'browser'", "readLaunchPreference().mode === 'nope'"),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'LM2',
    note: 'main 不再调用 decideShellStart —— §104 必须变红（启动形态退回无判据）',
    file: MAIN,
    anchor: /desktop\.shellState\.decideShellStart\(\{/g,
    count: 1,
    apply: (s) => s.replace('desktop.shellState.decideShellStart({', 'desktop.shellState.decideStartVisibility({'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'LM3',
    note: 'preload 删掉 openInBrowser —— §156 通道白名单必须变红（设置层点了没入口）',
    file: PRELOAD,
    anchor: /  openInBrowser: \(\) => ipcRenderer\.invoke\('shell:open-in-browser'\),\n/g,
    count: 1,
    apply: (s) => s.replace("  openInBrowser: () => ipcRenderer.invoke('shell:open-in-browser'),\n", ''),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'LM4',
    note: 'show-window handler 漏 trustedIpc —— §156 来源校验必须变红（任意页面都能调窗口）',
    file: MAIN,
    anchor: /  ipcMain\.handle\('shell:show-window', \(event\) => \{\n    if \(!trustedIpc\(event\)\) return \{ ok: false, error: '不信任的调用来源' \};\n/g,
    count: 1,
    apply: (s) => s.replace(
      "  ipcMain.handle('shell:show-window', (event) => {\n    if (!trustedIpc(event)) return { ok: false, error: '不信任的调用来源' };\n",
      "  ipcMain.handle('shell:show-window', (event) => {\n",
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'LM5',
    note: 'settings 不再调壳的 openInBrowser —— §104 必须变红（只存配置，点了没反应）',
    file: SETTINGS,
    anchor: /openInBrowser/g,
    count: 2,
    apply: (s) => s.replaceAll('openInBrowser', 'startBrowser'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'LM6',
    note: 'schema 不再用 howLabel —— §104 必须变红（上次启动又退回浏览器/独立窗口三态猜测）',
    file: SCHEMA,
    anchor: /l\.howLabel \|\| /g,
    count: 1,
    apply: (s) => s.replace('l.howLabel || ', ''),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'LM7',
    note: 'config-route 不再写 modeExplicit —— §104 必须变红（旧默认永远被当成用户选择）',
    file: CFG_ROUTE,
    anchor: /cfg\.launch\.modeExplicit = true;/g,
    count: 1,
    apply: (s) => s.replace('cfg.launch.modeExplicit = true;', 'cfg.launch.modePinned = true;'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
];
