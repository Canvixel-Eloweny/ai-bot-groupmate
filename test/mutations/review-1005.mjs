/**
 * 开源前审查（2026-10-05）· S-06 的变异清单 —— 纯数据，
 * 供 `NODE_OPTIONS= node scripts/mutate.mjs test/mutations/review-1005.mjs` 复跑。
 *
 * 打的对象：`.gitignore` 里 `/napcat/` 那条规则的**前导斜杠**，以及
 * `scripts/check-wb.mjs` §49⑦c 新加的三条判据。
 *
 * 背景（为什么这条值得专门配一组变异）：
 *   `napcat/` **不带前导斜杠**时匹配**任意层级**，实测把 `docker/napcat/` 整个吃掉 ——
 *   13 个构建文件从未进过版本控制，而 `docker-compose.yml` 的 `build.context` 指的就是它。
 *   开源后 `git clone && docker compose up` 必然失败，而 Docker 是 README 的唯一推荐路线。
 *
 *   | 条  | 打的是 | 该由哪一层拦住 | 期望 |
 *   |---|---|---|---|
 *   | M1  | `/napcat/` → `napcat/`（去掉前导斜杠，回到原始缺陷） | §49⑦c 三条**全响** | BLOCKED |
 *   | M2  | 整行删掉 | §49⑦c 字符串判据 + 症状级 | BLOCKED |
 *   | M3  | `/napcat/` → `/napcat`（去掉**尾**斜杠） | §49⑦c 字符串判据 + 症状级 | BLOCKED |
 *   | M4  | 另加一行**精确**忽略 `docker/napcat/Dockerfile` | **只有症状级判据**—— M4 是本组的重点，见下 | BLOCKED |
 *   | M5  | 加一条无害注释（文案里提到 napcat） | 防线**不该**响 | NOT-BLOCKED |
 *
 * ⚠️ **M4 是这一组存在的理由**：前两条判据验的是「配置字符串长什么样」，
 *    而 M4 的改动让它们**全都绿** —— `/napcat/` 还在、也没有裸的 `napcat/` 行，
 *    只有 `git check-ignore` 那一问能发现 `Dockerfile` 进不了仓库。
 *    这正是「判症状而不是判字符串」的价值所在（本项目 R38：新写的判据也会被自己的弱形状骗过）。
 *
 * ⚠️ **M5 的方向与别的相反**（R44）：它是「误报型」变异 —— 期望是**防线不该响**。
 *    `.gitignore` 里成片地解释「napcat 是协议端」，若判据去做全文子串匹配就会误报；
 *    三条判据都用 `^…$/m` 锚住**独立成行**，所以注释不该触发它。
 *
 * 期望：M1–M4 `BLOCKED`，M5 `NOT-BLOCKED`，`INVALID` 为 0。
 * ⚠️ 跑测试一律 `NODE_OPTIONS= node …`（R39），漏带 = 内部基线假红、mutate 会正确地拒绝开跑。
 * ⚠️ 跑之前**先提交**，并用全新的 `QQBOT_MUTATE_WORK` 目录（R46.1：复用旧目录会把工作树回滚）。
 */
const GI = '.gitignore';
// 锚点：独立成行的 `/napcat/`。⚠️ 不能只锚 `napcat/` —— 上方注释里也出现了这个串，
// 取错了会把注释改掉，变异就打空了（INVALID）。
const ANCHOR = /^\/napcat\/$/m;

