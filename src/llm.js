import scoped from './logger.js';
import { capabilitiesOf, resolveThinking } from './model-caps.js';
import { sanitizeDeep } from './text-hygiene.js';
import { abortError } from './session-control.js';

// supportsVision 的实现在 model-caps.js（全项目唯一的能力判定入口）。
// 这里转出去只是为了不破坏 brain.js 的既有 import —— 但它**不允许**再有一份自己的名单。
export { supportsVision } from './model-caps.js';

/**
 * 「这条其实没把图发给它」的提示词（Q26b 裁决②：降级时明确提示"看不到图"）。
 *
 * ⚠️ 为什么必须有这句话（实测，不是猜的）：真机主模型 `glm-4.6v` 看得见图，
 * 而降级链**首位** `glm-4.5-air` 看不见（400 点名 `image_url` 非法）。
 * 识图开关开着、但那一枪降到了看不见图的模型上 → 图片被剥掉、它只看到「[图片]」两个字，
 * 于是答非所问 —— 而这条链上**没有任何东西会响**（不报错、不告警、界面照旧）。
 * 用户看到的表现是"它突然变笨了"，而真相是"它瞎了"。
 *
 * 裁决选的是"**只做可观测、不改选择**"（选项②）：
 * ① 会让降级时可选项变少（把看不见图的模型从链上摘掉 = 免费额度少一大半），
 * 而② 只是把已经发生的事说出来。
 */
export const NO_VISION_NOTE = '当前模型看不到图';

/**
 * 那句提示的完整文案（**唯一构造点**）。
 *
 * 抽出来是为了让"提示长什么样"只有一个住处 —— 日志里写一句、trace 里记一句，
 * 各拼一份必然漂，而漂了之后断言还能绿（它只查"有没有提示过"）。
 */
export function blindNoteOf({ model = '', reason = '' } = {}) {
  const why = reason === 'rejected' ? '服务端拒收图片' : '这个模型不支持识图';
  return `${NO_VISION_NOTE}（${model || '未知模型'} · ${why}）—— 图片已剥掉，它只看到「[图片]」，答非所问是正常的`;
}

/**
 * 读出「这轮请求命中了多少缓存 token」。
 *
 * 三家服务商的字段名**互不相同**，只认一家就等于换家之后永远读到 0：
 *   DeepSeek    usage.prompt_cache_hit_tokens
 *   OpenAI/智谱 usage.prompt_tokens_details.cached_tokens
 *   Anthropic   usage.cache_read_input_tokens
 *
 * 之前这里只认 DeepSeek 的名字，而本地主链路走的是智谱 → usage.jsonl 里 160 条记录、
 * 142,448 个 prompt token 的命中数**每一行都是 0**。后果不是数字难看，而是
 * 「改提示词顺序到底有没有提升缓存命中」这件事**从来没被看见过**，改了也证明不了。
 *
 * 单独导出成函数、而不是内联在下面那段对象字面量里：断言要能直接喂合成 usage 验证，
 * 若把这串兜底逻辑再在测试里抄一遍，就又多了一处「同一份语义的第二份拷贝」。
 */
export function cachedTokensOf(usage) {
  if (!usage || typeof usage !== 'object') return 0;
  const n =
    usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens ?? usage.cache_read_input_tokens;
  return Number.isFinite(n) ? n : 0;
}

const log = scoped('llm');

/**
 * 智谱的**内置**联网工具。注意它和 function 型工具不是一回事：
 * 这是"服务商自己实现的搜索"，我们只负责开开关，没有本地实现。
 *
 * ⚠️ 做成模块级常量、且**只此一份**：它会被放进每一轮请求的前缀，
 * 一旦出现两份形状略有差异的拷贝，"tools 逐轮稳定"这条约束就守不住了。
 * 对象本身是冻结的 —— 谁都不能就地改它（改了之后每一轮的前缀都会带着那个改动）。
 */
export const WEB_SEARCH_TOOL = Object.freeze({ type: 'web_search', web_search: Object.freeze({ enable: true }) });

/**
 * 组装这次请求的 `tools` 数组 —— **纯函数，全项目唯一的一处**。
 *
 * 为什么单独抽出来而不是内联在 `#chatOnce` 里：`scripts/dryrun.js --tools`
 * 要能回答"现在这一次请求到底会带什么工具"。若在 dryrun 里再拼一遍，
 * 就出现了"同一份判据两份拷贝"，而两份漂移的表现是
 * **干跑显示的与实际发出的不一致** —— 那是本项目最忌讳的那种谎。
 *
 * 两个来源：
 *   ① `web_search`：服务商**内置**的搜索实现，我们只开开关。
 *   ② function 型工具：我们提供函数、模型决定调哪个（第 46 轮 B12e-1 新增）。
 *
 * ⚠️ 两类都必须按**这一次真正请求的那个模型**收敛，不是按配置里的主模型：
 *    降级链跑起来时真正被调用的是链上的某一项，而各模型能力不同 ——
 *    实测 `glm-4.6v` / `glm-5v-turbo` 收下 web_search 但不生效（白开），
 *    本机 4B 收到 function schema 会 400。不收敛的话，"降级成功"反而让整条消息被拒。
 *
 * @param {{webSearchEnabled:boolean, caps:object, tools?:object[]}} a
 * @returns {object[]} 空数组 = **不写 `body.tools` 字段**（不是写一个空数组）
 */
