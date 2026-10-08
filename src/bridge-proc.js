/**
 * 「这个进程到底是不是本项目的机器人」（第 35 轮 B9d · G-5）
 * ══════════════════════════════════════════════════════════════════════════
 *  它要治的是什么
 * ══════════════════════════════════════════════════════════════════════════
 *  旧实现用 `pgrep -f 'node src/index.js'` 找机器人，然后直接 `killTree`。
 *  `pgrep -f` 匹配的是**整个命令行文本**，于是命令行里**出现过**这段字符串的
 *  进程都会被选中 —— 实测（2026-09-19）：
 *
 *      $ sh -c 'echo "…node src/index.js…"; sleep 6' &
 *      $ pgrep -fl "node src/index.js"
 *      5250  sh -c echo "…node src/index.js…"; sleep 6     ← 不是机器人，也会被杀
 *      95006 …/bin/node src/index.js                       ← 真的机器人
 *
 *  后果：调用 `/api/bridge/start` 的那个 shell 会被自己发起的清理 SIGTERM 掉
 *  （exit 143）；编辑器、搜索工具、包装脚本同理。**杀错一个的代价远大于漏清一个。**
 *
 *  改法：先"发现"、再"核验"，**核验不过就绝不杀**。
 *  pgrep 仍然只用来**提名**候选，判定交给下面这个纯函数。
 *
 *  三条判据互相独立，缺一条就放掉：
 *   ① 可执行文件必须是 node —— 这一条就排掉了上面那个 `sh -c`，
 *      以及编辑器 / `grep` / `rg` 这类"命令行里含那段字符串"的进程；
 *   ② 命令行必须**以** `node <可选参数…> src/index.js` **结尾**，而不是"中间出现过"；
 *      （第 7 轮修正：`<可选参数…>` 不可省 —— 真机 argv 带着 `--max-old-space-size`，
 *        见下面 `ENTRY_RE` 的注释。旧写法把真机器人判成了"不是"。）
 *   ③ 工作目录必须是本项目根目录 —— 排掉"别的项目里也在跑 node src/index.js"。
 *
 *  全部 fail-closed：**任何一项取不到值（比如 lsof 探测失败）就判为不是我们的**。
 *  宁可留一个孤儿进程让用户手动处理，也绝不误杀一个无关程序。
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * node 可执行文件的名字。三种写法都算：`…/bin/node`、`…/bin/nodejs`、Windows 的 `…\node.exe`。
 *
 * ⚠️ `(?:\.exe)?` 与 `/i` 是 2026-10-08 为 Windows 补的：那边 `process.execPath` 形如
 *    `C:\Program Files\nodejs\node.exe`。少了它，下面的判据①会把**真的机器人**判掉 ——
 *    而①正是排掉 `sh -c "…"` 的那一条 ⇒ 表现是「面板实例数恒 0、『停止机器人』点了没反应」，
 *    且**四层回归在 macOS 上一个字都不会变**（这条只有 Windows 才走得到）。
 *    与"Linux 上 `-fl` 只打进程名"那次（见 `PGREP_LIST_FLAGS`）是同一族：
 *    **平台差异不会报错，只会静默降级**。
 */
const NODE_BIN_RE = /^node(js)?(?:\.exe)?$/i;

/**
 * 命令行必须**以** `node <可选参数…> src/index.js` 收尾，而不是"中间出现过"。
 *
 * ⚠️ 这里的 `<可选参数…>` 是**必需**的，不是宽容 —— 第 7 轮实测：
 *    真机 argv 是 `…/bin/node --max-old-space-size=384 src/index.js`，
 *    而本项目总在 node 后面插一个堆上限（`BRIDGE_MAX_OLD_SPACE_MB`），
 *    所以"node 后面只有一个 token"这个假设**永远不成立**。
 *    旧式 `/node\s+\S*src\/index\.js$/` 的 `\S*` 跨不过那个空格 →
 *    真机器人被判成 `cmd-not-entry` → **一个残留都清不掉** → 多实例。
 *    判据要按"**最后一个 token 是不是入口文件**"写，而不是数 node 后面有几个词。
 */
const ENTRY_RE = /node(?:js)?(?:\.exe)?"?\s+(?:\S+\s+)*\S*src[\\/]index\.js"?$/;

