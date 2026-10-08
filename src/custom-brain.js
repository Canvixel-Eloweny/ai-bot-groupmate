/**
 * 自定义大脑 —— 判据与归一化（2026-10-07 新增）
 * ══════════════════════════════════════════════════════════════════════════
 *  它解决的问题：内置那四套（本机 / DeepSeek / 智谱 / 千问）是**我们替用户挑好的**，
 *  而用户手里往往还有别的：公司网关、自建中转、另一台机器上的 LM Studio、
 *  或者干脆就是我们没接的某一家。这些必须能自己填，而且**能存好多套、能改名字、能删**。
 *
 *  ──────────────────────────────────────────────────────────────────────────
 *  ⚠️ **为什么它不进 `llm.presets`**（这是本模块存在的全部理由）
 *
 *  `llm.presets` 的形状是「服务商 → 一套设置」，`PRESET_KEYS` 是那张**固定名单**
 *  （`readPresets` 遍历它、`stashCurrentPreset` 按它决定要不要归档、
 *  `buildModelCaps` 按它下发能力表、`keySaved` 从它派生……一共十几处）。
 *  自定义大脑是**一对多**且**用户自己命名**的 —— 硬塞进那张表就要把名单改成动态的，
 *  上面十几处全得跟着动，其中任何一处漏改都会**静默失效**（本项目最贵的那类失败）。
 *
 *  ⇒ 所以自定义大脑单独住 `llm.customBrains{ <id>: … }`，用 `activeCustomId` 标记
 *    "当前用的是哪一套"。**两套结构互不干扰**：内置的断言一条都没被碰。
 *
 *  ──────────────────────────────────────────────────────────────────────────
 *  ⚠️ 本模块是**零依赖叶子**（连 `node:` 都不用）：它要被机器人进程、面板后端、
 *     前端状态下发、以及测试同时读，谁都不该被别人的依赖拖住。
 *     副作用（读环境变量解析 Key、落盘）**不在本模块** —— 那是 `config.js` 的事。
 */

/**
 * 用户可以在自定义大脑上声明的能力。
 *
 * ⚠️ 只有三项，且每一项都对应**我们真的做得到的一件事**（勾了没用的选项摆出来是骗人）：
 *   · `vision`    —— 勾了才会把群里的图片发给它（不勾就剥掉，只发「[图片]」）
 *   · `thinking`  —— 勾了才带思考参数。⚠️ 各家写法不同（智谱 `thinking.type`、
 *                    千问 `enable_thinking`），所以自定义这边只发**最通用**的
 *                    `reasoning_effort`；服务端不认时 `src/llm.js` 已有的
 *                    「点名 reasoning_effort 就去掉参数重发」会自动兜住 —— 不会静默失败。
 *   · `webSearch` —— 勾了才带 `{type:'web_search'}` 工具。
 *                    ⚠️ 这个形状是**智谱内置**的，别家基本不认（会 400）。
 *                    所以界面上要写明"只有支持这一套的服务商才认"，别让用户勾了以为是通用的。
 */
export const CUSTOM_FEATURE_KEYS = Object.freeze(['vision', 'thinking', 'webSearch']);

/** id 的前缀。带前缀是为了让"内置预设键"和"自定义大脑 id"在任何日志里都一眼分开。 */
const CUSTOM_ID_PREFIX = 'custom-';

/**
 * 造一个不与现有 id 冲突的 id。
 *
 * ⚠️ `seed` 是**入参而不是内部取 `Date.now()`**：纯函数不该偷偷读时钟，
 *    否则测试无法稳定复现（本项目对"可断言"的要求高于"写法省事"）。
 *    `seed` 缺省时由调用方给（面板那边给 `Date.now()`）。
 *
 * @param {object} existing 已有的大脑字典（`{id: brain}`）
 * @param {string} [seed]
 */
export function newBrainId(existing, seed = '') {
  const taken = new Set(Object.keys(existing || {}));
  const base = `${CUSTOM_ID_PREFIX}${String(seed || 'b').replace(/[^a-zA-Z0-9_-]/g, '') || 'b'}`;
  if (!taken.has(base)) return base;
  for (let i = 2; ; i += 1) {
    const id = `${base}-${i}`;
    if (!taken.has(id)) return id;
  }
}

