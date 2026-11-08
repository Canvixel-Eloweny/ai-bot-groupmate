/**
 * 官方通道存活判定（零依赖纯函数，2026-11-06）。
 *
 * 为什么不复用 `src/onebot-liveness.js` 的阶梯：那条阶梯的第一层判据是
 * "面板能不能连上 3000/3001 这两个端口"。官方通道**根本没有端口**（它是出站到
 * api.bot.qq.com 的客户端），把那条阶梯原样套上去会得到两种假象：
 *   · 端口全不通 ⇒ 判 `down` —— 而机器人其实连得好好的；
 *   · 或者反过来，为了让它变绿而把端口探活"当成通" —— 那就是把判据本身写坏了。
 * 所以这里换一套观测面：**机器人自己看到的连接状态 + 最后一次入站帧 + 鉴权结果**。
 *
 * 阶梯（命中即返回）：
 *   unconfigured（没填凭据）→ terminal（下架/封禁，重试没有意义）
 *   → auth-failed（鉴权失败）→ connecting（在连/在重连）
 *   → account-offline（连上过但账号态不在线）→ stalled（帧停摆）
 *   → online。
 *
 * ⚠️ 与 onebot-liveness 同一条纪律：**这里只出结论，不出"健康/不健康"的措辞**，
 *    措辞由面板转述；两处各判一次必然漂移。
 *
 * 本文件有两个出口：`officialVerdictOf`（存活阶梯）与 `officialPanelView`
 * （面板 `state.channel` 那一份投影）。它们都是纯函数、零 IO；
 * 唯一 import 是 `channel-mode.js`（值域与"配齐了没有"的同一份判据），
 * 所以按 check-wb §82 的口径，闭包规模 = 2 个模块。
 */

import { CHANNEL_LABELS, channelIsConfigured } from './channel-mode.js';

/** 官方事件流停摆阈值：至少 120 秒（官方心跳 45 秒一次，两拍半没东西才是真死了）。 */
function staleMsOf(health, fallback = 120_000) {
  const iv = Number(health?.heartbeatIntervalMs);
  const base = Number.isFinite(iv) && iv > 0 ? Math.max(120_000, iv * 3) : fallback;
  return Number.isFinite(base) && base > 0 ? base : 120_000;
}

/**
 * @param {{health?:object, now?:number, staleMs?:number}} input health = 机器人 effective 快照
 * @returns {{code:string, detail:string, staleMs?:number}}
 */
export function officialVerdictOf({ health = null, now = Date.now(), staleMs = null } = {}) {
  if (!health || typeof health !== 'object') {
    return { code: 'no-snapshot', detail: '机器人还没有写出官方通道快照（没启动，或还在启动中）' };
  }
  if (health.configured === false) {
    return { code: 'unconfigured', detail: '缺 AppID / AppSecret，通道没有启动' };
  }
  if (Number(health.gateway?.terminalCode) > 0) {
    return {
      code: 'terminal',
      detail: `机器人被平台下架或封禁（${health.gateway.terminalReason || '网关终止码'}）—— 重试没有意义`,
    };
  }
  if (health.lastErrorCode === 'official_auth' || health.lastErrorCode === 'channel_unconfigured') {
    return { code: 'auth-failed', detail: `鉴权没通过：${health.lastError || health.lastErrorCode}` };
  }
  if (health.connected !== true) {
    return { code: 'connecting', detail: health.lastDropReason || '还没连上事件网关' };
  }
  if (health.botOffline === true) {
    return { code: 'account-offline', detail: '机器人账号状态不在线（连接在，但平台侧不认）' };
  }
  const last = Math.max(Number(health.lastFrameAt) || 0, Number(health.connectedAt) || 0);
  const limit = staleMs == null ? staleMsOf(health) : staleMs;
  if (last > 0 && now - last > limit) {
    return { code: 'stalled', detail: `事件流停摆 ${Math.round((now - last) / 1000)} 秒`, staleMs: limit };
  }
  return { code: 'online', detail: '' };
}

/**
 * 官方通道在面板上的那一份投影（`state.channel`）—— 2026-11-06 从
 * `panel/lib/state-collector.js` 的内联对象提出来，理由是一条**实测到的崩溃**：
 * 机器人写进 effective.json 的 `recvAll` 是**对象**（`{群 openid: true}`），
 * 而面板那侧照着旧形状写了 `Object.fromEntries(...)` ⇒ 只要官方通道真的在跑、
 * 采一次状态就 `TypeError: object is not iterable` 整颗抛。
 *
 * 这类"两份形状"的问题在浏览器和静态扫描里都看不见：写的人两边都只见过自己那一半。
 * 所以现在两边喂进同一个纯函数，接缝能在没有浏览器的门禁里变红
 * （判据见 `test/check-official.mjs` 第 ⑬ 节与 check-wb §190⑦）。
 *
 * ⚠️ 三条不变量：
 *   ① **绝不下发 AppSecret** —— `/api/state` 是不鉴权的只读口，进来过一次就等于外送一次；
 *   ② `recvAll` 与 `pendingGroups` 的形状**原样转述**机器人写出的那一份，面板不重拼；
 *   ③ `restartRequired` 比的是"运行侧那一份 vs 配置里这一份"，不是常量、也不是只看通道种类
 *      （只比种类的话，存好凭据不重启的用户看到的是一片安静）。
 *
 * @param {{mode:string, health?:object, effChannel?:string, cfgChannel?:object,
 *          ownerIds?:string[]}} input cfgChannel = 配置里的 `channel` 那一块（含明文 Secret，只读不抄）
 * @returns {object} 面板 `state.channel`
 */
export function officialPanelView({ mode = '', health = null, effChannel = '', cfgChannel = null, ownerIds = [] } = {}) {
  const officialCfg = cfgChannel?.official || {};
  const appId = String(officialCfg.appId ?? '');
  const configured = channelIsConfigured(mode, officialCfg);
  const runConfigured = health ? health.configured === true : false;
  const restartRequired = mode !== 'official'
    // NapCat 那条只看种类：它的凭据是扫码来的，没有"改了没加载"这一说。
    ? Boolean(effChannel) && effChannel !== mode
    : ((configured || Boolean(health))
      && (effChannel !== 'official'
        || runConfigured !== configured
        || String(health?.appId ?? '') !== appId));
  return {
    mode,
    label: CHANNEL_LABELS[mode] || mode,
    configured,
    restartRequired,
    runningChannel: effChannel || '',
    official: mode === 'official' ? {
      appId,
      // 只说"有没有配过"：这把 Key 面板读不到明文，也不许被读走。
      hasSecret: Boolean(String(officialCfg.appSecret ?? '').trim()),
      selfId: health?.selfId || '',
      selfName: health?.selfName || '',
      connected: health?.connected === true,
      token: health?.token || null,
      passive: health?.passive || null,
      pendingGroups: health?.pendingGroups || [],
      pendingMembers: health?.pendingMembers || [],
      // 对象 `{群 openid: true/false}` —— 原样转述（见上面那条崩溃）。
      recvAll: health?.recvAll || {},
      groupsBound: Object.keys(cfgChannel?.bindings?.groups || {}).length,
      lastError: health?.lastError || '',
      lastErrorCode: health?.lastErrorCode || '',
      // 主人的唯一真值是 `owner.qq`（大脑与叫醒路都读它），
      // 所以"绑了几个主人"= 那一份里**不是纯数字**的条目数，不是另开一张表。
      ownersBound: ownerIds.length,
    } : null,
    bindings: {
      groups: cfgChannel?.bindings?.groups || {},
      ownerIds,
    },
  };
}