export function toolsForRequest({ webSearchEnabled, caps, tools } = {}) {
  const builtin = webSearchEnabled && caps?.features?.webSearch ? [WEB_SEARCH_TOOL] : [];
  const funcs = caps?.features?.functions && Array.isArray(tools) ? tools : [];
  return builtin.length || funcs.length ? [...builtin, ...funcs] : [];
}

export class LlmClient {
  /**
   * @param {{baseUrl:string, apiKey:string, model:string, temperature:number,
   *          maxTokens:number, timeoutMs:number, thinking?:'auto'|'on'|'off'}} cfg
   */
  constructor(cfg) {
    this.cfg = cfg;
    /** 最近一次请求的 token 用量，供成本统计用 */
    this.lastUsage = null;
    /**
     * 实测不认 reasoning_effort 的模型集合，键为 `provider/model`。
     *
     * 为什么需要它：服务端第一次拒绝之后，如果每次都"先发、被拒、再重发"，
     * 那么每一条消息都要白搭一次往返。记下来之后，这个进程里后续请求干脆不再带。
     * 故意**不落盘**：服务端随时可能改口味，重启重新探测一次比背着一份陈旧名单更安全。
     */
    this._effortRejected = new Set();
    /**
     * M-3（2026-10-04 审查轮）：已经**就"工具发不出去"告警过**的模型集合。
     * 只用来**去重告警**（每模型一次），不参与任何业务判定 ——
     * 为什么不去重就会出事：这条在**每一轮请求**上都会命中，
     * 不限一次的告警等于把日志刷满，而日志被刷满之后**真正的异常就看不见了**。
     */
    this._toolsGated = new Set();
    /**
     * 最近一次**成功**的请求里，图片是不是被剥掉了（Q26b）。
     * `null` = 这次没剥（图片正常发了，或压根没图）。
     * 与 `lastUsage` 同族：只在 `chat()` 里对外发布，`chatWithUsage()` 旁路各取各的。
     */
    this.lastBlind = null;
    /** 本次 `#run` 内最后一次"剥图"的事实（成功才对外发布，见 `chat()`）。 */
    this._blind = null;
  }