// ⚠️ 2026-10-08（Windows 适配）本条的两处放宽，与上面 NODE_BIN_RE 的理由同源：
//    · `(?:\.exe)?` —— Windows 的命令行里可执行文件叫 `node.exe`；
//    · `[\\/]` —— 那边路径分隔符是反斜杠（`…\src\index.js`）；
//    · 末尾的 `"?` —— Windows 的进程命令行**会把带空格的参数用引号裹起来**，
//      而 `C:\Program Files\…` 一定带空格 ⇒ 入口那个 token 末尾会多一个 `"`。
//      少了它，真机器人会卡在判据②（`cmd-not-entry`）—— 同样是一个字都不报错。
//    ⚠️ 判据的**形状**没变：仍然要求"入口在命令行末尾"，`"?` 只吃那一个引号。
//    `scripts/check-wb.mjs` §3h-2 会拿一对真机 argv 直接试这条正则（real 必须过、
//    面板自己必须不过）—— 所以放宽之后**当场就会被验**，不靠人记得。

/**
 * 判定。
 *
 * @returns `{ ours, reason }` —— reason 只用于日志，便于事后回答
 *          "为什么它没被当作机器人"。
 */
export function isOurBridge(info = {}) {
  const cmd = String(info.cmd ?? '').trim();
  const cwd = String(info.cwd ?? '').trim();
  const execPath = String(info.execPath ?? '').trim();
  const root = String(info.root ?? '').trim();

  // ① 可执行文件
  const bin = execPath ? execPath.split(/[\\/]/).filter(Boolean).pop() || '' : '';
  if (!NODE_BIN_RE.test(bin)) return { ours: false, reason: 'exec-not-node' };

  // ② 命令行收尾
  if (!ENTRY_RE.test(cmd)) return { ours: false, reason: 'cmd-not-entry' };

  // ③ 工作目录
  //    能取到就照旧比 —— 这是 macOS / Linux 上唯一的身份凭据（`lsof -d cwd`）。
  if (cwd && root) {
    if (!pathEq(cwd, root)) return { ours: false, reason: 'cwd-elsewhere' };
    return { ours: true, reason: 'ok' };
  }
  //    取不到 cwd 时退到一条**窄例外**（Windows 专用，判据在 `absEntryInRoot`）：
  //    Windows **没有**"读别的进程工作目录"的公开手段（`Win32_Process` 就没这个字段），
  //    所以 Get-CimInstance 那条路永远拿不到 cwd。此时改用**正向**凭据：
  //    命令行里的入口必须是**绝对路径**、且解析后正好是本仓的 `src/index.js`。
  //    ⚠️ 它**不放松 fail-closed**：相对入口（`node src/index.js`）在拿不到 cwd 时
  //       仍然判"不是"。松的只是"我们确知它是谁"的那一格。
  if (absEntryInRoot(cmd, root)) return { ours: true, reason: 'ok-abs-entry' };
  return { ours: false, reason: 'cwd-unknown' };
}

/**
 * 这条路径长得像不像 Windows 绝对路径（`C:\…` 或 `\\server\share`）。
 * 存在的理由见 `pathEq`：本机（macOS）要能直接喂 Windows 形态做断言。
 */
const WIN_ABS_RE = /^(?:[A-Za-z]:[\\/]|\\\\)/;

/**
 * 两条路径是不是同一个位置。
 *
 * ⚠️ 必须**分两套 path 模块**：`path.isAbsolute('C:\\x')` 在 POSIX 上是 `false`，
 *    而 `path.win32.resolve('C:\\x')` 在 macOS 上照样算得对 —— 这正好给了本项目
 *    目前唯一的出路：**本机没有 Windows**，但 Windows 的路径判定可以在这里被直接断言。
 * ⚠️ Windows 路径**大小写不敏感**（盘符与目录名都是），POSIX 敏感 ⇒
 *    小写化只对 Windows 那一支做，否则会把 macOS 上两个真的不同的目录判成同一个。
 */
export function pathEq(a, b) {
  const s1 = String(a ?? '').trim();
  const s2 = String(b ?? '').trim();
  if (!s1 || !s2) return false;
  const win = WIN_ABS_RE.test(s1) || WIN_ABS_RE.test(s2);
  const p = win ? path.win32 : path;
  const r1 = p.resolve(s1);
  const r2 = p.resolve(s2);
  return win ? r1.toLowerCase() === r2.toLowerCase() : r1 === r2;
}

/**
 * 取命令行里的**最后一个** token，并剥掉 Windows 给它裹的引号。
 *
 * 为什么不能只按空格切：`"C:\Program Files\nodejs\node.exe" "C:\p\src\index.js"`
 * 按空格切会切出 `Files\nodejs\node.exe"` 这种碎片。
 */
export function lastCmdToken(cmd) {
  const toks = String(cmd ?? '').match(/"[^"]*"|\S+/g) || [];
  if (!toks.length) return '';
  return toks[toks.length - 1].replace(/^"|"$/g, '');
}

