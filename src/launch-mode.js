/**
 * 桌面端「启动方式」的唯一一份判据（2026-10-16 · 桌面端形态第一批）。
 * ══════════════════════════════════════════════════════════════════════════
 *  它回答两个问题，而且**只有这一个地方回答**：
 *    ① 启动器该以什么形态把控制台页面呈现出来 —— 浏览器标签页 / 独立应用窗口；
 *    ② 「独立窗口」在这台机器上拿哪个浏览器开 —— 探测 → 回落，**绝不失败**。
 *
 *  ── 为什么必须只有一份 ─────────────────────────────────────────────────
 *  读方向有**三个启动入口**：Windows 便携包 `tools/start.mjs`（经 `lib/console.mjs`）、
 *  Windows 开发树 `scripts/win-launcher.mjs`、macOS `Estrella-Bot.app` 的 `launcher.sh`
 *  （经 `scripts/launch-mode.mjs` 这个 CLI）。写方向还有面板两处：保存配置的校验
 *  （`panel/lib/config-route.js`）与状态下发（`panel/lib/state-collector.js`）。
 *  同一件事五处各写一份 = 必然漂移：症状会是"面板存不进去"或"存了不生效"，
 *  而两边看起来都正常（本仓在同类问题上反复清过，不再是新发现的量级）。
 *
 *  ── 三条设计纪律 ───────────────────────────────────────────────────────
 *  ① **读取一律 fail-open**：配置缺失 / 读不出来 / 值认不出 ⇒ 按 browser 处理。
 *     一个坏配置把"打不开界面"变成现实，是本模块的**头号红线**。
 *  ② **零项目依赖**（只 import `node:` 内置）：面板进程也要 import 它 ——
 *     一旦引了机器人的重型链，两个进程的启动路径就缠在一起了（check-wb §82 的准入判据）。
 *  ③ **纯决策与副作用分离**：`normalizeLaunch` / `validateLaunch` / `planOpen` 全是纯函数
 *     （测试直接断言，不需要真开浏览器）；只有 `openPanelFromConfig` 落成真动作，
 *     且它的 IO（读文件 / 探测存在 / spawn）全部可注入。
 *
 *  形态说明：mode='window' 时用系统里已装的 Microsoft Edge / Google Chrome 以
 *  `--app=<url>` 打开一个没有地址栏、没有标签页的应用窗口；两个都没装 ⇒
 *  回落成浏览器标签页（**不是**错误）。mode='browser' 就是一直以来的行为。
 *
 *  ── 它还负责「启动跟踪」（2026-10-16 · 维护者点名）────────────────────────
 *  每次启动落**一行 JSON** 到与 config.json 同辈的 `panel/launch-log.jsonl`，
 *  控制台「启动方式」卡片显示最近一次 —— 启动器在 Windows 上是隐藏窗口跑的、
 *  在 Mac 上是个图标，出了问题"到底走了哪条路"人在现场看不见，
 *  而这一层跨三个入口 + 面板，没有跟踪就只能靠猜。
 *  读写两个口（`recordLaunch` / `readLaunchLog`）与写方（本模块的 openPanelFromConfig）
 *  同住这里：跟踪的**形状**只此一份，写的人和读的人不会各存一半。
 *
 *  ── 它还负责「窗口记忆」（2026-10-16 · 维护者报"窗口每次都被重置"）─────────────
 *  「独立窗口」的位置与尺寸由**面板页面**上报（它就在那个窗口里，screenX / outerWidth
 *  是现成的）；面板存进与 config.json 同辈的 `panel/window-state.json`；启动器下次开窗
 *  用 `--window-size` / `--window-position` 还原。三个角色（页面报 / 面板存 / 启动器用）
 *  共享的**只有这一份形状**：`normalizeWinState`（值域与取舍）/ `windowStatePath` /
 *  `readWindowState`。页面与启动器之间靠 URL 上的 `__win=1` 标记认亲 —— 普通标签页
 *  不报（它报的是整个浏览器窗口，会把"上次独立窗口"污染成浏览器窗口的样子）。
 *  ⚠️ 与 fail-open 同一红线：这份记忆**全都可以没有**（没有 / 坏了 / 越界）——
 *     那就按默认尺寸开，绝不因为一个记忆文件"打不开界面"。
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';

/** 值域：写侧只收这两个；读侧认不出的值一律按 `browser` 处理（见 normalizeLaunch）。 */
export const LAUNCH_MODES = ['browser', 'window'];

/** 缺省值 = 现行行为（老配置里没有 `launch` 段时走它 ⇒ 老用户零感知）。 */
export const DEFAULT_LAUNCH = Object.freeze({ mode: 'browser', openOnStart: true });

/**
 * 独立窗口的**默认**尺寸（逻辑像素）—— 只在"没有记住的窗口状态"时用（第一次开）。
 * 之后每一次：面板会把上次的尺寸与位置记进 `panel/window-state.json`，
 * `planOpen` 读出来用 `--window-size` / `--window-position` 还原（见文件头「窗口记忆」）。
 * ⚠️ **不导出**（check-wb §56 的取向：导出即对外承诺；现在只有 `planOpen` 这一个
 *    消费点）。将来要调它 / 做成配置项，就在这个模块里演进（不另开新段）。
 */