/**
 * 归一化一份大脑配置。**总是返回一份完整可用的**，缺的补默认值，坏字段丢弃。
 *
 * @returns {object|null} null = 这份**根本没法用**（没地址 / 没模型名），调用方应跳过它
 */
export function normalizeCustomBrain(raw, { id = '', fallbackName = '自定义模型' } = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const baseUrl = String(raw.baseUrl ?? '').trim().replace(/\/+$/, '');
  const model = String(raw.model ?? '').trim();
  // ⚠️ 这两个是"没有就无法发起请求"的字段 —— 缺了必须**明确丢弃**，
  //    而不是留一个空地址在列表里（那样点下去会得到一个看不懂的 fetch 失败）。
  if (!baseUrl || !model) return null;

  const features = {};
  for (const k of CUSTOM_FEATURE_KEYS) features[k] = raw.features?.[k] === true;

  return {
    id: String(raw.id || id || '').trim(),
    name: String(raw.name ?? '').trim() || fallbackName,
    baseUrl,
    model,
    // ⚠️ `apiKey` 在这一层**只做搬运，不解析 `env:NAME`** —— 解析要读进程环境，
    //    那是 `src/config.js` 的 `resolveSecret()` 的职责（判据只有一份）。
    apiKey: String(raw.apiKey ?? ''),
    fallbackModels: Array.isArray(raw.fallbackModels)
      ? raw.fallbackModels.map((s) => String(s).trim()).filter(Boolean)
      : [],
    features,
    maxTokens: Number.isFinite(raw.maxTokens) && raw.maxTokens > 0 ? Math.round(raw.maxTokens) : 400,
    temperature: Number.isFinite(raw.temperature) ? raw.temperature : 1,
  };
}

/**
 * 读出全部自定义大脑（归一化 + 丢弃坏条目）。
 *
 * ⚠️ **坏条目被丢弃时要说出来**：静默丢掉会让用户以为"我明明保存了，刷新就没了"。
 *    所以返回 `dropped` 计数，由调用方写进日志 / 提示。
 *
 * @param {object} cfg 完整配置
 * @returns {{ brains: object, dropped: string[] }}
 */
export function customBrainsOf(cfg) {
  const rawMap = cfg?.llm?.customBrains;
  const brains = {};
  const dropped = [];
  if (!rawMap || typeof rawMap !== 'object' || Array.isArray(rawMap)) {
    return { brains, dropped };
  }
  for (const [id, raw] of Object.entries(rawMap)) {
    const one = normalizeCustomBrain(raw, { id });
    if (!one) { dropped.push(id); continue; }
    brains[id] = one;
  }
  // ⚠️ `activeCustomId` 指向的那套如果已经坏了（地址被清空），**必须一并清掉标记** ——
  //    否则机器人会拿着一个空地址去跑，而界面上还显示"正在用：某某模型"。
  const active = String(cfg?.llm?.activeCustomId ?? '').trim();
  if (active && !brains[active]) dropped.push(`activeCustomId=${active} 指向的已失效`);
  return { brains, dropped };
}

/** 给界面用的有序列表（按创建顺序 —— 字典序遍历会让新增的乱跳） */
export function brainListOf(cfg) {
  const { brains } = customBrainsOf(cfg);
  return Object.values(brains).map((b, i) => ({ ...b, order: i }));
}

/** 当前正在用的那套自定义大脑（没有就 null —— 说明当前是内置的某一套） */
export function activeBrainOf(cfg) {
  const { brains } = customBrainsOf(cfg);
  const id = String(cfg?.llm?.activeCustomId ?? '').trim();
  return (id && brains[id]) || null;
}

/**
 * 这套大脑**声明**的能力，转成 `src/model-caps.js` 认的形状。
 *
 * ⚠️ 为什么要这一层：内置四家的能力来自**能力表**（实测出来的），
 *    自定义这边没有表 —— 它的能力**就只是用户自己勾的那几项**。
 *    所以这里把"勾了什么"翻成同一套 `{features}` 结构，让下游（`llm.js` /
 *    `resolveFeatures` / 面板）**只认一种形状**，不必分叉。
 *
 * ⚠️ `functions`（工具调用）**不在可勾选项里**：它是个能力位而非用户偏好，
 *    且我们自己没有实测手段 ⇒ 一律 false（与千问同一条纪律：没实测就不给）。
 */
