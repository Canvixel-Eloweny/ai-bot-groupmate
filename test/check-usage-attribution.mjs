// 按轮用量归属（2026-11-05 · 外部评估 P2）
//   ① 主链路不再读写共享的 `llm.lastUsage`，改用本轮 `toolLoop.run()` 的返回值；
//   ② 账本 / trace 读的是同一个局部值；
//   ③ 聚合口径仍由 `aggregateUsage` 一份实现。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from '../scripts/lib/scan-utils.mjs';
import { aggregateUsage } from '../src/tool-loop.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0;
const fails = [];
const ok = (name, cond, extra = '') => {
  if (cond) { pass += 1; return; }
  fails.push(`${name}${extra ? `  → ${extra}` : ''}`);
};

const idx = stripComments(fs.readFileSync(path.join(ROOT, 'src/index.js'), 'utf8'));

ok('主链路声明了本轮局部 turnUsage',
  /let turnUsage = null;/.test(idx));
ok('用量来自 toolLoop.run() 的返回值（不写共享字段）',
  /turnUsage = run\.usage;/.test(idx)
  && !/llm\.lastUsage\s*=/.test(idx));
ok('账本读本轮局部值并带会话键',
  /if \(turnUsage\) recordUsage\(\{ \.\.\.turnUsage, chat: session\.key, source: USAGE_SOURCES\.agent \}\);/.test(idx));
ok('trace 的模型名与 usage 也读本轮局部值',
  /const usedModel = turnUsage\?\.model \|\| '';/.test(idx)
  && /usage: turnUsage\s*\?\s*\{ prompt: turnUsage\.prompt, completion: turnUsage\.completion, reasoning: turnUsage\.reasoning \}/.test(idx));
ok('主链路不再出现 llm.lastUsage 读',
  !/llm\.lastUsage/.test(idx));

const one = { prompt: 11, completion: 2, reasoning: 0, model: 'a' };
const two = { prompt: 77, completion: 3, reasoning: 1, model: 'b' };
const sum = aggregateUsage([one, two]);
ok('聚合：多轮求和（prompt/completion/reasoning）',
  sum.prompt === 88 && sum.completion === 5 && sum.reasoning === 1 && sum.model === 'b',
  JSON.stringify(sum));
ok('聚合：单轮原样返回同一个对象（零工具时不引入形状漂移）',
  aggregateUsage([one]) === one);

if (fails.length) {
  console.log(`用量归属判据：${pass} 项通过，${fails.length} 项失败`);
  for (const f of fails) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`用量归属判据：${pass} 项通过，0 项失败`);
