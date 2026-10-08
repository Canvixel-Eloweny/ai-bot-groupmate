/**
 * 插话时机：活跃期提权 + 冷场降权（D12b · 报告 E15「活跃话题 TTL + 主动发言降权」）
 * ══════════════════════════════════════════════════════════════════════════
 *  为什么单独一个文件
 * ══════════════════════════════════════════════════════════════════════════
 *  判据层不许长依赖（同 `src/usage.js` / `src/field-schema.js`）：这里是**零依赖纯函数**，
 *  谁都能 import 而不会被它拖进 IO。接线只有一处（`brain.decide` 的插话分支，
 *  契约 §41 钉着）—— 改判据不用碰提示词，也不用碰发送路径。
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  两个因子各管一半，不许合成一个
 * ══════════════════════════════════════════════════════════════════════════
 *  ① **活跃期**（提权）—— 它**刚刚在这个会话里说过话**（`lastReplyAt`）且还在 TTL 内。
 *     语义是"话题还热着"，这时候插一句＝加入正在进行的对话，概率往上抬一档。
 *     ⚠️ 读的是**既有字段** `session.lastReplyAt`，不新造 `activeUntil`：
 *        否则"活跃到什么时候"就有两份数据，过期时两边必然漂（一份数据不许维护两遍）。
 *  ② **冷场**（降权）—— **这条消息之前**群里已经沉默了很久（`lastMsgAt` 距今 ≥ 阈值）。
 *     语义是"这条是打破沉默的第一句"，此时接话最像定时脚本冒出来，概率往下压。
 *
 *  ⚠️ 两者读的是**两个不同的量**（它自己说过话 vs 别人说过话），不是同一根轴的两端。
 *     合成一个"新鲜度"就会推出"它刚自言自语 ＝ 话题热"这种错判。
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  故意不做（规格点名过，量数后判定不做）
 * ══════════════════════════════════════════════════════════════════════════
 *  · **深夜时段降权** —— 归 D31（睡眠/作息全局）。这里再做一份，"深夜"就有两个判据
 *    （本项目头号禁忌）。契约 §41 有一条反向断言守着这条边界。
 *  · **「模型判断话题结束」就退出活跃期** —— 我们没有那条信号通道：模型不会在结束轮
 *    带回"话题摘要/结束"标记，要造就得改提示词 + 加解析（碰提示词 = 高风险、另批）。
 *    所以活跃期**只靠 TTL 到期**退出 —— 与 `mutedUntil` / `quietUntil` 同一族：
 *    时间戳自己过期，不需要任何人来清状态，也就不存在"清理事件丢了就一直活跃"。
 *
 * ⚠️ 下面四个默认值全是**经验值**（对齐参考实现 20–30 分钟这个量级），
 *    不是 QQ 官方阈值，也没有真机数据支撑 —— 真机观察后再调（台账 D12b 备注）。
 */

/** 插话时机的四个可调参数（默认值 = 上面说的经验值）。 */
export const DEFAULT_INTERJECT_TUNING = {
  /** 活跃期 TTL：它说过话之后这么久之内，话题算"还热着" —— 30 分钟。 */
  activeWindowMs: 30 * 60 * 1000,
  /** 活跃期内的概率乘子（>1 = 提权）。 */
  activeBoost: 1.5,
  /** 冷场阈值：距上一条消息超过这么久，就算"打破沉默的第一句" —— 10 分钟。 */
  coldGapMs: 10 * 60 * 1000,
  /** 冷场时的概率乘子（<1 = 降权）。 */
  coldFactor: 0.4,
};

function num(v, def, lo, hi) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(hi, Math.max(lo, n));
}

/**
 * 从配置的 `trigger` 段读出四个参数并夹到合法区间。
 *
 * 缺字段回落到默认值（而不是 0）：填错一个键不该让"活跃期/冷场"整条因子**静默消失**
 * —— 那正是"改了不报错"的那一类。
 */
export function interjectTuningOf(trigger) {
  const t = trigger || {};
  const d = DEFAULT_INTERJECT_TUNING;
  return {
    activeWindowMs: num(t.interjectActiveWindowMs, d.activeWindowMs, 0, 86400000),
    activeBoost: num(t.interjectActiveBoost, d.activeBoost, 0, 10),
    coldGapMs: num(t.interjectColdGapMs, d.coldGapMs, 0, 86400000),
    coldFactor: num(t.interjectColdFactor, d.coldFactor, 0, 10),
  };
}

/**
 * 拆出这一轮的两个客观状态（不含概率，纯观察）。
 *
 * ⚠️ `coldGapMs === 0` 表示"**不知道**上一条是多久以前"（`lastMsgAt` 还是 0，
 *    典型是重启后的第一轮）—— 这种情况下 `cold` 恒为 false，即**不降权**。
 *    方向是刻意的：判定拿不到证据时按"没这回事"处理，维持原有概率；
 *    "拿不到证据就闭嘴"会让它在重启后莫名安静一阵，而没人会想到是这里。
 */
function interjectFactorsOf(session, now = Date.now(), tuning = DEFAULT_INTERJECT_TUNING) {
  const t = tuning || DEFAULT_INTERJECT_TUNING;
  const lastReplyAt = Number(session?.lastReplyAt) || 0;
  const lastMsgAt = Number(session?.lastMsgAt) || 0;

  const sinceReply = lastReplyAt > 0 ? now - lastReplyAt : 0;
  const active = lastReplyAt > 0 && sinceReply < t.activeWindowMs;
  const activeLeftMs = active ? t.activeWindowMs - sinceReply : 0;

  const coldGapMs = lastMsgAt > 0 ? Math.max(0, now - lastMsgAt) : 0;
  const cold = lastMsgAt > 0 && coldGapMs >= t.coldGapMs;

  return { active, activeLeftMs, coldGapMs, cold };
}

/**
 * 这一轮插话的**最终概率**与它的来路（供 trace 排查用）。
 *
 * 两个乘子是**相乘**不是相加：相加会在 base=0 时硬造出一个"它其实不该开口"的概率，
 * 而总闸（`allowProactive`）关着时 base 虽然不是 0、但整段根本走不到 ——
 * 相乘保证"关掉因子"（乘子=1）与"没有因子"完全同形。
 *
 * @returns {{chance:number, weight:number, base:number, active:boolean,
 *            activeLeftMs:number, coldGapMs:number, cold:boolean}}
 */
export function interjectPlanOf({ session = null, now = Date.now(), base = 0, tuning = null } = {}) {
  const t = tuning || DEFAULT_INTERJECT_TUNING;
  const f = interjectFactorsOf(session, now, t);
  const weight = (f.active ? t.activeBoost : 1) * (f.cold ? t.coldFactor : 1);
  const raw = Math.min(1, Math.max(0, Number(base) || 0));
  // 夹到 [0,1]：提权乘子大于 1 时 base 已经贴着 1，不夹就会掷出"必插话"。
  const chance = Math.min(1, Math.max(0, raw * weight));
  return { chance, weight, base: raw, ...f };
}
