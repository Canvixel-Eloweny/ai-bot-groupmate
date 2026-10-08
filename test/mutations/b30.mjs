/**
 * B30（模型线路拖拽排序 · 2026-10-03 · `panel/next/sortable.js`）的变异清单。
 *
 * 这一批的**共同点**：每一条改完，**页面全都照常工作**。
 * 把手还在、↑↓ 还在、按钮还能点、控制台一句错都没有 —— 只是拖拽 / 让位 /
 * 键盘重排 / 撤销里的一样或几样静默失效。这正是"最像做完了"的那类缺陷。
 *
 *   | 条   | 打的是 | 该由哪一层拦住 | 期望 |
 *   |---|---|---|---|
 *   | M1  | 入口页**删掉** `sortable.js` 的 `<script>` | check-wb §61⑧ | BLOCKED |
 *   | M2  | `sortable.js` 排到 `motion.js` **之前** | check-wb §61⑧ | BLOCKED |
 *   | M3  | `.srt` 去掉 `position: relative` | check-wb §61⑨ | BLOCKED |
 *   | M4  | `.srt-grip` 去掉 `touch-action: none` | check-wb §61⑩ | BLOCKED |
 *   | M5  | `.srt-live` 加上 `display: none` | check-wb §61⑪（反向） | BLOCKED |
 *   | M6  | `.srt-item` 的 transition 里加 `transform` | check-wb §61⑫（反向） | BLOCKED |
 *   | M7  | `softPaint` 里**删掉** `Sortable.busy()` 守卫 | check-wb §61⑤ | BLOCKED |
 *   | M8  | `mountRouteSort` 里**删掉** `destroy()`（不再幂等） | check-wb §61⑦ | BLOCKED |
 *   | M9  | 多出**第二处** `Sortable.create(` | check-wb §61⑥ | BLOCKED |
 *   | M10 | `routeAction` 去掉 `_rbInst.applyIds(` 分支 | check-wb §61⑭ | BLOCKED |
 *   | M11 | 两档弹簧并成一个（`SETTLE_SPRING = GIVE_SPRING`） | check-wb §61④ | BLOCKED |
 *   | M12 | **`mv.jump(invert)` 改回 `rec.mv.jump(invert)`** ← 本轮真缺陷 | check-wb §61⑯ | BLOCKED |
 *   | M13 | **`on()` 签名改回两参**（事件一条都绑不上）← 本轮真缺陷 | check-wb §61⑰ | BLOCKED |
 *   | M14 | **`play()` 去掉 `anims` 自摘**（`busy()` 恒 true）← 本轮真缺陷 | check-wb §61⑱ | BLOCKED |
 *
 * ⚠️ **M12 / M13 / M14 的"真证据"在 `panel/next/verify.mjs`**（合成 PointerEvent /
 *    `window.addEventListener('error')`），而 **verify 不在变异的四层清单里**
 *    （只有 check-wb / smoke / sandbox / panel）——`mutate.mjs` 会判「未指定层」。
 *    所以这三条各配了一条**静态判据**（§61⑯⑰⑱）专门钉它们的"形状"，
 *    让缺陷在四层里也拦得住。**行为与形状两层都要有判据**，这是本轮最大的教训。
 *
 * 期望：14 条全部 `BLOCKED`，`INVALID` 为 0。
 *
 * ⚠️ **2026-10-05（第 7 轮 · 变异锚点修复）**：M4 / M6 / M12 三条的锚点**既不缺牙、
 *    也不是对象被删** —— 它们打的是"锚点写松了"那一类（命中 0/1 与 3/1、2/1）。
 *    ⇒ 处置是**收紧**（改钉语义边界），不是退役：M4 那行被并过行、M6 那句话在表里有三处
 *      同形、M12 那个赋值有两处。三处的详细理由写在各自条目上方。
 *    ⚠️ 同批把 `apply` 一起收窄（M6）：`String.replace` 只换第一处，
 *      而第一处是**另一个规则**（`.iconbtn`）—— 不改就等于"变异没打中"，
 *      而它看起来与"防线没牙"一模一样。
 *
 * ⚠️ 跑测试一律 `NODE_OPTIONS= node …`（R39），漏带 = 内部基线假红、mutate 会正确地拒绝开跑。
 * ⚠️ 跑之前先提交。
 *    ⚠️ **2026-10-05 订正**：原文写"`panel/next/` 目前**未入库**，所以 mutate 的 worktree
 *       里没有这些文件，本轮改用等价手工复演" —— 那一句**已过期**：`panel/next/*` 早已入库
 *       （见 `git ls-files panel/next`），本清单**可以直接跑**。第 7 轮已按"直接跑"复跑。
 */
const SRT = 'panel/next/sortable.js';
const APP = 'panel/next/app.js';
const CSS = 'panel/next/style.css';
const IDX = 'panel/next/index.html';

