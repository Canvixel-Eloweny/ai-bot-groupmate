/**
 * 安装版布局的纯判据（P2 · 2026-10-18）。
 *
 * 这个叶子**只 import node: 内置**，因为安装器会在 stage 里用它，而 stage 的
 * `src/user-root.js` 还不是最终安装根 —— 不能依赖 `common.mjs` 的根解析。
 *
 * 它回答四类问题，而且每类只在这里回答一次：
 *   ① 路径是否包含（userRoot / installRoot 双向校验）；
 *   ② install.json / current.json 的形状与版本目录是否合法；
 *   ③ 一条 Windows 命令行是不是**本安装根**的面板/机器人进程；
 *   ④ payload manifest 的文件/哈希/白名单校验。
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const WIN_ABS_RE = /^(?:[A-Za-z]:[\\/]|\\\\)/;
const HEALTH = new Set(['pending', 'ok', 'failed']);

/** nsExec 把子进程 stdout 喂进 instfiles 详情框，而详情框按系统码页解码字节：
 * UTF-8 中文（以及 ✓/✗ 记号）在中文 Windows 上就是乱码（P9 群友截图）。
 * 安装器环境下（.nsi 的 .onInit 设 ESTRELLA_NSIS=1）一律输出 ASCII：
 * 英文措辞 + 其余非 ASCII 替换成 '?'（例如路径里的中文用户名）。手动跑仍走完整 UTF-8。
 * 放在这个纯叶子：bootstrap 必须在 import common.mjs 之前设环境，不能从 common 拿它。 */
export const installerMode = () => process.env.ESTRELLA_NSIS === '1';
export const installerAscii = (s) => (installerMode() ? String(s).replace(/[^\x00-\x7F]+/g, '?') : String(s));

/** 路径里出现这些（按相对路径段）就拒绝进入安装 payload。 */
export const DEFAULT_ALLOWED = [
  /^(app|runtime|tools|launcher|resources)(\/|$)/,
  /^(README\.html|LICENSE|THIRD-PARTY-NOTICES\.md|BUILD-INFO\.txt)$/,
];

export const DEFAULT_FORBIDDEN = [
  // 只禁“安装根/app 根”的用户数据与构建素材；runtime 里 npm 自带的 docs 不算用户文档。
  /^(?:app\/)?(?:config\.json|userdata|data|plugins|skills|persona|napcat|test|docs|packaging|diag-out)(?:\/|$)/,
  /^(?:app\/)?\.git(?:\/|$)/,
  /(^|\/)\.env$/,
  /(^|\/)VM-ONLY\.txt$/,
  /^app\/panel\/(\.token|\.bridge\.pid|\.bridge\.lock|\.bridge-cmd\.json|effective\.json|\.thinking\.json|config-history\.jsonl|session-archive\.json|audit\.jsonl|local-trace\.jsonl|usage[^/]*\.jsonl|prompt-stats\.json|style-profile\.json|forward-probe\.jsonl|auto-memory\.jsonl|memory-records\.json|window-state\.json|model-sync\.json|launch-log\.jsonl|console-profile(?:\/|$)|[^/]*\.log)$/,
  /^(?:app\/)?(?:diag-out|\.update-tmp)(?:\/|$)/,
  /(^|\/)[^/]*\.part$/,
];

function isWinPath(p) {
  return WIN_ABS_RE.test(String(p ?? ''));
}

/**
 * 本文件是不是被 `node <file>` 直接跑的入口。
 * 用 realpath 两边归一：macOS 的 /var 是 /private/var 的软链，临时目录一拍就错。
 */
export function isMainModule(metaUrl) {
  const arg = process.argv[1];
  if (!arg) return false;
  const norm = (p) => {
    try { return fs.realpathSync(p); } catch { return path.resolve(p); }
  };
  try {
    return norm(fileURLToPath(metaUrl)) === norm(arg);
  } catch {
    return false;
  }
}

/** 去掉 BOM 后读 JSON；读不出来就抛，交给调用方决定是否降级。 */
export function readJsonFile(file) {
  const text = fs.readFileSync(file, 'utf8');
  return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
}

