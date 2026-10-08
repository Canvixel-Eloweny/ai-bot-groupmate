/**
 * 模型元数据与判定（第 38 轮 B11b-2 · AR-SERVERSPLIT · 依赖图 L2）
 * ══════════════════════════════════════════════════════════════════════════
 *  这个模块装的是"**关于模型的事实与判定**"，一句话概括：
 *
 *      模型叫什么、能不能当聊天模型用、属于哪一家、本机还是云端、
 *      每套大脑各自该用什么默认值、智谱还剩多少赠送额度。
 *
 *  ⚠️ 措辞刻意是"每套"而不是"三套/四套"：**这个数字会随加家变**，
 *     写死之后每接一家都要回来改注释（而注释不准没人会发现）。
 *     要判"现在有哪几家"，看 `PRESET_KEYS` —— 那是唯一名单。
 *
 *  为什么它必须独立成一层 —— 这三件事以前分散在主文件里，而它们**被上下两头同时用**：
 *
 *      · 上：主文件的"用量与花费"段要用"本机还是云端"判钱（判据来自 `src/net-rules.js`）；
 *      · 下：`LOCAL_MODELS` / `LOCAL_CHANNELS` 要用 `paths.js` 的端口常量。
 *
 *  于是"路径常量 → 模型元数据 → 计费判定"被压在同一层里，成了双向依赖。
 *  把它抽出来之后，依赖图变成一条直线的四层：
 *
 *      paths / runtime-state / http-io（L0）
 *          → config-io（L1）→ models（L2）→ 主文件（L3）
 *
 *  ⚠️ 本模块**只许 import `./paths.js` / `./config-io.js` 与 src/ 下的纯函数**。
 *     **绝不许 import 主文件**，也不许 import `./proc.js` —— 那两条都会把循环种回来。
 *     依赖矩阵（本轮实测）确认：本模块的跨模块出边**只有** `→ config-io`（读配置取 Key）。
 *     ⚠️ `src/` 这一侧也不是随便引 —— `check-wb` 第 7⑥ 段有一张
 *        **lib → src 白名单**，加新的 src 依赖必须先去那里登记，否则当场报红。
 *
 *  ⚠️ 这里有一条**与 src/config.js 重复的实现**：`normalizeThinking()`。
 *     机器人进程与面板各要一份，靠 `check-wb` 契约 2j 钉住"两份逐字一致"。
 *     本模块搬窝后，那条契约的扫描目标已同步改到这里（扫旧文件会变成永远的摆设）。
 *
 *  ⚠️ `isLocalBase()` / `providerOf()` **不在这里定义**（B11c · AR-DATADRIVEN）：
 *     它们搬去了 `src/net-rules.js`，本模块与机器人进程 import 同一份。
 *     ⚠️ 也**不做 re-export** —— 谁实现谁导出，中间多一层转发只会让
 *        "这个符号到底归谁管"变得没人答得上来。
 */

import fs from 'node:fs';
import path from 'node:path';
import { HOME, LOCAL_MODEL_PORT, QWENCHAT_PORT } from './paths.js';
import { readConfig } from './config-io.js';
import { ZHIPU_MODEL_META, QWEN_MODEL_META, capabilitiesOf } from '../../src/model-caps.js';
// ⚠️ 「这笔花不花钱」的判据（`FREE_CLOUD_MODELS` / `CREDIT_CLOUD_MODELS` / `isZhipuModel`）
//    已于 2026-10-07 搬去 `src/free-quota.js` —— 本文件**不再 import 它**，
//    因为搬完这里一个都用不到了（消费者的口径也换了：见 usage-report 的 deps）。
//    谁需要那三个名字，去问 free-quota；**别在这里补一个 import 只为凑数**。
// 本机 / 局域网判定与服务商判定（B11c · AR-DATADRIVEN）。
// 以前这里各有一份拷贝，与 `src/config.js`、页面三方手工同步 ——
// 而"手工同步"已经真的漂过一次（少写 172.16–31 → 本机被算成云端计费）。
// 现在只有一份实现，详情看 `src/net-rules.js` 的模块头。
import { isLocalBase, providerOf } from '../../src/net-rules.js';

/**
 * 本机可用的模型规格。
 *
 * 现在只有 4B 一个 —— 9B（5.6G）已按用户要求从这台机器上移除（实测 4B 输出正常，
 * 而 16GB 的机器同时跑 9B + Docker 会互相挤，历史上出过「容器凭空消失」）。
 * 以后要加回来，只在这个表里加一项即可，前端下拉是从这里读的（不是写死的）。
 */
export const LOCAL_MODELS = {
  '4b': { path: path.join(HOME, 'models', 'Qwen3.5-4B-MLX-4bit'), label: 'Qwen3.5-4B（2.9G，回复快）' },
};

/** 第一个可用的规格名，用于「配置里指的模型没了」时兜底 */
function firstLocalKey() {
  return Object.keys(LOCAL_MODELS)[0] || '4b';
}

