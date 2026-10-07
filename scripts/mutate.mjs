#!/usr/bin/env node
/**
 * 变异测试脚手架（工作流改造 · 杠杆 A）
 * ══════════════════════════════════════════════════════════════════════════
 *  它解决什么
 * ══════════════════════════════════════════════════════════════════════════
 *  本项目有一条硬纪律：**每处修复都要配一组"只打它那一条"的变异**（变异既验收代码，
 *  也验收契约本身）。但过去每一轮都**临时手写**一个变异脚本 —— 于是同一类错误被反复踩：
 *
 *   | 事故 | 形态 | 代价 |
 *   |---|---|---|
 *   | D14 实测 | 还原从"本次运行开始时的文件"取 → 一次还原失败就把变异**洗进基线**，之后每次复核都是自欺 | 误读一整轮结论 |
 *   | D14 实测 | 实现一搬家（分类搬进 `brain.classifySegments`），旧锚点命中 0 次，脚本抛错却**照样跑完** | 看起来像"没拦住" |
 *   | 第 40 轮 | 探针 `tail -60` 把中段断言截掉 → M1–M7 全被误报"没拦住" | 差点去改一个对的实现 |
 *   | 第 47 轮 | 探针的 cwd 搞错 → 测试跑在**没被改过**的仓库上，8 组全假绿 | 同上 |
 *   | 第 42 轮 | 镜像排除 `node_modules` → 挂载失败被读成"拦住" | 四个变异全是假红 |
 *   | D12a 实测 | 用 `node --check` 验"语法合法"，而它按 CJS 解析，悬空 `return` 也报 OK | 语法闸门形同虚设 |
 *
 *  这些坑的共同点是：**探针自己会说谎，而且方向往往是"谎报防线失效"** —— 比"谎报通过"
 *  更难分辨。所以本文件把六条纪律**焊进工具**，而不是继续写在文档里等人自觉。
 *
 *  ══════════════════════════════════════════════════════════════════════════
 *  六条焊死的纪律
 *  ══════════════════════════════════════════════════════════════════════════
 *  ① **pristine 开局冻结，还原只从 pristine 取** —— 绝不从"当前工作树"取（那会把变异洗进基线）。
 *     每轮开跑前先自检"工作树 == pristine"，不一致就拒绝开跑并提示 `--restore`。
 *  ② **判"变异生效"比工作树哈希** —— 不许用 `shasum -c pristine.sha`（那验的是 pristine
 *     自己那几份，永远 OK，是本项目实测踩过的假绿）。
 *  ③ **锚点命中数 ≠ count → `INVALID`** —— 不跑测试、不进统计。锚点失效必须是一条**硬失败**，
 *     不能混进"拦住 / 没拦住"的统计里冒充结论。
 *  ④ **探针不截断输出** —— 捕获完整 stdout/stderr，同时看**失败行**与**退出码**；
 *     沙箱层恒 `exit 0`，所以那一层必须解析文本（`结果：N 通过 / M 失败`）。
 *  ⑤ **打印输入基数** —— 每轮打印扫到的契约段数 / 用例数；基数低于下限即报错，
 *     这是"在真空里通过"的唯一防线。
 *  ⑥ **语法用真解析器验，不用 `node --check`** —— 走 `vm.SourceTextModule`（只解析不执行），
 *     它对 ESM 是权威的；且**不执行**被测文件（`check-wb.mjs` 一 import 就会跑起来）。
 *
 *  另有两条工程细节（第 28 / 44 轮踩过）：
 *    · 本工具**在工作树上就地变异**（不进 /tmp 镜像）—— 因此**不会**把 `config.json`/`.env`
 *      复制到 /tmp；node_modules 天然在位，不存在"缺 ws 被读成拦住"的假红。
 *    · 代价是必须**保证还原**：用 try/finally + 逐文件哈希复核；万一进程被杀，
 *      下一次运行会因"工作树 ≠ pristine"而拒绝开跑，用 `--restore` 一条命令复原。
 *
 *  ══════════════════════════════════════════════════════════════════════════
 *  用法
 *  ══════════════════════════════════════════════════════════════════════════
 *    node scripts/mutate.mjs <plan.mjs> [--layer check-wb|smoke|sandbox|panel|none]
 *                                     [--only M1,M3] [--timeout 600] [--json]
 *    node scripts/mutate.mjs --restore          # 从 pristine 复原所有文件
 *    node scripts/mutate.mjs --selftest         # 自证：一条必被拦住 + 一条必不被拦住
 *
 *  plan.mjs 是**纯数据**（不含执行逻辑），默认导出：
 *
 *    export default [
 *      { id: 'M1',
 *        file: 'src/working-memory.js',           // 相对仓库根
 *        anchor: /if \(!turn\) return kept;/,     // 施加前必须命中，且命中数 == count
 *        count: 1,
 *        apply: (src) => src.replace(...),        // 不可变：返回新字符串
 *        layer: 'check-wb',                       // 该变异该由哪一层拦住
 *        expect: 'BLOCKED',                       // 'BLOCKED' | 'NOT-BLOCKED'
 *        note: '§35 空轮判据' },
 *    ];
 *
 *  退出码：0 = 全部符合 expect；1 = 有 BLOCKED/NOT-BLOCKED 与 expect 不符；2 = 环境或自证失败。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORK = process.env.QQBOT_MUTATE_WORK || path.join('/tmp', 'qqbot-mutate');
const PRISTINE = path.join(WORK, 'pristine');

// ─────────────────────────────────────────────────────────────────────────────
// 小工具
// ─────────────────────────────────────────────────────────────────────────────

const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');
const abs = (p) => path.resolve(ROOT, p);
const say = (...a) => console.log(...a);

function parseArgs(argv) {
  const o = { plan: '', layer: '', only: [], timeout: 600, json: false, restore: false, selftest: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--layer') o.layer = argv[++i];
    else if (a === '--only') o.only = String(argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--timeout') o.timeout = Number(argv[++i]) || 600;
    else if (a === '--json') o.json = true;
    else if (a === '--restore') o.restore = true;
    else if (a === '--selftest') o.selftest = true;
    else if (!a.startsWith('--')) o.plan = a;
  }
  return o;
}

/**
 * ESM 语法闸门：真解析器，**只解析不执行**。
 *
 * 为什么不用 `node --check`：在没有 `package.json` 的目录里它按 CJS 解析 ——
 * 本项目实测（D12a）一份带悬空 `return` 的 ESM 文件它照样报 OK，而 `import()` 当场
 * `SyntaxError`。用 `vm.SourceTextModule` 构造一次才是权威判据，且**不会执行**被测模块
 * （`check-wb.mjs` 一旦被 import 就会真的跑起来）。
 */
