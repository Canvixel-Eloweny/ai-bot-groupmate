// 远程价格表 —— 移植自魔改版 price-feed.js（零侵入：经 setRemotePrices 注入）

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../../src/config.js';
import { setRemotePrices, remoteOverrideCount } from '../../src/model-prices.js';

const CACHE_FILE = path.join(DATA_DIR, 'price-feed-cache.json');
const TICK_MS = 3600 * 1000;

let cfg = () => ({});
let log = () => {};
let timer = null;

const status = {
  url: '',
  source: 'builtin',
  fetchedAt: 0,
  ok: false,
  error: '',
  count: 0,
  dropped: 0
};

function normEntry(v) {
  if (!v || typeof v !== 'object') return null;
  const i = Number(v.in), o = Number(v.out);
  if (!Number.isFinite(i) && !Number.isFinite(o)) return null;
  const e = {
    in: Number.isFinite(i) ? i : 0,
    out: Number.isFinite(o) ? o : 0,
    cached: v.cached == null ? null : (Number.isFinite(Number(v.cached)) ? Number(v.cached) : null)
  };
  if (v.peak && typeof v.peak === 'object') e.peak = { ...v.peak };
  if (v.image && typeof v.image === 'object') e.image = v.image;
  if (typeof v.note === 'string' && v.note) e.note = v.note;
  e.src = typeof v.src === 'string' && v.src ? v.src : 'remote';
  return e;
}

export function normalizePriceFeed(data) {
  if (!data || typeof data !== 'object') return null;
  let pairs = [];
  if (Array.isArray(data)) pairs = data.map((x) => [x?.id, x]);
  else if (Array.isArray(data.prices)) pairs = data.prices.map((x) => [x?.id, x]);
  else if (data.prices && typeof data.prices === 'object') pairs = Object.entries(data.prices);
  else pairs = Object.entries(data).filter(([k]) => !/^(updated|version|meta|comment)$/i.test(k));

  const prices = {};
  let dropped = 0;
  for (const [id, v] of pairs) {
    const key = String(id ?? '').trim().toLowerCase();
    const e = normEntry(v);
    if (!key || !e) { dropped++; continue; }
    prices[key] = e;
  }
  if (!Object.keys(prices).length && dropped) return null;
  return { prices, dropped };
}

function applyPrices(prices, source) {
  setRemotePrices(prices);
  status.source = source;
  status.count = Object.keys(prices).length;
}

function applyDiskCache(url) {
  try {
    const data = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    if (data?.url !== url) return false;
    const norm = normalizePriceFeed(data.prices);
    if (!norm) return false;
    applyPrices(norm.prices, 'cache');
    status.dropped = norm.dropped;
    return true;
  } catch {
    return false;
  }
}

function saveCache(url, prices) {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    const tmp = `${CACHE_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ url, prices, at: Date.now() }, null, 1), 'utf8');
    fs.renameSync(tmp, CACHE_FILE);
  } catch { /* ignore */ }
}

async function fetchOnce(url) {
  status.fetchedAt = Date.now();
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': 'qq-agent-price-feed/1.0' },
      signal: AbortSignal.timeout(10000)
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const norm = normalizePriceFeed(data);
    if (!norm) throw new Error('载荷无法解析成价格表');
    applyPrices(norm.prices, 'remote');
    status.dropped = norm.dropped;
    status.ok = true;
    status.error = '';
    saveCache(url, data);
    log(`[price-feed] 已更新远程价格表 ${norm.dropped ? `(丢弃 ${norm.dropped})` : ''} 共 ${Object.keys(norm.prices).length} 条`);
  } catch (e) {
    status.ok = false;
    status.error = String(e?.message ?? e);
    log(`[price-feed] 拉取失败：${status.error}（继续用缓存/内置表）`);
  }
}

function checkSchedule() {
  const c = cfg() || {};
  if (c.enabled === false) return;
  const url = String(c.url || '').trim();
  if (!url) return;
  const refreshMs = Math.max(1, Number(c.refreshHours) || 24) * 3600 * 1000;
  const retryMs = Math.max(1, Number(c.retryHours) || 3) * 3600 * 1000;
  const due = status.ok
    ? Date.now() - status.fetchedAt >= refreshMs
    : Date.now() - status.fetchedAt >= retryMs;
  if (status.url !== url) {
    status.url = url;
    applyDiskCache(url);
    status.fetchedAt = 0;
  }
  if (due || !status.fetchedAt) {
    void fetchOnce(url);
  }
}

export function setup(a) {
  cfg = a.config;
  log = (...args) => a.log?.(...args);
}

export function activate() {
  if (timer) return;
  const tick = () => {
    timer = setTimeout(tick, TICK_MS);
    try { checkSchedule(); } catch (e) { log('[price-feed] tick', e?.message ?? e); }
  };
  timer = setTimeout(tick, 8000);
  log('[price-feed] 已启动');
}

export function deactivate() {
  if (timer) clearTimeout(timer);
  timer = null;
}
