#!/bin/bash
# 提交前自检 —— **④ 结构契约这一项会真阻断**（第 21 轮起；此前恒定 exit 0）。
#
# 为什么放在 scripts/ 而不是 .git/hooks/：
#   .git/hooks/ 里的东西**不入库**，既看不到 diff、也 review 不了，
#   换台机器就没了 —— 那正是本项目最忌讳的「写上了但没人读」。
#   所以真正的逻辑放这里（可追溯、可 review），.git/hooks/pre-commit 只做一个两行转发。
#
# ⚠️⚠️ **为什么第 21 轮起不再「恒定 exit 0」**（这一条是本轮改动的全部理由）：
#   恒定放行意味着**红色可以入库**。第 20 轮实测到一次真实事故：
#   `2fcead3` 把 `panel/next/app.js` 的 RENDER 键改名成 `plugin*` 却**漏改 `schema.js`**，
#   而 §69「渲染面三处同集合」**抓得到**它 —— 但没人跑独立工作树核对，
#   于是**插件页 / 情绪设置 / 图库设置三块空白**在库里躺了很久。
#   三条成因各自独立：① 本脚本恒定 exit 0；② 仓库无 remote ⇒ `ci.yml` 从未跑；
#   ③ **本脚本查的是「工作树」**。第① 和第③ 本轮一起修。
#
#   ⚠️ **这与项目第 10 条约定不冲突**：那条约束的是「不许为了迁就检查器去改好代码」
#   —— 即**不许改代码去迎合检查器**。而阻断做的是相反的事：
#   **代码保持原样，让检查器真的有牙**。误报时的正确处置是**修检查器或改判据**
#   （本项目一贯如此，见 §51 那几段工具自测），不是把好代码改坏。
#
# ⚠️ **阻断只看「将要提交的那棵树」（索引树），不看工作树** —— 这是本轮最关键的一处。
#   工作树里可能躺着**修红的在制品**（第 20 轮那三个未提交的 `panel/next/*.js` 就是），
#   此时工作树绿、而**提交出去的那棵树是红的**。
#   做法：`git write-tree`（索引的 tree）→ `git commit-tree` 造一个临时 commit
#   → `git worktree add --detach` 到临时目录 → 在**那里**跑 check-wb。
#   ⚠️ **为什么不用 `git archive` 导出**：实测它导出的目录**没有 `.git`**，
#   而 check-wb 里有判据要跑 `git check-ignore` / `git ls-files`
#   ⇒ 在 archive 目录里跑会得到 **23 处假红**（exit 128）。
#   worktree 里有 `.git`（指向真实 gitdir 的一个文件），那些判据照常工作。
#   实测：索引树绿 ⇒ 100 段全过；把红的改动暂存 ⇒ 同一棵树里2 处问题（真检出）。
#
# 绕过（**要显式，且会留痕**）：
#   `QQBOT_SKIP_CONTRACT_GATE=1 git commit …` —— 打印醒目提示，且**把理由要求写进暂存说明**。
#   ⚠️ 刻意**不**提供 `--no-verify` 之外的静默开关：静默开关等于没有闸门。
#   ⚠️ 本变量只对**④ 结构契约**生效，① 语法与 ③ 量尺的诊断照常打印。
#
# 装法：bash scripts/pre-commit.sh --install

set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 0


if [ "${1:-}" = "--install" ]; then
  HOOK="$ROOT/.git/hooks/pre-commit"
  mkdir -p "$ROOT/.git/hooks"
  cat > "$HOOK" <<'SH'
#!/bin/sh
# 转发到入库的脚本（逻辑在那里，这个文件只是入口）
exec "$(git rev-parse --show-toplevel)/scripts/pre-commit.sh"
SH
  chmod +x "$HOOK"
  echo "已安装 pre-commit hook → $HOOK"
  exit 0
fi

NODE="${NODE:-node}"
warns=0

echo "── 提交前自检（① 语法 / ③ 量尺只报警；④ 契约闸门会真阻断）──"

# ① 语法：只查本次暂存的 js/mjs
staged="$(git diff --cached --name-only --diff-filter=ACM 2>/dev/null | grep -E '\.(js|mjs)$' || true)"
if [ -n "$staged" ]; then
  while IFS= read -r f; do
    [ -f "$f" ] || continue
    if ! out="$("$NODE" --check "$f" 2>&1)"; then
      echo "⚠️  语法检查未过：$f"
      echo "$out" | sed 's/^/     /'
      warns=$((warns + 1))
    fi
  done <<< "$staged"
  echo "✓ 语法检查：$(echo "$staged" | wc -l | tr -d ' ') 个暂存文件"
else
  echo "· 本次没有暂存的 js/mjs，跳过语法检查"
fi

