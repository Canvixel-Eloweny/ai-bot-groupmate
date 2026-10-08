// AI 免费额度情报 —— 移植自魔改版 api-deals（精简）
// activate 定时抓 yangmao JSON + linux.do；工具查询 data/api-deals.json

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../../src/config.js';

const FILE = path.join(DATA_DIR, 'api-deals.json');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

let cfg = () => ({});

// ── M-5（2026-10-04 审查轮）：网络出口必须走**宿主提供的受管 fetch** ──────────
// 本包在清单里**已经声明了** `permissions: ["web_fetch"]`，却一直直接用裸 `fetch` ——
// 于是宿主的出站策略（browse-lock 的范围名单 + safe-fetch 的私网/回环判据）**一条都拦不到它**：
// 「声明了权限」≠「走了受管通道」，上面那句声因此是**假的**。
// ⚠️ 默认值给一个会 reject 并说清原因的函数（不是 undefined），没接线时得到人话而不是 TypeError。
let httpFetch = () => Promise.reject(new Error('本扩展包的网络出口未接线（宿主未提供受管 fetch）'));

let log = () => {};
let timer = null;

function maxItems() {
  return Math.max(5, Math.min(200, Number(cfg()?.maxItems) || 40));
}

function keepMs() {
  return Math.max(1, Number(cfg()?.keepDays) || 45) * 86400000;
}

function readStore() {
  try {
    let t = fs.readFileSync(FILE, 'utf8');
    if (t.charCodeAt(0) === 0xFEFF) t = t.slice(1);
    const j = JSON.parse(t);
    return Array.isArray(j.items) ? j : { items: [], lastRefresh: 0 };
  } catch {
    return { items: [], lastRefresh: 0 };
  }
}

function writeStore(store) {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const tmp = `${FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(store, null, 1), 'utf8');
    fs.renameSync(tmp, FILE);
  } catch { /* ignore */ }
}

function pruneItems(items) {
  const cut = Date.now() - keepMs();
  return items
    .filter((x) => (x.at || 0) >= cut)
    .slice(0, maxItems());
}

async function fetchYangmao() {
  const res = await httpFetch('https://yangmao.ai/zh/deals/feed.json', {
    headers: { 'user-agent': UA, accept: 'application/json' },
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) throw new Error(`yangmao HTTP ${res.status}`);
  const j = await res.json();
  const list = Array.isArray(j) ? j : (Array.isArray(j.items) ? j.items : (Array.isArray(j.data) ? j.data : []));
  return list.map((x) => {
    const title = String(x?.title || x?.name || '').trim();
    if (!title) return null;
    const free = x?.free ?? x?.is_free ?? x?.type === 'free';
    const amount = x?.amount || x?.quota || x?.credits || '';
    const deadline = x?.deadline || x?.end_date || x?.expires_at || '';
    return {
      id: String(x?.id || title).slice(0, 80),
      title: title.slice(0, 120),
      brand: String(x?.brand || x?.provider || '').slice(0, 40),
      amount: String(amount).slice(0, 60),
      deadline: String(deadline).slice(0, 40),
      url: String(x?.url || x?.link || '').slice(0, 200),
      source: 'yangmao',
      free: free !== false,
      at: Date.now()
    };
  }).filter(Boolean);
}

async function fetchLinuxDo() {
  const res = await httpFetch('https://linux.do/latest.json', {
    headers: { 'user-agent': UA, accept: 'application/json' },
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) throw new Error(`linux.do HTTP ${res.status}`);
  const j = await res.json();
  const topics = j?.topic_list?.topics || [];
  const re = /(免费|白嫖|额度|credits|free tier|限时|薅)/i;
  return topics
    .filter((t) => re.test(String(t?.title || '')))
    .slice(0, 12)
    .map((t) => ({
      id: `ld-${t.id}`,
      title: String(t.title || '').slice(0, 120),
      brand: '',
      amount: '',
      deadline: '',
      url: `https://linux.do/t/${t.id}`,
      source: 'linux.do',
      free: true,
      at: Date.now()
    }));
}

