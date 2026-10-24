/**
 * P3-1 系统分配端口 / 发现文件的定向变异（2026-10-24）。
 *
 * 每条都打在 §155（以及 §3g 的 Host/Origin 实际端口判据）上：
 * 变异后 `check-wb` 必须 BLOCKED。跑法：
 *   NODE_OPTIONS= node scripts/mutate.mjs test/mutations/desktop-p3-port-1024.mjs
 * ⚠️ 串行；会改写真实工作树，失败后用 `--restore`。
 */

const PATHS = 'panel/lib/paths.js';
const SERVER = 'panel/server.js';
const LAUNCHER = 'packaging/windows/tools/launcher.mjs';
const CONSOLE = 'packaging/windows/tools/lib/console.mjs';
const STOP = 'packaging/windows/tools/stop.mjs';
const MAIN = 'electron/main.js';
const TEST = 'test/panel-port.mjs';
const PKG = 'package.json';
const DOC = 'docs/desktop/P3-PORT.md';
const DISC = 'src/panel-discovery.cjs';
const DIAG = 'packaging/windows/tools/diag.mjs';

export default [
  {
    id: 'P1',
    note: '产品形态又默认 8788 —— §155② 必须变红（8788 被占就回到起不来）',
    file: PATHS,
    anchor: /return MODE === 'dev' \? 8788 : 0;/g,
    count: 1,
    apply: (s) => s.replace("return MODE === 'dev' ? 8788 : 0;", 'return 8788;'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'P2',
    note: '面板不写发现文件 —— §155② 必须变红（启动器永远找不到端口）',
    file: SERVER,
    anchor: /panelDiscovery\.writeDiscovery\(/g,
    count: 1,
    apply: (s) => s.replace('panelDiscovery.writeDiscovery(', 'panelDiscovery.writeDiscoveryDisabled('),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'P3',
    note: '重启看门狗不继承实际端口 —— §155② 必须变红（重启后页面 origin 失效）',
    file: SERVER,
    anchor: /QQBOT_PANEL_PORT: String\(ACTUAL_PORT \|\| PORT \|\| 0\)/g,
    count: 1,
    apply: (s) => s.replace("QQBOT_PANEL_PORT: String(ACTUAL_PORT || PORT || 0)", "QQBOT_PANEL_PORT: '0'"),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'P4',
    note: 'Host/Origin 退回“任意回环端口” —— §3g/§155② 必须变红（同机其它回环服务可过闸）',
    file: SERVER,
    anchor: /Number\(u\.port\) === ACTUAL_PORT/g,
    count: 2,
    apply: (s) => s.replaceAll('Number(u.port) === ACTUAL_PORT', 'Number(u.port) > 0'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'P5',
    note: '启动器默认端口又回落 8788 —— §155③ 必须变红（产品又开始赌端口）',
    file: LAUNCHER,
    anchor: /const PORT_OVERRIDE = normalizePort\(process\.env\.QQBOT_PANEL_PORT\);/g,
    count: 1,
    apply: (s) => s.replace(
      'const PORT_OVERRIDE = normalizePort(process.env.QQBOT_PANEL_PORT);',
      'const PORT_OVERRIDE = normalizePort(process.env.QQBOT_PANEL_PORT) || 8788;',
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'P6',
    note: '启动器用 legacy 开窗而不是发现文件 url —— §155③ 必须变红（新面板会被打开到 8788）',
    file: LAUNCHER,
    anchor: /panelUrl: started\.url/g,
    count: 1,
    apply: (s) => s.replace('panelUrl: started.url', 'panelUrl: panelDiscovery.legacyPanelUrl()'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'P7',
    note: '便携包重新导出固定 PANEL_URL —— §155③ 必须变红（8788 又成了对外地址）',
    file: CONSOLE,
    anchor: /export const PANEL_LOG =/g,
    count: 1,
    apply: (s) => s.replace(
      'export const PANEL_LOG =',
      "export const PANEL_URL = 'http://127.0.0.1:8788/';\nexport const PANEL_LOG =",
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'P8',
    note: '停止链不读发现文件 —— §155④ 必须变红（动态端口面板停不掉）',
    file: STOP,
    anchor: /readDiscovery\(userRoot\)/g,
    count: 1,
    apply: (s) => s.replace('readDiscovery(userRoot)', "readDiscovery('')"),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'P9',
    note: '停止链端口未知时不再扫进程 —— §155④ 必须变红（发现文件没写成时面板变孤儿）',
    file: STOP,
    anchor: /const needSlowScan = !port \|\| portStill/g,
    count: 1,
    apply: (s) => s.replace('const needSlowScan = !port || portStill', 'const needSlowScan = portStill'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'P10',
    note: '壳又把 PANEL_URL 写死 8788 —— §155④ 必须变红（手动起壳只认旧端口）',
    file: MAIN,
    anchor: /let PANEL_URL = normalizePanelUrl\(process\.env\.QQBOT_PANEL_URL \|\| ''\) \|\| discoveryPanelUrl\(\) \|\| legacyPanelUrl\(\);/g,
    count: 1,
    apply: (s) => s.replace(
      "let PANEL_URL = normalizePanelUrl(process.env.QQBOT_PANEL_URL || '') || discoveryPanelUrl() || legacyPanelUrl();",
      "const PANEL_URL = 'http://127.0.0.1:8788/';",
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'P11',
    note: '端口测试删掉“8788 被占用”断言 —— §155⑤ 必须变红（核心场景不再被测）',
    file: TEST,
    anchor: /assert\.notEqual\(port, LEGACY/g,
    count: 1,
    apply: (s) => s.replace('assert.notEqual(port, LEGACY', 'assert.ok(port'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'P12',
    note: 'verify 漏掉 panel-port 门 —— §155⑤ 必须变红（新判据日常不跑）',
    file: PKG,
    anchor: / && NODE_OPTIONS= node test\/panel-port\.mjs/g,
    count: 1,
    apply: (s) => s.replace(' && NODE_OPTIONS= node test/panel-port.mjs', ''),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'P13',
    note: '诊断不再读发现文件 —— §155④ 必须变红（仍把 8788 当控制台判据）',
    file: DIAG,
    anchor: /readDiscovery\(USER_ROOT\)/g,
    count: 1,
    apply: (s) => s.replace('readDiscovery(USER_ROOT)', "readDiscovery('')"),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'P14',
    note: 'legacy 常量被改成 0 —— §155① 必须变红（旧版面板识别没有唯一值）',
    file: DISC,
    anchor: /LEGACY_PANEL_PORT = 8788/g,
    count: 1,
    apply: (s) => s.replace('LEGACY_PANEL_PORT = 8788', 'LEGACY_PANEL_PORT = 0'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'P15',
    note: 'sameSiteWrite 直接放行 —— §3g/§155② 必须变红（跨源写不再被拦）',
    file: SERVER,
    anchor: /return isLoopbackOrigin\(u\);/g,
    count: 1,
    apply: (s) => s.replace('return isLoopbackOrigin(u);', 'return true;'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'P16',
    note: '便携包把发现模块改回静态相对路径 —— §155④ 必须变红（安装包顶层 tools/ 找不到 app/src）',
    file: CONSOLE,
    anchor: /path\.join\(APP, 'src', 'panel-discovery\.cjs'\)/g,
    count: 1,
    apply: (s) => s.replace(
      "path.join(APP, 'src', 'panel-discovery.cjs')",
      "path.resolve('src', 'panel-discovery.cjs')",
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'P17',
    note: '启动器从 HERE 而不是当前程序根加载发现模块 —— §155③ 必须变红（versions/<ver>/app 布局下找不到）',
    file: LAUNCHER,
    anchor: /path\.join\(eff\.programRoot, 'src', 'panel-discovery\.cjs'\)/g,
    count: 1,
    apply: (s) => s.replace(
      "path.join(eff.programRoot, 'src', 'panel-discovery.cjs')",
      "path.join(HERE, 'src', 'panel-discovery.cjs')",
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'P18',
    note: '停止链不确认 legacy 8788 的进程身份 —— §155④ 必须变红（会误杀同机开发树面板）',
    file: STOP,
    anchor: /return await panelBelongsToInstall\(installRoot, versions, pid\)/g,
    count: 1,
    apply: (s) => s.replace(
      'return await panelBelongsToInstall(installRoot, versions, pid) ? legacyPort : 0;',
      'return legacyPort;',
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'P19',
    note: '启动器把 8788 上任何面板都当本安装根旧版 —— §155③ 必须变红（同机面板会挡住启动）',
    file: LAUNCHER,
    anchor: /legacyPanelBelongsToInstall\(legacyCmd, installRoot, legacyVersions\)/g,
    count: 1,
    apply: (s) => s.replace(
      'legacyPanelBelongsToInstall(legacyCmd, installRoot, legacyVersions)',
      'true',
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
];
