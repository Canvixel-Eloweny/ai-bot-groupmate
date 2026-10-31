const PF = 'panel/next/plugin-factory.html';
const SCH = 'panel/next/schema.js';

export default [
  {
    id: 'M1',
    note: '删掉工厂保存条 —— §85 必须变红（设置改了没有保存入口）。预期 BLOCKED',
    file: PF,
    anchor: /<div class="savebar" id="pfSavebar" hidden>/,
    count: 1,
    apply: (s) => s.replace('<div class="savebar" id="pfSavebar" hidden>', '<div class="savebar" hidden>'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M2',
    note: '删掉清单开关的 data-toggle —— §85 必须变红（开关没有接线）。预期 BLOCKED',
    file: PF,
    anchor: /data-toggle="\$\{kind\}\|\$\{esc\(it\.id\)\}"/,
    count: 1,
    apply: (s) => s.replace('data-toggle="${kind}|${esc(it.id)}"', ''),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M3',
    note: '钩子超时控件键被改名 —— §85 必须变红（上限控件没了）。预期 BLOCKED',
    file: PF,
    anchor: /mk\('hookTimeoutMs', '钩子单条超时（毫秒）'/,
    count: 1,
    apply: (s) => s.replace("mk('hookTimeoutMs', '钩子单条超时（毫秒）'", "mk('hookTimeout', '钩子单条超时（毫秒）'"),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M4',
    note: '更新不再带 expectId —— §85 必须变红（选错包会静默装成另一个）。预期 BLOCKED',
    file: PF,
    anchor: /const expectId = overwrite \? importMode\.id : '';/,
    count: 1,
    apply: (s) => s.replace("const expectId = overwrite ? importMode.id : '';", "const expectId = '';"),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M5',
    note: '工厂页签名标签被改回旧名 —— §171③ 必须变红。预期 BLOCKED',
    file: SCH,
    anchor: /id: 'plugin', label: '插件技能工厂', title: '插件技能工厂',/,
    count: 1,
    apply: (s) => s.replace(
      "id: 'plugin', label: '插件技能工厂', title: '插件技能工厂',",
      "id: 'plugin', label: '插件工厂', title: '插件工厂',"),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
];
