/**
 * §171 · UI 身份锁的定向变异（2026-10-29）。
 *
 * 只打 §171 的判据；负向对照（加新页/新域/新选择器仍通过）由 §171⑩ 的
 * 纯函数自证承担，不真改 schema —— 那会撞 verify.mjs 的 7 域、
 * check-wb §165 的工厂 5 页、panel-dom 的 3 frame 等既有精确计数。
 */

const ID = 'panel/ui-identity.json';
const SIG = 'panel/ui-identity.json.sig';
const HTML = 'panel/next/index.html';
const APP = 'panel/next/app.js';
const MOD = 'panel/lib/ui-identity.js';
const SRV = 'panel/server.js';
const PUB = 'resources/update-pubkey.pem';

export default [
  {
    id: 'M1',
    note: '改一个核心页 ID 但不重签 —— §171① 必须因验签失败变红',
    file: ID,
    anchor: /"id": "faces"/,
    count: 1,
    apply: (s) => s.replace('"id": "faces"', '"id": "faces2"'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M2',
    note: '删掉二级导航外壳 #nav2 —— §171④ 必须报缺外壳',
    file: HTML,
    anchor: /id="nav2"/,
    count: 1,
    apply: (s) => s.replace('id="nav2"', 'data-nav2="1"'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M3',
    note: '删掉设置层 #settingsPanel —— §171④ 必须报缺外壳',
    file: HTML,
    anchor: /id="settingsPanel"/,
    count: 1,
    apply: (s) => s.replace('id="settingsPanel"', 'data-settings-panel="1"'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M4',
    note: '删掉 refresh() 里的整段身份检查（if/else）—— §171⑤ 必须报接线缺失',
    file: APP,
    anchor: /if \(S\.state && S\.state\.uiIdentity\) runUiIdentityCheck\(S\.state\.uiIdentity\);\n  else if \(S\.online\) runUiIdentityCheck\(null\);/,
    count: 1,
    apply: (s) => s.replace(
      'if (S.state && S.state.uiIdentity) runUiIdentityCheck(S.state.uiIdentity);\n  else if (S.online) runUiIdentityCheck(null);',
      '',
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M5',
    note: '删掉非官方横幅分支 —— §171⑤ 必须报横幅缺失',
    file: APP,
    anchor: /data-ui-identity="unofficial"/,
    count: 1,
    apply: (s) => s.replace('data-ui-identity="unofficial"', 'data-ui-identity="x"'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M7',
    note: '换掉更新公钥 —— §171① 必须因指纹 pin 不符变红',
    file: PUB,
    anchor: /BEGIN PUBLIC KEY/,
    count: 1,
    apply: (s) => s.replace('BEGIN PUBLIC KEY', 'BEGIN PUBLIC KEYX'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M8',
    note: '截断身份签名 —— §171① 必须因验签失败变红',
    file: SIG,
    anchor: /^[A-Za-z0-9+/]{20}/,
    count: 1,
    apply: (s) => 'A'.repeat(20) + s.slice(20),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M9',
    note: '删掉安装根公钥候选 —— §171⑧ 必须报公钥双候选缺失',
    file: MOD,
    anchor: /path\.join\(INSTALL_ROOT, 'resources', 'update-pubkey\.pem'\),/,
    count: 1,
    apply: (s) => s.replace("path.join(INSTALL_ROOT, 'resources', 'update-pubkey.pem'),\n", ''),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M10',
    note: '删掉 /api/state 的 uiIdentity 下发 —— §171⑥ 必须报接线缺失',
    file: SRV,
    anchor: /uiIdentity: uiIdentityState\(\),/,
    count: 1,
    apply: (s) => s.replace('uiIdentity: uiIdentityState(),\n', ''),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
];
