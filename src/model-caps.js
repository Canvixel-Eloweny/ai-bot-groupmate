/**
 * ══════════════════════════════════════════════════════════════════════
 *  模型能力档案 —— 全项目唯一真相源
 * ══════════════════════════════════════════════════════════════════════
 *  解决的问题：用户明确抱怨过「点了是没用的」——
 *  切到某个模型之后，思考开关、强度档位、联网/识图开关里，
 *  有的一按就报错（机器人直接哑掉），有的按了毫无反应（参数被服务端忽略）。
 *
 *  做法：把「这个模型到底支持什么」集中成一张表 + 一组判定函数，
 *  **三个地方共用同一个判断**，任何一个地方都不再自己写 if：
 *    · panel/server.js —— 下发能力给面板渲染、写入配置时兜底校验
 *    · src/llm.js      —— 真正发请求前把模型不认的参数摘掉（最后一道闸）
 *    · src/brain.js    —— 决定要不要把图片组装进消息
 *  以前这里是三份独立的规则（VISION_MODELS 名单在 llm.js、能力开关在 server.js、
 *  服务商判断在两处各一份），漂移过一次就够难受了 —— 报告里反复记着这件事。
 *
 *  ⚠️ 本表里的每一项都是**实测**出来的，不是抄文档：
 *     文档只写官方口径，而"同一个参数对某些模型被静默忽略"这种事文档不会说。
 *     实测脚本：scripts/probe-models.mjs（改完表以后重跑它核对）。
 *     测出过的两个反直觉事实，都是这里的依据：
 *       · glm-4.6v 收下 tools 参数、返回 200、答案看着也像回事，
 *         但 prompt_tokens 纹丝不动（25 → 25）→ 搜索结果根本没被注入，联网对它无效。
 *       · glm-4.5-air 会思考（reasoning_content 非空、耗时 2.3 秒），
 *         但 reasoning_tokens 报 0 → 用 token 数判断"支不支持思考"会误判。
 *
 *  ──────────────────────────────────────────────────────────────────────
 *  `functions` 位的实测记录（第 46 轮 B12e-1，2026-09-21）
 *  ──────────────────────────────────────────────────────────────────────
 *  脚本 `scripts/probe-functions.mjs`；原始证据 `scripts/functions-probe-result.json`。
 *  样本：23 个模型（19 智谱 + 4 DeepSeek）× 2 次请求（auto / 强制 tool_choice）。
 *
 *  结果：**23/23 全部通过 ≥1 道判据**，全部填 `functions: true`。
 *  「未能判定」一个也没有 —— 所以这次没有需要靠"保守 false"兜底的模型。
 *
 *  三条读数必须留着（它们改变了设计）：
 *    ① `glm-ocr` 是 **noChat**（不是对话模型），**没有** `functions` 位 ——
 *       它本来就不该出现在工具链上。
 *    ② DeepSeek 三款（flash / v4-pro / reasoner）**auto 全部通过**，但
 *       **强制 tool_choice 一律 400**：`"Thinking mode does not support this tool_choice"`。
 *       → **生产代码不许给 body 加 `tool_choice`**。这一条是实测换来的，
 *         不是"我们没用到所以无所谓"——它挡的是将来有人顺手加一行。
 *    ③ `glm-5.3` 的 auto 那次是**超时**（90 秒 abort）、强制那次成功；
 *       `glm-4.6v-flash` 的强制那次是 **429**（访问量过大）。两者都靠另一道判据
 *       拿到了"支持"的结论 —— 这也是为什么判据要有两道，单道会得出假阴性。
 *
 *  未测的模型：本机 mlx / QwenChat 通道（`localMetaOf`）保持 `functions: false` ——
 *  本机 4B **没有实测**，按保守取 false（附 Q.5 风险 3："本机 4B 几乎肯定不支持"）。
 */

/** 思考能力的三种形态。字符串常量，避免各处写裸字符串写错 */
export const THINK = {
  OFFABLE: 'offable', // 能开也能关
  ALWAYS: 'always',   // 始终思考，关了就 400（必须在界面上禁掉"关闭"）
  NONE: 'none',       // 不产生思考，开关对它没有意义
};

