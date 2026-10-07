/**
 * B32（背景引擎 resize 防抖 + 预设缓存 · 2026-10-04 · `panel/next/shader-bg.js`）的变异清单。
 *
 * 背景层在 B32 之前是 `.aurora` 六团纯 CSS（实测同环境 p50 = 45ms ≈ 22fps，
 * 且它停不下来）。换成 WebGL 颗粒渐变后实测 p50 = 29ms，
 * 而**背景停 + 玻璃开是 16.7ms** ⇒ 剩余成本全部来自"每帧重画"。
 * 本清单守的是 B32 加的两处优化不被下一轮回退。
 *
 * 这一批打的全是「坏了看不出来」：resize 又开始抖、但页面完全正常。
 *
 *   | 条   | 打的是                              | 该由哪一层拦住            | 期望   |
 *   |------|-------------------------------------|---------------------------|--------|
 *   | M1   | resize 防抖整个删掉                  | 背景-防抖契约           | BLOCKED |
 *   | M2   | 防抖延时 160ms → 0（形同没有）      | 背景-防抖契约           | BLOCKED |
 *   | M3   | `setVariant` 忘了同步 `curVariant`  | 背景-防抖契约'          | BLOCKED |
 *   | M4   | 主循环读 `currentId` 现查（去掉缓存）| check-wb（唯一实现口径）   | BLOCKED |
 *   | M5   | `variantId` 探针删掉                | 背景-防抖契约'          | BLOCKED |
 *   | M6   | resize 里**不再**调 `startLoop()`    | check-wb                   | BLOCKED |
 *
 * ⚠️ **M2 是本轮实测踩出来的真问题**：第一版防抖写成 `setTimeout(..., 0)`，
 *    判据量到 47 次（比不防抖的 24 还多）—— 一度以为防抖写错了。
 *    真因是**量错了对象**：主循环每帧都在画，96ms 里正常画了 47 帧，
 *    混在里面根本分不清谁贡献的。⇒ 判据改成先用 `Emulation.setEmulatedMedia`
 *    模拟 reduced-motion 把主循环停掉，再量纯 resize 增量。
 *    **教训**："防抖生效"这类判据必须先隔离出被测的那条路径，
 *    否则测的是"两条路径之和"，而两条都在动。
 *    （probe 里的 `frame` 计数器也一样：它在 2D 与 WebGL 两条路上都会自增。）
 *
 * 期望：6 条全部 `BLOCKED`，`INVALID` 为 0。
 *
 * ⚠️⚠️⚠️ **三层教训，全部来自本轮实测（照抄照跑会重复踩）**：
 *  ① **量错了对象**：第一版防抖写成 `setTimeout(…, 0)`，判据量到 47 次
 *     （比不防抖的 24 还多）—— 一度以为防抖写错了。真因是**主循环每帧都在画**，
 *     96ms 里正常画了 47 帧，混在里面根本分不清谁贡献的。
 *     ⇒ 「防抖生效」这类判据必须先隔离被测路径（用 Emulation.setEmulatedMedia
 *     模拟 reduced-motion 把主循环停掉），否则测的是「两条路径之和」，而两条都在动。
 *  ② **层选错**：第一轮 5 条全 NOT-BLOCKED —— mutate.mjs 的四层**都不跑 v2 的
 *     `panel/next/verify.mjs`**（panel 层跑的是沙箱里的「面板验证」= 旧面板 jsdom），
 *     变异打在了跑不到 shader-bg.js 的层上。⇒ 全改挂 check-wb，并补静态子判据。
 *  ③ **判据不精确**：第二轮 M4 仍 NOT-BLOCKED —— 判据写成「文件里有没有
 *     `variantOf()`」，而它在**两处**被调用（主循环 + renderCurrent）⇒
 *     把主循环换掉而 renderCurrent 还在，判据照样为真。
 *     ⇒ 判据里出现「某标识符存在吗」这类问法时，先确认它**只出现一处**；
 *     出现多处时必须带上下文，否则判据会自证式通过。
 *
 * ⚠️ 跑测试一律 `NODE_OPTIONS= node …`（R39），漏带 = 内部基线假红、mutate 会正确地拒绝开跑。
 * ⚠️ 跑之前先提交；`panel/next/` 目前**未入库**（`git status` 是 `??`），
 *    mutate 的 worktree 里没有这些文件 —— 入库后这份清单可直接跑。
 */
const SBG = 'panel/next/shader-bg.js';
const VFY = 'panel/next/verify.mjs';

