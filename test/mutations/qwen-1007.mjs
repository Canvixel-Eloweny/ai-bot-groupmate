/**
 * 接入千问（Qwen）的变异清单。2026-10-07 · 接千问。
 * ══════════════════════════════════════════════════════════════════════════
 *  这一批打的是：**四层全绿，而"这家属于谁 / 这笔花不花钱 / 点那个按钮会切到哪"悄悄变了。**
 *
 *  | 条 | 打的是                                            | 该由谁拦住 | 期望    |
 *  |----|---------------------------------------------------|-----------|---------|
 *  | M1 | 地址判定删掉千问那一支（千问地址判成 other）        | smoke     | BLOCKED |
 *  | M2 | 控制台拦截失效（控制台地址一路存下去）              | smoke     | BLOCKED |
 *  | M3 | 千问的"限时额度"被说成"永久免费"                    | smoke     | BLOCKED |
 *  | M4 | 千问的强度档域里混进它不认的 `high`                 | smoke     | BLOCKED |
 *  | M5 | 预设名单里去掉千问（readPresets 只给三套）          | sandbox   | BLOCKED |
 *  | M6 | `ALT_TARGET` 去掉千问（切千问被静默兜底成切本机）   | sandbox   | BLOCKED |
 *  | M7 | `keySaved` 用手写两家名单（不跟 PRESET_KEYS 派生）  | sandbox   | BLOCKED |
 *  | M8 | 脱敏器不认千问（沙箱里 Key 的假名张冠李戴）         | sandbox   | BLOCKED |
 *
 * ## 为什么这八条挑的是它们
 *
 * 每一条都对应一个**真实存在过、且不报错**的失效形态：
 *
 *   · M1 —— `providerOf()` 一次判定同时决定三件事（取哪把 Key / 算不算免费 / 界面高亮哪个按钮）。
 *     漏判的症状是"切过去能保存、模型名也对，但每条消息都失败"，因为请求根本没发对地方。
 *   · M2 —— 提交前我就是这么想的：用户会照着浏览器地址栏把它填进来。
 *     而这一条**不归防钓鱼那道闸管**（控制台域名不属于任何一家 ⇒ `providerHostOk('other')` 恒真）
 *     ⇒ 没有它，地址会被原样存下去，然后表现成"机器人突然不理我"。
 *   · M3 —— 这是本批**唯一一条"会把话说反"的**：千问的额度会到期会用完，
 *     说成"永久免费"等于告诉用户"这个永远不会用完"。它是真的会让人被扣钱的那种错。
 *   · M4 —— 档位域发错的后果是 400 整条被拒；而"映射错了不报错"，只是静默变了档。
 *   · M5/M6/M7 —— 三条都是**加家时最容易漏的那一处**，且漏了都不报错：
 *     M6 尤其典型（不在表里的 target 被 `|| 'local'` 兜底 ⇒ 点"用千问"却拉起了本机模型）。
 *   · M8 —— 打的是"沙箱副本"那条路。它挂的时候，红的是**另一条**不相干的断言
 *     （"切走再切回来 Key 变了"），最容易被误判成切换逻辑坏了。
 *
 * ## ⚠️⚠️ 第一次跑，M3 **打空了**（NOT-BLOCKED）—— 值得单独记一笔的形态
 *
 * M3 的 `apply` 当时写成：
 *
 * ```js
 * apply: (src) => src.replace('每个模型 100 万 token、90 天有效', '官方永久免费')
 * ```
 *
 * 而 `src/free-quota.js` 里**同一串字面量出现了两次**：一次在**注释**里（解释平台规则的那段），
 * 一次在**真正被返回的那行** `why:` 上。`String.replace(字符串)` **只替换第一处**
 * ⇒ 变异改的是**注释**，判定逻辑一个字没动 ⇒ smoke 理所当然地全绿 ⇒
 * `mutate.mjs` 报 "NOT-BLOCKED · exit=0"，而它同时还报着 "生效 ✓"（文件哈希确实变了）。
 *
 * **两个信号同时出现、却互相矛盾**（"锚点命中 1/1" + "生效 ✓" + "没被拦住"）——
 * 这正是本文件开头那张事故表里第 4 行的同族：**探针/变异自己会说谎，而且方向往往是"谎报防线失效"**，
 * 比"谎报通过"更难分辨。
 *
 * ⇒ **由此定一条纪律（已写进下面 M3 的注释）**：
 *   **`apply` 的匹配串必须比 `anchor` 更精确 —— 必须带上只属于代码行的上下文**
 *   （本例是 `why: '平台赠送额度（…`，那个 `why: '` 前缀注释里没有）。
 *   `anchor` 只保证"命中数对得上"，**它管不到 `apply` 改的是哪一处**。
 *
 * 修复后 M3 由 BLOCKED 变绿（见当日日志）。同批其余 7 条的 `apply` 都带整行 / 唯一上下文，
 * 逐条核过没有这个形态。
 *
 * ## ⚠️ 两条刻意不做的（写在这里，免得下一个人再试一遍）
 *
 *   · **不给 `quotaOf` 的"历史账本回落"单独配一条变异。** 它的回归口是
 *     `quotaOf('', 'glm-4.5-air')`（服务商为空 ⇒ 按模型名判）—— 要打它得让 `isZhipuModel`
 *     整体失效，而那会**同时**打中四五个别的断言，拦是肯定拦得住，但归因不干净。
 *     这一条的证据留在 T381 的注释里（"口径必须与老代码逐字一致"）。
 *   · **不打 `consoleHostReject` 的"拒绝文案要说清该填什么"那一半。** 试过：把返回的中文
 *     换成一句"地址不对" —— smoke 层**会红**（T381 里有一条 `/compatible-mode\/v1/` 的断言），
 *     但它与 M2 打的是同一个函数、同一条判据，多一条只是重复计数器。
 *     这种"能拦住但只是再确认一遍"的条目**不算验收**，写在文档里比塞进清单更诚实。
 *
 * ⚠️ 跑法：`NODE_OPTIONS= node scripts/mutate.mjs test/mutations/qwen-1007.mjs`
 *    跑之前确认工作树是干净的（`git status`）—— 本工具**就地变异**，靠 pristine 还原。
 */