/** 规格对应的目录是否真的在磁盘上（可能被用户删了 / 换了目录） */
export function localModelExists(key) {
  const m = LOCAL_MODELS[key];
  return !!(m && fs.existsSync(m.path));
}

/**
 * 把任意来源的规格名解析成一个「磁盘上真的存在」的规格。
 *
 * 为什么需要它：配置里可能留着已经被删掉的规格名（比如用户把 9B 删了，
 * 而 config.json 里还写着 9b）。直接拿去启动会得到一个指向不存在目录的路径，
 * 然后报一个很难懂的模型加载错误。这里统一回落到第一个可用规格。
 */
export function resolveLocalKey(key) {
  return LOCAL_MODELS[key] && localModelExists(key) ? key : firstLocalKey();
}

/**
 * 本机模型的两条推理通道。同一个模型文件，两套服务：
 *
 *   mlx   → ~/models/bin/qwen-server（mlx_lm.server，:8080，OpenAI 兼容）
 *           给机器人用的默认通道，稳定、简单。
 *   qwenchat → ~/models/app/server.py（QwenChat 界面自带的 HTTP 服务，:8765）
 *           多了两样机器人那边没有的东西：**前缀 KV 缓存**（长对话不用重算整段历史，
 *           第一条明显更快）和**流式思考支持**。现在它也提供 OpenAI 兼容接口
 *           （/v1/chat/completions），所以机器人可以直接调它。
 *
 * ⚠️ 两条通道各自会把模型加载进内存，**绝不允许同时开**：
 *    4B 一份 2.9GB，两份就是 5.8GB —— 16GB 的机器扛不住。
 *    startLocalModel / switchBrain 里做了互斥。
 */
export const LOCAL_CHANNELS = {
  // label 要短：它会出现在日志和面板步骤里，常常后面还要跟「（:8765）」这类补充，
  // 写太长会变成「QwenChat（带前缀缓存）（:8765）」这种叠括号。详细说明放在前端。
  mlx: { port: LOCAL_MODEL_PORT, label: 'MLX 服务' },
  qwenchat: { port: QWENCHAT_PORT, label: 'QwenChat' },
};

/** 通道名 → 接口地址；非法值一律回落到默认通道 */
export function localChannelOf(v) {
  return LOCAL_CHANNELS[v] ? v : 'mlx';
}
export function localChannelUrl(v) {
  return `http://127.0.0.1:${LOCAL_CHANNELS[localChannelOf(v)].port}/v1`;
}

// ═══════════════════════════════════════════════════════════════════════
//  模型能力档案
// ═══════════════════════════════════════════════════════════════════════
//  ⚠️ 表本身**不在这里**：它搬到了 src/model-caps.js，因为机器人进程（src/llm.js）
//     也必须读同一张表 —— 它在发请求前要把模型不认的参数摘掉。
//     以前这里一份、src/llm.js 里的 VISION_MODELS 一份，报告里反复记着"两份名单
//     必然漂移"。现在只有一个 import。
//
//  这里直接 re-export 名字 ZHIPU_MODEL_META 是因为面板/测试都在用它
//  （下发给前端渲染线路板）。字段含义见 src/model-caps.js 的注释。
//  面板额外关心的：ms / pack / free / throttled —— 实测延迟、走哪个额度包、
//  官方免费、会不会被限流；think —— 'offable' | 'always' | 'none'。

/**
 * 智谱**可以当聊天模型用**的清单（按实测延迟排序）。
 *
 * 这里**不再排除** glm-5.3 / glm-5.3-flash 了。以前排除它们只是权宜：
 * 整页只有一个全局思考开关，而这两个关不掉思考，留在名单里必然踩 400。
 * 现在能力按模型收敛（选中后界面上"关闭"会变灰、后端也绝不发 disabled），
 * 它们可以正常被选中 —— 能选且点了有用，好过"看不见所以以为不存在"。
 */
const ZHIPU_SELECTABLE = Object.keys(ZHIPU_MODEL_META)
  .filter((m) => ZHIPU_MODEL_META[m].noChat !== true)
  .sort((a, b) => (ZHIPU_MODEL_META[a].ms ?? 9999) - (ZHIPU_MODEL_META[b].ms ?? 9999));

/**
 * 千问**可以当聊天模型用**的清单（2026-10-07）。
 *
 * ⚠️ 与上面那份的排法**刻意不同**：智谱那张表有实测 `ms`，所以按延迟排；
 *    千问**一个读数都没有**（见 `src/model-caps.js` 里那段说明），所以
 *    **保持能力表里的声明顺序**，不排。两个理由：
 *      ① 按 `(ms ?? 9999)` 排会让 8 个模型全部并列，等于没排 —— 但读代码的人
 *         会以为"排过了"，那是一种假象；
 *      ② 按字母排会把 `qwen-long` 排到 `qwen3.7-flash` 前面（`l` < `3` 不成立，
 *         实际字母序里 `qwen-` 与 `qwen3` 的分界取决于下一字符）—— 无论哪种，
 *         第一眼看到的都不是我们想推荐的那个。**声明顺序即推荐顺序**。
 */
