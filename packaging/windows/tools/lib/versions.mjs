/**
 * 版本探测与校验 —— 一键安装「② 版本校验」那一环的**唯一实现**。
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  为什么单独一层（而不是塞进 check-env.mjs）
 * ══════════════════════════════════════════════════════════════════════════
 *  `check-env.mjs` 是**只读自检**：它回答"现在能不能跑"，且**刻意不给版本号**
 *  （它只说"Node 22.13 以下不合格"，不关心最新是几）。
 *  而"自动修复"必须知道**两件事**：装的是几、最新是几 —— 它要拿这两个数去决定
 *  "要不要下、下哪个"。
 *
 *  两者混在一起的后果很具体：自检每被 `2-START.bat` 调一次就多一次网络请求，
 *  而**离线用户会因此卡住**（`fetch` 的超时在弱网下能到几十秒）。
 *  ⇒ 所以：自检不问网络；**只有一键安装才问**，且问失败一律降级为"沿用已装版本"。
 *
 *  ⚠️ 与 `check-env.mjs` 的**最低要求同源**：`MIN_NODE` 只在 `lib/common.mjs` 定义一次，
 *     本文件 import 它，不再写第二份（写两份必然漂移，这是本项目反复踩的坑）。
 *
 *  ⚠️ **网络探测一律可失败**：最新版查不到不是错误。查不到就回 `latest: null`，
 *     调用方据此"不更新"。绝不能因为 GitHub 连不上就让安装整个失败 ——
 *     离线用户手里那份包本来就是能跑的。
 */

import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  NODE_EXE, NAPCAT_DIR, IS_WIN, MIN_NODE, exists, readJson, writeJson,
  findQQExe, napcatHome, run,
} from './common.mjs';

/** 网络探测的兜底超时。宁可"查不到"，也不要让安装卡在一台断网的机器上。 */
const NET_TIMEOUT_MS = 8000;