  /**
   * 记一次"这次请求其实没把图给它"（Q26b 的唯一留痕点）。
   *
   * ⚠️ 两个来源都走这里，判据才只有一份：
   *   ① `unsupported` —— 能力表就说它看不见（**事前**剥，以前是完全静默的）；
   *   ② `rejected`   —— 能力表说能看、服务端仍拒（**事后**剥，以前只有一行"拒收图片"）。
   */
  #noteBlind(model, provider, reason) {
    this._blind = { model: String(model || ''), provider: String(provider || ''), reason };
    log.warn(blindNoteOf({ model, reason }));
  }

  /** 热重载：配置变了直接换掉，不用重建连接 */
  update(cfg) {
    // 换了模型/地址就把熔断记录清空，别把上一家的账算到新服务商头上
    if (cfg.model !== this.cfg.model || cfg.baseUrl !== this.cfg.baseUrl) {
      this._fail = {};
      this._cooldown = {};
      // 换了模型/服务商，上一家的"不认分级"记录就不作数了，重新探测
      this._effortRejected = new Set();
    /**
     * M-3（2026-10-04 审查轮）：已经**就"工具发不出去"告警过**的模型集合。
     * 只用来**去重告警**（每模型一次），不参与任何业务判定 ——
     * 为什么不去重就会出事：这条在**每一轮请求**上都会命中，
     * 不限一次的告警等于把日志刷满，而日志被刷满之后**真正的异常就看不见了**。
     */
    this._toolsGated = new Set();
    }
    this.cfg = { ...this.cfg, ...cfg };
    return this;
  }

  get label() {
    const t = this.cfg.thinking || { mode: 'auto', level: 'medium' };
    let s = '';
    if (t.mode === 'off') s = ' | 思考:关';
    else if (t.mode === 'on') s = ` | 思考:开(${t.level})`;
    return `${this.cfg.model} @ ${this.cfg.baseUrl}${s}`;
  }

  /**
   * 思考（思维链）参数。
   *
   * ⚠️ **按「这一次实际要请求的那个模型」算，不是按配置里的主模型算。**
   *    降级链跑起来时，真正被调用的是链上的某一项 —— 可能是 glm-4.6v，
   *    而主模型是 glm-4.5-air。两者的能力不一样（比如一个能联网一个不能），
   *    按主模型算就会把不该有的参数发给它。
   *
   * 参数写法（都是实测 + 官方文档核对过的）：
   *   智谱     thinking:{type:'enabled'|'disabled'} + 顶层 reasoning_effort: low|high|max
   *   本机     chat_template_kwargs:{enable_thinking:true|false}
   *   DeepSeek thinking:{type:'enabled'|'disabled'} + reasoning_effort
   *   千问     顶层 enable_thinking:true|false + 顶层 reasoning_effort: low|medium|xhigh
   *   自定义   只发顶层 reasoning_effort（low|medium|high）—— 见下方分支
   *   其他家   一个字段都不发（不认识的参数会被 400 整条拒掉）
   */
  #applyThinking(body, model, override) {
    // `override` = **这一次调用**的思考设置（`chatWithUsage(msgs, { thinking })`）。
    //
    // 为什么非要它：`thinking` 原本只住在构造配置里，于是"小额旁路调用"没法声明
    // 「我这点额度不够思考用」。真机实测（2026-09-23）：配置 `mode:'on'` 时，
    // 自动记忆判断（`maxTokens: 160`）的 content **恒为空** —— 额度全被 reasoning 吃满、
    // `finish_reason` 是 `length`，而这一失败**四层回归里一条断言都没有**
    // （mock 不会模拟"思考吃掉额度"）。表现是结构化记忆在真机上**一条都没落过盘**。
    //
    // ⚠️ override 也要过下面那层收敛：模型**关不掉思考**时它会被折回 `on`
    //    （那时额度不足的问题依然存在，只能靠加大 maxTokens，不能靠这句）。
    const t = override || this.cfg.thinking || { mode: 'auto', level: 'medium' };

    if (this.cfg.isLocal) {
      if (t.mode !== 'auto') body.chat_template_kwargs = { enable_thinking: t.mode === 'on' };
      return;
    }

    const provider = this.cfg.provider;
    // 自定义大脑才有（`src/config.js` 物化时带上）—— 内置那几家恒为 undefined
    const declared = this.cfg.declaredFeatures || null;

    // ── 千问 ────────────────────────────────────────────────────────────
    // ⚠️ 这一支是 2026-10-07 **补上去的漏洞**：上一批把千问加进了能力表
    //    （think=OFFABLE、档位 low/medium/xhigh），却**没接这一层** ——
    //    于是界面上"思考"开关能开、档位能选，**点了却一个参数都没发出去**。
    //    这是"点了没用"里最难发现的形态：界面正常、日志正常、回归也全绿。
    // 写法（官方兼容模式）：顶层 `enable_thinking` 开关 + 顶层 `reasoning_effort` 强度。
    if (provider === 'qwen') {
      const q = resolveThinking(provider, model, t, declared);
      if (q.mode === 'auto') return; // 不干预，用服务端默认
      body.enable_thinking = q.mode === 'on';
      if (q.mode === 'off') return; // 关思考时给强度参数没有意义
      const capsQ = capabilitiesOf(provider, model, declared);
      if (capsQ.levels.length && !this._effortRejected.has(`${provider}/${model}`)) {
        body.reasoning_effort = q.level;
      }
      return;
    }

    // ── 自定义大脑 ──────────────────────────────────────────────────────
    // 用户**没勾**"能思考" ⇒ 一个思考参数都不发。
    //   这不是保守：各家思考参数的写法互不相同（智谱 `thinking.type`、千问
    //   `enable_thinking`、还有家根本不认），对一个没勾思考的自建网关乱发只会 400。
    // 勾了 ⇒ 只发**最通用**的顶层 `reasoning_effort`；
    //   服务端不认时，下面那条「响应正文点名 reasoning_effort 就去掉参数重发」
    //   会自动兜住 —— 不会静默失败，也不会把整条请求废掉。
    if (declared) {
      if (!declared.thinking) return;
      const c = resolveThinking(provider, model, t, declared);
      if (c.mode !== 'on') return; // auto / off 都不发
      if (this._effortRejected.has(`${provider}/${model}`)) return; // 上次被拒过，别再撞一次
      // ⚠️ **这里刻意不看 `caps.levels`**：自定义大脑在能力表里没有条目，
      //    `levels` 恒为**空数组** —— 照内置那两家的写法判 `levels.length` 的话，
      //    门永远是关的，用户勾了"能思考"却一个参数都发不出去（正是漏掉这个检查时实测到的形态）。
      //    没有档位表 ≠ 不能发强度，只是我们不知道它认哪几档 ⇒ 退到 OpenAI 通用那三档。
      //    ⚠️ `max` 是智谱的档，不替用户猜。
      body.reasoning_effort = ['low', 'medium', 'high'].includes(c.level) ? c.level : 'medium';
      return;
    }

    if (provider !== 'zhipu' && provider !== 'deepseek') return; // 别家什么都不发

    // 收敛：模型关不掉思考就绝不发 disabled（glm-5.3 收到 disabled 会直接 400，
    // 而 400 不属于"可重试"错误，整条降级链会当场断掉）
    const { mode, level } = resolveThinking(provider, model, t, declared);
    if (mode === 'auto') return; // 不干预，用服务端默认

    body.thinking = { type: mode === 'on' ? 'enabled' : 'disabled' };
    if (mode === 'off') return; // 关思考时给强度参数没有意义

    // 强度用**官方字段 reasoning_effort**。
    // 旧代码把档位塞在 thinking.level 里 —— 官方文档里根本没有这个字段；
    // 实测把 low / max 两种档位各调一遍，思考长度没有稳定的差别，
    // 也就是"面板上选强度其实什么都没发生"。这正是用户抱怨的那种"点了没用"。
    const caps = capabilitiesOf(provider, model, declared);
    if (caps.levels.length && !this._effortRejected.has(`${provider}/${model}`)) {
      body.reasoning_effort = level;
    }
  }

  /**
   * @param {{role:'system'|'user'|'assistant', content:string}[]} messages
   * @returns {Promise<string>} 模型回复文本
   */
  /**
   * 完整的降级链：主模型 + 依次的备用，去重。
   * 免费模型晚高峰会轮流被限流，一条链比"主+单备"稳得多。
   */
  get chain() {
    const list = [];
    for (const m of [this.cfg.model, ...(this.cfg.fallbackModels || []), this.cfg.fallbackModel]) {
      if (m && !list.includes(m)) list.push(m);
    }
    return list;
  }

  /** 某个模型是不是还在熔断冷却期 */
  #cooling(model) {
    return (this._cooldown?.[model] || 0) > Date.now();
  }

  /** 试一个模型；失败时按错误类型决定要不要熔断。counter 由 #run 建，跨模型累计 HTTP 次数 */
  async #tryModel(model, messages, opts, counter) {
    try {
      const out = await this.#chatOnce(messages, opts, model, counter);
      // 成功就清掉这个模型的失败记录，让它重新参与
      if (this._fail?.[model]) this._fail[model] = 0;
      if (this._cooldown?.[model]) delete this._cooldown[model];
      if (model !== this.cfg.model) log.info(`降级到 ${model} 回复成功`);
      return out;
    } catch (err) {
      if (isOverloaded(err)) {
        this._fail = this._fail || {};
        this._cooldown = this._cooldown || {};
        this._fail[model] = (this._fail[model] || 0) + 1;
        if (this._fail[model] >= 2) {
          // 连续两次被拒就别每条消息都去撞墙了，冷却 5 分钟
          this._cooldown[model] = Date.now() + 5 * 60 * 1000;
          log.warn(`${model} 连续 ${this._fail[model]} 次不可用，冷却 5 分钟`);
        } else {
          log.warn(`${model} 不可用（${err.status || err.message}），换链上下一个`);
        }
      }
      throw err;
    }
  }

  /**
   * 跑完整条降级链，返回 `{ text, usage }`。
   *
   * **不碰 `this.lastUsage`** —— 这是刻意的：`lastUsage` 是实例上的共享可变字段，
   * 而自动记忆判断与主链路共用同一个 LlmClient。谁后写谁覆盖，
   * 结果是 memory keeper 那一笔 token 从来没进过账本。
   * 旁路调用请走 chatWithUsage()，拿自己那一份 usage。
   *
   * `counter.n` 记这次逻辑请求**实际发了几次 HTTP**（含 5xx/网络重试、换模型降级、
   * 以及 400 去掉 reasoning_effort 后的重试）—— 用来解释"账上只有一条、实际打了几枪"。
   */
  async #run(messages, opts = {}) {
    const counter = { n: 0 };
    const chain = this.chain;
    let lastErr = null;
    // 一次逻辑请求里可能换几个模型，剥图的事实只认**最后成功那一个**。
    this._blind = null;

    // 第一轮：跳过正在冷却的模型
    for (const m of chain) {
      if (this.#cooling(m)) continue;
      try {
        return await this.#tryModel(m, messages, opts, counter);
      } catch (err) {
        if (!isOverloaded(err)) throw err; // 参数错之类的，换模型也没用
        lastErr = err;
      }
    }

    // 第二轮：链上全都在冷却期。硬着头皮忽略冷却再试一遍 ——
    // 宁可多花一次等待，也不能让机器人在群里彻底哑掉。
    if (chain.length) {
      log.warn('模型链全部处于冷却期，忽略冷却强制重试一轮');
      for (const m of chain) {
        try {
          return await this.#tryModel(m, messages, opts, counter);
        } catch (err) {
          if (!isOverloaded(err)) throw err;
          lastErr = err;
        }
      }
    }

    throw lastErr || new Error('模型链上没有可用模型');
  }

  /** 主链路用：只要文本，usage 顺带写到 this.lastUsage（历史行为不变） */
  async chat(messages, opts = {}) {
    const { text, usage } = await this.#run(messages, opts);
    this.lastUsage = usage;
    // Q26b：成功才对外发布 —— 整条链都失败了的话，讨论"那个模型瞎不瞎"没有意义。
    this.lastBlind = this._blind;
    return text;
  }

  /**
   * 旁路调用用（如自动记忆判断）：调用方自己拿 usage 去记账，不经过共享字段。
   *
   * 为什么必须有这条出口：`lastUsage` 是**共享可变字段**，keeper 与主链路共用同一个
   * LlmClient —— 两边互相覆盖。keeper 那一笔 token 因此既没被记进账本，
   * 还可能串到主链路的账上（谁先写完谁被谁盖住，看时序）。
   *
   * `opts` 支持 `{ temperature, maxTokens, tools, thinking }`。
   * ⚠️ **给了小 `maxTokens` 就必须同时给 `thinking`**（`{mode:'off'}`）——
   *    那个额度是留给最终答案的，开着思考会被 reasoning 吃光、content 恒为空。
   *    判据由 `check-wb` 盯着（见"小额旁路必须声明 thinking"那条契约）。
   */
  async chatWithUsage(messages, opts = {}) {
    return this.#run(messages, opts);
  }

  async #chatOnce(messages, { temperature, maxTokens, tools, thinking, signal, shrink } = {}, model, counter) {
    const provider = this.cfg.provider;
    // ⚠️ 第三个参数必须传：自定义大脑的能力来自**用户勾的那几项**，
    //    不传的话 `capabilitiesOf` 会按"能力表里没这个型号"全判 false ——
    //    结果就是用户勾了"能看图"，图片照样被剥掉（界面上却显示着已开启）。
    const caps = capabilitiesOf(provider, model, this.cfg.declaredFeatures);
    // `msgs` 而不是直接用入参：语义降级（去图 / 收缩）会在下面**改写这一次请求的消息**。
    // 改的是**这个局部变量**，调用方手里的数组一个字节都不动 ——
    // 工具回合下一轮仍按它自己的 `msgs` 走，不会因为我们悄悄缩短了历史而错位。
    let msgs = messages;
    // Q26b：剥图这件事**必须留痕**。以前这里完全静默 ——
    // 降级到看不见图的模型时，图片被剥掉、它只看到「[图片]」，界面与日志一个字都没有。
    const sentMsgs = stripImagesIfUnsupported(msgs, provider, model, this.cfg.declaredFeatures);
    if (sentMsgs !== msgs) this.#noteBlind(model, provider, 'unsupported');
    const body = {
      model,
      // 不支持图片的模型要把图剥掉再发，否则整条消息会被 400 拒掉
      messages: sentMsgs,
      temperature: temperature ?? this.cfg.temperature,
      max_tokens: maxTokens ?? this.cfg.maxTokens,
      stream: false,
    };
    this.#applyThinking(body, model, thinking);

    // ── tools 的两个来源，合起来才是一次请求的 tools 数组（B12e-1）──
    //   ① 智谱内置的 web_search（服务商实现，我们只开开关）
    //   ② function 型工具（我们提供函数，模型决定调哪个）—— 由调用方经 opts.tools 传入
    //    组装判据在 `toolsForRequest()`（全项目唯一一处，`dryrun --tools` 也读它）。
    //
    // ★ 两个来源都为空时**不写 body.tools 字段**（不是写一个空数组）。
    //   这是"没注册任何工具时，请求体与改造前逐字节相同"的实现基础 ——
    //   `tools: []` 虽然语义等价，但请求体已经变了，字节级反证就不成立了。
    const composed = toolsForRequest({ webSearchEnabled: this.cfg.features?.webSearch, caps, tools });
    if (composed.length) body.tools = composed;

    // ── M-3（2026-10-04 审查轮）：**工具被静默关掉**必须出声 ────────────────
    // 症状：`provider='local'` 时 `capabilitiesOf()` 的 `functions` 位恒为 false
    //      （`localMetaOf()` 返回的对象**根本没有这个键**）⇒ 带进来的 function 工具
    //      **一个都发不出去**，而请求体只是"没有 `tools` 字段"：
    //      日志、trace、页面**三处都没有异常**。用户会以为"模型不会用工具"，
    //      而不是"有一道闸把工具全挡了" —— 这就是本项目最忌讳的"改了不报错"。
    // 处置：只在**真的带了工具却没发出去**时告警一次（每模型一次，不刷屏）。
    //      ⚠️ **不改判定方向** —— `functions` 保守默认 false 是刻意的：
    //         判宽了会让整条请求 400（表现为"机器人突然不理我"），代价不对称。
    //         这里只负责"说出来"，见 `src/model-caps.js` 的 functions 位注释。
    if (Array.isArray(tools) && tools.length && !caps?.features?.functions && !this._toolsGated.has(model)) {
      this._toolsGated.add(model);
      log.warn(
        `${model}（provider=${this.cfg.provider}）不支持 function 调用 → 本轮携带的 ${tools.length} 个工具**一个都不会发出**。`
          + '本机（mlx / QwenChat）通道恒为此状态；想用工具请切到云端服务商。'
          + '（只提醒一次；判据在 src/model-caps.js 的 functions 位）'
      );
    }

    // ⚠️ **不许给 body 加 `tool_choice`**（第 46 轮实测，见 model-caps.js 的实测记录）。
    //    DeepSeek 三款在思考模式下收到具名 tool_choice 一律 400：
    //      `"Thinking mode does not support this tool_choice"`
    //    而 400 不属于"可重试"错误 → 整条降级链当场断掉，群里表现为它彻底不回话。
    //    默认（不写这个字段）等价于 auto，是三家都认的那一种。

    let data;
    try {
      data = await this.#post('/chat/completions', body, 2, counter, signal);
    } catch (err) {
      // reasoning_effort 不是所有模型都认，服务端真拒了就降级重试 —— 不因一个可选参数丢掉整条回复。
      //
      // ⚠️ 但**不能见 400 就赖它**。2026-09-19 真机实测（第 36 轮）：
      //   同一个分支把 contentFilter(1301) 与「图片输入格式错误」(1210) 的 400
      //   也当成"服务端不接受分级"，于是删掉参数又白打一枪，还在日志里留下一句
      //   与真相不符的告警 —— 排查时被这句话带偏，比少一次重试贵得多。
      //   判据收紧为：**响应正文点名 reasoning_effort 才降级**；其余原样抛出
      //   （那些错误本来就换参数也没用，重发只是浪费）。
      //
      // ── D8：语义降级层（报告 E3）────────────────────────────────────
      // 同一形状再挂两档，**每档都只在响应正文点名时才降**、且**每档每轮最多一次**：
      //   ② 去图重试 —— 正文点名图片参数；把这次的 image_url 段剥掉重发
      //      （`stripImageParts` 与"模型不支持视觉"用的是**同一个实现**，不是第二份）
      //   ③ 收缩重试 —— 正文点名上下文过长；用调用方给的 `shrink` 把历史砍短重发
      //      （`shrink` 是入参而不是本地实现：历史该砍谁只有上层知道，
      //        在本层猜"哪条是历史"必然猜错）
      // 三档**互斥**：一次请求最多降一档。两档同时需要时先修视觉（代价更小），
      // 下一轮再收缩 —— 不做"链式降级"，那会让"这一枪为什么打了四次"无法归因。
      if (err.status === 400 && body.reasoning_effort && isEffortRejection(err)) {
        this._effortRejected.add(`${this.cfg.provider}/${model}`);
        log.warn(`${model} 不接受 reasoning_effort(${body.reasoning_effort})，本进程内不再携带并降级重试`);
        delete body.reasoning_effort;
        data = await this.#post('/chat/completions', body, 1, counter, signal);
      } else if (err.status === 400 && hasImageParts(body.messages) && isVisionRejection(err)) {
        body.messages = stripImageParts(body.messages);
        // Q26b：这一枪同样"它看不到图"，与上面那条走**同一个**留痕点。
        this.#noteBlind(model, provider, 'rejected');
        log.warn(`${model} 拒收图片（${String(err.message).slice(0, 120)}），去掉图片重试一次`);
        data = await this.#post('/chat/completions', body, 1, counter, signal);
      } else if (err.status === 400 && typeof shrink === 'function' && isContextTooLong(err)) {
        const next = shrink(body.messages);
        // ⚠️ `shrinkHistory` 缩不动时返回**同一个引用** —— 这里据此判断"降级有没有
        //    真的改变请求"。不比对就重发的话，日志会说"已收缩"，而实际上打的
        //    是同一份请求（白打一枪 + 留下一条不实告警，正是本文件上一段在骂的事）。
        if (next && next !== body.messages) {
          body.messages = next;
          log.warn(`${model} 报上下文过长，砍掉最老的历史重试一次（${msgs.length} → ${next.length} 条消息）`);
          data = await this.#post('/chat/completions', body, 1, counter, signal);
        } else {
          throw err;
        }
      } else {
        throw err;
      }
    }
    const choice = data?.choices?.[0];
    const message = choice?.message && typeof choice.message === 'object' ? choice.message : null;
    const content = message?.content ?? choice?.text ?? '';

    /**
     * 这一轮**只要工具、不说话**是 function calling 的正常形状
     * （`content: null` + `tool_calls` 非空）。
     *
     * ⚠️ 下面那句"内容为空就抛错"必须让开这条路，否则表现是：
     *    模型第一次要调工具 → 我们当成"模型返回空"抛异常 → 整条回复丢掉，
     *    而日志里写着"模型返回内容为空"——排查时会被这句话带到完全错误的方向。
     */
    const hasToolCalls = Array.isArray(message?.tool_calls) && message.tool_calls.length > 0;

    // 组装用量，哪怕这一步出问题也别影响正常回复。
    // 注意这里**不再写 this.lastUsage** —— 交给 #run 的调用者决定要不要落到那个共享字段。
    let usage = null;
    try {
      const t = this.cfg.thinking || {};
      usage = data?.usage
        ? {
            // 用「实际请求的那个模型」记账。服务端不回 model 字段时，
            // 至少还能如实记下我们降级到了谁，花费统计才不会被骗。
            model: data.model || model,
            base: this.cfg.baseUrl, // 记下来源，才能判断是不是本机（不花钱）
            // 服务商也**写入时定死**：统计时就不必再从 baseUrl 反推，也就不会认错对象。
            // 取 cfg.provider —— 那是 config.js 按 baseUrl 判好之后放进来的唯一那份，
            // 不在这里再写一遍判定规则（本项目已经有三份 providerOf 拷贝了，别再添第四份）。
            vendor: this.cfg.provider || '',
            // 直接把「是否本机 / 思考档位」落盘，统计时就不用再反推，不会认错对象
            local: !!this.cfg.isLocal,
            think: t.mode || 'auto',
            level: t.level || 'medium',
            prompt: data.usage.prompt_tokens ?? 0,
            completion: data.usage.completion_tokens ?? 0,
            reasoning: data.usage.completion_tokens_details?.reasoning_tokens ?? 0,
            // 缓存命中数：字段名三家不同，统一走 cachedTokensOf（别在这里内联第二份）
            cached: cachedTokensOf(data.usage),
            // 这条账背后实际发了几次 HTTP（5xx/网络重试、换模型降级、去参数重试都算）。
            // 只报"成功那次的 token"，但把"打了几枪"如实带上 —— 不然
            // 「账上一条、实际三次」这种事永远看不见。
            attempts: counter?.n ?? 1,
          }
        : null;
    } catch {
      usage = null;
    }

    if (!content && !hasToolCalls) {
      throw new Error(`模型返回内容为空: ${JSON.stringify(data).slice(0, 300)}`);
    }
    // `assistant` 原样带出去给工具回合用（它要靠 `tool_calls` 回灌）。
    // 这里**不解析** tool_calls —— 判据只有一处（src/tool-loop.js 的 parseToolCalls），
    // 在这一层再解析一遍就是第二份语义。
    return { text: String(content ?? '').trim(), usage, assistant: message };
  }

  async #get(pathname) {
    const url = this.#url(pathname);
    const res = await this.#fetchWithTimeout(url, { method: 'GET', headers: this.#headers() });
    if (!res.ok) throw new Error(`GET ${pathname} 失败: HTTP ${res.status}`);
    return res.json();
  }

  async #post(pathname, body, retriesLeft, counter, signal) {
    const url = this.#url(pathname);
    // 每一次真正发出去的 HTTP 都记一笔（含 5xx 重试与网络重试的递归调用）。
    // counter 由 #run 创建、跨模型传递 —— 不用实例字段，否则旁路调用会互相冲掉。
    if (counter) counter.n += 1;
    // ⚠️ 发之前先看一次中止标记：用户在上一次重试的 800ms 等待里点了中止，
    //    不该还替他把这一枪打出去（那正是"点了停止它却还在打模型"的观感来源）。
    if (signal?.aborted) throw abortError();
    try {
      const res = await this.#fetchWithTimeout(url, {
        method: 'POST',
        headers: { ...this.#headers(), 'Content-Type': 'application/json' },
        // 发出去之前的**最后一道文本卫生**（第 56 轮 F1-3 · E5③）：
        // 只删孤立代理项（切片切出来的半个 emoji），成对的一个都不动。
        // 挂在 `#post` 而不是 `#chatOnce`：**所有**请求都从这里出去（主链路 / 旁路 / 工具回合），
        // 挂在上面某一处就一定会有第二条路径绕过去。
        body: JSON.stringify(sanitizeDeep(body)),
      }, signal);
      if (res.status >= 500 && retriesLeft > 0) {
        log.warn(`模型返回 HTTP ${res.status}，重试中（剩 ${retriesLeft} 次）`);
        await sleep(800);
        return this.#post(pathname, body, retriesLeft - 1, counter, signal);
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        // 把状态码挂到错误上，上层才能判断「是不是某个可选参数导致的 400」
        const err = new Error(`模型请求失败: HTTP ${res.status} ${text.slice(0, 300)}`);
        err.status = res.status;
        throw err;
      }
      return await res.json();
    } catch (err) {
      // ── 中止的归因优先级最高（D6）────────────────────────────────────
      // 用户中止与"超时"在底层是**同一个 AbortError**（都来自 AbortController）。
      // 若不先判 `signal.aborted`，中止会被报成"模型请求超时"——
      // 于是排障时人会去查网络与服务商，而真实原因是他自己点了停止。
      if (signal?.aborted) throw abortError();
      if (isAbort(err)) throw new Error(`模型请求超时（>${this.cfg.timeoutMs}ms）`);
      if (retriesLeft > 0 && isNetwork(err)) {
        log.warn(`模型请求网络异常，重试中（剩 ${retriesLeft} 次）: ${err.message}`);
        await sleep(800);
        return this.#post(pathname, body, retriesLeft - 1, counter, signal);
      }
      throw err;
    }
  }

  #url(pathname) {
    return `${this.cfg.baseUrl}${pathname}`;
  }

  #headers() {
    return this.cfg.apiKey ? { Authorization: `Bearer ${this.cfg.apiKey}` } : {};
  }

  /**
   * 带超时的 fetch。`signal` 是**外部**（会话级）中止信号 —— D6：
   * 用户在面板点「中止本轮」要能立刻掐断在途请求，而不是干等 60 秒超时。
   *
   * ⚠️ 两路中止共用同一个内部 controller，但**归因在 `#post` 的 catch 里分**：
   *    先看 `signal.aborted`（人为中止），再看 `isAbort(err)`（超时）。
   *    顺序反了会把中止报成超时，把人引去查网络。
   */
  async #fetchWithTimeout(url, init, signal) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.cfg.timeoutMs);
    const onAbort = () => ac.abort();
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer);
        throw abortError();
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    try {
      return await fetch(url, { ...init, signal: ac.signal });
    } finally {
      clearTimeout(timer);
      // 摘掉监听：这条 signal 可能被同一会话的后续轮次复用（`AbortSignal` 不回收监听器，
      // 不摘的话长会话会攒出一串僵尸监听，本项目对"只增不减"一律设上限/回收）
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }
}

