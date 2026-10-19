#!/usr/bin/env node
/**
 * 「NapCat 离线包三件套」的自检（P6 · 2026-10-18）。
 *
 * 为什么需要它：三件套是给用户的**替代品**，替代的是"从 GitHub 现下 35MB"。
 * 一旦它悄悄漂移（重打包改了哈希 / 换了版本没改声明 / 许可全文没带上），
 * 用户拿到的是一个"看起来能用、实际来路说不清"的东西 —— 而许可条款恰恰把
 * "随附许可全文 + 写明出处"设成了再分发的**先决条件**。所以这份核对必须是脚本，
 * 不能靠"下次记得检查"。
 *
 * 用法：
 *   node scripts/check-napcat-kit.mjs [--kit <目录>] [--offline]
 *
 * 判据（任何一条不过 ⇒ exit 1）：
 *   ① zip 在、尺寸 ≥ `napcat.json.assetMinBytes`（拦 994KB 的 OneKey 壳）
 *   ② 实测 sha256 **命中** `napcat.json.knownGood` 的某一行（哈希反查，与人同一条路）
 *   ③ 该行的 tag 与 SHA-256 与 `NAPCAT-SHA256.txt` / `NAPCAT-SOURCE.txt` 写的一致
 *   ④ `NAPCAT-LICENSE.txt` 在且含"Redistribution"（许可全文，不是节选）
 *   ⑤ 出处声明含仓库地址 / tag / asset 名 / 取回时间
 *   ⑥ 线上核对：GitHub Release 的 `assets[].digest` 必须存在且与实测一致；
 *      **拿不到 digest 就拒绝**（"没核对"不等于"核对通过"）。`--offline` 时
 *      这一条打印成"未联网核对"并**继续失败**，因为这份 kit 的正是要发给别人。
 *
 * ⚠️ 本脚本只读：不下载、不写 kit、不联网改任何东西。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argOf = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? String(process.argv[i + 1] || '') : '';
};

function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

async function main() {
  const kit = path.resolve(argOf('--kit') || path.join(os.homedir(), 'Desktop', 'estrella-dist', 'napcat-kit'));
  const offline = process.argv.includes('--offline');
  const problems = [];
  const notes = [];
  const miss = (m) => problems.push(m);

  const cfg = JSON.parse(fs.readFileSync(path.join(REPO, 'packaging/windows/tools/napcat.json'), 'utf8'));
  const known = Array.isArray(cfg.knownGood) ? cfg.knownGood : [];
  if (known.length < 2) miss('napcat.json.knownGood 少于 2 条，无从核对');

  const zipPath = path.join(kit, cfg.asset || 'NapCat.Shell.zip');
  if (!fs.existsSync(zipPath)) {
    miss(`kit 里没有 ${cfg.asset}：${kit}`);
  } else {
    const size = fs.statSync(zipPath).size;
    const hex = sha256(zipPath);
    notes.push(`zip    ${path.basename(zipPath)}  ${size} 字节  sha256 ${hex.slice(0, 16)}…`);
    if (size < Number(cfg.assetMinBytes)) miss(`尺寸 ${size} 低于地板 ${cfg.assetMinBytes} —— 这不是官方 NapCat.Shell.zip（OneKey 壳只有 994,134 字节）`);
    const hit = known.find((e) => String(e.sha256).toLowerCase() === hex);
    if (!hit) miss('实测 sha256 **不在** napcat.json.knownGood 里 ⇒ kit 与安装器认的那张表脱节了（要么重洗 kit，要么把这一版加进表并核对来源）');
    else {
      notes.push(`命中清单版本 ${hit.tag}（记录尺寸 ${hit.size}）`);
      if (hit.size && hit.size !== size) miss(`knownGood 记的尺寸 ${hit.size} 与实测 ${size} 不符`);
      const shaTxt = path.join(kit, 'NAPCAT-SHA256.txt');
      if (!fs.existsSync(shaTxt)) miss('缺 NAPCAT-SHA256.txt');
      else if (!fs.readFileSync(shaTxt, 'utf8').toLowerCase().includes(hex)) miss('NAPCAT-SHA256.txt 里的哈希与实测不是同一份件');
      const srcTxt = path.join(kit, 'NAPCAT-SOURCE.txt');
      if (!fs.existsSync(srcTxt)) miss('缺 NAPCAT-SOURCE.txt（许可的"写明出处"是再分发的先决条件）');
      else {
        const s = fs.readFileSync(srcTxt, 'utf8');
        for (const [label, needle] of [['仓库地址', /github\.com/i], ['tag', new RegExp(hit.tag.replace('.', '\\.'))], ['asset 名', new RegExp(String(cfg.asset).replace('.', '\\.'))], ['取回时间', /20\d\d-\d\d-\d\d/]]) {
          if (!needle.test(s)) miss(`NAPCAT-SOURCE.txt 里没有${label}`);
        }
      }
      const lic = path.join(kit, 'NAPCAT-LICENSE.txt');
      if (!fs.existsSync(lic)) miss('缺 NAPCAT-LICENSE.txt（许可全文，缺了就没有再分发的依据）');
      else {
        const t = fs.readFileSync(lic, 'utf8');
        if (!/Redistribution/i.test(t) || t.length < 500) miss('NAPCAT-LICENSE.txt 看着不像许可全文（要逐字全文，不是节选）');
      }
      if (!fs.existsSync(path.join(kit, 'README-群内说明.txt'))) miss('缺 README-群内说明.txt（告诉用户这是什么、怎么放、放哪儿）');

      // ⑥ 线上核对 digest
      if (offline) miss(`要求联网核对 assets[].digest，但给了 --offline（这份 kit 是要发给别人的，"没核对"不算通过）`);
      else {
        try {
          const u = `https://api.github.com/repos/${cfg.repo}/releases/tags/${hit.tag}`;
          const res = await fetch(u, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'estrella-bot-kit-check' } });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const j = await res.json();
          const asset = (j.assets || []).find((a) => a.name === cfg.asset);
          if (!asset) throw new Error(`Release ${hit.tag} 里没有 asset ${cfg.asset}`);
          if (typeof asset.digest !== 'string' || !/^sha256:/i.test(asset.digest)) miss('GitHub 侧没有 assets[].digest —— 无法证明这份件是原件，拒绝通过');
          else if (`sha256:${hex}`.toLowerCase() !== asset.digest.toLowerCase()) miss(`与官方 digest 不一致（官方 ${asset.digest.slice(7, 23)}… 实测 ${hex.slice(0, 16)}…）⇒ 这份件被重打包/改过`);
          else notes.push('与官方 assets[].digest 逐字一致 ⇒ 是未修改的原件字节');
        } catch (e) {
          miss(`线上核对失败：${e.message}（本机对 api.github.com 才有解，VM 上 DNS 直失败，别在 VM 上跑本脚本）`);
        }
      }
    }
  }

  for (const n of notes) console.log(`  · ${n}`);
  if (problems.length) {
    for (const p of problems) console.log(`✗ ${p}`);
    console.log(`── napcat-kit 自检：${problems.length} 处问题 ──`);
    process.exitCode = 1;
    return;
  }
  console.log(`✓ napcat-kit 自检通过：原件字节 = 官方 digest，许可全文与出处声明齐备（${kit}）`);
}

main();
