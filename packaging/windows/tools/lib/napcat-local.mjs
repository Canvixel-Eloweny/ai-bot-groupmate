/**
 * 离线放包（P6 · 2026-10-18）—— 把**用户自己已经弄到手**的 NapCat 放到该在的位置。
 *
 * 为什么这一份文件必须存在：NapCat 的许可（Limited Redistribution License §2 要求
 * 随附许可全文与出处、§3 非商业）决定它**不能进我们的安装包**，而大陆网络现下
 * 一份 35,884,742 B 的官方包实测 2.6–12.7 分钟，两个镜像差 5 倍（见 INSTALLER-SPEC.md §21 的探针原文）。所以"我已经有包了"
 * 必须是**一等路径**，不是兜底复选框。
 *
 * 三条纪律（写下来是因为每一条都有人会用"更短"的写法破掉）：
 *  ① **只复制，绝不动原件**：不 rename、不 rm、不 truncate 用户选中的那份文件/目录。
 *     装完打印原件路径，删不删由用户自己决定 —— 把可逆动作变成不可逆，本工具没有这个权限。
 *  ② **先验形状再提交**：解到 `.new-<时间戳>` 暂存目录、确认里面有启动器，才往
 *     `NAPCAT_DIR` 落。失败就把暂存删掉，`NAPCAT_DIR` 一个字节都不动。
 *  ③ **认得的哈希才写 tag**：`tag` 是"日后敢不敢自动覆盖它"的判据（见 versions.mjs
 *     的 napcatInstalled 与 repair.mjs 的"不是本包装的不自动替换"守卫）。
 *     按 knownGood 命中 ⇒ 写 tag；没命中 ⇒ `tag` 留空 + `verification:'unverified-*'`，
 *     于是这份包**永远不会被后续自动升级悄悄换掉**。
 *
 * ⚠️ 这里**一次网络都不碰**：mode 为 zip/folder 时调用方（bootstrap.mjs）不得先问
 *    GitHub API —— 由 §114 用"下标顺序"钉住（本地分支必须出现在任何
 *    latestNapcatRelease( / ensureNapcat( 之前）。
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  NAPCAT_DIR, humanSize, exists, sha256File, unzip, flattenSingleDir,
  findNapcatLauncher, napcatHome, overlay, diag, loadNapcatSource,
  say, ok, warn, dim,
} from './common.mjs';
import { writeNapcatRecord, napcatInstalled, verifyNapcatZip } from './versions.mjs';
import { pathEq, pathInside } from './install-layout.mjs';

/**
 * 状态令牌：写进 `USER_ROOT/update/napcat-status.txt` 第一行，安装器据此决定要不要弹一句。
 *
 * ⚠️ 这是**唯一一份**令牌清单：bootstrap 也 import 这里（不再写字面量），
 *    `check-wb` §114 会把这里的键与 `Estrella-Bot.nsi` 的分支逐一对照 ——
 *    少一个分支 = 那个失败在安装器里**完全静默**（2026-10-19 群友真机就是 FAILED 静默）。
 *    新增令牌必须同时在 .nsi 里给它一个分支（或显式列进静默集合）。
 */
export const NAPCAT_STATUS = {
  OK: 'OK', MISMATCH: 'MISMATCH', UNVERIFIED: 'UNVERIFIED', REFUSED: 'REFUSED',
  FAILED: 'FAILED', SLOW: 'SLOW', SKIPPED: 'SKIPPED',
};

/**
 * 失败原因的**ASCII 一句话**（写进状态文件第三行，安装器的详情/弹窗直接显示）。
 * ⚠️ 必须全 ASCII：nsExec 按系统码页解码子进程字节，中文在英文 Windows 上就是乱码，
 *    而 `installerAscii` 会把它们变成 `?`。原因码与文案分离，纯判据只认码。
 */
