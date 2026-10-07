/**
 * ══════════════════════════════════════════════════════════════════════
 *  视觉（识图）能力实测探测器（D16 · 报告 E10 ①）
 * ══════════════════════════════════════════════════════════════════════
 *
 *  为什么必须实测、而不是信 `src/model-caps.js` 那张手填的表：
 *  表里的 `vision: true` 是**人写上去的**。写错的两个方向代价都不对称：
 *    · 判宽了（其实看不见却标 true）→ 每轮请求都带图 → 服务端 400 →
 *      整条请求失败（D8 的去图重试能救回来，但白花一次调用）；
 *    · 判窄了（其实看得见却标 false）→ **它永远看不到群里的图**，
 *      而界面上只会说"这个模型不能看图" —— 一个静默的能力丢失。
 *
 *  ────────────────────────────────────────────────────────────────────
 *  两道测试（这就是报告里"32×32 纯红/纯绿"那句话的来历）
 *  ────────────────────────────────────────────────────────────────────
 *  对每张图问一句「这张图是什么颜色？只回一个颜色词」：
 *    · 两张都答对   → `yes`（硬证据：它真的看见了。单张蒙对的概率不低，两张一起就很难蒙）
 *    · 服务端点名图片参数非法 → `no`（确定的否定）
 *    · 其余一切     → `unknown`（**不写 false 也不写 true** —— 与 probe-functions 同一条纪律）
 *
 *  ⚠️ **测试图是自己合成的**（`src/vision-probe.js` 的 `pngSolid`），并且在发出去之前
 *     先用 `verifyPng` **按规范读回来核对**。报告点名的坑正是这里：
 *     用一张**不合法**的测试图去探，服务端会 400，而探测方把"这张图不合法"读成了
 *     "这个模型没有视觉" —— 于是把模型**永久**标成瞎子。合成 + 自证，这个坑就不存在。
 *
 *  ⚠️ **退避重试**：429 被当成"看不见"会写出错误的能力表，比不测更糟（probe-models 的同款教训）。
 *
 *  ⚠️ **它一个字节都不写留档**：直接 fetch，不走 LlmClient ——
 *     也就不会碰 `src/usage.js` 的 recordUsage、不会碰 trace / prompt-stats。
 *
 *  用法：
 *      node scripts/probe-vision.mjs                # 全部候补
 *      node scripts/probe-vision.mjs glm-4.6v       # 只测指定模型
 *      node scripts/probe-vision.mjs --out x.json   # 结果另存
 *
 *  产出：scripts/vision-probe-result.json —— `src/model-caps.js` 的 `vision` 位照它填。
 *
 *  ⚠️ **落点与报告不同（有意）**：报告写"结果缓存到 `panel/model-vision.json`"（运行时缓存）。
 *     本实现改成**入库的结果文件**，与 `probe-functions.mjs` / `functions-probe-result.json`
 *     的先例一致：既能被契约逐卡比对（`check-wb` §45），又不必新增运行时落盘文件
 *     （那会牵出三件套：`.gitignore` / 沙箱排除 / env 覆盖）。探测是**按需手动跑**的，
 *     本来就不需要缓存。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  VISION_TEST_CASES, VISION_TEST_IMAGES, probeVerdictOf, visionTestBody, verifyPng,
} from '../src/vision-probe.js';
import { isVisionRejection } from '../src/llm.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TIMEOUT = 90000;

/**
 * 测哪些模型。
 *
 * 只测**与决定有关**的那些，不去把整张表跑一遍（AI额度是有限的，探测也要花钱）：
 *   · 能力表里标了 `vision: true` 的**对话**模型（`glm-ocr` 不是对话模型，跳过）
 *     —— 它们在宣称"我能看图"，这一条最该被验证；
 *   · 现役大脑 + 降级链上那几个（判错会直接影响真机行为）。
 */
const VISION_CANDIDATES = [
  // 表里宣称有视觉的（对话模型）
  'glm-4.6v', 'glm-5v-turbo', 'glm-4.6v-flash', 'glm-5.3-flash', 'glm-4.6v-flashx', 'glm-4.5v',
  // 现役 + 降级链（判错直接影响真机）
  'glm-4.5-air', 'glm-4.7', 'glm-5.2', 'glm-5', 'glm-4-flash',
];

function readCfg() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
}

