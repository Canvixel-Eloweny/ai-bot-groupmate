/**
 * 机器人**进程侧**的实例互斥锁 + 启动/崩溃留档 · 判据层（D19 · 报告 E19/E20）
 *
 * ══════════════════════════════════════════════════════════════════════
 *  它补的是哪一半
 * ══════════════════════════════════════════════════════════════════════
 *  R13 修的是**面板侧**那一半：面板在启动前扫残留、停止时杀掉全部实例。
 *  但"同一份数据目录里只允许一个机器人"这件事，**任何发起方**都该被拦住 ——
 *  直接 `node src/index.js`、`.app` 里的脚本、用户自己开的终端，都不经过面板。
 *  多实例的代价是实测过的：四个进程抢同一条群消息，用户只看到"它怎么回了两遍"。
 *
 *  所以本模块是**机器人自己的排他声明**，与 `panel/.bridge.pid` 语义不同：
 *    · `.bridge.pid` —— *面板眼里的* pid（面板写、面板删，机器人不碰它）；
 *    · `.bridge.lock` —— *机器人自己的*"我在这里跑"（谁都不能替别人删）。
 *
 * ══════════════════════════════════════════════════════════════════════
 *  拿不准时朝哪边倒 —— 方向是分开定的，不是一刀切
 * ══════════════════════════════════════════════════════════════════════
 *  · **锁写不进去**（磁盘满 / 权限）→ **degraded 放行** + 显式留档。
 *    理由：这是一个附属文件，因为写不进一个文件就不让机器人说话，代价不对等
 *    （宁可偶尔双开，也不要因为一个文件把机器人锁死）。
 *  · **锁指向一个活着的进程** → **拒绝启动**。
 *    理由反过来：真双开的代价是"在同一条群消息上回两遍"，用户当场就会看到。
 *  · **探针不可用**（lsof 缺失等）→ 放行 + 留档说明。理由：不能让一条探测命令
 *    把机器人永久锁死；这一支还要求"pid 活着 + 心跳停滞"，三重条件同时成立。
 *
 * ⚠️ 零依赖叶子：**IO 全部由入参给**（`readRaw` / `writeRec` / `unlink` / `alive` / `isOurs`）。
 *    于是"接管矩阵"的每一格都能在 smoke 里直接喂 —— 起两个真进程去测死锁
 *    是最难复现、也最容易把测试写成碰运气的那种用例。
 */

/** 心跳间隔（毫秒）。**经验值，非官方阈值。** 与 20s 的 effective 快照、30s 的 tick 同族。 */
export const LOCK_HEARTBEAT_MS = 45 * 1000;

/**
 * 心跳"停滞"的判据（毫秒）。**经验值，非官方阈值。**
 *
 * 取心跳的两倍：一次落空不算停滞（事件循环偶尔忙一下很正常），
 * 连续两次没打上才值得怀疑（多半是系统休眠，或者那个进程真的僵住了）。
 */
export const LOCK_STALE_MS = 2 * LOCK_HEARTBEAT_MS;

/**
 * "启动被拒"的退出码。
 *
 * ⚠️ 为什么不用 1：面板要能把这个事实**显示给人看**，而 1 与"自己崩了"分不开。
 *    页面读的是 `/api/state` 下发的这个数（不在前端再写一遍 3）。
 */
export const LOCK_REFUSE_EXIT_CODE = 3;

/** 留档上限（行）。**经验值**，与 `TRACE_MAX` 同族：有界 + 折半截断，不做轮转改名。 */
export const JOURNAL_MAX_LINES = 300;

/** 留档的单行消息上限（字符）。防一个超长错误把日志撑成一行几兆。 */
const JOURNAL_MSG_MAX = 400;

