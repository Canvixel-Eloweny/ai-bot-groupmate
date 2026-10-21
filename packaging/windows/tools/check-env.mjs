/**
 * 环境自检 —— 只读，不改任何东西。
 *
 * 被 `1-SETUP.bat`、`2-START.bat` import；也可以自己跑：
 *   runtime\node\node.exe tools\check-env.mjs
 *
 * 设计原则：**每一项都要能回答"不满足时我该做什么"**。做不到这一点的检查就不写进来
 * （例如"检查杀软"——给不出可执行建议，只会制造焦虑）。
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  APP, NODE_EXE, NAPCAT_ZIP, CONFIG_JSON, CONFIG_EXAMPLE, USER_ROOT,
  ROOT, IS_WIN, MIN_NODE, exists, portOpen, readJson, findQQExe,
  findNapcatLauncher, findOnebotConfigs,
  // 第 58 轮：把「哪个账号还没配上 3001/3000」直接报出来（见下面"协议端口"那一项的理由）。
  knownAccounts, hasOnebotServers, napcatConfigDir,
  ok, warn, bad, title, say, dim, isMain,
  // VC++ 运行库那一项要读注册表（见 ⑥b 的理由）；`run` 是 common 里跑 `reg query` 的唯一实现。
  run,
} from './lib/common.mjs';

/** 版本号比较：`gte('22.13.0','22.13')` === true。只处理 x[.y[.z]]，够用。 */
function gte(a, b) {
  const p = (s) => String(s).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const [x, y] = [p(a), p(b)];
  for (let i = 0; i < 3; i += 1) {
    if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  }
  return true;
}

const LEVEL = { ok: 'ok', warn: 'warn', err: 'err' };
const item = (level, name, detail, fix = '') => ({ level, name, detail, fix });

// QQ 客户端的定位**只有一处实现**：`findQQExe()`（lib/common.mjs）。
// ⚠️ 它读的是与 `app\napcat\launcher-user.bat` **同一条注册表项** ——
//    以前这里自己探四个 C 盘固定路径，于是 QQ 装在非 C 盘时**自检说"没装"、
//    启动器却能找到并跑起来**，把人白白引去重装 QQ（2026-10-09 · 真机首跑）。

function diskFree(p) {
  try {
    const st = fs.statfsSync(p);
    return st.bavail * st.bsize;
  } catch {
    return null;
  }
}

/** 注册表判据的键名（微软文档确认的固定位置，与 NapCatQQ-Desktop 用的同一个）。 */
const VC_KEY = 'HKLM\\SOFTWARE\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\X64';

/**
 * VC++ 2015-2022 x64 运行库检测（只读）。
 *
 * 判据与 NapCat 官方 Windows 壳同源：它把这套运行库当成一个"组件"做注册表检测 ——
 * 该键的 `Installed`(REG_DWORD) 非 0 即算已装，`Version`(REG_SZ，形如 v14.44.35211.0)
 * 能解出来就带上、解不出不影响判定（NapCatQQ-Desktop `crates/ncd-component/src/vcredist.rs:6-8,29`，
 * 2026-10-19 取证）。
 *
 * 键不存在时（真机实测：`reg.exe` 回 exit 1 + "unable to find the specified registry key"）
 * 退化到 System32 那三颗 DLL 在场与否 —— 有些机器的运行库是别的程序带进来的，注册表键没写但库
 * 实际在；反过来三颗齐了才算装，缺任何一颗都可能撞上 `msvcp140.dll` 找不到。
 *
 * @param {string} [key] 判定用的注册表键；默认为官方固定位置，留一个注入口是为了让
 *   "键不存在 → DLL 兜底"这条负路能在真机上被单独验到（真装一次 VC++ 不是可重复的实验）。
 * @returns {Promise<{installed:boolean, version:string, via:string}>}
 */
