// 记忆管理 —— 全局 people 列表 / 审计（通用，不绑具体人设）

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../../src/config.js';

let cfg = () => ({});
let log = () => {};
let dataDir = DATA_DIR;

function peopleDir() {
  return path.join(dataDir, 'memory', 'people');
}

function auditFile() {
  return path.join(dataDir, 'memory', 'audit.jsonl');
}

function readAllPeople() {
  try {
    const dir = peopleDir();
    if (!fs.existsSync(dir)) return [];
    const out = [];
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      try {
        let t = fs.readFileSync(path.join(dir, name), 'utf8');
        if (t.charCodeAt(0) === 0xFEFF) t = t.slice(1);
        out.push(JSON.parse(t));
      } catch { /* skip bad file */ }
    }
    out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    return out;
  } catch {
    return [];
  }
}

function readAudit(limit = 20) {
  try {
    const f = auditFile();
    if (!fs.existsSync(f)) return [];
    const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/).filter(Boolean).slice(-limit);
    return lines.map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean).reverse();
  } catch {
    return [];
  }
}

export function setup(api) {
  cfg = api.config;
  log = (...a) => api.log?.(...a);
  if (api.dataDir) dataDir = api.dataDir;

  api.registerTool({
    id: 'memory_admin',
    name: '记忆管理',
    description: '管理全局记忆：list=列群友；search=按关键词搜印象；audit=最近改动。action 必填。',
    category: 'knowledge',
    icon: '🗂️',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'search', 'audit'], description: '操作类型' },
        query: { type: 'string', description: 'search 时的关键词' },
        userId: { type: 'string', description: '可选：只看某个 QQ 号' },
        limit: { type: 'integer', description: '返回条数' }
      },
      required: ['action']
    },
    async execute(_ctx, args) {
      try {
        const action = String(args?.action || '').trim();
        const maxList = Math.max(5, Math.min(80, Number(cfg()?.maxList) || 30));

        if (action === 'list') {
          let people = readAllPeople();
          const uid = String(args?.userId || '').trim();
          if (uid) people = people.filter((p) => String(p.userId) === uid);
          if (!people.length) return { content: '还没有全局群友档案' };
          const lines = people.slice(0, maxList).map((p) => {
            const nick = p.nicknames?.[0] ? `（${p.nicknames[0]}）` : '';
            const n = p.impressions?.length || 0;
            const fav = typeof p.favor === 'number' ? ` 好感${p.favor}` : '';
            const att = p.attitude ? ` 态度:${String(p.attitude).slice(0, 20)}` : '';
            return `- ${p.userId}${nick} 印象${n}${fav}${att}`;
          });
          return {
            content: [`共 ${people.length} 人（显示 ${Math.min(lines.length, maxList)}）：`, ...lines].join('\n')
          };
        }

        if (action === 'search') {
          const q = String(args?.query || '').toLowerCase().trim();
          const people = readAllPeople();
          const hits = [];
          for (const p of people) {
            const imps = (p.impressions || []).filter((x) => !q || String(x.content).toLowerCase().includes(q));
            if (imps.length) {
              hits.push({ p, imps: imps.slice(-3) });
            }
            if (hits.length >= maxList) break;
          }
          if (!hits.length) return { content: `没有匹配「${args?.query || ''}」的印象` };
          const lines = hits.map(({ p, imps }) => {
            const nick = p.nicknames?.[0] ? `（${p.nicknames[0]}）` : '';
            const body = imps.map((x) => x.content).join('；');
            return `- ${p.userId}${nick}: ${body}`;
          });
          return { content: [`命中 ${hits.length} 人：`, ...lines].join('\n') };
        }

        if (action === 'audit') {
          const items = readAudit(Math.min(50, Number(args?.limit) || 20));
          if (!items.length) return { content: '没有审计记录' };
          const lines = items.map((x, i) => {
            const t = x.at ? new Date(x.at).toISOString().slice(5, 16).replace('T', ' ') : '';
            const who = x.userId || x.qq || '';
            return `${i + 1}. [${t}] ${x.type || x.action || ''} ${who} ${String(x.note || x.summary || '').slice(0, 40)}`;
          });
          return { content: lines.join('\n') };
        }

        return { content: 'action 必须是 list / search / audit', isError: true };
      } catch (e) {
        return { content: `记忆管理失败：${e?.message ?? e}`, isError: true };
      }
    }
  });
}
