/**
 * 第 21 轮（开源前审查 · **提交门有牙**）的变异清单 ——
 * 纯数据，供 `NODE_OPTIONS= QQBOT_MUTATE_WORK=/tmp/r21-mutate
 * node scripts/mutate.mjs test/mutations/r21-1010.mjs` 复跑。
 *
 * 本轮**没有新功能**。第 20 轮发现「红色已入库」（面板三块空白躺在库里而四层在工作树上全绿），
 * 根因三条各自独立。本轮封其中两条：
 *   ① `scripts/pre-commit.sh` **恒定 `exit 0`**；
 *   ③ 它查的是**工作树**—— 而工作树里可能躺着**未提交的修红在制品**。
 * （第 ② 条「仓库无 remote ⇒ `ci.yml` 从未跑过」**不在本轮能力范围内**，那是发布前的另一件事。）
 *
 * 做法：闸门改成 `git write-tree`（索引的 tree）→ `git commit-tree` 造临时 commit
 * → `git worktree add --detach` → 在**那棵树**里跑 check-wb → 红则 `exit 1`。
 * ⚠️ **不用 `git archive`**：实测那份导出**没有 `.git`**，而 check-wb 有判据要跑
 *    `git check-ignore` / `git ls-files` ⇒ 会得到 **23 处假红**（exit 128）。
 *    worktree 里有 `.git`（指向真实 gitdir 的文件）⇒ 那些判据照常工作。
 *
 * 实测（端到端，不是推断）：
 *   绿树 ⇒ exit 0；**树绿 + 索引红**（`MM`，第 20 轮事故的形状）⇒ **exit 1**。
 *
 * | 条 | 打的是 | 该由哪一层拦住 | 期望 |
 * |---|---|---|---|
 * | G1 | `exit 1` 被改回 `exit 0`（闸门恒定放行） | §86① | BLOCKED |
 * | G2 | 索引树闸门被删（退回只查工作树） | §86② | BLOCKED |
 * | G3 | 取了索引树却**不 cd 进去**（假索引视角） | §86② | BLOCKED |
 * | G4 | 绕过开关写成恒真条件（空串也成立） | §86④ | BLOCKED |
 * | G5 | fail-closed 被改成静默放行 | §86③ | BLOCKED |
 * | G6 | shell 剥注释器退化（`#` 不再剥） | §51 ④c-2 | BLOCKED |
 *
 * ⚠️ **G3 是本清单最要紧的一条**：它打的是「看起来做了索引视角、实际没做」这种形态——
 *   `git write-tree` 与 `git worktree add` 都还在（所以「有没有用索引树」那条判据是绿的），
 *   但 `cd` 没了 ⇒ check-wb 仍在**仓库根**跑 ⇒ 判的还是工作树。
 *   **这种改法骗得过除它之外的全部判据**，而它恰好把闸门整个废掉。
 * ⚠️ **G6 打的是工具退化**：本轮第一版忘了给 §86 传 `kind: 'sh'`，
 *   于是 `stripComments` 只剥 C 风格块注释与双斜杠注释、剥不掉 `#`
 *   ⇒ §86 被 `pre-commit.sh` **自己的注释**误伤
 *   （注释里写「为什么不用 git archive」就被判成「用了它」）⇒ 3 处假红。
 *   正解是修工具（`scan-utils.mjs` 补 `#` 行注释），**不是**把判据改松。
 *
 * ⚠️ 跑测试一律 `NODE_OPTIONS= node …`（R39）；用**全新**的 `QQBOT_MUTATE_WORK` 目录（R46.1）。
 */
const SH = 'scripts/pre-commit.sh';
const SU = 'scripts/lib/scan-utils.mjs';

