const BASE = 'http://127.0.0.1:8788';
const st = async () => (await fetch(BASE + '/api/state')).json();
const before = await st();
console.log('重启前 pid =', before.panel.pid, '｜stale =', before.panel.stale);
if (!before.panel.stale) { console.log('代码没变，不需要重启'); process.exit(0); }
const r = await (await fetch(BASE + '/api/panel/restart', { method: 'POST' })).json();
console.log('重启接口返回：', JSON.stringify(r));
const t0 = Date.now();
let ok = null;
while (Date.now() - t0 < 40000) {
  await new Promise((z) => setTimeout(z, 700));
  try { const s = await st(); if (s.panel.pid !== before.panel.pid) { ok = s; break; } } catch {}
}
if (!ok) { console.log('❌ 面板没起来'); process.exit(1); }
console.log(`新 pid = ${ok.panel.pid}｜stale = ${ok.panel.stale}`);
console.log('custom.playRules =', ok.custom.playRules, '｜customMeta.playRules =', ok.customMeta.playRules.length, '条');
console.log('featureLabels =', JSON.stringify(ok.featureLabels));
console.log('幂等复验：', JSON.stringify(await (await fetch(BASE + '/api/panel/restart', { method: 'POST' })).json()));
const after = await st();
console.log('复验后 pid =', after.panel.pid, after.panel.pid === ok.panel.pid ? '（没被误重启 ✓）' : '（✗ 被重启了）');
