/**
 * 批 B1.1（好友申请 / 群邀请）定向变异（2026-11-04 · §181）。
 *
 * 这一族的形状是"**一条报文要穿过四道门，任何一道门漏了都不报错**"：
 *   协议端把 `post_type=request` 推过来 → `onebot.js` 得分流（原始缺陷就死在这里：
 *   它和心跳一起被塞进 `emit('notice')`）→ `index.js` 得有监听者 → 落盘的路径
 *   只有一份（写侧与读侧各拼一次就会永远读成空列表）→ 控制通道三处一起扩 `arg`
 *   （闭集合 / 记录形状 / 传给执行体）→ 面板下发 + 渲染 + 按钮带 flag + 路由透传。
 * 另外三条是**红线**：同意好友只有一个由人拍板的出口（多一个调用点就是有人加了自动通过）、
 * 群邀请必须走另一个接口（共用时报错会伪装成"申请过期"）、读不出不许说成"没有申请"。
 * R13 打在**文案语义**上，而 §181⑦ 是**实跑一次函数**再判它的 —— 别的判据扫源码，这条跑代码。
 *
 * 跑法（串行；会改写真实工作树，失败后用 `--restore`）：
 *   NODE_OPTIONS= node scripts/mutate.mjs test/mutations/friend-requests-b11-1104.mjs
 */

const OB = 'src/onebot.js';
const IDX = 'src/index.js';
const CC = 'src/control-channel.js';
const FR = 'src/friend-requests.js';
const COL = 'panel/lib/state-collector.js';
const SRV = 'panel/server.js';
const SCH = 'panel/next/schema.js';
const DOM = 'test/panel-dom.mjs';

