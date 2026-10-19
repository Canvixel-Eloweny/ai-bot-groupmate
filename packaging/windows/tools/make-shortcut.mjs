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
 *  ⚠️ **与包放在哪个盘无关**：`ROOT` 由本文件自身位置推出（见 `lib/common.mjs`），
 *     桌面走 `[Environment]::GetFolderPath('Desktop')`（认 OneDrive 重定向与改过位置的桌面）。
 */

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

  // ⚠️ 不把整条命令拼进 `-Command`：路径里的空格 / 中文 / 单引号在拼接写法下会被
  //    二次解释，而失败的样子是"快捷方式建出来了但指向不对"—— 看不出是引号的问题。
  //
  // ⚠️ 2026-10-16：改用 `-EncodedCommand`（把脚本 base64 塞进命令行），**不再落盘**。
  //
  //    为什么换（维护者 2026-10-16 实测反馈：「按 Y 之后过了好几秒才生成」）：
  //      ① 旧写法每次都要**新建一个 .ps1 文件**。Windows Defender 的实时防护对
  //         "**新出现的脚本文件**"会先扫一遍再放行 —— 那几秒就是它。不落盘 ⇒ 不扫。
  //      ② 落盘还带来一整类编码坑：PS 5.1 读**无 BOM** 的 .ps1 时按系统 ANSI 解码，
  //         脚本里那句中文被拆错、凑出半个引号 ⇒ ParserError，整个脚本一行不执行
  //         （2026-10-15 真机踩过，修法是加 BOM）。`-EncodedCommand` 把脚本以
  //         **UTF-16LE base64** 直接交给 PS，**编码由协议本身定死** ⇒ 这一类从根上不存在。
  //      ③ 顺带少一个失败分支（"临时脚本写不进去"）。
  //
  //    ⚠️ `-EncodedCommand` 收的是 **UTF-16LE 的 base64**，不是 UTF-8 —— 写错会报
  //       "命令行参数无效"或读到乱码。所以这里显式 `utf16le` 再 `toString('base64')`。
  //    ⚠️ 顺手把控制台输出编码钉成 UTF-8：否则 `OK|<路径>` 里的中文在按 OEM 代码页
  //       输出、而我们按 UTF-8 收 ⇒ 返回的路径是乱码（`OK|` 本身是 ASCII 所以不影响判定，
  //       但日志里那个路径就没法看了）。
  const script = [
    '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
    '$ErrorActionPreference = "Stop"',
  ].concat([
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
  ].filter(Boolean)).join('\n');

  const enc = Buffer.from(script, 'utf16le').toString('base64');
  const t0 = Date.now();
  const r = spawnSync('powershell',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', enc],
    { windowsHide: true, encoding: 'utf8' });
  const ms = Date.now() - t0;

  const out = `${r.stdout || ''}${r.stderr || ''}`.trim();
  if (r.error || r.status !== 0 || !/OK\|/.test(out)) {
    return { ok: false, ms, msg: out || (r.error ? r.error.message : `退出码 ${r.status}`) };
  }
  const p = out.split('\n').map((s) => s.trim()).find((s) => s.startsWith('OK|')).slice(3);
  return { ok: true, ms, path: p, msg: '快捷方式已建好' };
}

// ── CLI ─────────────────────────────────────────────────────────────────────
if (isMain(import.meta.url)) {
  say('桌面快捷方式');
  const r = makeShortcut();
  if (r.ok) {
    ok(`已在桌面建好「${SHORTCUT_NAME.replace(/\.lnk$/, '')}」（耗时 ${r.ms} ms）`);
    dim(`      ${r.path}`);
    dim('      以后双击它即可打开控制台（不会弹出黑窗口）。');
  } else {
    bad(`没建成（耗时 ${r.ms} ms）：${r.msg}`);
    process.exitCode = 1;
  }
}
