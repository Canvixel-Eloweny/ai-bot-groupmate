/**
 * 节假日查表底座（D17 · 报告 E9「提醒三件套 + 节假日」的第三件）
 * ══════════════════════════════════════════════════════════════════════════
 *  为什么单独一个文件，且必须零依赖
 * ══════════════════════════════════════════════════════════════════════════
 *  判据层不许长依赖（同 `src/interject.js` / `src/browse-lock.js`）：这里是**零依赖纯函数**，
 *  谁都能 import 而不会被它拖进 IO。提醒（`src/reminder.js`）与将来的作息（D31）都要问
 *  "今天算上班还是算休息"，答案只能有一个 —— 所以查表判据住在叶子上，接线方各自取。
 *
 *  ⚠️ **它同时是全仓「本地日期键 / 月份键」的唯一实现**（`dayKeyOf` / `monthKeyOf`，
 *  第 13 轮 H-11 收敛）。这不是"顺手塞进来"：`src/reminder.js` 只许依赖本文件（契约 §46①），
 *  而本文件必须零依赖，所以"本地日期键"这个语义**只能**住在这里 ——
 *  面板、`trace-stats`、`usage`、`scripts/cache-hit` 一律从这里 import。
 *  收敛前它有**四份**拷贝（`dayKeyOf` / `isoOfLocal` / `monthKey` / `cache-hit.dayOf`），
 *  四份各抄了一遍同一条"别用 `toISOString()`（UTC 会差一天）"的踩坑注释。
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  表里登记什么，查出来是什么 —— 两套词表，故意不同
 * ══════════════════════════════════════════════════════════════════════════
 *  · **表里登记的**（用户填）：`holiday` = 法定放假日、`makeup` = 调休补班日。
 *    这两个词描述的是"这天被安排成了什么"，与星期几无关 —— 国庆放假的周三写 `holiday`，
 *    被拿来补班的周六写 `makeup`。
 *  · **查出来的**（调用方用）：只有 `workday` / `rest` 两种。
 *    调用方要判的是"这天算不算上班"，不是"它为什么这么安排"。
 *    混成一套词，调用方就会写出 `kind === 'holiday' || kind === 'rest'` 这种两头堵的判据。
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  ⚠️ 没登记的日子靠星期几兜底，所以底座**不填数据也能用**
 * ══════════════════════════════════════════════════════════════════════════
 *  表里查不到时，周六周日 = `rest`、其余 = `workday`。也就是说"只在工作日提醒"这种用法
 *  **不需要任何数据**就能正确跳过周末；表只用来修正常见的两种例外：
 *  法定假日（本来是工作日却放假）与调休（本来是周末却要上班）。
 *
 *  刻意**不内置某一年的法定假日表**：那是一份每年都要人工更新、且抄错一次就静默错一整年
 *  的数据（把"调休上班的周六"漏掉，等于那天该发的提醒全被跳过）。数据由用户在
 *  `config.json` 的 `custom.holidays` 里维护，形状见 `config.example.json`。
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  "拿不准朝哪边倒"
 * ══════════════════════════════════════════════════════════════════════════
 *  ① **认不出的键 / 认不出的值 → 丢掉**（宁可少收，不可错收）。留着一个永远命中不了的键，
 *     会让"我明明登记了"变成查不出来的幽灵问题（与 `src/browse-lock.js` 的归一化同款）。
 *  ② **日期字符串解析不了 → 当 `workday`**（朝"照常"倒）。不知道这天是什么日子时，
 *     按"照常触发"处理 —— 与全局约束 §3.2 ③「判定类失败一律放行」同向：
 *     少发一条用户设的提醒，比多发一条更容易变成"它怎么不提醒我了"这种查不出来的事故。
 */

/** 表里允许登记的两种值（用户填的那套词）。 */
const HOLIDAY_KINDS = ['holiday', 'makeup'];