function isAbort(err) {
  return err?.name === 'AbortError' || /aborted/i.test(err?.message ?? '');
}

/**
 * 这个 400 是不是「服务端不认 reasoning_effort」造成的。
 *
 * 判据是**响应正文里点名了这个参数**，而不是"状态码等于 400"。
 * 400 是所有"你这次请求有问题"的公共出口（内容安全 1301、图片格式 1210 都走它），
 * 拿状态码当判据会把每一次内容过滤都误判成参数不兼容。
 */
function isEffortRejection(err) {
  return /reasoning_effort/i.test(err?.message ?? '');
}

/**
 * 这个 400 是不是「服务端收不下我发过去的图片」造成的（D8）。
 *
 * 判据同样是**响应正文点名**，不是状态码。已有的真机证据（见 `stripImagesIfUnsupported`
 * 的注释）：纯文本模型收到带图消息时报的是 `messages.content.type 参数非法`。
 * 所以这里认三种措辞：字段名 `image_url` / `messages.content`，以及中文的「图片…非法 / 不支持」。
 *
 * ⚠️ 口径必须收窄：**只在这次请求真的带了图时才走这条路**（调用点会再判一次
 *    `hasImageParts`）。否则一条与图片无关的 400 也会被当成"去图能解决"，
 *    于是白打一枪 —— 那正是本文件反复警告的"把 400 当成一个笼统的失败"。
 *
 * ⚠️ **导出是为了复用**（D16）：`scripts/probe-vision.mjs` 要判"服务端是不是在说
 *    '我不认图片'"，而那必须与生产走**同一份措辞判据** —— 探测脚本另抄一个正则的话，
 *    两边迟早分叉（真机上表现为"探测说支持、生产却去图"）。签名保持不变（收 `err`）。
 */
