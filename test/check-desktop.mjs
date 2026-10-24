/**
 * 桌面壳纯判据测试（无 Electron）。
 *
 * 复跑：NODE_OPTIONS= node test/check-desktop.mjs
 * 覆盖：面板同源/外链协议、窗口越界回收、托盘与关闭决策、自启三态与 IO 形状。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { isPanelUrl, classifyExternal } from '../src/desktop/url-policy.js';
import {
  IPC_CHANNELS, isTrustedRendererUrl, buildPanelSpawnSpec, panelCmdlineBelongsToProgram,
  parseRestartResponse, decideRestartMode, healthMatches,
} from '../src/desktop/panel-control.js';
import {
  MIN_WIDTH, MIN_HEIGHT, DEFAULT_WIDTH, DEFAULT_HEIGHT, defaultBounds, clampBounds,
  normalizeWindowState, reflowForDisplays,
} from '../src/desktop/window-bounds.js';
import { trayUsable, decideCloseAction, decideStartVisibility } from '../src/desktop/shell-state.js';
import { desktopDirFor, shellPaths } from '../src/desktop/shell-path.js';
import { shellEvent, panelExit, tailLines, parseJsonl } from '../src/desktop/crash-record.js';
import { maskIdentifiers, scanResidualSecrets, redactLines } from '../src/redact-identifiers.js';
import { lastExitText } from '../panel/lib/last-exit.js';
import {
  startupShortcutPath, parseStartupApproved, classifyAutostart, readAutostartState, setAutostart,
} from '../src/desktop/autostart.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0;
let failed = 0;

function ck(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (e) {
    failed += 1;
    console.log(`  FAIL  ${name}: ${e && e.message ? e.message : e}`);
  }
}

console.log('── URL 策略 ──');
ck('面板同源放行；换端口/换主机/坏地址拒绝', () => {
  assert.equal(isPanelUrl('http://127.0.0.1:8788/run', 'http://127.0.0.1:8788/'), true);
  assert.equal(isPanelUrl('http://127.0.0.1:8789/run', 'http://127.0.0.1:8788/'), false);
  assert.equal(isPanelUrl('https://evil.example/run', 'http://127.0.0.1:8788/'), false);
  assert.equal(isPanelUrl('not-a-url', 'http://127.0.0.1:8788/'), false);
});

ck('外链只放行 http/https；file/javascript/mailto/坏地址拒绝', () => {
  assert.equal(classifyExternal('https://example.com/a').ok, true);
  assert.equal(classifyExternal('http://example.com/a').ok, true);
  assert.equal(classifyExternal('javascript:alert(1)').ok, false);
  assert.equal(classifyExternal('file:///etc/passwd').ok, false);
  assert.equal(classifyExternal('mailto:a@b.c').ok, false);
  assert.equal(classifyExternal('not-a-url').ok, false);
});

console.log('── 窗口几何 ──');
ck('默认尺寸与居中', () => {
  assert.equal(DEFAULT_WIDTH, 1360);
  assert.equal(DEFAULT_HEIGHT, 860);
  assert.deepEqual(defaultBounds({ x: 0, y: 0, width: 1920, height: 1080 }), {
    x: 280, y: 110, width: 1360, height: 860,
  });
});

ck('窗口状态值域：坏值返回 null；maximized 只认布尔 true；写回 v:1', () => {
  assert.equal(normalizeWindowState(null), null);
  assert.equal(normalizeWindowState({ x: 0, y: 0, width: 0, height: 600 }), null);
  assert.deepEqual(normalizeWindowState({ x: '10', y: '20', width: '800', height: '600', maximized: 1 }), {
    x: 10, y: 20, width: 800, height: 600, maximized: false, v: 1,
  });
  assert.deepEqual(normalizeWindowState({ x: 10, y: 20, width: 800, height: 600, maximized: true }), {
    x: 10, y: 20, width: 800, height: 600, maximized: true, v: 1,
  });
});

ck('显示器变化回收：普通窗口钳制；最大化在原屏不动；原屏拔掉先还原再回主屏', () => {
  const primary = { workArea: { x: 0, y: 0, width: 1920, height: 1080 } };
  const secondary = { workArea: { x: 1920, y: 0, width: 1920, height: 1080 } };
  const dual = [primary, secondary];
  const onSecondary = { x: 2200, y: 100, width: 1000, height: 700 };
  assert.deepEqual(reflowForDisplays({
    bounds: onSecondary, normalBounds: onSecondary, maximized: false, displays: dual,
  }), { unmaximize: false, remaximize: false, bounds: onSecondary });
  assert.deepEqual(reflowForDisplays({
    bounds: onSecondary, normalBounds: onSecondary, maximized: false, displays: [primary],
  }), { unmaximize: false, remaximize: false, bounds: { x: 460, y: 190, width: 1000, height: 700 } });

  const maxBounds = { x: 1920, y: 0, width: 1920, height: 1080 };
  assert.deepEqual(reflowForDisplays({
    bounds: maxBounds, normalBounds: onSecondary, maximized: true, displays: dual,
  }), { unmaximize: false, remaximize: false, bounds: maxBounds });
  assert.deepEqual(reflowForDisplays({
    bounds: maxBounds, normalBounds: onSecondary, maximized: true, displays: [primary],
  }), { unmaximize: true, remaximize: true, bounds: { x: 460, y: 190, width: 1000, height: 700 } });
  assert.deepEqual(reflowForDisplays({
    bounds: maxBounds, normalBounds: { x: 100, y: 100, width: 1000, height: 700 }, maximized: true, displays: [primary],
  }), { unmaximize: false, remaximize: false, bounds: maxBounds });
});

ck('全越界回收主屏；副屏保留；副屏拔掉回主屏；小于最小尺寸的屏幕按屏幕', () => {
  const primary = { workArea: { x: 0, y: 0, width: 1920, height: 1080 } };
  assert.deepEqual(clampBounds({ x: 99999, y: 99999, width: 800, height: 600 }, [primary]), {
    x: 560, y: 240, width: 800, height: 600,
  });
  // 小于 600×480 的窗口会被抬到新下限（P1-5 半屏修复后）
  assert.deepEqual(clampBounds({ x: 99999, y: 99999, width: 500, height: 400 }, [primary]), {
    x: 660, y: 300, width: MIN_WIDTH, height: MIN_HEIGHT,
  });
  assert.equal(MIN_WIDTH, 600);
  assert.equal(MIN_HEIGHT, 480);
  const dual = [primary, { workArea: { x: 1920, y: 0, width: 1920, height: 1080 } }];
  assert.deepEqual(clampBounds({ x: 2200, y: 100, width: 1000, height: 700 }, dual), {
    x: 2200, y: 100, width: 1000, height: 700,
  });
  assert.deepEqual(clampBounds({ x: 2200, y: 100, width: 1000, height: 700 }, [primary]), {
    x: 460, y: 190, width: 1000, height: 700,
  });
  assert.deepEqual(clampBounds({ x: -100, y: -100, width: 1200, height: 900 }, [{ workArea: { x: 0, y: 0, width: 800, height: 600 } }]), {
    x: 0, y: 0, width: 800, height: 600,
  });
});

console.log('── 托盘/关闭/启动可见性 ──');
ck('托盘 bounds 全零 / 降级图标 / 构造失败 / 通知区关闭 均不可用', () => {
  assert.equal(trayUsable(null), false);
  assert.equal(trayUsable({ width: 0, height: 0 }), false);
  assert.equal(trayUsable({ width: 16, height: 16 }), true);
  assert.equal(trayUsable({ width: 16, height: 16 }, { degraded: true }), false);
  assert.equal(trayUsable({ width: 16, height: 16 }, { createFailed: true }), false);
  assert.equal(trayUsable({ width: 16, height: 16 }, { notificationAreaDisabled: true }), false);
});

ck('退出→close；tray 偏好→hide/minimize；quit 偏好→quit（托盘不可用也 exit）', () => {
  assert.equal(decideCloseAction({ quitting: true, trayUsable: true }), 'close');
  assert.equal(decideCloseAction({ quitting: false, trayUsable: true }), 'hide');
  assert.equal(decideCloseAction({ quitting: false, trayUsable: false }), 'minimize');
  assert.equal(decideCloseAction({ quitting: false, trayUsable: true, preference: 'quit' }), 'quit');
  assert.equal(decideCloseAction({ quitting: false, trayUsable: false, preference: 'quit' }), 'quit');
  assert.equal(decideCloseAction({ quitting: true, trayUsable: true, preference: 'quit' }), 'close');
});

ck('隐藏启动只在托盘可用时生效', () => {
  assert.equal(decideStartVisibility({ hidden: true, trayUsable: true }), 'hidden');
  assert.equal(decideStartVisibility({ hidden: true, trayUsable: false }), 'show');
  assert.equal(decideStartVisibility({ hidden: false, trayUsable: true }), 'show');
});

console.log('── 开机自启三态 ──');
ck('非 Windows unsupported；无快捷方式 off；有快捷方式 on；03/07 blocked', () => {
  assert.equal(classifyAutostart({ platform: 'darwin' }), 'unsupported');
  assert.equal(classifyAutostart({ platform: 'win32', shortcutExists: false }), 'off');
  assert.equal(classifyAutostart({ platform: 'win32', shortcutExists: true }), 'on');
  assert.equal(classifyAutostart({ platform: 'win32', shortcutExists: true, approvalFirstByte: 0x03 }), 'blocked');
  assert.equal(classifyAutostart({ platform: 'win32', shortcutExists: true, approvalFirstByte: 0x07 }), 'blocked');
  assert.equal(classifyAutostart({ platform: 'win32', shortcutExists: true, approvalFirstByte: 0x02 }), 'on');
});

ck('StartupApproved 解析 Buffer / reg 输出 / 无值', () => {
  assert.equal(parseStartupApproved(Buffer.from([0x03])), 0x03);
  assert.equal(parseStartupApproved('    Estrella Bot.lnk    REG_BINARY    03000000'), 0x03);
  assert.equal(parseStartupApproved('no such value'), null);
});

ck('Startup 快捷方式路径只在 win32 生成', () => {
  assert.equal(startupShortcutPath({ platform: 'darwin' }), '');
  const p = startupShortcutPath({ platform: 'win32', appData: 'C:\\Users\\A\\AppData\\Roaming' });
  assert.equal(p, 'C:\\Users\\A\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\Estrella Bot.lnk');
});

ck('readAutostartState 的 IO 形状：off / on / blocked / 查询失败按 on', () => {
  const base = { platform: 'win32', shortcutPath: 'C:\\Startup\\Estrella Bot.lnk' };
  assert.equal(readAutostartState({ ...base, fsApi: { existsSync: () => false }, execFileSync: () => '' }).state, 'off');
  assert.equal(readAutostartState({ ...base, fsApi: { existsSync: () => true }, execFileSync: () => 'x REG_BINARY 02000000' }).state, 'on');
  assert.equal(readAutostartState({ ...base, fsApi: { existsSync: () => true }, execFileSync: () => 'x REG_BINARY 03000000' }).state, 'blocked');
  assert.equal(readAutostartState({ ...base, fsApi: { existsSync: () => true }, execFileSync: () => { throw new Error('no key'); } }).state, 'on');
  assert.equal(readAutostartState({ platform: 'darwin' }).state, 'unsupported');
});

ck('setAutostart 非 Windows 拒绝；Windows 写/删走外部命令', () => {
  assert.equal(setAutostart(true, { platform: 'darwin' }).ok, false);
  const calls = [];
  const fsApi = { existsSync: () => true, rmSync: (p) => calls.push(['rm', p]) };
  const exec = (cmd, args) => calls.push([cmd, args]);
  const on = setAutostart(true, {
    platform: 'win32', installRoot: 'C:\\App', launcherPath: 'C:\\App\\launcher\\Estrella-Bot.vbs', fsApi, execFileSync: exec,
  });
  assert.equal(on.ok, true);
  assert.equal(on.state, 'on');
  assert.ok(calls.some(([cmd]) => cmd === 'powershell.exe'));
  const off = setAutostart(false, {
    platform: 'win32', installRoot: 'C:\\App', launcherPath: 'C:\\App\\launcher\\Estrella-Bot.vbs', fsApi, execFileSync: exec,
  });
  assert.equal(off.ok, true);
  assert.equal(off.state, 'off');
  assert.ok(calls.some(([cmd]) => cmd === 'rm'));
});

console.log('── 桌面壳路径 ──');
ck('壳默认在 programRoot/electron；显式覆盖优先；win32 路径用反斜杠', () => {
  assert.equal(desktopDirFor({ programRoot: '/opt/app', platform: 'darwin' }), '/opt/app/electron');
  assert.equal(desktopDirFor({
    programRoot: '/opt/app', env: { QQBOT_DESKTOP_DIR: '/custom/shell' }, platform: 'darwin',
  }), '/custom/shell');
  const win = shellPaths({ programRoot: 'C:\\App\\versions\\0.1.4\\app', platform: 'win32' });
  assert.equal(win.desktopDir, 'C:\\App\\versions\\0.1.4\\app\\electron');
  assert.equal(win.exe, 'C:\\App\\versions\\0.1.4\\app\\electron\\electron.exe');
  assert.equal(win.packageJson, 'C:\\App\\versions\\0.1.4\\app\\electron\\package.json');
  const over = shellPaths({ programRoot: '/opt/app', env: { QQBOT_ELECTRON_EXE: '/x/electron' }, platform: 'darwin' });
  assert.equal(over.exe, '/x/electron');
  assert.throws(() => desktopDirFor({ programRoot: '' }), /programRoot/);
});

console.log('── 崩溃记录与脱敏 ──');
ck('壳事件归一化：字段裁剪、exitCode 数字化、可选字段不写空', () => {
  const e = shellEvent({ kind: 'renderer-gone', reason: 'crashed', exitCode: '5', pid: '42', isQuitting: false, url: 'http://x/' });
  assert.equal(e.kind, 'renderer-gone');
  assert.equal(e.exitCode, 5);
  assert.equal(e.pid, 42);
  assert.equal(e.isQuitting, false);
  assert.equal(e.url, 'http://x/');
  assert.equal('message' in e, false);
  assert.equal(shellEvent({ kind: 'x', message: 'a'.repeat(3000) }).message.length <= 2001, true);
});

ck('面板退出归一化与文案', () => {
  assert.equal(panelExit({ code: '1', reason: 'addr-in-use' }).code, 1);
  assert.match(lastExitText({ code: 0, reason: 'quit' }), /正常退出/);
  assert.match(lastExitText({ code: 1, reason: 'addr-in-use' }), /异常退出.*code 1/);
  assert.equal(lastExitText(null), '');
  assert.equal(tailLines('a\nb\nc', 2), 'b\nc');
  assert.deepEqual(parseJsonl('{"a":1}\nnot-json\n{"b":2}'), [{ a: 1 }, { b: 2 }]);
});

ck('身份脱敏：QQ/群号/用户名/裸 5–12 位数字；端口与日期保留', () => {
  const out = maskIdentifiers('self_id=123456789 群 987654321 C:\\Users\\Moon\\x 端口 8788 日期 2026-10-23 裸号 555666777');
  assert.equal(out.includes('123456789'), false);
  assert.equal(out.includes('987654321'), false);
  assert.equal(out.includes('Moon'), false);
  assert.equal(out.includes('555666777'), false);
  assert.equal(out.includes('8788'), true);
  assert.equal(out.includes('2026-10-23'), true);
  // JSON 转义路径（诊断包的 summary/install.json）也要盖住
  const jsonPath = maskIdentifiers('{"installRoot":"C:\\\\Users\\\\MoonEstrella\\\\App"}');
  assert.equal(jsonPath.includes('MoonEstrella'), false);
  assert.match(jsonPath, /C:\\\\Users\\\\<user>/);
});

ck('残余凭据 fail-closed：命中行整行替换，正常行保留', () => {
  assert.deepEqual(scanResidualSecrets('sk-abcdefghijklmnopqrstuvwxyz'), ['sk-key']);
  const r = redactLines('正常一行\nsk-abcdefghijklmnopqrstuvwxyz\n', { maskSecrets: (s) => s });
  assert.equal(r.text.includes('sk-abcdefghijklmnopqrstuvwxyz'), false);
  assert.equal(r.text.includes('[REDACTED: sk-key]'), true);
  assert.equal(r.text.includes('正常一行'), true);
  assert.ok(r.redactions.includes('sk-key'));
});

console.log('── P3-2 IPC 控制面 ──');
ck('IPC 来源只认当前面板同源与壳自己的 error.html', () => {
  const panelUrl = 'http://127.0.0.1:52661/';
  const errorFile = path.join(ROOT, 'electron', 'error.html');
  const errorUrl = `${pathToFileURL(errorFile).href}?message=x`;
  assert.equal(isTrustedRendererUrl('http://127.0.0.1:52661/#/x', { panelUrl }), true);
  assert.equal(isTrustedRendererUrl('http://127.0.0.1:52662/', { panelUrl }), false);
  assert.equal(isTrustedRendererUrl('http://localhost:52661/', { panelUrl }), false);
  assert.equal(isTrustedRendererUrl('https://example.com/', { panelUrl }), false);
  assert.equal(isTrustedRendererUrl(errorUrl, { panelUrl, errorFile }), true);
  assert.equal(isTrustedRendererUrl(pathToFileURL(path.join(ROOT, 'electron', 'main.js')).href, { panelUrl, errorFile }), false);
  assert.equal(isTrustedRendererUrl('', { panelUrl, errorFile }), false);
  assert.equal(isTrustedRendererUrl('not-a-url', { panelUrl, errorFile }), false);
});

ck('半死恢复参数：安装版用共享 runtime，清 ELECTRON_RUN_AS_NODE，端口不写死', () => {
  const spec = buildPanelSpawnSpec({
    installRoot: '/opt/app',
    programRoot: '/opt/app/versions/0.1.4/app',
    userRoot: '/tmp/u',
    configFile: '/tmp/u/config.json',
    env: { ELECTRON_RUN_AS_NODE: '1', QQBOT_PANEL_PORT: '0', KEEP: 'yes' },
    platform: 'linux',
  });
  assert.equal(spec.command, '/opt/app/runtime/node/node');
  assert.deepEqual(spec.args, ['/opt/app/versions/0.1.4/app/panel/server.js']);
  assert.equal(spec.cwd, '/opt/app/versions/0.1.4/app');
  assert.equal(spec.env.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(spec.env.QQBOT_USER_ROOT, '/tmp/u');
  assert.equal(spec.env.QQBOT_CONFIG, '/tmp/u/config.json');
  assert.equal(spec.env.QQBOT_PANEL_PORT, '0');
  assert.equal(spec.env.KEEP, 'yes');
  assert.equal(spec.logFile, '/tmp/u/panel/panel.log');

  const dev = buildPanelSpawnSpec({
    programRoot: '/repo', userRoot: '/tmp/u', env: { QQBOT_NODE: '/usr/bin/node' }, platform: 'linux',
  });
  assert.equal(dev.command, '/usr/bin/node');
  assert.equal('QQBOT_PANEL_PORT' in dev.env, false);
  assert.equal('QQBOT_MODE' in dev.env, false);

  const bad = buildPanelSpawnSpec({
    programRoot: '/repo', userRoot: '/tmp/u', env: { QQBOT_PANEL_PORT: '70000' }, panelPort: 70000,
  });
  assert.equal('QQBOT_PANEL_PORT' in bad.env, false);
  assert.throws(() => buildPanelSpawnSpec({ programRoot: '', userRoot: '/tmp/u' }), /programRoot/);
  assert.throws(() => buildPanelSpawnSpec({ programRoot: '/repo', userRoot: '' }), /userRoot/);
});

ck('面板进程身份：只认本程序根下的 panel/server.js；Windows 路径大小写不敏感', () => {
  assert.equal(panelCmdlineBelongsToProgram('node /srv/app/panel/server.js', '/srv/app'), true);
  assert.equal(panelCmdlineBelongsToProgram('"C:\\node\\node.exe" "C:\\App\\panel\\server.js"', 'C:\\App', { platform: 'win32' }), true);
  assert.equal(panelCmdlineBelongsToProgram('node /srv/app2/panel/server.js', '/srv/app'), false);
  assert.equal(panelCmdlineBelongsToProgram('node /srv/app/panel/other.js', '/srv/app'), false);
  assert.equal(panelCmdlineBelongsToProgram('', '/srv/app'), false);
  assert.equal(panelCmdlineBelongsToProgram('node /srv/app/panel/server.js', ''), false);
});

ck('重启回执：200/ok 才算终局；400/0 允许主进程改走直接拉起', () => {
  assert.deepEqual(parseRestartResponse({
    status: 200, text: '{"ok":true,"restarted":true,"msg":"正在重启","oldPid":12}',
  }), { ok: true, terminal: true, restarted: true, msg: '正在重启', oldPid: 12 });
  assert.equal(parseRestartResponse({ status: 200, text: '{"ok":true,"restarted":false,"msg":"已是最新"}' }).terminal, true);
  assert.equal(parseRestartResponse({ status: 200, text: '{"ok":false,"msg":"已是最新"}' }).terminal, true);
  assert.equal(parseRestartResponse({ status: 400, text: '{"ok":false,"error":"看门狗起不来"}' }).terminal, false);
  assert.equal(parseRestartResponse({ status: 0, text: 'ECONNREFUSED' }).terminal, false);
  assert.equal(parseRestartResponse({ status: 401, text: '' }).terminal, false);
  assert.equal(decideRestartMode({ restarting: true, healthOk: true }), 'busy');
  assert.equal(decideRestartMode({ healthOk: true }), 'http');
  assert.equal(decideRestartMode({ healthOk: false }), 'recover');
});

ck('健康身份：pid/appId/version 必须同时对上', () => {
  const body = { ok: true, pid: 7, appId: 'com.estrellabot.windows', version: '0.1.4' };
  assert.equal(healthMatches({ body, pid: 7, appId: 'com.estrellabot.windows', version: '0.1.4' }), true);
  assert.equal(healthMatches({ body, pid: 8 }), false);
  assert.equal(healthMatches({ body, appId: 'other' }), false);
  assert.equal(healthMatches({ body, version: '0.1.5' }), false);
  assert.equal(healthMatches({ body: { ...body, ok: false } }), false);
  assert.equal(healthMatches({ body, appId: '', version: '' }), true);
});

ck('preload 暴露面恰好是白名单七个动作，没有通用 invoke / 监听', () => {
  const code = fs.readFileSync(path.join(ROOT, 'electron', 'preload.js'), 'utf8');
  let exposed = null;
  const context = {
    require(name) {
      assert.equal(name, 'electron');
      return {
        contextBridge: { exposeInMainWorld: (key, value) => { exposed = { key, value }; } },
        ipcRenderer: {
          invoke: () => Promise.resolve(),
          on: () => { throw new Error('preload 不许监听 ipcRenderer'); },
        },
      };
    },
    process: { platform: 'darwin' },
    document: { readyState: 'complete', documentElement: { dataset: {} } },
    window: { addEventListener() {} },
    Promise,
    Object,
    console,
  };
  vm.runInNewContext(code, context, { filename: 'preload.js' });
  assert.equal(exposed.key, 'estrellaShell');
  assert.deepEqual(Object.keys(exposed.value), [
    'isShell', 'platform', 'notify', 'retry', 'quit', 'isWindowVisible', 'restartPanel', 'quitConsole', 'panelState',
  ]);
  assert.equal(exposed.value.isShell, true);
  const channels = [...code.matchAll(/ipcRenderer\.invoke\('([^']+)'[^)]*\)/g)].map((m) => m[1]);
  assert.deepEqual(channels, [
    IPC_CHANNELS.notify, IPC_CHANNELS.retry, IPC_CHANNELS.quit, IPC_CHANNELS.visible,
    IPC_CHANNELS.restartPanel, IPC_CHANNELS.quitConsole, IPC_CHANNELS.panelState,
  ]);
  assert.equal(/ipcRenderer\.(?:on|send|sendSync)\(/.test(code), false);
  assert.equal(/\binvoke:\s*\(/.test(code), false);
});

console.log(`\n${passed}/${passed + failed} passed`);
if (failed) process.exitCode = 1;
