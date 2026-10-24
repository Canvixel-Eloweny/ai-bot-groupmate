/**
 * 共用工具叶子 —— 三个入口脚本（check-env / setup / start）都只 import 这里，
 * 避免"同一件事写三遍"。
 *
 * 设计约束（刻意的，改动前先想清楚）：
 *  ① **零第三方依赖**：只允许 node: 内置模块。包里除了 `ws` 没有任何 npm 依赖，
 *     而 `ws` 是给 app/ 用的 —— 工具层不该让它多背一份。
 *  ② **一切以"位置"推导路径，不用 cwd**：用户是在"解压出来的那个目录"里双击 bat，
 *     但双击出来的 cwd 未必等于包根（Win11 有时给 `C:\Windows\System32`）。
 *     所以根目录一律从 `import.meta.url` 反推。
 *  ③ 所有"失败"都必须带上**下一步该做什么**，不允许只喊一句"失败"。
 */

import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadUserRoot } from './user-root-loader.mjs';
import { NAPCAT_LAUNCHER_CANDIDATES, NOT_LAUNCHER_RE, isNapcatLauncherName } from './napcat-shape.mjs';

// ── 路径（P1：根由 src/user-root.js 唯一解析）──────────────────────────────
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ROOTS = await loadUserRoot();
/**
 * 快速登录判据的**唯一实现**在 `app/src/napcat-login.js`。工具层只负责把目录给它。
 * 装包前（app 还不存在）导入失败 ⇒ null ⇒ 走二维码；不再在工具层抄第二份排序逻辑。
 */
const NAPCAT_LOGIN = await import(pathToFileURL(path.join(ROOTS.PROGRAM_ROOT, 'src', 'napcat-login.js')).href)
  .catch(() => null);

export const MODE = ROOTS.MODE;
export const PROGRAM_ROOT = ROOTS.PROGRAM_ROOT;
export const INSTALL_ROOT = ROOTS.INSTALL_ROOT;
export const USER_ROOT = ROOTS.USER_ROOT;
/** 兼容旧名：工具层原先的 ROOT 就是安装根。 */
export const ROOT = ROOTS.INSTALL_ROOT;
export const APP = ROOTS.PROGRAM_ROOT;
export const TOOLS = path.join(PACKAGE_ROOT, 'tools');
export const RUNTIME_NODE_DIR = path.join(ROOTS.INSTALL_ROOT, 'runtime', 'node');
export const NODE_EXE = path.join(RUNTIME_NODE_DIR, 'node.exe');
export const NAPCAT_DIR = ROOTS.NAPCAT_DIR;
export const NAPCAT_ZIP = path.join(NAPCAT_DIR, 'NapCat.Shell.zip');
/** 更新/下载的临时区（`userdata\update`）—— **不在协议端目录里**，见 fetchNapcatZip 的注释。 */
export const UPDATE_DIR = ROOTS.UPDATE_DIR;
export const CONFIG_JSON = ROOTS.CONFIG_FILE;
export const CONFIG_EXAMPLE = path.join(ROOTS.PROGRAM_ROOT, 'config.example.json');
export const SETUP_MARKER = ROOTS.SETUP_STATE_FILE;
export const MIGRATION_FILE = ROOTS.MIGRATION_FILE;
/** 版本单一来源：程序根的 package.json（P1 起不再在 setup/onekey 里各写一份）。 */
export const VERSION = JSON.parse(fs.readFileSync(path.join(ROOTS.PROGRAM_ROOT, 'package.json'), 'utf8')).version;

export const IS_WIN = process.platform === 'win32';
export const MIN_NODE = '22.13';

// ── 输出 ────────────────────────────────────────────────────────────────────
const C = {
  reset: '\u001b[0m', dim: '\u001b[2m', red: '\u001b[31m', green: '\u001b[32m',
  yellow: '\u001b[33m', cyan: '\u001b[36m', bold: '\u001b[1m',
};
const canColor = () => process.stdout.isTTY || process.env.FORCE_COLOR === '1';
const paint = (c, s) => (canColor() ? `${c}${s}${C.reset}` : s);

// nsExec feeds child stdout into the instfiles details view, which decodes bytes with
// the system codepage: UTF-8 Chinese (and our ✓/✗ marks) renders as mojibake on Chinese
// Windows (P9 group-test screenshot). Under the installer we therefore print ASCII:
// English wording plus '?' for anything non-ASCII left (e.g. a Chinese user name in a
// path). Manual runs keep full UTF-8. The primitive lives in install-layout.mjs (pure
// leaf) so bootstrap can use it before common.mjs is allowed to be imported.
import { installerMode as underInstaller, installerAscii as safe } from './install-layout.mjs';

export const say = (s = '') => console.log(safe(s));
export const ok = (s) => console.log(safe(underInstaller() ? `  [ok] ${s}` : `${paint(C.green, '  ✓')} ${s}`));
export const warn = (s) => console.log(safe(underInstaller() ? `  [!] ${s}` : `${paint(C.yellow, '  !')} ${s}`));
export const bad = (s) => console.log(safe(underInstaller() ? `  [x] ${s}` : `${paint(C.red, '  ✗')} ${s}`));
export const sayErr = (s = '') => console.error(safe(s));
export const title = (s) => console.log(`\n${paint(C.bold, s)}`);
export const dim = (s) => console.log(safe(paint(C.dim, s)));

