// 自定义图库 —— 移植自魔改包 image-lib
// data/images-lib/index.json；类别 self / meme / art / other

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../../src/config.js';

let cfg = () => ({});
let log = () => {};
let dataDir = DATA_DIR;

function dir() {
  return path.join(dataDir, 'images-lib');
}
function file() {
  return path.join(dir(), 'index.json');
}

function maxEntries() {
  return Math.max(1, Number(cfg()?.maxEntries) || 200);
}

function readIndex() {
  try {
    fs.mkdirSync(dir(), { recursive: true });
    let t = fs.readFileSync(file(), 'utf8');
    if (t.charCodeAt(0) === 0xFEFF) t = t.slice(1);
    const j = JSON.parse(t);
    return Array.isArray(j.images) ? j.images : [];
  } catch {
    return [];
  }
}

function writeIndex(list) {
  fs.mkdirSync(dir(), { recursive: true });
  const n = maxEntries();
  const tmp = `${file()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, images: list.slice(-n) }, null, 1), 'utf8');
  fs.renameSync(tmp, file());
}

function normEntry(raw) {
  const id = String(raw?.id || '').trim();
  const src = String(raw?.url || raw?.localFile || raw?.src || '').trim();
  if (!id || !src) return null;
  return {
    id,
    url: src,
    localFile: String(raw?.localFile || '').trim(),
    tags: (Array.isArray(raw?.tags) ? raw.tags : []).map(String).map((s) => s.trim()).filter(Boolean).slice(0, 12),
    note: String(raw?.note || raw?.desc || '').slice(0, 160),
    category: ['self', 'meme', 'art', 'other'].includes(raw?.category) ? raw.category : 'other',
    uses: Math.max(0, Number(raw?.uses) || 0),
    lastUsedAt: Number(raw?.lastUsedAt) || 0,
    createdAt: Number(raw?.createdAt) || Date.now()
  };
}

function resolveImagePath(entry) {
  if (!entry) return '';
  const src = String(entry.url || entry.localFile || '');
  if (!src) return '';
  if (/^https?:\/\//i.test(src)) return src;
  if (src.startsWith('file://')) return src;
  const abs = path.isAbsolute(src) ? src : path.join(dataDir, src);
  return abs;
}

function scoreEntry(e, terms) {
  if (!terms.length) return 1;
  const hay = `${e.id} ${e.note} ${e.tags.join(' ')} ${e.category}`.toLowerCase();
  let s = 0;
  for (const t of terms) {
    if (hay.includes(t)) s += 2;
    else if ([...t].some((ch) => ch.length > 1 && hay.includes(ch))) s += 0.2;
  }
  return s;
}

export function setup(api) {
  cfg = api.config;
  log = (...a) => api.log?.(...a);
  if (api.dataDir) dataDir = api.dataDir;

  api.registerTool({
    id: 'image_lib_add',
    name: '收录图片到图库',
    description: '把一张图（URL 或本机路径）加入自定义图库，方便以后按标签发出。category：self/meme/art/other。',
    category: 'media',
    icon: '🗂️',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '图片 URL 或本机路径' },
        id: { type: 'string', description: '可选唯一名；不传按时间生成' },
        note: { type: 'string', description: '一句话说明' },
        tags: { type: 'array', items: { type: 'string' }, description: '标签' },
        category: { type: 'string', enum: ['self', 'meme', 'art', 'other'] }
      },
      required: ['url']
    },
    async execute(_ctx, args) {
      try {
        const raw = {
          url: args?.url,
          id: args?.id,
          note: args?.note,
          tags: args?.tags,
          category: args?.category
        };
        if (!raw.id) raw.id = `img_${Date.now().toString(36)}`;
        const e = normEntry(raw);
        if (!e) return { content: 'url 不能为空', isError: true };
        const list = readIndex().filter((x) => x.id !== e.id);
        list.push(e);
        writeIndex(list);
        return { content: `已收录 ${e.id}（共 ${list.length} 条）` };
      } catch (err) {
        return { content: `收录失败：${err?.message ?? err}`, isError: true };
      }
    }
  });

  api.registerTool({
    id: 'image_lib_search',
    name: '搜图库',
    description: '按关键词/标签/分类搜索自定义图库，返回 id、说明与标签。找到后再用 image_lib_send 发送。',
    category: 'media',
    icon: '🔎',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '关键词，可空=列出全部' },
        category: { type: 'string', enum: ['self', 'meme', 'art', 'other'] },
        limit: { type: 'integer', description: '最多返回条数，默认 8' }
      }
    },
    async execute(_ctx, args) {
      try {
        const list = readIndex();
        const cat = String(args?.category || '').trim();
        const terms = String(args?.query || '').toLowerCase().split(/\s+/).filter(Boolean);
        let hits = list;
        if (cat) hits = hits.filter((e) => e.category === cat);
        const scored = hits
          .map((e) => ({ e, s: scoreEntry(e, terms) }))
          .filter((x) => x.s > 0)
          .sort((a, b) => b.s - a.s || (b.e.lastUsedAt || 0) - (a.e.lastUsedAt || 0));
        const lim = Math.min(20, Math.max(1, Number(args?.limit) || 8));
        const top = scored.slice(0, lim);
        if (!top.length) return { content: '图库里没有匹配的图片' };
        const lines = top.map(({ e }) => `- ${e.id} [${e.category}] ${e.note || '(无说明)'} tags=${e.tags.join(',') || '-'}`);
        return { content: [`找到 ${top.length} 张：`, ...lines, '用 image_lib_send({id}) 发送'].join('\n') };
      } catch (err) {
        return { content: `搜索失败：${err?.message ?? err}`, isError: true };
      }
    }
  });

  api.registerTool({
    id: 'image_lib_send',
    name: '发图库图片',
    description: '按 id 从图库发一张图到当前会话。先 image_lib_search 拿到 id。',
    category: 'media',
    icon: '🖼️',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '图库里的图片 id' }
      },
      required: ['id']
    },
    async execute(ctx, args) {
      try {
        const id = String(args?.id || '').trim();
        if (!id) return { content: '缺 id', isError: true };
        const list = readIndex();
        const e = list.find((x) => x.id === id);
        if (!e) return { content: `图库里没有 id=${id}`, isError: true };
        const src = resolveImagePath(e);
        if (!src) return { content: '这张图的路径无效', isError: true };
        e.uses += 1;
        e.lastUsedAt = Date.now();
        writeIndex(list);
        if (ctx.sender?.sendImage) {
          if (/^https?:\/\//i.test(src)) {
            await ctx.sender.sendImage(ctx.chatKey, { url: src }, { note: e.note });
          } else {
            await ctx.sender.sendImage(ctx.chatKey, { url: src }, { note: e.note });
          }
        } else {
          await ctx.onebot.sendImage(ctx.kind, ctx.chatId, src);
        }
        return { content: `已发送图库图片 ${id}` };
      } catch (err) {
        return { content: `发送失败：${err?.message ?? err}`, isError: true };
      }
    }
  });
}
