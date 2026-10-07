/**
 * ══════════════════════════════════════════════════════════════════════
 *  真实缓存命中率：cached / prompt（第 45 轮 B12e-0）
 * ══════════════════════════════════════════════════════════════════════
 *  这个数在项目里**从来没人算过** —— 面板只把 `cached` 累加出来显示，
 *  「花费」页用 `h` 计价，但**从不除以 `p`**。所以"改提示词顺序到底有没有
 *  提升缓存命中"这件事一直只能靠感觉。
 *
 *  ────────────────────────────────────────────────────────────────────
 *  ⚠️ 它和 prompt-stats.json 那个「87%」**不是一回事**，别混
 *  ────────────────────────────────────────────────────────────────────
 *  两个指标同名不同义：
 *
 *  | | 来源 | 算法 | 覆盖 tools 吗 |
 *  |---|---|---|---|
 *  | `panel/prompt-stats.json` 的 ratio | 本地离线 | `lcp(上轮prompt, 本轮prompt) / min(长度)`，只看 `messages` 文本 | **不覆盖**（tools 不在 messages 里） |
 *  | 本脚本的 `h/p` | 服务端返回 | `sum(cached_tokens) / sum(prompt_tokens)` | 覆盖（服务端按整个请求前缀算） |
 *
 *  第 45 轮开工前就是靠这一条把方案推翻重做的：原打算用前者当判据，
 *  而它**根本量不到 tools** —— 照那个做实验会得出一个假的"没影响"。
 *
 *  ⚠️ 只读：不写任何留档、不碰 usage.jsonl 与 prompt-stats.json。
 *
 *  用法：
 *      node scripts/cache-hit.mjs            # 人读的表格
 *      node scripts/cache-hit.mjs --json     # 机器读，便于前后对比
 *      node scripts/cache-hit.mjs --since 2026-09-19
 */
import fs from 'node:fs';
import path from 'node:path';
import { USAGE_DIR, USAGE_FILE_RE } from '../panel/lib/paths.js';
// 日期键的唯一实现（第 13 轮 H-11）—— 这里曾自己拼一份，与 src 侧重复。
import { dayKeyOf } from '../src/holidays.js';

/**
 * 列出所有账本文件（**按月切分**，`panel/usage-YYYY-MM.jsonl`）。
 *
 * ⚠️ 「什么算账本文件」这条判据只有一处：`panel/lib/paths.js` 的 `USAGE_FILE_RE`。
 *    在这里另写一个 glob 就等于抄了第二份 —— 而那正是本项目反复在清的那类重复
 *    （改了一处、另一处还按旧规则认）。契约 12 节盯着这条 import。
 */
export function listUsageFiles(dir = USAGE_DIR) {
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => USAGE_FILE_RE.test(n))
    .sort()
    .map((n) => path.join(dir, n));
}

/**
 * 解析一行账本记录。坏行返回 null（**不抛**）——
 * 账本是 append-only 的，进程被 kill 时最后一行可能是半截 JSON，
 * 那种情况下"少算一条"远好过"整份统计跑不出来"。
 */
export function parseRow(line) {
  const s = String(line || '').trim();
  if (!s) return null;
  try {
    const r = JSON.parse(s);
    return r && typeof r === 'object' ? r : null;
  } catch {
    return null;
  }
}

/**
 * 老记录判定 —— **按字段存在性，不按行号、不按日期**。
 *
 * 背景：`cached`（`h`）这个字段是后来才加上的，加之前那 160 行的 `h` 全是 0。
 * 用"前 N 行"当判据会在文件重排、换月、或以后又加字段时立刻失效；
 * 而 `v`（服务商）与 `h` 是同一批加上的，所以「有没有 `v` 字段」是一条稳定的分界线。
 * ⚠️ `v: ''` 是**有效值**（未知渠道），所以判据用 `in` 而不是"真值非空"。
 */
export function isLegacyRow(rec) {
  return !rec || !('v' in rec);
}

/**
 * 聚合一组记录 → `{n, p, h, ratio}`。
 *
 * ⚠️ 加权而不是取平均：一轮 3000 token 的请求和一轮 300 token 的请求，
 *    对"整体命中率"的贡献本就不同。取算术平均会让短请求把数字带偏
 *    （而短请求恰好是命中率最低的那批 —— 前缀还没热起来）。
 *
 * ⚠️ `p === 0` 时 ratio 返回 `null` 而**不是 0**：分母为零是"这条记录没上报
 *    输入 token"，与"命中率为零"是两回事。混在一起会让首轮未命中的真实信号
 *    被一堆无意义记录稀释掉。
 */
export function aggregate(rows) {
  let n = 0;
  let p = 0;
  let h = 0;
  for (const r of rows || []) {
    if (!r) continue;
    const pp = Number(r.p) || 0;
    if (pp <= 0) continue;
    n += 1;
    p += pp;
    h += Number(r.h) || 0;
  }
  return { n, p, h, ratio: p > 0 ? h / p : null };
}

