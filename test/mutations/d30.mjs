/**
 * D30（未读模型）的变异清单 —— 纯数据，供
 * `node scripts/mutate.mjs test/mutations/d30.mjs` 复跑。
 *
 * 为什么每一步都要配变异：这一批的每一处判错**都不会报错**，只会安静地失效 ——
 *   · 两处接线没接上 → 账面依旧分不清"它不理我"与"它没看见"，四层回归照样全绿；
 *   · 顺序反了（记在 decide 之后 / 消费在 decide 之前）→ "有结论了"与"看见了"混成一件事；
 *   · 冒出一个无参清空 → 积压的消息被一次抹掉，用户看到的是"它醒了但没理我"；
 *   · 叶子长出依赖 / 碰 IO → 反例再也喂不进去（判据只能靠真机等）；
 *   · 未读落进存档 → 恢复一个过期的未读比丢掉它更糟（与 working-memory 同一条纪律）。
 *
 *   | 组  | 打的是 | 该由哪一层拦住 |
 *   |---|---|---|
 *   | M1  | 判据叶子长出依赖 | check-wb §48 ① |
 *   | M2  | 判据叶子碰 IO | check-wb §48 ① |
 *   | M3  | 导出里出现"无参清空"形态 | check-wb §48 ② |
 *   | M4  | consume 的 ids 加上默认值（等于把无参清空写回来） | check-wb §48 ② |
 *   | M5  | 未读记录被搬到 decide 之后 | check-wb §48 ③ |
 *   | M6  | 未读消费被搬到 decide 之前 | check-wb §48 ③ |
 *   | M7  | writeSkip 的字段集去掉 unread | check-wb §48 ④ |
 *   | M8  | 主回复记录不带 unread | check-wb §48 ④ |
 *   | M9  | 只漏掉一个出口的 unread（"能匹配到一处就绿"的假绿形状） | check-wb §48 ④ |
 *   | M10 | 会话上的未读被第三个地方改写（绕过唯一清除路径） | check-wb §48 ③ |
 *   | M11 | 未读落进会话存档（重启后恢复一个过期的未读） | check-wb §48 ⑤ |
 *
 * 期望：十一条全部 `BLOCKED`，`INVALID` 为 0。
 *
 * ⚠️ 跑这一批时若看到 `[safe-delete]`，那是**沙箱的批量删除保护**在冒充"被拦住"
 *    （不是断言失败）—— 换前台 + 非沙箱复跑同一组再下结论（R33/R34/R36 同款）。
 * ⚠️ 另：本机 shell 注入的 `NODE_OPTIONS` 会把 `err.code` 改写成 `CODEBUDDY_BROKER_DENY`
 *    （D17 批实测：T293/T296 因此假红）—— 跑测试要 `NODE_OPTIONS= node …`。
 */

/** 未读记录块（记录点）：整块搬走用它当锚点 */
const RECORD_BLOCK = '    if (allowed && !evt.isPoke) {\n'
  + '      noteUnread(session, {\n'
  + '        messageId: evt.message_id,\n'
  + '        userId: evt.user_id,\n'
  + '        sender,\n'
  + '        text: parsed.text,\n'
  + '        mentionedSelf: parsed.mentionedSelf,\n'
  + '        now: Date.now(),\n'
  + '      });\n'
  + '    }';

const CONSUME_LINE = '    const unreadStat = session ? consumeUnread(session, evt.message_id) : null;';
const DECIDE_LINE = '    const decision = brain.decide(session, evt, parsed);';

