/**
 * D19（实例互斥锁 + 启动/崩溃留档 · 报告 E19/E20）的变异清单 —— 纯数据，供
 * `node scripts/mutate.mjs test/mutations/d19.mjs` 复跑。
 *
 * 为什么每一步都要配变异：锁的**每一格判错都是静默的** ——
 *   判宽了（把活着的实例当残留）→ 双开，两个进程抢同一条群消息；
 *   判窄了（把残留锁当占用）→ 机器人起不来，用户只看到"点了启动没反应"。
 * 两种都不会让别的门响。所以这一组同时打"判据"与"接线位置"。
 *
 *   | 组 | 打的是 | 该由哪一层拦住 |
 *   |---|---|---|
 *   | M1–M2 | 判据层不许长依赖 / 不许自己碰文件 | check-wb §43 |
 *   | M3 | 占锁必须排在"清扫"之前（早占位、早拒绝） | check-wb §43 |
 *   | M4–M5 | 心跳用叶子里的常量 + unref | check-wb §43 |
 *   | M6 | 崩溃留档**不许**改崩溃语义（装了监听器就必须自己 exit） | check-wb §43 |
 *   | M7 | 三件套（沙箱排除） | check-wb §43 |
 *   | M8 | 面板**只读**：不许写/删锁（Q19 否认过"强制接管"） | check-wb §43 |
 *   | M9 | 页面不许写死"被拒"的退出码（它是 src 那边定义的） | check-wb §43 |
 *   | M10 | 存活判据：只有 ESRCH 算死（EPERM/未知都算活） | smoke |
 *   | M11 | 心跳陈旧是边界判据（差 1ms 不算陈旧） | smoke |
 *   | M12 | 释放：不是自己的 pid 绝不 unlink | smoke |
 *   | M13 | 拒绝时**一个字节都不写**（顶掉别人的锁就是双开） | smoke |
 *   | M14 | 拒绝必须**真的退出**（不退出就等于放行 → 双开） | smoke |
 *
 * 期望：十四条全部 `BLOCKED`，`INVALID` 为 0。
 *
 * ⚠️ M10–M14 都在 smoke 层。跑这一批时若看到 `自测异常` 里带 `[safe-delete]`，
 *    那是**沙箱的批量删除保护**在冒充"被拦住"（不是断言失败）——
 *    必须换**前台 + 非沙箱**复跑同一组再下结论（D6b 那一批实测踩过）。
 */

