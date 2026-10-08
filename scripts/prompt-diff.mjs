#!/usr/bin/env node
/**
 * 相邻运行逐字符比对 —— 把「提示词前缀缓存有没有变好」从玄学变成一个数字。
 *
 * 背景（一句话）：前缀缓存只认「从头逐字一致」。所以只要有一行会变的内容排在最前面，
 * 它后面几千字符就全部作废。本地实测：改序前相邻两轮公共前缀 58 / 2,947 字符（2.0%），
 * 把「当前时间 + 场景（群号）」压到 system 末尾之后升到 2,926 字符（99.3%）。
 *
 * 用法：
 *   node scripts/prompt-diff.mjs            # 打印两路数字 + 结构断言
 *   node scripts/prompt-diff.mjs --json     # 供脚本消费
 *
 * ⚠️ 必须**两路一起看**：
 *   ① 合成样本（同一个会话、同一个事件，只让"秒"真的走一格）—— 它会**虚高**，
 *      因为没有新消息进来，ambient 完全不变，而真实运行时 ambient 每轮都在动；
 *   ② 真实链路（读 panel/local-trace.jsonl 里同一会话的相邻两条）—— 这一路才是真相，
 *      但它条数少、还可能碰上"用户中途真改了配置"（那种情况本就该失效，不算退步）。
 *   只看 ① 会以为自己优化到了 99%，只看 ② 又会被噪声带偏。
 *
 * 另外提供 checkVolatileTail()：把「必变段必须压在 system 末尾」这条设计钉死。
 * 它**不依赖墙钟**——否则这条断言会变成"看运气"，而它恰恰是用来防"顺序又被改回去"的。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Brain, SessionStore } from '../src/brain.js';
import { lcp, ambientBlockOf, readStats, statsFilePath, summarizeStats } from '../src/trace-stats.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TRACE_FILE = path.join(ROOT, 'panel', 'local-trace.jsonl');

// ⚠️ `lcp` 与 `ambientBlockOf` 的**实现在 src/trace-stats.js，此处只做转发**。
//    判据必须是同一份 —— 机器人写入留档时用它，这里量数时也用它；
//    各写一份就会出现"留档里是 87%，脚本算出 92%"这种两边都自认正确、却对不上的局面
//    （本项目已在 normalizeThinking 上真实踩过一次）。check-wb 有契约盯着不许再写一份。
export { lcp, ambientBlockOf };

/** 一条**最小可用**的配置：只为把 buildMessages 跑起来，刻意不读用户的真实 config.json */
export function sampleConfig() {
  return {
    persona: { name: '小鱼', text: '（示例人格文本）' },
    context: { recentTurns: 6, ambientMessages: 8 },
    reply: { maxChunks: 4 },
    llm: { model: 'sample-model', provider: 'zhipu', features: { vision: false, stickers: false, webSearch: false } },
    trigger: { requireAtInGroup: true, aliases: [], interjectChance: 0, interjectCooldownMs: 0 },
    throttle: { minIntervalMs: 0, perMinutePerSession: 100, globalConcurrency: 1 },
    allow: { private: [], groups: ['100000001'], allowAllWhenEmpty: false },
    deny: { users: [], groups: [] },
    custom: {
      persona: { age: '24', role: '学生', desire: '交几个说得上话的朋友', tone: '随和，别端着' },
      enhance: {},
      playRules: true,
      scenes: {},
      skills: [],
      memory: { manual: [{ id: 'm1', text: '不要跟群里的张三说话', on: true }], auto: false },
      replyStyle: { length: 'normal' },
      allowProactive: true,
    },
  };
}

/** 用示例配置跑一次 buildMessages，拿到 system 段 */
export function buildSampleSystem(cfg = sampleConfig()) {
  const store = new SessionStore(cfg);
  const brain = new Brain(cfg, store);
  const session = store.get('group', '100000001');
  brain.rememberAmbient(session, '路人乙', '今天下班好晚，累死了');
  brain.rememberAmbient(session, '老王', '我还在公司呢，你算好的');
  const evt = {
    message_type: 'group',
    group_id: '100000001',
    user_id: '10001',
    message_id: '1',
    sender: { nickname: '群主' },
  };
  const parsed = { text: '你们平时几点睡觉', mentionedSelf: true, images: [] };
  return { system: brain.buildMessages(session, evt, parsed)[0].content, brain, session, evt, parsed };
}

