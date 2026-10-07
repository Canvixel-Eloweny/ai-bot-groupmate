/**
 * B29（顶部三层导航「液态玻璃统一」· 2026-10-03）的变异清单。
 *
 * 为什么要单独一批：B29 动的是**位置关系**（DOM 顺序 / z-index 次序 / top 偏移 /
 * 高度令牌），而这些失效有一个共同特征 —— **静止状态下页面看起来完全正常**：
 *   · 顶层写死 px 而令牌没跟着改 ⇒ 只有触摸设备上、且只有当标签高度变化时才错位；
 *   · z-index 次序反了 ⇒ 静止时两块玻璃不重叠，看不出谁压谁；
 *   · 二级 tab 的玻璃太透 ⇒ 只有当**深色按钮滚到它背后**时字才消失。
 * 也就是说这一批全部落在「断言存在 ≠ 断言接线」那个本项目头号风险上，
 * 而且**没有一条会自己暴露**。
 *
 * | 条  | 打的是                                              | 拦住它| 期望   |
 * |-----|-----------------------------------------------------|--------|--------|
 * | V1  | **深色**块漏掉 `--c-nav-cnt-fg`                      | §60⑧N4 | BLOCKED |
 * | V2  | 定义了 `--c-nav-cnt-fg` 但 `.cnt` 仍是 `inherit`     | §60⑧N12| BLOCKED |
 * | V3  | 二级栏白纱 `.18 → .60`（"二级栏也要压得住内容"）    | §60⑧N5②| BLOCKED |
 * | V4  | 灵动岛白纱 `.60 → .06`（"岛也一起通透"）            | §60⑧N5①| BLOCKED |
 * | V5  | `--c-nav-bg` 改回 `#000000`（纯黑）                 | §60⑧N11| BLOCKED |
 * | V6  | **只把浅色**改回纯黑（深色侧漏改）                 | §60⑧N11| BLOCKED |
 * | V7  | `.nav-inner` 里就地写 rgba（不跟主题走）            | §60⑧N6 | BLOCKED |
 * | V8  | `.navrow` z-index 40 → 45（压过顶栏）               | §60⑧N7 | BLOCKED |
 * | V9  | 吸顶行 `top` 写死 `58px`（令牌不同步）               | §60⑧N8①| BLOCKED |
 * | V10 | `@media (pointer:coarse)` 漏改 `--h-nav2`            | §60⑧N9 | BLOCKED |
 * | V11 | 删掉 `.sub:focus-visible`（键盘焦点不可见）         | §60⑧N10| BLOCKED |
 * | V12 | `-bar` 的厚度层写回 `inset 0 0 2px`（接缝变两道）   | §60⑧N15| BLOCKED |
 * | V13 | DOM 顺序错：`.nav2wrap` 回到 `.nav1` 之后          | §60⑧N14| BLOCKED |
 * | V14 | 选中文字色 `--c-sub-on` 删掉（退回 accent 单令牌）  | §60⑧N13| BLOCKED |
 * | V15 | **只把深色**白纱调到 `.04`（下限以下）              | §60⑧N5①| BLOCKED |
 * | V16 | 抽掉二级栏的 `min-width: 0`（压不动 ⇒ 遮挡重现）    | §60⑧N8③| BLOCKED |
 * | V17 | `.navrow` 退回 `display: block`（两个块级兄弟）      | §60⑧N8①| BLOCKED |
 * | V20 | 岛退回 flex 语义（`2fr auto`）⇒ 不再是视口居中     | §60⑧N8①| BLOCKED |
 * | V18 | 给二级栏加回 `position: sticky`（与父容器打架）       | §60⑧N8②| BLOCKED |
 * | V19 | 1280px 档退回三列（窄屏没有换行退路）              | §60⑧N8⑤| BLOCKED | *
 * ⚠️ **锚点纪律**（`b25.mjs` M8踩过"锚点写死注释装饰字符数量"的坑，实测命中 0/1）：
 *   V13 只锚 `class="nav2wrap"` / `class="nav1"` / `class="banners"` **三个标识符
 *   的先后**，不碰任何注释里的 `═` 或缩进 —— 注释一改锚点就漂。
 *
 * 期望：14 条全部 `BLOCKED`，`INVALID` 为 0。
 * ⚠️ 跑测试一律 `NODE_OPTIONS= node …`（R39），漏带 = 内部基线假红、mutate 会正确地拒绝开跑。
 * ⚠️ 跑之前**先提交**（R46.1：mutate 只支持单文件变异）。
 */