// ── M1：resize 防抖整个删掉（回到 B32 之前）────────────────────────────────
const M1 = {
  id: 'M1',
  note: '把 resize 防抖整段换回裸调用 —— 拖窗口时 canvas.width= 每次都重分配显存，顿挫回来。预期 BLOCKED（背景-防抖契约）',
  anchor: /window\.addEventListener\('resize', \(\) => \{/,
  count: 1,
  file: SBG,
  apply: (s) => s.replace(
    /window\.addEventListener\('resize', \(\) => \{[\s\S]*?\}\);\n/,
    "window.addEventListener('resize', () => { renderCurrent(); startLoop(); });\n",
  ),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M2：防抖延时改成 0（形同没有防抖，但代码看着"有防抖"）──────────────────
// ⚠️ 这一条专打"看起来做了、其实没做"的写法：setTimeout(…, 0) 仍在，
//    静态判据（有 clearTimeout + setTimeout）照样绿，只有行为层能红。
const M2 = {
  id: 'M2',
  note: '防抖延时 160ms → 0 —— 保留 clearTimeout/setTimeout 的"防抖形状"但实际不防抖。预期 BLOCKED（背景-防抖契约）',
  /* ⚠️ 锚点**只锚 `}, 160);` 这一段**，不锚整个 setTimeout ——
   *   B34 把回调体改成了多行（中间加了 paintSpeed），单行锚点随之失效（报 INVALID）。 */
  anchor: /\}, 160\);/,
  count: 1,
  file: SBG,
  apply: (s) => s.replace(/\}, 160\);/, '}, 0);'),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M3：setVariant 忘了同步 curVariant（缓存与 currentId 脱钩）───────────────
// ⚠️ 症状极隐蔽：current 字段全对、只有画面还停在旧预设的流动。
const M3 = {
  id: 'M3',
  note: 'setVariant 里删掉 curVariant = v —— 切预设后画面不变（current 字段却已变）。预期 BLOCKED（verify 契约 ②\'\'\'）',
  anchor: /curVariant = v;                          \/\/ ← 与 currentId 同步/,
  count: 1,
  file: SBG,
  apply: (s) => s.replace(/curVariant = v;\s*\/\/.*\n/, ''),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M4：主循环退回每帧现查（把上一轮的优化回退）───────────────────────────
const M4 = {
  id: 'M4',
  note: '主循环改回每帧 VARIANTS.find()（去掉 variantOf 缓存）—— 每帧两次线性查找。预期 BLOCKED（唯一实现口径）',
  /* ⚠️ 锚点只锚**主循环那一处**的 `variantOf()`，不带后面的 `t +=` ——
   *   B33 往那一行后面加了速度档（`t += dt * v.speed * (curSpeed ? ... : 1)`），
   *   原锚点跟着 B33 一起失效了（报 INVALID，0 命中）。
   *   ⇒ 教训：锚点要选**语义上必须存在、且不与别的批次共形**的那一段。
   *   `const v = variantOf();` + 后面接 `t += dt * v.speed` 才是"主循环在用缓存"；
   *   但 `t +=` 那一行被 B33 改过，所以只锚前者 + 用 apply 精确替换两行。 */
  anchor: /const v = variantOf\(\);\n    t \+= dt \* v\.speed/,
  count: 1,
  file: SBG,
  apply: (s) => s.replace(
    /const v = variantOf\(\);\n(    t \+= dt \* v\.speed[^\n]*\n)    drawOnce\(v\);/,
    'const v = VARIANTS.find((x) => x.id === currentId) || VARIANTS[0];\n$1    drawOnce(v);',
  ),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M5：把 variantId 探针删掉（让契约抓不到脱钩）──────────────────────────
const M5 = {
  id: 'M5',
  note: '删掉 ShaderBG.variantId 探针 —— currentId 与 curVariant 是否同步就再也测不出来了。预期 BLOCKED（verify 契约 ②\'\'\'）',
  anchor: /get variantId\(\) \{ return curVariant \? curVariant\.id : null; \},/,
  count: 1,
  file: SBG,
  apply: (s) => s.replace(/\n\s*get variantId\(\)[^\n]*\n/, '\n'),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M6：resize 里不再 startLoop（reduced 下切了动效也不会恢复）──────────────
const M6 = {
  id: 'M6',
  note: 'resize 尾帧不再 startLoop() —— 用户在系统里改完动效偏好、resize 一次就永远不恢复动画。预期 BLOCKED（唯一实现口径）',
  /* ⚠️ 锚点用**跨行**形态（`[\s\S]`）：实际代码是
   *     resizeTimer = setTimeout(() => {
   *       resizeTimer = 0; renderCurrent(); startLoop();
   *       ...
   *     }, 160);
   *   原来锚的是单行版本，B32 之后代码被 B34 改成了多行 ⇒ 锚点失效。
   *   这条只要求"`startLoop();` 还在这一行上"，不锚它后面的内容（B34 会往那儿加东西）。 */
  anchor: /resizeTimer = 0; renderCurrent\(\); startLoop\(\);/,
  count: 1,
  file: SBG,
  apply: (s) => s.replace(
    'resizeTimer = 0; renderCurrent(); startLoop();',
    'resizeTimer = 0; renderCurrent();',
  ),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

export default [M1, M2, M3, M4, M5, M6];
