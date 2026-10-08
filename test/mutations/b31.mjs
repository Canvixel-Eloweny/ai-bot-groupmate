/**
 * B31（卡片 3D 倾斜 + 跟随高光 · 2026-10-04 · `panel/next/tilt.js`）的变异清单。
 *
 * 这一批打的都是**「坏了完全看不出来」**：光标扫过去什么都不发生，
 * 而页面是全对的 —— 没有报错、没有白屏、按钮照常能点。
 * 静态判据见 `check-wb` §62（12 条子判据），行为判据见 `panel/next/verify.mjs`
 * （7 条，含一条"跨过一次整页重绘倾斜仍在"）。
 *
 *   | 条   | 打的是 | 该由哪一层拦住 | 期望 |
 *   |---|---|---|---|
 *   | M1  | `tilt.js` 排到 `motion.js` **之前** | check-wb §62⑥ | BLOCKED |
 *   | M2  | `markTiltables()` **从 `onPageShown` 里删掉** | check-wb §62⑤ | BLOCKED |
 *   | M3  | `markTiltables()` 里**不喊** `Tilt.resync()` | check-wb §62⑫ | BLOCKED |
 *   | M4  | CSS 的 transform 里去掉 `rotateX(var(--tilt-rx…))` | check-wb §62⑦ | BLOCKED |
 *   | M5  | 给 `[data-tilt]` 的 transform 加 CSS transition | check-wb §62⑧（反向） | BLOCKED |
 *   | M6  | 删掉 `prefers-reduced-motion` 那一块 | check-wb §62⑨ | BLOCKED |
 *   | M7  | 把已删掉的**跟随高光**接回来（`[data-tilt]::after`） | check-wb §62⑩（反向） | BLOCKED |
 *   | M8  | `tilt.js` 自己起一条 `requestAnimationFrame` 循环 | check-wb §62② | BLOCKED |
 *   | M9  | 三条事件从 `document` 改绑到元素上 | check-wb §62④ | BLOCKED |
 *   | M10 | 给 `[data-tilt]` 加回 `transform-style: preserve-3d` | check-wb §62⑬（反向） | BLOCKED |
 *   | M11 | 倾角上限改回"更明显"的 12° | check-wb §62⑭ | BLOCKED |
 *
 * ⚠️ **M3 是本轮实测发现的真问题**：整页每 3 秒 `innerHTML` 重建，
 *    正在倾斜的卡片被换成新节点 ⇒ 变量与 `tilt-on` 全丢 ⇒
 *    「鼠标停在卡片上不动，卡片每 3 秒自己正一下再斜回来」。
 *    事件委托只解决了"事件收得到"，**没解决"状态丢了"**——这两件事别混。
 * ⚠️ M9 打的是"不需要重绘守卫"这条**前提本身**：监听一旦绑到元素上，
 *    那个前提就没了（而页面在 3 秒内看起来完全正常）。
 * ⚠️ **2026-10-05（第 7 轮 · 变异锚点修复）**：M7 与 M11 重锚，形态都变了 ——
 *    · **M7 的方向反转了**：旧形态打"深色那份 `--c-eg-glare` 被删"，
 *      而整套高光已按用户两轮反馈**整组删除**，`§62⑩` 现在是**反向判据**。
 *      所以变成"把高光接回来"，理由与取证写在 M7 上方。
 *    · **M11 的现值从 3° 降到 1°**（用户连着两轮要"更小"），锚点跟着当前值走。
 *    ⚠️ **M10 / M11 原本就没进过这张表**（表停在 M9，而文件里有 11 条）——
 *      本轮顺手补齐；"期望 N 条"也一并订正为 11。
 *
 * 期望：11 条全部 `BLOCKED`，`INVALID` 为 0。
 *
 * ⚠️ 跑测试一律 `NODE_OPTIONS= node …`（R39），漏带 = 内部基线假红、mutate 会正确地拒绝开跑。
 * ⚠️ 跑之前先提交。
 *    ⚠️ **2026-10-05 订正**：原文写"`panel/next/` 目前**未入库**（`git status` 是 `??`）"
 *       —— 那一句**已过期**，`panel/next/*` 早已入库，本清单可以直接跑。
 */
