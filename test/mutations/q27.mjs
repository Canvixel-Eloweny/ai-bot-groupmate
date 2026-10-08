/**
 * Q27 批（D19 覆盖缺口三件 + 顺手件，2026-09-30）的变异清单 —— 纯数据，供
 * `node scripts/mutate.mjs test/mutations/q27.mjs` 复跑。
 *
 * 每条对应本批新增的一道判据（契约 §43 ⑬⑭⑮ / smoke T333–T337），"只打它那一条"：
 *
 *   | 组  | 打的是 | 该由哪一层拦住 |
 *   |---|---|---|
 *   | M1  | journal('start') 拿掉 lockNote（留档看不出这次怎么拿到的锁） | check-wb §43 ⑬ |
 *   | M2  | lockNote 定义不再带 lockOut.reason（结论只剩空壳标签） | check-wb §43 ⑬ |
 *   | M3  | 留档不再折半（bridge-journal.log 无限长大） | check-wb §43 ⑭ |
 *   | M4  | 探针不再复用 isOurBridge（判据写了第二份） | check-wb §43 ⑮ |
 *   | M5  | isOurs 没接 probeIsOurBridge（探针定义了没接上） | check-wb §43 ⑮ |
 *   | M6  | "锁损坏"理由被吞（接管理由与"没有锁"混成一句） | smoke T333 |
 *   | M7  | shutdown 不再写 exit 留档（"正常退出过"查无痕迹） | smoke T335 |
 *   | M8  | fatal 退出码变 0（崩溃与正常退出分不开） | smoke T336 |
 *
 * 期望：八条全部 `BLOCKED`，`INVALID` 为 0。
 *
 * ⚠️ 迭代记录：M2 第一版 NOT-BLOCKED —— ⑬ 切固定 300 字符窗口，被窗口内**别处**的合法
 *    `lockOut.reason`（refuse 留档行）冒充 → 契约已收窄为"只切定义语句本身"
 *    （与"判据口径按语义边界切"同族）。M7 第一版（shutdown 不释放锁）NOT-BLOCKED ——
 *    `process.on('exit')` 兜底那处仍会释放，T335 分不出两条释放路径 → 换成"不写 exit
 *    留档"（兜底帮不上；§43⑦ 有第二处 `journal('exit'`（锁易主自逐）顶着，不会两片一起红）。
 *
 * ⚠️ T334（探针真路径）没有专属变异：它验的是"真 pgrep/lsof 打活进程"这条集成路径，
 *    生产侧的形状漂移由 M4/M5（契约层）负责拦。
 * ⚠️ 跑测试一律 `NODE_OPTIONS= node …`（R39）。
 */

export default [
  {
    id: 'M1',
    note: "journal('start') 拿掉 lockNote（契约切的是那一处调用本身）",
    file: 'src/index.js',
    anchor: /^    \+ ` · 锁=\$\{lockNote\}`\);$/m,
    count: 1,
    apply: (s) => s.replace(
      '    + ` · 锁=${lockNote}`);',
      '    + `（锁的结论被拿掉了）`); // 变异：start 行不带锁的结论'
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M2',
    note: 'lockNote 定义不再带 lockOut.reason（结论只剩空壳标签）',
    file: 'src/index.js',
    anchor: /const lockNote = lockOut\.degraded/,
    count: 1,
    apply: (s) => s.replace(
      /const lockNote = lockOut\.degraded \? `degraded（写不进锁：\$\{lockOut\.reason\}）` : `已持有（\$\{lockOut\.reason\}）`;/,
      "const lockNote = lockOut.degraded ? 'degraded' : '已持有'; // 变异：结论不带理由"
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M3',
    note: '留档不再折半（bridge-journal.log 无限长大，且无人报）',
    file: 'src/index.js',
    anchor: /^    truncateLinesAtomic\(JOURNAL_FILE, JOURNAL_MAX_LINES\);$/m,
    count: 1,
    apply: (s) => s.replace(
      '    truncateLinesAtomic(JOURNAL_FILE, JOURNAL_MAX_LINES);',
      '    // 变异：留档不再折半'
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M4',
    note: '探针不再复用 isOurBridge（判据写了第二份，R13 的复发形态）',
    file: 'src/bridge-io.js',
    anchor: /^  return isOurBridge\(\{ cmd: hit\.cmd, cwd: firstPathOf\(cwd\.out\), execPath: firstPathOf\(txt\.out\), root: ROOT \}\)\.ours;$/m,
    count: 1,
    apply: (s) => s.replace(
      '  return isOurBridge({ cmd: hit.cmd, cwd: firstPathOf(cwd.out), execPath: firstPathOf(txt.out), root: ROOT }).ours;',
      '  return /index\\.js$/.test(hit.cmd); // 变异：探针自己抄一份判据'
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M5',
    note: 'isOurs 没接 probeIsOurBridge（探针定义了却没接上）',
    file: 'src/index.js',
    anchor: /^    isOurs: \(pid\) => probeIsOurBridge\(pid\),$/m,
    count: 1,
    apply: (s) => s.replace(
      '    isOurs: (pid) => probeIsOurBridge(pid),',
      '    isOurs: () => null, // 变异：探针没接上'
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M6',
    note: '"锁损坏"理由被吞（接管理由与"没有锁"混成一句，排障时以为锁从来不存在）',
    file: 'src/bridge-lock.js',
    anchor: /^  const reason = broken \? '锁损坏（读不出 pid），已接管' : d\.reason;$/m,
    count: 1,
    apply: (s) => s.replace(
      "  const reason = broken ? '锁损坏（读不出 pid），已接管' : d.reason;",
      '  const reason = d.reason; // 变异：锁损坏不再如实说'
    ),
    layer: 'smoke',
    expect: 'BLOCKED',
  },
  {
    id: 'M7',
    note: 'shutdown 不再写 exit 留档（"正常退出过"查无痕迹；§43⑦ 另有「锁易主自逐」那处顶着，只有 smoke 会响）',
    file: 'src/index.js',
    anchor: /^    journal\('exit', `收到 \$\{sig\}，正常退出`\);$/m,
    count: 1,
    apply: (s) => s.replace(
      "    journal('exit', `收到 ${sig}，正常退出`);",
      '    // 变异：正常退出不留档'
    ),
    layer: 'smoke',
    expect: 'BLOCKED',
  },
  {
    id: 'M8',
    note: 'fatal 退出码变 0（崩溃与正常退出分不开，面板把"崩了"显示成"好好退了"）',
    file: 'src/index.js',
    anchor: /^    releaseOwnLock\(kind\);\n    process\.exit\(1\);$/m,
    count: 1,
    apply: (s) => s.replace(
      '    releaseOwnLock(kind);\n    process.exit(1);',
      '    releaseOwnLock(kind);\n    process.exit(0); // 变异：崩溃变成"正常退出"'
    ),
    layer: 'smoke',
    expect: 'BLOCKED',
  },
];
