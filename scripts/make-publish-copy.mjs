#!/usr/bin/env node
/**
 * 生成一份**可安全外发/发布**的代码拷贝（B-K3 · 2026-09-27 立）。
 *
 * ⚠️ 为什么不用「按路径名排除」的 rsync 清单：
 *    2026-09-27 实测照着旧清单（`docs/PUBLISH-CHECKLIST.md` §3 的历史写法）做了一份，
 *    产物**逐文件复扫**后发现 **21 个文件命中真实标识符**，其中包括：
 *      · `.env`                          —— **机器人真实 QQ 号**（最严重）
 *      · `.backup/snapshots/**`          —— 真实群号
 *      · `panel/style-profile.json`      —— 3 个真实群号 + 真实群友 QQ
 *    根因：那份清单按**路径名**排除，而"哪些是运行时数据"只有 `.gitignore` **按语义**表达过。
 *    按名字列清单必然漏掉没想到的那些 —— `.env` 就是典型：它**被 gitignore**，
 *    所以任何**基于 git** 的流程都不会带它，但**基于文件系统**的 rsync 会。
 *
 * → 改为**以 `git ls-files` 为准**：只拷被追踪的文件。
 *    `.gitignore` 的语义被自动继承，且**将来新增的运行时文件默认安全**
 *    （不需要有人记得回来加一条 exclude —— 这类"记得"从来不可靠）。
 *
 * 用法：
 *   node scripts/make-publish-copy.mjs <目标目录>
 *   （原 `--with-handoff` 开关已在第 14 轮按 R11-d1 裁决删除：它读的 `docs/HANDOFF.md` 不存在）
 *
 * 退出码：0 = 干净；1 = 产物里仍命中已知标识符（**必须处理，不要忽略**）。
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// 已知真实标识符的**单一来源**（本文件因此**不含**任何真值）。
// ⚠️ 2026-10-05（S-01）：表本体已搬去**仓库外**（默认 `~/.qqbot/known-real.local.mjs`）——
//    这个 import 拿到的是**加载器**；加载不到时 `KNOWN_REAL === []`，下面会**告警**。
import { KNOWN_REAL, KNOWN_REAL_LOADED, KNOWN_REAL_SOURCE } from './known-real.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * ── 发布面的 `docs/` **白名单**（H-12 · 2026-10-05 · 第 11 轮）────────────────
 *
 * 发布机制由用户裁决为「**生成对外拷贝**」（接手件 R10-d1）⇒ `docs/` 里哪些文件会随公开仓库
 * 出去，必须由**一处**说了算。此前只有下面 EXCLUDE 里逐个点名的四个，于是 `docs/` 顶层那
 * 20 份逐轮交付 HTML 与 6 份内部台账**会被一起发出去** —— 那正是审查报告的 H-12。
 *
 * 规则改成**白名单**：只有通用技术文档随拷贝发布，`docs/` 下其余一律排除（fail-closed）。
 * ⚠️ 名单本体住在**零依赖叶子** `scripts/lib/publish-docs.mjs` 里（不是本文件）——
 *    理由：本文件**一 import 就跑**（读 argv、没目标目录就 exit），
 *    `scripts/check-wb.mjs` §71 没法 import 它做双向核对；抽成叶子后两个消费者读**同一份**。
 */
import { DOCS_KEEP, isHeldBackDoc } from './lib/publish-docs.mjs';

/**
 * 追踪清单之外**还要排除**的项。
 * 判据只有一条：**它按设计就持有真实标识符**（是"防抄回"的哨兵表或真实值对照表）。
 */
