/**
 * D15（联网底座续 · 报告 E11）的变异清单 —— 纯数据，供
 * `node scripts/mutate.mjs test/mutations/d15.mjs` 复跑。
 *
 * 为什么每一步都要配变异：这一批的每一处判错都是**静默的** ——
 *   · 浏览锁定关着 / 没接上 → 三个联网技能照常访问任意公网站点，四层全绿；
 *   · 关闭态说谎（理由不是 `lock-off`）→ 看起来"检查过了"，其实一次判据都没跑；
 *   · 顺序写反（先形态后范围）→ 照样跑通，只是拒绝理由指错方向，排障的人永远查不到名单；
 *   · 张数上限的计数器放进循环 → 每分段重置，上限等于没有，而用例照样全绿。
 * 所以这一组同时打"判据"、"接线位置"与"顺序"。
 *
 *   | 组 | 打的是 | 该由哪一层拦住 |
 *   |---|---|---|
 *   | M1–M2 | 判据层不许长依赖 / 不许自己碰文件 | check-wb §44 |
 *   | M3    | 范围判据不许被搬进"花不花钱"那个文件（方向相反） | check-wb §44 |
 *   | M4    | 关闭态必须 `=== true`（truthy 会让字符串 "false" 把锁打开） | check-wb §44 + smoke |
 *   | M5    | 关闭态的理由必须如实是 `lock-off`（不许伪装成"通过了"） | check-wb §44 + smoke |
 *   | M6    | 顺序：**先范围、后形态**（写反照样跑，理由指错方向） | check-wb §44 |
 *   | M7    | 宿主必须把名单传给 fetch（判据写好了却没人喂 = 写了没人读） | check-wb §44 |
 *   | M8    | 默认值只许来自判据叶子（手写第二份必然漂） | check-wb §44 |
 *   | M9    | 图片上限常量抄第二份 → 改一处不再生效 | check-wb §44 |
 *   | M10   | 整轮计数器挪进发送循环 → 每段重置，上限失效 | check-wb §44 |
 *   | M11   | 裁掉图片必须留痕（否则"少发一个表情"在日志里什么都没有） | check-wb §44 |
 *   | M12   | 去重被摘掉（同一张图发两遍） | smoke |
 *   | M13   | 子域边界写成裸 `endsWith`（`notexample.com` 被放行） | smoke |
 *   | M14   | 名单为空不再 fail-closed（"没配干净"被当成"全都放行"） | smoke |
 *   | M15   | `src/` 里新增裸 fetch（绕过两道闸，四层照样全绿） | check-wb §44 |
 *   | M16   | 协议端令牌不走 `resolveSecret`（`env:` 写法在这个字段上静默失效） | check-wb §44 |
 *
 * 期望：十六条全部 `BLOCKED`，`INVALID` 为 0。
 *
 * ⚠️ 跑这一批时若看到 `自测异常` 里带 `[safe-delete]`，那是**沙箱的批量删除保护**
 *    在冒充"被拦住"（不是断言失败）—— 必须换**前台 + 非沙箱**复跑同一组再下结论
 *    （D6b / D19 那两批实测踩过，见 R33/R34）。
 */

const BROWSE_ANCHOR = "import { browseDecision } from './browse-lock.js'; // 变异：方向相反的两份判据混在一起";