/** 智谱认的思考强度档（就是官方 reasoning_effort 的取值域） */
const ZHIPU_LEVELS = ['low', 'high', 'max'];
/** DeepSeek 的 reasoning_effort 档位不同，它没有 max、有 medium */
const DEEPSEEK_LEVELS = ['low', 'medium', 'high'];

/**
 * 智谱模型档案。
 *
 * 字段：
 *   ms        实测延迟（毫秒）。口径：关闭思考、max_tokens=8、单次。用于线路板排序
 *   pack      该模型消耗哪个赠送额度包（展示用），缺省 = 走"通用模型"包
 *   free      智谱官方承诺"永久免费"，永远不花钱
 *   throttled 免费档晚高峰实测会被 429 限流（放链首会白等一次超时）
 *   vision    多模态，能看群里的图
 *   webSearch 内置联网工具**真的会把结果注入上下文**（实测判据：带工具后 prompt_tokens 暴涨）
 *   functions **function 型 tools**：我们自己提供函数、模型决定调哪个。
 *             判据是实测「返回了 tool_calls」（scripts/probe-functions.mjs）。
 *             ⚠️ 与 `webSearch` **是两件事**，不能混：webSearch 是服务商内置的搜索实现，
 *                只认它自己的 `{type:'web_search'}` 结构；functions 认的是
 *                `{type:'function', function:{name,…}}`。有的模型两者都不支持，
 *                有的只支持其中一个 —— 所以**两个独立的能力位**。
 *   think     思考形态，见 THINK
 *   efforts   该模型真正生效的强度档；空数组 = 不分档
 */
export const ZHIPU_MODEL_META = {
  // ── 主力：最快 + 有专属赠送额度。群聊真正该用的就是这两三档 ──
  'glm-4.5-air': { functions: true, ms: 408, pack: '1200万 GLM-4.5-Air 包', think: THINK.OFFABLE, efforts: ZHIPU_LEVELS, webSearch: true },
  'glm-4.6v': { functions: true, ms: 423, pack: '600万 GLM-4.6V 包', think: THINK.OFFABLE, efforts: ZHIPU_LEVELS, vision: true, webSearch: false },
  'glm-4.7': { functions: true, ms: 2944, pack: '500万 GLM-4.7 包', think: THINK.OFFABLE, efforts: ZHIPU_LEVELS, webSearch: true },
  // ── 兜底：通用包 / 纯按量，不挑模型，快就完事 ──
  'glm-4-flash': { functions: true, ms: 453, think: THINK.NONE, efforts: [], webSearch: true },
  'glm-4-flash-250414': { functions: true, ms: 471, think: THINK.NONE, efforts: [], webSearch: true },
  'glm-4.5': { functions: true, ms: 658, think: THINK.OFFABLE, efforts: ZHIPU_LEVELS, webSearch: true },
  'glm-5': { functions: true, ms: 851, think: THINK.OFFABLE, efforts: ZHIPU_LEVELS, webSearch: true },
  'glm-5.2': { functions: true, ms: 864, think: THINK.OFFABLE, efforts: ZHIPU_LEVELS, webSearch: true },
  'glm-5v-turbo': { functions: true, ms: 1198, think: THINK.OFFABLE, efforts: ZHIPU_LEVELS, vision: true, webSearch: false },
  'glm-4.6': { functions: true, ms: 1786, think: THINK.OFFABLE, efforts: ZHIPU_LEVELS, webSearch: true },
  'glm-4.5-flash': { functions: true, ms: 2584, think: THINK.OFFABLE, efforts: ZHIPU_LEVELS, webSearch: true },
  'glm-5.1': { functions: true, ms: 4046, think: THINK.OFFABLE, efforts: ZHIPU_LEVELS, webSearch: true },
  'glm-5-turbo': { functions: true, ms: 4519, think: THINK.OFFABLE, efforts: ZHIPU_LEVELS, webSearch: true },
  // ── 官方永久免费，但晚高峰挤不进去（实测 429）。正因为免费，放链尾最划算 ──
  'glm-4.7-flash': { functions: true, ms: 157, free: true, throttled: true, think: THINK.OFFABLE, efforts: ZHIPU_LEVELS, webSearch: true },
  'glm-4.6v-flash': { functions: true, ms: 165, free: true, throttled: true, vision: true, think: THINK.OFFABLE, efforts: ZHIPU_LEVELS, webSearch: false },
  // ── 始终思考，不许关 ──
  //   以前这两个模型被**从候选名单里剔除**了 —— 那只是一种权宜：因为整页只有一个
  //   全局思考开关，而它们不能被关，留在名单里就一定会踩 400。
  //   现在有了按模型收敛的能力，它们可以正常出现在列表里：选中后界面上"关闭"会变灰，
  //   后端也绝不会再发 disabled 过去。能选、且点了有用，比"看不见"好。
  'glm-5.3': { functions: true, ms: 2884, think: THINK.ALWAYS, efforts: ZHIPU_LEVELS, webSearch: true },
  // 2026-09-18 实测：flash 版是多模态（发图正常返回，带 vision 标识的消息被收下），
  // 但标准版 5.3 发图直接 1210「content.type 参数非法」—— 兄弟型号能力并不对称。
  'glm-5.3-flash': { functions: true, ms: 2900, think: THINK.ALWAYS, efforts: ZHIPU_LEVELS, webSearch: true, vision: true },
  'glm-ocr': { ms: 900, vision: true, think: THINK.NONE, efforts: [], webSearch: false, noChat: true },
  'glm-4.6v-flashx': { functions: true, ms: 500, vision: true, think: THINK.OFFABLE, efforts: ZHIPU_LEVELS, webSearch: false },
  'glm-4.5v': { functions: true, ms: 900, vision: true, think: THINK.OFFABLE, efforts: ZHIPU_LEVELS, webSearch: false },
};

