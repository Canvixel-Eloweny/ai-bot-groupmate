/**
 * B4 · 优雅停止与首启（§123 · 2026-10-21）的变异清单。
 * 跑法：NODE_OPTIONS= node scripts/mutate.mjs test/mutations/shutdown-1021.mjs
 */

const CC = 'src/control-channel.js';
const IDX = 'src/index.js';
const SRV = 'panel/server.js';
const ONE = 'packaging/windows/tools/onekey.mjs';
const CMN = 'packaging/windows/tools/lib/common.mjs';
const GEN = 'scripts/make-config-example.mjs';
const SCH = 'panel/next/schema.js';
const CR = 'panel/lib/config-route.js';

export default [
  {
    id: 'S1',
    note: 'shutdown 退出控制命令闭集合 —— §123① 必须变红（面板停止回到硬杀）',
    file: CC,
    anchor: /, 'shutdown'\]/,
    count: 1,
    apply: (s) => s.replace(", 'shutdown']", ']'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'S2',
    note: 'shutdown 寿命退回 2 分钟 —— §123② 必须变红（强杀后的旧命令会让下次启动即退）',
    file: CC,
    anchor: /CONTROL_MAX_AGE_BY_KIND = \{ shutdown: 30 \* 1000 \}/,
    count: 1,
    apply: (s) => s.replace('CONTROL_MAX_AGE_BY_KIND = { shutdown: 30 * 1000 }', 'CONTROL_MAX_AGE_BY_KIND = { shutdown: 120 * 1000 }'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'S3',
    note: 'index 不再消费 shutdown —— §123③ 必须变红（命令写了没人执行）',
    file: IDX,
    anchor: /if \(cmd === 'shutdown'\)/,
    count: 1,
    apply: (s) => s.replace("if (cmd === 'shutdown')", 'if (false)'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'S4',
    note: 'stopBridge 不再发 shutdown 命令 —— §123④ 必须变红（Windows 停止仍丢补写）',
    file: SRV,
    anchor: /const cmd = issueCommand\('shutdown'\);/,
    count: 1,
    apply: (s) => s.replace("const cmd = issueCommand('shutdown');", 'const cmd = { ok: false };'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'S5',
    note: '--only=check 退回只认空格写法 —— §123⑤ 必须变红',
    file: ONE,
    anchor: /argValue\('--only'\)/,
    count: 1,
    apply: (s) => s.replace("argValue('--only')", "argOf('--only')"),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'S6',
    note: 'ask 去掉非 TTY 降级 —— §123⑥ 必须变红（静默安装挂死 / exit 13）',
    file: CMN,
    anchor: /if \(!process\.stdin\.isTTY\) \{/,
    count: 1,
    apply: (s) => s.replace('if (!process.stdin.isTTY) {', 'if (false) {'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'S7',
    note: '配置模板写回中文占位群号 —— §123⑦ 必须变红',
    file: GEN,
    anchor: /  example\.allow\.groups = \[\];/,
    count: 1,
    apply: (s) => s.replace('  example.allow.groups = [];', "  example.allow.groups = ['填你的群号，例如 123456789'];"),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'S8',
    note: '面板删掉 owner.qq 控件 —— §123⑧ 必须变红',
    file: SCH,
    anchor: /bindSys: 'ownerQq'/,
    count: 1,
    apply: (s) => s.replace("bindSys: 'ownerQq'", "bindSys: 'ownerQqX'"),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'S9',
    note: '/api/config 不再接收 ownerQq —— §123⑨ 必须变红',
    file: CR,
    anchor: /if \(Array\.isArray\(body\.ownerQq\)\)/,
    count: 1,
    apply: (s) => s.replace('if (Array.isArray(body.ownerQq))', 'if (false)'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
];
