/**
 * 批 B2（巡逻空转三件套）定向变异（2026-11-03 · 群友报告 PAT-01 / 审计报告 BUG-14）。
 *
 * 事故形状是三条局部合理的选择叠出来的，单独看每一条都不像 bug：
 *   ① `decide()` 把 requireAtInGroup / 主动发言总闸排在 patrol 分支之前 ⇒ 合成巡逻必被拒；
 *   ②  `lastPatrolAt` 只在真的回了之后才写 ⇒ 被拒的那一批永远不动 ⇒ 每 30 秒重排同一批；
 *   ③  巡逻摘要写回 `ambient` ⇒ 下一轮把自己上一轮的摘要当成群友新说的话（自喂）。
 * 表现：日志每 30 秒一行「跳过(群聊未被点名)」，队列被无效事件占满，越聊越不回。
 *
 * 旧判据 `['巡逻不自喂', /!evt\.isPatrol/]` 只要**全文件任何一处**有这个 token 就绿，
 * 而背景段那一处恰恰没有 —— 自喂正是从那里发生的。本批把它收紧到具体条件上，
 * 并给 ②③ 各补一条判据 + 一条变异（下面 P1/P2/P3 三条，逐条证明新判据真的会红）。
 *
 * 跑法（串行；会改写真实工作树，失败后用 `--restore`）：
 *   NODE_OPTIONS= node scripts/mutate.mjs test/mutations/patrol-idleloop-b2-1103.mjs
 */

const IDX = 'src/index.js';

export default [
  {
    id: 'P1',
    note: '巡逻摘要又写回背景段 —— §「巡逻不进背景段」必须变红（自喂那条腿接回去）',
    file: IDX,
    anchor: /if \(allowed && scene === 'group' && !evt\.isPoke && !evt\.isPatrol\) \{/g,
    count: 1,
    apply: (s) => s.replace(
      "if (allowed && scene === 'group' && !evt.isPoke && !evt.isPatrol) {",
      "if (allowed && scene === 'group' && !evt.isPoke) {",
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'P2',
    note: '被拒的巡逻不记账 —— §「巡逻被拒也记账」必须变红（同一批每 30 秒重排回来）',
    file: IDX,
    anchor: /if \(evt\.isPatrol && decision\.kind !== 'patrol' && session\) \{/g,
    count: 1,
    apply: (s) => s.replace(
      "if (evt.isPatrol && decision.kind !== 'patrol' && session) {",
      "if (evt.isPatrol && decision.kind === 'patrol' && session) {",
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'P3',
    note: 'tick 不再与 decide() 同源早退 —— §「巡逻与必须@互斥」必须变红（必被拒的一轮照样入队）',
    file: IDX,
    anchor: /if \(cfg\.trigger\?\.requireAtInGroup \|\| cfg\.custom\?\.allowProactive === false\) return 0;/g,
    count: 1,
    apply: (s) => s.replace(
      'if (cfg.trigger?.requireAtInGroup || cfg.custom?.allowProactive === false) return 0;',
      'if (false) return 0;',
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
];
