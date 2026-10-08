/**
 * 请求体文本卫生（第 56 轮 F1-3 · E5 第三项）。
 *
 * ══════════════════════════════════════════════════════════════════════
 *  它防的是哪一种 400
 * ══════════════════════════════════════════════════════════════════════
 * JS 的字符串是 UTF-16 码元序列，非 BMP 字符（emoji、罕见汉字）占**两个**码元
 * （一对代理项）。凡是**按码元切片**的地方，都可能正好切在一对代理项中间，
 * 于是留下**半个字符**（孤立代理项）。它不会让 `JSON.stringify` 报错 ——
 * 它会安静地序列化成 `"\ud83d"` 这样的**孤立转义**，而严格的解析器（服务端的
 * JSON 解析器就是）会因此整条请求 400。
 *
 * 本项目**真的存在**这类切片点（实测，不是推测）：
 *   · `memory-record.js` 注入提示词的那一行 `.slice(0, LINE_MAX)`
 *   · `custom-config.js` 的 `str(v, max)`（人格 / 技能文本）
 *   · `tool-loop.js` 工具结果超长时的 `.slice(0, TOOL_RESULT_MAX)`
 *   · `memory.js` 自动记忆字段截断
 * 反例构造（第 56 轮实测）：`('前缀文字🙂后缀').slice(0, 5)` → 孤立代理项 1 个，
 * `JSON.stringify` 输出 `"前缀文字\ud83d"`。
 *
 * ⚠️ **如实标注：这是预防性的**。第 56 轮在真机 `panel/local-trace.jsonl` 上量过：
 *    6 条带 prompt 的记录里孤立代理项 **0 个**、会产出孤立转义的 **0 条**。
 *    也就是说"大概率永远不会发生"——但真发生时它的表现是**整条请求 400**，
 *    而且归因很难（错误正文只说 JSON 非法，不会告诉你是哪半个字符）。
 *    成本是几行纯函数 + 一次线性扫描，收益是把这一类 400 从"可能发生"变成"不可能"。
 *
 * ⚠️ 零依赖叶子：不 import 任何东西，便于 smoke 直接喂反例。
 */

/** 高位代理项 / 低位代理项的码元区间。 */
const HI = 0xd800;
const HI_END = 0xdbff;
const LO = 0xdc00;
const LO_END = 0xdfff;

/**
 * 去掉**孤立**代理项，保留成对的（合法的非 BMP 字符一个都不动）。
 *
 * ⚠️ 不能简单地用 `/[\\uD800-\\uDFFF]/g` 删 —— 那会把 emoji 一起删掉，
 * 而 emoji 是这个机器人日常说话的一部分（表情、群昵称里到处都是）。
 * 判据必须是**配对**：高代理项后面紧跟低代理项才留。
 *
 * @param {string} text
 * @returns {string}
 */
export function stripLoneSurrogates(text) {
  const s = String(text ?? '');
  // 快路径：绝大多数请求里一个代理项都没有，先扫一遍避免无谓地重建字符串。
  // （不用正则：`u` 标志下的字符类会按**码点**匹配，反而看不出"孤立"这件事。）
  let hasAny = false;
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c >= HI && c <= LO_END) { hasAny = true; break; }
  }
  if (!hasAny) return s;

  let out = '';
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c >= HI && c <= HI_END) {
      const d = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (d >= LO && d <= LO_END) {
        out += s[i] + s[i + 1];
        i += 1;
      }
      // 后面不是低代理项 → 这是被切出来的半个字符，丢掉
      continue;
    }
    if (c >= LO && c <= LO_END) continue; // 孤立的低代理项，丢掉
    out += s[i];
  }
  return out;
}

/** 文本里有没有孤立代理项（探针；smoke 与契约用它判定"清干净了"）。 */
export function hasLoneSurrogate(text) {
  const s = String(text ?? '');
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c >= HI && c <= HI_END) {
      const d = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (!(d >= LO && d <= LO_END)) return true;
      i += 1;
    } else if (c >= LO && c <= LO_END) return true;
  }
  return false;
}

/**
 * 深拷贝式清理：遍历任意 JSON 形状，把**每一个字符串**过一遍 `stripLoneSurrogates`。
 *
 * 为什么要"整份请求体"而不是只清 messages：
 *   · 只清 messages 会漏掉 `tools` 里的描述与枚举（那里也可能有外来文本）；
 *   · 而且"下一个写入 body 的字段"没人会记得也清一遍 —— 那正是本项目反复在清的
 *     那一类（加了新东西忘了同步）。深遍历是一次性的、与字段名无关。
 *
 * 语义保证：**只删孤立代理项，其余一个字节不动**（成对代理项、结构、键序全保留）。
 * 因此它可以被安全地挂在"发出去之前的最后一步"——那一处的输入输出差异只有这一类字符。
 *
 * @template T
 * @param {T} value
 * @returns {T}
 */
export function sanitizeDeep(value) {
  if (typeof value === 'string') return stripLoneSurrogates(value);
  if (Array.isArray(value)) return value.map((v) => sanitizeDeep(v));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = sanitizeDeep(v);
    return out;
  }
  return value;
}

/**
 * 自检：这份东西能不能被 JSON 安全地序列化（不产生孤立 `\uD8xx` 转义）。
 *
 * 用它做"发出去之前的最后一道断言"：清理过之后必须为 true。
 * 判据刻意**不**去解析 JSON 字符串（那要写一个小解析器），
 * 而是直接对**结构**再扫一遍 —— 两者等价，且更短。
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isJsonSafe(value) {
  if (typeof value === 'string') return !hasLoneSurrogate(value);
  if (Array.isArray(value)) return value.every((v) => isJsonSafe(v));
  if (value && typeof value === 'object') return Object.values(value).every((v) => isJsonSafe(v));
  return true;
}