// ── 小工具 ──────────────────────────────────────────────────────────────────
export function humanSize(n) {
  if (!Number.isFinite(n) || n < 0) return '?';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i += 1; }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)}${u[i]}`;
}

export function exists(p) { try { return fs.existsSync(p); } catch { return false; } }

/** 整个文件的 SHA-256（十六进制小写）。本包要哈希的件最大约 36MB，整读即可。 */
export function sha256File(p) {
  const h = createHash('sha256');
  h.update(fs.readFileSync(p));
  return h.digest('hex');
}

// ── 启动诊断（boot 日志）────────────────────────────────────────────────────
/**
 * 逐阶段启动诊断（2026-10-16 · Windows P0-3）：往 `<包根>/diag-out/boot-<日期>.log`
 * **同步追加**一行 —— "双击之后卡在哪一步 / 下载到底走没走到"这类问题过去只能靠人
 * 复述屏幕；现在 `4-DIAG` 会把这份日志的尾部一起收走（见 diag.mjs ⑥c）。
 *
 * 三条纪律（与「启动跟踪」同一取向）：
 *  ① **写本机本地时间**（给人读，与钟一致；不写 UTC —— 别再制造"13:55 是什么时候"）。
 *  ② **同步 append**：顺序即事实（异步写会把"谁先谁后"搅乱）。
 *  ③ **写不进去绝不抛**：诊断是锦上添花，不是任何流程的前置。
 */
export function diag(msg) {
  try {
    const d = new Date();
    const p2 = (n) => String(n).padStart(2, '0');
    const day = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
    const stamp = `${day} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
    const dir = path.join(USER_ROOT, 'diag-out');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, `boot-${day}.log`), `[${stamp}] ${msg}\n`, 'utf8');
  } catch { /* 纪律 ③：写不进去就算了 */ }
}

/** 递归找出**全部**命中（找启动器/配置时要看全再排序，不能只拿第一个碰到的）。 */
function findAll(dir, predicate, { maxDepth = 5, skip = new Set(['node_modules', 'QQ']) } = {}) {
  const out = [];
  const walk = (d, depth) => {
    if (depth > maxDepth) return;
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (skip.has(e.name)) continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (predicate(e.name, full)) out.push(full);
    }
  };
  walk(dir, 0);
  return out;
}

// ── 端口 ────────────────────────────────────────────────────────────────────
/** 探测回环端口上"有没有东西应答"。与项目 `panel/lib/paths.js` 同一口径：只问在不在。 */
export function portOpen(port, host = '127.0.0.1', timeout = 1200) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host });
    const done = (v) => { s.destroy(); resolve(v); };
    s.setTimeout(timeout);
    s.once('connect', () => done(true));
    s.once('timeout', () => done(false));
    s.once('error', () => done(false));
  });
}

export async function waitPort(port, ms, step = 800) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await portOpen(port)) return true;
    await sleep(step);
  }
  return false;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 下载（带镜像回退 / 断点续传 / 进度 / 真值校验 / 超时与预算）──────────────
/**
 * 网络的下限（2026-10-18 · P6）：**宁可这一次不下，也不要把安装器挂死。**
 *
 * 来历：Windows 安装器在 `nsExec` 里同步调用本函数下载 NapCat，而 NSIS 的进度条
 * 在外部进程里**不会推进** —— 于是任何时长都表现成"卡在最后一格"。在维护者的
 * Windows 11 测试机上实测（2026-10-18 18:47 · 3MB Range 探针 · `--max-time 25`，
 * 原文见 `INSTALLER-SPEC.md` §21 引用的探针输出）：
 *   · 第一候选 `gh-proxy.com`  3,000,001 B / 13.097 s = **229,064 B/s**（≈224 KiB/s）
 *     ⇒ 官方包 35,884,742 B ≈ **2.6 分钟**；
 *   · 第二候选 `ghproxy.net`   1,173,044 B / 25.003 s = **46,919 B/s**（≈46 KiB/s），
 *     且**在 25 秒处被 max-time 截断**（curl rc=28）⇒ 按这一档 ≈ **12.7 分钟**；
 *   · `github.com` 与 `api.github.com` **0 字节、curl rc=6**（DNS 直接解析失败）。
 * ⇒ 两个镜像**差 5 倍**，而第二候选连 3MB 都要 25 秒都拉不完 —— 这才是"看起来卡死"的量级。
 * 而这里原来**一个超时都没有**（同仓的元数据口 `lib/versions.mjs` 反倒有 8 秒，
 * 注释写着"宁可查不到，也不要让安装卡在一台断网的机器上"）。
 * ⇒ 五个数字全部具名、可被 `check-wb` §114 静态解析，不许改回魔法数。
 */
/** DNS + TLS + 首个响应头的上限。实测坏 DNS 在 0.02 秒就失败，这条只管"挂住不动"。 */
export const CONNECT_TIMEOUT_MS = 12000;
/** 两个数据块之间的最大静默；**每收到一个 chunk 重新计时**。 */
export const STALL_TIMEOUT_MS = 20000;
/** 15 秒滑动窗口的最低存活速率（字节/秒）。低于它 = 这个源还活着但没用，判死并回退。 */
export const MIN_ALIVE_BYTES_SEC = 15000;
/** 单个源最多占用的时间，超了就换下一个。 */
export const PER_SOURCE_BUDGET_MS = 150000;
/** 整轮（所有源加起来）的预算；耗尽 ⇒ 抛 `code='DOWNLOAD_BUDGET'`，**保留 `.part`** 供下次续传。 */
export const TOTAL_BUDGET_MS = 300000;

