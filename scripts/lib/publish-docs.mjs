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