/** 千问认的思考强度档。⚠️ 与另外两家都不同：**没有 high，最高档叫 xhigh**（官方文档口径） */
const QWEN_LEVELS = ['low', 'medium', 'xhigh'];

/**
 * 千问（阿里云「千问AI平台」＝ 原百炼 / DashScope）模型档案（2026-10-07 接入）。
 *
 * ⚠️⚠️ **这张表里没有一条是本项目实测的** —— 与上面智谱那张表**性质不同**，别混着读。
 *     智谱那 20 个模型有 `scripts/probe-models.mjs` 的原始读数（延迟 / 档位 / 工具）；
 *     千问这批是照**官方文档 + 兼容模式公开协议**写的，标注为「文档口径」。
 *     要把它变成实测，得先有一把能用的 Key（`.env` 里的 `DASHSCOPE_API_KEY`）
 *     再照着 probe 脚本跑一遍。谁跑了，请把这句注释改掉。
 *
 * 依据（三处互相印证）：
 *   · 平台兼容 OpenAI 协议，官方给的 `base_url` 是 dashscope.aliyuncs.com/compatible-mode/v1
 *   · 思考走请求体的 `enable_thinking` ＋ 顶层 `reasoning_effort`（取值 xhigh / medium / low）
 *
 * ⚠️⚠️ `functions` **一律标 false，但这不是"千问不支持工具调用"**（官方文档明确支持）。
 *     原因是本项目的一条硬纪律：**没实测过的能力位不许标 true** ——
 *     `check-wb` 有一条契约会拿"实测记录"逐卡比对，标了 true 却拿不出读数，
 *     当场报红（我第一次就是这么被拦下的）。这条纪律的取向是对的：
 *     标错的代价不对称 —— 判宽了，降级链上撞到不认 function schema 的型号会
 *     整条请求 400（用户看到"机器人突然不理我"）；判窄了只是少一个还在孵化中的能力。
 *
 *     **要打开它**（三步，缺一不可）：
 *       ① 把 `DASHSCOPE_API_KEY` 配好（真机 `.env`）；
 *       ② 照 `scripts/probe-functions.mjs` 跑一遍，把读数落到 `functions-probe-result.json`；
 *       ③ 再把这里对应的 `functions` 改成 true —— 那时契约才认。
 *     在那之前，千问这边**不携带任何 tools**（表里在列的 8 个型号也一样）。
 *
 * ⚠️ `webSearch` 一个都不给 true：那是**智谱内置**的 `{type:'web_search'}` 形状，
 *     别家服务端不认（发了会被 400 整条拒掉）。千问也有联网能力，但走的是它自己的
 *     接口形状 —— 那不是这个能力位能表达的东西。**这里给 true 等于埋雷**。
 *
 * ⚠️ `vision` 一个都不给 true：**不是**"千问不能看图"，而是"这张表里没有一个型号
 *     被验证过"（见上面那句注释：本表是文档口径）。给一个没验证的 `vision: true`，
 *     后果是群友发图时整条请求被服务端拒掉、机器人哑掉 —— 代价不对称，所以按保守取。
 *     要用识图，先实测一个 VL 型号再把 `vision: true` 加上来。
 *
 * `ms` / `pack` / `throttled` 一律不填 —— 那是智谱那套的字段（实测延迟 / 额度包 / 限流），
 * 千问这边没有对应读数。线路板的排序会因此把千问模型排在末尾（`ms ?? 9999`），
 * 这是**如实**的：我们确实不知道它们谁快。
 */
