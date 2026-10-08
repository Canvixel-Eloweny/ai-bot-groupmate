/**
 * ══════════════════════════════════════════════════════════════════════
 *  表情标记与出站分段（H-10 第 22 轮 · 从 `src/brain.js` 整块搬出）
 * ══════════════════════════════════════════════════════════════════════
 *  为什么单独立一个模块：`brain.js` 是巨型文件，而这一整族（标记的**形态定义**、
 *  拆段、分类、整轮图片上限）与 `Brain` 类**没有任何关系** —— 它们只吃字符串，
 *  产出的东西被 `src/index.js` 的发送循环消费。混在类文件里的后果是：改一个
 *  表情正则要先在 1200 行里找到它。
 *
 *  ⚠️ **唯一依赖**：`./custom-faces.js`（它自己是零依赖叶子，只复用
 *     `./trace-id.js` 的短哈希）。方向是「本模块 → 叶子」，不会成环。
 *     `brain.js` 与 `index.js` 都会引这里，所以**不许**再引任何重型模块。
 *
 *  ⚠️ 搬家纪律同 `src/reply-text.js` 的文件头：实现只在新家一份，`brain.js`
 *     只 `import` 再**原样转出**；判据的取源**改指这里**，不是复制一份。
 */

import { isCustomFaceToken } from './custom-faces.js';

/**
 * 「文本里的表情标记」的**唯一**形态定义（D14 起含自定义表情令牌）。
 *
 *   · 内置表情：`[face:14]` —— 1–3 位数字（QQ 的 face id）
 *   · 自定义表情（收藏）：`[face:cf-ab12cd34]` —— 令牌 = 该图 URL 的 8 位短哈希
 *     （**故意不放 URL**：QQ 图片地址常带签名，落进 trace / 历史 / 提示词就是泄漏）
 *
 * ⚠️ 不许在别处再写一份这个正则。目前问这句话的有三处，必须同源：
 *   ① 出站拆段（`splitFaceMarks`）② 贴纸关闭时的清理（`parseReply`）
 *   ③ "模型自己插过没有"（`src/index.js`）。各写一遍迟早漂 —— 漂的表现是
 *   `[face:cf-…]` 被当成普通文字发进群里，而那一条会被所有人看见。
 */
export const FACE_MARK_SRC = '\\[face:(\\d{1,3}|cf-[0-9a-f]{8})\\]';

/** 每次现造一个正则：`/g` 对象带 `lastIndex`，共享它会让调用顺序影响结果。 */
export function faceMarkRe() {
  return new RegExp(FACE_MARK_SRC, 'g');
}

/** 这段文字里有没有表情标记（含自定义令牌）。 */
export function hasFaceMark(text) {
  return faceMarkRe().test(String(text ?? ''));
}

/** 去掉全部表情标记（贴纸关着时用：别把 `[face:14]` 原样发到群里）。 */
export function stripFaceMarks(text) {
  return String(text ?? '').replace(faceMarkRe(), '').trim();
}

/**
 * 把一段文本拆成「文字段 + 表情段」，供发送层拼 OneBot 消息段。
 * 例 '哈哈哈[face:14]笑死' → [{text:'哈哈哈'}, {face:'14'}, {text:'笑死'}]
 * 自定义令牌同样产出 `{type:'face', id:'cf-…'}`，由 `classifySegments` 再分流成图片。
 */
export function splitFaceMarks(text) {
  const out = [];
  const re = faceMarkRe();
  let last = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push({ type: 'text', text: text.slice(last, m.index) });
    out.push({ type: 'face', id: m[1] });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ type: 'text', text: text.slice(last) });
  return out.filter((s) => (s.type !== 'text' ? true : s.text.trim().length > 0));
}

