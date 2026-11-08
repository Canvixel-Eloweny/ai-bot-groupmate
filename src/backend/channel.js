/**
 * 消息通道的**唯一工厂**（2026-11-06）。
 *
 * 为什么要有它：机器人侧原来直接 `new OneBotClient(...)`，那条假设是
 * "出口只可能是 OneBot"。加第二条通道时最容易做的两件事都错：
 *   ① 在启动路径上到处 `if (channel === ...)` —— 判据散成一地，迟早漏一处；
 *   ② 让官方通道去冒充 OneBot 后端（塞进 `onebot.backend`）—— 那会让 `auto`
 *      识别去问一个官方根本没有的 `get_version_info`。
 * 所以出口只从这里出：**构造在此刻决定，运行期不再改**。切换通道要重启机器人，
 * 面板把这件事说清楚（`restartRequired`），而不是假装能热插拔。
 *
 * ⚠️ 工厂**只构造、不 start()**：`bot.start()` 的调用点必须仍然只有一个
 *    （check-wb §24 盯的就是"两条连接循环并存"）。
 */

import { OneBotClient } from '../onebot.js';
import { CHANNEL_LABELS } from '../channel-mode.js';
import { OfficialClient } from './official/client.js';

/**
 * @param {ReturnType<import('../config.js').loadConfig>} cfg
 * @param {{getCfg?:()=>object, fetchImpl?:Function, WebSocketImpl?:Function,
 *          base?:string, wsUrl?:string, dataDir?:string}} [options] 测试注入口
 * @returns {{id:string, label:string, client:OneBotClient|OfficialClient}}
 */
export function createChannelClient(cfg, options = {}) {
  const mode = cfg?.channel?.mode === 'official' ? 'official' : 'napcat';
  if (mode === 'official') {
    return {
      id: mode,
      label: CHANNEL_LABELS.official,
      client: new OfficialClient(cfg.channel ?? {}, options),
    };
  }
  return {
    id: mode,
    label: CHANNEL_LABELS.napcat,
    client: new OneBotClient(cfg.onebot),
  };
}
