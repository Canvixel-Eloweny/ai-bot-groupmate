#!/usr/bin/env node
/**
 * 「启动方式」的命令行入口（2026-10-16 · 桌面端形态第一批）。
 * ══════════════════════════════════════════════════════════════════════════
 *  给 **macOS 的 launcher.sh** 用：那份脚本是 bash，不该、也不许自己再实现一遍
 *  "读配置 → 分派"的判据（两份实现必然漂移 —— 本仓反复清过这类毛病）。
 *  它只做一件事：把 CLI 调出去，按退出码决定要不要回落自带的 `open`。
 *
 *  判据本体住 `src/launch-mode.js`（与 Windows 两个启动器、面板两侧共用同一份）。
 *  这个文件里**一行判据都不许有** —— 它只是"把模块接到命令行上"的壳。
 *
 *  用法：
 *    node scripts/launch-mode.mjs resolve [--config <config.json>]
 *        # 只看判定结果，不开任何东西（排障与测试用）
 *    node scripts/launch-mode.mjs open --url <url> [--config <config.json>] [--dry-run] [--entry <id>]
 *        # 读配置 → 按形态打开 → 记一条启动跟踪；--dry-run 时只打印"将会执行什么"
 *        # --entry：跟踪记录里的入口标识（mac 的 launcher.sh 传 `mac-app`；手工跑不传 = `cli`）
 *
 *  退出码：0 = 处理完成（**含一切回落**，含 openOnStart=false 的"不开"）；
 *          1 = 尝试打开但失败（调用方应回落自带的 `open`）；
 *          2 = 用法错误。
 *  输出：结果 JSON 走 stdout；给人看的过程话走 stderr（调用方重定向进 panel.log）。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LAUNCH_MODES, openPanelFromConfig, planOpen, readLaunchFile, readWindowState, consoleProfileDir } from '../src/launch-mode.js';
import { resolveRoots } from '../src/user-root.js';
import panelDiscovery from '../src/panel-discovery.cjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 没传 --url 时（手工调试）读发现文件；最后才回落 legacy 8788。 */
function defaultPanelUrl() {
  if (process.env.QQBOT_PANEL_URL) return String(process.env.QQBOT_PANEL_URL);
  const info = panelDiscovery.readDiscovery(resolveRoots().userRoot);
  if (info && panelDiscovery.isLive(info)) return info.url;
  return panelDiscovery.legacyPanelUrl();
}

function usage(msg) {
  if (msg) console.error(`✗ ${msg}`);
  console.error('用法：');
  console.error('  node scripts/launch-mode.mjs resolve [--config <config.json>]');
  console.error('  node scripts/launch-mode.mjs open --url <url> [--config <config.json>] [--dry-run]');
  process.exit(2);
}

const argv = process.argv.slice(2);
const cmd = argv.shift() || '';
const opt = {};
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i];
  if (a === '--config') opt.config = argv[++i];
  else if (a === '--url') opt.url = argv[++i];
  else if (a === '--entry') opt.entry = argv[++i];
  else if (a === '--dry-run') opt.dryRun = true;
  else usage(`认不出的参数：${a}`);
}
if (cmd !== 'resolve' && cmd !== 'open') usage(`认不出的子命令：${cmd || '(空)'}`);

const configPath = opt.config ? path.resolve(opt.config) : path.join(ROOT, 'config.json');
const url = opt.url || defaultPanelUrl();
const log = (m) => console.error(`[launch] ${m}`);

if (cmd === 'resolve') {
  const l = readLaunchFile(configPath);
  if (l.unreadable) log(`读不到 ${configPath} —— 按默认值（browser + 自动打开）处理`);
  if (l.unknownMode) {
    log(`launch.mode 值是「${l.unknownMode}」—— 认不出；启动时会按 browser 处理（可选：${LAUNCH_MODES.join(' / ')}）`);
  }
  console.log(JSON.stringify({
    ok: true, mode: l.mode, openOnStart: l.openOnStart,
    unknownMode: l.unknownMode, unreadable: l.unreadable, config: configPath,
  }));
  process.exit(0);
}

// cmd === 'open'
if (opt.dryRun) {
  const l = readLaunchFile(configPath);
  const skipped = l.openOnStart === false;
  // ⚠️ dry-run 必须给 planOpen **喂和真实 open 同一批输入**（含窗口记忆与专用 profile）——
  //    漏了任何一项，它打印的命令都会与真实执行的差一截，照着它排障会得出错误结论。
  const winState = l.mode === 'window' ? readWindowState(configPath) : null;
  const profileDir = l.mode === 'window' ? consoleProfileDir(configPath) : '';
  const plan = skipped ? null : planOpen({ platform: process.platform, mode: l.mode, url, winState, profileDir });
  console.log(JSON.stringify({
    ok: true, dryRun: true, mode: l.mode, openOnStart: l.openOnStart, skipped, plan, url,
  }));
  process.exit(0);
}

let r;
try {
  r = openPanelFromConfig({ configPath, url, entry: opt.entry || 'cli', log });
} catch (e) {
  // 判据模块自己崩了也不该把启动链带崩 —— 如实报、退回"打开失败"，由调用方 `open` 兜底。
  log(`✗ 启动方式判据出错：${e && e.message ? e.message : e}`);
  console.log(JSON.stringify({ ok: false, opened: false, error: String(e && e.message ? e.message : e), url }));
  process.exit(1);
}
console.log(JSON.stringify({ ok: r.opened || r.skipped === true, ...r }));
log(r.skipped
  ? '已按设置不自动打开界面（launch.openOnStart=false）'
  : (r.opened
    ? `已打开控制台（${r.kind === 'window' ? `独立窗口 · ${r.used}` : '浏览器标签页'}）：${url}`
    : `没能打开界面：${r.error || '未知原因'}`));
process.exit(r.opened || r.skipped === true ? 0 : 1);