export const QWEN_MODEL_META = {
  // ── 官方文档点名的三个主力档 ──
  'qwen3.8-max': { functions: false, think: THINK.OFFABLE, efforts: QWEN_LEVELS, webSearch: false },
  'qwen3.7-plus': { functions: false, think: THINK.OFFABLE, efforts: QWEN_LEVELS, webSearch: false },
  'qwen3.7-flash': { functions: false, think: THINK.OFFABLE, efforts: QWEN_LEVELS, webSearch: false },
  // ── 平台在售的其余文本档（名字取自平台模型列表）──
  'qwen3.8-flash': { functions: false, think: THINK.OFFABLE, efforts: QWEN_LEVELS, webSearch: false },
  'qwen3.5-plus': { functions: false, think: THINK.OFFABLE, efforts: QWEN_LEVELS, webSearch: false },
  'qwen3-max': { functions: false, think: THINK.OFFABLE, efforts: QWEN_LEVELS, webSearch: false },
  'qwen-turbo': { functions: false, think: THINK.OFFABLE, efforts: QWEN_LEVELS, webSearch: false },
  'qwen-long': { functions: false, think: THINK.OFFABLE, efforts: QWEN_LEVELS, webSearch: false },
};

/** DeepSeek 现役模型：都没有联网内置工具，也都没有视觉模型 */
const DEEPSEEK_MODEL_META = {
  'deepseek-flash': { functions: true, think: THINK.OFFABLE, efforts: DEEPSEEK_LEVELS, webSearch: false, vision: false },
  'deepseek-v4-pro': { functions: true, think: THINK.OFFABLE, efforts: DEEPSEEK_LEVELS, webSearch: false, vision: false },
  // 官方已停用，会静默跳到 flash。留着是为了让历史配置不报错
  'deepseek-chat': { functions: true, think: THINK.OFFABLE, efforts: DEEPSEEK_LEVELS, webSearch: false, vision: false },
  'deepseek-reasoner': { functions: true, think: THINK.ALWAYS, efforts: [], webSearch: false, vision: false },
};

/**
 * 本机 mlx / QwenChat 通道上的模型。
 * 只有开/关，没有强度档；不认 web_search（会 400）；Qwen3.5-4B 不是视觉模型。
 * 目录名里带 VL 的才算多模态（如 Qwen3.5-VL-7B-MLX-4bit）。
 */
function localMetaOf(model) {
  const m = String(model || '');
  const isVL = /(^|[/\-_.])[Vv][Ll]([/\-_.\d]|$)/.test(m);
  return { think: THINK.OFFABLE, efforts: [], webSearch: false, vision: isVL };
}

