/**
 * 出站节奏（B8 · S-GAP）：让「连着发几条」看起来像人在打字，而不是机器在批量推送。
 *
 * 为什么值得单独一个模块：节奏以前是 `config.reply.sendDelayMs` 一个固定值，
 * 两处发送循环各写一遍 `await sleep(cfg.reply.sendDelayMs)`。固定 700ms 意味着
 * 「发三条」永远是 700 + 700 —— 人不会这么整齐，这是最容易被一眼看出来的机器特征之一。
 *
 * ⚠️ 下面的数字是**经验值 / 参考实现的默认值，不是 QQ 官方阈值**。
 *    QQ 从未公开过发送频率上限，本项目也明令禁止编造官方风控数字。
 *    它们只是"让它别那么整齐"的默认值，允许在 `config.json` 的
 *    `reply.pace` 段里改（见 README / 升级计划 §10 Q6）。
 */

/** 默认节奏（经验值）：每条之间随机 1–3 秒，再按字数附加 20ms/字 */
export const PACE_DEFAULTS = Object.freeze({
  enabled: true,
  minMs: 1000,
  maxMs: 3000,
  perCharMs: 20,
});

/** 只接受非负整数，其余一律回落 —— 配置里填了 `"abc"` / `-5` 不该变成 NaN 延迟 */
function posInt(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : fallback;
}

/**
 * 算出「这一条发完之后该停多久」。
 *
 * **纯函数**，`rng` 可注入 —— 这是它能被断言钉死区间的前提（否则只能靠碰运气，
 * 而"跑十次都通过"不等于"一直会通过"）。全项目只有这一处算延迟：
 * 机器人主链路（`handleMessage`）与主动路径（`sayToGroup`）共用它，
 * 两处各写一遍的话，迟早出现"主动消息还是那个整齐的 700ms"。
 *
 * 下限**不为 0**：0 延迟等于连着刷屏，那正是要避免的东西。
 * 想回到旧行为（固定值）就在 config 里把 `reply.pace.enabled` 设成 false。
 *
 * @param {string} text      刚发出去那一条的正文（按字数附加延迟）
 * @param {object} [reply]   `config.reply` 段
 * @param {() => number} [rng] 随机源，默认 Math.random
 * @returns {number} 毫秒
 */
export function sendDelayFor(text, reply = {}, rng = Math.random) {
  const pace = reply?.pace || {};
  const legacy = posInt(reply?.sendDelayMs, 0);

  // 显式关掉节奏 → 回落旧行为（sendDelayMs 固定值）。
  // 老配置的语义因此一字不变，切过来的人不会觉得"我什么都没改它怎么变了"。
  if (pace.enabled === false) return legacy;

  const minMs = posInt(pace.minMs, PACE_DEFAULTS.minMs);
  const maxMs = Math.max(minMs, posInt(pace.maxMs, PACE_DEFAULTS.maxMs));
  const perCharMs = posInt(pace.perCharMs, PACE_DEFAULTS.perCharMs);

  // rng 越界（有人塞了 1 或 -0.5）也不该算出区间外的值，先夹到 [0,1]
  const r = Math.min(1, Math.max(0, Number(rng()) || 0));
  const jitter = minMs + Math.round(r * (maxMs - minMs));

  // ⚠️ `sendDelayMs` 是**下限**，不是被绕过的旧字段。
  // 本项目对同类问题（`config.js` 里 throttle.minIntervalMs 与界面冷却时间）的既有约定
  // 就是"取两者的大值，而不是覆盖" —— 用户在配置里写下的数字，不该被代码里的默认值
  // 悄悄压掉。反过来，节奏也不会比用户设的那条底线更快。
  return Math.max(legacy, jitter) + String(text ?? '').length * perCharMs;
}
