/**
 * P8「中文乱码」门禁的定向变异（2026-10-19）。
 * 群友真机回执：选中文后自定文案全是乱码。根因 = .nsi 无 UTF-8 BOM，
 * makensis 3.13 按构建机 ACP（英文 Windows = CP1252）读源码（VM 探针定量证实）。
 * 这几条证明新/改的门禁判据真会红。
 */
export default [
  {
    id: 'M26',
    note: '剥掉 .nsi 的 UTF-8 BOM —— 英文构建机上中文又会以 CP1252 乱码烤进语言表（P8 群友真机症状）',
    file: 'packaging/windows/installer/Estrella-Bot.nsi',
    anchor: /^\uFEFF/g,
    count: 1,
    apply: (s) => s.replace(/^\uFEFF/, ''),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M27',
    note: '删掉 Unicode true —— 安装器输出格式非 Unicode，中文 Windows 上同样整页乱码',
    file: 'packaging/windows/installer/Estrella-Bot.nsi',
    anchor: /Unicode true\n/g,
    count: 1,
    apply: (s) => s.replace('Unicode true\n', ''),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'C1',
    note: '对照组：只给 .nsi 加一行行尾注释，不应被拦截',
    file: 'packaging/windows/installer/Estrella-Bot.nsi',
    anchor: /!insertmacro MUI_LANGDLL_DISPLAY\n/g,
    count: 1,
    apply: (s) => s.replace('!insertmacro MUI_LANGDLL_DISPLAY\n', '!insertmacro MUI_LANGDLL_DISPLAY ; p8 control\n'),
    layer: 'check-wb',
    expect: 'NOT-BLOCKED',
  },
];
