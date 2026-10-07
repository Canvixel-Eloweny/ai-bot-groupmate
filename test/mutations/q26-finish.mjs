/**
 * 2026-10-02「28 条裁决收尾轮」的变异清单 —— 纯数据，供
 * `NODE_OPTIONS= node scripts/mutate.mjs test/mutations/q26-finish.mjs` 复跑。
 *
 * 这批打的是**本轮新长出来的判据与接线**，每条都指向一个具体的失败形态：
 *
 *   | 条 | 打的是 | 该由哪一层拦住 | 期望 |
 *   |---|---|---|---|
 *   | M1  | Q26b：事前剥图**不再留痕**（降级后静默失明回到原状） | smoke T350 | BLOCKED |
 *   | M2  | Q26b：事后剥图（服务端拒收）不再留痕 | smoke T351 | BLOCKED |
 *   | M3  | Q11：道晚安**不置位**（她到点就静默消失） | check-wb §50㉕ | BLOCKED |
 *   | M4  | Q12：闭集合里的 `sleep` 没人接 | check-wb（控制通道） | BLOCKED |
 *   | M5  | Q26f：自动补白名单退化成"只提示" | check-wb §50㉖ | BLOCKED |
 *   | M6  | Q26n：表里声明一个**实测明确拒收**的档位 | check-wb §57 | BLOCKED |
 *   | M7  | Q26n：`think=always` 却没有"关不掉"的实测支撑 | check-wb §57 | BLOCKED |
 *   | M8  | Q45：拷贝里**不补桩**（check-wb 在发布拷贝上 ENOENT） | check-wb §34⑦ | BLOCKED |
 *   | M9  | Q45：把"缺失即崩"松成 try/catch 兜住 | check-wb §34⑦ 反向 | BLOCKED |
 *   | M10 | Q9：取消自用包的 .gitignore 例外 | check-wb §?（plugins 三件套） | BLOCKED |
 *   | M11 | **Q26i 的正主**：抽一层函数建 panel/ 落盘常量（旧行级状态机整条隐身） | check-wb §37③b | BLOCKED |
 *   | M12 | Q13：私聊 poke 的 scene 闸被删（拿 QQ 号当群号） | check-wb §32⑧ | BLOCKED |
 *   | M13 | Q86：睡眠处境的冻结挪到生成**之后**（又变回"两边各读一次"） | check-wb §50㉔ | BLOCKED |
 *
 * ⚠️ **M11 是本轮最要紧的一条**：它就是 Q26i 里"那 20%"的形态 ——
 *    上一版行级状态机 + "声明里必须有 path.join 字面"**整条看不见它**（本仓 M3 实测 NOT-BLOCKED）。
 *    本轮上了 AST-lite（词法切分 + 深度 0 取声明 + 顺着调用下潜一层），M11 必须翻成 BLOCKED。
 * ⚠️ **M1/M2 刻意走行为层**：Q26b 的裁决是"只做可观测、不改选择"，
 *    可观测这件事只有真跑一遍才证明得了（静态层只会看到"有个函数被调用了"）。
 *
 * 期望：13 条全部 `BLOCKED`，`INVALID` 为 0。
 * ⚠️ 跑测试一律 `NODE_OPTIONS= node …`（R39），漏带 = 内部基线假红、mutate 会正确地拒绝开跑。
 * ⚠️ 跑之前**先提交**，并用全新的 `QQBOT_MUTATE_WORK` 目录（R46.1：复用旧目录会把工作树回滚）。
 */

const LLM = 'src/llm.js';
const IDX = 'src/index.js';
const CFG = 'src/config.js';
const CAPS = 'src/model-caps.js';

// ── M1：事前剥图不留痕（识图开着、降级到看不见图的模型 → 又变回静默失明）──────
const M1 = {
  id: 'M1',
  note: '删掉事前剥图的留痕（`if (sentMsgs !== msgs) this.#noteBlind(...)`）—— 降级后它只看到「[图片]」而界面与日志一个字都没有。预期 BLOCKED（smoke T350）',
  file: LLM,
  anchor: /if \(sentMsgs !== msgs\) this\.#noteBlind\(model, provider, 'unsupported'\);/,
  count: 1,
  apply: (s) => s.replace("if (sentMsgs !== msgs) this.#noteBlind(model, provider, 'unsupported');", '// 变异：静默失明'),
  layer: 'smoke',
  expect: 'BLOCKED',
};

