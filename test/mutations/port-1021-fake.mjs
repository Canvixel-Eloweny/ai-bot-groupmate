/**
 * Win-v0.1.2 移植 · §129「假 QQ 虚拟入口」的定向变异（2026-10-21）。
 */
export default [
  {
    id: 'F1',
    note: '面板退出不收拾假 QQ 子进程 —— §129 的 fakeDispose 判据应红',
    file: 'panel/server.js',
    anchor: /try \{ fakeDispose\(\); \} catch/g,
    count: 1,
    apply: (s) => s.replace('try { fakeDispose(); } catch', 'try { void 0; } catch'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'F2',
    note: '把假 QQ 三条写路由从 WRITE_ROUTES 摘掉 —— §129 的鉴权/审计判据应红',
    file: 'panel/server.js',
    anchor: /  '\/api\/fake-qq\/start', '\/api\/fake-qq\/send', '\/api\/fake-qq\/stop',\n/g,
    count: 1,
    apply: (s) => s.replace("  '/api/fake-qq/start', '/api/fake-qq/send', '/api/fake-qq/stop',\n", ''),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'F3',
    note: '把脚本存在预检去掉 —— §129 的 fs.existsSync 判据应红',
    file: 'panel/lib/fake-session.js',
    anchor: /if \(!fs\.existsSync\(FAKE_SCRIPT\)\)/g,
    count: 1,
    apply: (s) => s.replace('if (!fs.existsSync(FAKE_SCRIPT))', 'if (false)'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'F4',
    note: '页面显示假 QQ 时不挂轮询 —— §129 的 mountFake 接线判据应红',
    file: 'panel/next/app.js',
    anchor: /if \(ids\.has\('fakeView'\)\) mountFake\(\);/g,
    count: 1,
    apply: (s) => s.replace("if (ids.has('fakeView')) mountFake();", "if (ids.has('fakeView')) void 0;"),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
];
