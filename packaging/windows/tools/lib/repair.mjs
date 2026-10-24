/**
 * 自动修复 —— 一键安装「③ 自动修复」那一环的**唯一实现**。
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  三条纪律（改这个文件之前先读）
 * ══════════════════════════════════════════════════════════════════════════
 *  ① **只修我们自己的东西，不修用户的系统。**
 *     Node（包内自带）→ 随便换。NapCat（我们装的）→ 随便换。
 *     QQ（腾讯的客户端、用户的聊天工具）→ **只引导，绝不静默替他装**。
 *     静默装一个聊天软件进用户的电脑，是本包最不该做的那类事。
 *
 *  ② **更新不许弄丢登录态。** NapCat 更新时 `config/` 整个保留 ——
 *     那里存着已登录账号与 OneBot 端口配置。弄丢它 = 逼用户重新扫码，
 *     而"每次都要重新扫码"正是本次要解决的问题。
 *
 *  ③ **失败必须带下一步。** 每一处 catch 都要说清"那你现在该怎么办"，
 *     不允许只输出一句"失败"（这是本包一直以来的格式要求）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  ROOT, NAPCAT_DIR, NAPCAT_ZIP, UPDATE_DIR, RUNTIME_NODE_DIR, IS_WIN,
  say, ok, warn, dim, exists, humanSize,
  downloadWithMirrors, unzip, flattenSingleDir, loadNapcatSource, napcatUrls,
  napcatHome, findNapcatLauncher, sha256File, diag, overlay,
} from './common.mjs';
import {
  nodeInstalled, latestNodeLts, nodeZipSha, napcatInstalled, writeNapcatRecord,
  latestNapcatRelease, napcatDigestForTag, verifyNapcatZip, gte,
} from './versions.mjs';
import { lookupNapcatDigest, napcatOfflineDefault } from './napcat-local.mjs';

// ── 小工具 ──────────────────────────────────────────────────────────────────
function rmrf(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); return true; } catch { return false; }
}

// ⚠️ 原来这里有一份本地的 `sha256File`；2026-10-16 起搬去 `lib/common.mjs` ——
//    下载器的真值校验与 `verifyNapcatZip` 都要用它，三处都要用的东西不许各存一份。

/** 用系统默认浏览器开一个网址（QQ 下载页 / 控制台都靠它）。 */
export function openUrl(url) {
  if (!IS_WIN) { say(`  请手动打开：${url}`); return false; }
  try {
    // ⚠️ `start` 是 cmd 内建命令，必须经 cmd；那个空串参数是"窗口标题"位，
    //    少了它 URL 会被当成标题、浏览器根本不开且**没有任何报错**。
    spawn('cmd.exe', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    return true;
  } catch {
    return false;
  }
}

/** Node 官方 win-x64 zip 的候选源（国内镜像优先 —— 直连常常只有几十 KB/s）。 */
function nodeZipUrls(version) {
  const name = `node-v${version}-win-x64.zip`;
  return [
    `https://cdn.npmmirror.com/binaries/node/v${version}/${name}`,
    `https://mirrors.tuna.tsinghua.edu.cn/nodejs-release/v${version}/${name}`,
    `https://nodejs.org/dist/v${version}/${name}`,
  ];
}

// ── ① Node 运行时 ───────────────────────────────────────────────────────────
/**
 * 保证包内的 Node 存在且不低于 `MIN_NODE`。
 *
 * ⚠️ 换运行时的**顺序是刻意的**（Windows 上正在运行的 exe 不能删、但可以改名）：
 *     下载 → 解到临时目录 → **把旧目录改名**（rename 对运行中的映像成立）
 *     → **把新目录改名为 runtime\node** → 再尽力删掉旧目录。
 *   之所以能这么做：Windows 的文件映射按 ID 保持，改路径不影响已在跑的进程 ——
 *   于是"我们自己正从这个目录里跑着"不再是需要重启才能解的死结。
 *   删不掉旧目录（我们自己的进程仍持有它）时**留着并说明**，下次启动会顺手清掉。
 *
 * @returns {Promise<{state:'ok'|'fixed'|'unchanged', version:string, note?:string}>}
 */
/**
 * @param {{updateToLatest?:boolean}} opt
 *   updateToLatest=false（默认）时**只修"不合格"**：缺失 / 低于 `MIN_NODE`。
 *   ⚠️ **为什么不默认追最新 LTS**：包内这份运行时是构建时**比对过官方 SHASUMS** 的固定件，
 *      `BUILD-INFO.txt` 里记着它是哪一版。每次安装都把它换成"当下最新"，
 *      等于让"这份包里跑的是什么"变成随时间漂移的东西 —— 而它只要满足
 *      `package.json` 的 `engines.node` 就**不影响任何功能**。
 *      所以：追新是**显式**动作（`--update-node`），默认只保证够用。
 *      这个取向必须写进输出（见下面那句"已是最新 / 未追新"），不能默默决定。
 * @returns {Promise<{state:'ok'|'fixed'|'unchanged', version:string, note?:string}>}
 */
export async function ensureNodeRuntime({ updateToLatest = false } = {}) {
  const cur = nodeInstalled();
  const need = cur.need;
  const missing = !cur.found;
  const below = cur.probed && !gte(cur.version, need);
  if (!missing && !below && !updateToLatest) {
    return { state: 'unchanged', version: cur.version, note: '已满足要求，未追新' };
  }

  const target = (await latestNodeLts()) || '';
  // 只装 LTS，且**不低于**最低要求：查不到最新就退回"修到满足最低要求的那一版"思路 ——
  // 但 Node 官方没有"某一档"的下载别名，所以查不到最新时**不动它**，只把问题说清。
  if (!target) {
    if (!cur.found) throw new Error('包内的 Node 运行时不见了，而查不到官方版本号，无法自动补装。\n      离线办法：到 https://nodejs.org 下 Windows x64 的 zip，把里面的文件解到 runtime\\node\\。');
    warn(`包内 Node ${cur.version} 低于要求 ${need}，但查不到官方最新版（离线？）—— 暂不替换`);
    return { state: 'unchanged', version: cur.version, note: '离线，未更新' };
  }
  if (cur.found && gte(cur.version, target)) {
    ok(`包内 Node ${cur.version} 已是最新 LTS`);
    return { state: 'unchanged', version: cur.version };
  }

  const zipPath = path.join(ROOT, 'runtime', `.node-update-${target}.zip`);
  // ⚠️ 先取官方哈希、再下载（2026-10-16 · P0-2）：期望哈希透传给下载器 ⇒
  //    续传残段被改过也能在**整份重算**时现形，并自动丢弃残段重下（自愈）。
  const want = await nodeZipSha(target);
  diag(`③-1 Node 更新下载 v${target}（${want ? `官方哈希 ${want.slice(0, 12)}…` : '未取到官方哈希'}）`);
  say(`  正在下载 Node ${target}（Windows x64，约 30MB，国内镜像优先）…`);
  const r = await downloadWithMirrors(nodeZipUrls(target), zipPath, { expectedSha256: want || '' });
  ok(`下载完成：${humanSize(r.bytes)}`);

  // 真值复核：与官方 SHASUMS256.txt 比对。查不到哈希时**明确说没校验**，
  // 不能假装校验过（"以为校验了"比"没校验"更危险）。
  if (want) {
    const got = r.sha256 || sha256File(zipPath); // 下载器给了实测值就用它；没给（理论到不了）就自己算
    if (got === want) ok('SHA-256 与官方 SHASUMS256.txt 一致');
    else throw new Error(`下载件与官方哈希对不上（官方 ${want.slice(0, 12)}… 实测 ${got.slice(0, 12)}…）\n      已中止，包内运行时未被改动。重新跑一次即可。`);
  } else {
    warn('没查到官方哈希，这次下载**没做**完整性校验（不影响使用，仅作说明）');
  }

  const tmpDir = path.join(ROOT, 'runtime', '.node-new');
  rmrf(tmpDir);
  unzip(zipPath, tmpDir);
  const srcDir = flattenSingleDir(tmpDir);
  if (!exists(path.join(srcDir, 'node.exe'))) {
    rmrf(tmpDir);
    throw new Error(`解出来的目录里没有 node.exe（${srcDir}）—— 已中止，包内运行时未被改动。`);
  }

  const oldDir = path.join(ROOT, 'runtime', `.node-old-${Date.now()}`);
  if (exists(RUNTIME_NODE_DIR)) {
    try { fs.renameSync(RUNTIME_NODE_DIR, oldDir); }
    catch (e) {
      rmrf(tmpDir);
      throw new Error(`旧运行时目录改不了名（${e.message}）—— 多半是有个 node 进程还在跑。\n      关掉所有本项目的窗口（含控制台）后重新双击一键安装。`);
    }
  }
  try { fs.renameSync(srcDir, RUNTIME_NODE_DIR); }
  catch (e) {
    // 换名失败要把旧的换回来，否则这台机器上这份包就再也没有运行时了
    if (exists(oldDir)) { try { fs.renameSync(oldDir, RUNTIME_NODE_DIR); } catch { /* 尽力 */ } }
    throw new Error(`新运行时就位失败（${e.message}）—— 已把旧的换回去，包仍然可用。`);
  }

  const cleaned = rmrf(oldDir);
  try { fs.rmSync(zipPath, { force: true }); } catch { /* 留着也无所谓 */ }
  ok(`Node 运行时已更新到 ${target}`);
  if (!cleaned) dim(`      旧的那份暂时删不掉（有进程还在用它），留在 ${path.relative(ROOT, oldDir)}，下次启动会清掉。`);
  return { state: 'fixed', version: target, note: cleaned ? '' : '旧运行时残留待清理' };
}

// ── ② NapCat ────────────────────────────────────────────────────────────────
/**
 * 下载官方包到 `app/napcat/NapCat.Shell.zip`（已存在就复用 —— 支持离线手工放包）。
 *
 * ⚠️ 校验**不在这里**：本函数只管"把文件弄到位"，完整性由调用方紧跟着调
 *    `verifyNapcatZip()` —— 本地放包与下载件走**同一条**校验路（离线手工放包
 *    不再是一个绕过校验的口子）。下载这一路把期望哈希透传给下载器，
 *    是为了拿到"续传残段被改也能自动重下"的自愈（P0-2）。
 */
/**
 * 下载官方包到 `NAPCAT_ZIP`（**只负责"把文件弄到位"**）。
 *
 * ⚠️ 校验不在这里：完整性由调用方紧跟着调 `verifyNapcatZip()`；
 *    "手上已经有一份了"的判断也**不在这里**（P6 起挪到 `ensureNapcat` 开头 ——
 *    原来这个函数内部藏着一个"本地有就复用"分支，于是调用顺序变成"先问 API、
 *    再看本地"，离线机器白等超时，而且非兜底版本的本地件会被按兜底哈希判死）。
 * ⚠️ 期望哈希**与期望尺寸**都要透传给下载器：前者拿到"续传残段被改也能自愈"
 *    （P0-2），后者让"源给了别的东西"在下载当场就暴露，而不是等整份哈希。
 */
async function fetchNapcatZip(tag, expected) {
  const src = loadNapcatSource();
  const sizeHint = expected && expected.size ? `，约 ${humanSize(expected.size)}` : '';
  say(`  正在下载 NapCat ${tag}（官方包${sizeHint || '约 30MB'}，国内镜像优先；最多试到 5 分钟，超时就先跳过）…`);
  // ⚠️ 临时件**不许放进协议端目录**：downloadWithMirrors 会先建父目录，而
  //    "userdata\napcat 存在"曾经被当成"协议端已装"（2026-10-19 群友真机：
  //    一次失败下载就把后续每一次重试永久毒化成"已安装、无需处理"）。
  //    放在 update\downloads；成功校验后由调用方解压到 NAPCAT_DIR。
  const file = path.join(UPDATE_DIR, 'downloads', `napcat-${tag}.zip`);
  const r = await downloadWithMirrors(napcatUrls(src, tag), file, {
    expectedSha256: expected ? expected.sha256 : '',
    expectedSize: expected && expected.size ? expected.size : 0,
  });
  return { ...r, file };
}

// `overlay()`（只覆盖、不删除，默认保住 config/ 登录态）住在 lib/common.mjs ——
// 下载升级与"用户自带件"两条路必须共用同一份覆盖语义，各写一份迟早会变成
// 一份保 config、一份不保，那是会丢扫码登录的那种分叉。

/**
 * 保证 NapCat 已安装且是最新一版。
 *
 * ⚠️ **顺序就是正确性**（2026-10-18 · P6）：先看手上有没有包，**再**问 GitHub。
 *   原来这里一上来就 `latestNapcatRelease()`，于是
 *   ① 离线机器白等一次 API 超时；
 *   ② 更坏：API 拿不到时期望值退回 `fallbackTag` 那一版的哈希，用户手放的
 *      **任何别的版本**都被判"校验不过"而中止 —— 即"离线放包"这条路一直是坏的
 *      （`napcatDigestForTag` 对 tag ≠ fallbackTag 一律返回 null）。
 *   现在本地件**按哈希反查 knownGood**：认得就写 tag（日后敢自动覆盖），
 *   认不得就如实标未校验（日后不敢自动覆盖），两种都不中止。
 *
 * @param {{update?:boolean}} opt update=true 时，即使已装也会检查最新版并升级
 * @returns {Promise<{state:'ok'|'installed'|'updated'|'unchanged', tag?:string, home?:string}>}
 */
export async function ensureNapcat({ update = true } = {}) {
  const cur = napcatInstalled();
  const src = loadNapcatSource();

  if (!cur.found) {
    // 旧版把下载残片写在协议端目录里；它现在不再影响"装没装"的判据，
    // 但留着既占地方又会让人误以为装过。只删我们自己那个精确文件名。
    try { fs.rmSync(path.join(NAPCAT_DIR, 'NapCat.Shell.zip.part'), { force: true }); } catch { /* 删不掉不致命 */ }
    let tag = '';
    let expected = null;
    let local = false;
    let zipFile = NAPCAT_ZIP;
    if (exists(NAPCAT_ZIP)) {
      local = true;
      const sha = sha256File(NAPCAT_ZIP);
      const hit = lookupNapcatDigest(src, sha);
      tag = hit ? hit.tag : '';
      expected = hit ? { sha256: hit.sha256, source: 'knownGood-list' } : null;
      ok(`发现已放好的 NapCat 包：${humanSize(fs.statSync(NAPCAT_ZIP).size)}（离线安装 —— 全程没联网）`);
      say(`      清单${hit ? `命中 ${hit.tag}` : '没认得这份哈希（实测 ${sha.slice(0, 12)}…）—— 认不得的只标未校验，不会拦你'}`);
      diag(`③-2 NapCat 未装 → 用本地已放好的包（清单命中：${tag || '否'}）`);
    } else {
      const rel = await latestNapcatRelease(src);
      const offline = rel ? null : napcatOfflineDefault(src);
      tag = (rel && rel.tag) || (offline && offline.tag) || src.fallbackTag;
      expected = (rel && rel.sha256)
        ? { sha256: rel.sha256, source: 'github-api' }
        : (offline && offline.sha256)
          ? { sha256: offline.sha256, source: 'napcat.json-list', size: offline.size }
          : await napcatDigestForTag(src, tag);
      diag(`③-2 NapCat 未装 → 下载 ${tag}（校验值：${expected ? expected.source : '**没有**，只记实测'}）`);
      if (!rel && expected && expected.source === 'napcat.json-list') {
        say(`  查不到最新版本，按清单里最近的 ${tag} 装（带官方哈希，不是裸装）。`);
      }
      const r = await fetchNapcatZip(tag, expected);
      zipFile = r.file;
      ok(`下载完成：${humanSize(r.bytes)}（来源 ${new URL(r.url).host}）`);
    }

    const v = verifyNapcatZip(zipFile, expected, { strict: !local });
    unzip(zipFile, NAPCAT_DIR);
    const home = flattenSingleDir(NAPCAT_DIR);
    if (!findNapcatLauncher()) {
      // 下载/解压都成功、内容却不是协议端 —— 必须**失败**，不许在状态里写 OK。
      // 2026-10-19：这条以前只 warn 一句然后照样报"已安装"，于是"包形状不对"
      // 会重演群友看到的假成功（面板说未安装、安装器却说成功）。
      const e = new Error('解压后没找到启动器（launcher*.bat / NapCatWinBootMain.exe）—— 这份包不是 NapCat 本体');
      e.code = 'NAPCAT_NO_LAUNCHER';
      throw e;
    }
    writeNapcatRecord({
      tag, home: path.relative(NAPCAT_DIR, home), sha256: v.sha256, sha256Source: v.source,
      verification: v.verified ? 'downloaded-verified' : 'unverified-local',
      provenance: local ? 'manual-drop' : 'github-download',
    });
    try { fs.rmSync(zipFile, { force: true }); } catch { /* 删不掉无所谓 */ }
    ok(`NapCat ${tag || '版本未记'} 已安装${tag ? '' : '（清单没认得这份件，已按未校验登记，日后不会自动覆盖它）'}`);
    diag(`NapCat 安装完成：${tag || '未记版本'}（sha256 记录：${v.source}）`);
    return { state: 'installed', tag, home, sha256: v.sha256, sha256Source: v.source };
  }

  if (!update) return { state: 'unchanged', tag: cur.tag || cur.version };

  // 版本不明（不是本包装的）→ **不替换**。猜着换掉用户的东西，后果比不换严重。
  if (!cur.inferredFrom || cur.inferredFrom !== 'record') {
    dim(`  NapCat 已装（版本来源：${cur.inferredFrom || '未知'}）—— 不是本包装的，不自动替换`);
    return { state: 'unchanged' };
  }
  // 更新路径自己问一次版本（首装路径在上面已经走完了，不复用它的变量 ——
  // 两件事各自要判的东西不同：首装看"手上有没有件"，更新看"线上有没有新的"）。
  const rel = await latestNapcatRelease(src);
  const offline = rel ? null : napcatOfflineDefault(src);
  const latest = (rel && rel.tag) || (offline && offline.tag) || '';
  const expected = (rel && rel.sha256)
    ? { sha256: rel.sha256, source: 'github-api' }
    : (offline && offline.sha256)
      ? { sha256: offline.sha256, source: 'napcat.json-list', size: offline.size }
      : await napcatDigestForTag(src, latest);
  if (!latest) {
    dim(`  NapCat ${cur.version} 已在位（查不到最新版本，跳过更新）`);
    return { state: 'unchanged', tag: cur.tag };
  }
  if (gte(cur.version, String(latest).replace(/^v/, ''))) {
    ok(`NapCat ${cur.version} 已是最新（${latest}）`);
    return { state: 'unchanged', tag: cur.tag };
  }

  say(`  NapCat ${cur.version} → ${latest}，正在更新（**登录态与配置会保留**）…`);
  diag(`③-2 NapCat 更新 ${cur.version} → ${latest}（校验值：${expected ? expected.source : '**没有**，只记实测'}）`);
  const home = napcatHome() || NAPCAT_DIR;
  const tmp = path.join(NAPCAT_DIR, '.update-tmp');
  rmrf(tmp);
  await fetchNapcatZip(latest, expected);
  const v = verifyNapcatZip(NAPCAT_ZIP, expected);
  unzip(NAPCAT_ZIP, tmp);
  const srcDir = flattenSingleDir(tmp);
  const n = overlay(srcDir, home);
  rmrf(tmp);
  try { fs.rmSync(NAPCAT_ZIP, { force: true }); } catch { /* 无所谓 */ }
  writeNapcatRecord({
    tag: latest, home: path.relative(NAPCAT_DIR, home), sha256: v.sha256, sha256Source: v.source,
    verification: v.verified ? 'downloaded-verified' : 'unverified-local', provenance: 'github-download',
  });
  ok(`NapCat 已更新到 ${latest}（覆盖 ${n} 个文件，config\\ 原样保留 —— 不用重新扫码）`);
  diag(`NapCat 更新完成：${latest}（覆盖 ${n} 个文件 · sha256 记录：${v.source}）`);
  return { state: 'updated', tag: latest, home, sha256: v.sha256, sha256Source: v.source };
}

// ── ③ QQ 客户端（只引导）─────────────────────────────────────────────────────
/**
 * QQ 没装时的处理：**引导**，不代装。
 *
 * 能自动的部分只有一件：机器上若有 `winget`，就把它的安装命令跑起来
 * （仍会弹 UAC / 商店协议确认，这是 Windows 自己的规矩，绕不过去，也不该绕）。
 * 没有 winget 就只开下载页 —— 让用户自己决定装不装、装到哪。
 *
 * @param {{yes?:boolean}} opt yes=true 时不问，直接尝试 winget
 */
export async function ensureQQ({ yes = false } = {}) {
  if (!IS_WIN) return { state: 'skip', msg: '非 Windows，跳过' };
  const hasWinget = await new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    try {
      const c = spawn('winget', ['--version'], { windowsHide: true, stdio: 'ignore' });
      c.once('error', () => finish(false));
      c.once('close', (code) => finish(code === 0));
      setTimeout(() => { try { c.kill(); } catch { /* 已退出 */ } finish(false); }, 5000);
    } catch { finish(false); }
  });

  if (!hasWinget) {
    warn('没有检测到 QQ（NT 版）');
    say('  NapCat 是挂在 QQ 上的 —— 没有 QQ 客户端，机器人连不上群。');
    openUrl('https://im.qq.com/pcqq');
    say('  已打开 QQ 下载页。装好后重新双击一键安装即可（本次会先跳过这一步）。');
    return { state: 'guided', msg: '已打开下载页，等待用户安装' };
  }

  if (!yes) {
    warn('没有检测到 QQ（NT 版）—— 需要装一个才能跑机器人。');
    dim('      本机有 winget，可以试着自动装；也可以你自己去装，装完重跑一键安装。');
    return { state: 'need-confirm', msg: '待用户确认是否用 winget 安装 QQ' };
  }

  say('  正在用 winget 安装 QQ（这一步会弹 Windows 自己的确认框，按提示点即可）…');
  const code = await new Promise((resolve) => {
    try {
      const c = spawn('winget', [
        'install', '--id', 'Tencent.QQ.NT', '--exact',
        '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity',
      ], { windowsHide: false, stdio: 'inherit' });
      c.once('error', () => resolve(-1));
      c.once('close', resolve);
    } catch { resolve(-1); }
  });
  if (code === 0) { ok('QQ 安装已完成（首次打开需要你登录一次自己的 QQ）'); return { state: 'fixed' }; }
  warn('winget 没能装上 QQ（上面是它的输出）');
  say('  手动装：https://im.qq.com/pcqq —— 装好后重新双击一键安装。');
  return { state: 'guided', msg: 'winget 失败，已给出手动链接' };
}