const QWEN_SELECTABLE = Object.keys(QWEN_MODEL_META).filter((m) => QWEN_MODEL_META[m].noChat !== true);

/**
 * 智谱降级链的**默认顺序**（第一项即主模型，其余依次降级）。
 *
 * 排法依据本轮实测：先放"又快、又走赠送额度"的主力，再放高阶，
 * **最后**才轮到官方免费档 —— 顺序正好和旧版相反。
 * 旧版把限流的免费档放在链首，于是每轮请求都先撞一次 429/超时才降级，
 * 表现出来就是"机器人半天不回话"。
 */
export const ZHIPU_DEFAULT_CHAIN = [
  'glm-4.5-air',    // 0.41s · 1200 万额度
  'glm-4.6v',       // 0.42s · 600 万额度 · 还能看图
  'glm-4.7',        // 2.9s  · 500 万额度 · 旗舰
  'glm-5.2',        // 0.86s · 高阶
  'glm-5',          // 0.85s · 高阶
  'glm-4-flash',    // 0.45s · 纯兜底
  'glm-4.7-flash',  // 官方永久免费，晚高峰限流 → 垫底
  'glm-4.6v-flash', // 官方永久免费，晚高峰限流 → 垫底
];

/**
 * 千问降级链的**默认顺序**（2026-10-07 接入时定）。
 *
 * ⚠️ 与智谱那条**性质不同，别照抄排法**：智谱那条是**实测延迟**排出来的
 *    （`glm-4.5-air` 0.41s 是测出来的）；千问这边**一条实测读数都没有**
 *    （见 `src/model-caps.js` 里 QWEN_MODEL_META 的说明），所以这条是按**官方定位**排的：
 *    官方文档把 `qwen3.7-flash` 写成"快速且高性价比"、`qwen3.7-plus` 写成
 *    "质量、速度与成本均衡"、`qwen3.8-max` 写成"最复杂推理"。群聊要的是**快**
 *    （回得越慢越像机器人），所以 flash 放链首。
 *
 * ⚠️ 这条链**刻意排得长**，原因是千问独有的一个性质：
 *    **赠送额度是按模型发的**（图片里那 484 个模型，每个各 100 万 token）。
 *    ⇒ 换一个模型等于**换一份额度**，一条长链等于把 8 份额度串起来用。
 *    智谱那边不是这样（它的额度按"包"发，一个包覆盖一批模型），所以智谱的链短得多。
 *    这条差异是**平台规则**决定的，不是排法偏好。
 */
export const QWEN_DEFAULT_CHAIN = [
  'qwen3.7-flash',   // 官方定位"快速且高性价比" → 群聊主力
  'qwen3.8-flash',
  'qwen3.7-plus',    // "质量、速度与成本均衡"
  'qwen3.5-plus',
  'qwen3-max',
  'qwen3.8-max',     // 旗舰，最慢 → 垫底
  'qwen-turbo',
  'qwen-long',
];

/** 降级链最长多少项（含主模型）。
 *  上限只是防"病态长链"：全被限流时机器人会挨个撞墙，用户要等很久才看到失败。
 *  16 足够放下现网全部可调用模型（15 个）+ 1。前端 ROUTE_MAX 要跟着改。 */
export const MAX_CHAIN_LEN = 16;

// 云端预设。地址与默认模型：智谱那套的链见上方 ZHIPU_DEFAULT_CHAIN。
export const CLOUD_PRESETS = {
  deepseek: {
    label: 'DeepSeek 云端',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-flash',
    provider: 'deepseek',
  },
  zhipu: {
    label: '智谱免费云端',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4/',
    model: ZHIPU_DEFAULT_CHAIN[0],
    fallbackModels: ZHIPU_DEFAULT_CHAIN.slice(1),
    provider: 'zhipu',
  },
  // 千问（阿里云「千问AI平台」＝ 原百炼 / DashScope · 2026-10-07）。
  // ⚠️ 地址是**API 域名**，不是控制台域名（`platform.qianwenai.com`）——
  //    后者会被 `baseUrlReject()` 里的 `consoleHostReject()` 当场拒掉，这是有意的。
  // ⚠️ 这里**只能填这一个**（北京地域）。新加坡 / 美国是另外两个域名，
  //    且**密钥不通用** —— 填错会得到一个看不懂的 401。
  qwen: {
    label: '千问免费云端',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: QWEN_DEFAULT_CHAIN[0],
    fallbackModels: QWEN_DEFAULT_CHAIN.slice(1),
    provider: 'qwen',
  },
};

// `FREE_CLOUD_MODELS`（智谱官方白纸黑字永久免费的那批：GLM-4.7-Flash 与 GLM-4.6V-Flash）
// 已搬去 `src/free-quota.js`（2026-10-07 · 接千问时收敛判据）。
// 它仍然**派生**自 `ZHIPU_MODEL_META` 的 `free` 标记 —— 别在这里再手写一份，就为了少一行 import。

