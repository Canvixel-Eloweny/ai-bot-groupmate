/**
 * 原生 NapCat（Windows 便携包）—— 定位 / 起停 / WebUI token / 二维码图。
 * ══════════════════════════════════════════════════════════════════════════
 *  为什么需要这一片（2026-10-12 · 真机踩到）
 * ══════════════════════════════════════════════════════════════════════════
 *  面板原来**只认 Docker 那一条路**：`docker exec napcat cat /app/napcat/cache/qrcode.png`
 *  取二维码、`docker restart napcat` 重启协议端、token 从容器里的 `webui.json` 抠。
 *  这在 macOS 主线（NapCat 跑在容器里）成立 —— 但 **Windows 便携包根本不打 Docker**：
 *  NapCat 是被安装脚本直接解压到 `app\napcat\` 里、由启动器拉起来的**原生进程**。
 *
 *  于是便携包上会出现一个很具体、很好复现的现象：
 *    · 面板上「打开二维码登录」永远是一张**裂图**（接口 404）
 *    · 终端页刷「读不到 NapCat 的 token —— 容器没在运行，换不了码」
 *    · 「重启协议端」点了没反应（它执行的是 `docker restart napcat`）
 *  这三件事的根因是同一个：**面板不知道原生协议端长什么样**。
 *
 *  ⚠️ 与 `packaging/windows/tools/start-napcat.mjs` 的关系（刻意不是同一份代码）：
 *     那一份是**包外层**的启动器（面板还没起来时就得能用，双击 bat 触发）；
 *     本片是**程序内**的实现（面板起来之后要能自己拉起/重启协议端）。
 *     两者确实各有一份"找启动器"的判据 —— 但它们的**运行时机与依赖完全不同**
 *     （一个不能 import 面板、一个必须 import 面板），合并任何一侧都会让另一侧
 *     多背一整棵依赖树。所以这里接受这一处重复，并把风险说清：
 *     **候选表要一起改**（改一个不改另一个，症状是"双击 bat 能起、面板点不动"）。
 *
 *  ⚠️ 启动一律 **`cmd /d /c`，不许加 `/s`**（2026-10-11 第 59 轮实测）：
 *     Node 会给含空格的路径加引号，而 `cmd /s` 的语义正是"剥掉最外层引号再重新分词"
 *     ⇒ 路径里**只要有一个空格**就会被截断（`'D:\dsh\zz' 不是内部或外部命令`）。
 *     这与 `spawn EINVAL` 那条（Node ≥18.20.2 禁止不经 shell 直接 spawn `.bat`）是
 *     **两条独立的硬约束**：必须经 cmd，但绝不能带 `/s`。
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import net from 'node:net';
import { ROOT, IS_WIN } from './paths.js';

/** 便携包里 `ROOT` 就是 `app/`，协议端装在 `app\napcat\`；开发树同理。 */
export const NAPCAT_NATIVE_DIR = path.join(ROOT, 'napcat');

export const nativeLogFile = () => path.join(NAPCAT_NATIVE_DIR, 'napcat.log');
export const nativeWebuiJson = () => path.join(NAPCAT_NATIVE_DIR, 'config', 'webui.json');
export const nativeQrPng = () => path.join(NAPCAT_NATIVE_DIR, 'cache', 'qrcode.png');

/**
 * 启动器候选，**按优先级排**（与 `packaging/windows/tools/lib/common.mjs` 逐一对应）。
 * ⚠️ 明确排除安装器/结束器：宽松到一定程度就不再是"容错"而是"指错"——
 *    官方一键包里同时存在 `NapCatInstaller.exe`，它**不是**启动器。
 */
const LAUNCHER_CANDIDATES = [
  /^launcher[\w-]*\.bat$/i,
  /^NapCatWinBootMain\.exe$/i,
  /^napcat\.bat$/i,
  /^napcat[\w.-]*\.bat$/i,
];
const NOT_LAUNCHER_RE = /(install|uninstall|kill|stop|remove)/i;

function walk(dir, depth, out, maxDepth) {
  if (depth > maxDepth) return out;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === 'QQ') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, depth + 1, out, maxDepth);
    else out.push(full);
  }
  return out;
}