function syntaxOk(file) {
  // ⚠️ 只对 ESM 生效。对 `.html` 之类的文件跑 ESM 解析器会**永远报"语法不合法"**
  //    （本机实测：拿 `panel/parts/14-script.html` 跑，得到 `Unexpected token '<'`），
  //    而"文件加载不了"看着就像"被拦住了" —— 正是本工具要防的那种假象。
  if (!/\.(js|mjs)$/.test(file)) return { ok: true, skipped: '非 JS 文件，跳过语法闸门' };
  const src = fs.readFileSync(file, 'utf8');
  const probe = [
    "const vm=require('node:vm');const fs=require('node:fs');",
    "const src=fs.readFileSync(process.argv[1],'utf8');",
    "try{new vm.SourceTextModule(src);console.log('OK');}catch(e){console.log('ERR:'+e.message);}",
  ].join('');
  const r = spawnSync(process.execPath, ['--experimental-vm-modules', '-e', probe, file], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  if (out.includes('OK')) return { ok: true };
  return { ok: false, why: (out.match(/ERR:[^\n]*/) || ['解析失败'])[0] };
}

// ─────────────────────────────────────────────────────────────────────────────
// 层运行器：命令 + 判读
// ─────────────────────────────────────────────────────────────────────────────

const LAYERS = {
  'check-wb': { cmd: 'node', args: ['scripts/check-wb.mjs'], why: '契约层' },
  smoke: { cmd: 'node', args: ['test/smoke.js'], why: '动态层' },
  sandbox: { cmd: 'bash', args: ['test/sandbox.sh', '--run'], why: '沙箱全量（presets + panel）' },
  panel: { cmd: 'bash', args: ['test/sandbox.sh', '--run'], why: '沙箱（只看面板那一行）' },
  none: null,
};

/**
 * 判读「这一层有没有被这个变异打红」。
 *
 * ⚠️ 纪律 ④：**只用完整输出**判读，绝不 `tail`/`head` 截断 ——
 * 第 40 轮实测：`tail -60` 把中段的 T57–T66 截掉，7 组变异被误报"没拦住"。
 * ⚠️ 沙箱层**恒 `exit 0`**（脚本跑完测试就 exit 0），所以那一层必须解析文本。
 */
function judge(layer, code, out) {
  if (layer === 'check-wb') {
    const marks = (out.match(/^✗/gm) || []).length;
    return { blocked: code !== 0 || marks > 0, why: marks ? `${marks} 行 ✗` : `exit=${code}` };
  }
  if (layer === 'smoke') {
    const crash = (out.match(/自测异常[^\n]*/g) || [])[0];
    if (crash) return { blocked: true, why: `自测异常：${crash.slice(0, 60)}` };
    const list = (out.match(/^ {2}- T\d/gm) || []).length;
    return { blocked: code !== 0 || list > 0, why: list ? `${list} 条失败用例` : `exit=${code}` };
  }
  if (layer === 'sandbox' || layer === 'panel') {
    const pairs = [...out.matchAll(/(结果|面板验证)：(\d+) 通过 \/ (\d+) 失败/g)]
      .map((m) => ({ name: m[1], pass: Number(m[2]), fail: Number(m[3]) }));
    const wanted = layer === 'panel' ? pairs.filter((p) => p.name === '面板验证') : pairs;
    const bad = wanted.filter((p) => p.fail > 0);
    if (!wanted.length) return { blocked: false, why: '⚠️ 没有解析到结果行（可能沙箱没起来）—— 基数异常' };
    return {
      blocked: bad.length > 0,
      why: bad.length ? bad.map((p) => `${p.name} ${p.fail} 失败`).join(' · ') : wanted.map((p) => `${p.name} ${p.pass} 通过`).join(' · '),
    };
  }
  return { blocked: false, why: '未指定层' };
}

/** 跑一层，**不截断**输出。 */
function runLayer(layer, timeout) {
  const spec = LAYERS[layer];
  if (!spec) return { code: 0, out: '' };
  const r = spawnSync(spec.cmd, spec.args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024, // 不截断：读全
    timeout: timeout * 1000,
  });
  return { code: r.status ?? -1, out: `${r.stdout || ''}${r.stderr || ''}` };
}

