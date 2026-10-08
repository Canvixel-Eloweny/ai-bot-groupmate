#!/usr/bin/env node
/**
 * 变异清单的**静态锚点体检**（第 7 轮 · 2026-10-05）
 * ══════════════════════════════════════════════════════════════════════════
 *  它回答一个问题：**`test/mutations/` 里那 53 份清单，今天还跑得动吗？**
 * ══════════════════════════════════════════════════════════════════════════
 *
 *  为什么需要它
 *  ────────────
 *  这套清单是本项目「判据到底有没有盯住」的**唯一证据**（README 立档语）。
 *  而每条变异的锚点是**字面量** —— 实现一搬家、一改形状、一被删掉，
 *  命中数就不再等于 `count`。`scripts/mutate.mjs` 把那件事报成 **INVALID 硬失败**
 *  （六条纪律之③），于是那一条**拿不到结论**：
 *  它既不是"拦住了"也不是"没拦住"，而人极容易读成后者（"防线没牙"）。
 *
 *  **实测（第 7 轮开工时）**：53 份 / 524 条里有 **35 条失效**，散在 8 个套件 ——
 *  也就是说那 8 份当时**一跑就拿不到干净结论**，而"变异覆盖"里有 35 条是账面上的。
 *
 *  更麻烦的是它**不会有任何东西报警**：四层回归全绿、发布审计 0 阻断、
 *  真机照常运行 —— 这正是本项目头号风险「改了不报错、回归还全绿」的形状。
 *  所以第 7 轮把它固化成量尺，并接进 `check-wb` 当常驻闸门（§70）。
 *
 *  与 `mutate.mjs` 的分工
 *  ────────────────────
 *    · **本脚本 = 静态层**：只数锚点命中数，**不跑任何测试**，秒级出结果。
 *      它管"这条变异**还可能施加**吗"。
 *    · `mutate.mjs` = 动态层：施加变异、跑那一层、判 BLOCKED / NOT-BLOCKED。
 *      它管"施加之后防线响不响"。
 *    两者是**串联**的：静态层先过，动态层的结论才有意义。
 *    本脚本的判断口径与 `mutate.mjs` 的第 ③ 条纪律**逐字相同**
 *    （含"正则补 `g` 再数"、"`count` 缺省为 1"），所以"这里说 INVALID 的，
 *    在 mutate 里一定也是 INVALID" —— 两处口径不许分叉（本项目头号纪律）。
 *
 *  用法
 *  ────
 *    node scripts/mutate-lint.mjs                # 全量体检
 *    node scripts/mutate-lint.mjs --json         # 机器可读
 *    node scripts/mutate-lint.mjs --selftest     # 自证：合格样本 0 报，投毒样本必报
 *
 *  退出码：0 = 0 条失效；1 = 有失效；2 = 环境/自证失败。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(REPO, 'test', 'mutations');

/**
 * 一条锚点在目标文件里的**命中数**。
 *
 * ⚠️ 与 `mutate.mjs` **逐字同口径**：正则统一补 `g` 再 `match`。
 *    漏了这一步的话，`/x/` 在 `'xx'` 上只算 1 次 → 本脚本会漏报
 *    "锚点写松了、命中 2 处"那一类（第 7 轮实测：b30 M6 是 3/1、M12 是 2/1）。
 */