export const NAPCAT_REASON = {
  'source-unsafe': 'The picked path was refused (it is a parent folder or one of our own folders).',
  'folder-no-launcher': 'That folder has no NapCat launcher (launcher-user.bat / NapCatWinBootMain.exe) in it.',
  'occupied-foreign': 'Another NapCat copy is already there and it was not installed by this installer.',
  'zip-too-small': 'That file is too small to be NapCat.Shell.zip.',
  'zip-no-launcher': 'The zip did not contain a NapCat launcher after unzipping.',
  'unzip-failed': 'Unzipping the package failed.',
  'placement-failed': 'Placing the package failed before anything was committed.',
  'download-budget': 'The download time budget was used up before the file arrived.',
  'download-slow': 'The download was too slow and was stopped by the time budget.',
  'download-failed': 'No download source could be reached.',
};

/** 原因码 → ASCII 文案。未知码原样返回（便于排查，不吞掉信息）。 */
export function napcatReasonText(code) {
  const k = String(code || '').trim();
  if (!k) return '';
  return NAPCAT_REASON[k] || k;
}

/** knownGood 清单的归一化读取（真值住在 tools/napcat.json，这里只做形状过滤）。 */
export function napcatKnownDigests(src = loadNapcatSource()) {
  const rows = Array.isArray(src?.knownGood) ? src.knownGood : [];
  return rows
    .filter((r) => /^[0-9a-f]{64}$/i.test(String(r?.sha256 || '')))
    .map((r) => ({
      tag: String(r.tag || ''), sha256: String(r.sha256).toLowerCase(),
      size: Number.isInteger(r.size) ? r.size : 0, provenance: String(r.provenance || ''),
    }));
}

/**
 * **按哈希反查**条目 —— 用户带来的东西只能按内容认，不能按"我们以为的最新版"认。
 * 这一条方向就是 2026-10-18 之前"手放包必红"的正解：以前所有判据都以
 * "先问 API 拿 tag、再拿那个 tag 的哈希去比"为起点，于是任何不是 fallbackTag
 * 那一版的包都会被当成可疑件中止。
 */
export function lookupNapcatDigest(src, sha256Hex) {
  const want = String(sha256Hex || '').toLowerCase();
  if (!want) return null;
  return napcatKnownDigests(src).find((e) => e.sha256 === want) || null;
}

/** 版本号形状比较（缺段按 0）；只为挑清单里"语义最新"的那一行，不做别的判断。 */
function tagRank(tag) {
  const m = /v?(\d+)\.(\d+)\.(\d+)/.exec(String(tag || ''));
  if (!m) return -1;
  return Number(m[1]) * 1_000_000 + Number(m[2]) * 1_000 + Number(m[3]);
}

/**
 * API 查不到最新版时的**离线默认**：取清单里语义最新的一行（带哈希与尺寸）。
 * 以前这里退回 fallbackTag 且 `napcatDigestForTag` 对别的 tag 返回 null ⇒
 * "下载一份没校验过的 35MB 可执行件"；现在无论 API 通不通，下载都带着期望哈希。
 */
export function napcatOfflineDefault(src) {
  const rows = napcatKnownDigests(src);
  if (!rows.length) return null;
  const best = rows.reduce((a, b) => (tagRank(b.tag) > tagRank(a.tag) ? b : a), rows[0]);
  return { tag: best.tag, sha256: best.sha256, size: best.size, source: 'napcat.json-list' };
}

/**
 * 从已经放好的目录里**猜**一个版本串。返回只用于给人看，绝不参与任何判定 ——
 * 官方 shell 的 `package.json` 写的是 monorepo 桩值 `0.0.1`（2026-10-18 实测），
 * 所以"猜"和"知道"必须分开：知道来自哈希命中，猜来自包里那颗版本串。
 */
export function guessNapcatTagFromHome(home) {
  if (!home) return '';
  const cand = path.join(home, 'napcat.mjs');
  try {
    const fd = fs.openSync(cand, 'r');
    try {
      const buf = Buffer.alloc(2_000_000);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      const m = /\b(\d+\.\d+\.\d+)\b/.exec(buf.slice(0, n).toString('utf8'));
      return m ? `v${m[1]}` : '';
    } finally { fs.closeSync(fd); }
  } catch { return ''; }
}