/** 按某个键分组后再聚合。键为空时归到 `(未知)`，不猜、不硬套当前配置。 */
export function groupBy(rows, keyOf) {
  const m = new Map();
  for (const r of rows || []) {
    const k = String(keyOf(r) ?? '').trim() || '(未知)';
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  }
  const out = [];
  for (const [k, arr] of m) out.push({ key: k, ...aggregate(arr) });
  out.sort((a, b) => b.p - a.p);
  return out;
}

/**
 * 账本记录的本地日期（账本里的 `t` 是毫秒时间戳）。
 * 日期键本身走 `src/holidays.js` 的**唯一实现**；这里只多做一件事：`t` 读不出来时
 * 归到「(无时间)」这一桶 —— 那是本脚本自己的分桶语义，不是日期键的一部分。
 */
export function dayOf(rec) {
  const t = Number(rec && rec.t);
  if (!Number.isFinite(t)) return '(无时间)';
  return dayKeyOf(new Date(t));
}

/** 读一批文件 → 记录数组（带 `__file` 便于排障）。 */
export function readRecords(files) {
  const rows = [];
  for (const f of files || []) {
    let text = '';
    try {
      text = fs.readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      const r = parseRow(line);
      if (r) rows.push({ ...r, __file: path.basename(f) });
    }
  }
  return rows;
}

const pct = (x) => (x === null || x === undefined ? '—' : `${(x * 100).toFixed(2)}%`);

function table(title, groups) {
  const lines = [`\n【${title}】`];
  if (!groups.length) {
    lines.push('  （无记录）');
    return lines;
  }
  const w = Math.max(...groups.map((g) => g.key.length), 4);
  for (const g of groups) {
    lines.push(
      `  ${g.key.padEnd(w)}  ${String(g.n).padStart(5)} 条  p=${String(g.p).padStart(8)}  h=${String(g.h).padStart(8)}  ${pct(g.ratio).padStart(8)}`
    );
  }
  return lines;
}

function main() {
  const argv = process.argv.slice(2);
  const asJson = argv.includes('--json');
  const sinceIdx = argv.indexOf('--since');
  const since = sinceIdx >= 0 ? String(argv[sinceIdx + 1] || '') : '';

  const files = listUsageFiles();
  let rows = readRecords(files);
  if (since) rows = rows.filter((r) => dayOf(r) >= since);

  const legacy = rows.filter(isLegacyRow);
  const fresh = rows.filter((r) => !isLegacyRow(r));

  const all = aggregate(rows);
  const freshAgg = aggregate(fresh);
  const byDay = groupBy(rows, dayOf);
  const byModel = groupBy(rows, (r) => r.model);
  const byVendor = groupBy(rows, (r) => (isLegacyRow(r) ? '(老记录·无渠道字段)' : r.v));
  const byLocal = groupBy(rows, (r) => (r.local === true ? '本机' : '云端'));

  if (asJson) {
    console.log(JSON.stringify({
      files: files.map((f) => path.basename(f)),
      since: since || null,
      totalRows: rows.length,
      legacyRows: legacy.length,
      all,
      fresh: freshAgg,
      byDay,
      byModel,
      byVendor,
      byLocal,
    }, null, 2));
    return;
  }

  const out = [];
  out.push('缓存命中率（cached / prompt）—— 服务端口径');
  out.push(`账本：${files.length ? files.map((f) => path.basename(f)).join(' · ') : '(没有找到账本文件)'}`);
  out.push(`记录：${rows.length} 条（其中老记录 ${legacy.length} 条，其 h 字段是后加的，恒为 0）`);
  if (since) out.push(`过滤：${since} 起`);
  out.push('');
  out.push(`【全量】sum(h)/sum(p) = ${all.h}/${all.p} = ${pct(all.ratio)}   n=${all.n}`);
  if (legacy.length) {
    out.push(`  ⚠️ 含 ${legacy.length} 条老记录（h 未上报）—— 看下面那个数更准`);
    out.push(`【剔除老记录】sum(h)/sum(p) = ${freshAgg.h}/${freshAgg.p} = ${pct(freshAgg.ratio)}   n=${freshAgg.n}`);
  }
  out.push(...table('按天', byDay));
  out.push(...table('按模型', byModel));
  out.push(...table('按渠道', byVendor));
  out.push(...table('按本机/云端', byLocal));
  out.push('');
  out.push('提示：这是「服务端真实缓存命中」，与 panel/prompt-stats.json 那个');
  out.push('      「消息前缀占比」是两个指标（后者不覆盖 tools）。');
  console.log(out.join('\n'));
}

const invokedDirectly = process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href;
if (invokedDirectly) main();
