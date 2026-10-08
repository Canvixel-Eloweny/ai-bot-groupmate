/**
 * Windows 适配批（2026-10-08）的变异清单 —— 纯数据，供
 * `NODE_OPTIONS= node scripts/mutate.mjs test/mutations/win-1008.mjs` 复跑。
 *
 * 这一批验收的是**新契约 `check-wb` §96（跨平台分支）**本身，外加一条行为层。
 * 本项目纪律：**每新增一条契约都要配一组"只打它那一条"的变异** ——
 * 变异不只是验收代码，它同时验收"这条契约真的盯住了东西"。
 *
 * 为什么这一族特别需要静态判据：它打的每一个形态都是「**在那个平台上不会报错**」——
 * 换平台真跑一遍才发现，而本项目只有一台 mac。所以这里能做的只有两件事：
 *   ① 把判据做成纯函数，在 smoke 里直接喂 Windows 形态的数据（见 `T-WIN1…6`）；
 *   ② 把"分支存在 / 分支被接线"钉在静态层面（§96）。
 *
 *   | 变异 | 打的是什么（真实缺陷形态） | 层 | 该由谁拦 | 期望 |
 *   |---|---|---|---|---|
 *   | M1 | 平台判据出现**第二份实现**（proc.js 自己写 process.platform） | check-wb | §96 ① | BLOCKED |
 *   | M2 | killTree 的 Windows 分支被摘掉（taskkill 没了） | check-wb | §96 ③ | BLOCKED |
 *   | M3 | findBridgeProcesses 不再分派到 Windows 实现 | check-wb | §96 ④ | BLOCKED |
 *   | M4 | DOCKER_APP 写回无条件的 '/Applications/Docker.app' | check-wb | §96 ② | BLOCKED |
 *   | M5 | 根目录 .bat 里出现 label（LF 下 cmd 可能静默错读） | check-wb | §96 ⑥ | BLOCKED |
 *   | M6 | `absEntryInRoot` 被拆成**恒真**（窄例外变成对谁都说"是我们的"） | smoke | T-WIN1 / T-WIN4 | BLOCKED |
 *   | M7 | 「一键启动」的容器分支被**反转**（`IS_WIN` → `!IS_WIN`） | check-wb | §96 ⑤b | BLOCKED |
 *
 * 期望：七条全部 `BLOCKED`，`INVALID` 为 0。
 *
 * ⚠️ **M7 是第三轮补的**（用户追问"能不能按手册部署"时通读手册发现的真缺陷）：
 *    `apiOnekeyStart` 的**第一步**就是 `ensureDocker`，不 ok 直接 `return 400` ——
 *    而 Windows 上没有 Docker ⇒ 用户手册让 Windows 用户点的那个按钮**第一步就失败**。
 *    这正是「**文档写了一条走不通的路**」，而四层回归一条都不会响（那层跑在 macOS 上）。
 *
 * ⚠️ **首跑实测 4/6**，两条 NOT-BLOCKED 各自打出一个真问题（都留在原位当证据）：
 *    · **M2 打穿了 §96③** —— 第一版的判据是"分支里有 taskkill"，而那个分支里本来就有
 *      **两个**（`/T` 与 `/T /F`），删掉软的那个照样匹配 ⇒ 判据已收紧成"**先软后硬两条都在**"。
 *      （又一次证明：判"存在"会退化成假绿，要判**形状**。）
 *    · **M6 的第一版在这台机器上不可观测**（详见文件末尾那段），已换成恒真形态。
 *
 * ⚠️ 跑这一批必须带 `NODE_OPTIONS=` 前缀（R39）：本机 shell 注入的 `NODE_OPTIONS`
 *    会把 `err.code` 改写成 `CODEBUDDY_BROKER_DENY`，导致 smoke 基线不绿
 *    （T293/T296 因此假红）—— 而 `mutate` 会**正确地**拒绝开跑，人极容易读成"项目坏了"。
 * ⚠️ 若看到 `[safe-delete]`，那是沙箱的批量删除保护在冒充"被拦住"，换前台复跑再下结论。
 */

