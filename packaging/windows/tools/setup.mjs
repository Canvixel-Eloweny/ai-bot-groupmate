/**
 * 首次安装向导（`1-SETUP.bat` 调它）。**幂等**：重复运行不会破坏已有配置。
 *
 * 它做四件事，顺序有意义：
 *   ① 环境自检 —— 有硬错误就停下，不生成半成品状态
 *   ② 生成 `app/config.json`（从脱敏模板），并**修掉模板里两个已知的坑**
 *   ③ 装协议端：从官方 Release 下载 `NapCat.Shell.zip` 并解压
 *   ④ 写 NapCat 的 OneBot11 配置，把端口对齐到 3001/3000
 *
 * 为什么不用"向导式多步交互"：用户是双击 bat 的普通群成员，一屏能看完的说明比
 * 分步问答更不容易出错。只在**必须由人决定**的地方提问（机器人 QQ 号）。
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  NAPCAT_DIR, NAPCAT_ZIP, CONFIG_JSON, CONFIG_EXAMPLE, SETUP_MARKER, ROOT, PROGRAM_ROOT, USER_ROOT, IS_WIN, VERSION,
  say, ok, warn, bad, title, dim, exists, readJson, writeJson,
  downloadWithMirrors, unzip, loadNapcatSource, isMain, humanSize, napcatUrls,
  findOnebotConfigs, napcatHome, napcatConfigDir, findNapcatLauncher, flattenSingleDir,
  // 第 58 轮：OneBot11 配置的形状与"补服务端"只有 `lib/common.mjs` 那一份实现 ——
  // `start-napcat.mjs`（为已登录账号补配置）读的也是同一批函数。
  FALLBACK_ONEBOT11, withOnebotServers, isOwnOnebotFile,
} from './lib/common.mjs';
import { collectEnv, printEnv } from './check-env.mjs';
// 2026-10-16（P0-1）：NapCat 的版本/校验值解析只许住 `lib/versions.mjs` ——
// 本文件原来自带一份 resolveLatestTag（没有超时、也不带 digest），已改用共享件。
import { latestNapcatRelease, napcatDigestForTag, verifyNapcatZip } from './lib/versions.mjs';
import { migrateIfNeeded } from './migrate.mjs';

// ── ① 配置：生成 config.json ────────────────────────────────────────────────
/**
 * 从脱敏模板生成运行配置。
 *
 * ⚠️ 修掉模板的两个坑（这两个都是项目文档里点名过的实际事故）：
 *   1. `allow.groups` 模板值是一句中文占位符。它会**被当成真群号收下**，
 *      于是机器人照常启动、但永远不认任何群 —— 表现为"@ 了没反应"。
 *      ⇒ 生成时一律置空数组，让它在控制台里报"没有放行的群"这个明确原因。
 *   2. `llm.apiKey` 可能与 `llm.apiKeyEnv` 指向的环境变量冲突（后者有值时会覆盖前者）。
 *      ⇒ 生成时不动它们，但在控制台里提示（见下面的"下一步"）。这里只保证不写死值。
 */
export function ensureConfigJson() {
  if (exists(CONFIG_JSON)) {
    ok('app\\config.json 已存在 —— 保留你已有的配置，不覆盖');
    return { created: false };
  }
  const tpl = readJson(CONFIG_EXAMPLE);
  if (!tpl) throw new Error('读不到 app\\config.example.json（解压不完整？）');

  tpl.onebot = { ...(tpl.onebot || {}), wsUrl: 'ws://127.0.0.1:3001' };
  tpl.allow = { ...(tpl.allow || {}), groups: [] };
  writeJson(CONFIG_JSON, tpl);
  ok('已生成 app\\config.json（放行群号留空，稍后在控制台里填）');
  return { created: true };
}

