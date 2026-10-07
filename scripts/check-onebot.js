#!/usr/bin/env node
/**
 * 协议端探活：连上 OneBot WS，打印登录账号和已加入的群。
 * 不依赖桥接主程序，用来单独验证 NapCat 通道是否打通。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 探活时只想看结论，不想要重连日志刷屏。必须在加载 logger 之前设置。
process.env.QQBOT_LOG_LEVEL ??= 'error';
const { OneBotClient } = await import('../src/onebot.js');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function resolveWs() {
  const f = path.join(ROOT, fs.existsSync(path.join(ROOT, 'config.json')) ? 'config.json' : 'config.example.json');
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'))?.onebot?.wsUrl ?? 'ws://127.0.0.1:3001';
  } catch {
    return 'ws://127.0.0.1:3001';
  }
}

const wsUrl = process.argv[2] || resolveWs();
console.log(`正在连接 ${wsUrl} …`);

const bot = new OneBotClient({ wsUrl, accessToken: '', reconnectBackoffMs: [1000] });

const fail = (msg) => {
  console.log(`\n✗ ${msg}`);
  console.log('  排查顺序：');
  console.log('    1. docker ps            容器是否 running');
  console.log('    2. docker logs --tail 50 napcat');
  console.log('    3. WebUI 里是否真的建了「WebSocket 服务端」，端口是否 3001');
  console.log('    4. 端口是否被别的程序占了：lsof -nP -iTCP:3001 -sTCP:LISTEN');
  bot.stop();
  process.exit(1);
};

const timer = setTimeout(() => fail('8 秒内没能连上协议端'), 8000);

bot.on('ready', async () => {
  clearTimeout(timer);
  console.log('✓ 已连上协议端\n');

  try {
    const info = await bot.call('get_login_info');
    console.log(`  登录账号：${info.nickname ?? '?'} (${info.user_id ?? '?'})`);
    if (String(info.user_id ?? '').endsWith('123456')) {
      console.log('  ! 看起来是示例账号，确认一下是不是真登上了');
    }
  } catch (e) {
    console.log(`  取登录信息失败：${e.message}（协议端可能还没登录）`);
  }

  try {
    const groups = await bot.call('get_group_list');
    if (Array.isArray(groups) && groups.length) {
      console.log(`\n  已加入 ${groups.length} 个群：`);
      for (const g of groups) {
        console.log(`    ${String(g.group_id).padEnd(14)} ${g.group_name ?? ''}`);
      }
      console.log('\n  把要放行的群号填进 config.json 的 allow.groups');
    } else {
      console.log('\n  没取到群列表，可能是小号还没加群');
    }
  } catch (e) {
    console.log(`  取群列表失败：${e.message}`);
  }

  console.log('\n✓ 通道正常。');
  bot.stop();
  process.exit(0);
});

bot.on('error', () => {});
bot.start();