const WINDOW_SIZE = '1360,860';

/**
 * 独立窗口 URL 上的**认亲标记**：面板页面看到它才上报窗口几何（见 `panel/next/app.js`）。
 * ⚠️ 字面量与 `panel/next/app.js` 里那份必须逐字相同 —— check-wb §104 钉着这一对。
 */
const WIN_QUERY = '__win=1';

/**
 * 读侧归一化：把配置里那个 `launch` 段收敛成"启动器实际会执行"的样子。
 *
 * ⚠️ `unknownMode` 是**如实带出来给日志用的**：认不出时不静默 —— 启动器会把原值
 *    打进日志（"改了没生效"时，第一眼就能看到是不是值写错了）。
 * ⚠️ `openOnStart` 只有明确的 `false` 才算关；其余（含坏值）一律按"开"处理（fail-open）。
 */
export function normalizeLaunch(raw) {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const mode = r.mode === 'window' ? 'window' : 'browser';
  const unknownMode =
    typeof r.mode === 'string' && r.mode !== 'window' && r.mode !== 'browser' ? r.mode : null;
  return { mode, openOnStart: r.openOnStart !== false, unknownMode };
}

/**
 * 写侧校验（面板保存配置用）。**拒绝整次保存并说清原因**，不做静默纠正 ——
 * 静默纠正会让用户以为选上了（"我明明点了独立窗口"），而实际没存对。
 *
 * @returns {{ok:true, value:object} | {ok:false, error:string}}
 */
export function validateLaunch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return { ok: false, error: 'launch 必须是一个对象（{ mode?, openOnStart? }）。' };
  }
  const out = {};
  if ('mode' in patch) {
    const m = typeof patch.mode === 'string' ? patch.mode.trim() : '';
    if (!LAUNCH_MODES.includes(m)) {
      return {
        ok: false,
        error: `启动方式只接受 ${LAUNCH_MODES.join(' / ')}（收到的是 ${JSON.stringify(patch.mode)}）`
          + ' —— 它决定"用浏览器标签页还是独立窗口打开控制台"。',
      };
    }
    out.mode = m;
  }
  if ('openOnStart' in patch) {
    if (typeof patch.openOnStart !== 'boolean') {
      return {
        ok: false,
        error: `openOnStart 只接受 true / false（收到的是 ${JSON.stringify(patch.openOnStart)}）。`,
      };
    }
    out.openOnStart = patch.openOnStart;
  }
  return { ok: true, value: out };
}

/**
 * 从已解析的配置对象里读 launch（读侧）。
 *
 * `defaultMode` 只对**没有显式 launch.mode** 的配置生效（P2 安装版默认独立窗口）。
 * 用户显式写过 browser/window 时永远以配置为准 —— 默认值不能覆盖用户选择。
 */
export function launchOfConfig(cfg, { defaultMode } = {}) {
  const raw = cfg && typeof cfg === 'object' ? cfg.launch : undefined;
  const hasExplicitMode = raw && typeof raw === 'object' && !Array.isArray(raw) && typeof raw.mode === 'string';
  const out = normalizeLaunch(raw);
  if (!hasExplicitMode && (defaultMode === 'window' || defaultMode === 'browser')) out.mode = defaultMode;
  return out;
}

/**
 * 从磁盘上的 config.json 读 launch 段。**读不出来不抛** ⇒ 返回缺省值 + `unreadable: true`。
 */
export function readLaunchFile(configPath, { readFileSync = fs.readFileSync, defaultMode } = {}) {
  try {
    const cfg = JSON.parse(String(readFileSync(configPath, 'utf8')));
    return { ...launchOfConfig(cfg, { defaultMode }), unreadable: false };
  } catch {
    return { ...DEFAULT_LAUNCH, ...(defaultMode === 'window' ? { mode: 'window' } : {}), unknownMode: null, unreadable: true };
  }
}

// ── 启动跟踪（2026-10-16 · 维护者点名"添加跟踪"）────────────────────────────
//
// 为什么需要：启动器在 Windows 上是**隐藏窗口**跑的（双击完就退），Mac 上是个图标 ——
// 出了问题"到底用了什么形态、有没有回落、为什么"，人在现场看不见任何东西。
// 而这一层**跨三个入口 + 面板**，没有跟踪就只能靠猜。
// ⇒ 每次启动落**一行 JSON**，面板「启动方式」卡片直接显示最近一次。
//
// ⚠️ 跟踪**永远不许影响启动本身**：写不进去就静默放弃（返回 false），绝不抛 ——
//    它是"锦上添花"，不是启动的前置条件。

/** 启动跟踪的落点：默认与 config.json **同辈**的 panel/；面板可显式传 USER_ROOT/panel。 */
export function launchLogPath(configPath, stateDir) {
  return path.join(stateDir || path.join(path.dirname(configPath), 'panel'), 'launch-log.jsonl');
}