/**
 * 结构断言：**所有会变的东西都必须待在 system 的尾巴上**。
 *
 * 为什么断言"结构"而不是断言"某个具体字符数"：字符数会随配置漂移，
 * 而这条设计的本质是一个**顺序约束**。顺序被改回去 = 缓存命中率一夜回到 2%，
 * 且不报任何错 —— 正是这个项目最怕的那类静默失效。
 */
export function checkVolatileTail(system) {
  const lines = String(system ?? '').split('\n');
  // 忽略尾部空行：这份函数既会被喂 buildMessages 的原始 system 段，
  // 也会被喂 trace 里 promptText() 拼好的整包文本（那里面 system 段后面还跟着空行）。
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  const tail2 = lines[lines.length - 2] ?? '';
  const tail1 = lines[lines.length - 1] ?? '';
  const timeCount = lines.filter((l) => l.startsWith('当前时间：')).length;
  const sceneCount = lines.filter((l) => l.startsWith('场景：')).length;
  const problems = [];
  if (!tail2.startsWith('当前时间：')) problems.push(`倒数第 2 行应是「当前时间」，实际是：${tail2.slice(0, 40)}`);
  if (!tail1.startsWith('场景：')) problems.push(`最后 1 行应是「场景」，实际是：${tail1.slice(0, 40)}`);
  if (timeCount !== 1) problems.push(`「当前时间」应恰好出现 1 次，实际 ${timeCount} 次`);
  if (sceneCount !== 1) problems.push(`「场景」应恰好出现 1 次，实际 ${sceneCount} 次`);
  return { ok: problems.length === 0, problems };
}

/** 读真实链路：同一会话相邻两条记录的 prompt 公共前缀 */
export function realTraceLcps(file = TRACE_FILE) {
  let raw = '';
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return { available: false, items: [] };
  }
  const recs = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      recs.push(JSON.parse(t));
    } catch {
      /* 坏行跳过：trace 是 append-only，写一半的行不该让整个检查失败 */
    }
  }
  const bySession = new Map();
  for (const r of recs) {
    if (typeof r?.prompt !== 'string' || !r.prompt) continue;
    const k = `${r.scene}:${r.id}`;
    if (!bySession.has(k)) bySession.set(k, []);
    bySession.get(k).push(r);
  }
  const items = [];
  for (const [k, list] of bySession) {
    for (let i = 1; i < list.length; i += 1) {
      const a = list[i - 1];
      const b = list[i];
      const ratio = lcp(a.prompt, b.prompt) / Math.min(a.prompt.length, b.prompt.length);
      // 怎么判断一条记录是"改序前"还是"改序后"写的？**直接看内容本身**：
      // 改序之后 system 的最后两行必然是「当前时间」和「场景」。
      // （刻意不用 trace 里有没有 `vision` 字段来判 —— 那只标记「≥ B6」，
      //   而改序是 B7；用它会把这批记录错标成"已经改好了"。）
      const sysPart = String(b.prompt).split('【user】')[0];
      items.push({
        key: k,
        lcp: lcp(a.prompt, b.prompt),
        len: Math.min(a.prompt.length, b.prompt.length),
        ratio,
        ordered: checkVolatileTail(sysPart).ok,
        // B10f 新指标：背景消息段这一轮有没有变（粘性窗口的目标就是把它降下来）
        ambientChanged: ambientBlockOf(a.prompt) !== ambientBlockOf(b.prompt),
      });
    }
  }
  return { available: true, items };
}

/** 把一组占比压成 min/中位/max */
export function summarize(ratios) {
  if (!ratios.length) return null;
  const s = [...ratios].sort((a, b) => a - b);
  return { n: s.length, min: s[0], median: s[Math.floor(s.length / 2)], max: s[s.length - 1] };
}