/**
 * 解析锁文件。**只做形状校验**，不做"能不能接管"的判断（那是 `lockDecision`）。
 * 读不出 pid 就返回 null —— 当作"锁损坏"，由判定阶梯去接管并记录原因。
 *
 * @param {string|object|null|undefined} raw
 * @returns {{pid:number, at:number, beatAt:number}|null}
 *
 * @sync-with json-object-guard —— 下面那段"原文 → 对象或 null"的守卫与
 *   `src/control-channel.js` 的 `parseControlRecord` **逐字相同**。两个文件都是**零依赖叶子**
 *   （契约 §43① / §42① 各自钉死"一个 import 都不许有"），谁都不许 import 谁 ⇒ 抽不出公共模块；
 *   于是按 §9 的登记体例处置：`check-wb` 的抽取器证明两份逐字一致（改一处漏一处从此可见）。
 */
export function parseLock(raw) {
  if (raw === null || raw === undefined) return null;
  let obj = raw;
  if (typeof raw === 'string') {
    const text = raw.trim();
    if (!text) return null;
    try {
      obj = JSON.parse(text);
    } catch {
      return null; // 半个 JSON（写盘被打断）与"没有它"同等对待：不猜
    }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const pid = Number(obj.pid);
  if (!Number.isFinite(pid) || pid <= 0) return null;
  const at = Number(obj.at);
  const beatAt = Number(obj.beatAt ?? obj.at);
  return { pid, at: Number.isFinite(at) ? at : 0, beatAt: Number.isFinite(beatAt) ? beatAt : 0 };
}

/** 锁的内容（唯一构造点）。`beatAt` 缺省等于 `at`：刚占上锁时心跳就是此刻。 */
export function lockBodyOf({ pid, at = Date.now(), beatAt }) {
  return { pid: Number(pid) || 0, at: Number(at) || 0, beatAt: Number(beatAt ?? at) || 0 };
}

/**
 * 心跳是否停滞。
 * ⚠️ `beatAt <= 0`（时间未知）判**不**停滞 —— 与 `interject` 的冷场判据同一条 fail-open 取向：
 *    未知不等于坏消息，拿未知去拒绝启动会把一次"文件读坏了"升级成"机器人起不来"。
 */
export function staleBeatOf(lock, { now = Date.now(), staleMs = LOCK_STALE_MS } = {}) {
  if (!lock) return false;
  if (!(lock.beatAt > 0)) return false;
  return now - lock.beatAt >= staleMs;
}

/**
 * pid 还活着吗。
 *
 * 三条取值口径都是刻意的：
 *   · `ESRCH` → 死了（残留锁，可以接管）；
 *   · `EPERM` → **活着**（只是不归我管）—— 这一支必须算活着，否则会去抢一个
 *     比我们有权限的进程的锁；
 *   · 其它异常 → 也当活着（fail-safe 方向：不确定就不抢）。
 *
 * @param {number} pid
 * @param {{kill?: Function}} [deps] `kill` 注入，测试才能喂这三种 errno
 */
export function pidAliveOf(pid, { kill = process.kill } = {}) {
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 0) return false;
  try {
    kill(n, 0);
    return true;
  } catch (e) {
    // ⚠️ 只有 **ESRCH** 才算"死了"。其它一律当活着：
    //    EPERM = 存在但不归我管；EINVAL / 未知 errno = 说不清。
    //    "说不清"朝"活着"倒，方向与整条锁的取向一致 —— 不确定就不要去抢。
    return !(e && e.code === 'ESRCH');
  }
}

