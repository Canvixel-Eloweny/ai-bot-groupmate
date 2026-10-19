/**
 * 从 **VM 自用包**（`Estrella-Bot-napcat/`）派生出一份**对外分发包**。
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  为什么需要它（2026-10-16 维护者定的新数据流）
 * ══════════════════════════════════════════════════════════════════════════
 *  旧链路：`④ Estrella-Bot/`（对外）──make-vm-copy.mjs──▶ `④b Estrella-Bot-napcat/`（VM 自用）
 *  两份包各带一份**完全相同的 `app/`** ⇒ 常驻两份 = 白占 ~113 MB。
 *
 *  维护者 2026-10-16 的口径：**只常驻 `④b`**，对外那一份**用到时再派生出临时一份**，
 *  传完就删。于是 `Estrella-Bot/` 常态**不存在**，本脚本负责按需重建它。
 *
 *  ⚠️⚠️ **为什么是"复制派生"而不是"把 NapCat 移出去再移回来"** ——
 *     维护者最初的想法是后者，这里改掉，三条理由都踩过或必然踩到：
 *
 *     ① **登录态会丢**：QQ 登录态住在 `userdata/napcat/config/`。就地移动那个目录，
 *        一旦协议端在跑（Windows 上运行中的文件不能删/不能移）就会半途失败，
 *        症状是"又要重新扫码"。**复制**没有这个风险。
 *     ② **会绕过一道刻意设的机器闸**：`make-zip.py` 的 `refuse_vm_bundle()` 见到
 *        `userdata/napcat` 里的启动器、或包根有 `VM-ONLY.txt` 就**拒绝打包**——它防的是
 *        "手滑选了带协议端的那一份，打出来能装能用，只是把不该分发的东西发了出去"。
 *        手工移出会让 `userdata/napcat` 检查通过 ⇒ 闸失效。
 *     ③ **说明面会跟着错**：`BUILD-INFO.txt` 尾部那段「⛔ 禁止压缩/对外发布」
 *        是 `make-vm-copy.mjs` 写进去的，而它**不在** `SHA256SUMS.txt` 里 ⇒
 *        没有任何闸会拦它。就地移出会让这段声明**随对外包一起发出去**。
 *
 *  ⇒ 本脚本做的正是这三件事的**反面**：复制、剪干净、把说明面改回来，并且**不删任何东西**
 *    （源包一个字节都不动；目标目录已存在时**拒绝执行**，绝不 rm —— 删除属于 G7 闸门）。
 *
 *  用法：
 *    node packaging/windows/make-publish-from-vm.mjs                 # 只派生，不打包
 *    node packaging/windows/make-publish-from-vm.mjs --dry-run       # 只报要做什么
 *    node packaging/windows/make-publish-from-vm.mjs --zip           # 派生 + 清单 + 打 zip + 真值复扫
 *    node packaging/windows/make-publish-from-vm.mjs --src <④b> --out <④>
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url)); // packaging/windows
const REPO = path.dirname(path.dirname(HERE));             // 仓库根
const HOME = process.env.HOME || '';
const DIST = path.join(HOME, 'Desktop', 'estrella-dist');

const DEF = {
  src: path.join(DIST, 'Estrella-Bot-napcat'),
  out: path.join(DIST, 'Estrella-Bot'),
};

function argOf(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? String(process.argv[i + 1] || '') : '';
}
const has = (flag) => process.argv.includes(flag);

const SRC = argOf('--src') || DEF.src;
const OUT = argOf('--out') || DEF.out;
const DRY = has('--dry-run');
const ZIP = has('--zip');

const say = (s) => console.log(s);
const ok = (s) => console.log(`✔ ${s}`);
const bad = (s) => { console.error(`✗ ${s}`); process.exitCode = 1; };

/**
 * `make-vm-copy.mjs` 写进 BUILD-INFO 的那段说明的**标题行**。
 * ⚠️ 必须与那个脚本里的常量**逐字一致**（两处都改才行）——它是"剥掉这段"的锚点，
 *    用错了会剥不干净，而对外的包里留一句「⛔ 禁止对外发布」是自相矛盾的。
 */
const VM_HEAD = '本份是 **VM 自用变体**（Estrella-Bot-napcat）';

