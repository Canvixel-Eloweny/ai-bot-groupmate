/**
 * ══════════════════════════════════════════════════════════════════════
 *  工具回合循环 —— "模型要调工具 → 我们执行 → 回灌 → 再问"
 *  第 46 轮 B12e-1（执行层 · 硬前置）
 * ══════════════════════════════════════════════════════════════════════
 *
 *  ────────────────────────────────────────────────────────────────────
 *  ⚠️ 为什么是**新模块**，而不是计划里写的"加进 `src/brain.js`"
 *  ────────────────────────────────────────────────────────────────────
 *  附 Q.3 原写「`src/brain.js` 主循环加'工具回合'（+120 行）」。
 *  开工前核了一遍代码：**`brain.js` 里没有 LLM 主循环** ——
 *  `llm.chat(...)` 的唯一生产调用点在 `src/index.js`（主回复那一处）。
 *  `brain.js` 只做判定 / 组消息 / 解析回复，它连"发一次请求"这件事都不做。
 *  照规格把循环塞进 brain，等于在 brain 里新开**第二个** LLM 调用点 ——
 *  而"同一件事两处实现"正是本项目反复在清的那类歧义。
 *  → 偏差已记录（报告「偏差」一节）：改成新模块 + 在 `src/index.js` 那**一个**
 *    调用点接线。净行数与规格接近，接线点仍然只有一处。
 *
 *  ────────────────────────────────────────────────────────────────────
 *  ⚠️ 三条硬约束
 *  ────────────────────────────────────────────────────────────────────
 *  ① **零注册工具 → 与改造前逐字相同**。`run()` 拿到的 `tools` 为空数组时，
 *     请求体里不会出现 `tools` 字段，且**只发一次请求**（不是"发一次空循环"）。
 *     有断言钉着（T100）。
 *
 *  ② **工具自己抛错不许炸掉这一轮回复**。工具结果（含"未知工具""参数不是 JSON"）
 *     一律**回灌给模型**让它自己处理，绝不向上抛 —— 抛上去的表现是
 *     "机器人这条消息彻底不回"，而用户只看到它突然不理人。
 *
 *  ③ **回合必须有上限**。每多一轮 = 多一次 LLM 请求 = 群里等回复的体感变差
 *     （附 Q.5 风险 2）。到顶之后**必须**保证有话说：拿不到文本就再问一次
 *     （这次不带 tools）。宁可多花一次请求，也不许它哑掉 —— 这是本项目
 *     最怕的失败模式（"它突然不理我"）。
 */

// D6（会话级中止）：本模块只从判据叶子取**那一个**构造器 —— 中止的"标记"必须
// 只有一处实现（`session-control.js` 的 `abortError()`），否则上层要按文案判断"是不是中止"，
// 而文案会在某次改措辞时静默失效。
import { abortError } from './session-control.js';

/**
 * 一次回复最多执行几轮工具。
 * **经验值，非官方阈值**：1~2 轮覆盖"查一下再说"这类真实场景；
 * 再高就变成"模型自己在群里自言自语刷工具"。附 Q.5 建议 1~2。
 */
export const TOOL_ROUND_MAX = 2;

/** 单条工具参数的字符上限（模型偶尔会吐出一大坨，先截断再解析，避免 JSON.parse 被拖死） */
const TOOL_ARG_MAX = 8000;

/**
 * 单条工具结果回灌给模型时的字符上限。
 * 工具输出（网页正文、列表）可能极大，一条就能把上下文顶爆，
 * 而"顶爆"的表现是模型开始胡言乱语，不是报错。
 */
export const TOOL_RESULT_MAX = 4000;

/** 回灌时给模型的一句提示，避免它把截断当成"内容就这么点" */
const TRUNCATED_HINT = '\n…（内容过长已截断）';

/**
 * 从一次响应里取出 `tool_calls`。**纯函数**，只认 OpenAI 兼容的形状。
 *
 * 为什么单独成函数：它是"模型到底要不要调工具"的**唯一判据**，
 * 测试要能直接喂合成响应验证。内联在循环里的话，就只能靠"跑一次真请求"来验。
 *
 * @param {object|null} message 响应里的 `choices[0].message`
 * @returns {{id:string, name:string, argsRaw:string}[]}
 */
