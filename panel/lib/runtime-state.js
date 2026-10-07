/**
 * 面板进程的**运行时状态单例**（第 37 轮 B11b-1 · AR-SERVERSPLIT）
 * ══════════════════════════════════════════════════════════════════════════
 *  为什么必须**只有一个**（而不是各模块各留一份）
 * ══════════════════════════════════════════════════════════════════════════
 *  这个对象里装的是"跨请求共享、会被多个模块同时读写"的东西：
 *  自己 spawn 的桥接进程、本地模型进程、日志环形缓冲、Docker 退出时刻。
 *
 *  拆分时最容易犯的错是"谁用到谁复制一份"——那会有两种表现，都不报错：
 *    · 面板上读到的日志与写进去的日志**不是同一个数组** → 日志时有时无；
 *    · `bridge` 字段一处被赋值、另一处仍为 null → 「一键全停」找不到进程。
 *
 *  所以：**它属于一个模块，别人只 import 引用，绝不复制。**
 *
 * ⚠️ `state` + `logDropped` + `pushLog` 是**一对半**，必须待在一起：
 *    `/api/logs` 的游标是「累计第几行」的绝对编号，算法是
 *    `total = logDropped + state.logs.length`。
 *    把它们拆到两个模块，就等于把一个不变量的两半分家 —— 而它一旦错位，
 *    表现是「面板日志冻住不动」（历史真出现过，注释里有完整记录）。
 *
 * ⚠️ 本模块零依赖，属依赖图最底层（F.3 的 L0）。别给它加 import。
 */

/**
 * 运行状态。字段都是"进程活着的时候才有意义"的东西，**刻意不落盘**：
 * 重启面板本就该重新探测，把瞬时态持久化只会制造"孤儿记录"（B10c · O-EPHEMERAL）。
 */
export const state = {
  bridge: null, // 自己 spawn 出来的桥接进程
  bridgePid: null, // 包含「接管」来的进程 pid
  bridgeStartedAt: 0,
  logs: [], // 环形日志
  lastExit: null,
  localModel: null, // 本地模型服务进程
  localModelKey: '', // 当前加载的规格（见 paths.js 的 LOCAL_MODELS 消费方）
  localChannel: '', // 这个进程跑在哪条通道上（mlx / qwenchat）
  dockerQuitAt: 0, // 上次「让 Docker 退出」的时间点（见 proc.js 的 ensureDocker 保护）
};

/** 日志环形缓冲上限 */
export const MAX_LOG = 600;

/**
 * 环形日志从最前面挤掉了多少行。
 *
 * 为什么必须单独记：前端的游标是「累计第几行」的绝对编号，而数组下标每挤出一行
 * 就整体前移一位。少了这个计数，日志一满 total 就永远停在 600、前端游标也跟着卡在
 * 600，之后 `slice(600)` 恒为空 —— 面板日志彻底冻住，只能靠清日志或刷新页面恢复。
 *
 * ⚠️ `export let` 是**活绑定**：本模块里重新赋值，import 方读到的是新值。
 *    （这一点是它能被搬出主文件的前提；换成"导出 getter"就必须改掉所有调用点。）
 */
export let logDropped = 0;

/** 往环形日志里压一行（支持多行文本，按行拆开逐条记录） */
export function pushLog(line) {
  const ts = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  for (const l of String(line).split('\n')) {
    if (!l.trim()) continue;
    state.logs.push(`[${ts}] ${l}`);
  }
  if (state.logs.length > MAX_LOG) {
    const over = state.logs.length - MAX_LOG;
    state.logs.splice(0, over);
    logDropped += over;
  }
}

/**
 * 清空日志缓冲。
 *
 * ⚠️ 为什么必须做成函数、而不是让外面直接写 `logDropped = 0`：
 *   ① **ESM 的 import 绑定是只读的** —— 外部赋值会抛 `TypeError: Assignment to constant variable`。
 *      这不是理论风险：B11b-1 搬完第一次跑沙箱就撞上了，`/api/logs/clear` 与
 *      `withProgress 仍返回后端结果` 两条断言同时红。
 *   ② 更重要的：`state.logs` 与 `logDropped` 是**一对**不变量 ——
 *      `total = logDropped + state.logs.length`。只清一个，前端的绝对游标就永远对不上，
 *      表现是"清完日志后它再也不动了"（历史里出现过这个 bug）。
 *      封在这里，外面就没有机会只清一半。
 */
export function clearLogs() {
  state.logs = [];
  logDropped = 0;
}
