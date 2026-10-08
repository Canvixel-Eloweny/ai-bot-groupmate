/**
 * ══════════════════════════════════════════════════════════════════════
 *  「会显示给用户的数字」的声明表 —— 默认值 / 上下限的唯一真相源
 * ══════════════════════════════════════════════════════════════════════
 *  为什么需要它（第 42 轮 B12b · SCHEMA-LITE，开工前实测）：
 *  同一个数字曾经分散在**四种载体**里各写一遍 ——
 *    ① 后端默认值   `CUSTOM_DEFAULTS.trigger.proactive.intervalMin = 90`
 *    ② 后端校验边界 `num(c.trigger.proactive.intervalMin, 90, 5, 1440)`
 *    ③ 界面提示文字 `06-wb-reply.html` 的「只保留底层的 1.5 秒防抖」
 *    ④ 前端兜底 / `<input min max>` 属性 `num('wbProactiveMin', 90)`
 *  它们漂移的后果**不是报错，而是界面撒谎**：把防抖从 1500 改成 2000，
 *  校验、兜底、提示三处都不会跟着变，用户看到的是三个自相矛盾的说法。
 *
 *  ⚠️ 这套表**不是**通用 schema 引擎，只收「有数字、且会被界面显示出来」的字段。
 *      `ENHANCE` / `SCENES` 那类纯文本表的默认值本来就只有一处
 *      （`custom-config.js` 由键名派生，第 42 轮实测）—— 把它们"schema 化"
 *      属于**在没有第二个消费者时提前通用化**，本批明确不做。
 *
 *  ⚠️ 零依赖。`src/config.js` 与 `src/custom-config.js` 都要 import 它，
 *     它自己**不许 import 任何模块** —— 否则会出现 config ⇄ custom-config 的循环。
 *
 *  ⚠️ 这里放的是**经验值，不是 QQ 官方阈值**。标了就写清：
 *      取太短 → 白跑模型调用；取太长 → 它装死。理由见各自的注释。
 */

/**
 * 数值字段声明。
 *
 * 键名是**语义键**（不是 DOM id，也不是 config.json 的路径）——
 * 因为同一个语义值可能出现在两个配置段（例如「防抖」住在 `throttle`，
 * 而提示它的是「回复设置」那一屏），键名跟着**语义**走才不会两处各起一个名。
 *
 *  @param default 缺省值（config.json 没写这一段时用它）
 *  @param min/max 合法区间。**校验与界面的 `min` / `max` 属性共用这两个数字**
 *  @param shownAs 'sec' 表示界面上以**秒**呈现（由 `uiNumbers()` 换算，换算只此一处）
 */
export const NUM_FIELDS = {
  /**
   * 出站防抖下限（ms）。
   * ⚠️ 经验值，不是 QQ 官方阈值 —— 它只防"同一条消息触发两轮回复"这类偶发重复。
   * 面板上「连续回复的最小间隔」填 0 时，生效的就是这个值。
   */
  minIntervalMs: { default: 1500, min: 0, shownAs: 'sec' },

  /** 工作台「连续回复的最小间隔」（秒）。0 = 用底层防抖，所以 min 是 0 */
  cooldownSec: { default: 0, min: 0, max: 600 },

  /** 定时主动说话的间隔（分钟） */
  proactiveIntervalMin: { default: 90, min: 5, max: 1440 },

  /** 免打扰时段起点（小时）。24 小时制，所以上下限是 0–23 */
  quietFrom: { default: 23, min: 0, max: 23 },

  /** 免打扰时段终点（小时）。from === to 表示不启用静默 */
  quietTo: { default: 8, min: 0, max: 23 },

  /**
   * 开了「防刷屏」之后，每条回复最多发几段。
   * 生效值是 `min(这个值, reply.maxChunks)` —— 它只能压紧、不能放宽，
   * 所以这里不声明 max。
   */
  antiFloodChunks: { default: 2, min: 1 },
};

/**
 * 取一个字段声明。
 *
 * 键名写错时**当场抛**而不是回 `undefined` —— 后者会让 `default` 变成 `undefined`、
 * 一路静默带到配置里（这正是本项目反复踩的"改了不报错、只是悄悄失效"）。
 */
export function numField(key) {
  const f = NUM_FIELDS[key];
  if (!f) throw new Error(`field-schema: 未声明的数值字段「${key}」—— 请先在 NUM_FIELDS 里登记`);
  return f;
}

/** 默认值（消费方写 `asInt(raw.x, numDefault('cooldownSec'))`） */
export function numDefault(key) {
  return numField(key).default;
}

/** 合法区间 `[min, max]`；没声明 max 时返回 `[min, Infinity]` */
export function numBounds(key) {
  const f = numField(key);
  return [f.min, f.max ?? Infinity];
}

/**
 * 把配置里的原始值夹进声明区间；缺省或非法时用声明的默认值。
 *
 * `parse` 可选：不传用 `Number()`（和 `custom-config.js` 的局部 `num()` 同语义），
 * 传 `asInt` 这类**按需解析**的函数就与 `config.js` 原有的解析保持一致
 * （`parseInt('12px')` 是 12，而 `Number('12px')` 是 NaN —— 不能混）。
 *
 * ⚠️ 声明在 `NUM_FIELDS` 里的字段一律走这里；**没声明**的（例如 `custom.version`）
 *    继续用各文件自己的局部校验函数。两套并存是刻意的：这套只管"会显示给用户的数字"。
 */
export function numOr(key, raw, parse) {
  const f = numField(key);
  const n = parse ? parse(raw, NaN) : Number(raw);
  if (!Number.isFinite(n)) return f.default;
  return Math.min(f.max ?? Infinity, Math.max(f.min, n));
}

/**
 * 下发给面板的数字（`/api/state` 的 `customMeta.fieldMeta.numbers`）。
 *
 * `shownAs: 'sec'` 的字段额外给一个 `<键名>Sec` —— **单位换算只此一处**。
 * 页面里那句「只保留底层的 1.5 秒防抖」读的就是它，而不是自己拿 1500 去除 1000
 * （后者会把"1500 这个数是毫秒"这件事变成前端的第二份知识）。
 */
export function uiNumbers() {
  const out = {};
  for (const [k, f] of Object.entries(NUM_FIELDS)) {
    out[k] = f.default;
    if (f.shownAs === 'sec') out[`${k}Sec`] = f.default / 1000;
  }
  return out;
}

/** 下发给面板的区间表（用来填 `<input min max>`，前端不再手抄一遍） */
export function uiBounds() {
  const out = {};
  for (const [k, f] of Object.entries(NUM_FIELDS)) {
    if (f.max === undefined) continue;
    out[k] = [f.min, f.max];
  }
  return out;
}

/** `/api/state` 里 `customMeta.fieldMeta` 的整份形状 */
export function fieldMeta() {
  return { numbers: uiNumbers(), bounds: uiBounds() };
}
