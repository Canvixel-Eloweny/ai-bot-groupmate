/**
 * P3-2 · Electron 主进程的面板控制判据（纯函数）。
 *
 * 页面里的「重启面板」「退出控制台」先走 IPC；浏览器里没有 IPC，仍走原来的 HTTP 路由。
 * 主进程拿到请求后：面板健康就走面板自己的重启路由（保留幂等与端口沿用），
 * 面板已死/不应答才按程序根直接拉起新进程 —— 这正是 HTTP 路由做不到的那一半。
 *
 * 这一层的边界很窄：只处理重启与退出，不把其它写路由搬进 IPC。
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const IPC_CHANNELS = Object.freeze({
  notify: 'shell:notify',
  retry: 'shell:retry',
  quit: 'shell:quit',
  quitConsole: 'shell:quit-console',
  visible: 'shell:visible',
  restartPanel: 'shell:restart-panel',
  panelState: 'shell:panel-state',
});

function normalizeOrigin(raw) {
  try { return new URL(String(raw || '')).origin; } catch { return ''; }
}

/**
 * 只信任两种调用来源：当前面板同源页面，或壳自己的 error.html。
 * 前者挡住被导航到其它回环端口的页面，后者让「后端没起来」的错误页仍能重启/退出。
 */
export function isTrustedRendererUrl(rawUrl, { panelUrl = '', errorFile = '', platform = process.platform } = {}) {
  let u;
  try { u = new URL(String(rawUrl || '')); } catch { return false; }
  if (u.protocol === 'http:' || u.protocol === 'https:') {
    const want = normalizeOrigin(panelUrl);
    return Boolean(want) && u.origin === want;
  }
  if (u.protocol === 'file:' && errorFile) {
    try {
      const got = path.resolve(fileURLToPath(u));
      const want = path.resolve(errorFile);
      return platform === 'win32' ? got.toLowerCase() === want.toLowerCase() : got === want;
    } catch { return false; }
  }
  return false;
}

/**
 * 半死恢复时直接起面板的参数。
 * 不继承 ELECTRON_RUN_AS_NODE（会让 Electron 以 Node 跑），也不写死 8788：
 * 端口沿用环境里的显式覆盖；没有覆盖就交给面板自己决定（产品 0 / dev 8788）。
 */
export function buildPanelSpawnSpec({
  installRoot = '', programRoot, userRoot, configFile = '', env = {}, platform = process.platform, panelPort,
} = {}) {
  if (!programRoot) throw new Error('缺 programRoot');
  if (!userRoot) throw new Error('缺 userRoot');
  const childEnv = { ...env };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  childEnv.QQBOT_USER_ROOT = String(userRoot);
  if (configFile) childEnv.QQBOT_CONFIG = String(configFile);

  if (panelPort === null) {
    delete childEnv.QQBOT_PANEL_PORT;
  } else if (panelPort !== undefined) {
    const n = Number(panelPort);
    if (Number.isInteger(n) && n >= 0 && n <= 65535) childEnv.QQBOT_PANEL_PORT = String(n);
    else delete childEnv.QQBOT_PANEL_PORT;
  }

  const command = installRoot
    ? path.join(String(installRoot), 'runtime', 'node', platform === 'win32' ? 'node.exe' : 'node')
    : (childEnv.QQBOT_NODE || 'node');
  return {
    command,
    args: [path.join(String(programRoot), 'panel', 'server.js')],
    cwd: String(programRoot),
    env: childEnv,
    panelFile: path.join(String(programRoot), 'panel', 'server.js'),
    logFile: path.join(String(userRoot), 'panel', 'panel.log'),
  };
}

/** 只把「命令行确实指向本程序的 panel/server.js」的进程当作我们的面板。 */
export function panelCmdlineBelongsToProgram(cmdline, programRoot, { platform = process.platform } = {}) {
  const norm = (s) => path.posix.normalize(String(s || '').replace(/\\/g, '/'));
  const fold = platform === 'win32' ? (s) => s.toLowerCase() : (s) => s;
  const cmd = fold(norm(cmdline));
  const root = fold(norm(programRoot)).replace(/\/+$/, '');
  if (!cmd || !root || root === '/') return false;
  return cmd.includes(`${root}/panel/server.js`);
}

/**
 * 解析面板 /api/panel/restart 的回执。
 * `terminal=true` 表示「这个结果就是最终答复」；false 才允许主进程改走直接拉起。
 */
export function parseRestartResponse({ status = 0, text = '' } = {}) {
  let body = null;
  try { body = JSON.parse(String(text || '')); } catch { body = null; }
  const detail = String((body && (body.msg || body.error)) || String(text || '').slice(0, 200) || '');
  if (status === 200 && body && body.ok === true) {
    return {
      ok: true,
      terminal: true,
      restarted: Boolean(body.restarted),
      msg: String(body.msg || ''),
      oldPid: Number(body.oldPid) || 0,
    };
  }
  if (status === 200 && body && body.ok === false) {
    return { ok: false, terminal: true, restarted: false, error: detail || '面板拒绝重启' };
  }
  return {
    ok: false,
    terminal: false,
    restarted: false,
    error: `HTTP ${status}${detail ? `：${detail}` : ''}`,
  };
}

export function decideRestartMode({ restarting = false, healthOk = false } = {}) {
  if (restarting) return 'busy';
  return healthOk ? 'http' : 'recover';
}

/** 发现文件/健康端点的身份必须同时对上 pid、appId、version，才算「新面板真的起来了」。 */
export function healthMatches({ body, appId = '', version = '', pid = 0 } = {}) {
  if (!body || body.ok !== true) return false;
  if (pid && Number(body.pid) !== Number(pid)) return false;
  if (appId && String(body.appId || '') !== String(appId)) return false;
  if (version && String(body.version || '') !== String(version)) return false;
  return true;
}
