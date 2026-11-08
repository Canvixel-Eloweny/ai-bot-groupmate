/**
 * QQ 官方机器人通道（2026-11-06 · P0–P6）的定向变异清单 ——
 * 供 `NODE_OPTIONS= node scripts/mutate.mjs test/mutations/official-channel-2026-11-06.mjs` 复跑。
 *
 * 这一批分两层：
 *   · M1–M4、M7–M20 打 **check-wb §190 的九条判据**（静态层，跑一次约 20 秒）；
 *   · M5/M6 打**接缝行为**（`official` 层 = `test/check-official.mjs`，跑一次约 3 秒）：
 *     合并窗口与持久去重这两条，代码形状一模一样、线断不断只有真跑才知道 ——
 *     本轮端到端首跑抓到的第一条缺陷（`prev.entry` undefined 必抛）就是这个形状。
 *
 * ⚠️ 跑这一批必须带 `NODE_OPTIONS=` 前缀（R39），且**串行**（mutate 会改写真实工作树）。
 * ⚠️ 跑之前先提交；用全新的 `QQBOT_MUTATE_WORK` 目录（R46.1）。
 * ⚠️ C1 是**对照组**：它只改待配置提示的措辞（语义不变），§190 必须 NOT-BLOCKED。
 *    如果它也红了，说明判据在匹配"随便什么改动"而不是这九件事本身。
 */

const MODE = 'src/channel-mode.js';
const CONST = 'src/backend/official/constants.js';
const LIVE = 'src/official-liveness.js';
const CLIENT = 'src/backend/official/client.js';
const CFG = 'src/config.js';
const SRV = 'panel/server.js';
const SCHEMA = 'panel/next/schema.js';
const APP = 'panel/next/app.js';
const LAUNCH = 'Estrella-Bot.app/Contents/Resources/launcher.sh';
const CFGROUTE = 'panel/lib/config-route.js';
const DOM = 'test/panel-dom.mjs';

