#!/usr/bin/env node
/**
 * 从用户自己的电脑上**找**一份 NapCat 并装进 `userdata\napcat`。
 * 面板「自动查找并安装」调它。
 *
 * 为什么要有它（2026-10-19 维护者回执）：安装失败后面板只会说
 * "把解压好的文件夹放进 userdata\napcat"，而普通用户根本走不到
 * `%LOCALAPPDATA%\EstrellaBot\userdata`（原话："一直卡在 AppData 这一块，是没有这个东西的"）。
 * 让面板自己去找，用户只需要点一下。
 *
 * 纪律与安装器完全一致 —— **复用** `placeNapcatFromLocal`，不另写一份覆盖语义：
 *   · 只复制，绝不移动/删除原件；
 *   · 已经装过就不覆盖；
 *   · 路径安全闸、哈希登记、config 保留全走同一套。
 *
 * 输出最后一行固定为 `JSON:{...}`（面板据此判断结果）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainModule } from './lib/install-layout.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argOf = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? String(process.argv[i + 1] || '') : '';
};
const say = (s = '') => console.log(s);

const SKIP_DIRS = new Set([
  'node_modules', 'appdata', '.git', '$recycle.bin', 'system volume information',
  'windows', 'program files', 'program files (x86)',
]);

function launcherIn(dir, shape) {
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isFile() && shape.isNapcatLauncherName(e.name)) return path.join(dir, e.name);
    }
  } catch { /* 读不动就当他没有 */ }
  return null;
}

/** 广度有限的手工遍历：只读目录名，不读文件内容。 */
function scanRoot(root, maxDepth, found, shape, skipDirs) {
  const seen = new Set();
  const walk = (dir, depth) => {
    if (depth > maxDepth) return;
    const key = dir.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    if (skipDirs.some((s) => s && path.resolve(s).toLowerCase() === key)) return;
    if (launcherIn(dir, shape)) {
      try { found.folders.push({ src: dir, at: fs.statSync(dir).mtimeMs }); } catch { /* 时间拿不到就按 0 */ }
      return;
    }
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name.toLowerCase())) continue;
        walk(path.join(dir, e.name), depth + 1);
      } else if (e.isFile() && /^NapCat\.Shell\.zip$/i.test(e.name)) {
        const full = path.join(dir, e.name);
        try { found.zips.push({ src: full, at: fs.statSync(full).mtimeMs }); } catch { /* 同上 */ }
      }
    }
  };
  walk(root, 0);
}

async function main() {
  const installRoot = path.resolve(argOf('--install-root') || path.join(HERE, '..'));
  const userRootArg = argOf('--user-root');
  if (!userRootArg) {
    console.error('用法：node tools/import-napcat.mjs --install-root <安装根> --user-root <用户数据根> [--roots <目录1;目录2>]');
    process.exitCode = 2;
    return;
  }
  const userRoot = path.resolve(userRootArg);
  // 环境必须在 import common.mjs **之前**设好 —— 它在模块求值时就解析根。
  // 只覆盖用户根（安装版/便携版都认）；模式让它自己判 —— 强制 installed 在便携包里会找不到 install.json。
  process.env.QQBOT_USER_ROOT = userRoot;
  process.env.QQBOT_CONFIG = path.join(userRoot, 'config.json');

  const common = await import('./lib/common.mjs');
  const shape = await import('./lib/napcat-shape.mjs');
  const { placeNapcatFromLocal } = await import('./lib/napcat-local.mjs');
  const { napcatInstalled } = await import('./lib/versions.mjs');
  const { writeOnebotConfig } = await import('./setup.mjs');

  const out = (o) => console.log('JSON:' + JSON.stringify(o));

  const cur = napcatInstalled();
  if (cur.found) {
    out({ ok: true, action: 'already', home: cur.home, tag: cur.tag });
    return;
  }

  const rootsArg = argOf('--roots');
  const home = process.env.USERPROFILE || process.env.HOME || '';
  const roots = rootsArg
    ? rootsArg.split(/[;,]/).map((s) => s.trim()).filter(Boolean).map((dir) => ({ dir, depth: 4 }))
    : [
      { dir: path.join(home, 'Downloads'), depth: 4 },
      { dir: path.join(home, 'Desktop'), depth: 4 },
      { dir: path.join(home, 'Documents'), depth: 4 },
      { dir: home, depth: 2 },
    ];

  const found = { folders: [], zips: [] };
  const searched = [];
  for (const r of roots) {
    if (!r.dir || !fs.existsSync(r.dir)) continue;
    searched.push(r.dir);
    scanRoot(r.dir, r.depth, found, shape, [common.INSTALL_ROOT, common.USER_ROOT]);
  }

  const folder = found.folders.sort((a, b) => b.at - a.at)[0];
  const zip = found.zips.sort((a, b) => b.at - a.at)[0];
  // 优先用已解压的文件夹：不用再解压，也不会遇到"zip 里其实是安装壳"。
  const pick = folder ? { kind: 'folder', src: folder.src } : zip ? { kind: 'zip', src: zip.src } : null;
  if (!pick) {
    out({ ok: false, action: 'not-found', searched, candidates: [...found.folders, ...found.zips].map((x) => x.src) });
    return;
  }

  say(`· 找到 ${pick.kind === 'folder' ? '已解压的 NapCat 文件夹' : 'NapCat.Shell.zip'}：${pick.src}`);
  say('· 正在复制（原件不会被移动或删除）…');
  const r = await placeNapcatFromLocal({ kind: pick.kind, src: pick.src, installRoot, userRoot, srcText: pick.src });
  if (r.state === 'installed') {
    try { writeOnebotConfig(''); } catch { /* 模板写不进去不影响已经装好的协议端 */ }
    out({
      ok: true, action: 'imported', from: pick.src, kind: pick.kind,
      status: r.status, home: r.home, verification: r.verification, tag: r.tag || '',
    });
    return;
  }
  out({ ok: false, action: r.state || 'failed', from: pick.src, status: r.status, error: r.error || r.note || '' });
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(`查找失败：${e && e.message ? e.message : e}`);
    process.exitCode = 1;
  });
}