/**
 * 从候选 URL 依次尝试下载到 dest。
 *
 * ⚠️ 为什么不直接用 `fetch` 一把梭：实测直连 GitHub 只有 ~20KB/s（会挂死），
 *    而镜像 ~130KB/s。**30MB 的包在用户机器上可能更慢**，所以必须
 *    ① 支持多镜像回退；② 打印进度与速率（否则用户以为卡死了）；
 *    ③ 支持 `.part` 断点续传（重跑 SETUP 不从头再来）。
 *
 * ⚠️ 2026-10-16 增强（Windows P0-2），四条都围绕"用户看到的数字要可信"：
 *    ① `expectedSha256`：拿到官方哈希就**整份重算**（含续传留下的前半段 ——
 *       残段被改过、或两次下载来自不同版本，都会在这里现形）。对不上 ⇒
 *       丢弃残段**自动从头重下一次**（`.part` 被改的自我修复），再对不上才换镜像；
 *    ② 非 TTY（输出被重定向、被日志收走）时不再用 `\r` 原地刷新 —— 改成**每 10%
 *       一行**（`\r` 在非 TTY 里会拼成一坨，把日志搅花过）；
 *    ③ TTY 进度行带 **ETA**（"还要多久"比"已下多少"更能安抚用户）；
 *    ④ 报错翻出 `error.cause`（`fetch failed` 没有信息量，`ECONNRESET` /
 *       `ENOTFOUND` 才指向真原因）。
 *
 * ⚠️ 2026-10-18（P6）加的两条：
 *    ⑤ **超时与预算**：连接 / 空闲 / 存活速率 / 单源 / 总预算五道，任何一道触发都
 *       换下一个源或收工，**不存在"一直等"**；总预算耗尽 ⇒ 抛 `err.code='DOWNLOAD_BUDGET'`
 *       并**保留 `.part`**（调用方是被"转交"而不是被"取消"，下次续传从断点起，
 *       与 `panel/lib/update-download.js` 的"取消即删残段"是**有意的不对称**）；
 *    ⑥ `expectedSize`：官方尺寸一给，源返回的总长对不上就**当场判这个源不对**
 *       （以前 `total > 0 &&` 的守卫意味着服务端不给 `content-length` 时，
 *        截断流也会被当成成功）。
 *
 * @param {string[]} urls  候选 URL，按顺序试
 * @param {string} dest    最终文件路径
 * @param {{expectedSha256?:string, expectedSize?:number, budgetMs?:object, onProgress?:Function}} [opt]
 *        官方哈希（十六进制小写）与官方字节数；`budgetMs` 只给测试注入用（缩小时间尺度），
 *        生产路径一律用上表的具名常量。
 * @returns {Promise<{url:string, bytes:number, sha256:string}>} sha256 = 校验通过的实测值（没给期望值时为 ''）
 */