/** 服务商 → 取该服务商下某个模型的档案 */
function metaOf(provider, model) {
  const m = String(model || '');
  if (provider === 'zhipu') return ZHIPU_MODEL_META[m] || null;
  if (provider === 'deepseek') return DEEPSEEK_MODEL_META[m] || null;
  if (provider === 'qwen') return QWEN_MODEL_META[m] || null;
  if (provider === 'local') return localMetaOf(m);
  return null;
}

/**
 * ⚠️ **全项目唯一的能力判定入口**。谁要知道"这个模型能不能做 X"，都走这里。
 *
 * @param {object} [declared] **用户声明**的能力（自定义大脑专用，见下）
 * @returns {{
 *   known: boolean,            档案里有没有这个模型（没有就是按保守默认值推的）
 *   think: string,             THINK 三态
 *   thinkModes: {auto:boolean, off:boolean, on:boolean},
 *   levels: string[],          可用的强度档（空 = 不分档，界面上那一排整行不显示）
 *   features: {webSearch:boolean, vision:boolean, stickers:boolean, functions:boolean},
 *   reasons: Object<string,string>  不可用的原因（给界面直接显示，中文）
 * }}
 *
 * ── `declared` 是给**自定义大脑**用的（2026-10-07）───────────────────────────
 * 内置四家的能力来自这张**能力表**（实测出来的）。而用户自己填的那个地址上的型号，
 * 我们从来没见过 —— `metaOf()` 恒为 null，于是 `vision` / `webSearch` 会一路保守成 false。
 * 那会把用户明确的声明**盖掉**（"我勾了能看图，为什么不给它发图"）。
 *
 * ⇒ 所以自定义大脑走 `declared`：用户勾了什么就是什么。三项各自对应一件我们真做得到的事：
 *     vision    → 发不发图片给它
 *     webSearch → 带不带 `{type:'web_search'}` 工具
 *     thinking  → 带不带思考参数
 *
 * ⚠️ 只有这三项能被声明。第四项 `functions` **不接受声明**，恒 false ——
 *    没有实测手段，而判宽了会让整条请求 400（与千问同一条纪律）。
 */