// ═══════════════════════════════════════════════════════════════════════
//  三套「大脑预设」
//
//  为什么要有这个东西：以前三种大脑共用同一份扁平配置（llm.baseUrl / llm.model /
//  llm.features …），切来切去就会互相污染 —— 最典型的是模型下拉框里留着上一家的
//  候选，在 DeepSeek 页面点一下就写进 glm-4.6v-flash，请求必然报错。
//
//  现在每个大脑各存一套自己的设置（presets.<名字>），切换时只做「物化」：
//  把选中的那套摊平成机器人真正读的那几个扁平字段。
//  ⚠️ 扁平字段的语义完全没有变，bridge 侧一行都不用改。
//  ⚠️ presets 全部字段可选，缺失就回落到下面的默认值 —— 老的 config.json
//     不做任何迁移也能正常跑，第一次切换时自动补齐。
// ═══════════════════════════════════════════════════════════════════════
const LOCAL_CONTEXT = { recentTurns: 8, ambientMessages: 8 };
const CLOUD_CONTEXT = { recentTurns: 12, ambientMessages: 20 };

const PROVIDER_DEFAULTS = {
  // 本机：免费但慢，所以上下文砍半、单条上限压低（当年实测 400 token 的回复要二十多秒）
  local: {
    size: '4b',
    channel: 'mlx', // 走哪条推理通道（mlx / qwenchat）
    maxTokens: 160,
    // 小模型的采样温度要低一点才稳。0.7 是 Qwen 官方推荐档，也是 QwenChat 界面在用的值
    // ——用户反馈「在 QwenChat 里聊得很好」，很大一部分就是这个差别（云端默认 1.0 太飘）。
    temperature: 0.7,
    context: { ...LOCAL_CONTEXT },
    // 本机只有开/关，没有档位
    thinking: { mode: 'off', level: 'low' },
    // 本机不认 web_search（会 400），也不是 VL 模型，两个开关都关掉
    features: { webSearch: false, vision: false, stickers: false },
  },
  // DeepSeek：便宜、快，但**没有**联网工具、也没有视觉模型
  deepseek: {
    baseUrl: CLOUD_PRESETS.deepseek.baseUrl,
    model: 'deepseek-flash',
    fallbackModels: [],
    maxTokens: 400,
    temperature: 1,
    context: { ...CLOUD_CONTEXT },
    // DeepSeek 默认就在思考，且思考 token 按输出价计费 → 群聊默认关掉
    thinking: { mode: 'off', level: 'medium' },
    features: { webSearch: false, vision: false, stickers: false },
  },
  // 智谱：有官方免费档 + 内置联网 + 唯一的多模态档，能力最全
  zhipu: {
    baseUrl: CLOUD_PRESETS.zhipu.baseUrl,
    model: CLOUD_PRESETS.zhipu.model,
    fallbackModels: [...CLOUD_PRESETS.zhipu.fallbackModels],
    maxTokens: 400,
    temperature: 1,
    context: { ...CLOUD_CONTEXT },
    // 智谱默认思考且思考会吃光 max_tokens（正文变空），群聊必须关
    thinking: { mode: 'off', level: 'high' },
    features: { webSearch: false, vision: false, stickers: false },
  },
  // 千问：额度**按模型发**（每模型 100 万 token）⇒ 链排得长，详见 QWEN_DEFAULT_CHAIN。
  // 能力开关两个都关：webSearch 那个形状千问不认（会被 400）；vision 表里还没实测过能看图的型号。
  // 思考默认**关**：思考 token 也吃额度，而额度是有限的 —— 与智谱"思考会吃光 max_tokens"
  // 是两回事，这里的理由是"省额度"。
  qwen: {
    baseUrl: CLOUD_PRESETS.qwen.baseUrl,
    model: CLOUD_PRESETS.qwen.model,
    fallbackModels: [...CLOUD_PRESETS.qwen.fallbackModels],
    maxTokens: 400,
    temperature: 1,
    context: { ...CLOUD_CONTEXT },
    thinking: { mode: 'off', level: 'medium' },
    features: { webSearch: false, vision: false, stickers: false },
  },
};

export const PRESET_KEYS = ['local', 'deepseek', 'zhipu', 'qwen'];

/**
 * 内置模型名单。
 *
 * 为什么要内置而不是全靠 /models 接口：智谱的 /models **不返回免费档**
 * （glm-4-flash / glm-4.7-flash / glm-4.6v-flash 都不在返回列表里，但直接调用是认的），
 * 只信接口的话用户就永远选不到那两个官方免费的模型。
 * DeepSeek 的两款也内置一份，接口读不到时至少不至于让下拉框是空的。
 * 智谱那份由 ZHIPU_MODEL_META 派生（顺序 = 实测延迟），不要再手抄一遍。
 */
