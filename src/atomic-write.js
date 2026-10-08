/**
 * 原子写（第 35 轮 B10a · O-ATOMIC）
 * ══════════════════════════════════════════════════════════════════════════
 *  为什么要它
 * ══════════════════════════════════════════════════════════════════════════
 *  旧的 `writeFileSync(file, json)` 是**原地覆盖**：写到一半被读，读到的就是半个 JSON。
 *  本项目里这件事天天在发生 —— 机器人每 20 秒刷一次 `panel/effective.json`，
 *  面板每 3 秒轮询读它一次；配置保存同理。
 *
 *  后果不是报错，而是：读侧靠 `try/catch` 兜住，于是"这一帧读不到"表现为
 *  **面板上某个字段短暂空白**，用户看到的是"它偶尔抽风"，谁也不会往"写坏了"上想
 *  —— 正是本项目反复要消灭的那类静默失效。
 *
 *  改法：**写临时文件 + rename**。rename 在同一目录内是原子操作，
 *  读侧要么看到旧的全份、要么看到新的全份，**永远看不到半份**。
 *
 *  两条刻意的设计：
 *   ① **临时文件必须与目标同目录** —— 跨文件系统 rename 会 EXDEV，那就不是原子了。
 *   ② **失败一定删掉临时文件** —— 否则每失败一次就在目录里留一个垃圾，
 *      而这些目录是会被 rsync 进沙箱的（垃圾会跟着进 /tmp）。
 *
 *  ③ **但"失败"只覆盖得到"这次调用失败"**（第 48 轮 B12e-4 补）：
 *    进程在 `writeFileSync` 与 `renameSync` 之间被强杀时，谁都没机会清理 ——
 *    临时文件会永久留下。所以另配一个**启动时清扫**（`sweepStaleTemps`，见文件末）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

/**
 * 生成一个**同目录**的临时文件名。
 * 带上 pid 与随机后缀：多个进程同时写同一目标时不会互相踩掉对方的临时文件。
 */
