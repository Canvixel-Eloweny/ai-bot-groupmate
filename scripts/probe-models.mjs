/**
 * 智谱模型能力实测探测器。
 *
 * 为什么必须实测而不是查文档：控制台要在「切到某个模型」时决定思考开关、
 * 强度按钮、联网/识图三个开关能不能点。文档只写官方口径，而
 *   · 文档的模型页更新滞后于接口；
 *   · **同一个参数对某些模型是被静默忽略的**，文档不会说。
 *
 * 本脚本第一版踩过的两个坑（都很值钱，留在这里防复发）：
 *   ① 用「只回两个字：收到」这种题去测思考 → 所有模型 reasoning_tokens 都是 0，
 *      分不清「不支持思考」和「这题不值得思考」。改成鸡兔同笼这种必须动脑的题。
 *   ② 用 HTTP 200 判断「联网可用」→ 假阳性。实测 glm-4.6v 收下 tools 参数、
 *      返回 200、答案看着也像回事，但 **prompt_tokens 纹丝不动（25 → 25）**，
 *      说明搜索结果根本没被注入 —— 也就是"开关打开了，什么都没发生"。
 *      真正的判据是 **带工具后 prompt_tokens 是否暴涨**。
 *
 * 用法：
 *   node scripts/probe-models.mjs                 # 全部模型
 *   node scripts/probe-models.mjs glm-4.5-air …   # 只测指定模型
 *   node scripts/probe-models.mjs --out x.json    # 结果另存
 *
 * 产出：scripts/probe-result.json。控制台的 model-capabilities 表照它填。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// 候选清单与 `probe-functions.mjs` 共用一份（第 13 轮 H-11：这里曾各自抄一遍 19 个模型串）。
import { ZHIPU_CHAT_CANDIDATES, ZHIPU_NON_CHAT_CANDIDATES } from './lib/probe-common.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = 'https://open.bigmodel.cn/api/paas/v4';
const TIMEOUT = 90000;

/**
 * 测哪些模型 = **对话模型**（两份探针共用，住在 `lib/probe-common.mjs`）+ 本次多测的 OCR。
 * ⚠️ 清单只有一份：加 / 删模型改 `lib/probe-common.mjs`，别在这里再抄一遍。
 */
const CANDIDATES = [...ZHIPU_CHAT_CANDIDATES, ...ZHIPU_NON_CHAT_CANDIDATES];

/** 1×1 透明 PNG，用来测"能不能收图"。不在视觉模型上会被挡回来 */
const TINY_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** 必须动脑才做得对的题：思考一旦生效，输出里就藏不住 */
const REASON_PROMPT = '一个笼子里有若干只鸡和兔，共有 35 个头、94 只脚。鸡有几只？只回一个数字。';
const PLAIN_PROMPT = '只回两个字：收到';
/** 需要实时信息的提问：用来判断联网是不是**真的把结果塞进了上下文** */
const SEARCH_PROMPT = '2026年9月有什么重要的科技新闻？用一句话说，必须带具体日期。';

function readKey() {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
  return cfg?.llm?.keys?.zhipu || cfg?.llm?.apiKey || '';
}

const KEY = readKey();
if (!KEY) {
  console.error('config.json 里没有智谱 API Key，没法探测');
  process.exit(2);
}

/**
 * 发一次请求，只回事实，不抛异常。
 *
 * 三个关键证据都留着，因为单项都可能骗人：
 *   think   —— message.reasoning_content 非空。**比 reasoning_tokens 可靠**：
 *              实测 glm-4.5-air 会思考、耗时 2.3 秒，但 reasoning_tokens 报 0。
 *   reasoning / completion —— 档位之间是否真有差别
 *   prompt  —— 带联网工具后暴涨才说明搜索结果被注入了
 *
 * ⚠️ 限流必须重试，否则会得到**假阴性**：实测 glm-4.7 的联网探测第一次就被
 *    1302「账户已达到速率限制」挡回来了。把限流当成"这个模型不支持联网"，
 *    面板上就会写一条错误的结论 —— 比不测更糟。所以这里对 1302/429 退避重试。
 */
