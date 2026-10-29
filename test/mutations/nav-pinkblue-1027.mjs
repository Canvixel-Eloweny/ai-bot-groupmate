/**
 * 导航粉蓝配色回滚（§131 · 2026-10-27）的变异清单 —— 纯数据，
 * 供 `NODE_OPTIONS= node scripts/mutate.mjs test/mutations/nav-pinkblue-1027.mjs` 复跑。
 *
 * 背景：`8b2545d`「去灰轮」把 `--c-nav-pill-a/b` 与 `--c-nav-l2-grad-a/b`
 * 从粉蓝/冷蓝改成中性灰/白；旧判据只查 `linear-gradient`，灰化后照样全绿。
 * 本轮把定稿色值与 `.sub` 的墨色接线写进 §131，这四条变异就是防它再静默回灰。
 *
 * 写法约定：anchor 必须在文件里**恰好命中 1 次**（`count: 1`），`apply` 只做一处替换；
 * 命中数不对时 `mutate-lint` 判 INVALID，而不是"跑过去但不证明任何事"。
 *
 * ⚠️ 跑之前先提交（mutate 只支持干净树、会改写真实工作树），且串行。
 */
const CSS = 'panel/next/style.css';

export default [
  {
    id: 'P1',
    note: '把浅色粉端 #ffdbe9 换回中性灰 #eceff2 —— §131 必须变红'
      + '（胶囊只剩蓝→灰，看起来"像有渐变"但粉没了）。预期 BLOCKED（check-wb §131 粉蓝配色）',
    anchor: /--c-nav-pill-b:\s*#ffdbe9;/,
    count: 1,
    file: CSS,
    apply: (s) => s.replace(/--c-nav-pill-b:\s*#ffdbe9;/, '--c-nav-pill-b: #eceff2;'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'P2',
    note: '把深色粉端 rgba(196,108,158,.36) 换成中性白 —— §131 必须变红'
      + '（深色胶囊只剩淡蓝→白）。预期 BLOCKED（check-wb §131 粉蓝配色）',
    anchor: /--c-nav-pill-b:\s*rgba\(196, 108, 158, \.36\);/,
    count: 1,
    file: CSS,
    apply: (s) => s.replace(
      /--c-nav-pill-b:\s*rgba\(196, 108, 158, \.36\);/,
      '--c-nav-pill-b: rgba(255, 255, 255, .08);'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'P3',
    note: '把浅色冷蓝托盘下缘换成近白 —— §131 必须变红'
      + '（二级栏回到"几乎看不出蓝"的状态，肉眼像渐变丢失）。预期 BLOCKED（check-wb §131 粉蓝配色）',
    anchor: /--c-nav-l2-grad-b:\s*rgba\(230, 240, 251, \.86\);/,
    count: 1,
    file: CSS,
    apply: (s) => s.replace(
      /--c-nav-l2-grad-b:\s*rgba\(230, 240, 251, \.86\);/,
      '--c-nav-l2-grad-b: rgba(247, 249, 250, .86);'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'P4',
    note: '把 `.sub` 的墨色退回全局中性 `--c-text-2` —— §131 必须变红'
      + '（导航专属令牌"定义了没人用"，二级文字悄悄变灰）。预期 BLOCKED（check-wb §131 接线）',
    anchor: /color: var\(--c-nav-l2-fg\);/,
    count: 1,
    file: CSS,
    apply: (s) => s.replace('color: var(--c-nav-l2-fg);', 'color: var(--c-text-2);'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
];