/**
 * 判定阶梯（**唯一实现**）。五种"锁与实际不一致"的处置都在这里，一处也不能少：
 *
 * | 情形 | 处置 |
 * |---|---|
 * | 没有锁 / 锁损坏 | 接管（记录原因） |
 * | 锁是我的（自己的 pid） | hold：什么都不做 |
 * | pid 已死 | 接管（残留锁） |
 * | pid 活着，心跳新鲜 | **拒绝**（真占用） |
 * | pid 活着，心跳停滞，探针说是我们 | **拒绝**（"进程活着但心跳停滞（可能系统休眠）"） |
 * | pid 活着，心跳停滞，探针说不是我们 | 接管（pid 复用 / 无关进程） |
 * | pid 活着，心跳停滞，探针不可用 | 接管 + 留档说明（不让探测命令把机器人锁死） |
 *
 * @param {{pid:number,at:number,beatAt:number}|null} lock `parseLock` 的产物
 * @param {object} p
 * @param {number} p.ownPid
 * @param {number} p.now
 * @param {(pid:number)=>boolean} p.alive
 * @param {(pid:number)=>(boolean|null)} p.isOurs `null` = 探针不可用
 * @param {number} [p.staleMs]
 * @returns {{action:'take'|'refuse'|'hold', reason:string}}
 */
export function lockDecision(lock, {
  ownPid = 0, now = Date.now(), alive = () => false, isOurs = () => null, staleMs = LOCK_STALE_MS,
} = {}) {
  if (!lock) return { action: 'take', reason: '没有锁（首次启动）' };
  if (lock.pid === Number(ownPid)) return { action: 'hold', reason: '锁就是本进程的' };
  if (!alive(lock.pid)) {
    return { action: 'take', reason: `锁是残留的：pid ${lock.pid} 已经不在进程表里` };
  }
  if (!staleBeatOf(lock, { now, staleMs })) {
    // 两种都判"拒绝"，但理由必须分开说：心跳新鲜 = 真的有实例在跑；
    // 心跳时间未知 = 拿不准，按**不放行**处理（pid 活着这一条本身就已经够可疑了）。
    const beat = lock.beatAt > 0 ? `心跳 ${Math.round((now - lock.beatAt) / 1000)} 秒前` : '心跳时间未知（锁的格式不对或时间戳坏了）';
    return { action: 'refuse', reason: `已有实例在跑：pid ${lock.pid}，${beat}` };
  }
  const ours = isOurs(lock.pid);
  if (ours === true) {
    return { action: 'refuse', reason: `已有实例在跑：pid ${lock.pid}（心跳停滞 ${Math.round((now - lock.beatAt) / 1000)} 秒，进程仍活着 —— 可能系统休眠过）` };
  }
  if (ours === false) {
    return { action: 'take', reason: `锁的 pid ${lock.pid} 活着但不是本项目的机器人（pid 复用或无关进程），心跳已停滞 ${Math.round((now - lock.beatAt) / 1000)} 秒` };
  }
  return { action: 'take', reason: `锁的 pid ${lock.pid} 活着、心跳停滞 ${Math.round((now - lock.beatAt) / 1000)} 秒，但探测工具不可用 —— 按可接管处理（不让一条探测命令把机器人永久锁死）` };
}

/**
 * 占锁（**唯一入口**）。把「读 → 判 → 写」三步合成一次动作，IO 全部入参。
 *
 * ⚠️ 写失败 → `degraded` 放行（见文件头"拿不准时朝哪边倒"）。
 * ⚠️ `isOurs` 只在"pid 活着且心跳停滞"那一支才会被调用 —— 探针要起子进程，
 *    不能每次启动都跑。
 *
 * @returns {{ok:boolean, action:'take'|'refuse'|'hold', reason:string, body:object|null, tookOver:boolean, degraded?:boolean}}
 */
