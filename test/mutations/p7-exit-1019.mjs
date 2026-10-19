/**
 * P7「结束本次运行」真退出的定向变异（2026-10-18）。
 * 群友测试原话：右上角的退出不是真退出、留残骸。这几条证明新门禁真会红。
 */
export default [
  {
    id: 'M21',
    note: '把 exitPanelNow 里的 process.exit(0) 换成空操作 —— 面板进程不退，"结束本次运行"又变回假退出',
    file: 'panel/server.js',
    anchor: /server\.close\(\(\) => process\.exit\(0\)\);\n  setTimeout\(\(\) => process\.exit\(0\), BRIDGE_SETTLE_MS\);/g,
    count: 1,
    apply: (s) => s.replace(
      'server.close(() => process.exit(0));\n  setTimeout(() => process.exit(0), BRIDGE_SETTLE_MS);',
      'server.close(() => void 0);\n  setTimeout(() => void 0, BRIDGE_SETTLE_MS);'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M22',
    note: '把关窗前的 --app= 命令行校验换成恒真 —— 下一步就是拿用户的浏览器进程开刀',
    file: 'panel/server.js',
    anchor: /cmd\.includes\('--app='\)/g,
    count: 1,
    apply: (s) => s.replace("cmd.includes('--app=')", 'true'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M23',
    note: '把维护者点名删掉的 Pick .zip 按钮加回 NapCat 页 —— 群友测试证明它是一条走不通的视觉承诺',
    file: 'packaging/windows/installer/Estrella-Bot.nsi',
    anchor: /\$\{NSD_CreateButton\} 58% 62u 42% 12u "\$\(NAP_PICK\)"/g,
    count: 1,
    apply: (s) => s.replace('  ${NSD_CreateButton} 58% 62u 42% 12u "$(NAP_PICK)"', '  ${NSD_CreateButton} 58% 62u 20% 12u "Pick .zip..."\n  ${NSD_CreateButton} 80% 62u 20% 12u "$(NAP_PICK)"'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M24',
    note: '删掉 SimpChinese 语言与首页语言选择 —— 安装器退回纯英文（群友测试第一条回执）',
    file: 'packaging/windows/installer/Estrella-Bot.nsi',
    anchor: /!insertmacro MUI_LANGUAGE "SimpChinese"\n/g,
    count: 1,
    apply: (s) => s.replace('!insertmacro MUI_LANGUAGE "SimpChinese"\n', ''),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M25',
    note: '把 Mac 陈旧锁容忍窗改回 5 分钟 —— 那 5 分钟里每次点图标都只开一个空白页（维护者回执原症状）',
    file: 'Estrella-Bot.app/Contents/Resources/launcher.sh',
    anchor: /\[ "\$age" -gt 45 \]/g,
    count: 1,
    apply: (s) => s.replace('[ "$age" -gt 45 ]', '[ "$age" -gt 300 ]'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'C1',
    note: '对照组：只加一段行尾注释，不应被拦截',
    file: 'panel/server.js',
    anchor: /async function apiOnekeyStop\(req, res, url\) \{/g,
    count: 1,
    apply: (s) => s.replace('async function apiOnekeyStop(req, res, url) {', 'async function apiOnekeyStop(req, res, url) { // p7 control'),
    layer: 'check-wb',
    expect: 'NOT-BLOCKED',
  },
];
