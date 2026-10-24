/**
 * 快速登录账号判据（唯一实现）
 * ══════════════════════════════════════════════════════════════════════════
 *  面板自启协议端、便携包启动器、以及 `start-napcat.mjs` 三条入口都问同一个问题：
 *  「这台机器上一次登录的是哪个 QQ？」
 *
 *  证据只有一条：NapCat 自己留下的 `napcat_<QQ>.json`（每次登录它会更新 mtime）。
 *  **不接受命令行指定号码、不接受安装时手填的号** —— "能免扫"只能证明这台机器
 *  确实有人扫码登录过这个号，别的来源都可能把别人的号拿去登录。
 *
 *  ⚠️ 目录由调用方给（工具侧 `tools/lib/common.mjs`、面板侧 `panel/lib/napcat-native.js`）。
 *     "谁是最近登录"这个判断只有这一份；路径推导留在各自适配器里。
 * @module napcat-login
 */

import fs from 'node:fs';
import path from 'node:path';

/** 登录记录文件名 → QQ 号；不是登录记录就返回空串。 */
export function qqFromAccountFile(name) {
  const m = /^napcat(?:_protocol)?_(\d{5,12})\.json$/i.exec(String(name ?? ''));
  return m ? m[1] : '';
}

/**
 * 从一组 `{ qq, mtime }` 里挑出最近登录的那个。
 *
 * @param {Array<{qq?:string, mtime?:number}>} entries
 * @returns {{qq:string, from:string}} 没有可用记录时 `{qq:'', from:''}`（走二维码）
 */
export function pickKnownAccount(entries) {
  let best = null;
  for (const e of Array.isArray(entries) ? entries : []) {
    const qq = String(e?.qq ?? '').trim();
    if (!/^\d{5,12}$/.test(qq)) continue;
    const mtime = Number(e?.mtime);
    if (!Number.isFinite(mtime)) continue;
    if (!best || mtime > best.mtime) best = { qq, mtime };
  }
  return best
    ? { qq: best.qq, from: 'NapCat 上次登录的账号' }
    : { qq: '', from: '' };
}

/**
 * 列出一个 NapCat `config/` 目录里的登录记录，按 mtime 从新到旧。
 * 目录不存在/读不了 → 空数组（不抛：调用方据此走二维码）。
 *
 * @param {string} dir NapCat 的 `config` 目录
 * @returns {Array<{qq:string, mtime:number}>}
 */
export function knownAccountsByMtimeIn(dir) {
  const out = [];
  let names = [];
  try { names = fs.readdirSync(String(dir || '')); } catch { return out; }
  for (const n of names) {
    const qq = qqFromAccountFile(n);
    if (!qq) continue;
    let st;
    try { st = fs.statSync(path.join(dir, n)); } catch { continue; }
    const hit = out.find((x) => x.qq === qq);
    if (hit) hit.mtime = Math.max(hit.mtime, st.mtimeMs);
    else out.push({ qq, mtime: st.mtimeMs });
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

/**
 * 这次启动要拿去**快速登录**的 QQ 号。
 *
 * @param {string} dir NapCat 的 `config` 目录
 * @param {string} [argCli] 保留参数（已不再使用；命令行指定号码这条路已关闭）
 * @returns {{qq:string, from:string}}
 */
export function resolveLoginQqIn(dir, argCli = '') {
  void argCli;
  return pickKnownAccount(knownAccountsByMtimeIn(dir));
}
