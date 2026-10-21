/**
 * B3 · 协议端存活看门狗（§122 · 2026-10-21）的变异清单。
 * 跑法：NODE_OPTIONS= node scripts/mutate.mjs test/mutations/liveness-1021.mjs
 */

const OB = 'src/onebot.js';
const LIVE = 'src/onebot-liveness.js';
const SC = 'panel/lib/state-collector.js';
const APP = 'panel/next/app.js';
const SN = 'packaging/windows/tools/start-napcat.mjs';

export default [
  {
    id: 'L1',
    note: '看门狗超时后只记日志、不断开 —— §122① 必须变红（重连永远等不到 close）',
    file: OB,
    anchor: /    try \{ this\.ws\.terminate\(\); \} catch \{ \/\* 已断开 \*\/ \}/,
    count: 1,
    apply: (s) => s.replace(
      '    try { this.ws.terminate(); } catch { /* 已断开 */ }',
      '    /* 看门狗只记日志、不主动断开（变异） */'
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'L2',
    note: 'start() 不再启动看门狗 —— §122① 必须变红',
    file: OB,
    anchor: /    this\.#startWatchdog\(\);\n/,
    count: 1,
    apply: (s) => s.replace('    this.#startWatchdog();\n', ''),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'L3',
    note: '不再识别心跳里的账号掉线 —— §122③ 必须变红',
    file: OB,
    anchor: /if \(online === false && !this\.botOffline\)/,
    count: 1,
    apply: (s) => s.replace('if (online === false && !this.botOffline)', 'if (false && !this.botOffline)'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'L4',
    note: '存活阶梯删掉 account-offline 分支 —— §122④ 必须变红',
    file: LIVE,
    anchor: /if \(health\.botOffline === true\)/,
    count: 1,
    apply: (s) => s.replace('if (health.botOffline === true)', 'if (false)'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'L5',
    note: 'collector 不再下发存活结论 —— §122⑤ 必须变红',
    file: SC,
    anchor: /livenessVerdictOf\(\{/,
    count: 1,
    apply: (s) => s.replace('livenessVerdictOf({', '({'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'L6',
    note: '检查表不再读事件流 verdict —— §122⑥ 必须变红',
    file: APP,
    anchor: /j\(s, \['onebot', 'verdict'\], 'unknown'\)/,
    count: 1,
    apply: (s) => s.replace("j(s, ['onebot', 'verdict'], 'unknown')", "'unknown'"),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'L7',
    note: '安装器退回"只按 3001 端口认协议端" —— §122⑧ 必须变红',
    file: SN,
    anchor: /const probe = await probeOnebotIdentity\(3000\);/,
    count: 1,
    apply: (s) => s.replace('const probe = await probeOnebotIdentity(3000);', "const probe = { ok: true, detail: 'port-open' };"),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
];