const EXCLUDE = [
  '.workbuddy/',                    // 项目记忆：REFERENCE.md 含真实机器人 QQ 号
  // ⚠️ 下面三条 `docs/` 条目在 H-12 的 `DOCS_KEEP` 白名单生效后**已是冗余**（它们都不在白名单内，
  //    本就会被 `docs/` 规则排除）。**留着是刻意的**：① 它们被 `check-wb` §34 的判据逐条钉着
  //    （"按设计持有真值"那条理由与 `docs/` 白名单那条是**两种不同的理由**，不该被白名单吃掉）；
  //    ② 万一将来有人误把它们加进 `DOCS_KEEP`，这里仍是第二道闸。
  'docs/PUBLISH-CHECKLIST.md',      // 按设计记录真实群号（去标识的对照表）
  'docs/HANDOFF.md',                // 项目级接班文件：含真实标识符
  // 2026-10-01 清理轮：归档件整体搬到 `docs/archive/`（含 v1/v2 旧计划），
  // 于是这里从"逐个点名三个文件"改成**点名一个目录** —— 以后再归档什么，
  // 不必回来加行（"记得回来加一行"这种事从来不可靠，本项目已因此漏过 `.env`）。
  'docs/archive/',
  'docs/UPGRADE_PLAN-v3.md',        // 最终版优化报告：实测**含真实群友 QQ**（它仍留在顶层，是现行件）
  'scripts/publish-audit.mjs',      // 按设计持有真实标识符哨兵表
  // ⚠️ 2026-10-05（S-01）：`scripts/known-real.mjs` **从排除清单里移除了** ——
  //    它已改成**加载器**（表本体搬去仓库外），本身不含任何真值。
  //    不移除反而是缺陷：本文件 import 它，而它在拷贝里缺席 ⇒ 拷贝里的
  //    `make-publish-copy.mjs` **一 import 就崩**，且 `check-wb` §34 在拷贝上直接红
  //    （"别人 clone 下来能不能跑验收"在那份拷贝上反而验不了）。
];

/**
 * ── Q45 裁决①（2026-10-02）：被排除的文件里，有些是**验收门会去读**的 ──────────
 *
 * `scripts/check-wb.mjs` 第 34 节要读 `docs/PUBLISH-CHECKLIST.md`（核对"清单有没有指向脚本"），
 * 而那份文件按设计持有真实群号、在排除清单里。于是**对外拷贝上跑 check-wb 会直接 ENOENT 崩掉** ——
 * 也就是说"别人 clone 下来能不能跑验收"这件事在拷贝上验不了。
 *
 * 三条走法里用户选的是 **① 补桩核**：
 *  ① 给这些文件写一份**桩**（说清"原件为什么不在、去哪儿找"），check-wb 读得到、不再崩；
 *  ② ~~把第 34 节改成"缺失 → 记红 + 继续"~~ —— **未采纳**：那会放松"文件不存在即崩"这条既有纪律
 *     （一旦开了"缺了也能跑"的口子，将来任何门缺输入都只是记一行红，没人会去看）。
 *
 * ⚠️ 桩**不许含任何真值**：它自己也是产物里会被复扫的文件 ——
 *    在桩里抄一句真值，就等于给安全网开了一个它扫不出来的形状。
 * ⚠️ 桩只补"门会读"的那几个，**不扩大**：别的排除项保持"拷贝里根本没有它"，
 *    那才是"没有泄漏"最强的形态。
 */
const STUBS = {
  'docs/PUBLISH-CHECKLIST.md': [
    '# 发布到公开仓库 · 动作清单（对外拷贝里的**桩**）',
    '',
    '> 原件不在本拷贝里 —— 它**按设计**持有真实标识符（去标识的对照表与哨兵表），',
    '> 发布时按 `PUBLISH-CHECKLIST` 的口径整块排除。需要它请回原仓库取。',
    '',
    '本文件存在的唯一理由：`scripts/check-wb.mjs` 第 34 节会读它（核对"清单有没有指向脚本"），',
    '缺了它 check-wb 会 ENOENT 崩掉 —— 于是"别人 clone 下来能不能跑验收"在拷贝上验不了。',
    '补一份**不含任何真值**的桩，验收门就能照常跑（Q45 裁决①）。',
    '',
    '发布步骤（与原件同口径）：先跑 `node scripts/publish-audit.mjs`（退出码须为 0），',
    '再跑 `node scripts/make-publish-copy.mjs <目标目录>` 生成拷贝 —— 它以 `git ls-files` 为准；',
    '**不要**改用"按路径名排除"的 rsync 清单（实测漏过 `.env` 等 21 个文件）。',
    '',
    '⚠️ 本桩的头一行是 `check-wb` 判定"这是发布拷贝而不是内部仓"的**唯一依据**',
    '（第 22 轮加）：拷贝里按设计没有 `publish-audit.mjs` / `docs/archive/` /',
    '`ARCHIVE.md` / `DEEP-IMPROVE.md` / `.git/hooks/`，那几条判据据此换成**反向断言**。',
    '⚠️ 因此**头一行那串字不许改** —— 改了会让拷贝重新报 4 条假红。',
  ].join('\n'),
};

