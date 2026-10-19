/**
 * 生成 **VM 自用的那一份包**：`Estrella-Bot-napcat/`。
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  为什么会有「两份包」（2026-10-13 维护者指定）
 * ══════════════════════════════════════════════════════════════════════════
 *   · `Estrella-Bot/`（**无后缀**）—— 对外分发的那一份。它**不含**协议端：
 *     NapCat 是第三方项目，按它自己的许可**不能随本包分发**，所以首装时现下。
 *     要打 zip 就打这一份（`make-zip.py` 会**硬拦**另一份，见它的 refuse_vm_bundle）。
 *   · `Estrella-Bot-napcat/`（**带 -napcat 后缀**）—— **只在虚拟机/本机自用**。
 *     内容 = 上面那份 + 把 `NapCat.Shell` 预先装进 `userdata\napcat`，
 *     于是 VM 里跑「一键安装」时**不再联网下载**（`installNapcat()` 见到启动器就跳过）。
 *
 *  为什么要整份复制而不是"就地塞进同一份"：对外那份必须保持**不含第三方协议端**，
 *  而自用的必须**含**。两个相反的要求，只能靠两份目录来满足 ——
 *  用一个开关在同一份上反复增删，迟早会留下一次"忘了删/忘了加"。
 *
 * ⚠️⚠️ **本脚本绝不删除任何东西**：目标目录已存在时是**覆盖式复制**（不 rm）。
 *     删除属于 G7 闸门（必须维护者逐条批准），所以这里刻意不实现"先清空再拷"。
 *
 * 用法：
 *   node packaging/windows/make-vm-copy.mjs                 # 用默认路径
 *   node packaging/windows/make-vm-copy.mjs --src <④> --napcat <协议端目录> --out <④b>
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isNapcatLauncherName } from './tools/lib/napcat-shape.mjs';

const HOME = process.env.HOME || '';
const DIST = path.join(HOME, 'Desktop', 'estrella-dist');

const DEF = {
  src: path.join(DIST, 'Estrella-Bot'),
  napcat: path.join(DIST, 'NapCat.Shell'),
  out: path.join(DIST, 'Estrella-Bot-napcat'),
};

function argOf(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? String(process.argv[i + 1] || '') : '';
}

const SRC = argOf('--src') || DEF.src;
const NAPCAT = argOf('--napcat') || DEF.napcat;
const OUT = argOf('--out') || DEF.out;

const say = (s) => console.log(s);
const ok = (s) => console.log(`✔ ${s}`);
const bad = (s) => { console.error(`✗ ${s}`); process.exitCode = 1; };

/**
 * 目录里有没有像样的协议端启动器。
 * 判据**不再自己写一份**（2026-10-18 · P6）：以前这里抄了一份正则，
 * 于是"官方改了启动器名字"会出现 tools 侧认得、构建脚本认不得的分叉。
 * 现在两边共用 `tools/lib/napcat-shape.mjs` 那张候选表。
 */
function hasLauncher(dir) {
  if (!fs.existsSync(dir)) return false;
  try {
    for (const name of fs.readdirSync(dir)) {
      if (isNapcatLauncherName(name)) return true;
      const sub = path.join(dir, name);
      if ((name === 'NapCat.Shell' || name.toLowerCase().includes('napcat'))
        && fs.statSync(sub).isDirectory() && hasLauncher(sub)) return true;
    }
  } catch { /* 读不了就当没有 */ }
  return false;
}

/** 覆盖式复制目录内容（src/* → dst/*），不删目标里已有的东西。 */
function copyInto(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    if (name === '.DS_Store') continue;
    const from = path.join(src, name);
    const to = path.join(dst, name);
    fs.cpSync(from, to, { recursive: true, force: true });
  }
}

function dirSizeMb(dir) {
  let total = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else { try { total += fs.statSync(p).size; } catch { /* 跳过 */ } }
    }
  };
  try { walk(dir); } catch { /* 读不到就返回已知值 */ }
  return total / 1048576;
}

// ── ① 前置检查 ──────────────────────────────────────────────────────────────
if (!fs.existsSync(SRC)) {
  bad(`找不到源包 ${SRC} —— 先按 packaging/windows/README.md 构建 ④`);
  process.exit(1);
}
if (!fs.existsSync(path.join(SRC, 'app', 'panel', 'server.js'))) {
  bad(`${SRC} 里没有 app/panel/server.js —— 这不是一份完整的包`);
  process.exit(1);
}
if (!hasLauncher(NAPCAT)) {
  bad(`${NAPCAT} 里没有协议端启动器（launcher*.bat / NapCatWinBootMain.exe）。
     把官方 NapCat.Shell.zip 解压到 ${NAPCAT} 再跑本脚本。`);
  process.exit(1);
}

say(`源包    ${SRC}`);
say(`协议端  ${NAPCAT}`);
say(`产物    ${OUT}`);
say('');

// ── ② 复制 ④（覆盖，不删）──────────────────────────────────────────────────
copyInto(SRC, OUT);
ok('已复制 ④（覆盖式，未删除任何东西）');

