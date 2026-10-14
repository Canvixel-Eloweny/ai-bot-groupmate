/**
 * 分发包真值复扫（构建侧工具，不进包）。
 *
 * 为什么需要它 —— 项目自带的 `publish-audit.mjs` 与 `make-publish-copy.mjs` 都要求
 * 目标是**一个 git 仓库**（它们靠 `git ls-files` 表达"哪些文件该被看见"）。
 * 我们最终交付的是一份**解压出来的 zip**，没有 .git，那两个闸门在上面跑不起来。
 *
 * 所以这里做的是同一件事的第三种入口：**直接遍历文件系统**，用**同一份**真值来源
 * （`scripts/known-real.mjs` 的哨兵表 + `scripts/credential-shapes.mjs` 的凭据形态）
 * 扫一遍最终产物。不复制任何判据 —— 判据只有那一份。
 *
 * 用法：node scan-package.mjs <要扫的目录>
 * 退出码：0 = 0 命中；1 = 有命中（必须处理）
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 真值来源所在的开发仓。
 *
 * ⚠️ 默认值**从本文件的位置反推**（`packaging/windows/` → 仓库根），不再写死本机绝对路径。
 *    写死过一版的后果很具体：那个路径带着**用户名**，而这份脚本是要入库的 ——
 *    入库就等于把本机目录结构一起公开（本项目对"扫描器不含本机绝对路径"早有约定）。
 *    现在谁 clone 都能跑，`QQBOT_SRC` 仍然可以覆盖（跨仓扫描时用）。
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(process.env.QQBOT_SRC || path.join(HERE, '..', '..'));
const { KNOWN_REAL, KNOWN_REAL_LOADED, KNOWN_REAL_SOURCE } = await import(path.join(SRC, 'scripts/known-real.mjs'));
const { EXTRA_CREDENTIAL_SHAPES, PLACEHOLDER_RE } = await import(path.join(SRC, 'scripts/credential-shapes.mjs'));

const TARGET = path.resolve(process.argv[2] || '.');
const TEXT_EXT = new Set([
  '.js', '.mjs', '.cjs', '.json', '.jsonl', '.md', '.txt', '.html', '.htm', '.css',
  '.bat', '.cmd', '.sh', '.ps1', '.yml', '.yaml', '.svg', '.swift', '.py', '.ini', '.conf', '.log',
]);
const BINARY_EXT = new Set(['.exe', '.dll', '.node', '.zip', '.icns', '.png', '.jpg', '.jpeg', '.gif', '.woff', '.woff2', '.ttf', '.so', '.dylib']);
const MAX_BYTES = 3 * 1024 * 1024; // 大于 3MB 的文本基本是产物/数据，不在这里判

/**
 * 明确豁免的**第三方随附内容**（不是"为了让它变绿"才加的，理由写在这里）：
 *
 *   `runtime/node/node_modules` 是 **Node.js 官方发行版原样自带**的 npm 及其依赖。
 *   它的文档里含 PEM 私钥**示例**（`-----BEGIN … PRIVATE KEY-----`），那是教学文本，
 *   与用户数据、与本项目都无关。
 *   我们对这份运行时的校验方式也**不是**文本扫描 —— 而是比对该发行版官方
 *   SHASUMS256.txt 里的 zip 哈希（见构建报告），那比逐行扫更精确。
 *   豁免数会**如实打印**，不静默。
 */
const VENDOR_SKIP = [path.join('runtime', 'node', 'node_modules')];
const isVendor = (rel) => VENDOR_SKIP.some((v) => rel === v || rel.startsWith(v + path.sep));

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '.git' || e.name === '__MACOSX') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(full);
    else if (e.isFile()) yield full;
  }
}

const isText = (p) => {
  const ext = path.extname(p).toLowerCase();
  if (BINARY_EXT.has(ext)) return false;
  if (TEXT_EXT.has(ext)) return true;
  return !ext && !/node\.exe$/i.test(p); // 无扩展名的小文件（如 npm/npx 壳）
};

const hits = [];
const placeholders = [];
let scanned = 0;
let skipped = 0;
let vendorSkipped = 0;

for (const file of walk(TARGET)) {
  const rel = path.relative(TARGET, file);
  if (isVendor(rel)) { vendorSkipped += 1; continue; }
  const stat = fs.statSync(file);
  if (!isText(file) || stat.size > MAX_BYTES) { skipped += 1; continue; }
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { skipped += 1; continue; }
  scanned += 1;

  // ① 已知真值（哨兵表，表本体在仓库外，只有构建机上有）
  for (const k of KNOWN_REAL) {
    const m = text.match(k.re);
    if (!m) continue;
    if (k.placeholder && m[0] === k.placeholder) { placeholders.push({ file: rel, what: k.what, value: m[0] }); continue; }
    hits.push({ file: rel, kind: `已知真值：${k.what}`, sample: m[0] });
  }

  // ② 凭据形态（与发布链路共用同一组正则）
  for (const [re, label] of EXTRA_CREDENTIAL_SHAPES) {
    const m = text.match(re);
    if (!m) continue;
    for (const v of m) {
      if (PLACEHOLDER_RE.test(v)) { placeholders.push({ file: rel, what: label, value: v }); continue; }
      hits.push({ file: rel, kind: label, sample: v });
    }
  }
}

console.log(`扫描目录：${TARGET}`);
console.log(`哨兵表：${KNOWN_REAL_LOADED ? `已装载（${KNOWN_REAL.length} 条，来源 ${KNOWN_REAL_SOURCE}）` : '⚠️ 未装载 —— 真值判据为空，结果不可信！'}`);
console.log(`文本文件 ${scanned} 个已扫 · ${skipped} 个跳过（二进制/超大）· ${vendorSkipped} 个第三方随附内容已豁免（见脚本内注释）`);
console.log('');

for (const p of placeholders) {
  console.log(`  · 占位符（不计失败，仅提示）：${p.file} → ${p.what} = ${p.value}`);
}
if (hits.length === 0) {
  console.log(`  ✅ 0 命中`);
  process.exit(0);
}
console.log(`  ✗ ${hits.length} 处命中：`);
for (const h of hits) console.log(`      ${h.file} → ${h.kind} = ${h.sample}`);
process.exit(1);