/**
 * 已知真值 → 占位符。**安全网**：被追踪的文件本该已经去标识，扫到变化说明有人抄回来了。
 *
 * ⚠️ 真值**不在本文件里** —— 表来自 `scripts/known-real.mjs`（单一来源，表本体住在**仓库外**）。
 *   理由：它同时被 `publish-audit.mjs` 消费；抄两份必然漂移，
 *   而且**每一份拷贝都是一个泄漏口**（2026-09-27 实测：本文件第一版把真值硬编码进 `KEYS`，
 *   于是 `publish-audit` 当场报 5 项阻断 —— 审计把新脚本扫了出来）。
 * 只对**表里声明了 placeholder** 的项做替换（没声明的不猜）。
 * ⚠️ 表加载不到 → `SCRUB` 是空的、去标识**不工作**：下面会**显眼告警**，不许静默降级。
 */
const SCRUB = KNOWN_REAL.filter((k) => k.placeholder).map((k) => [k.re, k.placeholder]);

// ── 哨兵表未加载 = 去标识安全网降级（S-01 · 2026-10-05）────────────────────
//   空表不是"干净"，是"这道闸不工作了"：产物复扫里"已知标识符"一类的输入是空集合，
//   它会**在真空里通过**（本项目头号风险）。真值表按设计住在仓库外，所以这里**不阻断**
//   （否则任何人 clone 下来跑这个工具都会红），但必须把话说明白。
if (!KNOWN_REAL_LOADED) {
  console.log('');
  console.log('⚠️ ────────────────────────────────────────────────────────────');
  console.log(`⚠️ 真值哨兵表**未加载**（找不到 ${KNOWN_REAL_SOURCE}）：`);
  console.log('⚠️   本次"已知真值 → 占位符"的去标识与产物复扫里"已知标识符"一类**都不生效**。');
  console.log('⚠️   产物**仍可能带真值**（凭据形态一类仍会扫，但号码/用户名不在其列）。');
  console.log('⚠️   请把哨兵表放到该路径（或设 QQBOT_KNOWN_REAL）后重跑，再考虑外发。');
  console.log('⚠️ ────────────────────────────────────────────────────────────');
  console.log('');
}

// 2026-10-04 审查轮（n-6）：这两条**搬去 `credential-shapes.mjs` 了** ——
// 因为 `publish-audit.mjs`（源头审计）也该用同一份；只装在链路的一边
// 会出现"产物复扫会拦、发布前体检却一路放行"的别扭形状。
// ⚠️ 判据内容一字未改，只是不再住在这里（单一来源纪律）。
import { PLACEHOLDER_RE, EXTRA_CREDENTIAL_SHAPES as EXTRA } from './credential-shapes.mjs';

const dest = process.argv[2];
if (!dest) {
  console.error('用法：node scripts/make-publish-copy.mjs <目标目录>');
  process.exit(2);
}
const DEST = path.resolve(dest);
if (DEST === ROOT || ROOT.startsWith(`${DEST}${path.sep}`)) {
  console.error(`✗ 目标目录不能是本仓库本身或它的上级：${DEST}`);
  process.exit(2);
}

