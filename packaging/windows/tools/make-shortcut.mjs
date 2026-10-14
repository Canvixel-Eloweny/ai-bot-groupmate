/**
 * 桌面快捷方式 —— 一键安装的最后一步。
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  为什么是「快捷方式 → wscript → 无窗口启动」这条链
 * ══════════════════════════════════════════════════════════════════════════
 *  目标：双击桌面图标 → 控制台起来 → 浏览器打开，**全程不出现黑窗口**。
 *
 *  · 快捷方式不能直接指 `node.exe`：Node 在 Windows 上是**控制台程序**，
 *    从 .lnk 拉起必然闪一个黑框；而 .lnk **没有"隐藏窗口"这个开关**。
 *  · 所以中间夹一层 `wscript.exe launch-hidden.vbs`：wscript 本身无窗口，
 *    再由它 `Run …, 0` 把真正那条命令**隐藏**着起。
 *  · 名字与图标都用**当前品牌**：`Estrella Bot` + `estrella-bot.ico`
 *    （图标由 `packaging/windows/make-ico.py` 从官方立绘生成，7 档尺寸）。
 *
 *  ⚠️ **不写开始菜单、不改注册表、不开机自启** —— 这三件都是"往用户系统里放东西"，
 *     一个桌面图标已经够用，多做的那部分只会变成卸载时清不干净的残渣。
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, IS_WIN, exists, ok, warn, bad, say, dim, isMain } from './lib/common.mjs';

export const SHORTCUT_NAME = 'Estrella Bot.lnk';
export const ICO_REL = 'estrella-bot.ico';
export const VBS_REL = 'launch-hidden.vbs';

/** PowerShell 单引号字面量：单引号里唯一的元字符是 `'`，按规矩写成两个。 */
const psq = (s) => `'${String(s ?? '').replace(/'/g, "''")}'`;

/**
 * 建快捷方式。
 *
 * @param {{name?:string, desktop?:string}} opt
 * @returns {{ok:boolean, path?:string, msg:string}}
 */
export function makeShortcut({ name = SHORTCUT_NAME } = {}) {
  if (!IS_WIN) return { ok: false, msg: '非 Windows，跳过建快捷方式' };

  const vbs = path.join(ROOT, VBS_REL);
  if (!exists(vbs)) return { ok: false, msg: `包里缺 ${VBS_REL}（解压不完整？）` };
  const ico = exists(path.join(ROOT, ICO_REL)) ? path.join(ROOT, ICO_REL) : '';

  // ⚠️ 写一份临时 .ps1 再 `-File` 跑，而不是把整条命令拼进 `-Command`：
  //    路径里的空格 / 中文 / 单引号在拼接写法下会被二次解释，
  //    而失败的样子是"快捷方式建出来了但指向不对"—— 看不出是引号的问题。
  const ps1 = path.join(ROOT, 'tools', '.make-shortcut.ps1');
  const script = [
    '$ErrorActionPreference = "Stop"',
    '$ws = New-Object -ComObject WScript.Shell',
    // ⚠️ 用 [Environment]::GetFolderPath('Desktop') 而不是 $env:USERPROFILE\Desktop：
    //    OneDrive 桌面重定向 / 改过位置的用户，后者指向的目录根本不存在，
    //    于是快捷方式建在一个没人看得见的地方，且**不报错**。
    "$desktop = [Environment]::GetFolderPath('Desktop')",
    `$lnk = Join-Path $desktop ${psq(name)}`,
    '$sc = $ws.CreateShortcut($lnk)',
    "$sc.TargetPath = (Join-Path $env:SystemRoot 'System32\\wscript.exe')",
    `$sc.Arguments = ${psq(`"${vbs}"`)}`,
    `$sc.WorkingDirectory = ${psq(ROOT)}`,
    ico ? `$sc.IconLocation = ${psq(`${ico},0`)}` : '',
    `$sc.Description = ${psq('Estrella Bot 控制台 —— 双击打开控制台页面')}`,
    '$sc.Save()',
    'Write-Output "OK|$lnk"',
  ].filter(Boolean).join('\n');

  try { fs.writeFileSync(ps1, script, 'utf8'); } catch (e) {
    return { ok: false, msg: `临时脚本写不进去：${e.message}` };
  }
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ps1],
    { windowsHide: true, encoding: 'utf8' });
  try { fs.rmSync(ps1, { force: true }); } catch { /* 临时文件删不掉不致命 */ }

  const out = `${r.stdout || ''}${r.stderr || ''}`.trim();
  if (r.error || r.status !== 0 || !/OK\|/.test(out)) {
    return { ok: false, msg: out || (r.error ? r.error.message : `退出码 ${r.status}`) };
  }
  const p = out.split('\n').map((s) => s.trim()).find((s) => s.startsWith('OK|')).slice(3);
  return { ok: true, path: p, msg: '快捷方式已建好' };
}

// ── CLI ─────────────────────────────────────────────────────────────────────
if (isMain(import.meta.url)) {
  say('桌面快捷方式');
  const r = makeShortcut();
  if (r.ok) {
    ok(`已在桌面建好「${SHORTCUT_NAME.replace(/\.lnk$/, '')}」`);
    dim(`      ${r.path}`);
    dim('      以后双击它即可打开控制台（不会弹出黑窗口）。');
  } else {
    bad(`没建成：${r.msg}`);
    process.exitCode = 1;
  }
}
