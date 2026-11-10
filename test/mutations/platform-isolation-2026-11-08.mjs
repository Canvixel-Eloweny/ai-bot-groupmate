/**
 * 平台内容隔离（§194 · 2026-11-08 · Windows 没有 Docker）的变异清单 —— 纯数据。
 * 跑法：
 *   NODE_OPTIONS= node scripts/mutate-lint.mjs
 *   NODE_OPTIONS= node scripts/mutate.mjs test/mutations/platform-isolation-2026-11-08.mjs --layer check-wb
 * 纪律：anchor 必须在 pristine 文件里**恰好命中 count 次**；apply 必须返回不同且语法合法的内容。
 */
const SCHEMA = 'panel/next/schema.js';
const APP = 'panel/next/app.js';
const DOM = 'test/panel-dom.mjs';

export default [
  {
    id: 'M1',
    note: '平台判据比成 darwin（Windows 分支失效）—— §194① 必须变红。预期 BLOCKED',
    file: SCHEMA,
    anchor: /const isWinState = \(s\) => j\(s, \['appMeta', 'platform'\], ''\) === 'win32';/,
    count: 1,
    apply: (s) => s.replace(/=== 'win32';/, "=== 'darwin';"),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M2',
    note: '重启容器按钮改回写死（Windows 又喊容器）—— §194② 必须变红。预期 BLOCKED',
    file: SCHEMA,
    anchor: /act\(\(s\) => \(isWinState\(s\) \? '重启协议端' : '重启 QQ 容器'\), 'napcat\.restart', '', '', 'reload'\)/,
    count: 1,
    apply: (s) => s.replace(/act\(\(s\) => \(isWinState\(s\) \? '重启协议端' : '重启 QQ 容器'\), 'napcat\.restart', '', '', 'reload'\)/, "act('重启 QQ 容器', 'napcat.restart', '', '', 'reload')"),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M3',
    note: 'Docker 内存格的平台 when 被摘 —— §194② 必须变红。预期 BLOCKED',
    file: SCHEMA,
    anchor: /\{ \.\.\.memCell\('Docker', \['memory', 'procs', 'dockerMB'\], ' MB'\), when: \(s\) => !isWinState\(s\) \},/,
    count: 1,
    apply: (s) => s.replace(/\{ \.\.\.memCell\('Docker', \['memory', 'procs', 'dockerMB'\], ' MB'\), when: \(s\) => !isWinState\(s\) \},/, "memCell('Docker', ['memory', 'procs', 'dockerMB'], ' MB'),"),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M4',
    note: 'metrics 不再按 when 过滤（when 形同虚设）—— §194③ 必须变红。预期 BLOCKED',
    file: APP,
    anchor: /x\.items\.filter\(\(m\) => !m\.when \|\| m\.when\(S\.state \|\| DEMO\)\)\.map\(\(m\) => \{/,
    count: 1,
    apply: (s) => s.replace(/x\.items\.filter\(\(m\) => !m\.when \|\| m\.when\(S\.state \|\| DEMO\)\)\.map\(\(m\) => \{/, 'x.items.map((m) => {'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M5',
    note: '内存横幅不再带平台字段（Windows 又喊 Docker）—— §194② 必须变红。预期 BLOCKED',
    file: APP,
    anchor: /winPlatform: isWinState\(s\),/,
    count: 1,
    apply: (s) => s.replace(/winPlatform: isWinState\(s\),/, 'winPlatform: false,'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M6',
    note: 'panel-dom 的平台真渲染断言被摘 —— §194④ 必须变红。预期 BLOCKED',
    file: DOM,
    anchor: /Windows 上不再出现 Docker 专用控件/,
    count: 1,
    apply: (s) => s.replace(/Windows 上不再出现 Docker 专用控件/, '平台控件检查'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M7',
    note: '总览右栏重启按钮改回写死（Windows 又喊容器）—— §194②/§190⑩ 必须变红。预期 BLOCKED',
    file: APP,
    anchor: /ovActionButton\(isWinState\(s\) \? '重启协议端' : '重启 QQ 容器', 'napcat\.restart', 'ov-btn-danger', 'reload'\)/,
    count: 1,
    apply: (s) => s.replace(/ovActionButton\(isWinState\(s\) \? '重启协议端' : '重启 QQ 容器', 'napcat\.restart', 'ov-btn-danger', 'reload'\)/, "ovActionButton('重启 QQ 容器', 'napcat.restart', 'ov-btn-danger', 'reload')"),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M8',
    note: '状态卡标签改回写死「容器」（Windows 找不存在的容器）—— §194② 必须变红。预期 BLOCKED',
    file: SCHEMA,
    anchor: /label: \(s\) => \(j\(s, \['container', 'applicable'\]\) === false \? '协议端' : '容器'\)/,
    count: 1,
    apply: (s) => s.replace(/label: \(s\) => \(j\(s, \['container', 'applicable'\]\) === false \? '协议端' : '容器'\)/, "label: '容器'"),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
];