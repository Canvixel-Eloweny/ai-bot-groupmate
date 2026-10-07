/**
 * 收藏表情（QQ 收藏夹里的表情）—— 判据层（D14 · 报告 E12 · 用户 Q5 翻案为「要做」）
 * ══════════════════════════════════════════════════════════════════════════
 *  先量数，再实现。2026-09-27 实测到三件事，它们直接决定了这个模块的形状：
 *
 *  ① **机器人账号自带表情早就在跑**（`FACE_PRESETS` 15 张 + 三道 golden），
 *     所以 E12 的一半根本不是缺口。**本模块只管"收藏"那一半。**
 *  ② 协议端（NapCat）的收藏表情有 5 个动作，其中**只有读的那一个本模块会用**：
 *     `fetch_custom_face` 的 `payloadSchema = { count }`、`returnSchema = Array(String)`、
 *     说明文字就是「**表情URL列表**」（实现在 `MsgApi.fetchFavEmojiList(count).emojiInfoList.map(x => x.url)`）。
 *     → **不需要 `fetch_custom_face_detail`**（那个返回完整详情对象，是给"删除/改名"用的）。
 *     这一步把原始设想简化掉了整整一次协议往返。
 *  ③ 收藏表情**没有 face id 可寻址**，只有一个图片 URL → 它只能作为**图片段**发出，
 *     与内置表情（`[face:N]`）是两条不同的出网形状，必须在同一个地方分流。
 *
 *  ══════════════════════════════════════════════════════════════════════════
 *  两条硬约束（都来自本项目已经踩过的坑）
 *  ══════════════════════════════════════════════════════════════════════════
 *  · **URL 绝不进文本、绝不落盘 / 进日志**。QQ 的图片地址常常带签名或临时 token，
 *    原样写进 `panel/local-trace.jsonl` 就等于把一次性凭据写进一个会被面板读、
 *    会被沙箱 rsync 的文件里。判据层只经手 **8 位短哈希**（复用 `src/trace-id.js`
 *    的 `imageHash`，与"图片引用只留哈希"是同一条纪律）。
 *  · **本模块是零依赖叶子**：不 import 任何东西、不碰 IO、不读时钟 ——
 *    `rng` 由调用方注入，所以"挑哪一张"能在 smoke 里被钉死。
 *    ⚠️ 唯一例外是短哈希：它是纯函数且已有唯一实现，复用优于自己再写一份。
 *
 *  ⚠️ **只读**：本模块不调用、也不导出任何写动作（`add_custom_face` /
 *     `delete_custom_face` / `set_custom_face_desc` 一个都不许出现）——
 *     用户 2026-09-27 对 Q15 的裁决是「只读，我自己去收藏」。
 *     契约里有一条反向断言盯着这件事。
 */

import { imageHash } from './trace-id.js';

/**
 * 自定义表情的标记令牌前缀。
 *
 * 为什么用令牌而不是把 URL 塞进标记：标记会进 `rec.chunks`、进会话历史、进提示词，
 * 而 URL 带签名。令牌是 URL 的 8 位短哈希，**同样能回答"这一张和那一张是不是同一张"**，
 * 却拿不到可访问的地址 —— 与 `imageRefsOf` 是同一套取舍。
 */
export const CUSTOM_FACE_TOKEN_PREFIX = 'cf-';

/** 一次拉多少张。**经验值**（与协议端默认一致，48）：够用，且不会把一次响应当成大响应体。 */
export const CUSTOM_FACE_FETCH_COUNT = 48;

/** 多久重拉一次列表。**经验值**（10 分钟）：收藏是"人手动加的"，不会秒级变化；
 *  但 URL 可能带临时签名，所以不能只拉一次就永久缓存。 */
export const CUSTOM_FACE_REFRESH_MS = 10 * 60 * 1000;

/**
 * 有收藏时，用收藏表情（而不是内置表情）的比例。**经验值**。
 *
 * 为什么不各带一个：一轮**最多一个**附加素材 —— 那是 `faceDecision` 已经定下来的闸
 * （冷却 + 概率 + 位置，三张 golden 钉着）。本模块只在它放行之后做"用哪一类"的二级选择，
 * 所以这里是一个**条件概率**（在"决定要带"的前提下），不是独立概率。
 */
const CUSTOM_FACE_SHARE = 0.5;

/** URL 列表上限（防御：协议端返回超大数组时不要把内存与后续挑选拖垮）。 */
export const CUSTOM_FACE_MAX_URLS = 200;