const TILT = 'panel/next/tilt.js';
const APP = 'panel/next/app.js';
const CSS = 'panel/next/style.css';
const IDX = 'panel/next/index.html';

// ── M1：脚本顺序反过来 ──────────────────────────────────────────────────────
// 症状：tilt.js 读不到 window.Motion，只 console.warn 一句然后整个模块不挂。
const M1 = {
  id: 'M1',
  note: '把 tilt.js 排到 motion.js 之前 —— 静默不挂载（只一句 warn），卡片完全不会倾斜。预期 BLOCKED（§62⑥）',
  anchor: /<script src="\.\/motion\.js"><\/script>/,
  count: 1,
  file: IDX,
  apply: (s) => s
    .replace('\n<script src="./tilt.js"></script>', '')
    .replace('<script src="./motion.js"></script>',
      '<script src="./tilt.js"></script>\n<script src="./motion.js"></script>'),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M2：`data-tilt` 从来没人打上去 ──────────────────────────────────────────
// 症状：引擎在、监听在、样式在 —— 而页面上一个 [data-tilt] 都没有。
const M2 = {
  id: 'M2',
  note: 'markTiltables() 从 onPageShown 里删掉（函数还在文件里，只是没人调用）—— 判"接线"而不是"存在"。预期 BLOCKED（§62⑤）',
  anchor: /  mountRouteSort\(\);\n  markTiltables\(\);\n/,
  count: 1,
  file: APP,
  apply: (s) => s.replace('  mountRouteSort();\n  markTiltables();\n', '  mountRouteSort();\n'),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M3：整页重绘之后不认回来（本轮实测发现的真问题） ────────────────────────
const M3 = {
  id: 'M3',
  note: 'markTiltables() 里不喊 Tilt.resync() —— 整页每 3 秒重建，正在倾斜的卡片换成新节点后状态全丢：症状是"鼠标不动、卡片每 3 秒自己正一下"。预期 BLOCKED（§62⑫）',
  anchor: /if \(window\.Tilt && window\.Tilt\.resync\) window\.Tilt\.resync\(\);/,
  count: 1,
  file: APP,
  apply: (s) => s.replace('  if (window.Tilt && window.Tilt.resync) window.Tilt.resync();', ''),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M4：变量写了但样式不消费 ────────────────────────────────────────────────
// 症状：JS 每帧认真算、四个变量都写进去了，画面一动不动。
const M4 = {
  id: 'M4',
  note: 'CSS 的 transform 里去掉 rotateX(var(--tilt-rx…)) —— 变量算得再对也没有任何画面变化。预期 BLOCKED（§62⑦）',
  anchor: /    rotateX\(var\(--tilt-rx, 0deg\)\)\n/,
  count: 1,
  file: CSS,
  apply: (s) => s.replace('    rotateX(var(--tilt-rx, 0deg))\n', ''),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M5：给 transform 叠上第二套缓动 ─────────────────────────────────────────
const M5 = {
  id: 'M5',
  note: '给 [data-tilt] 的 transform 加 CSS transition —— 弹簧逐帧写变量，再叠过渡等于对每帧重新插值（双份缓动）。预期 BLOCKED（§62⑧ 反向）',
  anchor: /\[data-tilt\] \{\n  position: relative;\n  overflow: hidden;/,
  count: 1,
  file: CSS,
  apply: (s) => s.replace('[data-tilt] {\n  position: relative;\n  overflow: hidden;',
    '[data-tilt] {\n  transition: transform 300ms ease;\n  position: relative;\n  overflow: hidden;'),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M6：减弱动效不再被尊重 ──────────────────────────────────────────────────
// ⚠️ **2026-10-05（第 7 轮）修 `apply`**：这一条原本删除的块里还包含
//    `[data-tilt]::after { opacity: 0; transition: none; }` —— 那是**跟随高光**的
//    减弱动效分支，而高光整套已删（见 M7）⇒ 那段文本不存在 ⇒ 正则命中 0
//    ⇒ `apply` **悄悄变成空操作**（锚点仍然命中，所以静态体检与 `mutate` 的锚点闸门
//    都看不见它；只有"施加后内容未变"这条能抓）。⇒ 现在只删仍然存在的那两行。
//    ⚠️ 这与 M7 是本轮第二种腐烂的样本：**锚点对、apply 空转**。
const M6 = {
  id: 'M6',
  note: '删掉 prefers-reduced-motion 那一块 —— 前庭敏感用户看到的仍是整页卡片在倾斜。预期 BLOCKED（§62⑨）',
  anchor: /@media \(prefers-reduced-motion: reduce\) \{\n  \[data-tilt\] \{ transform: none; \}/,
  count: 1,
  file: CSS,
  apply: (s) => s.replace(/@media \(prefers-reduced-motion: reduce\) \{\n  \[data-tilt\] \{ transform: none; \}\n\}\n/, ''),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M7：把用户否掉的跟随高光**接回来** ──────────────────────────────────────
// ⚠️⚠️ **2026-10-05（第 7 轮 · 重锚）：这一条的形态整个换过了。**
//    旧形态是"删掉**深色那份** `--c-eg-glare`（浅色还在）→ 深色下高光是透明的" ——
//    那个对象**已经不存在**：用户连着两轮明确点名「不喜欢鼠标放上去有灯光」，
//    B31 复验轮把整套高光删干净了（令牌 + `[data-tilt]::after` + `tilt.js` 里的 gx/gy），
//    预期值也随之**反转**：`check-wb` §62⑩ 现在是一条**反向判据**
//    （"整套高光必须不存在"，三样各数一遍）。
//    ⇒ 处置**不是退役**（关切还在，而且方向反了），是**重锚到新的期望**：
//      从"删掉一半"改成"**把已删掉的整套接回来一半**"。
//    ⚠️ 为什么选 `::after` 这一样、而不是令牌或 gx/gy：
//      · 令牌那一样会**连坐** §60 ⑥f 的 G1（`--c-eg-*` 名字集合深浅双向相等）——
//        往 `:root` 单侧加一个令牌会同时让**两条**判据变红，而"改一处红一片"
//        说明这个变异没被收窄到"只打一条"（本项目第 18 条）；
//      · gx/gy 住在 `tilt.js`，与"顺手把 CSS 那段贴回来"这个真实场景隔了一层。
//    取证：本轮把这条变异施加后单独跑了一次 `check-wb`，**只有 §62⑩ 那一条 ✗**。
const M7 = {
  id: 'M7',
  note: '把 `[data-tilt]::after` 高光层贴回来（哪怕只是一条）—— 用户两轮都说「不喜欢鼠标放上去有灯光」，而它删干净之后**没有任何东西拦着别人顺手接回来**。预期 BLOCKED（§62⑩ 反向）',
  anchor: /\[data-tilt\] \{\n  position: relative;/,
  count: 1,
  file: CSS,
  apply: (s) => s.replace(
    '[data-tilt] {\n  position: relative;',
    '[data-tilt]::after {\n  content: ""; position: absolute; inset: 0; pointer-events: none;\n'
      + '  background: radial-gradient(120px circle at 50% 50%, rgba(255,255,255,.20), transparent 70%);\n'
      + '}\n[data-tilt] {\n  position: relative;'),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M8：自己起一条帧循环 ────────────────────────────────────────────────────
const M8 = {
  id: 'M8',
  note: 'tilt.js 里加一条自己的 requestAnimationFrame —— 违反"一个 rAF 驱动全部"（跟手本来就由指针事件按帧驱动）。预期 BLOCKED（§62②）',
  anchor: /  function move\(e\) \{/,
  count: 1,
  file: TILT,
  apply: (s) => s.replace('  function move(e) {',
    '  function tick() { requestAnimationFrame(tick); }\n  function move(e) {\n    tick();'),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M9：把委托改成绑在元素上（打"不需要重绘守卫"这条前提本身） ──────────────
const M9 = {
  id: 'M9',
  note: '三条监听从 document 改绑到元素上 —— 委托一改，"整页重建也不用管"这条前提就没了（而页面在 3 秒内看起来完全正常）。预期 BLOCKED（§62④）',
  anchor: /  document\.addEventListener\('pointerover', onOver, \{ passive: true \}\);\n/,
  count: 1,
  file: TILT,
  apply: (s) => s
    .replace("  document.addEventListener('pointerover', onOver, { passive: true });\n", '')
    .replace("  document.addEventListener('pointermove', onMove, { passive: true });\n", '')
    .replace("  document.addEventListener('pointerout', onOut, { passive: true });\n",
      "  document.querySelectorAll('[data-tilt]').forEach(function (el) {\n"
      + "    el.addEventListener('pointerover', onOver, { passive: true });\n"
      + "    el.addEventListener('pointermove', onMove, { passive: true });\n"
      + "    el.addEventListener('pointerout', onOut, { passive: true });\n"
      + '  });\n'),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M10：把 `preserve-3d` 加回去（用户报过的两条抱怨的根因） ────────────────
const M10 = {
  id: 'M10',
  note: '给 [data-tilt] 加回 transform-style: preserve-3d —— 卡内子元素一起进 3D 空间，症状是"里面的小方块也跟着动"+"旋转时莫名其妙的翻转"（用户实测报过）。预期 BLOCKED（§62⑬ 反向）',
  anchor: /\[data-tilt\] \{\n  position: relative;\n  overflow: hidden;/,
  count: 1,
  file: CSS,
  apply: (s) => s.replace('[data-tilt] {\n  position: relative;\n  overflow: hidden;',
    '[data-tilt] {\n  position: relative;\n  overflow: hidden;\n  transform-style: preserve-3d;'),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M11：把倾角调回"看起来更明显"的大角度 ──────────────────────────────────
// ⚠️ 这一条打的是**用户偏好**：没有它时，下一轮有人觉得"不够明显"就调回去，
//    而"太晃"这个反馈要等用户再提一次才会回来。
// ⚠️ **2026-10-05（第 7 轮）重锚**：上限又降过一次 —— 用户连着两轮要"更小"，
//    现在是 **1°**（`6° → 3° → 1°`）。旧锚点 `MAX_DEG = 3` 命中 0；
//    `§62⑭` 的判据（`> 2` 即红）一个字都没变。⇒ 锚点跟着**当前值**走。
//    ⚠️ 这里刻意**不**把锚点写成"`var MAX_DEG = 数字`"那种宽松形态：
//      判据本身就在读这个数字，锚点必须能证明"它今天真的是 1" ——
//      写成宽松形态的话，将来有人把它调成 12 时这条变异**依然 INVALID 消失**，
//      而不是红。收紧的代价是"调值时要跟着改锚点"，那正是本轮在做的事。
const M11 = {
  id: 'M11',
  note: 'MAX_DEG 1 → 12（"让它更明显"这个直觉）—— 用户明确要的是"小幅度的小倾斜"。预期 BLOCKED（§62⑭）',
  anchor: /var MAX_DEG = 1;/,
  count: 1,
  file: TILT,
  apply: (s) => s.replace('var MAX_DEG = 1;', 'var MAX_DEG = 12;'),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

export default [M1, M2, M3, M4, M5, M6, M7, M8, M9, M10, M11];
