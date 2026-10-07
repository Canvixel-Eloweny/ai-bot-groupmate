/**
 * 开源前审查（2026-10-05）· **S-12 第二批**（现役控制台渲染面）的变异清单 —— 纯数据，
 * 供 `NODE_OPTIONS= node scripts/mutate.mjs test/mutations/sec-s12c-1005.mjs` 复跑。
 *
 * 打的对象：`scripts/check-wb.mjs` §69（本轮新增）——
 * schema 的类型声明（`t: '<类型>'`）↔ `app.js` 的 `RENDER` 表 ↔ `CTRL_KINDS` 清单，
 * **三处必须同一集合**（实测 60 / 60 / 60）。
 *
 *   | 条 | 打的是 | 该由哪一层拦住 | 期望 |
 *   |---|---|---|---|
 *   | M1 | 把 RENDER 里一个**真在用的**渲染器改名（schema 还在用它） | §69 正查 | BLOCKED |
 *   | M2 | 往 RENDER 里塞一个**没人用**的渲染器（死代码 / 类型名写错） | §69 反查 | BLOCKED |
 *   | M3 | 拿掉取用点 `RENDER[…t]`（表有定义但没人按类型取） | §69 "断言接线" | BLOCKED |
 *   | M4 | 只在 **app.js 的注释**里提一个假的渲染器名 | 防线**不该**响 | NOT-BLOCKED |
 *   | M5 | 只在 **schema.js 的注释**里写一行 `t: 'X'` | 防线**不该**响 | NOT-BLOCKED |
 *
 * ⚠️ **M4 / M5 是一对「注释不算声明」的对照组**，两侧取源现在**一致**（都过 `stripComments`）：
 *    · app.js 走 `stripComments` → 注释里的名字不算（M4 期望 NOT-BLOCKED）；
 *    · schema.js 同样走 `stripComments` → 注释里的 `t: 'X'` 也不算（M5 期望 NOT-BLOCKED）。
 *    ⚠️⚠️ **M5 在第 8 轮之前是 `expect: BLOCKED`** —— 那时 schema 侧只能取**原文**：
 *       `stripComments` 不认字符串，schema.js 的 `desc` 里有一条通配路径（`people/` 紧跟
 *       一个星号），那两个字符被当成块注释起点、**吞掉约 5.8 KB 真实声明**（第一版据此
 *       误报两个"死渲染器"）。为了不让判据看不见那 5.8 KB，当时**故意**接受"注释会被当成
 *       声明"这点代价，并用 M5 的 `BLOCKED` 把这条已知代价钉成**可复跑的记录**。
 *       第 8 轮把 `stripComments` 改成**字符串感知**之后，那个取舍消失了 ——
 *       M5 因此从"已知代价"**翻成对照组**（这是本轮唯一一条期望值变更，理由记在这里）。
 *    ⇒ 教训：**"已知代价"要写成一条可复跑的变异**，这样它被消除的那天会**自己现形**，
 *      而不是留一句注释在代码里等着腐烂。
 *
 * 期望：M1–M3 `BLOCKED`，M4 / M5 `NOT-BLOCKED`，`INVALID` 为 0。
 * ⚠️ 跑测试一律 `NODE_OPTIONS= node …`（R39）；跑之前**先提交**；
 *    用全新的 `QQBOT_MUTATE_WORK` 目录（R46.1：复用旧目录会把工作树回滚）。
 */
const APP = 'panel/next/app.js';
const SCH = 'panel/next/schema.js';
const SL = /^ {2}sleepLine: /m; // RENDER 表里一个**真在用的**渲染器（schema 的 t: 'sleepLine'）

// ── M1：真在用的渲染器被改名 ────────────────────────────────────────────────
const M1 = {
  id: 'M1',
  note: 'RENDER 里 `sleepLine:` 改名为 `sleepLineX:` —— schema 仍在声明 `t: \'sleepLine\'`，页面上那一行会变成空白（而构建不报错）。预期 BLOCKED（§69 正查）',
  anchor: SL,
  count: 1,
  file: APP,
  apply: (s) => s.replace(SL, '  sleepLineX: '),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M2：塞一个没人用的渲染器 ────────────────────────────────────────────────
const M2 = {
  id: 'M2',
  note: '往 RENDER 里加一个没人用的 `zzzDead:` —— 要么死代码，要么某处类型名写错了（后者表现为"那块空白"）。预期 BLOCKED（§69 反查）',
  anchor: SL,
  count: 1,
  file: APP,
  apply: (s) => s.replace(SL, "  zzzDead: (x) => '',\n" + '  sleepLine: '),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M3：拿掉取用点（断言存在 ≠ 断言接线）────────────────────────────────────
const M3 = {
  id: 'M3',
  note: '把 `const fn = RENDER[x.t];` 换成常量空渲染器 —— 表还在、三处集合仍相等，但**没有一处按类型取用**，所有控件都渲染不出来。预期 BLOCKED（§69 取用点）',
  anchor: /const fn = RENDER\[x\.t\];/,
  count: 1,
  file: APP,
  apply: (s) => s.replace(/const fn = RENDER\[x\.t\];/, "const fn = () => '';"),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M4：只在 app.js 注释里提一个假渲染器名（误报型）────────────────────────
const M4 = {
  id: 'M4',
  note: '只在 app.js 的注释里写一句「RENDER 里还有个 zzzDead」—— app.js 走剥注释取源，防线**不该**响。预期 NOT-BLOCKED（R44）',
  anchor: SL,
  count: 1,
  file: APP,
  apply: (s) => s.replace(SL, '  // 说明：RENDER 里曾经还有一个 zzzDead 渲染器\n' + '  sleepLine: '),
  layer: 'check-wb',
  expect: 'NOT-BLOCKED',
};

// ── M5：只在 schema.js 注释里写 t:（**对照组** —— 注释不算声明）────────────────
const M5 = {
  id: 'M5',
  note: '只在 schema.js 的注释里写一行 `t: \'ghostType\'` —— schema 侧**同样过 `stripComments`**（第 8 轮起），注释里的类型声明不算数，防线**不该**响。预期 NOT-BLOCKED（R44；本条原来因"schema 取原文"而期望 BLOCKED，第 8 轮翻正）',
  anchor: /export const CTRL_KINDS/,
  count: 1,
  file: SCH,
  apply: (s) => s.replace(/export const CTRL_KINDS/, "// 备注：曾经用过 t: 'ghostType'\nexport const CTRL_KINDS"),
  layer: 'check-wb',
  expect: 'NOT-BLOCKED',
};

export default [M1, M2, M3, M4, M5];
