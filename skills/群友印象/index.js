// 群友印象 / 好感度 —— 移植自魔改包 08-people-memory
// 数据：优先写全局 data/memory/people/<QQ>.json（跨群共享）；
// 若 0.31 的 ctx.memory 已支持同一套接口，则直接复用。

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../../src/config.js';

let cfg = () => ({});
let log = () => {};
let dataDir = DATA_DIR;

function peopleDir() {
  return path.join(dataDir, 'memory', 'people');
}

function personFile(userId) {
  return path.join(peopleDir(), `${userId}.json`);
}

function ensureDir() {
  fs.mkdirSync(peopleDir(), { recursive: true });
}

function readPerson(userId) {
  try {
    const f = personFile(userId);
    if (!fs.existsSync(f)) return null;
    let t = fs.readFileSync(f, 'utf8');
    if (t.charCodeAt(0) === 0xFEFF) t = t.slice(1);
    return JSON.parse(t);
  } catch {
    return null;
  }
}

function writePerson(userId, data) {
  ensureDir();
  const f = personFile(userId);
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1), 'utf8');
  fs.renameSync(tmp, f);
}

function normQid(raw) {
  let s = String(raw ?? '').trim().replace(/^["']|["']$/g, '');
  if (/^-?\d{1,15}$/.test(s)) return String(Math.abs(Number(s)));
  return '';
}

function defaultPerson(userId) {
  return {
    userId,
    nicknames: [],
    favor: 50,
    impressions: [],
    updatedAt: Date.now()
  };
}

export function setup(api) {
  cfg = api.config;
  log = (...a) => api.log?.(...a);
  if (api.dataDir) dataDir = api.dataDir;

  api.registerTool({
    id: 'people_append',
    name: '记群友印象',
    description: '记对某人（按 QQ 号全局共享）的长期印象。只记身份/风格/雷点/喜好等稳定信息，≤80字。userId 必填。type：identity/preference/edge/style/event/attitude。',
    category: 'knowledge',
    icon: '🧠',
    parameters: {
      type: 'object',
      properties: {
        userId: { type: ['integer', 'string'], description: '对方 QQ 号（聊天行 名字(QQ数字) 里的数字）' },
        target: { type: 'string', description: '可选备注昵称' },
        content: { type: 'string', description: '印象内容，≤80字' },
        type: {
          type: 'string',
          enum: ['identity', 'preference', 'edge', 'style', 'event', 'attitude'],
          description: '不传自动猜。attitude=对他该用的态度'
        }
      },
      required: ['userId', 'content']
    },
    async execute(_ctx, args) {
      try {
        const userId = normQid(args?.userId);
        const target = String(args?.target ?? '').trim();
        let content = String(args?.content ?? '').trim().replace(/^["'“”]|["'“”]$/g, '').trim();
        if (!userId) return { content: '缺 userId（对方 QQ 号）', isError: true };
        if (!content) return { content: 'content 不能为空', isError: true };

        const p = readPerson(userId) || defaultPerson(userId);
        if (target && target !== userId && !p.nicknames.includes(target)) {
          p.nicknames.unshift(target);
          p.nicknames = p.nicknames.slice(0, 8);
        }
        const type = String(args?.type || guessType(content));
        // 10 分钟内被手动改过的印象不自动追加（简版：看 updatedAt 新鲜度）
        const recentManual = p.impressions.some((x) => x.manual && Date.now() - x.at < 10 * 60 * 1000);
        if (recentManual) {
          return { content: '对方刚被手动改过印象，10 分钟内跳过自动追加', isError: true };
        }
        p.impressions.push({ content, type, at: Date.now() });
        p.impressions = p.impressions.slice(-40);
        p.updatedAt = Date.now();
        writePerson(userId, p);
        return { content: `已记下对 ${userId} 的印象（共 ${p.impressions.length} 条）` };
      } catch (e) {
        return { content: `记录失败：${e?.message ?? e}`, isError: true };
      }
    }
  });

  api.registerTool({
    id: 'people_query',
    name: '查群友印象',
    description: '查对某人或某群聊的长期印象。userId 必填（对方 QQ 号）。也可 query 过滤关键词。',
    category: 'knowledge',
    icon: '🔍',
    parameters: {
      type: 'object',
      properties: {
        userId: { type: ['integer', 'string'], description: '对方 QQ 号' },
        query: { type: 'string', description: '可选关键词过滤' }
      },
      required: ['userId']
    },
    async execute(_ctx, args) {
      try {
        const userId = normQid(args?.userId);
        if (!userId) return { content: '缺 userId（对方 QQ 号）', isError: true };
        const p = readPerson(userId);
        if (!p || !p.impressions?.length) {
          return { content: `没有关于 ${userId} 的印象记录` };
        }
        const q = String(args?.query || '').toLowerCase();
        let list = p.impressions;
        if (q) list = list.filter((x) => String(x.content).toLowerCase().includes(q));
        const nick = p.nicknames?.[0] ? `（${p.nicknames[0]}）` : '';
        const lines = list.slice(-12).map((x) => {
          const tag = x.type ? `[${x.type}]` : '';
          const d = new Date(x.at).toISOString().slice(0, 16);
          return `${tag}${x.content}  #${d}`;
        });
        const favorLine = typeof p.favor === 'number' ? `好感度：${p.favor}/100` : '';
        return {
          content: [`对 ${userId}${nick} 的印象：`, ...lines, favorLine].filter(Boolean).join('\n')
        };
      } catch (e) {
        return { content: `查询失败：${e?.message ?? e}`, isError: true };
      }
    }
  });

  const favorOn = () => cfg()?.favorEnabled !== false;
  if (favorOn()) {
    api.registerTool({
      id: 'people_favor',
      name: '好感度调整',
      description: '查看或微调对某人的好感度（0~100，50中性）。被夸/被帮可 +；被怼/被烦可 −。单次最多 ±10。不传 delta 只查。',
      category: 'knowledge',
      icon: '💗',
      parameters: {
        type: 'object',
        properties: {
          userId: { type: ['integer', 'string'], description: '对方 QQ 号' },
          delta: { type: 'integer', description: '变化量 -10~10；不传=只查看' },
          reason: { type: 'string', description: '简短原因，≤30字' }
        },
        required: ['userId']
      },
      async execute(_ctx, args) {
        try {
          const userId = normQid(args?.userId);
          if (!userId) return { content: '缺 userId（对方 QQ 号）', isError: true };
          const p = readPerson(userId) || defaultPerson(userId);
          if (typeof p.favor !== 'number') p.favor = 50;
          let delta = args?.delta;
          if (delta == null || delta === '') {
            return { content: `对 ${userId} 的好感度：${p.favor}/100` };
          }
          let d = Number(delta);
          if (!Number.isFinite(d)) return { content: 'delta 必须是数字', isError: true };
          d = Math.max(-10, Math.min(10, Math.trunc(d)));
          p.favor = Math.max(0, Math.min(100, p.favor + d));
          p.updatedAt = Date.now();
          writePerson(userId, p);
          const reason = String(args?.reason || '').slice(0, 30);
          log(`favor ${userId} ${d >= 0 ? '+' : ''}${d} → ${p.favor}${reason ? ` (${reason})` : ''}`);
          return { content: `好感度 ${p.favor}/100${reason ? `（${reason}）` : ''}` };
        } catch (e) {
          return { content: `好感度操作失败：${e?.message ?? e}`, isError: true };
        }
      }
    });
  }
}

function guessType(content) {
  const s = String(content || '');
  if (/态度|怼|宠|护短|少理/.test(s)) return 'attitude';
  if (/喜欢|讨厌|雷|讨厌|偏好|喜欢/.test(s)) return 'preference';
  if (/口头禅|风格|说话|人设|昵称/.test(s)) return 'style';
  if (/记得|上次|昨天|事件/.test(s)) return 'event';
  if (/是谁|身份|职业|学生|号/.test(s)) return 'identity';
  return 'note';
}