export function parseToolCalls(message) {
  const raw = message?.tool_calls;
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const c of raw) {
    if (!c || typeof c !== 'object') continue;
    const fn = c.function && typeof c.function === 'object' ? c.function : {};
    const name = String(fn.name ?? '').trim();
    // 没名字的调用**丢弃**：拿它去查注册表必然找不到，回灌一条"未知工具"只会
    // 白白多耗一轮，而且会让模型以为工具真的存在。
    if (!name) continue;
    out.push({
      id: String(c.id ?? `call_${out.length}`),
      name,
      // 有的实现回的是对象而不是字符串。统一成**字符串**再回灌，
      // 否则 JSON.stringify 那一步会把它变成 `"[object Object]"`。
      argsRaw: typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments ?? {}),
    });
  }
  return out;
}

/**
 * 解析工具参数。
 * 解析失败**不抛**：回灌一条错误文本让模型自己改 —— 这是模型偶发的格式问题，
 * 不是程序缺陷，把它升级成异常就等于"一次格式抖动让机器人整条不回"。
 */
export function parseToolArgs(argsRaw) {
  const s = String(argsRaw ?? '').trim();
  if (!s) return { ok: true, value: {} };
  if (s.length > TOOL_ARG_MAX) return { ok: false, reason: `参数过长（${s.length} 字符，上限 ${TOOL_ARG_MAX}）` };
  try {
    const v = JSON.parse(s);
    // 顶层必须是对象：数组/标量没法当具名参数用，而 OpenAI 的约定也是对象。
    if (!v || typeof v !== 'object' || Array.isArray(v)) return { ok: false, reason: '参数不是 JSON 对象' };
    return { ok: true, value: v };
  } catch (err) {
    return { ok: false, reason: `参数不是合法 JSON：${err?.message ?? err}` };
  }
}

/**
 * 把工具返回值（任意类型）压成回灌用的字符串。
 *
 * 生态约定（参考实现 src/tools.js executeTool）：工具返回 `{ content, isError? }`，
 * content 是 string 或 parts 数组。**只把 content 回灌** —— 把 {content} 整个
 * JSON 化会让模型看到 `{"content":"..."}` 这种壳，回灌就废了。
 * 没有 content 字段的旧形状（裸字符串 / 裸对象）保持原样兼容。
 */
export function formatToolResult(value) {
  let v = value;
  if (v && typeof v === 'object' && !Array.isArray(v) && 'content' in v) v = v.content;
  let s;
  if (typeof v === 'string') s = v;
  else if (v === undefined || v === null) s = '';
  else {
    try {
      s = JSON.stringify(v);
    } catch {
      // 循环引用之类：**不许抛**，退化成 String()
      s = String(v);
    }
  }
  s = String(s ?? '');
  return s.length > TOOL_RESULT_MAX ? s.slice(0, TOOL_RESULT_MAX) + TRUNCATED_HINT : s;
}

/**
 * 记账聚合。
 *
 * ⚠️ 为什么必须聚合、且必须由本模块提供：工具回合会让**一次回复对应多次 HTTP**。
 * 主链路原先只记 `llm.lastUsage`（= 最后一次）。不改的话，第二、三轮的 token
 * **一笔都进不了账本** —— 账目虚低，而"账上一条、实际三次"这种事
 * 本项目已经在 `attempts` 字段上踩过一次，不能再开第二个同类口子。
 *
 * ⚠️ **只有一次请求时原样返回同一个对象**（不是拷贝）：这是"零注册工具时
 * 与改造前逐字相同"的实现基础 —— 拷贝会引入字段顺序/形状漂移的风险，而收益为零。
 *
 * @param {(object|null)[]} list
 * @returns {object|null}
 */
export function aggregateUsage(list) {
  const items = (Array.isArray(list) ? list : []).filter(Boolean);
  if (!items.length) return null;
  if (items.length === 1) return items[0];
  const sum = (k) => items.reduce((s, x) => s + (Number(x[k]) || 0), 0);
  const last = items[items.length - 1];
  return {
    ...last,
    prompt: sum('prompt'),
    completion: sum('completion'),
    reasoning: sum('reasoning'),
    cached: sum('cached'),
    attempts: sum('attempts'),
  };
}

/**
 * 把「模型的这一轮 assistant 消息」整理成可回灌的形状。
 *
 * ⚠️ 必须**只挑需要的字段重建**，不要把服务端原始 message 直接塞回去：
 * 它常带 `reasoning_content` / 私有字段，回灌时可能被某家服务端拒绝
 * （整条 400，表现为"用了工具之后机器人就不说话了"）。
 */