// ── M2：事后剥图（服务端拒收）不留痕 ──────────────────────────────────────────
const M2 = {
  id: 'M2',
  note: "删掉去图重试那一次的留痕 —— 两种成因（不支持 / 拒收）从此分不开。预期 BLOCKED（smoke T351）",
  file: LLM,
  anchor: /this\.#noteBlind\(model, provider, 'rejected'\);/,
  count: 1,
  apply: (s) => s.replace("this.#noteBlind(model, provider, 'rejected');", '// 变异：不留痕'),
  layer: 'smoke',
  expect: 'BLOCKED',
};

// ── M3：道晚安不置位（她到点就静默消失，观感是"它掉线了"）─────────────────────
const M3 = {
  id: 'M3',
  note: '把"由醒转睡就说晚安"那一支短路成 `if (false)` —— Q11 等于没接上。预期 BLOCKED（§50㉕ 数置位恰 1）',
  file: IDX,
  anchor: /if \(gn\.say\) \{/,
  count: 1,
  apply: (s) => s.replace('if (gn.say) {', 'if (false) { // 变异：不置位'),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M4：闭集合里的 `sleep` 没人接（点了「让它睡」机器人不认识）─────────────────
const M4 = {
  id: 'M4',
  note: "删掉 `if (cmd === 'sleep') return manualSleepNow();` —— 面板能发、机器人不接，表现是点了没反应且不报错。预期 BLOCKED（控制通道：闭集合里的命令必须都有人接）",
  file: IDX,
  anchor: /if \(cmd === 'sleep'\) return manualSleepNow\(\);/,
  count: 1,
  apply: (s) => s.replace("if (cmd === 'sleep') return manualSleepNow();", '// 变异：没人接'),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M5：自动补白名单退化成"只提示"（主人的私聊叫醒继续空转）───────────────────
const M5 = {
  id: 'M5',
  note: '删掉 `allow.private = [...allow.private, ...ownerAutoPrivate];` —— 回到 Q26f 裁决前的"只提示不改"，主人找她她不醒。预期 BLOCKED（§50㉖）',
  file: CFG,
  anchor: /allow\.private = \[\.\.\.allow\.private, \.\.\.ownerAutoPrivate\];/,
  count: 1,
  apply: (s) => s.replace('allow.private = [...allow.private, ...ownerAutoPrivate];', '// 变异：只提示不补'),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M6：表里声明的档位，实测**明确拒收**（"支持 max"这半句没有证据）─────────────
// ⚠️ 打的是**实测数据**而不是能力表：`capabilitiesOf` 对 `think=NONE` 的模型会把 levels 归一成 []，
//    改 `efforts` 不会改变比对结果（第一版就打空了，NOT-BLOCKED）。
const M6 = {
  id: 'M6',
  note: "把 `glm-4.5-air` 的 `effort.max` 改成 ok=0（并去掉 levelAlias 兜底）—— 表里仍声明 max，而实测明确拒收。预期 BLOCKED（§57：声明的档位不许实测明确失败）",
  file: 'scripts/probe-result.json',
  anchor: /"glm-4\.5-air": \{/,
  count: 1,
  apply: (s) => {
    const j = JSON.parse(s);
    j['glm-4.5-air'].effort.max = { ok: 0, code: '1214', msg: 'invalid parameter: reasoning_effort' };
    delete j['glm-4.5-air'].levelAlias;
    return JSON.stringify(j, null, 2);
  },
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M7：标了"能关"而实测 `thinkOff` 明确失败（界面会给一个按了就 400 的开关）────
const M7 = {
  id: 'M7',
  note: '把 `glm-5.3-flash` 的 think 从 ALWAYS 改成 OFFABLE —— 而实测 thinkOff 是 1210「该模型始终思考，不支持关闭思考」。预期 BLOCKED（§57 ④ 的反向：标了可关就不许关不掉）',
  file: CAPS,
  anchor: /'glm-5\.3-flash': \{ functions: true, ms: 2900, think: THINK\.ALWAYS/,
  count: 1,
  apply: (s) => s.replace(
    "'glm-5.3-flash': { functions: true, ms: 2900, think: THINK.ALWAYS,",
    "'glm-5.3-flash': { functions: true, ms: 2900, think: THINK.OFFABLE,",
  ),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M8：拷贝里不补桩（check-wb 在**要发布的那一份**上 ENOENT）─────────────────
const M8 = {
  id: 'M8',
  note: "把 `const STUBS = {…}` 改成空对象 —— 桩一个都不写，验收门在对外拷贝上读不到 PUBLISH-CHECKLIST 直接崩，于是'别人 clone 下来能不能跑验收'永远验不了。预期 BLOCKED（§34⑦ 判的是**声明里带着那个键**，不是'文件里出现过名字'）",
  file: 'scripts/make-publish-copy.mjs',
  anchor: /const STUBS = \{/,
  count: 1,
  apply: (s) => s.replace(/const STUBS = \{[\s\S]*?\n\};/, 'const STUBS = {};'),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M9：把"缺失即崩"松成守卫式（Q45 里被否掉的那条路）─────────────────────────
const M9 = {
  id: 'M9',
  note: "把 §34 读 PUBLISH-CHECKLIST 那处包进 try/catch —— '文件不存在即崩'退化成一条没人看的记红。预期 BLOCKED（§34⑦ 反向判据）",
  file: 'scripts/check-wb.mjs',
  anchor: /const chkSrc = readRaw\('\.\.\/docs\/PUBLISH-CHECKLIST\.md'\);/,
  count: 1,
  apply: (s) => s.replace(
    "const chkSrc = readRaw('../docs/PUBLISH-CHECKLIST.md');",
    "let chkSrc = ''; try { chkSrc = readRaw('../docs/PUBLISH-CHECKLIST.md'); } catch { chkSrc = ''; } // 变异：松成守卫",
  ),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M10：取消自用包的 .gitignore 例外 ─────────────────────────────────────────
const M10 = {
  id: 'M10',
  note: "删掉 `!/plugins/本体情绪/` —— 自用包回到'没有版本、没有回滚'，且别人的 clone 上 §38 / T233–T241 输入集合为空。预期 BLOCKED",
  file: '.gitignore',
  anchor: /!\/plugins\/本体情绪\/\n/,
  count: 1,
  apply: (s) => s.replace('!/plugins/本体情绪/\n', ''),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M11（正主）：抽一层函数建 panel/ 落盘常量 ─────────────────────────────────
// ⚠️ H-10 第 22 轮：`TRACE_FILE` 随写盘口那一族搬进 `src/bridge-io.js`，
//    锚点跟着实现走（§37③b 的取源已合并两处，注入哪个文件都能被扫到）。
const BIO = 'src/bridge-io.js';
const M11 = {
  id: 'M11',
  note: "新增 `function panelPathOf(n){return path.join(ROOT,'panel',n)}` + `const NOTE_FILE = panelPathOf('.x.json');` —— 声明里没有 path.join 字面，**旧的'字面筛选'整条看不见它**（Q26i 裁决②上 AST 就是为了这条）。预期 BLOCKED（§37③b AST-lite 下潜一层）",
  file: BIO,
  anchor: /const TRACE_FILE = /,
  count: 1,
  apply: (s) => s.replace(
    'const TRACE_FILE = ',
    "function panelPathOf(n) { return path.join(ROOT, 'panel', n); }\nconst NOTE_FILE = panelPathOf('.x.json');\nconst TRACE_FILE = ",
  ),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M12：私聊 poke 的 scene 闸被删（拿 QQ 号当群号去查成员）───────────────────
const M12 = {
  id: 'M12',
  note: "把 `if (n.scene !== 'group')` 短路成 `if (false)` —— 私聊戳一戳又被错合成群事件。预期 BLOCKED（§32⑧）",
  file: IDX,
  anchor: /if \(n\.scene !== 'group'\) \{/,
  count: 1,
  apply: (s) => s.replace("if (n.scene !== 'group') {", "if (false) { // 变异：闸没了"),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M13：睡眠处境的冻结挪到生成之后（又变回"提示词一句、trace 一句"）───────────
const M13 = {
  id: 'M13',
  note: "把 `const sleepRound = {...}` 挪到 `const decision = brain.decide(` 之后 —— Q86 要消掉的正是这个（两边各读一次快照）。预期 BLOCKED（§50㉔ 判位置）",
  file: IDX,
  anchor: /const sleepRound = \{ wakeKind: String\(sleepSnap\?\.wakeKind \|\| ''\), catchUp: !!evt\.isCatchUp \};/,
  count: 1,
  apply: (s) => {
    const freeze = "const sleepRound = { wakeKind: String(sleepSnap?.wakeKind || ''), catchUp: !!evt.isCatchUp };";
    const stripped = s.replace(`${freeze}\n`, '');
    return stripped.replace(
      'const decision = brain.decide(session, evt, parsed);',
      `const decision = brain.decide(session, evt, parsed);\n    ${freeze}`,
    );
  },
  layer: 'check-wb',
  expect: 'BLOCKED',
};

export default [M1, M2, M3, M4, M5, M6, M7, M8, M9, M10, M11, M12, M13];
