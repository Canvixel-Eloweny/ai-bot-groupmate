/**
 * 启动 QQ 协议端（NapCat）。
 *
 * 只有**一种**模式：后台、无窗口（2026-10-13 改）。
 *
 * 以前还有一条「前台」分支（`3-START-NAPCAT.bat` 默认走它）：把 stdio 交还给那个
 * cmd 窗口，聊天记录/扫码提示都在里面滚。代价是**关掉窗口就等于杀掉协议端** ——
 * 用户扫完码、顺手把窗口一关，登录态跟着没了，还得重扫一次。
 * 现在两条路都能看见同样的东西（① 面板「终端」页实时 tail `napcat.log`；
 * ② 面板「打开二维码登录」直接出图），那条分支就没有任何理由继续存在了。
 *
 * 后台模式：输出进 `app/napcat/napcat.log`，进程 detached + 无窗口，
 * **关掉任何窗口都不影响它**（这是本轮要保的语义）。
 *
 * 三个刻意的技术选择：
 *   ① 把**包内的** runtime\node 前置进 PATH —— NapCat 的启动器要 `node`，
 *      但用户机器上不该（也没有）装 Node。这是"内嵌运行时"真正被用上的地方。
 *   ② 不写死启动器的文件名。官方在多个版本里改过它（见 lib/common.mjs 的注释）。
 *   ③ 起 `.bat` 一律经 cmd（见下面 spawnLauncher 那两条约束）——
 *      真机首跑就崩在这里，两次。
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  ROOT, NAPCAT_DIR, RUNTIME_NODE_DIR, IS_WIN,
  say, ok, warn, bad, title, dim, exists, isMain, portOpen, waitPort, findNapcatLauncher,
  // 第 58 轮：为"已经登录过的账号"补 OneBot 端口配置。形状与"补服务端"只有 common.mjs 一份实现。
  knownAccounts, hasOnebotServers, withOnebotServers, napcatConfigDir, readJson, writeJson,
  // 2026-10-11：免扫码 —— 快速登录要把 QQ 号当参数传给启动器。
  resolveLoginQq,
} from './lib/common.mjs';

const PORT = 3001;
const LOG = path.join(NAPCAT_DIR, 'napcat.log');

// ⚠️ 这里**刻意没有** `--qq` 这个命令行参数（2026-10-13 移除，见 resolveLoginQq 的注释）：
//    允许在命令行里"指定一个 QQ 号"就等于允许任何人拿别人的号去登录，
//    而扫码是唯一能证明"这台机器上登录的是本人"的方式。

/** 往协议端日志里追加一行（带时间戳）。写不进去也不该让启动失败。 */
function appendLog(line) {
  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
    fs.appendFileSync(LOG, `[${ts}] ${line}\n`);
  } catch { /* 日志写不进去只是少一条线索，不是启动条件 */ }
}

function withBundledNodeOnPath() {
  const env = { ...process.env };
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
  env[key] = exists(RUNTIME_NODE_DIR)
    ? `${RUNTIME_NODE_DIR}${path.delimiter}${env[key] || ''}`
    : env[key];
  return env;
}

/**
 * 为**已经登录过的每个账号**补齐「WebSocket 3001 / HTTP 3000」配置。
 *
 * ⚠️ 为什么必须赶在**启动之前**做（第 58 轮真机实测）：
 *    NapCat **不会热重载** OneBot 配置 —— 实测把 servers 清空后端口 20 秒都不掉，
 *    说明配置**只在登录那一刻被读一次**。所以补配置只有两个时机：
 *    ① 下一次登录之前（就是这里）；② 登录之后补，则必须重启协议端 —— 而那会掉登录态、
 *       逼用户重新扫码一次。
 *
 * ⚠️ 它修的是什么：
 *    NapCat 只在 `onebot11_<实际登录的QQ>.json` 里读配置，而 `setup.mjs` 写的是
 *    `onebot11_<用户输入的QQ>.json`。两者对不上时 NapCat 会自建一份
 *    **httpServers / websocketServers 全空**的默认配置 ⇒ 3000/3001 永远不开且零报错。
 *    本函数按 NapCat 自己留下的 `napcat_<QQ>.json` 找出真号，把服务端补进对应的那份。
 *    （`setup.mjs` 现在还会写一份不带后缀的模板 `onebot11.json`，那挡住的是"以后的账号"；
 *      本函数挡的是"已经坏在盘上的那些"，两者互补。）
 *
 * 只补不覆盖：已经带 3001/3000 的配置**原样不动**（用户自己改过的不能被我们改回去）。
 */