/** 一次请求。返回事实，**不抛** —— 探测脚本里异常会打断整轮。 */
async function ask(baseUrl, key, model, body) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT);
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, stream: false }),
      signal: ac.signal,
    });
    const text = await res.text().catch(() => '');
    let data = null;
    try { data = JSON.parse(text); } catch { /* 非 JSON 也要能记下来 */ }
    const msg = data?.choices?.[0]?.message ?? null;
    return {
      ok: res.ok,
      status: res.status,
      // 只留证据，不留整包
      content: String(msg?.content ?? '').slice(0, 60),
      error: res.ok ? '' : text.slice(0, 300),
      raw: '',
      timeout: false,
    };
  } catch (err) {
    return {
      ok: false, status: 0, content: '', raw: '',
      error: String(err?.message ?? err),
      timeout: /abort/i.test(String(err?.name ?? err?.message ?? '')),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** 限流退避重试：把 429 当"看不见"，比不测更糟 */
async function askWithRetry(baseUrl, key, model, id, tries = 3) {
  let last = null;
  for (let i = 0; i < tries; i += 1) {
    last = await ask(baseUrl, key, model, visionTestBody(id, model));
    const limited = last.status === 429 || /1302|速率限制|rate.?limit/i.test(last.error);
    if (!limited) break;
    await new Promise((r) => setTimeout(r, 2500 * (i + 1)));
  }
  // ⚠️ **实测踩到（首次跑就撞上）**：`glm-5.3-flash` 是"始终思考、不许关"的型号，
  //    收到 `thinking:{type:'disabled'}` 直接 400（code 1210）—— 那是**本次请求参数**被拒，
  //    与"它看不看得见图"毫无关系。若不处理，它会被记成 `unknown`
  //    （虽然不猜是安全的，但它明明看得见却被挂着，等于这条探测白跑）。
  //    → 退一步：去掉 thinking 字段、把 max_tokens 调大（思考会吃掉额度，T159b 的教训），再问一次。
  if (last.status === 400 && /思考|thinking/i.test(last.error)) {
    const body = visionTestBody(id, model);
    delete body.thinking;
    body.max_tokens = 200; // 思考要占额度：给足，否则回来的正文是空的
    last = await ask(baseUrl, key, model, body);
  }
  return last;
}

async function probeOne(baseUrl, key, model) {
  const perImage = {};
  for (const c of VISION_TEST_CASES) {
    perImage[c.id] = await askWithRetry(baseUrl, key, model, c.id);
    await new Promise((r) => setTimeout(r, 400));
  }
  // 措辞判据**复用生产那一份**（`src/llm.js` 的 isVisionRejection）——
  // 它的签名收的是 `err` 形状，这里包一层把正文递进去，不改它的实现。
  const { verdict, evidence } = probeVerdictOf(perImage, {
    isVisionRejection: (s) => isVisionRejection({ message: String(s ?? '') }),
  });
  return { model, verdict, evidence, perImage };
}

async function main() {
  const argv = process.argv.slice(2);
  const outIdx = argv.indexOf('--out');
  const only = argv.filter((x, i) => !x.startsWith('--') && argv[i - 1] !== '--out');

  // ① 先把要发的两张图**按规范读回来核对**。不合法就当场停 ——
  //    发一张非法图出去，得到的是"这个模型看不见"这种**错得看不出来**的结论。
  for (const img of VISION_TEST_IMAGES) {
    const v = verifyPng(img.bytes);
    if (!v.ok) {
      console.error(`测试图 ${img.id} 不合规范：${v.reason} —— 停在这里，别把"图不合法"测成"模型看不见"`);
      process.exit(3);
    }
    if (v.w !== v.h || v.w < 16) {
      console.error(`测试图尺寸可疑（${v.w}×${v.h}）—— 报告点名的坑就是用 1×1 那种小图探，会被服务端判非法`);
      process.exit(3);
    }
  }

  const cfg = readCfg();
  const key = cfg?.llm?.keys?.zhipu || '';
  const baseUrl = cfg?.llm?.presets?.zhipu?.baseUrl || cfg?.llm?.cloudBaseUrl
    || cfg?.llm?.baseUrl || 'https://open.bigmodel.cn/api/paas/v4/';
  if (!key) {
    console.error('config.json 里没有 zhipu 的 API Key（llm.keys.zhipu），没法探测');
    process.exit(2);
  }

  const models = only.length ? only : VISION_CANDIDATES;
  console.log(`视觉能力实测：${models.length} 个模型 × ${VISION_TEST_CASES.length} 张图（真实计费，量很小）\n`);

  const results = [];
  for (const m of models) {
    process.stdout.write(`  zhipu/${m} … `);
    const r = await probeOne(baseUrl, key, m);
    results.push({ provider: 'zhipu', ...r });
    const mark = r.verdict === 'yes' ? '✓ 看得见' : r.verdict === 'no' ? '✗ 看不见' : '? 未能判定';
    const detail = VISION_TEST_CASES.map((c) => `${c.id}:${r.perImage[c.id].status}/${r.perImage[c.id].content || '—'}`).join(' ');
    console.log(`${mark}（${detail}）`);
    if (r.verdict === 'unknown' && r.evidence) console.log(`      ${r.evidence.slice(0, 200)}`);
    await new Promise((res) => setTimeout(res, 500));
  }

  const out = outIdx >= 0 ? String(argv[outIdx + 1]) : path.join(ROOT, 'scripts', 'vision-probe-result.json');
  fs.writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), results }, null, 2) + '\n');

  const yes = results.filter((r) => r.verdict === 'yes').map((r) => r.model);
  const no = results.filter((r) => r.verdict === 'no').map((r) => r.model);
  const unk = results.filter((r) => r.verdict === 'unknown').map((r) => r.model);
  console.log('\n─────────────────────────────────────────');
  console.log(`看得见（${yes.length}）：${yes.join(', ') || '—'}`);
  console.log(`看不见（${no.length}）：${no.join(', ') || '—'}`);
  console.log(`未能判定（${unk.length}）：${unk.join(', ') || '—'}`);
  console.log(`\n结果已写入 ${out}`);
  console.log('→ `src/model-caps.js` 的 `vision` 位**只对「看得见」的填 true**；');
  console.log('  「未能判定」保持 false（不猜）—— 猜错的方向有两个，都不报错。');
}

main().catch((e) => {
  console.error('探测异常:', e?.message ?? e);
  process.exit(1);
});