export function capabilitiesOf(provider, model, declared) {
  const meta = metaOf(provider, model);
  const known = !!meta;

  // 档案里没有的模型（服务商新上线的）：取**保守**默认值。
  // 宁可少给一个开关，也不能猜"它应该支持"——猜错的后果是每个请求被 400 整条拒掉，
  // 表现为"机器人突然不说话"，比少一个开关难查得多。
  // ⚠️ 这三个是 `let` 而不是 `const`：**自定义大脑的 `declared` 会覆盖它们**（见下方）。
  //    用 const 会在那一行直接抛 TypeError —— 而它只在用户选了自定义大脑时才走到，
  //    所以"内置四家全绿、一选自定义就崩"是这类写法最容易留下的形态。
  let think = meta?.think ?? (provider === 'local' ? THINK.OFFABLE : THINK.OFFABLE);
  // 档位默认值按服务商给：**各家认的强度域不同**（智谱没有 medium、千问没有 high），
  // 所以这里不是"一个全局默认"，而是"这家认哪几档"。判错的后果是 400 整条被拒。
  const levels = meta?.efforts
    ?? (provider === 'zhipu' ? ZHIPU_LEVELS
      : provider === 'deepseek' ? DEEPSEEK_LEVELS
        : provider === 'qwen' ? QWEN_LEVELS
          : []);
  let vision = meta?.vision === true;
  let webSearch = meta?.webSearch === true;
  // ⚠️ 保守默认 **false**，且「未能判定」一律按 false 记：
  //    这一位判错的代价不对称 —— 判宽了，降级链上撞到不认 function schema 的模型会
  //    整条请求 400（用户看到的是"机器人突然不理我"）；判窄了只是少一个还在孵化中的能力。
  // ⚠️ 且它**不接受用户声明**（理由见上面 JSDoc 里那段）—— 只允许在这一行改。
  const functions = meta?.functions === true;

  // ── 用户声明的能力（自定义大脑）──
  // ⚠️ 必须放在 `reasons` 之前：reasons 是照 `vision` / `webSearch` 算出来的文案，
  //    顺序反了就会先按"表里没有"写出理由，再被声明覆盖 —— 界面上会显示一句与事实相反的灰显原因。
  if (declared && typeof declared === 'object') {
    if (typeof declared.vision === 'boolean') vision = declared.vision;
    if (typeof declared.webSearch === 'boolean') webSearch = declared.webSearch;
    // 勾了"能思考" ⇒ 至少给"能开关"这一档（表里没有它，默认会落成 NONE）
    if (declared.thinking === true && think === THINK.NONE) think = THINK.OFFABLE;
    // 没勾 ⇒ 一律当作"不产生思考" —— 一个思考参数都不发。
    //   ⚠️ 这条尤其要紧：各家思考参数的写法**互不相同**（智谱 `thinking.type`、
    //      千问 `enable_thinking`），对一个没勾思考的自建网关乱发参数只会 400。
    if (declared.thinking === false) think = THINK.NONE;
  }

  const reasons = {};
  if (think === THINK.ALWAYS) {
    reasons.off = '这个模型始终思考，不支持关闭（实测强制关闭会直接返回 400）。强度可以调。';
  }
  if (think === THINK.NONE) {
    reasons.think = '这个模型不产生思考，开关和强度对它都没有影响 —— 实测它不会返回任何思考内容。';
  }
  if (!levels.length && think !== THINK.NONE) {
    reasons.levels = '这个模型只有开/关，没有强度档。';
  }
  if (!webSearch) {
    reasons.webSearch = provider === 'zhipu'
      ? '这个模型实测不认联网工具：参数会被收下、也不报错，但搜索结果不会进上下文（等于白开）。'
      : provider === 'deepseek'
        ? 'DeepSeek 的接口没有联网工具，开了会让每个请求被服务端 400 拒掉。'
        : provider === 'qwen'
          // ⚠️ 文案要与事实相符：千问**有**联网能力，只是它那套接口形状不是这个能力位
          //    能表达的东西（这个位只管智谱那个 `{type:'web_search'}`）。写成"千问不能联网"
          //    是错的，会让人去别处找开关。
          ? '这门开关走的是智谱那套内置搜索的形状，千问这边不认（开了会被服务端拒）。千问的联网能力不在这个开关里。'
          : '本机模型没有联网工具，开了会让请求直接报错。';
  }
  if (!vision) {
    reasons.vision = provider === 'zhipu'
      ? '这个模型不能看图（实测发图会返回 400「content.type 参数非法」）。'
      : provider === 'deepseek'
        ? 'DeepSeek 现役两款都是纯文本模型，看不了图。'
        : provider === 'qwen'
          // 与 webSearch 那条同一取向：说清楚是"我们没验证过"，不是"它做不到"。
          ? '千问的能力表里还没有登记过能看图的型号（接入时只登记了文本档），所以按保守取 false。要用识图得先实测一个 VL 型号。'
          : '本机这个规格不是视觉模型，看不了图。';
  }
  if (!functions) {
    // 这一条不在界面上（本批没有对应开关），但 `reasons` 是**排查用**的：
    // 「为什么它没调工具」的第一个怀疑对象就是这个模型的能力位。
    reasons.functions = provider === 'local'
      ? '本机这个规格实测不认 function 型 tools（会 400），所以不携带。'
      : provider === 'qwen'
        ? '千问这张表是文档口径（不是实测），没登记的型号一律按保守取 false 不携带 tools —— 在表里的那 8 个型号都给了 true。'
        : '这个模型没有通过 function calling 实测（或未能判定），按保守取 false 不携带 tools。';
  }
  reasons.stickers = '';

  return {
    known,
    think,
    thinkModes: {
      // 「自动」= 不干预，让服务端用自己的默认值。始终思考的模型没有"自动"的意义（它只能开）。
      // 本机也不摆「自动」：LM Studio 服务端默认就是不思考，自动 ≈ 关闭，
      // 摆两颗长得不一样的按钮只会让人猜区别 —— 只留开/关。
      auto: think === THINK.OFFABLE && provider !== 'local',
      off: think === THINK.OFFABLE,
      on: think !== THINK.NONE,
    },
    levels: think === THINK.NONE ? [] : [...levels],
    features: { webSearch, vision, stickers: true, functions },
    reasons,
  };
}

