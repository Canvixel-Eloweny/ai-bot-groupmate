/**
 * 发布面的 `docs/` 策略 —— **唯一出处**（H-12 · 第 11 轮 · 2026-10-05）。
 *
 * 为什么要有这个叶子：发布机制由用户裁决为「**生成对外拷贝**」（接手件 R10-d1），
 * 而 `docs/` 里哪些文件会随公开仓库出去，此前**没有一处说了算** ——
 * `make-publish-copy.mjs` 的 EXCLUDE 只逐个点名了四个（发布清单 / 交接件 / v3 计划 / 归档目录），
 * 于是 `docs/` 顶层那 20 份逐轮交付 HTML 与 6 份内部台账**会被一起发出去**（审查报告 H-12）。
 *
 * ⚠️ 为什么抽成叶子而不是写在 `make-publish-copy.mjs` 里：
 *    那个脚本**一 import 就跑**（它读 `process.argv`、没有目标目录就 `exit`），
 *    所以 `scripts/check-wb.mjs` §71 **没法 import 它**做双向核对。
 *    抽出来之后，两个消费者读的是**同一份名单** —— 不用在契约里再抄一遍（那正是"两份实现"）。
 *
 * 零依赖叶子：不 import 任何东西，能被直接 import 断言。
 */

/**
 * **会随公开拷贝发布**的 `docs/` 文件（通用技术文档，白名单）。
 * ⚠️ 白名单是 **fail-closed**：将来新加的 `docs/` 文件**默认不发布**，
 *    要发布必须显式加进这里 —— 因为"记得回来加一行排除"这种事从来不可靠
 *    （本项目已因此漏过 `.env`，见 `make-publish-copy.mjs` 文件头那段历史）。
 */
export const DOCS_KEEP = [
  'docs/ARCHITECTURE.md',        // 分层与依赖方向（改 src/ 之前必读）
  'docs/API_CONTRACT.md',        // 全部面板 API 的入参 / 出参 / 副作用 / 幂等性
  'docs/FRONTEND-V2.md',         // 现役面板前端的结构与约定
  'docs/MOTION-BRIEF.md',        // 动效委托模板
  'docs/MOTION-METHODOLOGY.md',  // 动效方法论与踩坑（面板 README 反复引用它）
  'docs/SKILLS.md',              // 插件 / Skill 两型的写法、配置与安装契约（README 引用它）
  'docs/legal/NOTICE',           // Apache §4(d) 署名通知；再分发时必须随附（README 指向它）
  'docs/legal/THIRD-PARTY-NOTICES.md', // 第三方来源与许可登记处（README/PR 模板引用）
  'docs/release/CHANGELOG.md',   // 对外版本沿革；README 徽章与发布说明引用
  'docs/guides/USER-GUIDE.md',       // 用户使用说明（英文默认）
  'docs/guides/USER-GUIDE.zh-CN.md', // 用户使用说明（中文权威版）
  'docs/guides/INSTALL-DOCKER.md',   // 容器路线安装手册（含回滚）
  'docs/README.zh-CN.md',            // 中文首页（权威版；README.md 语言切换指向它）
];

/**
 * **内部件**的名字形状 —— 白名单里**永远不许**出现命中的名字。
 *
 * 判据不从"我觉得它内部"来，而从 `docs/ARCHIVE.md` §规则 立的两条来：
 *   ① 顶层只放现行的五份内部件（`HANDOFF` / `DEEP-IMPROVE` / `PUBLISH-CHECKLIST` / `UPGRADE_PLAN-*` / `ARCHIVE`）；
 *   ② 被取代的逐轮交付件一律带日期尾巴（`*-1004` / `*-1005` / `-v3` …）。
 * 于是"是不是内部件"这件事有了一条**可核对的规则**，不是一份凭感觉维护的名单。
 * 消费者：`scripts/check-wb.mjs` §71 断言 `DOCS_KEEP` 里没有任何一项命中它。
 */
export const INTERNAL_DOC_NAME_RE = /^(DEEP-IMPROVE|PUBLISH-CHECKLIST|HANDOFF|UPGRADE_PLAN|ARCHIVE)(\.|$)|-\d{4}(-|\.)/;

/**
 * 一个被追踪的文件，**是否会随公开拷贝发布**（只看 `docs/` 这条规则；
 * `.workbuddy/`、`scripts/publish-audit.mjs` 等另由 `EXCLUDE` 管，它们不是 `docs/`）。
 */
export const isPublishedByDocsRule = (rel) =>
  !rel.startsWith('docs/') || DOCS_KEEP.includes(rel);

