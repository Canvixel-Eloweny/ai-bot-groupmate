#!/usr/bin/env node
/**
 * 官方通道连接自检（2026-11-06）。
 *
 * 与 `scripts/check-onebot.js` 是**同一类产品动作**（面板上那个「校验凭据 / 连接自检」按钮），
 * 但观测面完全不同：NapCat 在本地端口上，可以问端口、问 HTTP；
 * 官方机器人只有"出站到 api.bot.qq.com 能不能成"这一件事可问。
 *
 * 输出刻意分成四步，每步都单独可判：
 *   ① 配置：通道是不是 official、AppID/AppSecret 有没有（**不打印凭据**）
 *   ② 取 token：鉴权对不对（AppSecret 错、应用被下架都在这一步现形）
 *   ③ 机器人身份：`/users/@me` 的 id 与名字（id 用来判"这条消息 @ 的是不是我"）
 *   ④ 事件网关：连一次 wss，收到 Hello/READY 就算通（可选，`--no-gateway` 跳过）
 *
 * 退出码：0 = 四步全过；1 = 任一步失败；2 = 配置读不到。
 * 失败时**只说人话与官方码**，不回显请求体。
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const say = (s) => console.log(s);
const step = (okFlag, text) => say(`${okFlag ? '✔' : '✗'} ${text}`);

let exitCode = 0;
try {
  const { loadConfig } = await import(new URL('../src/config.js', import.meta.url));
  const cfg = loadConfig(process.env.QQBOT_CONFIG);
  const channel = cfg.channel || {};
  const official = channel.official || {};

  say('── 官方机器人通道自检 ──');
  const modeOk = channel.mode === 'official';
  step(modeOk, `通道：${channel.mode || '(未设置)'}${modeOk ? '' : ' —— 现在跑的不是官方通道，先切过来再自检'}`);
  if (!modeOk) { exitCode = 1; process.exit(1); }

  const appId = String(official.appId || '').trim();
  const hasSecret = Boolean(String(official.appSecret || '').trim());
  const credOk = Boolean(appId && hasSecret);
  step(credOk, `凭据：AppID ${appId ? `已填（${appId}）` : '未填'} · AppSecret ${hasSecret ? '已填' : '未填'}`);
  if (!credOk) {
    say('   下一步：在「运行 → 切换协议端」里填 AppID 与 AppSecret，然后重启机器人。');
    exitCode = 1;
    process.exit(1);
  }

  const { createOfficialHttp } = await import(new URL('../src/backend/official/http.js', import.meta.url));
  const { createTokenManager } = await import(new URL('../src/backend/official/token.js', import.meta.url));
  const { createOfficialRest } = await import(new URL('../src/backend/official/rest.js', import.meta.url));
  const { OfficialGateway } = await import(new URL('../src/backend/official/gateway.js', import.meta.url));

  const http = createOfficialHttp({});
  const tokens = createTokenManager({ appId, appSecret: official.appSecret, http });
  const rest = createOfficialRest({ http, tokens });

  let token = '';
  try {
    token = await tokens.get();
    const snap = tokens.snapshot();
    step(true, `取 token：成功（有效期约 ${Math.round((snap.msLeft || 0) / 60000)} 分钟）`);
  } catch (err) {
    step(false, `取 token 失败：${err.message}${err.officialCode ? `（官方码 ${err.officialCode}）` : ''}`);
    say('   常见原因：AppSecret 填错、应用未通过审核或已下架、本机出网被拦。');
    exitCode = 1;
    process.exit(1);
  }

  let bot = null;
  try {
    bot = await rest.getBotInfo();
    step(true, `机器人身份：${bot?.username || '(无名)'} · id=${bot?.id || '(空)'}`);
  } catch (err) {
    step(false, `读机器人身份失败：${err.message}${err.officialCode ? `（官方码 ${err.officialCode}）` : ''}`);
    exitCode = 1;
  }

  if (!process.argv.includes('--no-gateway')) {
    // 网关这一步只验"能不能握手"，收到 READY 就主动断开 —— 常驻连接归机器人自己维护，
    // 这里再挂一条会制造"两个客户端抢同一应用"的假象。
    const gateway = new OfficialGateway({ getToken: async () => token });
    const outcome = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ ok: false, why: '15 秒内没等到 READY' }), 15_000);
      gateway.on('ready', (info) => { clearTimeout(timer); resolve({ ok: true, info }); });
      gateway.on('terminal', (info) => { clearTimeout(timer); resolve({ ok: false, why: `平台终止连接：${info.reason}` }); });
      gateway.on('auth-error', (info) => { clearTimeout(timer); resolve({ ok: false, why: `鉴权失败：${info.message}` }); });
      gateway.start();
    });
    step(outcome.ok, outcome.ok
      ? `事件网关：连上了（session_id ${outcome.info?.sessionId ? '已下发' : '未下发'}）`
      : `事件网关：没连上 —— ${outcome.why}`);
    gateway.stop();
    if (!outcome.ok) exitCode = 1;
  }

  if (exitCode === 0) {
    say('');
    say('✔ 官方通道四步都通。接下来在群里 @ 它一次，'
      + '然后在「运行 → 总览 → 群与身份绑定」里把这个群绑到真实群号。');
    say('   注意：群主要在手机 QQ 的群设置里打开「接收所有消息」，否则机器人只收得到 @ 它的消息。');
  }
} catch (err) {
  say(`✗ 自检跑不起来：${err.message}`);
  exitCode = 2;
}
process.exit(exitCode);
