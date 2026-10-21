/**
 * 协议端存活判定（零依赖纯函数）。
 *
 * 面板能探到"端口在听"不等于"机器人听得见"：QQ 被腾讯踢下线时 NapCat 进程还活着、
 * 3001 还开着，但事件流已经死了 —— 只按端口判会显示一片绿，用户以为机器人正常。
 * 这里把两个来源并排看：
 *   · `ports`  = 面板此刻能不能连上（HTTP / WS）；
 *   · `health` = 机器人自己看到的连接、最后入站帧、账号在线状态。
 *
 * 阶梯（命中即返回）：
 *   down（全不通）→ ws-down（WS 不通 / 机器人没连上）→ port-only（端口在听但机器人没快照）
 *   → account-offline（账号掉线，**不要重启协议端**）→ stalled（帧停摆）
 *   → actions-dead（帧在但动作探测连败）→ ok。
 */

/** 帧停摆阈值：至少 90 秒，或后端自报心跳间隔的 3 倍。 */
function staleMsOf(health, fallback = 90000) {
  const iv = Number(health?.heartbeatIntervalMs);
  const base = Number.isFinite(iv) && iv > 0 ? Math.max(90000, iv * 3) : fallback;
  return Number.isFinite(base) && base > 0 ? base : 90000;
}

export function livenessVerdictOf({ health = null, ports = {}, now = Date.now(), staleMs = null } = {}) {
  const http = ports.http === true;
  const ws = ports.ws === true;
  if (!http && !ws) return { code: 'down', detail: 'HTTP 与 WS 都不通' };
  if (!ws) return { code: 'ws-down', detail: 'HTTP 通，但 WS 端口没人听' };
  if (!health || typeof health !== 'object') return { code: 'port-only', detail: '端口在听，但机器人还没有连接快照' };
  if (health.connected !== true) return { code: 'ws-down', detail: 'WS 端口在听，但机器人没连上' };
  if (health.botOffline === true) {
    return { code: 'account-offline', detail: 'QQ 账号已掉线（协议端还活着，重启它没用）' };
  }
  const last = Math.max(Number(health.lastFrameAt) || 0, Number(health.connectedAt) || 0);
  const limit = staleMs == null ? staleMsOf(health) : staleMs;
  if (last > 0 && now - last > limit) {
    return { code: 'stalled', detail: `事件流停摆 ${Math.round((now - last) / 1000)} 秒`, staleMs: limit };
  }
  if (health.lastStatusOk === false) return { code: 'actions-dead', detail: '连接与帧都在，但动作探测连败' };
  return { code: 'ok', detail: '' };
}
