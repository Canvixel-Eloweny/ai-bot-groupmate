// 出口闸门的规则表只在 src/egress.js 一份（唯一入口表）。这里只做**消费**：
// 主动路径与主链路用的是同一批规则，不在这里另写任何"什么不该发"的判据。
import { scanEgress } from './egress.js';
// B33：内部标记的判据与主链路**同一个叶子**（外壳/词干/旧措辞都在那儿，各写一份必然漂）。
import { scanInternalMarks, stripInternalMarks } from './internal-marks.js';

/**
 * 花费触顶（D8 的 `degrade` 档）时主动路径的停工理由。
 *
 * ⚠️ 它**只挡主动发言**，不挡被 @ / 私聊的回复 —— 这是刻意的，也是用户裁决
 *    （2026-09-26）选的那一档："只降档不哑掉"。
 *    理由与 `llm.js` 里那条既有先例一致：**宁可多花一次等待，也不能让机器人
 *    在群里彻底哑掉**（不认识的人被 @ 了没人理，比多花一点 token 糟得多）。
 */
export const PROACTIVE_BUDGET_REASON = '今日花费已达上限，本轮不主动开口';

/**
 * 主动出站的配额计划（B8 · S-PROACTIVE）。
 *
 * 抽成独立模块的原因不是"更优雅"，而是修一个具体的洞：**主动路径以前完全绕过限流**。
 * 定时消息到点就发，跟"群里是不是刚回过话"毫无关系 —— 用户视角就是
 * "它突然自己冒出来三条"。而主链路的限流判据写在 `brain.throttleReason()` 里，
 * 两处各判一次，迟早不一致（这个项目已经有 `providerOf` 三份拷贝的前车之鉴）。
 *
 * 所以这里是**唯一一处**决定"这一轮哪些群可以开口"的地方：主链路与主动路径
 * 共用调用方注入的同一个 `throttle` 判据。
 *
 * 纯函数：不碰 IO、不读时钟、不改状态 —— 因此可以被断言钉死
 * （"有配额的发、超配额的不发"，不需要真的等到某个时刻）。
 *
 * @param {object} p
 * @param {Array<string|number>} p.groups  允许开口的群
 * @param {(g: any) => object} p.sessionOf 取某个群的会话
 * @param {(s: object) => (string|null)} p.throttle 配额判据，返回原因字符串表示不许发
 * @param {'ok'|'trim'|'degrade'} [p.budgetLevel] 花费档位（D8）。判据在
 *        `src/usage.js` 的唯一一处 `usageLevelOf()`，这里只做**消费**。
 * @returns {Array<{group: string, send: boolean, reason: string}>}
 */
export function planProactiveSend({ groups = [], sessionOf, throttle, budgetLevel = 'ok' }) {
  const out = [];
  // 花费档位**先判**：它是全局的（日额度），与"这个群刚才回过话没有"无关。
  // 顺序反了不会有正确性问题，但会让日志里的理由指向错误的原因
  // （"静默期还没过" vs "今天花超了"，排障时是两条完全不同的线）。
  const budgetWhy = budgetLevel === 'degrade' ? PROACTIVE_BUDGET_REASON : '';
  for (const g of groups) {
    if (!g) continue; // 配置里可能留了空串，跳过而不是发到 "undefined"
    const why = budgetWhy || throttle(sessionOf(g));
    out.push({ group: String(g), send: !why, reason: why ? String(why) : '' });
  }
  return out;
}

/**
 * 主动/定时消息的**分句 + 出口闸门判定**（第 49 轮复审补充 · 纯函数）。
 *
 * 为什么存在：出口闸门规则在 `src/egress.js`、消费判据在 `brain.parseReply`，都是纯函数、
 * 各有断言钉着；唯独主动路径的**接线**（sayToGroup 要不要拦、拦了怎么办）原本藏在
 * `main()` 的闭包里 —— 没有任何行为断言能碰到它，删掉三行闸门后
 * 静态全绿、回归全绿、凭据重新开始外泄，没有门会响（复审报告点名的正是这一条）。
 *
 * 按「纯函数 + 一处接线」的惯例把**判定**抽出来（smoke T134 直接断言行为），
 * `sayToGroup` 是它**唯一的接线点**（check-wb 契约钉住接线不被摘掉）。
 *
 * 分句规则与旧实现逐字一致：按 `||` 或空行拆、去空白、去空段、封顶 maxChunks；
 * 闸门口径与 `brain.parseReply` 一致：**整条不发**（blocked 非空），不是丢一段留一段。
 *
 * B33 追加：同一条链路也是"模型复读内部标记"的**第二个出口**（定时文案是用户填的，
 * 但主动话题是模型生成的）。口径与主链路逐字一致 —— **剥掉标记、其余照发**，
 * 命中词干回传给调用方去留痕。凭据那一类照旧整条不发，两者刻意不混。
 *
 * @param {string} text 用户填的定时文案，或模型生成的主动话题
 * @param {{maxChunks?:number}} o
 * @returns {{chunks:string[], blocked:string|null, internal:string[]}} blocked 为出口闸门命中的规则名
 */
export function plannedProactiveChunks(text, { maxChunks = 5 } = {}) {
  const raw = String(text)
    .split(/\|\||\n+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, maxChunks);
  // B33：先剥标记再判闸门 —— 顺序与 `brain.parseReply` 一致（剥完的文本才是"真要发的"）
  const internalRaw = [];
  const chunks = raw
    .map((s) => {
      // 与 `brain.parseReply` 逐字同一条判据：**真的剥掉了**才算一次复读
      // （扫到宽词干但一字未改的那种，是正常中文里撞了词，不该记进日志）
      const cleaned = stripInternalMarks(s);
      if (cleaned === s) return s;
      internalRaw.push(...scanInternalMarks(s));
      return cleaned;
    })
    .filter(Boolean);
  return { chunks, blocked: scanEgress(chunks.join('\n')), internal: [...new Set(internalRaw)] };
}