// ── ③ 协议端：下载 + 校验 + 解压 ─────────────────────────────────────────────
/**
 * 装协议端。2026-10-16（P0-1）起，与一键安装走**同一套**取证与校验：
 *   · 版本/校验值解析 ← `lib/versions.mjs`（本文件原来那份 resolveLatestTag 已删）
 *   · zip 候选 URL ← `lib/common.mjs` 的 napcatUrls（原来这里也有一份）
 *   · 完整性校验 ← `lib/versions.mjs` 的 verifyNapcatZip —— **手动放包与下载件
 *     走同一条校验路**（"用户自己放一份 zip"不再是一个绕过校验的口子）。
 */
async function installNapcat() {
  if (findNapcatLauncher()) {
    ok('NapCat 已经装好了 —— 跳过下载');
    return { installed: false };
  }

  const src = loadNapcatSource();
  const rel = await latestNapcatRelease(src);
  if (!rel) warn(`查最新版本失败 —— 回退到清单里记的 ${src.fallbackTag}`);
  const tag = rel ? rel.tag : src.fallbackTag;
  const expected = (rel && rel.sha256)
    ? { sha256: rel.sha256, source: 'github-api' }
    : await napcatDigestForTag(src, tag);

  if (!exists(NAPCAT_ZIP)) {
    say(`  准备下载 NapCat ${tag}（官方包约 30–36MB，随版本变化）。国内镜像优先，可断点续传。`);
    const r = await downloadWithMirrors(napcatUrls(src, tag), NAPCAT_ZIP, {
      expectedSha256: expected ? expected.sha256 : '',
      expectedSize: expected && expected.size ? expected.size : 0,
    });
    ok(`下载完成：${humanSize(r.bytes)}（来源 ${new URL(r.url).host}）`);
  } else {
    ok(`发现你手动放好的 NapCat 包：${humanSize(fs.statSync(NAPCAT_ZIP).size)}`);
  }

  // 校验放在解压**之前**：可疑的包绝不拿去解压执行（两个入口同一条路）。
  verifyNapcatZip(NAPCAT_ZIP, expected);

  const tool = unzip(NAPCAT_ZIP, NAPCAT_DIR);
  ok(`解压完成（用 ${tool}）`);
  const home = flattenSingleDir(NAPCAT_DIR);
  const launcher = findNapcatLauncher();
  if (!launcher && home === NAPCAT_DIR) {
    warn('解压后没有找到启动器（launcher*.bat / NapCatWinBootMain.exe）');
    dim('      这不一定是错 —— 官方不同版本的文件名不同。请到 app\\napcat 里看一眼。');
  } else if (launcher) {
    ok(`启动器：${path.relative(ROOT, launcher)}`);
  }
  // 包本身不留在目录里（它只是安装素材），省 ~30MB
  try { fs.rmSync(NAPCAT_ZIP, { force: true }); } catch { /* 删不掉也无所谓 */ }
  return { installed: true, home };
}

// ── ④ 协议端端口对齐 ────────────────────────────────────────────────────────
/**
 * 写 NapCat 的 OneBot11 配置。策略是**克隆既有结构再改**，而不是凭空造一份：
 *   · 官方包里通常有 `onebot11.json` 之类的默认件 → 拿它当模板，只改端口/开关
 *   · 找不到模板 → 用下面这份实测结构兜底，并**明确告诉用户这是生成的**
 * 这样即使官方改了字段，我们也只动"我们确定的三个字段"（name/enable/port）。
 */
/**
 * 写 NapCat 的 OneBot11 配置。策略是**克隆既有结构再改**，而不是凭空造一份：
 *   · 官方包里通常有 `onebot11.json` 之类的默认件 → 拿它当模板，只改端口/开关
 *   · 找不到模板 → 用 `lib/common.mjs` 那份实测结构兜底，并**明确告诉用户这是生成的**
 * 这样即使官方改了字段，我们也只动"我们确定的三个字段"（name/enable/port）。
 *
 * ⚠️ 第 58 轮 · 真机发现的**关键一步**：除了账号那一份，还必须再写一份**不带账号后缀的
 *    模板 `<configDir>/onebot11.json`**。理由是从 NapCat 自己的代码里读出来的 ——
 *    它取配置的逻辑是：
 *        `onebot11_<登录的QQ>.json` 存在 → 用它；否则 → 读 `onebot11.json` 当模板
 *    （见 `napcat.mjs` 里 `mn(i) ? ds(i) : ds(Pn(configPath,'./onebot11.json'))`）
 *    以前只写带后缀那份 ⇒ 用户把 QQ 号输错一位、或换了号登录时，NapCat **连模板也读不到**，
 *    于是自建一份 httpServers/websocketServers **全空**的默认配置 ⇒ 3000/3001 永远不开，
 *    而且**零报错**（面板只会说"协议端没有响应"）。有了模板，**任何账号首次登录都能拿到带端口的配置**。
 */