async function main() {
  const asJson = process.argv.includes('--json');
  const { system } = buildSampleSystem();
  const tail = checkVolatileTail(system);

  // 合成样本：等 1.1 秒，让 toLocaleString 的"秒"真的走一格
  const { brain, session, evt, parsed } = buildSampleSystem();
  const first = brain.buildMessages(session, evt, parsed)[0].content;
  await new Promise((r) => setTimeout(r, 1100));
  const second = brain.buildMessages(session, evt, parsed)[0].content;
  const synth = { len: first.length, lcp: lcp(first, second) };

  const real = realTraceLcps();
  const before = summarize(real.items.filter((i) => !i.ordered).map((i) => i.ratio));
  const after = summarize(real.items.filter((i) => i.ordered).map((i) => i.ratio));

  if (asJson) {
    console.log(JSON.stringify({ tail, synth, real: { available: real.available, before, after } }, null, 2));
  } else {
    console.log('── 提示词前缀比对 ──────────────────────────────');
    console.log('① 合成样本（会虚高：没有新消息进来，ambient 不变）');
    console.log(`   提示词长度        : ${synth.len} 字符`);
    console.log(`   相邻两轮公共前缀  : ${synth.lcp} 字符（${((synth.lcp / synth.len) * 100).toFixed(1)}%）`);
    console.log('');
    console.log('② 真实链路（读 panel/local-trace.jsonl，这一路才是真相）');
    const show = (label, s) => {
      if (!s) {
        console.log(`   ${label}：暂无样本`);
        return;
      }
      console.log(
        `   ${label}（${s.n} 组）：最低 ${(s.min * 100).toFixed(1)}% · ` +
          `中位 ${(s.median * 100).toFixed(1)}% · 最高 ${(s.max * 100).toFixed(1)}%`
      );
    };
    if (!real.available) {
      console.log('   读不到 trace 文件 —— 跳过（这不代表失败，新装的项目还没有记录）');
    } else {
      show('改序之前（时间戳还在前面）', before);
      show('改序之后（结构已经正确）', after);
      const afterItems = real.items.filter((i) => i.ordered);
      if (afterItems.length) {
        const changed = afterItems.filter((i) => i.ambientChanged).length;
        console.log(
          `   ambient 变动率（改序之后 ${afterItems.length} 组）：${((changed / afterItems.length) * 100).toFixed(0)}% 的相邻轮背景段发生了变化`
        );
        console.log('   （B10f 粘性窗口落地前的基线；成批换的目标是把这一轮一轮的错位降下来。）');
      }
      console.log('   注：占比很低的那些通常是"用户中途真的改了配置"——那是真的变了，本就该失效。');
      console.log('       「改序之后」的样本要等群里真的来了消息才会有，刚落地时为空是正常的。');
    }
    console.log('');
    console.log('③ 结构断言：必变段必须压在 system 末尾');
    if (tail.ok) {
      console.log('   ✓ 通过（当前时间 / 场景 恰好各 1 次，且占据最后两行）');
    } else {
      for (const p of tail.problems) console.log(`   ✗ ${p}`);
    }
    console.log('');
    // ④ 长期留档（B10f 收口 · O-CACHESTAT）：② 那一段读的是**会被截断**的
    //    local-trace（TRACE_MAX=120，超了折半），只能反映"最近这一小段"。
    //    要跨小时 / 跨天比较"改前改后"，必须看只增不减的留档 —— 这就是加这一段的原因。
    const file = statsFilePath();
    const sums = summarizeStats(readStats(file));
    const pct = (x) => (x == null ? '—' : `${(x * 100).toFixed(1)}%`);
    const span = (s) =>
      s ? `${new Date(s.firstT).toLocaleString('zh-CN')} → ${new Date(s.lastT).toLocaleString('zh-CN')}` : '—';
    console.log('④ 长期留档（只增不减，不受 TRACE_MAX 截断影响）');
    console.log(`   文件: ${file}`);
    if (!sums.total) {
      console.log('   还没有样本 —— 留档从这一版代码上线后开始累积（历史样本无法回填，见报告）。');
    } else {
      console.log(
        `   累计（${sums.total.n} 组）：最低 ${pct(sums.total.min)} · 中位 ${pct(sums.total.median)} · 最高 ${pct(sums.total.max)}` +
          ` · ambient 变动率 ${pct(sums.total.ambientRate)}`
      );
      console.log(`   覆盖范围: ${span(sums.total)}`);
      for (const d of sums.days) {
        console.log(
          `     ${d.day}  n=${String(d.stat.n).padStart(3)}  中位 ${pct(d.stat.median)}` +
            `  最低 ${pct(d.stat.min)}  最高 ${pct(d.stat.max)}  ambient 变动率 ${pct(d.stat.ambientRate)}`
        );
      }
      console.log('   注：中位由 100 档直方图反推，精度 1%；min/max/ambient 是精确值。');
    }
    console.log('───────────────────────────────────────────────');
  }

  process.exit(tail.ok ? 0 : 1);
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((err) => {
    console.error('比对脚本异常:', err.message);
    process.exit(1);
  });
}
