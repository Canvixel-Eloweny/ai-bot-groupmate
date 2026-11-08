/**
 * 消息通道选择（官方机器人 / NapCat）的**唯一判据**（2026-11-06 · 官方通道接入）。
 *
 * 为什么单独一个零依赖叶子：
 *   这件事同时被**机器人**（起哪条连接）、**面板**（显示哪套控件、写哪份配置）
 *   和**测试**（要能钉住"旧配置升级不该被默认官方打断"）读。判据写第二份，
 *   就会出现"面板说在用官方、机器人其实连着 NapCat"这种两边各自自洽的状态。
 *
 * ⚠️ 本文件**不许 import 任何东西**（连 logger 都不行）：面板侧要过 §82 的
 *    lib→src 准入，判据是"传递闭包不触达 llm/brain/onebot/index/config/logger"。
 *    所以这里只返回**结论与来源**，"要不要告诉用户"由调用方决定。
 */

/** 两条通道的合法值。加第三条时只改这里。 */
export const CHANNEL_MODES = Object.freeze(['official', 'napcat']);

/** 面板与日志用的短标签（中文文案只有一份，不在 schema.js 再抄一遍）。 */
export const CHANNEL_LABELS = Object.freeze({
  official: 'QQ 官方机器人',
  napcat: 'NapCat（OneBot v11）',
});

/**
 * 全新安装（只有 `config.example.json`）的默认通道。
 *
 * 维护者 2026-11-06 先指定"默认走官方通道"，同日改口：**默认仍是 NapCat**，
 * 官方机器人由用户自己到「运行 → 切换协议端」里选。理由很实际 ——
 * 官方通道要 AppID/AppSecret（还得去开放平台建应用），把它设成默认，
 * 新装的第一眼就是"缺凭据、不说话"；而 NapCat 装上就能聊。
 * 与 `LEGACY_CHANNEL_MODE` 同值不是冗余：那两档说的是**不同的事**
 * （新装 vs 已装升级），将来任意一边单独改，另一边的语义不许跟着漂。
 */
export const DEFAULT_CHANNEL_MODE = 'napcat';

/**
 * 旧配置（`config.json` 存在但没有 `channel` 键）的回落通道。
 *
 * ⚠️ 这一条不是"保守"，是**防事故**：老用户升级后如果直接被切成官方通道，
 *    他们没有 AppID/AppSecret，机器人会从"照常聊天"变成"一条都不收"，
 *    而表现是"我没动它，它怎么哑了"。默认值只该作用于**新装**，不该改写**已装**。
 */
export const LEGACY_CHANNEL_MODE = 'napcat';

/** 环境变量覆盖（测试与运维用）：`QQBOT_CHANNEL=official|napcat`。 */
export const CHANNEL_ENV = 'QQBOT_CHANNEL';

/** 归一化单个值；不认识的一律空串（由调用方决定回落成什么，这里不猜）。 */
export function normalizeChannelMode(value) {
  const v = String(value ?? '').trim().toLowerCase();
  return CHANNEL_MODES.includes(v) ? v : '';
}

/**
 * 决定本次用哪条通道。**优先级从高到低**，`source` 把结论的出处一起交出去：
 *
 *   env          `QQBOT_CHANNEL` 显式覆盖（沙箱/测试/多实例）
 *   config       配置里写了合法值
 *   example      没写、且读的是 `config.example.json` ⇒ 新装默认官方
 *   legacy       没写、读的是真 `config.json` ⇒ 老配置按 NapCat 继续跑
 *
 * @param {{configured?:unknown, usedExample?:boolean, env?:Record<string,string|undefined>}} input
 * @returns {{mode:string, source:'env'|'config'|'example'|'legacy', ignoredEnv:string}}
 */
export function resolveChannelMode({ configured, usedExample = false, env = process.env } = {}) {
  const fromEnv = normalizeChannelMode(env?.[CHANNEL_ENV]);
  // 环境变量写了但不认识：不静默改掉它 —— 那会把"我明明设了 napcat"变成没人知道的默认值。
  const ignoredEnv = String(env?.[CHANNEL_ENV] ?? '').trim() && !fromEnv
    ? String(env[CHANNEL_ENV]).trim() : '';
  const fromConfig = normalizeChannelMode(configured);
  if (fromEnv) return { mode: fromEnv, source: 'env', ignoredEnv };
  if (fromConfig) return { mode: fromConfig, source: 'config', ignoredEnv };
  return {
    mode: usedExample ? DEFAULT_CHANNEL_MODE : LEGACY_CHANNEL_MODE,
    source: usedExample ? 'example' : 'legacy',
    ignoredEnv,
  };
}

/**
 * 这条通道**现在能不能连**。
 *
 * 判据只有一条：官方通道要 AppID + AppSecret 两个都在。
 * 不做"缺凭据就自动回落 NapCat" —— 那等于替用户换了一条他没说过的出口，
 * 而官方/NapCat 的身份体系完全不同（openid vs QQ 号），回落出去的每一条回复
 * 都可能落在错误的那批人身上。缺凭据就**明说缺凭据**。
 */
export function channelIsConfigured(mode, official) {
  if (mode !== 'official') return true;
  const appId = String(official?.appId ?? '').trim();
  const appSecret = String(official?.appSecret ?? '').trim();
  return Boolean(appId && appSecret);
}

/** 待配置时给用户的一句人话（文案只有一份，面板与日志共用，不各写一遍）。 */
export const CHANNEL_SETUP_HINT = '官方通道还缺 AppID / AppSecret：到 QQ 开放平台建机器人应用后，'
  + '在「运行 → 切换协议端」里填进来并重启机器人。想先用 NapCat 就把通道切成 NapCat。';