export function writeOnebotConfig(qq) {
  const configDir = napcatConfigDir();
  fs.mkdirSync(configDir, { recursive: true });

  // ⚠️ `qq` 现在是**可空**的（2026-10-13）：不再收集机器人号 ⇒ 没有"账号那份"可写，
  //    只写模板。账号那份由 `start-napcat.mjs` 在扫码登录之后按 NapCat 自己的记录补
  //    （见它里面的 alignKnownAccounts()）。
  const acctName = qq ? `onebot11_${qq}.json` : '';
  const acctPath = qq ? path.join(configDir, acctName) : '';
  const tplPath = path.join(configDir, 'onebot11.json');

  // 选模板时**排除我们自己写的那两份** —— 否则第二次运行会"克隆自己上一轮的产物"，
  // 而说明文字还写着"克隆既有结构"，是句骗人的话（第 58 轮真机发现）。
  const all = findOnebotConfigs();
  const external = all.filter((p) => !isOwnOnebotFile(path.basename(p), qq));
  const base = external[0] || all.find((p) => path.basename(p) === acctName);
  let cfg;
  let source;
  if (base) {
    cfg = readJson(base);
    const n = path.basename(base);
    source = isOwnOnebotFile(n, qq)
      ? `${path.relative(ROOT, base)}（沿用上一轮写入的配置 —— 幂等，不是克隆别人的）`
      : `${path.relative(ROOT, base)}（克隆既有结构）`;
  }
  if (!cfg) {
    cfg = structuredClone(FALLBACK_ONEBOT11);
    source = '内置结构（官方包里没有可克隆的模板）';
  }

  if (acctPath) writeJson(acctPath, withOnebotServers(cfg));

  // 模板那份：已经存在就**在它基础上补**（别把用户/NapCat 放进去的东西冲掉），没有才照抄账号那份。
  const tplCfg = readJson(tplPath) || structuredClone(cfg);
  writeJson(tplPath, withOnebotServers(tplCfg));

  return { dest: acctPath, tplDest: tplPath, source };
}

