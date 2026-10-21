/**
 * fake-host —— 「假 QQ 会话层」的共同零件。
 *
 * 被两个脚本共用（别各写一份，假 OneBot 的调用面一旦漂移，两个工具的结论就会打架）：
 *   · scripts/dev-sim.mjs   一次性：跑一轮、验一条链路、退出
 *   · scripts/fake-qq.mjs   常驻：你在终端里当群友，机器人真回你
 *
 * 三块积木：
 *   startFakeOnebot  本地 WS 服务端，冒充 OneBot v11 协议端（收 API 调用、推消息事件）
 *   startFakeLlm     本地 OpenAI 兼容服务，回固定话（可选，默认用真模型）
 *   spawnRealApp     spawn 同一份 `src/index.js`（同一套扩展、同一套钩子）
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { WebSocketServer } from 'ws';

export const SELF_ID = '10000';
export const SELF_NAME = '模拟鲸鱼';
export const FAKE_GROUP = '900000001';

/** 从任意一份配置改出「这次模拟」的版本：假地址、放行假群、关掉随机与延迟。 */
export function makeConfig(base, { wsPort, llmPort, group, fakeModel, privateUser, enablePlugins }) {
  const cfg = structuredClone(base);
  cfg.onebot.wsUrl = `ws://127.0.0.1:${wsPort}`;
  cfg.onebot.accessToken = '';
  cfg.onebot.reconnectBackoffMs = [200, 500, 1000];
  if (fakeModel) {
    // ⚠️ 地址别写 127.0.0.1：`src/net-rules.js` 的 `isLocalBase()` 会把本机地址判成
    // provider 'local'，而 `localMetaOf()` 的能力表里没有 functions 位 ⇒ 判定"不会用工具"，
    // 请求里 tools 一个都不发（本文件早前踩过：日志「不支持 function 调用 → 一个都不会发出」）。
    // 也不能用 127.0.0.2：macOS 默认没有这个 lo0 别名（实测 listen EADDRNOTAVAIL、连不上）。
    // IPv4-mapped IPv6 回环 `::ffff:127.0.0.1` 在 macOS / Linux / Windows 都能连，
    // 且不在 `isLocalBase` 的正则里；路径里带 `bigmodel.cn` 让 `providerOf()` 判成 zhipu，
    // 能力查 `ZHIPU_MODEL_META`（唯一能让 tools 发出去的路子）。服务端只认 POST、不看路径。
    cfg.llm.baseUrl = `http://[::ffff:127.0.0.1]:${llmPort}/bigmodel.cn/v1`;
    cfg.llm.apiKey = 'sim-key';
    cfg.llm.apiKeyEnv = '';
    // 模型名不能随便编：`src/model-caps.js` 的 `functions` 位是按**模型名**查表的，
    // 编个 'sim-model' 会让宿主判定"不支持工具调用"，请求里 tools 一个都不发（踩过）。
    // 借一个表里确认支持 function 调用的名字，反正真正的服务端是我们自己。
    cfg.llm.model = 'glm-4.6';
    cfg.llm.fallbackModels = [];
    cfg.llm.activeCustomId = '';
    cfg.llm.customBrains = {};
    cfg.llm.timeoutMs = 15000;
    cfg.llm.maxTokens = 200;
    cfg.llm.thinking = { mode: 'off', level: 'low' };
    cfg.llm.features = { webSearch: false, vision: false, stickers: false };
    cfg.llm.declaredFeatures = { vision: false, webSearch: false, thinking: false, functions: true, stickers: false };
  }
  cfg.allow = { ...(cfg.allow || {}), private: privateUser ? [String(privateUser)] : [], groups: [String(group)], allowAllWhenEmpty: false };
  // owner.qq 是**数组**（可以配多个管理员号），写成字符串程序会直接拒绝启动。
  if (privateUser) cfg.owner = { ...(cfg.owner || {}), qq: [String(privateUser)] };
  cfg.trigger = { ...(cfg.trigger || {}), requireAtInGroup: false };
  cfg.reply = { ...(cfg.reply || {}), splitToken: '||', sendDelayMs: 0, maxChunks: 1, pace: { enabled: false, minMs: 0, maxMs: 0, perCharMs: 0 } };
  cfg.throttle = { minIntervalMs: 0, perMinutePerSession: 600, perHourPerSession: 6000, globalConcurrency: 1 };
  cfg.custom = {
    ...(cfg.custom || {}),
    allowProactive: false,
    sleep: { ...(cfg.custom?.sleep || {}), enabled: false },
    trigger: { ...(cfg.custom?.trigger || {}), proactive: { ...(cfg.custom?.trigger?.proactive || {}), enabled: false }, quietHours: { from: 0, to: 0 }, interjectChance: 0 },
    memory: { auto: false, manual: [] },
  };
  // 不传就照你配置里的启用状态（fake-qq 用真配置时就是这个语义）；
  // dev-sim 传 ['local-memory']，否则示例配置里插件默认关着，验不到工具链路。
  if (enablePlugins) {
    cfg.custom.plugins = { ...(cfg.custom.plugins || {}), enabled: enablePlugins, settings: cfg.custom.plugins?.settings || {} };
  }
  return cfg;
}

