/**
 * 横幅「不再提示」（§191 · 2026-11-08）的变异清单 —— 纯数据。
 * 跑法：
 *   NODE_OPTIONS= node scripts/mutate-lint.mjs
 *   NODE_OPTIONS= node scripts/mutate.mjs test/mutations/banner-dismiss-2026-11-08.mjs --layer check-wb
 * 纪律：anchor 必须在 pristine 文件里**恰好命中 count 次**；apply 必须返回不同且语法合法的内容。
 *
 * 这一批盯的是两种最危险的失效形态：
 *   · 圆钮被摘（用户没法关）—— M1/M2/M11
 *   · 语义被偷换（latch 写成 permanent = 报警器被拆；permanent 写成 latch = 安全警告变成每次都能重弹）—— M3/M4/M6/M8
 * 以及几条"看着像小改动、实际会让记录永远挂着 / 写错键"的：M5/M7/M9/M10。
 */
const APP = 'panel/next/app.js';
const SET = 'panel/next/settings.js';
const HTML = 'panel/next/index.html';

export default [
  {
    id: 'M1',
    note: '关闭钮不再是 banner.dismiss（点了变成重启面板）—— §191⑥ 必须变红。预期 BLOCKED',
    file: APP,
    anchor: /data-a="banner\.dismiss"/,
    count: 1,
    apply: (s) => s.replace('data-a="banner.dismiss"', 'data-a="panel.restart"'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M2',
    note: '只摘「内存很紧」这一条的 add()（那条横幅没有圆钮了）—— §191① 必须变红。预期 BLOCKED',
    file: APP,
    anchor: /add\('memory',/,
    count: 1,
    apply: (s) => s.replace(
      "add('memory',",
      "((k, h) => nodes.push({ kind: k, html: `${h}</div>` }))('memory',"),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M3',
    note: '把「内存很紧」的 latch 写成 permanent（关一次就永久静音 = 报警器被拆）—— §191② 必须变红。预期 BLOCKED',
    file: APP,
    anchor: /memory: 'latch',/,
    count: 1,
    apply: (s) => s.replace("memory: 'latch',", "memory: 'permanent',"),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M4',
    note: '把「非官方界面」的 permanent 写成 latch（安全警告变成条件一变就能重弹）—— §191② 必须变红。预期 BLOCKED',
    file: APP,
    anchor: /unofficial: 'permanent',/,
    count: 1,
    apply: (s) => s.replace("unofficial: 'permanent',", "unofficial: 'latch',"),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M5',
    note: 'latch 复位挪到 DOM 守卫之后（记录作废了但横幅还挂在页面上）—— §191③ 必须变红。预期 BLOCKED',
    file: APP,
    anchor: /resetBannerLatches\(new Set\(live\)\);/,
    count: 1,
    apply: (s) => s
      .replace(
        "  resetBannerLatches(new Set(live));\n  const html = nodes.map((x) => x.html).join('');",
        "  const html = nodes.map((x) => x.html).join('');",
      )
      .replace(
        '  bannersHtml = html;\n  box.innerHTML = html;',
        '  bannersHtml = html;\n  box.innerHTML = html;\n  resetBannerLatches(new Set(live));',
      ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M6',
    note: '复位不再区分 latch/permanent（永久项会被顺手清掉）—— §191③ 必须变红。预期 BLOCKED',
    file: APP,
    anchor: /if \(BANNER_KINDS\[k\] !== 'latch' \|\| liveKinds\.has\(k\)\) continue;/,
    count: 1,
    apply: (s) => s.replace(
      "if (BANNER_KINDS[k] !== 'latch' || liveKinds.has(k)) continue;",
      'if (liveKinds.has(k)) continue;',
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M7',
    note: 'dismissBanner 不再拒绝未知 kind（拼错的键在本机躺一辈子）—— §191④ 必须变红。预期 BLOCKED',
    file: APP,
    anchor: /if \(!Object\.prototype\.hasOwnProperty\.call\(BANNER_KINDS, kind\)\) return false;/,
    count: 1,
    apply: (s) => s.replace(
      'if (!Object.prototype.hasOwnProperty.call(BANNER_KINDS, kind)) return false;',
      'if (false) return false;',
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M8',
    note: '静音项不进 live（条件成立却被跳过 ⇒ 别的记录被误作废、关掉的条子立刻又回来）—— §191④ 必须变红。预期 BLOCKED',
    file: APP,
    anchor: /    live\.push\(kind\);\n    if \(dismissed\[kind\]\) return;/,
    count: 1,
    apply: (s) => s.replace(
      '    live.push(kind);\n    if (dismissed[kind]) return;',
      '    if (dismissed[kind]) return;\n    live.push(kind);',
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M9',
    note: '把升级横幅也并进本机 kind 表（越权改动，§154④ 的按版本语义被绕开）—— §191⑦ 必须变红。预期 BLOCKED',
    file: APP,
    anchor: /  unofficial: 'permanent',\n\}\);/,
    count: 1,
    apply: (s) => s.replace(
      "  unofficial: 'permanent',\n});",
      "  unofficial: 'permanent',\n  update: 'latch',\n});",
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M10',
    note: '设置层自己拼本机键（第二真相源，复位会漏项）—— §191⑤ 必须变红。预期 BLOCKED',
    file: SET,
    anchor: /      deps\.resetBannerDismiss\(\);/,
    count: 1,
    apply: (s) => s.replace(
      '      deps.resetBannerDismiss();',
      "      try { localStorage.removeItem('next-banner-dismiss-v1'); } catch { /* 自己拼 */ }\n      deps.resetBannerDismiss();",
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M11',
    note: '设置层没有「恢复横幅提示」按钮（permanent 项再也回不来）—— §191⑧ 必须变红。预期 BLOCKED',
    file: HTML,
    anchor: /id="setResetBanners"/,
    count: 1,
    apply: (s) => s.replace('id="setResetBanners"', 'id="setResetBanners-gone"'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
];
