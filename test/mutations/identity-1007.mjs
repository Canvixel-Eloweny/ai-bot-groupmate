/**
 * 提交身份（谁会上榜）的变异清单。2026-10-07 · 第 24 轮 · 用户要求「确保贡献者不会再出上次那个情况」。
 *
 * 这一批打的是：**代码照跑、四层全绿，而「这份提交会被记到谁名下」悄悄变了。**
 *
 *   | 条  | 打的是                                          | 该由谁拦住 | 期望    |
 *   |-----|-------------------------------------------------|-----------|---------|
 *   | M1  | 本机 `.git/config` 的邮箱换成**第三方的 noreply** | check-wb  | BLOCKED |
 *
 * ## 为什么只有一条 —— 另两条"配置层"的打法**刻意不算 M-08b 的账**
 *
 * 试过并放弃的两条（写在这里，免得下一次有人再试一遍）：
 *
 *   | 打法 | 会红吗 | 为什么不算 |
 *   |---|---|---|
 *   | `.git/config` 里那个 email 行**整行删掉** | 不会 | `[user]` 段不存在是**合法状态**（对外拷贝就是 `git init` 出来的，本来就没有）。缺身份时该由「判提交对象」那条说话 —— 见下 |
 *   | 换成**别人的私人邮箱**（非 noreply） | 不会 | M-08b 只认 noreply 形状（它判的是"冒名"，不是"邮箱好不好看"）。私人邮箱同样交给下一条 |
 *
 * ⇒ 这两形的**真正闸门是 M-08d**（判 `HEAD` 提交对象里的作者与提交者邮箱，而不是配置）：
 *    配置层只是"早提醒"，提交对象层才是「谁会上榜」的唯一判据。
 *    ⚠️ 这也是本轮真事故的形状：线上那个提交署的是私人邮箱，而四层全绿 —— 因为当时
 *       **没有任何一条判据看过提交对象**。
 *
 * ## ⚠️ M-08d 没有条目，但它有**三次实测**（谁都能重跑）
 *
 * 变异框架只能改**文件内容**，而 M-08d 判的是**提交对象上的邮箱** —— 要打它得"造一个署错名的提交"，
 * 那不是 `apply`（把新内容写回同一路径）能表达的。所以这条判据的证据是下面这三次实测：
 *
 * ```bash
 * # ① 真阳性：对外拷贝里那个提交署的是私人邮箱（2026-10-07 上线时的真事故）
 * cp scripts/check-wb.mjs ~/Desktop/bot-groupmate-public/scripts/check-wb.mjs
 * cd ~/Desktop/bot-groupmate-public && node scripts/check-wb.mjs | grep 不属于本项目
 * #   → ✗ 这条线上有 N 处署名不属于本项目（Moon-Estrella@qq.com）
 *
 * # ② 假阳性对照：同一棵树、同一份判据，署名全对时必须绿
 * git clone <开发仓> /tmp/ident-clean && cd /tmp/ident-clean
 * cp <开发仓>/scripts/check-wb.mjs scripts/check-wb.mjs && ln -s <开发仓>/node_modules
 * node scripts/check-wb.mjs | grep -cE '^✗'      # → 只有"钩子未安装"那条（与身份无关）
 *
 * # ③ ★ 最值钱的一条：**上次事故的形状** —— 错名埋在历史**中间**、HEAD 是干净的
 * git clone <开发仓> /tmp/ident-probe && cd /tmp/ident-probe
 * TARGET=$(git rev-parse HEAD~5)
 * git filter-branch -f --env-filter \
 *   'if [ "$GIT_COMMIT" = "'"$TARGET"'" ]; then
 *      export GIT_AUTHOR_EMAIL=qqbot@users.noreply.github.com; fi' HEAD
 * cp <开发仓>/scripts/check-wb.mjs scripts/check-wb.mjs && ln -s <开发仓>/node_modules
 * node scripts/check-wb.mjs | grep -A1 不属于本项目
 * #   → ✗ 这条线上有 1 处署名不属于本项目（扫了 16 个提交）
 * #       3f81301 · 作者=qqbot@users.noreply.github.com ⇒ 会记到账号「qqbot」名下
 * #     而 HEAD 自己是干净的 ⇒ **只判 HEAD 的旧版会整个漏掉它**（这就是扩写这一条的理由）
 * ```
 *
 * ## ⚠️ 判据的**作用域**（2026-10-07 第三轮 · 用户口径「实至名归」）
 *
 * 判据只覆盖**我们自己要推的那条线**：开发仓（有 `scripts/publish-audit.mjs`）与对外拷贝
 * （`IS_PUBLISH_COPY` 桩标记）。**别人的 clone / 公开仓 clone 一律跳过** ——
 * 因为那个形态里历史本来就该有贡献者自己的提交，维护者规则会把真贡献者误判成冒名。
 * 实测三种形态：
 *   · 开发仓                → 判（绿）
 *   · 开发仓的克隆 + 毒化中间提交 → **红**（点名 3f81301）
 *   · 挖掉 publish-audit.mjs 的克隆（模拟公开仓）→ **跳过**（`✓ M-08d …不适用维护者规则`）
 *
 * ⚠️ **不许**为了让 M-08d 能被变异框架打到，就在判据里开一个"期望身份"的入参或环境变量 ——
 *    那等于给闸门装后门，而这一节存在的全部意义就是"没有后门"。
 *
 * ⚠️ 跑法：`NODE_OPTIONS= node scripts/mutate.mjs test/mutations/identity-1007.mjs`
 *    跑之前确认 `.git/config` 里是官方身份（M1 会临时改它，还原机制负责改回来）。
 */

export default [
  {
    id: 'M1',
    file: '.git/config',
    anchor: /email = 298320638\+Canvixel-Eloweny@users\.noreply\.github\.com/,
    count: 1,
    apply: (src) => src.replace(
      '298320638+Canvixel-Eloweny@users.noreply.github.com',
      'qqbot@users.noreply.github.com'
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
    note: 'M-08b：本机身份被换成第三方的 noreply ⇒ 之后的提交会被记到那个账号名下（上次事故的原形）',
  },
];