/**
 * 原子写 JSON：临时文件 + fsync + rename。
 * Windows 的 rename 会覆盖已存在目标；失败时不留半份（临时文件由调用方清理）。
 */
export function writeJsonAtomic(file, obj, { fsApi = fs } = {}) {
  fsApi.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  const text = `${JSON.stringify(obj, null, 2)}\n`;
  let fd;
  try {
    fd = fsApi.openSync(tmp, 'w', 0o600);
    fsApi.writeSync(fd, text);
    try { fsApi.fsyncSync(fd); } catch { /* 某些文件系统不支持 fsync */ }
    fsApi.closeSync(fd);
    fd = undefined;
    fsApi.renameSync(tmp, file);
  } catch (e) {
    if (fd !== undefined) { try { fsApi.closeSync(fd); } catch { /* 已关 */ } }
    try { fsApi.rmSync(tmp, { force: true }); } catch { /* 临时文件删不掉也不遮蔽原错误 */ }
    throw e;
  }
}

/** 分块算 SHA-256，避免 100MB 级 payload 整份读进内存。 */
export function sha256FileSync(file) {
  const h = createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.allocUnsafe(1 << 20);
  try {
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (!n) break;
      h.update(buf.subarray(0, n));
    }
  } finally {
    try { fs.closeSync(fd); } catch { /* 已关 */ }
  }
  return h.digest('hex');
}

/** 读程序根的 package.json，并校验 appId / version 都是非空字符串。 */
export function readPackageInfo(programRoot) {
  const pkg = readJsonFile(path.join(programRoot, 'package.json'));
  if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) throw new Error(`package.json 形状不对：${programRoot}`);
  if (typeof pkg.version !== 'string' || !pkg.version.trim()) throw new Error(`package.json 缺 version：${programRoot}`);
  if (typeof pkg.appId !== 'string' || !pkg.appId.trim()) throw new Error(`package.json 缺 appId：${programRoot}`);
  return { version: pkg.version.trim(), appId: pkg.appId.trim(), raw: pkg };
}

/** 读 install.json；不存在返回 null。 */
export function readInstallInfo(installRoot) {
  try {
    return readJsonFile(path.join(installRoot, 'install.json'));
  } catch (e) {
    if (e && e.code === 'ENOENT') return null;
    throw new Error(`install.json 读不出来（${path.join(installRoot, 'install.json')}）：${e.message}`);
  }
}

/** 读 current.json；不存在返回 null。 */
export function readCurrentInfo(installRoot) {
  try {
    return readJsonFile(path.join(installRoot, 'current.json'));
  } catch (e) {
    if (e && e.code === 'ENOENT') return null;
    throw new Error(`current.json 读不出来（${path.join(installRoot, 'current.json')}）：${e.message}`);
  }
}

/** 版本目录里的程序根。 */
export function programRootOf(installRoot, version) {
  return path.join(installRoot, 'versions', String(version), 'app');
}

/**
 * 双向路径包含：child 是否在 parent 内（相等不算）。
 * Windows 大小写不敏感；盘根 / UNC 也能正确比较。
 */
export function pathInside(child, parent, { platform = process.platform } = {}) {
  const p = platform === 'win32' || isWinPath(child) || isWinPath(parent) ? path.win32 : path;
  const a = p.resolve(String(child));
  const b = p.resolve(String(parent));
  const fold = (s) => (p === path.win32 ? s.toLowerCase() : s);
  const fa = fold(a);
  const fb = fold(b);
  if (fa === fb) return false;
  const rel = p.relative(fb, fa);
  return Boolean(rel) && !rel.startsWith('..') && !p.isAbsolute(rel);
}

/**
 * userRoot / installRoot 的双向校验。
 * 这里只做**形状**判断；真实可写性由 `assertWritableDir` 在提交前验证。
 * @returns {{ok:true}|{ok:false, error:string}}
 */