export function isVisionRejection(err) {
  const s = err?.message ?? '';
  return /image_url|messages\.content|图片|图像|vision|multimodal/i.test(s) && /非法|不支持|invalid|unsupported|not support/i.test(s);
}

/**
 * 这个 400 是不是「上下文太长」（D8）。
 *
 * ⚠️ **本条未在真机复现过** —— 主链路走智谱、上下文预算 16,000 字符，
 *    至今没有触发过超长。所以这里的措辞是**推测性**的（对齐三家公开文档里常见的说法），
 *    而不是实测所得。写清楚这一点，是为了让下一个人知道：
 *    如果它在真机上从不触发，**不是判据写错了，可能只是从没发生过**；
 *    真要确认，得先造一条超长请求打一次（`scripts/dryrun.js` 可以改着试）。
 *    —— 本项目纪律：没实测的因果要写成「推测」（§4.3）。
 */
function isContextTooLong(err) {
  const s = err?.message ?? '';
  return /context length|context_length|maximum context|too many tokens|prompt is too long|reduce the length|输入.{0,8}过长|上下文.{0,8}过长|超出.{0,6}长度|请减少/i.test(
    s
  );
}

/**
 * 「这一段消息内容是不是图片」的**唯一判据**（D8）。
 *
 * 抽出来的原因是它有两个消费者：`hasImageParts`（判断要不要走去图重试）与
 * `stripImageParts`（真的剥掉）。各写一份的后果与项目里所有"两份拷贝"一样：
 * 漂移的表现是**某个模型上图片永远被剥掉**或**永远剥不掉**，都不报错。
 */
