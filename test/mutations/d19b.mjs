/**
 * D19 的 W1 / W2 修复 —— 变异清单（2026-09-29 · 外包任务1 复核证实后修）
 *
 * 背景：外包任务1（对话1）独立复核 **证实** 了我方此前登记的两处薄弱点（Q26）：
 *   W1 占锁非原子（TOCTOU）—— 8 进程对齐启动实测 **6/6 轮双抢**；
 *   W2 丢锁后静默 —— 旧实例既不写、也不报错、也不退出，继续连着 QQ 说话。
 * 用户 2026-09-29 裁决：**W1 + W2 都修**。本清单盯的就是这次修复的六处落点。
 *
 * 期望：六条**全部 BLOCKED**。
 *
 * ⚠️ 与外包那份清单的区别：它的三条是 `expect: NOT-BLOCKED`（**假绿证据**，用来坐实缺口），
 *    本组是常规方向（改动应当被拦住）—— 缺口关上之后，防线必须真的有牙。
 */

export default [
  {
    id: 'W1a',
    note: 'index.js 不再注入 claimRec（判据写好了却没接上 = 等于没修：又回到"读→判→覆盖写"）',
    file: 'src/index.js',
    anchor: /claimRec: \(body\) => linkExclusiveSync\(LOCK_FILE/,
    count: 1,
    apply: (s) => s.replace(/claimRec: \(body\) => linkExclusiveSync\(LOCK_FILE[^\n]*\n/, ''),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'W1b',
    note: 'EEXIST 分支被拿掉（后到的那个"照写不误"）—— 双抢回来的原形态',
    file: 'src/bridge-lock.js',
    anchor: /    if \(e && e\.code === 'EEXIST'\) \{/,
    count: 1,
    apply: (s) => s.replace("    if (e && e.code === 'EEXIST') {", "    if (false) { // 变异：EEXIST 不再被认成'输'"),
    layer: 'smoke',
    expect: 'BLOCKED',
  },
  {
    id: 'W1d',
    note: '接管路径不再二次验旧（verify 恒真）—— 令牌释放后才出手的迟到者会盖掉刚写好的新锁',
    file: 'src/bridge-lock.js',
    anchor: /\(bd\) => reclaimRec\(bd, verifyUnchanged\)/,
    count: 1,
    // ⚠️ 这里**不许**加尾随注释：原式嵌在三元的中间，一行注释会把后面的 `: writeRec)` 一起吃掉（语法崩）
    apply: (s) => s.replace('(bd) => reclaimRec(bd, verifyUnchanged)', '(bd) => reclaimRec(bd, () => true)'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'W2a',
    note: '心跳不再接住返回值（丢锁又变成"静默放弃" —— 正是 W2 要消灭的形态）',
    file: 'src/index.js',
    anchor: /    const hb = heartbeatLock\(\{/,
    count: 1,
    apply: (s) => s.replace('    const hb = heartbeatLock({', '    heartbeatLock({ // 变异：不再看返回值'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'W2b',
    note: '自逐的判定改回"比中文文案"（调用方拿文案当枚举 —— D9 就踩过的那条）',
    file: 'src/index.js',
    anchor: /    if \(hb\.kind !== 'not-owner'\) return;/,
    count: 1,
    apply: (s) => s.replace(
      "    if (hb.kind !== 'not-owner') return;",
      "    if (hb.reason === '锁写不进去') return; // 变异：改回按文案分支"
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'W2c',
    note: '两拍确认被拿掉（单拍误读 —— 换 inode 那一瞬 —— 会把好实例打掉）',
    file: 'src/index.js',
    anchor: /    if \(!lostBeatOnce\) \{\n/,
    count: 1,
    apply: (s) => s.replace(
      "    if (!lostBeatOnce) {\n      lostBeatOnce = true;\n      log.warn(`启动锁疑似易主（${hb.reason}）—— 下一拍再确认一次`);\n      return;\n    }\n",
      ''
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
];