/**
 * 选取路径的**纯判据**（不碰文件系统，可用 win32 字符串直接断言）。
 *
 * ⚠️ 两类根必须区别对待（2026-10-19 群友真机 · P11）：
 *    · 我们自己的目录 / Windows 目录：本身、上级、**内部**都不许当源
 *      （拿我们自己的目录当原件会把两份同名件绕成环）。
 *    · 个人目录 / 桌面：**只拒根本身与上级**，子目录必须放行 ——
 *      用户解压出来的包十有八九在 `Downloads\NapCat.Shell` 或 `Desktop\NapCat.Shell`，
 *      而安装器的选目录框默认就开在 `$PROFILE\Downloads`。以前这里一律拒，
 *      等于把"按提示做"的用户全部挡死（VM 实测 REFUSED）。
 *
 * ⚠️ `pathEq` 与 `pathInside` 都要用：`pathInside` **把相等判成 false**，
 *    只调它就会漏掉"正好选到 NAPCAT_DIR 自己"这一类。
 * @returns {{ok:true, abs:string}|{ok:false, code:string, abs?:string}}
 */
export function napcatSourceVerdict(rawPath, {
  platform = process.platform,
  installRoot = '', userRoot = '', napcatDir = '', profile = '', windir = '',
} = {}) {
  const raw = String(rawPath || '').trim();
  if (!raw) return { ok: false, code: 'empty' };
  if (raw.length > 240) return { ok: false, code: 'too-long' };
  const p = platform === 'win32' || /^[a-zA-Z]:[\\/]/.test(raw) || /^\\\\/.test(raw) ? path.win32 : path;
  const abs = p.resolve(raw);
  if (/^\\\\/.test(abs)) return { ok: false, code: 'unc', abs };
  if (p.parse(abs).root === abs) return { ok: false, code: 'drive-root', abs };

  const strict = [
    ['install-root', installRoot], ['user-root', userRoot],
    ['napcat-dir', napcatDir], ['windir', windir],
  ];
  for (const [code, dir] of strict) {
    if (!dir) continue;
    const d = p.resolve(String(dir));
    if (pathEq(abs, d, platform)) return { ok: false, code: `${code}-self`, abs };
    if (pathInside(d, abs, { platform })) return { ok: false, code: `${code}-parent`, abs };
    if (pathInside(abs, d, { platform })) return { ok: false, code: `${code}-inside`, abs };
  }

  const desktop = profile ? p.join(profile, 'Desktop') : '';
  for (const [code, dir] of [['profile', profile], ['desktop', desktop]]) {
    if (!dir) continue;
    const d = p.resolve(String(dir));
    if (pathEq(abs, d, platform)) return { ok: false, code: `${code}-self`, abs };
    if (pathInside(d, abs, { platform })) return { ok: false, code: `${code}-parent`, abs };
  }
  return { ok: true, abs };
}

const SOURCE_ROOT_LABEL = {
  'install-root': '安装目录',
  'user-root': '用户数据目录',
  'napcat-dir': '协议端目录',
  windir: 'Windows 目录',
  profile: '个人目录',
  desktop: '桌面',
};

/** 拒绝码 → 给人看的中文。表在这里是为了让纯判据与措辞各管一件事。 */
function sourceRefusalText(code, abs, raw) {
  if (code === 'empty') return '没有给出路径';
  if (code === 'too-long') {
    return `路径太长（${raw.length} 字符），复制到目标位置时会先撞上 Windows 的 MAX_PATH，届时删也不是留也不是`;
  }
  if (code === 'unc') return `不支持网络共享路径（UNC）：${abs}`;
  if (code === 'drive-root') return `不能选盘根：${abs}`;
  const m = /^(install-root|user-root|napcat-dir|windir|profile|desktop)-(self|parent|inside)$/.exec(code);
  if (!m) return `这个路径不能用：${abs}`;
  const label = SOURCE_ROOT_LABEL[m[1]];
  if (m[2] === 'self') return `不能选${label}本身（${abs}）`;
  if (m[2] === 'parent') return `不能选${label}的上级目录（所选路径包含了 ${abs} —— 那意味着要搬走整棵子树）`;
  return `不能选「${label}」里面的路径：${abs}`;
}