/** 跟踪文件的**封顶行数**：超了就只留最近一半（它只用来回答"上次是怎么开的"）。 */
const LAUNCH_LOG_MAX = 200;

/**
 * 记一条启动跟踪（追加一行 JSON）。**永不抛**。
 * @param {string} file  日志文件路径（`''` = 关闭跟踪，直接返回 false）
 * @param {object} event 事件对象（形状由 openPanelFromConfig 决定，见那里）
 * @returns {boolean} 是否真的写下去了
 */
export function recordLaunch(file, event, { fsApi } = {}) {
  if (!file) return false;
  const A = fsApi || fs;
  try {
    A.appendFileSync(file, `${JSON.stringify(event)}\n`);
  } catch {
    return false; // 目录不存在 / 权限不足都不该打断启动
  }
  // 封顶修剪（独立 try）：按批修剪，并发下最坏丢几条跟踪，与启动无关。
  try {
    const lines = String(A.readFileSync(file, 'utf8')).split('\n').filter(Boolean);
    if (lines.length > LAUNCH_LOG_MAX) {
      A.writeFileSync(file, `${lines.slice(-Math.floor(LAUNCH_LOG_MAX / 2)).join('\n')}\n`);
    }
  } catch { /* 修剪失败不影响这次记录 */ }
  return true;
}

/**
 * 读最近 N 条启动跟踪（面板显示"上次是怎么打开的"）。
 * **读不出来一律 []**（fail-safe）—— 坏行跳过，不让一行脏数据挡住整个显示。
 */
export function readLaunchLog(file, { limit = 5, fsApi } = {}) {
  const A = fsApi || fs;
  try {
    const lines = String(A.readFileSync(file, 'utf8')).split('\n').filter(Boolean);
    const out = [];
    for (const l of lines.slice(-limit)) {
      try { out.push(JSON.parse(l)); } catch { /* 坏行跳过 */ }
    }
    return out;
  } catch {
    return [];
  }
}

// ── 「窗口记忆」：独立窗口的位置与尺寸（2026-10-16 · 维护者报"每次都被重置"）────
//
// 三个角色，一份形状（都住在本模块）：
//   ① 面板页面（在窗口里）在 resize / 移动 / 关闭前上报 screenX / screenY /
//      outerWidth / outerHeight；② 面板服务端把**过得了 `normalizeWinState` 的值**
//      写进 `<与 config.json 同辈>/panel/window-state.json`；③ 启动器下次开窗前
//      读回来 → `--window-size` / `--window-position`（由 `planOpen` 消费）。
//
// ⚠️ 与 fail-open 同一取向：这份记忆**全都可以没有**。读不到 / 坏 JSON / 值越界
//    ⇒ 一律 null（调用方回落默认尺寸），绝不因为一个记忆文件"打不开界面"。

/** 窗口尺寸的取值边界（逻辑像素）：更小多半不是一次真窗口的尺寸，更大当作脏数据。 */
const WIN_MIN_W = 400;
const WIN_MIN_H = 300;
const WIN_SIZE_MAX = 10000;
/** 位置边界：**允许负数**（多显示器摆在主屏左侧/上方时就是负的），只防离谱值。 */
const WIN_POS_MAX = 20000;

/**
 * 归一化一份窗口状态。**唯一一份值域判据** —— 页面报上来（服务端写盘前）与
 * 启动器读回来（用之前）都过它。
 *
 * 规则（刻意简单，宁缺毋滥）：
 *   · `w` / `h` 必须是有限数、取整后落在 [MIN, MAX]；不合格 ⇒ **整份 null**（连位置也丢）；
 *   · `x` / `y` 必须成对合格才带上；单独坏一个 ⇒ 只丢位置、尺寸照用；
 *   · 认不出的形状（字符串 / 数组 / null）⇒ null。
 * @returns {{w:number, h:number, x:number|null, y:number|null}|null}
 */
export function normalizeWinState(raw) {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null);
  const w = num(r.w);
  const h = num(r.h);
  if (w === null || h === null || w < WIN_MIN_W || h < WIN_MIN_H || w > WIN_SIZE_MAX || h > WIN_SIZE_MAX) return null;
  let x = num(r.x);
  let y = num(r.y);
  if (x === null || y === null || Math.abs(x) > WIN_POS_MAX || Math.abs(y) > WIN_POS_MAX) { x = null; y = null; }
  return { w, h, x, y };
}

/** 窗口状态的落点：默认与 config.json **同辈**的 panel/；面板可显式传 USER_ROOT/panel。 */
export function windowStatePath(configPath, stateDir) {
  return path.join(stateDir || path.join(path.dirname(configPath), 'panel'), 'window-state.json');
}

/**
 * 读窗口状态。**读不出来一律 null**（fail-safe —— 调用方按"没有记忆"处理，
 * 绝不因为它抛错而打不开界面）。
 */