function alignKnownAccounts() {
  const dir = napcatConfigDir();
  if (!exists(dir)) return;

  // ① 模板那份（不给账号）—— 它挡的是"**以后**换别的 QQ 号登录"。缺了它，
  //    新账号首次登录就会拿到一份没有 3001/3000 的默认配置（就是那个真机坑）。
  const tplPath = path.join(dir, 'onebot11.json');
  const tplCur = readJson(tplPath);
  if (!hasOnebotServers(tplCur)) {
    try {
      const seed = tplCur || readJson(path.join(dir, `onebot11_${knownAccounts()[0] || ''}.json`)) || {};
      writeJson(tplPath, withOnebotServers(seed));
      ok(`已补上 OneBot 端口模板（${path.relative(ROOT, tplPath)}）—— 以后换任何 QQ 号登录都能直接用`);
    } catch (e) {
      warn(`端口模板没补上：${e && e.message ? e.message : e}`);
    }
  }

  // ② 每个"NapCat 见过"的账号各自那份 —— 它挡的是"**已经**坏在盘上的那些"。
  for (const qq of knownAccounts()) {
    const f = path.join(dir, `onebot11_${qq}.json`);
    const cur = readJson(f);
    if (cur && hasOnebotServers(cur)) continue;
    try {
      writeJson(f, withOnebotServers(cur || readJson(tplPath) || {}));
      ok(`已为账号 ${qq} 补上 OneBot 端口配置（${path.relative(ROOT, f)}）`);
    } catch (e) {
      warn(`账号 ${qq} 的端口配置没补上：${e && e.message ? e.message : e}`);
    }
  }
}

