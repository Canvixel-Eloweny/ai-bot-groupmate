/**
 * ══════════════════════════════════════════════════════════════════════
 *  角色卡「AI 认领」的一次调用（面板按钮 → 子进程 → 这里）
 * ══════════════════════════════════════════════════════════════════════
 *  为什么是子进程而不是面板进程里直接调模型：
 *    面板是**只读为主**的进程，`server.js` 的契约里没有"面板自己发模型请求"
 *    这条路径（凭据、账单、失败重试都在机器人那边）。这一发走独立脚本，
 *    跟 `scripts/dryrun.js` 同形：面板把字喂进来，脚本吐一行 JSON，面板只负责渲染。
 *
 *  用法（面板自动调用，也可以手动）：
 *      echo '{"name":"阿蓝","text":"……","fields":{}}' | node scripts/adopt-card.mjs
 *
 *  stdin：`{name, text, fields}`（text = 卡里全部文字；fields = 卡已有字段）
 *  stdout：一行 JSON `{ok, ms, usage, fields, wrote, filled, missing, raw}`
 *          失败 `{ok:false, error}`（退出码 1）
 *
 *  ⚠️ 记账走 `recordUsage(usage)`（与 dryrun 同口径、不打 source），所以面板
 *     触发的这一发会如实进「用量」账本，不会变成看不见的花费。
 */
import { loadConfig } from '../src/config.js';
import { LlmClient } from '../src/llm.js';
import { recordUsage } from '../src/usage.js';
import { adoptMessages, parseAdopt, adoptFields, ADOPT_MAX_INPUT } from '../src/persona-adopt.js';

function out(obj, code = 0) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
  process.exit(code);
}

const chunks = [];
for await (const c of process.stdin) chunks.push(c);
let inp = {};
try {
  inp = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
} catch {
  out({ ok: false, error: '输入不是合法 JSON' }, 1);
}
const name = String(inp.name ?? '').trim().slice(0, 40);
const text = String(inp.text ?? '').slice(0, ADOPT_MAX_INPUT);
const fields = inp.fields && typeof inp.fields === 'object' && !Array.isArray(inp.fields) ? inp.fields : {};
if (text.trim().length < 20) {
  out({ ok: false, error: '这张卡里没有可认领的文字（至少 20 字）' }, 1);
}

let cfg;
try {
  cfg = loadConfig(process.env.QQBOT_CONFIG);
} catch (e) {
  // 配置有问题时别让面板看到一个栈：吐一行能读的错，用户才知道去改哪里。
  out({ ok: false, error: `读配置失败：${String(e?.message || e).split('\n')[0]}` }, 1);
}
const llm = new LlmClient(cfg.llm);
const t0 = Date.now();
let raw = '';
let usage = null;
try {
  const r = await llm.chatWithUsage(adoptMessages({ name, text }), {
    temperature: 0.2,
    maxTokens: 1500,
    thinking: { mode: 'off' },
  });
  raw = r.text ?? '';
  usage = r.usage || null;
  recordUsage(usage);
} catch (e) {
  out({ ok: false, error: `模型调用失败：${e?.message || e}` }, 1);
}

const parsed = parseAdopt(raw);
const mapped = adoptFields(parsed.byDim, { name, fields });
if (!mapped.wrote.length) {
  out({ ok: false, error: '模型这一趟没认领出任何一维 —— 卡里的文字可能太杂，先手动填几维', raw: String(raw).slice(0, 1500) }, 1);
}
out({
  ok: true,
  ms: Date.now() - t0,
  usage,
  fields: mapped.fields,
  wrote: mapped.wrote,
  filled: parsed.filled,
  missing: parsed.missing,
  raw: String(raw).slice(0, 1500),
});
