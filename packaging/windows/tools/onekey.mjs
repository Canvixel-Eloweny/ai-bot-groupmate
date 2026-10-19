/**
 * 一键安装 · 唯一入口（`一键安装.bat` 调它）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  一条命令跑完的四件事（顺序就是屏幕上的顺序）
 * ══════════════════════════════════════════════════════════════════════════
 *   ① 环境检测 —— 这台机器上现在有什么（Node / NapCat / QQ 各自装没装、是几版）
 *   ② 版本校验 —— 把"装着的"与"要求 / 最新"摆在一起比一次，说清差在哪
 *   ③ 自动修复 —— 缺的装、旧的更新（**Node 与 NapCat 自动；QQ 只引导**）
 *   ④ 拉起控制台 —— 起面板（**无黑窗口**）+ 开浏览器；并在桌面建好快捷方式
 *
 *  之后日常只用双击桌面上的 **Estrella Bot** 图标：它会走 `start.mjs`，
 *  协议端用**快速登录**（免扫码）、面板后台无窗口、浏览器直接开到控制台页面。
 *
 *  ⚠️ 它是**幂等**的：装过的机器再跑一次只会做"检查 + 补缺 + 拉起"。
 *     这一点是硬要求 —— 用户遇到问题时最常见的动作就是"再双击一次"。
 *
 *  ⚠️ 与 `1-SETUP.bat` 的关系：那是**老的**首次安装入口，逻辑仍能用；
 *     本入口把它那几步（生成配置 / 装协议端 / 对齐端口）**串进同一条命令**里，
 *     并且多了版本校验与自动更新。两边共用 `setup.mjs` 里那两个函数 ——
 *     "配置长什么样"仍然只有一份实现。
 */

import path from 'node:path';
import {
  ROOT, PROGRAM_ROOT, USER_ROOT, SETUP_MARKER, IS_WIN, VERSION,
  say, ok, warn, bad, title, dim, ask, writeJson, isMain, diag,
  loadNapcatSource, napcatHome, NAPCAT_DIR,
} from './lib/common.mjs';
import { collectEnv } from './check-env.mjs';
import { collectVersions } from './lib/versions.mjs';
import { ensureNodeRuntime, ensureNapcat, ensureQQ } from './lib/repair.mjs';
import { ensureConsole, PANEL_URL } from './lib/console.mjs';
import { makeShortcut } from './make-shortcut.mjs';
import { ensureConfigJson, writeOnebotConfig } from './setup.mjs';
import { startNapcat } from './start-napcat.mjs';
import { migrateIfNeeded } from './migrate.mjs';

const PROTOCOL_PORT = 3001;

const argOf = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? String(process.argv[i + 1] || '') : '';
};
const has = (...names) => names.some((n) => process.argv.includes(n));

// ── ② 版本校验的呈现 ─────────────────────────────────────────────────────────
const STATE_WORD = { ok: '合格', missing: '未安装', outdated: '版本过低' };

function printVersionTable(items, offline) {
  title('② 版本校验');
  for (const it of items) {
    // ⚠️ 行首那个 ✓/✗/! 由 `ok/warn/bad` 自己画，这里**不要再拼一个** ——
    //    拼了就是"✓ ✓"，而多出来的那一个看起来像解析出错。
    const verdict = it.outdated ? '有新版本' : (STATE_WORD[it.state] || '未知');
    const line = `${it.name}：${it.state === 'missing' ? '未安装' : `已装 ${it.installed || '（版本不明）'}`}`
      + `${it.latest ? ` · 最新 ${it.latest}` : ''}`
      + `${it.need ? ` · 要求 ≥ ${it.need}` : ''} — ${verdict}`;
    (it.state === 'ok' && !it.outdated ? ok : it.state === 'missing' ? bad : warn)(line);
    if (it.note) dim(`      ${it.note}`);
    if (it.path) dim(`      位置：${it.path}`);
  }
  if (offline) {
    say('');
    dim('  ⓘ 查不到各组件的最新版本（离线？）—— **只按"够不够用"判**，不会因此判定失败。');
  }
}

