/**
 * 人设域六页（2026-10-25）的定向变异清单。
 *
 * 打的是这批**新增行为**里"坏了不报错"的四条：
 *   M1 MBTI 开着但提示词里没有（开关成了假的）
 *   M2 生日彩蛋开着但不注入
 *   M3 提示词分段覆盖被保存了、但拼提示词时不生效
 *   M4 关着的 MBTI 被旧覆盖复活
 *   M5 状态文件在、心情段永远不拼
 *   M6 moodOn 关着也注入
 *   M7 用户改过的扮演规则被忽略
 *   M8 MBTI 场景卡不再画
 *   M9 官方场景图 src 被清空
 *   M10 persona 隐藏通用页头的规则被删
 *   M11 雷达 tooltip 锚点被删
 *   M12 折线 hover 区被删
 *   M13 字段帮助锚点被删
 *   M14 卡片左上色条被删
 *   M15 色条 hover 不再拉长
 *   M16 编辑人设等快捷入口退回纯文字
 *   M17 人设内容又被收窄
 *   M18 雷达虚线轨道被删
 *   M19 柱状生长动画被改成 0s
 *   M20 MBTI 页不挂页级主题色
 *   M21 人设页字段 id 不再每轮归零（轮询永远重绘）
 *   M22 轮询重画重新播放整页入场
 *   M23 情绪柱恢复 3D 椭圆帽
 *   M24 柱顶数字回到被动画覆盖的 translateX
 *   M25 字段行恢复全局 .row 边框/底色
 *   M26 二级点击恢复全量 paintPage(true)
 *   M27 psnGrowAll 退回逐个 psnGrow
 *   M28 dock 动画恢复每帧 getBoundingClientRect
 *   M29 程序性 nav2 滚动改回 instant 跳（掐断二级胶囊弹簧）
 *
 * M1–M7 由 smoke 的 T-PSN2/3/4/5/11/12 拦住；M8–M29 由 §162 静态契约拦住。
 */