export default [
  {
    id: 'M1',
    note: '未读判据叶子长出依赖（反例再也喂不进去，只能靠真机等一轮）',
    file: 'src/unread.js',
    anchor: /^export const UNREAD_MAX = 200;$/m,
    count: 1,
    apply: (s) => s.replace(
      'export const UNREAD_MAX = 200;',
      "import fs from 'node:fs'; // 变异：叶子不许有依赖\nexport const UNREAD_MAX = 200;"
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M2',
    note: '未读判据碰 IO（把记账写成读文件 — 判据层长出副作用）',
    file: 'src/unread.js',
    anchor: /^  const items = Array\.isArray\(list\) \? list : \[\];\n  if \(!entry\?\.id\) return \{ items, added: 0, dropped: 0 \};$/m,
    count: 1,
    apply: (s) => s.replace(
      '  if (!entry?.id) return { items, added: 0, dropped: 0 };',
      "  if (!entry?.id) { fs.writeFileSync('/tmp/x', ''); return { items, added: 0, dropped: 0 }; } // 变异：判据层碰 IO"
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M3',
    note: '导出里出现"无参清空"形态（积压的消息会被一次抹掉）',
    file: 'src/unread.js',
    anchor: /^export function consume\(list, ids\) \{$/m,
    count: 1,
    apply: (s) => s.replace(
      'export function consume(list, ids) {',
      'export function clearUnread() { return { items: [], consumed: [] }; } // 变异：无参清空\nexport function consume(list, ids) {'
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M4',
    note: 'consume 的 ids 加上默认值 —— 于是 `consume(list)` 静默变成"全清"',
    file: 'src/unread.js',
    anchor: /^export function consume\(list, ids\) \{$/m,
    count: 1,
    apply: (s) => s.replace(
      'export function consume(list, ids) {',
      'export function consume(list, ids = []) { // 变异：默认值给了"无参清空"一条路'
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M5',
    note: '未读记录被搬到 decide 之后（睡着时那条会先被处理再记，D31 的"留在未读"没处停）',
    file: 'src/index.js',
    anchor: /^    if \(allowed && !evt\.isPoke\) \{\n      noteUnread\(session, \{$/m,
    count: 1,
    apply: (s) => s
      .replace(RECORD_BLOCK, '    // 变异：未读记录点被搬到了 decide 之后')
      .replace(
        CONSUME_LINE,
        `${CONSUME_LINE}\n    if (allowed && !evt.isPoke) noteUnread(session, { messageId: evt.message_id, userId: evt.user_id, sender, text: parsed.text, mentionedSelf: parsed.mentionedSelf, now: Date.now() }); // 变异：位置搬错`
      ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M6',
    note: '未读消费被搬到 decide 之前（那条消息还没结论就被标成"处理完了"）',
    file: 'src/index.js',
    anchor: /^    const unreadStat = session \? consumeUnread\(session, evt\.message_id\) : null;$/m,
    count: 1,
    apply: (s) => s
      .replace(`${CONSUME_LINE}\n`, '')
      .replace(DECIDE_LINE, `${CONSUME_LINE}\n${DECIDE_LINE}`),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M7',
    note: 'writeSkip 的字段集去掉 unread —— "没回"的那一轮看不到看没看见',
    file: 'src/bridge-io.js',
    anchor: /^    unread: info\.unread \|\| null,$/m,
    count: 1,
    apply: (s) => s.replace('    unread: info.unread || null,', '    // 变异：skip 不带未读痕迹'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M8',
    note: '主回复记录不带 unread（回了话那一轮反而看不出它漏看了几条）',
    file: 'src/index.js',
    anchor: /^      memoryDropped: built\.memory,\n      \/\/ D30：这一轮消费掉的未读。放在 reply 记录上之后/m,
    count: 1,
    // ⚠️ **2026-10-05（第 7 轮 · 惰性体检）修 `apply`**：旧 `apply` 用
    //    `'      unread: unreadStat,\n    };\n\n    if (chatErr) {'` 当锚 —— 它假设
    //    `unread` 是 reply 记录的**最后一个字段**。后来记录里在它后面又加了
    //    `sleep` / `forward` / `cross`（Q37 / D23-2 / D18）⇒ 那个串不再存在 ⇒
    //    `apply` **静默空转**（锚点仍命中，所以锚点体检与 `mutate` 的 ③ 都看不见它）。
    //    ⇒ 改成只删**那一行**，并用它紧后那句 `// Q37：` 注释把它钉在**reply 记录里**
    //      （`unread: unreadStat,` 在文件里有四处，直接删会打到别处 —— 那是"变异没打中"）。
    apply: (s) => s.replace(
      '      unread: unreadStat,\n      // Q37：',
      '      // 变异：reply 不带未读痕迹\n      // Q37：'
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M9',
    note: '只漏掉一个出口的 unread（"能匹配到一处就绿"是已知的假绿形状）',
    file: 'src/index.js',
    anchor: /^          model: cfg\.llm\.model, baseUrl: cfg\.llm\.baseUrl,\n          unread: unreadStat,$/m,
    count: 1,
    apply: (s) => s.replace(
      '          model: cfg.llm.model, baseUrl: cfg.llm.baseUrl,\n          unread: unreadStat,',
      '          model: cfg.llm.model, baseUrl: cfg.llm.baseUrl,\n          // 变异：群内指令那一支漏了未读痕迹'
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M10',
    note: '会话上的未读被第三个地方改写（绕过了"按 id 消费"这条唯一清除路径）',
    file: 'src/index.js',
    anchor: /^    const unreadStat = session \? consumeUnread\(session, evt\.message_id\) : null;$/m,
    count: 1,
    apply: (s) => s.replace(
      CONSUME_LINE,
      `${CONSUME_LINE}\n    if (session) session.unread = []; // 变异：另一个地方把未读整组清空`
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M11',
    note: '未读落进会话存档（重启后恢复一个过期的未读 —— 比丢掉它更糟）',
    file: 'src/session-archive.js',
    anchor: /^      lastReplyAt: s\.lastReplyAt \|\| 0,\n      lastInterjectAt: s\.lastInterjectAt \|\| 0,$/m,
    count: 1,
    apply: (s) => s.replace(
      '      lastReplyAt: s.lastReplyAt || 0,\n      lastInterjectAt: s.lastInterjectAt || 0,',
      '      lastReplyAt: s.lastReplyAt || 0,\n      lastInterjectAt: s.lastInterjectAt || 0,\n      unread: s.unread || [], // 变异：未读进了存档'
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
];
