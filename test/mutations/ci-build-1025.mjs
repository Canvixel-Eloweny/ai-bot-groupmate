/**
 * P3-5 · CI Windows 构建的定向变异（2026-10-24）。
 *
 * 打的是「构建绕过门禁 / 偷渡发布权限 / 丢掉可复现判据」三类：
 *   CI1 删 needs（四层没过也能出包）
 *   CI2 去掉手动 dispatch 条件（push/PR 也出包）
 *   CI3 给 workflow 写权限
 *   CI4 松开 NSIS 版本
 *   CI5 缩短 artifact 保留期
 *   CI6 去掉 provenance 要求
 *   CI7 artifact 缺失不报错
 *   CI8 四层回归入口被换掉
 *
 * 全部由 §160 拦住。跑法：
 *   NODE_OPTIONS= node scripts/mutate.mjs test/mutations/ci-build-1025.mjs
 */
const CI = '.github/workflows/ci.yml';

export default [
  {
    id: 'CI1',
    file: CI,
    anchor: /    needs: \[contracts, smoke, windows-contracts, publish-audit, regression\]\n/,
    count: 1,
    apply: (s) => s.replace('    needs: [contracts, smoke, windows-contracts, publish-audit, regression]\n', ''),
    layer: 'check-wb',
    expect: 'BLOCKED',
    note: 'desktop-build 不再等四层门禁 —— 包可能在红门禁下出',
  },
  {
    id: 'CI2',
    file: CI,
    anchor: /    if: \$\{\{ github\.event_name == 'workflow_dispatch' && inputs\.build_windows \}\}\n/g,
    count: 2,
    apply: (s) => s.replace(/\n    if: \$\{\{ github\.event_name == 'workflow_dispatch' && inputs\.build_windows \}\}\n/g, '\n'),
    layer: 'check-wb',
    expect: 'BLOCKED',
    note: '去掉 dispatch 条件 —— push/PR 也会触发全量构建',
  },
  {
    id: 'CI3',
    file: CI,
    anchor: /permissions:\n  contents: read/,
    count: 1,
    apply: (s) => s.replace('permissions:\n  contents: read', 'permissions:\n  contents: write'),
    layer: 'check-wb',
    expect: 'BLOCKED',
    note: '构建 job 拿到写权限 —— 可能顺手推 tag/Release',
  },
  {
    id: 'CI4',
    file: CI,
    anchor: /choco install nsis --version=3\.13\.0 -y --no-progress/,
    count: 1,
    apply: (s) => s.replace('choco install nsis --version=3.13.0 -y --no-progress', 'choco install nsis -y --no-progress'),
    layer: 'check-wb',
    expect: 'BLOCKED',
    note: 'NSIS 版本松开 —— 构建机与验收机可能不是同一版本',
  },
  {
    id: 'CI5',
    file: CI,
    anchor: /retention-days: 14/,
    count: 1,
    apply: (s) => s.replace('retention-days: 14', 'retention-days: 1'),
    layer: 'check-wb',
    expect: 'BLOCKED',
    note: 'artifact 只留 1 天 —— 对账还没做就被清掉',
  },
  {
    id: 'CI6',
    file: CI,
    anchor: / --require-provenance/,
    count: 1,
    apply: (s) => s.replace(' --require-provenance', ''),
    layer: 'check-wb',
    expect: 'BLOCKED',
    note: '去掉 provenance 要求 —— 公开仓构建可能记错源提交',
  },
  {
    id: 'CI7',
    file: CI,
    anchor: /if-no-files-found: error/,
    count: 1,
    apply: (s) => s.replace('if-no-files-found: error', 'if-no-files-found: warn'),
    layer: 'check-wb',
    expect: 'BLOCKED',
    note: 'artifact 缺失只告警 —— 空构建也会绿',
  },
  {
    id: 'CI8',
    file: CI,
    anchor: /run: node scripts\/ci-verify\.mjs/,
    count: 1,
    apply: (s) => s.replace('run: node scripts/ci-verify.mjs', 'run: node scripts/mutate-lint.mjs'),
    layer: 'check-wb',
    expect: 'BLOCKED',
    note: '四层回归入口被换掉 —— 只跑锚点体检就出包',
  },
];