export async function acquireLock({
  // [W1a] `claimRec`（可选）：**独占提交** —— 首次占锁时用它（tmp + link，EEXIST 即输）。
  // [W1c] `reclaimRec`（可选）：接管路径的**独占替换**（先抢回收令牌，令牌内二次验旧后换锁）。
  // 两者都**不注入**时行为 = 现行版 + 一次读回自证（W1b）—— 老调用方不会被抛下。
  // 读 → 判 → 写之间的 TOCTOU 窗口，由"提交这一步是原子的、且失败方会重判"关掉。
  readRaw, writeRec, claimRec, reclaimRec, ownPid = 0, now = Date.now(),
  alive = () => false, isOurs = () => null, staleMs = LOCK_STALE_MS,
} = {}) {
  let lock = null;
  let broken = false;
  // [W1d] `raw` 提到外层：接管换锁前要拿它做**二次验旧**（"锁还是我刚读到的那份吗"）。
  let raw = null;
  try {
    raw = readRaw();
    lock = parseLock(raw);
    // 有内容但解析不出 pid = 锁损坏。这与"没有锁"处置相同，但**理由不同**，
    // 所以要分开记 —— 否则排障时会以为"锁从来不存在"，而去别处找原因。
    broken = lock === null && raw !== null && raw !== undefined && String(raw).trim() !== '';
  } catch {
    lock = null;
    broken = true; // 读不出来也当损坏：接管，但在留档里说明
  }
  const d = lockDecision(lock, { ownPid, now, alive, isOurs, staleMs });
  // "接管"与"首次启动"必须分得开：前者是一份**别人的/残留的**声明被我覆盖，
  // 后者只是从来没有过锁。混在一起的话，留档里每次启动都会冒充一次接管，
  // 而"接管"恰恰是排障时最想知道的那件事（谁被谁顶掉了）。
  const tookOver = (!!lock || broken) && d.action !== 'hold';
  if (d.action === 'refuse') return { ok: false, action: 'refuse', reason: d.reason, body: null, tookOver: false };

  const body = lockBodyOf({ pid: ownPid, at: now, beatAt: now });
  // [W1a] 首次占锁走独占提交 · [W1c] 接管走独占替换；两者都没注入才回落到覆盖写。
  const useClaim = !tookOver && typeof claimRec === 'function';
  const useReclaim = tookOver && typeof reclaimRec === 'function';
  // [W1d] 令牌只挡住"同时抢"的人；换锁前必须再验一次"锁还是我刚读到的那份" ——
  //       否则"令牌释放后才出手"的迟到者会覆盖掉刚写好的新锁（外包实测里那正是残余双抢的来源）。
  const verifyUnchanged = () => { try { return readRaw() === raw; } catch { return false; } };
  try {
    (useClaim ? claimRec : useReclaim ? (bd) => reclaimRec(bd, verifyUnchanged) : writeRec)(body);
  } catch (e) {
    if (e && e.code === 'EEXIST') {
      // 有人在我读之后、提交之前先占上了 —— **重读重判并如实拒绝**（不猜、不覆盖）。
      // 这是整个 W1 的落点：输的一方不再"照写不误"，而是承认自己输了。
      let fresh = null;
      try { fresh = parseLock(readRaw()); } catch { /* 读不回来也不猜 */ }
      const d2 = fresh
        ? lockDecision(fresh, { ownPid, now: Date.now(), alive, isOurs, staleMs })
        : { reason: '锁在提交的瞬间被占上（读不回来）' };
      return { ok: false, action: 'refuse', reason: `锁在提交的瞬间被另一个实例占上了：${d2.reason}`, body: null, tookOver: false };
    }
    return {
      ok: true,
      action: 'take',
      tookOver,
      degraded: true,
      reason: `${d.reason}；但锁写不进去（${e.message}）—— 本次按 degraded 放行，不因为一个附属文件把机器人挡住`,
      body: null,
    };
  }
  // [W1b] 兜底自证：只有**没走任何独占路径**（两个 IO 都没注入）时才需要 ——
  //       写回读一次，锁里不是自己的 pid 就说明被后来者盖上了，按输处理（拒绝）。
  if (!useClaim && !useReclaim) {
    let back = null;
    try { back = parseLock(readRaw()); } catch { /* 读不回来按输处理更安全 */ }
    if (!back || back.pid !== Number(ownPid)) {
      return { ok: false, action: 'refuse', reason: '提交瞬间被另一个实例抢先（读回自证失败）', body: null, tookOver: false };
    }
  }
  const reason = broken ? '锁损坏（读不出 pid），已接管' : d.reason;
  return { ok: true, action: d.action, reason, body, tookOver };
}