export default [
  {
    id: 'M1',
    file: 'src/net-rules.js',
    anchor: /if \(QWEN_RE\.test\(b\)\) return 'qwen';/,
    count: 1,
    apply: (src) => src.replace("  if (QWEN_RE.test(b)) return 'qwen';\n", ''),
    layer: 'smoke',
    expect: 'BLOCKED',
    note: '地址判定漏掉千问 ⇒ 千问地址落到 other（没有预设、没有免费判据、取不到 Key），而保存与切换都不会报错',
  },
  {
    id: 'M2',
    // ⚠️ 第 57 轮：锚点跟着**实现**搬（不是退役）。第 54 轮真机首跑后 `consoleHostReject()`
    //    从「`if (!CONSOLE_HOST_RE.test(host)) return '';` 提前返回」改写成
    //    「`if (CONSOLE_HOST_RE.test(u.hostname)) {` 正向分支」（同一个判断，另一处写法），
    //    并且多了一条 `CONSOLE_PATH_RE`（已知厂商域名 + 控制台**路径**）。
    //    被打的判断**还在**，只是换了形状 ⇒ 按纪律搬锚点，不退役。
    file: 'src/net-rules.js',
    anchor: /if \(CONSOLE_HOST_RE\.test\(u\.hostname\)\) \{/,
    count: 1,
    apply: (src) => src.replace('if (CONSOLE_HOST_RE.test(u.hostname)) {', 'if (false) {'),
    layer: 'smoke',
    expect: 'BLOCKED',
    note: '控制台拦截失效 ⇒ 用户照浏览器地址栏填的控制台域名被原样存下，然后每条请求都失败（而防钓鱼那道闸对它恒放行）。'
      + '（第 57 轮：实现改写成正向分支后锚点跟着搬 —— 若哪天这条真的被删，才是退役，'
      + '退役要写"两数同向 + 逐条理由"，见 `scripts/mutate-lint.mjs` 的口径）',
  },
  {
    id: 'M3',
    file: 'src/free-quota.js',
    // ⚠️ `anchor` 带 `why: '` 前缀 —— **只属于代码行**，注释里那处没有这个前缀。
    //    `apply` 的匹配串也必须带上同样的前缀（下面那条纪律的由来：第一次跑时
    //    `apply` 只写 `'每个模型 100 万 token、90 天有效'`，而**注释里有一模一样的字面量**，
    //    `String.replace(字符串)` 只改第一处 ⇒ 改到了注释 ⇒ 判定没变 ⇒ 假绿）。
    anchor: /why: '平台赠送额度（每个模型 100 万 token、90 天有效）/,
    count: 1,
    apply: (src) => src.replace(
      "why: '平台赠送额度（每个模型 100 万 token、90 天有效）",
      "why: '平台赠送额度（官方永久免费）"
    ),
    layer: 'smoke',
    expect: 'BLOCKED',
    note: '把千问的「限时额度」说成「永久免费」⇒ 账照算、界面照显示，但用户以为额度永远不会用完（会直接被扣钱）',
  },
  {
    id: 'M4',
    file: 'src/model-caps.js',
    anchor: /const QWEN_LEVELS = \['low', 'medium', 'xhigh'\];/,
    count: 1,
    apply: (src) => src.replace(
      "const QWEN_LEVELS = ['low', 'medium', 'xhigh'];",
      "const QWEN_LEVELS = ['low', 'medium', 'high'];"
    ),
    layer: 'smoke',
    expect: 'BLOCKED',
    note: '千问的档位域里混进它不认的 high ⇒ 每个带思考的请求被 400 整条拒掉（不报错、只表现为"它不理我"）',
  },
  {
    id: 'M5',
    file: 'panel/lib/models.js',
    anchor: /export const PRESET_KEYS = \['local', 'deepseek', 'zhipu', 'qwen'\];/,
    count: 1,
    apply: (src) => src.replace(
      "export const PRESET_KEYS = ['local', 'deepseek', 'zhipu', 'qwen'];",
      "export const PRESET_KEYS = ['local', 'deepseek', 'zhipu'];"
    ),
    layer: 'sandbox',
    expect: 'BLOCKED',
    note: '预设名单漏掉千问 ⇒ readPresets 只给三套、stashCurrentPreset 也不再归档它（"切走再切回来设置全丢"）',
  },
  {
    id: 'M6',
    file: 'panel/server.js',
    // ⚠️ 锚点**只匹配 qwen 这一项**，不要把邻居写进来：
    //    第一版写的是 `/qwen: 'qwen', local: 'local' \};/`（带上了邻居），
    //    后来 ALT_TARGET 里插进 `custom: 'custom'` ⇒ 那串就不再匹配 ⇒ 锚点失效。
    //    ⇒ 教训：**锚点要钉在"要改的那一项"上，不要钉在它周围那一片**。
    anchor: /qwen: 'qwen',/,
    count: 1,
    apply: (src) => src.replace("qwen: 'qwen', ", ""),
    layer: 'sandbox',
    expect: 'BLOCKED',
    note: 'ALT_TARGET 漏掉千问 ⇒ 点「用千问」被 `|| \'local\'` 静默兜底成「切本机」（本机模型被拉起来，而日志一切正常）',
  },
  {
    id: 'M7',
    file: 'panel/lib/state-collector.js',
    anchor: /PRESET_KEYS\.filter\(\(k\) => k !== 'local'\)/,
    count: 1,
    apply: (src) => src.replace("PRESET_KEYS.filter((k) => k !== 'local')", "['deepseek', 'zhipu']"),
    layer: 'sandbox',
    expect: 'BLOCKED',
    note: 'keySaved 退回手写两家名单 ⇒ 千问那页的 Key 框下方不显示"已保存"，用户以为没存上、再填一遍',
  },
  {
    id: 'M8',
    file: 'scripts/sanitize-config.mjs',
    anchor: /p === 'zhipu' \|\| p === 'qwen' \? p : '';/,
    count: 1,
    apply: (src) => src.replace("p === 'zhipu' || p === 'qwen' ? p : '';", "p === 'zhipu' ? p : '';"),
    layer: 'sandbox',
    expect: 'BLOCKED',
    note: '脱敏器不认千问 ⇒ 沙箱里当前大脑是千问时假值仍叫 apiKey，第一次切换就覆盖 keys.qwen（症状挂在另一条不相干的断言上）',
  },
];
