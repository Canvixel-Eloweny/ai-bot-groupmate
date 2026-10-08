#!/usr/bin/env node
/**
 * 报告 HTML 的交付前预检（工作流改造 · 杠杆 B）
 * ══════════════════════════════════════════════════════════════════════════
 *  它解决什么
 * ══════════════════════════════════════════════════════════════════════════
 *  每份报告交付前，过去要**手工逐项**跑 6 条静态检查 + 2 条像素检查（条宽 / 轴偏移），
 *  而其中好几条**正则写法本身会撒谎**，本项目为此返工过多次：
 *
 *   · 「裸 `1fr`」写成全文正则 `[\s,(]1fr` → 把 `minmax(0,1fr)` 内部的 `1fr` 也吃掉，
 *     报出 2 处**假阳性**，逼着人去改一个本来就对的实现（第 51 轮）；
 *   · 「标签配对」把自闭合的 `<polygon …/>` 算成"有开无闭"（第 56 轮）；
 *   · 「markdown 残留」不剥行内反引号 → 把"行内引用了那两个星号"的例子行全报出来
 *     （实测 6 行假阳性，第 48 轮）；
 *   · 「`/*`」只看正文不看 `<style>` 段 → 页面的 CSS 注释被当成正文里的通配符（第 38 轮）。
 *
 *  所以本脚本的每一节都按"**解析结构，不要全文正则**"写，并且自带一份
 *  **已知合格 fixture**：`--selftest` 拿它跑一遍，**任一误报即以退出码 2 失败**。
 *  这是"扫描型判据上线前，先用一组已知合格的输入跑一遍"（第 51 轮②）的可执行版本。
 *
 *  用法
 *    node scripts/preflight-html.mjs <file.html> [--json]
 *    node scripts/preflight-html.mjs --selftest
 *  退出码：0 = 八项全过 · 1 = 有项未过 · 2 = 自证失败 / 输入基数异常
 */

import fs from 'node:fs';
import path from 'node:path';

const say = (...a) => console.log(...a);

// ─────────────────────────────────────────────────────────────────────────────
// 八项检查（每项返回 {name, ok, detail, hits}）
// ─────────────────────────────────────────────────────────────────────────────

/** HTML 里天然没有闭合标签的元素 + SVG 里常自闭合的形状元素。 */
const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta',
  'param', 'source', 'track', 'wbr', 'path', 'polygon', 'polyline', 'rect',
  'line', 'circle', 'ellipse', 'use', 'stop', 'image',
]);

function stripStyleAndScript(raw) {
  return raw.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<script[\s\S]*?<\/script>/gi, '');
}

function check1NoRemote(raw) {
  const hits = [];
  for (const re of [/<link\b[^>]*>/gi, /<script\b[^>]*\bsrc\s*=/gi, /@import\s+url\(\s*['"]?https?:/gi, /\bcdn\./gi, /\bsrc\s*=\s*["']https?:/gi]) {
    for (const m of raw.matchAll(re)) hits.push(m[0].slice(0, 48));
  }
  return { name: '① 无外链 / CDN（自包含）', ok: hits.length === 0, detail: hits.length ? hits.slice(0, 3).join(' | ') : '0 处', hits };
}

/**
 * ② 标签配对。逐 token 压栈：
 *    · void 元素与自闭合 `<x …/>` **不压栈**；
 *    · 遇到闭标签时与栈顶比对（不匹配即记一处）。
 */
function check2Tags(raw) {
  const body = stripStyleAndScript(raw);
  const stack = [];
  const bad = [];
  const re2 = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)\b([^>]*)>/g;
  let m2;
  while ((m2 = re2.exec(body)) !== null) {
    const [, close, tag, attrs] = m2;
    const t = tag.toLowerCase();
    const selfClose = /\/\s*$/.test(attrs);
    if (close === '/') {
      if (!stack.length) bad.push(`多余的 </${t}>`);
      else if (stack[stack.length - 1] !== t) bad.push(`</${t}> 与 <${stack[stack.length - 1]}> 不匹配`);
      else stack.pop();
      continue;
    }
    if (selfClose || VOID_TAGS.has(t)) continue;
    stack.push(t);
  }
  for (const t of stack) bad.push(`未闭合 <${t}>`);
  return { name: '② 标签配对（自闭合不压栈）', ok: bad.length === 0, detail: bad.length ? bad.slice(0, 3).join(' | ') : '0 处', hits: bad };
}

/** ③ 正文里的 `/*`（CSS 注释已随 <style> 剥掉；正文里出现会让注释剥离器吃掉整段）。 */
function check3SlashStar(raw) {
  const body = stripStyleAndScript(raw);
  const hits = [...body.matchAll(/\/\*/g)].map((m) => body.slice(Math.max(0, m.index - 18), m.index + 18));
  return { name: '③ 正文无 /*（会吞掉整段）', ok: hits.length === 0, detail: hits.length ? `命中 ${hits.length} 处` : '0 处', hits };
}