export function assertUserRootOutsideInstallRoot({ installRoot, userRoot, platform = process.platform, env = process.env } = {}) {
  const miss = (m) => ({ ok: false, error: m });
  if (!installRoot || !userRoot) return miss('installRoot / userRoot 都必须给出');
  const p = platform === 'win32' ? path.win32 : path;
  const inst = p.resolve(String(installRoot));
  const user = p.resolve(String(userRoot));
  if (inst === p.parse(inst).root) return miss(`安装根不能是盘根：${inst}`);
  if (user === p.parse(user).root) return miss(`用户数据根不能是盘根：${user}`);
  if (pathInside(user, inst, { platform })) return miss('用户数据根不能位于安装根内部');
  if (pathInside(inst, user, { platform })) return miss('安装根不能位于用户数据根内部');
  if (platform === 'win32' || isWinPath(inst) || isWinPath(user)) {
    if (/^\\\\/.test(inst) || /^\\\\/.test(user)) return miss('不支持 UNC（网络共享）路径');
    const profile = String(env.USERPROFILE || '').trim();
    const windir = String(env.WINDIR || env.SystemRoot || '').trim();
    if (profile && (pathEq(user, profile, 'win32') || pathEq(inst, profile, 'win32'))) {
      return miss('安装根/用户数据根不能直接是用户主目录');
    }
    if (windir && (pathInside(user, windir, { platform: 'win32' }) || pathInside(inst, windir, { platform: 'win32' }))) {
      return miss('安装根/用户数据根不能位于 Windows 目录内');
    }
  }
  if (inst.length > 200 || user.length > 200) return miss('安装根/用户数据根路径过长（>200）');
  return { ok: true };
}

/**
 * 语义化版本比较（只支持 x.y.z[-tag]，与项目其它版本判据同口径）。
 * @returns {number} a<b 返回 -1，相等 0，a>b 返回 1；任一侧解析不出来返回 null。
 */
export function compareVersions(a, b) {
  const parse = (s) => {
    const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-(.+))?$/.exec(String(s || '').trim());
    if (!m) return null;
    return { n: [Number(m[1]), Number(m[2] || 0), Number(m[3] || 0)], pre: m[4] ? 1 : 0 };
  };
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i += 1) {
    if (x.n[i] !== y.n[i]) return x.n[i] < y.n[i] ? -1 : 1;
  }
  if (x.pre !== y.pre) return x.pre > y.pre ? -1 : 1; // 预发布 < 正式版
  return 0;
}

/** 两条路径是否同一个位置（Windows 大小写不敏感）。 */
export function pathEq(a, b, platform = process.platform) {
  const p = platform === 'win32' || isWinPath(a) || isWinPath(b) ? path.win32 : path;
  const fold = (s) => (p === path.win32 ? s.toLowerCase() : s);
  return fold(p.resolve(String(a))) === fold(p.resolve(String(b)));
}

/** 目标目录可写（会建目录并写删一个临时文件）。 */
export function assertWritableDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const probe = path.join(dir, `.estrellabot-write-${process.pid}-${Date.now()}`);
  try {
    fs.writeFileSync(probe, 'ok', 'utf8');
  } finally {
    try { fs.rmSync(probe, { force: true }); } catch { /* 删不掉不影响判定 */ }
  }
}

/**
 * current.json 的形状与版本目录校验。
 * @returns {{ok:true, programRoot:string, version:string}|{ok:false, error:string}}
 */
export function validateCurrent({ installRoot, current, expectedAppId, exists = fs.existsSync } = {}) {
  const bad = (m) => ({ ok: false, error: m });
  if (!current || typeof current !== 'object' || Array.isArray(current)) return bad('current.json 形状不对');
  if (current.schema !== 1) return bad(`current.json.schema=${current.schema}（只支持 1）`);
  if (typeof current.current !== 'string' || !current.current.trim()) return bad('current.json.current 为空');
  if (current.previous !== null && current.previous !== undefined && typeof current.previous !== 'string') {
    return bad('current.json.previous 形状不对');
  }
  if (current.health !== undefined && !HEALTH.has(current.health)) return bad(`current.json.health=${current.health} 不合法`);
  const programRoot = programRootOf(installRoot, current.current);
  if (!exists(path.join(programRoot, 'package.json'))) return bad(`版本目录不存在或缺少 package.json：${programRoot}`);
  let info;
  try {
    info = readPackageInfo(programRoot);
  } catch (e) {
    return bad(e.message);
  }
  if (info.version !== current.current) return bad(`current=${current.current} 但 package.json.version=${info.version}`);
  if (expectedAppId && info.appId !== expectedAppId) return bad(`appId 不一致：${info.appId} ≠ ${expectedAppId}`);
  return { ok: true, programRoot, version: info.version, appId: info.appId };
}

