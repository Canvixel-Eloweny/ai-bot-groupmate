/**
 * 一键取证（`4-DIAG.bat` 调它）—— 把"排查根因需要的全部证据"收进一个文本文件。
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  为什么需要它（2026-10-13）
 * ══════════════════════════════════════════════════════════════════════════
 *  AI 侧**连不进虚拟机**（实测：ping 不通、SSH/SMB/RDP/WinRM 全关、utmctl 无输出），
 *  而"二维码为什么裂 / 黑窗为什么还在"这类问题，缺的是**VM 里的现场**：
 *     · VM 上那份包到底是不是最新的（改了没生效，先怀疑这个）
 *     · NapCat 装没装好、启动器叫什么、qrcode.png 是不是一张完整的 PNG
 *     · 面板与协议端的日志尾部到底写了什么
 *     · OneBot 配置里有没有 3001/3000
 *  与其让用户截图十张，不如一键把这些收走。
 *
 * ⚠️ **只读，不写任何运行态文件**：它不改配置、不起停进程，只收集与打包。
 * ⚠️ **不收集凭据正文**：webui.json 只记"有没有 token"，不抄 token 本身。
 * ⚠️ 输出同时落到两处：① 包内 `diag-out\`；② `~/Documents/UTM-Share`（若存在）——
 *    共享目录是 AI 侧唯一可能读到的路径，写那儿它就能直接看。
 */

import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  ROOT, APP, USER_ROOT, NAPCAT_DIR, CONFIG_JSON, SETUP_MARKER, exists, readJson,
} from './lib/common.mjs';

const OUT = path.join(USER_ROOT, 'diag-out');
const SHARE = path.join(process.env.USERPROFILE || '', 'Documents', 'UTM-Share');
const lines = [];
const say = (s = '') => { lines.push(s); console.log(s); };