// 查表结果（调用方看的那套词）**只有两种**：`workday` / `rest`。
// ⚠️ 2026-10-01 清理轮：这里原先还有一个 `export const DAY_KINDS = ['workday','rest']`，
//    全仓 0 引用（只有声明行自己）—— `dayKindOf` 返回的是裸字面量，从不经过那张表。
//    也就是说那条"封闭集合"是**声明**而不是**实现**：改 `dayKindOf` 的返回值它不会跟着变，
//    而它的存在会让下一个人以为"改这里就够了"。删掉，把闭集合这件事写在注释里
//    （真正的判据在 `dayKindOf` 的两个 return 上，契约 §46 与行为层用例都在盯它）。

const ISO_DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * 解析 `YYYY-MM-DD`。认不出（含 `2026-02-30` 这种不存在的日期）一律 `null` ——
 * ⚠️ `new Date(2026, 1, 30)` 会**静默滚到 3 月 2 日**，不回读校验就会把 2 月 30 日当成合法日期。
 */
export function parseIsoDay(s) {
  const m = ISO_DAY_RE.exec(String(s == null ? '' : s).trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const probe = new Date(y, mo - 1, d);
  if (probe.getFullYear() !== y || probe.getMonth() !== mo - 1 || probe.getDate() !== d) return null;
  return { y, m: mo, d };
}

/** 两位补零（日期 / 月份键的**唯一**补齐实现，别再各处写 `padStart(2, '0')`）。 */
const pad2 = (n) => String(n).padStart(2, '0');

/** `{y,m,d}` → `YYYY-MM-DD`（补零）。 */
export function isoOf(p) {
  if (!p) return '';
  return `${p.y}-${pad2(p.m)}-${pad2(p.d)}`;
}

/**
 * 本地时间的一天 → `YYYY-MM-DD`，即"按日分桶"用的键。
 *
 * ⚠️ 用本地字段，不用 `toISOString()`（那是 UTC，会差一天）—— 差一天会让
 * "今天怎么掉了""今天发过没有"这类判断直接错位（`usage` 与面板的「今天」都按本地算）。
 *
 * **全仓唯一实现**：`trace-stats` 的分桶、缓存命中脚本的分组、面板的「今天」、
 * 提醒的日期维度都取它一份 —— 别在任何地方再拼一遍这个模板串。
 */
export function dayKeyOf(d = new Date()) {
  return isoOf({ y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate() });
}

/** 本地时间所在的月份 → `YYYY-MM`（账本按月切分用）。与 `dayKeyOf` 同源：同一套本地字段 + 同一个 `pad2`。 */
export function monthKeyOf(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
}

/** 星期几（0=周日）。日期非法时回 `1`（周一）—— 朝"照常"倒，理由同文件头 ②。 */
function weekdayOf(p) {
  const wd = new Date(p.y, p.m - 1, p.d).getDay();
  return Number.isInteger(wd) ? wd : 1;
}

/**
 * 把用户填的那张表规整成"能直接查"的形状：认不出的键与认不出的值**一律丢掉**。
 *
 * @param {unknown} raw `custom.holidays`，形如 `{ "2026-10-01": "holiday", "2026-09-29": "makeup" }`
 * @returns {Record<string, 'holiday'|'makeup'>}
 */
export function normalizeHolidays(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw)) {
    const p = parseIsoDay(k);
    if (!p) continue;
    if (!HOLIDAY_KINDS.includes(v)) continue;
    out[isoOf(p)] = v;
  }
  return out;
}

/**
 * 这天算上班还是算休息。
 *
 * 顺序是判据：**先查表，后按星期几兜底** —— 反过来（先按星期几）的话，
 * 调休上班的周六会被判成 `rest`，法定放假的周三会被判成 `workday`，表就白填了。
 *
 * @param {string} isoDay `YYYY-MM-DD`
 * @param {Record<string,string>} table 已规整的表（`normalizeHolidays` 的产物）
 * @returns {'workday'|'rest'}
 */
export function dayKindOf(isoDay, table = {}) {
  const p = parseIsoDay(isoDay);
  if (!p) return 'workday'; // 解析不了 → 照常（见文件头 ②）
  const hit = table?.[isoOf(p)];
  if (hit === 'holiday') return 'rest';
  if (hit === 'makeup') return 'workday';
  const wd = weekdayOf(p);
  return wd === 0 || wd === 6 ? 'rest' : 'workday';
}