export async function checkVcRedist(key = VC_KEY) {
  const r = await run('reg', ['query', key]);
  if (r.code === 0) {
    const dw = /Installed\s+REG_DWORD\s+0x([0-9a-fA-F]+)/.exec(r.out);
    const ver = /Version\s+REG_SZ\s+(\S+)/.exec(r.out);
    if (dw && Number.parseInt(dw[1], 16) !== 0) {
      return { installed: true, version: ver ? ver[1] : '', via: 'registry' };
    }
  }
  const sys32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
  const need = ['vcruntime140.dll', 'vcruntime140_1.dll', 'msvcp140.dll'];
  const present = need.filter((d) => exists(path.join(sys32, d)));
  return { installed: present.length === need.length, version: '', via: `dll:${present.length}/${need.length}` };
}

/**
 * 收集全部检查项。纯函数式的读，不做任何写操作。
 * @returns {Promise<Array<{level:string,name:string,detail:string,fix:string}>>}
 */
export async function collectEnv() {
  const out = [];

  // ① 平台
  // ⚠️ 报的是**运行架构**（`process.arch`），不是系统架构：包内嵌的是 win-x64 的 Node，
  //    在 Windows ARM64 上它会经 Prism 模拟层跑，于是这里显示 x64 而机器是 ARM64。
  //    措辞写清"运行架构"，免得用户以为自检认错了系统（第 58 轮真机）。
  out.push(IS_WIN
    ? item(LEVEL.ok, '操作系统', `Windows（包内 Node 的运行架构：${process.arch}）`)
    : item(LEVEL.warn, '操作系统', `当前是 ${process.platform}，本包面向 Windows`,
      '只有在 Windows 上才能完整跑通；本机这份检查结果仅供参考。'));

  // ② 内嵌运行时（目标机上 process.execPath 就是内嵌的 node.exe）
  const nodeVer = process.versions.node;
  out.push(gte(nodeVer, MIN_NODE)
    ? item(LEVEL.ok, '运行环境', `Node ${nodeVer}（包内自带，无需另装）`)
    : item(LEVEL.err, '运行环境', `Node ${nodeVer} 低于项目要求 ${MIN_NODE}`,
      '这份包被改坏了或用了系统 node。请用包内的 1-SETUP.bat / 2-START.bat 启动。'));
  out.push(exists(NODE_EXE)
    ? item(LEVEL.ok, '内嵌 Node', 'runtime\\node\\node.exe 就位')
    : item(LEVEL.err, '内嵌 Node', '找不到 runtime\\node\\node.exe',
      '解压不完整：请重新解压 zip（务必"全部解压"，不要在压缩包里直接双击）。'));

  // ③ 程序本体
  const need = ['package.json', 'src/index.js', 'panel/server.js', 'config.example.json'];
  const missing = need.filter((f) => !exists(path.join(APP, f)));
  out.push(missing.length === 0
    ? item(LEVEL.ok, '程序本体', `app/ 完整（${need.length} 项关键文件都在）`)
    : item(LEVEL.err, '程序本体', `app/ 缺文件：${missing.join('、')}`,
      '解压不完整或杀软删了文件。重新解压，并把整个目录加入杀软白名单。'));

  // ④ 唯一运行时依赖
  const wsPkg = readJson(path.join(APP, 'node_modules', 'ws', 'package.json'));
  out.push(wsPkg
    ? item(LEVEL.ok, '依赖 ws', `已预装 ws@${wsPkg.version}（无需 npm install）`)
    : item(LEVEL.err, '依赖 ws', 'app\\node_modules\\ws 缺失',
      '解压不完整。重新解压整包；若杀软报毒删了它，请加白名单后重解压。'));

  // ⑤ 配置
  out.push(exists(CONFIG_JSON)
    ? item(LEVEL.ok, '运行配置', 'app\\config.json 已生成')
    : item(LEVEL.warn, '运行配置', 'app\\config.json 还没生成（首次使用正常）',
      '双击 1-SETUP.bat 会自动生成。'));
  out.push(exists(CONFIG_EXAMPLE)
    ? item(LEVEL.ok, '配置模板', 'app\\config.example.json 就位')
    : item(LEVEL.err, '配置模板', 'config.example.json 缺失', '重新解压整包。'));

  // ⑥ 协议端（NapCat）
  const launcher = findNapcatLauncher();
  const obConfigs = findOnebotConfigs();
  const zipPresent = exists(NAPCAT_ZIP);
  if (launcher) {
    out.push(item(LEVEL.ok, 'QQ 协议端', `NapCat 已就位（启动器：${path.relative(ROOT, launcher)}）`));
    // ⚠️ 第 58 轮真机踩过的坑：NapCat **只在 `onebot11_<实际登录的QQ>.json` 里读配置**，
    //    而 `setup.mjs` 写的是 `onebot11_<用户输入的QQ>.json`。两者对不上时 NapCat 会自建
    //    一份 httpServers/websocketServers **全空**的默认配置 ⇒ 3000/3001 永远不开，且零报错。
    //    所以这里不能只报一个总数 —— 要把"**哪个账号还没配上**"指名道姓地说出来。
    const cfgDir = napcatConfigDir();
    const accounts = knownAccounts();
    const missing = accounts.filter((q) => !hasOnebotServers(readJson(path.join(cfgDir, `onebot11_${q}.json`))));
    const tplOk = hasOnebotServers(readJson(path.join(cfgDir, 'onebot11.json')));

    if (missing.length > 0) {
      out.push(item(LEVEL.warn, '协议端口',
        `账号 ${missing.join('、')} 的 onebot11 配置里没有 WebSocket 3001 / HTTP 3000`,
        '启动协议端时会自动补上（2-START / 一键启动都会跑这一步）；补完需要**重新扫码登录一次**才生效'
        + '（NapCat 只在登录那一刻读这份配置，它不会热重载）。'));
    } else if (obConfigs.length > 0) {
      out.push(item(LEVEL.ok, '协议端口',
        `已配置 ${obConfigs.length} 份 onebot11 配置${accounts.length ? `（账号 ${accounts.join('、')} 已对齐）` : ''}`));
    } else {
      out.push(item(LEVEL.warn, '协议端口', '没有找到 onebot11 配置',
        '重跑 1-SETUP.bat 会写入；或在 NapCat 的 WebUI 里手工开 WebSocket 3001 / HTTP 3000。'));
    }

    if (tplOk) {
      out.push(item(LEVEL.ok, '端口模板', 'onebot11.json 模板在位 —— 以后换任何 QQ 号登录都能直接用'));
    } else if (obConfigs.length > 0) {
      out.push(item(LEVEL.warn, '端口模板', '缺 onebot11.json 模板',
        '缺它的话，用**别的** QQ 号登录会拿到一份没有 3001/3000 的默认配置。重跑 1-SETUP.bat 即可补上。'));
    }
  } else {
    out.push(item(LEVEL.warn, 'QQ 协议端', zipPresent ? '已下载 NapCat 包，但还没解压' : '尚未安装 NapCat',
      '双击 1-SETUP.bat —— 它会在联网状态下自动下载并装好（约 30–36MB，随版本变化）。'
      + '没网也行：把官方 NapCat.Shell.zip 放到协议端目录再重跑一次即可。'));
  }

  // ⑥b VC++ 2015-2022 x64 运行库（NapCat 注入器的隐式依赖）
  //
  // 为什么写进来：NapCat 的 `NapCatWinBootMain.exe` / `NapCatWinBootHook.dll` **动态链接**
  // MSVCP140 / VCRUNTIME140，机器缺这套运行库时的症状是「注入器秒退、没有可读报错」
  // （NapCatQQ-Desktop `crates/ncd-component/src/vcredist.rs:3-4` 逐字这么写，它因此把 VC++
  // 当成一个正式组件来装）。这正是我方 VM 上「装了起不来」一类工单里最难归因的那型 ——
  // 面板只会说"协议端没起来"，真凶在系统层。
  // ⚠️ 这一项**刻意只出 warn**：setup 与一键安装都把 err 当"必须先解决"直接中止
  //    （`onekey.mjs` 的 `fatal` 分支、`setup.mjs` 同一形状），而缺运行库挡住的是**起协议端**
  //    这一步、不是装机器人；且装它需要 UAC 提权，只读自检不能替用户装（见文件头的设计原则）。
  if (IS_WIN) {
    const vc = await checkVcRedist();
    out.push(vc.installed
      ? item(LEVEL.ok, 'VC++ 运行库', `VC++ 2015-2022 x64 已安装${vc.version ? `（${vc.version}）` : ''}`)
      : item(LEVEL.warn, 'VC++ 运行库',
        '没有检测到 VC++ 2015-2022 x64 运行库（注册表那一项没查到，System32 里三颗运行库也不齐）',
        'NapCat 的注入器依赖它，缺了会「起协议端时秒退、只留一行看不懂的报错」。'
        + '装微软官方那一个：https://aka.ms/vs/17/release/vc_redist.x64.exe（要管理员权限），装完重跑本检查。'));
  } else {
    out.push(item(LEVEL.ok, 'VC++ 运行库', '非 Windows，跳过（本项只在 Windows 上有意义）'));
  }

  // ⑦ QQ 客户端
  const qq = await findQQExe();
  out.push(qq.found
    ? item(LEVEL.ok, 'QQ 客户端', `已安装（${qq.where || '检测到'})`.replace(')', '）'))
    : item(IS_WIN ? LEVEL.warn : LEVEL.ok, 'QQ 客户端', IS_WIN ? '没有检测到 QQ NT 版' : '非 Windows，跳过',
      'NapCat 依赖 QQ NT 版（新版 QQ）。到 https://im.qq.com 装一个，装完重跑本检查。'));

  // ⑧ 端口
  const ports = [
    [3001, '协议端 WebSocket', '先不管；2-START.bat 会自动拉起 NapCat'],
    [3000, '协议端 HTTP', '先不管；由 NapCat 提供'],
    [6099, 'NapCat WebUI', '用于扫码登录，详见 README.html'],
    [8788, '控制台面板', '在跑就说明控制台已经起来了'],
  ];
  const lines = [];
  for (const [p, label] of ports) {
    // eslint-disable-next-line no-await-in-loop
    const open = await portOpen(p);
    lines.push(`${p} ${open ? '占用中' : '空闲'}（${label}）`);
  }
  out.push(item(LEVEL.ok, '端口状态', lines.join(' · ')));

  // ⑨ 磁盘
  const free = diskFree(USER_ROOT);
  if (free !== null) {
    const enough = free > 500 * 1024 * 1024;
    out.push(item(enough ? LEVEL.ok : LEVEL.warn, '剩余磁盘',
      `${(free / 1024 / 1024 / 1024).toFixed(1)}GB（本目录所在分区）`,
      enough ? '' : 'NapCat 与运行日志还需要几百 MB，建议先清点空间。'));
  }

  return out;
}

export function printEnv(items) {
  title('环境自检');
  for (const it of items) {
    const tag = it.level === 'ok' ? ok : it.level === 'warn' ? warn : bad;
    tag(`${it.name}：${it.detail}`);
    if (it.fix && it.level !== 'ok') dim(`      ↳ 怎么办：${it.fix}`);
  }
  const errs = items.filter((i) => i.level === 'err').length;
  const warns = items.filter((i) => i.level === 'warn').length;
  say('');
  say(errs === 0
    ? `  结论：${warns === 0 ? '全部就绪' : `基本就绪（${warns} 项待处理，见上面的 ↳）`}`
    : `  结论：有 ${errs} 项必须先解决（见上面的 ↳）`);
  return errs;
}

// ── CLI ─────────────────────────────────────────────────────────────────────
if (isMain(import.meta.url)) {
  const items = await collectEnv();
  const errs = printEnv(items);
  process.exitCode = errs === 0 ? 0 : 1;
}