/** 端口是否在听（1.5 秒超时；连不上一律算"没开"，不猜）。 */
function portOpen(port) {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1');
    const done = (v) => { try { s.destroy(); } catch { /* 已断 */ } resolve(v); };
    s.setTimeout(1500, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

async function main() {

function head(title) { say(''); say('═'.repeat(72)); say(title); say('═'.repeat(72)); }

function tail(file, n) {
  try {
    const txt = fs.readFileSync(file, 'utf8');
    const arr = txt.split(/\r?\n/);
    return arr.slice(Math.max(0, arr.length - n)).join('\n');
  } catch (e) {
    return `（读不到：${e.message}）`;
  }
}

function sh(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', timeout: 15000, windowsHide: true }).trim();
  } catch (e) {
    return `（执行失败：${e.message}）`;
  }
}

// ── ① 环境 ──────────────────────────────────────────────────────────────────
head('① 环境 / 版本');
say(`系统           ${process.platform} ${process.arch}`);
say(`本包 ROOT      ${ROOT}`);
say(`包内 Node      ${exists(path.join(ROOT, 'runtime', 'node', 'node.exe')) ? '在' : '**不在**'}`);
say(`QQ 安装路径    ${sh('reg', ['query', 'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\QQ', '/v', 'UninstallString'])}`);

// ── ② 包完整性：按**出厂清单**逐项核对（权威判据）────────────────────────────
//
// ⚠️ 2026-10-14 立。这一节以前**没有** —— 那时这里只有一张手写的"关键词"表（现在降到 ②b），
//    而那张表在一次真实事故里把**坏文件报成了"是新版"**：
//      · `launch-napcat-hidden.vbs` 的判据是"含 `WScript.Shell`" —— **旧版也有这个词**（各 2 处）
//      · `app/panel/lib/napcat-native.js` 的判据是"含 `wscript`" —— 旧版同样有
//    于是 diag 打出"6 个关键文件全是新版"，我们据此把"包是旧的"这条假设划掉了 ——
//    而其中 3 个当时**确实是旧的**，正是它们让协议端起不来。**假绿灯比没灯更贵。**
//    ⇒ 判据换成**构建时机器生成的 `SHA256SUMS.txt`**（31 项、逐字节比对）：
//      不存在"新旧两个版本都命中同一个词"这种事。
head('② 包完整性（按 SHA256SUMS.txt 逐项核对 —— 权威判据）');
const SUMS = path.join(ROOT, 'SHA256SUMS.txt');
if (!exists(SUMS)) {
  say('**SHA256SUMS.txt 不在** —— 这份包没有出厂清单，无法自证。');
  say('  对外分发包一定带它。见到这一行 ⇒ 这份包被手工动过、或不是构建产物。');
} else {
  // 清单里前几行是 `#` 注释（make-sums.py 写的说明），**不是**坏行 —— 要单独算，
  // 否则"4 行读不懂"会把一份完全正常的清单说成可疑。
  const allLines = fs.readFileSync(SUMS, 'utf8').split(/\r?\n/);
  const comments = allLines.filter((l) => l.trim().startsWith('#')).length;
  const rawLines = allLines.map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  const rows = rawLines
    .map((l) => /^([0-9a-f]{64})\s+(\S.*)$/i.exec(l))
    .filter(Boolean)
    .map((m) => ({ hash: m[1].toLowerCase(), rel: m[2] }));
  const unparsed = rawLines.length - rows.length;
  const same = []; const diff = []; const miss = [];
  for (const r of rows) {
    const p = path.join(ROOT, r.rel);
    if (!exists(p)) { miss.push(r.rel); continue; }
    try {
      const h = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
      (h === r.hash ? same : diff).push(r.rel);
    } catch (e) { diff.push(`${r.rel}（读不了：${e.message}）`); }
  }
  say(`清单            ${comments} 行注释 · ${rawLines.length} 行条目 → 解析出 ${rows.length} 项${unparsed ? ` · **${unparsed} 行读不懂（已跳过）**` : ''}`);
  say(`逐项核对        ${same.length} 项一致 · ${diff.length} 项**内容不一致** · ${miss.length} 项**文件缺失**`);
  if (diff.length) { say(''); say('**内容不一致（被改过 / 是旧版）—— 就是这几个：**'); for (const f of diff) say(`  · ${f}`); }
  if (miss.length) { say(''); say('**清单里有、包内没有：**'); for (const f of miss) say(`  · ${f}`); }

  // 反向自证两道（都是"别让空集/截断被读成全都对"）：
  //   ① 一行都没解析出来 ⇒ 别报"一致"，去查清单本身。
  //   ② 启动链那三个文件**必须在清单里点名** —— 否则"少了几行的清单"会让逐项核对
  //      **看起来全绿**，而这恰恰是 2026-10-14 那次事故的形态（当时
  //      `app/panel/lib/napcat-native.js` 就是被换掉的三个之一，却**不在**清单里）。
  //      这一条是**跨文件核对**（与 `make-sums.py` 的 `ITEMS` 对表），不是第二份判据。
  const MUST = ['launch-napcat-hidden.vbs', 'tools/start-napcat.mjs', 'app/panel/lib/napcat-native.js'];
  const notNamed = MUST.filter((f) => !rows.some((r) => r.rel === f));
  if (!rawLines.length) say('⇒ **清单是空的** —— 别把它读成"全都对"。');
  else if (!rows.length) say('⇒ **一行都没解析出来** —— 别把它读成"全都对"，去看 SHA256SUMS.txt 本身有没有坏。');
  else if (notNamed.length) say(`⇒ **清单里没有点名：${notNamed.join('、')}** —— 启动链没被覆盖，逐项结果不足采信（去核 make-sums.py 的 ITEMS）。`);
  else if (!diff.length && !miss.length && !unparsed) say('⇒ 这份包与出厂时逐字节一致。');
}

// ── ②b 关键词探针（**弱判据**，只回答"这个包里有没有某个特性"）────────────────
// ⚠️ 它**不能**用来判断"这份包是不是最新的"（理由见 ② 开头那次事故）。
//    留着它是因为它还能答另一个问题："这份构建里有没有带上某个特性"。
head('②b 关键词探针（弱判据 —— 别拿它判新旧，见 ②）');
const probes = {
  'tools/start-napcat.mjs': 'wscript',
  'tools/lib/common.mjs': 'knownAccountsByMtime',
  // 2026-10-16（P0-1）：这个包带没带「NapCat 供应链 digest 校验」——有它 = 下载件/手动放包
  // 都会被逐字节核对；没有 = 老包。
  'tools/lib/versions.mjs': 'assetSha256',
  'app/panel/lib/next-page.js': 'blob:',
  'app/panel/lib/napcat-native.js': 'wscript',
  'app/panel/next/app.js': 'startNapTailTimer',
  'launch-napcat-hidden.vbs': 'WScript.Shell',
};
for (const [rel, needle] of Object.entries(probes)) {
  const p = path.join(ROOT, rel);
  if (!exists(p)) { say(`${rel.padEnd(34)} **文件不在**`); continue; }
  const src = fs.readFileSync(p, 'utf8');
  say(`${rel.padEnd(34)} ${src.includes(needle) ? `含「${needle}」` : `**不含「${needle}」**`}`);
}
/**
 * 桌面**真实**目录。
 *
 * ⚠️ 为什么不能直接写 `%USERPROFILE%\Desktop`（2026-10-16 定位到的假红）：
 *    建快捷方式那边（`make-shortcut.mjs`）用的是 PowerShell 的
 *    `[Environment]::GetFolderPath('Desktop')` —— 它认 **OneDrive 重定向**与
 *    **用户改过桌面位置**这两种常见情形；而这里若只认 `%USERPROFILE%\Desktop`，
 *    就会在那些机器上出现「**图标明明建好了，diag 却报"不在"**」。
 *    两边必须读**同一个真相源**，所以这里从注册表的 User Shell Folders 取。
 */
function desktopDir() {
  try {
    const out = execFileSync('reg', ['query',
      'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders',
      '/v', 'Desktop'], { encoding: 'utf8', stdio: 'pipe' });
    const m = /Desktop\s+REG_(?:EXPAND_)?SZ\s+(.+)/.exec(out);
    if (m) {
      const v = m[1].trim().replace(/%USERPROFILE%/gi, process.env.USERPROFILE || '');
      if (v) return v;
    }
  } catch { /* 读不到注册表就退回默认（至少不比旧行为更差） */ }
  return path.join(process.env.USERPROFILE || '', 'Desktop');
}
const DESKTOP = desktopDir();
say(`桌面快捷方式  ${exists(path.join(DESKTOP, 'Estrella Bot.lnk')) ? '在' : `不在（查的是 ${DESKTOP}）`}`);

// ── ③ 协议端 ────────────────────────────────────────────────────────────────
head('③ 协议端（NapCat）');
say(`app\\napcat 目录  ${exists(NAPCAT_DIR) ? '在' : '**不在**（协议端没装）'}`);
if (exists(NAPCAT_DIR)) {
  const top = fs.readdirSync(NAPCAT_DIR);
  say(`顶层条目        ${top.join(', ')}`);
  const launchers = [];
  const walk = (d, depth) => {
    if (depth > 3) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (/\.(bat|exe)$/i.test(e.name)) launchers.push(path.relative(NAPCAT_DIR, p));
    }
  };
  walk(NAPCAT_DIR, 0);
  say(`启动器候选      ${launchers.length ? launchers.join(', ') : '**一个都没有**'}`);
  const pkg = path.join(NAPCAT_DIR, 'package.json');
  if (exists(pkg)) { try { say(`协议端版本      ${readJson(pkg).version}`); } catch { /* 读不到就算了 */ } }
  const wj = path.join(NAPCAT_DIR, 'config', 'webui.json');
  say(`webui.json      ${exists(wj) ? (readJson(wj)?.token ? '在，且有 token' : '在，但没有 token') : '不在'}`);

  // 二维码图：是不是一张**完整**的 PNG（裂图与"取不到"同形，必须看字节）
  const qr = path.join(NAPCAT_DIR, 'cache', 'qrcode.png');
  if (!exists(qr)) say('qrcode.png      **不存在**');
  else {
    const b = fs.readFileSync(qr);
    const sig = b.subarray(0, 8).toString('hex');
    const iend = b.subarray(Math.max(0, b.length - 12)).includes(Buffer.from('IEND'));
    say(`qrcode.png      ${b.length} 字节 · 头 ${sig} ${sig === '89504e470d0a1a0a' ? '(PNG 签名对)' : '**(不是 PNG)**'} · 尾 ${iend ? '有 IEND(完整)' : '**缺 IEND(被截断)**'}`);
  }
}

// ── ④ 端口与进程 ────────────────────────────────────────────────────────────
head('④ 端口 / 进程');
for (const [name, port] of [['协议端 OneBot', 3001], ['协议端 HTTP', 3000], ['控制台面板', 8788]]) {
  const open = await portOpen(port);
  say(`${name} ${port}`.padEnd(20) + (open ? '在听' : '**没在听**'));
}
say('');
say('相关进程（映像名 + PID）：');
for (const img of ['node.exe', 'NapCatWinBootMain.exe', 'QQ.exe', 'wscript.exe']) {
  const out = sh('tasklist', ['/fi', `imagename eq ${img}`, '/fo', 'csv']);
  const rows = out.split('\n').slice(1).filter((l) => l.trim());
  say(`  ${img.padEnd(24)} ${rows.length ? rows.map((r) => r.split('","')[1] || r.trim()).join(', ') : '**没有**'}`);
}

// ── ③b 安装痕迹（这一节是"跑没跑过"的直接证据）────────────────────────────
/** 按**显示宽度**补空格（中文算 2 列），否则中英混排的标签会对不齐。 */
function pad(label, width) {
  const w = String(label).split('').reduce((n, c) => n + (c.charCodeAt(0) > 0x2e80 ? 2 : 1), 0);
  return label + ' '.repeat(Math.max(1, width - w));
}

head('③b 安装痕迹 / 启动器日志');
const marker = SETUP_MARKER;
if (exists(marker)) {
  try {
    const m = readJson(marker) || {};
    say(`${pad('安装标记', 16)}在 · 版本 ${m.version} · 装于 ${m.installedAt} · napcatHome ${m.napcatHome || '-'}`);
  } catch { say(`${pad('安装标记', 16)}在，但解析失败`); }
} else say(`${pad('安装标记', 16)}**不在**（一键安装没跑完）`);
say(`${pad('userdata/config.json', 16)}${exists(CONFIG_JSON) ? '在' : '**不在**'}`);
for (const [label, rel] of [['面板启动日志', ['panel', 'start.log']], ['面板运行日志', ['panel', 'panel.log']]]) {
  const p = path.join(USER_ROOT, ...rel);
  say(`${pad(label, 16)}${exists(p) ? '在' : '**不在**'}`);
}
// QQ.exe 是否真的在注册表指向的目录里（NapCat 起不来的常见原因之一）
const reg = sh('reg', ['query', 'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\QQ', '/v', 'UninstallString']);
const m = /"([A-Za-z]:\\[^"]*Uninstall\.exe)"/.exec(reg);
if (m) {
  const qqExe = path.join(path.dirname(m[1]), 'QQ.exe');
  say(`QQ.exe             ${exists(qqExe) ? qqExe : `**不在**（按注册表推的路径：${qqExe}）`}`);
} else say('QQ.exe             注册表里没读到 UninstallString，无从推断');

