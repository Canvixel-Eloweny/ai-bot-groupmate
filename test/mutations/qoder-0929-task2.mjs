/**
 * 任务2 v1 · 契约段补审的变异清单 —— 纯数据，供
 *   `node scripts/mutate.mjs <本文件>`（健康仓）复跑。
 *
 * 覆盖：§38（状态注入行 · D12a）· §40（收藏表情 · D14）· §41（插话时机 · D12b）
 *      · §42（控制通道 · D6b）· §43（实例互斥锁 · D19）—— 每段"只打一条"，
 *      外加三条**假绿通道实证**（G-*，证明"现行判据拦不住"的形状）。
 *
 * 期望：
 *   · C38 / C40 / C41 / C42 / C43 —— **BLOCKED**（且各自只红目标段）；
 *   · G-43-KILL / G-42-EXEC / G-40-ANCHOR —— **原先是 NOT-BLOCKED**（残余假绿通道）。
 *     2026-09-29 我方已收下 P1/P2/P3 三份加严补丁，三条**翻成 BLOCKED**。
 *     保留它们 = 把"这三类判据形状"钉成可复跑的回归。
 *
 * ⚠️ 本清单按**健康仓**设计（plugins/ 与 docs/PUBLISH-CHECKLIST.md 在位）。
 *    在发布拷贝上这两个输入被有意剥离 → check-wb 会在第 34 节崩、smoke 有 5 条
 *    环境性红 → `mutate.mjs` 的"基线必须全绿"门禁会拒跑。那种环境下改用等效差分法
 *    （先取各层基线红集，再逐条变异、比"新增红"，见回执 §7）。
 *
 * ⚠️ 关于 C38：它的目标判据（check-wb §38）依赖 `plugins/本体情绪/`，发布拷贝不可跑；
 *    健康仓里由 §38-③（桥）+ smoke T236/T240 双处拦住。本次在发布拷贝上实测到的
 *    等效证据是 §4（提示词前缀结构）与行为层同因变红。
 */

export default [
  {
    id: 'C38',
    note: '§38 落位桥：brain 改了时间行前缀（状态行把"时间行之前"锚不上）—— §38-③ / T236 / §4 应红',
    file: 'src/brain.js',
    anchor: /volatileSec\.lines\.push\(`当前时间：\$\{new Date\(now\)/,
    count: 1,
    apply: (s) => s.replace('`当前时间：${new Date(now)', '`此刻时间：${new Date(now)'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'C40',
    note: '§40 出站分流：认不出的令牌不再丢掉（classifySegments 的 filter(Boolean) 被换成恒真）—— §40-② 应红',
    file: 'src/face-marks.js',
    anchor: /export function classifySegments/,
    count: 1,
    apply: (s) => {
      const i = s.indexOf('export function classifySegments');
      const j = s.indexOf('.filter(Boolean);', i);
      if (i < 0 || j < 0) return s; // 命中数校验兜不住这里 → 内容不变会被判 INVALID
      return s.slice(0, j) + '.filter(() => true); // 变异：认不出的令牌不再被丢掉' + s.slice(j + '.filter(Boolean);'.length);
    },
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'C41',
    note: '§41 掷骰子绕过因子（plan.chance → trigger.interjectChance）—— §41-② 反向判据应红',
    file: 'src/brain.js',
    anchor: /if \(roll < plan\.chance\) return ok\('interject', '随机插话', plan\);/,
    count: 1,
    apply: (s) => s.replace('if (roll < plan.chance) return ok(', 'if (roll < trigger.interjectChance) return ok('),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'C42',
    note: '§42 过期命令不再写回"已忽略 + 原因"（面板永远显示"等待执行"）—— 行为层 T265 应红',
    file: 'src/control-channel.js',
    anchor: /      writeRec\(\{ \.\.\.rec, done: controlDoneOf\(\{ ok: false, msg: d\.reason, at: now, pid \}\) \}\);\n/,
    count: 1,
    apply: (s) => s.replace(
      '      writeRec({ ...rec, done: controlDoneOf({ ok: false, msg: d.reason, at: now, pid }) });\n',
      '      // 变异：过期不写回（面板看不到"已忽略"）\n'
    ),
    layer: 'smoke',
    expect: 'BLOCKED',
  },
  {
    id: 'C43',
    note: '§43 退出兜底被删（锁的释放只剩 SIGINT/SIGTERM 两条路）—— §43-④ 应红',
    file: 'src/index.js',
    anchor: /process\.on\('exit', \(\) => \{ releaseOwnLock\('进程退出'\); \}\);\n/,
    count: 1,
    apply: (s) => s.replace("process.on('exit', () => { releaseOwnLock('进程退出'); });\n", ''),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'G-43-KILL',
    note: '假绿通道实证：叶子长出第二处 process.kill（自己操刀 SIGKILL）—— 现行 §43-① 的禁字表不含 process.kill，拦不住',
    file: 'src/bridge-lock.js',
    anchor: /export function pidAliveOf\(pid, \{ kill = process\.kill \} = \{\}\) \{/,
    count: 1,
    apply: (s) => s.replace(
      'export function pidAliveOf(pid, { kill = process.kill } = {}) {',
      "/** 变异：叶子自己操刀（不再是'只做探测'的判据层）。 */\n"
        + "const forceKill = (pid) => process.kill(pid, 'SIGKILL');\n\n"
        + 'export function pidAliveOf(pid, { kill = process.kill } = {}) {'
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'G-42-EXEC',
    note: '假绿通道实证：轮询挂上了但执行体被换成桩（命令没真执行）—— T267 只钉"通道 + 写回"，钉不住 exec 接线',
    file: 'src/index.js',
    anchor: /\n        exec: runControlCommand,\n/,
    count: 1,
    apply: (s) => s.replace(
      '\n        exec: runControlCommand,\n',
      "\n        exec: () => ({ ok: true, msg: '已执行' }),\n"
    ),
    layer: 'smoke',
    expect: 'BLOCKED',
  },
  {
    id: 'G-40-ANCHOR',
    note: '假绿通道实证：令牌判据的锚被拿掉（^…$ → 无锚）—— §40-⑥ 与 T243 的样本都不含"尾部带垃圾"形态，拦不住',
    file: 'src/custom-faces.js',
    anchor: /\/\^\[0-9a-f\]\{8\}\$\//,
    count: 1,
    apply: (s) => s.replace('/^[0-9a-f]{8}$/', '/[0-9a-f]{8}/'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
];
