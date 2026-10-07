/**
 * B25（把 B22/B23/B24 的配色方案**接入 v2 控制台** · 2026-10-03）的变异清单
 * —— 纯数据，供 `NODE_OPTIONS= node scripts/mutate.mjs test/mutations/b25.mjs` 复跑。
 *
 * ⚠️⚠️ **2026-10-05（第 7 轮 · 变异锚点修复）：这份清单从 16 条收到 1 条。**
 *
 *   · **退役 15 条**（原 M1–M9 / M11–M16）：它们 100% 打**六团流体**
 *     （`.aurora-a…f` 六个 div · 六条 `@keyframes` · 七个 `--c-aurora-*` 令牌 ·
 *     `.aurora-grid` 方格网）。那整套对象已按用户要求**整体移除**
 *     （2026-10-04：`.aurora` 六团 → WebGL canvas 颗粒渐变，`panel/next/shader-bg.js`）。
 *     ⇒ 这正是纪律里写明的那个唯一例外：**「删掉了被断言的对象」**
 *       （与 B28 分批删/恢复流体、S-12 退役 `b22`/`d22` 同规）。
 *     ⚠️ **退役判据只有一条**：它的目标对象**已经不存在**。
 *       「没拦住」而退役是绝对不允许的（那等于把洞藏起来）—— 这 15 条**不是**那种。
 *     ⚠️ 取证：第 7 轮的静态锚点体检（`scripts/mutate-lint.mjs`）实测这 15 条
 *       锚点命中 **0**（`panel/next/style.css` 与 `index.html` 里 `aurora` 只剩注释）。
 *     ⚠️ **关切去哪了**（不是丢覆盖）：
 *        · 引擎四要件（预设闭集合 / localStorage / reduced-motion / WebGL+2D 兜底 /
 *          document.hidden 停 rAF）→ **`b32.mjs`**（6 条，打在 `shader-bg.js` 上）；静态侧由
 *          `check-wb` §60 的「背景引擎必须完整」那一组判据守。
 *        · 玻璃背板仍在 -1 层 → **本文件的 M10**（唯一存活的那条）。
 *        · 吸顶三层玻璃 / 灵动岛 / 下划线 → **`b29.mjs`**（14 条）。
 *     ⚠️ **如实登记仍未被变异覆盖的两条**（本轮量出，未擅自补）：§60 的
 *       「底色是青调」与「无流体残留」。它们**有静态判据**（§60 ① 与 `--c-aurora-*`
 *       零残留的自证），但**没有一条变异证明那道静态判据有牙** ——
 *       这与本项目「变异既验收代码，也验收契约本身」是同一件事。
 *       补法：往 `style.css` 塞回一条 `.aurora { … }` / 把 `--c-bg` 改成灰
 *       （后者应当被 §60 ① 拦下），跑一遍确认 `BLOCKED` 之后再入清单。
 *       本条登记在 `test/mutations/README.md` 与第 7 轮报告里。
 *
 *   · **保留 M10**：它打的是 `body.eg-on::before`（玻璃**背板**），
 *     那个对象**还在**（`check-wb` §60 ② 的 `zIndexOf('body.eg-on::before')`
 *     与 ④ 的 `envRule2` 都在判它）。第 7 轮的体检证实它的锚点命中 1/1 ——
 *     所以**不能整份退役**（接手件当时的建议是"整份退役"，那会连 M10 一起丢掉）。
 *
 * 期望：1 条 `BLOCKED`，`INVALID` 为 0。
 * ⚠️ 跑测试一律 `NODE_OPTIONS= node …`（R39），漏带 = 内部基线假红、mutate 会正确地拒绝开跑。
 * ⚠️ 跑之前**先提交**（R46.1：mutate 只支持单文件变异）。
 */
const CSS = 'panel/next/style.css';

// ── M10：玻璃环境层被删 → 玻璃退回"一块平灰" ───────────────────────────────
const M10 = {
  id: 'M10',
  note: '删掉 body.eg-on::before 整条规则 —— 玻璃本体（三档 backdrop-filter）还在，但它背后什么都没有了，表现为"玻璃看着和没开一样"（真折射与 backdrop-filter 背后是平灰时读不出效果），而 glass.js 一行没改、不报错。预期 BLOCKED（§60② 层序 -1 + §60④ 背板仍在，两处都会响）',
  anchor: /body\.eg-on::before \{/,
  count: 1,
  file: CSS,
  apply: (s) => s.replace(/body\.eg-on::before \{[^}]*\}\n/, ''),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

export default [M10];
