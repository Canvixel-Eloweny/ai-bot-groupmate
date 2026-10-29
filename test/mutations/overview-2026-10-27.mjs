/**
 * §164（运行总览发言账本 / 热力网格 / KPI 曲线 / 启动链路）的定向变异 —— 纯数据。
 *
 * 十九条都预期 BLOCKED：
 *   M1 出口记账 n=1 → 0（数量归零，页面照常渲染）
 *   M2 估算日标记 → 永远 false（历史日被当成精确日）
 *   M3 /api/state 不再下发 heat（页面退回空网格，不报错）
 *   M4 首坏行判据反向（检查表点亮"已就绪"的那一行）
 *   M5 KPI 的「昨日」取成今天（增幅恒 0）
 *   M6 今日发言卡撤掉缩略曲线（卡还在，条形统计图没了）
 *   M7 结束运行改回实心主按钮（又变成那颗绿色大按钮）
 *   M8 主节点默认收起（用户要的「默认全展开」失效）
 *   M9 协议端延迟字段改名（今日小结的「网络延迟」永远 —）
 *   M10 今日小结的三格运行信息撤掉（卡还在，内存/延迟/时长没了）
 *   M11 启动链子项右侧百分比撤掉（只剩圈，读数没了）
 *   M12 父节点完成勾撤掉（子项全完成也不打勾）
 *   M13 去掉首次完成判据（3 秒轮询每次都重播进度动画）
 *   M14 KPI 缩略曲线重新左右内缩（卡片两侧又出现白缝）
 *   M15 四张信息卡的右侧副读数撤掉（只剩大数字，右侧一片空白）
 *   M16 Gauge 图例悬停联动撤掉（中心读数不再切换）
 *   M17 插件分类把未加载项也数进去（图例之和 ≠ 中心总数）
 *   M18 Gauge 分段间隙退回 0.016（弧段重新粘成一条）
 *   M19 空插件集时删掉 ovPctParts 的空数组哨兵（Gauge 抛 reading i，整栏变错误卡）
 *
 * 跑法（串行，先起全新 QQBOT_MUTATE_WORK）：
 *   NODE_OPTIONS= node scripts/mutate.mjs test/mutations/overview-2026-10-27.mjs
 */
const INDEX = 'src/index.js';
const REPORT = 'panel/lib/sent-report.js';
const SERVER = 'panel/server.js';
const APP = 'panel/next/app.js';
const COLLECTOR = 'panel/lib/state-collector.js';

