#!/usr/bin/env node
/**
 * NSIS 脚本的静态体检（P2）。macOS 上没有 makensis，这层先把**能静态发现**的
 * 事故挡住：提权、写死版本、漏 stop、卸载默认删数据、缺文件。
 *
 * 用法：node check-nsi.mjs --nsi <buildDir>/Estrella-Bot.nsi --stage <buildDir>/stage
 */

import fs from 'node:fs';
import path from 'node:path';
import { isMainModule } from '../tools/lib/install-layout.mjs';

function argOf(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? String(process.argv[i + 1] || '') : '';
}

function main() {
  const nsi = path.resolve(argOf('--nsi') || path.join('..', 'Estrella-Bot.nsi'));
  const stage = path.resolve(argOf('--stage') || path.join('..', 'stage'));
  const text = fs.readFileSync(nsi, 'utf8');
  const problems = [];
  const has = (s) => text.includes(s);

  // P7 双语后源码是 UTF-8（中文 LangString）。真正要防的两件事：
  // ① 带非 ASCII 却没有 `Unicode true`（安装器输出格式非 Unicode，中文必乱）；
  // ② 带非 ASCII 却没有 UTF-8 BOM —— makensis 3.13 无 BOM 时按**构建机 ACP** 读源码
  //    （英文 Windows = CP1252），中文 LangString 会以乱码烤进中文语言表。
  //    P8 群友真机回执：选中文后自定文案全乱、MUI 自带文案正常（SimpChinese.nsh 自带 BOM）；
  //    VM 对照探针（2026-10-19）：同源码有/无 BOM 的 string pool 差 52 B
  //    = 4 B 文件名 + 12 个 CJK 字被误读成 36 字 ×2 B，定量吻合。
  //    旧判据「BOM 坏（makensis 会把 BOM 当指令的一部分）」是未经实证的猜测，与实测真相相反，
  //    本轮订正（旧表述留存在 CONTRACTS-HISTORY P7 行）。纯 ASCII 不再是要求。
  const uniTrue = /^\s*Unicode true/m.test(text);
  if (!uniTrue) problems.push('.nsi 没有声明 Unicode true');
  const rawHead = fs.readFileSync(nsi);
  const hasBom = rawHead[0] === 0xEF && rawHead[1] === 0xBB && rawHead[2] === 0xBF;
  if (/[^\x00-\x7F]/.test(text.replace(/^\uFEFF/, '')) && !hasBom) {
    problems.push('.nsi 含非 ASCII 却没有 UTF-8 BOM —— makensis 按构建机 ACP（英文 Windows 为 CP1252）读源码，中文必乱码（P8 群友真机回执）');
  }
  // P9（2026-10-19 群友回执）：下载必须有可视提示。
  // ⚠️ 同轮回执的另两条（排版重排 / 未选置灰二选一）经维护者点名**还原回 P8 快照**（见 r8 提交），
  // 相应判据一并撤除；本块只守保留下来的下载提示与 ASCII 化环境。
  {
    if (!/SendMessage \$R0 \$\{WM_SETTEXT\} 0 "STR:\$\(DL_HINT\)"/.test(text)) problems.push('缺下载时的页眉副标题提示（WM_SETTEXT $(DL_HINT)）—— 群友回执：下载看起来像卡死');
    if (!/LangString DL_HINT \$\{LANG_SIMPCHINESE\}/.test(text)) problems.push('缺 LangString DL_HINT 的中文份（下载提示没中文）');
    if (!/!include "WinMessages\.nsh"/.test(text)) problems.push('没有 include WinMessages.nsh（${WM_SETTEXT} 无定义）');
    if (!/SetEnvironmentVariableW\(w "ESTRELLA_NSIS"/.test(text)) problems.push('.onInit 没设 ESTRELLA_NSIS —— 安装链路工具输出不会 ASCII 化，详情框会再乱码');
  }
  if (!/MUI_LANGUAGE "SimpChinese"/.test(text)) problems.push('.nsi 没有 SimpChinese 语言（P7 起安装器必须双语）');
  if (!/MUI_LANGDLL_DISPLAY/.test(text)) problems.push('.nsi 没有在 .onInit 里给语言选择（MUI_LANGDLL_DISPLAY）');
  if (!/RequestExecutionLevel\s+user\b/.test(text)) problems.push('缺 RequestExecutionLevel user');
  if (/RequestExecutionLevel\s+admin\b/i.test(text)) problems.push('出现 RequestExecutionLevel admin（按用户安装禁止提权）');
  if (!/SetShellVarContext\s+current\b/.test(text)) problems.push('缺 SetShellVarContext current');
  if (!/!include\s+"version\.nsh"/.test(text)) problems.push('没有 include 生成的 version.nsh（版本/appId 可能被写死）');
  if (/\b0\.1\.\d+\b/.test(text)) problems.push('脚本里出现写死的版本号（必须来自 version.nsh）');
  if (/com\.estrellabot\.windows/.test(text)) problems.push('脚本里出现写死的 appId（必须来自 version.nsh）');
  if (!/OutFile\s+"Estrella-Bot-Setup-\$\{APP_VERSION\}\.exe"/.test(text)) problems.push('OutFile 没有使用 ${APP_VERSION}');
  if (!/VIProductVersion\s+"\$\{APP_VERSION\}\.0"/.test(text)) problems.push('VIProductVersion 没有使用 ${APP_VERSION}');
  if (!/WriteUninstaller\s+"\$INSTDIR\\uninstall\.exe"/.test(text)) problems.push('没有 WriteUninstaller');
  if (!/File\s+\/r\s+"stage\\\*\.\*"/.test(text)) problems.push('没有把 stage\\*.* 解进安装目录');
  if (!/WriteRegStr[^\n]+"UserRoot"/.test(text)) problems.push('卸载项没有记录 UserRoot');
  if (!/File\s+"uninstall-stop\.ps1"/.test(text)) problems.push('卸载段没有带 PowerShell 兜底脚本');

  const stopAt = text.indexOf('tools\\stop.mjs');
  const commitAt = text.indexOf('tools\\install-commit.mjs');
  if (stopAt < 0) problems.push('安装段没有调用 stop.mjs');
  if (commitAt < 0) problems.push('安装段没有调用 install-commit.mjs');
  if (stopAt >= 0 && commitAt >= 0 && stopAt > commitAt) problems.push('stop.mjs 出现在 install-commit 之后（runtime 会被占用）');
  if (!/install-commit\.mjs"[^\n]*--install-root[^\n]*--stage[^\n]*--version/.test(text)) {
    problems.push('install-commit 调用缺 --install-root/--stage/--version');
  }
  if (!/bootstrap\.mjs/.test(text)) problems.push('安装完成后没有调用 bootstrap.mjs');

  const deleteAt = text.indexOf('$DeleteUserData == 1');
  const dataRmAt = text.indexOf('RMDir /r "$UserRoot"');
  const skipLabelAt = text.indexOf('skipDataDelete:');
  if (dataRmAt < 0) problems.push('没有删除用户数据的实现');
  if (deleteAt < 0) problems.push('没有 $DeleteUserData 开关');
  if (dataRmAt >= 0 && (deleteAt < 0 || dataRmAt < deleteAt)) problems.push('RMDir /r "$UserRoot" 不在 Remove user data 分支内');
  if (dataRmAt >= 0 && skipLabelAt >= 0 && dataRmAt > skipLabelAt) problems.push('用户数据删除没有二次确认分支');
  if (!/MB_YESNO[^\n]*IDNO\s+skipDataDelete/.test(text)) problems.push('用户数据删除没有二次确认');
  if (!/(?:\$\{FileExists\}|FileExists)\s+"\$UserRoot\\\.estrellabot-user-root"/.test(text)) {
    problems.push('删用户数据前没有校验 .estrellabot-user-root 标记');
  }
  if (!/CreateShortCut[^\n]+Estrella-Bot\.vbs/.test(text)) problems.push('快捷方式没有指向 Estrella-Bot.vbs');

  // ── P6：协议端那一页的四条硬要求（都是"曾经会卡死用户"的那类形状）────────────
  if (!/Page custom NapCatPage NapCatPageLeave/.test(text)) problems.push('没有 NapCat 选择页（协议端又只剩"勾了就下载"一条路）');
  // P7：群友测试后维护者点名删掉「Pick .zip...」按钮 —— 页面上只留选文件夹一条路
  for (const dead of ['BtnNapZip', 'NapPickZipClick', 'Pick .zip']) {
    if (text.includes(dead)) problems.push(`NapCat 页还留着 ${dead} —— 维护者点名删掉的 zip 按钮又回来了`);
  }
  if (!/Pick the unzipped folder/.test(text)) problems.push('NapCat 页没有「选已解压文件夹」按钮');
  // 「默认」是位置属性：全文里 `StrCpy $NapcatMode "skip"` 有三处（默认 / /NAPCATSKIP 分支 /
  // 离页兜底），只问"出现过没有"会把默认值被改成 auto 这一件事听不见。
  // ⇒ 只看 .onInit 里**解析命令行之前**那一段，且要求它恰好一条。与 check-wb §114 ⑪ 同判据。
  const onInitAt = text.indexOf('Function .onInit');
  const getParamAt = text.indexOf('${GetParameters}', onInitAt);
  const defaultWindow = onInitAt >= 0 && getParamAt > onInitAt ? text.slice(onInitAt, getParamAt) : '';
  if (!defaultWindow) problems.push('认不出 .onInit → ${GetParameters} 区间（默认值判据失去作用域，不是通过）');
  else {
    const defaults = [...defaultWindow.matchAll(/StrCpy \$NapcatMode "(\w+)"/g)].map((m) => m[1]);
    if (defaults.length !== 1) problems.push(`.onInit 解析命令行前应有恰好 1 条 $NapcatMode 赋值，实测 ${defaults.length} 条（${defaults.join('、') || '无'}）`);
    else if (defaults[0] !== 'skip') problems.push(`$NapcatMode 默认是 "${defaults[0]}" 而不是 skip（默认塞一次下载 = 用户看见的卡死）`);
  }
  if (/\$\{NSD_Check\} \$CheckAutoNapcat/.test(text)) problems.push('出现了 ${NSD_Check} $CheckAutoNapcat —— 联网下载不许默认勾选');
  // .onInit 里出现 IfSilent ⇒ 静默安装会把 /NAPCATZIP= / /NAPCATFOLDER= 覆盖回 skip
  // （VM 实测 2026-10-18：/S /NAPCATZIP= 装完 status=SKIPPED[mode=skip]）。
  // 静默无开关时的默认值由最上面的 StrCpy 给出，不需要兜底。
  {
    const oi = text.indexOf('Function .onInit');
    const oe = oi >= 0 ? text.indexOf('FunctionEnd', oi) : -1;
    const body = oi >= 0 && oe > oi ? text.slice(oi, oe).replace(/;.*$/gm, '') : '';
    if (!body) problems.push('认不出 .onInit 的函数体');
    else if (/(^|\n)\s*IfSilent\b/.test(body)) problems.push('.onInit 里出现 IfSilent —— 静默安装会把显式传入的 /NAPCATZIP= / /NAPCATFOLDER= 覆盖回 skip');
  }
  // GetOptions 实测返回 "=value"（makensis 3.13）：不剥掉前导 = 就会把 =C:\... 当路径传下去。
  const onInitBody = (() => { const a = text.indexOf('Function .onInit'); const b = a >= 0 ? text.indexOf('FunctionEnd', a) : -1; return a >= 0 && b > a ? text.slice(a, b) : ''; })();
  const stripCount = (onInitBody.match(/StrCpy \$R1 \$R1 "" 1/g) || []).length;
  if (stripCount < 2) problems.push(`GetOptions 返回值没有去掉前导 "="（只数到 ${stripCount} 处 strip）—— 路径会带 = 前缀，离线放包必被拒`);
  const napPageAt = text.indexOf('Function NapCatPage');
  const leaveAt = text.indexOf('Function NapCatPageLeave');
  const silentAt = text.indexOf('${If} ${Silent}');
  if (napPageAt < 0 || leaveAt < 0) problems.push('认不出 NapCatPage / NapCatPageLeave');
  else if (silentAt < leaveAt) problems.push('NapCatPageLeave 没有先挡静默模式 —— 静默下控件句柄根本不存在，读它就是把未初始化当状态');
  if (!/bootstrap\.mjs"[^\n]*--napcat-mode/.test(text)) problems.push('bootstrap 调用没有 --napcat-mode（页面选的四条路传不下去）');
  // `$DOWNLOADS` 不是 NSIS 的 shell 常量：实测 makensis 3.13 打警告 6000、初始目录为空
  if (/\$DOWNLOADS\b/.test(text)) problems.push('用了 $DOWNLOADS —— NSIS 没有这个常量（编译警告 6000 + 初始目录为空），改用 $PROFILE\\Downloads');
  const yesNoExclaim = (text.match(/MessageBox MB_YESNO\|MB_ICONEXCLAMATION/g) || []).length;
  if (yesNoExclaim !== 1) problems.push(`卸载二次确认的 MessageBox 应恰好 1 处，实测 ${yesNoExclaim} —— install-p2 的变异按 count 1 钉它，多一处就把它变成假牙`);
  // 页面顺序 = `Page custom` 的**声明顺序**（函数定义在文件里排在声明之后，
  // 拿函数定义的下标去比声明的下标会得到一个永远为真的假告警 —— 第一版就踩了）。
  const napDeclAt = text.indexOf('Page custom NapCatPage');
  const importDeclAt = text.indexOf('Page custom ImportPage');
  if (napDeclAt >= 0 && importDeclAt >= 0 && napDeclAt > importDeclAt) problems.push('NapCat 页排在导入页之后（用户先选数据再选协议端，顺序反了）');

  for (const rel of [
    path.join('launcher', 'estrella-bot.ico'),
    path.join('launcher', 'estrella-bot-v5.ico'),
    'LICENSE',
    path.join('launcher', 'Estrella-Bot.vbs'),
    path.join('launcher', 'run-hidden.vbs'),
    path.join('launcher', 'launch-napcat-hidden.vbs'),
    'payload-manifest.json',
    path.join('app', 'electron', 'electron.exe'),
    path.join('app', 'electron', 'package.json'),
    path.join('app', 'electron', 'main.js'),
    path.join('app', 'electron', 'resources', 'default_app.asar'),
  ]) {
    if (!fs.existsSync(path.join(stage, rel))) problems.push(`stage 缺 ${rel}`);
  }
  const electronVersionFile = path.join(stage, 'app', 'electron', 'version');
  if (!fs.existsSync(electronVersionFile)) problems.push('stage 缺 app/electron/version');
  else {
    const ev = fs.readFileSync(electronVersionFile, 'utf8').trim();
    if (!/^44\.9\.3(?:$|[.-])/.test(ev)) problems.push(`stage 的 Electron 版本不是 44.9.3：${ev}`);
  }
  const ps1 = path.join(path.dirname(nsi), 'uninstall-stop.ps1');
  if (!fs.existsSync(ps1)) problems.push(`缺 ${ps1}`);
  else if (/[^\x00-\x7F]/.test(fs.readFileSync(ps1, 'utf8'))) problems.push('uninstall-stop.ps1 不是 ASCII-only');

  const headerBmp = path.join(path.dirname(nsi), 'estrella-bot-header.bmp');
  if (!fs.existsSync(headerBmp)) {
    problems.push('缺 estrella-bot-header.bmp（MUI_HEADERIMAGE_BITMAP）');
  } else {
    const b = fs.readFileSync(headerBmp);
    if (b.readUInt32LE(18) !== 150 || b.readUInt32LE(22) !== 57) {
      problems.push(`estrella-bot-header.bmp 不是 150x57（实测 ${b.readUInt32LE(18)}x${b.readUInt32LE(22)}）`);
    }
  }

  if (problems.length) {
    for (const p of problems) console.error(`✗ ${p}`);
    console.error(`── ${problems.length} 处问题 ──`);
    process.exitCode = 1;
    return;
  }
  console.log('✓ NSIS 静态检查通过（per-user / 版本单一来源 / stop→commit / 卸载默认保留数据 / 协议端默认不下载）');
}

if (isMainModule(import.meta.url)) main();
