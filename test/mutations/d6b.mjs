/**
 * D6b（控制通道：面板 → 机器人的命令文件轮询 · Q7 裁决①）的变异清单 —— 纯数据，供
 * `node scripts/mutate.mjs test/mutations/d6b.mjs` 复跑。
 *
 * 背景：这条通道**唯一的失败形态是静默的** —— 命令没被执行，而用户只看到"点了没反应"
 * （文件里躺着一条 `done: null`）。纯函数判据全对、面板也把文件写下去了、四层回归全绿，
 * 坏的可以只是**中间那根线**。所以这一组变异一半打在"接线"上：
 *
 *   | 组 | 打的是 | 该由哪一层拦住 |
 *   |---|---|---|
 *   | M1–M2 | 判据层不许长依赖 / 不许自己碰 IO | check-wb §42 |
 *   | M3    | 命令 → 动作的映射漏掉一个动词 | check-wb §42 |
 *   | M4 ★  | **中止只有一份实现**（信号与命令通道共用） | check-wb §42 |
 *   | M5    | 轮询真的挂在启动路径上（间隔不许抄成字面量） | check-wb §42 |
 *   | M6    | 三件套（沙箱排除） | check-wb §42 |
 *   | M7    | 面板侧不许自抄一份命令集合 | check-wb §42 |
 *   | M8    | 页面读的是后端下发的中文名表（**只有行为层拦得住**） | panel §Y |
 *   | M9–M11 | 有效期边界 / done 闸 / 闭集合（都有两层） | smoke + check-wb §42 |
 *   | M12   | 写回前复核 id（竞态不许覆盖新命令） | smoke |
 *   | M13   | 写路由已登记（漏登记＝漏一次鉴权与审计） | check-wb §42 |
 *
 * 期望：十二条全部 `BLOCKED`，`INVALID` 为 0。
 *   ⚠️ **2026-10-05 订正**：原文写"十三条"，而 M8 已在 S-12 第五批退役（旧页对象下线）
 *      —— 文件里实际是 12 条。本轮顺手订正分母（本项目第 57 条：分母也会腐烂）。
 *
 * ⚠️ **2026-10-05（第 7 轮 · 变异锚点修复）**：M1 / M7 重锚，起因是**同一件事故** ——
 *    Q12 裁决①往控制通道里加了 `sleep` / `wake` 两个动词与两个中文名，
 *    而这两条把"闭集合当前有哪几个成员"**逐字写进了锚点** ⇒ 命中 0 → INVALID。
 *    ⇒ 判据一个字都没改（"叶子不许长依赖" / "面板不许自抄一份命令集合"），
 *      锚点改成锚**声明的形状**（`= [ … ];` / `= { … };`）。
 *      这两条要证明的命题与"今天有哪几个动词"无关 —— 把成员表写进锚点，
 *      等于每加一个动作就要来修一次变异（而它一次都不会报警，只会静默变 INVALID）。
 *
 * ⚠️ M8 是**故意只打行为层**的：契约那一条（"页面有没有从下发的表取名字"）在
 *    `bridgeCmd` 里还留着同一个模式，所以它照样绿。这一组要证明的是
 *    **面板断言本身有牙** —— 只靠契约的话，把 paintControl 换成写死的名字没人会发现。
 */

