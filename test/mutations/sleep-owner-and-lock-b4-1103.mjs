/**
 * 批 B6（自锁 pid 撞号 → 退出码 3）定向变异（2026-11-03）。
 *
 * 修的是群友 0.1.4 审计报告 BUG-02，对回 0.1.7 仍开着：
 * `acquireLock` 只在启动时调用一次 ⇒ 本进程不可能已经写过锁 ⇒ "锁里就是本进程 pid"
 * 只有一种来源：上一轮残留与我们的 pid 撞了号。旧实现把它归入 `hold` 却继续往下走
 * 独占 `claimRec` ⇒ 文件已存在 ⇒ EEXIST ⇒ 重判仍 hold ⇒ 拒绝启动、退出码 3，
 * 而进程表里根本没有第二个实例 —— 只能人工删 `.bridge.lock`。
 *
 * ⚠️ 同一批里原本还有一条"睡眠门禁主人豁免"（BUG-12），**已回退**：
 *    实跑 smoke 时 T342 变红 —— 豁免会短路掉刻意设计的紧急唤醒
 *    （私聊连发 N 条 ⇒ emergency override ⇒ 落盘/刷新/不补看那一整套）。
 *    那是产品决定，不是这条判据该替用户定的，故不在本清单里。
 *
 * 跑法（串行；会改写真实工作树，失败后用 `--restore`）：
 *   NODE_OPTIONS= node scripts/mutate.mjs test/mutations/sleep-owner-and-lock-b4-1103.mjs
 */

const LOCK = 'src/bridge-lock.js';

export default [
  {
    id: 'L1',
    note: 'hold 交回下面走独占 claimRec —— §锁⑩ 必须变红（pid 撞号 ⇒ 拒绝启动、退出码 3）',
    file: LOCK,
    anchor: /if \(d\.action === 'hold'\) \{/g,
    count: 1,
    apply: (s) => s.replace(
      "if (d.action === 'hold') {",
      "if (d.action === '__never__') {",
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
];
