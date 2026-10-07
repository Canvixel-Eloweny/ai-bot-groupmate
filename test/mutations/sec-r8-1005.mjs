/**
 * 第 8 轮（2026-10-05 · 开源前审查）的变异清单 —— 纯数据，供
 * `NODE_OPTIONS= node scripts/mutate.mjs test/mutations/sec-r8-1005.mjs` 复跑。
 *
 * 本轮只有一件事：**把 `stripComments` 改成字符串感知**（并补三个守卫），
 * 然后撤掉它逼出来的四处"取原文"绕行。打的对象是**剥注释器自己**，
 * 而验收它的是本轮新加的 smoke 真值表 **T374 / T375 / T376**。
 *
 *   | 条 | 打的是什么 | 该由谁拦 | 期望 |
 *   |---|---|---|---|
 *   | N1 | **整块撤掉字符串感知**（改回旧的纯正则实现） | smoke T374 / T376 | BLOCKED |
 *   | N2 | **撤掉块注释的收口守卫**（找不到收口就一路吃到文件尾） | smoke T374⑨ / T376 | BLOCKED |
 *   | N3 | **行尾注释重新"当代码解释"**（反引号又能开模板） | smoke T375 | BLOCKED |
 *   | N4 | **撤掉未闭合引号的行内回退**（回到"到行尾就作废"） | smoke T375 | BLOCKED |
 *   | N5 | **对照组**：只在剥注释器里加一行注释（代码未动） | ——（防线**不该**响） | NOT-BLOCKED |
 *
 * ⚠️ 为什么这四条都要有（§4.1「没有护栏的修复不计入完成」）：
 *   这四条各自对应一个**真实踩过的形态**，不是假想的：
 *   · N1 = 本轮修的原始缺陷（schema.js 被吞 5865 字符 / check-wb 自己 179 888 字符）；
 *   · N2 = 一维状态机的典型失败（旧正则天然有这道守卫，重写时最容易丢）；
 *   · N3 = `check-wb.mjs` 第 1169 行行尾注释里的反引号（一路错到 §56、剥后无法解析）；
 *   · N4 = `check-wb.mjs` 第 8777 行正则字面量里的引号（`/^'/` 让奇偶反了）。
 *   四条全绿 = 那三个守卫**真的在挡**；只要有一条 NOT-BLOCKED，就说明对应的守卫
 *   可以被人悄悄删掉而四层全绿 —— 那正是本轮要消灭的状态。
 *
 * ⚠️ 四条都用 `layer: 'smoke'`：判据是**行为层**的真值表，不是静态契约。
 *   （本轮没有往 `check-wb` 里加契约：全仓性质的东西放进 check-wb 会被
 *   `mutate.mjs` 在变异后的工作树上重读 —— 第 7 轮已经用两条量数推翻过这个设计。）
 *
 * ⚠️ **N1 会连带打红一片**（T76 的取源也走 `stripComments`）：这是预期的 ——
 *   它打的是"整块语义退回去"，不是"某一条判据没接线"。判"只有你新加的那条会挂"
 *   在 N1 上不适用；N2/N3/N4 才是外科手术式的（各只打中新加的那一条）。
 *
 * 期望：N1–N4 `BLOCKED`、N5 `NOT-BLOCKED`，`INVALID` 为 0。
 * ⚠️ 跑测试一律 `NODE_OPTIONS= node …`（R39）；跑之前**先提交**；
 *    用全新的 `QQBOT_MUTATE_WORK` 目录（R46.1：复用旧目录会把工作树回滚）。
 * ⚠️ 这一批很慢：smoke 每条约 2–3 分钟，5 条 ≈ 12–15 分钟。**串行**（mutate 就地变异）。
 */

const SCAN = 'scripts/lib/scan-utils.mjs';

