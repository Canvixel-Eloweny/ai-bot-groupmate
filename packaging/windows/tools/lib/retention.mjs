/**
 * P4 版本保留策略（2026-10-18）。
 *
 * 判据三条：
 *   ① 只保留 current 与 previous 两个 semver 版本目录；
 *   ② 只删**程序文件**（versions / runtime 的直接子目录），绝不进入 USER_ROOT；
 *   ③ 任何不确定都朝 fail-safe：current 缺失、名字不认识、软链、正在运行的 runtime 都不动。
 *
 * `planRetention` 是纯函数；`applyRetention` 只执行计划，且对每个目标再校验一遍父目录。
 */

import fs from 'node:fs';
import path from 'node:path';

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
/** install-commit 的改目录残留：`<ver>.old-<stamp>` / `<ver>.new-<stamp>`。 */
const RESIDUE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\.(?:old|new)-/;
const RUNTIME_RESIDUE = /^node\.(?:previous|failed|new|old)(?:$|[-.])/;

function realOrResolved(p, fsApi) {
  try { return fsApi.realpathSync(p); } catch { return path.resolve(p); }
}

function isInside(parent, child, platform = process.platform) {
  const p = platform === 'win32' ? path.win32 : path;
  const a = p.resolve(parent);
  const b = p.resolve(child);
  const fold = (s) => (platform === 'win32' ? s.toLowerCase() : s);
  const aa = fold(a);
  const bb = fold(b);
  return bb === aa || bb.startsWith(`${aa}${p.sep}`);
}

export function listEntries(dir, { fsApi = fs } = {}) {
  try {
    return fsApi.readdirSync(dir, { withFileTypes: true }).map((e) => ({
      name: e.name,
      path: path.join(dir, e.name),
      isDirectory: e.isDirectory(),
      isSymlink: e.isSymbolicLink(),
    }));
  } catch {
    return [];
  }
}

/**
 * @param {object} opt
 * @param {Array} [opt.versions] versions/ 的直接子项 `{name,path,isDirectory,isSymlink}`
 * @param {Array} [opt.runtime] runtime/ 的直接子项
 * @param {string} [opt.current]
 * @param {string|null} [opt.previous]
 * @param {string} [opt.execPath] 当前 launcher 的 node 可执行文件
 * @param {string} [opt.platform]
 */
export function planRetention({
  versions = [],
  runtime = [],
  current = '',
  previous = null,
  execPath = '',
  platform = process.platform,
} = {}) {
  const cur = String(current || '');
  const prev = previous == null ? '' : String(previous || '');
  const keep = new Set([cur, prev].filter(Boolean));
  if (!cur) {
    return { versionsToRemove: [], runtimeToRemove: [], skipped: 'no-current', keep: [...keep] };
  }

  const versionsToRemove = [];
  const skippedVersions = [];
  for (const e of versions) {
    if (!e || typeof e.name !== 'string' || !e.name) continue;
    if (e.isSymlink) { skippedVersions.push(e.name); continue; }
    if (!e.isDirectory) continue;
    if (keep.has(e.name)) continue;
    if (SEMVER.test(e.name) || RESIDUE.test(e.name)) versionsToRemove.push(e.name);
    else skippedVersions.push(e.name);
  }

  const exec = execPath ? realOrResolved(execPath, fs) : '';
  const runtimeToRemove = [];
  const skippedRuntime = [];
  for (const e of runtime) {
    if (!e || typeof e.name !== 'string' || !e.name) continue;
    if (e.isSymlink) { skippedRuntime.push(e.name); continue; }
    if (e.name === 'node') continue;
    if (!RUNTIME_RESIDUE.test(e.name)) { skippedRuntime.push(e.name); continue; }
    if (exec && e.path && isInside(e.path, exec, platform)) { skippedRuntime.push(e.name); continue; }
    runtimeToRemove.push(e.name);
  }

  return {
    versionsToRemove,
    runtimeToRemove,
    skippedVersions,
    skippedRuntime,
    keep: [...keep],
  };
}

function safeChildName(name) {
  return typeof name === 'string' && name && name !== '.' && name !== '..'
    && !name.includes('/') && !name.includes('\\');
}

/**
 * 执行保留计划。只删 `installRoot/versions/<name>` 与 `installRoot/runtime/<name>`；
 * 每个目标都再校验父目录，删除失败只记录、不抛出。
 */
export function applyRetention({ installRoot, plan, fsApi = fs, log = () => {} } = {}) {
  const versionsDir = path.join(installRoot, 'versions');
  const runtimeDir = path.join(installRoot, 'runtime');
  const removed = [];
  const errors = [];

  for (const name of plan.versionsToRemove || []) {
    if (!safeChildName(name)) { errors.push(`非法版本目录名：${name}`); continue; }
    const target = path.join(versionsDir, name);
    if (path.dirname(path.resolve(target)) !== path.resolve(versionsDir)) {
      errors.push(`拒绝删除 versions 之外的路径：${target}`);
      continue;
    }
    try {
      fsApi.rmSync(target, { recursive: true, force: true });
      removed.push(target);
      log(`· 清理旧版本：${name}`);
    } catch (e) {
      errors.push(`清理 ${name} 失败：${e.message}`);
    }
  }

  for (const name of plan.runtimeToRemove || []) {
    if (!safeChildName(name)) { errors.push(`非法 runtime 目录名：${name}`); continue; }
    const target = path.join(runtimeDir, name);
    if (path.dirname(path.resolve(target)) !== path.resolve(runtimeDir)) {
      errors.push(`拒绝删除 runtime 之外的路径：${target}`);
      continue;
    }
    try {
      fsApi.rmSync(target, { recursive: true, force: true });
      removed.push(target);
      log(`· 清理旧 runtime：${name}`);
    } catch (e) {
      // launcher 自己可能正跑在 node.failed-* 里：Windows 会拒绝删，这是预期。
      errors.push(`清理 ${name} 失败：${e.message}`);
    }
  }

  return { removed, errors };
}
