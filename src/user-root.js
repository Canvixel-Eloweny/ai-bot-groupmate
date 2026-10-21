/**
 * 程序根 / 安装根 / 用户数据根的**唯一解析处**（P1 · 2026-10-18）。
 *
 * 为什么要有它：改造前 `ROOT` 在 panel 与 10 个 src 模块里各推导一次，
 * 且 `panel/lib/paths.js` 的配置路径不认 `QQBOT_CONFIG` —— 面板与机器人
 * 可以各读一份配置而**不报任何错**。这个叶子把“程序在哪、数据在哪”收成一份判据。
 *
 * 约束：
 *   · 只 import `node:` 内置；不 import config/logger/panel 任何模块。
 *   · 加载期只做同步计算，不 mkdir、不写盘（import 不能有副作用）。
 *   · 所有路径都能被 `resolveRoots({ env, programRoot, exists, readJson })` 注入测试，
 *     不依赖 cwd。
 *
 * 模式：
 *   dev       仓库根（`git` 开发树）
 *   portable  `<pkg>/app` + 同级 `tools`/`runtime` ⇒ `<pkg>/userdata`
 *   installed 向上找到 `install.json` ⇒ `install.json.userRoot` 或 `%LOCALAPPDATA%`
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 本文件在 `src/`，上一级就是程序根（dev 仓库 / `<pkg>/app` / `versions/<ver>/app`）。 */
export const PROGRAM_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const INSTALL_JSON = 'install.json';
const VALID_MODES = new Set(['dev', 'portable', 'installed']);

function readJsonFile(file) {
  const text = fs.readFileSync(file, 'utf8');
  return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
}

function absFrom(base, value) {
  return path.isAbsolute(value) ? path.resolve(value) : path.resolve(base, value);
}

