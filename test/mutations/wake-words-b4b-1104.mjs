/**
 * 批 B4b（BUG-12 方案② · 叫醒暗号摆到台面）定向变异（2026-11-04）。
 *
 * 这一族的形状是"**一条规则住在一个地方，另有六个人必须都从那一处取**"：
 *   词表与连发参数住在 `src/sleep.js` 的三个常量里；
 *   `wakeRouteMetaOf()` 换算 → `customMeta.sleep` 下发 → `sleepWake` 渲染 →
 *   schema 挂控件 + 类型白名单 → demo 夹具（浏览器侧引不到 src，只能抄，
 *   所以抄的那份必须被逐字盯住）→ 快照另带**此刻生效**的词表 + 面板给中文名。
 * 任何一环改回"自己写一份"，页面就开始对一个还没改的判据撒谎 ——
 * 而 §50㉒ 的第三条是**反向**的（面板文案里出现「10 秒内连发 3 条」就变红），
 * 所以"把数字抄进文案"这个最常见的退化方向本身会被拦，W3 专打它。
 *
 * 跑法（串行；会改写真实工作树，失败后用 `--restore`）：
 *   NODE_OPTIONS= node scripts/mutate.mjs test/mutations/wake-words-b4b-1104.mjs
 */

const SLP = 'src/sleep.js';
const COL = 'panel/lib/state-collector.js';
const APP = 'panel/next/app.js';
const SCH = 'panel/next/schema.js';
const DEMO = 'panel/next/demo-state.js';
const IDX = 'src/index.js';

export default [
  {
    id: 'W1',
    note: 'wakeRouteMetaOf 把三个数字写死（不再由常量换算）—— §50㉒① 必须变红（判据改了而页面照旧撒谎）',
    file: SLP,
    anchor: /burstWindowSec: WAKE_BURST\.windowMs \/ 1000,/g,
    count: 1,
    apply: (s) => s.replace(
      'burstWindowSec: WAKE_BURST.windowMs / 1000,\n    burstCount: WAKE_BURST.count,\n    emergencyQuietMin: EMERGENCY_QUIET_MS / 60000,',
      'burstWindowSec: 10,\n    burstCount: 3,\n    emergencyQuietMin: 10,',
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'W2',
    note: 'customMeta 不再下发 sleep 那一格 —— §50㉒② 必须变红（换算函数写了但没人调用）',
    file: COL,
    anchor: /sleep: wakeRouteMetaOf\(custom\.sleep\),/g,
    count: 1,
    apply: (s) => s.replace('        sleep: wakeRouteMetaOf(custom.sleep),\n', ''),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'W3',
    note: '面板文案里把数字抄成第二份 —— §50㉒③ 的**反向**判据必须变红（这是这条纪律唯一真正在生效的方向）',
    file: APP,
    anchor: /const warns = \[\];/g,
    count: 1,
    apply: (s) => s.replace(
      '    const warns = [];',
      "    const staleCopy = '私聊 10 秒内连发 3 条（万一后端没下发就用这份）';\n    const warns = [];",
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'W4',
    note: '控件没挂进睡眠状态卡 —— §50㉒④ 必须变红（页面静默少一块，看起来一切正常）',
    file: SCH,
    anchor: /\{\s*t: 'sleepWake'\s*\},/g,
    count: 1,
    apply: (s) => s.replace("              { t: 'sleepWake' },\n", ''),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'W5',
    note: 'demo 夹具的词表被改（与 `WAKE_WORDS_DEFAULT` 不一致）—— §50㉒⑤ 必须变红（演示页在教错的暗号）',
    file: DEMO,
    anchor: /words: \['起床', '醒醒', '醒一醒', '别睡了', '起来了'\],/g,
    count: 1,
    apply: (s) => s.replace(
      "words: ['起床', '醒醒', '醒一醒', '别睡了', '起来了'],",
      "words: ['起床', '醒醒'],",
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'W6',
    note: '睡眠快照不再下发此刻生效的词表 —— §50㉒⑥ 必须变红（配置改了但机器人没重载时页面会说谎）',
    file: IDX,
    anchor: /wakeWords: sc\.wakeWords,/g,
    count: 1,
    apply: (s) => s.replace('        wakeWords: sc.wakeWords,\n', ''),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'W7',
    note: '面板没给快照里的 wakeWords 中文名 —— §50㉒⑥ 的另一半必须变红（下发了没人看）',
    file: APP,
    anchor: /wakeWords: '生效中的叫醒词',/g,
    count: 1,
    apply: (s) => s.replace("  wakeWords: '生效中的叫醒词',\n", ''),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
];
