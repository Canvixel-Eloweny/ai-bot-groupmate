/**
 * 本体情绪（项目内建，2026-10-25）
 * ══════════════════════════════════════════════════════════════════════════
 *  这份能力原先由 `plugins/本体情绪` 提供；插件目录整体删除后，
 *  面板还在读 `data/bot-state.json`，于是页面显示「缺少插件」。
 *  现在把它收回项目本体：**不装任何插件也必须工作**。
 *
 *  分工：
 *    · 本文件管状态形状、每轮增减、提示词文本、雷达派生；
 *    · `src/index.js` 只在三个真实时刻接线（入站 / 拼提示词 / 本轮结束）；
 *    · 面板只读同一份 `data/bot-state.json`，不伪造任何数字。
 *
 *  两条纪律：
 *    ① 默认状态是**中性基线**，不是演示数据。没有事件就不假装有事件。
 *    ② 文本只在这里生成一份 —— 面板预览与模型收到的必须是同一段话。
 */

import fs from 'node:fs';
import path from 'node:path';
// 直接引 user-root 而不是 config.js：面板也要读这份状态，
// config.js 会把机器人后端注册表一起拖进启动路径（§82 的传递闭包门会拦）。
import { DATA_DIR } from './user-root.js';
import { writeJsonAtomic } from './atomic-write.js';
import { EMO_GROUPS, EMOTION_KEYS } from './emotion-keys.js';

/**
 * 状态文件路径。**在调用时读 env**，不在模块加载期算死：
 * smoke 会在本进程里跑 Brain，若这里固定成加载期的真实 DATA_DIR，
 * 测试就会读到用户真机的 bot-state.json（结果随本机状态漂）。
 */
function emotionFile() {
  const env = String(process.env.QQBOT_DATA_DIR || '').trim();
  return env ? path.join(path.isAbsolute(env) ? env : DATA_DIR, 'bot-state.json') : path.join(DATA_DIR, 'bot-state.json');
}
const EMOTION_BASELINE = Object.freeze({
  mood: 60,
  arousal: 45,
  acuteStress: 20,
  chronicStress: 2,
  energy: Object.freeze({ physical: 65, cognitive: 65, emotional: 60, will: 60 }),
});
const ENERGY_KEYS = ['physical', 'cognitive', 'emotional', 'will'];
const TREND_MAX = 48;
const TREND_MIN_MS = 10 * 60 * 1000;
const EMO_LABEL = Object.fromEntries(EMO_GROUPS.flatMap((g) => g.items));

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const numOr = (v, def) => (Number.isFinite(Number(v)) ? Number(v) : def);
const round1 = (n) => Math.round(n * 10) / 10;

function defaultEmotions() {
  return Object.fromEntries(EMOTION_KEYS.map((k) => [k, 0]));
}

/** 面板/提示词共用的心情档位。与原型 `moodLabel()` 一致。 */
function moodLabelOf(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  if (v >= 75) return '轻快';
  if (v >= 60) return '平静偏暖';
  if (v >= 45) return '平稳';
  return '低落';
}

function normalizeEvent(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const note = String(raw.note || '').trim().slice(0, 160);
  if (!note) return null;
  return {
    kind: String(raw.kind || '状态变化').slice(0, 40),
    note,
    chatKey: String(raw.chatKey || '').slice(0, 60),
    at: numOr(raw.at, 0),
  };
}

