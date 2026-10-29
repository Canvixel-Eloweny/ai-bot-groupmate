/**
 * 发言账本 + usage.byDay.agentCalls 的最小回归。
 *
 * 只碰临时目录；不写真实 panel 数据。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { dayKeyOf } from '../src/holidays.js';
import { recordSentRound } from '../src/sent-stats.js';
import { makeSentReport, makeOverviewHeat, makeOverviewKpi } from '../panel/lib/sent-report.js';
import { makeUsageReport } from '../panel/lib/usage-report.js';

const SENT_RE = /^sent(-\d{4}-\d{2})?\.jsonl$/;
const USAGE_RE = /^usage(-\d{4}-\d{2})?\.jsonl$/;
let passed = 0;
let sentDir = '';
let usageDir = '';
const oldSentFile = process.env.QQBOT_SENT_FILE;

function ok(cond, msg) {
  assert.ok(cond, msg);
  passed += 1;
}

try {
  sentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-sent-'));
  usageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-usage-'));
  const sentFile = path.join(sentDir, 'sent-2026-10.jsonl');
  process.env.QQBOT_SENT_FILE = sentFile;

  const tPrev = new Date(2026, 9, 26, 23, 59, 0).getTime();
  const tToday1 = new Date(2026, 9, 27, 0, 1, 0).getTime();
  const tToday2 = new Date(2026, 9, 27, 8, 0, 0).getTime();
  recordSentRound({ n: 2, at: tPrev, chatKey: 'group:1' });
  recordSentRound({ n: 1, at: tToday1, chatKey: 'private:2' });
  recordSentRound({ n: 3, at: tToday2, chatKey: 'group:1' });
  recordSentRound({ n: 0, at: tToday2 }); // 0 不记
  recordSentRound({ n: -2, at: tToday2 }); // 负数不记

  const report = makeSentReport({ SENT_DIR: sentDir, SENT_FILE_RE: SENT_RE, dayKeyOf });
  const now = new Date(2026, 9, 27, 12, 0, 0).getTime();
  const got = report.readSent({ now });
  ok(got.ok === true, '有账本文件时 ok=true');
  ok(got.today === 4, `今日按 n 求和 = 4（实得 ${got.today}）`);
  ok(got.total === 6, `累计 = 6（实得 ${got.total}）`);
  ok(got.exactFrom === '2026-10-26', 'exactFrom 取最早真实记录日');
  ok(got.lastAt === tToday2, 'lastAt 取最新记录');
  ok(got.byDay.length === 2 && got.byDay[0].key === '2026-10-26' && got.byDay[0].count === 2
    && got.byDay[1].key === '2026-10-27' && got.byDay[1].count === 4, '按天聚合正确');

  fs.appendFileSync(sentFile, 'not json\n{"t":"x","n":2}\n{"t":' + tToday2 + ',"n":-5}\n');
  const got2 = report.readSent({ now, force: true });
  ok(got2.total === 6 && got2.today === 4, '坏行 / 非正数被跳过');

  const blocker = path.join(sentDir, 'blocker');
  fs.writeFileSync(blocker, 'x');
  process.env.QQBOT_SENT_FILE = path.join(blocker, 'sent.jsonl');
  let threw = false;
  try {
    recordSentRound({ n: 1, at: tToday2 });
  } catch {
    threw = true;
  }
  ok(threw === false, '写盘失败不能抛（发送不能被统计拖垮）');
  process.env.QQBOT_SENT_FILE = sentFile;

  const ufile = path.join(usageDir, 'usage-2026-10.jsonl');
  const base = { t: tToday2, model: 'm', b: '', v: '', local: true, think: 'off', level: 'low', p: 10, c: 2, r: 0, h: 0, a: 1, k: 'group:1' };
  fs.writeFileSync(ufile, [
    JSON.stringify({ ...base, s: 'agent' }),
    JSON.stringify({ ...base, s: 'memoryJudge' }),
    JSON.stringify({ ...base, s: '' }),
  ].join('\n') + '\n');
  const usage = makeUsageReport({
    USAGE_DIR: usageDir,
    USAGE_FILE_RE: USAGE_RE,
    MODEL_LABELS: {},
    quotaOf: () => ({ kind: 'local', free: true, why: '' }),
    QUOTA_KIND: { local: 'local', official: 'official', grant: 'grant', paid: 'paid' },
    isLocalBase: () => true,
    dayKeyOf,
    USAGE_SOURCES: { agent: 'agent', memoryJudge: 'memoryJudge', proactiveTopic: 'proactiveTopic', nightly: 'nightly' },
  });
  const u = usage.readUsage();
  ok(u.byDay.length === 1, 'byDay 只有一天');
  ok(u.byDay[0].calls === 3, `byDay.calls 仍是全部调用 = 3（实得 ${u.byDay[0].calls}）`);
  ok(u.byDay[0].agentCalls === 1, `byDay.agentCalls 只数主回复 = 1（实得 ${u.byDay[0].agentCalls}）`);

  const heat = makeOverviewHeat({ dayKeyOf, weeks: 16 })({
    sent: {
      ok: true,
      exactFrom: '2026-10-26',
      byDay: [{ key: '2026-10-26', count: 2 }, { key: '2026-10-27', count: 4 }],
    },
    usage: { byDay: [{ key: '2026-10-25', agentCalls: 7 }] },
    now: new Date(2026, 9, 27, 12, 0, 0).getTime(),
  });
  const day = (key) => heat.days.find((x) => x.key === key);
  ok(heat.days.length === 112, '热力网格 = 16 周 × 7 天');
  ok(heat.today === '2026-10-27', 'today 由注入的 dayKeyOf 生成');
  ok(day('2026-10-25')?.count === 7 && day('2026-10-25')?.estimated === true, '精确计数起点之前用 agentCalls 估算');
  ok(day('2026-10-26')?.count === 2 && day('2026-10-26')?.exact === true, '精确起点当天用 sent.byDay');
  ok(day('2026-10-27')?.count === 4 && day('2026-10-27')?.exact === true, '今天用精确条数');
  ok(heat.weekCount === 6, `本周（周一起）= 6（实得 ${heat.weekCount}）`);
  ok(heat.peakCount === 7, `峰值 = 7（实得 ${heat.peakCount}）`);
  ok(heat.streak === 3, `连续 = 3（实得 ${heat.streak}）`);
  ok(heat.total === 13, `16 周总条数 = 13（实得 ${heat.total}）`);
  ok(heat.activeDays === 3, `活跃天数 = 3（实得 ${heat.activeDays}）`);
  ok(heat.months.length >= 1 && heat.months.every((m) => m.col >= 0 && /月$/.test(m.label)), '月份标签由后端生成并带列位置');

  const kpi = makeOverviewKpi({ dayKeyOf, days: 14 })({
    sent: { ok: true, today: 4, byDay: [{ key: '2026-10-26', count: 2 }, { key: '2026-10-27', count: 4 }] },
    usage: {
      byDay: [
        { key: '2026-10-26', tokens: 100, cost: 0.1 },
        { key: '2026-10-27', tokens: 200, cost: 0.2 },
      ],
    },
    heat,
    now: new Date(2026, 9, 27, 12, 0, 0).getTime(),
  });
  ok(kpi.days === 14 && kpi.messages.series.length === 14, 'KPI 近 14 天序列 = 14 天');
  ok(kpi.messages.today === 4, `KPI 今日发言 = 4（实得 ${kpi.messages.today}）`);
  ok(kpi.messages.prev === 2, `KPI 昨日发言取热力口径 = 2（实得 ${kpi.messages.prev}）`);
  ok(kpi.tokens.today === 200 && kpi.tokens.prev === 100, 'KPI Token 今日/昨日来自 usage.byDay');
  ok(kpi.cost.today === 0.2 && kpi.cost.prev === 0.1, 'KPI 花费今日/昨日来自 usage.byDay');
  ok(kpi.messages.series.at(-1).key === '10-27' && kpi.messages.series.at(-1).v === 4, 'KPI 序列末点 = 今天（MM-DD 标签）');
  ok(kpi.messages.series.at(-2).key === '10-26' && kpi.messages.series.at(-2).v === 2, 'KPI 序列倒数第二点 = 昨天');
  ok(kpi.messages.series.some((x) => x.est === true), 'KPI 发言序列保留估算标记');
  const kpiNoSent = makeOverviewKpi({ dayKeyOf, days: 14 })({ sent: { ok: false }, usage: { byDay: [] }, heat, now: new Date(2026, 9, 27, 12, 0, 0).getTime() });
  ok(kpiNoSent.messages.today === null, '没有发言账本时今日发言为 null（页面显示 —）');
  ok(kpiNoSent.tokens.today === 0 && kpiNoSent.tokens.prev === 0, '没有用量时 Token 序列全 0');

  console.log(`PASS check-sent-stats · ${passed} 项`);
} finally {
  if (oldSentFile === undefined) delete process.env.QQBOT_SENT_FILE;
  else process.env.QQBOT_SENT_FILE = oldSentFile;
  for (const dir of [sentDir, usageDir]) {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
}
