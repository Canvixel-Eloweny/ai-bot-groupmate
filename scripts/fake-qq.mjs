/**
 * fake-qq —— **常驻的假 QQ 会话层**：没有 QQ / NapCat 也能跟机器人整晚聊。
 *
 * 和 dev-sim 的区别：dev-sim 跑完一轮就退出（验链路用），这个是**你打字、它回你**。
 * 假的是「传输层」（本地 WS 冒充 OneBot v11），真的是程序本体：
 *   真模型（默认，用 config.json 里那套）· 真人设 · 真插件 · 真记忆落盘。
 *
 * 用法：
 *   node scripts/fake-qq.mjs                 # 用 app/config.json + app/data，真模型
 *   node scripts/fake-qq.mjs --offline       # 不调模型（固定回话），不花钱、断网可用
 *   node scripts/fake-qq.mjs --sandbox       # 配置和数据都拷到临时目录，不碰真身
 *   node scripts/fake-qq.mjs --group 123456 --user 2892113520 --name 岁小熙
 *
 * 进去以后直接打字就是群消息；以 / 开头的是命令：
 *   /help  /at   开关 @（关掉就是「没被点名的群消息」，用来试巡逻/插话）
 *   /private     切到私聊（管理员路径）· /group 切回群
 *   /as QQ 名字  换个身份说话 · /log 看程序日志尾巴 · /quit 退出
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { FAKE_GROUP, makeConfig, readJson, spawnRealApp, startFakeLlm, startFakeOnebot, waitFor } from './lib/fake-host.mjs';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const out = { config: '', data: '', group: FAKE_GROUP, user: '2892113520', name: '测试群友', at: true, offline: false, sandbox: false, log: false, timeout: 30000 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--config') out.config = argv[++i];
    else if (a === '--data') out.data = argv[++i];
    else if (a === '--group') out.group = argv[++i];
    else if (a === '--user') out.user = argv[++i];
    else if (a === '--name') out.name = argv[++i];
    else if (a === '--no-at') out.at = false;
    else if (a === '--offline') out.offline = true;
    else if (a === '--sandbox') out.sandbox = true;
    else if (a === '--log') out.log = true;
    else if (a === '--help' || a === '-h') {
      console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0]);
      process.exit(0);
    }
  }
  return out;
}

const HELP = `
  直接打字 = 以当前身份发一条群消息（默认带 @，机器人一定回）
  /at            开关 @：关掉就是"没点名的群消息"，用来看巡逻/插话/静默逻辑
  /private       切到私聊（管理员路径，管理员号在 config.json 里）
  /group         切回群聊
  /as QQ 名字    换个人说话（默认 ${FAKE_GROUP} 群里那个测试群友）
  /log           打印程序日志最后 20 行（出错时看这个）
  /where         当前身份与场景
  /quit          退出（也可以 Ctrl+C）
`;

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  // 临时工作目录放配置与日志（不往 app\ 里扔东西）；数据目录默认就是真身的 app\data，
  // 这样人设、记忆、存档都是你平时那份。`--sandbox` 连数据也拷到临时目录，坏了不心疼。
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-fakeqq-'));
  // 用户数据根由宿主（面板）通过 QQBOT_DATA_DIR 传入；--sandbox 永远用临时目录。
  const dataDir = opts.data || (opts.sandbox
    ? path.join(workDir, 'data')
    : (process.env.QQBOT_DATA_DIR || path.join(APP, 'data')));
  fs.mkdirSync(dataDir, { recursive: true });

  const cfgSource = opts.config || process.env.QQBOT_CONFIG
    || (fs.existsSync(path.join(APP, 'config.json')) ? path.join(APP, 'config.json') : path.join(APP, 'config.example.json'));
  const base = readJson(cfgSource);

  const bot = await startFakeOnebot({
    onReply: (text, action) => {
      const tag = action === 'send_private_msg' ? '私聊' : '群';
      console.log(`\n  机器人（${tag}）▸ ${text}\n`);
      safePrompt();
    },
  });
  const llm = opts.offline ? await startFakeLlm({ text: '（离线假回话：模型没调）' }) : null;

  const cfgPath = path.join(workDir, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify(makeConfig(base, {
    wsPort: bot.port, llmPort: llm?.port ?? 0, group: opts.group, fakeModel: Boolean(llm), privateUser: opts.user,
  }), null, 2));

  const logPath = path.join(workDir, 'bot.log');
  const child = spawnRealApp({
    appDir: APP, cfgPath, dataDir, logPath, lockPath: path.join(workDir, 'bridge.lock'),
    // 沙箱：把用户根也指到临时目录 —— 否则 trace / control / 用量 / 记忆这些
    // "panel 状态"仍会写进真机那份，和正在跑的真机器人抢文件。
    env: opts.sandbox ? { QQBOT_USER_ROOT: workDir } : {},
  });

  let mode = 'group';
  let at = opts.at;
  let user = opts.user;
  let name = opts.name;
  let logOffset = 0;

  const tailLog = (n = 20) => {
    try {
      const text = fs.readFileSync(logPath, 'utf8');
      const lines = text.trimEnd().split('\n').slice(-n);
      console.log(lines.map((l) => `  │ ${l}`).join('\n'));
    } catch {
      console.log('  （还没有日志）');
    }
  };

  const where = () => `[${mode === 'group' ? `群 ${opts.group}` : `私聊 ${user}`} · ${name}(${user}) · @${at ? '开' : '关'}]`;

  let down = false;
  const shutdown = () => {
    if (down) return;
    down = true;
    child.kill('SIGTERM');
    bot.close();
    llm?.close();
    if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
    console.log(`\n退出。程序日志：${logPath}`);
    process.exit(0);
  };

  // SIGTERM 也收（被 kill 时不留孤儿 —— 孤儿会攥着真机的 panel\.bridge.lock）。
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  console.log(`\n假 QQ 会话层已启动（${opts.offline ? '离线假模型' : '真模型'} · ${opts.sandbox ? '沙箱数据，不碰 app\\data' : '用 app\\data'}）`);
  console.log(`配置：${cfgSource} → ${cfgPath}`);
  console.log(`群 ${opts.group} 当背景，机器人号 ${'10000'}（假的，只用来判 @）`);
  console.log(HELP);

  try {
    await waitFor(() => bot.state.client !== null && bot.state.client.readyState === 1, opts.timeout, '程序连上假 OneBot');
  } catch (error) {
    console.error(`起不来：${error.message}`);
    tailLog(30);
    shutdown();
    return;
  }
  // 客户端连上 ≠ 程序开始收消息：它还要加载扩展包、恢复会话（约 1 秒），
  // 这一小段里发进去的消息会被静默丢掉（踩过：打字太快，机器人一声不吭）。
  // 等日志里出现「桥接就绪」再放人打字；等不到就照旧开始，只是提示一句。
  try {
    await waitFor(() => {
      try { return fs.readFileSync(logPath, 'utf8').includes('桥接就绪'); } catch { return false; }
    }, Math.min(opts.timeout, 15000), '程序进入桥接就绪');
  } catch {
    console.log('  （没等到「桥接就绪」，先开始了 —— 头一句可能被丢）');
  }
  // readline 必须在"程序能收消息"之后才创建：从 createInterface 到挂上 'line' 监听
  // 之间的输入会被直接丢弃（踩过：管道喂进去的第一句永远收不到）。
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '群友 ▸ ' });
  // stdin 关掉（管道喂完 / Ctrl-D）之后 `rl.prompt()` 会抛 `readline was closed`，
  // 那不该被当成"启动失败"：没人再说话了而已，退出走 `rl.on('close')`。
  const safePrompt = () => {
    try { rl.prompt(); } catch { /* 已关闭：交给 close 事件收尾 */ }
  };
  console.log(`程序已连上，开始说话吧。\n  当前：${where()}\n`);
  safePrompt();

  rl.on('line', (raw) => {
    const line = raw.trim();
    if (!line) { safePrompt(); return; }
    if (line === '/quit' || line === '/exit') { shutdown(); return; }
    if (line === '/help') { console.log(HELP); safePrompt(); return; }
    if (line === '/at') { at = !at; console.log(`  @ ${at ? '开' : '关'}（关掉＝没点名的群消息）`); safePrompt(); return; }
    if (line === '/private') { mode = 'private'; console.log('  切到私聊'); safePrompt(); return; }
    if (line === '/group') { mode = 'group'; console.log('  切回群聊'); safePrompt(); return; }
    if (line === '/where') { console.log(`  ${where()}`); safePrompt(); return; }
    if (line === '/log') { tailLog(opts.log ? 60 : 20); safePrompt(); return; }
    if (line.startsWith('/as ')) {
      const [, qq, ...rest] = line.split(/\s+/);
      if (!/^\d{5,12}$/.test(qq)) { console.log('  用法：/as QQ 名字'); safePrompt(); return; }
      user = qq;
      if (rest.length > 0) name = rest.join(' ');
      console.log(`  现在以 ${name}(${user}) 说话`);
      safePrompt();
      return;
    }

    try {
      if (mode === 'private') bot.sendPrivate({ user, name, text: line });
      else bot.sendGroup({ group: opts.group, user, name, at, text: line });
      console.log(`  ↑ 已发出 ${where()}`);
    } catch (error) {
      console.log(`  ✗ 发送失败：${error.message}`);
    }
    safePrompt();

    // 程序日志里出现 error 就顺手打出来 —— 不然它会安静地不说话，很难查。
    setTimeout(() => {
      try {
        const text = fs.readFileSync(logPath, 'utf8');
        if (text.length <= logOffset) return;
        const fresh = text.slice(logOffset);
        logOffset = text.length;
        const bad = fresh.split('\n').filter((l) => /\[error\]|错误|异常|拒绝/.test(l));
        if (bad.length > 0) console.log(bad.map((l) => `  ! ${l}`).join('\n'));
      } catch { /* 日志还没建 */ }
    }, 400);
  });

  rl.on('close', shutdown);
}

main().catch((error) => {
  console.error(`启动失败：${error.message}`);
  process.exit(1);
});