/** 把磁盘上/内存里的任意形状收成一份完整状态。缺字段回落中性基线。 */
function normalizeEmotionState(raw, now = Date.now()) {
  const d = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const energyRaw = d.energy && typeof d.energy === 'object' ? d.energy : {};
  const energy = {};
  for (const k of ENERGY_KEYS) {
    energy[k] = clamp(numOr(energyRaw[k], EMOTION_BASELINE.energy[k]), 0, 100);
  }
  const emoRaw = d.emotions && typeof d.emotions === 'object' && !Array.isArray(d.emotions) ? d.emotions : {};
  const emotions = defaultEmotions();
  for (const k of EMOTION_KEYS) emotions[k] = clamp(numOr(emoRaw[k], 0), 0, 100);
  const trend = (Array.isArray(d.trend) ? d.trend : [])
    .map((v) => numOr(v, null))
    .filter((v) => v !== null)
    .map((v) => Math.round(clamp(v, 0, 100)))
    .slice(-TREND_MAX);
  const state = {
    version: 1,
    mood: Math.round(clamp(numOr(d.mood, EMOTION_BASELINE.mood), 0, 100)),
    arousal: Math.round(clamp(numOr(d.arousal, EMOTION_BASELINE.arousal), 0, 100)),
    acuteStress: Math.round(clamp(numOr(d.acuteStress, EMOTION_BASELINE.acuteStress), 0, 100)),
    chronicStress: Math.round(clamp(numOr(d.chronicStress, EMOTION_BASELINE.chronicStress), 0, 100) * 10) / 10,
    energy,
    emotions,
    intent: String(d.intent || '').slice(0, 160),
    trend,
    trendAt: numOr(d.trendAt, 0),
    lastEvent: normalizeEvent(d.lastEvent),
    updatedAt: numOr(d.updatedAt, 0),
  };
  state.radar = deriveRadar(state);
  if (!state.trend.length) state.trend = [state.mood];
  if (!state.trendAt) state.trendAt = now;
  if (!state.updatedAt) state.updatedAt = now;
  return state;
}

/** 读状态。文件不存在/坏了都返回 null —— 页面据此显示"还没建立"。 */
export function readEmotionState(file = emotionFile()) {
  try {
    const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    return normalizeEmotionState(JSON.parse(text), Date.now());
  } catch {
    return null;
  }
}

export function saveEmotionState(state, file = emotionFile()) {
  const next = normalizeEmotionState(state, Date.now());
  writeJsonAtomic(file, next, { mode: 0o600 });
  return next;
}

/** 启动时建立中性基线：只建一次，绝不覆盖已有状态。 */
export function ensureEmotionState({ file = emotionFile(), now = Date.now() } = {}) {
  const current = readEmotionState(file);
  if (current) return current;
  return saveEmotionState(normalizeEmotionState({
    intent: '先听着。',
    updatedAt: now,
    trendAt: now,
    trend: [EMOTION_BASELINE.mood],
  }, now), file);
}

function groupTotals(emotions) {
  const out = { positive: 0, negative: 0, neutral: 0 };
  for (const g of EMO_GROUPS) {
    const key = g.label === '正向' ? 'positive' : g.label === '负向' ? 'negative' : 'neutral';
    out[key] = g.items.reduce((n, [k]) => n + (Number(emotions?.[k]) || 0), 0);
  }
  return out;
}

/**
 * 五维雷达。原型里它是插件写好的字段；现在从真实状态派生，
 * 公式固定在这里，面板不再自己算第二份。
 */
function deriveRadar(state) {
  const s = normalizeForMath(state);
  const t = groupTotals(s.emotions);
  const total = t.positive + t.negative;
  const balance = total ? (t.positive - t.negative) / total : 0;
  const negShare = total ? t.negative / total : 0;
  const v = (n) => Math.round(clamp(n, 0, 100));
  return {
    warmth: v(50 + (s.mood - 50) * 0.6 + balance * 20),
    initiative: v(s.arousal * 0.6 + s.energy.will * 0.4),
    sensitivity: v(s.energy.emotional * 0.5 + (100 - s.acuteStress) * 0.2 + negShare * 20),
    stability: v(100 - s.acuteStress * 0.9 - s.chronicStress * 3),
    expressiveness: v(s.arousal * 0.7 + s.energy.will * 0.15 + (s.emotions.hype || 0) * 0.15),
  };
}

