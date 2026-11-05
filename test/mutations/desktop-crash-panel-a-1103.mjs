/**
 * 批 A（2026-11-03）定向变异：桌面壳启动崩溃 + 记忆复核按钮 400。
 *
 * 这一批修的是三条**已经随 0.1.7 发到用户机上**的缺陷：
 *   A1 `electron/main.js` 的 ready-to-show / 兜底 timer 里读裸 `decision`（从未声明）
 *      ⇒ 每次启动抛 ReferenceError ⇒ `uncaughtException` ⇒ `app.exit(1)`
 *      ⇒ 症状是「控制台窗口一闪就没」。
 *   A2 同文件 `spawnSync` 没导入，三处调用都在 `try{}catch{}` 里 ⇒ 一声不吭，
 *      后果是面板进程永远杀不掉、退出留孤儿 node。
 *   A3 结构化记忆的按钮把**状态名**当**动作名**发 ⇒ `/api/memory/review` 每条 400。
 *
 * ⚠️ 为什么必须靠变异而不是 `node --check`：读一个未声明的变量**是合法语法**，
 *    `node --check electron/main.js` 带着 A1/A2 两个 bug 照样绿 —— 这正是它能发出去的原因。
 *    同理 §68 以前只核后端三张表自洽、从不核前端有没有用，所以 A3 也发出去了。
 *    下面每条都打在「新加的判据」上，逐条证明那条判据真的会红。
 *
 * 跑法（串行；会改写真实工作树，失败后用 `--restore`）：
 *   NODE_OPTIONS= node scripts/mutate.mjs test/mutations/desktop-crash-panel-a-1103.mjs
 */

const MAIN = 'electron/main.js';
const APP = 'panel/next/app.js';
const DEMO = 'panel/next/demo-state.js';

export default [
  {
    id: 'A1a',
    note: '兜底 timer 又去读裸 decision —— §151① 必须变红（0.1.7 一闪就没的根因复活）',
    file: MAIN,
    anchor: /if \(\(action === 'show' \|\| pendingShow\) && !win\.isVisible\(\)\) showWindow\(true\);/g,
    count: 1,
    apply: (s) => s.replace(
      "if ((action === 'show' || pendingShow) && !win.isVisible()) showWindow(true);",
      "if ((decision === 'show' || pendingShow) && !win.isVisible()) showWindow(true);",
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'A1b',
    note: '启动留档行读裸 decision —— §151① 必须变红（同步回调里抛 ⇒ app.exit(1)）',
    file: MAIN,
    anchor: /log\(`start decision=\$\{action\} visible=\$\{win\.isVisible\(\)\}`\)/g,
    count: 1,
    apply: (s) => s.replace(
      'log(`start decision=${action} visible=${win.isVisible()}`);',
      'log(`start decision=${decision} visible=${win.isVisible()}`);',
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'A2',
    note: 'spawnSync 从 child_process 解构里摘掉 —— §151① 必须变红（杀进程链静默失效）',
    file: MAIN,
    anchor: /const \{ spawn, spawnSync, execFileSync \} = require\('node:child_process'\);/g,
    count: 1,
    apply: (s) => s.replace(
      "const { spawn, spawnSync, execFileSync } = require('node:child_process');",
      "const { spawn, execFileSync } = require('node:child_process');",
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'A3a',
    note: '按钮退回页面自列 —— §68⑧b 必须变红（页面不再读下发的 actionsFor）',
    file: APP,
    anchor: /\(meta\.actionsFor\?\.\[r\.status\] \|\| \[\]\)/g,
    count: 1,
    apply: (s) => s.replace('(meta.actionsFor?.[r.status] || [])', "(['confirm', 'reject'])"),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'A3b',
    note: 'data-p 退回状态名 —— §68⑧b 必须变红（点了必 400 的那个原始写法）',
    file: APP,
    anchor: /data-a="mem\.review" data-p="\$\{esc\(r\.id\)\}\|\$\{a\}"/g,
    count: 1,
    apply: (s) => s.replace(
      'data-a="mem.review" data-p="${esc(r.id)}|${a}"',
      'data-a="mem.review" data-p="${esc(r.id)}|confirmed"',
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'A3c',
    note: '演示快照的按钮表掺进后端不认的动作 —— §68⑧c 必须变红（第二份拷贝会教错界面）',
    file: DEMO,
    anchor: /candidate: \['confirm', 'reject', 'delete'\],/g,
    count: 1,
    apply: (s) => s.replace(
      "candidate: ['confirm', 'reject', 'delete'],",
      "candidate: ['confirm', 'confirmed', 'delete'],",
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
];