export async function downloadWithMirrors(urls, dest, opt = {}) {
  const { expectedSha256 = '', expectedSize = 0 } = opt;
  const budget = {
    connectMs: CONNECT_TIMEOUT_MS,
    stallMs: STALL_TIMEOUT_MS,
    minAliveBytesPerSec: MIN_ALIVE_BYTES_SEC,
    perSourceMs: PER_SOURCE_BUDGET_MS,
    totalMs: TOTAL_BUDGET_MS,
    ...(opt.budgetMs || {}),
  };
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const part = `${dest}.part`;
  const errors = [];
  let budgetHit = false; let slowHit = false;
  const tAll = Date.now();
  const errText = (e) => {
    if (!e) return String(e);
    const cause = e.cause ? (e.cause.code || e.cause.message || String(e.cause)) : '';
    return cause ? `${e.message || e}（${cause}）` : (e.message || String(e));
  };

  for (const url of urls) {
    // 一个源最多两轮：① 带续传正常下载；② 校验不过 ⇒ 丢弃残段从头再来一次。
    for (let round = 0; round < 2; round += 1) {
      if (Date.now() - tAll > budget.totalMs) {
        errors.push(`${url} → 总预算 ${Math.round(budget.totalMs / 1000)} 秒已用尽，不再试下一个源`);
        budgetHit = true;
        break;
      }
      if (round === 1) {
        try { fs.rmSync(part, { force: true }); } catch { /* 下面用 'w' 截断也能盖掉 */ }
        say('    ! previous part failed verification - discarded the partial file, restarting from scratch');
      }
      const offset = round === 0 && exists(part) ? fs.statSync(part).size : 0;
      // 三道计时器共用一个 AbortController：连接超时（拿到响应头即撤）、
      // 空闲超时（**每收到一个 chunk 重挂**）、单源预算（到点就放弃这个源）。
      const ctl = new AbortController();
      const abortWith = (why) => { try { ctl.abort(new Error(why)); } catch { /* 已 abort */ } };
      let idleTimer = null;
      let sourceTimer = null;
      const armStall = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => abortWith('空闲超时（一段时间内没有任何数据到达）'), budget.stallMs);
      };
      const sourceDeadline = Date.now() + budget.perSourceMs;
      let out = null; // 半途 abort 也必须在 finally 关掉：Windows 上留着的句柄会让下一个源写不进同一个 .part
      let connectTimer = null;
      try {
        connectTimer = setTimeout(() => abortWith('连接超时'), budget.connectMs);
        armStall();
        sourceTimer = setTimeout(() => abortWith('单源预算耗尽'), Math.max(sourceDeadline - Date.now(), 1));
        const res = await fetch(url, {
          signal: ctl.signal,
          ...(offset > 0 ? { headers: { Range: `bytes=${offset}-` } } : {}),
        });
        clearTimeout(connectTimer);
        if (!res.ok) { errors.push(`${url} → HTTP ${res.status}`); break; }
        if (Date.now() > sourceDeadline) { errors.push(`${url} → 单源预算耗尽`); budgetHit = true; break; }
        let startAt = 0; // 服务端不认 Range（不是 206）：从头来
        if (offset > 0 && res.status === 206) {
          // ⚠️ 续传必须核对起点：Content-Range 的起始字节不等于我们的残段长度，
          //    说明服务端记的是**另一份**内容，接上去只会得到一个哈希对不上的文件。
          const cr = res.headers.get('content-range') || '';
          const from = /^bytes (\d+)-/.exec(cr);
          if (!from || Number(from[1]) !== offset) {
            fs.rmSync(part, { force: true });
            errors.push(`${url} → 续传起点与残段不符（Content-Range：${cr || '缺失'}），已丢弃残段`);
            continue; // 残段没了 ⇒ 回到 round 1，从 0 整份重下
          }
          startAt = offset;
        }
        const totalHeader = Number(res.headers.get('content-length') || 0);
        const total = startAt + totalHeader;
        if (expectedSize > 0 && total > 0 && total !== expectedSize) {
          // 总长与官方记录不符 = 源不对（或残段接错），当场判死，别等哈希才发现
          errors.push(`${url} → 尺寸 ${total} 与官方记录 ${expectedSize} 不符`);
          if (startAt > 0) { fs.rmSync(part, { force: true }); continue; }
          break;
        }
        say(`  downloading... ${url}`);
        if (total > 0) dim(`  total ${humanSize(total)} (resumable: re-run this script after an interruption)`);

        out = fs.createWriteStream(part, startAt > 0 ? { flags: 'a' } : { flags: 'w' });
        out.on('error', () => { /* 半途 destroy 的 premature-close 错误不该掀翻进程 */ });
        let got = startAt;
        let lastPrint = 0;
        let nextMark = 0.1; // 非 TTY 的 10% 打点
        const t0 = Date.now();
        let winStart = t0;
        let winBytes = 0;
        for await (const chunk of res.body) {
          armStall(); // 活着就重新计时 —— 这条是 §114 数的"逐块重挂"
          if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
          got += chunk.length;
          winBytes += chunk.length;
          const now = Date.now();
          // 存活速率地板：还连着但基本不动的源，比彻底断连更坏（用户看不见进度），
          // 所以每 15 秒算一次窗口速率，低于地板就放弃这个源去试下一个。
          if (now - winStart >= 15000) {
            const rate = winBytes / ((now - winStart) / 1000);
            winStart = now;
            winBytes = 0;
            if (rate < budget.minAliveBytesPerSec) { abortWith(`速率过低（约 ${Math.round(rate)}B/s）`); continue; }
          }
          if (process.stdout.isTTY) {
            if (now - lastPrint > 500) {
              lastPrint = now;
              const rate = (got - startAt) / 1024 / Math.max((now - t0) / 1000, 0.001);
              const pct = total > 0 ? `${((got / total) * 100).toFixed(1)}% ` : '';
              const eta = total > 0 && rate > 1 ? ` · ETA ${fmtEta((total - got) / 1024 / rate)}` : '';
              process.stdout.write(`\r  ${pct}${humanSize(got)}${total > 0 ? ` / ${humanSize(total)}` : ''}  ${rate.toFixed(0)}KB/s${eta}   `);
            }
          } else if (total > 0 && got / total >= nextMark) {
            nextMark = Math.min(0.95, nextMark + 0.1);
            say(`  progress ${Math.floor((got / total) * 100)}% (${humanSize(got)} / ${humanSize(total)})`);
          }
        }
        await new Promise((r) => out.end(r));
        if (process.stdout.isTTY) process.stdout.write(`\r${' '.repeat(72)}\r`);

        if (total > 0 && got < total) { errors.push(`${url} → 不完整（${got}/${total}）`); break; }

        // 真值校验：整份重算（含续传的前半段）。不过 ⇒ 同源从头再来一轮。
        if (expectedSha256) {
          const gotHex = sha256File(part);
          if (gotHex !== expectedSha256) {
            if (round === 0) continue;
            errors.push(`${url} → SHA-256 校验不过（期望 ${expectedSha256.slice(0, 12)}… 实测 ${gotHex.slice(0, 12)}…）`);
            break;
          }
          fs.renameSync(part, dest);
          return { url, bytes: got, sha256: gotHex };
        }
        fs.renameSync(part, dest);
        return { url, bytes: got, sha256: '' };
      } catch (e) {
        const why = errText(e);
        errors.push(`${url} → ${why}`);
        if (/超时|预算|速率过低/.test(why)) slowHit = true; // 是"太慢"，不是"没网"——说法要分开
        break; // 网络层出错：换下一个源（round 重试只服务于"校验不过"那一类）
      } finally {
        if (connectTimer) clearTimeout(connectTimer);
        if (idleTimer) clearTimeout(idleTimer);
        if (sourceTimer) clearTimeout(sourceTimer);
        if (out) { try { out.destroy(); } catch { /* 已经关了 */ } }
      }
    }
  }
  const err = new Error(`所有下载源都失败了：\n    - ${errors.join('\n    - ')}`);
  // 三种失败各有各的下一步，调用方（bootstrap）据此写状态文件，不许混成一句"失败"：
  //   DOWNLOAD_BUDGET 总预算耗尽（最可能：镜像活着但太慢）
  //   DOWNLOAD_SLOW   各源都因超时/断流/速率过低被放弃
  //   DOWNLOAD_FAILED 源本身就连不上/返回不对（没网、404、尺寸不符…）
  err.code = budgetHit ? 'DOWNLOAD_BUDGET' : slowHit ? 'DOWNLOAD_SLOW' : 'DOWNLOAD_FAILED';
  err.sources = errors;
  throw err;
}

