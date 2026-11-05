/**
 * 批 C2（出口闸门改成就地打码后照发）定向变异（2026-11-03 · 维护者批准）。
 *
 * 旧行为：模型回复里出现一个 Key 或一段本机绝对路径 ⇒ **整条不发**，
 * 群里一个字都没有、也没有解释 ⇒ 用户视角是"她突然不理我"。
 * 新行为：抹掉命中片段后**照发**；fail-closed 靠一条自证保留 ——
 * `maskEgress()` 打完再用**同一道 `scanEgress`** 复扫自己的输出，
 * 还扫得到就判"打不干净"，调用方据此退回整条不发。
 *
 * ⚠️ 这批变异钉的是"改了语义却没人发现"那五刀 + 一刀行为层：
 *   E1 拆掉自证 ⇒ 打码是否打干净变成不可证的事，而调用方据此照发 = 闸门静默变 fail-open
 *   E2/E3 拆掉两处"打不干净就不发"的退路（主链 / 主动链**各一处**，只留一条就等于另一条裸奔）
 *   E4 打码不落痕 ⇒ 用户下次看到"她说话带一串星号"无从归因（与 `blocked` 同一条纪律）
 *   E5 用 isBlocking 判自证结果 ⇒ 哨兵（闸门规则异常）被判成"没命中"，出口闸门变 fail-open
 *   E6 行为层：把某条规则的 `to` 改回 `$1***`（**本轮真实踩过的形状** —— 替换文本自己留着锚点，
 *      于是 `C:\Users\***` 仍被同一条规则判为命中）。它不会泄露，只会**静默退回整条不发**，
 *      检测类判据全绿；只有 T24b 那条"逐条自证打码"能抓住。
 *
 * 跑法（串行；会改写真实工作树，失败后用 `--restore`）：
 *   NODE_OPTIONS= node scripts/mutate.mjs test/mutations/egress-mask-c2-1103.mjs
 */

const EG = 'src/egress.js';
const BRAIN = 'src/brain.js';
const PRO = 'src/proactive.js';
const IDX = 'src/index.js';

export default [
  {
    id: 'E1',
    note: '拆掉"打完复扫"的自证（恒判可信）—— §3c 必须变红：打码是否干净变成不可证，照发等于 fail-open',
    file: EG,
    anchor: /const left = scanEgress\(s\);\n  return \{ text: s, rules: \[\.\.\.new Set\(rules\)\], trusted: left === null \};/g,
    count: 1,
    apply: (s) => s.replace(
      'const left = scanEgress(s);\n  return { text: s, rules: [...new Set(rules)], trusted: left === null };',
      'return { text: s, rules: [...new Set(rules)], trusted: true };',
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'E2',
    note: '主链拆掉"打不干净就不发"那一支 —— §3c 必须变红：任何打码失败都会把原文发进群',
    file: BRAIN,
    anchor: /if \(maskedChunks\.some\(\(c\) => c === null\)\) \{/g,
    count: 1,
    apply: (s) => s.replace('if (maskedChunks.some((c) => c === null)) {', 'if (false) {'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'E3',
    note: '主动链拆掉同一支 —— §3c 必须变红：两条出口链口径不一致，主动那条裸奔',
    file: PRO,
    anchor: /if \(maskedChunks\.some\(\(c\) => c === null\)\) \{/g,
    count: 1,
    apply: (s) => s.replace('if (maskedChunks.some((c) => c === null)) {', 'if (false) {'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'E4',
    note: '打码不落 trace —— §3c 必须变红：抹掉了却没人知道抹过（与 blocked 同一条纪律）',
    file: IDX,
    anchor: /rec\.masked = masked \|\| '';/g,
    count: 1,
    apply: (s) => s.replace("rec.masked = masked || '';", "rec.masked = '';"),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'E5',
    note: '自证改用 isBlocking —— §3c 必须变红：哨兵被当成"没命中"，出口闸门静默变 fail-open',
    file: EG,
    anchor: /const left = scanEgress\(s\);/g,
    count: 1,
    apply: (s) => s.replace(
      'const left = scanEgress(s);\n  return { text: s, rules: [...new Set(rules)], trusted: left === null };',
      'const left = scanEgress(s);\n  return { text: s, rules: [...new Set(rules)], trusted: isBlocking(left) || !left };',
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'E6',
    note: 'Windows 路径的 to 改回 $1***（替换文本自己留着锚点）—— **只由行为层 T24b 拦**：检测类判据全绿，打码却等于没打',
    file: EG,
    anchor: /Windows 绝对路径', re:/g,
    count: 1,
    apply: (s) => s.replace(
      "  { kind: 'Windows 绝对路径', re: /[A-Za-z]:\\\\Users\\\\[^\\s，。！？；：、]*/i, to: '[本机路径已脱敏]' },",
      "  { kind: 'Windows 绝对路径', re: /([A-Za-z]:\\\\Users\\\\)[^\\\\\\s]+/i, to: '$1***' },",
    ),
    layer: 'smoke',
    expect: 'BLOCKED',
  },
];