function isHttpUrl(u) {
  return typeof u === 'string' && /^https?:\/\//i.test(u.trim());
}

/**
 * `fetch_custom_face` 的返回值 → 干净的 URL 列表（**纯函数**）。
 *
 * 容错方向是"**宁可少用，不可用错**"：非数组 / 元素不是 URL / 重复 /
 * 数组过大，一律丢弃而不猜。拿不到就返回空数组 —— 调用方据此退化成"只用内置表情"
 * （也就是今天的现状），不会因为一次接口抖动而改变说话方式。
 *
 * @param {unknown} raw 协议端返回（`{data:[...]}` 里那一层，或直接是数组）
 * @returns {string[]}
 */
export function parseFaceUrls(raw) {
  // 兼容两种形状：直接是数组，或包在 `{ data: [...] }` 里。
  // ⚠️ 只认这两层 —— 再往深处猜（`data.data`…）就是"替协议端编结构"了。
  const list = Array.isArray(raw)
    ? raw
    : (raw && Array.isArray(raw.data) ? raw.data : null);
  if (!list) return [];
  const out = [];
  const seen = new Set();
  for (const item of list) {
    if (!isHttpUrl(item)) continue;
    const u = item.trim();
    if (seen.has(u)) continue;
    seen.add(u);
    out.push(u);
    if (out.length >= CUSTOM_FACE_MAX_URLS) break;
  }
  return out;
}

/** URL → 标记令牌（`cf-` + 8 位短哈希）。纯函数，复用 `imageHash` 这个唯一实现。 */
export function customFaceToken(url) {
  return `${CUSTOM_FACE_TOKEN_PREFIX}${imageHash(url)}`;
}

/**
 * 这个 id 是不是自定义表情令牌。**唯一判据** —— 别处不许再写 `startsWith('cf-')`：
 * 出站分流、trace 归类、契约都要问同一句话，各写一遍迟早漂。
 */
export function isCustomFaceToken(id) {
  return typeof id === 'string'
    && id.startsWith(CUSTOM_FACE_TOKEN_PREFIX)
    && /^[0-9a-f]{8}$/.test(id.slice(CUSTOM_FACE_TOKEN_PREFIX.length));
}

/**
 * URL 列表 → `{token, url}` 条目表（纯函数）。同时**去重**：同一个哈希只留一条，
 * 否则"最近用过的"会按 URL 而不是按图片来判重，同一张图换个签名就会被当成新的。
 */
export function customFaceEntries(urls) {
  if (!Array.isArray(urls)) return [];
  const seen = new Set();
  const out = [];
  for (const u of urls) {
    if (!isHttpUrl(u)) continue;
    const token = customFaceToken(u.trim());
    if (seen.has(token)) continue;
    seen.add(token);
    out.push({ token, url: u.trim() });
  }
  return out;
}

/**
 * "这一轮该不该用收藏表情"（纯函数）。
 * `has` 为假（一条收藏都没有 / 上次拉取失败且没有旧值）→ 恒假 → 退化成内置表情。
 */
export function shouldUseCustom({ has = false, rng = Math.random, share = CUSTOM_FACE_SHARE } = {}) {
  if (!has) return false;
  return Number(rng()) < share;
}

/**
 * 从条目表里挑一张：**跳过最近用过的**（与 `face-habit` 的"不连续用同一张"同一条纪律，
 * 只是这里的"用过"是跨内置/自定义统一的 —— `recentFaces` 存的就是 token）。
 * 全都被最近用过 → 返回 `null`（宁可这一轮不带，也不要连着发同一张）。
 *
 * @param {Array<{token:string,url:string}>} entries
 * @param {{recent?:string[], rng?:() => number}} o
 * @returns {{token:string,url:string}|null}
 */
export function pickCustomFace(entries, { recent = [], rng = Math.random } = {}) {
  const list = Array.isArray(entries) ? entries : [];
  if (!list.length) return null;
  const used = new Set((Array.isArray(recent) ? recent : []).map(String));
  const fresh = list.filter((e) => !used.has(e.token));
  if (!fresh.length) return null;
  const i = Math.floor(Number(rng()) * fresh.length) % fresh.length;
  return fresh[i];
}

/** 一条日志 / trace 里用的短标识：`cf-ab12cd34`（本身就是哈希，不含 URL）。 */
export function describeCustomFace(entry) {
  return entry && entry.token ? entry.token : '';
}