/**
 * 取“能启动的程序根”：current 合法就用它；否则回退 previous。
 * @returns {{ok:true, programRoot, version, appId, fallback:boolean, current:object}|{ok:false, error:string}}
 */
export function effectiveProgram({ installRoot, current, expectedAppId, exists = fs.existsSync } = {}) {
  const cur = validateCurrent({ installRoot, current, expectedAppId, exists });
  if (cur.ok) return { ...cur, fallback: false, current };
  const prevVer = current && typeof current.previous === 'string' ? current.previous : '';
  if (prevVer) {
    const prev = validateCurrent({
      installRoot,
      current: { schema: 1, current: prevVer, previous: null, health: 'pending' },
      expectedAppId,
      exists,
    });
    if (prev.ok) return { ...prev, fallback: true, current };
  }
  return { ok: false, error: cur.error };
}

/**
 * 一条进程是不是本安装根的面板/机器人。
 * 只认：node 可执行 + 命令行里出现**精确**的 `<installRoot>\versions\<ver>\app\...`
 * 入口 token；不按子串匹配，因此 `Estrella-Bot2` 不会误杀。
 */
export function classifyProcess({ cmd, execPath = '', installRoot, versions = [], platform = 'win32' } = {}) {
  if (!installRoot) return { ours: false, reason: 'no-install-root' };
  const win = platform === 'win32' || isWinPath(installRoot);
  const p = win ? path.win32 : path;
  const toks = (String(cmd || '').match(/"[^"]*"|\S+/g) || []).map((s) => s.replace(/^"|"$/g, ''));
  const bin = String(execPath || toks[0] || '').trim();
  const binName = bin.split(/[\\/]/).filter(Boolean).pop() || '';
  const versionsToTry = (Array.isArray(versions) ? versions : [versions]).filter(Boolean).map(String);
  if (!versionsToTry.length) return { ours: false, reason: 'no-version' };
  // Electron 壳：只认本安装根 versions/<ver>/app/electron/electron.exe 的主进程。
  // 渲染/GPU/Utility 子进程带 --type=，留给主进程的 /T 树杀，单独不认。
  if (/^electron(?:\.exe)?$/i.test(binName)) {
    if (toks.some((t) => /^--type=/.test(t))) return { ours: false, reason: 'electron-child' };
    for (const ver of versionsToTry) {
      const appDir = p.join(String(installRoot), 'versions', ver, 'app', 'electron');
      const wantExe = p.join(appDir, win ? 'electron.exe' : 'electron');
      if (!pathEq(bin, wantExe, win ? 'win32' : 'posix')) continue;
      if (toks.some((t) => pathEq(t, appDir, win ? 'win32' : 'posix'))) {
        return { ours: true, reason: 'ok', version: ver, kind: 'shell' };
      }
    }
    return { ours: false, reason: 'electron-entry-not-ours' };
  }
  if (!/^node(js)?(?:\.exe)?$/i.test(binName)) return { ours: false, reason: 'exec-not-node' };
  const expectedNode = p.join(String(installRoot), 'runtime', 'node', win ? 'node.exe' : 'node');
  if (bin && !pathEq(bin, expectedNode, win ? 'win32' : 'posix')) return { ours: false, reason: 'node-elsewhere' };
  for (const raw of toks) {
    const t = raw.replace(/^"|"$/g, '');
    if (!t) continue;
    for (const ver of versionsToTry) {
      for (const entry of ['panel/server.js', 'src/index.js']) {
        const want = p.join(String(installRoot), 'versions', ver, 'app', ...entry.split('/'));
        if (pathEq(t, want, win ? 'win32' : 'posix')) {
          return { ours: true, reason: 'ok', version: ver, kind: entry.startsWith('panel') ? 'panel' : 'bridge' };
        }
      }
    }
  }
  return { ours: false, reason: 'entry-not-ours' };
}

/** 旧便携数据源：接受旧包根 / userdata / app 三种位置。 */
export function resolveImportSource(dir) {
  const root = path.resolve(String(dir));
  const has = (p) => { try { return fs.existsSync(p); } catch { return false; } };
  if (has(path.join(root, 'userdata', 'config.json')) || has(path.join(root, 'userdata', 'panel'))) {
    return { source: path.join(root, 'userdata'), layout: 'userdata' };
  }
  if (has(path.join(root, 'app', 'config.json')) || has(path.join(root, 'app', 'panel'))) {
    return { source: path.join(root, 'app'), layout: 'app' };
  }
  return { source: root, layout: 'root' };
}

/**
 * 校验 stage/payload-manifest.json 与 stage 内实际文件。
 * 任何一项不符都返回 errors；调用方据此拒绝安装。
 */
export function verifyPayloadManifest(stage, {
  forbidden = DEFAULT_FORBIDDEN, allowed = DEFAULT_ALLOWED, expectedVersion, expectedAppId,
} = {}) {
  const errors = [];
  const manifestFile = path.join(stage, 'payload-manifest.json');
  let manifest;
  try {
    manifest = readJsonFile(manifestFile);
  } catch (e) {
    return { ok: false, errors: [`payload-manifest.json 读不出来：${e.message}`], count: 0 };
  }
  if (!manifest || manifest.schema !== 1) errors.push('payload-manifest.schema 必须为 1');
  if (expectedVersion && manifest.version !== expectedVersion) errors.push(`manifest.version=${manifest.version} ≠ ${expectedVersion}`);
  if (expectedAppId && manifest.appId !== expectedAppId) errors.push(`manifest.appId=${manifest.appId} ≠ ${expectedAppId}`);
  if (!Array.isArray(manifest.files)) {
    return { ok: false, errors: [...errors, 'manifest.files 必须是数组'], count: 0 };
  }
  if (manifest.count !== manifest.files.length) errors.push(`manifest.count=${manifest.count} ≠ files.length=${manifest.files.length}`);
  const seen = new Set();
  for (const item of manifest.files) {
    const rel = String(item && item.path ? item.path : '').replace(/\\/g, '/');
    if (!rel || rel.startsWith('/') || rel.split('/').includes('..') || /^[A-Za-z]:/.test(rel)) {
      errors.push(`非法相对路径：${JSON.stringify(item && item.path)}`);
      continue;
    }
    if (seen.has(rel)) errors.push(`重复条目：${rel}`);
    seen.add(rel);
    if (!allowed.some((re) => re.test(rel))) errors.push(`不在 payload 白名单：${rel}`);
    if (forbidden.some((re) => re.test(rel))) errors.push(`白名单外路径：${rel}`);
    const full = path.resolve(stage, rel);
    const relCheck = path.relative(path.resolve(stage), full);
    if (relCheck.startsWith('..') || path.isAbsolute(relCheck)) { errors.push(`越出 stage：${rel}`); continue; }
    let st;
    try { st = fs.statSync(full); } catch { errors.push(`文件不存在：${rel}`); continue; }
    if (!st.isFile()) { errors.push(`不是文件：${rel}`); continue; }
    if (Number(item.size) !== st.size) errors.push(`大小不符：${rel}（manifest ${item.size} / 实际 ${st.size}）`);
    if (!/^[0-9a-f]{64}$/i.test(String(item.sha256 || ''))) { errors.push(`sha256 形状不对：${rel}`); continue; }
    const got = sha256FileSync(full);
    if (got !== String(item.sha256).toLowerCase()) errors.push(`哈希不符：${rel}`);
  }
  return {
    ok: errors.length === 0,
    errors,
    count: manifest.files.length,
    version: manifest.version,
    appId: manifest.appId,
  };
}
