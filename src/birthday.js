/**
 * 生日彩蛋（2026-10-25 · 人设域六页合并）
 * ══════════════════════════════════════════════════════════════════════════
 *  只做两件事：
 *    ① 生日（月 / 日）+ 参考周岁 → 生肖与星座（**纯娱乐**，不改人设）；
 *    ② 生成最多两行的提示词点缀，默认关。
 *
 *  零依赖叶子：`custom-config.js` 用它做归一化，面板与 brain 用它取同一份
 *  文案 —— 三处不允许各写一份星座表（改一次要改三处，必有一处腐烂）。
 *
 *  ⚠️ 生肖**只展示、不注入**。它按"当前日期 + 参考周岁"反推出生年份，
 *     误差一年就会换生肖；拿这种东西去影响说话，属于编造事实。
 */

export const ZODIAC_ANIMALS = ['鼠', '牛', '虎', '兔', '龙', '蛇', '马', '羊', '猴', '鸡', '狗', '猪'];

// 本地年月日的拆解只许在 holidays.js（H-11①）。这里 import 那一份，不再自己写 getMonth()。
import { localDateParts } from './holidays.js';

/** 星座边界（含首尾）。跨年的摩羯放在第一条，`inSign()` 分两段判断。 */
export const STAR_SIGNS = [
  { name: '摩羯座', glyph: '♑', start: [12, 22], end: [1, 19], range: '12.22 – 01.19', trait: '克制、务实' },
  { name: '水瓶座', glyph: '♒', start: [1, 20], end: [2, 18], range: '01.20 – 02.18', trait: '独立、抽离' },
  { name: '双鱼座', glyph: '♓', start: [2, 19], end: [3, 20], range: '02.19 – 03.20', trait: '共情、心软' },
  { name: '白羊座', glyph: '♈', start: [3, 21], end: [4, 19], range: '03.21 – 04.19', trait: '直率、先行动' },
  { name: '金牛座', glyph: '♉', start: [4, 20], end: [5, 20], range: '04.20 – 05.20', trait: '稳、慢热' },
  { name: '双子座', glyph: '♊', start: [5, 21], end: [6, 21], range: '05.21 – 06.21', trait: '好奇、跳脱' },
  { name: '巨蟹座', glyph: '♋', start: [6, 22], end: [7, 22], range: '06.22 – 07.22', trait: '念旧、护短' },
  { name: '狮子座', glyph: '♌', start: [7, 23], end: [8, 22], range: '07.23 – 08.22', trait: '坦荡、要面子' },
  { name: '处女座', glyph: '♍', start: [8, 23], end: [9, 22], range: '08.23 – 09.22', trait: '细致、讲秩序' },
  { name: '天秤座', glyph: '♎', start: [9, 23], end: [10, 23], range: '09.23 – 10.23', trait: '求平衡、讲体面' },
  { name: '天蝎座', glyph: '♏', start: [10, 24], end: [11, 22], range: '10.24 – 11.22', trait: '专注、戒备' },
  { name: '射手座', glyph: '♐', start: [11, 23], end: [12, 21], range: '11.23 – 12.21', trait: '爱自由、直白' },
];

/** 每月的最大日数。2 月按 29 算 —— 这里只做输入钳制，不需要年份闰年判断。 */
function maxDayForMonth(month) {
  return [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][Number(month) - 1] || 31;
}

const intOr = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : fallback;
};

/**
 * 配置里的 `custom.birthday` → 确定形状。
 * `month = 0` / `day = 0` = 没填（面板显示"待填写"），不复用 1 月 1 日。
 */
export function normalizeBirthday(raw) {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const age = Math.max(0, Math.min(120, intOr(r.age, 0)));
  const monthRaw = intOr(r.month, 0);
  const month = monthRaw >= 1 && monthRaw <= 12 ? monthRaw : 0;
  const dayRaw = intOr(r.day, 0);
  const day = month ? Math.max(0, Math.min(maxDayForMonth(month), dayRaw)) : 0;
  return { age, month, day };
}

function birthdayParts(birthday) {
  const b = normalizeBirthday(birthday);
  if (!b.month || !b.day) return null;
  return { month: b.month, day: b.day };
}

/** 按"今年生日过没过"反推参考出生年。只用于生肖展示。 */
function inferredBirthYear(age, month, day, now = Date.now()) {
  const today = localDateParts(new Date(now));
  return today.y - age - ((today.m < month || (today.m === month && today.d < day)) ? 1 : 0);
}

function chineseZodiac(year) {
  if (!Number.isFinite(Number(year))) return '';
  return ZODIAC_ANIMALS[((Number(year) - 4) % 12 + 12) % 12];
}

function inSign(month, day, sign) {
  const [sm, sd] = sign.start;
  const [em, ed] = sign.end;
  if (sm <= em) {
    return (month > sm || (month === sm && day >= sd))
      && (month < em || (month === em && day <= ed));
  }
  return (month > sm || (month === sm && day >= sd))
    || (month < em || (month === em && day <= ed));
}

function starSign(month, day) {
  const m = intOr(month, 0);
  const d = intOr(day, 0);
  if (!m || !d) return null;
  return STAR_SIGNS.find((sign) => inSign(m, d, sign)) || null;
}

/** 面板用的派生信息（生肖 / 星座 / 是否注入）。 */
export function birthdayInfoOf(custom, now = Date.now()) {
  const b = normalizeBirthday(custom?.birthday);
  const parts = birthdayParts(b);
  const age = b.age || 0;
  const year = parts && age ? inferredBirthYear(age, parts.month, parts.day, now) : null;
  const animal = year ? chineseZodiac(year) : '';
  const sign = parts ? starSign(parts.month, parts.day) : null;
  const on = custom?.astroOn === true;
  return {
    age: b.age,
    month: b.month,
    day: b.day,
    year,
    animal,
    sign: sign ? { ...sign, start: sign.start.slice(), end: sign.end.slice() } : null,
    on,
    // 面板算"今年生日过没过"要用今天；把这份本地日期一起下发，前端就不必自己拆 Date
    // （拆了就是 H-11① 的第二份实现）。
    today: localDateParts(new Date(now)),
  };
}

/**
 * 写进提示词的两行点缀。默认关；没填完整也返回空。
 * ⚠️ 只提星座的色彩，**不提生日日期本身**：后者更像在写资料卡，且模型容易主动说
 *    "我记得你生日是…" —— 而它并没有真的记住任何东西。
 */
export function astroPromptLines(custom) {
  if (custom?.astroOn !== true) return [];
  const parts = birthdayParts(custom?.birthday);
  if (!parts) return [];
  const sign = starSign(parts.month, parts.day);
  if (!sign) return [];
  return [
    '## 生日彩蛋（权重最低，只作点缀）',
    `星座：${sign.name}。只让表达带一点「${sign.trait}」的色彩，不改变人物设定、关系和判断；不要主动提起生日或星座。`,
  ];
}