/** 秒数 → 人话 ETA（`45s` / `2m05s`）。 */
function fmtEta(sec) {
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
}

// ── 解压（Windows 上只用系统自带能力，不装任何东西）─────────────────────────
/**
 * 解压 zip 到 dir。
 * Windows 10 1809+ 自带 `tar.exe`（bsdtar，认 zip）；更老的系统回退 PowerShell。
 * 两者都在就会走 tar —— 它比 Expand-Archive 快一个量级。
 */
export function unzip(zipPath, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const tries = [
    ['tar', ['-xf', zipPath, '-C', dir]],
    // Linux 的 GNU tar 不认 zip；Windows 的 bsdtar 认。补一条 unzip，让同一份工具
    // 在 ubuntu runner 上也能跑 p6 的放置用例（Windows 上没有 unzip 时仍走 tar）。
    ['unzip', ['-q', zipPath, '-d', dir]],
    ['powershell', ['-NoProfile', '-NonInteractive', '-Command',
      `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${dir.replace(/'/g, "''")}' -Force`]],
  ];
  const errs = [];
  for (const [cmd, args] of tries) {
    // 用 spawnSync 而不是 execSync：不经 shell，路径里的中文与空格不会被二次解释。
    const r = spawnSync(cmd, args, { stdio: 'pipe', windowsHide: true });
    if (!r.error && r.status === 0) return cmd;
    errs.push(`${cmd} → ${r.error ? r.error.message : `退出码 ${r.status}`}`);
  }
  throw new Error(`解压失败（${path.basename(zipPath)}）：\n    - ${errs.join('\n    - ')}`);
}

// ── 子进程 ──────────────────────────────────────────────────────────────────
/** 前台跑一条命令并把输出收回来（用于 `reg query` 这类"只想知道结果"的探测）。 */
export function run(exe, args, { timeout = 8000 } = {}) {
  return new Promise((resolve) => {
    let out = '';
    let child;
    try {
      child = spawn(exe, args, { windowsHide: true });
    } catch (e) {
      resolve({ code: -1, out: e.message });
      return;
    }
    const timer = setTimeout(() => { try { child.kill(); } catch { /* 已退出 */ } }, timeout);
    child.stdout?.on('data', (d) => { out += d; });
    child.stderr?.on('data', (d) => { out += d; });
    child.once('error', (e) => { clearTimeout(timer); resolve({ code: -1, out: e.message }); });
    child.once('close', (code) => { clearTimeout(timer); resolve({ code, out }); });
  });
}

/** 交互式提问（只需要 node 内置 readline，不引 prompt 库）。 */
export async function ask(question, { def = '', validate } = {}) {
  // 非交互（stdin 不是 TTY / 被脚本拉起）时 readline 的 question 永不 settle ——
  // Node 会以 "unsettled top-level await" + exit 13 收场，后面的收尾一步都不做。
  // 有默认值就用默认值；必填项没有默认值就抛一句明确的错，让调用方知道该加 --yes。
  if (!process.stdin.isTTY) {
    const err = validate ? validate(def) : null;
    if (err) throw new Error(`非交互模式无法询问「${question}」，且没有可用的默认值：${err}`);
    return def;
  }
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (;;) {
      const suffix = def ? ` ${paint(C.dim, `[回车=${def}]`)}` : '';
      const a = (await rl.question(`  ${paint(C.cyan, '?')} ${question}${suffix} `)).trim() || def;
      const err = validate ? validate(a) : null;
      if (!err) return a;
      bad(err);
    }
  } finally {
    rl.close();
  }
}

/** 读 JSON；坏文件不抛异常，交给调用方决定怎么办。 */
export function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

export function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
}

export function loadNapcatSource() {
  const p = path.join(TOOLS, 'napcat.json');
  const cfg = readJson(p);
  if (!cfg) throw new Error(`下载源清单读不出来：${p}`);
  return cfg;
}

/**
 * NapCat 官方包的**候选下载 URL**（镜像打头、直连垫底）。
 * ⚠️ 只有这一份：`setup.mjs`（老入口）与 `lib/repair.mjs`（一键安装）都调它 ——
 *    以前两边各写了一遍，改一处漏一处是迟早的事。
 */
export function napcatUrls(src, tag) {
  const base = src.downloadTemplate
    .replace('{repo}', src.repo).replace('{tag}', tag).replace('{asset}', src.asset);
  const list = (src.mirrors || []).map((m) => (m.endsWith('/') ? m + base : `${m}/${base}`));
  list.push(base); // 直连排最后：实测最慢，还可能挂死
  return list;
}

/** 判断"本文件是不是被直接双击/直接跑的那个"。Windows 与 macOS 都能用。 */
export function isMain(metaUrl) {
  const self = fileURLToPath(metaUrl);
  const argv1 = process.argv[1];
  if (!argv1) return false;
  const norm = (p) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
  return norm(self) === norm(argv1);
}