// ── M1：去掉前导斜杠，回到原始缺陷 ──────────────────────────────────────────
const M1 = {
  id: 'M1',
  note: '`/napcat/` → `napcat/`（去掉前导斜杠）—— 它会重新匹配任意层级、把 docker/napcat/ 吃掉。预期 BLOCKED（§49⑦c 三条全响）',
  anchor: ANCHOR,
  count: 1,
  file: GI,
  apply: (s) => s.replace(ANCHOR, 'napcat/'),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M2：整行删掉 ────────────────────────────────────────────────────────────
const M2 = {
  id: 'M2',
  note: '把 `/napcat/` 整行删掉 —— 根目录的登录态目录不再被忽略，凭据会进仓库。预期 BLOCKED',
  anchor: ANCHOR,
  count: 1,
  file: GI,
  apply: (s) => s.replace(/\/napcat\/\n/, ''),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M3：去掉尾部斜杠（只匹配到文件而非目录） ────────────────────────────────
const M3 = {
  id: 'M3',
  note: '`/napcat/` → `/napcat`（去掉尾斜杠）—— 形状几乎一样，但语义从"目录"变成"文件或目录"。预期 BLOCKED',
  anchor: ANCHOR,
  count: 1,
  file: GI,
  apply: (s) => s.replace(ANCHOR, '/napcat'),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M4：精确忽略单个构建文件（本组的重点） ─────────────────────────────────
const M4 = {
  id: 'M4',
  // ⚠️ 期望已改为 NOT-BLOCKED（本轮实证修正）：`.gitignore` 对**已被跟踪的文件无效**，
  //    而 `git check-ignore` 对它们也返回"不被忽略" —— 所以 Dockerfile 入库之后，
  //    再写一条精确忽略它的规则，判据**正确地不响**（文件已经进来了，clone 拿得到）。
  //    ⇒ 它现在钉的是"判据不该在已入库时误报"，而"必须真的 git add"那一半
  //      由 §49⑦c 的 `git ls-files` 那一问守着（本轮为它专门补的）。
  note: '另起一行精确忽略 `docker/napcat/Dockerfile` —— Dockerfile 已入库时这条规则**实际无效**（gitignore 不管已跟踪文件），判据不该误报。预期 NOT-BLOCKED（本轮由 BLOCKED 修正，理由见下方注释）',
  anchor: ANCHOR,
  count: 1,
  file: GI,
  apply: (s) => `${s}\n# 构建产物单独排除\ndocker/napcat/Dockerfile\n`,
  layer: 'check-wb',
  expect: 'NOT-BLOCKED',
};

// ── M5：无害注释（误报型） ─────────────────────────────────────────────────
const M5 = {
  id: 'M5',
  note: '追加一条提到 napcat 的普通注释 —— 文案里出现这个串是无害的，防线**不该**响。预期 NOT-BLOCKED（R44：误报型的期望与别的相反）',
  anchor: ANCHOR,
  count: 1,
  file: GI,
  apply: (s) => `${s}\n# 提醒：napcat/ 下是协议端登录态，别手动拷走\n`,
  layer: 'check-wb',
  expect: 'NOT-BLOCKED',
};

// ── M6/M7：NapCat-Docker 的上游构件不许入库（许可，不是体积）───────────────
//    NapCat 用 Limited Redistribution License：禁止未经授权分发、
//    "修改后的代码不得公开发布"。而 THIRD-PARTY-NOTICES.md 声明「不复制它的任何代码」。
//    ⇒ 这一对判据**必须是可执行的**：本仓在 `git add -A` 上已误收过两次
//      （`.gitignore:154-155` 有记录）——「写在文档里的边界不会自动执行」。
const M6 = {
  id: 'M6',
  note: '删掉 `.gitignore` 里 `docker/napcat/entrypoint.sh` 那行 —— 上游构件会随仓库分发，违反其许可且让第三方声明变成伪陈述。预期 BLOCKED（§49⑦c MUST_NOT_TRACK）',
  anchor: /^docker\/napcat\/entrypoint\.sh$/m,
  count: 1,
  file: GI,
  apply: (s) => s.replace(/^docker\/napcat\/entrypoint\.sh\n/m, ''),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

const M7 = {
  id: 'M7',
  note: '删掉 `.gitignore` 里 `docker/napcat/templates/` 那行 —— 8 个上游配置模板进仓库，同上。预期 BLOCKED（§49⑦c MUST_NOT_TRACK）',
  anchor: /^docker\/napcat\/templates\/$/m,
  count: 1,
  file: GI,
  apply: (s) => s.replace(/^docker\/napcat\/templates\/\n/m, ''),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M8：只动注释（误报型） ─────────────────────────────────────────────────
const M8 = {
  id: 'M8',
  note: '加一条提到 entrypoint.sh 的注释，规则一个字没动 —— 防线**不该**响。预期 NOT-BLOCKED（R44：误报型的期望与别的相反）',
  anchor: /^docker\/napcat\/entrypoint\.sh$/m,
  count: 1,
  file: GI,
  apply: (s) => `${s}\n# 注：entrypoint.sh 由 fetch-docker-assets.sh 拉取，别手动改\n`,
  layer: 'check-wb',
  expect: 'NOT-BLOCKED',
};

export default [M1, M2, M3, M4, M5, M6, M7, M8];
