/**
 * §131（二级滑块「同步幂等 + 取数回环」· 2026-10-21）的变异清单 —— 纯数据。
 *
 * 真机视频里的"横线乱跑 / 消失 / 位置错"不是弹簧参数问题，而是：
 *   ① 日志与审计页的 loadLogs()/loadAudit() 取完数就 softPaint()，而 onPageShown()
 *      每次重画又会再调它们 ⇒ 本地取数回环（实测每秒上千次重画）；
 *   ② syncNav2Indicator() 每次调用都 stop()+animate()，高频重启让弹簧带着速度
 *      反复重来，速度指数发散（实测 translateX(66662px) / width(21304px)），
 *      横线冲出 `.nav2wrap` 后被 clip-path 裁掉。
 * 这五条各打一个失效面，每条都必须**只打红 §131**。
 *
 * 跑法：`NODE_OPTIONS= node scripts/mutate.mjs test/mutations/nav2-idem-1021.mjs`
 * ⚠️ 串行；会改写真实工作树。
 */

const CSS = 'panel/next/style.css';
const APP = 'panel/next/app.js';

export default [
  {
    id: 'Q1',
    note: '删掉二级滑块「目标未变就 return」的早退 —— §131① 必须变红'
      + '（每次重画都重启弹簧，重复重启会数值发散，横线飞出后被裁掉）。预期 BLOCKED',
    file: APP,
    anchor: /const x = sel\.offsetLeft \+ NAV2_INSET - nav\.scrollLeft;\n  const w = Math\.max\(0, sel\.offsetWidth - NAV2_INSET \* 2\);\n  \/\*[\s\S]{0,600}?\*\/\n  if \(!instant && ind\.inited\n      && Math\.abs\(ind\.tx - x\) < 0\.5 && Math\.abs\(ind\.tw - w\) < 0\.5\) return;/,
    count: 1,
    apply: (s) => s.replace(
      /(const x = sel\.offsetLeft \+ NAV2_INSET - nav\.scrollLeft;[\s\S]{0,600}?\*\/\n)  if \(!instant && ind\.inited\n      && Math\.abs\(ind\.tx - x\) < 0\.5 && Math\.abs\(ind\.tw - w\) < 0\.5\) return;\n/,
      '$1'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'Q2',
    note: '删掉 loadLogs 的「没有新行 → return」守卫 —— §131② 必须变红'
      + '（softPaint() 会经 onPageShown 再调 loadLogs，形成每秒上千次的取数回环）。预期 BLOCKED',
    file: APP,
    anchor: /    if \(!reset && !fresh\.length\) return;\n/,
    count: 1,
    apply: (s) => s.replace('    if (!reset && !fresh.length) return;\n', '', 1),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'Q3',
    note: '把横线改回 bottom:3px / height:2px —— §131④ 必须变红'
      + '（用户 2026-10-21 明确要求上移 + 加粗）。预期 BLOCKED',
    file: CSS,
    anchor: /\.nav2-ind \{\n  position: absolute; left: 0; bottom: 6px;\n  height: 3px; width: 0;/,
    count: 1,
    apply: (s) => s.replace(
      '.nav2-ind {\n  position: absolute; left: 0; bottom: 6px;\n  height: 3px; width: 0;',
      '.nav2-ind {\n  position: absolute; left: 0; bottom: 3px;\n  height: 2px; width: 0;'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'Q4',
    note: '删掉二级滑块写样式前的非有限值拦截 —— §131③ 必须变红'
      + '（数值坏了以后 CSS 静默忽略 transform / width 归零，横线消失但不报错）。预期 BLOCKED',
    file: APP,
    anchor: /    if \(!Number\.isFinite\(x\) \|\| !Number\.isFinite\(w\)\) return;   \/\/ 理由同一级滑块\n/,
    count: 1,
    apply: (s) => s.replace(
      '    if (!Number.isFinite(x) || !Number.isFinite(w)) return;   // 理由同一级滑块\n', '', 1),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'Q5',
    note: '删掉 loadAudit 的「内容未变 → return」守卫 —— §131② 必须变红'
      + '（同上，审计页也会变成取数回环）。预期 BLOCKED',
    file: APP,
    anchor: /    if \(S\.extra\.auditSig === sig\) return;\n/,
    count: 1,
    apply: (s) => s.replace('    if (S.extra.auditSig === sig) return;\n', '', 1),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
];
