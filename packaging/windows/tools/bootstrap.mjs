#!/usr/bin/env node
/**
 * 安装后的首次配置（P2 · 2026-10-18）。
 *
 * 由 NSIS 在 `install-commit.mjs` 成功后调用；用的是**新安装的** runtime。
 * 它只做三件事，且顺序固定：
 *   ① 旧便携数据迁移（只复制；失败不阻断安装，旧数据留在原处）
 *   ② 生成 config.json（已有配置永不覆盖）
 *   ③ 协议端（NapCat）四条路：跳过（默认）/ 用户自带的 zip / 用户已解压的目录 / 联网下载
 *     （P6 · 2026-10-18：以前只有"勾了就下载"，而 NSIS 进度条在外部进程里不会动，
 *      大陆网络下那份 35,884,742 B 的官方包实测 2.6–12.7 分钟（两个镜像差 5 倍，见 §21）—— 用户看见的就是"卡在最后一格"）
 *
 * 下载失败 / 迁移失败都**不阻断安装**：安装器已经成功，用户仍可打开控制台，
 * 之后重跑安装器或手工补装。只有“配置生成失败”才返回 1。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isMainModule, readInstallInfo, readJsonFile, resolveImportSource, writeJsonAtomic,
  installerAscii,
} from './lib/install-layout.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const say = (s = '') => console.log(installerAscii(s));
const sayErr = (s = '') => console.error(installerAscii(s));
const has = (...names) => names.some((n) => process.argv.includes(n));
function argOf(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? String(process.argv[i + 1] || '') : '';
}

async function main() {
  const installRoot = path.resolve(argOf('--install-root') || path.join(HERE, '..'));
  const install = readInstallInfo(installRoot);
  const userRoot = path.resolve(
    argOf('--user-root')
      || (install && install.userRoot ? path.resolve(installRoot, String(install.userRoot)) : '')
      || process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'EstrellaBot', 'userdata')
      || path.join(process.env.HOME || process.env.USERPROFILE || '.', 'EstrellaBot', 'userdata'),
  );
  const importFrom = argOf('--import-from');
  // P6：协议端从哪来。`skip` 是默认 —— 安装期不再默认塞一次以分钟计、且时长不确定的下载。
  //   skip   什么都不做（离线装好本体，协议端以后再说）
  //   zip    用户带来的 NapCat.Shell.zip（全程不联网）
  //   folder 用户已经解压好的 NapCat 目录（全程不联网）
  //   auto   联网下载（有超时与预算，永远不会挂住）
  // 没给 `--napcat-mode` 的老调用（含静默 `/INSTALLNAPCAT`）按 `--install-napcat` 走 auto，向后兼容。
  const napcatMode = (argOf('--napcat-mode') || '').toLowerCase();
  const napcatSrc = argOf('--napcat-src');
  const installNapcat = has('--install-napcat')
    ? !['0', 'false', 'no'].includes(argOf('--install-napcat').toLowerCase())
    : false;
  const mode = napcatMode || (installNapcat ? 'auto' : 'skip');
  const json = has('--json');

  if (!fs.existsSync(path.join(installRoot, 'current.json'))) {
    sayErr(`[x] bootstrap must run after install-commit (missing ${path.join(installRoot, 'current.json')})`);
    process.exitCode = 2;
    return;
  }

  process.env.QQBOT_MODE = 'installed';
  process.env.QQBOT_USER_ROOT = userRoot;
  process.env.QQBOT_CONFIG = path.join(userRoot, 'config.json');

  // 环境必须在 import common.mjs **之前**设好 —— 它在模块求值时就解析根。
  const common = await import('./lib/common.mjs');
  const { ensureConfigJson, writeOnebotConfig } = await import('./setup.mjs');
  const { ensureNapcat } = await import('./lib/repair.mjs');
  const { napcatInstalled } = await import('./lib/versions.mjs');
  const { NAPCAT_STATUS, napcatReasonText } = await import('./lib/napcat-local.mjs');
  const { migrateIfNeeded } = await import('./migrate.mjs');

  fs.mkdirSync(userRoot, { recursive: true });
  const warnings = [];
  say(`Estrella Bot ${common.VERSION} first-run configuration`);
  say(`user data root: ${userRoot}`);

  if (importFrom) {
    try {
      const src = resolveImportSource(importFrom);
      say(`- importing old data: ${src.source} (${src.layout})`);
      const mig = migrateIfNeeded({ source: src.source, userRoot, log: (m) => say(`  ${m}`) });
      if (mig.status === 'failed') {
        warnings.push(`old-data migration failed: ${mig.error || mig.reason || 'unknown reason'} (old data left in place)`);
      } else if (mig.status === 'complete') {
        say(`  [ok] copied ${mig.files} files (conflicts ${mig.conflicts.length})`);
      } else {
        say(`  skipped: ${mig.reason || 'nothing to migrate'}`);
      }
    } catch (e) {
      warnings.push(`old-data migration failed: ${e.message} (old data left in place)`);
    }
  }

  try {
    const r = ensureConfigJson();
    say(r.created ? '[ok] config.json created (allowed group list left empty)' : '- config.json already present, keeping user config');
    if (r.created) {
      // 安装版默认**浏览器标签页**。曾经默认 window（Edge --app 独立窗口 + 专用 profile），
      // 群友测试与 VM 复现（2026-10-18）证明那条路首跑必然先给用户一个**灰色空窗**：
      // 全新 profile 的首跑 UI（Edge 的同步/登录卡）+ 空白页一起出现，launch-log 里
      // opened=true 但屏幕上没有可用窗口，用户只能再双击一次图标。
      // 标签页走用户自己的浏览器 profile，没有首跑 UI；window 模式保留为可选设置。
      const cfgFile = path.join(userRoot, 'config.json');
      const cfg = readJsonFile(cfgFile);
      cfg.launch = { ...(cfg.launch && typeof cfg.launch === 'object' ? cfg.launch : {}), mode: 'browser' };
      writeJsonAtomic(cfgFile, cfg);
      say('[ok] installed default = browser tab (launch.mode=browser; a dedicated window stays selectable in settings)');
    }
  } catch (e) {
    sayErr(`[x] creating config.json failed: ${e.message}`);
    process.exitCode = 1;
    return;
  }

  // ── ③ 协议端（NapCat）：四条路，顺序即判据 ────────────────────────────────
  //
  // ⚠️ §114 用"下标顺序"钉住一件事：zip/folder 两支必须在任何
  //    `ensureNapcat(` / `latestNapcatRelease(` 之前 —— 用户自带件的那两条路
  //    一次网络都不许碰（"离线可用"这件事不能只写在注释里）。
  let napcatResult = { status: NAPCAT_STATUS.SKIPPED, state: 'skipped' };
  // 三行：令牌 / JSON / **ASCII 一句话原因**。
  // 第三行是给安装器弹窗用的 —— nsExec 按系统码页解码，中文在那里只能是乱码或 `?`。
  const writeNapcatStatus = (status, extra = {}) => {
    try {
      const dir = path.join(userRoot, 'update');
      fs.mkdirSync(dir, { recursive: true });
      const reason = napcatReasonText(extra.reason);
      fs.writeFileSync(path.join(dir, 'napcat-status.txt'), `${status}\n${JSON.stringify(extra)}\n${reason}\n`, 'utf8');
    } catch { /* 状态是给人看的，写不进去不影响安装结果 */ }
  };

  if (mode === 'zip' || mode === 'folder') {
    const { placeNapcatFromLocal } = await import('./lib/napcat-local.mjs');
    try {
      const r = await placeNapcatFromLocal({ kind: mode, src: napcatSrc, installRoot, userRoot, srcText: napcatSrc });
      napcatResult = r;
      writeNapcatStatus(r.status, { mode, sourcePath: r.sha256 ? napcatSrc : '', tag: r.tag || '', verification: r.verification, reason: r.reason || '' });
      if (r.state === 'installed') {
        try {
          const w = writeOnebotConfig('');
          say(`[ok] wrote OneBot template: ${path.relative(userRoot, w.tplDest)}`);
        } catch (e) { warnings.push(`OneBot template write failed: ${e.message}`); }
      } else {
        warnings.push(r.error || r.note || 'protocol side not installed (the app itself is unaffected)');
      }
    } catch (e) {
      napcatResult = { status: NAPCAT_STATUS.FAILED, state: 'failed' };
      writeNapcatStatus(NAPCAT_STATUS.FAILED, { mode, error: e.message, reason: 'placement-failed' });
      warnings.push(`protocol side placement failed: ${e.message} (app installed; re-run the installer and pick a route again)`);
    }
  } else if (mode === 'auto') {
    try {
      const n = await ensureNapcat({ update: false });
      napcatResult = { status: NAPCAT_STATUS.OK, state: n.state, tag: n.tag };
      writeNapcatStatus(NAPCAT_STATUS.OK, { mode: 'auto', tag: n.tag || '', reason: '' });
      say(`[ok] NapCat: ${n.state}${n.tag ? ` (${n.tag})` : ''}`);
      try {
        const w = writeOnebotConfig('');
        say(`[ok] wrote OneBot template: ${path.relative(userRoot, w.tplDest)}`);
      } catch (e) {
        warnings.push(`OneBot template write failed: ${e.message}`);
      }
    } catch (e) {
      const slow = e.code === 'DOWNLOAD_BUDGET' || e.code === 'DOWNLOAD_SLOW';
      const reason = e.code === 'NAPCAT_NO_LAUNCHER' ? 'zip-no-launcher'
        : e.code === 'DOWNLOAD_BUDGET' ? 'download-budget'
          : e.code === 'DOWNLOAD_SLOW' ? 'download-slow' : 'download-failed';
      napcatResult = { status: slow ? NAPCAT_STATUS.SLOW : NAPCAT_STATUS.FAILED, state: 'failed' };
      writeNapcatStatus(slow ? NAPCAT_STATUS.SLOW : NAPCAT_STATUS.FAILED, { mode: 'auto', code: e.code || '', error: e.message, reason });
      warnings.push(slow
        ? 'protocol side download did not finish (network too slow; the budget stopped it instead of waiting forever). Estrella Bot itself is installed: '
          + 're-run the installer and pick "I already have a package", or put the official NapCat.Shell.zip into userdata\\napcat\\ and re-run.'
        : `NapCat install failed: ${e.message} (re-run the installer to install it later)`);
    }
  } else {
    say('- protocol side (NapCat) not installed this time - this is the default, not a failure.');
    say('  to install it later without waiting on a download: (1) re-run the installer and pick'
      + ' "I already have a package", or (2) put the official NapCat.Shell.zip into userdata\\napcat\\ and re-run the installer.');
    writeNapcatStatus(NAPCAT_STATUS.SKIPPED, { mode: 'skip', reason: '' });
  }

  try {
    writeJsonAtomic(common.SETUP_MARKER, {
      version: common.VERSION,
      installedAt: new Date().toISOString(),
      // 记**事实**（现在有没有），不是意图（用户当初勾了什么）。
      napcatInstalled: Boolean(napcatInstalled().found),
      napcatStatus: napcatResult.status,
      napcatMode: mode,
    });
  } catch (e) {
    warnings.push(`writing setup-state.json failed: ${e.message}`);
  }

  for (const w of warnings) say(`[!] ${w}`);
  if (json) console.log(JSON.stringify({ ok: true, version: common.VERSION, userRoot, warnings }));
  say('[ok] first-run configuration complete');
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    sayErr(`[x] first-run configuration failed: ${e && e.message ? e.message : e}`);
    process.exitCode = 1;
  });
}