/**
 * 选取路径的安全闸：纯判据 + 真实文件系统检查。
 * @returns {{ok:true, abs:string}|{ok:false, error:string}}
 */
export function assertNapcatSourceSafe(srcPath, {
  kind, installRoot = '', userRoot = '', napcatDir = NAPCAT_DIR,
  env = process.env, platform = process.platform,
} = {}) {
  const miss = (m) => ({ ok: false, error: m });
  const raw = String(srcPath || '').trim();
  const profile = String(env.USERPROFILE || '').trim();
  const windir = String(env.WINDIR || env.SystemRoot || '').trim();
  const verdict = napcatSourceVerdict(raw, {
    platform, installRoot, userRoot, napcatDir, profile, windir,
  });
  if (!verdict.ok) return miss(sourceRefusalText(verdict.code, verdict.abs || raw, raw));
  const abs = verdict.abs;
  if (!exists(abs)) return miss(`路径不存在：${abs}`);
  const st = fs.statSync(abs);
  if (kind === 'zip' && !st.isFile()) return miss(`选中的不是文件：${abs}`);
  if (kind === 'folder' && !st.isDirectory()) return miss(`选中的不是目录：${abs}`);
  if (kind === 'zip' && !/\.zip$/i.test(abs)) return miss(`选中的不是 .zip：${abs}`);
  return { ok: true, abs };
}

/** 只删我们自己造的东西（暂存目录一律以 `.new-<时间戳>` 结尾）。 */
function dropStaging(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 留个残目录不影响使用，下次换名会换一个新后缀 */ }
}

/**
 * 把用户选中的包放到 `NAPCAT_DIR`。
 *
 * @param {{kind:'zip'|'folder', src:string, installRoot?:string, userRoot?:string, srcText?:string}} opt
 *        `srcText` 是安装器里显示的那串原样文字（只用于记录/回显，不参与判定）
 * @returns {Promise<{state:string, status:string, tag:string, verification:string,
 *          home:string, sha256:string, guessedTag?:string, error?:string, note?:string}>}
 */
