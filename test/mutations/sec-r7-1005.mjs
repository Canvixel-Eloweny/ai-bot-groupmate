/**
 * 第 7 轮（2026-10-05 · **变异锚点修复**）的变异清单 —— 纯数据，供
 * `NODE_OPTIONS= node scripts/mutate.mjs test/mutations/sec-r7-1005.mjs` 复跑。
 *
 * 这一批只有一件事：**验收新加的 §70「变异清单体检」那条契约本身**。
 * 本项目纪律（§4.0.2 第 4 条）：**本批每条新契约各配一组"只打它那一条"的变异** ——
 * 变异不只是验收代码，**也是验收契约**。新契约没有变异的话，分不清它是真有牙
 * 还是恰好绿着（本项目已经栽过好几次：Q88 的 `minLen` 是死参数、
 * §50㉔ 第一版只判"键在不在"……）。
 *
 *   | 条 | 打的是什么 | 该由谁拦 | 期望 |
 *   |---|---|---|---|
 *   | L1 | **量尺自身退化**：让 `hitsOf` 恒返回 1（投毒锚点再也报不出来） | check-wb §70 ① | BLOCKED |
 *   | L2 | **接线被拆**：把提交门里那次 `scripts/mutate-lint.mjs` 调用换掉 | check-wb §70 ② | BLOCKED |
 *   | L3 | **对照组**：只往量尺里加一行注释（什么都不改） | ——（防线**不该**响） | NOT-BLOCKED |
 *
 * ⚠️⚠️ **本文件的第一版不是这样写的 —— 它被量数推翻了两次，值得记下来**：
 *   初版 L1 打的是「把 `panel/next/tilt.js` 的 `var MAX_DEG = 1;` 改成 `1.0`，
 *   于是 `b31 M11` 的锚点失效」—— 那才是本轮真正的缺陷形状。
 *   但 §70 第一版是**在 check-wb 里扫全仓**的，于是：
 *     · 先发现**自报**：L1 改完 tilt.js 之后，§70 重扫时**把 L1 自己也报成"惰性"**
 *       （它的 `apply` 再也找不到那一句）—— 输出 2 条 ✗，分不清打中了谁；
 *     · 再一量全仓（把每条变异施加一遍再重扫）：**512 条里 393 条会触发 §70**，
 *       其中 **28 条 `expect: 'NOT-BLOCKED'`** 的条目会被误翻成 BLOCKED
 *       —— 那些正是「误红对照组」，一转就失去了全部意义。
 *   ⇒ 根因是结构性的：**「锚点是否自洽」是整棵树的性质**，而 check-wb 是被
 *     `mutate.mjs` 在**变异后的工作树**上调的。所以全仓扫描**移出了 check-wb**
 *     （去提交门 + 收尾门），§70 改成钉**能在这里钉住**的两件事。
 *   ⇒ 本文件的 L1/L2 因此改成打那两件事（**量尺自证** 与 **提交门接线**）——
 *     它们都只吃"文件内容"，不吃工作树的整体自洽性，所以**既没有噪音、也钉得住**。
 *   （详见 `check-wb` §70 的注释：那里写着为什么不在这里扫全仓。）
 *
 * ⚠️ **L1/L2 的锚点都刻意选在"不是被改的那一行"上**：否则 §70 会**同时**报两条
 *    （被打中的那条 + 变异自己 —— 因为 §70 是在**变异后的工作树**上重读一遍的），
 *    输出变成 2 条 ✗，读起来分不清"我到底打中了谁"。
 *    而"只有你新加的那条断言会挂"正是变异有没有被收窄的唯一判据。
 *
 * ⚠️ **L3 是对照组**：没有它，"L1/L2 被拦住"这件事也可能是"§70 恒红"的结果。
 *    加一行注释 = 任何断言都不读注释 ⇒ 必须 NOT-BLOCKED。
 *
 * 期望：3 条全部符合（L1/L2 `BLOCKED`、L3 `NOT-BLOCKED`），`INVALID` 为 0。
 * ⚠️ 跑测试一律 `NODE_OPTIONS= node …`（R39），漏带 = 内部基线假红、mutate 会正确地拒绝开跑。
 */

const LINT = 'scripts/mutate-lint.mjs';
const HOOK = 'scripts/pre-commit.sh';

// ── L1：量尺自己退化 —— 投毒锚点再也报不出来（自证就成了摆设） ────────────────
const L1 = {
  id: 'L1',
  note: '把 `hitsOf` 的返回值改成恒 1 —— 于是**任何**锚点都"命中恰当"：'
    + '投毒样本再也报不出来，`lintAnchors` 恒返回"0 条失效"。'
    + '预期 BLOCKED（§70① 报"量尺自身没通过自证"）',
  file: LINT,
  // ⚠️ 锚在**函数头**而不是被改的那一行（理由见文件头）。
  anchor: /^function hitsOf\(src, anchor\) \{$/m,
  count: 1,
  apply: (s) => s.replace(
    '  return (src.match(new RegExp(re.source, re.flags.includes(\'g\') ? re.flags : `${re.flags}g`)) || []).length;',
    '  return 1;',
  ),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── L2：接线被拆 —— 提交门里那次调用被换掉（体检从此没有常驻执行点） ──────────
const L2 = {
  id: 'L2',
  note: '把提交门里那次锚点体检调用换成 `"$NODE" --version`（脚本照常跑、不报错，'
    + '只是体检**再也不会执行**）—— 这正是"接线被摘掉"的真实形态：'
    + '文件还在、字面量还在（在别处），而那个动作没了。'
    + '预期 BLOCKED（§70② 报"pre-commit.sh 里没有真的调用"）',
  file: HOOK,
  // ⚠️ 锚在**另一行**（`NODE=` 那行），改的是调用那行。
  anchor: /^NODE="\$\{NODE:-node\}"$/m,
  count: 1,
  apply: (s) => s.replace(
    '"$NODE" scripts/mutate-lint.mjs',
    '"$NODE" --version',
  ),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── L3：对照组 —— 只加一行注释，防线**不该**响 ──────────────────────────────
const L3 = {
  id: 'L3',
  note: '只往量尺的 `const REPO = …` 上方加一行注释（代码未动）—— 任何断言都不读注释，'
    + '§70 的两半都不该响。预期 NOT-BLOCKED（对照组：没有它，"被拦住"也可能是"§70 恒红"）',
  file: LINT,
  anchor: /^const REPO = path\.resolve\(path\.dirname\(fileURLToPath\(import\.meta\.url\)\), '\.\.'\);$/m,
  count: 1,
  apply: (s) => s.replace(
    "const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');",
    "// L3 注入：这一行只是个注释，什么都不改\nconst REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');",
  ),
  layer: 'check-wb',
  expect: 'NOT-BLOCKED',
};

export default [L1, L2, L3];
