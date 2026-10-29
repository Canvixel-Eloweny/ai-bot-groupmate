/**
 * 发言账本的只读聚合（面板侧）。
 *
 * 只 import `node:` 内置；`SENT_DIR` / `SENT_FILE_RE` / `dayKeyOf` 由主文件注入
 * （与 `usage-report.js` 同一条纪律：lib 不直接引 `src/`）。
 *
 * ⚠️ 这里只吐**真实记录**。历史日期的「按回复轮次估算」由页面用
 *    `usage.byDay[].agentCalls` 去补，不在读取层混两种口径。
 */
import fs from 'node:fs';
import path from 'node:path';

export function makeSentReport({ SENT_DIR, SENT_FILE_RE, dayKeyOf }) {
  let cache = { sig: '', data: null };

  function listFiles() {
    try {
      return fs.readdirSync(SENT_DIR).filter((name) => SENT_FILE_RE.test(name)).sort();
    } catch {
      return [];
    }
  }

  function signature(files, dayKey) {
    let sig = dayKey;
    for (const name of files) {
      try {
        const st = fs.statSync(path.join(SENT_DIR, name));
        sig += `|${name}:${st.size}:${st.mtimeMs}`;
      } catch {
        sig += `|${name}:missing`;
      }
    }
    return sig;
  }

  function readSent({ now = Date.now(), force = false } = {}) {
    const dayKey = dayKeyOf(new Date(now));
    const files = listFiles();
    const sig = signature(files, dayKey);
    if (!force && cache.data && cache.sig === sig) return cache.data;

    const byDay = new Map();
    let total = 0;
    let lastAt = null;
    let exactFrom = null;
    for (const name of files) {
      let text = '';
      try {
        text = fs.readFileSync(path.join(SENT_DIR, name), 'utf8');
      } catch {
        continue;
      }
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        let row;
        try {
          row = JSON.parse(line);
        } catch {
          continue;
        }
        const t = Number(row?.t);
        const n = Math.max(0, Math.floor(Number(row?.n) || 0));
        if (!Number.isFinite(t) || t <= 0 || n <= 0) continue;
        const day = dayKeyOf(new Date(t));
        byDay.set(day, (byDay.get(day) || 0) + n);
        total += n;
        if (lastAt === null || t > lastAt) lastAt = t;
        if (exactFrom === null || day < exactFrom) exactFrom = day;
      }
    }

    const days = [...byDay.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .slice(-371)
      .map(([key, count]) => ({ key, count }));
    const data = {
      ok: files.length > 0,
      missing: files.length === 0,
      today: byDay.get(dayKey) || 0,
      total,
      lastAt,
      exactFrom,
      byDay: days,
    };
    cache = { sig, data };
    return data;
  }

  return { readSent };
}

/**
 * 总览顶部三张 KPI 的近 14 天序列与「较昨日」基数。
 *
 * 序列日期键只在后端生成（`dayKeyOf` 注入）—— 前端只拿 `MM-DD` 标签，
 * 不自己拼日期（H-11①）。`messages` 用 `heat.days`（已分精确/估算），
 * `tokens` / `cost` 用 `usage.byDay`（同一天同一份账）。
 */