/** 解压后可能多套一层目录（官方包通常是 `NapCat.xxxx.Shell/`），所以要动态求"家"。 */
export function findNativeHome() {
  if (!fs.existsSync(NAPCAT_NATIVE_DIR)) return null;
  const files = walk(NAPCAT_NATIVE_DIR, 0, [], 3)
    .filter((p) => /\.(bat|exe|cmd)$/i.test(p))
    .filter((p) => !NOT_LAUNCHER_RE.test(path.basename(p)))
    .sort();
  for (const re of LAUNCHER_CANDIDATES) {
    const hits = files.filter((p) => re.test(path.basename(p)));
    if (hits.length === 0) continue;
    // 同一优先级内固定优先 `*-user.bat`：另外几个开头会做管理员检查，
    // 非管理员时用 `Start-Process -Verb runAs` **另开一个提权窗口再 exit** ⇒ 原窗口一闪而过。
    const pick = hits.find((p) => /-user\.bat$/i.test(p)) || hits[0];
    return path.dirname(pick);
  }
  return null;
}

export function nativeLauncher() {
  const home = findNativeHome();
  if (!home) return null;
  const files = walk(home, 0, [], 1)
    .filter((p) => /\.(bat|exe)$/i.test(p))
    .filter((p) => !NOT_LAUNCHER_RE.test(path.basename(p)))
    .sort();
  for (const re of LAUNCHER_CANDIDATES) {
    const hits = files.filter((p) => re.test(path.basename(p)));
    if (hits.length) return hits.find((p) => /-user\.bat$/i.test(p)) || hits[0];
  }
  return null;
}

/** 这台机器上装的是"原生 NapCat"吗（而不是容器那套）。 */
export function nativePresent() {
  return Boolean(nativeLauncher());
}

/** NapCat WebUI 的 token（原生那份写在 `config/webui.json` 里）。 */
export function readNativeWebuiToken() {
  try {
    const j = JSON.parse(fs.readFileSync(nativeWebuiJson(), 'utf8'));
    return typeof j?.token === 'string' ? j.token.trim() : '';
  } catch {
    return '';
  }
}

/**
 * NapCat WebUI 的**真实端口**（2026-10-13 真机反馈后加）。
 *
 * ⚠️ 不能再写死 6099：NapCat 启动时会探端口，**被占用就自动 +1**
 *    （源码里 `hm()`：EADDRINUSE 时试下一个，最多 100 次）。
 *    端口一换，写死 6099 的面板就永远连不上 —— 症状是
 *    「换二维码失败: NapCat 登录失败: HTTP 0」，看起来像协议端没起来，
 *    其实起来了、只是 WebUI 换了门牌号。
 * 读不到文件（协议端还没起来过）时返回 0，调用方应回落默认值。
 */
export function readNativeWebuiPort() {
  try {
    const j = JSON.parse(fs.readFileSync(nativeWebuiJson(), 'utf8'));
    const p = Number(j?.port);
    return Number.isFinite(p) && p > 0 ? p : 0;
  } catch {
    return 0;
  }
}

/**
 * 这张 PNG 是不是**一张完整的图**。
 *
 * ⚠️ 不是多余的谨慎：NapCat 是**覆盖写**那张 PNG 的，撞上"写了一半"的那一瞬间
 *    就会发出一张裂图 —— 而裂图在页面上与"取不到"长得一样（都是破图标），
 *    用户没法区分，我们也没法从截图判断。所以宁可判"不完整"、退回落的那份。
 */
export function looksLikeCompletePng(buf) {
  if (!buf || buf.length < 16) return false;
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < sig.length; i += 1) if (buf[i] !== sig[i]) return false;
  // 结尾必须是 IEND 块（PNG 的固定收尾），确认不是被截断的半张
  return buf.subarray(Math.max(0, buf.length - 12)).includes(Buffer.from('IEND'));
}

/** 读盘上那张二维码图；不完整/不存在都回 null。 */
export function readLocalQr() {
  try {
    const buf = fs.readFileSync(nativeQrPng());
    return looksLikeCompletePng(buf) ? buf : null;
  } catch {
    return null;
  }
}