export default [
  {
    id: 'M1',
    file: 'src/mbti.js',
    anchor: /if \(!m\.on\) return \[\];/,
    count: 1,
    apply: (src) => src.replace('if (!m.on) return [];', 'if (true) return [];'),
    layer: 'smoke',
    expect: 'BLOCKED',
    note: 'MBTI 开关打开但 mbtiPromptLines 永远返回空 —— T-PSN2 必须红',
  },
  {
    id: 'M2',
    file: 'src/birthday.js',
    anchor: /if \(custom\?\.astroOn !== true\) return \[\];/,
    count: 1,
    apply: (src) => src.replace('if (custom?.astroOn !== true) return [];', 'if (true) return [];'),
    layer: 'smoke',
    expect: 'BLOCKED',
    note: '生日彩蛋开关打开但 astroPromptLines 永远返回空 —— T-PSN3 必须红',
  },
  {
    id: 'M3',
    file: 'src/prompt-sections.js',
    anchor: /sec\.lines = text === '' \? \[\] : text\.split\('\\n'\);/,
    count: 1,
    apply: (src) => src.replace("sec.lines = text === '' ? [] : text.split('\\n');", 'sec.lines = sec.lines;'),
    layer: 'smoke',
    expect: 'BLOCKED',
    note: '分段覆盖存了但不替换 sec.lines —— T-PSN4 必须红',
  },
  {
    id: 'M4',
    file: 'src/brain.js',
    anchor: /if \(s\.id === 'mbti' && custom\.mbti\?\.on !== true\) continue;/,
    count: 1,
    apply: (src) => src.replace("      if (s.id === 'mbti' && custom.mbti?.on !== true) continue;\n", ''),
    layer: 'smoke',
    expect: 'BLOCKED',
    note: '关着的 MBTI 也被旧覆盖复活 —— T-PSN5 必须红',
  },
  {
    id: 'M5',
    file: 'src/brain.js',
    anchor: /if \(custom\.moodOn !== false\) moodSec\.lines\.push\(\.\.\.moodPromptLines\(readEmotionState\(\)\)\);/,
    count: 1,
    apply: (src) => src.replace(
      'if (custom.moodOn !== false) moodSec.lines.push(...moodPromptLines(readEmotionState()));',
      'if (false) moodSec.lines.push(...moodPromptLines(readEmotionState()));'
    ),
    layer: 'smoke',
    expect: 'BLOCKED',
    note: '状态文件在、心情段永远不拼 —— T-PSN12 必须红',
  },
  {
    id: 'M6',
    file: 'src/brain.js',
    anchor: /if \(custom\.moodOn !== false\) moodSec\.lines\.push\(\.\.\.moodPromptLines\(readEmotionState\(\)\)\);/,
    count: 1,
    apply: (src) => src.replace(
      'if (custom.moodOn !== false) moodSec.lines.push(...moodPromptLines(readEmotionState()));',
      'if (true) moodSec.lines.push(...moodPromptLines(readEmotionState()));'
    ),
    layer: 'smoke',
    expect: 'BLOCKED',
    note: 'moodOn 关着也注入 —— T-PSN12 的关闭分支必须红',
  },
  {
    id: 'M7',
    file: 'src/brain.js',
    anchor: /rulesSec\.lines\.push\(\.\.\.rulesPromptLines\(resolvePlayRules\(custom\)\)\);/,
    count: 1,
    apply: (src) => src.replace(
      'rulesSec.lines.push(...rulesPromptLines(resolvePlayRules(custom)));',
      'rulesSec.lines.push(...rulesPromptLines(resolvePlayRules({})));'
    ),
    layer: 'smoke',
    expect: 'BLOCKED',
    note: '用户改过的扮演规则被忽略 —— T-PSN11 必须红',
  },
  {
    id: 'M8',
    file: 'panel/next/app.js',
    anchor: /data-psn-art-scene>\$\{psnTypeScene\(type\)\}<\/span>/,
    count: 1,
    apply: (src) => src.replace('data-psn-art-scene>${psnTypeScene(type)}</span>', 'data-psn-art-scene></span>'),
    layer: 'check-wb',
    expect: 'BLOCKED',
    note: 'MBTI 场景卡不再画（只剩空 span）—— §162 必须红',
  },
  {
    id: 'M9',
    file: 'panel/next/app.js',
    anchor: /src="\$\{PSN_ART\[type\] \|\| ''\}"/,
    count: 1,
    apply: (src) => src.replace('src="${PSN_ART[type] || \'\'}"', 'src=""'),
    layer: 'check-wb',
    expect: 'BLOCKED',
    note: '官方场景图的 src 被清空 —— §162 必须红',
  },
  {
    id: 'M10',
    file: 'panel/next/persona.css',
    anchor: /#page\[data-domain="persona"\] > \.wrap-head\{display:none\}/,
    count: 1,
    apply: (src) => src.replace('#page[data-domain="persona"] > .wrap-head{display:none}', ''),
    layer: 'check-wb',
    expect: 'BLOCKED',
    note: 'persona 隐藏通用页头的规则被删 —— §162 必须红',
  },
  {
    id: 'M11',
    file: 'panel/next/app.js',
    anchor: /data-tip="radar"/,
    count: 3,
    apply: (src) => src.replaceAll('data-tip="radar"', 'data-tip-x="radar"'),
    layer: 'check-wb',
    expect: 'BLOCKED',
    note: '雷达扇区/点/标签的 tooltip 锚点被删 —— §162 必须红',
  },
  {
    id: 'M12',
    file: 'panel/next/app.js',
    anchor: /<rect class="line-hover-zone"/,
    count: 1,
    apply: (src) => src.replace('<rect class="line-hover-zone"', '<rect class="line-hover-zone-x"'),
    layer: 'check-wb',
    expect: 'BLOCKED',
    note: '折线 hover 区被删（十字线无法触发）—— §162 必须红',
  },
  {
    id: 'M13',
    file: 'panel/next/app.js',
    anchor: /data-help-tip="\$\{esc\(o\.help\)\}"/,
    count: 1,
    apply: (src) => src.replace('data-help-tip="${esc(o.help)}"', 'data-help-tip-x="${esc(o.help)}"'),
    layer: 'check-wb',
    expect: 'BLOCKED',
    note: '字段帮助按钮的 data-help-tip 被删 —— §162 必须红',
  },
  {
    id: 'M14',
    file: 'panel/next/persona.css',
    anchor: /\.psn \.card::before\{/,
    count: 1,
    apply: (src) => src.replace('.psn .card::before{', '.psn .card::before-x{'),
    layer: 'check-wb',
    expect: 'BLOCKED',
    note: '卡片左上主题色条整条被删 —— §162 必须红',
  },
  {
    id: 'M15',
    file: 'panel/next/persona.css',
    anchor: /\.psn \.card:hover::before,\.psn \.card:focus-within::before\{width:96px\}/,
    count: 1,
    apply: (src) => src.replace('.psn .card:hover::before,.psn .card:focus-within::before{width:96px}', '.psn .card:hover::before,.psn .card:focus-within::before{width:80px}'),
    layer: 'check-wb',
    expect: 'BLOCKED',
    note: '色条 hover 不再拉到 96px —— §162 必须红',
  },
  {
    id: 'M16',
    file: 'panel/next/persona.css',
    anchor: /\.psn \.layer-foot \.linklike,/,
    count: 1,
    apply: (src) => src.replace('.psn .layer-foot .linklike,', '.psn .layer-foot .linklike-x,'),
    layer: 'check-wb',
    expect: 'BLOCKED',
    note: '编辑人设等页脚快捷入口退回纯文字（灰底胶囊没了）—— §162 必须红',
  },
  {
    id: 'M17',
    file: 'panel/next/persona.css',
    anchor: /max-width: 1352px;/,
    count: 1,
    apply: (src) => src.replace('max-width: 1352px;', 'max-width: 1136px;'),
    layer: 'check-wb',
    expect: 'BLOCKED',
    note: '人设内容又被收窄回 1136 —— §162 必须红',
  },
  {
    id: 'M18',
    file: 'panel/next/app.js',
    anchor: /class="radar-orbit"/,
    count: 1,
    apply: (src) => src.replace('class="radar-orbit"', 'class="radar-orbit-x"'),
    layer: 'check-wb',
    expect: 'BLOCKED',
    note: '雷达外围虚线轨道被删 —— §162 必须红',
  },
  {
    id: 'M19',
    file: 'panel/next/persona.css',
    anchor: /psn-bar-grow 1s/,
    count: 1,
    apply: (src) => src.replace('psn-bar-grow 1s', 'psn-bar-grow 0s'),
    layer: 'check-wb',
    expect: 'BLOCKED',
    note: '柱状图生长动画被改成 0s（只剩静态柱）—— §162 必须红',
  },
  {
    id: 'M20',
    file: 'panel/next/app.js',
    anchor: /data-psn-page="mbti"/,
    count: 1,
    apply: (src) => src.replace('data-psn-page="mbti"', 'data-psn-page-x="mbti"'),
    layer: 'check-wb',
    expect: 'BLOCKED',
    note: 'MBTI 页不挂页级主题色（--page-lc 回落 accent）—— §162 必须红',
  },
  {
    id: 'M21',
    file: 'panel/next/app.js',
    anchor: /if \(isPersona\) PSN_UID = 0;/,
    count: 1,
    apply: (src) => src.replace('if (isPersona) PSN_UID = 0;', ''),
    layer: 'check-wb',
    expect: 'BLOCKED',
    note: '人设页字段 id 不再每轮归零（HTML 每次都变，page-in 每 3 秒重播）—— §162 必须红',
  },
  {
    id: 'M22',
    file: 'panel/next/app.js',
    anchor: /classList\.add\('psn-no-enter'\)/,
    count: 1,
    apply: (src) => src.replace("classList.add('psn-no-enter')", "classList.add('psn-no-enter-x')"),
    layer: 'check-wb',
    expect: 'BLOCKED',
    note: '轮询重画重新播放整页入场（数据更新也会闪）—— §162 必须红',
  },
  {
    id: 'M23',
    file: 'panel/next/persona.css',
    anchor: /\.psn \.cyl\{/,
    count: 1,
    apply: (src) => src.replace('.psn .cyl{', '.psn .cyl::before{content:"";position:absolute;left:0;top:-7px;width:100%;height:14px;border-radius:50%;background:var(--cyl-color)}\n.psn .cyl{'),
    layer: 'check-wb',
    expect: 'BLOCKED',
    note: '情绪柱恢复 3D 椭圆帽 —— §162 平面柱判据必须红',
  },
  {
    id: 'M24',
    file: 'panel/next/persona.css',
    anchor: /translate:-50% 0;/,
    count: 1,
    apply: (src) => src.replace('translate:-50% 0;', 'transform:translateX(-50%);'),
    layer: 'check-wb',
    expect: 'BLOCKED',
    note: '柱顶数字回到被入场动画覆盖的 translateX —— §162/panel-dom 居中判据必须红',
  },
  {
    id: 'M25',
    file: 'panel/next/persona.css',
    anchor: /border:0;background:transparent;box-shadow:none;min-height:0;/,
    count: 1,
    apply: (src) => src.replace('border:0;background:transparent;box-shadow:none;min-height:0;', ''),
    layer: 'check-wb',
    expect: 'BLOCKED',
    note: '字段行恢复全局 .row 边框/底色 —— §162/panel-dom 紧凑判据必须红',
  },
  {
    id: 'M26',
    file: 'panel/next/app.js',
    anchor: /paintPage\(true, \{ nav1: false, nav2: false \}\);/,
    count: 1,
    apply: (src) => src.replace('paintPage(true, { nav1: false, nav2: false });', 'paintPage(true);'),
    layer: 'check-wb',
    expect: 'BLOCKED',
    note: '二级点击恢复全量重建 nav1/nav2（dock 动画每页重启）—— §162/panel-dom 必须红',
  },
  {
    id: 'M27',
    file: 'panel/next/app.js',
    anchor: /psnGrowAll\(document\.querySelectorAll\('\.psn \[data-psn-auto\]'\)\);/,
    count: 1,
    apply: (src) => src.replace("psnGrowAll(document.querySelectorAll('.psn [data-psn-auto]'));", "for (const el of document.querySelectorAll('.psn [data-psn-auto]')) psnGrow(el);"),
    layer: 'check-wb',
    expect: 'BLOCKED',
    note: 'textarea 退回逐个 psnGrow（12–24 次强制布局）—— §162 必须红',
  },
  {
    id: 'M28',
    file: 'panel/next/app.js',
    anchor: /const W = navDockBoxW;/,
    count: 1,
    apply: (src) => src.replace('const W = navDockBoxW;', 'const W = dock.getBoundingClientRect().width;'),
    layer: 'check-wb',
    expect: 'BLOCKED',
    note: 'dock 动画恢复每帧 getBoundingClientRect —— §162 必须红',
  },
  {
    id: 'M29',
    file: 'panel/next/app.js',
    anchor: /syncNav2Indicator\(performance\.now\(\) - nav2AutoScrollT > 120\);/,
    count: 1,
    apply: (src) => src.replace('syncNav2Indicator(performance.now() - nav2AutoScrollT > 120);', 'syncNav2Indicator(true);'),
    layer: 'check-wb',
    expect: 'BLOCKED',
    note: '程序性 nav2 滚动改回 instant 跳（二级胶囊切换被一帧掐到终点）—— §162 必须红',
  },
];
