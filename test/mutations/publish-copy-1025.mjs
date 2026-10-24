/**
 * P3-5 · 公开拷贝门禁兼容的定向变异（2026-10-24）。
 *
 * 打的是「公开仓 CI 要么整层静默跳过、要么在缺文件时假红」这两类：
 *   PC1 readDoc 的 held-back 守卫被关掉
 *   PC2 §154–§158 又出现裸 docs/desktop 读取
 *   PC3 mutate-lint 不再跳过 held-back 目标
 *   PC4 mutate-lint 丢了 skipped 回传
 *   PC5 check-wb 又长出一份内联桩判定
 *   PC6 ci-verify 允许跳过任意缺失步骤
 *
 * 全部由 §159 拦住。跑法：
 *   NODE_OPTIONS= node scripts/mutate.mjs test/mutations/publish-copy-1025.mjs
 */
const CK = 'scripts/check-wb.mjs';
const LINT = 'scripts/mutate-lint.mjs';
const CI = 'scripts/ci-verify.mjs';

export default [
  {
    id: 'PC1',
    file: CK,
    anchor: /if \(IS_PUBLISH_COPY && isHeldBackForGates\(norm\)\) \{/,
    count: 1,
    apply: (s) => s.replace(
      'if (IS_PUBLISH_COPY && isHeldBackForGates(norm)) {',
      'if (false && IS_PUBLISH_COPY && isHeldBackForGates(norm)) {',
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
    note: 'readDoc 的发布守卫被短路 —— 公开拷贝读内部文档会 ENOENT 或 fail-open',
  },
  {
    id: 'PC2',
    file: CK,
    anchor: /const doc = readDoc\('docs\/desktop\/P3-PORT\.md'\);/,
    count: 1,
    apply: (s) => s.replace(
      "const doc = readDoc('docs/desktop/P3-PORT.md');",
      "const doc = read('../docs/desktop/P3-PORT.md');",
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
    note: '§155 又绕过 readDoc 直接读内部文档 —— 公开拷贝 ENOENT',
  },
  {
    id: 'PC3',
    file: LINT,
    anchor: /if \(publishCopy && m\.file && isHeldBack\(m\.file\)\) \{/,
    count: 1,
    apply: (s) => s.replace(
      'if (publishCopy && m.file && isHeldBack(m.file)) {',
      'if (false && publishCopy && m.file && isHeldBack(m.file)) {',
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
    note: 'mutate-lint 不再跳过 held-back 目标 —— 公开仓整份清单 INVALID',
  },
  {
    id: 'PC4',
    file: LINT,
    anchor: /return \{ files: plans\.length, total, bad, noop, skipped, plans \};/,
    count: 1,
    apply: (s) => s.replace(
      'return { files: plans.length, total, bad, noop, skipped, plans };',
      'return { files: plans.length, total, bad, noop, plans };',
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
    note: 'mutate-lint 丢了 skipped 回传 —— 跳过数量变成不可见',
  },
  {
    id: 'PC5',
    file: CK,
    anchor: /const IS_PUBLISH_COPY = isPublishCopy\(REPO\);/,
    count: 1,
    apply: (s) => s.replace(
      'const IS_PUBLISH_COPY = isPublishCopy(REPO);',
      "const IS_PUBLISH_COPY = (() => {\n  try {\n    return fs.readFileSync(new URL('../docs/PUBLISH-CHECKLIST.md', import.meta.url), 'utf8').includes('对外拷贝里的**桩**');\n  } catch { return false; }\n})();",
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
    note: 'check-wb 又长出第二份内联桩判定 —— 桩标记从此有两处真源',
  },
  {
    id: 'PC6',
    file: CI,
    anchor: /if \(publishCopy && onlyHeldBack\) \{/,
    count: 1,
    apply: (s) => s.replace(
      'if (publishCopy && onlyHeldBack) {',
      'if (publishCopy) {',
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
    note: 'ci-verify 允许跳过任意缺失步骤 —— 公开仓少一层门也照样绿',
  },
];