/**
 * 续心跳。**仅当锁还是自己的**才写 —— 锁已易主时静默放弃（自愈，不报错刷屏）。
 * 「绝不覆盖别人的锁」这条在这里与 `releaseLock` 是同一条纪律。
 */
/**
 * 心跳写不上的**原因分类**。**封闭枚举** —— 调用方要按它分支。
 *
 * ⚠️ 为什么要有它（W2）：以前调用方只能拿到 `reason`（一句中文），
 *    于是"锁写不进去（degraded 家族，不该退出）"与"锁不是我的（真丢锁，该自逐）"
 *    只能靠**比对那句中文**来区分 —— 那正是本项目 D9 就踩过的「调用方拿文案当枚举」：
 *    文案一改，分支就静默走错。机器读的归 `kind`，人看的归 `reason`，两码事。
 */
export const HEARTBEAT_KINDS = Object.freeze(['ok', 'read-fail', 'not-owner', 'write-fail']);

export function heartbeatLock({ readRaw, writeRec, ownPid = 0, now = Date.now(), at = 0 } = {}) {
  let lock = null;
  try {
    lock = parseLock(readRaw());
  } catch {
    return { wrote: false, kind: 'read-fail', reason: '读不到锁' };
  }
  if (!lock || lock.pid !== Number(ownPid)) {
    return { wrote: false, kind: 'not-owner', reason: '锁不是本进程的（已易主或已删除）' };
  }
  try {
    writeRec(lockBodyOf({ pid: ownPid, at: lock.at || at || now, beatAt: now }));
  } catch {
    return { wrote: false, kind: 'write-fail', reason: '锁写不进去' };
  }
  return { wrote: true, kind: 'ok', reason: '' };
}

/**
 * 释放锁。**仅当 `lock.pid === 本进程`** 时才 unlink。
 *
 * ⚠️ 这一条是硬约束，不是洁癖：进程被强杀后锁会残留，下一个实例接管并写入**它自己的**
 *    pid；此时原来那个进程如果还活着（比如它只是被暂停过），它的退出钩子会把这个
 *    **别人的锁**删掉 —— 于是第三个实例又能起来，双开。
 */
export function releaseLock({ readRaw, unlink, ownPid = 0, now = Date.now() } = {}) {
  let lock = null;
  try {
    lock = parseLock(readRaw());
  } catch {
    return { released: false, reason: '读不到锁' };
  }
  if (!lock) return { released: false, reason: '没有锁' };
  if (lock.pid !== Number(ownPid)) return { released: false, reason: `锁不是本进程的（pid ${lock.pid}）—— 不删别人的锁` };
  try {
    unlink();
  } catch {
    return { released: false, reason: '删不掉（可能已经没了）' };
  }
  return { released: true, reason: '' };
}

/**
 * 留档一行（**唯一构造点**）。JSONL：人肉可读，也能 `jq` 批量看。
 *
 * 为什么是"一行 JSON"而不是纯文本：`msg` 里可能出现换行 / 制表符（错误信息、
 * 白名单串），纯文本格式会让一条记录变成好几行，折半截断时就会从句子中间切断。
 * `JSON.stringify` 天然把换行转义掉，这个坑不用再防一次。
 *
 * @param {{at?:number, kind:string, pid?:number, msg?:string}} p
 */
export function journalLineOf({ at = Date.now(), kind = '', pid = 0, msg = '' } = {}) {
  const text = String(msg ?? '').replace(/\s+/g, ' ').trim().slice(0, JOURNAL_MSG_MAX);
  return JSON.stringify({ t: Number(at) || 0, kind: String(kind || ''), pid: Number(pid) || 0, msg: text });
}
