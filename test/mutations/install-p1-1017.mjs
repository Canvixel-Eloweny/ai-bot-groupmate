/**
 * P1 数据分离（2026-10-18）的定向变异清单。
 *
 * 目标：验收 `check-wb` §107「单一根解析」真的会红，而不是一条漂亮的空断言。
 * 复跑：`NODE_OPTIONS= node scripts/mutate.mjs test/mutations/install-p1-1017.mjs`
 */

export default [
  {
    id: 'M1',
    note: '面板 spawn 漏注入 QQBOT_USER_ROOT —— 机器人会按自己的默认根另算一份配置',
    file: 'panel/server.js',
    anchor: /QQBOT_USER_ROOT: USER_ROOT,/m,
    count: 1,
    apply: (s) => s.replace('QQBOT_USER_ROOT: USER_ROOT,', '// 变异：漏注入用户根'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M2',
    note: '机器人 cwd 回退到 USER_ROOT —— 程序入口与运行目录分离后相对路径会指错',
    file: 'panel/server.js',
    anchor: /cwd: PROGRAM_ROOT,/m,
    count: 1,
    apply: (s) => s.replace('cwd: PROGRAM_ROOT,', 'cwd: USER_ROOT,'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M3',
    note: 'DATA_DIR 不再从根解析器 re-export，扩展包兼容面断掉',
    file: 'src/config.js',
    anchor: /export\s*\{\s*DATA_DIR\s*\}\s*from\s*'\.\/user-root\.js';/m,
    count: 1,
    apply: (s) => s.replace(
      "export { DATA_DIR } from './user-root.js';",
      "export const DATA_DIR = path.join(PROGRAM_ROOT, 'data');"
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M4',
    note: 'panel/lib/paths.js 不再 import 根解析器 —— 面板又会自己推一份根',
    file: 'panel/lib/paths.js',
    anchor: /from '\.\.\/\.\.\/src\/user-root\.js';/m,
    count: 1,
    apply: (s) => s.replace(
      "from '../../src/user-root.js';",
      "from '../../src/user-root.js?mutation';"
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M5',
    note: '程序根推导锚点被换成 process.cwd() —— cwd 一换，全部路径失效',
    file: 'src/user-root.js',
    anchor: /path\.resolve\(path\.dirname\(fileURLToPath\(import\.meta\.url\)\), '\.\.'\)/m,
    count: 1,
    apply: (s) => s.replace(
      "path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')",
      'path.resolve(process.cwd())'
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'C1',
    note: '对照组：只加一行注释，不应被拦截',
    file: 'src/user-root.js',
    anchor: /export const PROGRAM_ROOT/m,
    count: 1,
    apply: (s) => s.replace('export const PROGRAM_ROOT', '// control\nexport const PROGRAM_ROOT'),
    layer: 'check-wb',
    expect: 'NOT-BLOCKED',
  },
];
