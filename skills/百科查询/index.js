// 多源百科查询 —— 移植自魔改包 wiki.js（简化）
// 走 MediaWiki action API 的 extracts；失败时试 REST summary。

let cfg = () => ({});
let log = () => {};
// ── M-5（2026-10-04 审查轮）：网络出口必须走**宿主提供的受管 fetch** ──────────
// 本包在清单里**已经声明了** `permissions: ["web_fetch"]`，却一直直接用裸 `fetch` ——
// 于是宿主的出站策略（`src/browse-lock.js` 的范围名单 + `src/safe-fetch.js` 的
// 私网/回环/云元数据判据）**一条都拦不到它**：声明了权限≠走了受管通道。
// 上面那句"声明"因此是**假的**（看着有约束，实际没有），这正是本项目最忌讳的形状。
// ⚠️ 默认值给一个**会 reject 并说清原因**的函数（不是 `undefined`）：
//    没接线时 `httpFetch(...)` 得到一句人话，而不是 `TypeError: not a function`。
let httpFetch = () => Promise.reject(new Error('本扩展包的网络出口未接线（宿主未提供受管 fetch）'));

function sources() {
  const c = cfg() || {};
  const list = [];
  const def = String(c.defaultSource || '').trim();
  if (def) list.push({ id: 'default', label: '默认百科', baseUrl: def.replace(/\/+$/, '') });
  if (Array.isArray(c.sources)) {
    for (const s of c.sources) {
      const baseUrl = String(s?.baseUrl || '').replace(/\/+$/, '');
      if (!baseUrl || s?.enabled === false) continue;
      list.push({
        id: String(s.id || baseUrl),
        label: String(s.label || baseUrl),
        baseUrl
      });
    }
  }
  if (!list.length) {
    list.push({ id: 'zhwiki', label: '中文维基', baseUrl: 'https://zh.wikipedia.org/api/rest_v1' });
  }
  return list;
}

function limitChars() {
  return Math.max(200, Math.min(4000, Number(cfg()?.limitChars) || 1200));
}

function cleanText(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limitChars());
}

async function fetchExtract(baseUrl, title) {
  // REST summary
  const rest = `${baseUrl}/page/summary/${encodeURIComponent(title)}`;
  const r = await httpFetch(rest, {
    headers: { 'User-Agent': 'qq-agent-skill/1.0' },
    signal: AbortSignal.timeout(15000)
  });
  if (r.ok) {
    const j = await r.json();
    const extract = cleanText(j.extract || j.description || '');
    if (extract) {
      return {
        title: j.title || title,
        extract,
        url: j.content_urls?.desktop?.page || '',
        source: baseUrl
      };
    }
  }
  // action API fallback
  const apiBase = baseUrl.replace(/\/api\/rest_v1\/?$/, '');
  const api = `${apiBase}/w/api.php?action=query&format=json&prop=extracts&exintro=1&explaintext=1&redirects=1&titles=${encodeURIComponent(title)}`;
  const r2 = await httpFetch(api, {
    headers: { 'User-Agent': 'qq-agent-skill/1.0' },
    signal: AbortSignal.timeout(15000)
  });
  if (!r2.ok) return null;
  const j2 = await r2.json();
  const pages = j2?.query?.pages || {};
  const page = Object.values(pages)[0];
  if (!page || page.missing !== undefined) return null;
  const extract = cleanText(page.extract || '');
  if (!extract) return null;
  return {
    title: page.title || title,
    extract,
    url: '',
    source: baseUrl
  };
}

export function setup(api) {
  cfg = api.config;
  log = (...a) => api.log?.(...a);
  httpFetch = api.fetch;   // M-5：受管出口（声明了 web_fetch 才有；否则它是会 reject 的替身）

  api.registerTool({
    id: 'wiki_lookup',
    name: '查百科',
    description: '按标题查询外部百科/设定条目，返回摘要。用于人物出处、作品设定、名词解释。查不到会明说。',
    category: 'knowledge',
    icon: '📖',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '条目标题，如「初音未来」' },
        source: { type: 'string', description: '可选：指定源 id 或 baseUrl' }
      },
      required: ['title']
    },
    async execute(_ctx, args) {
      try {
        const title = String(args?.title || '').trim();
        if (!title) return { content: '缺 title', isError: true };
        const srcList = sources();
        const key = String(args?.source || '').trim();
        const ordered = key
          ? [...srcList.filter((s) => s.id === key || s.baseUrl === key), ...srcList.filter((s) => s.id !== key && s.baseUrl !== key)]
          : srcList;

        const errors = [];
        for (const s of ordered) {
          try {
            const hit = await fetchExtract(s.baseUrl, title);
            if (hit) {
              const tail = hit.url ? `\n链接：${hit.url}` : '';
              return { content: `【${hit.title}】\n${hit.extract}${tail}\n（来源：${s.label}）` };
            }
          } catch (e) {
            errors.push(`${s.label}: ${e?.message ?? e}`);
          }
        }
        return {
          content: errors.length
            ? `百科查询失败：${errors.join('；')}`
            : `百科里没有「${title}」的条目`,
          isError: true
        };
      } catch (e) {
        return { content: `百科查询出错：${e?.message ?? e}`, isError: true };
      }
    }
  });
}
