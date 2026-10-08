/**
 * 面板 → 机器人 控制通道 · **面板侧唯一入口**（D6b · 用户 Q7 裁决①「命令文件轮询」· 依赖图 L1）
 * ══════════════════════════════════════════════════════════════════════
 *  它只做三件事，但每一件都只能有一处
 * ══════════════════════════════════════════════════════════════════════
 * ① 下发命令（`issueCommand`）—— 面板是这条通道上**唯一写请求**的一方；
 * ② 读回执行结果（`controlStateOf`）—— 页面只按它渲染，不自己解析文件；
 * ③ 中文名表（`CONTROL_LABELS`）—— 由 `/api/state` 下发。
 *
 * ⚠️ **判据全部来自 `src/control-channel.js`**：命令闭集合、有效期上限、id 生成、
 *    记录形状都是那一份。这里**一个都不重写** —— 两侧各写一份判据必然漂，
 *    而漂了之后的形态是"面板认为能发、机器人认为不认识"（不报错，只是点不动）。
 *    `src/control-channel.js` 是零依赖叶子，面板引它只多加载一个文件
 *    （白名单见 `check-wb` 的 `LIB_SRC_ALLOW`）。
 *
 * ⚠️ 本模块**不许 import 主文件**（它是 L1，主文件是 L3）。路径只从 `paths.js` 取。
 */

import fs from 'node:fs';
import { CONTROL_FILE } from './paths.js';
import { writeJsonAtomic } from '../../src/atomic-write.js';
import {
  CONTROL_KINDS, CONTROL_MAX_AGE_MS, CONTROL_POLL_MS, newControlId, parseControlRecord,
} from '../../src/control-channel.js';

/**
 * 命令的中文名（**唯一住处**，由 `/api/state` 下发给页面）。
 * 与结构化记忆那张状态表同一条纪律：页面里不许出现这些中文串 ——
 * 抄一份到前端，改了后端就只剩一边生效。
 */
// Q12 裁决①：`sleep` / `wake` = 面板上的「让它睡 / 叫它醒」。
// ⚠️ 它们与上面两个不是同一层（那两个动的是"正在生成的那一轮"，这两个动的是作息），
//    所以按钮在页面上也**分开摆**（见 `01-body-shell.html`）—— 混在一排会让人把
//    「让它睡」当成「停止机器人」。
export const CONTROL_LABELS = { abort: '中止本轮', retry: '重试本轮', sleep: '让它睡', wake: '叫它醒' };

/** 读命令文件。**读不到/坏 JSON 一律给 null**（面板不该因为一个可选通道崩掉）。 */
function readControl() {
  try {
    return parseControlRecord(fs.readFileSync(CONTROL_FILE, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 页面要展示的形态。**只读、不写、不改**。
 *
 * 三个派生字段的用途（页面不许自己算）：
 *   `pending` —— 已下发但还没有执行结果（按钮该灰着，提示"等待机器人执行"）
 *   `stale`   —— 已下发、且已经超过有效期（机器人多半没在跑；告诉用户它不会被执行）
 *   `ageMs`   —— 下发了多久（提示里的秒数）
 *
 * @returns {null|{id:string, cmd:string, at:number, ageMs:number, pending:boolean, stale:boolean, done:object|null}}
 */
export function controlStateOf({ now = Date.now() } = {}) {
  const rec = readControl();
  if (!rec) return null;
  const known = CONTROL_KINDS.includes(rec.cmd);
  const ageMs = rec.at > 0 ? Math.max(0, now - rec.at) : 0;
  const expired = rec.at <= 0 || now - rec.at > CONTROL_MAX_AGE_MS;
  return {
    id: rec.id,
    cmd: rec.cmd,
    at: rec.at,
    ageMs,
    pending: !rec.done && known && !expired,
    stale: !rec.done && known && expired,
    done: rec.done,
  };
}

/**
 * 下发一条命令（`POST /api/bridge/command` 的唯一实现）。
 *
 * ⚠️ **上一条还没执行完时拒绝下发**，而不是覆盖它。理由：文件只有一个槽位，
 *    覆盖等于把用户上一次的点击**静默丢掉**（他以为点了两次，实际只到了一次）。
 *    宁可回一句"上一条还没被执行"，让它可解释。
 *
 * @param {string} cmd 命令种类（闭集合，判据在叶子）
 * @returns {{ok:boolean, id?:string, msg:string}}
 */
export function issueCommand(cmd, { now = Date.now() } = {}) {
  if (!CONTROL_KINDS.includes(cmd)) {
    return { ok: false, msg: `不认识的命令「${cmd}」—— 面板只会发 ${CONTROL_KINDS.map((k) => CONTROL_LABELS[k] || k).join(' / ')}` };
  }
  const prev = readControl();
  if (prev && !prev.done && CONTROL_KINDS.includes(prev.cmd) && prev.at > 0 && now - prev.at <= CONTROL_MAX_AGE_MS) {
    const left = Math.max(1, Math.round((CONTROL_MAX_AGE_MS - (now - prev.at)) / 1000));
    return {
      ok: false,
      msg: `上一条命令（${CONTROL_LABELS[prev.cmd] || prev.cmd}）还没被执行 —— 机器人大概没在运行，`
        + `要再发请等 ${left} 秒后重试`,
    };
  }
  const id = newControlId({ now });
  try {
    writeJsonAtomic(CONTROL_FILE, { id, cmd, at: now, done: null });
  } catch (e) {
    return { ok: false, msg: `写不了命令文件：${e.message}` };
  }
  const secs = Math.max(1, Math.round(CONTROL_POLL_MS / 1000));
  return { ok: true, id, msg: `已下发「${CONTROL_LABELS[cmd] || cmd}」，机器人会在 ${secs} 秒内执行` };
}
