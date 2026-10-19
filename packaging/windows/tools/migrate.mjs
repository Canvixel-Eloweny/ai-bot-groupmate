/**
 * 旧便携数据 → USER_ROOT 的**只复制**迁移（P1 · 2026-10-18）。
 *
 * 规则（P0 冻结）：
 *   · 只复制，绝不移动/删除源；源与目标相同（dev）直接 skipped。
 *   · 目标已有内容优先；冲突进 `.migration-conflicts/<ts>/`。
 *   · 不复制 token / pid / lock / bridge-cmd / effective / thinking / 日志 / console-profile。
 *   · NapCat 整树（config + QQ 登录态）复制；日志/缓存/update-tmp 除外。
 *   · marker 最后写；失败保留源并写 failed marker。
 *
 * 用法：
 *   node tools/migrate.mjs [--import-from <旧包根或旧 app>] [--user-root <dir>] [--dry-run] [--json]
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { USER_ROOT, PROGRAM_ROOT, isMain } from './lib/common.mjs';

const PANEL_FILES = [
  'audit.jsonl', 'local-trace.jsonl', 'session-archive.json', 'config-history.jsonl',
  'prompt-stats.json', 'style-profile.json', 'forward-probe.jsonl',
  'auto-memory.jsonl', 'memory-records.json', 'window-state.json', 'launch-log.jsonl',
];
const USAGE_RE = /^usage(-\d{4}-\d{2})?\.jsonl$/;
const TREE_DIRS = ['data', 'plugins', 'skills', 'persona'];
const NAPCAT_SKIP = new Set(['napcat.log', 'cache/qrcode.png', '.update-tmp']);
const SENSITIVE_NAMES = new Set(['config.json', '.env', 'config-history.jsonl', 'session-archive.json']);

const json = (v) => JSON.stringify(v, null, 2);
const nowIso = () => new Date().toISOString();
const hashFile = (file) => {
  try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
  catch { return ''; }
};
const safeLstat = (p) => { try { return fs.lstatSync(p); } catch { return null; } };
const isAlive = (pid) => {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try { process.kill(n, 0); return true; } catch { return false; }
};

function normalizeSource(source) {
  const abs = path.resolve(source);
  const app = path.join(abs, 'app');
  if (fs.existsSync(path.join(app, 'panel')) || fs.existsSync(path.join(app, 'config.json'))) {
    return { app, pkg: abs };
  }
  if (fs.existsSync(path.join(abs, 'panel')) || fs.existsSync(path.join(abs, 'config.json'))) {
    return { app: abs, pkg: path.dirname(abs) };
  }
  throw new Error(`源目录里找不到旧数据（需要 app/panel、app/config.json 或 panel/、config.json）：${abs}`);
}

function hasLegacyData(app) {
  return ['config.json', 'panel', 'data', 'plugins', 'skills', 'persona', 'napcat']
    .some((name) => fs.existsSync(path.join(app, name)));
}

function legacyBotAlive(app) {
  for (const name of ['.bridge.pid', '.bridge.lock']) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(app, 'panel', name), 'utf8'));
      if (j && isAlive(j.pid)) return true;
    } catch { /* 没有/坏文件 = 没在跑 */ }
  }
  return false;
}

function ensureDir(dir, dryRun) {
  if (dryRun) return;
  fs.mkdirSync(dir, { recursive: true });
}

function copyOneFile(src, dst, { dryRun, conflictsRoot, sensitive, result, conflictRel }) {
  const st = safeLstat(src);
  if (!st || !st.isFile()) return;
  if (fs.existsSync(dst)) {
    const target = safeLstat(dst);
    if (target && target.size > 0) {
      const rel = conflictRel || path.basename(dst);
      result.conflicts.push(rel);
      if (!dryRun) {
        const conflict = path.join(conflictsRoot, rel);
        fs.mkdirSync(path.dirname(conflict), { recursive: true });
        fs.copyFileSync(src, conflict);
      }
      result.skipped += 1;
      return;
    }
  }
  result.files += 1;
  result.bytes += st.size;
  if (dryRun) return;
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  const tmp = `${dst}.${process.pid}.migrate.tmp`;
  fs.copyFileSync(src, tmp);
  if (sensitive) { try { fs.chmodSync(tmp, 0o600); } catch { /* Windows 无 POSIX 权限 */ } }
  fs.renameSync(tmp, dst);
}

