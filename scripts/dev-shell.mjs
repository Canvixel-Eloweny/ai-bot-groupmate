#!/usr/bin/env node
/**
 * 开发用的 Electron 启动器：不经安装布局，直接把 electron/ 当作 app 打开。
 *
 * 本机 AI 环境会注入 ELECTRON_RUN_AS_NODE=1（见 AGENTS.md 的 R39 同族）；
 * 那会让 Electron 以 Node 运行而不是开窗口，所以这里显式删掉再 spawn。
 */

import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const electronPath = require('electron');
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
if (process.argv.includes('--hidden')) env.QQBOT_START_HIDDEN = '1';
// 开发壳与面板读同一份 launch 偏好（关闭行为）；没有配置就按 tray fail-open。
const devConfig = path.join(repoRoot, 'config.json');
if (!env.QQBOT_CONFIG && fs.existsSync(devConfig)) env.QQBOT_CONFIG = devConfig;

const child = spawn(electronPath, [path.join(repoRoot, 'electron'), ...process.argv.slice(2)], {
  cwd: repoRoot,
  env,
  stdio: 'inherit',
});
child.once('exit', (code) => process.exit(code ?? 0));
child.once('error', (e) => {
  console.error(`[dev-shell] ${e.message}`);
  process.exit(1);
});