// ── 取追踪清单 ──
// ⚠️ 必须 `-z`：中文/特殊字符路径默认会被 git 用 C 风格转义加引号包起来
//    （`"test/fixtures/…/\347\244\272…/index.js"`），按行切会拿到不存在的路径。
const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
  .split('\0').filter(Boolean);
// H-12：`docs/` 只发 `DOCS_KEEP` 白名单里的通用技术文档，其余（逐轮交付 HTML / 内部台账 /
// 外包回执 / 归档件）一律排除。判据要**落在这一处**：`check-wb` §71 有双向核对盯着它。
const keep = tracked.filter((f) => {
  if (EXCLUDE.some((e) => f === e || f.startsWith(e))) return false;
  if (isHeldBackDoc(f)) return false;   // H-12：docs/ 只发白名单里的通用技术文档
  return true;
});

/**
 * 这个文件是不是二进制 —— **判据是内容，不是扩展名**（扩展名可以撒谎）。
 *
 * ⚠️ 为什么要单独判（2026-10-07 修 · 真事故）：
 *   原实现对**每个**文件都做 `readFileSync(src, 'utf8')` 再 `Buffer.from(t, 'utf8')`。
 *   而**用 utf8 读二进制不会抛错**，只会把非法字节替换成 U+FFFD（`ef bf bd`）——
 *   于是每一次发布都会把所有二进制文件（图标 PNG、.icns…）**逐字节损坏**：
 *   76462 字节的 PNG 出来 137357 字节、文件头被破坏 ⇒ GitHub README 上裂图。
 *   `catch { fs.readFileSync(src) }` 那条"二进制直接拷"的正路**永远走不到**。
 *
 * 判据：前 8 KB 里出现 NUL 字节 ⇒ 二进制（Git 自己的启发式同款）。
 * 扩展名只作补充，且只加常见的（png/icns/woff…）—— 两者取或。
 */
const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.icns', '.pdf', '.zip', '.gz',
  '.woff', '.woff2', '.ttf', '.otf', '.mp3', '.mp4', '.webm', '.mov', '.wasm',
  '.so', '.dylib', '.node', '.jar', '.bin', '.jks', '.keystore', '.db',
]);
function isBinaryFile(abs) {
  if (BINARY_EXT.has(path.extname(abs).toLowerCase())) return true;
  const fd = fs.openSync(abs, 'r');
  try {
    const len = Math.min(8192, fs.fstatSync(fd).size);
    const head = Buffer.alloc(len);
    fs.readSync(fd, head, 0, len, 0);
    return head.includes(0);
  } finally {
    fs.closeSync(fd);
  }
}

fs.rmSync(DEST, { recursive: true, force: true });
let scrubbed = 0;
for (const f of keep) {
  const src = path.join(ROOT, f);
  const dst = path.join(DEST, f);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  let buf;
  // ⚠️ 二进制**只按字节拷**：进过一次 utf8 就再也回不到原样了（见 isBinaryFile 的注释）。
  if (isBinaryFile(src)) {
    buf = fs.readFileSync(src);
  } else {
    const s = fs.readFileSync(src, 'utf8');
    const t = SCRUB.reduce((a, [re, to]) => a.replace(re, to), s);
    if (t !== s) { scrubbed += 1; console.log(`  ⚠️ 去标识：${f}`); }
    buf = Buffer.from(t, 'utf8');
  }
  fs.writeFileSync(dst, buf);
}
console.log(`拷入 ${keep.length} / ${tracked.length} 个追踪文件；排除 ${tracked.length - keep.length} 个`);
{
  const heldBack = tracked.filter((f) => isHeldBackDoc(f) && !EXCLUDE.some((e) => f === e || f.startsWith(e)));
  console.log(`  docs/：发布 ${DOCS_KEEP.filter((d) => keep.includes(d)).length} 份通用技术文档（H-12 白名单），`
    + `另排除 ${heldBack.length} 份内部件（逐轮交付件 / 台账 / 归档 / 发布清单）`);
}
if (scrubbed) console.log(`  （其中 ${scrubbed} 个被顺带去标识 —— 说明仓库里有人把真值抄回来了，请单独排）`);

