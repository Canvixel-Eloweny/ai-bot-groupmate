/**
 * 把 `src/user-root.js` 载入工具层（P1 · 2026-10-18）。
 *
 * 工具层在包内是 `<pkg>/tools/lib/`，在仓库里是 `packaging/windows/tools/lib/`；
 * 两种位置都没有静态可用的 `app/`。所以用候选表 + `pathToFileURL` 动态 import：
 *   ① installed：`<install>/versions/<current>/app/src/user-root.js`（读 current.json）
 *   ② portable ：`<pkg>/app/src/user-root.js`
 *   ③ dev      ：仓库根 `src/user-root.js`
 *
 * 约束：不用 cwd；缓存 Promise；找不到时把期望路径打出来，而不是只抛 ERR_MODULE_NOT_FOUND。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(HERE, '..', '..');
const REPO_ROOT = path.resolve(HERE, '..', '..', '..', '..');

function candidates() {
  const out = [];
  try {
    const cur = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'current.json'), 'utf8'));
    if (cur && cur.current) {
      out.push(path.join(PACKAGE_ROOT, 'versions', String(cur.current), 'app', 'src', 'user-root.js'));
    }
  } catch { /* 便携包/开发树没有 current.json 是正常的 */ }
  out.push(path.join(PACKAGE_ROOT, 'app', 'src', 'user-root.js'));
  out.push(path.join(REPO_ROOT, 'src', 'user-root.js'));
  return out;
}

let cached = null;

export function loadUserRoot() {
  if (!cached) cached = importRoot();
  return cached;
}

async function importRoot() {
  const tried = candidates();
  for (const file of tried) {
    if (!fs.existsSync(file)) continue;
    return import(pathToFileURL(file).href);
  }
  throw new Error(
    '找不到 src/user-root.js —— 工具层无法解析程序根/用户数据根。\n'
    + '期望以下位置之一：\n' + tried.map((p) => `  · ${p}`).join('\n')
  );
}
