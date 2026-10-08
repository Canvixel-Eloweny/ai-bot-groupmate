/**
 * ══════════════════════════════════════════════════════════════════════
 *  smoke 的测试骨架（第 22 轮 · H-10 从 `test/smoke.js` 整块搬出）
 * ══════════════════════════════════════════════════════════════════════
 *  为什么单独立一个模块：`test/smoke.js` 是**巨型文件**里最"平"的一个 ——
 *  462 个用例共用一个 `main()` 闭包（本体按设计留在原处，见下方 ⚠️），
 *  而**这一块**（计数 / 等待 / 文本抽取 / 脚本化 mock 服务 / 配置路径 / 群号常量）
 *  是模块级、与 `main()` 的局部状态**零耦合**的：搬出来不改变任何一条用例的行为。
 *
 *  ⚠️ **为什么用例本体不跟着搬**（如实写下来，免得下一个人以为是漏了）：
 *  它们全部读 `main()` 里的 `cfile` / `tfile` / `bot` / `cfg` 等十几个局部量。
 *  要搬就得给每个用例传一个上下文对象，并**重排 `check-wb` §48/§49/§51 的行号锚点** ——
 *  那是"改测试的形状"，而测试正是本仓判断"改对了没有"的那把尺子。
 *  在发布前一轮做这件事，风险远大于收益。**这是刻意的边界，不是没做完。**
 *
 *  ⚠️ **搬家时真踩的一个坑**：`test/smoke.js` 的 import 段**不是连成一片**的 ——
 *    它在 `repliesOf()`（第 135 行）之后**又续了一段**（第 144–208 行）。
 *    第一次按"135–328 一整块"剪，把那段 import 一起剪走了 ⇒ smoke 直接
 *    `Cannot find module .../test/src/panel-auth.js`（相对路径按新目录解析）。
 *    **教训：剪之前先 `grep '^import'` 看清楚 import 段到底铺在哪几行。**
 *
 *  ⚠️ 本模块**不许** import `test/smoke.js`（那是循环）。
 */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpPath } from './fixtures.js';

// ⚠️ **退两级**（`test/helpers/` → 仓库根）。搬过来时这里踩过一次：照抄原来那句
//    `'..'` 会让 ROOT 指向 `test/`，而 smoke 用它当 `spawn(..., { cwd: ROOT })` 的
//    工作目录 ⇒ 症状是 `Cannot find module '<repo>/test/src/index.js'`。
//    **相对路径的层数也是形状，搬家要一起改**（与 check-wb 的 `readPanelLogic` 同一条教训）。
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const SELF = '10001';
export const OK_GROUP = 20001;
export const BAD_GROUP = 29999;
export const FRIEND = 30001;

// Q46：mock 端口可被 env 覆盖 —— 同机并行跑两份副本（两条外包对话并行已是常态）
// 时，写死的 39991/39992 会让后起的那份**撞端口**（表现是"随机一条用例失败"，
// 而原因与代码无关）。基准端口一个 env 顶开，LLM 固定取 +1，两者不会互相踩。
// ⚠️ 默认值保持原样（39991/39992）：不加 env 时行为与改动前逐字相同。
export const SMOKE_BASE_PORT = Number(process.env.QQBOT_SMOKE_BASE_PORT) || 39990;
export const OB_PORT = SMOKE_BASE_PORT + 1;
export const LLM_PORT = SMOKE_BASE_PORT + 2;

