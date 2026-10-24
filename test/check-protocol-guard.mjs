/**
 * 协议端进程守护的判据（2026-10-22）。
 *
 * 跑法：`node test/check-protocol-guard.mjs`
 * 判据全是纯函数 + 注入时钟，不启动面板、不碰真实进程。
 */
import fs from 'node:fs';

const SRC = new URL('../src/', import.meta.url).pathname;
const PANEL = new URL('../panel/', import.meta.url).pathname;
const { GUARD_DEFAULTS, guardDecision, createProtocolGuard } =
  await import(`${PANEL}lib/protocol-guard.js`);

let pass = 0;
const fails = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass += 1; return; }
  fails.push(detail ? `${name} —— ${detail}` : name);
};

const G = (extra = {}) => ({
  enabled: true,
  configured: true,
  attempts: 0,
  nextRetryAt: 0,
  maxAttempts: GUARD_DEFAULTS.maxAttempts,
  seenAlive: true,
  ...extra,
});

// ── ① 七条判据 ──────────────────────────────────────────────────────────
ok('守护关着 → skip', guardDecision({ now: 0, guard: G({ enabled: false }), alive: false }).act === 'skip');
ok('没配拉起方式 → give_up', guardDecision({ now: 0, guard: G(), configured: false, alive: false }).act === 'give_up');
ok('账号掉线 → skip（重启没用）',
  guardDecision({ now: 0, guard: G(), onebotState: 'offline', alive: false }).act === 'skip');
ok('端口有应答 → skip（还活着）',
  guardDecision({ now: 0, guard: G({ seenAlive: false }), alive: true }).act === 'skip');
ok('探测失败 null → skip（不冒险拉起）',
  guardDecision({ now: 0, guard: G(), alive: null }).act === 'skip');
ok('从没起来过 → skip（首次不替用户开窗口）',
  guardDecision({ now: 0, guard: G({ seenAlive: false }), alive: false }).act === 'skip');
ok('冷却中 → skip',
  guardDecision({ now: 1000, guard: G({ nextRetryAt: 5000 }), alive: false }).act === 'skip');
ok('超过上限 → give_up',
  guardDecision({ now: 1000, guard: G({ attempts: 3 }), alive: false }).act === 'give_up');
ok('其余 → spawn',
  guardDecision({ now: 1000, guard: G(), alive: false }).act === 'spawn');
ok('force 越过"从没起来过"',
  guardDecision({ now: 0, guard: G({ seenAlive: false }), alive: false, force: true }).act === 'spawn');
ok('force 越过冷却',
  guardDecision({ now: 1000, guard: G({ nextRetryAt: 5000 }), alive: false, force: true }).act === 'spawn');
ok('force 越过上限',
  guardDecision({ now: 1000, guard: G({ attempts: 3 }), alive: false, force: true }).act === 'spawn');
ok('force 永不越过"账号掉线"',
  guardDecision({ now: 0, guard: G(), onebotState: 'offline', alive: false, force: true }).act === 'skip');
ok('force 永不越过"还活着"',
  guardDecision({ now: 0, guard: G(), alive: true, force: true }).act === 'skip');

// ── ② 实例状态机（注入时钟与假拉起）─────────────────────────────────────
const run = async () => {
  let t = 0;
  let launches = 0;
  let alive = false;
  const g = createProtocolGuard({
    probeAlive: async () => alive,
    launch: async () => { launches += 1; return { ok: true, msg: 'fake' }; },
    now: () => t,
    conf: { intervalMs: 999999, maxAttempts: 3, cooldownsMs: [60000, 180000, 540000], readyWaitMs: 90000 },
  });

  let r = await g.runStep();
  ok('没拉起过时第一拍不拉', r.act === 'skip' && launches === 0, JSON.stringify(r));

  g.noteAttempt();
  r = await g.runStep();
  ok('自启发起过之后，进程不在就拉起', r.act === 'spawn' && r.ok === true && launches === 1, JSON.stringify(r));

  r = await g.runStep();
  ok('刚拉起、等端口就绪时不再撞第二次', r.act === 'skip' && launches === 1, JSON.stringify(r));

  alive = true;
  r = await g.runStep();
  ok('端口活了 → 计数清零', r.act === 'skip' && g.stateOf().attempts === 0, JSON.stringify(r));

  alive = false;
  t += 1;
  r = await g.runStep();
  ok('再次死掉 → 重新拉起', r.act === 'spawn' && launches === 2, JSON.stringify(r));

  await g.stop();
  r = await g.runStep();
  ok('stop 之后拒绝任何拉起', r.act === 'skip' && launches === 2, JSON.stringify(r));
};
await run();

// ── ③ 接线（服务器真的用了它们）──────────────────────────────────────────
const server = fs.readFileSync(`${PANEL}server.js`, 'utf8');
ok('停止链 import 了 stopNativeNapcat', /stopNativeNapcat/.test(server));
ok('一键停止按平台分派', /IS_WIN \? false : await cachedDockerUp\(\)/.test(server));
ok('两个停止接口都先停守护', (server.match(/protocolGuard\.stop\(\)/g) || []).length >= 3);
ok('守护只在 Windows 原生协议端上启动',
  /IS_WIN && nativePresent\(\)/.test(server) && /protocolGuard\.start\(\)/.test(server));
ok('守护探测同时看 WebUI 端口（等扫码时不算死）',
  /portOpen\(NAPCAT_WEBUI_PORT\)/.test(server));
ok('手动拉起路由存在', /'\/api\/protocol\/start'/.test(server) && /apiProtocolStart/.test(server));
ok('写路由表含 /api/protocol/start', /'\/api\/stop-all', '\/api\/protocol\/start'/.test(server));
ok('自启把已登录 QQ 传给协议端',
  /knownLoginQq\(\)/.test(server) && /startNativeNapcat\(\{ qq: login\.qq \}\)/.test(server));

if (fails.length) {
  console.log(`协议端守护判据：${pass} 项通过，${fails.length} 项失败`);
  for (const f of fails) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`协议端守护判据：${pass} 项通过，0 项失败`);
console.log('  ✓ 判据阶梯 / 状态机 / 停止链 / 自启接线 都对得上');