// ── NapCat 定位（形状判据住在 lib/napcat-shape.mjs，这里只做"找文件"）────────
// 那张候选表 + 排除表 + 粗判函数搬到了零依赖叶子 `napcat-shape.mjs`，因为构建脚本
// `make-vm-copy.mjs` 也要同一份判据，而它不能 import 本文件（本文件在模块求值时
// 就要解析安装/用户根）。搬走之后"协议端长什么样"全 tools 侧只有一处定义。
// ⚠️ 来历与两次指错的教训写在 napcat-shape.mjs 的头注释里，改表之前先读那段。
export { NAPCAT_LAUNCHER_CANDIDATES, NOT_LAUNCHER_RE, isNapcatLauncherName };
export const NAPCAT_LAUNCHER_RE = NAPCAT_LAUNCHER_CANDIDATES[0]; // 保留导出：只用于"像不像"的粗判

/**
 * @param {string} [dir=NAPCAT_DIR] 要检查的目录。
 *   ⚠️ 这个参数是 P6 加的，为的是"先验暂存目录、再提交"：离线放包必须能对一个
 *   **还没落到 NAPCAT_DIR** 的目录说"这里面确实有启动器"。写死成 NAPCAT_DIR
 *   就等于逼调用方先提交再检查 —— 那时已经来不及了。
 */
export function findNapcatLauncher(dir = NAPCAT_DIR) {
  if (!exists(dir)) return null;
  const files = findAll(dir, (name) => /\.(bat|exe|cmd)$/i.test(name), { maxDepth: 3 })
    .filter((p) => !NOT_LAUNCHER_RE.test(path.basename(p)))
    .sort(); // 排序是第二重保险：结果不再依赖文件系统的返回顺序
  // ① 按候选表优先级挑
  //
  // ⚠️ 同一优先级内**必须挑得确定**（2026-10-09 · 真机首跑）。候选正则
  //    `/^launcher[\w-]*\.bat$/i` 在 `NapCat.Shell.Windows.OneKey` 里会**同时**命中
  //    launcher.bat / launcher-user.bat / launcher-win10.bat 好几个，而原来的
  //    `files.find(...)` 是"谁先被 readdir 返回就用谁"。除 `*-user` 版之外的几个开头会做
  //    `net session` 管理员检查，非管理员时用 `Start-Process -Verb runAs` **另开一个提权窗口
  //    再 exit** ⇒ 原窗口一闪而过，扫码提示跑到别的窗口去（没装 Windows Terminal 时干脆不出现）。
  //    那正是用户报上来的"双击 3-START-NAPCAT.bat 不显示二维码"。
  //    `*-user` 版不提权也能跑通，所以同一优先级内**固定优先它**。
  for (const re of NAPCAT_LAUNCHER_CANDIDATES) {
    const hits = files.filter((p) => re.test(path.basename(p)));
    if (hits.length === 0) continue;
    return hits.find((p) => /-user\.bat$/i.test(p)) || hits[0];
  }
  // ② 兜底：家目录里第一个 .bat / .exe（官方若又改了命名，宁可先指一个再让用户改，
  //    也不要因为认不出名字就说"没装好"）。
  const home = flattenSingleDir(dir);
  const local = files.filter((p) => path.dirname(p) === home || path.dirname(path.dirname(p)) === home);
  return local[0] || files[0] || null;
}

/** NapCat 的"家" = 启动器所在目录。解压后可能多套一层目录，所以必须动态求。 */
export function napcatHome(dir = NAPCAT_DIR) {
  const l = findNapcatLauncher(dir);
  return l ? path.dirname(l) : exists(dir) ? dir : null;
}

/**
 * 把 `srcDir` **覆盖**到 `dstDir`（只复制，不删除目标里已有的东西）。
 *
 * ⚠️ 只**覆盖**、**不删除**：官方每个版本的文件集合不完全一样，删旧文件
 *    会把"上一版有、这一版没有"的依赖连带清掉（例如它自己的数据目录）。
 * ⚠️ `preserve` 里的名字**整个跳过** —— 默认保住 `config/`（NapCat 的登录态与
 *    OneBot 配置都在那里，是用户扫过码的唯一凭证）。
 *
 * 住在 common.mjs 是因为有两个消费者要用**同一份**覆盖语义：
 * `lib/repair.mjs`（下载后升级）与 `lib/napcat-local.mjs`（用户自带件）。
 * 各写一份的话，将来一定是一份保 config、一份不保 —— 那是会丢登录态的那种分叉。
 *
 * @param {string} srcDir 解压出来的（已 flatten 的）新版本目录 / 用户选的目录
 * @param {string} dstDir 现有 NapCat 的家
 * @returns {number} 复制的文件数
 */
export function overlay(srcDir, dstDir, { preserve = new Set(['config']) } = {}) {
  let copied = 0;
  const walk = (rel) => {
    const from = rel ? path.join(srcDir, rel) : srcDir;
    const to = rel ? path.join(dstDir, rel) : dstDir;
    fs.mkdirSync(to, { recursive: true });
    for (const e of fs.readdirSync(from, { withFileTypes: true })) {
      if (preserve.has(e.name)) continue;
      const f = rel ? path.join(rel, e.name) : e.name;
      if (e.isDirectory()) walk(f);
      else { fs.copyFileSync(path.join(srcDir, f), path.join(dstDir, f)); copied += 1; }
    }
  };
  walk('');
  return copied;
}

