/**
 * 瞬时态的判据（第 35 轮 B10c · O-EPHEMERAL）
 * ══════════════════════════════════════════════════════════════════════════
 *  区分「持久态」与「瞬时态」
 * ══════════════════════════════════════════════════════════════════════════
 *  持久态（配置、记忆、账本、对话流）落盘天经地义 —— 它们要跨重启存在。
 *  瞬时态（"正在生成"这类过渡标记）落盘是**妥协**：它跨进程边界，只能借文件传。
 *
 *  妥协的代价是**孤儿记录**：写好标记 → 进程被 SIGKILL / 断电 → 没人来删。
 *  于是读侧会继续声称"它正在生成"，而它其实早就不说话了。
 *  这正是横向报告里点名的"孤儿记录"风险，也是本项目最怕的那一类静默失效 ——
 *  不是报错，而是**说了一个已经不成立的谎**。
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  为什么判据要独立成纯函数
 * ══════════════════════════════════════════════════════════════════════════
 *  写侧（机器人：决定要不要留）与读侧（面板：决定信不信）是**两个进程**，
 *  各自写一遍判据就会漂移 —— 本项目已经在 `normalizeThinking` 上真实踩过一次
 *  （两份实现靠契约盯才没漂）。这里从一开始就只留一份。
 *
 *  纯函数（不碰 IO、不调 process.kill）才能被 smoke 直接断言：
 *  "死了的进程留下的标记不算数" 这句话必须真的被测到。
 */

/** 瞬时态标记的默认有效期。**经验值**：本机模型一条要十几秒，给足 20 倍余量。 */
const THINKING_TTL_MS = 180000;

/**
 * 一个"正在生成"的标记还算不算数。
 *
 * 两条判据**都要过**：
 *   ① 写它的进程还在不在 —— 这条最快，专门抓崩溃留下的孤儿；
 *   ② 标记有没有过期 —— 兜底"进程还在但卡住了"（比如一次异常长的生成）。
 *
 * @param entry  标记文件内容；null / 非法 → 不算数
 * @param opts.now     当前时间戳（**注入**的，为了能测）
 * @param opts.isAlive (pid) => boolean —— **注入**的，为了能测
 * @param opts.ttl     有效期，默认 {@link THINKING_TTL_MS}
 */
export function thinkingIsLive(entry, { now = Date.now(), isAlive, ttl = THINKING_TTL_MS } = {}) {
  if (!entry || typeof entry !== 'object') return false;

  // pid 缺失 = 旧格式写的（那版本没带 pid 字段）。**不能因此判它活着**：
  // 没有 pid 就无从核验，只能退回时间判据；也**不能判它死掉**，
  // 否则一次滚动升级期间（新旧版本交替）会把正在生成的标记抹掉。
  if (Number.isFinite(entry.pid)) {
    if (typeof isAlive !== 'function') return false; // 无从核验 → 不信（fail-closed）
    if (!isAlive(entry.pid)) return false;
  }

  if (!Number.isFinite(entry.t)) return false;
  return now - entry.t < ttl;
}

/**
 * 启动时该不该把磁盘上那份标记删掉。
 *
 * 与 {@link thinkingIsLive} 刻意**不同**：清理只认 pid（不认时间）。
 * 因为这一刻还没开始生成，任何活着的 pid 写的标记都属于**别的实例**，
 * 不能动；而"没有 pid 或 pid 已死"的就是遗留物，留着只会说谎。
 */
export function shouldClearStale(entry, { isAlive } = {}) {
  if (!entry || typeof entry !== 'object') return false; // 没有文件就不用清
  if (!Number.isFinite(entry.pid)) return true; // 旧格式 = 遗留物
  if (typeof isAlive !== 'function') return true; // 无从核验 → 当遗留物清掉
  return !isAlive(entry.pid);
}