// ── ⑤ OneBot 配置 ───────────────────────────────────────────────────────────
head('⑤ OneBot 配置（3001/3000 在不在）');
const cfgDir = path.join(NAPCAT_DIR, 'config');
if (!exists(cfgDir)) {
  say('config 目录不在');
} else {
  const all = fs.readdirSync(cfgDir);
  const ob = all.filter((n) => /^onebot11.*\.json$/i.test(n));
  if (ob.length === 0) {
    // ⚠️ 以前这里是**一片空白**，而"没有输出"和"没查"长得一样 —— 排障时最容易被跳过。
    say('**一个 onebot11*.json 都没有**（NapCat 从未登录过，或配置被清过）');
    say(`config 目录里现有：${all.join(', ') || '（空）'}`);
  } else {
    for (const f of ob) {
      let j = null;
      try { j = readJson(path.join(cfgDir, f)); } catch { /* 坏文件照实说 */ }
      const ws = j?.servers?.websocketServers?.length || 0;
      const http = j?.servers?.httpServers?.length || 0;
      say(`${f.padEnd(28)} websocket=${ws} http=${http}${!j ? '  **解析失败**' : ''}`);
    }
  }
}

// ── ⑥ 日志尾部 ──────────────────────────────────────────────────────────────
head('⑥ 面板日志尾部（最后 80 行）');
say(tail(path.join(USER_ROOT, 'panel', 'panel.log'), 80));
head('⑥b 面板启动日志尾部（最后 40 行 —— 启动器写的那个）');
say(tail(path.join(USER_ROOT, 'panel', 'start.log'), 40));
// ── ⑥c 一键安装的逐阶段 boot 日志（2026-10-16 · Windows P0-3）───────────────
// "双击之后卡在哪一步"最省事的证据：onekey 每一步都往 `diag-out/boot-<日期>.log`
// 同步追一行（唯一实现住 `lib/common.mjs` 的 diag()）。这里把**最新那份**的尾部一起收走。
head('⑥c 最近一次 boot 日志（一键安装逐阶段 · 最后 60 行）');
{
  let newest = '';
  try {
    for (const n of fs.readdirSync(OUT)) if (/^boot-.*\.log$/.test(n) && n > newest) newest = n;
  } catch { /* OUT 还不存在：下面按"没有"如实说 */ }
  if (newest) { say(`boot 文件：${newest}`); say(tail(path.join(OUT, newest), 60)); }
  else say('**还没有 boot 日志**（这台机器还没跑过一键安装 / 或日志被清过）');
}