/**
 * 把**包内的** runtime\node 前置进 PATH（NapCat 的启动器要 `node`，而用户机器上
 * 不该、也没有）装 Node）。判据与 `packaging/windows/tools/start-napcat.mjs` 的
 * `withBundledNodeOnPath()` 一致 —— 那一份是包外层启动器用的，这里是面板内用的，
 * 两边**不能 import 同一份**（一个不能 import 面板、一个必须 import 面板），
 * 但候选表/判据要一起改。
 */
function withBundledNodeOnPath() {
  const env = { ...process.env };
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
  // 便携包里 ROOT = app/ ⇒ 运行时在 ROOT/../runtime/node；开发树里没有这个目录，
  // exists 判不过就原样返回（不凭空造路径）。
  const runtimeNode = path.resolve(ROOT, '..', 'runtime', 'node');
  try {
    if (fs.existsSync(runtimeNode)) env[key] = `${runtimeNode}${path.delimiter}${env[key] || ''}`;
  } catch { /* 读不到就按原样用，缺 node 的症状由协议端自己的报错暴露 */ }
  return env;
}

/**
 * `launch-napcat-hidden.vbs` 的落点。**两份候选，都要维护**（改一个不改另一个，
 * 症状是"工具层无窗口、面板点重启又弹一个"）：
 *   ① 便携包里：`ROOT` 就是 `app/`，vbs 在**包根**（与 `launch-hidden.vbs` 并排）
 *   ② 开发树里：`ROOT` 是仓库根，vbs 在 `packaging/windows/launcher/` 下
 */
function hiddenLauncherVbs() {
  const cands = [
    path.resolve(ROOT, '..', 'launch-napcat-hidden.vbs'),
    path.join(ROOT, 'packaging', 'windows', 'launcher', 'launch-napcat-hidden.vbs'),
  ];
  for (const p of cands) {
    try { if (fs.existsSync(p)) return p; } catch { /* 继续找下一个 */ }
  }
  return null;
}

/**
 * 起原生协议端（后台、无窗口）。
 *
 * ⚠️⚠️ **为什么必须经 wscript + vbs，不能直接 spawn cmd**（2026-10-13 真机复现）：
 *    `windowsHide: true` 映射 CREATE_NO_WINDOW ⇒ 子进程**没有控制台**；
 *    而 `NapCatWinBootMain.exe` 是控制台程序，没有控制台它就 **AllocConsole
 *    自己弹一个黑窗口**。用户看到的是"点了重启协议端，又冒出第二个终端"，
 *    而关掉那个窗口 = 杀协议端 = 账号掉线。
 *    `launch-napcat-hidden.vbs` 用 `WScript.Shell.Run(cmd, 0, True)` 建的是
 *    **隐藏的控制台**（不是没有控制台），协议端继承它 ⇒ 全程无窗口。
 *    与包根 `launch-hidden.vbs`（面板自己的启动链）同一套机制。
 *
 * ⚠️ `windowsHide: true`：面板自己就没有控制台，不隐藏就会多弹一个黑窗 ——
 *    而"关不掉的黑窗"正是这一版要消灭的东西。
 * ⚠️ 不传 QQ 号：面板不知道机器人号，而且这里要的正是**二维码登录**（用户就是来扫码的）。
 */
