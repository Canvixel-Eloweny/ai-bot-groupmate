/**
 * ══════════════════════════════════════════════════════════════════════════
 *  触发档位 ↔ 上下文条数（D9a · 报告 E23）
 * ══════════════════════════════════════════════════════════════════════════
 *  这件事解决什么
 * ──────────────────────────────────────────────────────────────────────────
 *  改造前「为什么回它」和「带多少历史」是**两件互不相干的事**：
 *    · 要不要回 —— `brain.decide()` 按「私聊 → 被 @/叫名 → 关键词 → 插话」从严到松判；
 *    · 带多少   —— `context.recentTurns` / `context.ambientMessages` 两个**全局常量**。
 *  于是「随机插话」这种最轻的接话，也和「被 @ 了」一样带着满额历史，
 *  单次成本白白高一截（报告原文：概率档只带 8 条而非 20 条，单次成本立降）。
 *
 *  改造后：**档位由 decide() 自己产出**（`decision.tier`），上下文条数按档位收窄。
 *
 *  ⚠️ 为什么档位不由 `decision.reason` 反推（一个独立的 `tierOf(reason)` 函数）
 * ──────────────────────────────────────────────────────────────────────────
 *  `reason` 是**给人看的文案**（「命中关键词「早」」这种带变量的句子），
 *  它同时被日志、面板 skip 记录、以及断言读着。拿它当判定键，就等于
 *  "一个变量两个语义" —— 文案改一个字，档位静默错档，而**没有任何断言会响**。
 *  所以档位在**产出它的那一行**就给出来（`ok(kind, reason)`），
 *  映射表只有下面 `TIER_OF_KIND` 这一份。
 *
 *  ⚠️ 零依赖叶子：本文件**不许 import 任何模块**。
 *     它被 `src/brain.js`（判定与组消息）与契约扫描器直接读。
 */

/**
 * 放行类判定的**稳定枚举**。
 *
 * 注意它**只是放行类的枚举**：拒绝（`deny_`）不给 kind —— 拒绝没有档位，
 * 拒绝的理由本身就是文案（「插话冷却中」），足够定位，不需要再挂一个身份。
 */
export const DECISION_KINDS = ['private', 'named', 'keyword', 'interject'];

/**
 * kind → 档位。**这是全项目唯一的一份映射**。
 *
 * 三档而不是四档：`private`（私聊）与 `named`（被 @ / 叫名）共用 `direct` 档 ——
 * 两者都是"明确点名"，带同样多的历史才合理（QQ-Agent 也是"私聊恒 4 档"）。
 */
export const TIER_OF_KIND = {
  private: 'direct',
  named: 'direct',
  keyword: 'keyword',
  interject: 'interject',
};

/** 全部档位。`direct` 是「不退让」的那一档，见 `contextLimitsOf`。 */
export const TIERS = ['direct', 'keyword', 'interject'];

/**
 * 每档**最多**带多少条上下文。**经验值，不是 QQ 官方阈值。**
 *
 * ── 为什么是这三组数字 ────────────────────────────────────────────────────
 *  · `direct` **故意留空**，表示"完全继承全局配置"，一个字都不改。
 *    理由：被 @ / 私聊是最高频也最要紧的一条路，它的提示词必须**逐字不变** ——
 *    否则「它说话怎么变味了」这件事**没有任何断言能发现**（本项目把这类改动
 *    单独立过纪律：会改模型实际看到的提示词的东西，先看有没有办法断言）。
 *    留空还有个附带好处：用户把 `context.recentTurns` 从 12 调到 30，direct 档跟着走，
 *    不会因为这里写死一个 12 而"改了配置没生效"。
 *  · `keyword` 只收背景（20 → 15），轮数不动 —— 命中关键词是"被叫到"，
 *    对话连续性该保；要省的是"没参与的群聊背景"那一大段。
 *  · `interject` 收得最狠（轮数 12 → 8、背景 20 → 8）：随机插话是唯一
 *    "没人叫它"的路径，代价与风险都最低，省在这里最划算。
 *
 * ⚠️ 这些值是**相对全局上限的收窄**，不是绝对值 —— 见 `contextLimitsOf`。
 */
export const TIER_SHRINK = {
  direct: {},
  keyword: { ambientMessages: 15 },
  interject: { recentTurns: 8, ambientMessages: 8 },
};

/**
 * 算出这一档**实际**能用多少上下文。
 *
 * ⚠️ 取 `min`，**只能压紧、不能放宽** —— 与 `antiFloodChunks`（`min(它, reply.maxChunks)`）
 *    是同一个先例。若直接覆盖，用户把 `context.ambientMessages` 调成 5（从简）
 *    反而会被插话档"放宽"到 8，那就成了"我调小了它却带得更多"。
 *
 * @param {string} tier 档位（未知档按 `direct` 处理 —— 宁可多带也不许丢防线）
 * @param {{recentTurns:number, ambientMessages:number}} base 全局配置里的那两份数字
 */
export function contextLimitsOf(tier, base) {
  const cap = TIER_SHRINK[tier] || TIER_SHRINK.direct;
  return {
    recentTurns: Math.min(base.recentTurns, cap.recentTurns ?? Infinity),
    ambientMessages: Math.min(base.ambientMessages, cap.ambientMessages ?? Infinity),
  };
}

/**
 * 判定结果的档位。拒绝（`respond:false`）回 `null` —— 没有档位这回事。
 *
 * 放在这里而不是塞进 `ok()` 里现算，是为了让"未知 kind"当场暴露：
 * 新增一个放行 kind 却忘了登记 `TIER_OF_KIND`，这里会回 `undefined`
 * （而不是静默当成 direct），契约里有一条专门盯它。
 */
export function tierOfKind(kind) {
  return Object.prototype.hasOwnProperty.call(TIER_OF_KIND, kind) ? TIER_OF_KIND[kind] : undefined;
}