function normalizeForMath(state) {
  const energy = state?.energy && typeof state.energy === 'object' ? state.energy : {};
  const emotions = state?.emotions && typeof state.emotions === 'object' ? state.emotions : {};
  return {
    mood: numOr(state?.mood, EMOTION_BASELINE.mood),
    arousal: numOr(state?.arousal, EMOTION_BASELINE.arousal),
    acuteStress: numOr(state?.acuteStress, EMOTION_BASELINE.acuteStress),
    chronicStress: numOr(state?.chronicStress, EMOTION_BASELINE.chronicStress),
    energy: Object.fromEntries(ENERGY_KEYS.map((k) => [k, numOr(energy[k], EMOTION_BASELINE.energy[k])])),
    emotions,
  };
}

const HINTS = [
  { kind: '挑衅', patterns: ['举报', '封号', '找死', '威胁'], mood: -5, stress: 8, emo: { fear: 8, anxiety: 7 }, arousal: 6, note: '有人放了一句狠话。' },
  { kind: '被怼', patterns: ['笨', '傻', '滚', '讨厌', '闭嘴', '垃圾', '废物', '蠢', '恶心'], mood: -4, stress: 5, emo: { irk: 9, anger: 4, sadness: 2 }, arousal: 5, note: '有人怼了它一句。' },
  { kind: '被夸', patterns: ['厉害', '真棒', '好棒', '可爱', '喜欢你', '爱你', '聪明', '优秀', '漂亮', '帅', '太强', '牛', '666'], mood: 4, stress: -2, emo: { joy: 6, gratitude: 5, pride: 3 }, arousal: 3, note: '有人夸了它一句。' },
  { kind: '示好', patterns: ['抱抱', '摸摸', '亲亲', '贴贴', '想你', '在吗'], mood: 3, stress: -2, emo: { gratitude: 4, joy: 4, hope: 2 }, arousal: 2, note: '有人朝它示好。' },
  { kind: '道歉', patterns: ['对不起', '抱歉', '不好意思'], mood: 2, stress: -3, emo: { gratitude: 2 }, arousal: -1, note: '有人道了歉。' },
];

/**
 * 从一条入站消息里读出情绪暗示。只处理**对着它说**的消息
 * （私聊或被点名）；群里旁人的闲聊不该让它的心情漂。
 */
export function emotionOnIncoming(state, { text = '', atMe = false, chatKey = '', now = Date.now() } = {}) {
  if (!atMe) return { state, changed: false };
  const src = String(text || '');
  const hit = HINTS.find((h) => h.patterns.some((p) => src.includes(p)));
  if (!hit) return { state, changed: false };
  const base = normalizeEmotionState(state, now);
  const next = normalizeEmotionState({
    ...base,
    mood: base.mood + hit.mood,
    arousal: base.arousal + hit.arousal,
    acuteStress: base.acuteStress + hit.stress,
    emotions: Object.fromEntries(EMOTION_KEYS.map((k) => [k, (base.emotions[k] || 0) + (hit.emo[k] || 0)])),
    intent: hit.mood >= 0 ? '刚被好好接住，语气会软一点。' : '被刺了一下，先收着点。',
    lastEvent: { kind: hit.kind, note: hit.note, chatKey, at: now },
    updatedAt: now,
  }, now);
  return { state: next, changed: true };
}

const OUTCOME_TEXT = {
  error: { kind: '调用失败', note: '刚才那轮模型出错了，状态跟着沉了一下。' },
  quiet: { kind: '没接上', note: '想接一句，最后没发出去。' },
  burst: { kind: '连着说', note: '一口气说了好几句。' },
  reply: { kind: '正常回复', note: '顺着刚才的话题接住了。' },
};

/**
 * 一轮结束时按结果微调。**中止不算失败**（用户点了停止，不该掉精力）。
 * 每轮都有轻微回落：心情/精力会慢慢回到基线，不会永远停在峰值。
 */