export const BUILTIN_MODELS = {
  zhipu: ZHIPU_SELECTABLE,
  deepseek: ['deepseek-flash', 'deepseek-v4-pro', 'deepseek-chat', 'deepseek-reasoner'],
  qwen: QWEN_SELECTABLE,
  local: [],
  other: [],
};

/**
 * 把某家的候选模型和接口真实返回的列表合并（内置在前，接口独有的补在后）。
 *
 * ⚠️ 智谱这边仍然要过滤，但**判据变了**：以前拦的是"关思考就 400"的模型
 * （所以 glm-5.3 被整个挡在名单外）；现在能力按模型收敛，选到它也不会再发
 * disabled，所以那个理由不成立了。真正该挡在聊天下拉之外的是**不是聊天模型**的
 * 那类（如 glm-ocr 是专用 OCR 模型、glm-embedding 是向量模型）——
 * 露在下拉里等于给用户埋雷：选中之后每条消息都得不到像样的回复。
 */
export function mergeModelList(provider, remote) {
  const out = [...(BUILTIN_MODELS[provider] || [])];
  // 千问也要挡一道 `isNonChatName`：它那个平台把**全平台 484 个模型**都列出来
  // （截图里就是"共 484 条"），其中量不少是向量 / 语音 / 图像生成的。
  // 不挡的话，那个下拉框会长到没法用，而且选中任何一个都得不到像样的回复。
  // ⚠️ 千问**不用** `noChat` 那半条：`QWEN_MODEL_META` 里根本没有这个字段
  //    （它是为智谱的 `glm-ocr` 那种"在表里但不是聊天模型"准备的），
  //    写上去恒为 `undefined !== true` ⇒ 恒真，等于没判。
  const acceptable = provider === 'zhipu'
    ? (m) => ZHIPU_MODEL_META[m]?.noChat !== true && !isNonChatName(m)
    : provider === 'qwen'
      ? (m) => !isNonChatName(m)
      : () => true;
  for (const m of remote || []) if (m && !out.includes(m) && acceptable(m)) out.push(m);
  return out;
}

/**
 * 名字一眼就能看出不是聊天模型的那些（向量 / 重排 / 图像生成 / 语音）。
 * 放在这里的原因：智谱的 /models 会把它们一起报回来，而我们的候选名单是
 * 「内置 + 接口返回」合并出来的 —— 不挡一道，下拉里会混进一堆选了没用的模型。
 *
 * ⚠️ 2026-10-07 起它有了**第二个消费者**（千问），而且那边更严重：
 *    千问平台的模型列表是**全平台 484 条**（截图里那个数字），量级完全不是智谱能比的。
 */
function isNonChatName(m) {
  return /(embedding|rerank|image|cogview|video|cogvideo|tts|asr|voice|realtime|ocr|search-(pro|std))/i.test(String(m));
}

// ═══════════════════════════════════════════════════════════════════════
//  智谱赠送资源包的余额
// ═══════════════════════════════════════════════════════════════════════
/**
 * 资源包查询端点。**这是私有接口**，不在智谱公开文档里 ——
 * 是从官网「财务 → 资源包管理」页面的前端 bundle 里找出来的
 * （同目录下 `/api/biz/account/query-customer-account-report` 是公开的账户余额，
 * 但那个只给现金余额 0，赠送包一个都看不到，所以必须用这个）。
 *
 * 好消息：实测**用同一个 API Key 放在 Authorization 里就能查**，不需要网页登录态。
 * 坏消息：私有接口，智谱改版就会失效 → 调用方必须能优雅降级，绝不能把面板拖垮。
 */
const ZHIPU_PACKAGE_API = 'https://open.bigmodel.cn/api/biz/tokenAccounts/list/my';

/** 余额缓存时长。额度是"用一次少一点"，60 秒足够新鲜，也免得反复点刷新把接口打爆 */
const PACKAGE_CACHE_MS = 60 * 1000;
let packageCache = { at: 0, data: null };

/**
 * 读智谱的赠送资源包余额。
 *
 * 只保留 **按 token 计费** 且 **生效中** 的包：搜索次数包、图片/视频生成次数包
 * 对 QQ 机器人没有任何意义，摆出来只会占地方（用户明确说过"联网和视频生成不要"）。
 *
 * @param {boolean} force 跳过缓存强制刷新（用户点「刷新」时）
 * @returns {Promise<{ok:boolean, rows:Array, error?:string, cached?:boolean}>}
 *          任何失败都返回 ok:false + 中文原因，**不抛异常** —— 一个查余额的失败
 *          不该让整个面板报错。
 */