/** 走 `python3` 的步骤统一从这里过：非 0 就整体失败（fail-closed，不许静默继续） */
function py(script, args) {
  const r = spawnSync('python3', [path.join(HERE, script), ...args], { stdio: 'inherit' });
  if (r.error) { bad(`跑不起来 python3（${script}）：${r.error.message}`); return false; }
  if (r.status !== 0) { bad(`${script} 退出码 ${r.status} —— 停下，不继续`); return false; }
  return true;
}

/** 复制时要跳过的东西：协议端、VM 标记、以及 macOS/Windows 的目录垃圾 */
function skipOf(rel) {
  const p = rel.split(path.sep).join('/');
  if (p === 'app/napcat' || p.startsWith('app/napcat/')) return false;
  if (p === 'userdata/napcat' || p.startsWith('userdata/napcat/')) return false;
  if (p === 'VM-ONLY.txt') return false;
  if (['.DS_Store', 'Thumbs.db', 'desktop.ini'].includes(path.basename(p))) return false;
  return true;
}

// ── ① 前置检查 ──────────────────────────────────────────────────────────────
if (!fs.existsSync(SRC)) {
  bad(`找不到源包 ${SRC} —— 本脚本从 **VM 自用包**派生，请确认它还在。`);
  process.exit(1);
}
for (const rel of ['app/panel/server.js', 'app/node_modules/ws/package.json', '一键安装.bat']) {
  if (!fs.existsSync(path.join(SRC, rel))) {
    bad(`${SRC} 里没有 ${rel} —— 这不是一份完整的包。`);
    process.exit(1);
  }
}
/**
 * ⚠️ 源包必须**真的含协议端**。否则说明它已经被剪过一次（或本身就不是 ④b），
 *    本脚本会安静地派生出一份"看起来正常"的对外包 —— 而那等于把"我剪干净了"
 *    这句话变成了一句没人验证过的话。宁可当场拒。
 */
const napDir = path.join(SRC, 'userdata', 'napcat');
const napHasLauncher = (() => {
  if (!fs.existsSync(napDir)) return false;
  const stack = [napDir];
  while (stack.length) {
    const d = stack.pop();
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      if (e.isDirectory()) stack.push(path.join(d, e.name));
      else if (/\.(bat|exe|cmd)$/i.test(e.name)) return true;
    }
  }
  return false;
})();
if (!napHasLauncher) {
  bad(`源包 ${SRC} 的 userdata/napcat 里找不到任何 .bat/.exe/.cmd —— 它不是一份含协议端的 ④b。`);
  bad('  本脚本要挡的是"对着已经剪过的包再剪一次"，所以这里 fail-closed。');
  process.exit(1);
}
if (!fs.existsSync(path.join(SRC, 'VM-ONLY.txt'))) {
  bad(`源包 ${SRC} 里没有 VM-ONLY.txt —— 它不像 make-vm-copy.mjs 产出的那一份。`);
  process.exit(1);
}

// ── ② 目标目录：**已存在就拒绝**（绝不删除 —— 删除属于 G7 闸门）────────────────
if (fs.existsSync(OUT)) {
  bad(`目标目录已存在：${OUT}`);
  bad('  本脚本**绝不删除任何东西**。请先自己处理它（删掉 / 改名 / 用 --out 指到别处），再重跑。');
  process.exit(1);
}

say(`源包（④b）  ${SRC}`);
say(`产物（④）   ${OUT}`);
say(`模式         ${DRY ? '只报告，不落盘' : ZIP ? '派生 + 清单 + 打 zip + 真值复扫' : '只派生'}`);
say('');

if (DRY) {
  ok('--dry-run：到此为止。上面就是本脚本会做的事（复制、剪 userdata/napcat、删 VM-ONLY、改回 BUILD-INFO）。');
  process.exit(process.exitCode || 0);
}

// ── ③ 复制（跳过协议端 / VM 标记 / 目录垃圾）──────────────────────────────────
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.cpSync(SRC, OUT, { recursive: true, force: true, filter: (s) => skipOf(path.relative(SRC, s)) });
ok('已复制（**复制**，不是移动 —— 源包一个字节都没动）');