export function emotionOnResponse(state, {
  sentCount = 0, error = '', toolErrors = 0, aborted = false, chatKey = '', now = Date.now(),
} = {}) {
  if (aborted) return { state, changed: false };
  const s = normalizeEmotionState(state, now);
  let dm = 0; let da = 0; let ds = 0; let de = 0; let intent = '';
  const emo = { ...s.emotions };
  let event = null;

  if (error) {
    dm -= 5; da += 5; ds += 10; de -= 8;
    emo.irk = (emo.irk || 0) + 9;
    emo.anxiety = (emo.anxiety || 0) + 6;
    intent = '刚才那轮出了点问题，先缓一下。';
    event = OUTCOME_TEXT.error;
  } else if (!sentCount) {
    dm -= 1; da -= 1; de -= 1;
    emo.loneliness = (emo.loneliness || 0) + 2;
    intent = '没找到合适的话，先安静一会儿。';
    event = OUTCOME_TEXT.quiet;
  } else {
    dm += 0.6; da += sentCount >= 3 ? 5 : 1; de -= sentCount >= 3 ? 2 : 0.5;
    if (sentCount >= 3) {
      emo.hype = (emo.hype || 0) + 4;
      intent = '刚说了一串，歇一口气。';
      event = OUTCOME_TEXT.burst;
    } else {
      emo.joy = (emo.joy || 0) + 1;
      intent = '顺着刚才的话题。';
      event = OUTCOME_TEXT.reply;
    }
  }
  if (toolErrors > 0) {
    de -= Math.min(6, toolErrors * 2);
    emo.irk = (emo.irk || 0) + Math.min(8, toolErrors * 3);
  }

  const nextEnergy = {};
  for (const k of ENERGY_KEYS) nextEnergy[k] = s.energy[k] + (EMOTION_BASELINE.energy[k] - s.energy[k]) * 0.04 + (k === 'emotional' ? de : (k === 'will' ? de * 0.5 : 0));
  const nextEmotions = Object.fromEntries(EMOTION_KEYS.map((k) => [k, Math.round((emo[k] || 0) * 0.94)]));
  const trend = s.trend.slice();
  let trendAt = s.trendAt;
  if (!trend.length || now - s.trendAt >= TREND_MIN_MS) {
    trend.push(Math.round(clamp(s.mood + dm, 0, 100)));
    trendAt = now;
    if (trend.length > TREND_MAX) trend.splice(0, trend.length - TREND_MAX);
  }
  const next = normalizeEmotionState({
    ...s,
    mood: s.mood + (EMOTION_BASELINE.mood - s.mood) * 0.02 + dm,
    arousal: s.arousal + (EMOTION_BASELINE.arousal - s.arousal) * 0.05 + da,
    acuteStress: Math.max(0, s.acuteStress * 0.9 + ds),
    chronicStress: Math.max(0, s.chronicStress * 0.98 + (error ? 0.8 : 0)),
    energy: nextEnergy,
    emotions: nextEmotions,
    intent,
    trend,
    trendAt,
    lastEvent: event ? { ...event, chatKey, at: now } : s.lastEvent,
    updatedAt: now,
  }, now);
  return { state: next, changed: true };
}

/** 模型真正收到的状态段。面板预览也读这里 —— 只有一份文本实现。 */
export function moodPromptLines(state) {
  if (!state) return [];
  const s = normalizeEmotionState(state, Date.now());
  const top = EMOTION_KEYS
    .map((k) => [k, s.emotions[k] || 0])
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([k, v]) => `${EMO_LABEL[k] || k} ${v}`)
    .join('、');
  return [
    '## 此刻的状态（只影响这一轮的语气）',
    `此刻：心情 ${s.mood}/100（${moodLabelOf(s.mood)}），唤醒度 ${s.arousal}，急性压力 ${s.acuteStress}，慢性压力 ${round1(s.chronicStress)}。`,
    `精力：身体 ${s.energy.physical} / 认知 ${s.energy.cognitive} / 情绪 ${s.energy.emotional} / 意志 ${s.energy.will}。`,
    `主导情绪：${top || '没有明显情绪'}。`,
    `意图：${s.intent || '先听着。'}`,
  ];
}