/**
 * 命令行里的入口是不是**本仓的**绝对 `src/index.js`。
 *
 * 这是"拿不到 cwd"时唯一的正向凭据（Windows 专用，理由见 `isOurBridge` 判据③）。
 * 三个条件缺一不可：入口是绝对路径、形态与 root 同族（Windows/POSIX）、解析后等于
 * `<root>/src/index.js`。**相对入口一律返回 false** —— 那正是 fail-closed 保留的那一格。
 */
export function absEntryInRoot(cmd, root) {
  const r = String(root ?? '').trim();
  if (!r) return false;
  const t = lastCmdToken(cmd);
  if (!t) return false;
  if (!(path.isAbsolute(t) || WIN_ABS_RE.test(t))) return false;
  const p = WIN_ABS_RE.test(r) ? path.win32 : path;
  return pathEq(t, p.join(r, 'src', 'index.js'));
}

/**
 * 从 `lsof -Fn` 的输出里取第一条路径。
 *
 * `-Fn` 的每行首字符是字段标识：`p`=pid、`f`=描述符、`n`=名字（路径）。
 * `-d txt` 的第一条 `n` 就是可执行文件，`-d cwd` 的那条 `n` 就是工作目录。
 * 拿不到就返回空串 —— 空串会让 `isOurBridge` 判为「不是」，正是我们要的 fail-closed。
 */
export function firstPathOf(lsofOutput) {
  for (const line of String(lsofOutput ?? '').split('\n')) {
    const s = line.trim();
    if (s.length > 1 && s[0] === 'n') return s.slice(1);
  }
  return '';
}

/**
 * 解析 `pgrep -fl` 的一行（形如 `95006 /…/bin/node src/index.js`）。
 * 解析不出来返回 null —— 叫不出名字的 pid 一律不参与后续判断。
 */
export function parsePgrepLine(line) {
  const m = /^\s*(\d+)\s+(\S.*?)\s*$/.exec(String(line ?? ''));
  if (!m) return null;
  const pid = Number.parseInt(m[1], 10);
  if (!Number.isFinite(pid) || pid <= 0) return null;
  return { pid, cmd: m[2] };
}

/**
 * 外部命令的**可移植解析**（放在这个叶子里的理由：`src/bridge-io.js` 与
 * `panel/server.js` 都已经 import 它，于是工具路径只有**一份实现**，不会两边漂）。
 *
 * ⚠️ 2026-10-06 · 开源发布当天的 CI 逮到的一处真实缺陷 —— 此前两处都写死绝对路径：
 *      `PGREP = '/usr/bin/pgrep'` · `LSOF = '/usr/sbin/lsof'`
 *    这在 macOS 上是对的，但在 Debian/Ubuntu 上 **`lsof` 住 `/usr/bin/lsof`**，
 *    `/usr/sbin/lsof` 根本不存在（GitHub 的 ubuntu runner 实测：探针直接返回 `null`）。
 *    后果不是报错，而是**静默降级**：
 *      ① 锁里那条"pid 活着 + 心跳停滞"的分支退回"探针不可用 → 放行"（`bridge-lock.js` 已写明）；
 *      ② 面板 `findBridgeProcesses()` 一个候选都核验不出来 ⇒ **实例数恒 0、"停止机器人"点了没反应**。
 *    而本项目的**推荐部署正是 Docker + Linux**（README 第 2 节路线 A），所以这不是边缘情况。
 *    —— 又一次印证那条老经验：**改了不报错**的缺陷只能靠"换个平台真跑一遍"暴露出来。
 *
 * 解析策略：先按候选绝对路径找（确定性），都找不到就**原样返回命令名交给 PATH**。
 * 找不到不是错误：`runQuiet` 那层本来就把"工具缺失"当成一格独立状态（返回 null 而不是 false）。
 *
 * 不 `export`：全仓只有下面两行常量用它（导出面那条契约会把它判成死导出）。
 * 要验"Linux 上解析得对不对"，用 `T334` —— 它跑的就是这份常量解出来的真路径。
 */
function resolveProcTool(name, candidates) {
  for (const c of candidates) {
    try {
      fs.accessSync(c, fs.constants.X_OK);
      return c;
    } catch {
      /* 试下一个候选 */
    }
  }
  return name;
}

export const PGREP = resolveProcTool('pgrep', ['/usr/bin/pgrep', '/usr/sbin/pgrep', '/bin/pgrep']);

export const LSOF = resolveProcTool('lsof', ['/usr/sbin/lsof', '/usr/bin/lsof', '/bin/lsof']);