export default [
  {
    id: 'R1',
    note: 'request 不再分流（又和心跳一起塞进 notice）—— §181① 必须变红（原始缺陷复活）',
    file: OB,
    anchor: /\} else if \(payload\.post_type === 'request'\) \{/g,
    count: 1,
    apply: (s) => s.replace(
      /    \} else if \(payload\.post_type === 'request'\) \{[\s\S]*?this\.emit\('request', payload\);\n/,
      '',
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'R2',
    note: '改了分发但没有监听者 —— §181① 必须变红（"改了分发没改消费"，表现与原来一模一样）',
    file: IDX,
    anchor: /bot\.on\('request', async \(evt\) => \{/g,
    count: 1,
    apply: (s) => s.replace("bot.on('request', async (evt) => {", "bot.on('requestX', async (evt) => {"),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'R3',
    note: '机器人写侧改成手写路径（ROOT/data）—— §181② 必须变红（绕开 DATA_DIR 就绕开了目录级三件套）',
    file: IDX,
    anchor: /const FRIEND_REQ_FILE = path\.join\(DATA_DIR, FRIEND_REQ_FILE_NAME\);/g,
    count: 1,
    apply: (s) => s.replace(
      'const FRIEND_REQ_FILE = path.join(DATA_DIR, FRIEND_REQ_FILE_NAME);',
      "const FRIEND_REQ_FILE = path.join(ROOT, 'data', 'friend-requests.json'); // 变异：手写路径",
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'R4',
    note: '面板读侧自己拼一个文件名 —— §181② 必须红（写侧与读侧两个字面量，永远读成空列表）',
    file: COL,
    anchor: /path\.join\(DATA_DIR, FRIEND_REQ_FILE_NAME\)/g,
    count: 1,
    apply: (s) => s.replace(
      'path.join(DATA_DIR, FRIEND_REQ_FILE_NAME)',
      "path.join(DATA_DIR, 'friend-requests-v2.json')",
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'R5',
    note: 'CONTROL_KINDS 摘掉 friend.resolve —— §181③ 必须变红（命令在判据层就被当"不认识"拒掉）',
    file: CC,
    anchor: /, 'friend\.resolve'\]/g,
    count: 1,
    apply: (s) => s.replace(", 'friend.resolve']", ']'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'R6',
    note: 'parseControlRecord 不收 arg —— §181③ 必须变红（带参数的命令参数被静默丢掉：点同意却谁也没同意）',
    file: CC,
    anchor: /return \{ id, cmd, at: Number\.isFinite\(at\) \? at : 0, done, arg \};/g,
    count: 1,
    apply: (s) => s.replace(
      'return { id, cmd, at: Number.isFinite(at) ? at : 0, done, arg };',
      'return { id, cmd, at: Number.isFinite(at) ? at : 0, done };',
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'R7',
    note: '轮询器收下 arg 但不传给执行体 —— §181③ 必须变红（"写了没人读"那一族）',
    file: CC,
    anchor: /result = \(await exec\(rec\.cmd, rec\.arg\)\) \|\| result;/g,
    count: 1,
    apply: (s) => s.replace(
      'result = (await exec(rec.cmd, rec.arg)) || result;',
      'result = (await exec(rec.cmd)) || result;',
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'R8',
    note: '有人在收到申请时直接自动同意（第二个调用点）—— §181④ 必须变红（撤不回来的动作不许由机器自己拍板）',
    file: IDX,
    anchor: /const text = requestNoticeTextOf\(rec, \{ pending: pendingRequestsOf\(r\.list\)\.length \}\);/g,
    count: 1,
    apply: (s) => s.replace(
      '    const text = requestNoticeTextOf(rec, { pending: pendingRequestsOf(r.list).length });',
      "    if (rec.kind === 'friend') await bot.call('set_friend_add_request', { flag: rec.flag, approve: true }, 5000);\n    const text = requestNoticeTextOf(rec, { pending: pendingRequestsOf(r.list).length });",
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'R9',
    note: '群邀请也走好友那个接口 —— §181④ 必须变红（协议端报"flag 无效"会被读成"申请过期"，bug 伪装成正常）',
    file: IDX,
    anchor: /hit\.kind === 'group' \? 'set_group_add_request' : 'set_friend_add_request'/g,
    count: 1,
    apply: (s) => s.replace(
      "const api = hit.kind === 'group' ? 'set_group_add_request' : 'set_friend_add_request';",
      "const api = 'set_friend_add_request';",
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'R10',
    note: '/api/state 不再下发 friendRequests —— §181⑤ 必须变红（读文件的函数写了但没人调用）',
    file: COL,
    anchor: /friendRequests: readFriendRequestsOf\(\),/g,
    count: 1,
    apply: (s) => s.replace('      friendRequests: readFriendRequestsOf(),\n', ''),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'R11',
    note: '路由不透传 arg —— §181⑤ 必须变红（前端发了、服务端丢了，机器人永远收到空参数）',
    file: SRV,
    anchor: /issueCommand\(String\(body\?\.cmd \|\| ''\), \{ arg: String\(body\?\.arg \?\? ''\) \}\)/g,
    count: 1,
    apply: (s) => s.replace(
      "issueCommand(String(body?.cmd || ''), { arg: String(body?.arg ?? '') })",
      "issueCommand(String(body?.cmd || ''))",
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'R12',
    note: '解析失败不再单独报 unreadable —— §181⑥ 必须变红（把"读不出"说成"没人申请过"）',
    file: COL,
    anchor: /return \{ list: \[\], pending: 0, unreadable: true, ever: false \};/g,
    count: 1,
    apply: (s) => s.replace(
      'return { list: [], pending: 0, unreadable: true, ever: false };',
      'return { list: [], pending: 0, unreadable: false, ever: false };',
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'R13',
    note: '通知里不再告诉主人去哪儿拍板 —— §181⑦（**实跑这个函数**再判）必须变红',
    file: FR,
    anchor: /。要不要通过由你在控制台里点，我不会自己答应。/g,
    count: 1,
    apply: (s) => s.replace(
      '。要不要通过由你在控制台里点，我不会自己答应。',
      '。要不要通过你自己定。',
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'R14',
    note: 'panel-dom 删掉整段好友申请断言 —— §181⑧ 必须变红（"列出来了但按钮死了"从此没人守）',
    file: DOM,
    anchor: /── 好友申请（机器人落盘 → 采集 → 页面 → 按钮带 flag）──/g,
    count: 1,
    apply: (s) => s.replace(
      /  \/\* ── 好友申请[\s\S]*?frEmpty\.won\}）`\);\n/,
      '',
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
];