/** `docs/` 下、**不会**发布的那一份（用于 §71 的反向核对与提示文案）。 */
export const isHeldBackDoc = (rel) => rel.startsWith('docs/') && !DOCS_KEEP.includes(rel);

/**
 * ── 顶层（`docs/` 以外）**不随公开拷贝发布**的资产 ──────────────────────────────
 * （2026-10-11 · 由「总项目与外部线路」那一轮立）
 *
 * 为什么这一份必须住在这个叶子里，而不是继续写在 `make-publish-copy.mjs` 的 `EXCLUDE` 里：
 *   `EXCLUDE` 那些老条目**搬不动** —— 变异清单 `test/mutations/sec-s01-1005.mjs` 的 M8
 *   把锚点钉在 `'scripts/publish-audit.mjs',` 那一行上，搬走它 = 那条变异变成"锚点失效"。
 *   但 `check-wb` §71 的"死引用闸"需要知道**哪些 `.md`/`.html` 其实不会发布**，
 *   否则它会把一份已排除的文件当成"被发布的文档"去扫（2026-10-11 实测踩到：
 *   `AGENTS.md` 被排除后仍被判为"被发布的文档"。它引用了 `docs/PUBLISH-CHECKLIST.md`
 *   ⇒ 报了两条**假红**，而闸门当时正确地拦下了提交）。
 *
 * ⚠️ 判据（而不是"我觉得"）：一条目进这里，必须同时满足
 *   ① 它**写死了本机路径**或**只对这台机器上的 AI/维护者有约束力**（对外部读者是死路径）；
 *   ② 它**没有对外使用价值**（与 `packaging/` 那条"对象不对"同族）。
 *
 * 单一来源：`make-publish-copy.mjs`（真的排除它）与 `check-wb.mjs` §71（判定"是否被发布"）
 * **读同一份** —— 这正是 H-12 之后 `DOCS_KEEP` 立下的规矩，此处照办。
 */
export const HOLD_BACK_ROOT = [
  // 四节点 + 七道批准闸门的**本机协作约定**正本。含 ~/Documents/estrella-bot、
  // ~/Desktop/estrella-dist/、~/.qqbot/finish-ai-bot-groupmate.sh 等本机路径；
  // 读者是"在这台机器上动手的 AI"。公开仓里的读者 clone 下来另起一套，这份约定对他们无约束力。
  'AGENTS.md',
  // push 闸门。与 `scripts/pre-commit.sh` 同族（钩子逻辑入库、`.git/hooks/` 只做转发），
  // 但提示正文里写死了本机那条发布流水线（`~/.qqbot/finish-ai-bot-groupmate.sh`）——
  // 对外是死路径，且把本机工具布局泄到公开面。旧纪律：本机路径不进公开仓。
  'scripts/pre-push.sh',
  // G4 打 tag 的唯一入口（2026-10-20 维护者批准入库）。两条判据**都**命中：
  //   ① 它把本机凭据存放位置写死成 `~/.qqbot/gh-token.txt`，且注释里那条发布链
  //     （`~/.qqbot/finish-ai-bot-groupmate.sh` 第 ⑧ 步）只在这台机器上存在 —— 对外部读者
  //     是死路径，clone 下来既没有 token 文件也没有驱动它的链；
  //   ② 它是**维护者的发布工具**，不是产品运行时代码：对外没有使用价值（与上面 `packaging/`
  //     那条"对象不对"同族）。
  // ⚠️ 公开仓里"能直接跑起来写 GitHub tag 的脚本"本身就是攻击面 —— 持有不发也是减面。
  'scripts/g4-tag.mjs',
  // g4-tag 的 `--selftest` 夹具（本地 mock GitHub，绝不联网）。它随正本一起持有：
  // 少了它，仓内那 10 条 selftest 断言就只能在真 GitHub 上跑（写操作），自检价值直接归零。
  // 判据同上两条：只服务本机那条发布链、对外无使用价值。
  'scripts/mock-github-server.mjs',
  // Qoder Repo Wiki 的预检配置：只约束本机 AI 生成 wiki 的口径，对外无意义，
  // 也不是产品运行时代码；留在公开仓根只会多一个无用的隐藏目录。
  '.qoder/',
];

/** 顶层资产是否**不随公开拷贝发布**（前缀匹配，与 `make-publish-copy.mjs` 的同名语义一致）。 */
export const isHeldBackRoot = (rel) => HOLD_BACK_ROOT.some((e) => rel === e || rel.startsWith(e));

