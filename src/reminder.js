/**
 * 提醒判据（D17 · 报告 E9「提醒三件套」）
 * ══════════════════════════════════════════════════════════════════════════
 *  开工量数（第 23 次推翻规格）—— 这一半**本来就在跑**
 * ══════════════════════════════════════════════════════════════════════════
 *  规格把"提醒三件套"写成新增能力。实测 `custom.trigger.scheduled`（定时消息）这一半
 *  已经在 `tickProactive()` 里跑着，而且该有的闸一个都不少：主动出站总闸 / 白名单群 /
 *  免打扰 / 到点判据 + 去重 / 限流 / 出口闸门 / 配额记账 / 30 秒 tick。
 *
 *  → 所以本文件**不是**"一个提醒系统"，只是把既有调度**缺的三件**补成纯函数：
 *    ① **日期维度** —— `scheduled` 原本只认 `HH:MM`，于是每一条都是"每天这个点"。
 *    ② **到点后的重试窗与 missed 收尾** —— 原本是"跳过 + 记一行日志"，没有重试、也没有
 *       "这条算错过"这个状态（被限流挡一下就永久没了）。
 *    ③ **什么日子才排** —— 交给 `src/holidays.js` 的查表（只 import 同为叶子的它）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  ⚠️ 两条硬约束（违反就是另一条调度线 / 另一份用户资产）
 * ══════════════════════════════════════════════════════════════════════════
 *  ① **不新开第二条调度**：这里只出判据，接线**只有一处**（`tickProactive` 里那段遍历），
 *     挂在既有的 30 秒 tick 上。另起一个 `setInterval` 就是第二个"谁在发消息"的入口。
 *  ② **运行时状态不进 `config.json`**：`custom` 是用户资产，机器人高频写它迟早与面板互相覆盖
 *     （D11a 的教训：自动记忆就是因此单独住的）。"发过了 / 错过了 / 这天不排"落
 *     `panel/reminder-state.json` —— 新落盘文件，三件套见 `.gitignore` /
 *     `test/sandbox.sh --exclude` / `QQBOT_REMINDER_FILE`。
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  窗口怎么算（用户 Q24 裁决：按墙钟）
 * ══════════════════════════════════════════════════════════════════════════
 *  窗口起点是**到期时刻**，不是"第一次被拦下的时刻"（判据写成 `now - dueMs`，契约 §46 ⑤ 盯着）。
 *  于是静默期 / 睡眠**计入**窗口：07:50 到期、免打扰到 08:00 → 08:00 出静默后仍在窗口内，
 *  正常补发；而 23:10 到期（静默到次日 08:00）→ 次日再看已经超窗，记 `missed`。
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  "拿不准朝哪边倒"
 * ══════════════════════════════════════════════════════════════════════════
 *  ① `at` 认不出 → **整条不触发**（`null`）。回落到"现在"的话，一条填错的提醒会变成
 *     "每 30 秒都到期"，那是刷屏。
 *  ② `date` 填了却认不出 → **整条不触发**（`null`），**不退回落成每天**。填了日期说明用户
 *     要的是"那天那一次"，退回"每天"是比不发糟得多的误解。
 *  ③ `on` 认不出 → 当 `any`（照常排）。与 §3.2 ③「判定类失败一律放行」同向。
 *  ④ **只要有一个群发出去了就标 `sent`** —— 重发会让已经收到过的那个群再收一遍，
 *     重复一遍的代价比漏一个群大。
 *  ⑤ **`missed` 要"亲眼看着它到点"才记**（接线侧用 `seenDue` 集合守着）：
 *     进程启动时就已经过窗的那些，不该被记成"错过了" —— 那时它根本没在跑。
 *
 * ⚠️ 下面的常量全是**经验值**（对齐"半小时之内还算数"这个量级），不是任何官方阈值。
 */

import { parseIsoDay, dayKeyOf, dayKindOf } from './holidays.js';

/**
 * 到点之后的**重试窗口**：30 分钟（经验值）。
 * 窗口内每个 tick（30 秒）再试一次；超窗仍没发出 → `missed`。
 */
export const REMINDER_WINDOW_MS = 30 * 60 * 1000;

/** 三个**终态**：写进状态文件之后这条就不再被考虑。 */
const REMINDER_STATUS = ['sent', 'missed', 'skipped'];

/** `on` 的闭集合：`any` = 每天都排，`workday` / `rest` = 只在那类日子排。 */
export const REMINDER_ON = ['any', 'workday', 'rest'];

