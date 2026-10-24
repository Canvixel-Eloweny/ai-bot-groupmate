/**
 * §132「协议端生命周期」的定向变异（2026-10-22）。
 *
 * 每条只打一个失效面，跑完应全部 BLOCKED；任何一条 PASS 都说明 §132 是假绿。
 * 跑法：`NODE_OPTIONS= node scripts/mutate.mjs test/mutations/protocol-lifecycle-1022.mjs`
 * ⚠️ 串行；会改写真实工作树。
 */
export default [
  {
    id: 'P1',
    note: '「结束本次运行」退回只按 Docker 判 —— §132⑤ 必须变红'
      + '（Windows 原生 NapCat 不走容器，整段被跳过且不报错）。预期 BLOCKED',
    file: 'panel/server.js',
    anchor: /const dockerUpFirst = IS_WIN \? false : await cachedDockerUp\(\);/,
    count: 1,
    apply: (s) => s.replace(
      'const dockerUpFirst = IS_WIN ? false : await cachedDockerUp();',
      'const dockerUpFirst = await cachedDockerUp();'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'P2',
    note: '两个停止接口都不再调 stopNativeNapcat —— §132⑤ 必须变红'
      + '（协议端一个进程都不动）。预期 BLOCKED',
    file: 'panel/server.js',
    anchor: /stopNativeNapcat\(killTree, \{ wsPort \}\)/g,
    count: 2,
    apply: (s) => s.replaceAll(
      'stopNativeNapcat(killTree, { wsPort })',
      "Promise.resolve({ ok: true, msg: 'mutated' })"),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'P3',
    note: 'shutdown 不再停守护 —— §132⑦ 必须变红'
      + '（面板退出前守护最后一拍会把协议端拉起来，留下孤儿）。预期 BLOCKED',
    file: 'panel/server.js',
    anchor: /  void protocolGuard\.stop\(\);\n/,
    count: 1,
    apply: (s) => s.replace('  void protocolGuard.stop();\n', ''),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'P4',
    note: '自启不再传已登录 QQ —— §132⑩ 必须变红'
      + '（安装版每次启动仍要扫码）。预期 BLOCKED',
    file: 'panel/server.js',
    anchor: /startNativeNapcat\(\{ qq: login\.qq \}\)/,
    count: 1,
    apply: (s) => s.replace(
      'startNativeNapcat({ qq: login.qq })',
      'startNativeNapcat({})'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'P5',
    note: '删掉守护的「本次运行从没活过就不拉」护栏 —— §132③ 必须变红'
      + '（首次安装会被替用户开窗口）。预期 BLOCKED',
    file: 'panel/lib/protocol-guard.js',
    anchor: /if \(!guard\.seenAlive && !force\) \{/,
    count: 1,
    apply: (s) => s.replace(
      'if (!guard.seenAlive && !force) {',
      'if (false) {'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
];