// ── G1：守卫被改坏 ⇒ `exit 1` 走不到（**这一条是本轮最难抓的形态**）──────────
// ⚠️ 第一版把 `exit 1` 改成 `exit 0`（想着"那不就等于恒定放行了吗"），
//    实测 **NOT-BLOCKED** —— 因为 §86① 只查「`exit 1` 这个串在不在」，
//    而真正的故障形态恰恰是**那行还在、但走不到**：守卫被改成 `-ne 99999`。
//    ⇒ 变异改成打**守卫**，判据也相应升级成「判守卫的形状」（见 §86①）。
//    这一条记的是：**「有 X」与「X 生效」是两件事**，而闸门类判据必须钉后者。
const G1 = {
  id: 'G1',
  note: 'exit 1 那个分支的守卫被改成 -ne 99999（那行还在，红时却走不到 ⇒ 恒定放行）——',
  anchor: /if \[ "\$GATE_BLOCK" -ne 0 \]; then/,
  count: 1,
  file: SH,
  apply: (s) => s.replace(
    'if [ "$GATE_BLOCK" -ne 0 ]; then',
    'if [ "$GATE_BLOCK" -ne 99999 ]; then'
  ),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── G2：索引树赋值被摘掉（退回只查工作树 —— 成因③）──────────────────────────
// ⚠️ 第一版只把 `idx_tree=""` 那一行改掉，而 §86② 判的是**全文出现**
//    `git write-tree` ⇒ 隔壁那句 `echo "取不到索引树（git write-tree 失败）"`
//    里同样有这几个字 ⇒ 判据照样绿（实测 NOT-BLOCKED）。
//    ⇒ 变异与判据一起收紧：判据认**赋值那一句** `idx_tree="$(git write-tree…"`。
const G2 = {
  id: 'G2',
  note: 'idx_tree 的赋值不再来自 git write-tree（退回只查工作树 ⇒ 工作树绿而提交物红）——',
  anchor: /idx_tree="\$\(git write-tree 2>\/dev\/null \|\| true\)"/,
  count: 1,
  file: SH,
  apply: (s) => s.replace(
    'idx_tree="$(git write-tree 2>/dev/null || true)"',
    'idx_tree=""   # 变异：不再取索引树（工作树里那份就够用了）'
  ),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── G3：取了树却不 cd 进去（**假索引视角** · 本清单最要紧）────────────────────
// ⚠️ 形状刻意做成「**表面上该有的都在**」：write-tree / commit-tree / worktree add 全在，
//    只有 `cd "$GATE_TREE_DIR"` 被换成 `cd "$ROOT"` ⇒ check-wb 仍在仓库根跑。
//    ⇒ 「有没有用索引树」「有没有 fail-closed」两条判据都还是绿的，唯独闸门已废。
const G3 = {
  id: 'G3',
  note: '取了索引树却不 cd 进去（假索引视角：全部形状判据都绿，闸门却已废）——',
  anchor: /if \(cd "\$GATE_TREE_DIR" && "\$NODE" scripts\/check-wb\.mjs\); then/,
  count: 1,
  file: SH,
  apply: (s) => s.replace(
    'if (cd "$GATE_TREE_DIR" && "$NODE" scripts/check-wb.mjs); then',
    'if (cd "$ROOT" && "$NODE" scripts/check-wb.mjs); then'
  ),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── G4：绕过开关写成恒真条件（空串也成立 ⇒ 闸门永远被绕过）──────────────────
const G4 = {
  id: 'G4',
  note: '绕过开关写成 -n（空串也成立 ⇒ 闸门永远被绕过，等于没有闸门）——',
  anchor: /if \[ "\$\{QQBOT_SKIP_CONTRACT_GATE:-\}" = "1" \]; then/,
  count: 1,
  file: SH,
  apply: (s) => s.replace(
    'if [ "${QQBOT_SKIP_CONTRACT_GATE:-}" = "1" ]; then',
    'if [ -n "${QQBOT_SKIP_CONTRACT_GATE:-}" ]; then'
  ),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── G5：fail-closed 被改成静默放行（闸门跑不起来就悄悄过）──────────────────
// ⚠️ 打的是「取不到索引树」那一支：那正是 §86③ 的判据点。
// ⚠️ 锚点用 `[\s\S]*?` 而不是 `[^\n]*\n\s*` —— 实测那两句 `echo` 与 `GATE_BLOCK=1`
//    之间还夹着**另一句 echo**（量尺报「命中 0/1」当场把这件事说出来了）。
const G5 = {
  id: 'G5',
  note: '取不到索引树时不再阻断（闸门没跑起来却悄悄放行）——',
  anchor: /(echo "✗ 取不到索引树（git write-tree 失败）[\s\S]{0,200}?)\n(\s*)GATE_BLOCK=1/,
  count: 1,
  file: SH,
  apply: (s) => s.replace(
    /(echo "✗ 取不到索引树（git write-tree 失败）[\s\S]{0,200}?)\n(\s*)GATE_BLOCK=1/,
    '$1\n$2: 变异：静默放行'
  ),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── G6：shell 剥注释器退化（`#` 不再剥 ⇒ §86 被自家注释误伤）────────────────
// ⚠️ 这是**工具退化**，不是判据退化：判据 §86 本身是对的，坏的是它的取源。
//    退化后的症状很具体：`pre-commit.sh` 注释里那句「为什么不用 `git archive`」
//    会被 §86② 判成「用了 git archive」⇒ 假红。
const G6 = {
  id: 'G6',
  note: 'shell 剥注释器不再剥 # 行注释（§86 会被 pre-commit.sh 自己的注释误伤）——',
  anchor: /if \(kind === 'sh'\) s = s\.replace\(\/\(\^\|\\n\)\[ \\t\]\*#\.\*\$\/gm, '\$1'\);/,
  count: 1,
  file: SU,
  apply: (s) => s.replace(
    "if (kind === 'sh') s = s.replace(/(^|\\n)[ \\t]*#.*$/gm, '$1');",
    "if (kind === 'sh') s = s;   // 变异：不再剥 # 行注释"
  ),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

export default [G1, G2, G3, G4, G5, G6];