/**
 * 输入基数（纪律 ⑤）：把它打出来，"在真空里通过"才看得见。
 * 本项目实测过：扫描对象为空时契约会对着空集合打印"0 违规"，一路绿。
 */
function cardinality(layer, out) {
  if (layer === 'check-wb') {
    const m = out.match(/跑了 (\d+) 段契约/);
    const has = Number(m?.[1] || 0);
    const min = Number((fs.readFileSync(abs('scripts/check-wb.mjs'), 'utf8').match(/MIN_CONTRACTS = (\d+)/) || [])[1] || 0);
    return { value: has, min, label: '契约段数' };
  }
  if (layer === 'smoke') {
    const m = out.match(/(\d+)\/(\d+) 通过/);
    return { value: Number(m?.[1] || 0), min: 1, label: '用例数' };
  }
  // 沙箱层：把"面板验证 / 结果"里通过的数量当基数。**必须 > 0** ——
  // 0 说明那一层根本没跑起来（沙箱没起来 / 解析不到结果行），此时任何"没拦住"都是假的。
  if (layer === 'sandbox' || layer === 'panel') {
    const nums = [...out.matchAll(/(?:结果|面板验证)：(\d+) 通过/g)].map((m) => Number(m[1]));
    const value = nums.length ? Math.max(...nums) : 0;
    return { value, min: 1, label: '沙箱用例数' };
  }
  return { value: 0, min: 0, label: '' };
}

