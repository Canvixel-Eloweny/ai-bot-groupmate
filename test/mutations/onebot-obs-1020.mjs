/**
 * 协议端可观测面（2026-10-20 · 步骤 1 的 B2–B6）的变异清单 —— 纯数据，
 * 供 `NODE_OPTIONS= node scripts/mutate.mjs test/mutations/onebot-obs-1020.mjs` 复跑。
 *
 * 这一批分两层：
 *   · M1–M6 打 **§24 重连五条 + 输入基数**（静态层，check-wb）；
 *   · M7–M11 打**新长出来的可观测链**（行为层，smoke T396–T398）：
 *       心跳消费 → 周期 get_status → 健康快照落 effective → 面板投影。
 *     为什么必须用行为层：这四条全是"接线"，静态判据只能钉住"代码里有没有这行"，
 *     钉不住"这条线到底通不通"—— M7/M8 改完后代码形状仍然完整，只有真跑才能看见。
 *
 * ⚠️ 跑这一批必须带 `NODE_OPTIONS=` 前缀（R39），且**串行**（mutate 会改写真实工作树）。
 * ⚠️ 行为层每条会跑一遍完整 smoke（约 3 分钟）；先用 `--layer check-wb` 跑静态那六条。
 * ⚠️ 跑之前先提交；用全新的 `QQBOT_MUTATE_WORK` 目录（R46.1）。
 */

const OB = 'src/onebot.js';
const IDX = 'src/index.js';

export default [
  // ── §24 六条：重连入口唯一（方案 B）───────────────────────────────────────
  {
    id: 'M1',
    note: '在文件里再声明一个带 `#connect()` 的类 —— §24① 的「定义恰好 1 处」必须变红'
      + '（重复定义 = 两套重连逻辑并存的入口）。预期 BLOCKED（check-wb §24①）',
    file: OB,
    anchor: /export class OneBotClient extends EventEmitter \{/,
    count: 1,
    apply: (s) => s.replace(
      'export class OneBotClient extends EventEmitter {',
      'class __DummyConnectProbe {\n  #connect() {}\n}\n\nexport class OneBotClient extends EventEmitter {'
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M2',
    note: 'start() 里多调一次 `#connect()` —— §24① 的「调用点恰好 2」变红'
      + '（多出来的入口就是"两条连接循环并存"）。预期 BLOCKED（check-wb §24①）',
    file: OB,
    anchor: /    this\.#connect\(\);\n    this\.#startStatusProbe\(\);/,
    count: 1,
    apply: (s) => s.replace(
      '    this.#connect();\n    this.#startStatusProbe();',
      '    this.#connect();\n    this.#connect();\n    this.#startStatusProbe();'
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M3',
    note: "open 处理器里不再把 attempt 归零 —— 重连成功后还背着涨到顶的退避（30 秒才重连一次）。"
      + '预期 BLOCKED（check-wb §24②）',
    file: OB,
    anchor: /      this\.connected = true;\n      this\.attempt = 0;/,
    count: 1,
    apply: (s) => s.replace('      this.connected = true;\n      this.attempt = 0;', '      this.connected = true;'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M4',
    note: '退避取值不再夹下标 —— 越界时 delay 是 undefined，setTimeout 按 0 处理 ⇒ 立刻重连风暴。'
      + '预期 BLOCKED（check-wb §24③）',
    file: OB,
    anchor: /backoff\[Math\.min\(this\.attempt, backoff\.length - 1\)\]/,
    count: 1,
    apply: (s) => s.replace('backoff[Math.min(this.attempt, backoff.length - 1)]', 'backoff[this.attempt]'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M5',
    note: 'close 处理里不再判 closedByUs —— stop() 之后还会自己连回来（关不掉的进程）。'
      + '预期 BLOCKED（check-wb §24④）',
    file: OB,
    anchor: /if \(this\.closedByUs\) return;/,
    count: 1,
    apply: (s) => s.replace('if (this.closedByUs) return;', 'if (false) return;'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M6',
    note: 'index.js 里再调一次 `bot.start()` —— 第二个入口会开第二条连接循环，'
      + '那时必须补代际号（方案 A）。预期 BLOCKED（check-wb §24⑤）',
    file: IDX,
    anchor: /bot\.start\(\);\n  onebotHealthSnap = bot\.healthSnapshot\(\);/,
    count: 1,
    apply: (s) => s.replace(
      'bot.start();\n  onebotHealthSnap = bot.healthSnapshot();',
      'bot.start();\n  bot.start();\n  onebotHealthSnap = bot.healthSnapshot();'
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },

  // ── 可观测链：心跳 / 周期探活 / 快照落盘 / 面板投影 ──────────────────────
  {
    id: 'M7',
    note: '心跳事件不再被识别（分支条件改成永远不匹配）—— 心跳落进 notice、lastHeartbeatAt 恒 0。'
      + '代码形状仍然完整，只有真跑才发现。预期 BLOCKED（smoke T396）',
    file: OB,
    anchor: /payload\.meta_event_type === 'heartbeat'/,
    count: 1,
    apply: (s) => s.replace("payload.meta_event_type === 'heartbeat'", "payload.meta_event_type === 'heartbeat-disabled'"),
    layer: 'smoke',
    expect: 'BLOCKED',
  },
  {
    id: 'M8',
    note: '周期探活不启动（`#startStatusProbe` 第一行直接 return）—— 机器人再不问 get_status，'
      + '面板只能等后端推心跳（而有的家根本不推）。预期 BLOCKED（smoke T396 / T397）',
    file: OB,
    anchor: /if \(!this\.statusProbeMs \|\| this\.statusTimer\) return;/,
    count: 1,
    apply: (s) => s.replace('if (!this.statusProbeMs || this.statusTimer) return;', 'return;'),
    layer: 'smoke',
    expect: 'BLOCKED',
  },
  {
    id: 'M9',
    note: 'effective.json 不再带 onebotHealth —— 面板那一行永远显示"还没上报"，'
      + '而机器人其实知道心跳与超时。预期 BLOCKED（smoke T397）',
    file: IDX,
    anchor: /      onebotHealth: onebotHealthSnap,\n/,
    count: 1,
    apply: (s) => s.replace('      onebotHealth: onebotHealthSnap,\n', ''),
    layer: 'smoke',
    expect: 'BLOCKED',
  },
  {
    id: 'M10',
    note: '20 秒快照只写配置、不刷新 onebotHealth —— 快照永远停在启动那一刻（connected=false）。'
      + '预期 BLOCKED（smoke T397）',
    file: IDX,
    anchor: /    onebotHealthSnap = bot\.healthSnapshot\(\);\n    writeEffective\(cfg\);/,
    count: 1,
    apply: (s) => s.replace('    onebotHealthSnap = bot.healthSnapshot();\n    writeEffective(cfg);', '    writeEffective(cfg);'),
    layer: 'smoke',
    expect: 'BLOCKED',
  },
  {
    id: 'M11',
    note: '自报投影不再带 probedAt —— 面板无法区分"两个观测面各是什么时候看到的"（B6 双时刻退化成一句）。'
      + '预期 BLOCKED（smoke T398）',
    file: 'panel/lib/state-collector.js',
    anchor: /    probedAt: now,\n/,
    count: 1,
    apply: (s) => s.replace('    probedAt: now,\n', ''),
    layer: 'smoke',
    expect: 'BLOCKED',
  },
];
