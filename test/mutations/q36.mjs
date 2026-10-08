/**
 * Q36 批（外包任务1 v8 回执采纳 · 8 条加严的"换写法缝隙"收口，2026-09-30）的变异清单。
 *
 * 来源：任务1 v8 回执 §二·2.2 —— 对上一批 8 条加严各换一种写法下手，**5 条全部静默
 * 穿过静态层**（其中 4 条行为层也没兜住 = 双层皆绿真缺口）。已在本仓独立复现
 * （test/mutations/task1v8-review.mjs 原样跑：V1–V5 NOT-BLOCKED · G1–G4 NOT-BLOCKED ·
 * G5 BLOCKED），结论与回执逐字一致后采纳。
 *
 * 落地（全部在 check-wb 静态层，行为层 T310 前缀表随 V1 补全）：
 *   · V1 → §48② 导出白名单改**运行时 namespace 枚举**（文本扫描认不全导出形态）
 *   · V2 → §50⑤ `setTimeout` 与 setInterval 同法数**标识符**（别名声明也算一次）
 *   · V3 → §49① 特征常量正则加 `/i` + 补十进制形态
 *   · V4 → §48③ 方括号计数的引号集合补**反引号**
 *   · V5 → §50② 顶层禁 `status:` 补**计算键**形态（含反引号）
 *
 * 期望：五条全部 `BLOCKED`，`INVALID` 为 0。
 * ⚠️ 跑测试一律 `NODE_OPTIONS= node …`（R39）。
 */

export default [
  {
    id: 'V1',
    note: '换写法打 Q49：箭头函数 + 导出清单形态的"无参清空"（白名单曾只扫 `export function` 声明）',
    file: 'src/unread.js',
    anchor: /^export function consume\(list, ids\) \{$/m,
    count: 1,
    apply: (s) => s.replace(
      'export function consume(list, ids) {',
      'const purgeAll = () => [];\n'
      + 'export { purgeAll };\n\n'
      + 'export function consume(list, ids) {'
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'V2',
    note: '换写法打 Q54/零定时器：新调度藏进第四个函数 + setTimeout 别名（曾只数 setInterval + 扫三个具名函数体）',
    file: 'src/index.js',
    anchor: /^  function evaluateWake\(\{ scene, userId, mentionedSelf, text, now, sessionKey = '' \}\) \{$/m,
    count: 1,
    apply: (s) => {
      let out = s.replace(
        "  function evaluateWake({ scene, userId, mentionedSelf, text, now, sessionKey = '' }) {",
        '  function promotePendingWakeSoon() {\n'
        + '    const iv = setTimeout; // 变异：把"窗口到了"交给一条新定时器（别名写法）\n'
        + '    iv(() => {\n'
        + '      const p = wakePromotionOf({ pending: wakePending, now: Date.now(), wakeAt: Number(sleepSnap?.wakeAt) || 0 });\n'
        + '      if (p.promote && p.override) { wakePending = null; sleepState = { ...sleepState, override: p.override }; journal(\'wake\', `叫醒：${p.reason}`); }\n'
        + '    }, 10000);\n'
        + '  }\n\n'
        + "  function evaluateWake({ scene, userId, mentionedSelf, text, now, sessionKey = '' }) {"
      );
      out = out.replace(
        "      if (r.action === 'hold') wakePending = r.pending;",
        "      if (r.action === 'hold') { wakePending = r.pending; promotePendingWakeSoon(); }"
      );
      return out;
    },
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'V3',
    note: '换写法打 Q52：改名复辟一份 CRC，魔数用大写十六进制（正则曾大小写敏感）',
    file: 'panel/server.js',
    anchor: /^import \{ createHash \} from 'node:crypto';$/m,
    count: 1,
    apply: (s) => s.replace(
      /^import \{ createHash \} from 'node:crypto';$/m,
      'const CRC_POLY_K = 0xEDB88320; // 变异：改名复辟一份 CRC（大写魔数）\n'
      + 'function crcOf(buf) { let c = 0xFFFFFFFF; for (const b of buf) { c ^= b; for (let i = 0; i < 8; i += 1) c = (c >>> 1) ^ (CRC_POLY_K & -(c & 1)); } return (c ^ 0xFFFFFFFF) >>> 0; }\n'
      + "import { createHash } from 'node:crypto';"
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'V4',
    note: '换写法打 Q27（§48③）：反引号形态另开一处清空 session[`unread`] = []',
    file: 'src/bridge-io.js',
    anchor: /^function noteUnread\(session, info\) \{$/m,
    count: 1,
    apply: (s) => s.replace(
      'function noteUnread(session, info) {',
      'function noteUnread(session, info) {\n  if (info && info.now === -7) session[`unread`] = []; // 变异：反引号写法另开一处清空'
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'V5',
    note: '换写法打 Q53：计算键 [`status`] 塞进 normalizeSleepState 的返回对象（键数扫描与行尾内联检查曾都看反引号）',
    file: 'src/sleep.js',
    anchor: /^    override,$/m,
    count: 1,
    apply: (s) => s.replace(
      '    override,',
      '    override,\n    [`status`]: String(raw.status ?? ""), // 变异：计算键形态多塞一个字段'
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
];
