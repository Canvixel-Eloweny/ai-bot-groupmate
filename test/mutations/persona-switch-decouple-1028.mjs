/**
 * 人设域换域切换解耦（2026-10-28）的变异清单 —— 纯数据。
 *
 * 本批要解决的是「从运行/发言切到人设，一级栏与二级栏明显卡顿」：
 * 导航与页面内容在同一条时间线上互相挤（内容只让开两帧、而 dock 跑 380ms）。
 * 每条变异各打一个失效面，**只打红它对应的那一条判据**。
 *
 * 跑法：`NODE_OPTIONS= node scripts/mutate.mjs test/mutations/persona-switch-decouple-1028.mjs`
 * ⚠️ 串行；会改写真实工作树。
 */

const APP = 'panel/next/app.js';
const CSS = 'panel/next/persona.css';

export default [
  {
    id: 'PS1',
    note: '落图不等导航停稳（改成立刻下一帧）—— §162「分段渲染等导航停稳」必须变红'
      + '（图表体与入场动画又回到 dock 380ms 动画里面起播）。预期 BLOCKED',
    file: APP,
    anchor: /if \(navDockAnimating\(\)\) navDockSettled\(psnArm\);\n  else requestAnimationFrame\(psnArm\);/,
    count: 1,
    apply: (s) => s.replace(
      'if (navDockAnimating()) navDockSettled(psnArm);\n  else requestAnimationFrame(psnArm);',
      'requestAnimationFrame(psnArm);', 1),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'PS2',
    note: '壳落定后不排期落图 —— §162「分段渲染排期」必须变红'
      + '（壳永远空着，图表再也不出现；这种失效不报错、只是图没了）。预期 BLOCKED',
    file: APP,
    anchor: /if \(staged\) \{ psnChartSlots = slots; psnScheduleArm\(\); \}/,
    count: 1,
    apply: (s) => s.replace('if (staged) { psnChartSlots = slots; psnScheduleArm(); }',
      'if (staged) { psnChartSlots = slots; }', 1),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'PS3',
    note: '轮询缓存改成存"壳"而不是完整趟 —— §162「轮询缓存只存完整趟」必须变红'
      + '（下一轮逐字比较永远不等 ⇒ 人设页每 3 秒整页重播入场）。预期 BLOCKED',
    file: APP,
    anchor: /S\.extra\.psnHtml = isPersona \? html : null;/,
    count: 1,
    apply: (s) => s.replace("S.extra.psnHtml = isPersona ? html : null;",
      "S.extra.psnHtml = isPersona ? (html || '') : null;", 1),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'PS4',
    note: '页级入场把 filter:blur(3px) 加回来 —— §162 反向判据必须变红'
      + '（祖先 blur 会让 10 张 backdrop-filter 卡逐帧重光栅）。预期 BLOCKED',
    file: CSS,
    anchor: /@keyframes psn-page-in\{from\{opacity:0;transform:translateY\(8px\)\}to\{opacity:1;transform:none\}\}/,
    count: 1,
    apply: (s) => s.replace(
      '@keyframes psn-page-in{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}',
      '@keyframes psn-page-in{from{opacity:0;transform:translateY(8px);filter:blur(3px)}to{opacity:1;transform:none;filter:none}}', 1),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'PS5',
    note: '滚动状态的键退回 `S.gi + \'/\' + S.si`（换域时用新页的键去采集旧 DOM）——'
      + ' §162「跨页不恢复旧滚动」必须变红（表现是旧域容器的滚动位置被恢复到新页同路径节点，'
      + '且换域那一帧白遍历一遍旧 DOM）。预期 BLOCKED',
    file: APP,
    anchor: /if \(S\.extra\.paintKey !== S\.gi \+ '\/' \+ S\.si\) return null;\n/,
    count: 1,
    apply: (s) => s.replace("if (S.extra.paintKey !== S.gi + '/' + S.si) return null;\n", '', 1),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'PS6',
    note: '撤掉分段渲染的动画闸门 —— §162「分段渲染动画闸门」必须变红'
      + '（壳一插进页面，psn-page-in 等入场就立刻起播，又和导航同窗）。预期 BLOCKED',
    file: CSS,
    anchor: /#page\.psn-stage \.psn,\n#page\.psn-stage \.psn \*\{animation:none!important\}/,
    count: 1,
    apply: (s) => s.replace('#page.psn-stage .psn,\n#page.psn-stage .psn *{animation:none!important}', '', 1),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
];