function pickText(segments) {
  if (typeof segments === 'string') return segments;
  if (!Array.isArray(segments)) return '';
  return segments.map((s) => (s?.type === 'text' ? String(s.data?.text ?? '') : '')).join('');
}

/**
 * 假 OneBot v11 协议端。
 * @param {{onReply?: (text: string, action: string) => void, groupName?: string}} opts
 */
export async function startFakeOnebot(opts = {}) {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  const port = await new Promise((resolve) => wss.once('listening', () => resolve(wss.address().port)));
  const state = { client: null, seq: 1, replies: [], calls: [] };

  wss.on('connection', (ws) => {
    state.client = ws;
    ws.on('message', (buf) => {
      let frame;
      try { frame = JSON.parse(String(buf)); } catch { return; }
      if (!frame || typeof frame.action !== 'string') return;
      const { action, params = {}, echo } = frame;
      // 所有 API 调用都留一份（`set_input_status` 这类没有返回值、只看有没有被调的东西靠它断言）。
      state.calls.push({ action, params });
      let data = {};
      if (action === 'send_group_msg' || action === 'send_private_msg') {
        const text = pickText(params.message).trim();
        state.replies.push(text);
        data = { message_id: state.seq++ };
        opts.onReply?.(text, action);
      } else if (action === 'get_login_info') {
        data = { user_id: Number(SELF_ID), nickname: SELF_NAME };
      } else if (action === 'get_group_info') {
        data = { group_id: Number(params.group_id), group_name: opts.groupName ?? '模拟群' };
      } else if (action === 'get_group_member_info') {
        data = { group_id: Number(params.group_id), user_id: Number(params.user_id), nickname: '测试群友', card: '' };
      } else if (action === 'get_stranger_info') {
        data = { user_id: Number(params.user_id), nickname: '测试群友' };
      } else if (action === 'get_msg') {
        // `opts.messageImage` 有值时，这条消息里就带一张图（看图工具用它当输入）。
        const segs = opts.messageImage ? [{ type: 'image', data: { url: opts.messageImage, file: opts.messageImage } }] : [];
        data = { message_id: Number(params.message_id), sender: { user_id: 1 }, message: segs };
      }
      ws.send(JSON.stringify({ status: 'ok', retcode: 0, data, echo }));
    });
    ws.on('close', () => { if (state.client === ws) state.client = null; });
  });

  return {
    port,
    state,
    /** 造一条群消息事件并推给程序。 */
    sendGroup({ group, user, name = '测试群友', text, at = true, messageId = state.seq++ }) {
      if (!state.client || state.client.readyState !== 1) throw new Error('程序还没连上假 OneBot');
      const segments = [];
      if (at) segments.push({ type: 'at', data: { qq: SELF_ID } });
      segments.push({ type: 'text', data: { text } });
      state.client.send(JSON.stringify({
        post_type: 'message', message_type: 'group', sub_type: 'normal',
        self_id: Number(SELF_ID), group_id: Number(group), user_id: Number(user),
        message_id: messageId, message: segments,
        raw_message: text, time: Math.floor(Date.now() / 1000),
        sender: { user_id: Number(user), nickname: name, card: '', role: 'member' },
      }));
    },
    /** 造一条私聊事件（管理员路径）。 */
    sendPrivate({ user, name = '测试群友', text, messageId = state.seq++ }) {
      if (!state.client || state.client.readyState !== 1) throw new Error('程序还没连上假 OneBot');
      state.client.send(JSON.stringify({
        post_type: 'message', message_type: 'private', sub_type: 'friend',
        self_id: Number(SELF_ID), user_id: Number(user),
        message_id: messageId, message: [{ type: 'text', data: { text } }],
        raw_message: text, time: Math.floor(Date.now() / 1000),
        sender: { user_id: Number(user), nickname: name, card: '', role: 'member' },
      }));
    },
    close() { wss.close(); },
  };
}

