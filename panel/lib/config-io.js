/**
 * `config.json` 的**唯一所有者**（第 38 轮 B11b-2 · AR-SERVERSPLIT · 依赖图 L1）
 * ══════════════════════════════════════════════════════════════════════════
 *  这个模块只装三个函数，但它们共同承担一条**全项目级的不变量**：
 *
 *      「config.json 的唯一写入者必须是面板，机器人只读。」
 *
 *  这条不变量以前由 `panel/server.js` 里的一段注释 + `check-wb` 的 3k 契约共同守护。
 *  现在实现搬到了这里 —— **契约的扫描目标也一并改到这里**（锚点是"实现所在文件"，
 *  不是"历史上它曾经在的文件"）。搬了实现却没搬契约，契约就会变成一条永远绿的摆设。
 *
 *  为什么 `writeConfig` 必须是唯一入口：
 *    · 它是**唯一**会先记历史、再原子写的地方（顺序是刻意的，见函数注释）；
 *    · 绕开它直接写 config.json，就绕开了"撤销上一次保存"这条后悔药；
 *    · 而"绕开"的表现不是报错，是**某天发现回不去了**。
 *
 *  ⚠️ 本模块**不许 import 主文件**。它是 L1，主文件是 L3 —— 一旦反向依赖，
 *     B11b 消掉的循环就会从底部长回来（`check-wb` 的契约把这条盯在 `BACKEND_SOURCES` 上）。
 *  ⚠️ 路径**不许在这里自己拼**。`configPath()` 只是 `paths.js` 里 `CONFIG_FILE` 的
 *     一个别名 —— 推导只发生一次（`ROOT` 是"搬了就静默失效"的头号风险，见 paths.js）。
 */

import fs from 'node:fs';
import { CONFIG_FILE, HISTORY_FILE } from './paths.js';
import { writeJsonAtomic } from '../../src/atomic-write.js';
import { appendHistory, historyEntryOf } from '../../src/config-history.js';

/**
 * `config.json` 的绝对路径。
 * 别名而不是重新推导 —— 路径的唯一推导处在 `paths.js`。
 * **不对外导出**：外面要用路径就直接从 `paths.js` 取 `CONFIG_FILE`，
 * 别在这里多开一个"拿路径"的口子（"同一份语义两份拷贝"就是这么长出来的）。
 */
function configPath() {
  return CONFIG_FILE;
}

/**
 * 读配置。**读不到就返回 null，不抛**。
 *
 * 这个"吞掉异常"是刻意的，也是一处**危险**：配置读不到时整台面板会用默认值继续跑，
 * 看不出任何异常。所以它必须读对路径 —— 路径算错的表现正是"面板突然变回默认配置"。
 * （`paths.js` 里那道 `package.json` 自检就是为了让这种情况下**当场崩**。）
 */
export function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPath(), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 写配置。**所有写配置的路径都必须经过它**（`check-wb` 契约 3k 盯着）。
 *
 * @param cfg      新配置
 * @param via      这次改动来自哪条路由（进历史，便于追"谁改的"）
 * @param history  `false` 表示这次写**不进历史** —— 只有"撤销"会用
 *                 （撤销自己再记一条历史，会把撤销点也变成一个可撤销的状态，越绕越乱）
 */
export function writeConfig(cfg, { via = '', history = true } = {}) {
  // 先把**旧的那一份**存进历史（B10b · O-CFGHIST）。
  // 顺序是刻意的：宁可"历史记上了但新配置没写成"（可以再存一次），
  // 也不要"新配置写上了但历史没记"（那就真的回不去了）。
  // 记不下来也要继续写 —— 历史是后悔药，不该变成拦路石。
  if (history) {
    try {
      const prev = readConfig();
      if (prev) appendHistory(HISTORY_FILE, historyEntryOf(prev, { actor: 'panel', via }));
    } catch {
      /* 历史记不下来不影响这次保存 */
    }
  }

  // 原子写（B10a · O-ATOMIC）。config.json 是最不该被写坏的那个文件：
  // 原地覆盖时读到半个 JSON，面板会把它当成"配置损坏"，
  // 而用户刚刚明明点的是"保存成功"。
  writeJsonAtomic(configPath(), cfg);
}
