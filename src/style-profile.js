/**
 * ══════════════════════════════════════════════════════════════════════
 *  说话风格画像（ATI-2）—— 纯本地统计，**零模型调用**
 * ══════════════════════════════════════════════════════════════════════
 *  要解决的问题：接话的**分量**跟对方对不上 —— 对方只说了三个字，它回一长段；
 *  对方一直在问，它一直只陈述。这类"不自然"不是语气问题，是**没看见对方**。
 *
 *  为什么做成纯本地统计而不是让模型判断：
 *    · 统计这件事模型并不擅长，而且每轮判断一次要花钱；
 *    · 数字是**确定性**的，能写进断言 —— 这是它能进回归测试的前提。
 *  所以这一整个模块**不产生任何模型调用**（本项目对"新增热路径调用"的既有约束）。
 *
 *  ⚠️ 依赖方向：只 import node: 内置与 `atomic-write`（后者也只依赖 node: 内置）。
 *    所以提示词侧（brain）与采集侧（index）都能引它，不会成环。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeJsonAtomic } from './atomic-write.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 落盘位置。`QQBOT_STYLE_PROFILE` 与 `QQBOT_AUTO_MEMORY_FILE` 同款：让测试指去临时目录。
 * ⚠️ 它是**模块加载期定型**的常量（本项目既有约定）—— 运行时改 env 无效，
 *    测试要走"带 query 的动态 import"，别在这里动歪脑筋。
 */
const STYLE_FILE = process.env.QQBOT_STYLE_PROFILE
  ? path.resolve(process.env.QQBOT_STYLE_PROFILE)
  : path.join(ROOT, 'panel', 'style-profile.json');

/** 只统计 ≤60 字的消息：长文里切出来的片段没有意义 */
const MSG_MAX = 60;
/** 口头禅滑窗长度（参考材料的做法：2~4 字） */
const GRAM_SIZES = Object.freeze([2, 3, 4]);
/** 每人最多保留多少个口头禅候选（封住"无上限膨胀"这个口子） */
const GRAM_KEEP = 24;
/** 候选至少出现几次才敢拿去用（低于这个值只是噪声） */
const GRAM_MIN = 3;
/** 几个样本以下不做定性描述（"话很短""爱提问"这种结论，三句话下不了） */
const MIN_FOR_QUALITY = 5;
/** 夜猫子时段 [0, 6) */
const NIGHT_START = 0;
const NIGHT_END = 6;

/**
 * 停用词：太常见的组合，记下来没有信息量。
 * 匹配方式 = **完全相等**（一个 gram 等于某个停用词才丢）；
 * 不去"包含即丢" —— 那会把大量正常短语一起误杀，代价大于收益。
 */
const STOPWORDS = Object.freeze(new Set([
  '我的', '你的', '他的', '我们', '你们', '他们', '这个', '那个', '什么', '怎么', '为什么',
  '可以', '不能', '不要', '没有', '就是', '不是', '还是', '但是', '然后', '因为', '所以',
  '如果', '已经', '现在', '自己', '知道', '觉得', '时候', '这样', '那样', '真的', '而且',
  '于是', '其实', '应该', '不会', '还有', '一个', '一下', '一点', '一直', '有些', '有些些',
]));

/** 一份空档案 */
export function newProfile() {
  return { n: 0, chars: 0, q: 0, face: 0, night: 0, grams: {} };
}

/**
 * 累积一条消息。**纯函数**：不改入参，返回新档案。
 *
 * @param {object} prev 已有档案（可空）
 * @param {{text:string, hour?:number, hasFace?:boolean}} msg
 * @returns {object}
 */
export function observe(prev, msg) {
  const base = { ...newProfile(), ...(prev || {}) };
  const text = String(msg?.text ?? '').trim();
  // 空消息不计；长文不计（只统计 ≤60 字的短消息）
  if (!text || text.length > MSG_MAX) return base;

  const next = { ...base, grams: { ...base.grams } };
  next.n += 1;
  next.chars += text.length;
  if (/[?？]/.test(text)) next.q += 1;
  if (msg?.hasFace) next.face += 1;
  const hour = Number.isFinite(msg?.hour) ? Number(msg.hour) : null;
  if (hour !== null && hour >= NIGHT_START && hour < NIGHT_END) next.night += 1;

  const clean = text.replace(/\s+/g, '').toLowerCase();
  for (const size of GRAM_SIZES) {
    for (let i = 0; i + size <= clean.length; i += 1) {
      const g = clean.slice(i, i + size);
      if (STOPWORDS.has(g)) continue;
      next.grams[g] = (next.grams[g] || 0) + 1;
    }
  }
  // 只留前 GRAM_KEEP 个：否则一个话痨能把这个文件撑到几 MB
  next.grams = Object.fromEntries(
    Object.entries(next.grams).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, GRAM_KEEP)
  );
  return next;
}

/**
 * 口头禅候选（已过滤停用词与**屏蔽词**）。**纯函数**。
 *
 * 屏蔽词的匹配 = **双向包含、不分大小写**（参考材料的做法）：
 * 写「懒得」会把「懒得理你」这种更长的候选一起挡掉 —— 长词（英文名 / 昵称）
 * 被滑窗切成没意义的碎片，只能靠整词屏蔽。
 *
 * @param {object} profile
 * @param {string[]} blockWords 手动屏蔽词
 * @returns {string[]} 按次数降序
 */
