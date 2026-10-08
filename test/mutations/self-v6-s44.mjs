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
  {
    id: 'M4',
    file: 'src/index.js',
    anchor: /if \(capped\.dropped\)/,
    count: 1,
    // 攻击「裁图要留痕」：加 `=== true` 语义等价，正则不匹配。
    apply: (src) => src.replace('if (capped.dropped)', 'if (capped.dropped === true)'),
    layer: 'check-wb',
    expect: 'BLOCKED',
    note: '§44⑥：裁掉图片的留痕判断换写法（不留痕 = 少发一个表情而日志什么都不剩）',
  },
  {
    id: 'M5',
    file: 'src/onebot.js',
    anchor: /Authorization: `Bearer /,
    count: 1,
    // 攻击「令牌注入点唯一」：模板字符串换成字符串拼接，正则认不出。
    // 危险在于：多一处拼接头 = 令牌有第二个注入点，而这一节就是来防那个的。
    // ⚠️ 用**整行精确替换**，不要用正则去改造模板字符串 ——
    //    第一版那么写生成了 `{ Authorization: Bearer ${... + ' }`（反引号丢了，语法直接坏），
    //    变异会挂在语法检查上而不是被判据拦下，等于这条变异白跑。
    apply: (src) => src.replace(
      '? { Authorization: `Bearer ${this.opts.accessToken}` }',
      "? { Authorization: 'Bearer ' + this.opts.accessToken }",
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
    note: '§44⑦：Authorization 头从模板字符串换成拼接（令牌注入点唯一这条靠的是那个模板形状）',
  },
  {
    id: 'M6',
    file: 'src/ambient.js',
    // ⚠️ 锚点故意用"文件里有几处 export"—— 它只是 mutate.mjs 的自检计数，
    //    真正的改动是**追加**到文件末尾。写死 1 会得到 INVALID（实测这个文件有 2 处）。
    anchor: /^export /m,
    count: 2,
    // 攻击「裸 fetch 不许新增」：`globalThis.fetch(` 里 `fetch(` 前一个是 `.`，
    // 而正则 `[^.\w]fetch\(` 明确**排除**了点号 → 绕过去。
    // 这是本段最危险的一条：它绕过 browseLock + safe-fetch **两道**闸而四层全绿。
    apply: (src) => `${src}\nasync function _unusedProbe(u) { return globalThis.fetch(u); }\nvoid _unusedProbe;\n`,
    layer: 'check-wb',
    expect: 'BLOCKED',
    note: '§44⑧：`globalThis.fetch(` 绕过裸 fetch 扫描（正则的 [^.\w] 把点号排除了）',
  },
  {
    id: 'M7',
    file: 'src/plugin-host.js',
    anchor: /lock: getCustom\?\.\(\)\?\.browseLock/,
    count: 1,
    // 攻击「名单要传下去」：少一层可选链，语义几乎相同（getCustom 基本不返回空），
    // 而正则认不出 → "写了判据却没人喂名单"这类缺陷就查不出来了。
    apply: (src) => src.replace(
      'lock: getCustom?.()?.browseLock',
      'lock: getCustom()?.browseLock',
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
    note: '§44④：传给 createExtFetch 的 browseLock 换了写法（少一层可选链）',
  },
  {
    id: 'M8',
    file: 'src/index.js',
    anchor: /let imagesSent = 0;/,
    count: 1,
    // 【阳性对照】真做错：把整轮计数器挪到发送循环**里** → 每分段重新计数，上限等于没有。
    // 用例照样全绿，所以只有这一条判据在守。它不响 = 这一节是死的。
    apply: (src) => {
      const decl = 'let imagesSent = 0;';
      const loop = 'for (let i = 0; i < outChunks.length';
      const at = src.indexOf(decl);
      const lp = src.indexOf(loop);
      if (at < 0 || lp < 0) return src;
      const without = src.slice(0, at) + src.slice(at + decl.length);
      const lp2 = without.indexOf(loop);
      const brace = without.indexOf('{', without.indexOf(')', lp2));
      return `${without.slice(0, brace + 1)}\n      ${decl}${without.slice(brace + 1)}`;
    },
    layer: 'check-wb',
    expect: 'BLOCKED',
    note: '§44⑥【阳性对照】整轮图片计数器真的挪进循环里（上限失效，而用例全绿）',
  },
  {
    id: 'M9',
    file: 'src/ext-fetch.js',
    anchor: /browseDecision\(/,
    count: 1,
    // 【阳性对照】真做错：把两道闸的顺序写反（先形态后范围）。
    // 功能照样跑通，只是拒绝理由指错方向 —— 排障的人会顺着错理由查，永远查不到名单。
    apply: (src) => {
      const i = src.indexOf('browseDecision(');
      const j = src.indexOf('safeFetch(');
      if (i < 0 || j < 0) return src;
      // 把 `browseDecision(` 这一整段调用搬到 `safeFetch(` 之后（整行搬，保持语法）
      const lineStart = src.lastIndexOf('\n', i) + 1;
      const lineEnd = src.indexOf('\n', i);
      if (lineEnd < 0) return src;
      const moved = src.slice(lineStart, lineEnd);
      const rest = src.slice(0, lineStart) + src.slice(lineEnd + 1);
      const jj = rest.indexOf('safeFetch(');
      const after = rest.indexOf('\n', jj);
      if (after < 0) return src;
      return `${rest.slice(0, after + 1)}${moved}\n${rest.slice(after + 1)}`;
    },
    layer: 'check-wb',
    expect: 'BLOCKED',
    note: '§44⑤【阳性对照】browseDecision 真的排到 safeFetch 之后（顺序写反，拒绝理由指错方向）',
  },
];
