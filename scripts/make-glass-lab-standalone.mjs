#!/usr/bin/env node
/**
 * 把液态玻璃制作站打成**单文件**（桌面验收页）。
 *
 * 只做一件事：按页面里既有的 <link>/<script> 顺序，把 5 个源文件内联进去。
 * 不重新实现、不改参数、不联网；同一批源文件重复运行必须字节一致。
 *
 * 用法：
 *   node scripts/make-glass-lab-standalone.mjs
 *   node scripts/make-glass-lab-standalone.mjs --out /path/to/file.html
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { NEXT_ASSETS } from '../panel/lib/next-page.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NEXT = path.resolve(HERE, '../panel/next');
const ENTRY = 'lab-liquid-glass.html';
const SOURCES = [
  'style.css',
  'glass-scrim.css',
  'glass-station.css',
  'glass.js',
  'glass-station.js',
];

const outArg = process.argv.indexOf('--out');
const OUT = outArg > 0 && process.argv[outArg + 1]
  ? path.resolve(process.argv[outArg + 1])
  : path.join(os.homedir(), 'Desktop', 'Estrella-液态玻璃制作站-验收页.html');

const fail = (msg) => { console.error('✗ ' + msg); process.exit(1); };
for (const name of [ENTRY, ...SOURCES]) {
  if (!(name in NEXT_ASSETS)) fail(`${name} 未登记在 NEXT_ASSETS —— 先登记再导出`);
}
const read = (name) => fs.readFileSync(path.join(NEXT, name), 'utf8');
const hash = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);

let html = read(ENTRY);
const sources = new Map();
for (const name of SOURCES) sources.set(name, read(name));

for (const [name, src] of sources) {
  if (name.endsWith('.css') && /<\/style/i.test(src)) fail(`${name} 含 </style，不能内联`);
  if (name.endsWith('.js') && /<\/script/i.test(src)) fail(`${name} 含 </script，不能内联`);
}

html = html.replace(/<link\b[^>]*href="\.\/([^"]+)"[^>]*>/g, (tag, name) => {
  const src = sources.get(name);
  if (src == null) fail(`页面引用了未登记的内联源：${name}`);
  return `<style data-inline="${name}">\n${src}\n</style>`;
});
html = html.replace(/<script\b[^>]*src="\.\/([^"]+)"[^>]*><\/script>/g, (tag, name) => {
  const src = sources.get(name);
  if (src == null) fail(`页面引用了未登记的内联脚本：${name}`);
  return `<script data-inline="${name}">\n${src}\n</script>`;
});

const leftovers = [...html.matchAll(/(?:src|href)="\.\//g)].map((m) => m[0]);
if (leftovers.length) fail(`仍有未内联的相对引用 ${leftovers.length} 处`);
if (/type="module"/.test(html)) fail('单文件里不应再有 type="module"');

const urls = [...html.matchAll(/https?:\/\/[^\s"'<>)]+/g)].map((m) => m[0]);
const external = urls.filter((u) => u !== 'http://www.w3.org/2000/svg');
if (external.length) fail(`单文件里仍有外部 URL：${external.slice(0, 3).join(' · ')}`);

const banner = '<!-- Estrella Liquid Glass Lab · standalone build\n'
  + '     derived by scripts/make-glass-lab-standalone.mjs; do not edit this copy.\n'
  + '     sources: ' + [ENTRY, ...SOURCES].map((n) => `${n} sha256=${hash(n === ENTRY ? read(ENTRY) : sources.get(n))}`).join(' · ')
  + ' -->';
html = html.replace('<head>', '<head>\n' + banner);

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, html);
console.log(`OK ${OUT}`);
console.log(`size=${Buffer.byteLength(html)} bytes · sources=${SOURCES.length + 1} · sha256=${hash(html)}`);