/** 假模型：OpenAI 兼容，回固定话。`--fake-model` 时用（不花钱、离线可跑）。 */
export async function startFakeLlm({ text = '（模拟回复）收到', tool = '', args = {}, delayMs = 0 } = {}) {
  const requests = [];
  let toolSent = false;
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST') { res.writeHead(404).end(); return; }
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let parsed = {};
      try { parsed = JSON.parse(body); } catch { /* 坏了就当空请求 */ }
      requests.push(parsed);
      // 第一次请求如果宿主带了 tools，就调**一个真工具**，让整条"模型要工具 → 宿主执行 →
      // 结果回填 → 再请求一次"的链路真的跑一遍；之后一律回文本，避免无限循环。
      const wantsTool = tool && !toolSent && (parsed.tools || []).some((t) => t?.function?.name === tool);
      let message;
      let finish = 'stop';
      if (wantsTool) {
        toolSent = true;
        finish = 'tool_calls';
        message = {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'call_sim_1', type: 'function', function: { name: tool, arguments: JSON.stringify(args) } }],
        };
      } else {
        message = { role: 'assistant', content: text };
      }
      const reply = () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'chatcmpl-sim', object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: 'sim-model',
        choices: [{ index: 0, message, finish_reason: finish }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }));
      };
      // `delayMs` 让假模型"慢"一点（用来验慢任务垫话）；0 = 立刻回。
      if (delayMs > 0) setTimeout(reply, delayMs); else reply();
    });
  });
  // 绑通配地址：makeConfig 故意把客户端指向 127.0.0.2（避开 `isLocalBase` 的 provider 判定），
  // 而 macOS 默认没有配置 127.0.0.2 这个别名（listen 会 EADDRNOTAVAIL）—— 只有绑通配
  // 才能同时接受 127.0.0.1/127.0.0.2。它是**假会话期间的本地测试桩**，只回固定话，
  // 不持有凭据；真实模型请求不经过它。
  const port = await new Promise((resolve) => server.listen(0, '0.0.0.0', () => resolve(server.address().port)));
  return { port, requests, close: () => server.close() };
}

/**
 * 起真程序（同一份 src/index.js）。配置与数据目录由调用方给。
 *
 * `lockPath` 一定要给：程序用 `QQBOT_BRIDGE_LOCK_FILE` 决定排他锁放哪，
 * 不指走的话它会去抢 `panel\.bridge.lock` —— 真机正在跑时假会话起不来，
 * 假会话留个僵尸时真机也起不来（这个坑踩过：or 掉了）。
 */
export function spawnRealApp({ appDir, cfgPath, dataDir, logPath, lockPath, env = {} }) {
  const logFd = fs.openSync(logPath, 'a');
  const child = spawn(process.execPath, ['src/index.js'], {
    cwd: appDir,
    env: { ...process.env, QQBOT_CONFIG: cfgPath, QQBOT_DATA_DIR: dataDir, ...(lockPath ? { QQBOT_BRIDGE_LOCK_FILE: lockPath } : {}), ...env },
    stdio: ['ignore', logFd, logFd],
  });
  child.on('exit', () => { try { fs.closeSync(logFd); } catch { /* 已经关了 */ } });
  return child;
}

/** 等一个条件成立；超时抛错。 */
export async function waitFor(fn, ms, why) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`等待超时：${why}`);
}

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export { path };