function assistantEcho(message, calls) {
  return {
    role: 'assistant',
    content: typeof message?.content === 'string' ? message.content : '',
    tool_calls: calls.map((c) => ({
      id: c.id,
      type: 'function',
      function: { name: c.name, arguments: c.argsRaw },
    })),
  };
}

/** 工具结果消息（OpenAI 兼容形状：`role:'tool'` + `tool_call_id`） */
function toolResultMessage(callId, content) {
  return { role: 'tool', tool_call_id: String(callId ?? ''), content: String(content ?? '') };
}

/**
 * 建一个工具回合执行器。
 *
 * @param {{client:{chatWithUsage:Function}, registry:{specs:Function,executorOf:Function,size:Function},
 *          log?:{info?:Function,warn?:Function}, maxRounds?:number,
 *          onRound?:Function, onToolCall?:Function}} deps
 *   `onToolCall` 在**每一次**工具调用结束之后被 await（参考实现 orchestrator.js:1132 的
 *   `after-tool` 同位置）。载荷 `{name, argsRaw, result, isError, ctx}`；
 *   其中 `ctx` 是**原样回传**的 `meta.ctx`（对本模块是不透明对象）——
 *   会话上下文的展开、钩子点名字都由接线层（`src/index.js`）决定，
 *   本模块零依赖、不认识 hookBus。
 */