export function tmpPathOf(file) {  const dir = path.dirname(file);
  const base = path.basename(file);
  return path.join(dir, `.${base}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
}

/**
 * rename，并在 EPERM / EACCES 时先 chmod 再试一次。
 *
 * 为什么要这一层：macOS 上目标文件被设为只读（或被锁）时，rename 会 EPERM，
 * 而此时**临时文件已经写完**了 —— 不重试就直接失败，等于这次写入整个丢掉。
 * chmod 失败也要继续试 rename：目标可能根本不存在，那时 rename 本来就能成功。
 */
function renameOrChmodRetry(tmp, file) {
  try {
    fs.renameSync(tmp, file);
    return;
  } catch (e) {
    if (e.code !== 'EPERM' && e.code !== 'EACCES') throw e;
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      /* 目标不存在时必然失败，无所谓 —— 下面那一试才是正解 */
    }
    fs.renameSync(tmp, file);
  }
}

/**
 * 原子地写一段文本。失败时**一定**删掉临时文件，然后把错误抛给调用方
 * （调用方决定要不要忽略 —— 这里不替它做"静默吞掉"的决定）。
 */
export function writeTextAtomic(file, text, { mode } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = tmpPathOf(file);
  try {
    fs.writeFileSync(tmp, text, mode == null ? undefined : { mode });
    renameOrChmodRetry(tmp, file);
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* 连临时文件都删不掉（权限）就到此为止，别让清理掩盖真正的错误 */
    }
    throw e;
  }
}

/** 原子地写一个 JSON。`spaces` 给 null 就是紧凑单行（JSONL 的场景用得上）。 */
export function writeJsonAtomic(file, value, { mode, spaces = 2, trailingNewline = true } = {}) {
  const text = JSON.stringify(value, null, spaces) + (trailingNewline ? '\n' : '');
  return writeTextAtomic(file, text, { mode });
}

/**
 * 把"读回来 + 截断 + 写回"这三步合起来，用在 JSONL 的折半截断上。
 *
 * 为什么连截断也要原子：旧实现是 `writeFileSync(file, 后半段)` 原地覆盖 ——
 *  它跟**同一时刻的 append** 撞车时，append 进来的那一行会被整段覆盖掉。
 *  表现是"刚刚那条对话记录不见了"，而且再也查不到。
 */
export function truncateLinesAtomic(file, maxLines, keepRatio = 0.5) {
  let lines = [];
  try {
    lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  } catch {
    return 0; // 读不到就当没有，不折腾
  }
  if (lines.length <= maxLines) return 0;
  const keep = Math.max(1, Math.round(maxLines * keepRatio));
  const dropped = lines.length - keep;
  writeTextAtomic(file, lines.slice(-keep).join('\n') + '\n');
  return dropped;
}

/**
 * ══════════════════════════════════════════════════════════════════════
 *  清扫"属主已死"的临时文件（第 48 轮 B12e-4 · EX-TEMPSWEEP）
 * ══════════════════════════════════════════════════════════════════════
 *
 *  ────────────────────────────────────────────────────────────────────
 *  它要堵的那个洞：本文件上面那句"失败**一定**删掉临时文件"有一个前提
 *  ────────────────────────────────────────────────────────────────────
 *  那个 `catch` 只在**这次调用失败**时生效。如果进程在 `writeFileSync` 与
 *  `renameSync` 之间**被强杀**（SIGKILL / 崩溃 / 关机），临时文件就永久留在磁盘上。
 *
 *  实测（2026-09-21）：`panel/` 下躺了 6 个 —— 5 个 `..thinking.json.<pid>.*.tmp`
 *  + 1 个 `.effective.json.<pid>.*.tmp`，属主 pid 20162 早已不在进程表里。
 *  两个后果都不报错：① 一直污染 `git status`（它们没被 gitignore）；
 *  ② 每次被 rsync 进沙箱（垃圾跟着进 /tmp）。
 *
 *  ────────────────────────────────────────────────────────────────────
 *  判据为什么用"年龄"而不是"查进程表"
 *  ────────────────────────────────────────────────────────────────────
 *  最直觉的做法是"解析文件名里的 pid，看它还在不在"。但：
 *    · `src/` 侧没有查进程表的工具（`panel/lib/proc.js` 在面板那一侧，`src` 不该 import 它），
 *      为一个清理动作新开一条跨层依赖，代价大于收益；
 *    · pid 会回绕，"pid 还活着"不等于"那个 pid 还是当初那个进程"。
 *  → 改用**双条件**：`pid != 我自己` **且** `年龄 > TMP_STALE_MS`。
 *    - "不是我的" 保证不会删掉**本进程**正在写的临时文件（那是正在进行的写）；
 *    - "够旧" 保证不会删掉**另一个活着进程**正在写的（它刚创建，一定很新）。
 *    两个条件都是 fail-safe 方向：**宁可留下一个垃圾，也不删掉一个正在用的临时文件。**
 *
 *  ⚠️ `TMP_STALE_MS` 是**经验值**（不是任何官方阈值）：一次原子写的耗时是毫秒级，
 *     一小时足够跨越任何正常的慢磁盘 / 长 GC 停顿。
 */
export const TMP_STALE_MS = 60 * 60 * 1000;

/**
 * 临时文件名的判据。**与 `tmpPathOf` 是同一份形状**（生成与识别不许各写一遍）。
 * 形状：`.<目标文件名>.<pid>.<8 位十六进制>.tmp`
 */
const TMP_NAME_RE = /^\..+\.(\d+)\.([0-9a-f]{8})\.tmp$/;

/** 这个名字是不是本模块产生的临时文件。**纯函数**。 */
export function isTempName(name) {
  return TMP_NAME_RE.test(String(name ?? ''));
}

/**
 * 从"目录里的文件清单"里挑出**该删的**那些。**纯函数**（不碰 IO，`now` 由入参给）。
 *
 * @param {Array<{name:string, mtimeMs:number}>} entries
 * @param {{now?:number, ownPid?:number, maxAgeMs?:number}} [opts]
 * @returns {string[]} 该删的文件名
 */
export function staleTempsIn(entries, { now = Date.now(), ownPid = process.pid, maxAgeMs = TMP_STALE_MS } = {}) {
  const out = [];
  for (const e of Array.isArray(entries) ? entries : []) {
    const m = TMP_NAME_RE.exec(String(e?.name ?? ''));
    if (!m) continue;
    if (Number(m[1]) === Number(ownPid)) continue; // 我自己的 —— 可能正在写
    const t = Number(e?.mtimeMs);
    if (!Number.isFinite(t)) continue; // 拿不到时间就**不删**（fail-safe）
    if (now - t <= maxAgeMs) continue; // 另一个活着进程刚建的
    out.push(e.name);
  }
  return out;
}

/**
 * 扫若干目录，删掉"属主已死"的临时文件。**本模块唯一的 IO 入口**。
 *
 * 永不抛：目录不存在 / 单个文件删不掉都只是跳过（下次启动再来）。
 *
 * @param {string[]} dirs 要扫的目录（本项目写原子的地方只有两个：仓库根与 `panel/`）
 * @param {{now?:number, ownPid?:number, maxAgeMs?:number, log?:{warn?:Function}}} [opts]
 * @returns {string[]} 实际删掉的**绝对路径**
 */
export function sweepStaleTemps(dirs, opts = {}) {
  const removed = [];
  for (const dir of Array.isArray(dirs) ? dirs : []) {
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue; // 目录不在（比如沙箱里没拷 panel/）就当没有
    }
    const entries = [];
    for (const name of names) {
      if (!isTempName(name)) continue;
      try {
        entries.push({ name, mtimeMs: fs.statSync(path.join(dir, name)).mtimeMs });
      } catch {
        /* 竞态：刚好被别的进程删了/改名了 —— 跳过 */
      }
    }
    for (const name of staleTempsIn(entries, opts)) {
      const full = path.join(dir, name);
      try {
        // ⚠️ `recursive: true` 是**必需的**（D21）：临时产物不只两种 —— 本仓现在还有
        //    "临时**目录**"（扩展包安装的 staging/备份，名字同形状、内容是目录）。
        //    不带 recursive 时对非空目录抛 `ERR_FS_EISDIR`，被下面的 catch 吞掉 →
        //    目录**永远清不掉**，而且每次启动都刷一条 warn（看起来像"清扫在工作"）。
        fs.rmSync(full, { recursive: true, force: true });
        removed.push(full);
      } catch (e) {
        const fn = opts.log?.warn;
        if (typeof fn === 'function') fn(`清理临时文件失败（忽略）：${full} · ${e?.message ?? e}`);
      }
    }
  }
  return removed;
}

// ══════════════════════════════════════════════════════════════════════════
//  独占提交 / 独占替换（D19 的 W1 · 2026-09-29）
// ══════════════════════════════════════════════════════════════════════════
//  背景（外包任务1 复核实证，本仓已复现结构）：`acquireLock` 是「读 → 判 → **普通覆盖写**」，
//  **没有任何独占创建原语** —— 两个进程同时读到一个"没有锁"的状态就会**双双占锁**。
//  实测口径（8 进程对齐启动）：现行 6/6 轮双抢。
//
//  为什么"原子写"救不了它：`writeTextAtomic` 的原子性只保证**单进程写出来的文件是完整的**，
//  它**不表达"我是第一个"**。要表达"第一个"，必须有一种"**不存在才创建**"的操作 ——
//  在 POSIX 上就是 `link`（硬链接）与 `mkdir`，两者都是"已存在即失败"。
//
//  ⚠️ 为什么不用 `openSync(file, 'wx')`：它会**先创建出一个空文件**、然后才写内容。
//     那中间有一个窗口：另一个进程读到一个**空文件**，判成"锁损坏"，于是**接管**。
//     `link` 没有这个窗口 —— 目标一出现就是完整内容。
//
//  ⚠️ 临时文件沿用本模块的命名形状（`.<base>.<pid>.<hex>.tmp`）——
//     于是 `sweepStaleTemps` **自动**管它，不用再写第二套命名与清扫规则。

/**
 * 独占创建：`file` **不存在时才**写入，存在则抛 `EEXIST`（原样抛出，由调用方重判）。
 *
 * @param {string} file
 * @param {string} text
 * @param {{mode?:number}} [opts]
 * @throws 已存在时 `e.code === 'EEXIST'`
 */
export function linkExclusiveSync(file, text, { mode } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = tmpPathOf(file);
  try {
    fs.writeFileSync(tmp, text, mode == null ? undefined : { mode });
    fs.linkSync(tmp, file);
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* 临时文件删不掉不影响主流程 */ }
  }
}

/**
 * 回收令牌的路径。**名字固定**（不像 tmp 那样带随机串）—— 它是要给**别的进程**找到的。
 *
 * ⚠️ 因此它**不在** `isTempName` 的形状里，`sweepStaleTemps` 不会碰它 ——
 *    陈旧令牌由 `reclaimExclusiveSync` 自己的 `staleMs` 兜底清理。
 *    代价是三件套要把它一起覆盖：`.gitignore` / 沙箱排除都写 `panel/.bridge.lock*`。
 */
export function tokenPathOf(file) {
  const dir = path.dirname(file);
  const base = path.basename(file);
  return path.join(dir, `.${base}.reclaim`);
}

/**
 * 独占**替换**（接管路径）：先抢回收令牌，拿到令牌后**再验一次**"目标还是不是我读到的那份"，
 * 才 unlink + 独占重建。
 *
 * ⚠️ 为什么验两次：令牌只挡住"同时抢"的人 —— **令牌释放之后才出手**的迟到者
 *    会把刚写好的新锁覆盖掉。外包实测：只加令牌时接管仍有 2/6 轮双抢，补上二次验旧后 0/6。
 *
 * @param {string} file
 * @param {string} text
 * @param {{verify?:() => boolean, staleMs?:number, mode?:number, now?:number}} [opts]
 * @throws 已存在 / 二次验旧失败时 `e.code === 'EEXIST'`（由调用方重判并拒绝）
 */
export function reclaimExclusiveSync(file, text, { verify, staleMs = 10000, mode, now = Date.now() } = {}) {
  const tok = tokenPathOf(file);
  // ① 抢令牌（tmp + link 的独占创建，与 linkExclusiveSync 同一套形状）
  const tokTmp = `${tok}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  fs.mkdirSync(path.dirname(tok), { recursive: true });
  fs.writeFileSync(tokTmp, `${now}\n`);
  try {
    fs.linkSync(tokTmp, tok);
  } catch (e) {
    try { fs.unlinkSync(tokTmp); } catch { /* 无所谓 */ }
    if (!(e && e.code === 'EEXIST')) throw e;
    // 陈旧兜底：上次换锁途中崩了留下的令牌 —— 清掉重抢一次
    let stale = false;
    try { stale = now - fs.statSync(tok).mtimeMs > staleMs; } catch { /* 刚被清掉 */ }
    if (!stale) throw e;
    try { fs.unlinkSync(tok); } catch { /* 有人先清了 */ }
    fs.writeFileSync(tokTmp, `${now}\n`);
    try { fs.linkSync(tokTmp, tok); } finally { try { fs.unlinkSync(tokTmp); } catch { /* 无所谓 */ } }
  }
  try { fs.unlinkSync(tokTmp); } catch { /* 无所谓 */ }
  try {
    if (typeof verify === 'function' && !verify()) {
      const e = new Error('目标在令牌等待期间已被替换（二次验旧失败）');
      e.code = 'EEXIST';
      throw e;
    }
    try { fs.unlinkSync(file); } catch { /* 可能已被清掉 */ }
    linkExclusiveSync(file, text, { mode });
  } finally {
    try { fs.unlinkSync(tok); } catch { /* 无所谓 */ }
  }
}
