#!/usr/bin/env node
/**
 * 生成更新清单 latest.json（P3 · 2026-10-18）。
 *
 * 生产默认地址是固定 GitHub Release 资产；测试可用 --installer-url/--notes-url
 * 指向本地 HTTP（必须同时给 --test，否则白名单会拒绝）。
 *
 * 用法：
 *   node packaging/windows/update/make-manifest.mjs \
 *     --exe <Estrella-Bot-Setup-x.y.z.exe> --version x.y.z --out <latest.json>
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { validateManifest } from '../../../panel/lib/update-manifest.js';
import { compareVersions } from '../../../panel/lib/update-version.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..', '..');

function argOf(name, fallback = '') {
  const i = process.argv.indexOf(name);
  return i >= 0 ? String(process.argv[i + 1] || '') : fallback;
}
const has = (name) => process.argv.includes(name);
const allowCurrent = has('--allow-current');

async function sha256File(file) {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function main() {
  const exe = path.resolve(argOf('--exe'));
  const version = argOf('--version');
  const out = path.resolve(argOf('--out'));
  if (!argOf('--exe') || !version || !argOf('--out')) {
    console.error('用法：node packaging/windows/update/make-manifest.mjs --exe <EXE> --version <ver> --out <latest.json> [--allow-current]');
    process.exit(2);
    return;
  }
  if (!fs.existsSync(exe)) throw new Error(`找不到 EXE：${exe}`);
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error(`version 不是语义化版本：${version}`);

  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
  const cmp = compareVersions(version, pkg.version);
  // 正式发布“当前版本”的清单时，version == package.json.version 是合法场景；
  // 只有显式 --allow-current 才放行，测试/日常构建仍要求严格高于当前版本。
  if (cmp === null || cmp < 0 || (cmp === 0 && !allowCurrent)) {
    throw new Error(`version 必须高于 package.json（${version} <= ${pkg.version}）${cmp === 0 ? '；发布当前版本请加 --allow-current' : ''}`);
  }
  if (cmp === 0) console.log('  （发布当前版本：--allow-current）');
  const appId = argOf('--app-id', pkg.appId);
  const base = 'https://github.com/Canvixel-Eloweny/ai-bot-groupmate';
  const installerUrl = argOf('--installer-url',
    `${base}/releases/download/v${version}/Estrella-Bot-Setup-${version}.exe`);
  const notesUrl = argOf('--notes-url', `${base}/releases/tag/v${version}`);
  const now = new Date();
  const expires = argOf('--expires-at', new Date(now.getTime() + 30 * 24 * 3600 * 1000).toISOString());
  const mirrors = argOf('--mirrors').split(',').map((s) => s.trim()).filter(Boolean);
  const testMode = has('--test');

  const size = fs.statSync(exe).size;
  const sha256 = await sha256File(exe);
  const manifest = {
    schemaVersion: 1,
    appId,
    channel: 'stable',
    version,
    minVersion: argOf('--min-version', '0.1.0'),
    minWindows: argOf('--min-windows', '10.0.17763'),
    generatedAt: now.toISOString(),
    expiresAt: expires,
    notesUrl,
    installer: {
      kind: 'nsis',
      url: installerUrl,
      mirrors,
      size,
      sha256,
    },
  };

  const check = validateManifest(manifest, {
    currentVersion: pkg.version,
    appId,
    windowsVersion: '10.0.17763',
    testMode,
  });
  if (!check.ok) throw new Error(`清单自校验失败：\n  - ${check.errors.join('\n  - ')}`);
  if (path.basename(exe) !== `Estrella-Bot-Setup-${version}.exe`) {
    console.warn(`⚠ EXE 文件名不是 Estrella-Bot-Setup-${version}.exe：${path.basename(exe)}`);
  }

  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log(`✓ 清单：${out}`);
  console.log(`  version=${version} size=${size} sha256=${sha256.slice(0, 16)}…`);
  console.log(`  installer=${installerUrl}`);
}

main().catch((e) => {
  console.error(`✗ ${e && e.message ? e.message : e}`);
  process.exitCode = 1;
});