export async function startNapcat({ qq = '' } = {}) {
  // ⚠️ 对齐**刻意放在端口守卫之前**（第 58 轮实测后调整）：协议端已经在跑时，
  //    下面那条 `portOpen(3001)` 会直接 return —— 而"协议端在跑、配置却被清空 / 模板缺失"
  //    正是需要修的两种状态。放在前面就都能自愈，而且正常情况下它只是一次空操作。
  alignKnownAccounts();

  if (await portOpen(PORT)) {
    ok(`协议端已经在跑了（${PORT} 端口有应答）—— 不重复启动`);
    return { started: false };
  }

  const launcher = findNapcatLauncher();
  if (!launcher) {
    bad('找不到 NapCat 的启动器 —— 协议端还没装好');
    say('  双击 1-SETUP.bat 会自动把它装好（约 30–36MB，需要联网；离线可自己放包，见 napcat.json 的 manual）。');
    say(`  装好后应该能在 ${path.relative(ROOT, NAPCAT_DIR)}\\ 下看到启动器。`);
    return { started: false, error: 'no-launcher' };
  }

  dim(`  启动器：${path.relative(ROOT, launcher)}`);
  const env = withBundledNodeOnPath();
  // ⚠️ 工作目录由 launch-napcat-hidden.vbs 自己设（`fso.GetParentFolderName(launcher)`）——
  //    这里刻意不再传 cwd：多一处传 cwd 就多一处"两边设得不一样"的漂移点。

  /**
   * 起协议端。两条约束**必须同时成立** —— 少任何一条，Windows 上都起不来：
   *
   *   ① **必须经 cmd。** NapCat 的启动器是 `.bat`，而 Node ≥ 18.20.2 / 20.12.2 / 21.7.3
   *      （修 CVE-2024-27980）起，**禁止不经 shell 直接 `spawn` `.bat` / `.cmd`** ——
   *      会当场抛 `spawn EINVAL`（errno -4071）。本包内嵌的 `runtime\node` 是 v22.x，
   *      正好命中这条策略，所以这条路以前是 **100% 必现**地崩在第一步（真机实测）。
   *
   *   ② **但不能用 `shell: true`。** `shell: true` 会把整条命令拼成一个字符串交给 cmd，
   *      包路径里只要有一个空格就会被第一个空格截断（实测报
   *      `'D:\...\AI_Boot' 不是内部或外部命令`）。而"解压到纯英文**无空格**路径"是
   *      README 的**建议**、不是我们能强制的 —— 用户把包放进 `D:\AI Boot of QQ` 完全合理。
   *
   * 所以走第三条路：把 **`cmd.exe /d /c <启动器>`** 拆成 argv 交给 `spawn`，且**不设** `shell`。
   * 这样 launcher 是一个独立的 argv，含空格的路径由 Node 自己按需加引号
   * （`windowsVerbatimArguments` 默认为 false），全程不经过任何字符串拼接。
   *
   * ⚠️ 2026-10-12 修掉一条：这里原先是 `['/d', '/s', '/c', …]`，**多了一个 `/s`**。
   *    `cmd /s` 的语义是"剥掉最外层引号、再按原样重新分词"，而 Node 会给含空格的路径
   *    加引号 ⇒ **路径里只要有一个空格就被截断**（真机实测：`D:\dsh\zz space probe`
   *    这种只含空格、不含括号的路径必挂，报 `'D:\dsh\zz' 不是内部或外部命令`）。
   *    它的隐蔽之处在于：**无空格路径下永远看不出问题**，而报错出现在另一个窗口里。
   *    所以：经 cmd 是**必须**的，`/s` 是**绝不能**有的 —— 这是两条独立的约束。
   */
  /**
   * ⚠️⚠️ **免扫码的关键一行**（2026-10-11）：把 QQ 号**作为启动器的参数**传下去，
   *    官方 `launcher*.bat` 会把它（`%*`）转给 `NapCatWinBootMain.exe`，走**快速登录** ——
   *    登录态还在时直接进，不弹二维码。
   *
   *    以前不传 ⇒ NapCat 每次都打印「没有 -q 指令指定快速登录，将使用二维码登录方式」
   *    ⇒ 用户每次开机都要扫一次。这就是"每次都要重新扫码"的根因。
   *
   *    ⚠️ 参数**不是** `-q <号>`：官方 launcher 的注释那么写，但实测（issue #1557）
   *       `NapCatWinBootMain.exe` 会把 `-q` 当成一个**独立的 argv**，于是它看到的号是空的。
   *       正确形状就是**光秃秃一个号码**：`launcher.bat 123456`。
   *    ⚠️ 快速登录失败（换机器登录过 / 风控）时 NapCat **自己会退回二维码**，
   *       所以传号永远是安全的：有登录态就免扫，没有就照旧扫。
   */
  const login = resolveLoginQq(qq);
  if (login.qq) ok(`快速登录：${login.qq}（来源：${login.from}）—— 登录态有效时不弹二维码`);
  else dim('  没拿到已登录的 QQ 号 —— 走二维码登录（首次或换号时正常）');

  // ⚠️⚠️ **不能直接 spawn cmd**（2026-10-13 真机复现）：`windowsHide: true` 映射的是
  //    CREATE_NO_WINDOW —— 子进程**拿不到控制台**，而 `NapCatWinBootMain.exe` 是
  //    控制台程序，没有控制台它就 **AllocConsole 自己弹一个**。用户看到的就是
  //    "第二个黑窗口"，而且关掉它 = 杀掉协议端 = 账号掉线。
  //    正解是 `launch-napcat-hidden.vbs`：`WScript.Shell.Run(cmd, 0, True)` 建的是
  //    **隐藏的控制台**（不是没有控制台），协议端继承它 ⇒ 全程无窗口。
  //    这与 launch-hidden.vbs（面板自己那条链）是同一套机制，已在生产验证过。
  const vbsCands = [
    path.join(ROOT, 'launcher', 'launch-napcat-hidden.vbs'),
    path.join(ROOT, 'launch-napcat-hidden.vbs'),
    path.join(ROOT, 'packaging', 'windows', 'launcher', 'launch-napcat-hidden.vbs'),
  ];
  const vbs = vbsCands.find((p) => exists(p));
  if (!vbs) {
    appendLog(`✗ 找不到 launch-napcat-hidden.vbs（试过：${vbsCands.join(' / ')}）—— 协议端没起`);
    return { started: false, error: 'no-vbs' };
  }
  const wscript = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wscript.exe');

  fs.mkdirSync(path.dirname(LOG), { recursive: true });
  /**
   * ⚠️⚠️⚠️ **这里绝对不许 openSync(LOG)、也不许把它当 stdio 传下去**（2026-10-13 真机定死的根因）：
   *   vbs 那条命令**自己**会 `>> napcat.log`（协议端的输出本来就归它写）。而 Windows 上
   *   **只要还有别的句柄开着这个文件**，cmd 就打不开重定向目标 ⇒ 当场 `exit 1`（0.04 秒，
   *   **连 launcher-user.bat 都还没跑**）⇒ 表现成"协议端秒退、零输出、NapCat 一行日志都没有"。
   *
   *   证据（同一台真机 · probe-chain2 build 2.6 的 S 系列，同一份哨兵 bat 挨条对照）：
   *     S0  cmd /d /c <bat>                        ✅ 起得来
   *     S6  <bat> < nul                            ✅ ⇒ `< nul` 无辜
   *     S5  <bat> >> napcat.log                    ❌ code=1 ⇒ 坏在"往这个文件重定向"
   *     S8  <bat> >> 没人占着的新文件               ✅ ⇒ 换个目标就通
   *     S9  同 S5，但不把句柄继承给子进程            ❌ ⇒ 罪在"父进程自己开着"，不是"继承"
   *   ⇒ 谁都不许在起协议端期间持有 napcat.log。stdout/stderr 一律 'ignore'，
   *     日志由 vbs 的 `>>` 自己写（面板「终端」页读的就是这个文件，照样能看）。
   *   以前那个 fd 的注释写着"只是兜底（wscript 自己的少量输出）"—— 那点兜底换来的正是这个
   *   静默秒退，不值得。
   */
  /**
   * ⚠️⚠️ 三个参数**一个都不能省、顺序不能换**（2026-10-13 真机踩过，代价是几个小时）：
   *    `wscript.exe //B //Nologo <vbs> <启动器> <QQ号或_-> <日志文件>`
   *    `WScript.Arguments` **不含脚本名**，所以少传一个参数就会整体错位 ——
   *    那次 QQ 槽位里落进了日志路径、日志重定向静默失效、NapCat 拿到诡异 argv
   *    直接 exit 0 且零输出，表现就是"协议端秒退、什么都没有"。
   *    QQ 号为空时用 '-' 占位（vbs 会把它还原成空串），槽位永远填满。
   */
  const child = spawn(wscript, ['//B', '//Nologo', vbs, launcher, login.qq || '-', LOG], {
    detached: true, windowsHide: true, stdio: 'ignore',
    // ⚠️ env 必须带下去：NapCat 的启动器要 `node`，而用户机器上不该（也没有）装 Node。
    //    以前这层 env 是直接传给 cmd 的，现在经 wscript 透传 —— 少了它协议端起不来。
    env,
  });
  // ⚠️ 协议端"什么时候死的、怎么死的"以前**一个字都不留**（真机上 napcat.log
  //    只有几十字节、全是 cmd 自己的提示）—— 用户手上唯一能查的证据就是它。
  //    所以这两条监听是**可诊断性**，不是可选的锦上添花。
  //    ⚠️ 这里的 code 是 vbs 交回来的（它 WScript.Quit rc 原样透传），
  //       不是 Node 直接拿到的 NapCat 退出码 —— 但"什么时候没的"这个信号是准的。
  child.once('error', (e) => appendLog(`✗ 协议端没能起来：${e && e.message ? e.message : e}`));
  child.once('exit', (code) => appendLog(`■ 协议端已退出 (code=${code})`));
  child.unref();
  dim(`  输出写往 ${path.relative(ROOT, LOG)}（面板「终端」页里能实时看到，不用开任何窗口）`);
  return { started: true, child };
}