export default [
  {
    id: 'M1',
    note: '平台判据的第二份实现：proc.js 不 import IS_WIN，自己又写一遍 process.platform —— 散开之后没人答得上"哪几处会按平台走"',
    file: 'panel/lib/proc.js',
    anchor: /^  if \(IS_WIN\) return null;$/m,
    count: 1,
    apply: (s) => s.replace(
      '  if (IS_WIN) return null;',
      "  if (process.platform === 'win32') return null; // 变异：第二份平台判据"
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M2',
    note: 'killTree 的 Windows 分支被摘掉 —— 负 pid 在那边不支持 ⇒ 清理静默退化成"只杀单进程"，端口被僵尸占住而清理报成功',
    file: 'panel/lib/proc.js',
    anchor: /^    await sh\('taskkill', \['\/PID', String\(pid\), '\/T'\], 5000\);$/m,
    count: 1,
    apply: (s) => s.replace(
      "    await sh('taskkill', ['/PID', String(pid), '/T'], 5000);",
      '    // 变异：Windows 分支不干活了'
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M3',
    note: 'findBridgeProcesses 不再分派到 Windows 实现 —— 那边会去跑不存在的 pgrep/lsof，候选池恒空（实例数恒 0、「停止机器人」点了没反应）',
    file: 'panel/server.js',
    anchor: /^  if \(IS_WIN\) return findBridgeProcessesWin\(exceptPids\);$/m,
    count: 1,
    apply: (s) => s.replace(
      '  if (IS_WIN) return findBridgeProcessesWin(exceptPids);',
      '  // 变异：不分派到 Windows 实现'
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M4',
    note: 'DOCKER_APP 写回无条件的 /Applications/Docker.app —— Windows 上会去 open 一个不存在的路径，一键启动卡到超时',
    file: 'panel/lib/paths.js',
    anchor: /^export const DOCKER_APP = DOCKER_APP_CANDIDATES\.find\(\(p\) => p && fs\.existsSync\(p\)\)\n  \|\| \(IS_WIN \? '' : '\/Applications\/Docker\.app'\);$/m,
    count: 1,
    apply: (s) => s.replace(
      "export const DOCKER_APP = DOCKER_APP_CANDIDATES.find((p) => p && fs.existsSync(p))\n  || (IS_WIN ? '' : '/Applications/Docker.app');",
      "export const DOCKER_APP = '/Applications/Docker.app'; // 变异：平台分支被抹平"
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M5',
    note: '.bat 里出现 label/goto —— 那类结构在 LF 换行下可能被 cmd 静默错读，而本仓不许把 .bat 改成 CRLF',
    file: 'QQ-BOT-CONTROL.bat',
    anchor: /^@echo off$/m,
    count: 1,
    apply: (s) => s.replace('@echo off', '@echo off\ngoto :RUN\n:RUN'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M6',
    note: 'absEntryInRoot 被拆成恒真（"拿不到 cwd"的窄例外变成对谁都说"是我们的"）—— 判据被拆成恒真，于是误杀方向彻底打开',
    file: 'src/bridge-proc.js',
    anchor: /^  return pathEq\(t, p\.join\(r, 'src', 'index\.js'\)\);$/m,
    count: 1,
    apply: (s) => s.replace(
      "  return pathEq(t, p.join(r, 'src', 'index.js'));",
      '  return true; // 变异：判据被拆成恒真'
    ),
    layer: 'smoke',
    expect: 'BLOCKED',
  },
  {
    id: 'M7',
    note: '「一键启动」的容器分支被**反转**（if (IS_WIN) → if (!IS_WIN)）—— Windows 上退回"无条件先 ensureDocker"，点「一键启动」第一步就 400 失败；而 macOS 上一切照旧 ⇒ 四层回归全绿',
    file: 'panel/server.js',
    anchor: /if \(IS_WIN\) \{\n    say\('· Windows 走原生 NapCat（不用 Docker）：跳过容器这一步'\);/,
    count: 1,
    apply: (s) => s.replace(
      "if (IS_WIN) {\n    say('· Windows 走原生 NapCat（不用 Docker）：跳过容器这一步');",
      "if (!IS_WIN) {\n    say('· Windows 走原生 NapCat（不用 Docker）：跳过容器这一步');"
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
];

// ⚠️ **M6 的第一版是"删掉 `if (!(path.isAbsolute(t) || WIN_ABS_RE.test(t))) return false;` 这一行"**
//    —— 它跑出来是 `NOT-BLOCKED`，而**那不是说断言坏了**，是说那条变异**在这台机器上不可观测**：
//    删掉守卫之后，末端的 `pathEq(t, <root>/src/index.js)` 仍然会否掉相对入口，
//    因为 `path.win32.resolve('src\\index.js')` 用的是**本进程的 cwd**（在 macOS 上是个 POSIX 路径）。
//    ⚠️ 而在一台**真的 Windows** 上，面板的 cwd 就是仓库根 ⇒ 那一行会**意外相等** ⇒
//       相对入口被误认成"我们的"（且结果取决于**面板从哪儿被启动**，是个非确定行为）。
//    ⇒ 守卫是**负载的**（它让判定与面板 cwd 无关），只是它的效果在 macOS 上看不见。
//    这正是"本机没有 Windows"的代价，如实写在这里，别假装那个守卫被验过。
//    改成"恒真"之后，效果在任何平台上都可见（误杀方向），所以它是一条**有效的**变异。
