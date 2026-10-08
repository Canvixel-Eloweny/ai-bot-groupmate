/**
 * 我方自审 · §45「视觉链路」+ §46「提醒三件套」专项变异 · 2026-10-02
 * 代替外包任务2 v6 组 B 的 §45 / §46 —— 这两段**从未被任何一轮外包专项打过**。
 *
 * 号段：我方字母后缀（Q26o 起），不占外包 Q89 / Q216。
 * `NODE_OPTIONS= node scripts/mutate.mjs test/mutations/self-v6-s45-46.mjs`
 */

export default [
  // ── §45 视觉链路 ────────────────────────────────────────────────────────
  {
    id: 'S1',
    file: 'src/onebot.js',
    anchor: /case 'video':/,
    count: 1,
    // 攻击「视频地址不许混进 images」：判据在 video 段里搜的是 `images.push` 这个**写法**。
    // 换成 `images = images.concat([...])` 语义完全一样，正则就认不出来了 ——
    // 于是"视频 URL 被当成图片发给模型"这件事（本架构里根本不存在这条链路）会溜过去。
    apply: (src) => src.replace(
      "      case 'video':\n        text += '[视频]';\n        bareText += '[视频]';",
      "      case 'video':\n        text += '[视频]';\n        bareText += '[视频]';\n        if (/^https?:\\/\\//i.test(String(c?.data?.file || ''))) images = images.concat([String(c.data.file)]);",
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
    note: '§45：video 段用 concat 把地址收进 images（判据只认 `images.push` 这种写法）',
  },
  {
    id: 'S2',
    file: 'src/ambient.js',
    anchor: /^export /m,
    count: 2,
    // 攻击「不许引入图像处理库」：正则写的是 `sharp\(`（要求紧跟括号），
    // 而真实引入是 `import sharp from 'sharp'` —— **永远不含 `sharp(`**。
    // 于是 ffmpeg/sharp 这类库一旦被引入（而本架构明确"压缩/抽帧/视频没有落点"）就没人报。
    apply: (src) => `import sharp from 'sharp';\n${src}\nvoid sharp;\n`,
    layer: 'check-wb',
    expect: 'BLOCKED',
    note: '§45：`import sharp from \'sharp\'` 绕过图像处理库扫描（正则只认 `sharp(`）',
  },
  {
    id: 'S4',
    file: 'scripts/probe-vision.mjs',
    anchor: /verifyPng\(/,
    count: 1,
    // 【阳性对照】真的做错：把「核对测试图」挪到探测循环**之后**（先请求、后核对）。
    // 报告点名的坑就是它 —— 不合法的那次请求已经花掉额度，而且结论会是错的（"模型看不见"）。
    apply: (src) => {
      const i = src.indexOf('verifyPng(');
      const ls = src.lastIndexOf('\n', i) + 1;
      const le = src.indexOf('\n', i);
      if (le < 0) return src;
      const line = src.slice(ls, le);
      const rest = src.slice(0, ls) + src.slice(le + 1);
      const loop = rest.indexOf('for (const m of models)');
      if (loop < 0) return src;
      const after = rest.indexOf('\n', rest.indexOf('{', rest.indexOf(')', loop)));
      return `${rest.slice(0, after + 1)}${line}\n${rest.slice(after + 1)}`;
    },
    layer: 'check-wb',
    expect: 'BLOCKED',
    note: '§45【阳性对照】verifyPng 真的挪到探测循环之后（先请求后核对，白花额度且结论错）',
  },
  {
    id: 'S5',
    file: 'src/vision-probe.js',
    anchor: /export const VISION_VERDICTS/,
    count: 1,
    // 【阳性对照】真的做错：结论集合多出第四种。调用方要按它分支，
    // 随手加一种会让"看不见 / 未能判定"重新混在一起。
    apply: (src) => src.replace(
      "Object.freeze(['yes', 'no', 'unknown'])",
      "Object.freeze(['yes', 'no', 'unknown', 'maybe'])",
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
    note: '§45【阳性对照】VISION_VERDICTS 多出第四种（调用方按它分支，随手加不会被发现）',
  },

  // ── §46 提醒三件套 ──────────────────────────────────────────────────────
  {
    id: 'S9',
    file: 'src/reminder.js',
    anchor: /^export function dueMsOf\(/m,
    count: 1,
    // 攻击「判据不许碰 IO」—— 与 §44 的 M1 **同型**：
    // 正则里只有 `process\.on\(`（要求括号），而真实写法 `process.env.XXX` 没有括号，
    // 所以"提醒判据偷偷读环境变量"这条路径**完全没人看**。
    // ⚠️ 若这条 NOT-BLOCKED，说明这不是 §44 一处的笔误，而是**跨段的系统性形态**。
    apply: (src) => `${src}\nconst _probeEnv = process.env.QQBOT_REMINDER_TEST;\nvoid _probeEnv;\n`,
    layer: 'check-wb',
    expect: 'BLOCKED',
    note: '§46①：`process.env.XXX` 应被"判据零 IO"拦下（与 §44 M1 同型，看是不是系统性形态）',
  },
  {
    id: 'S7',
    file: 'src/index.js',
    // ⚠️ 锚点必须锚到**调用点**而不是裸函数名：`saveReminderState` 在 index.js 里
    //    出现 2 次（2254 的定义 + 2383 的调用），锚宽了会命中 2 → INVALID。
    anchor: /if \(reminderDirty\) saveReminderState\(\);/,
    count: 1,
    // 【阳性对照】真的做错：不落盘 → 重启一次就把今天发过的再发一遍。
    apply: (src) => src.replace('if (reminderDirty) saveReminderState();', 'if (reminderDirty) void 0;'),
    layer: 'check-wb',
    expect: 'BLOCKED',
    note: '§46【阳性对照】tickProactive 里真的不落盘（重启就重发一遍）',
  },
  {
    id: 'S8',
    file: 'src/reminder.js',
    anchor: /if \(now - dueMs </,
    count: 1,
    // 【阳性对照】真的做错：窗口起点从"到期时刻"改成"当前时刻" →
    // 每条提醒在启动的那一刻就算"已到期"，30 分钟重试窗完全失效。
    // ⚠️ 必须替换**整句**：`src.replace('now - dueMs', …)` 只会命中第一处，
    //    而第一处在 **:29 的注释里** —— 改的是注释、真代码没动，判据当然不响。
    //    实测第一版就是这个 bug，结果被误读成"§46 判据有洞"（**变异自己骗自己**）。
    apply: (src) => src.replace(
      'if (now - dueMs < REMINDER_WINDOW_MS)',
      'if (now - now < REMINDER_WINDOW_MS)',
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
    note: '§46【阳性对照】窗口起点从到期时刻改成当前时刻（Q24 裁决的口径被改坏）',
  },
];
