/**
 * 桌面壳的路径解析（P1-7 · 2026-10-23）。
 *
 * 壳必须跟着 app 版本目录走：`versions/<ver>/app/electron/electron.exe`。
 * 这样回滚时旧 app 自带旧壳，不会出现“旧 app + 新壳”的错配。
 *
 * 纯函数、零业务依赖：安装器/启动器/测试都读这一份，别各自拼路径。
 */

import path from 'node:path';

// 按**被测平台**选路径实现，而不是按宿主平台：`platform` 参数存在的意义就是
// 让 Windows 上也能验 POSIX 夹具（反之亦然）。生产里 platform === 宿主，行为不变。
const pathFor = (platform) => (platform === 'win32' ? path.win32 : path.posix);

export function desktopDirFor({ programRoot, env = {}, platform = process.platform } = {}) {
  const p = pathFor(platform);
  if (env && env.QQBOT_DESKTOP_DIR) return p.resolve(String(env.QQBOT_DESKTOP_DIR));
  if (!programRoot) throw new Error('desktopDirFor: 缺少 programRoot');
  return p.join(String(programRoot), 'electron');
}

function electronExeFor({ programRoot, env = {}, platform = process.platform } = {}) {
  const p = pathFor(platform);
  if (env && env.QQBOT_ELECTRON_EXE) return p.resolve(String(env.QQBOT_ELECTRON_EXE));
  return p.join(desktopDirFor({ programRoot, env, platform }), platform === 'win32' ? 'electron.exe' : 'electron');
}

export function shellPaths({ programRoot, env = {}, platform = process.platform } = {}) {
  const p = pathFor(platform);
  const desktopDir = desktopDirFor({ programRoot, env, platform });
  return {
    desktopDir,
    exe: electronExeFor({ programRoot, env, platform }),
    packageJson: p.join(desktopDir, 'package.json'),
    versionFile: p.join(desktopDir, 'version'),
    resources: p.join(desktopDir, 'resources'),
  };
}