# ② 结构契约：**在「将要提交的那棵树」上跑**，红则阻断（第 21 轮 · 见文件头）。
#
# ⚠️ 为什么不在工作树跑：工作树里可能躺着修红的在制品 ⇒ 工作树绿、提交物是红的。
#    第 20 轮那次事故正是这个形状（三个 panel/next/*.js 未提交 ⇒ 本机全绿、库里空白）。
# ⚠️ 为什么不用 `git archive`：导出的目录没有 `.git`，而 check-wb 有判据要跑
#    `git check-ignore` / `git ls-files` ⇒ 实测会得到 23 处假红（exit 128）。
#    worktree 里有 `.git`（指向真实 gitdir 的文件），那些判据照常工作。
# ⚠️⚠️ **必须先把 `GIT_INDEX_FILE` 钉成绝对路径**（本轮真踩，且它**只在真实钩子路径上发生**）：
#   git 跑钩子时会设 `GIT_INDEX_FILE=.git/index` —— 一个**相对路径**（实测捕获）。
#   本脚本前半段在仓库根跑，相对路径没问题；但闸门要`cd "$GATE_TREE_DIR"`，
#   那个目录里**没有 `.git/index`** ⇒ 相对路径解析到不存在的文件
#   ⇒ `git worktree add` 报 `fatal: .git/index: index file open failed`（exit 128）
#   ⇒ 闸门判定「跑不起来」→ fail-closed → **每一次提交都被拦下**。
#   ⚠️ 症状极具误导性：输出里只有一行「worktree add 失败」，
#   而在**仓库外手动跑**同一个脚本完全正常（实测）⇒ 看起来像"钩子环境有问题"，
#   实际是**相对索引路径 + cd** 这个组合。修法就一句：进闸门前把它变成绝对路径。
GATE_BLOCK=0
GATE_TREE_DIR=""
if [ -f scripts/check-wb.mjs ]; then
  # ⚠️ 必须在**cd 之前**解析成绝对路径（此刻还在仓库根，相对路径才有意义）。
  #    未设置时保持未设置 —— 不能给空值，那会让 git 去找一个空路径的索引。
  if [ -n "${GIT_INDEX_FILE:-}" ]; then
    case "$GIT_INDEX_FILE" in
      /*) : ;;                                  # 已是绝对路径，不动
      *)  GIT_INDEX_FILE="$ROOT/$GIT_INDEX_FILE" ;;  # 相对 ⇒ 钉到仓库根
    esac
    export GIT_INDEX_FILE
  fi
  idx_tree="$(git write-tree 2>/dev/null || true)"
  if [ -z "$idx_tree" ]; then
    # ⚠️ 取不到索引（例如不在 git 仓库里、或索引损坏）⇒ **fail-closed**：
    #    静默放行等于把闸门关掉，而「关掉的闸门」与「没有闸门」在输出上长得一样。
    echo "✗ 取不到索引树（git write-tree 失败）—— 无法判断将要提交的内容是否是绿的。"
    echo "     确认在仓库根目录里提交，或用 QQBOT_SKIP_CONTRACT_GATE=1 显式绕过（会留痕）。"
    GATE_BLOCK=1
  else
    tmp_commit="$(git commit-tree "$idx_tree" -p HEAD -m 'pre-commit gate probe' 2>/dev/null || true)"
    if [ -z "$tmp_commit" ]; then
      echo "✗ 造不出临时提交（git commit-tree 失败）—— 同样无法判断提交物是否是绿的。"
      GATE_BLOCK=1
    else
      GATE_TREE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/qqbot-gate.XXXXXX" 2>/dev/null || true)"
      if [ -z "$GATE_TREE_DIR" ]; then
        echo "✗ 建不了临时目录 —— 闸门无法运行，按 fail-closed 处理。"
        GATE_BLOCK=1
      elif ! git worktree add --detach --quiet "$GATE_TREE_DIR" "$tmp_commit" >/dev/null 2>&1; then
        #    ⚠️ 失败时把 git 的原话打出来：本轮第一次栽在这里时只有一行
        #    「worktree add 失败」，而真实原因是 `fatal: .git/index: index file open failed`
        #    —— 看不到原话就只能猜，猜错方向会浪费很久（当时怀疑的是「钩子环境有问题」）。
        echo "✗ git worktree add 失败 —— 闸门无法运行，按 fail-closed 处理。"
        echo "   git 的原话："
        git worktree add --detach --quiet "$GATE_TREE_DIR" "$tmp_commit" 2>&1 | sed 's/^/     /'
        GATE_BLOCK=1
      else
        # 依赖装在仓库里，跟着软链过去（worktree 本身不带 node_modules）。
        [ -e node_modules ] && ln -s "$ROOT/node_modules" "$GATE_TREE_DIR/node_modules" 2>/dev/null || true
        echo "── 契约检查跑在**将要提交的那棵树**上（$(echo "$tmp_commit" | cut -c1-8)）"
        if (cd "$GATE_TREE_DIR" && "$NODE" scripts/check-wb.mjs); then
          echo "✓ 结构契约通过（提交物是绿的）"
        else
          echo "✗ 结构契约未过 —— **阻断本次提交**。"
          echo "   ⚠️ 判的是**将要提交的那棵树**，不是工作树：工作树里若有未提交的修红改动，"
          echo "      它救不了这一记（那正是第 20 轮事故的形状）。"
          echo "   · 若确认是**假阳性**：按项目第 10 条约定**改检查器**，别改好代码。"
          echo "   · 若确实要带着红提交：QQBOT_SKIP_CONTRACT_GATE=1 git commit …（会打印留痕提示）"
          GATE_BLOCK=1
        fi
      fi
    fi
  fi
else
  echo "· 找不到 scripts/check-wb.mjs，跳过契约检查（**没有闸门**）"
  GATE_BLOCK=1
fi

# ③ 变异清单的**锚点体检**（第 7 轮 · 2026-10-05）。
#
# 它问的是「**工作树**里那 54 份变异清单还跑得动吗」（`scripts/mutate-lint.mjs`）。
# ⚠️ **为什么必须在这里、而不是在 check-wb 里**（量数决定的，别搬回去）：
#   `check-wb` 会被 `mutate.mjs` 在**变异后的工作树**上调，而"锚点是否自洽"是
#   **整棵树**的性质 —— 实测（第 7 轮）：把它放进 check-wb 会让 **512 条里 393 条**
#   触发它，其中 **28 条 `expect: 'NOT-BLOCKED'` 的"误红对照组"会被误翻成 BLOCKED**。
#   提交门恰好是"树自洽"的时刻，所以它是全仓扫描唯一的常驻执行点。
#   （`check-wb` §70 只钉量尺自身的自证 + 本次调用真的在，两件事都钉得住。）
if [ -f scripts/mutate-lint.mjs ]; then
  lint_rc=0
  lint_out="$("$NODE" scripts/mutate-lint.mjs 2>&1)" || lint_rc=1
  if [ "$lint_rc" -eq 0 ]; then
    echo "✓ $lint_out"
  else
    echo "⚠️  变异锚点体检未过 —— 有清单的锚点失效 / 变成惰性："
    echo "     那一条变异从此**拿不到结论**（\`mutate.mjs\` 会报 INVALID：既不是拦住也不是没拦住）。"
    echo "$lint_out" | sed 's/^/     /'
    warns=$((warns + 1))
  fi
else
  echo "· 找不到 scripts/mutate-lint.mjs，跳过变异锚点体检"
fi

echo "──────────────────────────────────"
if [ "$warns" -gt 0 ]; then
  echo "⚠️  $warns 项需要留意（① 语法 / ③ 量尺**只报警不阻断**）"
else
  echo "✓ 全部通过"
fi

# 清理闸门用的临时工作树 —— 必须在 exit 之前，且**不能因为清理失败就不阻断**
# （那会变成「闸门因为清垃圾失败而放行」，方向正好相反）。
if [ -n "$GATE_TREE_DIR" ] && [ -d "$GATE_TREE_DIR" ]; then
  git worktree remove --force "$GATE_TREE_DIR" >/dev/null 2>&1 || rm -rf "$GATE_TREE_DIR"
  git worktree prune >/dev/null 2>&1 || true
fi

# ── 唯一的阻断点：只有「提交物是红的」或「闸门自己没能跑起来」才拦 ──────────
# ⚠️ ① 语法与 ③ 量尺**故意仍然只报警**（见文件头：第 10 条约束的是"别改好代码迎合检查器"，
#    而它们历史上假阳性较多，阻断它们会把人逼去改代码）。④ 才是真闸门。
if [ "$GATE_BLOCK" -ne 0 ]; then
  if [ "${QQBOT_SKIP_CONTRACT_GATE:-}" = "1" ]; then
    echo "──────────────────────────────────"
    echo "⚠️⚠️ **已绕过契约闸门**（QQBOT_SKIP_CONTRACT_GATE=1）—— 这一记会把红色提交进库。"
    echo "   请在提交说明里写明为什么（项目约定：红色入库必须可追溯）。"
    echo "   下一轮开工第一件事：git worktree add /tmp/x HEAD --detach 后跑一次 check-wb。"
    exit 0
  fi
  echo "──────────────────────────────────"
  echo "✗ 提交被**契约闸门**拦下（不是① ③，它们仍然只报警）。"
  exit 1
fi

exit 0