/**
 * 取智谱资源包接口的**原始响应体**。
 *
 * 有夹具就用夹具，没有才真的发请求 —— 夹具开关叫 `QQBOT_ZHIPU_PACKAGES_FIXTURE`
 * （B9 · K-SANDBOX），与 `QQBOT_CONFIG` / `QQBOT_TRACE_FILE` / `QQBOT_USAGE_FILE` /
 * `QQBOT_AUTO_MEMORY_FILE` 同款。
 *
 * 为什么必须有这个开关（实测出来的，不是想出来的）：
 *   这条路径会**真的去调智谱的余额接口**。沙箱以前用的是「整份复制的真实配置」，
 *   所以每次沙箱回归都会拿**用户的真 Key** 打一次真实网络；
 *   按 K-SANDBOX 把凭据脱敏之后，它又变成 401 —— 于是「4 条资源包进度条」
 *   那条断言只能靠"真实凭据 + 真实网络"才通过。
 *   也就是说：它从来不是一条可离线复现的断言，而沙箱本就不该有出站流量。
 *   给个夹具之后，沙箱离线、成功路径照样测得到。
 */
async function zhipuPackagesPayload(key) {
  const fixture = process.env.QQBOT_ZHIPU_PACKAGES_FIXTURE;
  if (fixture) return { ok: true, json: JSON.parse(fs.readFileSync(fixture, 'utf8')) };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 10000);
  const r = await fetch(ZHIPU_PACKAGE_API, {
    headers: { Authorization: key, 'Content-Type': 'application/json' },
    signal: ac.signal,
  });
  clearTimeout(timer);
  if (!r.ok) return { ok: false, status: r.status };
  return { ok: true, json: await r.json() };
}

export async function readZhipuPackages(force = false) {
  if (!force && packageCache.data && Date.now() - packageCache.at < PACKAGE_CACHE_MS) {
    return { ...packageCache.data, cached: true };
  }
  const cfg = readConfig() || {};
  // Key 取法和 /api/models 一致：当前就停在智谱就用现用的，否则用归档里那一份
  const isZhipuNow = providerOf(cfg?.llm?.baseUrl) === 'zhipu';
  const key = (isZhipuNow ? cfg?.llm?.apiKey : '') || cfg?.llm?.keys?.zhipu || '';
  if (!key) return { ok: false, rows: [], error: '还没填智谱的 API Key，填好并保存后再看余额' };

  try {
    const got = await zhipuPackagesPayload(key);
    if (!got.ok) return { ok: false, rows: [], error: `智谱接口返回 HTTP ${got.status}` };

    const j = got.json;
    // ⚠️ 这个接口**没有 success 字段** —— 别照抄同目录 query-customer-account-report
    //    的判法（那个有）。它只有 code / msg / total / rows，成功时 code=200、msg="查询成功"。
    //    按 success 判会永远失败，而且错误文案会荒唐地显示成「查询成功」。
    if (j?.code !== 200 || !Array.isArray(j.rows)) {
      return {
        ok: false,
        rows: [],
        error: `智谱返回了看不懂的数据（code=${j?.code} msg=${j?.msg || '无'}），接口可能已改版`,
      };
    }

    const rows = j.rows
      .filter((x) => x.consumeType === 'TOKENS' && x.status === 'EFFECTIVE')
      .map((x) => ({
        // 去掉「【新用户专享】」这类前缀：这里每个包都带，纯占地方
        name: String(x.resourcePackageName || '未命名资源包').replace(/^【[^】]*】/, ''),
        model: String(x.suitableModel || ''),
        available: Number(x.availableBalance) || 0,
        total: Number(x.tokensMagnitude) || 0,
        expireAt: String(x.expirationTime || ''),
      }))
      .sort((a, b) => b.total - a.total); // 额度大的在前，顺序稳定不跳

    packageCache = { at: Date.now(), data: { ok: true, rows } };
    return packageCache.data;
  } catch (e) {
    return {
      ok: false,
      rows: [],
      error: e.name === 'AbortError' ? '查余额超时了（10 秒没回应）' : `查不到余额：${e.message}`,
    };
  }
}

/** 只做已知键的深合并，避免把预设里的嵌套对象整个覆盖掉 */
function mergeDeep(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over || {})) {
    if (v === undefined || v === null) continue;
    const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);
    out[k] = isObj(v) && isObj(base[k]) ? { ...base[k], ...v } : v;
  }
  return out;
}

/** 读出全部预设（`PRESET_KEYS` 里每套都给出完整、可直接用的那份，缺的部分用默认值补齐） */
export function readPresets(cfg) {
  const saved = cfg?.llm?.presets || {};
  const out = {};
  for (const k of PRESET_KEYS) out[k] = mergeDeep(PROVIDER_DEFAULTS[k], saved[k]);
  return out;
}

/**
 * 从当前扁平配置里抽出「属于这个大脑」的字段，回写进它的预设。
 * 这样用户在某套大脑里做的任何调整都会被记住，切走再切回来不丢。
 */
