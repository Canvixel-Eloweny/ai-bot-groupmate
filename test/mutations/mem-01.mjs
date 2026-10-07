/**
 * 记忆体检批（D-M1 / D-M2 / D-M3 · 2026-10-04）的变异清单 —— 纯数据，供
 * `node scripts/mutate.mjs test/mutations/mem-01.mjs` 复跑。
 *
 * 这一批修的是体检在**真机数据**上抓到的三个形态，它们的共同点是：
 * 拆掉之后**什么都没有报错**，只是记忆又悄悄变回"记错人"的样子。
 *   · 主语字段被抹掉 → 读盘→归一→写回之间静默丢字段（"记了主语，重启就没了"）；
 *   · 判官算出的主语没写进 provenance → 中途丢失，落盘还是旧形状；
 *   · 渲染退回发送者 / 长类名 → 提示词里又出现「<QQ 号>：<别人的事>」这种错行；
 *   · 主语判据被拆 → 两个人的偏好被合并成一条，"张三不吃香菜"复证了李四；
 *   · 检索判据从叶子里消失 / 门面不再导出 → "你还记得吗"退化成"我不记得"；
 *   · supersedes 退回旧行为 → 目标找不到也照样抄一份副本（46% superseded 的来源）。
 *
 *   | 组  | 打的是 | 该由哪一层拦住 |
 *   |---|---|---|
 *   | M1 | 归一化丢掉 subjectId/subjectName（白名单漏字段） | check-wb §25 ①b |
 *   | M2 | memory.js 不把主语写进 provenance | check-wb §25 ①b |
 *   | M3 | recordLine 退回用发送者 / 不读主语 | check-wb §25 ①b |
 *   | M4 | subjectMatches 恒真（主语不同也合并） | smoke T357 |
 *   | M5 | searchRecords 不再导出（检索判据离开叶子） | check-wb §25 ①c |
 *   | M6 | memory.js 不再导出 recallForPrompt（门面断了） | check-wb §25 ①c |
 *   | M7 | supersedes 匹配不到也照样新增（退回旧行为） | smoke T364 |
 *
 * 期望：七条全部 `BLOCKED`，`INVALID` 为 0。
 *
 * ⚠️ 跑这一批时若看到 `[safe-delete]`，那是**沙箱的批量删除保护**在冒充"被拦住"
 *    （不是断言失败）—— 换前台 + 非沙箱复跑同一组再下结论（R33/R34/R36 同款）。
 * ⚠️ 本机 shell 注入的 `NODE_OPTIONS` 会把 `err.code` 改写成 `CODEBUDDY_BROKER_DENY`
 *    （D17 批实测：T293/T296 因此假红）—— 跑测试要 `NODE_OPTIONS= node …`。
 */

export default [
  {
    id: 'M1',
    note: '归一化丢掉主语字段 —— 判官算得再准，读盘→归一→写回之间也会被抹掉（"记了主语，重启就没了"）',
    file: 'src/memory-record.js',
    anchor: /^      subjectId: str\(p\.subjectId \|\| raw\.subjectId, 24\),$/m,
    count: 1,
    apply: (s) => s.replace(
      "      subjectId: str(p.subjectId || raw.subjectId, 24),",
      "      // 变异：主语字段不在白名单里"
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M2',
    note: 'memory.js 不把主语写进落盘的 provenance —— 判官算出的"关于谁"在中途丢掉',
    file: 'src/memory.js',
    anchor: /^            subjectId: subj\.subjectId,$/m,
    count: 1,
    apply: (s) => s.replace(
      '            subjectId: subj.subjectId,',
      '            // 变异：主语不落盘'
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M3',
    note: '渲染退回发送者 —— 提示词里又出现「<QQ 号>：<别人的事>」（体检里 18/35 条的那个形状）',
    file: 'src/memory-record.js',
    anchor: /^  const who = n\.provenance\.subjectName \|\| '';$/m,
    count: 1,
    apply: (s) => s.replace(
      "  const who = n.provenance.subjectName || '';",
      "  const who = n.provenance.userId || ''; // 变异：退回发送者"
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M4',
    note: '主语判据被拆：别人有主语、自己没有也算同一条 → 两个人的偏好被合并复证',
    file: 'src/memory-record.js',
    anchor: /^  if \(x && y\) return x === y;$/m,
    count: 1,
    apply: (s) => s.replace('  if (x && y) return x === y;', '  if (x && y) return true; // 变异：主语不同也合并'),
    layer: 'smoke',
    expect: 'BLOCKED',
  },
  {
    id: 'M5',
    note: 'searchRecords 不再导出 —— 检索判据离开零依赖叶子，消费方只能自己再写一份',
    file: 'src/memory-record.js',
    anchor: /^export function searchRecords\(items, query, opts = \{\}\) \{$/m,
    count: 1,
    apply: (s) => s.replace(
      'export function searchRecords(items, query, opts = {}) {',
      'function searchRecords(items, query, opts = {}) { // 变异：不导出'
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M6',
    note: 'memory.js 不再导出 recallForPrompt —— 门面断了，"你还记得吗"在真机上退化成"我不记得"',
    file: 'src/memory.js',
    anchor: /^export function recallForPrompt\(query, opts = \{\}\) \{$/m,
    count: 1,
    apply: (s) => s.replace(
      'export function recallForPrompt(query, opts = {}) {',
      'function recallForPrompt(query, opts = {}) { // 变异：不导出'
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M7',
    note: 'supersedes 退回旧行为：目标找不到也照样新增一条副本（46% superseded 的产生方式）',
    file: 'src/memory.js',
    anchor: /^  const realSupersede = supersededIdx >= 0;$/m,
    count: 1,
    apply: (s) => s.replace(
      '  const realSupersede = supersededIdx >= 0;',
      '  const realSupersede = !!supersedes; // 变异：退回旧行为（匹配不到也当推翻）'
    ),
    layer: 'smoke',
    expect: 'BLOCKED',
  },
];
