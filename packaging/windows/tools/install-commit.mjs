#!/usr/bin/env node
/**
 * 安装提交事务（P2 · 2026-10-18）。
 *
 * 为什么事务在 Node 里而不是 NSIS 里：
 *   NSIS 适合做向导与解包，但“停进程 → 备份 → 换目录 → 原子写指针 → 失败恢复”
 *   是一串需要逐条判断的回滚动作，写在 .nsi 里既难测试也难以在 macOS 上验证。
 *   这里只用 node: 内置 + `install-layout.mjs`，可以在本机用假目录完整跑。
 *
 * 三条铁律：
 *   ① **只复制 stage，绝不 rename/move stage** —— 本进程正从 stage 的 runtime/node 运行；
 *   ② **先停应用**（含机器人）再换 runtime，停不掉就整体失败；
 *   ③ 任何一步失败都按 `versions/.txn.json` 恢复，旧 `current.json` 不动。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  assertUserRootOutsideInstallRoot,
  assertWritableDir,
  compareVersions,
  isMainModule,
  pathEq,
  readCurrentInfo,
  readInstallInfo,
  readPackageInfo,
  readJsonFile,
  sha256FileSync,
  verifyPayloadManifest,
  writeJsonAtomic,
} from './lib/install-layout.mjs';
import { stopInstalledApp } from './stop.mjs';
import { writeRuntimeMarker } from './lib/rollback.mjs';
import { say, sayErr } from './lib/common.mjs';

const IS_WIN = process.platform === 'win32';
const STABLE_DIRS = ['tools', 'launcher', 'resources'];
const ROOT_FILES = ['README.html', 'LICENSE', 'THIRD-PARTY-NOTICES.md', 'BUILD-INFO.txt'];

const has = (...names) => names.some((n) => process.argv.includes(n));
function argOf(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? String(process.argv[i + 1] || '') : '';
}
const ts = () => new Date().toISOString().replace(/[:.]/g, '-');

const exists = (p) => { try { return fs.existsSync(p); } catch { return false; } };
const rm = (p) => { try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* best effort */ } };
const copyDir = (src, dest) => {
  if (!exists(src)) throw new Error(`payload 缺目录：${src}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, { recursive: true, force: true, errorOnExist: false, preserveTimestamps: true });
};
const copyFile = (src, dest) => {
  if (!exists(src)) throw new Error(`payload 缺文件：${src}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
};

function defaultUserRoot(installRoot) {
  const existing = readInstallInfo(installRoot);
  if (existing && existing.userRoot) return path.resolve(installRoot, String(existing.userRoot));
  const local = process.env.LOCALAPPDATA
    || (IS_WIN ? path.join(os.homedir(), 'AppData', 'Local') : path.join(os.homedir(), '.local', 'share'));
  return path.join(local, 'EstrellaBot', 'userdata');
}

function writeMarker(userRoot, appId) {
  fs.mkdirSync(userRoot, { recursive: true });
  fs.writeFileSync(path.join(userRoot, '.estrellabot-user-root'), `${JSON.stringify({
    appId, createdAt: new Date().toISOString(),
  })}\n`, { encoding: 'utf8', mode: 0o600 });
}

function journalFileOf(installRoot) {
  return path.join(installRoot, 'versions', '.txn.json');
}

/**
 * 按 journal 恢复。只恢复 journal 里登记过的 target/backup；
 * 不碰 user data（除了恢复旧的 install.json/current.json 指针）。
 */
export function restoreJournal(installRoot, journal, log = () => {}) {
  const errors = [];
  for (const entry of [...(journal.entries || [])].reverse()) {
    try {
      const target = entry.target;
      const backup = entry.backup;
      if (backup && exists(backup)) {
        if (exists(target)) rm(target);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.renameSync(backup, target);
        log(`- restored ${path.relative(installRoot, target)}`);
      } else if (entry.created && exists(target)) {
        rm(target);
        log(`- removed file created by this run ${path.relative(installRoot, target)}`);
      }
    } catch (e) {
      errors.push(`恢复 ${entry.target} 失败：${e.message}`);
    }
  }
  try {
    const installFile = path.join(installRoot, 'install.json');
    if (journal.hadInstall) writeJsonAtomic(installFile, journal.oldInstall);
    else if (exists(installFile)) rm(installFile);
    const currentFile = path.join(installRoot, 'current.json');
    if (journal.hadCurrent) writeJsonAtomic(currentFile, journal.oldCurrent);
    else if (exists(currentFile)) rm(currentFile);
  } catch (e) {
    errors.push(`恢复 install.json/current.json 失败：${e.message}`);
  }
  return errors;
}

function recoverStaleJournal(installRoot, log) {
  const file = journalFileOf(installRoot);
  if (!exists(file)) return;
  let journal;
  try { journal = readJsonFile(file); } catch (e) {
    throw new Error(`上次安装的 .txn.json 读不出来（${file}）：${e.message}`);
  }
  if (!journal || journal.schema !== 1) throw new Error(`上次安装的 .txn.json 形状不对：${file}`);
  if (journal.status === 'committed') return;
  // 幂等：指针已经是 journal.version 且版本目录合法 ⇒ 上次其实已提交，只差最后一行状态。
  // 没有这一条，断电落在“指针写完、状态未写”之间会把一次成功安装回滚掉。
  if (journal.status !== 'restore_failed' && journal.version) {
    let cur = null;
    let inst = null;
    try { cur = readCurrentInfo(installRoot); } catch { cur = null; }
    try { inst = readInstallInfo(installRoot); } catch { inst = null; }
    const appPkg = path.join(installRoot, 'versions', journal.version, 'app', 'package.json');
    if (cur && cur.current === journal.version && inst && inst.installedVersion === journal.version && exists(appPkg)) {
      writeJsonAtomic(file, { ...journal, status: 'committed', committedAt: new Date().toISOString() });
      log('- last journal already points at the new version; treating it as committed (no restore)');
      return;
    }
  }
  log(`found an unfinished install transaction (${journal.status}); restoring first...`);
  const errors = restoreJournal(installRoot, journal, log);
  if (errors.length) {
    writeJsonAtomic(file, { ...journal, status: 'restore_failed', restoreErrors: errors, recoveredAt: new Date().toISOString() });
    throw new Error(`previous install incomplete and restore failed:\n  - ${errors.join('\n  - ')}`);
  }
  writeJsonAtomic(file, { ...journal, status: 'recovered', recoveredAt: new Date().toISOString() });
  log('- last transaction restored; continuing this install');
}

let faultCounts = {};
/** 仅测试用：`QQBOT_INSTALL_TEST=1` + `QQBOT_INSTALL_FAULT=<point>[:n]` 在指定点退出 97。 */
function fault(point) {
  if (process.env.QQBOT_INSTALL_TEST !== '1') return;
  const spec = String(process.env.QQBOT_INSTALL_FAULT || '').trim();
  if (!spec) return;
  const [name, nthRaw] = spec.split(':');
  if (name !== point) return;
  const nth = Math.max(1, Number.parseInt(nthRaw || '1', 10) || 1);
  faultCounts[point] = (faultCounts[point] || 0) + 1;
  if (faultCounts[point] >= nth) {
    say(`[x] test fault injection: ${point} (count ${faultCounts[point]})`);
    process.exit(97);
  }
}

function existingVersion(installRoot) {
  const install = readInstallInfo(installRoot);
  const current = readCurrentInfo(installRoot);
  const fromInstall = install && typeof install.installedVersion === 'string' ? install.installedVersion : '';
  const fromCurrent = current && typeof current.current === 'string' ? current.current : '';
  if (fromInstall && fromCurrent && fromInstall !== fromCurrent) {
    // 不一致时以 current 为准（它才是启动器实际会用的），但把两个都留给日志。
    return { version: fromCurrent, installVersion: fromInstall, currentVersion: fromCurrent, install, current };
  }
  return { version: fromInstall || fromCurrent || '', install, current };
}

function swapIn({ target, newPath, backup, entries, persist, log }) {
  if (typeof persist !== 'function') throw new Error('swapIn 需要 persist 回调');
  const targetExists = exists(target);
  if (targetExists && !backup) throw new Error(`内部错误：${target} 存在但没有备份路径`);
  const entry = {
    target,
    backup: targetExists ? backup : '',
    created: !targetExists,
  };
  entries.push(entry);
  // 必须先落盘再改名：否则断电后磁盘 journal 里没有这条 entry，restoreJournal 无从下手。
  persist();
  fault('after-journal');
  if (targetExists) {
    fs.renameSync(target, entry.backup);
    log(`- backed up ${path.basename(target)} -> ${path.basename(entry.backup)}`);
  }
  fault('after-backup');
  fs.renameSync(newPath, target);
  fault('after-swap');
  log(`- placed ${path.basename(target)}`);
}

function prepareDir(installRoot, stage, name, stamp, entries, persist, log) {
  const src = path.join(stage, name);
  if (!exists(src)) return false;
  const target = path.join(installRoot, name);
  const newPath = `${target}.new-${stamp}`;
  rm(newPath);
  copyDir(src, newPath);
  swapIn({ target, newPath, backup: `${target}.old-${stamp}`, entries, persist, log });
  return true;
}

function prepareFile(installRoot, stage, name, stamp, entries, persist, log) {
  const src = path.join(stage, name);
  if (!exists(src)) return false;
  const target = path.join(installRoot, name);
  const newPath = `${target}.new-${stamp}`;
  rm(newPath);
  copyFile(src, newPath);
  swapIn({ target, newPath, backup: `${target}.old-${stamp}`, entries, persist, log });
  return true;
}

async function main() {
  const installRoot = path.resolve(argOf('--install-root') || process.argv[2] || '');
  const stage = path.resolve(argOf('--stage') || '');
  const versionArg = argOf('--version');
  const importFrom = argOf('--import-from');
  const installNapcat = has('--install-napcat')
    ? !['0', 'false', 'no'].includes(argOf('--install-napcat').toLowerCase())
    : false;
  // P6：协议端的来源（skip|zip|folder|auto）与用户自带的件路径。**这里只记账，不放包** ——
  // 放置发生在 bootstrap（提交之后），所以放包失败永远不会进入回滚路径。
  const napcatMode = (argOf('--napcat-mode') || '').toLowerCase();
  const napcatSrc = argOf('--napcat-src');
  const json = has('--json');

  if (!installRoot || !stage) {
    sayErr('usage: node tools/install-commit.mjs --install-root <install-root> --stage <stage> --version <version> [--user-root <data-root>] [--import-from <old-root>] [--install-napcat 0|1] [--napcat-mode skip|zip|folder|auto] [--napcat-src <local-path>]');
    process.exitCode = 2;
    return;
  }
  if (!exists(path.join(stage, 'payload-manifest.json'))) throw new Error(`stage 缺 payload-manifest.json：${stage}`);
  const stagePkg = readPackageInfo(path.join(stage, 'app'));
  const version = versionArg || stagePkg.version;
  if (version !== stagePkg.version) throw new Error(`--version=${version} 与 stage 的 package.json=${stagePkg.version} 不一致`);
  const manifest = verifyPayloadManifest(stage, {
    expectedVersion: version,
    expectedAppId: stagePkg.appId,
  });
  if (!manifest.ok) throw new Error(`payload 校验失败：\n  - ${manifest.errors.join('\n  - ')}`);
  for (const rel of ['app', 'runtime/node', 'tools', 'launcher']) {
    if (!exists(path.join(stage, rel))) throw new Error(`payload 缺 ${rel}/`);
  }
  if (IS_WIN && !exists(path.join(stage, 'runtime', 'node', 'node.exe'))) {
    throw new Error('payload 的 runtime/node/node.exe 不存在');
  }
  say(`installing Estrella Bot ${version} -> ${installRoot}`);
  say(`payload: ${manifest.count} files (manifest verified)`);

  fs.mkdirSync(installRoot, { recursive: true });
  fs.mkdirSync(path.join(installRoot, 'versions'), { recursive: true });
  recoverStaleJournal(installRoot, say);

  const old = existingVersion(installRoot);
  if (old.version) {
    const cmp = compareVersions(version, old.version);
    if (cmp === null) throw new Error(`版本号无法比较：当前 ${old.version} / 目标 ${version}`);
    if (cmp < 0) throw new Error(`拒绝降级：当前 ${old.version}，目标是 ${version}`);
  }
  const sameVersion = old.version === version;
  const previous = sameVersion
    ? (old.current && typeof old.current.previous === 'string' ? old.current.previous : null)
    : (old.version || (old.current && typeof old.current.previous === 'string' ? old.current.previous : null));

  // userRoot：升级优先沿用旧 install.json.userRoot；显式传入只允许首次或完全一致。
  const argUserRoot = argOf('--user-root');
  const existingUserRoot = old.install && old.install.userRoot
    ? path.resolve(installRoot, String(old.install.userRoot))
    : '';
  if (argUserRoot && existingUserRoot && !pathEq(argUserRoot, existingUserRoot)) {
    throw new Error(`安装器传入的 userRoot=${argUserRoot} 与已有 install.json=${existingUserRoot} 不一致；`
      + '为避免数据搬家，拒绝覆盖。要换数据根请先卸载/手工迁移。');
  }
  const userRoot = path.resolve(existingUserRoot || argUserRoot || defaultUserRoot(installRoot));
  const guard = assertUserRootOutsideInstallRoot({ installRoot, userRoot });
  if (!guard.ok) throw new Error(guard.error);
  assertWritableDir(userRoot);
  writeMarker(userRoot, stagePkg.appId);
  say(`user data root: ${userRoot}`);

  // ① 先停应用（含机器人）——runtime 被占用时后面每一步都会失败。
  const stop = await stopInstalledApp({
    installRoot,
    userRoot,
    timeoutMs: 30000,
    includeShell: true,
    log: (m) => say(m),
  });
  if (!stop.ok) throw new Error(`应用没能停干净，拒绝替换 runtime：\n  - ${stop.errors.join('\n  - ')}`);

  // ② 事务日志：在任何目录交换之前落盘。
  const stamp = `${version}-${ts()}`;
  const journalFile = journalFileOf(installRoot);
  const journal = {
    schema: 1,
    status: 'in_progress',
    startedAt: new Date().toISOString(),
    version,
    previous,
    installRoot,
    userRoot,
    hadInstall: Boolean(old.install),
    oldInstall: old.install || null,
    hadCurrent: Boolean(old.current),
    oldCurrent: old.current || null,
    entries: [],
  };
  writeJsonAtomic(journalFile, journal);
  const entries = journal.entries;
  // 每次 swap 前都把 entries 落盘；这是断电恢复的唯一依据。
  const persistJournal = () => writeJsonAtomic(journalFile, { ...journal, entries });

  try {
    // ③ 版本目录：复制 stage/app → versions/<ver>.new → 换入。
    const versionTarget = path.join(installRoot, 'versions', version);
    const versionNew = `${versionTarget}.new-${stamp}`;
    rm(versionNew);
    // 最终布局是 versions/<ver>/app；不能把 stage/app 的内容直接铺在版本目录根上。
    copyDir(path.join(stage, 'app'), path.join(versionNew, 'app'));
    const copiedPkg = readPackageInfo(path.join(versionNew, 'app'));
    if (copiedPkg.version !== version) throw new Error(`复制后的版本不对：${copiedPkg.version} ≠ ${version}`);
    // manifest 里每个 app 文件的哈希已由 verifyPayloadManifest 校验过；这里只再算一次
    // package.json，防止复制过程被截断（大目录复制最常见的失败形态）。
    if (sha256FileSync(path.join(versionNew, 'app', 'package.json')) !== sha256FileSync(path.join(stage, 'app', 'package.json'))) {
      throw new Error('version 目录的 package.json 复制后哈希不一致');
    }
    swapIn({
      target: versionTarget,
      newPath: versionNew,
      backup: `${versionTarget}.old-${stamp}`,
      entries,
      persist: persistJournal,
      log: say,
    });

    // ④ runtime：先把新运行时复制到位，再把旧目录备份成规格要求的 runtime/node.previous。
    const runtimeRoot = path.join(installRoot, 'runtime');
    fs.mkdirSync(runtimeRoot, { recursive: true });
    const nodeTarget = path.join(runtimeRoot, 'node');
    const nodePrev = path.join(runtimeRoot, 'node.previous');
    const nodePrevOld = path.join(runtimeRoot, `node.previous.old-${stamp}`);
    const nodeNew = path.join(runtimeRoot, `node.new-${stamp}`);
    // 先把新 runtime 复制到位，再动旧的 node.previous —— 复制 100 MB+ 期间断电时，
    // 旧备份必须还在，否则 restoreJournal 只能把旧 runtime 放回 node，下一次回滚就没有 runtime 可换。
    rm(nodeNew);
    copyDir(path.join(stage, 'runtime', 'node'), nodeNew);
    if (exists(nodePrev)) {
      // 旧的 node.previous 不能直接删：它是“上一次 runtime”的唯一备份。
      // 先改名并写进 journal，再让 swapIn 用它当本次的 backup；成功后由 retention 清掉这份改名残留。
      rm(nodePrevOld);
      const entry = { target: nodePrev, backup: nodePrevOld, created: false };
      entries.push(entry);
      persistJournal();
      try {
        fs.renameSync(nodePrev, nodePrevOld);
      } catch (e) {
        throw new Error(`旧的 runtime/node.previous 移不开（可能被占用）：${nodePrev}：${e.message}`);
      }
      say(`- moved aside runtime/node.previous -> ${path.basename(nodePrevOld)}`);
    }
    swapIn({
      target: nodeTarget,
      newPath: nodeNew,
      backup: nodePrev,
      entries,
      persist: persistJournal,
      log: say,
    });
    // 给真机验收留一个“这份 runtime 是谁装的”证据（回滚交换会把它一起带回去）。
    try {
      const marker = writeRuntimeMarker({ installRoot, installedBy: version });
      if (!marker.ok) say(`[!] skipped runtime/.runtime.json: ${marker.reason}`);
    } catch (e) {
      say(`[!] writing runtime/.runtime.json failed (install continues): ${e.message}`);
    }

    // ⑤ 稳定目录 + 根文件（只换安装根里的程序侧文件）。
    for (const name of STABLE_DIRS) prepareDir(installRoot, stage, name, stamp, entries, persistJournal, say);
    for (const name of ROOT_FILES) prepareFile(installRoot, stage, name, stamp, entries, persistJournal, say);

    // ⑥ 指针最后写：install.json → current.json。
    const installInfo = {
      schema: 1,
      appId: stagePkg.appId,
      displayName: 'Estrella Bot',
      installRoot,
      userRoot,
      installedVersion: version,
      installedAt: new Date().toISOString(),
    };
    writeJsonAtomic(path.join(installRoot, 'install.json'), installInfo);
    const currentInfo = {
      schema: 1,
      current: version,
      previous: previous || null,
      health: 'pending',
      failures: 0,
      updatedAt: new Date().toISOString(),
    };
    writeJsonAtomic(path.join(installRoot, 'current.json'), currentInfo);

    // ⑦ 给 bootstrap 的请求（导入源 / 协议端怎么来）；失败不影响安装。
    try {
      writeJsonAtomic(path.join(userRoot, 'update', 'install-request.json'), {
        version,
        importFrom: importFrom || '',
        installNapcat,
        napcatMode: napcatMode || (installNapcat ? 'auto' : 'skip'),
        napcatSrc: napcatSrc || '',
        at: new Date().toISOString(),
      });
    } catch (e) {
      say(`[!] writing install-request.json failed (install continues): ${e.message}`);
    }

    writeJsonAtomic(journalFile, { ...journal, status: 'committed', committedAt: new Date().toISOString() });
    say(`[ok] install committed: current=${version} previous=${previous || '-'}`);
    if (json) {
      console.log(JSON.stringify({ ok: true, version, previous, installRoot, userRoot, files: manifest.count }));
    }
  } catch (e) {
    say(`[x] install commit failed: ${e.message}`);
    // 失败现场留一份文本日志：NSIS 的 details 在 silent 模式下拿不到，
    // 而“为什么失败”只能靠这里留下来。
    try {
      const dir = path.join(userRoot, 'update', 'logs');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `install-${ts()}.log`), `${new Date().toISOString()}\n${e.stack || e}\n`, 'utf8');
    } catch { /* 日志写不进去不遮蔽原错误 */ }
    const errors = restoreJournal(installRoot, journal, say);
    writeJsonAtomic(journalFile, {
      ...journal,
      status: errors.length ? 'restore_failed' : 'failed',
      error: e.message,
      restoreErrors: errors,
      failedAt: new Date().toISOString(),
    });
    if (errors.length) say(`[x] restore failed too:\n  - ${errors.join('\n  - ')}`);
    throw e;
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    sayErr(`[x] ${e && e.message ? e.message : e}`);
    process.exitCode = 1;
  });
}