function presetFieldsFromConfig(cfg, provider) {
  if (provider === 'local') {
    const size = resolveLocalKey(localKeyOf(cfg?.llm?.model) || cfg?.llm?.localSize);
    return {
      size,
      channel: localChannelOf(cfg?.llm?.localChannel),
      maxTokens: cfg?.llm?.maxTokens,
      temperature: cfg?.llm?.temperature,
      context: { ...(cfg?.context || {}) },
      thinking: normalizeThinking(cfg?.llm?.thinking),
      features: { ...(cfg?.llm?.features || {}) },
    };
  }
  return {
    baseUrl: cfg?.llm?.baseUrl,
    model: cfg?.llm?.model,
    fallbackModels: [...(cfg?.llm?.fallbackModels || [])],
    maxTokens: cfg?.llm?.maxTokens,
    temperature: cfg?.llm?.temperature,
    context: { ...(cfg?.context || {}) },
    thinking: normalizeThinking(cfg?.llm?.thinking),
    features: { ...(cfg?.llm?.features || {}) },
  };
}

/**
 * 把当前这套扁平配置存回它所属大脑的预设里。
 * 每次保存配置 / 每次切换前都会调一次 —— 这是「各存各的」能成立的关键。
 */
export function stashCurrentPreset(cfg) {
  const provider = providerOf(cfg?.llm?.baseUrl);
  if (!PRESET_KEYS.includes(provider)) return readPresets(cfg);
  const presets = readPresets(cfg);
  presets[provider] = mergeDeep(presets[provider], presetFieldsFromConfig(cfg, provider));
  cfg.llm.presets = presets;
  return presets;
}

/**
 * 跨服务商写错模型名的拦截。
 *
 * 这是用户明确提出的痛点：在 A 大脑的页面上选了 B 大脑的模型，
 * 点下去就报错（400 / 404），而且报错信息完全看不懂。
 * 前端已经把下拉框按服务商分开了，这里是后端第二道闸 ——
 * 就算前端有 bug、或者有人直接调接口，也休想把 glm-* 塞给 DeepSeek。
 *
 * @returns {string|null} 不匹配时返回给用户看的中文原因
 */
export function modelProviderMismatch(model, provider) {
  const m = String(model || '').trim();
  if (!m) return null;
  if (provider === 'deepseek' && !/^deepseek/i.test(m)) {
    return `「${m}」不是 DeepSeek 的模型。当前大脑是 DeepSeek 云端，只能用它自己的模型` +
      `（deepseek-flash / deepseek-v4-pro）。要换成 ${m}，请先切到对应的大脑。`;
  }
  if (provider === 'zhipu' && !/^glm/i.test(m)) {
    return `「${m}」不是智谱的模型。当前大脑是智谱云端，只能填 glm 开头的模型` +
      `（如 glm-4.6v-flash）。要换成 ${m}，请先切到对应的大脑。`;
  }
  if (provider === 'local' && !m.includes('/')) {
    return `当前大脑是本机模型，模型要填本机模型的目录路径（例如 ` +
      `/Users/…/models/Qwen3.5-4B-MLX-4bit），不能填云端模型名「${m}」。` +
      `想用云端模型请先切换大脑。`;
  }
  if (provider === 'qwen') {
    // ⚠️ 这一支**刻意放行**（返回 null），与另外两家相反 —— 因为这里有一个真实的反例：
    //    千问平台**自己也代理别家的模型**（它的模型列表里有 deepseek-v4-* 与 glm-*；
    //    用户截图的第一页整页都是 deepseek）。所以"跨家名字"对它**不是错误**。
    //    照另外两家的形状拦一道，用户就选不了平台提供的那些模型 ——
    //    那是把"防错"做成了"功能缺失"，而界面上看不出原因。
    //
    //    代价（写清楚，别让下一个人以为这里是漏写的）：
    //    真填了一个平台没有的模型名，会得到一个**服务端的 404/400**，而不是在这里被拦住。
    //    那一类报错会在 /api/config 的返回里如实回显（`模型请求失败: HTTP 404 …`），
    //    用户能自己看出来。这与另外两家"当场拦住并说清"的取舍不同，是有意的：
    //    那两家的模型域是**闭集**（glm-* / deepseek-*），能判；千问是**开集**（484 条且在变），判不了。
    return null;
  }
  return null;
}

// `CREDIT_CLOUD_MODELS`（能调用、但走赠送额度的智谱模型）与 `isZhipuModel()`
// 已搬去 `src/free-quota.js`（2026-10-07 · 接千问时收敛判据）—— **一份实现**，换了个更该待的住处。
// ⚠️ 本文件**刻意不做 re-export**：多一层转发会让"这个符号到底归谁管"没人答得上来。
//    所以 `panel/server.js` 改成直接从 `src/free-quota.js` 取（与它取 net-rules 同款）。