export async function placeNapcatFromLocal({ kind, src, installRoot = '', userRoot = '', srcText = '' } = {}) {
  const srcLog = srcText || src || '';
  const guard = assertNapcatSourceSafe(src, { kind, installRoot, userRoot });
  if (!guard.ok) {
    warn(`✗ 这个路径不能用：${guard.error}`);
    diag(`NapCat 离线放包被拒（${kind}）：${guard.error}`);
    return { state: 'refused', status: NAPCAT_STATUS.REFUSED, tag: '', verification: 'none', home: '', sha256: '', error: guard.error, reason: 'source-unsafe' };
  }
  const abs = guard.abs;
  const napcatDir = NAPCAT_DIR;
  const already = napcatInstalled();
  const recordOf = { sourcePath: abs, sourceKind: kind };

  // ── 目录分支：形状先过，再谈提交 ──────────────────────────────────────────
  if (kind === 'folder') {
    const launcher = findNapcatLauncher(abs);
    if (!launcher) {
      const e = `${abs} 里没找到 NapCat 的启动器（launcher*.bat / NapCatWinBootMain.exe）。`
        + ' 选**解压出来的那一层**（里面直接放着启动器），别选下载的父目录，也别选 NapCat 源码仓（packages/ + pnpm-workspace.yaml 那种）。';
      warn(`✗ ${e}`);
      return { state: 'refused', status: NAPCAT_STATUS.REFUSED, tag: '', verification: 'none', home: '', sha256: '', error: e, reason: 'folder-no-launcher' };
    }
    // 已经有一份、且不是我们装的 ⇒ 不覆盖，把话讲明白。两份不同版本叠在一起
    // 是最难查的坏法（登录态还在，代码却换了）。
    if (already.found && already.inferredFrom !== 'record') {
      const e = `${path.relative(userRoot || napcatDir, napcatDir)} 里已经有一份 NapCat（版本来源：${already.inferredFrom || '未知'}），不是本包装的，不覆盖。`
        + ' 要换：先把它整个移到别处，再重跑一次安装器选你的新包。';
      warn(`! ${e}`);
      return { state: 'refused', status: NAPCAT_STATUS.REFUSED, tag: already.tag || '', verification: 'none', home: already.home || '', sha256: '', error: e, reason: 'occupied-foreign' };
    }
    fs.mkdirSync(napcatDir, { recursive: true });
    // 用户可能选的是**外层目录**（里面套着一层 napcat/）。照原样复制会变成
    // napcat\napcat\launcher-user.bat —— 能装、装完启动不了。所以先定位真正
    // 含启动器的那一层再复制（2026-10-18 VM 实测：选外层目录会套两层）。
    const srcHome = napcatHome(abs) || abs;
    const copied = overlay(srcHome, napcatDir, { preserve: already.found ? new Set(['config']) : new Set() });
    const home = napcatHome(napcatDir) || napcatDir;
    const guessed = guessNapcatTagFromHome(home);
    writeNapcatRecord({
      ...recordOf, tag: '', home: path.relative(napcatDir, home), sha256: '',
      sha256Source: 'unverified', verification: 'unverified-local', provenance: 'installer-folder',
      guessedTag: guessed, filesCopied: copied,
    });
    const note = `按**未校验**装上了一份目录形态的 NapCat（复制 ${copied} 个文件；猜它是 ${guessed || '版本不明'}，猜的不作数）。`
      + ` 原件仍在 ${abs}，我们没有动它。`;
    warn(`! ${note}`);
    diag(`NapCat 离线放包（目录）：${abs} → ${napcatDir}，${copied} 个文件，未校验`);
    return { state: 'installed', status: NAPCAT_STATUS.UNVERIFIED, tag: '', verification: 'unverified-local', home, sha256: '', guessedTag: guessed, note, reason: '' };
  }

  // ── zip 分支：哈希 → 清单 → 暂存解压 → 验形状 → 提交 ─────────────────────
  const st = fs.statSync(abs);
  const srcCfg = loadNapcatSource();
  const minBytes = Number(srcCfg.assetMinBytes) > 0 ? Number(srcCfg.assetMinBytes) : 8_000_000;
  if (st.size < minBytes) {
    const e = `${path.basename(abs)} 只有 ${humanSize(st.size)}，这不是 NapCat.Shell.zip。`
      + ` NapCat 官方的 ${srcCfg.asset || 'NapCat.Shell.zip'} 约 ${humanSize(minBytes)} 以上；`
      + ' 那个 994KB 的 `NapCat.Shell.Windows.OneKey.zip` 是一键安装壳，不是协议端本体。';
    warn(`✗ ${e}`);
    return { state: 'refused', status: NAPCAT_STATUS.REFUSED, tag: '', verification: 'none', home: '', sha256: '', error: e, reason: 'zip-too-small' };
  }

  const sha = sha256File(abs);
  const hit = lookupNapcatDigest(srcCfg, sha);
  const expected = hit ? { sha256: hit.sha256, source: 'knownGood-list' } : null;
  // 本地选件走"宽"校验：形状/尺寸/清单都在下面判，不许像下载路径那样一不对就中止 ——
  // 中止等于把用户自己带来的文件也一并骂一顿，而他是来装我们装不了的东西的。
  verifyNapcatZip(abs, expected, { strict: false });

  const staging = `${napcatDir}.new-${Date.now()}`;
  let home = '';
  try {
    fs.mkdirSync(staging, { recursive: true });
    const tool = unzip(abs, staging);
    home = flattenSingleDir(staging);
    if (!findNapcatLauncher(home)) {
      const e = `${path.basename(abs)} 解压后没找到启动器（launcher*.bat / NapCatWinBootMain.exe）—— 这份件不像 NapCat 本体，已放弃，原来的目录一个字节都没动。`;
      warn(`✗ ${e}`);
      dropStaging(staging);
      return { state: 'failed', status: NAPCAT_STATUS.FAILED, tag: '', verification: 'none', home: '', sha256: sha, error: e, reason: 'zip-no-launcher' };
    }
    if (!exists(napcatDir) || isDirEmpty(napcatDir)) {
      dropIfEmpty(napcatDir);
      // ⚠️ 不能 rename(staging) —— flattenSingleDir 只是**返回**内层路径，没有把
      //    文件挪上来。rename 整棵 staging 会把 zip 里那层包装目录一起带进 napcat\。
      //    统一走 overlay(home) ，与外层已存在的分支同一套语义（2026-10-18 VM 实测）。
      fs.mkdirSync(napcatDir, { recursive: true });
      overlay(home, napcatDir);
      dropStaging(staging);
      home = napcatHome(napcatDir) || napcatDir;
    } else {
      const copied = overlay(home, napcatDir, { preserve: new Set(['config']) });
      dropStaging(staging);
      home = napcatHome(napcatDir) || napcatDir;
      diag(`NapCat 离线放包为覆盖式复制（${copied} 个文件），config/ 保留`);
    }
  } catch (e) {
    dropStaging(staging);
    const msg = `放包失败：${e && e.message ? e.message : e}`;
    warn(`✗ ${msg}`);
    diag(`NapCat 离线放包异常：${msg}`);
    return { state: 'failed', status: NAPCAT_STATUS.FAILED, tag: '', verification: 'none', home: '', sha256: sha, error: msg, reason: 'unzip-failed' };
  }

  const guessed = guessNapcatTagFromHome(home);
  if (hit) {
    writeNapcatRecord({
      ...recordOf, tag: hit.tag, home: path.relative(napcatDir, home), sha256: sha,
      sha256Source: 'knownGood-list', verification: 'official-digest', provenance: 'installer-zip',
      guessedTag: guessed, sizeBytes: st.size,
    });
    ok(`NapCat ${hit.tag} 已从本地件装好（SHA-256 与官方记录一致：${sha.slice(0, 12)}…）`);
    say(`      the original at ${abs} was only read, never moved or deleted.`);
    diag(`NapCat 离线放包（zip）命中清单：${hit.tag}`);
    return { state: 'installed', status: NAPCAT_STATUS.OK, tag: hit.tag, verification: 'official-digest', home, sha256: sha, reason: '' };
  }

  writeNapcatRecord({
    ...recordOf, tag: '', home: path.relative(napcatDir, home), sha256: sha,
    sha256Source: 'unverified', verification: 'unverified-mismatch', provenance: 'installer-zip',
    guessedTag: guessed, sizeBytes: st.size,
    expectedTag: (napcatOfflineDefault(srcCfg) || {}).tag || '',
    expectedSha256: (napcatOfflineDefault(srcCfg) || {}).sha256 || '',
  });
  const want = napcatOfflineDefault(srcCfg);
  warn('this package is not in our known-good list; installed as UNVERIFIED because you picked the file yourself.');
  say(`      expected: some release of ${srcCfg.asset || 'NapCat.Shell.zip'} (nearest in our list: ${want ? want.tag : 'none'},`
    + ` SHA-256 first 12 ${want ? want.sha256.slice(0, 12) : 'none'}, from GitHub Release assets[].digest)`);
  say(`      actual: SHA-256 first 12 ${sha.slice(0, 12)} (full value and original path recorded in userdata\\napcat\\INSTALLED.json)`);
  say(`      guessed tag: ${guessed || 'unknown'} (guessed from the version string inside the package; not authoritative and never used to decide overwrites).`);
  say('      for the official original: NapCat.Shell.zip on the NapCat Releases page (NOT NapCat.Shell.Windows.OneKey.zip - that 994KB file is just an installer shell).');
  say(`      the original at ${abs} was left untouched.`);
  diag(`NapCat offline zip not in known-good list: actual ${sha.slice(0, 12)}`);
  return { state: 'installed', status: NAPCAT_STATUS.MISMATCH, tag: '', verification: 'unverified-mismatch', home, sha256: sha, guessedTag: guessed, reason: '' };
}

/** 目录是不是空的（不存在/读不动都按"可以当成空"处理 —— 后面 rename 会自己报错并走覆盖分支）。 */
function isDirEmpty(dir) {
  try { return fs.readdirSync(dir).length === 0; } catch { return false; }
}
function dropIfEmpty(dir) {
  if (isDirEmpty(dir)) dropStaging(dir);
}