export function startNativeNapcat({ qq = '' } = {}) {
  if (!IS_WIN) return { ok: false, msg: '原生协议端只在本包的 Windows 构建里使用' };
  const launcher = nativeLauncher();
  if (!launcher) return { ok: false, msg: '找不到 NapCat 的启动器（app\\napcat 下没有 launcher*.bat）' };

  const vbs = hiddenLauncherVbs();
  if (!vbs) return { ok: false, msg: '找不到 launch-napcat-hidden.vbs（应在包根目录）' };
  const wscript = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wscript.exe');

  try {
    fs.mkdirSync(NAPCAT_NATIVE_DIR, { recursive: true });
    // ⚠️⚠️⚠️ **不许 openSync(napcat.log)、也不许把它当 stdio**（2026-10-13 真机定死的根因，
    //    与 tools/start-napcat.mjs 那处是同一个坑）：vbs 的命令自己 `>> napcat.log`，
    //    而只要**还有别的句柄开着这个文件**，cmd 就打不开重定向目标 ⇒ 秒退 `exit 1`、
    //    连启动器都没跑（症状＝"重启协议端没有任何反应、二维码永不出现"）。
    //    证据见 packaging/windows/tools/start-napcat.mjs 顶部那段 S 系列读数（S5 ❌ / S8 ✅ / S9 ❌）。
    // ⚠️⚠️ 三个参数**一个都不能省、顺序不能换**（与 tools/start-napcat.mjs 同一处契约，
    //    2026-10-13 真机踩过）：`<vbs> <启动器> <QQ号或_-> <日志文件>`。
    //    `WScript.Arguments` 不含脚本名 ⇒ 少传一个就整体错位（症状：秒退 exit 0、零输出）。
    //    QQ 为空用 '-' 占位，vbs 会还原成空串。
    const child = spawn(wscript, ['//B', '//Nologo', vbs, launcher, qq || '-', nativeLogFile()], {
      detached: true, windowsHide: true, stdio: 'ignore',
      // ⚠️ env 里带着包内 runtime\node（NapCat 的启动器要 node），原样透传
      env: withBundledNodeOnPath(),
    });
    child.once('error', () => { /* 上面的 log 会留下痕迹 */ });
    child.unref();
  } catch (e) {
    return { ok: false, msg: `起协议端失败：${e.message}` };
  }
  return { ok: true, msg: `已拉起协议端（${path.basename(launcher)}）` };
}

/**
 * 停原生协议端。
 *
 * ⚠️ 三条杀路（2026-10-13 真机定位，前两条都单独踩过）：
 *    ① 按端口（已登录时那条路，登录态在 3001 上）；
 *    ② 按映像名 `NapCatWinBootMain.exe` **强杀**（`/T /F`）—— 优雅关闭对 GUI 的 QQ 无效；
 *    ③ 清掉父进程已死的**孤儿 QQ**（NapCat 拉起来的那个；用户自己的 QQ 父进程活着，不碰）。
 *    ⚠️ 只按端口杀是杀不掉的：没登录时 3001 根本没开，按端口找不到进程，
 *       于是"重启协议端"变成"又拉了一个 NapCat"，二维码永远不会重新生成。
 *
 * @param {(pid:number)=>Promise<boolean>} killTree 面板的杀树函数（按 pid，仅用于①）
 */
export async function stopNativeNapcat(killTree) {
  if (!IS_WIN) return { ok: false, msg: '仅 Windows' };

  // ① 按端口（登录态在时）
  try {
    const r = await killTree({ port: 3001 });
    if (r && r.ok) return { ok: true, msg: '已停止协议端' };
  } catch { /* 端口那条路本来就可能找不到，继续按映像名 */ }

  // ② 按映像名 + 进程树，**强杀**
  const pids = napcatProcessPids();
  if (pids.length) forceKillTree(pids);
  // ③ 孤儿 QQ（NapCat 拉起的那个）
  const orphans = orphanQqPids();
  if (orphans.length) forceKillTree(orphans);

  if (!pids.length && !orphans.length) return { ok: false, msg: '没找到在跑的协议端' };
  // 给系统一点时间收尾：不等就可能"新的起了、旧的还没死"，两边打架
  await new Promise((s) => setTimeout(s, 1500));
  const extra = orphans.length ? `（连带它拉起的 ${orphans.length} 个 QQ）` : '';
  return { ok: true, msg: `已停止协议端（${pids.length} 个进程）${extra}` };
}

/**
 * 强杀 NapCat 的进程树（含它拉起的 QQ）。
 *
 * ⚠️ 为什么必须 `/F`（2026-10-13 真机定位）：面板通用的 `killTree` 先发**优雅关闭**
 *    （`taskkill /PID x /T`，无 /F）。GUI 程序（QQ）对优雅关闭是**直接无视**的 ——
 *    于是 NapCat 死了、QQ 活着，下一个 NapCat 起不来（QQ 已在运行，hook 注入不进去），
 *    表现就是"重启协议端成功但二维码永远不出现"。
 *    这里自己发 `/F`，不依赖调用方传进来的 killTree。
 */
