/**
 * P4 回滚策略与 runtime 交换（2026-10-18）。
 *
 * 纯判据与可注入 fs 的交换动作分开：
 *   · `decideStartFailure` 只回答“这次失败该计数、回滚还是终止”；
 *   · `configRollbackGuard` 只回答“配置 schema 是否允许回滚”；
 *   · `swapRuntime` 做 `runtime/node` ↔ `runtime/node.previous` 的目录改名；
 *   · `preserveRollbackEvidence` 只复制日志/指针快照，不碰用户配置。
 *
 * Windows 上“正在运行的 exe 不能删、但可以改名”由 `lib/repair.mjs` 的
 * 换运行时流程实测过（文件映射按 ID 保持）；本模块沿用同一先例。
 */

import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from './install-layout.mjs';

export const FAILURE_THRESHOLD = 2;
export const ROLLBACK_LOG_MAX_BYTES = 256 * 1024;
export const EVIDENCE_KEEP = 20;

/**
 * @param {object} opt
 * @param {string} opt.current 当前版本
 * @param {string|null} opt.previous 上一版
 * @param {number} opt.failures 已连续失败次数（本次失败之前）
 * @param {boolean} [opt.previousValid]
 * @param {boolean} [opt.configSchemaOk]
 * @returns {{action:'count'|'rollback'|'terminal', failures:number, reason:string, blocked?:string}}
 */
export function decideStartFailure({
  current = '',
  previous = null,
  failures = 0,
  previousValid = true,
  configSchemaOk = true,
} = {}) {
  const cur = typeof current === 'string' ? current.trim() : '';
  const prev = typeof previous === 'string' ? previous.trim() : '';
  const n = Number.isInteger(failures) && failures >= 0 ? failures : 0;
  const next = n + 1;
  const base = { failures: next, current: cur, previous: prev };
  if (!cur) {
    return { ...base, action: 'terminal', reason: 'current.json 没有 current，无法判断回滚目标' };
  }
  if (!prev || prev === cur) {
    return {
      ...base,
      action: next >= FAILURE_THRESHOLD ? 'terminal' : 'count',
      reason: '没有可回滚的上一版（首装或同版本重装）',
    };
  }
  if (!previousValid) {
    return { ...base, action: 'terminal', reason: `上一版 ${prev} 的版本目录不合法` };
  }
  if (!configSchemaOk) {
    return {
      ...base,
      action: 'terminal',
      reason: '新版本已升级配置，回滚需先恢复备份',
      blocked: 'config-schema',
    };
  }
  if (next < FAILURE_THRESHOLD) {
    return { ...base, action: 'count', reason: `第 ${next} 次启动失败` };
  }
  return { ...base, action: 'rollback', reason: `连续 ${next} 次启动失败` };
}

/**
 * 配置前向迁移的失败闸：上一版支持的 schema 低于用户配置的 schema 时拒绝自动回滚。
 * 当前没有真正的迁移，缺省都按 1；首个改 schema 的版本负责写 `schemaVersion` 与备份。
 */
export function configRollbackGuard({ configSchema = 1, targetSupported = 1 } = {}) {
  const cur = Number.isInteger(configSchema) && configSchema > 0 ? configSchema : 1;
  const tgt = Number.isInteger(targetSupported) && targetSupported > 0 ? targetSupported : 1;
  if (tgt < cur) {
    return {
      ok: false,
      reason: `配置 schema=${cur}，上一版只支持 ${tgt}`,
      configSchema: cur,
      targetSupported: tgt,
    };
  }
  return { ok: true, configSchema: cur, targetSupported: tgt };
}

/** 从版本目录的 package.json 读 configSchema；缺省 1。 */
export function readConfigSchema(programRoot, { fsApi = fs } = {}) {
  try {
    const pkg = JSON.parse(fsApi.readFileSync(path.join(programRoot, 'package.json'), 'utf8'));
    const n = Number(pkg && pkg.configSchema);
    return Number.isInteger(n) && n > 0 ? n : 1;
  } catch {
    return 1;
  }
}

export function configBackupPath(userRoot, version) {
  return path.join(userRoot, `config-backup-${String(version || 'unknown')}.json`);
}

/** rollback.json 的内容；规格要求的 time/from/to/reason 都在顶层。 */
export function rollbackRecord({
  from = '',
  to = '',
  reason = '',
  failures = 0,
  runtimeRestored = false,
  result = 'ok',
  evidenceDir = '',
  configBackup = '',
  at = new Date().toISOString(),
} = {}) {
  return {
    schema: 1,
    at,
    from: String(from || ''),
    to: String(to || ''),
    reason: String(reason || ''),
    failures: Number.isInteger(failures) ? failures : 0,
    runtimeRestored: Boolean(runtimeRestored),
    result: String(result || 'ok'),
    evidenceDir: String(evidenceDir || ''),
    configBackup: String(configBackup || ''),
  };
}

function swapMarkerPath(installRoot) {
  return path.join(installRoot, 'runtime', '.swap.json');
}

export function readSwapMarker(installRoot, { fsApi = fs } = {}) {
  try {
    const obj = JSON.parse(fsApi.readFileSync(swapMarkerPath(installRoot), 'utf8'));
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : null;
  } catch {
    return null;
  }
}

