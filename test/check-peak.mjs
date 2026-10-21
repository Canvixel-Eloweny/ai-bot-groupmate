/**
 * 「峰谷闸」的判据（C 改造）。
 *
 * 跑法：`node test/check-peak.mjs`
 * 为什么单独一个文件：判据全是**零依赖纯函数**（`now` 入参），两秒能定位；
 * smoke 要起假 OneBot + 假模型，改一行等一分钟。
 *
 * ⚠️ 这里**不假造时钟**：`peakWindowOf(now)` 直接吃毫秒时间戳，
 *    所以"工作日 10 点"这种断言是喂进去的，不是等出来的。
 */
const SRC = new URL('../src/', import.meta.url).pathname;
const { PEAK_WINDOWS, PEAK_DEFAULTS, readPeak, peakWindowOf, peakSkipReason, peakQuietForProactive } =
  await import(`${SRC}peak.js`);

let pass = 0;
const fails = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass += 1; return; }
  fails.push(detail ? `${name} —— ${detail}` : name);
};
const at = (y, m, d, hh, mm = 0) => new Date(y, m - 1, d, hh, mm, 0, 0).getTime();
// 2026-10-19 是周一；2026-10-24 是周六。用固定日期，别让断言随"今天"漂。
const MON = (hh, mm) => at(2026, 10, 19, hh, mm);
const SAT = (hh, mm) => at(2026, 10, 24, hh, mm);
const group = (now, extra = {}) => peakSkipReason({ now, scene: 'group', peak: PEAK_DEFAULTS, ...extra });

// ── ① 时间窗与星期 ──────────────────────────────────────────────────────
ok('窗口就是那两段（一份数字，别处不许再写）',
  PEAK_WINDOWS.length === 2 && PEAK_WINDOWS[0].from === 540 && PEAK_WINDOWS[0].to === 720
  && PEAK_WINDOWS[1].from === 840 && PEAK_WINDOWS[1].to === 1080);
ok('工作日 09:00 落在第一段', peakWindowOf(MON(9, 0))?.label === '09:00–12:00');
ok('工作日 11:59 仍在第一段', peakWindowOf(MON(11, 59))?.label === '09:00–12:00');
ok('12:00 是右开边界（谷）', peakWindowOf(MON(12, 0)) === null);
ok('13:00 是谷', peakWindowOf(MON(13, 0)) === null);
ok('14:00 落在第二段', peakWindowOf(MON(14, 0))?.label === '14:00–18:00');
ok('17:59 仍在第二段', peakWindowOf(MON(17, 59))?.label === '14:00–18:00');
ok('18:00 是右开边界（谷）', peakWindowOf(MON(18, 0)) === null);
ok('工作日 08:00 / 23:00 都不是高峰', peakWindowOf(MON(8, 0)) === null && peakWindowOf(MON(23, 0)) === null);
ok('周六 10:00 不是高峰（只算工作日）', peakWindowOf(SAT(10, 0)) === null);
ok('周六 15:00 也不是', peakWindowOf(SAT(15, 0)) === null);

// ── ② 「算不算被叫到」────────────────────────────────────────────────────
const r = group(MON(10, 0));
ok('群聊高峰、没人叫它 → 不出声', r.includes('高峰时段') && r.includes('09:00–12:00'), r);
ok('私聊高峰照样出声（没有沉默档）', peakSkipReason({ now: MON(10, 0), scene: 'private', peak: PEAK_DEFAULTS }) === '');
ok('被 @ 了照回', group(MON(10, 0), { mentionedSelf: true }) === '');
ok('引用了我的话也算被叫到', group(MON(10, 0), { repliedToMe: true }) === '');
ok('命中触发词也算被叫到', group(MON(10, 0), { keywordHit: true }) === '');
ok('拍一拍不算"话"，但算打招呼 → 不拦', group(MON(10, 0), { isPoke: true }) === '');
ok('谷时段不拦', group(MON(13, 0)) === '' && group(MON(19, 0)) === '');
ok('周末不拦', group(SAT(10, 0)) === '');
ok('两个窗口各报各的时间', group(MON(15, 0)).includes('14:00–18:00'));

// ── ③ 配置 ──────────────────────────────────────────────────────────────
ok('默认是开的，且高峰里不搭话', readPeak(undefined).enabled === true && readPeak(undefined).muteUnmentioned === true);
ok('只认真的是 true（字符串不算）', readPeak({ enabled: 'true', muteUnmentioned: 'yes' }).enabled === false);
ok('total 关掉 → 一条都不拦', group(MON(10, 0), { peak: { enabled: false, muteUnmentioned: true } }) === '');
ok('只关"不搭话"那半 → 也不拦', group(MON(10, 0), { peak: { enabled: true, muteUnmentioned: false } }) === '');
ok('主动开口的判据：高峰拦 / 谷放行 / 关掉放行',
  peakQuietForProactive(MON(10, 0), PEAK_DEFAULTS).includes('不主动找话')
  && peakQuietForProactive(MON(13, 0), PEAK_DEFAULTS) === ''
  && peakQuietForProactive(MON(10, 0), { enabled: false }) === '');

// ── ④ 接线（只断言"忘了接"会红的几处）──────────────────────────────────
{
  const fs = await import('node:fs');
  const indexJs = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  const customJs = fs.readFileSync(new URL('../src/custom-config.js', import.meta.url), 'utf8');
  ok('主链路有这道门禁，且写了一条 stage=peak 的 skip（为什么不回要查得到）',
    /const peakReason = peakSkipReason\(\{/.test(indexJs) && /stage: 'peak'/.test(indexJs));
  ok('门禁在未读消费之前（跳过时如实 null）',
    /stage: 'peak'[\s\S]{0,400}unread: null/.test(indexJs));
  ok('主动话题也过同一道判据（定时消息不受限）',
    /peakQuietForProactive\(now\.getTime\(\), readPeak\(c\.peak\)\)/.test(indexJs)
    && indexJs.indexOf('peakQuietForProactive(now.getTime()') > indexJs.indexOf("const p = c.trigger?.proactive;"));
  ok('配置归一化进了 readCustom()', /peak: readPeak\(c\.peak\)/.test(customJs));
  const schemaJs = fs.readFileSync(new URL('../panel/next/schema.js', import.meta.url), 'utf8');
  ok('面板上有总闸与「没被叫到不接话」两格（否则用户只能手改 config.json）',
    /id: 'peak', label: '峰谷/.test(schemaJs)
    && /bind: 'peak\.enabled'/.test(schemaJs) && /bind: 'peak\.muteUnmentioned'/.test(schemaJs));
}

if (fails.length) {
  console.log(`峰谷闸判据：${pass} 项通过，${fails.length} 项失败`);
  for (const f of fails) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`峰谷闸判据：${pass} 项通过，0 项失败`);
console.log('  ✓ 时间窗 / 工作日 / 被叫到 / 配置 / 接线 都对得上');