// ── ③ 注入协议端：NapCat.Shell 的**内容**平铺进 userdata/napcat ──────────────
// ⚠️ P1 起 NapCat 整个是用户级组件（程序 + config + QQ 登录态），不再放 app/。
//    平铺（不留 NapCat.Shell/ 子目录）与「安装脚本自己解压」的结果同形。
const destNap = path.join(OUT, 'userdata', 'napcat');
copyInto(NAPCAT, destNap);
if (!hasLauncher(destNap)) {
  bad(`注入后 ${destNap} 里仍然找不到启动器 —— 这份包的协议端是坏的`);
  process.exit(1);
}
ok(`已注入协议端 → userdata\\napcat（VM 上首装会认出已装好，不再下载）`);

// ── ④ 打标记：这份包不许对外分发 ────────────────────────────────────────────
const marker = path.join(OUT, 'VM-ONLY.txt');
fs.writeFileSync(marker, [
  '这份包 = Estrella-Bot/ + 预装好的协议端（NapCat）。',
  '',
  '用途：**只**在本机 / 虚拟机里自用 —— 省掉首次安装时的那次下载。',
  '',
  '⚠️⚠️ 不许压缩、不许对外发布、不许发给任何人：',
  '   NapCat 是第三方项目，按它自己的许可**不能随本包分发**。',
  '   要打对外分发的 zip，请用同目录下不带后缀的那一份：Estrella-Bot/',
  '   （make-zip.py 里有硬闸，见到本文件或 userdata/napcat 里的启动器会直接拒绝打包）。',
  '',
  `生成时间：${new Date().toISOString().replace('T', ' ').slice(0, 19)}`,
  `由 packaging/windows/make-vm-copy.mjs 生成 —— 每次更新 ④ 之后重跑一次即可。`,
  '',
].join('\n'), 'utf8');
ok('已写入 VM-ONLY.txt（make-zip.py 见到它就拒绝压缩）');

// ── ⑤ BUILD-INFO 写一段说明，说明这份的来历 ─────────────────────────────────
// ⚠️ 幂等：这段说明**替换**而不是追加 —— 本脚本"每次更新 ④ 之后都会重跑"，
//    用追加的话跑十次就叠十段，而重复的段落会让"这份包到底哪来的"更难读。
// ⚠️⚠️ 分隔点必须是**本段独有的标题行**，不能拿 `⚠️ ` 这种在原文里到处都有的
//    前缀去 indexOf（实测踩过：那样会命中文件里第一处「⚠️」，
//    把整段构建历史拦腰截断 —— 而源包那边还是好的，症状只有"历史凭空少了"）。
// ⚠️ 标题里**不带**前导 `· `：模板那一行会自己拼一个分隔点，带了就会出现「· ·」。
const VM_HEAD = '本份是 **VM 自用变体**（Estrella-Bot-napcat）';
const buildInfo = path.join(OUT, 'BUILD-INFO.txt');
if (fs.existsSync(buildInfo)) {
  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const block = [
    `⚠️ ${stamp} · ${VM_HEAD}`,
    '----------------------------------------------------------------',
    '组成    Estrella-Bot/ 的全部内容 + 预装协议端（NapCat.Shell → userdata\\napcat）',
    '用途    只在本机/虚拟机里跑 —— 一键安装时不再联网下载协议端',
    '⛔ 禁止  压缩 / 对外发布 / 发给他人（第三方协议端不许随包分发）',
    '         要打 zip 请用不带后缀的那一份（make-zip.py 有硬闸拦着这一份）',
    '',
    '关于真值复扫：扫**这一份**会看到 1 处命中 ——',
    '  userdata/napcat/static/assets/index-*.js 里有 NapCat 自带 WebUI 某个表单的',
    '  placeholder 文本（长得很像私钥块的那串标记），',
    '不是真私钥，也不在我们能改的代码里。对外那份（不含协议端）扫出来是 0 命中。',
    '  ⚠️ 本文件**刻意不写出**那串标记的字面量：写了会让发布面的真值复扫命中',
    '  （2026-10-15 `packaging/` 纳入发布面后实测踩到，故改为描述性写法）。',
    '',
  ].join('\n');
  const cur = fs.readFileSync(buildInfo, 'utf8');
  const at = cur.indexOf(VM_HEAD);
  // 找到标题 ⇒ 回退到它所在那一行的行首，把旧块整块换掉；找不到 ⇒ 拼在文末
  const head = at >= 0 ? cur.slice(0, cur.lastIndexOf('\n', at) + 1) : cur;
  fs.writeFileSync(buildInfo, `${head.replace(/\s+$/, '\n')}\n${block}`, 'utf8');
  ok('已在 BUILD-INFO.txt 写入 VM 变体说明（幂等替换，不叠段、不截历史）');
}

say('');
say(`产物体积约 ${dirSizeMb(OUT).toFixed(0)} MB（含协议端）`);
say('下一步：把整个 Estrella-Bot-napcat/ 拷进虚拟机，双击「一键安装.bat」。');
