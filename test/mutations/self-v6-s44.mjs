/**
 * 我方自审 · §44「联网底座」专项变异（代替外包任务2 v6 组 B 的 §44）· 2026-10-02
 *
 * ⚠️ 这一段**从未被任何一轮外包专项打过**（历轮打的是 §47–§50 与 D31），所以是真空白。
 * ⚠️ 我方自己干外包这份活，号段仍用**字母后缀 Q26o 起**（不占外包的 Q89 / Q216 段 ——
 *    外包回执若到达还要交叉核对，占号会造成第三次撞号事故）。
 *
 * 设计：两类变异混在一起，缺一不可 ——
 *   · **攻击类**（M1–M7）：换一种写法，功能不变，看判据还认不认得出来；
 *   · **对照类**（M8/M9）：真的做错（把计数器挪进循环 / 把两道闸顺序写反），
 *     判据**必须**响。它俩要是也绿，说明这一整段判据是死的，攻击类结果就没有意义。
 *
 * `NODE_OPTIONS= node scripts/mutate.mjs test/mutations/self-v6-s44.mjs`
 */

export default [
  {
    id: 'M1',
    file: 'src/browse-lock.js',
    anchor: /^export const BROWSE_REASONS/m,
    count: 1,
    // 攻击「判据零 IO」：`process.env.XXX` 是**最常见的写法**，
    // 而那条正则写的是 `process\.(env|on)\(` —— 要求 `env` 后面紧跟括号。
    // 于是 `process.env.QQBOT_X`（不带括号）**永远匹配不到**。
    // 若这条 NOT-BLOCKED = 判据对最常见的形态完全失效（真缺陷，不是换写法缝隙）。
    apply: (src) => `${src}\nconst _probeEnv = process.env.QQBOT_BROWSE_TEST;\nvoid _probeEnv;\n`,
    layer: 'check-wb',
    expect: 'BLOCKED',
    note: '§44①：`process.env.XXX` 这种最常见写法应被"判据零 IO"拦下（正则却要求 env 后紧跟括号）',
  },
  {
    id: 'M2',
    file: 'src/browse-lock.js',
    anchor: /enabled === true/,
    count: 1,
    // 攻击「只认 === true」：`true === enabled` 语义完全相同，正则却认不出。
    apply: (src) => src.replace('enabled === true', 'true === enabled'),
    layer: 'check-wb',
    expect: 'BLOCKED',
    note: '§44③：enabled 的严格判断被换成等价写法（truthy 会让字符串 "false" 把锁打开）',
  },
  {
    id: 'M3',
    file: 'src/browse-lock.js',
    anchor: /reason: 'lock-off'/,
    count: 1,
    // 攻击「关闭态如实」：理由值拼出来，fnSlice 里的正则就认不出来了，
    // 而运行时的返回值一模一样 —— 这正是"关闭态被伪装成通过了名单检查"能溜过去的路。
    apply: (src) => src.replace("reason: 'lock-off'", "reason: 'lock' + '-off'"),
    layer: 'check-wb',
    expect: 'BLOCKED',
    note: '§44③：关闭态的 reason 被拼出来（函数体里就没有 `reason: \'lock-off\'` 这个形状了）',
  },
/* §44⑥「裁掉图片的留痕」已于 2026-10-17 删除：出站媒体护栏随表情能力一起下线。 */
];