export default [
  {
    id: 'M1',
    // ⚠️ **2026-10-05（第 7 轮）重锚 + 顺带放宽**：Q12 裁决①往闭集合里加了
    //    `sleep` / `wake`（"手动让它睡 / 叫它醒"），旧锚点把四个成员**逐字写死**
    //    于是命中 0 —— 判据（"叶子不许长依赖"）一个字都没变。
    //    ⇒ 这次锚点锚**声明形状**（`= [ … ];`）而不是成员表：这条变异要证明的是
    //      "往这个叶子里插一行 import 会被抓到"，与闭集合里今天有哪几个动词**无关**。
    //      本项目的教训原文：**锚点别写死"它今天长什么样"**（第 53 条 argv 那一课）。
    note: '判据层长出依赖（叶子被 import 之后就没人敢在测试里单独喂它反例）',
    file: 'src/control-channel.js',
    anchor: /export const CONTROL_KINDS = \[[^\]]*\];/,
    count: 1,
    apply: (s) => s.replace(
      /export const CONTROL_KINDS = \[[^\]]*\];/,
      (m) => `import fs from 'node:fs'; // 变异：叶子不许有依赖\n\n${m}`,
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M2',
    note: '判据层自己碰 IO（IO 必须全部由入参给，否则只能起一台真机器人才能测）',
    file: 'src/control-channel.js',
    anchor: /export const CONTROL_MAX_AGE_MS = 2 \* 60 \* 1000;/,
    count: 1,
    apply: (s) => s.replace(
      'export const CONTROL_MAX_AGE_MS = 2 * 60 * 1000;',
      "const TOUCHES_IO = () => fs.existsSync('/tmp'); // 变异：叶子碰了 IO\n\nexport const CONTROL_MAX_AGE_MS = 2 * 60 * 1000;"
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M3',
    note: '命令 → 动作的映射漏掉 retry（闭集合里的动词没人接，点了没反应）',
    file: 'src/index.js',
    anchor: /    if \(cmd === 'retry'\) return replayLastFailure\(\);\n/,
    count: 1,
    apply: (s) => s.replace("    if (cmd === 'retry') return replayLastFailure();\n", ''),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M4',
    note: '★ SIGUSR2 回调里内联第二份中止实现（信号与面板各走一套，两边迟早不一样）',
    file: 'src/index.js',
    anchor: /    const r = abortAllInFlight\(\);/,
    count: 1,
    apply: (s) => s.replace(
      '    const r = abortAllInFlight();',
      '    const live = sessionCtl.snapshot();\n'
        + '    for (const one of live) sessionCtl.abort(one.key);\n'
        + '    const r = { ok: live.length > 0, msg: `已中止 ${live.length} 个在途会话` };'
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M5',
    note: '轮询间隔抄成字面量（叶子里的那个常量从此没人消费，改它不再生效）',
    file: 'src/index.js',
    anchor: /setInterval\(\(\) => \{ void pollControl\(\); \}, CONTROL_POLL_MS\);/,
    count: 1,
    apply: (s) => s.replace('}, CONTROL_POLL_MS);', '}, 1500);'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M6',
    note: '三件套缺一件：沙箱不排除命令文件（测试造的命令会落进真机那份，下次启动被真机器人执行）',
    file: 'test/sandbox.sh',
    anchor: /  --exclude 'panel\/\.bridge-cmd\.json' \\\n/,
    count: 1,
    apply: (s) => s.replace("  --exclude 'panel/.bridge-cmd.json' \\\n", ''),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M7',
    // ⚠️ **2026-10-05（第 7 轮）重锚 + 顺带放宽**：与 M1 同一件事故 ——
    //    Q12 给 `CONTROL_LABELS` 也加了 `sleep` / `wake` 两个中文名，
    //    旧锚点把四对键值逐字写死 ⇒ 命中 0。判据（"面板侧不许自抄一份命令集合"）
    //    一个字都没改。锚点改成**表形状**（`= { … };`），成员增减不再咬它。
    //    ⚠️ 这个变异要证明的是"另起一份 LOCAL_KINDS 会被抓到" ——
    //      所以 `apply` 插的那份**故意**抄成员表（自抄一份的真实形态）。
    note: '面板侧自抄一份命令集合（漂了就是"面板认为能发、机器人认为不认识"）',
    file: 'panel/lib/control.js',
    anchor: /export const CONTROL_LABELS = \{[^}]*\};/,
    count: 1,
    apply: (s) => s.replace(
      /export const CONTROL_LABELS = \{[^}]*\};/,
      (m) => `const LOCAL_KINDS = ['abort', 'retry']; // 变异：自抄一份\n\n${m}`,
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  // ⚠️ S-12 第五批（2026-10-05）：原 M8（打 panel/parts/14-script.html）已**退役** ——
  //    它对应的旧页判据随旧页下线，且该关切在现役控制台没有等价判据。
  //    去向登记在 docs/S12-CONTRACT-MIGRATION-1005.md §十三。
  {
    id: 'M9',
    note: '有效期边界写成 >=（"恰好到上限"也判过期 → 静默缩短整条通道的寿命）',
    file: 'src/control-channel.js',
    anchor: /  if \(now - rec\.at > maxAgeMs\) \{/,
    count: 1,
    apply: (s) => s.replace('if (now - rec.at > maxAgeMs) {', 'if (now - rec.at >= maxAgeMs) {'),
    layer: 'smoke',
    expect: 'BLOCKED',
  },
  {
    id: 'M10',
    note: 'done 闸去掉（同一个文件被反复执行 —— 重启后 lastId 归零，就再没有第二道闸）',
    file: 'src/control-channel.js',
    anchor: /  if \(rec\.done\) \{/,
    count: 1,
    apply: (s) => s.replace('if (rec.done) {', 'if (false) { // 变异：去掉持久闸'),
    layer: 'smoke',
    expect: 'BLOCKED',
  },
  {
    id: 'M11',
    note: '闭集合放宽（任何动词都放行 —— 这条通道能改变机器人的行为，默认必须拒绝）',
    file: 'src/control-channel.js',
    anchor: /  if \(!CONTROL_KINDS\.includes\(rec\.cmd\)\) \{/,
    count: 1,
    apply: (s) => s.replace('if (!CONTROL_KINDS.includes(rec.cmd)) {', 'if (false) { // 变异：闭集合失效'),
    layer: 'smoke',
    expect: 'BLOCKED',
  },
  {
    id: 'M12',
    note: '写回前不复核 id（执行期间面板下发的新命令会被旧记录覆盖 → 新命令永远等不到结果）',
    file: 'src/control-channel.js',
    anchor: /  if \(curRec && curRec\.id === rec\.id\) \{/,
    count: 1,
    apply: (s) => s.replace('if (curRec && curRec.id === rec.id) {', 'if (true) { // 变异：不复核'),
    layer: 'smoke',
    expect: 'BLOCKED',
  },
  {
    id: 'M13',
    note: '命令写路由没登记进 WRITE_ROUTES（漏一次鉴权与审计；而处理器里也有同一个字面量会冒充它）',
    file: 'panel/server.js',
    anchor: /  '\/api\/bridge\/command',\n/,
    count: 1,
    apply: (s) => s.replace("  '/api/bridge/command',\n", ''),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
];
