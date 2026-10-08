#!/usr/bin/env node
/**
 * 分析入站合并转发段的量数脚本（D23-1）。
 *
 * 用法：
 *   node scripts/analyze-forward.mjs [panel/forward-probe.jsonl]
 *
 * 输出形态：
 *   - 总样本数
 *   - forward-id 型 vs 内嵌 node 型 的分布
 *   - node 型里的节点数分布（含平均 / 最大）
 *   - 嵌套 forward 出现次数
 *   - 时间跨度
 */
import fs from 'node:fs';

const file = process.argv[2] || 'panel/forward-probe.jsonl';

if (!fs.existsSync(file)) {
  console.log(`探针文件不存在：${file}（尚无入站合并转发样本）`);
  process.exit(0);
}

const rows = fs.readFileSync(file, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((line, idx) => {
    try {
      return JSON.parse(line);
    } catch (e) {
      return { kind: 'parse-error', index: idx, error: e.message };
    }
  });

const forwardId = rows.filter((r) => r.kind === 'forward');
const node = rows.filter((r) => r.kind === 'node');
const other = rows.filter((r) => r.kind !== 'forward' && r.kind !== 'node');
const nested = node.filter((r) => r.hasNestedForward).length;
const nodeCounts = node.map((r) => r.nodeCount || 0);
const avgNode = nodeCounts.length ? (nodeCounts.reduce((a, b) => a + b, 0) / nodeCounts.length).toFixed(1) : 0;
const maxNode = nodeCounts.length ? Math.max(...nodeCounts) : 0;
const ts = rows.map((r) => r.ts).filter(Boolean);

console.log(`入站合并转发探针统计：${file}`);
console.log(`────────────────────────────────────────`);
console.log(`总样本数：${rows.length}`);
console.log(`  forward-id 型：${forwardId.length}（含 id 字段：${forwardId.filter((r) => r.hasId).length}）`);
console.log(`  内嵌 node 型：${node.length}`);
console.log(`  其它 / 解析失败：${other.length}`);
console.log(`  嵌套 forward：${nested} 次`);
if (node.length) {
  console.log(`  node 节点数：平均 ${avgNode} · 最大 ${maxNode}`);
}
if (ts.length) {
  const first = new Date(Math.min(...ts));
  const last = new Date(Math.max(...ts));
  console.log(`  时间跨度：${first.toISOString()} → ${last.toISOString()}`);
}