function declaredFeaturesOf(brain) {
  const f = brain?.features || {};
  return {
    vision: f.vision === true,
    webSearch: f.webSearch === true,
    thinking: f.thinking === true,
    // 这一位不在用户的勾选项里，恒 false —— 理由见上面那条注释
    functions: false,
    stickers: true,
  };
}

/**
 * 把一套大脑**物化**到扁平字段（`cfg.llm.baseUrl` / `.model` / `.apiKey` …）。
 *
 * ⚠️ 这个函数存在的唯一理由是**消掉一份重复**：
 *    `src/config.js`（机器人启动时）与 `panel/server.js`（切换 / 保存时）都要做这件事。
 *    两处各写一遍的后果是它们迟早漂移 —— 表现是"界面上切换成功了，机器人那边还是旧的"，
 *    而两边看起来都完全正常。
 *
 * ⚠️ **不设** `isLocal` / `provider` —— 那两个是**由地址推导**出来的派生值，
 *    各自在算完 baseUrl 之后重算（`config.js` 里就是这么做的）。在这里写死就会
 *    出现"自定义大脑明明是云端，却被算成本机免费"那类错账。
 *
 * @param {object} cfg 会被**就地修改**
 * @param {object} brain `normalizeCustomBrain()` 的产物
 * @returns {boolean} 是否真的物化了（false = 这套没法用）
 */
export function materializeBrain(cfg, brain) {
  if (!cfg?.llm || !brain?.baseUrl || !brain?.model) return false;
  cfg.llm.baseUrl = brain.baseUrl;
  cfg.llm.model = brain.model;
  // ⚠️ Key 为空时**保留原来那把**（不是清空）：用户编辑时不动 Key 是很常见的操作，
  //    清掉会让"改个模型名导致 Key 没了"。
  cfg.llm.apiKey = brain.apiKey || cfg.llm.apiKey;
  cfg.llm.fallbackModels = [...(brain.fallbackModels || [])];
  cfg.llm.fallbackModel = '';
  cfg.llm.maxTokens = brain.maxTokens;
  cfg.llm.temperature = brain.temperature;
  cfg.llm.activeCustomId = brain.id;
  // 能力按**用户勾的那几项**，没勾的一律关
  cfg.llm.features = {
    webSearch: brain.features?.webSearch === true,
    vision: brain.features?.vision === true,
    stickers: cfg.llm.features?.stickers === true,
  };
  if (!brain.features?.thinking) cfg.llm.thinking = { mode: 'off', level: 'medium' };
  // 给下游（llm.js）把"用户声明"带进能力判定用 —— 见 model-caps 的 `declared` 参数。
  // ⚠️ 走 `declaredFeaturesOf()` 而不是在这里再写一遍对象字面量：
  //    "哪些能力算被声明了"这件事只有一处答案，写两份就是两份会漂的语义。
  cfg.llm.declaredFeatures = declaredFeaturesOf(brain);
  return true;
}

/**
 * 界面上该显示哪些能力开关 —— **只显示用户勾过的**。
 *
 * 这是用户明确要的行为："勾选并保存后，只显示用户勾选的内容" ⇒ **没勾过的根本不出现**，
 * 界面上不会摆一排灰掉的开关（摆出来又关不掉，正是本项目最忌讳的"点了没用"）。
 *
 * ⚠️ 由此产生的一个边界，**必须写清**：既然没勾的不显示，那么"把某个已勾的能力关掉"
 *    只能回到**编辑大脑**那里取消勾选 —— 界面上那个开关在关掉后会消失。
 *    这是有意的取舍（换取界面干净），代价是少了一条"随手关"的路径。
 *    ⇒ 界面上要给一个明确的入口回到编辑表单，否则用户会以为"开关消失了 = 功能坏了"。
 *
 * @returns {string[]} 要显示的键
 */
export function visibleFeatureKeysOf(brain) {
  const f = brain?.features || {};
  return CUSTOM_FEATURE_KEYS.filter((k) => f[k] === true);
}