/**
 * 让 `pgrep` 吐出「pid ＋ **完整命令行**」的旗标。**必须分两套**，因为 `-l` 两边语义不同名：
 *
 *   · BSD / macOS：`-l` 就是"连同命令行一起打印"（配合 `-f` 打完整 argv）——
 *     实测 `pgrep -fl 'src/index\.js'` → `12543 node --max-old-space-size=384 src/index.js`
 *   · Linux / procps：`-l` 只打**进程名**（`/proc/pid/stat` 里那 ≤15 字符的 comm），
 *     要打完整命令行得用 `-a`（man 原文：`-a, --list-full  List the full command line as well
 *     as the process ID.`；而 `-f` **只改匹配、不改输出**）。
 *
 * ⚠️ 2026-10-06 · 首次真跑 CI 逮到（GitHub 的 ubuntu runner 上 `T334` = `probe(真入口)=false`）：
 *    在 Linux 上沿用 `-fl` 的后果是 `parsePgrepLine` 只拿到 `cmd = 'node'` ⇒
 *    `ENTRY_RE`（要求命令行**以** `…src/index.js` 收尾）**永远不成立** ⇒
 *    实例锁探针判"不是我们的"、面板 `findBridgeProcesses()` 提名后全被筛掉 ⇒
 *    **多实例保护 / 面板实例数 / "停止机器人" 在 Linux 上一起静默失效**。
 *    而本项目的推荐部署正是 Docker + Linux，且这些坏法**一个都不报错**。
 *
 * 找不到 `-a` 的极老 procps 会直接以 exit 2 报错 —— 那种机器上探针会如实返回"不可用"，
 * 而不是拿一个错的命令行去误杀（fail-closed 的方向本来就是"宁可漏清，不可误杀"）。
 */
export const PGREP_LIST_FLAGS = process.platform === 'linux' ? ['-f', '-a'] : ['-f', '-l'];

// ── Windows：进程发现（2026-10-08）───────────────────────────────────────────
//
// Windows 上没有 `pgrep` / `lsof`。但**"先提名、再核验"这两步一步都不许省** ——
// 提名宽、核验严，是 B9d（G-5）用一次真实误杀换来的结构，换成 Windows 也一样：
// 少一步就退回到"文本匹配上了就杀"。
//
// 工具选 `powershell`：Windows 7 起系统自带。**不用 `wmic`** —— 它在
// Windows 11 24H2 / Server 2025 起已被移除，拿它当唯一实现等于给新系统埋一个
// "改了不报错"（本项目最贵的一类）。
//
// ⚠️ 脚本走 `-EncodedCommand`（UTF-16LE 的 Base64），不走 `-Command`：
//    后者要求把引号穿过 Windows 的命令行解析器，是经典的一类静默失败；
//    编码之后**没有任何字符需要转义**，而且编码本身是纯函数 —— 能被 smoke 直接断言。
//    `-NoProfile` 是硬要求：用户 profile 里的任何输出都会污染这份 JSON。

export const POWERSHELL = resolveProcTool('powershell', [
  'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
]);

/** 只列 `node.exe`（候选池必然是我们这类进程），字段够 `isOurBridge` 的三条判据用。 */
const WIN_PS_SCRIPT = "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" "
  + '| Select-Object ProcessId,ExecutablePath,CommandLine '
  + '| ConvertTo-Json -Compress -Depth 3';

/** PowerShell 的 `-EncodedCommand` 入参。纯函数。 */
export function encodePwshCommand(script) {
  return Buffer.from(String(script ?? ''), 'utf16le').toString('base64');
}

/** 跑那次枚举的完整 argv（`/api/state` 会每 15 秒用一次，参数必须稳定）。 */
export function winNodeListArgs() {
  return ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodePwshCommand(WIN_PS_SCRIPT)];
}

/**
 * 解析 `ConvertTo-Json` 的输出 → `[{pid, execPath, cmd}]`。
 *
 * ⚠️ 必须吃**两种**形态：**单个对象**与数组。`ConvertTo-Json` 在只有一个元素时
 *    **不套数组**（PowerShell 的老毛病），而"机器人刚起来、进程表里只有它一个"
 *    恰好是最常见的时刻 —— 漏了这一支，表现就是"刚启动时面板认不出机器人"。
 * ⚠️ 认不出一律返回空数组（fail-closed）：提名不出来就不会有东西被杀。
 */
export function parseWinNodeProcesses(stdout) {
  const s = String(stdout ?? '').trim();
  if (!s) return [];
  let parsed = null;
  try {
    parsed = JSON.parse(s);
  } catch {
    return [];
  }
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  const out = [];
  for (const r of rows) {
    if (!r || typeof r !== 'object' || Array.isArray(r)) continue;
    const pid = Number(r.ProcessId);
    if (!Number.isFinite(pid) || pid <= 0) continue;
    out.push({
      pid,
      execPath: String(r.ExecutablePath ?? ''),
      cmd: String(r.CommandLine ?? ''),
    });
  }
  return out;
}

