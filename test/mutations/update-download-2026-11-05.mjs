/**
 * 下载器续传 / 低速切换 / 清单镜像回退（§109/§114 · 2026-11-05）的变异清单 —— 纯数据。
 * 跑法：
 *   NODE_OPTIONS= node scripts/mutate-lint.mjs
 *   NODE_OPTIONS= node scripts/mutate.mjs test/mutations/update-download-2026-11-05.mjs --layer check-wb
 * 纪律：anchor 必须在 pristine 文件里**恰好命中 count 次**；apply 必须返回不同且语法合法的内容。
 */
const DL = 'panel/lib/update-download.js';
const UPD = 'panel/lib/update.js';

export default [
  {
    id: 'D1',
    note: '删掉面板低速阈值常量 —— §114 必须变红。预期 BLOCKED',
    file: DL,
    anchor: /export const LOW_SPEED_MS = 15_000;/,
    count: 1,
    apply: (s) => s.replace(/export const LOW_SPEED_MS = 15_000;/, ''),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'D2',
    note: '两轮续传改成一轮（全部源失败后不再重试）—— §114 必须变红。预期 BLOCKED',
    file: DL,
    anchor: /for \(let pass = 0; pass < 2; pass \+= 1\) \{/,
    count: 1,
    apply: (s) => s.replace(/for \(let pass = 0; pass < 2; pass \+= 1\) \{/, 'for (let pass = 0; pass < 1; pass += 1) {'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'D3',
    note: '清单镜像回退只剩官方源 —— §109 必须变红。预期 BLOCKED',
    file: UPD,
    anchor: /return \[primary,[^\n]*\];/,
    count: 1,
    apply: (s) => s.replace(/return \[primary,[^\n]*\];/, 'return [primary];'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'D4',
    note: '下载失败不能从 error 继续 —— §109 必须变红。预期 BLOCKED',
    file: UPD,
    anchor: /if \(state\.phase !== 'available' && state\.phase !== 'error'\) return snapshot\(\);/,
    count: 1,
    apply: (s) => s.replace(
      /if \(state\.phase !== 'available' && state\.phase !== 'error'\) return snapshot\(\);/,
      "if (state.phase !== 'available') return snapshot();",
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
];
