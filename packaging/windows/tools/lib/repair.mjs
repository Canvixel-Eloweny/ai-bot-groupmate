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
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  ROOT, NAPCAT_DIR, NAPCAT_ZIP, RUNTIME_NODE_DIR, IS_WIN,
  say, ok, warn, dim, exists, humanSize,
  downloadWithMirrors, unzip, flattenSingleDir, loadNapcatSource,
  napcatHome, findNapcatLauncher,
} from './common.mjs';
import {
  nodeInstalled, latestNodeLts, nodeZipSha, napcatInstalled, writeNapcatRecord,
  latestNapcatTag, gte,
} from './versions.mjs';

const ZIP_RE = /^node-v.+-win-x64\.zip$/;

// ── 小工具 ──────────────────────────────────────────────────────────────────
function rmrf(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); return true; } catch { return false; }
}

function sha256File(p) {
  const h = createHash('sha256');
  h.update(fs.readFileSync(p));
  return h.digest('hex');
}

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
  say(`  正在下载 Node ${target}（Windows x64，约 30MB，国内镜像优先）…`);
  const r = await downloadWithMirrors(nodeZipUrls(target), zipPath);
  ok(`下载完成：${humanSize(r.bytes)}`);

  // 真值校验：与官方 SHASUMS256.txt 比对。查不到哈希时**明确说没校验**，
  // 不能假装校验过（"以为校验了"比"没校验"更危险）。
  const want = await nodeZipSha(target);
  if (want) {
    let got = '';
    try { got = sha256File(zipPath); } catch { /* 读不出来当未校验 */ }
    if (got && got === want) ok('SHA-256 与官方 SHASUMS256.txt 一致');
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
/** 下载官方包到 `app/napcat/NapCat.Shell.zip`（已存在就复用 —— 支持离线手工放包）。 */
async function fetchNapcatZip(tag) {
  if (exists(NAPCAT_ZIP)) {
    ok(`发现已放好的 NapCat 包：${humanSize(fs.statSync(NAPCAT_ZIP).size)}（离线安装用）`);
    return { url: '本地已有', bytes: fs.statSync(NAPCAT_ZIP).size };
  }
  const src = loadNapcatSource();
  const base = src.downloadTemplate
    .replace('{repo}', src.repo).replace('{tag}', tag).replace('{asset}', src.asset);
  const list = (src.mirrors || []).map((m) => (m.endsWith('/') ? m + base : `${m}/${base}`));
  list.push(base); // 直连排最后：实测最慢，还可能挂死
  say(`  正在下载 NapCat ${tag}（官方包，约 30MB，国内镜像优先）…`);
  return downloadWithMirrors(list, NAPCAT_ZIP);
}

/**
 * 把新版本**覆盖**到现有目录。
 *
 * ⚠️ 只**覆盖**、**不删除**：官方每个版本的文件集合不完全一样，删旧文件
 *    会把"上一版有、这一版没有"的依赖连带清掉（例如它自己的数据目录）。
 * ⚠️ `config/` **整个跳过** —— 那里是登录态与 OneBot 配置（见文件头纪律 ②）。
 *
 * @param {string} srcDir 解压出来的（已 flatten 的）新版本目录
 * @param {string} dstDir 现有 NapCat 的家
 */
function overlay(srcDir, dstDir, { preserve = new Set(['config']) } = {}) {
  let copied = 0;
  const walk = (rel) => {
    const from = rel ? path.join(srcDir, rel) : srcDir;
    const to = rel ? path.join(dstDir, rel) : dstDir;
    fs.mkdirSync(to, { recursive: true });
    for (const e of fs.readdirSync(from, { withFileTypes: true })) {
      if (preserve.has(e.name)) continue;
      const f = rel ? path.join(rel, e.name) : e.name;
      if (e.isDirectory()) walk(f);
      else { fs.copyFileSync(path.join(srcDir, f), path.join(dstDir, f)); copied += 1; }
    }
  };
  walk('');
  return copied;
}

/**
 * 保证 NapCat 已安装且是最新一版。
 *
 * @param {{update?:boolean}} opt update=true 时，即使已装也会检查最新版并升级
 * @returns {Promise<{state:'ok'|'installed'|'updated'|'unchanged', tag?:string, home?:string}>}
 */
export async function ensureNapcat({ update = true } = {}) {
  const cur = napcatInstalled();
  const src = loadNapcatSource();
  const latest = await latestNapcatTag(src);
  const latestTag = latest || src.fallbackTag;

  if (!cur.found) {
    const r = await fetchNapcatZip(latestTag);
    ok(`下载完成：${humanSize(r.bytes)}（来源 ${r.url === '本地已有' ? '本地文件' : new URL(r.url).host}）`);
    unzip(NAPCAT_ZIP, NAPCAT_DIR);
    const home = flattenSingleDir(NAPCAT_DIR);
    if (!findNapcatLauncher()) {
      warn('解压后没找到启动器（launcher*.bat / NapCatWinBootMain.exe）');
      dim('      这不一定是错 —— 官方不同版本的文件名不同。到 app\\napcat 里看一眼。');
    }
    writeNapcatRecord({ tag: latestTag, home: path.relative(NAPCAT_DIR, home) });
    try { fs.rmSync(NAPCAT_ZIP, { force: true }); } catch { /* 删不掉无所谓 */ }
    ok(`NapCat ${latestTag} 已安装${latest ? '' : '（查不到最新版本，用了清单里的兜底版本）'}`);
    return { state: 'installed', tag: latestTag, home };
  }

  if (!update) return { state: 'unchanged', tag: cur.tag || cur.version };

  // 版本不明（不是本包装的）→ **不替换**。猜着换掉用户的东西，后果比不换严重。
  if (!cur.inferredFrom || cur.inferredFrom !== 'record') {
    dim(`  NapCat 已装（版本来源：${cur.inferredFrom || '未知'}）—— 不是本包装的，不自动替换`);
    return { state: 'unchanged' };
  }
  if (!latest) {
    dim(`  NapCat ${cur.version} 已在位（查不到最新版本，跳过更新）`);
    return { state: 'unchanged', tag: cur.tag };
  }
  if (gte(cur.version, String(latest).replace(/^v/, ''))) {
    ok(`NapCat ${cur.version} 已是最新（${latest}）`);
    return { state: 'unchanged', tag: cur.tag };
  }

  say(`  NapCat ${cur.version} → ${latest}，正在更新（**登录态与配置会保留**）…`);
  const home = napcatHome() || NAPCAT_DIR;
  const tmp = path.join(NAPCAT_DIR, '.update-tmp');
  rmrf(tmp);
  await fetchNapcatZip(latest);
  unzip(NAPCAT_ZIP, tmp);
  const srcDir = flattenSingleDir(tmp);
  const n = overlay(srcDir, home);
  rmrf(tmp);
  try { fs.rmSync(NAPCAT_ZIP, { force: true }); } catch { /* 无所谓 */ }
  writeNapcatRecord({ tag: latest, home: path.relative(NAPCAT_DIR, home) });
  ok(`NapCat 已更新到 ${latest}（覆盖 ${n} 个文件，config\\ 原样保留 —— 不用重新扫码）`);
  return { state: 'updated', tag: latest, home };
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