export default [
  // ── §190① 默认值只作用新装 · 旧配置继续 NapCat ──────────────────────────
  {
    id: 'M1',
    note: '把新装默认改成 official —— §190① 必须变红。'
      + '维护者 2026-11-06 先定官方、同日改口回 NapCat：官方通道要 AppID/AppSecret，'
      + '把它设成默认，新装第一眼就是"缺凭据、不说话"，而 NapCat 装上就能聊。'
      + '预期 BLOCKED（§190①）',
    file: MODE,
    anchor: /export const DEFAULT_CHANNEL_MODE = 'napcat';/,
    count: 1,
    apply: (s) => s.replace(
      "export const DEFAULT_CHANNEL_MODE = 'napcat';",
      "export const DEFAULT_CHANNEL_MODE = 'official';",
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M2',
    note: '把旧配置（没有 channel 键）的回落也改成 official —— §190① 必须变红：'
      + '今天所有在跑的用户一升级就换了出口，而他们手里没有 AppID，表现是"更新完它就不说话了"。'
      + '预期 BLOCKED（§190①）',
    file: MODE,
    anchor: /export const LEGACY_CHANNEL_MODE = 'napcat';/,
    count: 1,
    apply: (s) => s.replace(
      "export const LEGACY_CHANNEL_MODE = 'napcat';",
      "export const LEGACY_CHANNEL_MODE = 'official';",
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },

  // ── §190② 被动凭据账本 ─────────────────────────────────────────────────
  {
    id: 'M3',
    note: '把群被动回复上限 5 次放宽到 50 次 —— §190② 必须变红：'
      + '那是平台规则不是本地策略，放开的后果是前 5 条正常发、后面每条吃 40034128，'
      + '用户看到的是"它越说越不回"。预期 BLOCKED（§190②）',
    file: CONST,
    anchor: /  group: \{ windowMs: 5 \* 60_000, maxReplies: 5 \},/,
    count: 1,
    apply: (s) => s.replace(
      '  group: { windowMs: 5 * 60_000, maxReplies: 5 },',
      '  group: { windowMs: 5 * 60_000, maxReplies: 50 },',
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M4',
    note: '被动窗口起点改回平台事件时间戳 —— §190② 必须变红：'
      + '本机时钟比平台快 5 分钟以上时每一条群回复都算超窗，全落到主动消息'
      + '（而主动发言要群主单独开），症状是"通道显示在线却不回话"。'
      + '这是 2026-11-06 端到端实测出来的形状。预期 BLOCKED（§190②）',
    file: CLIENT,
    anchor: /      receivedAt: Date\.now\(\),/,
    count: 1,
    apply: (s) => s.replace(
      '      receivedAt: Date.now(),',
      '      receivedAt: official.time * 1000,',
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },

  // ── §190③ 入站接缝：合并窗口 + 持久去重（行为层）────────────────────────
  {
    id: 'M5',
    note: '把 AT+全量 的合并分支短路掉（三段形状仍然齐全，只是永不合成）—— '
      + '同一条消息会进大脑两次、回两遍。§190③ 的静态判据看不见这件事，'
      + '只有端到端能：合并后必须恰好一条事件且 mentionedSelf 为真。'
      + '预期 BLOCKED（official 层 / check-official ⑫）',
    file: CLIENT,
    anchor: /    if \(key && this\.mergePending\.has\(key\)\) \{/,
    count: 1,
    apply: (s) => s.replace(
      '    if (key && this.mergePending.has(key)) {',
      '    if (key && false && this.mergePending.has(key)) {',
    ),
    layer: 'official',
    expect: 'BLOCKED',
  },
  {
    id: 'M6',
    note: '把持久去重短路掉（`seen.has` 永不命中）—— 平台重投 / 续传补发的旧消息会再进大脑一次。'
      + '端到端第 ⑫ 节在合并窗口之后再推一次同 id，必须被丢掉并计入 duplicates。'
      + '预期 BLOCKED（official 层 / check-official ⑫）',
    file: CLIENT,
    anchor: /    if \(key && this\.seen\.has\(key\)\) \{/,
    count: 1,
    apply: (s) => s.replace(
      '    if (key && this.seen.has(key)) {',
      '    if (key && false && this.seen.has(key)) {',
    ),
    layer: 'official',
    expect: 'BLOCKED',
  },

  // ── §190④ 平台没给的能力必须明确失败 ───────────────────────────────────
  {
    id: 'M7',
    note: '合并转发从"抛错"改成"回一个假 message_id" —— §190④ 必须变红：'
      + '面板显示已发送而用户什么都没收到，是这批里最坏的一类静默。'
      + '预期 BLOCKED（§190④）',
    file: CLIENT,
    anchor: /    if \(plan\.unsupported\.includes\('forward'\)\) \{/,
    count: 1,
    apply: (s) => s.replace(
      "    if (plan.unsupported.includes('forward')) {\n      throw officialError(OFFICIAL_CODE.unsupportedForward,",
      "    if (plan.unsupported.includes('forward')) {\n      return { message_id: 'simulated', message_ids: [], steps: 1 };\n    }\n    if (false) {\n      throw officialError(OFFICIAL_CODE.unsupportedForward,",
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M8',
    note: '大脑里那三条"官方根本没有"的调用里，输入中气泡那条不再跳过 —— §190④ 必须变红：'
      + '它看着只是"少了一个气泡"，实际是每次回复前先吃掉一次被动名额（一条消息只有 5 次）。'
      + "⚠️ 这条变异第一次跑出来是 NOT-BLOCKED：判据当时写的是子串（函数名 + 中文实参），"
      + "把它塞进 `false &&` 之后子串照样命中 ⇒ 门假绿。现在钉的是整行 `if (skipOnOfficial(…` 的形状。"
      + '预期 BLOCKED（§190④）',
    file: 'src/index.js',
    anchor: /    if \(skipOnOfficial\('正在输入气泡'/,
    count: 1,
    apply: (s) => s.replace(
      "    if (skipOnOfficial('正在输入气泡'",
      "    if (false && skipOnOfficial('正在输入气泡'",
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },

  // ── §190⑤ 凭据外送闸 ───────────────────────────────────────────────────
  {
    id: 'M9',
    note: '把官方主机名导出、地址改成可配置 —— §190⑤ 必须变红：'
      + 'identify 帧与 REST 头都带 access_token，能改地址就能改收凭据的人；'
      + '而 AppSecret 是从面板进来的，配置面一旦能填 URL 就等于开了第二条外送路。'
      + '预期 BLOCKED（§190⑤）',
    file: CONST,
    anchor: /const OFFICIAL_HOST = 'api\.bot\.qq\.com';/,
    count: 1,
    apply: (s) => s.replace(
      "const OFFICIAL_HOST = 'api.bot.qq.com';",
      "export const OFFICIAL_HOST = 'api.bot.qq.com';",
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M10',
    note: '面板把 AppSecret 输入框从 password 退成 text —— §190⑤ 必须变红：'
      + '肩窥与"截个图发群里问"是最现实的泄漏面，而这一格旁边就写着"填进来"。'
      + '预期 BLOCKED（§190⑤）',
    file: SCHEMA,
    anchor: /                t: 'password', id: 'channel\.appSecret', label: 'AppSecret',/,
    count: 1,
    apply: (s) => s.replace(
      "                t: 'password', id: 'channel.appSecret', label: 'AppSecret',",
      "                t: 'text', id: 'channel.appSecret', label: 'AppSecret',",
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },

  // ── §190⑥ 身份单一真值 ─────────────────────────────────────────────────
  {
    id: 'M11',
    note: '配置归一化里再开一份 `owners`（主人第二真相源）—— §190⑥ 必须变红：'
      + '大脑与叫醒路只读 `owner.qq`，第二份的表现是"面板说设过主人了，它仍然不认你"。'
      + '预期 BLOCKED（§190⑥）',
    file: CFG,
    anchor: /  const out = \{ groups: \{\} \};/,
    count: 1,
    apply: (s) => s.replace(
      '  const out = { groups: {} };',
      '  const out = { groups: {}, owners: Array.isArray(src.owners) ? src.owners.slice() : [] };',
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },

  // ── §190⑦ 面板接线 + 写操作分类 ────────────────────────────────────────
  {
    id: 'M12',
    note: '把解绑路由从 WRITE_ROUTES 里漏掉 —— §190⑦ 必须变红：'
      + '演示模式（没有机器人在线）里它照样能改 config，分类表的作用就是"会改状态的 POST 必须登记"。'
      + '预期 BLOCKED（§190⑦）',
    file: SRV,
    anchor: /'\/api\/channel\/bind', '\/api\/channel\/unbind', '\/api\/channel\/owner',/,
    count: 1,
    apply: (s) => s.replace(
      "  '/api/channel/bind', '/api/channel/unbind', '/api/channel/owner',",
      "  '/api/channel/bind', '/api/channel/owner',",
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },

  {
    id: 'M13',
    note: '把机器人写出的 recvAll 再套一次 `Object.fromEntries` —— 这就是 2026-11-06 实测到的那颗雷：'
      + '快照里它是**对象**（`{群 openid: true}`），而 fromEntries 只对数组成立 ⇒ 整次状态采集 TypeError，'
      + '面板上的表现是"机器人没在跑"，不是"这里写错了"。'
      + '预期 BLOCKED（§190⑦；端到端 ⑬ 也会红）',
    file: LIVE,
    anchor: /      recvAll: health\?\.recvAll \|\| \{\},/,
    count: 1,
    apply: (s) => s.replace(
      '      recvAll: health?.recvAll || {},',
      '      recvAll: Object.fromEntries(health?.recvAll || []),',
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M14',
    note: '把「改了要重启」退回只比通道种类（不再比运行侧的 AppID）—— §190⑦ 必须变红：'
      + '用户存好 AppID 后卡片一片安静，于是他以为填错了，其实只差重启一次。'
      + '预期 BLOCKED（§190⑦）',
    file: LIVE,
    anchor: /        \|\| String\(health\?\.appId \?\? ''\) !== appId\)\);/,
    count: 1,
    apply: (s) => s.replace(
      "        || String(health?.appId ?? '') !== appId));",
      '        ));',
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },

  // ── §190⑧ 启动链按通道 ─────────────────────────────────────────────────
  {
    id: 'M15',
    note: 'Mac 启动器的通道兜底改成 official —— §190⑧ 必须变红：'
      + '默认应是 NapCat，兜底成官方会让读不出配置的老用户被迫切到没有凭据的官方通道，'
      +"机器人从「照常聊天」变成「一条都收不到」。预期 BLOCKED（§190⑧）",
    file: LAUNCH,
    anchor: /^\[ -n "\$CHANNEL" \] \|\| CHANNEL="napcat"$/m,
    count: 1,
    apply: (s) => s.replace(
      '[ -n "$CHANNEL" ] || CHANNEL="napcat"',
      '[ -n "$CHANNEL" ] || CHANNEL="official"',
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },

  // ── §190⑨ 回归门在 verify 里 + panel-dom 真渲染 ─────────────────────────
  {
    id: 'M16',
    note: '把官方通道回归从 verify 链里摘掉 —— §190⑨ 必须变红：'
      + '一个不进 verify 的测试文件等于没有测试，下一轮就没人再跑它。'
      + '预期 BLOCKED（§190⑨）',
    file: 'package.json',
    anchor: /NODE_OPTIONS= node test\/check-official\.mjs && /,
    count: 1,
    apply: (s) => s.replace(
      'NODE_OPTIONS= node test/check-official.mjs && ',
      '',
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M17',
    note: '把 panel-dom 里官方通道的真渲染段整段改名（`接入通道（官方）` → 别的字样）—— '
      + '§190⑨ 必须变红：静态字面量在，页面却可能什么都没画。'
      + '预期 BLOCKED（§190⑨）',
    file: 'test/panel-dom.mjs',
    anchor: /console\.log\('\\n── 接入通道（官方）：独立二级页/,
    count: 1,
    apply: (s) => s.replace("console.log('\\n── 接入通道（官方）：独立二级页", "console.log('\\n── 通道段被改名：独立二级页"),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },

  // ── §190⑦ 新页「切换协议端」的接线（2026-11-06 维护者改口之后）───────────
  {
    id: 'M18',
    note: '把「切换协议端」与「会话与日志」两个二级页的 id 互换 —— §190⑦ 必须变红：'
      + '通道卡就落到第三个位置上，用户按「总览 → 协议端 → 会话日志」的顺序找不到它。'
      + '预期 BLOCKED（§190⑦）',
    file: SCHEMA,
    anchor: /id: 'channel', label: '切换协议端', title: '切换协议端',/,
    count: 1,
    apply: (s) => s.replace(
      "id: 'channel', label: '切换协议端', title: '切换协议端',",
      "id: 'sessions', label: '切换协议端', title: '切换协议端',",
    ).replace(
      "id: 'sessions', label: '会话与日志', title: '会话与日志',",
      "id: 'channel', label: '会话与日志', title: '会话与日志',",
      1,
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M19',
    note: '漏给新二级页登记 NAV_SHORT 短标签 —— §190⑦ 必须变红。'
      + '症状不是报错而是 dock 被"切换协议端"五个字撑宽（导航改版那一族的经典回归）。'
      + '预期 BLOCKED（§190⑦）',
    file: SCHEMA,
    anchor: /subs: \{ overview: '总览', channel: '协议端', sessions: '会话日志' \},/,
    count: 1,
    apply: (s) => s.replace(
      "subs: { overview: '总览', channel: '协议端', sessions: '会话日志' },",
      "subs: { overview: '总览', sessions: '会话日志' },",
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M20',
    note: '把「立即重启生效」那颗动作改名（面板接线断在这里）—— §190⑦ 必须变红：'
      + '维护者原话是"切完还得点一次启动才刷新"，这颗按钮就是为这句话加的，'
      + '按钮还在、点了没反应，静态看形状完全正常。预期 BLOCKED（§190⑦）',
    file: APP,
    anchor: /  'channel\.restart': async \(\) => \{/,
    count: 1,
    apply: (s) => s.replace("  'channel.restart': async () => {", "  'channel.restartX': async () => {"),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },

  // ── §190⑦/⑧/⑨ 切完立刻换脸（2026-11-07 维护者点名「切的时候就要有反馈」）─────
  {
    id: 'M21',
    note: '把 channel.mode 的乐观重画钩子改名（optimistic → optimisticX）—— §190⑦ 必须变红：'
      + '面板不再当场换脸，回到「切了通道要去总览点一次启动框才出来」。'
      + '预期 BLOCKED（§190⑦）',
    file: SCHEMA,
    anchor: /optimistic: \(v, s\) => \{/,
    count: 1,
    apply: (s) => s.replace('optimistic: (v, s) => {', 'optimisticX: (v, s) => {'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M22',
    note: '删掉保存失败时的回滚重画（undo 那一行）—— §190⑦ 必须变红：'
      + '乐观换脸后若 /api/config 失败，单选停在官方、框不消失，正是「失败伪装成成功」。'
      + '预期 BLOCKED（§190⑦）',
    file: APP,
    anchor: /if \(undo\) \{ undo\(\); paintPage\(false\); \}/,
    count: 1,
    apply: (s) => s.replace('if (undo) { undo(); paintPage(false); }', 'if (undo) { undo(); }'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M23',
    note: '把通道改动的热重载白等加回去（去掉 channelRestart ? false 分支）—— §190⑧ 必须变红：'
      + 'waitEffectiveApplied 比的是 LLM 值不是通道，通道改了它秒回 true，'
      + '再说「已用上新配置（不用重启）」就和「通道要重启」自相矛盾。预期 BLOCKED（§190⑧）',
    file: CFGROUTE,
    anchor: /const applied = channelRestart \? false : await waitEffectiveApplied\(cfg\);/,
    count: 1,
    apply: (s) => s.replace(
      'const applied = channelRestart ? false : await waitEffectiveApplied(cfg);',
      'const applied = await waitEffectiveApplied(cfg);',
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M24',
    note: '把 panel-dom 里乐观重画那条真渲染断言的夹具标记改名 —— §190⑨ 必须变红：'
      + '静态判据钉不住「焦点停在 radio + 后端回执被拖住」这两个真实条件，'
      + '这道断言一旦被摘掉，缺陷就又是无人守的盲区。预期 BLOCKED（§190⑨）',
    file: DOM,
    anchor: /乐观重画夹具跑通/,
    count: 1,
    apply: (s) => s.replace('乐观重画夹具跑通', '乐观重画夹具被改名'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M25',
    note: '把 readyChecklist 的官方分流判据改坏（=== official → === napcat-x）—— §100 必须变红：'
      + '切到官方机器人后仍会收到「重启协议端 / 扫码」这类 NapCat 催法。预期 BLOCKED（§100）',
    file: APP,
    anchor: /const officialMode = j\(s, \['channel', 'mode'\], 'napcat'\) === 'official';/,
    count: 1,
    apply: (s) => s.replace(
      "const officialMode = j(s, ['channel', 'mode'], 'napcat') === 'official';",
      "const officialMode = j(s, ['channel', 'mode'], 'napcat') === 'napcat-x';"),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M26',
    note: '把状态岛的通道判据钉死成 napcat（var chMode = j(...mode...) → var chMode = napcat）'
      + '—— §190⑩ 必须变红：官方模式下那颗「协议端」格又显示 Docker / 没起。预期 BLOCKED（§190⑩）',
    file: 'panel/next/island.js',
    anchor: /var chMode = j\(s, \['channel', 'mode'\], 'napcat'\);/,
    count: 1,
    apply: (s) => s.replace(
      "var chMode = j(s, ['channel', 'mode'], 'napcat');",
      "var chMode = 'napcat';"),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },

  // ── 对照组：证明这九条不是"随便改点什么都红" ────────────────────────────
  {
    id: 'C1',
    note: '对照组：只改一条待配置提示的措辞（语义不变）—— §190 **必须 NOT-BLOCKED**。'
      + '如果它红了，说明判据在匹配"任何改动"而不是这九件事本身。预期 NOT-BLOCKED',
    file: SCHEMA,
    anchor: /text: '官方通道还缺 AppID \/ AppSecret：到 QQ 开放平台（q\.qq\.com）建机器人应用/,
    count: 1,
    apply: (s) => s.replace(
      'text: \'官方通道还缺 AppID / AppSecret：到 QQ 开放平台（q.qq.com）建机器人应用',
      'text: \'官方通道还缺 AppID / AppSecret：先到 QQ 开放平台（q.qq.com）建一个机器人应用',
    ),
    layer: 'check-wb',
    expect: 'NOT-BLOCKED',
  },
  {
    id: 'C2',
    note: '对照组：只改 channel.mode 切到官方后那句提示的措辞（语义不变）—— §190 **必须 NOT-BLOCKED**。'
      + '判据钉的是「有 savedMsg 函数」这件事，不是某一句文案；改文案不该红。预期 NOT-BLOCKED',
    file: SCHEMA,
    anchor: /已切到 QQ 官方机器人 · 填好 AppID \/ AppSecret，再重启机器人加载/,
    count: 1,
    apply: (s) => s.replace(
      '已切到 QQ 官方机器人 · 填好 AppID / AppSecret，再重启机器人加载',
      '已切到 QQ 官方机器人 · 填好 AppID / AppSecret 后重启机器人加载',
    ),
    layer: 'check-wb',
    expect: 'NOT-BLOCKED',
  },
];