export default [
  {
    id: 'M1',
    note: '范围判据长出依赖（"关闭态 / 空名单 / 子域边界"就没法逐格喂反例了）',
    file: 'src/browse-lock.js',
    anchor: /export const BROWSE_LOCK_DEFAULTS = Object\.freeze\(\{ enabled: false, hosts: \[\] \}\);/,
    count: 1,
    apply: (s) => s.replace(
      'export const BROWSE_LOCK_DEFAULTS = Object.freeze({ enabled: false, hosts: [] });',
      "import fs from 'node:fs'; // 变异：叶子不许有依赖\n\nexport const BROWSE_LOCK_DEFAULTS = Object.freeze({ enabled: false, hosts: [] });"
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M2',
    note: '范围判据自己碰文件（名单必须由配置喂进来，否则判据层不可单元测试）',
    file: 'src/browse-lock.js',
    anchor: /export const BROWSE_LOCK_DEFAULTS/,
    count: 1,
    apply: (s) => s.replace(
      'export const BROWSE_LOCK_DEFAULTS',
      "const TOUCHES_FS = () => fs.statSync('/tmp'); // 变异：叶子碰了文件系统\n\nexport const BROWSE_LOCK_DEFAULTS"
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M3',
    note: '把范围判据搬进 net-rules（那个文件管"花不花钱"，放宽才安全 —— 放进去会被下一个人照着放宽）',
    file: 'src/net-rules.js',
    anchor: /export function providerOf\(base\) \{/,
    count: 1,
    apply: (s) => s.replace(
      'export function providerOf(base) {',
      `${BROWSE_ANCHOR}\n\nexport function providerOf(base) {`
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M4',
    note: '关闭态用 truthy 判断（字符串 "false" / 数字 1 都会把锁打开，而界面上看不出来）',
    file: 'src/browse-lock.js',
    anchor: /    enabled: src\.enabled === true,/,
    count: 1,
    apply: (s) => s.replace('    enabled: src.enabled === true,', '    enabled: !!src.enabled,'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M5',
    note: '关闭态的理由不再如实（伪装成"检查过了"，其实一次判据都没跑）',
    file: 'src/browse-lock.js',
    anchor: /    return \{ allow: true, reason: 'lock-off', host: '', detail: '浏览锁定未启用' \};/,
    count: 1,
    apply: (s) => s.replace(
      "    return { allow: true, reason: 'lock-off', host: '', detail: '浏览锁定未启用' };",
      "    return { allow: true, reason: '', host: '', detail: '' };"
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M6',
    note: '两道闸顺序调换：先按"地址形态"判、后按"范围"判（照样跑通，但拒绝理由指错方向）',
    file: 'src/ext-fetch.js',
    anchor: /    const gate = browseDecision\(url, lock\);/,
    count: 1,
    apply: (s) => {
      const from = s.indexOf('    // ── 第一道：**范围**（browseLock，D15）');
      const to = s.indexOf('    const r = await safeFetch(url);');
      if (from < 0 || to < 0 || to < from) return s; // 锚点不在 → 命中数校验兜住
      const gate = s.slice(from, to);
      const rest = s.slice(0, from) + s.slice(to);
      const at = rest.indexOf('    const r = await safeFetch(url);');
      const afterCall = rest.indexOf('\n', at) + 1;
      return rest.slice(0, afterCall) + gate + rest.slice(afterCall);
    },
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M7',
    note: '宿主不再把名单传给 fetch（判据写好了却没人喂 —— 静态扫描查不出的那类"写了没人读"）',
    file: 'src/plugin-host.js',
    anchor: /      lock: getCustom\?\.\(\)\?\.browseLock,\n/,
    count: 1,
    apply: (s) => s.replace('      lock: getCustom?.()?.browseLock,\n', ''),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M8',
    note: '配置段自己手写一份默认值（与判据叶子那份必然漂）',
    file: 'src/custom-config.js',
    anchor: /  browseLock: \{ \.\.\.BROWSE_LOCK_DEFAULTS, hosts: \[\] \},/,
    count: 1,
    apply: (s) => s.replace(
      '  browseLock: { ...BROWSE_LOCK_DEFAULTS, hosts: [] },',
      '  browseLock: { enabled: false, hosts: [] }, '
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M9',
    note: '图片上限常量抄第二份到调用方（改叶子里的值不再生效）',
    file: 'src/index.js',
    anchor: /    let imagesSent = 0;/,
    count: 1,
    apply: (s) => s.replace(
      '    let imagesSent = 0;',
      '    const IMAGE_CAP_PER_RUN = 3; // 变异：抄第二份\n    let imagesSent = 0;'
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M10',
    note: '整轮图片计数器挪进发送循环（每分段重置 → 上限等于没有，而用例照样全绿）',
    file: 'src/index.js',
    anchor: /    let imagesSent = 0;\n    let imagesSeen = \[\];\n/,
    count: 1,
    apply: (s) => {
      const decl = '    let imagesSent = 0;\n    let imagesSeen = [];\n';
      const rest = s.replace(decl, '');
      const loop = '    for (let i = 0; i < outChunks.length; i += 1) {\n';
      const at = rest.indexOf(loop);
      if (at < 0) return s;
      const insertAt = at + loop.length;
      return rest.slice(0, insertAt) + decl + rest.slice(insertAt);
    },
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M11',
    note: '裁掉图片时不留痕（"它这一轮少发了一个表情"，日志里什么都不剩）',
    file: 'src/index.js',
    anchor: /      if \(capped\.dropped\) \{\n/,
    count: 1,
    apply: (s) => {
      const from = s.indexOf('      if (capped.dropped) {');
      const to = s.indexOf('      imagesSent = capped.used;');
      if (from < 0 || to < 0 || to < from) return s;
      return s.slice(0, from) + s.slice(to);
    },
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M12',
    note: '去重被摘掉（同一张图在同一轮里发两遍 —— 收藏表情刷屏的最短路径）',
    file: 'src/face-marks.js',
    anchor: /    if \(already\.has\(key\) \|\| base \+ added\.length >= cap\) \{/,
    count: 1,
    apply: (s) => s.replace(
      '    if (already.has(key) || base + added.length >= cap) {',
      '    if (base + added.length >= cap) {'
    ),
    layer: 'smoke',
    expect: 'BLOCKED',
  },
  {
    id: 'M13',
    note: '子域边界写成裸 endsWith（`notexample.com` 会被当成 `example.com` 的子域放行）',
    file: 'src/browse-lock.js',
    anchor: /  return h === a \|\| h\.endsWith\(`\.\$\{a\}`\);/,
    count: 1,
    apply: (s) => s.replace(
      '  return h === a || h.endsWith(`.${a}`);',
      '  return h === a || h.endsWith(a);'
    ),
    layer: 'smoke',
    expect: 'BLOCKED',
  },
  {
    id: 'M14',
    note: '名单为空不再 fail-closed（"还没配"被当成"全都放行" —— 正是这一条判据要防的事）',
    file: 'src/browse-lock.js',
    anchor: /  if \(!hosts\.length\) \{/,
    count: 1,
    apply: (s) => s.replace('  if (!hosts.length) {', '  if (false) {'),
    layer: 'smoke',
    expect: 'BLOCKED',
  },
  {
    id: 'M15',
    note: 'src/ 里新增一处裸 fetch（绕过 browseLock 与 safe-fetch 两道闸，而四层照样全绿）',
    file: 'src/pace.js',
    anchor: /^export const PACE_DEFAULTS = Object\.freeze\(\{$/m,
    count: 1,
    apply: (s) => s.replace(
      'export const PACE_DEFAULTS = Object.freeze({',
      "export const SNEAKY = () => fetch('https://example.com'); // 变异：裸 fetch\n\nexport const PACE_DEFAULTS = Object.freeze({"
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M16',
    note: '协议端令牌不走 resolveSecret（`env:NAME` 写法在这个字段上静默失效 —— 而它同样是凭据）',
    file: 'src/config.js',
    anchor: /      accessToken: resolveSecret\(raw\.onebot\?\.accessToken\),/,
    count: 1,
    apply: (s) => s.replace(
      '      accessToken: resolveSecret(raw.onebot?.accessToken),',
      "      accessToken: String(raw.onebot?.accessToken ?? ''),"
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
];