export default [
  {
    id: 'M1',
    note: 'sendMsg 成功后把 recordSentRound 的 n 改成 0 —— §164② 必须变红'
      + '（今日发言恒 0；热力图和 KPI 看起来都"正常"，只是没数）。预期 BLOCKED',
    file: INDEX,
    anchor: /recordSentRound\(\{ n: 1, chatKey/,
    count: 1,
    apply: (s) => s.replace('recordSentRound({ n: 1, chatKey', 'recordSentRound({ n: 0, chatKey'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M2',
    note: '把估算日标记永久改成 false —— §164③ 必须变红'
      + '（历史日被当成精确 0，tooltip 不再说"按回复轮次估算"）。预期 BLOCKED',
    file: REPORT,
    anchor: /estimated = count > 0;/,
    count: 1,
    apply: (s) => s.replace('estimated = count > 0;', 'estimated = false;'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M3',
    note: 'apiState 不再下发 heat —— §164⑤ 必须变红'
      + '（前端退回空网格；没有异常，只是热力图永远空白）。预期 BLOCKED',
    file: SERVER,
    anchor: /    heat,\n    kpi: kpiOf\(\{ \.\.\.stateBody, heat \}\),/,
    count: 1,
    apply: (s) => s.replace('    heat,\n    kpi: kpiOf({ ...stateBody, heat }),', '    kpi: kpiOf({ ...stateBody, heat }),'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M4',
    note: '启动链路的首坏行判据反向 —— §100 必须变红'
      + '（点亮的是已就绪项，用户会被指到错的那一步）。预期 BLOCKED',
    file: APP,
    anchor: /const firstBad = items\.findIndex\(\(it\) => !it\.ok\);/,
    count: 1,
    apply: (s) => s.replace('const firstBad = items.findIndex((it) => !it.ok);', 'const firstBad = items.findIndex((it) => it.ok);'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M5',
    note: 'KPI 的「昨日」基数取成今天 —— §164③ 必须变红'
      + '（增幅永远 0%，卡片看起来有百分比但其实没在比昨天）。预期 BLOCKED',
    file: REPORT,
    anchor: /const prev = series\[series\.length - 2\]/,
    count: 1,
    apply: (s) => s.replace('const prev = series[series.length - 2] || null;', 'const prev = series[series.length - 1] || null;'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M6',
    note: '今日发言卡撤掉缩略曲线 —— §164⑥ 必须变红'
      + '（卡还在、数字还在，只是"背后没有条形统计图"了）。预期 BLOCKED',
    file: APP,
    anchor: /\$\{ovKpiSpark\(k\.messages\.series/,
    count: 1,
    apply: (s) => s.replace(/\$\{ovKpiSpark\(k\.messages\.series.*\n/, ''),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M7',
    note: '「结束本次运行」改回实心主按钮 —— §164⑨ 必须变红'
      + '（又变成那颗绿色大按钮，且和「拉起协议端」的空白幽灵样式不一致）。预期 BLOCKED',
    file: APP,
    anchor: /ovActionButton\('结束本次运行', 'onekey\.stop', 'ov-btn-ghost', 'stop'\)/,
    count: 1,
    apply: (s) => s.replace("ovActionButton('结束本次运行', 'onekey.stop', 'ov-btn-ghost', 'stop')", "ovActionButton('结束本次运行', 'onekey.stop', 'ov-btn-primary', 'stop')"),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M9',
    note: '协议端延迟字段改名 —— §164⑩ 必须变红'
      + '（今日小结的「网络延迟」永远显示 —，即使协议端其实连着）。预期 BLOCKED',
    file: COLLECTOR,
    anchor: /onebotLatencyMs,/,
    count: 1,
    apply: (s) => s.replace('onebotLatencyMs,', 'probeRttMs,'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M10',
    note: '撤掉今日小结底部的三格运行信息 —— §164⑩ 必须变红'
      + '（内存/延迟/运行时长又空了，卡里还是大片留白）。预期 BLOCKED',
    file: APP,
    anchor: /class="ov-focus-extra"/,
    count: 1,
    apply: (s) => s.replace('class="ov-focus-extra"', 'class="ov-focus-extra-off"'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M11',
    note: '撤掉启动链子项右侧百分比 —— §164⑪ 必须变红'
      + '（圈还在，但用户看不到 0%/100% 的读数）。预期 BLOCKED',
    file: APP,
    anchor: /class="ov-sub-pct"/,
    count: 1,
    apply: (s) => s.replace('<span class="ov-sub-pct" data-p="${pct}">${anim ? 0 : pct}%</span>', ''),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M12',
    note: '撤掉父节点完成勾 —— §164⑪ 必须变红'
      + '（子项全完成时总条目不再打勾）。预期 BLOCKED',
    file: APP,
    anchor: /class="ov-node-check"/,
    count: 1,
    apply: (s) => s.replace(/<span class="ov-node-check"[\s\S]*?<\/span>/, ''),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M13',
    note: '去掉首次完成判据 —— §164⑪ 必须变红'
      + '（每次 3 秒轮询都会把 0→100% 和打勾/横线重播一遍）。预期 BLOCKED',
    file: APP,
    anchor: /const anim = !bad && !_ovSeenDone\.has\(key\);/,
    count: 1,
    apply: (s) => s.replace('const anim = !bad && !_ovSeenDone.has(key);', 'const anim = !bad;'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M14',
    note: 'KPI 缩略曲线重新左右内缩 —— §164⑫ 必须变红'
      + '（曲线与卡片左右边框之间又出现白缝）。预期 BLOCKED',
    file: APP,
    anchor: /const xOf = \(i\) => \(i \* W\) \/ \(vals\.length - 1\);/,
    count: 1,
    apply: (s) => s.replace('const xOf = (i) => (i * W) / (vals.length - 1);', 'const xOf = (i) => 3 + (i * (W - 6)) / (vals.length - 1);'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M15',
    note: '四张信息卡的右侧副读数撤掉 —— §164⑬ 必须变红'
      + '（又只剩一个大数字，右半边空白）。预期 BLOCKED',
    file: APP,
    anchor: /class="ov-stat-side"/,
    count: 4,
    apply: (s) => s.replaceAll('class="ov-stat-side"', 'class="ov-stat-side-old"'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M16',
    note: 'Gauge 图例悬停联动撤掉 —— §164⑬ 必须变红'
      + '（图例还在，但中心读数不再跟随悬停切换）。预期 BLOCKED',
    file: APP,
    anchor: /function ovMountGauge\(root\)/,
    count: 1,
    apply: (s) => s.replace('function ovMountGauge(root)', 'function ovMountGaugeOff(root)'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M17',
    note: '插件分类把未加载项也数进去 —— §164⑬ 必须变红'
      + '（图例 4+2+1 与中心 6 再次对不上）。预期 BLOCKED',
    file: APP,
    anchor: /if \(String\(it\.action \|\| ''\) !== 'load'\) continue;/,
    count: 1,
    apply: (s) => s.replace("if (String(it.action || '') !== 'load') continue;", 'if (false) continue;'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M18',
    note: 'Gauge 分段间隙退回 0.016 —— §164⑬ 必须变红'
      + '（弧段重新粘成一条，参考图里的间隔消失）。预期 BLOCKED',
    file: APP,
    anchor: /const gap = p\.segs\.length > 1 \? Math\.min\(0\.3, 1\.4 \/ p\.segs\.length\) : 0;/,
    count: 1,
    apply: (s) => s.replace('const gap = p.segs.length > 1 ? Math.min(0.3, 1.4 / p.segs.length) : 0;', 'const gap = p.segs.length > 1 ? 0.016 : 0;'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M19',
    note: '空插件集时删掉 ovPctParts 的空数组哨兵 —— §164⑬ 必须变红'
      + '（Gauge 读 order[0].i 抛错，整个右栏被「渲染 overviewSide 时出错」替代）。预期 BLOCKED',
    file: APP,
    anchor: /if \(!counts\.length\) return \[\];/,
    count: 1,
    apply: (s) => s.replace('if (!counts.length) return [];', ''),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M8',
    note: '主节点默认收起 —— §164⑥ 必须变红'
      + '（用户要的「默认自动展开」失效，又得自己点）。预期 BLOCKED',
    file: APP,
    anchor: /const open = _ovOpen\.has\(g\.id\) \? _ovOpen\.get\(g\.id\) : true;/,
    count: 1,
    apply: (s) => s.replace('const open = _ovOpen.has(g.id) ? _ovOpen.get(g.id) : true;', 'const open = _ovOpen.has(g.id) ? _ovOpen.get(g.id) : false;'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
];