/** 模型显示名：让花费明细里看得懂谁是谁 */
export const MODEL_LABELS = {
  'glm-4-flash': 'GLM-4-Flash',
  'glm-4-flash-250414': 'GLM-4-Flash-250414',
  'glm-4.5-flash': 'GLM-4.5-Flash',
  'glm-4.5-air': 'GLM-4.5-Air',
  'glm-4.5': 'GLM-4.5',
  'glm-4.6': 'GLM-4.6',
  'glm-4.7': 'GLM-4.7',
  'glm-4.7-flash': 'GLM-4.7-Flash',
  'glm-4.6v-flash': 'GLM-4.6V-Flash',
  'glm-4.6v-flashx': 'GLM-4.6V-FlashX',
  'glm-4.6v': 'GLM-4.6V',
  'glm-4.5v': 'GLM-4.5V',
  'glm-5': 'GLM-5',
  'glm-5-turbo': 'GLM-5-Turbo',
  'glm-5.1': 'GLM-5.1',
  'glm-5.2': 'GLM-5.2',
  'glm-5.3': 'GLM-5.3',
  'glm-5.3-flash': 'GLM-5.3-Flash',
  'glm-5v-turbo': 'GLM-5V-Turbo',
  'glm-ocr': 'GLM-OCR',
  'deepseek-flash': 'DeepSeek Flash',
  'deepseek-v4-pro': 'DeepSeek V4 Pro',
  // ── 千问（2026-10-07）──
  // ⚠️ 这几个名字要**跟着官方改名走**：平台把版本号写进模型名（`qwen3.8-max`），
  //    它一升级就多一个新名字。这里少一个不会报错 —— 线上会回落到显示原始 id
  //    （`s.modelLabels?.[m] || m`），所以最坏情况是"名字没修饰过"，不是空白。
  'qwen3.8-max': 'Qwen3.8-Max',
  'qwen3.8-flash': 'Qwen3.8-Flash',
  'qwen3.7-plus': 'Qwen3.7-Plus',
  'qwen3.7-flash': 'Qwen3.7-Flash',
  'qwen3.5-plus': 'Qwen3.5-Plus',
  'qwen3-max': 'Qwen3-Max',
  'qwen-turbo': 'Qwen-Turbo',
  'qwen-long': 'Qwen-Long',
};

// `providerOf()` 搬去 `src/net-rules.js`（B11c · AR-DATADRIVEN）。
// 判据只有一份：这里、`src/config.js`、页面读到的 `provider` 字段全都来自它。

/**
 * 从本地服务返回的模型 id（一个目录路径）反推它属于哪个规格。
 *
 * 改成由 LOCAL_MODELS 驱动，不再写死 4b/9b —— 加规格或减规格只动那一张表。
 * 匹配时要求参数量是一个独立的段（前后不是字母数字），否则
 * `Qwen3.5-30B-MLX-4bit` 里的 "4bit" 会被错认成 4B 规格。
 */
export function localKeyOf(id) {
  const seg = String(id || '').split('/').filter(Boolean).pop() || '';
  const name = seg.toLowerCase();
  for (const k of Object.keys(LOCAL_MODELS)) {
    if (new RegExp(`(^|[^a-z0-9])${k}([^a-z0-9]|$)`).test(name)) return k;
  }
  return '';
}

// `LOCAL_HOST_RE` / `isLocalBase()` 搬去 `src/net-rules.js`（B11c · AR-DATADRIVEN）。

/**
 * 生成下发给面板的能力表：
 *   { zhipu: { 'glm-4.5-air': {...}, ... }, deepseek: {...}, local: {...} }
 * 只给"会出现在界面上的模型"，不要把整张档案表原样搬过去（面板用不到 noChat 那些）。
 */
export function buildModelCaps() {
  const out = {};
  // ⚠️ 这个数组就是"面板上有哪几个大脑"的**唯一名单** —— 加一家只改这里。
  //    它必须与 `PRESET_KEYS` 同步（那边是"后端认哪几套预设"）；两者不同的症状是
  //    **界面上那个大脑的开关全是灰的**（`modelCaps[provider]` 取不到 → 判成"模型不支持"），
  //    而页面其余部分完全正常。
  for (const provider of ['zhipu', 'deepseek', 'qwen', 'local']) {
    const list = provider === 'zhipu'
      ? ZHIPU_SELECTABLE
      : provider === 'deepseek'
        ? BUILTIN_MODELS.deepseek
        : provider === 'qwen'
          ? QWEN_SELECTABLE
          : Object.keys(LOCAL_MODELS);
    out[provider] = {};
    for (const m of list) out[provider][m] = capabilitiesOf(provider, m);
  }
  return out;
}

/**
 * 和 src/config.js 的 normalizeThinking 保持一致（兼容旧的字符串写法）。
 *
 * ⚠️ 必须认 'max'：智谱的思考档位是 low / high / max。这里以前只认 low/medium/high，
 * 于是用户在面板上选了「最高」，保存时被静默降级成 medium 写回 config.json，
 * 机器人再把它映射成 high —— 界面上写着"最高"，实际跑的是"高"，而且没有任何提示。
 */
export function normalizeThinking(v) {
  const level = (s) => (['low', 'medium', 'high', 'max'].includes(s) ? s : 'medium');
  if (v && typeof v === 'object') {
    return { mode: ['auto', 'on', 'off'].includes(v.mode) ? v.mode : 'auto', level: level(v.level) };
  }
  if (['auto', 'on', 'off'].includes(v)) return { mode: v, level: 'medium' };
  return { mode: 'auto', level: 'medium' };
}