function isImagePart(c) {
  return c?.type === 'image_url';
}

/** 这批消息里有没有图片段（参数用同一个 `isImagePart`） */
function hasImageParts(messages) {
  return (Array.isArray(messages) ? messages : []).some(
    (m) => Array.isArray(m?.content) && m.content.some(isImagePart)
  );
}

/**
 * **无条件**把 image_url 段剥掉、只留文字（D8：`stripImageParts` 是这里唯一的实现）。
 *
 * 两个调用方，判据只有一份：
 *   ① `stripImagesIfUnsupported`（事前）—— 能力表说这个模型看不了图，就别发；
 *   ② `#chatOnce` 的去图重试（事后）—— 能力表说能看、服务端仍拒收，剥掉重发。
 */
export function stripImageParts(messages) {
  let touched = false;
  const out = (Array.isArray(messages) ? messages : []).map((m) => {
    if (!Array.isArray(m.content)) return m;
    if (!m.content.some(isImagePart)) return m;
    touched = true;
    const text = m.content.filter((c) => c?.type === 'text').map((c) => c.text).join('\n');
    return { ...m, content: text || '[图片]' };
  });
  return touched ? out : messages;
}

/**
 * 模型不支持图片时，把 image_url 段剥掉只留文字。
 *
 * 这一步很关键：开了识图之后，主模型（如 GLM-4.6V）能看图，
 * 但一旦被限流降级到 GLM-4-Flash 这类纯文本模型，
 * 带着图片的请求会直接被拒（实测报 `messages.content.type 参数非法`），
 * 整条消息就丢了 —— 剥掉至少还能正常聊。
 *
 * 判据来自 model-caps.js，那里是全项目唯一的能力来源。
 */
function stripImagesIfUnsupported(messages, provider, model, declared) {
  // `declared` 同样要传下去 —— 不传的话自定义大脑勾的"能看图"在这里失效。
  if (capabilitiesOf(provider, model, declared).features.vision) return messages; // 看得见就原样发
  return stripImageParts(messages);
}


function isNetwork(err) {
  return !isAbort(err) && /fetch failed|ECONNREFUSED|ENOTFOUND|socket hang up|other side closed/i.test(err?.message ?? '');
}

/** 服务端"现在忙不过来"：限流或自身故障。这类错误换一个模型通常是有效的 */
function isOverloaded(err) {
  return err?.status === 429 || err?.status >= 500 || isNetwork(err);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
