/**
 * 桌面壳的路径解析（P1-7 · 2026-10-23）。
 *
 * 壳必须跟着 app 版本目录走：`versions/<ver>/app/electron/electron.exe`。
 * 这样回滚时旧 app 自带旧壳，不会出现“旧 app + 新壳”的错配。
 *
 * 纯函数、零业务依赖：安装器/启动器/测试都读这一份，别各自拼路径。
 */

import path from 'node:path';

export function desktopDirFor({ programRoot, env = {}, platform = process.platform } = {}) {
  if (env && env.QQBOT_DESKTOP_DIR) return path.resolve(String(env.QQBOT_DESKTOP_DIR));
  if (!programRoot) throw new Error('desktopDirFor: 缺少 programRoot');
  const p = platform === 'win32' ? path.win32 : path;
  return p.join(String(programRoot), 'electron');
}

function electronExeFor({ programRoot, env = {}, platform = process.platform } = {}) {
  if (env && env.QQBOT_ELECTRON_EXE) return path.resolve(String(env.QQBOT_ELECTRON_EXE));
  const p = platform === 'win32' ? path.win32 : path;
  return p.join(desktopDirFor({ programRoot, env, platform }), platform === 'win32' ? 'electron.exe' : 'electron');
}

export function shellPaths({ programRoot, env = {}, platform = process.platform } = {}) {
  const p = platform === 'win32' ? path.win32 : path;
  const desktopDir = desktopDirFor({ programRoot, env, platform });
  return {
    desktopDir,
    exe: electronExeFor({ programRoot, env, platform }),
    packageJson: p.join(desktopDir, 'package.json'),
    versionFile: p.join(desktopDir, 'version'),
    resources: p.join(desktopDir, 'resources'),
  };
}
