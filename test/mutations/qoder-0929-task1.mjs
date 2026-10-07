/**
 * 任务1v6 回执附件 · 「判据假绿」变异清单（3 条）—— 针对 D19 复核中发现的三处判据缺口
 *
 * 怎么跑（在**装有依赖**的仓库根）：
 *   node scripts/mutate.mjs 任务1v6回执-D19施工复核-0929-变异清单.mjs
 *   （mutate.mjs 把 plan 路径按仓库根解析；放在仓库外时请传绝对路径，或先拷进 test/mutations/）
 *
 * ⚠️ 本组 3 条的 `expect` **原来是 NOT-BLOCKED**（语义与常规变异相反：跑出"没被拦住"
 *   = 坐实缺口）。2026-09-29 我方已按回执补上三条断言（叶子 import 判据收敛成 `importsOf`、
 *   监听器回调体切片），**缺口已关** → 三条 expect 已翻成常规的 BLOCKED。
 *   保留原清单的意义：它是"这三类假绿形状"的可复跑回归，将来改坏就会红。
 *
 * 校验记录（提交前在 /tmp 上做过）：三条的锚点命中数 1/1、施加后内容变化、
 * ESM 真解析器（vm.SourceTextModule）语法 OK——与 mutate.mjs 的语法闸门同规、不执行被测文件。
 * 逐条"该补什么"写在 note 里。
 */

export default [
  {
    id: 'FG-1',
    note: '§43①（check-wb.mjs 约 5928 行）的 import 判据只认"单行 + 单引号"：'
      + '多行命名导入能带着裸调用 IO 一起骗过"依赖检查 + IO 检查"两道正则。'
      + '该补：按 AST 枚举 import（或至少覆盖"多行 / 双引号"两种形态 + 对 node: 内置名做反向枚举）。',
    file: 'src/bridge-lock.js',
    anchor: /export const LOCK_STALE_MS = 2 \* LOCK_HEARTBEAT_MS;/,
    count: 1,
    apply: (s) => s.replace(
      'export const LOCK_STALE_MS = 2 * LOCK_HEARTBEAT_MS;',
      "export const LOCK_STALE_MS = 2 * LOCK_HEARTBEAT_MS;\n\nimport {\n  readFileSync,\n} from 'node:fs';\nconst FG1 = () => readFileSync('/dev/null', 'utf8');"
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'FG-2',
    note: '§43① 的双引号形态同样漏：`import { readFileSync } from "node:fs";` + 裸调用 = 双 0 命中。'
      + '（附注：`child_process` 反而不易被绕——模块名里就含 `child_process` 子串，IO 正则接得住；fs 才是缺口。）'
      + '该补：同 FG-1，一条判据同时覆盖两种引号、两种折行。',
    file: 'src/bridge-lock.js',
    anchor: /export const LOCK_HEARTBEAT_MS = 45 \* 1000;/,
    count: 1,
    apply: (s) => s.replace(
      'export const LOCK_HEARTBEAT_MS = 45 * 1000;',
      'export const LOCK_HEARTBEAT_MS = 45 * 1000;\nimport { readFileSync } from "node:fs";\nconst FG2 = () => readFileSync("/dev/null", "utf8");'
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'FG-3',
    note: '§43⑥ 只查 fatal() 的函数体与"监听器存在"，**不查监听器真的接了 fatal()**：'
      + '把 uncaughtException 回调换成空函数 → 崩溃被吞（正是 M6 要防的行为），判据却全绿；'
      + 'test/ 下也没有任何用例覆盖这两个监听器（repo 级 grep：uncaughtException/unhandledRejection 0 处）。'
      + '该补：切片断言"两个监听器的回调体必须含 fatal("（配套一条变异）。',
    file: 'src/index.js',
    anchor: /process\.on\('uncaughtException', \(e\) => fatal\('未捕获异常', e\)\);/,
    count: 1,
    apply: (s) => s.replace(
      "process.on('uncaughtException', (e) => fatal('未捕获异常', e));",
      "process.on('uncaughtException', () => { /* FG-3：监听器不再接 fatal() */ });"
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
];