export function readWindowState(configPath, { readFileSync = fs.readFileSync } = {}) {
  try {
    return normalizeWinState(JSON.parse(String(readFileSync(windowStatePath(configPath), 'utf8'))));
  } catch {
    return null;
  }
}

/**
 * 「独立窗口」专用浏览器 profile 目录（与 config.json 同辈的 panel/ 下）。
 *
 * ⚠️ 为什么必须**专用**（2026-10-16 · 真机根因，实测复现）：
 *    Chromium 对同一个 user-data-dir 只跑一个浏览器进程 —— 第二个进程会把"开窗口"
 *    **委派**给已在跑的那个，而委派路径**吞掉** `--window-size` / `--window-position`
 *    （隔离实测：请求 640×480@300,250，实际开在上一只窗口的位置；而全新进程逐字兑现）。
 *    用专用 profile：① 不与会话里的日常 Edge/Chrome 互相干扰（顺带不共享它们的
 *    扩展与策略）；② 每次开窗前我们可**关掉旧实例**（见 closeStaleConsole），
 *    保证"开窗的这一只"是全新进程 —— 几何标志才会被真正兑现。
 */
export function consoleProfileDir(configPath, stateDir) {
  return path.join(stateDir || path.join(path.dirname(configPath), 'panel'), 'console-profile');
}

/** 同步睡一会儿（只为"等旧浏览器进程退出"这一件事；不引第三方库）。 */
function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* 不支持就跳过 */ }
}

/**
 * 关掉**用我们这个专用 profile** 的浏览器实例（只认它 —— 绝不碰用户自己的浏览器）。
 *
 * ⚠️ 它的存在就是为了破解"委派吞几何"：先关旧实例、再开新实例 ⇒ 标志必被兑现。
 *    必须在开窗前**同步**完成，故用 execFileSync + 同步轮询。
 * ⚠️ 三条约束：① 匹配模式指向专用 profile（用户自己的浏览器命令行里没有它，误伤不了）；
 *    ② 全程 try/catch，**永远不抛**（关不掉就照常开 —— 最坏=这一次几何没生效，与不做这步时相同）；
 *    ③ 等退出有**有界**超时（约 3 秒），不让"浏览器赖着不走"把启动链拖死。
 * @returns {number} 实际发过终止信号的进程数（0 = 本来就没有 / 关不掉）
 *
 * ⚠️ **0 是有歧义的**（2026-10-16 第六轮真机数据的教训）："进程本来就不在"与
 *    "PowerShell 超时/起不来被吞掉"返回值一样 —— 排障时两种原因天差地别。
 *    所以给了可选的 `onNote`：**失败 / 输出解析不出**时如实带一句话（注意：`0` 是一个
 *    正当答案 —— "本来就没有旧实例"，不带话，别把"没活干"报成"没干成"），
 *    调用方（openPanelFromConfig）把它写进启动跟踪（`consoleKillNote`）。
 * @param {object} [hiddenVbs] 通用隐藏执行件的路径（`run-hidden.vbs`）—— 给了就走
 *    它（见下面的机制说明），没给就退回直接调 PowerShell。
 */