export function makeOverviewKpi({ dayKeyOf, days = 14 } = {}) {
  const span = Math.max(7, Math.min(30, Math.floor(Number(days) || 14)));
  return function kpiOf({ sent, usage, heat, now = Date.now() } = {}) {
    const base = new Date(now);
    base.setHours(12, 0, 0, 0);
    const keys = [];
    for (let i = span - 1; i >= 0; i -= 1) {
      const d = new Date(base);
      d.setDate(base.getDate() - i);
      keys.push(dayKeyOf(d));
    }
    const heatByDay = new Map((heat?.days || []).map((x) => [String(x.key), x]));
    const usageByDay = new Map((usage?.byDay || []).map((x) => [String(x.key), x]));
    const series = keys.map((key) => {
      const h = heatByDay.get(key);
      const u = usageByDay.get(key);
      return {
        key,
        label: key.slice(5),
        msgs: h ? Number(h.count) || 0 : 0,
        est: !!(h && h.estimated),
        tokens: u ? Number(u.tokens) || 0 : 0,
        cost: u ? Number(u.cost) || 0 : 0,
      };
    });
    const last = series[series.length - 1] || null;
    const prev = series[series.length - 2] || null;
    const sentOk = sent?.ok === true;
    return {
      today: last ? last.key : '',
      days: span,
      messages: {
        today: sentOk ? Number(sent.today) || 0 : null,
        prev: prev ? prev.msgs : null,
        prevEst: !!(prev && prev.est),
        series: series.map((x) => ({ key: x.label, v: x.msgs, est: x.est })),
      },
      tokens: {
        today: last ? last.tokens : 0,
        prev: prev ? prev.tokens : 0,
        series: series.map((x) => ({ key: x.label, v: x.tokens })),
      },
      cost: {
        today: last ? last.cost : 0,
        prev: prev ? prev.cost : 0,
        series: series.map((x) => ({ key: x.label, v: x.cost })),
      },
    };
  };
}

/**
 * 运行总览的 16 周发言网格。
 *
 * ⚠️ 日期键只在后端生成（`dayKeyOf` 由主文件注入）—— 前端不再自己拼
 *    `YYYY-MM-DD`（H-11①：本地日期键只有一份实现）。
 * `sent` 是精确逐条计数；`usage.byDay[].agentCalls` 只用于**早于精确计数起点**的
 * 历史补齐，返回的每一天都带 `exact / estimated`，页面只负责画。
 */
export function makeOverviewHeat({ dayKeyOf, weeks = 16 } = {}) {
  const spanWeeks = Math.max(1, Math.min(53, Math.floor(Number(weeks) || 16)));
  const totalDays = spanWeeks * 7;
  return function heatOf({ sent, usage, now = Date.now() } = {}) {
    const base = new Date(now);
    base.setHours(12, 0, 0, 0);
    const today = dayKeyOf(base);
    const dow = (base.getDay() + 6) % 7;
    const start = new Date(base);
    start.setDate(base.getDate() - dow - (spanWeeks - 1) * 7);
    const weekStart = new Date(base);
    weekStart.setDate(base.getDate() - dow);
    const weekKey = dayKeyOf(weekStart);

    const sentOk = sent?.ok === true;
    const exactFrom = sent?.exactFrom || '';
    const exactMap = new Map((sent?.byDay || []).map((x) => [String(x.key), Number(x.count) || 0]));
    const estMap = new Map((usage?.byDay || []).map((x) => [String(x.key), Number(x.agentCalls) || 0]));

    const days = [];
    const months = [];
    let lastMonth = '';
    let weekCount = 0;
    let peakCount = 0;
    let total = 0;
    let activeDays = 0;
    for (let col = 0; col < spanWeeks; col += 1) {
      const first = new Date(start);
      first.setDate(start.getDate() + col * 7);
      const firstKey = dayKeyOf(first);
      const month = `${Number(firstKey.slice(5, 7))}月`;
      if (col === 0 || month !== lastMonth) {
        months.push({ label: month, col });
        lastMonth = month;
      }
    }
    for (let i = 0; i < totalDays; i += 1) {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      const key = dayKeyOf(d);
      const future = key > today;
      let count = 0;
      let estimated = false;
      let exact = false;
      if (!future) {
        if (sentOk && exactFrom && key >= exactFrom) {
          count = exactMap.get(key) || 0;
          exact = true;
        } else {
          count = estMap.get(key) || 0;
          estimated = count > 0;
        }
        if (key >= weekKey) weekCount += count;
        if (count > peakCount) peakCount = count;
        total += count;
        if (count > 0) activeDays += 1;
      }
      days.push({ key, future, count, estimated, exact });
    }

    let streak = 0;
    for (let i = days.length - 1; i >= 0; i -= 1) {
      if (days[i].future) continue;
      if (days[i].count > 0) streak += 1;
      else break;
    }
    return {
      today, weeks: spanWeeks, days, months, weekCount, peakCount,
      total, activeDays, streak, exactFrom: exactFrom || null,
    };
  };
}