function walkUpInstall(start, { exists, readJson }) {
  let dir = path.resolve(start);
  for (let i = 0; i < 4; i += 1) {
    const file = path.join(dir, INSTALL_JSON);
    if (exists(file)) {
      let info;
      try {
        info = readJson(file);
      } catch (e) {
        throw new Error(`install.json 读不出来（${file}）：${e.message}`);
      }
      if (!info || typeof info !== 'object' || Array.isArray(info)) {
        throw new Error(`install.json 形状不对（${file}）：应为对象`);
      }
      return { installRoot: dir, installInfo: info };
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function detectMode({ env, programRoot, exists, readJson }) {
  const forced = String(env.QQBOT_MODE || '').trim();
  if (forced) {
    if (!VALID_MODES.has(forced)) {
      throw new Error(`QQBOT_MODE=${forced} 不合法（只允许 dev / portable / installed）`);
    }
    if (forced === 'dev') return { mode: 'dev', installRoot: programRoot, installInfo: null };
    if (forced === 'portable') {
      if (path.basename(programRoot) !== 'app') {
        throw new Error('QQBOT_MODE=portable 但程序根不是 <pkg>/app');
      }
      return { mode: 'portable', installRoot: path.dirname(programRoot), installInfo: null };
    }
    const found = walkUpInstall(programRoot, { exists, readJson });
    if (!found) {
      throw new Error('QQBOT_MODE=installed 但向上找不到 install.json');
    }
    return { mode: 'installed', ...found };
  }

  const found = walkUpInstall(programRoot, { exists, readJson });
  if (found) return { mode: 'installed', ...found };

  if (path.basename(programRoot) === 'app') {
    const pkgRoot = path.dirname(programRoot);
    if (exists(path.join(pkgRoot, 'tools')) && exists(path.join(pkgRoot, 'runtime'))) {
      return { mode: 'portable', installRoot: pkgRoot, installInfo: null };
    }
  }

  return { mode: 'dev', installRoot: programRoot, installInfo: null };
}

function userRootOf({ mode, programRoot, installRoot, installInfo, env }) {
  const override = String(env.QQBOT_USER_ROOT || '').trim();
  if (override) return absFrom(programRoot, override);

  if (mode === 'installed') {
    const fromInstall = installInfo && installInfo.userRoot;
    if (fromInstall) return absFrom(installRoot, String(fromInstall));
    const local = env.LOCALAPPDATA
      || (process.platform === 'win32'
        ? path.join(os.homedir(), 'AppData', 'Local')
        : path.join(os.homedir(), '.local', 'share'));
    return path.join(local, 'EstrellaBot', 'userdata');
  }

  if (mode === 'portable') return path.join(installRoot, 'userdata');
  return programRoot;
}

/**
 * 解析三根与全部派生路径。纯函数式：IO 全部可注入，测试可构造任意布局。
 */
export function resolveRoots(options = {}) {
  const env = options.env || process.env;
  const programRoot = path.resolve(options.programRoot || PROGRAM_ROOT);
  const exists = options.exists || fs.existsSync;
  const readJson = options.readJson || readJsonFile;
  const detected = detectMode({ env, programRoot, exists, readJson });
  const userRoot = userRootOf({ ...detected, programRoot, env });
  const panelStateDir = path.join(userRoot, 'panel');

  return {
    mode: detected.mode,
    programRoot,
    installRoot: detected.installRoot,
    userRoot,
    panelStateDir,
    updateDir: path.join(userRoot, 'update'),
    configFile: env.QQBOT_CONFIG
      ? absFrom(programRoot, String(env.QQBOT_CONFIG))
      : path.join(userRoot, 'config.json'),
    dataDir: env.QQBOT_DATA_DIR
      ? absFrom(userRoot, String(env.QQBOT_DATA_DIR))
      : path.join(userRoot, 'data'),
    pluginsDir: env.QQBOT_PLUGINS_DIR
      ? absFrom(userRoot, String(env.QQBOT_PLUGINS_DIR))
      : path.join(userRoot, 'plugins'),
    skillsDir: env.QQBOT_SKILLS_DIR
      ? absFrom(userRoot, String(env.QQBOT_SKILLS_DIR))
      : path.join(userRoot, 'skills'),
    personaDir: path.join(userRoot, 'persona'),
    napcatDir: path.join(userRoot, 'napcat'),
    setupStateFile: path.join(userRoot, 'setup-state.json'),
    migrationFile: path.join(userRoot, 'migration.json'),
  };
}

const ROOTS = resolveRoots();

export const MODE = ROOTS.mode;
export const INSTALL_ROOT = ROOTS.installRoot;
export const USER_ROOT = ROOTS.userRoot;
export const PANEL_STATE_DIR = ROOTS.panelStateDir;
export const CONFIG_FILE = ROOTS.configFile;
export const DATA_DIR = ROOTS.dataDir;
export const PERSONA_DIR = ROOTS.personaDir;
export const NAPCAT_DIR = ROOTS.napcatDir;
export const SETUP_STATE_FILE = ROOTS.setupStateFile;
export const MIGRATION_FILE = ROOTS.migrationFile;
export const UPDATE_DIR = ROOTS.updateDir;

/** 程序资产路径（版本目录内，升级时可替换）。 */
export const programFile = (rel = '') => path.join(ROOTS.programRoot, rel);
/** 用户数据路径（升级/卸载默认保留）。 */
export const userFile = (rel = '') => path.join(ROOTS.userRoot, rel);
/** 面板运行态路径（USER_ROOT/panel）。 */
export const panelFile = (name = '') => path.join(ROOTS.panelStateDir, name);

/** 建启动必需的三层 + 图片工具的本机目录；napcat 由协议端安装流程自己建。 */
export function ensureUserDirs({ roots = ROOTS, fsApi = fs } = {}) {
  for (const dir of [roots.userRoot, roots.panelStateDir, roots.dataDir, path.join(roots.dataDir, 'images-out')]) {
    fsApi.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  return roots;
}