if (isMain(import.meta.url)) {
  title('QQ 协议端（NapCat）');
  if (!IS_WIN) {
    warn('当前不是 Windows —— 这个入口只在 Windows 上有意义');
    process.exitCode = 1;
  } else {
    // ⚠️ 兜一层 try：这里以前是裸的 `await`，任何抛出的异常都会变成一段 Node 堆栈 ——
    //    用户拿到的"唯一线索"是一个他不认识的错误码，而该给的是一条**下一步**。
    let r = { started: false };
    try {
      r = await startNapcat();
    } catch (e) {
      bad(`起协议端失败：${e && e.message ? e.message : e}`);
      say('  自检：runtime\\node\\node.exe tools\\check-env.mjs');
      say('  或者把上面这段报错原样贴出来。');
      process.exitCode = 2;
      r = { started: false, error: 'spawn-failed' };
    }
    if (r.started) {
      if (await waitPort(PORT, 60000)) {
        ok('协议端已就绪（3001 端口在应答）');
      } else {
        warn('协议端还没在 3001 上应答。多半是**还没扫码登录**，或 QQ 没装。');
        // ⚠️ 扫码入口**只指向面板**（2026-10-13）：以前这里让用户"再开一个前台窗口扫码"，
        //    而那个窗口一关就把登录态带走了 —— 正是本轮要消灭的行为。
        say('  扫码：打开控制台 →「打开二维码登录」（终端页也能实时看到二维码）。');
        say(`  看日志：${path.relative(ROOT, LOG)}`);
      }
    }
    if (!r.started && !r.error) say('  可以直接双击 2-START.bat 打开控制台了。');
  }
}
