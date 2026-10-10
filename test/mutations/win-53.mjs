/**
 * 第 53 轮（Windows 便携版五缺陷）的变异清单 —— 纯数据，供
 * `NODE_OPTIONS= node scripts/mutate.mjs test/mutations/win-53.mjs` 复跑。
 *
 * 这一批验收的是**四条新契约**：
 *   · §96 的三条新子判据（⑦绝对入口 / ⑧端口来自配置且不被容器门住 / ⑨内存不许拿 0 冒充）
 *   · §97（子进程窗口 · windowsHide）
 *   · §98（配置模板可运行性 · 逐字发送）
 *   · §99（表情 id 表）
 *
 * 本项目纪律：**每新增一条契约都要配一组"只打它那一条"的变异** ——
 * 变异不只是验收代码，它同时验收"这条契约真的盯住了东西"。
 *
 * 为什么这一族特别需要静态判据：它们打的每一个形态都是「**在那个平台上不会报错**」——
 *   · 漏了 windowsHide ⇒ 只是多一个黑窗（macOS 上根本不存在"控制台窗口"这回事）；
 *   · 相对入口起机器人 ⇒ 只是"实例数"恒 0（macOS 走 cwd 判据，照样对）；
 *   · 端口写死 3000/3001 ⇒ 只是"断"（macOS 的 Docker 路线恰好在这些端口上）；
 *   · 空 splitToken ⇒ 只是"一个字一个字地发"（夹具全写死 '||'，四层回归全绿）；
 *   · 表情表配错名字 ⇒ 只是"群里显示的不是你以为的那个"（发出去的一直是合法表情）。
 *   换平台真跑一遍才发现，而本项目只有一台 mac。所以能做的只有两件事：
 *   ① 把判据做成**纯函数**，在本机直接喂 Windows / 坏配置形态的数据（smoke 的 T383 / T384）；
 *   ② 把"分支在不在、判据有没有被接线"钉在**静态**层面（本清单打的四个契约段）。
 *
 * ⚠️ 跑这一批必须带 `NODE_OPTIONS=` 前缀（R39）：本机 shell 注入的 `NODE_OPTIONS`
 *    会把 `err.code` 改写成 `CODEBUDDY_BROKER_DENY`，导致 smoke 基线不绿
 *    （T293/T296 因此假红）—— 而 `mutate` 会**正确地**拒绝开跑，人极容易读成"项目坏了"。
 * ⚠️ 若看到 `[safe-delete]`，那是沙箱的批量删除保护在冒充"被拦住"，换前台复跑再下结论。
 */

