/**
 * L3 聚合适配层（2026-10-20 · R1–R4）的变异清单 —— 纯数据。
 *
 * 复跑：
 *   QQBOT_MUTATE_WORK=/tmp/qqbot-mutate-l3 NODE_OPTIONS= \
 *     node scripts/mutate.mjs test/mutations/backend-l3-1020.mjs --layer backend
 *
 * 这一批打的是**四家后端语义差异**的每一条决定点：
 *   · M1/M8  forward 参数顺序（LLBot 先 id；调用方不许自己再排）
 *   · M2    失败语义（retcode 200 + failed 不许当成功）
 *   · M3/M4/M5 自报识别 / 能力真值 / 自报可信度
 *   · M6    auto 才有识别（显式配置不许被自报覆盖）
 *   · M7    面板投影带后端
 *   · M9/M10 机器人 / 面板共用同一个归一判据
 *   · M11/M12 后端选择进配置与模板
 *
 * ⚠️ 这一批用 `layer: 'backend'`（`scripts/check-backend.mjs`，26 条判据、秒级），
 *    不跑完整 smoke；行为层的 T399–T403 是同一批规则的第二条腿，单独由 smoke 兜着。
 * ⚠️ 跑之前先提交；用全新的 `QQBOT_MUTATE_WORK` 目录（R46.1）。
 */

const REG = 'src/backend/registry.js';
const NORM = 'src/backend/normalize.js';
const DRV = 'src/backend/driver.js';

