/**
 * dev-sim —— **一次性**假会话：跑一轮、看结果、退出。
 *
 * 常驻的那种（你用键盘当群友聊天）在 scripts/fake-qq.mjs；两者共用 scripts/lib/fake-host.mjs。
 * 这里适合「验一条链路」：不连真 QQ、不花真 token（`--tool` 会让假模型调一次真工具）。
 *
 * 用法：
 *   node scripts/dev-sim.mjs
 *   node scripts/dev-sim.mjs --text "记住我喜欢猫" --tool
 *   node scripts/dev-sim.mjs --turns 2 --tool --args '{"kind":"rule","text":"鱼塘的规矩是先打招呼"}'
 *   node scripts/dev-sim.mjs --tool local-memory__remember --keep
 *
 * 退出码：0 = 收到回复；1 = 超时/程序起不来（日志路径会打出来）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FAKE_GROUP, makeConfig, readJson, spawnRealApp, startFakeLlm, startFakeOnebot, waitFor } from './lib/fake-host.mjs';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const out = {
    text: '你好呀', group: FAKE_GROUP, user: '2892113520', name: '测试群友', turns: 1,
    at: true, tool: '', args: '{"kind":"fact","text":"假会话里记下的一条"}', keep: false, timeout: 25000,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--text') out.text = argv[++i];
    else if (a === '--group') out.group = argv[++i];
    else if (a === '--user') out.user = argv[++i];
    else if (a === '--name') out.name = argv[++i];
    else if (a === '--turns') out.turns = Number(argv[++i]);
    else if (a === '--tool') out.tool = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'local-memory__remember';
    else if (a === '--args') out.args = argv[++i];
    else if (a === '--no-at') out.at = false;
    else if (a === '--keep') out.keep = true;
    else if (a === '--timeout') out.timeout = Number(argv[++i]);
    else if (a === '--help' || a === '-h') {
      console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0]);
      process.exit(0);
    }
  }
  return out;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-sim-'));
  const dataDir = path.join(tmp, 'data');
  fs.mkdirSync(dataDir, { recursive: true });

  const replies = [];
  const bot = await startFakeOnebot({ onReply: (text) => { replies.push(text); console.log(`[sim] 机器人发出：${text}`); } });
  const llm = await startFakeLlm({
    text: `（模拟回复）收到：${opts.text}`,
    tool: opts.tool,
    args: JSON.parse(opts.args),
  });

  const cfgPath = path.join(tmp, 'config.json');
  const base = readJson(path.join(APP, 'config.example.json'));
  fs.writeFileSync(cfgPath, JSON.stringify(makeConfig(base, { wsPort: bot.port, llmPort: llm.port, group: opts.group, fakeModel: true, enablePlugins: ['local-memory'] }), null, 2));
  const logPath = path.join(tmp, 'bot.log');
  const child = spawnRealApp({ appDir: APP, cfgPath, dataDir, logPath, lockPath: path.join(tmp, 'bridge.lock') });
  child.on('exit', (code) => { if (code !== 0 && code !== null) console.log(`[sim] 程序退出码 ${code}（日志 ${logPath}）`); });

  try {
    await waitFor(() => bot.state.client !== null && bot.state.client.readyState === 1, opts.timeout, '程序连上假 OneBot');
    console.log('[sim] 已连上，发消息');
    for (let turn = 1; turn <= opts.turns; turn += 1) {
      const before = replies.length;
      bot.sendGroup({
        group: opts.group, user: opts.user, name: opts.name, at: opts.at,
        text: turn === 1 ? opts.text : `第 ${turn} 轮：${opts.text}`,
      });
      await waitFor(() => replies.length > before, opts.timeout, `第 ${turn} 轮回复`);
    }

    const requests = llm.requests;
    const memDir = path.join(dataDir, 'memory', 'local');
    const memFiles = fs.existsSync(memDir) ? fs.readdirSync(memDir).filter((f) => f.endsWith('.jsonl')) : [];
    console.log('\n[sim] 结果');
    console.log(`  · 回复 ${replies.length} 条：${replies.join(' / ') || '（无）'}`);
    console.log(`  · 模型请求 ${requests.length} 次（工具调用：${opts.tool || '无'}）`);
    const firstSystem = requests[0]?.messages?.find((m) => m?.role === 'system');
    if (firstSystem) console.log(`  · 系统提示词 ${String(firstSystem.content ?? '').length} 字符`);
    const MARKERS = ['【记得】', '【别这么干】', '【灵枢', '【心情】', '【困'];
    requests.forEach((r, i) => {
      const system = (r.messages ?? []).find((m) => m?.role === 'system');
      const text = String(system?.content ?? '');
      const hit = MARKERS.filter((k) => text.includes(k));
      if (hit.length > 0) console.log(`  · 第 ${i + 1} 次请求注入：${hit.join(' ')}`);
    });
    console.log(`  · 记忆文件：${memFiles.length === 0 ? '（没写，检查插件是否启用）' : memFiles.map((f) => path.join(memDir, f)).join(', ')}`);
    if (memFiles.length > 0) {
      const lines = fs.readFileSync(path.join(memDir, memFiles[0]), 'utf8').trim().split('\n').filter(Boolean);
      console.log(`  · 记忆条数：${lines.length}`);
    }
    if (opts.keep) console.log(`  · 临时目录（--keep）：${tmp}`);
  } finally {
    child.kill('SIGTERM');
    bot.close();
    llm.close();
    if (!opts.keep) fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`[sim] 失败：${error.message}`);
  process.exit(1);
});