function copyTree(srcDir, dstDir, { dryRun, conflictsRoot, result, relPrefix = '', skipRel = null }) {
  const st = safeLstat(srcDir);
  if (!st || st.isSymbolicLink() || !st.isDirectory()) return;
  ensureDir(dstDir, dryRun);
  let entries = [];
  try { entries = fs.readdirSync(srcDir, { withFileTypes: true }); } catch { return; }
  for (const ent of entries) {
    const rel = relPrefix ? `${relPrefix}/${ent.name}` : ent.name;
    if (skipRel && skipRel(rel)) { result.skipped += 1; continue; }
    const src = path.join(srcDir, ent.name);
    const dst = path.join(dstDir, ent.name);
    if (ent.isSymbolicLink()) { result.skipped += 1; continue; }
    if (ent.isDirectory()) {
      copyTree(src, dst, { dryRun, conflictsRoot, result, relPrefix: rel, skipRel });
    } else if (ent.isFile()) {
      copyOneFile(src, dst, {
        dryRun, conflictsRoot, sensitive: SENSITIVE_NAMES.has(ent.name), result, conflictRel: rel,
      });
    }
  }
}

function writeMarker(file, value, dryRun) {
  if (dryRun) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.migrate.tmp`;
  fs.writeFileSync(tmp, `${json(value)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

/**
 * @returns {{status:'complete'|'skipped'|'failed'|'dry-run', ...}}
 */
export function migrate({
  source = PROGRAM_ROOT,
  userRoot = USER_ROOT,
  dryRun = false,
  log = () => {},
} = {}) {
  const root = path.resolve(userRoot);
  const markerFile = path.join(root, 'migration.json');
  const configDest = process.env.QQBOT_CONFIG
    ? path.resolve(process.env.QQBOT_CONFIG)
    : path.join(root, 'config.json');
  const setupDest = path.join(root, 'setup-state.json');
  const napcatDest = path.join(root, 'napcat');
  const conflictsRoot = path.join(root, '.migration-conflicts', String(Date.now()));
  const startedAt = nowIso();

  const existing = (() => {
    try { return JSON.parse(fs.readFileSync(markerFile, 'utf8')); } catch { return null; }
  })();
  if (existing && existing.status === 'complete' && Number(existing.schema) >= 1) {
    return { status: 'skipped', reason: 'already-migrated', marker: existing };
  }

  let src;
  try { src = normalizeSource(source); }
  catch (e) { return { status: 'failed', reason: 'bad-source', error: e.message }; }

  if (path.resolve(src.app) === path.resolve(root) || path.resolve(src.pkg) === path.resolve(root)) {
    return { status: 'skipped', reason: 'source-equals-target' };
  }
  if (!hasLegacyData(src.app)) {
    if (!dryRun) writeMarker(markerFile, {
      schema: 1, status: 'complete', source: src.app, userRoot: root,
      startedAt, completedAt: nowIso(), counts: { files: 0, bytes: 0, skipped: 0, conflicts: 0 }, conflicts: [],
    }, dryRun);
    return { status: 'skipped', reason: 'no-legacy-data' };
  }
  if (legacyBotAlive(src.app)) {
    return { status: 'failed', reason: 'legacy-bot-running', error: '旧机器人仍在运行：先停止它再迁移' };
  }

  if (dryRun) {
    const result = { status: 'dry-run', source: src.app, userRoot: root, files: 0, bytes: 0, skipped: 0, conflicts: [] };
    collectOnly(src, root, result, dryRun);
    return result;
  }

  ensureDir(root, dryRun);
  const lockFile = path.join(root, '.migration.lock');
  try {
    fs.writeFileSync(lockFile, json({ pid: process.pid, at: Date.now() }), { flag: 'wx' });
  } catch {
    return { status: 'failed', reason: 'locked', error: `迁移锁已存在：${lockFile}（若确认没有别的迁移在跑，请手动检查/删除）` };
  }

  const result = { status: 'complete', source: src.app, userRoot: root, files: 0, bytes: 0, skipped: 0, conflicts: [] };
  try {
    writeMarker(markerFile, {
      schema: 1, status: 'in_progress', source: src.app, userRoot: root, startedAt,
      counts: { files: 0, bytes: 0, skipped: 0, conflicts: 0 }, conflicts: [],
    }, false);

    for (const name of ['config.json', '.env', '.qqbot-portable-setup.json']) {
      const from = path.join(src.app, name);
      if (!fs.existsSync(from)) {
        const alt = path.join(src.pkg, name);
        if (name === '.env' && fs.existsSync(alt)) {
          copyOneFile(alt, path.join(root, '.env'), { dryRun, conflictsRoot, sensitive: true, result });
        }
        continue;
      }
      const to = name === 'config.json' ? configDest
        : name === '.env' ? path.join(root, '.env') : setupDest;
      copyOneFile(from, to, {
        dryRun, conflictsRoot, sensitive: SENSITIVE_NAMES.has(name), result, conflictRel: name,
      });
    }

    for (const name of PANEL_FILES) {
      const from = path.join(src.app, 'panel', name);
      if (fs.existsSync(from)) {
        copyOneFile(from, path.join(root, 'panel', name), {
          dryRun, conflictsRoot, sensitive: SENSITIVE_NAMES.has(name), result,
          conflictRel: path.join('panel', name),
        });
      }
    }
    const panelDir = path.join(src.app, 'panel');
    if (fs.existsSync(panelDir)) {
      for (const name of fs.readdirSync(panelDir)) {
        if (!USAGE_RE.test(name)) continue;
        copyOneFile(path.join(panelDir, name), path.join(root, 'panel', name), {
          dryRun, conflictsRoot, result, conflictRel: path.join('panel', name),
        });
      }
    }

    for (const name of TREE_DIRS) {
      const from = path.join(src.app, name);
      if (fs.existsSync(from)) copyTree(from, path.join(root, name), { dryRun, conflictsRoot, result });
    }

    const napcatSrc = path.join(src.app, 'napcat');
    if (fs.existsSync(napcatSrc)) {
      copyTree(napcatSrc, napcatDest, {
        dryRun, conflictsRoot, result,
        skipRel: (rel) => NAPCAT_SKIP.has(rel) || rel.startsWith('.update-tmp/'),
      });
    }

    const configSha256 = fs.existsSync(configDest) ? hashFile(configDest) : '';
    if (configDest.endsWith('.json') && fs.existsSync(configDest)) {
      try { JSON.parse(fs.readFileSync(configDest, 'utf8').replace(/^\uFEFF/, '')); }
      catch (e) { throw new Error(`迁移后的 config.json 解析失败：${e.message}`); }
    }

    const done = {
      schema: 1, status: 'complete', source: src.app, userRoot: root,
      startedAt, completedAt: nowIso(),
      counts: { files: result.files, bytes: result.bytes, skipped: result.skipped, conflicts: result.conflicts.length },
      configSha256, conflicts: result.conflicts,
    };
    writeMarker(markerFile, done, false);
    log(`迁移完成：${result.files} 个文件 / ${result.bytes} 字节 / 冲突 ${result.conflicts.length}`);
    return { ...result, marker: done, configSha256 };
  } catch (e) {
    const failed = {
      schema: 1, status: 'failed', source: src.app, userRoot: root,
      startedAt, failedAt: nowIso(), error: e.message,
      counts: { files: result.files, bytes: result.bytes, skipped: result.skipped, conflicts: result.conflicts.length },
      conflicts: result.conflicts,
    };
    try { writeMarker(markerFile, failed, false); } catch { /* marker 也写不了就只返回错误 */ }
    return { ...result, status: 'failed', reason: 'copy-error', error: e.message, marker: failed };
  } finally {
    try { fs.unlinkSync(lockFile); } catch { /* 只删自己刚建的锁 */ }
  }
}

/** dry-run 只统计，不建目录/不写 marker。 */
function collectOnly(src, root, result, dryRun) {
  const fake = { dryRun: true, conflictsRoot: path.join(root, '.migration-conflicts', 'dry'), result };
  for (const name of ['config.json', '.env', '.qqbot-portable-setup.json']) {
    const from = path.join(src.app, name);
    if (fs.existsSync(from)) {
      const st = safeLstat(from); if (st) { result.files += 1; result.bytes += st.size; }
    }
  }
  for (const name of PANEL_FILES) {
    const from = path.join(src.app, 'panel', name);
    if (fs.existsSync(from)) { const st = safeLstat(from); if (st) { result.files += 1; result.bytes += st.size; } }
  }
  const panelDir = path.join(src.app, 'panel');
  if (fs.existsSync(panelDir)) {
    for (const name of fs.readdirSync(panelDir)) {
      if (!USAGE_RE.test(name)) continue;
      const st = safeLstat(path.join(panelDir, name));
      if (st) { result.files += 1; result.bytes += st.size; }
    }
  }
  for (const name of TREE_DIRS) {
    const from = path.join(src.app, name);
    if (fs.existsSync(from)) copyTree(from, path.join(root, name), fake);
  }
  if (fs.existsSync(path.join(src.app, 'napcat'))) {
    copyTree(path.join(src.app, 'napcat'), path.join(root, 'napcat'), {
      ...fake,
      skipRel: (rel) => NAPCAT_SKIP.has(rel) || rel.startsWith('.update-tmp/'),
    });
  }
}

/** setup/onekey 的入口：没有旧数据/已迁移/源=目标 ⇒ skipped。 */
export function migrateIfNeeded({ source = PROGRAM_ROOT, userRoot = USER_ROOT, log = () => {} } = {}) {
  return migrate({ source, userRoot, log });
}

function argOf(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? String(process.argv[i + 1] || '') : '';
}

if (isMain(import.meta.url)) {
  const result = migrate({
    source: argOf('--import-from') || PROGRAM_ROOT,
    userRoot: argOf('--user-root') || USER_ROOT,
    dryRun: process.argv.includes('--dry-run'),
    log: (s) => console.log(s),
  });
  if (process.argv.includes('--json')) console.log(json(result));
  else console.log(`${result.status}: ${result.reason || result.error || ''}`.trim());
  process.exit(result.status === 'failed' ? 1 : 0);
}
