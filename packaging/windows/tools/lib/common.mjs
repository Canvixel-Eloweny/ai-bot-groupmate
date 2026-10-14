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
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// ── 路径 ────────────────────────────────────────────────────────────────────
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const APP = path.join(ROOT, 'app');
export const TOOLS = path.join(ROOT, 'tools');
export const RUNTIME_NODE_DIR = path.join(ROOT, 'runtime', 'node');
export const NODE_EXE = path.join(RUNTIME_NODE_DIR, 'node.exe');
export const NAPCAT_DIR = path.join(APP, 'napcat');
export const NAPCAT_ZIP = path.join(NAPCAT_DIR, 'NapCat.Shell.zip');
export const CONFIG_JSON = path.join(APP, 'config.json');
export const CONFIG_EXAMPLE = path.join(APP, 'config.example.json');
export const SETUP_MARKER = path.join(APP, '.qqbot-portable-setup.json');

export const IS_WIN = process.platform === 'win32';
export const MIN_NODE = '22.13';

// ── 输出 ────────────────────────────────────────────────────────────────────
const C = {
  reset: '\u001b[0m', dim: '\u001b[2m', red: '\u001b[31m', green: '\u001b[32m',
  yellow: '\u001b[33m', cyan: '\u001b[36m', bold: '\u001b[1m',
};
const canColor = () => process.stdout.isTTY || process.env.FORCE_COLOR === '1';
const paint = (c, s) => (canColor() ? `${c}${s}${C.reset}` : s);

export const say = (s = '') => console.log(s);
export const ok = (s) => console.log(`${paint(C.green, '  ✓')} ${s}`);
export const warn = (s) => console.log(`${paint(C.yellow, '  !')} ${s}`);
export const bad = (s) => console.log(`${paint(C.red, '  ✗')} ${s}`);
export const title = (s) => console.log(`\n${paint(C.bold, s)}`);
export const dim = (s) => console.log(paint(C.dim, s));

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

// ── 下载（带镜像回退 / 断点续传 / 进度）──────────────────────────────────────
/**
 * 从候选 URL 依次尝试下载到 dest。
 *
 * ⚠️ 为什么不直接用 `fetch` 一把梭：实测直连 GitHub 只有 ~20KB/s（会挂死），
 *    而镜像 ~130KB/s。**30MB 的包在用户机器上可能更慢**，所以必须
 *    ① 支持多镜像回退；② 打印进度与速率（否则用户以为卡死了）；
 *    ③ 支持 `.part` 断点续传（重跑 SETUP 不从头再来）。
 *
 * @param {string[]} urls  候选 URL，按顺序试
 * @param {string} dest    最终文件路径
 * @returns {Promise<{url:string, bytes:number}>}
 */