/**
 * 图片能力判定。保留这个函数名是因为 brain.js 一直在用它；
 * 实现改成走 capabilitiesOf —— 再也不要第二套名单。
 */
export function supportsVision(model, provider) {
  const p = provider || (String(model || '').includes('/') ? 'local' : 'zhipu');
  return capabilitiesOf(p, model).features.vision;
}

/** 把「内部档位」映射成某个服务商认的档位 */
function levelFor(provider, level, levels) {
  const allow = levels?.length ? levels : ZHIPU_LEVELS;
  if (allow.includes(level)) return level;
  // 智谱没有 medium → 落到 high；DeepSeek 没有 max → 落到 high。
  // 映射而不是丢弃：用户选了"最高"，至少要给它这一侧的最高档，不能悄悄变最低。
  return allow.includes('high') ? 'high' : allow[allow.length - 1];
}

/**
 * 把思考设置收敛成**这个模型真的能接受**的形态。
 *
 * 返回 {mode, level}，其中：
 *   mode = 'auto' | 'on' | 'off'   —— off 只在模型支持关闭时才可能出现
 *   level                        —— 已经映射到该模型认的档位
 *
 * 为什么必须有这一层：用户可能在 glm-5.3 上把思考设成"关闭"，之后切回
 * glm-4.5-air —— 配置里那个 off 是全局的，直接发出去对 5.3 就是 400。
 * 有了收敛，"什么配置"和"发什么参数"彻底解耦。
 */
export function resolveThinking(provider, model, thinking, declared) {
  // `declared` = 自定义大脑的用户声明。
  // ⚠️ **必须透传**给 `capabilitiesOf`：不传的话它按"能力表里没有这个型号"落成保守值
  //    （`think` 会是 OFFABLE），于是"用户没勾思考"被当成"能开能关" ——
  //    下游就会真的把思考参数发过去。而各家思考参数的写法互不相同，
  //    对一个没勾思考的自建网关乱发参数，后果就是一个 400 拒绝整条请求。
  const caps = capabilitiesOf(provider, model, declared);
  const want = thinking?.mode || 'auto';
  let mode = want;
  if (caps.think === THINK.NONE) mode = 'auto';        // 开关无意义，不干预
  else if (caps.think === THINK.ALWAYS) mode = 'on';   // 关不掉，一律按开
  else if (want === 'auto') mode = 'auto';
  return { mode, level: levelFor(provider, thinking?.level || 'medium', caps.levels) };
}

/**
 * 收敛能力开关：把该模型做不到的项一律置 false。
 * @returns {{features: object, dropped: string[]}} dropped 里是被关掉的项，用来提示用户
 */
export function resolveFeatures(provider, model, features, declared) {
  // 同 `resolveThinking`：`declared` 必须透传。不传的话，用户勾过的"能看图"会在这里
  // 被当成"这个型号没有视觉能力"而**关掉** —— 界面上刚勾的开关，保存后自己灭了。
  const caps = capabilitiesOf(provider, model, declared);
  const want = {
    webSearch: features?.webSearch === true,
    vision: features?.vision === true,
    stickers: features?.stickers === true,
  };
  const dropped = [];
  const out = { ...want };
  for (const k of ['webSearch', 'vision']) {
    if (want[k] && !caps.features[k]) {
      out[k] = false;
      dropped.push(k);
    }
  }
  return { features: out, dropped };
}

/** 给面板用的中文名（提示语里要能直接读） */
export const FEATURE_LABEL = { webSearch: '联网查询', vision: '识图', stickers: '发 QQ 表情' };
