/**
 * 假 QQ 对话界面的定向变异（2026-11-01）。
 *
 * 每条都打在 §178 上：变异后 `check-wb` 必须 BLOCKED。
 * 跑法：
 *   NODE_OPTIONS= node scripts/mutate.mjs test/mutations/chat-ui-2026-11-01.mjs
 * ⚠️ 串行；会改写真实工作树，失败后用 `--restore`。
 */

const LINE = 'panel/lib/fake-line.js';
const SESSION = 'panel/lib/fake-session.js';
const APP = 'panel/next/app.js';
const SCHEMA = 'panel/next/schema.js';
const CSS = 'panel/next/style.css';
const FAKE_TEST = 'test/check-fake-panel.mjs';

export default [
  {
    id: 'CH1',
    note: 'fake-session 不再返回 messages —— §178① 必须变红（聊天只剩原始日志）',
    file: SESSION,
    anchor: /    messages: st\.messages\.filter\(\(m\) => m\.n > after\),\n/,
    count: 1,
    apply: (s) => s.replace('    messages: st.messages.filter((m) => m.n > after),\n', ''),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'CH2',
    note: '机器人角色被改成 assistant —— §178① 必须变红（聊天无法区分左右）',
    file: LINE,
    anchor: /role: 'bot'/,
    count: 1,
    apply: (s) => s.replace("role: 'bot'", "role: 'assistant'"),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'CH3',
    note: '输入栏 id 被改掉 —— §178② 必须变红（拿不到草稿/发送键）',
    file: APP,
    anchor: /<textarea id="fakeComposer"/,
    count: 1,
    apply: (s) => s.replace('<textarea id="fakeComposer"', '<textarea id="fakeInput"'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'CH4',
    note: '已见去重被删 —— §178② 必须变红（3 秒重建会重播所有气泡）',
    file: APP,
    anchor: /if \(!id \|\| seen\[id\]\) continue;/,
    count: 1,
    apply: (s) => s.replace('if (!id || seen[id]) continue;', 'if (!id) continue;'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'CH5',
    note: '减弱动效判断被改名 —— §178② 必须变红（系统设置被忽略）',
    file: APP,
    anchor: /reducedChatMotion/g,
    count: 2,
    apply: (s) => s.replaceAll('reducedChatMotion', 'motionOff'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'CH6',
    note: 'Shift+Enter 换行被删 —— §178② 必须变红（多行输入直接发送）',
    file: APP,
    anchor: /ev\.shiftKey/,
    count: 1,
    apply: (s) => s.replace(' && !ev.shiftKey', ''),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'CH7',
    note: '正在输入动画被改名 —— §178③ 必须变红（等回复没有任何反馈）',
    file: CSS,
    anchor: /@keyframes chatTyping/,
    count: 1,
    apply: (s) => s.replace('@keyframes chatTyping', '@keyframes chatDots'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'CH8',
    note: '真会话测试不再断言 user 消息 —— §178④ 必须变红（用户说的话可能不在列表里）',
    file: FAKE_TEST,
    anchor: /msgs\.some\(\(m\) => m\.role === 'user' && m\.text === '在吗'\)/,
    count: 1,
    apply: (s) => s.replace("msgs.some((m) => m.role === 'user' && m.text === '在吗')", 'false'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'CH9',
    note: '启动会话不再清空旧消息 —— §178② 必须变红（上一轮对话串到下一轮）',
    file: APP,
    anchor: /S\.extra\.fakeMsgs = \[\];\n      S\.extra\.fakeSeen = \{\};\n      S\.extra\.fakeWaitAt = 0;\n      S\.extra\.fakeDraft = '';\n      toastResult/,
    count: 1,
    apply: (s) => s.replace(
      "S.extra.fakeMsgs = [];\n      S.extra.fakeSeen = {};\n      S.extra.fakeWaitAt = 0;\n      S.extra.fakeDraft = '';\n      toastResult",
      "S.extra.fakeSeen = {};\n      S.extra.fakeWaitAt = 0;\n      S.extra.fakeDraft = '';\n      toastResult"
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'CH10',
    note: '旧的 fake.text 控件被加回来 —— §178② 必须变红（每敲一个字整页重绘）',
    file: SCHEMA,
    anchor: /ctrls: \[\{ t: 'fakeView' \}\],/,
    count: 1,
    apply: (s) => s.replace(
      "ctrls: [{ t: 'fakeView' }],",
      "ctrls: [{ t: 'fakeView' }, { t: 'text', id: 'fake.text', volatile: true }],"
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'CH11',
    note: '轮询重建不再保留滚动位置 —— §178② 必须变红（读历史时被拉回顶部）',
    file: APP,
    anchor: /const oldTop = log\.scrollTop;/,
    count: 1,
    apply: (s) => s.replace('const oldTop = log.scrollTop;', 'const oldTop = 0;'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'CH12',
    note: '消息签名被改名 —— §178② 必须变红（每 1.5 秒重建一次聊天 DOM）',
    file: APP,
    anchor: /log\.dataset\.sig = sig;/,
    count: 1,
    apply: (s) => s.replace('log.dataset.sig = sig;', 'log.dataset.signature = sig;'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'CH13',
    note: '“正在输入”状态缓存被改名 —— §178② 必须变红（三点动画每轮重启）',
    file: APP,
    anchor: /slot\.dataset\.on = want;/,
    count: 1,
    apply: (s) => s.replace('slot.dataset.on = want;', 'slot.dataset.onState = want;'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
];
