/**
 * P4 回滚 / 断电恢复 / 离线更新 / 保留策略（2026-10-18）的定向变异清单。
 *
 * 目标：验收 `check-wb` §110 真的会红，而不是一条漂亮的空断言。
 * 复跑：`NODE_OPTIONS= node scripts/mutate.mjs test/mutations/install-p4-1018.mjs`
 */

export default [
  {
    id: 'M1',
    note: '回滚阈值从 2 改成 1 —— 第一次失败就翻指针，误伤正常启动抖动',
    file: 'packaging/windows/tools/lib/rollback.mjs',
    anchor: /export const FAILURE_THRESHOLD = 2;/g,
    count: 1,
    apply: (s) => s.replace('export const FAILURE_THRESHOLD = 2;', 'export const FAILURE_THRESHOLD = 1;'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M2',
    note: '阈值比较从 < 改成 <= —— 第一次失败就进回滚分支',
    file: 'packaging/windows/tools/lib/rollback.mjs',
    anchor: /if \(next < FAILURE_THRESHOLD\) \{/g,
    count: 1,
    apply: (s) => s.replace('if (next < FAILURE_THRESHOLD) {', 'if (next <= FAILURE_THRESHOLD) {'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M3',
    note: '回滚后把失败版本留在 previous —— 下一次可能自动回滚到已知坏版本',
    file: 'packaging/windows/tools/launcher.mjs',
    anchor: /current: to, previous: null, health: 'pending', failures: 0/g,
    count: 1,
    apply: (s) => s.replace(
      "current: to, previous: null, health: 'pending', failures: 0",
      "current: to, previous: from, health: 'pending', failures: 0"
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M4',
    note: '只翻指针、不交换 runtime —— 旧版可能跑在不兼容的新 runtime 上',
    file: 'packaging/windows/tools/launcher.mjs',
    anchor: /const sw = swapRuntime\(\{ installRoot, stamp \}\);/g,
    count: 1,
    apply: (s) => s.replace(
      'const sw = swapRuntime({ installRoot, stamp });',
      'const sw = { ok: true, swapped: false };'
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M5',
    note: 'runtime 交换失败也继续翻指针 —— 目录状态与 current.json 分叉',
    file: 'packaging/windows/tools/launcher.mjs',
    anchor: /if \(!sw\.ok\) \{\n    logLine\(`✗ runtime 交换失败，拒绝翻指针：\$\{sw\.reason\}`\);/g,
    count: 1,
    apply: (s) => s.replace(
      'if (!sw.ok) {\n    logLine(`✗ runtime 交换失败，拒绝翻指针：${sw.reason}`);',
      'if (false) {\n    logLine(`✗ runtime 交换失败，拒绝翻指针：${sw.reason}`);'
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M6',
    note: '失败时不停子进程 —— 坏面板继续占着端口，下一次启动直接撞端口',
    file: 'packaging/windows/tools/launcher.mjs',
    anchor: /const stop = await stopPanel\(pid\);/g,
    count: 1,
    apply: (s) => s.replace('const stop = await stopPanel(pid);', 'const stop = { ok: true };'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M7',
    note: '不做配置 schema 闸 —— 新版升级过配置后仍自动回滚，旧版读不懂配置',
    file: 'packaging/windows/tools/launcher.mjs',
    anchor: /const guard = configRollbackGuard\(\{ configSchema: userSchema, targetSupported: targetSchema \}\);/g,
    count: 1,
    apply: (s) => s.replace(
      'const guard = configRollbackGuard({ configSchema: userSchema, targetSupported: targetSchema });',
      'const guard = { ok: true };'
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M8',
    note: 'swap 前不落盘 journal —— 断电后 entries 为空，restoreJournal 无从恢复',
    file: 'packaging/windows/tools/install-commit.mjs',
    anchor: /  persist\(\);\n  fault\('after-journal'\);/g,
    count: 1,
    apply: (s) => s.replace("  persist();\n  fault('after-journal');", "  fault('after-journal');"),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M9',
    note: 'runtime 备份名回到 node.previous-<stamp> —— 与冻结规格 ABI 不一致',
    file: 'packaging/windows/tools/install-commit.mjs',
    anchor: /const nodePrev = path\.join\(runtimeRoot, 'node\.previous'\);/g,
    count: 1,
    apply: (s) => s.replace(
      "const nodePrev = path.join(runtimeRoot, 'node.previous');",
      'const nodePrev = path.join(runtimeRoot, `node.previous-${stamp}`);'
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M10',
    note: '保留策略不再跳过 current/previous —— 健康成功反而删掉正在用的版本',
    file: 'packaging/windows/tools/lib/retention.mjs',
    anchor: /if \(keep\.has\(e\.name\)\) continue;/g,
    count: 1,
    apply: (s) => s.replace('if (keep.has(e.name)) continue;', 'if (false) continue;'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M11',
    note: '保留策略碰 USER_ROOT —— 清理程序文件时误入用户数据',
    file: 'packaging/windows/tools/lib/retention.mjs',
    anchor: /const runtimeDir = path\.join\(installRoot, 'runtime'\);/g,
    count: 1,
    apply: (s) => s.replace(
      "const runtimeDir = path.join(installRoot, 'runtime');",
      "const userRoot = path.join(installRoot, 'userdata');\n  const runtimeDir = path.join(installRoot, 'runtime');"
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M12',
    note: '离线 prepare 不拒绝坏签名 —— 任何人都能改清单',
    file: 'panel/lib/update.js',
    anchor: /if \(!verifyRawSignature\(raw, sig, publicKey\)\) throw new Error\('离线清单签名无效'\);/g,
    count: 1,
    apply: (s) => s.replace(
      "if (!verifyRawSignature(raw, sig, publicKey)) throw new Error('离线清单签名无效');",
      "if (false) throw new Error('离线清单签名无效');"
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M13',
    note: '离线 complete 不拒绝坏 SHA-256 —— 被篡改的 EXE 会进入 ready',
    file: 'panel/lib/update.js',
    anchor: /if \(digest !== obj\.installer\.sha256\) throw new Error\('离线安装包 SHA-256 不符'\);/g,
    count: 1,
    apply: (s) => s.replace(
      "if (digest !== obj.installer.sha256) throw new Error('离线安装包 SHA-256 不符');",
      "if (false) throw new Error('离线安装包 SHA-256 不符');"
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M14',
    note: '离线版本比较拿常量当当前版本 —— 版本闸失真',
    file: 'panel/lib/update.js',
    anchor: /const cmp = compareVersions\(obj\.version, appVersion\);\n    if \(cmp === 0\) throw new Error\(`离线清单就是当前版本 \$\{appVersion\}`\);/g,
    count: 1,
    apply: (s) => s.replace(
      'const cmp = compareVersions(obj.version, appVersion);\n    if (cmp === 0) throw new Error(`离线清单就是当前版本 ${appVersion}`);',
      "const cmp = compareVersions(obj.version, '0.0.0');\n    if (cmp === 0) throw new Error(`离线清单就是当前版本 ${appVersion}`);"
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M15',
    note: '离线路径偷偷联网 —— 离线更新不应依赖网络',
    file: 'panel/lib/update-offline.js',
    anchor: /import \{ readBody, readBodyToFile, sendJson \} from '\.\/http-io\.js';/g,
    count: 1,
    apply: (s) => s.replace(
      "import { readBody, readBodyToFile, sendJson } from './http-io.js';",
      "import { readBody, readBodyToFile, sendJson } from './http-io.js';\nconst mutationFetch = () => fetch('https://example.com');"
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M16',
    note: '镜像允许 latest —— 镜像换掉“这一版到底是哪一版”',
    file: 'panel/lib/update-manifest.js',
    anchor: /if \(m\[1\]\.toLowerCase\(\) === 'latest'\) \{/g,
    count: 1,
    apply: (s) => s.replace("if (m[1].toLowerCase() === 'latest') {", 'if (false) {'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M17',
    note: 'Windows 回滚不创建独立任务助手 —— 助手随启动器/桥作业一起被杀，runtime 永远换不回去',
    file: 'packaging/windows/tools/launcher.mjs',
    anchor: /const helper = spawnRollbackHelper\(\{\n      installRoot,\n      userRoot,\n      from,\n      to,/g,
    count: 1,
    apply: (s) => s.replace(
      'const helper = spawnRollbackHelper({\n      installRoot,\n      userRoot,\n      from,\n      to,',
      "const helper = { ok: true, taskName: 'mutation' };\n    const unused = ({\n      installRoot,\n      userRoot,\n      from,\n      to,"
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M18',
    note: '回滚任务改用 start 而不是 schtasks —— 任务不会被 Task Scheduler 持有，助手必被作业对象杀掉',
    file: 'packaging/windows/tools/launcher.mjs',
    anchor: /spawnSync\('schtasks', \[\s*'\/Create'/g,
    count: 2,
    apply: (s) => s.replace(
      /spawnSync\('schtasks', \[(\s*)'\/Create'/g,
      "spawnSync('start', [$1'/Create'"
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'C1',
    note: '对照组：只加一行注释，不应被拦截',
    file: 'packaging/windows/tools/lib/rollback.mjs',
    anchor: /export const FAILURE_THRESHOLD = 2;/g,
    count: 1,
    apply: (s) => s.replace(
      'export const FAILURE_THRESHOLD = 2;',
      '// control\nexport const FAILURE_THRESHOLD = 2;'
    ),
    layer: 'check-wb',
    expect: 'NOT-BLOCKED',
  },
];