// ── M1：入口页删掉排序引擎的 script 标签 ────────────────────────────────────
// 症状：`window.Sortable` 不存在 ⇒ `mountRouteSort` 第一句就 return。
// 页面照常工作、↑↓ 照常能改顺序，只是**没有拖拽、没有让位、没有键盘重排**。
const M1 = {
  id: 'M1',
  note: '入口页删掉 `<script src="./sortable.js">` —— 引擎整块不加载。预期 BLOCKED（§61⑧）',
  anchor: /<script src="\.\/sortable\.js"><\/script>\n/,
  count: 1,
  file: IDX,
  apply: (s) => s.replace('\n<script src="./sortable.js"></script>', ''),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M2：脚本顺序反过来 ──────────────────────────────────────────────────────
// 症状：`sortable.js` 启动时读不到 `window.Motion`，只 `console.warn` 一句然后**整个不挂载**。
const M2 = {
  id: 'M2',
  note: '把 sortable.js 排到 motion.js 之前 —— 反了就是静默不挂载（只一句 warn）。预期 BLOCKED（§61⑧）',
  anchor: /<script src="\.\/motion\.js"><\/script>/,
  count: 1,
  file: IDX,
  apply: (s) => s
    .replace('\n<script src="./sortable.js"></script>', '')
    .replace('<script src="./motion.js"></script>',
      '<script src="./sortable.js"></script>\n<script src="./motion.js"></script>'),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M3：容器不再是定位元素 ──────────────────────────────────────────────────
// 症状：`offsetTop` 的参照物往上冒，让位补偿差一个容器高 —— "松手时全体往下弹一截"。
const M3 = {
  id: 'M3',
  note: '`.srt` 的 position:relative 改成 static —— offsetTop 参照物变了，整列补偿差一个容器高。预期 BLOCKED（§61⑨）',
  anchor: /\.srt \{ position: relative; \}/,
  count: 1,
  file: CSS,
  apply: (s) => s.replace('.srt { position: relative; }', '.srt { position: static; }'),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M4：触摸拖动会被当成滚页 ────────────────────────────────────────────────
// ⚠️ **2026-10-05（第 7 轮）重锚**：`.srt-grip` 那行从"`touch-action: none;` 独占一行"
//    变成了"`cursor: grab; touch-action: none;   /* … */`"（2026-10-04 顺手把两行并了）。
//    旧锚点连**注释原文**一起钉着，一并就命中 0 —— 而 `§61⑩` 的判据住在
//    `cssRule('.srt-grip')` 里、**一个字都没变**。⇒ 这是"锚点不跟着实现走"，
//    不是"判据没牙"。改钉**语义边界**（`cursor: grab;` 紧跟 `touch-action: none;`），
//    不钉注释、不钉行尾（纪律：锚点钉语义边界，别钉行尾 —— 本技能 §6 第 70 条）。
const M4 = {
  id: 'M4',
  note: '`.srt-grip` 去掉 touch-action:none —— 触摸设备上按住拖会被浏览器当成滚页。预期 BLOCKED（§61⑩）',
  anchor: /cursor: grab; touch-action: none;/,
  count: 1,
  file: CSS,
  apply: (s) => s.replace('cursor: grab; touch-action: none;', 'cursor: grab;'),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M5：播报区对读屏隐身 ────────────────────────────────────────────────────
// 反向判据。屏幕上完全看不出区别，只是读屏用户再也听不到"现在是第几位"。
const M5 = {
  id: 'M5',
  note: '`.srt-live` 加 display:none —— 部分读屏会直接跳过它，"有播报"变成假绿。预期 BLOCKED（§61⑪ 反向）',
  anchor: /\.srt-live \{\n  position: absolute;/,
  count: 1,
  file: CSS,
  apply: (s) => s.replace('.srt-live {\n  position: absolute;', '.srt-live {\n  display: none;\n  position: absolute;'),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M6：让位动画被 CSS 过渡旁路 ─────────────────────────────────────────────
// ⚠️ **2026-10-05（第 7 轮）收紧**：`transition: background …` 这句话在现役样式表里
//    有**三处**（`.iconbtn` / `.srt-item` / `.row`，都是同一句"换底色+换描边"）——
//    旧锚点只写这一句，于是命中 3/1、`mutate` 报 INVALID。**判据不缺牙**（§61⑫ 走
//    `cssRule('.srt-item')` 取那一条规则的体），缺的是"锚点只指向 `.srt-item` 那一条"。
//    ⇒ 收紧成"从 `.srt-item {` 起、到它自己那句 transition 为止"（惰性匹配，恰好 1 处）。
//    同理 `apply` 也必须跟着收窄：`String.replace` 只换**第一处**，
//    而第一处是 `.iconbtn`（行号更靠前）—— 那等于改了一个**与判据无关**的规则，
//    判据不会响，看着就像"防线没牙"（这正是第 41/46 条那类"变异没打中"）。
const M6 = {
  id: 'M6',
  note: '`.srt-item` 的 transition 里加 transform —— 引擎逐帧写 transform，再叠过渡等于对每帧重新插值，弹簧被旁路。预期 BLOCKED（§61⑫ 反向）',
  anchor: /\.srt-item \{[\s\S]*?transition: background var\(--dur\) var\(--ease\), border-color var\(--dur\) var\(--ease\);/,
  count: 1,
  file: CSS,
  apply: (s) => s.replace(
    /(\.srt-item \{[\s\S]*?)transition: background var\(--dur\) var\(--ease\), border-color var\(--dur\) var\(--ease\);/,
    '$1transition: background var(--dur) var(--ease), transform var(--dur) var(--ease);'),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M7：轮询重绘不再让路 ────────────────────────────────────────────────────
// 症状：每 3 秒的 innerHTML 重建把**正在拖的那一行**换掉 —— 拖拽"莫名其妙就断了"。
const M7 = {
  id: 'M7',
  note: 'softPaint 里删掉 Sortable.busy() 守卫 —— 每 3 秒的轮询会把正在拖的节点换掉。预期 BLOCKED（§61⑤）',
  anchor: /if \(SORTABLE_ON && window\.Sortable && window\.Sortable\.busy\(\)\) return;/,
  count: 1,
  file: APP,
  apply: (s) => s.replace('if (SORTABLE_ON && window.Sortable && window.Sortable.busy()) return;', ''),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M8：重挂不再回收（rAF 泄漏） ────────────────────────────────────────────
const M8 = {
  id: 'M8',
  note: 'mountRouteSort 里删掉 destroy() —— 整页每 3 秒重建一次，不回收就是每轮多一份监听 + 一条不收敛的动画。预期 BLOCKED（§61⑦）',
  anchor: /_rbInst\.destroy\(\);/,
  count: 1,
  file: APP,
  apply: (s) => s.replace('_rbInst.destroy();', 'void 0;'),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M9：第二处挂载点 ────────────────────────────────────────────────────────
// ⚠️ 用 `if (0)` 包一句死代码 —— 直接复制一份 create 会破坏页面，而本判据判的是
//    "唯一接线点"，死代码同样违反"两个实例对着同一份 DOM 各自算位置"这条纪律。
const M9 = {
  id: 'M9',
  note: '在 mountRouteSort 里加第二处 Sortable.create(（死代码也算）—— "唯一接线点"纪律。预期 BLOCKED（§61⑥）',
  anchor: /function mountRouteSort\(\) \{/,
  count: 1,
  file: APP,
  apply: (s) => s.replace('function mountRouteSort() {',
    'function mountRouteSort() {\n  if (0) window.Sortable.create({});'),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M10：↑↓ 退回直写配置（没有让位、撤销点失效） ────────────────────────────
// ⚠️⚠️ **2026-10-05（第 7 轮）：这一条当场打出了一个真缺口 —— 判据被收紧了，变异一个字没改。**
//    第一次真跑时它是 **NOT-BLOCKED**（13/14）。查明原因：`§61⑭` 当时的判据是
//    `!/_rbInst/.test(routeAct) || !/applyIds\(/.test(routeAct)` —— 即"**能匹配到一处就绿**"，
//    而 `routeAction` 里有**两处** `_rbInst.applyIds(`（↑↓ 一处 + 撤销一处）。
//    只摘掉 ↑↓ 那一处，撤销那处还在 ⇒ 判据照旧通过。
//    这正是本项目第 55 条记过的「**多调用点只看"有一处合规"**」那一类假绿
//    （同族：第 29 条"某常量必须被消费"要先剥 import；第 32 条"断言存在 ≠ 断言接线"）。
//    ⇒ 修的是**判据**：`§61⑭` 改成"两处都要在"（`applyIds(` ≥2），并注明取证。
//      **没有去把变异改宽**（改宽只是把这个缺口藏起来）。
//    ⇒ 复跑：M10 由 NOT-BLOCKED → **BLOCKED**，且只打 1 行 ✗（外科手术式）。
//    ★ 这就是"**变异也是验收契约本身**"的活样本 —— 一条变异的价值不只是"证明判据有牙"，
//      它还可能**发现判据根本没牙**。
const M10 = {
  id: 'M10',
  note: 'routeAction 里去掉 ↑↓ 那处 _rbInst.applyIds( —— ↑↓ 退回"直写配置"：顺序确实变了，但没有让位动画、撤销点也点不回去。预期 BLOCKED（§61⑭，**该判据本轮由本变异查出缺口并收紧**）',
  anchor: /_rbInst\.applyIds\(next, \{ via: 'button', movedId: list\[i\] \}\);/,
  count: 1,
  file: APP,
  apply: (s) => s.replace("_rbInst.applyIds(next, { via: 'button', movedId: list[i] });", 'void 0;'),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M11：两档弹簧并成一个 ───────────────────────────────────────────────────
// 症状：拖动中的"被推一下"与落定后的收尾共用一条曲线，手感糊在一起（看得见，但说不清）。
const M11 = {
  id: 'M11',
  note: 'SETTLE_SPRING 改成引用 GIVE_SPRING —— 两档并成一个值，让位与落位手感糊在一起。预期 BLOCKED（§61④）',
  anchor: /var SETTLE_SPRING = \{ stiffness: 900, damping: 50, mass: 1 \};/,
  count: 1,
  file: SRT,
  apply: (s) => s.replace(
    'var SETTLE_SPRING = { stiffness: 900, damping: 50, mass: 1 };',
    'var SETTLE_SPRING = GIVE_SPRING;'),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M12：本轮真缺陷之一 —— `mvOf()` 的返回值被当"记录"用 ────────────────────
// 症状：`rec.mv` 恒为 undefined ⇒ 第一次遇到"位移超过 0.5px 的项"就抛 TypeError；
//      而 `appendChild`（改 DOM）在抛点**之前** ⇒ 顺序照常改好、页面照常工作，
//      唯一症状是"让位动画从来没发生"，异常还被 dispatchEvent 吞掉。
// ⚠️ **2026-10-05（第 7 轮）收紧**：`var mv = mvOf(el);` 在 `sortable.js` 里有**两处**
//    （giveWay 里那次 + 起拖时那次，见 `stopAnim(el);` 之后），旧锚点命中 2/1 → INVALID。
//    真正要打的是 giveWay 里那一处（**只有它紧跟着 `mv.jump(`**）——
//    所以锚点收窄成"`var mv = mvOf(el);` 紧跟 `if (Math.abs(invert) < 0.5)`"这一段。
//    ⚠️ `apply` 不必改：`String.replace` 只换第一处，而 giveWay 那处在文件里更靠前
//      （244 行 vs 327 行）—— 已实测确认（见提交信息）。
const M12 = {
  id: 'M12',
  note: '把 mv.jump(invert) 改回 rec.mv.jump(invert)（本轮真缺陷：mvOf 返回的是运动值不是记录）—— 让位永远不会发生。预期 BLOCKED（§61⑯）',
  anchor: /\n        var mv = mvOf\(el\);\n        if \(Math\.abs\(invert\) < 0\.5\)/,
  count: 1,
  file: SRT,
  apply: (s) => s
    .replace('var mv = mvOf(el);', 'var rec = mvOf(el);')
    .replace('        mv.jump(invert);', '        rec.mv.jump(invert);'),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M13：本轮真缺陷之二 —— 事件注册的参数顺序 ───────────────────────────────
// 症状：`addEventListener('pointerdown', {passive:false})` —— 第二个参数是对象不是函数
//      ⇒ 浏览器**静默忽略**。挂载数=1、把手=7、按钮全正常，而拖拽与键盘一条都不工作。
const M13 = {
  id: 'M13',
  note: 'on() 改回两参写法（本轮真缺陷：addEventListener 的 listener 位置收到 options 对象，整条注册被静默忽略）—— 拖拽与键盘全废。预期 BLOCKED（§61⑰）',
  anchor: /function on\(t, type, fn\) \{ t\.addEventListener\(type, fn, \{ passive: false \}\); \}/,
  count: 1,
  file: SRT,
  apply: (s) => s.replace(
    'function on(t, type, fn) { t.addEventListener(type, fn, { passive: false }); }',
    'function on(t, type, fn) { t.addEventListener(fn, { passive: false }); }'),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M14：本轮真缺陷之三 —— 动画句柄只增不减 ─────────────────────────────────
// 症状：`api.anims` 留着已收敛的句柄 ⇒ `busy()` 恒 true ⇒ `softPaint` 的守卫
//      把**每 3 秒的轮询重绘永久挡掉**（页面看起来卡在旧数据上）。
const M14 = {
  id: 'M14',
  note: 'play() 里删掉 whenDone 自摘（本轮真缺陷：api.anims 只增不减 → busy() 恒 true → 轮询重绘被永久挡掉）。预期 BLOCKED（§61⑱）',
  anchor: /whenDone\(h, function \(\) \{ if \(api\.anims\.get\(el\) === h\) api\.anims\.delete\(el\); \}\);/,
  count: 1,
  file: SRT,
  apply: (s) => s.replace(
    'whenDone(h, function () { if (api.anims.get(el) === h) api.anims.delete(el); });', ''),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

export default [M1, M2, M3, M4, M5, M6, M7, M8, M9, M10, M11, M12, M13, M14];