async function refresh(logFn) {
  const store = readStore();
  const merged = new Map(store.items.map((x) => [x.id, x]));
  const errors = [];
  for (const [name, fn] of [['yangmao', fetchYangmao], ['linux.do', fetchLinuxDo]]) {
    try {
      const items = await fn();
      for (const it of items) merged.set(it.id, it);
    } catch (e) {
      errors.push(`${name}: ${e?.message ?? e}`);
    }
  }
  const items = pruneItems([...merged.values()].sort((a, b) => (b.at || 0) - (a.at || 0)));
  writeStore({ items, lastRefresh: Date.now(), lastError: errors.join('; ') });
  logFn?.(`[api-deals] 刷新完成 ${items.length} 条${errors.length ? `（部分失败 ${errors.length}）` : ''}`);
  return items.length;
}

function maybeRefresh() {
  try {
    if (cfg()?.enabled === false) return;
    const store = readStore();
    const hour = new Date().getHours();
    const target = Number(cfg()?.refreshHour) || 4;
    if (hour !== target) return;
    if (Date.now() - (store.lastRefresh || 0) < 20 * 3600 * 1000) return;
    void refresh(log);
  } catch (e) {
    log('[api-deals]', e?.message ?? e);
  }
}

export function setup(api) {
  cfg = api.config;
  httpFetch = api.fetch;   // M-5：受管出口（声明 web_fetch 才有；否则是会 reject 的替身）
  log = (...a) => api.log?.(...a);

  api.registerTool({
    id: 'api_deals_search',
    name: '搜AI免费额度',
    description: '在本地 AI 免费额度/羊毛情报清单里搜索（关键词/品牌）。结果可能过期，以链接为准。查不到就直说没有。',
    category: 'knowledge',
    icon: '🎁',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '关键词，如 openai / 免费 / credits' },
        limit: { type: 'integer', description: '最多返回条数，默认 8' }
      }
    },
    async execute(_ctx, args) {
      try {
        const store = readStore();
        const q = String(args?.query || '').toLowerCase().trim();
        let items = store.items;
        if (q) {
          items = items.filter((x) =>
            `${x.title} ${x.brand} ${x.amount} ${x.source}`.toLowerCase().includes(q)
          );
        }
        const lim = Math.min(20, Math.max(1, Number(args?.limit) || 8));
        const top = items.slice(0, lim);
        if (!top.length) {
          return {
            content: q
              ? `清单里没有「${args?.query}」相关条目（本地共 ${store.items.length} 条，上次刷新 ${store.lastRefresh ? new Date(store.lastRefresh).toISOString().slice(0, 16) : '从未'}）`
              : '清单是空的，还没抓到数据'
          };
        }
        const lines = top.map((x, i) => {
          const bits = [x.brand, x.amount, x.deadline].filter(Boolean).join(' · ');
          return `${i + 1}. ${x.title}${bits ? `（${bits}）` : ''}${x.url ? `\n   ${x.url}` : ''} [${x.source}]`;
        });
        return {
          content: [`命中 ${top.length} 条：`, ...lines].join('\n')
        };
      } catch (e) {
        return { content: `查询失败：${e?.message ?? e}`, isError: true };
      }
    }
  });

  api.registerTool({
    id: 'api_deals_refresh',
    name: '刷新免费额度',
    description: '立刻重新抓取 AI 免费额度情报源。管理员/群友催更时用；平时不用。',
    category: 'knowledge',
    icon: '🔄',
    parameters: { type: 'object', properties: {} },
    async execute() {
      try {
        const n = await refresh(log);
        return { content: `已刷新，当前 ${n} 条` };
      } catch (e) {
        return { content: `刷新失败：${e?.message ?? e}`, isError: true };
      }
    }
  });
}

export function activate() {
  if (timer) return;
  const tick = () => {
    timer = setTimeout(tick, 20 * 60 * 1000);
    try { maybeRefresh(); } catch { /* ignore */ }
  };
  timer = setTimeout(tick, 15_000);
  log('[api-deals] 已启动定时检查');
}

export function deactivate() {
  if (timer) clearTimeout(timer);
  timer = null;
}
