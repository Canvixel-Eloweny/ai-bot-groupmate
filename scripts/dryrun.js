#!/usr/bin/env node
/**
 * 干跑：不碰 QQ，只走「配置 → 人格 → 模型 → 分段」这条链。
 * 用来在真去群里 @ 之前，确认模型接得上、人格说得像人话、分段正常。
 *
 * 用法：
 *   node scripts/dryrun.js                      # 用内置的一句测试
 *   node scripts/dryrun.js "你们平时几点睡觉"
 *   node scripts/dryrun.js --json "句子"         # 输出 JSON（控制台的「试一句」用）
 *   node scripts/dryrun.js --json -- "句子"      # ⚠️ 以 `-` 开头的句子必须这么传
 *   node scripts/dryrun.js --tools              # 只报告"这次请求会带什么工具"，不调模型、不花钱
 *
 * ⚠️ **`--` 之后一律当正文**（2026-10-05 · 开源前审查 H-04）。原来正文是
 *    "把所有不等于 `--json` / `--tools` 的参数都收下"，于是 `node scripts/dryrun.js "-你好"`
 *    会把 `-你好` 当成一个选项 —— 它**照样进了正文**（宽容），但那是巧合而不是规则：
 *    哪天多认一个开关，用户的那句话就会被吃掉。拆分规则现在只有一份实现，
 *    住在 `scripts/lib/cli-args.mjs`（能被 smoke 直接 import 的零依赖叶子）。
 *
 * --json 会把**完整提示词**也带上：控制台要能把
 * 「群消息 → 发给模型的原文 → 模型原始输出 → 实际会发出去的段」整条链路摆给人看。
 *
 * --tools（第 46 轮 B12e-1）回答的是执行层最容易被误判的那个问题：
 * 「当前这个模型到底认不认 function calling / 现在会带几条工具」。
 * ⚠️ 它**必须读 `toolsForRequest()` 那份判据**，不许自己再拼一遍 ——
 *    拼一遍就会出现"干跑显示的"与"实际发出去的"不一致，而那是最难查的一种谎。
 */
import { splitCliArgs } from './lib/cli-args.mjs';
import { loadConfig } from '../src/config.js';
import { Brain, SessionStore } from '../src/brain.js';
import { LlmClient, toolsForRequest } from '../src/llm.js';
import { capabilitiesOf } from '../src/model-caps.js';
import { createToolRegistry } from '../src/tool-registry.js';
import { TOOL_ROUND_MAX } from '../src/tool-loop.js';
import { recordUsage } from '../src/usage.js';

// 开关与正文的拆分只有一份实现（`scripts/lib/cli-args.mjs`）—— 见该模块的文件头。
// `--` 之后的一律算正文（H-04）；没有它时行为与改造前逐字相同。
const { flags, words } = splitCliArgs(process.argv.slice(2), ['--json', '--tools']);
const asJson = flags.includes('--json');

const cfg = loadConfig();
const store = new SessionStore(cfg);
const brain = new Brain(cfg, store);
const llm = new LlmClient(cfg.llm);

if (flags.includes('--tools')) {
  const caps = capabilitiesOf(cfg.llm.provider, cfg.llm.model);
  // 注册表在这里是**空的**：扩展包执行属于 B12e-2，本批只铺链路。
  // 报 0 条是如实的现状，不是"没实现"——它在等 B12e-2 往里注册。
  const registry = createToolRegistry();
  const tools = toolsForRequest({
    webSearchEnabled: cfg.llm.features?.webSearch,
    caps,
    tools: registry.specs(),
  });
  console.log('─'.repeat(58));
  console.log(`模型            : ${cfg.llm.model}（provider=${cfg.llm.provider}）`);
  console.log(`能力位 functions: ${caps.features.functions}${caps.features.functions ? '' : '（不携带 tools）'}`);
  console.log(`能力位 webSearch: ${caps.features.webSearch}（配置里开=${cfg.llm.features?.webSearch === true}）`);
  console.log(`未知模型        : ${caps.known ? '否' : '是（能力位取保守默认）'}`);
  console.log(`已注册工具      : ${registry.size()} 条${registry.size() ? ` — ${registry.names().join(', ')}` : '（扩展包执行属 B12e-2）'}`);
  console.log(`本次会带 tools  : ${tools.length} 条`);
  console.log(`回合上限        : ${TOOL_ROUND_MAX}`);
  console.log('─'.repeat(58));
  console.log('body.tools 的实际内容：');
  console.log(tools.length ? JSON.stringify(tools, null, 2) : '（空 → 请求体里**不出现** tools 字段）');
  if (!caps.known) console.log(`\n提示：${caps.reasons.functions}`);
  process.exit(0);
}