// ── N1：整块撤掉字符串感知（改回旧的纯正则实现）──────────────────────────────
const N1 = {
  id: 'N1',
  note: '把 `stripComments` 的分派改成**一律走旧的纯正则实现**（`stripJsComments` 从此没人调）'
    + '—— 这正是本轮开工时的状态：schema.js 的 desc 里那条通配路径会吞掉 5865 字符、'
    + 'check-wb 自己会出现 11 万字符的假块注释跨度。'
    + '预期 BLOCKED（smoke T374 真值表 / T376 全仓"剥后仍可解析"）',
  file: SCAN,
  // ⚠️ 锚在**分派那两行**（改的是第二行），不是被改的那一行本身 —— 便于读输出。
  anchor: /^  if \(kind !== 'js'\) return stripCommentsByRegex\(src, kind\);$/m,
  count: 1,
  apply: (s) => s.replace('  return stripJsComments(src);', '  return stripCommentsByRegex(src, kind);'),
  layer: 'smoke',
  expect: 'BLOCKED',
};

// ── N2：撤掉块注释的收口守卫 ──────────────────────────────────────────────────
const N2 = {
  id: 'N2',
  note: '把"找不到收口就不剥"改成"直接跳到文件尾"（一维状态机的典型写法）——'
    + '于是源码里任何一处没有配对的"斜杠+星号"都会把**后面整份文件**吞掉。'
    + '预期 BLOCKED（smoke T374⑨ 未收口不剥 / T376 剥后仍可解析）',
  file: SCAN,
  anchor: /if \(e < 0\) \{ out \+= c; i \+= 1; continue; \}/,
  count: 1,
  apply: (s) => s.replace(/if \(e < 0\) \{ out \+= c; i \+= 1; continue; \}/, 'if (e < 0) { i = n; continue; }'),
  layer: 'smoke',
  expect: 'BLOCKED',
};

// ── N3：行尾注释重新"当代码解释"（反引号又能开模板）──────────────────────────
const N3 = {
  id: 'N3',
  note: '行尾 `//` 之后的文字不再当死文本，而是逐字符按代码解释（回到"只删整行注释"那一版）——'
    + '于是注释里一个反引号就能开出一个模板字面量、把后面几十行当成模板正文'
    + '（实测 check-wb.mjs 第 1169 行就是这个形状）。'
    + '预期 BLOCKED（smoke T375 模式栈不许跑偏）',
  file: SCAN,
  anchor: /^      out \+= src\.slice\(i, end\); i = end; continue;$/m,
  count: 1,
  apply: (s) => s.replace('      out += src.slice(i, end); i = end; continue;', '      out += c; i += 1; continue;'),
  layer: 'smoke',
  expect: 'BLOCKED',
};

// ── N4：撤掉未闭合引号的行内回退 ──────────────────────────────────────────────
const N4 = {
  id: 'N4',
  note: '未闭合的单/双引号串改回"到行尾就作废"（不回退、不把开点当普通文本）——'
    + '于是正则字面量里的那个引号（`/^\'/`）造成的模式栈错位会**累积**：'
    + '整行 `//` 注释从此不再被删，模板 / 代码被当成模板正文吞掉。'
    + '预期 BLOCKED（smoke T375）',
  file: SCAN,
  anchor: /^        const o = opens\[top\];$/m,
  count: 1,
  apply: (s) => s.replace(
    [
      '        const o = opens[top];',
      '        out = out.slice(0, o.outLen) + o.ch;',
      '        i = o.idx + 1;',
      '        modes.pop(); depths.pop(); opens.pop();',
      '        continue;',
    ].join('\n'),
    '        modes.pop(); depths.pop(); opens.pop(); out += c; i += 1; continue;',
  ),
  layer: 'smoke',
  expect: 'BLOCKED',
};

// ── N5：对照组 —— 只加一行注释，防线**不该**响 ────────────────────────────────
const N5 = {
  id: 'N5',
  note: '只往剥注释器的 `const modes = [\'code\'];` 上方加一行注释（代码未动）——'
    + '任何断言都不读注释（而剥注释器读的是**别人的**注释，不是自己的）。'
    + '预期 NOT-BLOCKED（对照组：没有它，"N1–N4 被拦住"也可能是"smoke 恒红"）',
  file: SCAN,
  anchor: /^  const modes = \['code'\];$/m,
  count: 1,
  apply: (s) => s.replace(
    "  const modes = ['code'];",
    "  // N5 注入：这一行只是个注释，什么都不改\n  const modes = ['code'];",
  ),
  layer: 'smoke',
  expect: 'NOT-BLOCKED',
};

export default [N1, N2, N3, N4, N5];