function hitsOf(src, anchor) {
  const re = anchor instanceof RegExp ? anchor : new RegExp(anchor, 'm');
  return (src.match(new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`)) || []).length;
}

/**
 * 遍历一个目录下的全部变异清单，逐条比对"锚点命中数 vs `count`"，
 * 并顺手做一次**惰性体检**（施加后内容必须变）。
 *
 * 设计成**可注入**（`dir` / `readFile` / `exists`）是为了两件事：
 *   ① `--selftest` 能拿一个临时目录 + 投毒样本喂它（不碰真仓库）；
 *   ② `check-wb` §70 直接复用**同一份实现** —— 不许在那边再抄一遍判据
 *      （「同一份语义两份拷贝」是本项目清得最久的那类腐烂）。
 *
 * ⚠️ **惰性体检抓的是哪一类、抓不到哪一类**（写清楚，别假装它是硬闸）：
 *   · **抓得到**：`apply` 的目标文本已经不存在 → 整个函数变成空操作
 *     （第 7 轮实测 4 条：`b31 M6` / `d30 M8` / `d31-1 M4` / `d31-1 M5`。
 *      它们的**锚点全是对的** —— 锚点锚的是"附近还在的东西"，
 *      而 `apply` 锚的是"要改的那一句"，两者可以各自腐烂）。
 *   · **抓不到**：`apply` 里**多步替换只死了其中一步**（剩下的仍能改变内容）。
 *     例如 `A24-1` 第一步（删老的多行 `sleep` 块）已经命中 0，第二步（插诱饵注释）还活着 ——
 *     产物确实变了，但它**已经不是那个变异**了。
 *     这一类**静态查不出来**，只能靠"把它跑一遍看结论对不对"。
 *     ⇒ 所以第 7 轮除了本量尺，还把受影响的套件**逐个真跑**了一遍。
 *
 * @param {object} [o]
 * @param {string} [o.dir] 变异清单目录
 * @param {(p: string) => string} [o.readFile]
 * @param {(p: string) => boolean} [o.exists]
 * @returns {Promise<{files: number, total: number, bad: Array, noop: Array, plans: string[]}>}
 */
export async function lintAnchors(o = {}) {
  const dir = o.dir || DIR;
  const readFile = o.readFile || ((p) => fs.readFileSync(p, 'utf8'));
  const exists = o.exists || ((p) => fs.existsSync(p));
  const plans = fs.readdirSync(dir).filter((x) => x.endsWith('.mjs')).sort();
  const bad = [];
  const noop = [];
  let total = 0;

  for (const f of plans) {
    let plan;
    try {
      const mod = await import(pathToFileURL(path.join(dir, f)).href);
      plan = mod.default || mod.MUTATIONS || [];
    } catch (e) {
      // 清单一 import 就抛 = 整份跑不动。这**不是**"没拦住"，必须单独报。
      bad.push({ file: f, id: '(整份)', hits: 0, want: 0, target: '', why: `清单自身 import 失败：${e.message}` });
      continue;
    }
    for (const m of plan) {
      total += 1;
      const want = m.count == null ? 1 : m.count;
      const target = path.join(REPO, m.file || '');
      if (!m.file || !exists(target)) {
        bad.push({ file: f, id: m.id, hits: 0, want, target: String(m.file || '(缺 file 字段)'), why: '目标文件不存在' });
        continue;
      }
      const src = readFile(target);
      const hits = hitsOf(src, m.anchor);
      if (hits !== want) {
        bad.push({
          file: f, id: m.id, hits, want, target: m.file,
          why: `锚点命中 ${hits}/${want}`,
          anchor: String(m.anchor).slice(0, 78),
        });
        continue; // 锚点都不对，惰性体检没有意义（apply 的目标可能整段都不在）
      }
      // 惰性体检：施加之后内容必须变。与 `mutate.mjs` 的纪律②同口径。
      try {
        if (typeof m.apply === 'function' && m.apply(src) === src) {
          noop.push({ file: f, id: m.id, target: m.file, why: '施加后内容未变（这个变异是惰性的）' });
        }
      } catch (e) {
        noop.push({ file: f, id: m.id, target: m.file, why: `apply 抛错：${e.message}` });
      }
    }
  }
  return { files: plans.length, total, bad, noop, plans };
}

// ─────────────────────────────────────────────────────────────────────────────
// 自证（第 51 轮那条：扫描型判据上线前，先用**已知合格**的输入跑一遍）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 拿临时目录里造的**三条**清单喂 `lintAnchors`：
 *   · 一条**合格**（锚点在、count 也对、apply 真的改内容）→ 必须 0 报；
 *   · 一条**投毒·锚点**（锚点不存在）→ 必须报进 `bad`；
 *   · 一条**投毒·惰性**（锚点好端端的，`apply` 是空操作）→ 必须报进 `noop`。
 * 三条都要成立才叫"这个量尺不是恒真、也不是恒假"。
 *
 * ⚠️ **它必须与真仓库无关**（只吃一个临时目录）—— 因为 `check-wb` §70 要在**每次**
 *    check-wb 运行里调它，而 check-wb 会被 `mutate.mjs` 在**变异后的工作树**上调
 *    （见 §70 里那段"为什么不在这里做全仓扫描"）。喂真仓库的话，§70 就变成了
 *    变异测试自身的噪音源。**这就是它被抽成一个导出函数的理由。**
 *
 * @returns {{ok: boolean, lines: string[]}}
 */
export async function lintSelftest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mutate-lint-selftest-'));
  const L = [];
  try {
    fs.writeFileSync(path.join(tmp, 'ok.mjs'), [
      'export default [',
      "  { id: 'OK', file: 'package.json', anchor: /^\\{/m, count: 1, apply: (s) => s + '\\n// x', layer: 'check-wb', expect: 'BLOCKED' },",
      '];',
    ].join('\n'));
    fs.writeFileSync(path.join(tmp, 'poison-anchor.mjs'), [
      'export default [',
      "  { id: 'POISON', file: 'package.json', anchor: /ZZZ_THIS_ANCHOR_CANNOT_EXIST_ZZZ/, count: 1, apply: (s) => s + '// x', layer: 'check-wb', expect: 'BLOCKED' },",
      '];',
    ].join('\n'));
    fs.writeFileSync(path.join(tmp, 'poison-inert.mjs'), [
      'export default [',
      "  { id: 'INERT', file: 'package.json', anchor: /^\\{/m, count: 1, apply: (s) => s, layer: 'check-wb', expect: 'BLOCKED' },",
      '];',
    ].join('\n'));
    const r = await lintAnchors({ dir: tmp });
    const okBad = r.bad.filter((b) => b.id === 'OK').length;
    const okNoop = r.noop.filter((b) => b.id === 'OK').length;
    const poisonAnchor = r.bad.filter((b) => b.id === 'POISON').length;
    const poisonInert = r.noop.filter((b) => b.id === 'INERT').length;
    L.push(`扫到 ${r.files} 份 / ${r.total} 条 · 报出 锚点失效 ${r.bad.length} / 惰性 ${r.noop.length}`);
    L.push(`${okBad + okNoop === 0 ? '✓' : '✗'} 合格样本（锚点对、apply 真改）—— 报出 ${okBad + okNoop} 条（应为 0）`);
    L.push(`${poisonAnchor === 1 ? '✓' : '✗'} 投毒·锚点（锚点故意不存在）—— 报出 ${poisonAnchor} 条（应为 1）`);
    L.push(`${poisonInert === 1 ? '✓' : '✗'} 投毒·惰性（apply 是空操作）—— 报出 ${poisonInert} 条（应为 1）`);
    const baseOk = r.files === 3 && r.total === 3;
    if (!baseOk) L.push(`✗ 基数异常：扫到 ${r.files} 份 / ${r.total} 条（应为 3 / 3）`);
    const ok = baseOk && okBad + okNoop === 0 && poisonAnchor === 1 && poisonInert === 1;
    L.push(ok ? '✓ 自证通过：合格不误报 · 两类投毒各自必报（双向可见）'
      : '✗ 自证失败：这个量尺现在不可信（恒真或恒假），先修它再看真仓库的结论。');
    return { ok, lines: L };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--selftest')) {
    const r = await lintSelftest();
    console.log('── mutate-lint.mjs --selftest ──');
    for (const l of r.lines) console.log(l);
    process.exit(r.ok ? 0 : 2);
  }

  const r = await lintAnchors();
  if (argv.includes('--json')) {
    console.log(JSON.stringify({ files: r.files, total: r.total, bad: r.bad, noop: r.noop }, null, 2));
    process.exit(r.bad.length || r.noop.length ? 1 : 0);
  }
  console.log(`共 ${r.files} 份清单 · ${r.total} 条变异 · **锚点失效 ${r.bad.length} 条** · **惰性 ${r.noop.length} 条**`);
  for (const b of r.bad) {
    console.log(`  ✗ [锚点] ${b.file} ${b.id} · ${b.why} · ${b.target}${b.anchor ? ` · ${b.anchor}` : ''}`);
  }
  for (const b of r.noop) {
    console.log(`  ✗ [惰性] ${b.file} ${b.id} · ${b.why} · ${b.target}`);
  }
  if (r.bad.length || r.noop.length) {
    console.log('\n⇒ 这些条目在 `scripts/mutate.mjs` 里会被报成 **INVALID**（硬失败）——');
    console.log('  它们所在的套件**一跑就拿不到干净结论**。锚点是"实现所在的位置"，');
    console.log('  实现搬了就跟着搬；对象真被删了才退役（两数同向 + 逐条写理由）。');
    console.log('  ⚠️ 「惰性」那一类的成因不同：**锚点是对的，是 `apply` 里要改的那一句没了**');
    console.log('     —— 两者可以各自腐烂，所以两样都要查。');
  }
  process.exit(r.bad.length || r.noop.length ? 1 : 0);
}

/**
 * ⚠️ 「我是不是主模块」必须走 **realpath**（本项目第 68 条）——
 *    `path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)` 是纯字面比较，
 *    在符号链接路径下（macOS 的 `/tmp` → `/private/tmp` 是最常见的一例）两边字面不同，
 *    CLI 分支会被**静默跳过**：`exit 0`、无输出。而 `check-wb` 正是要 import 本文件 ——
 *    这个守卫写错，check-wb 会在 import 时把整个体检跑一遍再 `process.exit`。
 */
function isMain() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch { return false; }
}

if (isMain()) {
  main().catch((e) => {
    console.error('mutate-lint.mjs 异常:', e.message);
    process.exit(2);
  });
}