// ── 主流程 ──────────────────────────────────────────────────────────────────
async function main() {
  say('');
  say(`  AI 群友 便携版 v${VERSION} —— 首次安装`);
  say('  ' + '─'.repeat(46));
  dim('  这一步只做一次。之后日常只用双击 2-START.bat。');

  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    say('');
    say('  用法：1-SETUP.bat [--skip-check]');
    say('     --skip-check  跳过中途的环境自检输出');
    // ⚠️ `--qq` 参数已移除（2026-10-13）：手填 QQ 号这条路整体关掉，登录只走扫码。
    return;
  }

  // ① 环境自检
  const items = await collectEnv();
  if (!process.argv.includes('--skip-check')) printEnv(items);
  const fatal = items.filter((i) => i.level === 'err');
  if (fatal.length > 0) {
    say('');
    bad(`有 ${fatal.length} 项硬错误必须先解决（上面带 ↳ 的行就是怎么解决）。`);
    process.exitCode = 1;
    return;
  }
  if (!IS_WIN) {
    say('');
    warn('当前不是 Windows 系统 —— 本包是给 Windows 用户打的。');
    warn('继续下去只能生成一半状态（Windows 的 node.exe 与 .bat 在这里跑不起来）。');
    say('  如果你是在 macOS 上校验这个包，请只跑：runtime/node/node.exe 之外的检查。');
    process.exitCode = 1;
    return;
  }

  // ② 旧数据迁移：必须在创建新 config / 装 NapCat 之前
  title('旧数据迁移');
  const mig = migrateIfNeeded({ source: PROGRAM_ROOT, userRoot: USER_ROOT });
  if (mig.status === 'failed') {
    bad(`旧数据迁移失败：${mig.error || mig.reason}`);
    bad('旧数据仍在原处；先处理上面的原因，再重跑 1-SETUP.bat。');
    process.exitCode = 1;
    return;
  } else if (mig.status === 'complete') {
    ok(`旧数据已复制到 userdata（${mig.files} 个文件，冲突 ${mig.conflicts.length}）`);
  } else {
    dim(`旧数据迁移：${mig.reason || '无需迁移'}`);
  }

  // ② 配置
  title('② 生成运行配置');
  ensureConfigJson();

  // ③ 协议端
  title('③ 安装 QQ 协议端（NapCat）');
  dim('  NapCat 是第三方协议端，按它自己的许可**不能随本包分发**，所以在这里现下。');
  await installNapcat();

  // ⚠️ **不问 QQ 号**（2026-10-13 移除）：以前这里会 `ask('机器人小号的 QQ 号…')`，
  //    还支持 `1-SETUP.bat --qq <号>`。那条路的问题不是麻烦，是**谁都能填别人的号**，
  //    而脚本照单全收拿去登录。现在登录只走扫码（面板里「打开二维码登录」），
  //    首次扫完之后 NapCat 自己记住账号，**以后开机自动免扫**（见 resolveLoginQq）。
  //    这里能做的、也只需要做的是：把端口模板写好（不带任何账号）。
  const qq = '';

  // ④ 端口对齐
  title('④ 对齐协议端端口');
  const { dest, tplDest, source } = writeOnebotConfig(qq);
  if (dest) ok(`已写入 ${path.relative(ROOT, dest)}`);
  // ⚠️ 模板那份是给"**以后任何账号首次登录**"用的（见 writeOnebotConfig 的注释）。
  //    必须让用户看见它被写了 —— 否则排障时没人知道它为什么在那儿。
  //    ⚠️ 而且**它是唯一必须写的那份**：没有手填的号 ⇒ 账号那份只能等扫码登录后
  //    由 `start-napcat.mjs` 的 alignKnownAccounts() 按 NapCat 自己的记录补。
  ok(`已写入模板 ${path.relative(ROOT, tplDest)}（以后任何 QQ 号首次登录都能直接用）`);
  dim(`      结构来源：${source}`);
  dim('      WebSocket 服务端 3001 · HTTP 服务端 3000 · 仅监听 127.0.0.1');

  // ⑤ 收尾
  writeJson(SETUP_MARKER, {
    version: VERSION,
    installedAt: new Date().toISOString(),
    napcatHome: path.relative(ROOT, napcatHome() || NAPCAT_DIR),
  });

  title('装好了。接下来：');
  say('  1. 确认这台电脑装了 QQ（NT 版 / 新版 QQ）。');
  say('  2. 双击 2-START.bat —— 浏览器会自动打开控制台。');
  say('  3. 控制台里点「打开二维码登录」，用**机器人小号**的手机 QQ 扫码。');
  say('     扫完这一次，以后开机就自动登录了（NapCat 记住了账号），不用再扫。');
  say('  4. 在控制台里填「放行的群号」和模型 API Key，点右上角「一键启动」。');
  say('');
  dim('  提醒：一定要用小号。第三方协议端存在封号风险，别拿主号冒险。');
}

if (isMain(import.meta.url)) {
  try {
    await main();
  } catch (e) {
    say('');
    bad(`安装中断：${e && e.message ? e.message : e}`);
    if (/所有下载源都失败了/.test(e && e.message ? e.message : '')) {
      say('  离线办法：自己到官方 Releases 页下载 NapCat.Shell.zip，');
      say(`  放到 ${path.relative(ROOT, NAPCAT_ZIP)}，然后重新双击 1-SETUP.bat。`);
      const src = loadNapcatSource();
      say(`  页面：${src.manual.page}`);
    }
    process.exitCode = 2;
  }
}