/** NapCat 的 OneBot11 配置（形如 `onebot11_<QQ号>.json`，也可能是不带号的默认件）。 */
export function findOnebotConfigs() {
  if (!exists(NAPCAT_DIR)) return [];
  return findAll(NAPCAT_DIR, (name) => /^onebot11.*\.json$/i.test(name), { maxDepth: 5 });
}

/** 本工具写出来的那两份（账号那份 + 模板那份）—— 选模板时要能把它们认出来。 */
export function isOwnOnebotFile(name, qq) {
  const n = String(name ?? '').toLowerCase();
  return n === 'onebot11.json' || n === `onebot11_${String(qq)}.json`.toLowerCase();
}

// ── OneBot11 配置的形状（**唯一实现**）────────────────────────────────────────
/**
 * 内置兜底结构。只在"官方包里连一份可克隆的模板都没有"时才会用到，
 * 用到时调用方**必须**如实说明"这是生成的"。
 */
export const FALLBACK_ONEBOT11 = {
  network: {
    httpServers: [],
    httpSseServers: [],
    httpClients: [],
    websocketServers: [],
    websocketClients: [],
    plugins: [],
  },
  musicSignUrl: '',
  enableLocalFile2Url: false,
  parseMultMsg: false,
  imageDownloadProxy: '',
  timeout: { baseTimeout: 10000, uploadSpeedKBps: 1024, downloadSpeedKBps: 1024, maxTimeout: 60000 },
};

/** 同端口已有就不重复加；已有就把 name/enable/host/port 对齐（幂等）。 */
export function ensureEntry(list, { name, port, extra = {} }) {
  const arr = Array.isArray(list) ? list : [];
  const hit = arr.find((x) => x && Number(x.port) === port);
  if (hit) {
    Object.assign(hit, { name: hit.name || name, enable: true, host: '127.0.0.1', port });
    return arr;
  }
  arr.push({ name, enable: true, host: '127.0.0.1', port, ...extra });
  return arr;
}

/**
 * 把「WebSocket 3001 + HTTP 3000，仅监听 127.0.0.1」补到一份 OneBot11 配置里（幂等）。
 *
 * ⚠️ 这是全项目唯一一处知道"我们要哪两个服务端"的地方 —— `setup.mjs`（首次对齐）
 *    与 `start-napcat.mjs`（为已登录账号补配置）都调它，谁都不许再抄一份。
 */
export function withOnebotServers(cfg) {
  const out = cfg && typeof cfg === 'object' ? cfg : structuredClone(FALLBACK_ONEBOT11);
  out.network = out.network || structuredClone(FALLBACK_ONEBOT11.network);
  out.network.websocketServers = ensureEntry(out.network.websocketServers, {
    name: 'qqbot-ws',
    port: 3001,
    extra: { messagePostFormat: 'array', reportSelfMessage: false, token: '', enableForcePushEvent: true, debug: false, heartInterval: 30000 },
  });
  out.network.httpServers = ensureEntry(out.network.httpServers, {
    name: 'qqbot-http',
    port: 3000,
    extra: { enableCors: true, enableWebsocket: false, messagePostFormat: 'array', token: '', debug: false, reportSelfMessage: false },
  });
  return out;
}

/** 这份配置里 3001 / 3000 两个服务端是不是都已经在了。 */
export function hasOnebotServers(cfg) {
  const ws = Array.isArray(cfg?.network?.websocketServers) ? cfg.network.websocketServers : [];
  const http = Array.isArray(cfg?.network?.httpServers) ? cfg.network.httpServers : [];
  return ws.some((x) => Number(x?.port) === 3001) && http.some((x) => Number(x?.port) === 3000);
}

/**
 * 这台机器上 **NapCat 见过哪些账号**。
 *
 * ⚠️ 为什么需要它（第 58 轮真机发现的一个真缺陷）：
 *    NapCat 只在 `config/onebot11_<实际登录的QQ>.json` 里读 OneBot 配置，而本包的
 *    `setup.mjs` 写的是 `onebot11_<用户输入的QQ>.json`。两者对不上时，NapCat 会自建
 *    一份 **httpServers / websocketServers 全空**的默认配置 ⇒ **3000/3001 永远不开，
 *    而且零报错**（面板只会说"协议端没有响应"）。用户把号输错一位就会踩中。
 *    NapCat 自己会写 `napcat_<QQ>.json` / `napcat_protocol_<QQ>.json` 记录登录过的账号 ——
 *    那就是"真号"的唯一来源。
 */
export function knownAccounts() {
  const home = napcatHome() || NAPCAT_DIR;
  const dir = path.join(home, 'config');
  if (!exists(dir)) return [];
  const out = new Set();
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  for (const n of names) {
    const m = /^napcat(?:_protocol)?_(\d{5,12})\.json$/i.exec(n);
    if (m) out.add(m[1]);
  }
  return [...out].sort();
}

/**
 * NapCat **最近登录过**的那个账号（按 `napcat_<QQ>.json` 的修改时间排）。
 *
 * ⚠️ 为什么需要"最近"而不只是"有哪些"（2026-10-11 · 免扫码那一环）：
 *    快速登录要把 QQ 号作为参数传给启动器，而一台机器上登录过多个号时，
 *    `knownAccounts()` 返回的是**字典序**（数字当字符串排）——
 *    那与"用户上一次用的是哪个号"毫无关系。取了字典序第一个，
 *    表现就是"明明上次登的是 A，这次却拿 B 去快速登录 ⇒ 登录态对不上 ⇒ 又弹二维码"。
 *    按 mtime 取才是"上一次"，而 mtime 正是 NapCat 每次登录自己会去更新的东西。
 *
 * @returns {Array<{qq:string, mtime:number}>} 最近的排在最前
 */