export function createToolLoop({ client, registry, log, maxRounds = TOOL_ROUND_MAX, onRound, onToolCall } = {}) {
  if (!client || typeof client.chatWithUsage !== 'function') {
    throw new Error('createToolLoop 需要 client.chatWithUsage');
  }
  if (!registry || typeof registry.specs !== 'function') {
    throw new Error('createToolLoop 需要 registry');
  }

  const warn = (m) => log?.warn?.(m);

  /**
   * 执行一次工具调用。**永不抛** —— 所有失败都变成回灌给模型的文本。
   *
   * ⚠️ **必须是 async，且必须 await 工具自己的返回值。**
   *    生态约定 `execute(ctx, args)` **普遍是 async**（13 个真实包里每一个都写了
   *    `async execute`）。旧写法 `const r = execute(...)` 拿到的是 **Promise 对象**，
   *    `formatToolResult` 会把它 JSON 化成 `{}` 回灌给模型 ——
   *    表现是"工具明明调用了、日志里也有，模型却只收到一个空对象"，
   *    **不报错、不为 isError**，属本项目第 12 条那类"失败伪装成成功"。
   *    （第 47 轮 B12e-3 修；当时 `execute` 迁移刚做完，异步工具一次都还没真跑过。）
   *
   * @param {string} name 工具名（function name）
   * @param {string|object} argsRaw 模型给的实参（JSON 字符串或对象）
   * @param {object} ctx 宿主注入的会话上下文（第 47 轮 B12e-3 起随调用传入；
   *        形状见 src/index.js 的 toolCtx —— 生态约定 execute(ctx, args)）
   * @returns {Promise<{content:string, isError:boolean, raw:unknown}>}
   *         `content`/`isError` 是回灌用的；`raw` 是工具原样返回的对象
   *         （`after-tool` 钩子需要它 —— 参考实现传的就是这个 `result`）。
   */
  async function invoke(name, argsRaw, ctx = {}) {
    const fail = (content) => ({ content, isError: true, raw: null });
    const execute = registry.executorOf(name);
    if (typeof execute !== 'function') {
      // 模型幻觉出一个不存在的工具是常见现象，报给它是**正常路径**，不是异常。
      return fail(`工具「${name}」不存在。`);
    }
    const parsed = parseToolArgs(argsRaw);
    if (!parsed.ok) return fail(`工具「${name}」的参数有问题：${parsed.reason}`);
    try {
      const raw = await execute(ctx, parsed.value);
      const formatted = formatToolResult(raw);
      // 工具自己声明 isError（生态约定 {content, isError}）→ 如实透传；
      // 没声明的旧形状 → 不算失败。
      return { content: formatted, isError: Boolean(raw && typeof raw === 'object' && raw.isError), raw };
    } catch (err) {
      const msg = String(err?.message ?? err);
      warn(`工具「${name}」执行失败：${msg}`);
      return fail(`工具「${name}」执行失败：${msg}`);
    }
  }

  return {
    /**
     * 跑完一次回复（可能包含 0~maxRounds 轮工具）。
     *
     * @param {{messages:object[], meta?:object}} req
     *   `meta.ctx` 是宿主注入的会话上下文（execute(ctx, args) 的第一个参数）；
     *   缺省时给空对象 —— 不带上下的调用**仍然存在**（宿主自己的内部工具），
     *   只是扩展包那种依赖 ctx.chatKey 的工具会拿不到会话信息。
     * @returns {Promise<{text:string, usage:object|null, rounds:number, calls:number,
     *                    toolResults:Array<{name:string,isError:boolean}>}>}
     */
    async run({ messages, meta, signal, shrink } = {}) {
      // ★ 唯一取 tools 的地方。空注册表 → 空数组 → 下游不会往 body 里放 tools。
      const tools = registry.specs();
      const usages = [];
      const toolResults = [];
      const ctx = meta?.ctx ?? {};
      let msgs = Array.isArray(messages) ? messages : [];
      let rounds = 0;
      let calls = 0;
      let out = null;

      // D8：`shrink` 是**透传**的，不是本地实现 —— 原文照交给 llm 的重试链。
      // 这里不判它是不是函数：llm 自己会判（少了它只是"超长时不能自愈"，
      // 不该让整条工具回合挂掉）。

      for (;;) {
        // D6：每轮开头先看中止标记。三个检查点缺一不可 ——
        //   ① 轮次开头（这里）：上一轮结束时用户点了中止，不该再打一次模型；
        //   ② 拿到工具调用之后（见下）：中止后**绝不执行工具**（工具带副作用：发消息、写档）；
        //   ③ llm 层（`#post`）：掐断在途 HTTP。
        // 只做 ③ 的话，中止只能"下一次请求不发"，而正在排队执行的那批工具照跑 ——
        // 表现是"点了停止，它还是把话说出去了"。
        if (signal?.aborted) throw abortError();
        out = await client.chatWithUsage(msgs, { tools, signal, shrink });
        usages.push(out?.usage ?? null);

        const pending = parseToolCalls(out?.assistant);
        if (!pending.length) break;
        if (signal?.aborted) throw abortError();

        if (rounds >= maxRounds) {
          warn(`工具回合已达上限 ${maxRounds}，本轮不再执行工具`);
          // ★ 兜底：模型只想调工具、一个字都没说 → 再问一次（这次不带 tools）。
          //   不带 tools 是刻意的：它会让模型没有"再叫一次工具"这个选项，
          //   从而必须给出文本。这是"它不许哑掉"的唯一保证。
          if (!out?.text) {
            out = await client.chatWithUsage(msgs, { tools: [], signal, shrink });
            usages.push(out?.usage ?? null);
          }
          break;
        }

        rounds += 1;
        calls += pending.length;
        const results = [];
        // ⚠️ **顺序**执行，不是 Promise.all：参考实现也是一个 for 循环
        //    （orchestrator.js:1109 起）。工具普遍带副作用（发消息、写档），
        //    并发会让"谁先谁后"变得不可预测 —— 而那正是"看起来只是慢"的一类缺陷。
        // eslint-disable-next-line no-await-in-loop -- 顺序是刻意的，理由见上
        for (const c of pending) {
          const r = await invoke(c.name, c.argsRaw, ctx);
          // 每次调用留一条 {name, isError} —— after-response 钩子（如「本体情绪」）
          // 靠它判"这轮工具是不是失败了"。isError 的来历只有两种：宿主三态失败
          // （不存在 / 参数坏 / 抛错）或工具自己在结果里声明。
          toolResults.push({ name: c.name, isError: r.isError });
          results.push({ c, content: r.content });
          // after-tool：**每一次**调用之后（参考实现 orchestrator.js:1132 同位置）。
          // 钩子总线自己 fail-open；这里再兜一层 —— 钩子绝不许影响工具回合。
          if (typeof onToolCall === 'function') {
            try {
              // eslint-disable-next-line no-await-in-loop -- 同上
              await onToolCall({ name: c.name, argsRaw: c.argsRaw, result: r.raw, isError: r.isError, ctx });
            } catch (e) {
              warn(`after-tool 接线层抛错：${String(e?.message ?? e)}`);
            }
          }
        }
        onRound?.({ round: rounds, calls: pending, results, meta });

        msgs = [...msgs, assistantEcho(out?.assistant, pending)];
        for (const r of results) msgs.push(toolResultMessage(r.c.id, r.content));
      }

      return { text: String(out?.text ?? ''), usage: aggregateUsage(usages), rounds, calls, toolResults };
    },
  };
}
