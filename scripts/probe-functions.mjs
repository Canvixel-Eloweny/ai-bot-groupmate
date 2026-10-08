/**
 * ══════════════════════════════════════════════════════════════════════
 *  function calling 能力实测探测器（第 46 轮 B12e-1）
 * ══════════════════════════════════════════════════════════════════════
 *
 *  为什么必须实测、而不是查文档：`src/model-caps.js` 的规矩是
 *  **本表里的每一项都是实测出来的**。已有的先例很值钱 ——
 *  实测发现 glm-4.6v「收下 tools 参数、返回 200、答案看着也像回事」，
 *  但搜索结果根本没进上下文（prompt_tokens 25 → 25）。
 *  所以"HTTP 200"完全不能证明 function calling 能用。
 *
 *  ────────────────────────────────────────────────────────────────────
 *  判据（三道，从强到弱）
 *  ────────────────────────────────────────────────────────────────────
 *  A「自动」：给一个**必须调工具才能答对**的问题，`tool_choice` 不设（=auto）。
 *             返回 `tool_calls` → **支持**（最强证据：它自己决定要调）。
 *  B「强制」：`tool_choice` 指定那个函数。返回 `tool_calls` → **支持**
 *             （服务端认这个参数、且愿意回 tool_calls 结构）。
 *  C 都不是：把响应正文/状态码原样记下来。
 *             · 400 且正文点名 tools/function → **不支持**（确定的否定）
 *             · 200 但没有 tool_calls、两次都没 → **未能判定**（不写 false，
 *               也不写 true —— 本项目纪律是"不知道"就照实写"不知道"）
 *
 *  ⚠️ 为什么要有 A 和 B 两道：只做 A 会得到**假阴性**（模型可能只是不想调工具，
 *     而不是不支持）。只做 B 会得到**假阳性**（服务端认参数 ≠ 模型真会用）。
 *     两道都过才算硬证据；A 过 B 不过也判支持（A 更严格）。
 *
 *  ⚠️ **它一个字节都不写留档**：直接 fetch，不走 LlmClient，
 *     也就不会碰 `src/usage.js` 的 recordUsage、不会碰 trace / prompt-stats。
 *
 *  用法：
 *      node scripts/probe-functions.mjs                 # 全部候补
 *      node scripts/probe-functions.mjs glm-4.5-air …   # 只测指定模型
 *      node scripts/probe-functions.mjs --out x.json    # 结果另存
 *
 *  产出：scripts/functions-probe-result.json —— `src/model-caps.js` 的
 *        `functions` 位照它填。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// 候选清单与 `probe-models.mjs` 共用一份（第 13 轮 H-11：这里曾各自抄一遍同样的 19 个模型串）。
// `glm-ocr` 不是对话模型，所以只取 `ZHIPU_CHAT_CANDIDATES`（`probe-models` 才补测它）。
import { ZHIPU_CHAT_CANDIDATES, DEEPSEEK_CANDIDATES } from './lib/probe-common.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TIMEOUT = 90000;

/**
 * 测试用的工具。
 * 刻意做成"模型**不可能**自己知道答案"——否则它会直接编一个回答，
 * 我们就把"它懒得调工具"误读成"它不支持"。
 */
const TEST_TOOL = {
  type: 'function',
  function: {
    name: 'get_current_time',
    description: '查某个城市当前的准确时间。这个信息只能通过本工具获得。',
    parameters: {
      type: 'object',
      properties: { city: { type: 'string', description: '城市名，例如「西安」' } },
      required: ['city'],
    },
  },
};

/** 逼它必须调工具：明确说"你不知道、必须查、不许猜" */
const FORCE_PROMPT =
  '现在几点了？你不知道当前时间，**必须调用 get_current_time 工具**去查，'
  + '不允许猜、不允许说"我无法回答"。城市按西安算。';

function readCfg() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
}