head('⑦ 协议端日志尾部（最后 120 行）');
say(tail(path.join(NAPCAT_DIR, 'napcat.log'), 120));

// ── ⑧ 落盘 + 尝试写共享目录 ─────────────────────────────────────────────────
head('⑧ 输出位置');
fs.mkdirSync(OUT, { recursive: true });
const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
const file = path.join(OUT, `diag-${stamp}.txt`);
fs.writeFileSync(file, lines.join('\n'), 'utf8');
say(`已写入 ${file}`);
if (exists(SHARE)) {
  try {
    fs.copyFileSync(file, path.join(SHARE, path.basename(file)));
    say(`也已复制到共享目录：${SHARE}\\${path.basename(file)}（AI 侧读这里就能看到）`);
  } catch (e) { say(`共享目录写失败：${e.message}`); }
} else {
  // ⚠️ 2026-10-16：客户机里**没有挂载的共享目录**（维护者的传件方式是"把文件夹直接拖进
  //    虚拟机窗口"）⇒ 这一支走到的概率是 100%。所以正文要写清"该往哪儿放"，
  //    而不是旧那句含糊的"发我也行"。
  say(`没找到 ${SHARE} —— 这台机器没有挂载的共享目录（**正常现象**，不是坏了）`);
  say('  请把上面那个文件**从虚拟机窗口直接拖出来**，放到 Mac 的 ~/Documents/UTM-Share');
}
}

main().catch((e) => {
  say(`✗ 取证脚本自己出错：${e && e.message ? e.message : e}`);
  try {
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, 'diag-error.txt'), lines.join('\n'), 'utf8');
  } catch { /* 写不出去就只能看控制台 */ }
  process.exitCode = 1;
});
