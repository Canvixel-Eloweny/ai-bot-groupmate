/**
 * B4 发送许可定向变异（2026-11-05 · §186）。
 *
 * 缺陷形状：**门在，但门装错了位置** ——
 *   · 最终复核只留在进 hook 之前 → 钩子期间撤权仍会发出；
 *   · 唯一发送边界不查许可 → 工具发图/主动路径绕过去；
 *   · owner 豁免从 sayToOwner 扩散到所有发送 → 群发也能被"豁免"。
 *
 * 跑法（串行；会改写真实工作树，失败后用 `--restore`）：
 *   NODE_OPTIONS= node scripts/mutate.mjs test/mutations/audit-b4-2026-11-05.mjs
 */

const PERM = 'src/send-permission.js';
const IDX = 'src/index.js';
const PKG = 'package.json';

export default [
  {
    id: 'M1',
    note: 'owner 豁免不再限定私聊 —— §186① 必须变红（群发也能被豁免）',
    file: PERM,
    anchor: /if \(ownerBypass === true && scene === 'private'\) return '';/g,
    count: 1,
    apply: (s) => s.replace(
      "if (ownerBypass === true && scene === 'private') return '';",
      "if (false) return '';",
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M2',
    note: '唯一发送边界不再查许可 —— §186② 必须变红（工具发图/主动路径绕过）',
    file: IDX,
    anchor: /bot\.sendMsg = createGuardedSender\(\{\n      send: sendMsgRaw,\n      gateReason: \(e\) => brain\.gateReason\(e\),\n      recordSent: recordSentRound,\n    \}\);/g,
    count: 1,
    apply: (s) => s.replace(
      `bot.sendMsg = createGuardedSender({
      send: sendMsgRaw,
      gateReason: (e) => brain.gateReason(e),
      recordSent: recordSentRound,
    });`,
      'bot.sendMsg = sendMsgRaw; // 变异：绕过许可复核',
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M3',
    note: '删掉 hook 之后的最终复核 —— §186③ 必须变红（撤权仍照发）',
    file: IDX,
    anchor: /      const lateFinal = lateSendReason\(brain\.gateReason\(evt\), store\.sessions\.get\(session\.key\) === session\);\n      if \(lateFinal\) \{\n        lateBlocked\.push\(\{ text: outChunks\[i\], reason: lateFinal \}\);\n        log\.warn\(`\[\$\{traceId\}\] 发送前最终复核拦下第 \$\{i \+ 1\}\/\$\{outChunks\.length\} 条：\$\{lateFinal\}`\);\n        break;\n      \}/g,
    count: 1,
    apply: (s) => s.replace(
      /      const lateFinal = lateSendReason\(brain\.gateReason\(evt\), store\.sessions\.get\(session\.key\) === session\);\n      if \(lateFinal\) \{\n        lateBlocked\.push\(\{ text: outChunks\[i\], reason: lateFinal \}\);\n        log\.warn\(`\[\$\{traceId\}\] 发送前最终复核拦下第 \$\{i \+ 1\}\/\$\{outChunks\.length\} 条：\$\{lateFinal\}`\);\n        break;\n      \}/,
      '      // 变异：最终复核被删',
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M4',
    note: 'sayToOwner 不再显式豁免 —— §186④ 必须变红（夜间产出会被白名单吞掉）',
    file: IDX,
    anchor: /deliverFromBot\('private', id, text, \{ ownerBypass: true \}\)/g,
    count: 1,
    apply: (s) => s.replace(
      "deliverFromBot('private', id, text, { ownerBypass: true })",
      "deliverFromBot('private', id, text)",
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M5',
    note: 'deliverFromBot 不再透传 ownerBypass —— §186④ 必须变红（豁免传不到发送边界）',
    file: IDX,
    anchor: /\[textSegment\(chunks\[i\]\)\], \{ ownerBypass \}/g,
    count: 1,
    apply: (s) => s.replace('[textSegment(chunks[i])], { ownerBypass }', '[textSegment(chunks[i])]'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M6',
    note: '发送复核回归从 check:features 摘掉 —— §186④ 必须变红',
    file: PKG,
    anchor: /node test\/check-send-recheck\.mjs && /g,
    count: 1,
    apply: (s) => s.replace('node test/check-send-recheck.mjs && ', ''),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
];