// ── ④ 说明面改回"对外"：剥掉 BUILD-INFO 里的 VM 段 ────────────────────────────
const buildInfo = path.join(OUT, 'BUILD-INFO.txt');
if (fs.existsSync(buildInfo)) {
  const cur = fs.readFileSync(buildInfo, 'utf8');
  const at = cur.indexOf(VM_HEAD);
  if (at < 0) {
    // 不静默：剥离没发生就要说出来（否则对外包里可能留着"禁止对外发布"）
    bad(`BUILD-INFO.txt 里找不到 VM 段锚点「${VM_HEAD}」—— 没有剥到任何东西，请人工确认。`);
  } else {
    const headEnd = cur.lastIndexOf('\n', at) + 1;      // 回退到标题行行首
    // 标题行以 `⚠️ <时间> · ` 开头，再回退到那一行的行首即可把整段拿走
    fs.writeFileSync(buildInfo, cur.slice(0, headEnd).replace(/\s+$/, '\n'), 'utf8');
    ok('BUILD-INFO.txt 已剥离 VM 自用段（对外包里不再有「⛔ 禁止对外发布」）');
  }
} else {
  bad('产物里没有 BUILD-INFO.txt —— 这份包无法溯源（README 第 8 步要求每份包一份）。');
}

// ── ⑤ 自证（fail-closed）：这七条全过，这次派生才算数 ─────────────────────────
const checks = [
  ['产物里没有 app/napcat（协议端已剪掉）', !fs.existsSync(path.join(OUT, 'app', 'napcat'))],
  ['产物里没有 userdata/napcat（协议端已剪掉）', !fs.existsSync(path.join(OUT, 'userdata', 'napcat'))],
  ['产物里没有 VM-ONLY.txt', !fs.existsSync(path.join(OUT, 'VM-ONLY.txt'))],
  ['BUILD-INFO 里没有 VM 段残留',
    !fs.existsSync(buildInfo) || !fs.readFileSync(buildInfo, 'utf8').includes(VM_HEAD)],
  ['程序本体在（app/panel/server.js）', fs.existsSync(path.join(OUT, 'app', 'panel', 'server.js'))],
  ['唯一运行时依赖在（app/node_modules/ws/package.json）',
    fs.existsSync(path.join(OUT, 'app', 'node_modules', 'ws', 'package.json'))],
  ['没有 ws 嵌套（app/node_modules/ws/ws 不存在）',
    !fs.existsSync(path.join(OUT, 'app', 'node_modules', 'ws', 'ws'))],
  ['内嵌运行时在（runtime/node/node.exe）', fs.existsSync(path.join(OUT, 'runtime', 'node', 'node.exe'))],
];
for (const [what, pass] of checks) {
  if (pass) ok(what);
  else bad(what);
}
if (process.exitCode) {
  bad('自证没过 —— **不要**拿这一份去打包。先按上面那条红字修，再重跑本脚本。');
  process.exit(1);
}

// ── ⑥ 可选：清单 → zip → 真值复扫（四道闸一个不绕）──────────────────────────
if (ZIP) {
  const pkgJson = JSON.parse(fs.readFileSync(path.join(OUT, 'app', 'package.json'), 'utf8'));
  const ver = String(pkgJson.version || '').trim();
  if (!ver) { bad('读不到 app/package.json 的 version'); process.exit(1); }
  const zipOut = path.join(DIST, `Win-v${ver}.zip`);
  say('');
  say('── 清单 ──');
  if (!py('make-sums.py', [OUT])) process.exit(1);
  say('── 打包 ──');
  if (!py('make-zip.py', [OUT, zipOut, `Win-v${ver}`])) process.exit(1);
  say('── 真值复扫 ──');
  const r = spawnSync(process.execPath, [path.join(REPO, 'packaging', 'windows', 'scan-package.mjs'), OUT],
    { stdio: 'inherit' });
  if (r.status !== 0) { bad(`scan-package.mjs 退出码 ${r.status} —— 复扫命中，停下来看上面`); process.exit(1); }
  ok(`真值复扫 0 命中 · zip 在 ${zipOut}`);
}

say('');
say(`产物：${OUT}`);
say('⚠️ 这一份是**临时派生品**：传完之后可以删掉它（需要时随时用本脚本重建），');
say('   —— 常驻两份包 = 白占 ~113 MB，维护者 2026-10-16 已定过口径。');
say('⚠️ 要更新 VM 自用包时，旧链路仍是 make-vm-copy.mjs（④ → ④b）；');
say('   若 ④ 不在，先用本脚本产出一份 ④，再用 --src 指过去。');
