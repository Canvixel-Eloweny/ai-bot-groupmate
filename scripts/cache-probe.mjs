/**
 * ══════════════════════════════════════════════════════════════════════
 *  A/B 探针：给 LLM 请求加上 tools 之后，服务端缓存命中率会掉多少？
 *  第 45 轮 B12e-0
 * ══════════════════════════════════════════════════════════════════════
 *  B12e 执行层要给请求加 function-calling 的 `tools`，而 `tools` 会进
 *  服务端的缓存前缀。代价多大，**开工前必须有个数**——因为那条链改的是
 *  每天在群里说话的提示词主路径。
 *
 *  ────────────────────────────────────────────────────────────────────
 *  ⚠️ 为什么借现成的 webSearch 开关，而不是自己发 HTTP
 *  ────────────────────────────────────────────────────────────────────
 *  生产链路里 `tools` 的写入点**只有一处**（src/llm.js 的 #chatOnce）：
 *
 *      if (cfg.features?.webSearch && caps.features.webSearch) body.tools = [...]
 *
 *  也就是说"带不带 tools"这个自变量，**已经有一个现成的开关**。
 *  探针直接借它 → 走的是**完全相同的生产路径**（同一个 LlmClient、同一份
 *  请求构造、同一套能力判定），不必把 body 组装抄一遍
 *  （抄一遍就又多了"同一份语义的第二份拷贝"，而且抄错了不会报错）。
 *
 *  ⚠️ 代价必须说清楚：B 组带的是服务商**内置**工具（web_search），
 *     它比将来 B12e 要带的 function schema **小**。所以本探针量到的是**下界** ——
 *     若下界就已经明显掉命中，真实影响只会更大。这条写进结论，不含糊。
 *
 *  ────────────────────────────────────────────────────────────────────
 *  ⚠️ 它**不写任何留档**（契约 12 节盯着这一条）
 *  ────────────────────────────────────────────────────────────────────
 *  只调 `LlmClient.chatWithUsage`（它不记 usage 账本）。
 *  **不碰** `src/usage.js` 的 `recordUsage`（那是用户的花费账本）；
 *  **不碰** `src/index.js` 的 `writeTrace` / `recordSample`（那是命中率留档）。
 *  探针污染留档是一件很难被发现的事 —— 账目虚高、命中率曲线被实验数据污染，
 *  而且看起来"就是真实数据"。
 *
 *  用法：
 *      node scripts/cache-probe.mjs                   # A/B 各 6 轮
 *      node scripts/cache-probe.mjs --rounds 4
 *      node scripts/cache-probe.mjs --model glm-4.5-air
 *      node scripts/cache-probe.mjs --json
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';
import { capabilitiesOf } from '../src/model-caps.js';
import { LlmClient } from '../src/llm.js';
import { buildSampleSystem } from './prompt-diff.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 对照用的对话。刻意做成**短句、贴近真实群聊**——
 * 缓存命中率与"每轮新增多少 token"强相关，用长段落提问会把这层关系盖掉。
 */
const TURNS = [
  '在吗',
  '刚下班，今天累死了',
  '周末你们有啥安排',
  '我想去看那个新上的片子',
  '有人一起吗',
  '那我先睡了，明天聊',
];

/**
 * 预填历史 —— 让 prompt 达到**真机量级**。
 *
 * 为什么必须做：真机 `glm-4.5-air` 的平均 prompt ≈ **1790 token**（账本 185 条实测）。
 * 一个刚开张的会话只有几十 token，那时"命不命中"主要取决于服务端有没有别人
 * 留下的前缀，**与 tools 无关** —— 拿它做对照说明不了任何事。
 * （第一版探针就是这么跑的，量到 p=11~99，那批数字全部作废。）
 *
 * ⚠️ 两组的预填内容**逐字相同**：否则比的就成了"内容差异"，不是 tools。
 */
const PRELOAD = [
  ['user', '今晚有人打游戏吗'],
  ['assistant', '我在的，不过可能得晚一点'],
  ['user', '行，那我先吃个饭'],
  ['assistant', '好，吃完喊我'],
  ['user', '你们公司最近忙不忙'],
  ['assistant', '还行，月中都会忙一阵'],
  ['user', '我们也是，天天加班'],
  ['assistant', '差不多，熬过这周就好了'],
];

/** 探针不需要思考档：省时间省钱，且两组一致（不引入额外变量）。 */
function probeLlmCfg(cfg, withTools) {
  return {
    ...cfg.llm,
    thinking: { mode: 'disabled', level: 'low' },
    features: { ...(cfg.llm.features || {}), webSearch: !!withTools },
  };
}

