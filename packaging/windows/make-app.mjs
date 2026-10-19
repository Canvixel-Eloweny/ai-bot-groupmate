#!/usr/bin/env node
/**
 * 生成**包内**的 `app/`：对外拷贝 + 剔除 `app/packaging/`。
 *
 * 为什么不是直接 `node scripts/make-publish-copy.mjs pkg/app`（手册第 1 步的老写法）：
 *   2026-10-15 起 `packaging/` **进了仓库发布面**（维护者点名：源码都上传），
 *   于是 make-publish-copy 生成的 `app/` 里会带上 `app/packaging/windows/`（28 个文件）。
 *   而包里**顶层已经有一份** `tools/` 与那几个 `.bat` —— 同一个 `setup.mjs` 在一个包里
 *   出现两份，正是「一份数据维护两遍」要避免的：`.bat` 按 `%~dp0tools\` 定位，改一份
 *   不会改到另一份，症状是"我改了包里的 tools，重启还是旧的"。
 *
 * ⇒ 仓库发布面（GitHub 上能看、能照着重建）与**包内分发面**（用户拿到的那份）是两件事：
 *    前者要完整，后者不带重复件。这个脚本就是后者那一条的入口。
 *
 * 用法：
 *   node packaging/windows/make-app.mjs <pkg目录>
 *
 * 退出码：0 = 干净；非 0 = 生成或剔除失败（不静默）。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PKG = process.argv[2];
if (!PKG) {
  console.error('用法：node packaging/windows/make-app.mjs <pkg目录>');
  process.exit(2);
}
const APP = path.resolve(PKG, 'app');
const PRUNE = path.join(APP, 'packaging');
const PRUNE_RESOURCES = path.join(APP, 'resources');

// ① 生成对外拷贝（复用发布面判据：git ls-files + 真值复扫，一处实现不抄第二份）
console.log('① 生成 app/ 对外拷贝…');
execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'make-publish-copy.mjs'), APP], {
  stdio: 'inherit',
});

// ② 剔除包内重复的构建素材（顶层 tools/ 才是分发给用户的那份）
if (fs.existsSync(PRUNE)) {
  const n = fs.readdirSync(PRUNE, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile()).length;
  fs.rmSync(PRUNE, { recursive: true, force: true });
  console.log(`② 已剔除 app/packaging/（${n} 个文件，与顶层拼装件重复）`);
} else {
  console.log('② app/packaging/ 不存在，无需剔除');
}

// ②b 剔除 app/resources：更新公钥只在安装器 payload 的 <InstallRoot>/resources 落一份
if (fs.existsSync(PRUNE_RESOURCES)) {
  const n = fs.readdirSync(PRUNE_RESOURCES, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile()).length;
  fs.rmSync(PRUNE_RESOURCES, { recursive: true, force: true });
  console.log(`②b 已剔除 app/resources/（${n} 个文件，公钥只随安装器 payload 发布）`);
} else {
  console.log('②b app/resources/ 不存在，无需剔除');
}

// ③ 自证：包内不应再有两份 setup.mjs
const dup = [
  path.join(APP, 'packaging', 'windows', 'tools', 'setup.mjs'),
  path.join(APP, 'packaging', 'windows', 'launcher', '一键安装.bat'),
];
const left = [...dup, PRUNE_RESOURCES].filter((p) => fs.existsSync(p));
if (left.length) {
  console.error(`✗ 仍有重复件/未清理目录：${left.join(', ')}`);
  process.exit(1);
}
console.log('③ 自证通过：包内只有一份 tools/ 与一套启动器');
