/**
 * 右键浮层（§102⑥ · 2026-10-20）的变异清单 —— 纯数据。
 *
 * 只改呈现层：居中 modal → 锚点浮层；信息与三个动作一字未改。
 * 数值规格借自 bencho（`transform-origin: 100% 0` / 只写 from 的关键帧 / 180ms），
 * **未取任何代码行**（bencho 无公开仓库与许可声明）。
 *
 * 跑法：`NODE_OPTIONS= node scripts/mutate.mjs test/mutations/ctx-menu-1020.mjs`
 */

const APP = 'panel/next/app.js';

export default [
  {
    id: 'R1',
    note: '把 `openCtxMenu(ev, …)` 换回 `modal(…)` —— §102⑥ 必须变红'
      + '（行为没坏、体验静默回退：这条判据专门防"改回去也没人发现"）。预期 BLOCKED',
    file: APP,
    anchor: /  openCtxMenu\(ev, `「\$\{b\.name\}」`/,
    count: 1,
    apply: (s) => s.replace('  openCtxMenu(ev, `「${b.name}」`', '  modal(`「${b.name}」`', 1),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'R2',
    note: '去掉 Escape 关闭 —— §102⑥ 必须变红（键盘用户关不掉浮层）。预期 BLOCKED',
    file: APP,
    anchor: /document\.addEventListener\('keydown', \(e\) => \{\n  if \(e\.key === 'Escape'\) closeCtxMenu\(\);\n\}\);\n/,
    count: 1,
    apply: (s) => s.replace("document.addEventListener('keydown', (e) => {\n  if (e.key === 'Escape') closeCtxMenu();\n});\n", '', 1),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'R3',
    note: '去掉按视口夹紧（直接放在 clientX/Y）—— §102⑥ 必须变红'
      + '（右下角右键时菜单一半在屏幕外）。预期 BLOCKED',
    file: APP,
    anchor: /  m\.style\.left = `\$\{Math\.max\(pad, Math\.min\(ev\.clientX, window\.innerWidth - mw - pad\)\)\}px`;\n  m\.style\.top = `\$\{Math\.max\(pad, Math\.min\(ev\.clientY, window\.innerHeight - mh - pad\)\)\}px`;/,
    count: 1,
    apply: (s) => s.replace(
      '  m.style.left = `${Math.max(pad, Math.min(ev.clientX, window.innerWidth - mw - pad))}px`;\n  m.style.top = `${Math.max(pad, Math.min(ev.clientY, window.innerHeight - mh - pad))}px`;',
      '  m.style.left = `${ev.clientX}px`;\n  m.style.top = `${ev.clientY}px`;'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
];