/**
 * 跑一组：逐轮追加「用户一句 + 助手回复一句」，模拟真实连续对话。
 *
 * ⚠️ 必须把助手的**回复**也放进历史 —— 真实对话就是这么长的。
 *    只追加用户消息会让每轮增量恒为一条短句，前缀增长速度与真机不符。
 *
 * ⚠️ 请求**用真实的 `brain.buildMessages()` 构造**，不是自己拼 messages：
 *    它会带上 system 段、尾部的时间/场景、以及上下文预算的截断规则 ——
 *    自己拼等于把那些规则又抄了一遍，而抄错既不报错、又只让对照悄悄失真。
 */
async function runArm({ label, cfg, turns }) {
  // ★ 两组各自建一套 Brain / Session。共用会让 A 组的历史污染 B 组 ——
  //   那种污染不抛错，只让对照失去意义。
  //   `buildSampleSystem` 每次调用都新建 Brain 与 SessionStore，所以调两次就是两套。
  const { brain, session, evt, parsed } = buildSampleSystem(cfg);

  for (const [role, text] of PRELOAD) brain.remember(session, role, text);

  const client = new LlmClient(probeLlmCfg(cfg, label === 'B'));
  const rows = [];
  for (let i = 0; i < turns.length; i += 1) {
    brain.remember(session, 'user', turns[i]);
    const messages = brain.buildMessages(session, evt, { ...parsed, text: turns[i] });
    const r = await client.chatWithUsage(messages, { temperature: 0, maxTokens: 200 });
    const p = Number(r?.usage?.prompt) || 0;
    const h = Number(r?.usage?.cached) || 0;
    rows.push({ turn: i + 1, p, h, ratio: p > 0 ? h / p : null, text: (r?.text || '').slice(0, 40) });
    brain.remember(session, 'assistant', r?.text || '(无回复)');
  }
  return rows;
}

const pct = (x) => (x === null || x === undefined ? '—' : `${(x * 100).toFixed(2)}%`);

/** 稳态：丢掉第 1 轮（它必然未命中），对剩余轮次做**加权**。 */
function steady(rows) {
  const rest = (rows || []).slice(1);
  let p = 0;
  let h = 0;
  for (const r of rest) {
    p += r.p;
    h += r.h;
  }
  return { n: rest.length, p, h, ratio: p > 0 ? h / p : null };
}