export default [
  {
    id: 'M1',
    note: '判据层长出依赖（"接管矩阵"就再也没法逐格喂反例了）',
    file: 'src/bridge-lock.js',
    anchor: /export const LOCK_HEARTBEAT_MS = 45 \* 1000;/,
    count: 1,
    apply: (s) => s.replace(
      'export const LOCK_HEARTBEAT_MS = 45 * 1000;',
      "import fs from 'node:fs'; // 变异：叶子不许有依赖\n\nexport const LOCK_HEARTBEAT_MS = 45 * 1000;"
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M2',
    note: '判据层自己碰文件（锁的 IO 必须由入参给，否则只能起两个真进程去测死锁）',
    file: 'src/bridge-lock.js',
    anchor: /export const LOCK_STALE_MS = 2 \* LOCK_HEARTBEAT_MS;/,
    count: 1,
    apply: (s) => s.replace(
      'export const LOCK_STALE_MS = 2 * LOCK_HEARTBEAT_MS;',
      "const TOUCHES_FS = () => fs.statSync('/tmp'); // 变异：叶子碰了文件系统\n\nexport const LOCK_STALE_MS = 2 * LOCK_HEARTBEAT_MS;"
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M3',
    note: '占锁挪到清扫**之后**（被拒时先去替"上一次运行"收拾残局 —— 晚占位、晚拒绝）',
    file: 'src/index.js',
    anchor: /  const lockOut = await acquireLock\(\{/,
    count: 1,
    apply: (s) => {
      const from = s.indexOf('  const lockOut = await acquireLock({');
      const to = s.indexOf('  // 清扫"属主已死"的原子写临时文件');
      const dest = s.indexOf('  clearStaleThinking();');
      if (from < 0 || to < 0 || dest < 0 || to < from || dest < to) return s; // 锚点不在 → 命中数校验兜住
      const block = s.slice(from, to);
      const rest = s.slice(0, from) + s.slice(to);
      const at = rest.indexOf('  clearStaleThinking();');
      return rest.slice(0, at) + block + rest.slice(at);
    },
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M4',
    // ⚠️ **2026-10-05（第 7 轮）重锚**：心跳从"内联匿名箭头 + 收尾 `}, LOCK_HEARTBEAT_MS);`"
    //    改成了**具名回调**（`setInterval(() => { heartbeatStep(); }, LOCK_HEARTBEAT_MS);`）——
    //    回调体搬进 `heartbeatStep()` 是为了让 `§43⑤` 那条"短形状窗口"
    //    （`setInterval([\s\S]{0,400}}, LOCK_HEARTBEAT_MS)`）不被撑爆
    //    （见 `src/index.js` 那一行上方的注释）。判据一个字没改，锚点得跟着搬。
    note: '心跳间隔抄成字面量（叶子里的常量从此没人消费，改它不再生效）',
    file: 'src/index.js',
    anchor: /const heartbeat = setInterval\(\(\) => \{ heartbeatStep\(\); \}, LOCK_HEARTBEAT_MS\);/,
    count: 1,
    apply: (s) => s.replace('}, LOCK_HEARTBEAT_MS);', '}, 45000);'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M5',
    note: '心跳不 unref（一个心跳成了"这个进程还不能退出"的理由）',
    file: 'src/index.js',
    anchor: /  heartbeat\.unref\(\);\n/,
    count: 1,
    apply: (s) => s.replace('  heartbeat.unref();\n', ''),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M6',
    note: '崩溃留档不再 exit —— 装了监听器之后 Node 不再自动退出，这就变成了"吞掉异常继续跑"',
    file: 'src/index.js',
    anchor: /    releaseOwnLock\(kind\);\n    process\.exit\(1\);\n/,
    count: 1,
    apply: (s) => s.replace('    releaseOwnLock(kind);\n    process.exit(1);\n', '    releaseOwnLock(kind);\n'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M7',
    // ⚠️ **2026-10-05（第 7 轮）重锚**：排除项从 `'panel/.bridge.lock'` 换成了
    //    **带星号的 `'panel/.bridge.lock*'`**（[W1] 修法：它要同时盖住
    //    独占提交的临时文件 `.bridge.lock.<pid>.<hex>.tmp` 与回收令牌 `.reclaim`，
    //    见 `check-wb` §43⑧ 的注释）。判据同时盯 `.gitignore` 与 `sandbox.sh` 两处，
    //    一个字没改；锚点得跟着当前形态走。
    note: '三件套缺一件：沙箱不排除锁（沙箱里造的锁会顶掉真机那份，真机器人下次心跳静默放弃续期）',
    file: 'test/sandbox.sh',
    anchor: /  --exclude 'panel\/\.bridge\.lock\*' \\\n/,
    count: 1,
    apply: (s) => s.replace("  --exclude 'panel/.bridge.lock*' \\\n", ''),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M8',
    note: '面板开始删锁 —— Q19 明确否认过「强制接管」（删锁重启是危险动作，交脚本或人工）',
    file: 'panel/server.js',
    anchor: /    const lock = parseLock\(fs\.readFileSync\(BRIDGE_LOCK_FILE, 'utf8'\)\);/,
    count: 1,
    apply: (s) => s.replace(
      "    const lock = parseLock(fs.readFileSync(BRIDGE_LOCK_FILE, 'utf8'));",
      "    fs.unlinkSync(BRIDGE_LOCK_FILE); // 变异：面板删锁\n    const lock = parseLock(fs.readFileSync(BRIDGE_LOCK_FILE, 'utf8'));"
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  // ⚠️ S-12 第五批（2026-10-05）：原 M9（打 panel/parts/14-script.html）已**退役** ——
  //    它对应的旧页判据随旧页下线，且该关切在现役控制台没有等价判据。
  //    去向登记在 docs/S12-CONTRACT-MIGRATION-1005.md §十三。
  {
    id: 'M10',
    note: '存活判据收窄成"只有 EPERM 算活"（未知 errno 被判成死 → 去抢一个说不清的进程的锁）',
    file: 'src/bridge-lock.js',
    anchor: /    return !\(e && e\.code === 'ESRCH'\);/,
    count: 1,
    apply: (s) => s.replace(
      "    return !(e && e.code === 'ESRCH');",
      "    return !!(e && e.code === 'EPERM');"
    ),
    layer: 'smoke',
    expect: 'BLOCKED',
  },
  {
    id: 'M11',
    note: '心跳陈旧的边界写成 `>`（"恰好到阈值"不算陈旧 → 静默多接管一档）',
    file: 'src/bridge-lock.js',
    anchor: /  return now - lock\.beatAt >= staleMs;/,
    count: 1,
    apply: (s) => s.replace('return now - lock.beatAt >= staleMs;', 'return now - lock.beatAt > staleMs;'),
    layer: 'smoke',
    expect: 'BLOCKED',
  },
  {
    id: 'M12',
    note: '释放锁时不再校验 pid（会删掉**别人的**锁 → 第三个实例又能起来，双开）',
    file: 'src/bridge-lock.js',
    anchor: /  if \(lock\.pid !== Number\(ownPid\)\) return \{ released: false, reason: `锁不是本进程的（pid \$\{lock\.pid\}）—— 不删别人的锁` \};/,
    count: 1,
    apply: (s) => s.replace(
      'if (lock.pid !== Number(ownPid)) return { released: false, reason: `锁不是本进程的（pid ${lock.pid}）—— 不删别人的锁` };',
      'if (false) return { released: false, reason: `锁不是本进程的（pid ${lock.pid}）—— 不删别人的锁` };'
    ),
    layer: 'smoke',
    expect: 'BLOCKED',
  },
  {
    id: 'M13',
    note: '被拒时也把锁写了一遍（顶掉别人的锁就是双开 —— 而且那个持锁的进程还在跑）',
    file: 'src/bridge-lock.js',
    anchor: /  if \(d\.action === 'refuse'\) return \{ ok: false, action: 'refuse', reason: d\.reason, body: null, tookOver: false \};/,
    count: 1,
    apply: (s) => s.replace(
      "  if (d.action === 'refuse') return { ok: false, action: 'refuse', reason: d.reason, body: null, tookOver: false };",
      "  if (d.action === 'refuse') { writeRec(lockBodyOf({ pid: ownPid, at: now, beatAt: now })); return { ok: false, action: 'refuse', reason: d.reason, body: null, tookOver: false }; }"
    ),
    layer: 'smoke',
    expect: 'BLOCKED',
  },
  {
    id: 'M14',
    note: '被拒时不退出（只是 return）—— 等于放行：真双开，两个进程都连上 QQ',
    file: 'src/index.js',
    anchor: /    process\.exit\(LOCK_REFUSE_EXIT_CODE\);/,
    count: 1,
    apply: (s) => s.replace('    process.exit(LOCK_REFUSE_EXIT_CODE);', '    return; // 变异：不退出'),
    layer: 'smoke',
    expect: 'BLOCKED',
  },
];