/** 状态文件里保留多久（7 天，**经验值**）：更久只会让文件长而不带来任何判断力。 */
const REMINDER_STATE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** 状态文件的条数上限（**经验值**）：有界才有"它不会无限涨"这件事。 */
const REMINDER_STATE_MAX_ITEMS = 300;

const HHMM_RE = /^(\d{1,2}):(\d{2})$/;

/** 解析 `HH:MM`。认不出（含 `25:00` / `9:5`）一律 `null`。 */
export function parseHhmm(s) {
  const m = HHMM_RE.exec(String(s == null ? '' : s).trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return { h, mi };
}

/**
 * 这条提醒**这一次**的到期时刻（本地时区，绝对毫秒）。
 *
 * 为什么返回**绝对时刻**而不是"今天的 HH:MM"：有了它，去重键就是 `${id}@${dueMs}` ——
 * 跨天天然不同、"某年某月某日那一次"天然唯一，于是不需要第二份"今天几号"的口径
 * （一份数据不许维护两遍），也不必去 import 带 IO 的日期工具。
 *
 * @param {{at?:string, date?:string}} entry `custom.trigger.scheduled` 里的一条
 * @param {number|Date} now
 * @returns {number|null} `null` = 这条认不出来，**整条不触发**
 */
export function dueMsOf(entry, now = Date.now()) {
  const t = parseHhmm(entry?.at);
  if (!t) return null;
  const n = new Date(now);
  let y = n.getFullYear();
  let mo = n.getMonth();
  let d = n.getDate();
  const raw = entry?.date;
  if (raw !== undefined && raw !== null && String(raw).trim() !== '') {
    const p = parseIsoDay(raw);
    if (!p) return null; // 填了却认不出 → 不退回落成每天（见文件头 ②）
    y = p.y;
    mo = p.m - 1;
    d = p.d;
  }
  return new Date(y, mo, d, t.h, t.mi, 0, 0).getTime();
}

/** 去重键：`${id}@${dueMs}`。⚠️ 键里带 dueMs 是刻意的（见 `dueMsOf` 的注释）。 */
export function keyOf(id, dueMs) {
  return `${id == null || id === '' ? '_' : id}@${dueMs}`;
}

/**
 * 这条提醒此刻处在哪一相。
 *
 * @param {{now:number, dueMs:number, status?:string}} a `status` = 状态文件里已有的终态
 * @returns {'pending'|'due'|'missed'|'sent'|'skipped'}
 */
export function phaseOf({ now, dueMs, status } = {}) {
  if (REMINDER_STATUS.includes(status)) return status; // 终态一律透传，不重判
  if (!Number.isFinite(dueMs)) return 'pending';
  if (now < dueMs) return 'pending';
  if (now - dueMs < REMINDER_WINDOW_MS) return 'due';
  return 'missed';
}

/** `on` 与当日类型是否匹配（认不出的 `on` 当 `any` —— 朝"照常排"倒）。 */
export function matchesOn(on, dayKind) {
  const want = REMINDER_ON.includes(on) ? on : 'any';
  if (want === 'any') return true;
  return want === dayKind;
}

/** 到期那天的类型（`workday` / `rest`）—— 接线方不必自己去拼 ISO 串。 */
export function dayKindAt(dueMs, table = {}) {
  return dayKindOf(dayKeyOf(new Date(dueMs)), table);
}

/** 从键里取回 dueMs（供清扫用）；取不出 → `NaN`。 */
export function dueMsOfKey(key) {
  const at = String(key).lastIndexOf('@');
  return at < 0 ? NaN : Number(String(key).slice(at + 1));
}

/**
 * 清扫状态文件：丢掉过老的、条数超上限时丢最老的。
 *
 * 纯函数（返回**新对象**，不改入参）—— 否则"清扫"这件事就只能靠真 IO 测，
 * 而反例（未来的键不许被丢）根本喂不进去。
 */
export function pruneReminderState(state, { now = Date.now(), maxAgeMs = REMINDER_STATE_MAX_AGE_MS, maxItems = REMINDER_STATE_MAX_ITEMS } = {}) {
  const src = state && typeof state === 'object' ? state : {};
  const keep = [];
  for (const [k, v] of Object.entries(src)) {
    const due = dueMsOfKey(k);
    if (!Number.isFinite(due)) continue; // 认不出到期的键：没有它就无法判断老不老 → 丢
    if (now - due > maxAgeMs) continue;
    keep.push([k, v, due]);
  }
  keep.sort((a, b) => b[2] - a[2]); // 新的在前
  const cut = keep.slice(0, maxItems);
  const out = {};
  for (const [k, v] of cut) out[k] = v;
  return out;
}