export default [
  // ── §97 子进程窗口（B1）────────────────────────────────────────────────
  {
    id: 'M1',
    note: 'proc.js 的 sh() 丢掉 windowsHide —— 它是**全项目外部命令的唯一出口**，'
      + '没了它 /api/state 轮询链上每 9~15 秒就闪一个黑窗（poweshell 15s TTL / docker info 8s TTL）',
    file: 'panel/lib/proc.js',
    anchor: /maxBuffer: 4 \* 1024 \* 1024, windowsHide: true \}/,
    count: 1,
    apply: (s) => s.replace(
      'maxBuffer: 4 * 1024 * 1024, windowsHide: true }',
      'maxBuffer: 4 * 1024 * 1024 }'
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M2',
    note: 'proc.js 的 shBuffer() 丢掉 windowsHide（第二处唯一出口）—— 拉一次二维码就闪一个黑窗',
    file: 'panel/lib/proc.js',
    anchor: /encoding: 'buffer', windowsHide: true \}/,
    count: 1,
    apply: (s) => s.replace(
      "encoding: 'buffer', windowsHide: true }",
      "encoding: 'buffer' }"
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M3',
    note: 'server.js 的 startBridge 把入口改回**相对路径** —— Windows 上 absEntryInRoot 只认绝对入口，'
      + '于是面板认不出自己刚起的机器人（「实例数」恒 0、孤儿清理也看不见它），而**不报错**',
    file: 'panel/server.js',
    anchor: /const entry = path\.join\(ROOT, 'src', 'index\.js'\);/,
    count: 1,
    apply: (s) => s.replace(
      "const entry = path.join(ROOT, 'src', 'index.js');",
      "const entry = 'src/index.js';"
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },

  // ── §96⑧ 协议端端口（B2）───────────────────────────────────────────────
  {
    id: 'M4',
    note: '协议端端口写回 3000 字面量 —— 那两个数字只是 macOS 的 Docker 路线"容器端口映射"的巧合；'
      + 'Windows 上原生 NapCat 的端口是用户自己配的，写死之后面板**连探都不探**',
    file: 'panel/lib/state-collector.js',
    anchor: /httpGet\(onebot\.httpPort, '\/get_login_info'\)/,
    count: 1,
    apply: (s) => s.replace("httpGet(onebot.httpPort, '/get_login_info')", "httpGet(3000, '/get_login_info')"),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M5',
    note: '协议端探测又被「容器在不在跑」门住 —— 容器只是 macOS 那条部署路线的实现细节，'
      + 'Windows 用原生 NapCat（那边根本没有容器）⇒ 屏幕上永远"HTTP 断 / WS 断 / 未登录"，'
      + '而机器人其实连着、消息流一直有记录',
    file: 'panel/lib/state-collector.js',
    anchor: /^      httpGet\(onebot\.httpPort, '\/get_login_info'\),$/m,
    count: 1,
    apply: (s) => s.replace(
      "      httpGet(onebot.httpPort, '/get_login_info'),",
      "      containerRunning ? httpGet(onebot.httpPort, '/get_login_info') : Promise.resolve({ ok: false }),"
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },

  // ── §96⑨ 内存读数不许撒谎（B2）─────────────────────────────────────────
  {
    id: 'M6',
    note: '「健康与占用」的一格改回 `?? 0` 兜底 —— Windows 上 readMemory() 如实返回 null，'
      + '而被它兜成 0 之后屏幕上是一片"0 MB / 0%"，读的人只会以为"它几乎不占内存"，'
      + '不可能想到"这个数根本没采到"（本项目最忌的"失败伪装成成功"）',
    file: 'panel/next/schema.js',
    anchor: /memCell\('机器人进程', \['memory', 'procs', 'bridgeMB'\], ' MB'\)/,
    count: 1,
    apply: (s) => s.replace(
      "memCell('机器人进程', ['memory', 'procs', 'bridgeMB'], ' MB'),",
      "metric('机器人进程', (s) => `${j(s, ['memory', 'procs', 'bridgeMB'], 0)} MB`),"
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },

  // ── §98 配置模板可运行性（B4 · 逐字发送）────────────────────────────────
  {
    id: 'M7',
    note: '脱敏器的「不是凭据」例外表里删掉 splitToken —— 凭据正则以 `token` 结尾锚定会把它清空，'
      + '写进 config.example.json 之后**每个从模板起步的新用户**都会拿到一份'
      + '"一条回复被逐字发出去"的配置（这就是本轮的真实事故）',
    file: 'scripts/sanitize-config.mjs',
    anchor: /'splitToken', \/\/ reply\.splitToken/,
    count: 1,
    apply: (s) => s.replace("  'splitToken', // reply.splitToken：模型用来分隔多条消息的标记，不是密钥\n", ''),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M8',
    note: '模板里的 splitToken 改回空串 —— 空串进 `new RegExp(\'|\\\\n+\')` 会**在每个字符之间**匹配，'
      + '整段回复被切成单字发出去；而它**每个新用户都会踩**（全新安装必走模板）',
    file: 'config.example.json',
    anchor: /"splitToken": "\|\|"/,
    count: 1,
    apply: (s) => s.replace('"splitToken": "||"', '"splitToken": ""'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M9',
    note: 'brain.js 的分条去掉守门（把 splitToken 直接塞回正则）—— 归一化只管从 config.json 装载那条路，'
      + '夹具 / 脚本 / 将来新增的配置来源给的空串会在这里退化成**逐字发送**',
    file: 'src/brain.js',
    anchor: /^      \.split\(splitter\)$/m,
    count: 1,
    apply: (s) => s.replace(
      '      .split(splitter)',
      '      .split(new RegExp(`${escapeRe(splitToken)}|\\n+`))'
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M10',
    note: 'config.js 的 splitToken 兜底改回 `?? \'||\'` —— `??` 只对 null/undefined 生效，'
      + '而真正会出问题的形态是**空串**，它会原样通过（第 53 轮"逐字发送"的根因之一）',
    file: 'src/config.js',
    anchor: /splitToken: normalizeSplitToken\(raw\.reply\?\.splitToken\)/,
    count: 1,
    apply: (s) => s.replace(
      'splitToken: normalizeSplitToken(raw.reply?.splitToken)',
      "splitToken: String(raw.reply?.splitToken ?? '||')"
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },

  // ── §99 表情 id 表（B5）────────────────────────────────────────────────
  {
    id: 'M11',
    note: 'FACE_PRESETS 里塞一个**重复的 id** —— 同一个表情在随机池里出现两次，权重被悄悄改了；'
      + '这类"复制粘贴时改漏一个"没有断言看着就永远查不出来',
    file: 'src/custom-config.js',
    anchor: /\[14, '微笑'\], \[13, '呲牙'\]/,
    count: 1,
    apply: (s) => s.replace("[14, '微笑'], [13, '呲牙']", "[14, '微笑'], [14, '呲牙']"),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M12',
    note: 'FACE_PRESETS 附近**删掉核对方法**（不提 NapCat 的 face_config.json / QSid）——'
      + '`napcat/` 不入库，注释是唯一能让下一个人不去猜的手段；'
      + '没有它，这张表在第 53 轮实测漂了 11/15 而**没有任何人发现**',
    file: 'src/custom-config.js',
    anchor: /face_config\.json/,
    count: 3, // 注释里出现三次（那句说明 / 核对方法那句 / 核对命令里各一次）
    apply: (s) => s.replaceAll('face_config.json', 'FACECONFIG-DISABLED').replaceAll('QSid', 'XXSID'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
];
