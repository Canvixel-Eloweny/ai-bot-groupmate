/**
 * P2 安装器布局（2026-10-18）的定向变异清单。
 *
 * 目标：验收 `check-wb` §108「安装器布局与单一来源」真的会红，而不是一条漂亮的空断言。
 * 复跑：`NODE_OPTIONS= node scripts/mutate.mjs test/mutations/install-p2-1018.mjs`
 */

export default [
  {
    id: 'M1',
    note: 'APP_VERSION 写死 —— 升级后健康端点/安装器会报旧版本，启动器永远等不到匹配',
    file: 'panel/lib/paths.js',
    anchor: /export const APP_VERSION = PKG\.version\.trim\(\);/m,
    count: 1,
    apply: (s) => s.replace(
      "export const APP_VERSION = PKG.version.trim();",
      "export const APP_VERSION = '0.1.3';"
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M2',
    note: 'apiHealth 读配置 —— 配置坏了安装器就没有就绪信号，且健康端点开始依赖业务',
    file: 'panel/server.js',
    anchor: /version: APP_VERSION,/m,
    count: 1,
    apply: (s) => s.replace(
      'version: APP_VERSION,',
      "version: readConfig()?.version || APP_VERSION,"
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M3',
    note: 'stop 只退面板、不停机器人 —— 机器人占着 runtime/node，安装器替换必然失败',
    file: 'packaging/windows/tools/stop.mjs',
    anchor: /const b = await post\(port, '\/api\/bridge\/stop', token,/m,
    count: 1,
    apply: (s) => s.replace(
      "const b = await post(port, '/api/bridge/stop', token,",
      "const b = { status: 200, body: '' }; void post(port, '/api/panel/quit', token,"
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M4',
    note: '进程认领退回单根 —— 升级后旧版机器人被判成“不是我们的”，安装器停不掉',
    file: 'panel/server.js',
    anchor: /roots: BRIDGE_ROOTS/g,
    count: 2,
    apply: (s) => s.replaceAll('roots: BRIDGE_ROOTS', 'root: PROGRAM_ROOT'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M5',
    note: 'NSIS 请求管理员 —— 按用户安装被破坏，且普通用户会看到 UAC',
    file: 'packaging/windows/installer/Estrella-Bot.nsi',
    anchor: /RequestExecutionLevel user/m,
    count: 1,
    apply: (s) => s.replace('RequestExecutionLevel user', 'RequestExecutionLevel admin'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M6',
    note: '卸载删用户数据不再二次确认 —— 一次误点就把 config/聊天/NapCat 登录态删光',
    file: 'packaging/windows/installer/Estrella-Bot.nsi',
    anchor: /MessageBox MB_YESNO\|MB_ICONEXCLAMATION[^\n]+/m,
    count: 1,
    apply: (s) => s.replace(
      /MessageBox MB_YESNO\|MB_ICONEXCLAMATION[^\n]+/m,
      '; mutation: no confirmation'
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'C1',
    note: '对照组：只加一行注释，不应被拦截',
    file: 'src/user-root.js',
    anchor: /export const PROGRAM_ROOT/m,
    count: 1,
    apply: (s) => s.replace('export const PROGRAM_ROOT', '// control\nexport const PROGRAM_ROOT'),
    layer: 'check-wb',
    expect: 'NOT-BLOCKED',
  },
];