// ─────────────────────────────────────────────────────────────────────────────
// pristine：冻结、自检、还原
// ─────────────────────────────────────────────────────────────────────────────

function freeze(files) {
  fs.mkdirSync(PRISTINE, { recursive: true });
  const man = {};
  for (const f of files) {
    const dst = path.join(PRISTINE, f);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(abs(f), dst);
    man[f] = sha(dst);
  }
  fs.writeFileSync(path.join(WORK, 'pristine.json'), JSON.stringify(man, null, 2));
  return man;
}

function loadManifest() {
  const f = path.join(WORK, 'pristine.json');
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
}

/** 工作树 vs pristine：返回不一致的文件列表（纪律 ①）。 */
function drift(man) {
  const bad = [];
  for (const [f, h] of Object.entries(man || {})) {
    const p = abs(f);
    if (!fs.existsSync(p) || sha(p) !== h) bad.push(f);
  }
  return bad;
}

function restore(man) {
  const done = [];
  for (const f of Object.keys(man || {})) {
    const src = path.join(PRISTINE, f);
    if (!fs.existsSync(src)) continue;
    fs.copyFileSync(src, abs(f));
    done.push(f);
  }
  return done;
}

// ─────────────────────────────────────────────────────────────────────────────
// 主流程
// ─────────────────────────────────────────────────────────────────────────────

