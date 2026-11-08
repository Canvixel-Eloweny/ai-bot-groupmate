/**
 * 官方通道的**接口语义层**（2026-11-06）：把"发群消息 / 发私聊 / 传图 / 查群 / 查机器人"
 * 这五件事包成带鉴权与自动续期的一次调用。
 *
 * 与 `http.js` 的分工：`http.js` 只管"这条请求怎么发、回包算不算成功"，
 * 这里只管"这个接口该传什么、返回什么"。判据不许在两边各写一遍。
 *
 * 鉴权失败（token 过期）在这里**重取一次再发**：401/403 是网关在受理前拒的，
 * 消息没有被处理过，重试是安全的；而传输失败（超时/5xx）是"结果不明"，
 * 由上层按不重试处理 —— 两者的处置方向相反，所以必须分开。
 */

import {
  BOT_INFO_PATH, UPLOAD_TIMEOUT_MS, groupFilesPath, groupInfoPath, groupMessagesPath, userMessagesPath,
} from './constants.js';
import { OFFICIAL_CODE } from './errors.js';

export function createOfficialRest({ http, tokens }) {
  async function call(method, path, { body, timeoutMs, expectEmpty } = {}) {
    const run = async () => http.request(method, path, {
      body, timeoutMs, token: await tokens.get(), expectEmpty,
    });
    try {
      return await run();
    } catch (err) {
      if (err?.code !== OFFICIAL_CODE.auth) throw err;
      tokens.invalidate();
      return run();
    }
  }

  return {
    /** 发群消息：payload 由 `outbound.js` 拼好（msg_type / content / media / msg_id / msg_seq）。 */
    sendGroupMessage(groupOpenid, payload) {
      return call('POST', groupMessagesPath(groupOpenid), { body: payload });
    },
    sendPrivateMessage(userOpenid, payload) {
      return call('POST', userMessagesPath(userOpenid), { body: payload });
    },
    /** 群富媒体上传：返回 `{ file_info, ttl, ... }`；**群与单聊的上传接口不互通**。 */
    uploadGroupFile(groupOpenid, body) {
      return call('POST', groupFilesPath(groupOpenid), { body, timeoutMs: UPLOAD_TIMEOUT_MS });
    },
    getGroupInfo(groupOpenid) {
      return call('GET', groupInfoPath(groupOpenid));
    },
    /** 机器人自身：`{ id, username, avatar, bot }`。id 用来判"这条消息里 @ 的是不是我"。 */
    getBotInfo() {
      return call('GET', BOT_INFO_PATH);
    },
  };
}