const CSS = 'panel/next/style.css';
const PAGE = 'panel/next/index.html';

// ── V1：深色块漏一个灵动岛令牌 → 计数胶囊在深色下继承错色 ─────────────────────
const V1 = {
  id: 'V1',
  note: '删掉**深色块里**的 --c-nav-cnt-fg —— 计数胶囊在深色下回落到"继承项色"，'
    + '而浅色下那组值是过 4.5 的（深色下未必）。表现为"深色模式计数胶囊数字发糊"。'
    + '预期 BLOCKED（§60⑧N4 --c-nav-* 名字集合深浅双向相等）',
  anchor: /(html\[data-theme="dark"\][\s\S]*?)\n\s*--c-nav-cnt-fg:\s*#c3c8d2;/,
  count: 1,
  file: CSS,
  apply: (s) => s.replace(/(html\[data-theme="dark"\][\s\S]*?)\n\s*--c-nav-cnt-fg:\s*#c3c8d2;/, '$1'),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── V2：定义了却没人用（"写了没人读"）─────────────────────────────────────
const V2 = {
  id: 'V2',
  note: '把 `.cnt` 的 color 从 var(--c-nav-cnt-fg) 改回 inherit —— 那个推理在**纯黑**岛上成立'
    + '（白 fill 提亮底色，对白字是增益），在浅色玻璃上**反了**：继承来的 #455c85 压在'
    + 'chip 底上只有 3.98:1。表现为"浅色模式计数数字看不清"。'
    + '预期 BLOCKED（§60⑧N12 --c-nav-cnt-fg 必须被 .cnt 消费）',
  anchor: /color: var\(--c-nav-cnt-fg\);/,
  count: 1,
  file: CSS,
  apply: (s) => s.replace('color: var(--c-nav-cnt-fg);', 'color: inherit;'),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── V3：二级栏玻璃为了"更透亮"调薄 → 滚动内容透上来 ────────────────────────
const V3 = {
  id: 'V3',
  note: '把 :root 的 --c-eg-surface-bar 从 .18 调到 **.60**（动机通常是"二级栏也要压得住滚动内容"'
    + '或"照抄灵动岛那一档"）—— 白纱比顶栏 .16 厚 .44，两层透出**不同**的背景色，'
    + '截图里就是"一块白牌贴在紫玻璃下面"，正是用户 2026-10-04 要求消除的那个形态。'
    + '预期 BLOCKED（§60⑧N5② 融合：二级栏与顶栏必须同档，容差 .10）'
    + '⚠️ 这条打的是**关系**不是绝对值：上一版 V3 只打绝对下限，'
    + '于是"顶栏 .16 / 二级栏 .44"这种明显分家的组合全绿 —— 闸门在真空里。',
  anchor: /--c-eg-surface-bar:\s*rgba\(255, 255, 255, \.18\);/,
  count: 1,
  file: CSS,
  apply: (s) => s.replace(
    '--c-eg-surface-bar:   rgba(255, 255, 255, .18);',
    '--c-eg-surface-bar:   rgba(255, 255, 255, .60);'),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── V4：灵动岛玻璃照抄卡片那档（岛是胶囊，透光度天然该更高）───────────────
//  ⚠️⚠️ 2026-10-04（M-1 第一步）**换了打的目标令牌**：原来打 `--c-eg-surface-isle`，
//     而**灵动岛实际用的是 `--c-nav-bg`** —— 也就是说这条变异一直在改一个
//     **不影响页面**的数字，而判据照样"BLOCKED"（**看起来在工作**）。
//     判据那一侧已同步改成 `--c-nav-bg`（见 §60⑧N5① 的换令牌说明），本条的
//     anchor / apply 必须跟着走 —— 不然它就变成"改 A、判 B"，正是本项目第 12 条。
const V4 = {
  id: 'V4',
  note: '把 --c-nav-bg 从 .60 调到 **.06**（"岛也一起通透一点"）—— '
    + '白纱再薄就压不住滚动内容：blur 只能糊掉细节、糊不掉大字与色块，'
    + '导航字会与背后正文直接叠在一起。预期 BLOCKED（§60⑧N5① 下限 ≥.10）'
    + '⚠️ 取 .06 而不是 .10：**判据是 `a < 下限`**，取等于下限的值不会报红 ——'
    + '这条变异第一次取 .10 时就是 NOT-BLOCKED（阈值边界不是缺陷，但边界要另取）。'
    + '⚠️ 只改**浅色**那一处（`.60`）：判据深浅两块都查，单侧改动就必须能拦住。',
  anchor: /--c-nav-bg:\s*rgba\(255, 255, 255, \.60\);/,
  count: 1,
  file: CSS,
  apply: (s) => s.replace(
    '--c-nav-bg:        rgba(255, 255, 255, .60);',
    '--c-nav-bg:        rgba(255, 255, 255, .06);'),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── V5：灵动岛退回纯黑（用户 B29 明确要求跟随主题）────────────────────────
const V5 = {
  id: 'V5',
  note: '把 :root 的 --c-nav-bg 改回 #000000 —— 用户 B29 原话「将黑色主题切换栏改为跟随当前'
    + '主题配色」，纯黑是该被改掉的旧形态。表现为"浅色页面上又多了一块黑"。'
    + '预期 BLOCKED（§60⑧N11 反向判据：不许再是纯黑）',
  anchor: /--c-nav-bg:\s*rgba\(255, 255, 255, \.60\);/,
  count: 1,
  file: CSS,
  apply: (s) => s.replace(
    '--c-nav-bg:        rgba(255, 255, 255, .60);',
    '--c-nav-bg:        #000000;'),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── V6：只把浅色改回纯黑（深色侧漏改）→ N11 必须是"两块都查" ────────────────
const V6 = {
  id: 'V6',
  note: '**只把深色块**的 --c-nav-bg 改成 #000000，浅色侧保持玻璃 —— '
    + '这条专打"反向判据只查了 :root、漏了深色块"这种半吊子实现'
    + '（旧设计里 --c-nav-bg 两块**都是** #000000，且**没有任何判据发现过**，这个洞开了两轮）。'
    + '预期 BLOCKED（§60⑧N11 两块都查）',
  anchor: /--c-nav-bg:\s*rgba\(11, 18, 38, \.60\);/,
  count: 1,
  file: CSS,
  apply: (s) => s.replace(
    '--c-nav-bg:        rgba(11, 18, 38, .60);',
    '--c-nav-bg:        #000000;'),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── V7：灵动岛就地写 rgba（不跟主题走）──────────────────────────────────────
const V7 = {
  id: 'V7',
  note: '给 `.nav-inner` 独立写一条 background: rgba(255,255,255,.82) —— '
    + '⚠️ 这条**同时**打两个判据：G5（玻璃区块零就地色值）扫不到它（选择器里没有 eg-on/card/'
    + 'modal-box），所以专设 §60⑧N6 按元素名再取一次并集。表现为"切到深色后岛还是白的"。'
    + '预期 BLOCKED（§60⑧N6）',
  // ⚠️ 锚点必须**精确到基础规则那一行**（首版写 `/\.nav-inner \{/` 命中 3 次：
  //    基础规则 / `body.eg-on .nav-inner` 那条 / 窄屏覆盖里的一条）⇒ count 对不上。
  anchor: /^\.nav-inner \{/m,
  count: 1,
  file: CSS,
  apply: (s) => s.replace(/^\.nav-inner \{/m, '.nav-inner {\n  background: rgba(255, 255, 255, .82);'),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── V8：z-index 次序反了 → 二级栏被岛的投影盖住 ─────────────────────────────
// ── V8：吸顶行压过顶栏（z 次序反了）────────────────────────────────────────
const V8 = {
  id: 'V8',
  note: '把 `.navrow` 的 z-index 从 40 提到 45 —— 顶栏是 42，于是**吸顶导航行盖住顶栏内容**。'
    + '⚠️ B40 起二级栏与灵动岛都收进 `.navrow`，子层**不再有自己的 z-index**（N7 反向判）—— '
    + '这条打的就是"父容器层序"这一层，静态看 diff 只会觉得"调高一点而已"。'
    + '预期 BLOCKED（§60⑧N7 相对次序 topbar > navrow）',
  anchor: /z-index: 40;/,
  count: 1,
  file: CSS,
  apply: (s) => s.replace('z-index: 40;', 'z-index: 45;'),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── V9：吸顶行的 top 写死像素（令牌不同步）──────────────────────────────────
const V9 = {
  id: 'V9',
  note: '把 `.navrow` 的 top 从 var(--h-topbar) 写死成 58px —— '
    + '桌面端恰好等于现值、看不出；但 `pointer:coarse` 下顶栏实际更高 ⇒ **错位**，'
    + '而**两级导航看起来都正常**。预期 BLOCKED（§60⑧N8① top 必须引用令牌）。'
    + '⚠️ 锚点必须**带 `.navrow` 前缀**：`top: var(--h-topbar);` 在文件里出现两次'
    + '（navrow 与速度面板的 fixed 三角），只锚字符串会 count=2 或替错那一个。',
  anchor: /\.navrow \{[^}]*?top: var\(--h-topbar\);/,
  count: 1,
  file: CSS,
  apply: (s) => s.replace(/(\.navrow \{[\s\S]*?)top: var\(--h-topbar\);/, '$1top: 58px;'),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── V16：抽掉二级栏的 min-width:0 ⇒ 它压不动，只能把岛挤走（用户报的遮挡）──
const V16 = {
  id: 'V16',
  note: '把 `.navrow > .nav2wrap` 的 `min-width: 0` 删掉 —— flex item 默认 '
    + '`min-width: auto`（= 内容宽）**压不动**，空间不够时它把灵动岛挤出/压住，'
    + '**整条二级栏被盖住**（用户实机截图 B40 的起因）。'
    + '⚠️ 这是**纯几何**退化：两层都还画得好好的、玻璃也都在，'
    + '**页面上没有任何报错**；而本机窗口宽（1440）时压根看不出来。'
    + '预期 BLOCKED（§60⑧N8③）',
  anchor: /\.navrow > \.nav2wrap \{[^}]*?min-width: 0;/,
  count: 1,
  file: CSS,
  apply: (s) => s.replace(/(\.navrow > \.nav2wrap \{[^}]*?)min-width: 0;/, '$1'),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── V17：把吸顶行退回块级 ⇒ 退回 B39 那个"两个块级兄弟"的遮挡形态 ───────────
const V17 = {
  id: 'V17',
  note: '把 `.navrow` 的 `display: grid` 改成 `display: block` —— '
    + '两个子层立刻变回**各自占满整行宽度**的块级盒子，横向必然重叠：'
    + '岛的玻璃从左边压过来，**二级栏整条被盖住**（就是用户报的那一幕）。'
    + '⚠️ 这条打的是**根因**而不是某个数值 —— B39 的错正是"用负 margin 让两个块级兄弟叠行"，'
    + '而块级盒子**完全无法分配水平空间**。预期 BLOCKED（§60⑧N8①）',
  anchor: /\.navrow \{[^}]*?display: grid;/,
  count: 1,
  file: CSS,
  apply: (s) => s.replace(/(\.navrow \{[\s\S]*?)display: grid;/, '$1display: block;'),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── V18：给二级栏重新加回 position: sticky（与父容器打架）────────────────────
const V18 = {
  id: 'V18',
  note: '给 `.nav2wrap` 加回 `position: sticky; top: 0` —— B40 起吸顶由父容器 `.navrow` '
    + '一处负责，子层各自吸顶会与父容器打架：**症状是滚动几像素后两层错开，而静止时完全正常**'
    + '（本机只在滚动后才看得出，且要看得很仔细）。预期 BLOCKED（§60⑧N8②）',
  anchor: /^\.nav2wrap \{/m,
  count: 1,
  file: CSS,
  apply: (s) => s.replace(/^\.nav2wrap \{/m, '.nav2wrap {\n  position: sticky; top: 0;'),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── V19：删掉 1280px 换行退路 ⇒ 窄屏下二级栏被压到看不见 ─────────────────────
const V19 = {
  id: 'V19',
  note: '把 `@media (max-width: 1280px)` 里的 `grid-template-columns: 1fr`（单列）改回三列 —— '
    + '空间不够并排时**没有退路**：实测二级栏被压到 ~90px、五个 tab 一个都看不见'
    + '（"不遮住了但没法用"）。⚠️ **本机窗口宽，这一档完全看不出来** —— '
    + '只有用户那种小窗口才会现形，而那时他已经报过一次了。预期 BLOCKED（§60⑧N8⑤）',
  anchor: /\.navrow \{ grid-template-columns: 1fr; height: auto; row-gap: 0; \}/,
  count: 1,
  file: CSS,
  apply: (s) => s.replace('.navrow { grid-template-columns: 1fr; height: auto; row-gap: 0; }', '.navrow { grid-template-columns: 1fr auto 1fr; height: auto; row-gap: 0; }'),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── V10：触摸设备的媒体查询漏改 --h-nav2────────────────────────────────────
const V10 = {
  id: 'V10',
  note: '从 `@media (pointer:coarse)` 里删掉 --h-nav2 —— 触摸设备上二级栏比 :root 里'
    + '低一档，两层不齐平（而且 `.sub` 被 min-height:44px 顶起，`.nav2` 实际装不下）。'
    + '⚠️ **本机只有鼠标，这条路径无法靠肉眼发现**。'
    + '预期 BLOCKED（§60⑧N9 三处媒体查询都要改）',
  // ⚠️ 锚点用**字符串**而不是正则（首版写了正则、带 `\n`，结果 mutate 把
  //    `\n` 当字面量两个字符去匹配 ⇒ 命中 0，实测报 INVALID）。
  //    锚点只锚那一行的 `:root {...}`，避开任何注释。
  // ⚠️⚠️ **这个锚点写死了 `--h-nav2: 58px`** —— B39 把它改成 60px（与 --h-nav1 相等），
  //    锚点就命中 0、整条报 INVALID。**改取值的那一次必须一起改锚点**，
  //    否则"变异失效"会被读成"防线失效"，方向正好相反。
  anchor: ':root { --h-nav1: 60px; --h-nav-item: 44px; --h-nav2: 60px; }\n  .btn,',
  count: 1,
  file: CSS,
  apply: (s) => s.replace(
    '@media (pointer: coarse) {\n  :root { --h-nav1: 60px; --h-nav-item: 44px; --h-nav2: 60px; }',
    '@media (pointer: coarse) {\n  :root { --h-nav1: 60px; --h-nav-item: 44px; }'),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── V11：删掉键盘焦点环 ─────────────────────────────────────────────────────
const V11 = {
  id: 'V11',
  note: '删掉整条 `.sub:focus-visible` 规则 —— 文件开头那条 `:focus:not(:focus-visible)'
    + '{outline:none}` 已经把浏览器默认焦点环清掉了，`.sub` 自己不补就等于键盘用户'
    + '看不到焦点在哪。⚠️ **不报红、鼠标用户完全无感**。'
    + '预期 BLOCKED（§60⑧N10）',
  anchor: /\.sub:focus-visible \{ outline: 2px solid var\(--c-accent\); outline-offset: 2px; \}/,
  count: 1,
  file: CSS,
  apply: (s) => s.replace(/\.sub:focus-visible \{[^\n]*\n/, ''),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── V12：厚度层写回四边 → 接缝变成两道暗角 ─────────────────────────────────
const V12 = {
  id: 'V12',
  note: '把 --c-eg-inset-bar 末层的 `inset 0 -2px 2px` 写回 `inset 0 0 2px` —— '
    + 'B29 特意让它**只压下沿**，因为三层上下相邻时每条各留一道下沿暗角就是"两道脏缝"。'
    + '表现为"二级栏与灵动岛之间有一道灰边"。预期 BLOCKED（§60⑧N15 厚度层必须只压下沿）',
  anchor: /inset 0 -2px 2px var\(--c-eg-vol-bottom\);/,
  count: 4,   /* ⚠️ 首版写 2 —— 实测文件里是 **4 处**（深浅两块 × bar/isle），
               * 写少会让 mutate 判 INVALID（"改动数与 count 不符"）。 */
  file: CSS,
  apply: (s) => s.split('inset 0 -2px 2px var(--c-eg-vol-bottom);')
    .join('inset 0 0 2px var(--c-eg-vol-bottom);'),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── V13：DOM 顺序错（静态层必须单独判，否则 N7/N8 全绿而页面是错的）──────────
const V13 = {
  id: 'V13',
  note: '把 .nav2wrap 整块挪回 .nav1 之后 —— B29 的"上移"**本质是改 DOM 顺序**'
    + '（三层都是 position:sticky 且都在正常文档流，文档顺序决定谁在上）。'
    + '⚠️ N7/N8 判的是**样式里写的** top 与 z-index，改 DOM 顺序它们一条都不报 '
    + '⇒ 首版这条挂在 verify 层，但实测 mutate **不支持该层**'
    + '（只认 check-wb / smoke / sandbox / panel），报"未指定层"。'
    + '所以补了 N14 判 DOM 先后，把它挪回 check-wb。'
    + '预期 BLOCKED（§60⑧N14 三层 DOM 先后）',
  /* ⚠️⚠️ 锚点**不许把中间那段注释写死**（2026-10-04 修复）。
     旧锚点写的是 `<div class="nav2wrap"…</div>\n\n<!-- ══+ 一级导航` —— 而 B30 在
     两者之间**插了一段 B30 的说明注释**（删 `.page-meta` 那次），于是锚点命中 0、
     整个 V13 报 INVALID。**这正是本工具纪律③要拦的形态**：锚点失效必须硬失败，
     不能混进"拦住/没拦住"。
     ⇒ 现在只用两个**结构锚**（nav2wrap 块 → nav1 块）串起来，中间夹什么注释都不管。 */
  anchor: /<div class="nav2wrap"[\s\S]*?<\/div>[\s\S]*?<nav class="nav1"[\s\S]*?<\/nav>/,
  count: 1,
  file: PAGE,
  apply: (s) => {
    const m = /(<div class="nav2wrap"[\s\S]*?<\/div>)([\s\S]*?)(<nav class="nav1"[\s\S]*?<\/nav>)/.exec(s);
    if (!m) return s;
    /* 把 nav2wrap 块搬到 nav1 **之后**（顺序从 `nav2wrap → nav1` 变成 `nav1 → nav2wrap`）。
       ⚠️ 三块都要留在结果里：旧实现写成 `${m[2]}\n${m[1]}`，**把 nav1 整块丢了** ——
       它照样能 BLOCKED（N14 取不到 nav1 就报红），但拦住的理由变成了"元素没了"，
       而不是"顺序反了"。变异要打的必须是**它声称打的那件事**。 */
    return s.replace(m[0], `${m[2]}${m[3]}\n${m[1]}`);
  },
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── V14：选中文字色删掉（退回 accent 一个令牌扛两种门槛）────────────────────
const V14 = {
  id: 'V14',
  note: '删掉 :root 的 --c-sub-on —— 选中文字只能退回 --c-accent，而下划线（非文本图形'
    + '只要 ≥3）也用它，**一个令牌扛不住两种门槛**：把 accent 调浅到 3.x 时'
    + '图形还合格、文字已经塌了。表现为"选中项文字偏浅"。'
    + '预期 BLOCKED（§60⑧N13 选中文字与下划线必须两个令牌）',
  anchor: /--c-sub-on:\s*#26457f;/,
  count: 1,
  file: CSS,
  apply: (s) => s.replace(/\n  --c-sub-on:\s*#26457f;[^\n]*\n/, '\n'),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── V15：只把**深色**块的白纱调到下限以下（专打"N5 深浅两块都查"）──────────
const V15 = {
  id: 'V15',
  note: '把 html[data-theme="dark"] 里的 --c-eg-surface-bar 从 .12 调到 .04 —— '
    + '⚠️ 这条**只动深色侧**，浅色一个字都不碰。N5 ① 此前只查 :root，'
    + '于是"深色下二级栏几乎没玻璃"会完全静默（这与 N4 补过的"深色漏改"是同型洞，'
    + '同一次修复里补的：判据现在深浅两块都查）。预期 BLOCKED（§60⑧N5① 下限 ≥.10）',
  anchor: /--c-eg-surface-bar:\s*rgba\(11, 18, 38, \.12\);/,
  count: 1,
  file: CSS,
  apply: (s) => s.replace(
    '--c-eg-surface-bar:   rgba(11, 18, 38, .12);',
    '--c-eg-surface-bar:   rgba(11, 18, 38, .04);'),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── V20：三列改成 `2fr auto` ⇒ 岛仍"居中"但左列更宽，视觉上偏 ───────────────
const V20 = {
  id: 'V20',
  note: '把 `grid-template-columns: 1fr auto 1fr` 改成 `2fr auto` —— '
    + '岛**仍然**在视口正中（它独占 auto 列），但左列比右列宽一倍，'
    + '二级栏（贴左）与岛之间的空档不再对称 ⇒ **看起来仍然是偏的**。'
    + '⚠️ 这条专打"只判有没有 auto 那一列"的松判据 —— 岛居中不等于布局对称。'
    + '预期 BLOCKED（§60⑧N8① 必须是 `1fr auto 1fr`）',
  anchor: /grid-template-columns: 1fr auto 1fr;/,
  count: 1,
  file: CSS,
  apply: (s) => s.replace('grid-template-columns: 1fr auto 1fr;', 'grid-template-columns: 2fr auto;'),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

export default [V20, V1, V2, V3, V4, V5, V6, V7, V8, V9, V10, V11, V12, V13, V14, V15, V16, V17, V18, V19];