// ── 主流程 ──────────────────────────────────────────────────────────────────
async function main() {
  say('');
  say(`  Estrella Bot 一键安装 v${VERSION}`);
  say('  ' + '─'.repeat(48));
  dim('  一条命令做完：检测 → 校验 → 自动修复 → 打开控制台。');
  diag(`一键安装启动 v${VERSION}（参数：${process.argv.slice(2).join(' ') || '无'}）`);

  const yes = has('--yes', '-y');
  const onlyCheck = argOf('--only') === 'check';
  const updateNode = has('--update-node');
  const noShortcut = has('--no-shortcut');
  const noBrowser = has('--no-browser');

  // ── ① 环境检测 ────────────────────────────────────────────────────────────
  title('① 环境检测');
  const env = await collectEnv();
  for (const it of env) {
    const tag = it.level === 'ok' ? ok : it.level === 'warn' ? warn : bad;
    // 只报**不合格**的：11 项全打印一遍，用户要找的那条会被淹掉
    if (it.level !== 'ok') { tag(`${it.name}：${it.detail}`); if (it.fix) dim(`      ↳ 怎么办：${it.fix}`); }
  }
  const fatal = env.filter((i) => i.level === 'err');
  if (fatal.length > 0) {
    say('');
    bad(`有 ${fatal.length} 项硬错误必须先解决（上面带 ↳ 的行就是怎么解决）。`);
    diag(`① 环境检测：${fatal.length} 项硬错误，已中止`);
    process.exitCode = 1;
    return;
  }
  ok('基础环境就绪（包体完整、内嵌运行时在位）');
  diag(`① 环境检测通过（ok=${env.filter((i) => i.level === 'ok').length} · warn=${env.filter((i) => i.level === 'warn').length}）`);

  const src = loadNapcatSource();
  const { items, offline } = await collectVersions(src);
  printVersionTable(items, offline);
  diag(`② 版本：${items.map((i) => `${i.id}=${i.installed || 'none'}`).join(' · ')}${offline ? ' · 离线' : ''}`);

  if (onlyCheck) {
    const blocking = items.filter((i) => i.state === 'missing' || i.state === 'outdated');
    say('');
    say(blocking.length === 0 ? '  结论：全部合格，无需修复。' : `  结论：${blocking.length} 项待修复（跑不带 --only=check 的同一条命令即可自动修）。`);
    diag(`--only=check 结论：${blocking.length === 0 ? '全部合格' : `${blocking.length} 项待修复`}`);
    process.exitCode = blocking.length === 0 ? 0 : 1;
    return;
  }

  if (!IS_WIN) {
    say('');
    warn('当前不是 Windows —— 本包是给 Windows 用户打的，后续步骤在这里跑不出结果。');
    dim('  在 Windows 上（或虚拟机里）双击 一键安装.bat 才会真正走完。');
    return;
  }

  // ── ②.5 旧数据迁移（必须在装/升级 NapCat 与生成配置之前）──────────────────
  title('②.5 旧数据迁移');
  const mig = migrateIfNeeded({ source: PROGRAM_ROOT, userRoot: USER_ROOT });
  if (mig.status === 'failed') {
    bad(`旧数据迁移失败：${mig.error || mig.reason}`);
    bad('旧数据仍在原处；先处理上面的原因，再重跑一键安装。');
    process.exitCode = 1;
    return;
  } else if (mig.status === 'complete') {
    ok(`旧数据已复制到 userdata（${mig.files} 个文件，冲突 ${mig.conflicts.length}）`);
  } else {
    dim(`旧数据迁移：${mig.reason || '无需迁移'}`);
  }

  // ── ③ 自动修复 ────────────────────────────────────────────────────────────
  title('③ 自动修复');
  const repairLog = [];

  // ③-1 Node（包内自带）
  try {
    const r = await ensureNodeRuntime({ updateToLatest: updateNode });
    const line = `Node ${r.version}：${r.state === 'fixed' ? '已自动修复' : '无需改动'}${r.note ? `（${r.note}）` : ''}`;
    repairLog.push(line);
    diag(`③-1 ${line}`);
  } catch (e) {
    bad(`Node 这一步没修好：${e.message}`);
    repairLog.push('Node：修复失败（见上面的说明）');
    diag(`③-1 Node 修复失败：${String(e.message || e).split('\n')[0]}`);
  }

  // ③-2 NapCat（协议端）
  try {
    const r = await ensureNapcat({ update: true });
    const stateWord = { installed: '已安装', updated: '已更新', unchanged: '无需改动' }[r.state] || r.state;
    const shaWord = r.sha256Source
      ? `（sha256：${r.sha256Source === 'unverified' ? '**未校验**（没拿到官方哈希）' : `已校验 · ${r.sha256Source}`}）`
      : '';
    const line = `NapCat：${stateWord}${shaWord}`;
    repairLog.push(line);
    diag(`③-2 ${line}`);
  } catch (e) {
    bad(`NapCat 这一步没修好：${e.message}`);
    if (/所有下载源都失败了/.test(e.message)) {
      say('  离线办法：自己到官方 Releases 页下载 NapCat.Shell.zip，');
      say(`  放到 ${path.relative(ROOT, path.join(NAPCAT_DIR, 'NapCat.Shell.zip'))}，然后重新双击一键安装。`);
      say(`  页面：${src.manual.page}`);
    }
    repairLog.push('NapCat：修复失败（见上面的说明）');
    diag(`③-2 NapCat 修复失败：${String(e.message || e).split('\n')[0]}`);
  }

  // ③-3 QQ（只引导 —— 见 lib/repair.mjs 文件头纪律 ①）
  const qqItem = items.find((i) => i.id === 'qq');
  if (qqItem && qqItem.state === 'missing') {
    const r = await ensureQQ({ yes });
    const line = `QQ：${{ fixed: '已安装', guided: '已引导安装（需你确认一次）', 'need-confirm': '待你确认', skip: '跳过' }[r.state] || r.state}`;
    repairLog.push(line);
    diag(`③-3 ${line}`);
  }

  // ③-4 运行配置（首次）
  title('④ 运行配置');
  let cfgCreated = false;
  try {
    const r = ensureConfigJson();
    cfgCreated = r.created;
  } catch (e) {
    bad(`配置没生成：${e.message}`);
  }

  // ⚠️ **不问 QQ 号**（2026-10-13 移除，与 setup.mjs 同一处改动）：
  //    以前这里会 ask(...) 或读 `--qq`，并把号记进 marker 供快速登录用。
  //    手填号码的风险是"谁都能拿别人的号去登录"，所以整条路关掉 ——
  //    登录改由**扫码**完成，扫完之后 NapCat 自己记住账号（以后自动免扫）。
  //    这里只把端口模板写好（不带账号），其余交给 start-napcat 的 alignKnownAccounts()。
  const { dest, tplDest } = writeOnebotConfig('');
  if (dest) ok(`已写入 ${path.relative(ROOT, dest)}`);
  ok(`已写入模板 ${path.relative(ROOT, tplDest)}（任何 QQ 号首次登录都能直接用）`);
  dim('      WebSocket 服务端 3001 · HTTP 服务端 3000 · 仅监听 127.0.0.1');
  writeJson(SETUP_MARKER, { version: VERSION, installedAt: new Date().toISOString(), napcatHome: path.relative(ROOT, napcatHome() || NAPCAT_DIR) });
  diag(`④ 运行配置：config ${cfgCreated ? '已生成' : '已存在'} · onebot 模板已写入`);

  // ── ④ 拉起控制台 ──────────────────────────────────────────────────────────
  title('⑤ 拉起控制台');
  let napcatWord = '未重新拉起（大概率已在运行）';
  try {
    const r = await startNapcat();
    if (r.error === 'no-launcher') {
      napcatWord = '未装好（no-launcher）';
      warn('协议端还没装好 —— 控制台照样打开，但机器人连不上 QQ');
    } else if (r.started) {
      napcatWord = '已后台拉起';
      dim('  协议端已在后台拉起（**没有黑窗口**，日志进 app\\napcat\\napcat.log）');
    }
  } catch (e) {
    napcatWord = `出错：${String(e.message || e).split('\n')[0]}`;
    warn(`协议端这一步出错：${e.message}`);
    dim('  不影响打开控制台；首次登录需要扫码，网页里的「终端」页会显示二维码。');
  }
  diag(`⑤ 协议端：${napcatWord}`);

  const c = await ensureConsole({ open: !noBrowser });
  say('');
  ok(c.opened ? `已打开浏览器：${PANEL_URL}` : `控制台地址：${PANEL_URL}`);
  diag(`⑤ 界面：opened=${c.opened} · ${c.reused ? '复用已在跑的面板' : '新拉起面板'}`);
  say('  控制台在**后台**跑，没有黑窗口；要停它就在页面里点「退出控制台」。');

  // ── ⑤ 桌面快捷方式 ────────────────────────────────────────────────────────
  if (!noShortcut) {
    title('⑥ 桌面快捷方式');
    const want = yes || (await ask('在桌面建一个「Estrella Bot」快捷方式？', {
      def: 'y', validate: (v) => (/^[yn]/i.test(v) ? null : '请输入 y 或 n'),
    })).toLowerCase().startsWith('y');
    if (want) {
      // ⚠️ 这行在 makeShortcut() **之前**打（2026-10-16 维护者点名）：建快捷方式要走一次
      //    PowerShell（冷启动 + 写 .lnk 有一两秒），按完 Y 干等着会让人以为卡死了。
      say('  正在创建快捷方式，请勿关闭窗口……');
      const r = makeShortcut();
      if (r.ok) { ok(`已建好 —— 以后双击桌面图标即可进入控制台（耗时 ${r.ms} ms）`); dim(`      ${r.path}`); diag(`⑥ 快捷方式：已建（${r.ms} ms）`); }
      else { warn(`没建成（耗时 ${r.ms} ms）：${r.msg}`); diag(`⑥ 快捷方式：未建成 —— ${r.msg}`); }
    } else {
      diag('⑥ 快捷方式：用户跳过');
    }
  } else {
    diag('⑥ 快捷方式：按参数 --no-shortcut 跳过');
  }

  // ── 收尾 ──────────────────────────────────────────────────────────────────
  title('好了。接下来：');
  say('  1. 浏览器里就是控制台 —— 首次使用点「协议端」那一页，**用手机 QQ 扫一次码**登录小号。');
  say('  2. 扫码成功过一次之后，以后双击桌面图标会**自动登录**（不会再要扫码）。');
  say('  3. 在控制台里填「放行的群号」和模型 API Key，然后点右上角「一键启动」。');
  say('');
  for (const line of repairLog) dim(`  · ${line}`);
  say('');
  diag(`收尾：exit=${process.exitCode || 0} · 共 ${repairLog.length} 条修复记录`);
  dim('  提醒：一定要用小号。第三方协议端存在封号风险，别拿主号冒险。');
}

if (isMain(import.meta.url)) {
  try {
    await main();
  } catch (e) {
    say('');
    bad(`一键安装中断：${e && e.message ? e.message : e}`);
    say('  把上面这段原样贴出来即可；或先跑 一键安装.bat --only=check 只看检测结果。');
    diag(`一键安装中断：${String(e && e.message ? e.message : e).split('\n')[0]}`);
    process.exitCode = 2;
  }
}