export const results = [];
export function check(name, pass, detail = '') {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

/**
 * 夹具不在时的**显式跳过**（第 22 轮 · 对外拷贝）。
 *
 * 为什么需要：本仓有三条用例跑的是**磁盘上真实的第三方/自用包**
 * （`plugins/复读拦截` 与 `skills/合并转发发送`），而那两处**都不入库** ——
 * `plugins/` 按 allowlist 只放行 `本体情绪`；`skills/` 整块 gitignore。
 * ⇒ 任何人 clone 下来，那三条会**永远红**，而它们不是缺陷，是"夹具不在本机"。
 * 实测（2026-10-06）：对外拷贝里跑 smoke 是 **459/462**，挂的正是这三条。
 *
 * ⚠️ **必须是"看得见的 SKIP"，不是静默 pass**：静默 pass 会让
 *    「夹具搬走了」与「这条判据真的跑过了」在输出上长得一样 ——
 *    那正是本项目反复清掉的形态。
 * ⚠️ 计数照旧（`results.push`）⇒ 用例数下限 **462 不变**（四层"只增不减"）。
 */
export function skip(name, why) {
  results.push({ name, pass: true, detail: `SKIP：${why}` });
  console.log(`  SKIP  ${name}  — SKIP：${why}`);
}

/**
 * 某个**不入库**的夹具在不在（相对仓库根）。
 * ⚠️ 判"在不在"而不是判"加载成功没有"：夹具在而加载失败**必须照旧红**
 *    （那是真缺陷）；夹具不在才是跳过。
 */
export function hasFixture(rel) {
  return fs.existsSync(path.join(ROOT, rel));
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(predicate, { timeout = 4000, interval = 50 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(interval);
  }
  return false;
}

export function textOf(params) {
  const msg = params?.message;
  if (!Array.isArray(msg)) return String(msg ?? '').trim();
  return msg
    .filter((s) => s.type === 'text')
    .map((s) => s.data?.text ?? '')
    .join('')
    .trim();
}

/**
 * 按脚本回放响应的假模型服务端（第 36 轮 T42 用）。
 *
 * 为什么不能复用 startMockLlm：那一支永远返回 200。而这里要验的恰恰是
 * "不同身份的 400 分别怎么处理" —— 必须能指定第 N 次调用返回什么。
 *
 * @param {number} port
 * @param {{status:number, body:string}[]} script 第 i 次调用按 script[i] 回；越界或缺项一律 200
 */
export async function startScriptedLlm({ port, script = [] }) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
    });
    req.on('end', () => {
      let parsed = {};
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = {};
      }
      calls.push(parsed);
      const step = script[calls.length - 1];
      if (!step || step.status === 200) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            model: parsed.model || 'mock-model',
            choices: [{ index: 0, message: { role: 'assistant', content: '收到，我在' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          })
        );
        return;
      }
      res.writeHead(step.status, { 'Content-Type': 'application/json' });
      res.end(step.body ?? '{}');
    });
  });
  server.listen(port);
  await new Promise((r) => server.on('listening', r));
  return { calls, close: () => new Promise((r) => server.close(() => r())) };
}

export function cfgPath() {
  const cfg = {
    onebot: { wsUrl: `ws://127.0.0.1:${OB_PORT}`, accessToken: '', reconnectBackoffMs: [200] },
    llm: {
      baseUrl: `http://127.0.0.1:${LLM_PORT}/v1`,
      apiKeyEnv: '',
      apiKey: '',
      model: 'mock-model',
      temperature: 1,
      maxTokens: 200,
      timeoutMs: 8000,
    },
    allow: { private: [FRIEND], groups: [OK_GROUP], allowAllWhenEmpty: false },
    deny: { users: [], groups: [] },
    trigger: { requireAtInGroup: true, aliases: [], interjectChance: 0, interjectCooldownMs: 0 },
    // B8 起「多条消息之间」默认是随机节奏（1–3 秒 + 20ms/字），而它对这十来个端到端
    // 用例毫无意义（只让整轮变慢、还容易踩到等待窗口）。所以这里显式给一个
    // **极小但仍在区间内**的节奏：路径照样走 sendDelayFor（接线不会被测漏），
    // 但每条之间只停 1–2ms。`sendDelayMs: 0` 依旧是节奏的下限。
    reply: { splitToken: '||', sendDelayMs: 0, pace: { enabled: true, minMs: 1, maxMs: 2, perCharMs: 0 }, maxChunks: 4, maxCharsPerChunk: 300, quoteOnReply: false },
    context: { recentTurns: 6, ambientMessages: 10 },
    throttle: { minIntervalMs: 0, perMinutePerSession: 100, globalConcurrency: 1 },
    persona: { name: '小鱼', file: 'persona/qq-chat.md' },
    // D9b（E7）：给一个**别的用例都不会碰到的**关键词 ——
    // T214 要证明的是「安静期内，本来会回的那条不回了」。没有这条关键词的话，
    // 未被点名的消息本来就一律不回，「安静期内不回」就是一条**真空断言**（永远绿）。
    // 用「菠萝」而不是「天气」：T2 拿「今天天气不错」证明"未被点名不回"，
    // 换成「天气」会把它一起打破。
    custom: { trigger: { keywords: ['菠萝'] } },
  };
  const p = tmpPath('smoke', 'json');
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2));
  return p;
}
