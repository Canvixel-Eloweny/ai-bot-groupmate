/**
 * B1 · 判据正确性（§120 · 2026-10-21）的变异清单。
 *
 * 每条只改一处、只打红 §120；`anchor` 必须在文件里恰好命中 1 次。
 * 跑法（串行）：NODE_OPTIONS= node scripts/mutate.mjs test/mutations/judgments-1021.mjs
 */

const REPLY = 'src/reply-track.js';
const FETCH = 'src/safe-fetch.js';
const ASYNC = 'src/async-util.js';
const CTRL = 'src/session-control.js';
const NET = 'src/net-rules.js';
const BUDGET = 'src/context-budget.js';
const BRAIN = 'src/brain.js';
const INDEX = 'src/index.js';

export default [
  {
    id: 'J1',
    note: '引用回执退回只认外层 `res.data` —— 线上传入的是已剥壳内层，§120 必须变红',
    file: REPLY,
    anchor: /const d = res\?\.data \?\? res;/,
    count: 1,
    apply: (s) => s.replace('const d = res?.data ?? res;', 'const d = res?.data;'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'J2',
    note: 'safe-fetch 的 settled 初值翻成 true（done 不再幂等/不再清 deadline）—— §120 必须变红',
    file: FETCH,
    anchor: /let settled = false;/,
    count: 1,
    apply: (s) => s.replace('let settled = false;', 'let settled = true;'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'J3',
    note: '信号量同步抛错分支不再归还槽位 —— §120 必须变红（累计 limit 次后死锁）',
    file: ASYNC,
    anchor: /      active -= 1;\n      next\(\);\n      reject\(e\);/,
    count: 1,
    apply: (s) => s.replace('      active -= 1;\n      next();\n      reject(e);', '      next();\n      reject(e);'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'J4',
    note: '主动链单飞守卫的入口判断变成恒假 —— §120 必须变红',
    file: INDEX,
    anchor: /if \(proactiveTickRunning\) return;/,
    count: 1,
    apply: (s) => s.replace('if (proactiveTickRunning) return;', 'if (false) return;'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'J5',
    note: '会话“上一轮”表回到 FIFO（覆盖 key 不刷新顺序）—— §120 必须变红',
    file: CTRL,
    anchor: /    last\.delete\(key\);\n    last\.set\(key, rec\);/,
    count: 1,
    apply: (s) => s.replace('    last.delete(key);\n    last.set(key, rec);', '    last.set(key, rec);'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'J6',
    note: 'isLocalBase 不再取 hostname（退回整串判断）—— §120 必须变红',
    file: NET,
    anchor: /const host = hostnameOf\(base\);/,
    count: 1,
    apply: (s) => s.replace('const host = hostnameOf(base);', 'const host = String(base);'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'J7',
    note: '预算裁剪从“保标题”退回 `shift()` —— §120 必须变红（第一个丢的是段标题）',
    file: BUDGET,
    anchor: /s\.lines\.splice\(keepHead, 1\)\[0\]/,
    count: 2,
    apply: (s) => s.replaceAll('s.lines.splice(keepHead, 1)[0]', 's.lines.shift()'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'J8',
    note: '背景段不再声明 keepHead —— §120 必须变红（实现有了但这一处没接）',
    file: BRAIN,
    anchor: /trimFrom: 'oldest', keepHead: 1/,
    count: 1,
    apply: (s) => s.replace("trimFrom: 'oldest', keepHead: 1", "trimFrom: 'oldest'"),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
];