export default [
  {
    id: 'M1',
    note: 'LLBot 的 forwardOrder 改回 message_id 优先 —— 它两个键都按 resId 解读，'
      + '先喂整数 message_id 是空转；第一次调用就失败，兜底那次才通。预期 BLOCKED（check-backend ①）',
    file: REG,
    anchor: /forwardOrder: \['id', 'message_id'\],/,
    count: 1,
    apply: (s) => s.replace("forwardOrder: ['id', 'message_id'],", "forwardOrder: ['message_id', 'id'],"),
    layer: 'backend',
    expect: 'BLOCKED',
  },
  {
    id: 'M2',
    note: '失败语义只认 retcode/数据失败，丢掉 `status failed` 与已知失败文案 —— '
      + 'Lagrange 的 retcode 200 + failed、SnowLuma 的 payload is empty 都会被当成功。'
      + '预期 BLOCKED（check-backend ② / smoke T399）',
    file: NORM,
    anchor: /const businessFailed = statusFailed \|\| retFailed \|\| dataFailed \|\| msgFailed;/,
    count: 1,
    apply: (s) => s.replace(
      'const businessFailed = statusFailed || retFailed || dataFailed || msgFailed;',
      'const businessFailed = retFailed || dataFailed;'
    ),
    layer: 'backend',
    expect: 'BLOCKED',
  },
  {
    id: 'M3',
    note: '把 get_status 的自报 online 当成可信 —— NapCat/Lagrange 的 good 写死 true，'
      + 'online 只是"进程还在"的自述，不是登录态。预期 BLOCKED（check-backend ③）',
    file: NORM,
    anchor: /online: false,\n    good: false,/,
    count: 1,
    apply: (s) => s.replace('online: false,\n    good: false,', 'online: true,\n    good: false,'),
    layer: 'backend',
    expect: 'BLOCKED',
  },
  {
    id: 'M4',
    note: '把 SnowLuma 的自报识别成 NapCat —— 两家 forwardOrder 虽然同形，但 message_id '
      + '形状（int32 可为负）与失败文案不同，识别错会掩盖真实差异。预期 BLOCKED（check-backend ①b）',
    file: REG,
    anchor: /if \(s\.includes\('snowluma'\)\) return 'snowluma';/,
    count: 1,
    apply: (s) => s.replace("if (s.includes('snowluma')) return 'snowluma';", "if (s.includes('snowluma')) return 'napcat';"),
    layer: 'backend',
    expect: 'BLOCKED',
  },
  {
    id: 'M5',
    note: '把 LLBot 的 get_status 标成 yes（未取证的动作写成支持）—— 面板会拿一条'
      + '根本不存在的回读去报状态。预期 BLOCKED（check-backend ①c）',
    file: REG,
    anchor: /llbot:\s*\{[\s\S]{0,800}?get_status: 'unknown'/,
    count: 1,
    apply: (s) => s.replace(/(llbot:\s*\{[\s\S]{0,800}?)get_status: 'unknown'/, "$1get_status: 'yes'"),
    layer: 'backend',
    expect: 'BLOCKED',
  },
  {
    id: 'M6',
    note: 'driver 的 auto 识别不再问 get_version_info —— 永远停在 generic，'
      + 'LLBot 的 forward 顺序就退回"先试空转的那一步"。预期 BLOCKED（check-backend ⑧ / smoke T402）',
    file: DRV,
    anchor: /const selfReport = await client\.call\('get_version_info', \{\}, 5000\);/,
    count: 1,
    apply: (s) => s.replace("const selfReport = await client.call('get_version_info', {}, 5000);", 'const selfReport = null;'),
    layer: 'backend',
    expect: 'BLOCKED',
  },
  {
    id: 'M7',
    note: '面板自报投影不再下发 backendId（只留 label）—— 面板失去"实际连的是哪家"的机器可读值。'
      + '预期 BLOCKED（check-backend ⑦）',
    file: 'panel/lib/state-collector.js',
    anchor: /    backendId,\n    backendLabel: backendLabel\(backendId\),/,
    count: 1,
    apply: (s) => s.replace('    backendId,\n    backendLabel: backendLabel(backendId),', '    backendLabel: backendLabel(backendId),'),
    layer: 'backend',
    expect: 'BLOCKED',
  },
  {
    id: 'M8',
    note: 'index.js 绕过 forwardAttemptsFor、把两步顺序写回调用方 —— 同一件事又有了第二个决定点。'
      + '预期 BLOCKED（check-backend ④）',
    file: 'src/index.js',
    anchor: /const attempts = forwardAttemptsFor\(onebot\.backend, \{ messageId: evt\.message_id, resId \}\);/,
    count: 1,
    apply: (s) => s.replace(
      'const attempts = forwardAttemptsFor(onebot.backend, { messageId: evt.message_id, resId });',
      "const attempts = [];\n    if (evt.message_id !== undefined && evt.message_id !== null && String(evt.message_id)) attempts.push({ via: 'message_id', params: { message_id: Number(evt.message_id) || evt.message_id } });\n    if (resId) attempts.push({ via: 'res_id', params: { id: resId } });"
    ),
    layer: 'backend',
    expect: 'BLOCKED',
  },
  {
    id: 'M9',
    note: 'OneBotClient 绕过归一层，把 `status===\'ok\' || retcode===0` 写回来 —— Lagrangian '
      + '的 retcode 200 + failed 会被当成功。预期 BLOCKED（check-backend ⑤）',
    file: 'src/onebot.js',
    anchor: /const reply = classifyOneBotReply\(payload\);/,
    count: 1,
    apply: (s) => s.replace(
      'const reply = classifyOneBotReply(payload);',
      "const reply = { businessOk: payload.status === 'ok' || payload.retcode === 0, data: payload.data };"
    ),
    layer: 'backend',
    expect: 'BLOCKED',
  },
  {
    id: 'M10',
    note: '面板 apiGroups 绕过归一层，直接把 `data` 当成功 —— 列群失败又变回"ok:true + 空表"，'
      + '界面上像"这个号一个群都没有"。预期 BLOCKED（check-backend ⑥）',
    file: 'panel/server.js',
    anchor: /const rep = classifyOneBotReply\(JSON\.parse\(r\.body\)\);/,
    count: 1,
    apply: (s) => s.replace(
      'const rep = classifyOneBotReply(JSON.parse(r.body));',
      'const rep = { businessOk: true, data: JSON.parse(r.body).data };'
    ),
    layer: 'backend',
    expect: 'BLOCKED',
  },
  {
    id: 'M11',
    note: 'config.js 不再归一 onebot.backend —— 用户配了 `snowluma` 也会静默回 auto。'
      + '预期 BLOCKED（check-backend ①d）',
    file: 'src/config.js',
    anchor: /      backend: normalizeBackend\(raw\.onebot\?\.backend\),\n/,
    count: 1,
    apply: (s) => s.replace('      backend: normalizeBackend(raw.onebot?.backend),\n', ''),
    layer: 'backend',
    expect: 'BLOCKED',
  },
  {
    id: 'M12',
    note: 'config.example.json 不再带 onebot.backend —— 照着模板配不出后端选择。'
      + '预期 BLOCKED（check-backend ①d）',
    file: 'config.example.json',
    anchor: /    "backend": "auto",\n/,
    count: 1,
    apply: (s) => s.replace('    "backend": "auto",\n', ''),
    layer: 'backend',
    expect: 'BLOCKED',
  },
];
