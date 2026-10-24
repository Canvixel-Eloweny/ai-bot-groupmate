/**
 * 面板上一次退出的落盘与文案（P1-10 · 2026-10-23）。
 *
 * 只读/写一个 JSON 文件；不依赖面板其它模块，便于在退出路径上安全调用。
 * 正常退出也必须写：否则下次启动分不清“上次没退”与“上次异常”。
 */

import fs from 'node:fs';
import path from 'node:path';
import { stripBom } from '../../src/plugin-manifest.js';
import { panelExit } from '../../src/desktop/crash-record.js';

export function readLastExit(file) {
  try {
    const obj = JSON.parse(stripBom(fs.readFileSync(file, 'utf8')));
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : null;
  } catch {
    return null;
  }
}

export function writeLastExit(file, record) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, `${JSON.stringify(panelExit(record))}\n`);
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

/** 给面板显示的一行文案；没有记录时返回空串（首次启动不吓人）。 */
export function lastExitText(record) {
  if (!record || typeof record !== 'object') return '';
  const code = Number(record.code);
  const reason = String(record.reason || '');
  const normal = code === 0 && ['quit', 'restart', 'update-install', 'stop-all', 'onekey-stop'].includes(reason);
  if (normal) return `上次正常退出（${reason}）`;
  return `上次异常退出（code ${Number.isFinite(code) ? code : '?'}${reason ? ` · ${reason}` : ''}）`;
}

export function appendPanelEvent(file, event) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      if (fs.statSync(file).size > 512 * 1024) {
        const text = fs.readFileSync(file, 'utf8').split(/\r?\n/).slice(-100).join('\n');
        fs.writeFileSync(file, text);
      }
    } catch { /* 文件不存在或读不到：直接 append */ }
    fs.appendFileSync(file, `${JSON.stringify({ schema: 1, at: new Date().toISOString(), ...event })}\n`);
    return true;
  } catch {
    return false;
  }
}
