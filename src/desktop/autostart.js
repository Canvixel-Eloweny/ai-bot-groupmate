/**
 * Windows 开机自启：Startup 快捷方式 + StartupApproved 三态。
 *
 * 面板开关必须读系统状态，而不是只信 config.json：用户可能在任务管理器里禁用，
 * 或者手删快捷方式。三态 = on / off / blocked；非 Windows 为 unsupported。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const REG_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\StartupFolder';
const SHORTCUT_NAME = 'Estrella Bot.lnk';

export function startupShortcutPath({
  platform = process.platform,
  appData = process.env.APPDATA,
  shortcutName = SHORTCUT_NAME,
} = {}) {
  if (platform !== 'win32') return '';
  const base = appData || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.win32.join(base, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', shortcutName);
}

export function parseStartupApproved(raw) {
  if (Buffer.isBuffer(raw)) return raw.length ? raw[0] : null;
  const text = String(raw || '');
  const m = /REG_BINARY\s+([0-9a-fA-F]{2})/.exec(text);
  return m ? Number.parseInt(m[1], 16) : null;
}

export function classifyAutostart({ platform = process.platform, shortcutExists = false, approvalFirstByte = null } = {}) {
  if (platform !== 'win32') return 'unsupported';
  if (!shortcutExists) return 'off';
  if (approvalFirstByte === 0x03 || approvalFirstByte === 0x07) return 'blocked';
  return 'on';
}

export function readAutostartState({
  platform = process.platform,
  fsApi = fs,
  execFileSync: exec = execFileSync,
  shortcutPath,
  shortcutName = SHORTCUT_NAME,
} = {}) {
  if (platform !== 'win32') return { state: 'unsupported', shortcut: '', approval: null };
  const shortcut = shortcutPath || startupShortcutPath({ platform, shortcutName });
  const shortcutExists = fsApi.existsSync(shortcut);
  if (!shortcutExists) return { state: 'off', shortcut, approval: null };
  let approval = null;
  try {
    const out = exec('reg', ['query', REG_KEY, '/v', path.win32.basename(shortcut)], {
      encoding: 'utf8', windowsHide: true, timeout: 5000,
    });
    approval = parseStartupApproved(out);
  } catch {
    // 没有 StartupApproved 值 = 默认启用；快捷方式存在即 on。
  }
  return {
    state: classifyAutostart({ platform, shortcutExists, approvalFirstByte: approval }),
    shortcut,
    approval,
  };
}

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

export function setAutostart(enabled, {
  platform = process.platform,
  installRoot = '',
  launcherPath = '',
  fsApi = fs,
  execFileSync: exec = execFileSync,
  shortcutName = SHORTCUT_NAME,
} = {}) {
  if (platform !== 'win32') return { ok: false, state: 'unsupported', error: '仅 Windows 支持开机自启' };
  if (!installRoot) return { ok: false, state: 'unsupported', error: '未找到安装根，无法写开机自启' };
  const launcher = launcherPath || path.win32.join(installRoot, 'launcher', 'Estrella-Bot.vbs');
  if (!fsApi.existsSync(launcher)) {
    return { ok: false, state: 'unsupported', error: `未找到启动器：${launcher}` };
  }
  const shortcut = startupShortcutPath({ platform, shortcutName });
  const approvalName = path.win32.basename(shortcut);

  if (!enabled) {
    try {
      fsApi.rmSync(shortcut, { force: true });
    } catch (e) {
      return { ok: false, state: 'off', error: `删除开机自启失败：${e.message}` };
    }
    try { exec('reg', ['delete', REG_KEY, '/v', approvalName, '/f'], { windowsHide: true, timeout: 5000 }); } catch { /* 无值即已启用 */ }
    return { ok: true, state: 'off', shortcut };
  }

  const target = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wscript.exe');
  const args = `"${launcher}" --hidden`;
  const icon = path.win32.join(installRoot, 'launcher', 'estrella-bot-v5.ico');
  const script = [
    `$s=(New-Object -ComObject WScript.Shell).CreateShortcut(${psQuote(shortcut)})`,
    `$s.TargetPath=${psQuote(target)}`,
    `$s.Arguments=${psQuote(args)}`,
    `$s.WorkingDirectory=${psQuote(installRoot)}`,
    `$s.IconLocation=${psQuote(`${icon},0`)}`,
    `$s.Description='Estrella Bot'`,
    '$s.Save()',
  ].join('; ');
  try {
    exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      windowsHide: true, timeout: 15000,
    });
  } catch (e) {
    return { ok: false, state: 'off', error: `写开机自启失败：${e.message}` };
  }
  try { exec('reg', ['delete', REG_KEY, '/v', approvalName, '/f'], { windowsHide: true, timeout: 5000 }); } catch { /* 无值即已启用 */ }
  return { ok: true, state: 'on', shortcut };
}