function forceKillTree(pids) {
  for (const pid of pids) {
    try {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { timeout: 8000, windowsHide: true });
    } catch { /* 目标已经没了 —— 那不是错误 */ }
  }
}

/**
 * 找出**被 NapCat 拉起来的** QQ：父进程已经死了的 QQ.exe。
 *
 * 为什么不能一律杀 QQ：用户自己开的 QQ 父进程活着（explorer 等），杀了会打扰人家；
 * 而 NapCat 拉起的 QQ 在 NapCat 死后父进程就没了 ⇒ 孤儿。这条判据足够精确。
 */
function orphanQqPids() {
  if (!IS_WIN) return [];
  try {
    const ps = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      "$all = Get-CimInstance Win32_Process | Select-Object -ExpandProperty ProcessId; " +
      "Get-CimInstance Win32_Process -Filter \"Name='QQ.exe'\" | " +
      "Where-Object { $all -notcontains $_.ParentProcessId } | " +
      "ForEach-Object { $_.ProcessId }"],
      { encoding: 'utf8', timeout: 20000, windowsHide: true });
    return ps.split('\n').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0);
  } catch {
    return []; // 没有 QQ / PowerShell 不可用 —— 都当作"没有孤儿"
  }
}

/** 当前在跑的 NapCat 主进程 PID 列表（tasklist /fi csv，解析第二列）。 */
export function napcatProcessPids() {
  if (!IS_WIN) return [];
  try {
    const out = execFileSync(
      'tasklist', ['/fi', 'imagename eq NapCatWinBootMain.exe', '/fo', 'csv'],
      { encoding: 'utf8', timeout: 8000, windowsHide: true },
    );
    return out.split('\n').slice(1)
      .map((l) => l.split(',')[1])
      .map((s) => Number(String(s || '').replace(/"/g, '').trim()))
      .filter((n) => Number.isFinite(n) && n > 0);
  } catch {
    return []; // tasklist 对"没有匹配进程"返回非零 —— 那不是错误，就是没有
  }
}

/**
 * 真·重启：先杀干净（含 NapCat 拉起的 QQ），再拉起，然后**等它真正活过来**。
 *
 * "活过来"的判据是三选一（2026-10-13 群友资料补充）：NapCat 把 hook 注进 QQ，
 * **WebUI(6099) 与 OneBot(3001/3000) 都由 QQ 进程监听** —— 所以二维码图先出、
 * 端口后开，等任何一个都算活。等到不等于失败，照实说明。
 *
 * @param {(pid:number)=>Promise<boolean>} killTree 面板的杀树函数（按 pid）
 */
export async function restartNativeNapcat(killTree, { qq = '', waitMs = 45000 } = {}) {
  if (!IS_WIN) return { ok: false, msg: '原生协议端只在本包的 Windows 构建里使用' };
  const stop = await stopNativeNapcat(killTree);
  if (!stop.ok && !/没找到/.test(stop.msg)) {
    return { ok: false, msg: `停不下来：${stop.msg}` };
  }
  const start = startNativeNapcat({ qq });
  if (!start.ok) return { ok: false, msg: start.msg };

  // 删掉旧码，免得"新的还没写好、旧的还躺着"被当成换好了
  try { fs.rmSync(nativeQrPng(), { force: true }); } catch { /* 删不掉不致命 */ }

  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await new Promise((s) => setTimeout(s, 700));
    if (readLocalQr()) return { ok: true, msg: '已重启，新二维码已生成' };
    if (await portAlive(3001)) return { ok: true, msg: '已重启，协议端已就绪（账号已登录，不用扫码）' };
  }
  return {
    ok: false,
    msg: '已重启但协议端没起来 —— 大概率是 **QQ 还在运行**（NapCat 要把 hook 注进 QQ，\n' +
         'QQ 占着就注不进去）。请完全退出 QQ（含托盘图标）后再点一次「重启协议端」。',
  };
}

/** 端口是否在听（本地探一次，失败算不在）。 */
function portAlive(port) {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1');
    const done = (v) => { try { s.destroy(); } catch { /* 已断 */ } resolve(v); };
    s.setTimeout(800, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}