function selftestPlan() {
  // 目标层选**当前仓库里已经存在、且与我手工验证过一致的**那一段（D14 的契约 §40），
  // 这样自证不依赖"某个补丁有没有收"，任何时刻都能跑。
  //
  // ① 必被拦住：把令牌判据改成恒假 —— D14 手工跑过这一条，§40 的行为子判据必须报红。
  // ② 必不被拦住：只加一行注释 —— 哈希变了（证明"生效判据"不是恒真），但任何断言都不读注释。
  return [
    {
      id: 'SELF-BLOCKED',
      file: 'src/custom-faces.js',
      anchor: /export function isCustomFaceToken\(id\) \{/,
      count: 1,
      apply: (s) => s.replace('export function isCustomFaceToken(id) {', 'export function isCustomFaceToken(id) {\n  if (id) return false;'),
      layer: 'check-wb',
      expect: 'BLOCKED',
      note: '自证用：§40 令牌判据必须红',
    },
    {
      id: 'SELF-PASS',
      file: 'src/custom-faces.js',
      anchor: /export function describeCustomFace\(entry\) \{/,
      count: 1,
      apply: (s) => s.replace(
        'export function describeCustomFace(entry) {',
        '// 变异自证：只加一行注释（任何断言都不读注释）\nexport function describeCustomFace(entry) {'
      ),
      layer: 'check-wb',
      expect: 'NOT-BLOCKED',
      note: '自证用：必须不红（证明探针能报 NOT-BLOCKED）',
    },
  ];
}

async function main() {
  const opt = parseArgs(process.argv.slice(2));

  // ── --restore：一条命令复原 ──────────────────────────────────────────────
  if (opt.restore) {
    const man = loadManifest();
    if (!man) {
      say('✗ 没有找到 pristine 清单，无法复原');
      process.exit(2);
    }
    const done = restore(man);
    const left = drift(man);
    say(`已从 pristine 复原 ${done.length} 个文件`);
    say(left.length ? `✗ 复原后仍不一致：${left.join(', ')}` : '✓ 复原复核通过（工作树 == pristine）');
    process.exit(left.length ? 2 : 0);
  }

  // ── 取变异清单 ──────────────────────────────────────────────────────────
  let plan;
  if (opt.selftest) {
    plan = selftestPlan();
  } else {
    if (!opt.plan) {
      say('用法：node scripts/mutate.mjs <plan.mjs> [--layer …] [--only M1,M3] [--selftest] [--restore]');
      process.exit(2);
    }
    const mod = await import(pathToFileURL(abs(opt.plan)).href);
    plan = mod.default || mod.MUTATIONS || [];
  }
  if (opt.only.length) plan = plan.filter((m) => opt.only.includes(m.id));
  if (!plan.length) {
    say('✗ 变异清单为空 —— 拒绝在空集合上给结论（本项目"在真空里通过"的老毛病）');
    process.exit(2);
  }

  const files = [...new Set(plan.map((m) => m.file))];

  // ── 纪律 ①：冻结 pristine + 自检工作树 ──────────────────────────────────
  const man = freeze(files);
  say(`══ mutate.mjs · ${opt.selftest ? '--selftest' : rel(abs(opt.plan))} ══`);
  say(`pristine 冻结：${files.length} 个文件 → ${PRISTINE}`);
  const bad = drift(man);
  if (bad.length) {
    say(`✗ 冻结之后工作树就与 pristine 不一致：${bad.join(', ')}`);
    process.exit(2);
  }

  // ── 基线：先证明"没变异时这一层是绿的"，并取输入基数 ────────────────────
  const layersUsed = [...new Set(plan.map((m) => opt.layer || m.layer || 'none'))].filter((l) => l !== 'none');
  const base = {};
  for (const layer of layersUsed) {
    const t0 = Date.now();
    const { code, out } = runLayer(layer, opt.timeout);
    const j = judge(layer, code, out);
    const c = cardinality(layer, out);
    base[layer] = { green: !j.blocked, cardinality: c, secs: ((Date.now() - t0) / 1000).toFixed(1) };
    const cardTxt = c.label ? `${c.label} ${c.value}${c.min ? `（下限 ${c.min}）` : ''}` : '（无基数）';
    say(`基线 ${layer}：${j.blocked ? `✗ 不是全绿（${j.why}）` : '✓ 全绿'} · ${cardTxt} · ${base[layer].secs}s`);
    if (c.min && c.value < c.min) {
      say(`✗ ${layer} 的输入基数 ${c.value} 低于下限 ${c.min} —— 拒绝在此基数上下结论`);
      process.exit(2);
    }
    if (j.blocked) {
      say(`✗ 基线本身不是绿的（${j.why}）—— 先修基线，变异结论才有意义`);
      process.exit(2);
    }
  }

  // ── 逐个变异 ─────────────────────────────────────────────────────────────
  const rows = [];
  const invalid = [];
  try {
    for (const m of plan) {
      const f = abs(m.file);
      const layer = opt.layer || m.layer || 'none';
      const before = sha(f);
      const src = fs.readFileSync(f, 'utf8');
      const anchor = m.anchor instanceof RegExp ? m.anchor : new RegExp(m.anchor, 'm');
      const hits = (src.match(new RegExp(anchor.source, anchor.flags.includes('g') ? anchor.flags : `${anchor.flags}g`)) || []).length;
      const want = m.count == null ? 1 : m.count;

      // 纪律 ③：锚点命中数不对 → INVALID（硬失败，不进统计，不跑测试）
      if (hits !== want) {
        invalid.push({ id: m.id, why: `锚点命中 ${hits}/${want}（实现可能已搬家）`, note: m.note || '' });
        say(`\n${m.id}  ${m.note || ''}`.trimEnd());
        say(`  ⛔ INVALID：锚点命中 ${hits}/${want} —— 本次结果无效（不是"没拦住"）`);
        continue;
      }

      let mutated;
      try {
        mutated = m.apply(src);
      } catch (e) {
        invalid.push({ id: m.id, why: `apply 抛错：${e.message}`, note: m.note || '' });
        say(`\n${m.id}  ${m.note || ''}`.trimEnd());
        say(`  ⛔ INVALID：apply 抛错 ${e.message}`);
        continue;
      }

      // 纪律 ②：比**工作树**哈希（不是比 pristine 副本）
      if (mutated === src) {
        invalid.push({ id: m.id, why: '施加后内容未变（这个变异是惰性的）', note: m.note || '' });
        say(`\n${m.id}  ${m.note || ''}`.trimEnd());
        say('  ⛔ INVALID：内容未变 —— 这个变异什么都没改');
        continue;
      }
      fs.writeFileSync(f, mutated);
      const applied = sha(f) !== before;

      // 纪律 ⑥：语法用真解析器（不执行；非 JS 文件跳过）
      const syn = syntaxOk(f);
      if (!syn.ok) {
        invalid.push({ id: m.id, why: `语法不合法：${syn.why}`, note: m.note || '' });
        say(`\n${m.id}  ${m.note || ''}`.trimEnd());
        say(`  ⛔ INVALID：语法不合法（${syn.why}）—— "文件加载不了"看着像被拦住，其实什么都没验到`);
        fs.copyFileSync(path.join(PRISTINE, m.file), f);
        continue;
      }

      // 跑层（纪律 ④：完整输出；同时看失败行与退出码）
      const { code, out } = runLayer(layer, opt.timeout);
      const j = judge(layer, code, out);
      const got = j.blocked ? 'BLOCKED' : 'NOT-BLOCKED';
      const expect = m.expect || 'BLOCKED';
      rows.push({ id: m.id, note: m.note || '', layer, got, expect, ok: got === expect, why: j.why, applied });

      say(`\n${m.id}  ${m.note || ''}`.trimEnd());
      say(`  ${got === expect ? '✓' : '✗'} ${got}（期望 ${expect}）· ${j.why}`);
      say(`  锚点 ${hits}/${want} · 生效 ${applied ? '✓' : '✗'} · 语法 ✓`);

      // 纪律 ①：还原**只从 pristine 取**
      fs.copyFileSync(path.join(PRISTINE, m.file), f);
    }
  } finally {
    // 无论如何都要还原：进程被杀时下一次运行会因 drift 拒绝开跑，可用 --restore 复原
    for (const f of files) {
      const src = path.join(PRISTINE, f);
      if (fs.existsSync(src)) fs.copyFileSync(src, abs(f));
    }
    const left = drift(man);
    say(`\n${left.length ? `✗ 未能完全还原：${left.join(', ')}（请跑 --restore）` : '✓ 已还原并复核（工作树 == pristine）'}`);
    if (left.length) process.exitCode = 2;
  }

  // ── 汇总 ────────────────────────────────────────────────────────────────
  const okCount = rows.filter((r) => r.ok).length;
  say('\n' + '─'.repeat(62));
  for (const r of rows) say(`${r.ok ? '✓' : '✗'} ${r.id.padEnd(22)} ${r.got.padEnd(12)} ${r.why}`);
  const cards = Object.entries(base).map(([l, v]) => `${l} ${v.cardinality.value}${v.cardinality.label}`).join(' / ');
  say(`结果：符合期望 ${okCount}/${rows.length} · INVALID ${invalid.length}（输入基数：${cards || '无'}）`);
  for (const i of invalid) say(`  ⛔ ${i.id}：${i.why}${i.note ? ` · ${i.note}` : ''}`);
  if (invalid.length) say('⛔ 本轮含 INVALID —— 其结论**不计入**上面这行，请先修锚点再下结论');

  if (opt.json) say(JSON.stringify({ rows, invalid, base }, null, 2));
  process.exit(invalid.length || okCount !== rows.length ? 1 : 0);
}

main().catch((e) => {
  console.error('mutate.mjs 异常:', e.message);
  process.exit(2);
});
