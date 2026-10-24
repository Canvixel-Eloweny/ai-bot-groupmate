/**
 * 面板一键诊断包（P1-10 · 2026-10-23）。
 *
 * 只收集**固定清单**里的文件，不扫目录 —— 扫目录必然把 config.json / .token /
 * bridge.log（聊天正文）/ napcat 配置卷进来，而“排除名单”永远会漏一项。
 *
 * 所有文本逐行过 `maskSecrets` + `maskIdentifiers`；再过一遍凭据形态扫描，
 * 命中就把那一行替换成 `[REDACTED: ...]`（fail-closed，不把可疑行原样发出去）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { makeZip } from './zip.js';
import { readLastExit } from './last-exit.js';
import { stripBom } from '../../src/plugin-manifest.js';
import { tailLines } from '../../src/desktop/crash-record.js';
import { redactLines } from '../../src/redact-identifiers.js';

function readText(file, maxLines = 200) {
  try {
    return tailLines(fs.readFileSync(file, 'utf8'), maxLines);
  } catch {
    return '';
  }
}

function readJson(file) {
  try {
    return JSON.parse(stripBom(fs.readFileSync(file, 'utf8')));
  } catch {
    return null;
  }
}

function add(files, name, text) {
  const body = String(text ?? '');
  if (body.trim()) files[name] = body;
}

export function buildDiagnosticsBundle({
  userRoot,
  installRoot,
  programRoot,
  maskSecrets = (s) => s,
  knownIds = {},
  now = () => new Date(),
} = {}) {
  const files = {};
  const panelDir = path.join(userRoot, 'panel');
  const electronDir = path.join(userRoot, 'electron');
  const pkg = readJson(path.join(programRoot, 'package.json')) || {};
  const lastExit = readLastExit(path.join(panelDir, '.last-exit.json'));

  add(files, 'summary.json', JSON.stringify({
    schema: 1,
    generatedAt: now().toISOString(),
    appId: pkg.appId || '',
    appVersion: pkg.version || '',
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    panelPid: process.pid,
    panelUptimeSec: Math.round(process.uptime()),
    install: readJson(path.join(installRoot, 'install.json')),
    current: readJson(path.join(installRoot, 'current.json')),
    shell: readJson(path.join(panelDir, '.shell.json')),
    lastExit,
    rollback: readJson(path.join(userRoot, 'update', 'rollback.json')),
    updateState: readJson(path.join(userRoot, 'update', 'state.json')),
    buildInfo: readText(path.join(installRoot, 'BUILD-INFO.txt'), 40),
  }, null, 2));

  add(files, 'shell.log', readText(path.join(electronDir, 'shell.log'), 200));
  add(files, 'shell.log.1', readText(path.join(electronDir, 'shell.log.1'), 100));
  add(files, 'shell-exit.json', readText(path.join(electronDir, 'shell-exit.json'), 20));
  add(files, 'shell-events.jsonl', readText(path.join(electronDir, 'crashes', 'shell-events.jsonl'), 100));
  add(files, 'panel.log', readText(path.join(panelDir, 'panel.log'), 200));
  add(files, 'bridge-journal.log', readText(path.join(panelDir, 'bridge-journal.log'), 300));
  add(files, 'panel-exit.json', readText(path.join(panelDir, '.last-exit.json'), 20));
  add(files, 'panel-events.jsonl', readText(path.join(panelDir, 'crashes', 'panel-events.jsonl'), 100));
  add(files, 'current.json', readText(path.join(installRoot, 'current.json'), 80));
  add(files, 'install.json', readText(path.join(installRoot, 'install.json'), 80));
  add(files, 'BUILD-INFO.txt', readText(path.join(installRoot, 'BUILD-INFO.txt'), 40));
  add(files, 'rollback.json', readText(path.join(userRoot, 'update', 'rollback.json'), 80));
  add(files, 'update-state.json', readText(path.join(userRoot, 'update', 'state.json'), 80));

  try {
    const logDir = path.join(userRoot, 'update', 'logs');
    const names = fs.readdirSync(logDir)
      .filter((n) => n.endsWith('.log'))
      .sort()
      .slice(-5);
    for (const name of names) add(files, `update-${name}`, readText(path.join(logDir, name), 100));
  } catch { /* 没有更新日志很正常 */ }

  const redactions = [];
  for (const [name, text] of Object.entries(files)) {
    const r = redactLines(text, { maskSecrets, ...knownIds });
    files[name] = r.text;
    if (r.redactions.length) redactions.push({ file: name, hits: r.redactions });
  }
  add(files, 'manifest.json', JSON.stringify({
    schema: 1,
    generatedAt: now().toISOString(),
    files: Object.keys(files).sort(),
    redactions,
  }, null, 2));
  return { files, redactions };
}

export function buildDiagnosticsZip(bundle) {
  const entries = Object.entries(bundle.files).map(([name, text]) => ({ name, text: String(text) }));
  return makeZip(entries);
}
