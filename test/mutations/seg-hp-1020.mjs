/**
 * 分段选择器滑动高亮块（§101 · 2026-10-20）的变异清单 —— 纯数据，
 * 供 `NODE_OPTIONS= node scripts/mutate.mjs test/mutations/seg-hp-1020.mjs` 复跑。
 *
 * 背景：`.seg` 有 5 处实例，原本选中态是「每个选项各自变底色」，没有滑动指示器。
 * 机制取自 Watermelon Highlight（MIT），改造成水平 + 按 `:checked` 定位。
 *
 * ⚠️ **第一版用 CSS 过渡，真机实测跑不起来**：`paintPage` 每次整页重建 `#page`，
 *    点一下 `.seg` 的旧节点在 120ms 内就被卸载 ⇒ 逐帧采样只拿到 2 个值（起点/终点），
 *    也就是说"看着像做了动画，其实从不滑动"。现改为**跨重绘的 WAAPI**：
 *    在新节点上从旧坐标滑过去（旧坐标由 `SEG_POS` 按 `data-seg` 记住）。
 *    这组变异就是照着这个实现写的 —— 每一条都必须**只打红 §101**。
 *
 * 写法约定（与同目录其它清单一致）：anchor 必须在文件里**恰好命中 1 次**（`count: 1`），
 * `apply` 只做一处替换 —— 命中数不对时 `mutate-lint` 判 INVALID，而不是"跑过去但不证明任何事"。
 *
 * ⚠️ 跑这一批必须带 `NODE_OPTIONS=` 前缀（R39），且**串行**（mutate 会改写真实工作树）。
 * ⚠️ 2026-10-20 本轮**没有**跑动态变异器：当时工作树里有另一条会话的 16 处未提交改动
 *    （含 `panel/next/app.js` 本身），跑 mutate 会改写共享工作树。
 *    改用的等价做法：把仓库 rsync 到 `/tmp/seg-hp-mut`（排除 research/napcat/console-profile，
 *    `node_modules` 软链），在复本上逐条施加并跑真 `check-wb`。这份清单的用途是让下一次
 *    **在干净工作树上**用官方运行器复跑同一组。
 */

const CSS = 'panel/next/style.css';
const APP = 'panel/next/app.js';

export default [
  {
    id: 'M1',
    note: '`positionSegHp` 里不再判 `M.reducedMotion()` —— §101 必须变红'
      + '（减弱动效下仍然滑动；正常人看不出区别）。预期 BLOCKED（check-wb §101）',
    file: APP,
    anchor: /const reduced = M \? M\.reducedMotion\(\) : false;/,
    count: 1,
    apply: (s) => s.replace('const reduced = M ? M.reducedMotion() : false;', 'const reduced = false;'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M2',
    note: '把动画时长写死成 160 —— §101 必须变红'
      + '（抄上游最常见的形态：数值照搬、令牌丢掉；`segDurMs` 与 `--dur` 读取都不再被用）。'
      + '预期 BLOCKED（check-wb §101）',
    file: APP,
    anchor: /\{ duration: segDurMs\(hp\), easing: 'cubic-bezier\(\.4, 0, \.2, 1\)' \},/,
    count: 1,
    apply: (s) => s.replace(
      "{ duration: segDurMs(hp), easing: 'cubic-bezier(.4, 0, .2, 1)' },",
      "{ duration: 160, easing: 'cubic-bezier(.4, 0, .2, 1)' },"),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M3',
    note: '把 `mountSegHp()` 从 `onPageShown` 里摘掉 —— §101 必须变红'
      + '（3 秒轮询整页重建后不再重挂：高亮闪一下消失，而页面其它一切正常）。预期 BLOCKED（check-wb §101）',
    file: APP,
    anchor: /  markTiltables\(\);\n  mountSegHp\(\);\n/,
    count: 1,
    apply: (s) => s.replace('  markTiltables();\n  mountSegHp();\n', '  markTiltables();\n', 1),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M4',
    note: 'change 委托里不再调用 `positionSegHp` —— §101 必须变红'
      + '（点选项时块不动；若改成"每次重建各绑一次"则是监听器随轮询累积）。预期 BLOCKED（check-wb §101）',
    file: APP,
    anchor: /  if \(seg\) positionSegHp\(seg, true\);\n/,
    count: 1,
    apply: (s) => s.replace('  if (seg) positionSegHp(seg, true);\n', '  if (seg) { }\n', 1),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M5',
    note: '把 `.seg-hp` 的定位基准从 absolute 改成 static —— §101 必须变红'
      + '（块回到文档流里，滑动失效但元素仍在，肉眼像是"多了一圈边框"）。预期 BLOCKED（check-wb §101）',
    file: CSS,
    anchor: /\.seg \.seg-hp \{\n  position: absolute;/,
    count: 1,
    apply: (s) => s.replace('.seg .seg-hp {\n  position: absolute;', '.seg .seg-hp {\n  position: static;'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M6',
    note: '`RENDER.seg` 不再输出 `data-seg` —— §101 必须变红'
      + '（跨重绘记不住上一位置：动画只能从 0 宽度长出来或干脆不动，且不报错）。'
      + '⚠️ 这一条是"实现换了、判据要跟着走"的样本：`data-seg` 是 WAAPI 版本才有的东西。'
      + '预期 BLOCKED（check-wb §101）',
    file: APP,
    anchor: /<div class="seg" data-seg="\$\{esc\(x\.id \|\| ''\)\}">/,
    count: 1,
    apply: (s) => s.replace('<div class="seg" data-seg="${esc(x.id || \'\')}">', '<div class="seg">'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
];
