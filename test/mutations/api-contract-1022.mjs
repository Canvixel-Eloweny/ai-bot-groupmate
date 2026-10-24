/**
 * §135「API 文档 ↔ 路由表」的定向变异（2026-10-22）。
 *
 * 每条只打一个失效面；全部 BLOCKED 才说明 §135 不是假绿。
 * 跑法：`NODE_OPTIONS= node scripts/mutate.mjs test/mutations/api-contract-1022.mjs --layer check-wb`
 * ⚠️ 串行；会改写真实工作树。文档读的是原始 Markdown，HTML 注释标记不能被剥掉。
 */
export default [
  {
    id: 'A1',
    note: '删掉路由总表里的一条（GET /api/health）—— §135② 双向集合相等必须变红。预期 BLOCKED',
    file: 'docs/API_CONTRACT.md',
    anchor: /\| GET \| `\/api\/health` \|\n/,
    count: 1,
    apply: (s) => s.replace('| GET | `/api/health` |\n', ''),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'A2',
    note: '往路由总表塞一条代码里不存在的幽灵路由 —— §135② 必须变红（文档多一条）。预期 BLOCKED',
    file: 'docs/API_CONTRACT.md',
    anchor: /<!-- api-inventory:end -->/,
    count: 1,
    apply: (s) => s.replace(
      '<!-- api-inventory:end -->',
      '| GET | `/api/__phantom` |\n<!-- api-inventory:end -->'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'A3',
    note: '删掉 health 字段契约的「幂等」行 —— §135③ 四行判据必须变红。预期 BLOCKED',
    file: 'docs/API_CONTRACT.md',
    anchor: /- \*\*幂等\*\*：是；正在退出时回 \*\*503\*\* 且 `ok:false`。/,
    count: 1,
    apply: (s) => s.replace('- **幂等**：是；正在退出时回 **503** 且 `ok:false`。', ''),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'A4',
    note: '把路由总表的 begin 标记改名 —— §135① 标记 fail-closed 必须变红。预期 BLOCKED',
    file: 'docs/API_CONTRACT.md',
    anchor: /<!-- api-inventory:begin -->/,
    count: 1,
    apply: (s) => s.replace('<!-- api-inventory:begin -->', '<!-- api-inventory:start -->'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
];
