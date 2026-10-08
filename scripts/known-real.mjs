/**
 * ══════════════════════════════════════════════════════════════════════
 *  已知真实标识符 —— **单一来源**（表本体住在**仓库外**）
 * ══════════════════════════════════════════════════════════════════════
 *
 * ⚠️ 2026-10-05（开源前审查 · S-01）：本文件此前**直接持有真值表** ——
 *    于是「把仓库推成公开仓库」就等于「把这台机器上真实用过的 QQ 号 / 群号 /
 *    本机用户名连同 311 个提交的 git 历史一起公开」。真值表按设计必须存在
 *    （它是"防真值被抄回来"的哨兵），所以它**不能住在这个仓库里**。
 *
 * 现在它只是一个**加载器**：
 *   · 默认从 `~/.qqbot/known-real.local.mjs` 读（可用环境变量 `QQBOT_KNOWN_REAL` 覆盖）；
 *   · 读不到 → `KNOWN_REAL = []` 且 `KNOWN_REAL_LOADED = false`；
 *   · **两个消费者**（`publish-audit.mjs` / `make-publish-copy.mjs`）
 *     在 `KNOWN_REAL_LOADED === false` 时**必须告警**，不许静默降级 ——
 *     空表会让"已知标识符"这条判据在**真空里通过**，而它恰恰是防真值抄回来的那道闸
 *     （本项目头号风险：输入为空 ≠ 通过）。
 *
 * 表本体字段（外部文件里那张表，与旧版逐字相同）：
 *   re          —— 匹配该标识符的正则（带 g，用前请把 lastIndex 归零）
 *   what        —— 它是什么（这句话决定下一任维护者能不能删它）
 *   placeholder —— 已被替换成的占位符（没有就不写；`make-publish-copy` 用它做去标识映射）
 *
 * ⚠️ **单一来源纪律没变**：两个消费者都只能从**本文件**取表，不许各抄一份 ——
 *    抄一份 = 多一个泄漏口（2026-09-27 实测：make-publish-copy 第一版把真值硬编码进
 *    自己的 KEYS，`publish-audit` 当场报 5 项阻断）。
 * ⚠️ **本文件不许再出现任何真值字面量**：`check-wb` §34 有一条契约专门钉这一点
 *    （查 `re: /…/` 条目与 9–11 位数字）。改这里之前先读它。
 * ⚠️ 自用扩展包白名单**已拆走**到 `scripts/plugin-allowlist.mjs`（S-01 同批）——
 *    它是**非敏感**的目录名，与真值表性质不同，不该跟着一起搬出仓库。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** 真值表的**仓库外**位置（默认 `~/.qqbot/known-real.local.mjs`）。 */
export const KNOWN_REAL_SOURCE = process.env.QQBOT_KNOWN_REAL
  || path.join(os.homedir(), '.qqbot', 'known-real.local.mjs');

let loaded = false;
let table = [];
try {
  const resolved = path.resolve(KNOWN_REAL_SOURCE);
  if (fs.existsSync(resolved)) {
    const mod = await import(pathToFileURL(resolved).href);
    if (Array.isArray(mod.KNOWN_REAL)) {
      table = mod.KNOWN_REAL;
      loaded = true;
    }
  }
} catch {
  // 读不到 / 文件坏了都算"没加载到"：消费者据此告警。**不在这里抛** ——
  // 抛出去会让 publish-audit 直接崩，而"崩"会被读成"审计不通过"，掩盖真正的病因。
  loaded = false;
}

/** 真值表**是否真的从仓库外加载到了**（false = 空表，消费者必须告警）。 */
export const KNOWN_REAL_LOADED = loaded;

/** 已知真实标识符。加载不到时为空数组 —— 但那时请先看 `KNOWN_REAL_LOADED`。 */
export const KNOWN_REAL = table;