export function knownAccountsByMtime() {
  const dir = path.join(napcatHome() || NAPCAT_DIR, 'config');
  return NAPCAT_LOGIN ? NAPCAT_LOGIN.knownAccountsByMtimeIn(dir) : [];
}

/**
 * 这次启动要拿去**快速登录**的 QQ 号。
 *
 * ⚠️⚠️ **唯一来源 = NapCat 自己留下来的登录记录**（2026-10-13 改）。
 *   以前还有两个来源，都已被移除，理由不是洁癖而是安全：
 *     ① 命令行 `--qq <号>`  —— 谁都能在命令行里写别人的号，机器照样拿它去登录；
 *     ② 安装时手填的号（`app/.qqbot-portable-setup.json` 的 `qq` 字段）—— 同样是人填的。
 *   "能免扫"这件事，证据只能是**这台机器上确实有人扫过码登录过这个号**
 *   （NapCat 每次登录会留下 `napcat_<QQ>.json`，这就是那条证据）；除此之外一律走扫码。
 *
 * 于是优先级只剩两级：
 *   ① NapCat 最近登录过的那个号（有登录态 ⇒ 免扫，掉线/换号时 NapCat 自己会退回二维码）
 *   ② 空 —— 走二维码（首次登录必然走到这一支）
 *
 * @param {string} argCli 保留参数（已不再使用；留着是为了让老调用点不炸）
 */
export function resolveLoginQq(argCli = '') {
  void argCli; // ⚠️ 刻意忽略：命令行指定号码这条路已经关掉（见上面的说明）
  const dir = path.join(napcatHome() || NAPCAT_DIR, 'config');
  return NAPCAT_LOGIN ? NAPCAT_LOGIN.resolveLoginQqIn(dir) : { qq: '', from: '' };
}

/** OneBot11 配置目录（NapCat 的家下面的 `config/`）。 */
export function napcatConfigDir() {
  const home = napcatHome() || NAPCAT_DIR;
  return path.join(home, 'config');
}

/** 解压 zip 后若恰好只有一个顶层目录，把它当成真正的家（官方包通常如此）。 */
export function flattenSingleDir(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return dir; }
  const dirs = entries.filter((e) => e.isDirectory());
  const files = entries.filter((e) => e.isFile());
  if (dirs.length === 1 && files.length === 0) return path.join(dir, dirs[0].name);
  return dir;
}

// ── QQ 客户端定位（自检与启动器**同一条判据**）────────────────────────────────
/**
 * QQ NT 装在哪。
 *
 * ⚠️ 为什么必须与 `app\napcat\launcher-user.bat` **同源**（2026-10-09 · 真机首跑）：
 *    `check-env.mjs` 原来只探 `%ProgramFiles%\Tencent\QQNT\QQ.exe` 等四个固定路径
 *    与 `HKCU\Software\Tencent\QQNT`，而启动器读的是 `HKLM\...\Uninstall\QQ` 的
 *    `UninstallString`。QQ 装在非 C 盘时（真机是 `E:\QQ\`）两条路都探不到 ⇒
 *    **自检说"没有检测到 QQ NT 版"，启动器却能找到它并跑起来**。用户被这句误报
 *    引去重装 QQ，纯属白费功夫 —— 而且会让人怀疑是包坏了。
 *
 * 判据只留一份：先注册表（与启动器同源），注册表缺失时才回落到固定路径。
 *
 * @returns {Promise<{found:boolean, where?:string}>}
 */
export async function findQQExe() {
  if (!IS_WIN) return { found: false };
  // ① 与 launcher-user.bat 同一条注册表项 —— 64 位系统上 32 位的 QQ 装在 WOW6432Node 下
  for (const key of [
    'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\QQ',
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\QQ',
  ]) {
    // eslint-disable-next-line no-await-in-loop
    const r = await run('reg', ['query', key, '/v', 'UninstallString']).catch(() => null);
    if (!r || r.code !== 0) continue;
    const m = r.out.match(/UninstallString\s+REG_SZ\s+(.+)/i);
    if (!m) continue;
    // `UninstallString` 指向 …\Uninstall.exe，它的目录就是安装目录
    const dir = path.dirname(m[1].trim().replace(/^"|"$/g, ''));
    if (exists(path.join(dir, 'QQ.exe'))) return { found: true, where: path.join(dir, 'QQ.exe') };
    if (exists(dir)) return { found: true, where: dir };
  }
  // ② 注册表查不到（绿色版 / 装法特殊）时才回落到固定路径
  const candidates = [
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Tencent', 'QQNT', 'QQ.exe'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Tencent', 'QQNT', 'QQ.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Tencent', 'QQ', 'QQ.exe'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Tencent', 'QQ', 'Bin', 'QQ.exe'),
  ].filter(Boolean);
  const hit = candidates.find((p) => exists(p));
  if (hit) return { found: true, where: hit };
  const reg = await run('reg', ['query', 'HKCU\\Software\\Tencent\\QQNT']).catch(() => null);
  if (reg && reg.code === 0 && /QQNT/i.test(reg.out)) return { found: true, where: '注册表 HKCU\\Software\\Tencent\\QQNT' };
  return { found: false };
}
