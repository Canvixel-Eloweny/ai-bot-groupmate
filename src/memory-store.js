/**
 * 自我记忆的**读盘口 + 两个文件路径**（第 19 轮 · H-10 第二半从 `memory.js` 拆出）。
 * ══════════════════════════════════════════════════════════════════════════
 * ⚠️ **为什么要拆这个叶子**（本文件存在的全部理由）：
 *   `memory.js` 静态 `import scoped from './logger.js'`，而 `logger.js` →
 *   `egress.js` 在 **import 期就有副作用**（`compiled(SECRET_RULES)` 编译凭据特征表
 *   + 装入本次生效的凭据值）。于是 `panel/lib/*` 只要 import `memory.js`，
 *   面板进程的启动路径就被拖进机器人的凭据装载—— 那正是 §82 白名单要防的后果，
 *   也是 `collectState` / `buildExport` 两块一直搬不动的**唯一**原因。
 *
 *   而面板真正需要的恰好是**两个纯读函数**（`listAutoMemory` / `readRecords`）——
 *   实测两者体内**零 log 引用**。把它们连同路径常量搬到这个叶子里，
 *   面板侧只引这份纯读实现，机器人的启动链一点没被拖进来。
 *
 * ⚠️ **判据仍然只有一份**：写路径与所有判据都留在 `memory.js`，它从本文件
 *   import 这两个函数与路径并**转出** —— 面板与机器人读的是同一份实现。
 *   本文件不复制任何判据，只有 I/O 与路径。
 *
 * ⚠️ **本文件刻意是「只读」的**（不搬 `writeRecords`）：
 *   写入要走 `src/atomic-write.js` 的原子写纪律，而面板的状态聚合与导出包
 *   **只读不写**。把它留在 `memory.js` 就让这个叶子的 `src/` 依赖**真的为零**
 *   （实测传递闭包 = 它自己一个模块），进 `LIB_SRC_ALLOW` 时闭包干净到无需论证。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 解析两个记忆文件的位置（**唯一一份**判据）。
 *
 * ⚠️ **为什么是函数而不是裸常量**（第 19 轮实测踩到的坑）：
 *   测试的做法是「设好 `process.env.QQBOT_MEMORY_RECORDS` → 再
 *   `import('../src/memory.js?probe=…')`」，靠**缓存穿透**拿到一份按新env 重算的模块。
 *   若把路径算成模块级常量，算的位置就在**哪个模块**里成了问题：
 *   常量住在 `memory.js` 时，穿透 `memory.js` 就能重算；搬进本叶子后，
 *   穿透 `memory.js` **不会**连带穿透本叶子 ⇒ 测试读到的仍是真机那份文件
 *   （实测 8 条结构化记忆用例当场报红，`条数=16` 就是真机的条数）。
 *
 *   所以这里给的是**函数**：`memory.js` 在自己被重新 import 时调一次，
 *   拿到的就是那一次的新 env —— 而「路径怎么算」仍然只有这一份实现。
 */
export function resolveMemoryFiles(env = process.env) {
  return {
    autoFile: env.QQBOT_AUTO_MEMORY_FILE
      ? path.resolve(env.QQBOT_AUTO_MEMORY_FILE)
      : path.join(ROOT, 'panel', 'auto-memory.jsonl'),
    recordsFile: env.QQBOT_MEMORY_RECORDS
      ? path.resolve(env.QQBOT_MEMORY_RECORDS)
      : path.join(ROOT, 'panel', 'memory-records.json'),
  };
}

// 模块级那一份：供**直接引本叶子**的消费者用（面板侧只读，且运行期不改 env）。
const FILES = resolveMemoryFiles();

// `QQBOT_AUTO_MEMORY_FILE` 与 `QQBOT_CONFIG` / `QQBOT_TRACE_FILE` / `QQBOT_USAGE_FILE`
// 同款：让测试能把它指去临时目录。
// 为什么必须有（B9 补上）：注入闸门是**唯一一条"拦住了"要断言的路径**，
// 而断言"拦住了"就得真的调一次写入函数 —— 没有这个开关，那一次调用会直接写进
// 用户真实的自动记忆文件里。这正是 B7 修过两次的「测试污染生产数据」，同一个坑的第三处。
export const AUTO_MEMORY_FILE = FILES.autoFile;

/** `QQBOT_MEMORY_RECORDS` 与同系列 env 同款：让测试指去临时目录 */
export const RECORDS_FILE = FILES.recordsFile;

/**
 * 读全部自动记忆，最近的在前。文件很小，直接同步读，不必上缓存。
 *
 * @param {string} [file] 覆盖读哪个文件（默认本模块解析出来的那份）。
 *   参数**不是**为了灵活，是为了上面注释里那条「缓存穿透」的路——
 *   `memory.js` 重新 import 时会把它自己解析出的路径显式传进来。
 */
export function listAutoMemory(file = AUTO_MEMORY_FILE) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const out = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const o = JSON.parse(line);
        if (o && o.text) out.push(o);
      } catch {
        /* 半行（正好在写）跳过 */
      }
    }
    return out.reverse();
  } catch {
    return []; // 文件不存在 = 还没记过任何东西，不是错误
  }
}

/**
 * 读结构化记忆的原始条目。
 *
 * ⚠️ 这一份是**投影**（原样读出，不做 `normalizeRecord`）——
 *   归一化是判据，住在 `memory-record.js`；这里只管把字节读进来。
 */
export function readRecords(file = RECORDS_FILE) {
  try {
    const o = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(o?.items) ? o.items : [];
  } catch {
    return [];
  }
}