/** 一次请求。返回事实，**不抛** —— 探测脚本里异常会打断整轮。 */
async function ask(baseUrl, key, model, extra) {
  const body = {
    model,
    messages: [{ role: 'user', content: FORCE_PROMPT }],
    max_tokens: 256,
    stream: false,
    ...extra,
  };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT);
  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    const text = await res.text().catch(() => '');
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      /* 非 JSON 的响应体也要能记下来 */
    }
    const msg = data?.choices?.[0]?.message ?? null;
    const calls = Array.isArray(msg?.tool_calls) ? msg.tool_calls : [];
    return {
      status: res.status,
      // 只留证据，不留整包（响应可能很大）
      calls: calls.length,
      callNames: calls.map((c) => c?.function?.name).filter(Boolean),
      content: String(msg?.content ?? '').slice(0, 120),
      promptTokens: Number(data?.usage?.prompt_tokens) || 0,
      error: res.ok ? '' : text.slice(0, 300),
      timeout: false,
    };
  } catch (err) {
    return {
      status: 0, calls: 0, callNames: [], content: '', promptTokens: 0,
      error: String(err?.message ?? err), timeout: /abort/i.test(String(err?.name ?? err?.message ?? '')),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** 限流退避重试：把 429 当成"不支持"会写出错误的能力表，比不测更糟（probe-models 的同款教训） */
async function askWithRetry(baseUrl, key, model, extra, tries = 3) {
  let last = null;
  for (let i = 0; i < tries; i += 1) {
    last = await ask(baseUrl, key, model, extra);
    const limited = last.status === 429 || /1302|速率限制|rate.?limit/i.test(last.error);
    if (!limited) return last;
    await new Promise((r) => setTimeout(r, 2500 * (i + 1)));
  }
  return last;
}

/** 判据落成一个字段：'yes' | 'no' | 'unknown' */
function verdictOf(a, b) {
  if (a.calls > 0) return 'yes';
  if (b.calls > 0) return 'yes';
  const rejected = (r) => r.status === 400 || /tool|function/i.test(r.error);
  if (rejected(a) || rejected(b)) return 'no';
  return 'unknown';
}

async function probeOne(baseUrl, key, model) {
  // A：不设 tool_choice（=auto），这是**生产将要用的那条路**
  const a = await askWithRetry(baseUrl, key, model, { tools: [TEST_TOOL] });
  await new Promise((r) => setTimeout(r, 400));
  // B：强制指定那个函数 —— 区分"模型不想调"与"服务端不认"
  const b = await askWithRetry(baseUrl, key, model, {
    tools: [TEST_TOOL],
    tool_choice: { type: 'function', function: { name: TEST_TOOL.function.name } },
  });
  return { model, verdict: verdictOf(a, b), auto: a, forced: b };
}

async function main() {
  const argv = process.argv.slice(2);
  const outIdx = argv.indexOf('--out');
  const only = argv.filter((x) => !x.startsWith('--') && argv[argv.indexOf(x) - 1] !== '--out');
  const cfg = readCfg();
  const zhipuKey = cfg?.llm?.keys?.zhipu || '';
  const deepseekKey = cfg?.llm?.keys?.deepseek || '';

  const zhipuBase = cfg?.llm?.presets?.zhipu?.baseUrl || cfg?.llm?.cloudBaseUrl
    || cfg?.llm?.baseUrl || 'https://open.bigmodel.cn/api/paas/v4/';
  const deepseekBase = cfg?.llm?.presets?.deepseek?.baseUrl || 'https://api.deepseek.com/v1';
  const jobs = [];
  const zp = only.length ? only : ZHIPU_CHAT_CANDIDATES;
  for (const m of zp) {
    if (!zhipuKey) break;
    jobs.push({ provider: 'zhipu', baseUrl: zhipuBase, key: zhipuKey, model: m });
  }
  if (!only.length && deepseekKey) {
    for (const m of DEEPSEEK_CANDIDATES) {
      jobs.push({ provider: 'deepseek', baseUrl: deepseekBase, key: deepseekKey, model: m });
    }
  }

  if (!jobs.length) {
    console.error('config.json 里没有可用的 API Key（llm.keys.zhipu / llm.keys.deepseek），没法探测');
    process.exit(2);
  }

  console.log(`function calling 实测：${jobs.length} 个模型 × 2 次请求（真实计费，量很小）\n`);
  const results = [];
  for (const j of jobs) {
    process.stdout.write(`  ${j.provider}/${j.model} … `);
    const r = await probeOne(j.baseUrl, j.key, j.model);
    results.push({ provider: j.provider, ...r });
    const mark = r.verdict === 'yes' ? '✓ 支持' : r.verdict === 'no' ? '✗ 不支持' : '? 未能判定';
    console.log(`${mark}（auto: status=${r.auto.status} calls=${r.auto.calls}；forced: status=${r.forced.status} calls=${r.forced.calls}）`);
    if (r.verdict === 'unknown' && r.auto.error) console.log(`      auto 正文：${r.auto.error.slice(0, 160)}`);
    await new Promise((res) => setTimeout(res, 500));
  }

  const out = outIdx >= 0 ? String(argv[outIdx + 1]) : path.join(ROOT, 'scripts', 'functions-probe-result.json');
  fs.writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), results }, null, 2) + '\n');

  const yes = results.filter((r) => r.verdict === 'yes').map((r) => r.model);
  const no = results.filter((r) => r.verdict === 'no').map((r) => r.model);
  const unk = results.filter((r) => r.verdict === 'unknown').map((r) => r.model);
  console.log(`\n─────────────────────────────────────────`);
  console.log(`支持（${yes.length}）：${yes.join(', ') || '—'}`);
  console.log(`不支持（${no.length}）：${no.join(', ') || '—'}`);
  console.log(`未能判定（${unk.length}）：${unk.join(', ') || '—'}`);
  console.log(`\n结果已写入 ${out}`);
  console.log('→ `src/model-caps.js` 的 `functions` 位**只对「支持」的那些填 true**；');
  console.log('  「未能判定」保持 false（不猜）—— 填错的后果是降级时整条请求 400。');
}

main().catch((e) => {
  console.error(`探测失败：${e?.message ?? e}`);
  process.exit(1);
});