export function topPhrases(profile, blockWords = []) {
  const blocks = (Array.isArray(blockWords) ? blockWords : [])
    .map((s) => String(s ?? '').trim().toLowerCase())
    .filter(Boolean);
  return Object.entries(profile?.grams || {})
    .filter(([, c]) => c >= GRAM_MIN)
    .filter(([g]) => !blocks.some((b) => g.includes(b) || b.includes(g)))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([g]) => g);
}

/**
 * 生成写进提示词的那一行。**样本不够就只给数字、不给结论** ——
 * 三句话就下"TA 话很短"这种断语，是拿噪声当判断（也是本模块最容易说谎的地方）。
 *
 * @param {object} profile
 * @param {{blockWords?:string[]}} opts
 * @returns {string} 空串 = 不注入（没档案时提示词**一个字都不多**）
 */
export function profileLine(profile, opts = {}) {
  const p = profile || {};
  const n = Number(p.n) || 0;
  if (!n) return '';
  const avg = Math.round((Number(p.chars) || 0) / n);
  const pct = (v) => Math.round(((Number(v) || 0) / n) * 100);
  const bits = [`TA 说了 ${n} 句，平均 ${avg} 字`];
  if (n >= MIN_FOR_QUALITY) {
    if (avg <= 10) bits.push('话很短');
    else if (avg >= 30) bits.push('话偏长');
    if (pct(p.q) >= 25) bits.push('爱提问');
    if (pct(p.face) >= 25) bits.push('常带表情');
    if (pct(p.night) >= 30) bits.push('夜猫子');
  }
  const top = topPhrases(p, opts.blockWords);
  if (top.length) bits.push(`口头禅 ${top.slice(0, 2).map((t) => `「${t}」`).join('')}`);
  return bits.join('；');
}

/**
 * 生成"跟你说话的这个人"那一行。**纯函数**（store 由入参给，便于断言）。
 * 空档案 → 空串 → 提示词一个字都不多（对陌生人不凭空编画像）。
 *
 * @param {{chatKey?:string, userId?:string|number}} who
 * @param {object} store 由 `readProfiles()` 得到的存档
 * @param {{blockWords?:string[]}} opts
 */
export function speakerLine(who, store, opts = {}) {
  const key = profileKey(who?.chatKey, who?.userId);
  if (!key) return '';
  const p = store?.p?.[key];
  return profileLine(p, opts);
}

/** 存档键：`会话:QQ号`。风格**按群各算各的**（他在 A 群话痨，不代表 B 群也是） */
function profileKey(chatKey, userId) {
  const c = String(chatKey ?? '').trim();
  const u = String(userId ?? '').trim();
  if (!c || !u) return '';
  return `${c}:${u}`;
}

/** 读档。文件坏了 / 不存在 = 还没有任何人被统计过，不是错误 */
export function readProfiles() {
  try {
    const raw = JSON.parse(fs.readFileSync(STYLE_FILE, 'utf8'));
    if (!raw || typeof raw !== 'object' || !raw.p || typeof raw.p !== 'object') return { v: 1, p: {} };
    return raw;
  } catch {
    return { v: 1, p: {} };
  }
}

/** 写档（走项目唯一的原子写入口，不自己 writeFileSync） */
function writeProfiles(store) {
  writeJsonAtomic(STYLE_FILE, store);
}

// ── 采集侧的防抖写盘 ──────────────────────────────────────────────────────
// 群里刷消息时每条都写一次盘没必要；攒 30 秒写一次，最多丢这 30 秒的统计
// （统计丢一点无所谓，它不是事实数据）。与会话存档的防抖同一个思路。
const FLUSH_MS = 30000;
let pending = null;
let timer = null;

/**
 * 记一条并安排落盘。由 `src/index.js` 调用（唯一采集点）。
 * @param {{chatKey:string, userId:string|number, text:string, hour?:number, hasFace?:boolean}} m
 * @param {{now?:number}} [opts]
 */
export function observeAndStore(m, opts = {}) {
  const key = profileKey(m?.chatKey, m?.userId);
  if (!key) return;
  if (!pending) pending = readProfiles();
  const prev = pending.p[key] || {};
  const next = observe(prev, { text: m.text, hour: m.hour, hasFace: m.hasFace });
  // 长消息 / 空消息不会改变档案 —— 那就别安排一次无意义的写盘
  if (next === prev || next.n === prev.n) return;
  pending.p[key] = next;
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    const snapshot = pending;
    pending = null;
    try {
      writeProfiles(snapshot);
    } catch {
      /* 记不下来也绝不能影响正常回复 */
    }
  }, FLUSH_MS);
  if (typeof timer.unref === 'function') timer.unref();
}

/** 立刻落盘（进程退出前 / 测试里用） */
export function flushProfiles() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (!pending) return;
  const snapshot = pending;
  pending = null;
  writeProfiles(snapshot);
}