export function writeSwapMarker(installRoot, marker, { fsApi = fs } = {}) {
  writeJsonAtomic(swapMarkerPath(installRoot), { schema: 1, at: new Date().toISOString(), ...marker }, { fsApi });
}

export function clearSwapMarker(installRoot, { fsApi = fs } = {}) {
  try { fsApi.rmSync(swapMarkerPath(installRoot), { force: true }); } catch { /* 下次按陈旧 marker 处理 */ }
}

/**
 * 把当前 runtime 换成 `runtime/node.previous`。
 * 任一步失败都尽量回到交换前的状态；返回 `ok:false` 时调用方**不得**翻 current.json。
 */
export function swapRuntime({ installRoot, stamp, fsApi = fs } = {}) {
  const runtime = path.join(installRoot, 'runtime');
  const node = path.join(runtime, 'node');
  const previous = path.join(runtime, 'node.previous');
  const failed = path.join(runtime, `node.failed-${stamp}`);
  const exists = (p) => { try { return fsApi.existsSync(p); } catch { return false; } };

  if (!exists(previous)) return { ok: true, swapped: false, reason: '没有 runtime/node.previous' };
  if (!exists(node)) return { ok: false, swapped: false, reason: `runtime/node 不存在：${node}` };
  if (exists(failed)) return { ok: false, swapped: false, reason: `回滚目标已存在：${failed}` };

  try {
    fsApi.renameSync(node, failed);
  } catch (e) {
    return { ok: false, swapped: false, reason: `runtime/node 改名失败：${e.message}` };
  }
  try {
    fsApi.renameSync(previous, node);
  } catch (e) {
    try {
      fsApi.renameSync(failed, node);
    } catch (e2) {
      return {
        ok: false,
        swapped: true,
        reason: `恢复 node.previous 失败：${e.message}；回退 node 也失败：${e2.message}`,
      };
    }
    return { ok: false, swapped: false, reason: `恢复 node.previous 失败：${e.message}` };
  }
  return { ok: true, swapped: true, failedDir: failed, restoreDir: node };
}

/** 给安装事务/验收一个“这一份 runtime 是谁装的”的证据。 */
export function writeRuntimeMarker({ installRoot, installedBy, nodeVersion = process.version, fsApi = fs } = {}) {
  const dir = path.join(installRoot, 'runtime', 'node');
  if (!fsApi.existsSync(dir)) return { ok: false, reason: `runtime/node 不存在：${dir}` };
  writeJsonAtomic(path.join(dir, '.runtime.json'), {
    schema: 1,
    nodeVersion: String(nodeVersion || ''),
    installedBy: String(installedBy || ''),
    at: new Date().toISOString(),
  }, { fsApi });
  return { ok: true };
}

function readTail(file, maxBytes, fsApi) {
  const st = fsApi.statSync(file);
  const len = Math.min(maxBytes, Number(st.size) || 0);
  if (len <= 0) return '';
  const buf = Buffer.alloc(len);
  const fd = fsApi.openSync(file, 'r');
  try {
    fsApi.readSync(fd, buf, 0, len, Math.max(0, st.size - len));
  } finally {
    try { fsApi.closeSync(fd); } catch { /* 已关 */ }
  }
  return buf.toString('utf8');
}

function pruneEvidence(logsDir, fsApi, keep) {
  try {
    const dirs = fsApi.readdirSync(logsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.startsWith('rollback-'))
      .map((e) => e.name)
      .sort();
    for (const name of dirs.slice(0, Math.max(0, dirs.length - keep))) {
      try { fsApi.rmSync(path.join(logsDir, name), { recursive: true, force: true }); } catch { /* 下次再清 */ }
    }
  } catch { /* 没有 logs 目录就没什么可清 */ }
}

/**
 * 回滚证据：只复制 panel.log 尾部与 current.json 快照，不复制 config.json。
 * 证据目录固定放在 `USER_ROOT/update/logs/rollback-<from>-<stamp>/`。
 */
export function preserveRollbackEvidence({
  installRoot,
  userRoot,
  from,
  to,
  reason,
  failures = 0,
  fsApi = fs,
  now = new Date(),
  keep = EVIDENCE_KEEP,
} = {}) {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const logs = path.join(userRoot, 'update', 'logs');
  const dir = path.join(logs, `rollback-${String(from || 'unknown')}-${stamp}`);
  try {
    fsApi.mkdirSync(dir, { recursive: true });
    const panelLog = path.join(userRoot, 'panel', 'panel.log');
    if (fsApi.existsSync(panelLog)) {
      const tail = readTail(panelLog, ROLLBACK_LOG_MAX_BYTES, fsApi);
      fsApi.writeFileSync(path.join(dir, 'panel.log.tail'), tail, 'utf8');
    }
    const currentFile = path.join(installRoot, 'current.json');
    if (fsApi.existsSync(currentFile)) {
      fsApi.copyFileSync(currentFile, path.join(dir, 'current.json'));
    }
    fsApi.writeFileSync(path.join(dir, 'reason.txt'), [
      `at=${now.toISOString()}`,
      `from=${from || ''}`,
      `to=${to || ''}`,
      `failures=${failures}`,
      `reason=${reason || ''}`,
      '',
    ].join('\n'), 'utf8');
    pruneEvidence(logs, fsApi, keep);
    return { ok: true, dir };
  } catch (e) {
    return { ok: false, dir, error: e.message };
  }
}