/** `fetch` 带超时（Node 的 fetch 默认没有总超时，弱网下能挂到系统默认几分钟）。 */
async function fetchJson(url, ms = NET_TIMEOUT_MS) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetch(url, {
      signal: ctl.signal,
      headers: { 'user-agent': 'estrella-bot-onekey', accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchText(url, ms = NET_TIMEOUT_MS) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctl.signal, headers: { 'user-agent': 'estrella-bot-onekey' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

// ── 版本号比较 ──────────────────────────────────────────────────────────────
/**
 * 只处理 `x[.y[.z]]`（前面可带 `v`，后面可带 `-tag`）。够用，且**不去引 semver**
 * —— 包内除 `ws` 外零依赖，为"比个版本号"多背一个包不值得。
 *
 * ⚠️ `-tag` 一律**降权**（`4.18.33-beta` < `4.18.33`）。NapCat 的 Release 里
 *    预发布是常态，把它判成"比正式版新"会让自动更新去装一个 beta。
 */
export function parseVer(s) {
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-(.+))?$/.exec(String(s || '').trim());
  if (!m) return null;
  return {
    n: [Number(m[1]), Number(m[2] || 0), Number(m[3] || 0)],
    pre: m[4] ? 1 : 0,
    raw: String(s).trim(),
  };
}

/** a >= b 返回 true；任一侧解析不出来返回 false（"认不出"不等于"够新"）。 */
export function gte(a, b) {
  const x = parseVer(a);
  const y = parseVer(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i += 1) {
    if (x.n[i] !== y.n[i]) return x.n[i] > y.n[i];
  }
  return x.pre <= y.pre;
}

/** 人类可读的比较结果词。 */
export function verState(installed, required) {
  if (!installed) return 'missing';
  return gte(installed, required) ? 'ok' : 'outdated';
}

// ── ① Node ──────────────────────────────────────────────────────────────────
/**
 * 本包**自带**运行时，所以"装没装"问的是包内那份 `runtime\node\node.exe`。
 *
 * ⚠️ macOS 上（构建机 / 我们自己做校验时）那个 `.exe` 跑不起来 ——
 *    这时回落到**当前进程**的版本，并标 `probed: false`。
 *    标出来是必须的：否则"构建机上看着是 22.x"会被误当成"包里那份也是 22.x"。
 */
export function nodeInstalled() {
  let version = '';
  let probed = false;
  if (IS_WIN && exists(NODE_EXE)) {
    const r = spawnSync(NODE_EXE, ['-v'], { windowsHide: true, encoding: 'utf8' });
    if (!r.error && r.status === 0) { version = String(r.stdout || '').trim(); probed = true; }
  }
  if (!version) version = process.versions.node;
  return { found: exists(NODE_EXE), version: version.replace(/^v/, ''), probed, need: MIN_NODE };
}

/**
 * 最新的 Node **LTS** 版本号（不含 v）。查不到回 null —— 调用方据此跳过更新。
 *
 * 用 `nodejs.org/dist/index.json`：它是官方的、无需鉴权的完整版本索引。
 * ⚠️ 它有 2MB+ 且是**倒序**的，取第一个 `lts` 真值项即可（不用全扫）。
 */
export async function latestNodeLts() {
  try {
    const list = await fetchJson('https://nodejs.org/dist/index.json', 12000);
    if (!Array.isArray(list)) return null;
    const hit = list.find((x) => x && x.lts && typeof x.version === 'string');
    return hit ? hit.version.replace(/^v/, '') : null;
  } catch {
    return null;
  }
}

/** 官方 SHASUMS 里这个 win-x64 zip 的哈希。用于对下载件做真值校验。 */
export async function nodeZipSha(version) {
  try {
    const txt = await fetchText(`https://nodejs.org/dist/v${version}/SHASUMS256.txt`, 12000);
    const name = `node-v${version}-win-x64.zip`;
    for (const line of txt.split('\n')) {
      const m = /^([0-9a-f]{64})\s+\*?(.+)$/.exec(line.trim());
      if (m && m[2] === name) return m[1];
    }
    return null;
  } catch {
    return null;
  }
}

// ── ② NapCat ────────────────────────────────────────────────────────────────
/**
 * NapCat 的**已装版本**。
 *
 * ⚠️ 主来源是**我们自己写的安装记录** `app/napcat/INSTALLED.json`，不是去猜官方包的
 *    版本号字段。理由：官方那份的文件名/结构每个版本都在变（这正是 `common.mjs` 里
 *    `NAPCAT_LAUNCHER_CANDIDATES` 为什么是一张候选表），而"装的是哪一版"是我们
 *    **自己下载时就知道**的事实 —— 拿事实，不去猜。
 *    记录不存在时（用户手工放进去的 NapCat）回落到读官方 `package.json`，
 *    再读不到就是 `unknown`（判为"已装但版本不明"，**不算过旧**，避免误触发重装）。
 */
export function napcatInstalled() {
  const rec = readJson(path.join(NAPCAT_DIR, 'INSTALLED.json'));
  const home = napcatHome();
  const pkgVer = home ? readJson(path.join(home, 'package.json'))?.version : null;
  const version = rec?.tag?.replace(/^v/, '') || pkgVer || '';
  return {
    found: Boolean(home),
    version,
    tag: rec?.tag || '',
    installedAt: rec?.installedAt || '',
    home: home ? path.relative(NAPCAT_DIR, home) : '',
    inferredFrom: rec?.tag ? 'record' : pkgVer ? 'package.json' : '',
  };
}

/** 记录一次安装（幂等）。写不进去只警告 —— 它只是"下次要知道装的是哪一版"。 */
export function writeNapcatRecord(info) {
  try {
    writeJson(path.join(NAPCAT_DIR, 'INSTALLED.json'), {
      ...(readJson(path.join(NAPCAT_DIR, 'INSTALLED.json')) || {}),
      ...info,
      installedAt: new Date().toISOString(),
    });
  } catch { /* 记录写不进去：下次会被判成"版本不明"，不会装错 */ }
}

/** 最新的 NapCat Release tag。查不到回 null。 */
export async function latestNapcatTag(src) {
  try {
    const j = await fetchJson(src.api);
    if (j && typeof j.tag_name === 'string' && j.tag_name) return j.tag_name;
    return null;
  } catch {
    return null;
  }
}

// ── ③ QQ ────────────────────────────────────────────────────────────────────
/**
 * QQ NT 的装况与版本。位置沿用 `findQQExe()`（与 NapCat 启动器**同源**的注册表项），
 * 版本号从**同一条卸载项**的 `DisplayVersion` 读 ——
 *
 * ⚠️ 为什么要特地读版本号：NapCat 注入的是 QQ 的**进程**，QQ 大版本升级后
 *    `QQNT.dll` 的导出会变，旧版 NapCat 挂上去就是启动即崩。
 *    "装了"和"能挂"是两件事，所以这里把版本号带上，让用户能一眼看出
 *    "QQ 刚自动更新过，而 NapCat 还没跟上"。
 */
export async function qqInstalled() {
  const where = await findQQExe();
  if (!where.found) return { found: false, version: '', path: '' };
  if (!IS_WIN) return { found: true, version: '', path: where.where || '' };

  let version = '';
  for (const key of [
    'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\QQ',
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\QQ',
  ]) {
    // eslint-disable-next-line no-await-in-loop
    const r = await run('reg', ['query', key, '/v', 'DisplayVersion']).catch(() => null);
    if (!r || r.code !== 0) continue;
    const m = /DisplayVersion\s+REG_SZ\s+(\S+)/i.exec(r.out);
    if (m) { version = m[1]; break; }
  }
  return { found: true, version, path: where.where || '' };
}

// ── 汇总 ────────────────────────────────────────────────────────────────────
/**
 * 一次拿齐三件的「装况 + 版本 + 最新」。
 *
 * 网络那半（latest*）**并发**跑且**允许全失败**：失败时 `latest` 为 null，
 * 校验结论退化为"只判已装版本是否够最低要求" —— 这正好是离线用户想要的行为。
 *
 * @returns {Promise<{items:Array, offline:boolean}>}
 */
export async function collectVersions(napcatSource) {
  const [node, qq, nodeLatest, napLatest] = await Promise.all([
    Promise.resolve(nodeInstalled()),
    qqInstalled(),
    latestNodeLts(),
    latestNapcatTag(napcatSource),
  ]);
  const nap = napcatInstalled();

  const items = [
    {
      id: 'node', name: '运行环境 Node',
      installed: node.version, need: node.probed ? MIN_NODE : '',
      latest: nodeLatest || '', state: verState(node.version, MIN_NODE),
      path: node.found ? 'runtime\\node\\node.exe（包内自带）' : '',
      note: node.probed ? '' : '当前平台跑不了 .exe，版本号取自本进程（仅供构建机自检参考）',
      fixable: true,
    },
    {
      id: 'napcat', name: 'QQ 协议端 NapCat',
      installed: nap.version, need: '',
      latest: (napLatest || '').replace(/^v/, ''), state: nap.found ? 'ok' : 'missing',
      path: nap.home || '',
      note: nap.found && !nap.version ? '版本不明（不是本包装的）—— 不会自动替换' : '',
      fixable: true,
      outdated: Boolean(nap.version && napLatest && !gte(nap.version, String(napLatest).replace(/^v/, ''))),
    },
    {
      id: 'qq', name: 'QQ 客户端（NT 版）',
      installed: qq.version, need: '', latest: '', state: qq.found ? 'ok' : 'missing',
      path: qq.path || '',
      note: '',
      fixable: false, // QQ 是腾讯的客户端，我们只能引导去装，不该也不许静默替用户装
    },
  ];

  const offline = !nodeLatest && !napLatest;
  return { items, offline };
}
