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

/** node 可执行文件的名字（`…/bin/node`、`…/bin/nodejs` 都算） */
const NODE_BIN_RE = /^node(js)?$/;

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
const ENTRY_RE = /node(?:js)?\s+(?:\S+\s+)*\S*src\/index\.js$/;

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
  const bin = execPath ? execPath.split('/').filter(Boolean).pop() || '' : '';
  if (!NODE_BIN_RE.test(bin)) return { ours: false, reason: 'exec-not-node' };

  // ② 命令行收尾
  if (!ENTRY_RE.test(cmd)) return { ours: false, reason: 'cmd-not-entry' };

  // ③ 工作目录（取不到值 = 不算 —— fail-closed）
  if (!cwd || !root) return { ours: false, reason: 'cwd-unknown' };
  if (path.resolve(cwd) !== path.resolve(root)) return { ours: false, reason: 'cwd-elsewhere' };

  return { ours: true, reason: 'ok' };
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