/**
 * 一段文本 → **段描述**（纯函数，不出网）：文字 / 内置表情 / 收藏表情（图片）三态。
 *
 * 为什么把"分类"从发送循环里抽出来：它有两个**判据**（令牌认不认、
 * 认不出的怎么办），而原来的写法把它们埋在 `index.js` 的 `map(...)` 里 ——
 * 那是没有任何断言碰得到的位置（本项目对"接线藏在闭包里"有过专门的教训）。
 * 抽出来之后，`index.js` 只剩"把三态换成三个 Segment 构造器"这一件事。
 *
 * ⚠️ **认不出的令牌一律丢掉**（fail-closed），绝不退回当文字发：
 * 退回发的是 `[face:cf-…]` 这串字面量，群里所有人都会看到它。
 *
 * @param {string} text
 * @param {(token:string) => (string|undefined)} lookup 令牌 → 图片 URL（本轮内存表）
 * @returns {Array<{type:'text',text:string}|{type:'face',id:string}|{type:'image',url:string}>}
 */
export function classifySegments(text, lookup) {
  const get = typeof lookup === 'function' ? lookup : () => undefined;
  return splitFaceMarks(text)
    .map((s) => {
      if (s.type !== 'face') return { type: 'text', text: s.text };
      if (!isCustomFaceToken(s.id)) return { type: 'face', id: s.id };
      const url = get(s.id);
      return url ? { type: 'image', url } : null;
    })
    .filter(Boolean);
}

/**
 * 一整轮回复里最多发几张**图片**（收藏表情走的就是图片段）。**经验值**。
 *
 * 取 2 的理由：图片段**不是文字**，多张图连着发出去在群里的观感是"刷屏"，
 * 而正常聊天里"一句话带两三个表情"已经到顶。取 1 太紧（一条回复里前后各一个表情
 * 是常见写法），取 3 以上就已经不是聊天的密度了。
 *
 * ⚠️ 这个数字**不进面板**（`src/field-schema.js` 只收"会显示给用户的数字"）——
 *    本轮不加控件，所以它是导出常量而不是配置项（E23 的先例：不加控件就别硬声明）。
 *
 * ⚠️ 在这之前，一轮能发几张图**没有任何上限**：模型只要把同一个令牌写几遍，
 *    同一张图就会被发出去几次（`classifySegments` 每命中一次就产出一个图片段）。
 *    另外**去重**与**张数**是两件事，都做：同一张图重复出现不该算两张。
 */
export const IMAGE_CAP_PER_RUN = 2;

/**
 * 出站媒体护栏：把这一轮的消息段裁到"图片不超过 `max` 张、且同一张只发一次"。
 *
 * 纯函数（不碰 IO、不改入参）—— `used` / `seen` 由调用方按**整轮**累积后回传，
 * 所以"一轮"这个口径不在本函数里猜（它在 `index.js` 的发送循环里，跨分段）。
 *
 * ⚠️ 裁掉是 **fail-closed（丢掉）**，不是"换成文字发出去"：
 *    把认不出的 / 超额的令牌退回成 `[face:cf-…]` 字面量，群里所有人都会看到那串字。
 *
 * @param {Array<{type:string}>} parts `classifySegments` 的产物（或它的一部分）
 * @param {{max?:number, used?:number, seen?:string[]}} [state]
 *   `used` 本轮已经发掉的图片张数；`seen` 本轮已经用过的 URL（≤ max 个，所以很小）
 * @returns {{parts:Array, used:number, seen:string[], dropped:number}}
 */
export function capImageSegments(parts, { max = IMAGE_CAP_PER_RUN, used = 0, seen = [] } = {}) {
  const cap = Number.isFinite(max) && max >= 0 ? Math.floor(max) : IMAGE_CAP_PER_RUN;
  const base = Number.isFinite(used) && used > 0 ? Math.floor(used) : 0;
  const keys = Array.isArray(seen) ? seen.map(String) : [];
  const already = new Set(keys);
  const kept = [];
  const added = [];
  let dropped = 0;
  for (const p of Array.isArray(parts) ? parts : []) {
    if (!p || p.type !== 'image') {
      kept.push(p);
      continue;
    }
    const key = String(p.url ?? '');
    if (already.has(key) || base + added.length >= cap) {
      dropped += 1;
      continue;
    }
    already.add(key);
    added.push(key);
    kept.push(p);
  }
  return { parts: kept, used: base + added.length, seen: [...keys, ...added], dropped };
}