export async function downloadWithMirrors(urls, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const part = `${dest}.part`;
  const errors = [];

  for (const url of urls) {
    let offset = exists(part) ? fs.statSync(part).size : 0;
    try {
      const res = await fetch(url, offset > 0 ? { headers: { Range: `bytes=${offset}-` } } : {});
      if (!res.ok) { errors.push(`${url} → HTTP ${res.status}`); offset = 0; continue; }
      if (offset > 0 && res.status !== 206) offset = 0; // 服务端不认 Range：从头来

      const totalHeader = Number(res.headers.get('content-length') || 0);
      const total = offset + totalHeader;
      say(`  下载中… ${url}`);
      if (total > 0) dim(`  共 ${humanSize(total)}（可断点续传：中断后重跑本脚本）`);

      const out = fs.createWriteStream(part, offset > 0 ? { flags: 'a' } : { flags: 'w' });
      let got = offset;
      let lastPrint = 0;
      const t0 = Date.now();
      for await (const chunk of res.body) {
        if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
        got += chunk.length;
        const now = Date.now();
        if (now - lastPrint > 500) {
          lastPrint = now;
          const kbps = ((got - offset) / 1024) / Math.max((now - t0) / 1000, 0.001);
          const pct = total > 0 ? `${((got / total) * 100).toFixed(1)}% ` : '';
          process.stdout.write(`\r  ${pct}${humanSize(got)}${total > 0 ? ` / ${humanSize(total)}` : ''}  ${kbps.toFixed(0)}KB/s   `);
        }
      }
      await new Promise((r) => out.end(r));
      process.stdout.write('\r' + ' '.repeat(72) + '\r');

      if (total > 0 && got < total) { errors.push(`${url} → 不完整（${got}/${total}）`); continue; }
      fs.renameSync(part, dest);
      return { url, bytes: got };
    } catch (e) {
      errors.push(`${url} → ${e && e.message ? e.message : e}`);
    }
  }
  throw new Error(`所有下载源都失败了：\n    - ${errors.join('\n    - ')}`);
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

/** 判断"本文件是不是被直接双击/直接跑的那个"。Windows 与 macOS 都能用。 */
export function isMain(metaUrl) {
  const self = fileURLToPath(metaUrl);
  const argv1 = process.argv[1];
  if (!argv1) return false;
  const norm = (p) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
  return norm(self) === norm(argv1);
}

// ── NapCat 定位（全项目只有这一处知道它长什么样）────────────────────────────
/**
 * 启动器候选，**按优先级排**（数组顺序就是优先级）。
 *
 * ⚠️ 这里踩过一次坑，注释留下：最初只写了一条宽松正则
 *    `/^napcat[\w-]*\.(bat|exe)$/i`，理由是"NapCat 的启动器名改过多次"。
 *    实测（`NapCat.Shell.Windows.OneKey.zip` v4.18.33）才发现它**同时**匹配了
 *    `NapCatInstaller.exe` —— 而那是**安装器**，不是启动器。宽松到一定程度就不再是
 *    "容错"，而是"指错"。
 *    所以改成：① 精确候选 + 优先级；② 明确排除安装器/结束器一类；③ 兜底才用宽泛匹配。
 */
export const NAPCAT_LAUNCHER_CANDIDATES = [
  /^launcher[\w-]*\.bat$/i,     // 官方文档里最常见的一任名字
  /^NapCatWinBootMain\.exe$/i,  // Windows 一键包里的真正入口
  /^napcat\.bat$/i,
  /^napcat[\w.-]*\.bat$/i,      // napcat.quick.bat 之类
];
/** 名字里带这些的**不是**启动器（安装器、结束器、卸载器）。 */
const NOT_LAUNCHER_RE = /(install|uninstall|kill|stop|remove)/i;
export const NAPCAT_LAUNCHER_RE = NAPCAT_LAUNCHER_CANDIDATES[0]; // 保留导出：只用于"像不像"的粗判

export function findNapcatLauncher() {
  if (!exists(NAPCAT_DIR)) return null;
  const files = findAll(NAPCAT_DIR, (name) => /\.(bat|exe|cmd)$/i.test(name), { maxDepth: 3 })
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
  const home = flattenSingleDir(NAPCAT_DIR);
  const local = files.filter((p) => path.dirname(p) === home || path.dirname(path.dirname(p)) === home);
  return local[0] || files[0] || null;
}

/** NapCat 的"家" = 启动器所在目录。解压后可能多套一层目录，所以必须动态求。 */
export function napcatHome() {
  const l = findNapcatLauncher();
  return l ? path.dirname(l) : exists(NAPCAT_DIR) ? NAPCAT_DIR : null;
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
  if (!exists(dir)) return [];
  const out = [];
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  for (const n of names) {
    const m = /^napcat(?:_protocol)?_(\d{5,12})\.json$/i.exec(n);
    if (!m) continue;
    let st;
    try { st = fs.statSync(path.join(dir, n)); } catch { continue; }
    const hit = out.find((x) => x.qq === m[1]);
    if (hit) hit.mtime = Math.max(hit.mtime, st.mtimeMs);
    else out.push({ qq: m[1], mtime: st.mtimeMs });
  }
  return out.sort((a, b) => b.mtime - a.mtime);
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
  const last = knownAccountsByMtime()[0];
  if (last) return { qq: last.qq, from: 'NapCat 上次登录的账号' };
  return { qq: '', from: '' };
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