/** ④ markdown 残留：先剥行内反引号与 <code> 段（否则"把 ** 当例子写进正文"自己会误报）。 */
function check4Markdown(raw) {
  const body = stripStyleAndScript(raw)
    .replace(/`[^`\n]*`/g, '``')
    .replace(/<code\b[\s\S]*?<\/code>/gi, '<<>>');
  const bold = (body.match(/\*\*/g) || []).length;
  const strike = (body.match(/~~/g) || []).length;
  const ok = bold === 0 && strike === 0;
  return { name: '④ markdown 残留（** / ~~）', ok, detail: `** ${bold} 处 · ~~ ${strike} 处`, hits: [] };
}

/** ⑤ SVG `<text>` 内不许出现 HTML 标签（解析器不懂 <b>，文字会被挤出 <text>）。 */
function check5SvgText(raw) {
  const hits = [];
  for (const svg of raw.matchAll(/<svg[\s\S]*?<\/svg>/gi)) {
    for (const t of svg[0].matchAll(/<text\b[^>]*>([\s\S]*?)<\/text>/gi)) {
      if (/<\/?(b|i|u|em|strong|span|div|code|br|p)\b/i.test(t[1])) hits.push(t[1].trim().slice(0, 40));
    }
  }
  return { name: '⑤ SVG <text> 内无 HTML 标签', ok: hits.length === 0, detail: hits.length ? hits.slice(0, 2).join(' | ') : '0 处', hits };
}

/** ⑥ 体积与图数：图太少说明报告退化成纯文本；体积过大提示该拆。 */
function check6Size(raw, budgetKB = 200) {
  const svg = (raw.match(/<svg\b/gi) || []).length;
  const caps = (raw.match(/class="cap"/gi) || []).length;
  const kb = Buffer.byteLength(raw) / 1024;
  const ok = kb <= budgetKB && (svg + caps) >= 5;
  return { name: '⑥ 体积 ≤ 预算 且 图 ≥ 5', ok, detail: `${kb.toFixed(1)} KB / 图 ${svg + caps} 张`, hits: [] };
}

/**
 * ⑦ 裸 `1fr`：**先抽 `grid-template-columns` 的整值，再逐值判**每个 `1fr` 是否被 `minmax(` 包住。
 *    ⚠️ 不许在整个文件上跑一条正则 —— 那会把 `minmax(0,1fr)` 内部的 `1fr` 也当成裸的（实测假阳性）。
 */
function check7BareFr(raw) {
  const hits = [];
  // 值的终止符要把**引号**也算进去：行内 style="grid-template-columns:1fr" 的取值
  // 到 `"` 就结束，只认 `;}` 会让最后那个 `1fr` 落进"后面没有分隔符"的缝里漏掉（本机实测过）。
  for (const m of raw.matchAll(/grid-template-columns\s*:\s*([^;}'"]+)/gi)) {
    const val = m[1];
    for (const t of val.matchAll(/(?:^|[\s,])(1fr)(?=[\s,]|$)/g)) {
      const at = t.index + (t[0].length - 3);
      if (!/minmax\(\s*0\s*,\s*$/.test(val.slice(Math.max(0, at - 12), at))) hits.push(val.trim().slice(0, 48));
    }
  }
  const shorthand = [...raw.matchAll(/grid-template\s*:\s*([^;}]+)/gi)].filter((m) => /(?:^|[\s,])1fr(?=[\s,]|$)/.test(m[1])).length;
  return { name: '⑦ 裸 1fr（按整值判，不用全文正则）', ok: hits.length === 0 && shorthand === 0, detail: hits.length || shorthand ? `裸 1fr ${hits.length} 处 · grid-template 简写 ${shorthand} 处` : '0 处', hits };
}

/** ⑧ 轴标签用负偏移 → 会被容器裁掉半个字（第 40 轮实测）。 */
function check8AxisOffset(raw) {
  const hits = [];
  for (const m of raw.matchAll(/(\.[a-z0-9_-]*ax[a-z0-9_-]*|\.axis[a-z0-9_-]*)\s*\{([^}]*)\}/gi)) {
    if (/(left|bottom)\s*:\s*-\d/.test(m[2])) hits.push(m[1]);
  }
  return { name: '⑧ 轴标签不用负偏移', ok: hits.length === 0, detail: hits.length ? hits.join(' | ') : '0 处', hits };
}

function runAll(raw, { budgetKB = 200 } = {}) {
  return [
    check1NoRemote(raw),
    check2Tags(raw),
    check3SlashStar(raw),
    check4Markdown(raw),
    check5SvgText(raw),
    check6Size(raw, budgetKB),
    check7BareFr(raw),
    check8AxisOffset(raw),
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// 自证用 fixture：**已知合格**（历史上这八项都踩过假阳性，所以它专门覆盖那几种形状）
// ─────────────────────────────────────────────────────────────────────────────

const FIXTURE = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>fixture</title>
<style>
  :root{--ok:#00b42a}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(0,1fr));gap:8px}
  .bar{display:block;height:14px}
  .axis-x{left:10px;bottom:6px}
  /* 这条 CSS 注释里故意放一个通配符形状，验证"剥 <style> 后不该报" */
</style></head><body>
<div class="wrap">
  <h1>预检用合格样本</h1>
  <p>正文里可以出现 &#42;&#47; 这种实体（渲染出来是那两个字符，但剥离器看不见）。</p>
  <p>也可以行内引用 <code>/&#42; 与 &#42;&#42; 的写法</code> —— 这一段必须被剥掉，不许误报。</p>
  <p>行内反引号里的 <code>**</code> 同理。</p>
  <div class="grid">
    <div class="card">A</div><div class="card">B</div>
  </div>
  <span class="bar" style="width:50%"></span>
  <svg viewBox="0 0 680 120" role="img" aria-label="图例 1">
    <rect x="10" y="10" width="120" height="40" rx="6" fill="#e8ffea" stroke="#aff0b5"/>
    <polygon points="196,46 208,52 196,58" fill="#86909c"/>
    <polyline points="300,10 320,30 340,10" fill="none" stroke="#1677ff"/>
    <line x1="10" y1="90" x2="670" y2="90" stroke="#e5e6eb"/>
    <text x="20" y="60" font-size="12" fill="#1f2329" font-family="sans-serif">正常文字</text>
    <text x="200" y="60" font-size="12" fill="#1f2329" font-family="sans-serif"><tspan font-weight="700">加粗用 tspan</tspan></text>
  </svg>
  <svg viewBox="0 0 680 60" role="img" aria-label="图例 2"><text x="10" y="30" font-size="12" fill="#1f2329">2</text></svg>
  <svg viewBox="0 0 680 60" role="img" aria-label="图例 3"><text x="10" y="30" font-size="12" fill="#1f2329">3</text></svg>
  <div class="cap">图 1</div><div class="cap">图 2</div><div class="cap">图 3</div>
</div>
</body></html>`;

function selftest() {
  say('── preflight-html.mjs --selftest ──');
  const res = runAll(FIXTURE);
  const falsePositives = res.filter((r) => !r.ok);
  for (const r of res) say(`${r.ok ? '✓' : '✗'} ${r.name} — ${r.detail}`);
  if (falsePositives.length) {
    say(`\n✗ 自证失败：已知合格的 fixture 上有 ${falsePositives.length} 项误报 —— 这些检查项现在不可信，先修它们。`);
    return 2;
  }
  // 反向自证：把几种"必须报"的形状喂进去，确认检查项不是恒真
  const poison = FIXTURE
    .replace('<div class="grid">', '<div class="grid" style="grid-template-columns:1fr">')
    .replace('<text x="20" y="60" font-size="12" fill="#1f2329" font-family="sans-serif">正常文字</text>',
      '<text x="20" y="60"><b>不该用 b</b></text>')
    .replace('</body>', '<p>**残留粗体**</p><p>/* 正文通配符</p></body>');
  const poisoned = runAll(poison);
  const caught = poisoned.filter((r) => !r.ok).map((r) => r.name);
  say(`\n反向自证（投毒样本）：命中 ${caught.length} 项 —— ${caught.join(' · ') || '（一项都没命中，说明检查项恒真）'}`);
  if (caught.length < 3) {
    say('✗ 自证失败：投毒样本只命中 <3 项，检查项疑似恒真（`失败伪装成成功` 那一类）');
    return 2;
  }
  say('\n✓ 自证通过：合格样本 0 误报 · 投毒样本命中 ≥3 项（双向可见）');
  return 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// main
// ─────────────────────────────────────────────────────────────────────────────

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--selftest')) process.exit(selftest());

  const file = argv.find((a) => !a.startsWith('--'));
  const asJson = argv.includes('--json');
  if (!file) {
    say('用法：node scripts/preflight-html.mjs <file.html> [--json] | --selftest');
    process.exit(2);
  }
  const p = path.resolve(file);
  if (!fs.existsSync(p)) {
    say(`✗ 文件不存在：${p}`);
    process.exit(2);
  }
  const raw = fs.readFileSync(p, 'utf8');
  const res = runAll(raw);
  const failed = res.filter((r) => !r.ok);
  if (asJson) say(JSON.stringify({ file: p, ok: failed.length === 0, checks: res }, null, 2));
  else {
    say(`── 报告预检：${path.basename(p)} ──`);
    for (const r of res) say(`${r.ok ? '✓' : '✗'} ${r.name} — ${r.detail}`);
    say(failed.length ? `\n✗ 未过 ${failed.length} 项：${failed.map((r) => r.name).join(' · ')}` : '\n✓ 八项全过');
  }
  process.exit(failed.length ? 1 : 0);
}

main();