const text = words.join(' ') || '小鱼在不，随便聊两句呗';

const groupId = String(cfg.allow.groups[0] ?? '0');

// 造几条「群里其他人说过的话」，看机器人会不会接得上话
const ambient = [
  { speaker: '路人乙', text: '今天下班好晚，累死了' },
  { speaker: '老王', text: '我还在公司呢，你算好的' },
];

const evt = {
  message_type: 'group',
  group_id: groupId,
  user_id: '10001',
  sender: { card: '', nickname: '群主' },
};

const session = store.get('group', groupId);
for (const a of ambient) brain.rememberAmbient(session, a.speaker, a.text);

const parsed = { text, mentionedSelf: true, atList: [] };

const decision = brain.decide(session, evt, parsed);

if (asJson) {
  // ── JSON 模式：给控制台的「试一句」用，一次给全链路 ──
  const out = {
    ok: true,
    model: cfg.llm.model,
    baseUrl: cfg.llm.baseUrl,
    provider: cfg.llm.provider,
    isLocal: cfg.llm.isLocal,
    thinking: cfg.llm.thinking,
    maxTokens: cfg.llm.maxTokens,
    persona: cfg.persona.name,
    groupId,
    decision: { respond: decision.respond, reason: decision.reason },
    text,
    prompt: '',
    messageCount: 0,
    ms: 0,
    usage: null,
    raw: '',
    silent: false,
    chunks: [],
    error: '',
    // 这一次真的被塞进提示词的记忆。工作台「测试」要显示它 ——
    // 如实给"注入了什么"，不假装知道"模型参考了哪条"（那不可观测）。
    memoryUsed: brain.memoryInPrompt(),
    // 同上，技能：命中是确定的（开关 + 范围 + 触发词），报出去的可以逐条对上
    skillsUsed: brain.skillsInPrompt(evt, parsed).map((s) => ({ kind: s.kind, name: s.name })),
  };
  if (!decision.respond) {
    console.log(JSON.stringify(out));
    process.exit(0);
  }
  const messages = brain.buildMessages(session, evt, parsed);
  out.messageCount = messages.length;
  out.prompt = messages
    .map(
      (m) =>
        `【${m.role}】\n` +
        (Array.isArray(m.content) ? m.content.map((c) => c.text || '[图片]').join('\n') : m.content)
    )
    .join('\n\n');

  const t0 = Date.now();
  try {
    const raw = await llm.chat(messages);
    out.ms = Date.now() - t0;
    recordUsage(llm.lastUsage);
    out.usage = llm.lastUsage;
    out.raw = raw;
    const { silent, chunks } = brain.parseReply(raw);
    out.silent = silent;
    out.chunks = chunks;
  } catch (e) {
    out.ok = false;
    out.ms = Date.now() - t0;
    out.error = e.message;
  }
  console.log(JSON.stringify(out));
  process.exit(0);
}

console.log('─'.repeat(58));
console.log(`模型      : ${cfg.llm.model}`);
console.log(`接口      : ${cfg.llm.baseUrl}`);
console.log(`人格      : ${cfg.persona.name}`);
console.log(`群号      : ${groupId}`);
console.log(`白名单    : ${cfg.allow.groups.join(', ')}`);
console.log('─'.repeat(58));

console.log(`决策      : ${decision.respond ? '回应' : '不理'}（${decision.reason}）`);
if (!decision.respond) process.exit(0);

const messages = brain.buildMessages(session, evt, parsed);
console.log(`上下文    : 系统提示 + ${messages.length - 1} 段历史/背景`);
console.log(`收到消息  : 群主: ${text}`);
console.log('─'.repeat(58));
console.log('正在问模型…');

const t0 = Date.now();
const raw = await llm.chat(messages);
const ms = Date.now() - t0;
recordUsage(llm.lastUsage); // 干跑也是真花钱，如实记账

const { silent, chunks } = brain.parseReply(raw);

console.log(`耗时      : ${ms} ms`);
if (llm.lastUsage) {
  const u = llm.lastUsage;
  console.log(`用量      : 输入 ${u.prompt} tok（缓存命中 ${u.cached}）| 输出 ${u.completion} tok | 其中思考 ${u.reasoning} tok`);
}
console.log(`原始输出  : ${JSON.stringify(raw)}`);
console.log('─'.repeat(58));

if (silent) {
  console.log('结果      : 机器人选择不说话（[SILENT]）');
} else {
  console.log(`结果      : 会发 ${chunks.length} 条消息`);
  chunks.forEach((c, i) => console.log(`  [${i + 1}] ${c}`));
}