// ── Q45 裁决①：给"被排除、但验收门会去读"的文件补一份**桩** ──────────────
// 不补的话 `scripts/check-wb.mjs` 第 34 节会在拷贝上 ENOENT 崩掉 ——
// 于是"别人 clone 下来能不能跑验收"这件事，在要发布的那份拷贝上反而验不了。
// ⚠️ 桩也进产物复扫（下面那段扫的是 **DEST 全目录**），所以它不许含任何真值。
for (const [rel, text] of Object.entries(STUBS)) {
  const dst = path.join(DEST, rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.writeFileSync(dst, text);
  console.log(`  补桩：${rel}（原件按设计被排除；桩不含任何真值）`);
}

// ── 「可选：去标识的交接文档」已删除（R11-d1 裁决 · 第 14 轮）──
// 它挂在 `--with-handoff` 开关上，而第一条就读 `docs/HANDOFF.md` —— 那份文件
// **既不在磁盘、也不在 git**（两份接手须知早已合并进 `docs/DEEP-IMPROVE.md` 体系，
// 且 `docs/HANDOFF.md` 只剩 EXCLUDE 里的一行名字）⇒ **这个开关一用就 ENOENT**，是条死路。
// 裁决选项三选一（改读新路径 / 删开关 / 恢复文档）→ 选**删开关**：
//   ① 它装的四份里三份来自 `.workbuddy/memory/`（**已移出版本控制**），外发它们与
//      `.gitignore` 的既定边界相冲突；② 真要外发交接材料，如今的正路是
//      `make-publish-copy.mjs` + 桌面那份交接件，不需要脚本里再留一条旁路。
// ⚠️ 连带：`.gitignore` 的 EXCLUDE 里那条 `docs/HANDOFF.md` **保留**（§34 逐条钉着，
//    且它是"按设计持有真值"的第二道闸，与"文件存不存在"是两件事）。

// ── 复扫：**扫到 0 才算完成** ──
// 判据：不许因为"我照清单做了"就当它干净 —— 必须对**产物**逐个文件核。
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
  const p = path.join(d, e.name);
  return e.isDirectory() ? walk(p) : [p];
});
const files = walk(DEST);
let bad = 0;
let notes = 0;
for (const f of files) {
  let s; try { s = fs.readFileSync(f, 'utf8'); } catch { continue; }
  const hits = [];
  // ① 已知真值：只报"它是什么"，**不把真值打出来** —— 这份报告本身也可能被人转发
  for (const k of KNOWN_REAL) {
    k.re.lastIndex = 0;
    const n = (s.match(k.re) || []).length;
    if (n) hits.push(`${k.what}（${n} 处）`);
  }
  // ② 表里没有的"像凭据"形态
  for (const [re, label] of EXTRA) {
    for (const m of s.matchAll(re)) {
      const v = m[0];
      if (PLACEHOLDER_RE.test(v)) { notes += 1; continue; } // 占位符：只提示，不失败
      hits.push(`${label}:${v.slice(0, 12)}…`);
    }
  }
  if (hits.length) { bad += 1; console.log(`✗ ${f.replace(`${DEST}/`, '')} → ${hits.join(' | ')}`); }
}
console.log(`\n产物：${DEST}`);
console.log(`复扫 ${files.length} 个文件 → ${bad === 0 ? '✅ 0 处已知标识符' : `✗ ${bad} 个文件仍命中（不要外发）`}`);
if (notes) console.log(`ℹ️ 另有 ${notes} 处「像凭据但明显是占位符」（字母表/数字表顺序），已按占位符放行 —— 若那不是占位符，请立刻来看`);
process.exit(bad === 0 ? 0 : 1);