async function ask(model, extra, prompt = PLAIN_PROMPT, maxTokens = 32, messages) {
  const body = {
    model,
    messages: messages || [{ role: 'user', content: prompt }],
    max_tokens: maxTokens,
    stream: false,
    ...extra,
  };

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TIMEOUT);
    const t0 = Date.now();
    try {
      const r = await fetch(`${BASE}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
        body: JSON.stringify(body),
        signal: ac.signal,
      });
      const ms = Date.now() - t0;
      const text = await r.text();
      let j = null;
      try { j = JSON.parse(text); } catch { /* 非 JSON 就是服务端异常页 */ }
      if (!r.ok) {
        // 智谱的错误码在 error.code / code 里，文案在 error.message / msg 里。
        // 这句文案很有用 —— 它会被原样搬进面板当「为什么点不了」的解释。
        const code = j?.error?.code ?? j?.code ?? r.status;
        const msg = j?.error?.message ?? j?.msg ?? text.slice(0, 200);
        if (isRateLimited(code, r.status) && attempt < 3) {
          await sleep(3000 * (attempt + 1)); // 3s / 6s / 9s 退避
          continue;
        }
        return { ok: false, http: r.status, code, msg, ms, rateLimited: isRateLimited(code, r.status) };
      }
      const u = j?.usage || {};
      const msgObj = j?.choices?.[0]?.message || {};
      const rc = String(msgObj.reasoning_content ?? '');
      return {
        ok: true,
        ms,
        think: rc.length > 0,
        reasoning: u.completion_tokens_details?.reasoning_tokens ?? 0,
        completion: u.completion_tokens ?? 0,
        prompt: u.prompt_tokens ?? 0,
        // 有些响应会把联网结果挂在 finish_reason / 额外字段上，
        // 但**唯一可靠的判据是 prompt_tokens 涨没涨**（见上）
        hits: Array.isArray(j?.choices?.[0]?.web_search) ? j.choices[0].web_search.length : 0,
        out: String(msgObj.content ?? '').replace(/\s+/g, ' ').slice(0, 60),
      };
    } catch (e) {
      if (attempt < 3) { await sleep(2000); continue; }
      return { ok: false, http: 0, code: 'net', msg: e.name === 'AbortError' ? '超时' : String(e.message).slice(0, 120), ms: Date.now() - t0 };
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: false, http: 0, code: 'retry-exhausted', msg: '重试 4 次都被限流' };
}

function isRateLimited(code, http) {
  return http === 429 || String(code) === '1302' || String(code) === '1301';
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 把一次 ask 的结果压成一行可比的摘要 */
const slim = (a) => (a.ok
  ? { ok: 1, think: a.think ? 1 : 0, rt: a.reasoning, ct: a.completion, pt: a.prompt, ms: a.ms }
  : { ok: 0, code: a.code, msg: a.msg });

/**
 * 一个模型的完整能力探针。每个探针只问一件事，结论不靠推断。
 */
async function probe(model) {
  const r = {};

  // ① 默认状态：思不思考？prompt 基线是多少（联网判据要用它做参照）？
  const bare = await ask(model, {}, REASON_PROMPT, 256);
  r.bare = slim(bare);
  if (bare.ok) r.basePrompt = bare.prompt;

  // ② 明确要求关闭思考 —— 「思考能选关闭吗」的唯一判据
  const off = await ask(model, { thinking: { type: 'disabled' } }, REASON_PROMPT, 256);
  r.thinkOff = off.ok ? { ...slim(off), out: off.out } : { code: off.code, msg: off.msg };

  // ③ 官方口径的强度写法：顶层 reasoning_effort。
  //    档位之间 think/rt/ct/ms 若毫无差别，说明这个档位没被真正采纳。
  r.effort = {};
  for (const lv of ['low', 'high', 'max']) {
    r.effort[lv] = slim(await ask(model, { thinking: { type: 'enabled' }, reasoning_effort: lv }, REASON_PROMPT, 256));
  }

  // ④ 本项目旧代码的写法：thinking.level 别名。
  //    和 ③ 对照 —— 若 low 与 max 的结果没差别，说明别名被静默忽略，
  //    也就是"用户在面板上选强度其实什么都没发生"。
  r.levelAlias = {
    low: slim(await ask(model, { thinking: { type: 'enabled', level: 'low' } }, REASON_PROMPT, 256)),
    max: slim(await ask(model, { thinking: { type: 'enabled', level: 'max' } }, REASON_PROMPT, 256)),
  };

  // ⑤ 联网：先测不带工具的 prompt 基线，再看带工具后涨没涨（涨 = 真搜了）
  const webBase = await ask(model, {}, SEARCH_PROMPT, 220);
  const web = await ask(model, { tools: [{ type: 'web_search', web_search: { enable: true } }] }, SEARCH_PROMPT, 220);
  r.webSearch = web.ok
    ? {
        ...slim(web),
        basePt: webBase.ok ? webBase.prompt : null,
        // 判据：带工具后 prompt 至少翻 3 倍才算搜索结果真的进了上下文
        effective: webBase.ok ? web.prompt > Math.max(60, webBase.prompt * 3) : null,
        out: web.out,
      }
    : { code: web.code, msg: web.msg };

  // ⑥ 收不收图。用 1×1 png，只看接口认不认这种 content 结构
  const vis = await ask(model, {}, '', 32, [{
    role: 'user',
    content: [
      { type: 'text', text: '这张图是什么颜色？只回两个字' },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${TINY_PNG}` } },
    ],
  }]);
  r.vision = vis.ok ? slim(vis) : { code: vis.code, msg: vis.msg };

  return r;
}

// ── 主流程：**串行**。并发会把账号打到限流（实测并发 2 就撞上 1302），
//    而限流会被误判成"这个模型不支持某能力"—— 假阴性比不测更危险，所以宁可慢 ──
const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const outPath = outIdx >= 0 ? args[outIdx + 1] : path.join(ROOT, 'scripts', 'probe-result.json');
const models = args.filter((a, i) => !a.startsWith('--') && i !== outIdx + 1);
const list = models.length ? models : CANDIDATES;

const result = {};
const CONC = 1;
let cursor = 0;

async function worker() {
  while (cursor < list.length) {
    const m = list[cursor++];
    process.stderr.write(`探测 ${m} … `);
    const t0 = Date.now();
    try {
      result[m] = await probe(m);
      process.stderr.write(`完成（${((Date.now() - t0) / 1000).toFixed(1)}s）\n`);
    } catch (e) {
      result[m] = { fatal: String(e.message) };
      process.stderr.write(`异常：${e.message}\n`);
    }
    // 每完成一个就落盘：中途被打断也不至于全丢
    fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
  }
}

await Promise.all(Array.from({ length: CONC }, worker));
fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
console.log(`\n已写入 ${outPath}`);
