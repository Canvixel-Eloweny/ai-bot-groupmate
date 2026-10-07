// B 站视频解析（不下载）—— 移植自魔改版 bilibili.js 的精简子集

let cfg = () => ({});

// ── M-5（2026-10-04 审查轮）：网络出口必须走**宿主提供的受管 fetch** ──────────
// 本包在清单里**已经声明了** `permissions: ["web_fetch"]`，却一直直接用裸 `fetch` ——
// 于是宿主的出站策略（browse-lock 的范围名单 + safe-fetch 的私网/回环判据）**一条都拦不到它**：
// 「声明了权限」≠「走了受管通道」，上面那句声因此是**假的**。
// ⚠️ 默认值给一个会 reject 并说清原因的函数（不是 undefined），没接线时得到人话而不是 TypeError。
let httpFetch = () => Promise.reject(new Error('本扩展包的网络出口未接线（宿主未提供受管 fetch）'));

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function cookie() {
  return String(cfg()?.cookie || '').trim();
}

function parseIds(rawUrl) {
  let u = String(rawUrl || '')
    .replace(/[　 ]/g, ' ')
    .trim()
    .replace(/／/g, '/')
    .replace(/[Ａ-Ｚａ-ｚ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0));
  const bv = /(BV[0-9A-Za-z]{10})/i.exec(u);
  const av = /(?:av|AV)(\d+)/.exec(u);
  const urlBv = /bilibili\.com\/video\/(BV[0-9A-Za-z]{10})/i.exec(u);
  const b23 = /b23\.tv\/\w+/i.exec(u);
  return {
    bvid: (bv?.[1] || urlBv?.[1] || '').trim(),
    aid: (av?.[1] || '').trim(),
    isShort: Boolean(b23)
  };
}

async function get(url) {
  const res = await httpFetch(url, {
    headers: {
      'user-agent': UA,
      origin: 'https://www.bilibili.com',
      referer: 'https://www.bilibili.com/',
      ...(cookie() ? { cookie: cookie() } : {})
    },
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) throw new Error(`B站 HTTP ${res.status}`);
  return res.json();
}

async function resolveUrl(url) {
  if (!/b23\.tv/i.test(url)) return url;
  try {
    const res = await httpFetch(url, {
      method: 'GET',
      redirect: 'follow',
      headers: { 'user-agent': UA },
      signal: AbortSignal.timeout(8000)
    });
    return res.url || url;
  } catch {
    return url;
  }
}

function fmtDuration(sec) {
  const n = Math.max(0, Number(sec) || 0);
  const h = Math.floor(n / 3600);
  const m = Math.floor((n % 3600) / 60);
  const s = Math.floor(n % 60);
  if (h) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

async function fetchInfo(url) {
  const resolved = await resolveUrl(url);
  let ids = parseIds(resolved);
  if (!ids.bvid && !ids.aid) {
    // BV1xx411c7mD 格式有时只在路径里
    const m = /(BV[0-9A-Za-z]{10})/i.exec(resolved);
    if (m) ids = { bvid: m[1], aid: '', isShort: false };
  }
  if (!ids.bvid && !ids.aid) throw new Error('解析不出 BV/av 号');

  const q = ids.bvid ? `bvid=${encodeURIComponent(ids.bvid)}` : `aid=${ids.aid}`;
  const j = await get(`https://api.bilibili.com/x/web-interface/view?${q}`);
  if (j.code !== 0) throw new Error(`B站接口 code=${j.code} ${j.message || ''}`);
  const d = j.data || {};
  const limit = Math.max(200, Number(cfg()?.maxSubtitleChars) || 4000);

  const out = {
    bvid: d.bvid || ids.bvid,
    aid: d.aid || ids.aid,
    title: String(d.title || ''),
    owner: String(d.owner?.name || ''),
    mid: Number(d.owner?.mid) || 0,
    durationSec: Number(d.duration) || 0,
    view: Number(d.stat?.view) || 0,
    like: Number(d.stat?.like) || 0,
    desc: String(d.desc || '').replace(/\s+/g, ' ').slice(0, limit),
    url: `https://www.bilibili.com/video/${d.bvid || ids.bvid}`,
    published: d.pubdate ? new Date(d.pubdate * 1000).toISOString().slice(0, 16) : ''
  };

  // 热评（可选）
  if (cfg()?.hotComments !== false && out.aid) {
    try {
      const r = await get(`https://api.bilibili.com/x/v2/reply?type=1&oid=${out.aid}&pn=1&ps=10&sort=1`);
      const list = Array.isArray(r?.data?.replies) ? r.data.replies : [];
      out.hotComments = list
        .map((x) => String(x?.content?.message || '').replace(/\s+/g, ' ').trim())
        .filter((s) => s && s.length >= 3)
        .slice(0, 6);
    } catch { /* 热评失败不致命 */ }
  }

  return out;
}

export function setup(api) {
  cfg = api.config;
  httpFetch = api.fetch;   // M-5：受管出口（声明 web_fetch 才有；否则是会 reject 的替身）
  api.registerTool({
    id: 'bili_info',
    name: '解析B站视频',
    description: '解析 B 站链接的标题/UP主/时长/简介（可选热评）。用于「这视频讲啥」；要下载转发请用 media-download 能力，不要用本工具。',
    category: 'media',
    icon: '📺',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'B站视频链接或 BV 号' },
        withComments: { type: 'boolean', description: '是否附热评（默认按设置）' }
      },
      required: ['url']
    },
    async execute(_ctx, args) {
      try {
        let url = String(args?.url || '').trim();
        if (!url) return { content: '缺 url', isError: true };
        if (/^BV[0-9A-Za-z]{10}$/i.test(url)) {
          url = `https://www.bilibili.com/video/${url}`;
        }
        const info = await fetchInfo(url);
        if (args?.withComments === false) delete info.hotComments;
        const lines = [
          `标题：${info.title}`,
          `UP：${info.owner} · 时长 ${fmtDuration(info.durationSec)}`,
          info.published ? `发布：${info.published}` : '',
          `播放 ${info.view} · 点赞 ${info.like}`,
          `链接：${info.url}`,
          info.desc ? `简介：${info.desc}` : '',
          info.hotComments?.length ? `热评：\n${info.hotComments.map((c, i) => `${i + 1}. ${c}`).join('\n')}` : ''
        ].filter(Boolean);
        return { content: lines.join('\n') };
      } catch (e) {
        return { content: `B站解析失败：${e?.message ?? e}`, isError: true };
      }
    }
  });
}