export function closeStaleConsole(profileDir, {
  platform = process.platform, exec = execFileSync, onNote, hiddenVbs = '',
} = {}) {
  const note = onNote || (() => {});
  if (!profileDir) return 0;
  try {
    if (platform === 'darwin') {
      const pat = profileDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // pgrep -f 是 ERE，路径要转义
      const list = () => {
        try {
          return String(exec('pgrep', ['-f', `user-data-dir=${pat}`], { encoding: 'utf8', timeout: 4000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }))
            .split('\n').map((s) => s.trim()).filter((s) => /^\d+$/.test(s));
        } catch { return []; } // pgrep 无命中时退出码非 0
      };
      const pids = list();
      for (const pid of pids) {
        // ⚠️ stderr 全静音：进程可能恰好已退出，`kill` 会喊 "No such process" ——
        //    那是正常竞态，不该出现在用户的启动器输出里。
        try { exec('kill', [pid], { timeout: 4000, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'] }); } catch { /* 已退出 */ }
      }
      for (let i = 0; i < 15 && list().length > 0; i += 1) sleepSync(200);
      return pids.length;
    }
    if (platform === 'win32') {
      // **单趟 PowerShell** 干完"找 → 强杀 → 等退出"，只回一个数字。
      // ⚠️ 2026-10-16 VM 反馈砸出来的三条（每一条都是真机上真发生过的，改回去就复发）：
      //   ① 必须**单趟**：原实现从 Node 侧多趟往返（查 / 杀 / 再查），冷 VM 里每趟都要
      //      一次 PS + WMI 冷启动；快速连点几次、几趟叠起来会把启动链拖死 ——
      //      真机症状"打开两次之后控制台就打不开了"即由此而来；
      //   ② 直接 `/F` 强杀（配窗口参数里的 `--disable-session-crashed-bubble`）——
      //      不做"先优雅再等"：Edge 有后台驻留时优雅关并不退出，白等一轮还把开窗拖慢；
      //   ③ 超时后**放弃**（返回值按 0 算）—— 冷 VM 首查可达 10s+，但绝不把启动链拖死；
      //      这一次几何没生效只是回到"旧行为"，下一次就好了。
      // 只认专用目录名（`console-profile`）：用户自己的浏览器命令行里没有它，误伤不了。
      //
      // ⚠️ ④ **口径订正（2026-10-17 第 15 次构建的真机取证）**：上一版在这里写的是
      //    "必须 windowsHide:true，否则那只灰框就是它" —— **这句是错的**，真机数据
      //    （windowsHide 一直带着、`consoleKilled` 正常、几何已兑现）证明灰框另有来源。
      //    现在的认识：Windows 11 把「默认终端应用程序」设成 **Windows 终端**时，
      //    控制台程序**不认** CREATE_NO_WINDOW（`windowsHide` 就是它）—— 进程照样
      //    要一个控制台 ⇒ 终端窗口自己弹出来。可靠的那条路是 ShellExecute 的 SW_HIDE，
      //    也就是 `run-hidden.vbs`（包里另两条隐藏链用的就是它）。所以：
      //    **给了 hiddenVbs 就走 VBS**（首选）；没有（Mac / 老包 / 开发树）才直接调 PS。
      const ps = [
        `$m = "Name='msedge.exe' or Name='chrome.exe'";`,
        `$f = { $_.CommandLine -and $_.CommandLine.Contains('console-profile') };`,
        `$p = @(Get-CimInstance Win32_Process -Filter $m | Where-Object $f);`,
        `foreach ($x in $p) { taskkill /PID $x.ProcessId /T /F 2>$null | Out-Null };`,
        `for ($i = 0; $i -lt 25; $i++) { if (-not @(Get-CimInstance Win32_Process -Filter $m | Where-Object $f).Count) { break }; Start-Sleep -Milliseconds 200 };`,
        `Write-Output $p.Count`,
      ].join(' ');
      // PS 的输出解析：`null` = 解析不出（跟"回答是 0"两回事）
      const parseCount = (raw) => {
        const t = String(raw || '').trim();
        if (!t) return null;
        const n = Number(t.split('\n').map((s) => s.trim()).filter(Boolean).pop());
        return Number.isFinite(n) ? n : null;
      };
      try {
        let out = '';
        if (hiddenVbs) {
          // 首选：经 `run-hidden.vbs` 的 ShellExecute(SW_HIDE) —— 见上面的口径订正 ④。
          // 输出只能走文件（SW_HIDE 那条路拿不到管道），跑完读回来再删。
          const enc = Buffer.from(ps, 'utf16le').toString('base64');
          const tmpDir = process.env.TEMP || process.env.TMP || path.dirname(profileDir);
          const outFile = path.join(tmpDir, `estrella-console-kill-${process.pid}.txt`);
          const cmdLine = `cmd /d /c powershell -NoProfile -NonInteractive -EncodedCommand ${enc} > "${outFile}" 2>&1`;
          exec('wscript', ['//B', '//Nologo', hiddenVbs, cmdLine, 'wait'], {
            timeout: 20000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
          });
          try { out = String(fs.readFileSync(outFile, 'utf8')); } catch { out = ''; }
          try { fs.unlinkSync(outFile); } catch { /* 删不掉也就留个临时文件 */ }
        } else {
          out = String(exec('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], {
            encoding: 'utf8', timeout: 15000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
          }));
        }
        const n = parseCount(out);
        if (n === null) {
          note(`ps-no-output（PowerShell 有应答但解析不出数字）：${String(out).trim().slice(0, 80) || '(空)'}`);
          return 0;
        }
        return n > 0 ? n : 0; // 0 = 确实没有旧实例 —— 正当答案，不带话
      } catch (e) {
        // 超时 / 起不来都不抛：照常开窗（最坏=这一次几何没生效）—— 但要**如实带话**，
        // 别让"没杀成"伪装成"没东西可杀"（这就是 consoleKilled:0 歧义的来源）。
        note(`ps-failed${e && e.code ? ` code=${e.code}` : ''}：${e && e.message ? String(e.message).slice(0, 120) : e}`);
        return 0;
      }
    }
  } catch { /* 约束 ②：永不抛 */ }
  return 0;
}

/**
 * 启动入口的**中文名**（跟踪记录里存的是 id，面板显示要人话）。
 * 住在这里而不是面板里：id 由各入口传给本模块，名字也由本模块一处提供 ——
 * 面板不该再自存一份（"一份数据维护两遍"是本仓反复踩过的坑）。
 */
export const LAUNCH_ENTRY_LABELS = {
  'win-pkg': 'Windows 便携包（桌面图标 / 2-START）',
  'win-dev': 'Windows 开发树启动器',
  'mac-app': 'Mac 图标（.app）',
  cli: '命令行',
};

// ── 「该执行什么命令」的决策（纯函数）────────────────────────────────────────

/** 探路径是否存在。**默认实现就是真探测** —— 调用方忘了注入时也不许退化成"都找不到"。 */
const defaultExists = (p) => {
  try { return fs.existsSync(p); } catch { return false; }
};

/**
 * 浏览器标签页：win 走 `cmd /c start`、mac 走 `open`、其余 `xdg-open`。
 *
 * ⚠️ `start` 是 cmd 的**内建命令**，且第一个带引号的参数会被当成**窗口标题** ——
 *    那个空串位缺不得：少了它 URL 会被当成标题、浏览器根本不开，而且**没有任何报错**。
 */
function browserPlan(platform, url) {
  if (platform === 'win32') {
    // ⚠️ **不碰控制台程序**（2026-10-17 · 灰框机制的彻底解法）：
    //    以前这里是 `cmd /c start "" <url>` —— cmd 是**控制台程序**，Windows 终端当
    //    默认终端时，CREATE_NO_WINDOW（windowsHide）与 SW_HIDE 都可能照样弹出一只
    //    终端窗（那只灰框的来源之一）。
    //    `rundll32.exe` 是 **GUI 子系统**程序：系统根本不会为它建控制台 ⇒
    //    这类窗口**从根上就不存在**。`url.dll,FileProtocolHandler` 走的仍是
    //    ShellExecute，所以"用系统默认浏览器打开"这个语义一点没变。
    //    ⚠️ 起不来的兜底（rundll32 被策略拦掉时）在 openPanelFromConfig 里。
    return { kind: 'browser', exec: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', url], used: 'default-browser' };
  }
  if (platform === 'darwin') return { kind: 'browser', exec: 'open', args: [url], used: 'default-browser' };
  return { kind: 'browser', exec: 'xdg-open', args: [url], used: 'default-browser' };
}

/**
 * 「独立窗口」的候选浏览器表。**顺序有意义**：先 Edge、后 Chrome；都没有就是空表。
 *
 * ⚠️ 路径用字符串拼 `\`（**不用 path.join**）：这个函数会带着 `platform='win32'`
 *    在 macOS 上被测试直接调用，path.join 会按**当前平台**折出混合分隔符。
 */
function windowBrowserCandidates(platform, env) {
  if (platform === 'win32') {
    const pf = env.ProgramFiles || 'C:\\Program Files';
    const pf86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const local = env.LOCALAPPDATA || '';
    return [
      { used: 'msedge', exe: `${pf86}\\Microsoft\\Edge\\Application\\msedge.exe` },
      { used: 'msedge', exe: `${pf}\\Microsoft\\Edge\\Application\\msedge.exe` },
      { used: 'chrome', exe: `${pf}\\Google\\Chrome\\Application\\chrome.exe` },
      { used: 'chrome', exe: `${pf86}\\Google\\Chrome\\Application\\chrome.exe` },
      { used: 'chrome', exe: `${local}\\Google\\Chrome\\Application\\chrome.exe` },
    ];
  }
  if (platform === 'darwin') {
    return [
      { used: 'msedge', app: 'Microsoft Edge', probe: '/Applications/Microsoft Edge.app' },
      { used: 'chrome', app: 'Google Chrome', probe: '/Applications/Google Chrome.app' },
    ];
  }
  return [];
}

/** 给独立窗口的 URL 带上认亲标记（`WIN_QUERY`）。已带则原样放行（幂等）。 */
function winModeUrl(url) {
  const s = String(url);
  if (s.includes('__win=')) return s;
  const [base, hash] = s.split('#');
  return `${base}${base.includes('?') ? '&' : '?'}${WIN_QUERY}${hash !== undefined ? `#${hash}` : ''}`;
}

/**
 * 纯决策：给定平台 / 模式 / URL / 存在性判据 / 记住的窗口状态，算出该执行什么命令。
 * **不产生任何副作用** —— 测试直接断言它，不需要真开浏览器。
 *
 * ⚠️ 窗口模式四件套（2026-10-16 起）：
 *   ① URL 上带 `__win=1` 标记（页面靠它知道"我是个独立窗口，该上报几何"）；
 *   ② 专用 `--user-data-dir`（`consoleProfileDir`）—— 见那个函数的注释：共用 profile
 *      会被 Chromium 委派开窗、几何标志被吞；
 *   ③ `--window-size`：有记住的状态用它的，没有用默认 `WINDOW_SIZE`；
 *   ④ 有记住的**位置**才带 `--window-position`（没记过就不指挥系统把窗放哪儿）。
 *   两端（win32 / darwin）用**同一套参数** —— 一致性靠这一份，不靠各写一半。
 *
 * @param {object} o
 * @param {string} o.platform  'win32' | 'darwin' | 其它
 * @param {'browser'|'window'} o.mode
 * @param {string} o.url
 * @param {(p:string)=>boolean} [o.exists] 探路径是否存在（可注入）
 * @param {object} [o.env] 取 Windows 的 ProgramFiles 等（可注入）
 * @param {object} [o.winState] 记住的窗口状态（原始形状即可，内部过 normalizeWinState）
 * @param {string} [o.profileDir] 专用浏览器 profile 目录（给了才带 `--user-data-dir`）
 * @returns {{kind:'window'|'browser', exec:string, args:string[], used:string, reason?:string, win?:object}}
 */
export function planOpen({ platform, mode, url, exists = defaultExists, env = {}, winState = null, profileDir = '' }) {
  if (mode === 'window') {
    const st = normalizeWinState(winState);
    const [dw, dh] = WINDOW_SIZE.split(',');
    const winArgs = [`--app=${winModeUrl(url)}`];
    if (profileDir) winArgs.push(`--user-data-dir=${profileDir}`);
    winArgs.push(`--window-size=${st ? `${st.w},${st.h}` : WINDOW_SIZE}`);
    if (st && st.x !== null) winArgs.push(`--window-position=${st.x},${st.y}`);
    // 专用 profile 是"全新的" ⇒ 不加这两只旗标，首启会多弹一个欢迎/引导窗，把这个
    // 控制台窗口衬得像是坏了。
    if (profileDir) winArgs.push('--no-first-run', '--no-default-browser-check');
    // 旧实例万一走到"强制关"（Windows 的 /F 兜底），下次开窗别再弹"恢复页面"气泡 ——
    // 对一个控制台窗口来说那看起来就像坏了。
    if (profileDir) winArgs.push('--disable-session-crashed-bubble');
    const win = {
      w: st ? st.w : Number(dw),
      h: st ? st.h : Number(dh),
      x: st ? st.x : null,
      y: st ? st.y : null,
      remembered: Boolean(st),
    };
    if (platform === 'win32') {
      const hit = windowBrowserCandidates('win32', env).find((c) => c.exe && exists(c.exe));
      if (hit) return { kind: 'window', exec: hit.exe, args: winArgs, used: hit.used, win };
    } else if (platform === 'darwin') {
      const hit = windowBrowserCandidates('darwin', env).find((c) => exists(c.probe));
      if (hit) return { kind: 'window', exec: 'open', args: ['-na', hit.app, '--args', ...winArgs], used: hit.used, win };
    }
    // 没有能开窗口的浏览器 ⇒ **回落浏览器标签页**（fail-open）：
    // "宁可是标签页"永远好过"双击了却什么都没开"。
    return { ...browserPlan(platform, url), reason: 'no-window-browser' };
  }
  return browserPlan(platform, url);
}

// ── 执行 ────────────────────────────────────────────────────────────────────

/**
 * 一次调用完成「读配置 → 分派 → 打开 → 记一条跟踪」。三个启动器等入口都走它。
 *
 * @param {object} o
 * @param {string} [o.entry] 入口 id（`win-pkg` / `win-dev` / `mac-app` / `cli`…）——
 *   进跟踪记录，面板「上次启动」靠它说清"是谁开的"。新增入口必须在这里有个名字
 *   （`LAUNCH_ENTRY_LABELS`），否则面板上显示原始 id。
 * @param {string} [o.logFile] 跟踪落点（缺省 = 与 config.json 同辈的 panel/launch-log.jsonl；
 *   `''` = 显式关闭跟踪）。
 * @returns {{opened:boolean, skipped?:boolean, mode:string, used:string, kind?:string,
 *            reason?:string, error?:string, url:string}}
 */
export function openPanelFromConfig({
  configPath,
  url,
  entry = 'unknown',
  platform = process.platform,
  env = process.env,
  exists = defaultExists,
  spawnFn = spawn,
  execFn = execFileSync,
  readFileSync = fs.readFileSync,
  log = () => {},
  logFile,
  // 通用隐藏执行件（包根 `run-hidden.vbs`）：win32 上"要跑控制台程序又不想被看见"
  // 的唯一通道。没给 = 老包 / 非 Windows —— 一切照旧（fail-open）。
  hiddenVbs = '',
  defaultMode = '',
} = {}) {
  const launch = readLaunchFile(configPath, { readFileSync, defaultMode });
  // 「窗口记忆」：只在 window 模式读（browser 模式根本不消费它）。
  const winState = launch.mode === 'window' ? readWindowState(configPath, { readFileSync }) : null;
  // 独立窗口的专用浏览器 profile（破除"委派吞几何"——见 consoleProfileDir 的注释）。
  const profileDir = launch.mode === 'window' ? consoleProfileDir(configPath) : '';
  const trackFile = logFile !== undefined ? logFile : (configPath ? launchLogPath(configPath) : '');
  const track = (extra) => recordLaunch(trackFile, {
    t: new Date().toISOString(),
    entry,
    platform,
    mode: launch.mode,
    url,
    ...(launch.unknownMode ? { unknownMode: launch.unknownMode } : {}),
    ...(launch.unreadable ? { unreadable: true } : {}),
    ...extra,
  });
  if (launch.unreadable) {
    log(`⚠ 读不到配置（${configPath}）—— launch 段按默认值处理（浏览器标签页 + 自动打开）`);
  }
  if (launch.unknownMode) {
    log(`⚠ launch.mode 值是「${launch.unknownMode}」—— 认不出，按 browser 处理（可选：${LAUNCH_MODES.join(' / ')}）`);
  }
  if (!launch.openOnStart) {
    log(`ℹ 已按设置不自动打开界面（launch.openOnStart=false）—— 控制台地址：${url}`);
    track({ opened: false, skipped: true, used: 'none' });
    return { opened: false, skipped: true, mode: launch.mode, used: 'none', url };
  }
  const plan = planOpen({ platform, mode: launch.mode, url, exists, env, winState, profileDir });
  if (plan.win && plan.win.remembered) {
    log(`ℹ 独立窗口：沿用上次的尺寸与位置（${plan.win.w}×${plan.win.h}${plan.win.x !== null ? ` @ ${plan.win.x},${plan.win.y}` : ''}）`);
  }
  if (plan.reason === 'no-window-browser') {
    log('⚠ 没找到能开独立窗口的浏览器（Microsoft Edge / Google Chrome）—— 已回落成浏览器标签页');
  }
  // ⚠️ 开窗前先关掉"上一只控制台浏览器"（专用 profile 的实例）：Chromium 把新窗口
  //    委派给已在跑的实例时会**吞掉** --window-size/--window-position（2026-10-16 真机
  //    实测复现）。只认我们的专用 profile，绝不碰用户自己的浏览器；关不掉照常开（永不抛）。
  //    ⚠️ 这个计数进启动跟踪（`consoleKilled`）——"位置没记住"的排障第一眼看它是否为 0。
  let killNote = '';
  const consoleKilled = (plan.kind === 'window' && profileDir)
    ? closeStaleConsole(profileDir, {
      platform, exec: execFn, hiddenVbs,
      // "没杀成"与"没东西可杀"必须在跟踪里分得开（0 的歧义 —— 见 closeStaleConsole 注释）
      onNote: (n) => { killNote = n; log(`⚠ 关旧实例：${n}`); },
    })
    : 0;
  if (consoleKilled) log(`ℹ 已关掉上一只控制台窗口的浏览器实例（${consoleKilled} 个进程）—— 新窗口才能按记住的位置开`);
  // 判据本身已经是"控制台无关"的（browser 走 rundll32 这个 GUI 程序，window 走
  // msedge / chrome），所以常规路径就是**直接 spawn**：系统不会为 GUI 程序建控制台，
  // 灰框那类窗口从根上不会出现。
  // ⚠️ 兜底仍然要留：rundll32 万一被策略拦掉，界面就打不开了 —— 那时退回隐藏通道
  //    （`run-hidden.vbs` 的 SW_HIDE + `cmd /c start`），宁可冒一次窗口，也不能打不开。
  const spawnForPlan = () => {
    const child = spawnFn(plan.exec, plan.args, { detached: true, stdio: 'ignore', windowsHide: true });
    if (platform === 'win32' && hiddenVbs && plan.kind === 'browser' && child && typeof child.once === 'function') {
      child.once('error', () => {
        try {
          const q = (s) => (s === '' ? '""' : `"${String(s).replace(/"/g, '\\"')}"`);
          const cmdLine = [q('cmd'), '/c', 'start', q(''), q(url)].join(' ');
          const c2 = spawnFn('wscript', ['//B', '//Nologo', hiddenVbs, cmdLine], {
            detached: true, stdio: 'ignore', windowsHide: true,
          });
          if (c2 && typeof c2.unref === 'function') c2.unref();
        } catch { /* 兜底也没起来：下面那条 error 日志会把原因说清楚 */ }
      });
    }
    return child;
  };
  try {
    const child = spawnForPlan();
    // P7：记下我们开的那只窗口的 pid —— 「结束本次运行」要连窗口一起收，
    // 而收之前必须拿命令行校验它确实是我们开的（见 server.js closeConsoleWindowIfOurs）。
    const openedPid = child && child.pid ? Number(child.pid) : 0;
    if (child && typeof child.unref === 'function') child.unref();
    if (child && typeof child.once === 'function') {
      // 起不来的错误通常是**同步 ENOENT 之后异步派发**的 —— 不接住会变成未捕获异常，
      // 把"打开失败"伪装成"启动器自己崩了"。
      child.once('error', (e) => log(`✗ 打开失败：${e && e.message ? e.message : e}`));
    }
    track({
      opened: true, skipped: false, kind: plan.kind, used: plan.used,
      ...(openedPid ? { openedPid } : {}),
      ...(plan.reason ? { reason: plan.reason } : {}),
      ...(plan.win ? { win: plan.win } : {}),
      ...(plan.kind === 'window' ? { consoleKilled } : {}),
      ...(plan.kind === 'window' && killNote ? { consoleKillNote: killNote } : {}),
    });
    return { opened: true, skipped: false, mode: launch.mode, used: plan.used, kind: plan.kind, url, openedPid };
  } catch (e) {
    const error = e && e.message ? e.message : String(e);
    track({ opened: false, skipped: false, used: plan.used, error });
    return { opened: false, skipped: false, mode: launch.mode, used: plan.used, error, url };
  }
}
