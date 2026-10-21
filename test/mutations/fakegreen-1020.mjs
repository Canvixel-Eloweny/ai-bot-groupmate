/**
 * A 批「假绿补洞」（2026-10-20）的变异清单 —— 纯数据，供
 *   NODE_OPTIONS= node scripts/mutate.mjs test/mutations/fakegreen-1020.mjs
 * 复跑。命名照 `test/mutations/README.md:24-33` 的 `<来源>-<MMDD>` 形状。
 *
 * 这一批验收的是**三条新判据**（都是"同一件事有第二份真相，而旧门禁只扫其中一份"）：
 *   · §114⑬ 面板侧启动器候选表 ↔ 共享叶子 **逐字等价**（含排除词）
 *   · §115①②③ 外部私有协议面：WebUI 口令派生 / 两步私有路由 / 端口漂移候选
 *
 * ⚠️ 为什么这三处非要有变异不可：它们改坏之后**四层回归全绿**——
 *   候选表分叉的表现是"面板说协议端没装、安装器说已装"（不报错，只是没效果）；
 *   口令后缀改错的表现是"永远登录不上 WebUI"，而 `/api/qrcode/refresh` 早已改成
 *   "业务失败也回 200 + ok:false"（前端一见非 2xx 会把原因整个丢掉），
 *   所以**没有任何一层会替我发现**。这正是本项目反复记在 `CONTRACTS-HISTORY.md` 里的形状。
 *
 * ⚠️ 编号说明：§96⑧b 那三条同批的变异挂在 `win-53.mjs` 的 M14–M17（沿用该清单的号段，
 *   避开已删除的 §99 M11/M12），本清单从 M1 起。
 * ⚠️ 跑法照旧：先 `mutate-lint`（静态核锚点与"是否真改了东西"），再串行 `npm run verify`。
 */

export default [
  // ── §114⑬ 两份启动器候选表必须等价 ──────────────────────────────────────
  {
    id: 'M1',
    note: '把面板侧第四条候选从 /^napcat[\\w.-]*\\.bat$/i 改成 /^napcat[\\w-]*\\.bat$/i（少一个点）—— '
      + '与共享叶子分叉。真实后果：napcat.quick.bat 这类带点的名字，tools 认得、面板认不得，'
      + '于是「一键安装」说装好了而面板坚持"协议端未安装"。预期 BLOCKED（§114⑬ 候选表条）',
    file: 'panel/lib/napcat-native.js',
    anchor: /^ {2}\/\^napcat\[\\w\.-\]\*\\\.bat\$\/i,$/m,
    count: 1,
    apply: (s) => s.replace('/^napcat[\\w.-]*\\.bat$/i,', '/^napcat[\\w-]*\\.bat$/i,'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M2',
    note: '把面板侧排除词里的 `stop` 删掉 —— 与叶子的 (install|uninstall|kill|stop|remove) 分叉。 '
      + '真实后果：`napcat-stop.bat` 会被当启动器选中并拉起来（官方包里就有结束器），'
      + '表现为"点重启协议端反而把协议端停了"。预期 BLOCKED（§114⑬ 排除词条）',
    file: 'panel/lib/napcat-native.js',
    anchor: /const NOT_LAUNCHER_RE = \/\(install\|uninstall\|kill\|stop\|remove\)\/i;/,
    count: 1,
    apply: (s) => s.replace(
      'const NOT_LAUNCHER_RE = /(install|uninstall|kill|stop|remove)/i;',
      'const NOT_LAUNCHER_RE = /(install|uninstall|kill|remove)/i;',
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },

  // ── §115 外部私有协议面 ────────────────────────────────────────────────
  {
    id: 'M3',
    note: '把 WebUI 口令派生的后缀 `.napcat` 换成 `.estrella`（"改到自己的命名规范里"最自然的写法）—— '
      + '对方算法不认，永远登录不上 WebUI，界面只说"拿不到二维码"，且失败被 200 吞掉。'
      + '预期 BLOCKED（§115① 派生形状条）',
    file: 'panel/server.js',
    anchor: /createHash\('sha256'\)\.update\(token \+ '\.napcat'\)/,
    count: 1,
    apply: (s) => s.replace("update(token + '.napcat')", "update(token + '.estrella')"),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M4',
    note: '把私有路由名 /api/QQLogin/RefreshQRcode 改成 /api/QQLogin/GetQRcode（"更像我们自己的 API 风格"）—— '
      + '那是**对方的 URL**，OneBot v11 里没有这条路，改名等于把两步协议拆断。'
      + '预期 BLOCKED（§115② 路由名条）',
    file: 'panel/server.js',
    anchor: /'\/api\/QQLogin\/RefreshQRcode'/,
    count: 1,
    apply: (s) => s.replace("'/api/QQLogin/RefreshQRcode'", "'/api/QQLogin/GetQRcode'"),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M5',
    note: '把端口漂移候选的 base+1..4 收成 `i <= 0`（= 只探配置里那一个端口）—— NapCat 的 WebUI '
      + '端口被占时会 +1 重试且**不回写配置**（群友实测），于是"连不上"而配置数字看着完全正确。'
      + '预期 BLOCKED（§115③ 漂移候选条）',
    file: 'panel/server.js',
    anchor: /for \(let i = 1; i <= 4; i \+= 1\) out\.push\(base \+ i\);/,
    count: 1,
    apply: (s) => s.replace('for (let i = 1; i <= 4; i += 1) out.push(base + i);', 'for (let i = 1; i <= 0; i += 1) out.push(base + i);'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M6',
    note: '反向的一侧：把近邻候选从 4 扩到 12（"多试几个总没错"）—— 换码链路是串行的，'
      + '每个候选都要等一次 HTTP 应答，扩到 12 就把"点了没反应"做成真的没反应。'
      + '预期 BLOCKED（§115③ 漂移上限条）',
    file: 'panel/server.js',
    anchor: /for \(let i = 1; i <= 4; i \+= 1\) out\.push\(base \+ i\);/,
    count: 1,
    apply: (s) => s.replace('for (let i = 1; i <= 4; i += 1) out.push(base + i);', 'for (let i = 1; i <= 12; i += 1) out.push(base + i);'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M7',
    note: '把面板侧数组改名为 LAUNCHER_CANDIDATES_V2 —— 判据抽不到就是**真空**，'
      + '而"没比对出差异"在真空里会长成一条绿灯（本项目反复吃过这个亏）。'
      + '预期 BLOCKED（§114⑬ 抽出失败当失败那条）',
    file: 'panel/lib/napcat-native.js',
    anchor: /const LAUNCHER_CANDIDATES = \[/,
    count: 1,
    apply: (s) => s.replace('const LAUNCHER_CANDIDATES = [', 'const LAUNCHER_CANDIDATES_V2 = ['),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
];