function main() {
  const argv = process.argv.slice(2);
  const asJson = argv.includes('--json');
  const roundsIdx = argv.indexOf('--rounds');
  const modelIdx = argv.indexOf('--model');

  const cfg = loadConfig(process.env.QQBOT_CONFIG);
  const model = modelIdx >= 0 ? String(argv[modelIdx + 1]) : 'glm-4.5-air';
  const rounds = Math.max(2, Math.min(TURNS.length, Number(roundsIdx >= 0 ? argv[roundsIdx + 1] : 6) || 6));

  // ★ 关键防线：B 组必须真的能带上 tools，否则这次对照**没有意义**。
  //   本项目有过一次真实教训：某些模型"收下 tools 参数、返回 200、看着也像回事"，
  //   但工具根本没生效。所以这里宁可当场不跑，也不要产出一个假的"无影响"。
  const caps = capabilitiesOf(cfg.llm.provider, model);
  if (!caps.features.webSearch) {
    console.error(`✗ 模型 ${model} 的 capabilities.features.webSearch = false —— B 组带不上 tools，`
      + '这次对照会得出假的「无影响」结论，已中止。');
    console.error('  请用 --model 换一个支持的模型（如 glm-4.5-air）。');
    process.exit(2);
  }

  const turns = TURNS.slice(0, rounds);
  const started = Date.now();

  if (!asJson) {
    console.log('A/B 对照：tools 是否进入服务端缓存前缀');
    console.log(`模型：${model}（provider=${cfg.llm.provider}，webSearch 能力 = true）`);
    console.log(`轮次：${rounds}（A 组不带 tools，B 组带内置 web_search）`);
    console.log(`预填历史：${PRELOAD.length} 条（两组逐字相同）`);
    console.log(`预计请求：${rounds * 2} 次 —— 会真实计费，但量很小\n`);
  }

  return (async () => {
    const a = await runArm({ label: 'A', cfg, turns });
    const b = await runArm({ label: 'B', cfg, turns });

    const sa = steady(a);
    const sb = steady(b);
    const pa = a.map((r) => r.p).filter((x) => x > 0);
    const pb = b.map((r) => r.p).filter((x) => x > 0);
    const avg = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
    const deltaP = avg(pb) - avg(pa);

    if (asJson) {
      console.log(JSON.stringify({
        model, provider: cfg.llm.provider, rounds,
        preload: PRELOAD.length,
        avgPromptDelta: deltaP,
        a: { rows: a, steady: sa },
        b: { rows: b, steady: sb },
        elapsedMs: Date.now() - started,
      }, null, 2));
      return;
    }

    console.log('轮次   A组 p / h            A组命中    B组 p / h            B组命中   备注');
    for (let i = 0; i < rounds; i += 1) {
      const ra = a[i] || { p: 0, h: 0, ratio: null };
      const rb = b[i] || { p: 0, h: 0, ratio: null };
      const note = i === 0 ? '（首轮，两组都必然未命中）'
        : (rb.h === 0 && ra.h > 0 ? '★ B 组归零' : '');
      console.log(
        `  ${String(i + 1).padStart(2)}   ${String(ra.p).padStart(6)} / ${String(ra.h).padStart(6)}    ${pct(ra.ratio).padStart(8)}   ${String(rb.p).padStart(6)} / ${String(rb.h).padStart(6)}    ${pct(rb.ratio).padStart(8)}   ${note}`
      );
    }

    console.log('\n─────────────────────────────────────────');
    console.log('稳态（丢掉第 1 轮后加权）');
    console.log(`  A 组（不带 tools）：${sa.h}/${sa.p} = ${pct(sa.ratio)}   n=${sa.n}`);
    console.log(`  B 组（带 tools）  ：${sb.h}/${sb.p} = ${pct(sb.ratio)}   n=${sb.n}`);
    const diff = (sa.ratio !== null && sb.ratio !== null) ? (sb.ratio - sa.ratio) * 100 : null;
    console.log(`  差值：${diff === null ? '—' : `${diff > 0 ? '+' : ''}${diff.toFixed(2)} 个百分点`}`);
    console.log('\n前缀增量（tools 占了多少输入 token）');
    console.log(`  B 组平均输入 ${avg(pb).toFixed(0)}，A 组平均输入 ${avg(pa).toFixed(0)}，差 ${deltaP.toFixed(0)} token`);

    // 量级自检：真机同模型的平均 prompt ≈ 1790 token。
    // 探针的 prompt 若小一个数量级，缓存行为与真实场景**不是一回事**，
    // 那批数字就不能拿去决策（第一版探针正是栽在这里：p=11~99）。
    const lvl = avg(pa);
    console.log('\n量级自检（决定这批数字能不能用）');
    console.log(`  A 组平均输入 ${lvl.toFixed(0)} token；真机同模型基线约 1790 token`);
    if (lvl < 500) {
      console.log('  ⚠️ 小了一个数量级 —— 结论不可用于决策，请加大预填历史或换更长的对话。');
    } else if (lvl < 1200) {
      console.log('  △ 偏小 —— 方向可信、幅度可能失真，报告里要写明这一点。');
    } else {
      console.log('  ✓ 与真机同量级。');
    }

    // 离群点：某一轮 p 突然是其它轮的几倍（通常是超长回复被算进历史，
    // 或那次请求被降级重发）。不标出来，它会被当成真实数据算进加权平均。
    const med = (xs) => {
      const s = [...xs].sort((x, y) => x - y);
      return s.length ? s[Math.floor(s.length / 2)] : 0;
    };
    const outliers = [];
    for (const [tag, rows2] of [['A', a], ['B', b]]) {
      const m = med(rows2.map((r) => r.p));
      for (const r of rows2) if (m > 0 && r.p > m * 3) outliers.push(`${tag} 组第 ${r.turn} 轮 p=${r.p}（中位 ${m}）`);
    }
    if (outliers.length) {
      console.log('\n⚠️ 离群点（它们已计入上面的加权，读数字时要留意）');
      for (const o of outliers) console.log(`  ${o}`);
    }

    console.log('\n判据（B 组减 A 组）');
    if (diff === null) console.log('  无法判定：有某一组没有拿到 usage。');
    else if (diff <= -15) console.log('  ⚠️ 降幅 > 15 个百分点 → 代价过高，B12e 应改设计（工具描述挪进 system 末尾）。');
    else if (diff >= -5) console.log('  ✓ 降幅 ≤ 5 个百分点 → 可接受，可以开工 B12e-1。');
    else console.log('  △ 介于两者之间 → 结合成本换算（缓存命中价约 1/50）再定。');
    if (diff > 0) {
      console.log('  ※ 注意：B 组命中率**反而更高**。这与"固定的 tools 让公共前缀变长"一致，'
        + '是有效结果，不是测量失败。');
    }
    console.log(`\n（用时 ${((Date.now() - started) / 1000).toFixed(1)} 秒；本次实验未写入任何留档）`);
  })();
}

const invokedDirectly = process.argv[1]
  && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href;
if (invokedDirectly) {
  main().catch((e) => {
    console.error(`探针失败：${e?.message ?? e}`);
    process.exit(1);
  });
}

export { runArm, steady, probeLlmCfg, TURNS };
