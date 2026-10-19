/**
 * P9「下载提示 / 详情英文化」门禁的定向变异（2026-10-19）。
 * ⚠️ 原 M28（删置灰行）与 C1 随维护者点名还原「二选一/置灰」回 P8 快照而撤除（r8）。
 * 这几条证明新判据真会红。
 */
export default [
  {
    id: 'M29',
    note: '把 installerAscii 的非 ASCII 替换摘掉 —— 详情框 sanitization 兜底没了，中文路径又变乱码',
    file: 'packaging/windows/tools/lib/install-layout.mjs',
    anchor: /String\(s\)\.replace\(\/\[\^\\x00-\\x7F\]\+\/g, '\?'\)/g,
    count: 1,
    apply: (s) => s.replace("String(s).replace(/[^\\x00-\\x7F]+/g, '?')", 'String(s)'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M30',
    note: '往 bootstrap 的输出行塞回中文 —— nsExec 按系统码页解码，详情框必乱码（P9 群友截图）',
    file: 'packaging/windows/tools/bootstrap.mjs',
    anchor: /say\('\[ok\] first-run configuration complete'\);/g,
    count: 1,
    apply: (s) => s.replace("say('[ok] first-run configuration complete');", "say('[ok] first-run configuration complete');\n  say('中文回潮探针');"),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M31',
    note: '删掉下载时的页眉副标题提示 —— 下载那几分钟又变回「看起来卡死」（群友回执原症状）',
    file: 'packaging/windows/installer/Estrella-Bot.nsi',
    anchor: /SendMessage \$R0 \$\{WM_SETTEXT\} 0 "STR:\$\(DL_HINT\)"\n/g,
    count: 1,
    apply: (s) => s.replace('    SendMessage $R0 ${WM_SETTEXT} 0 "STR:$(DL_HINT)"\n', ''),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
];
