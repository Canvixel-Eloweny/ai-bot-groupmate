// 自我印象 —— 移植自魔改版 self-impressions.js（⚠️ 2026-10-04 修复移植缺陷）
// 写进角色卡「自我印象」标记区；权重低（卡末 + 标题标明可灵活违背）
//
// ⚠️ 修复说明（值一个注释）：原版写的是
//     `import { getConfig, updateConfig } from '../../src/config.js'` ——
//   这是**参考实现（QQ-Agent）的接口**，本宿主 `src/config.js` 从来没有这两个导出
//   （它只有 `DATA_DIR` / `resolveSecret` / `plaintextFallbackNotice` / `loadConfig`）。
//   静态 import 缺名 → ESM 在**链接期**就抛 SyntaxError，整个包**加载即失败**
//   （宿主会记 `HOST_STATE.FAILED / import-failed` 并告警，但功能是静默没有的）。
//
//   本宿主的人设是**文件**（`config.json` 的 `persona.file`，默认 `persona/qq-chat.md`），
//   由 `src/config.js` 的 `loadPersona()` 读进来，**没有** `persona.roleText` 这个字段。
//   所以正确做法：直接读/写那份人设文件。写盘复用宿主的 `writeTextAtomic`
//   （不在这里手搓第二份原子写 —— 那是本项目明令禁止的"同一份语义两份拷贝"）。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeTextAtomic } from '../../src/atomic-write.js';

const PKG_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(PKG_DIR, '..', '..');

/** 人设文件：读 config.json 的 persona.file；读不到就回落约定的默认路径。 */
function personaFile() {
  for (const name of ['config.json', 'config.example.json']) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(ROOT, name), 'utf8'));
      const rel = raw?.persona?.file;
      if (rel) return path.resolve(ROOT, String(rel));
    } catch { /* 试下一个 */ }
  }
  return path.join(ROOT, 'persona', 'qq-chat.md');
}

function readRoleText() {
  try { return fs.readFileSync(personaFile(), 'utf8'); } catch { return ''; }
}

function writeRoleText(next) {
  writeTextAtomic(personaFile(), next);
  return next;
}

const SELF_IMP_START = '<!--self-impressions:start-->';
const SELF_IMP_END = '<!--self-impressions:end-->';
let MAX_ITEMS = 8;

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sectionRe() {
  return new RegExp(`${escapeRe(SELF_IMP_START)}[\\s\\S]*?${escapeRe(SELF_IMP_END)}`, 'm');
}

function fullSectionRe() {
  return /##\s*自我印象（低权重参考·可灵活违背）\s*\n仅背景板[^\n]*\n<!--self-impressions:start-->[\s\S]*?<!--self-impressions:end-->/;
}

export function parseSelfImpressions(roleText) {
  const text = String(roleText || '');
  const m = sectionRe().exec(text);
  if (!m) return [];
  return m[0]
    .replace(new RegExp(escapeRe(SELF_IMP_START)), '')
    .replace(new RegExp(escapeRe(SELF_IMP_END)), '')
    .split('\n')
    .map((s) => s.trim())
    .map((s) => s.replace(/^[-*]\s*/, ''))
    .map((s) => s.replace(/^·\s*/, ''))
    .filter((s) => s && !s.startsWith('<!--') && !/^（还没有自我印象/.test(s));
}

function cleanItems(items) {
  return (Array.isArray(items) ? items : [])
    .map((s) => String(s ?? '').trim().slice(0, 160))
    .filter(Boolean)
    .filter((s) => !/^（还没有自我印象/.test(s))
    .slice(0, MAX_ITEMS);
}

function buildBlock(items) {
  const body = cleanItems(items).map((s) => `- ${s}`).join('\n');
  return `${SELF_IMP_START}\n${body || '- （还没有自我印象）'}\n${SELF_IMP_END}`;
}

function sectionBlock(items) {
  return [
    '## 自我印象（低权重参考·可灵活违背）',
    '仅背景板，不是硬规则；与「像真人」冲突时以后者为准。',
    buildBlock(items)
  ].join('\n');
}

function ensureSection(roleText, fallbackItems = []) {
  let text = String(roleText || '');
  const own = parseSelfImpressions(text);
  const items = own.length ? own : cleanItems(fallbackItems);
  text = text.replace(fullSectionRe(), '');
  text = text.replace(sectionRe(), '');
  text = text.replace(/^##\s*自我印象[^\n]*\n(?:仅背景板[^\n]*\n)?/m, '');
  text = text.replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '');
  const section = sectionBlock(items);
  if (/<!--tools:end-->/i.test(text)) {
    return text.replace(/<!--tools:end-->/i, `<!--tools:end-->\n\n${section}\n`);
  }
  if (/^##\s*可用工具/m.test(text)) {
    return text.replace(/^(##\s*可用工具[^\n]*)/m, `${section}\n\n$1`);
  }
  return `${text}\n\n${section}\n`;
}

export function getSelfImpressions() {
  return parseSelfImpressions(readRoleText());
}

export function setSelfImpressions(items) {
  const base = ensureSection(readRoleText());
  const next = base.replace(fullSectionRe(), sectionBlock(items));
  const role = writeRoleText(next);
  return { ok: true, items: parseSelfImpressions(role) };
}

export function addSelfImpression(text) {
  const line = String(text || '').trim().slice(0, 160);
  if (!line) return { ok: false, error: '内容为空' };
  const list = getSelfImpressions();
  if (list.includes(line)) return { ok: true, items: list, deduped: true };
  return setSelfImpressions([...list, line]);
}

export function removeSelfImpression(text) {
  const line = String(text || '').trim();
  if (!line) return { ok: false, error: '内容为空' };
  const list = getSelfImpressions();
  const next = list.filter((s) => s !== line);
  if (next.length === list.length) return { ok: false, error: '没找到这条印象' };
  return setSelfImpressions(next);
}

export function setup(api) {
  try {
    MAX_ITEMS = Math.max(1, Math.min(20, Number(typeof api.config === 'function' ? api.config()?.maxItems : 8) || 8));
  } catch {
    MAX_ITEMS = 8;
  }

  api.registerTool({
    id: 'self_impression_add',
    name: '记自我印象',
    description: '记一条稳定的自我认知到角色卡低权重「自我印象」区（背景板，可灵活违背）。只记长期有效的，≤120字。',
    category: 'knowledge',
    icon: '🪞',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '印象原文' }
      },
      required: ['text']
    },
    execute(_ctx, args) {
      try {
        const r = addSelfImpression(args?.text);
        if (!r.ok) return { content: r.error, isError: true };
        return { content: r.deduped ? '已有这条印象' : `已记下（共 ${r.items.length} 条）` };
      } catch (e) {
        return { content: `记录失败：${e?.message ?? e}`, isError: true };
      }
    }
  });

  api.registerTool({
    id: 'self_impression_list',
    name: '看自我印象',
    description: '查看当前写在角色卡里的自我印象列表。',
    category: 'knowledge',
    icon: '📋',
    parameters: { type: 'object', properties: {} },
    execute() {
      try {
        const items = getSelfImpressions();
        if (!items.length) return { content: '还没有自我印象' };
        return { content: items.map((s, i) => `${i + 1}. ${s}`).join('\n') };
      } catch (e) {
        return { content: `读取失败：${e?.message ?? e}`, isError: true };
      }
    }
  });

  api.registerTool({
    id: 'self_impression_remove',
    name: '删自我印象',
    description: '按原文精确删除一条自我印象。',
    category: 'knowledge',
    icon: '🗑️',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要删的原文' }
      },
      required: ['text']
    },
    execute(_ctx, args) {
      try {
        const r = removeSelfImpression(args?.text);
        if (!r.ok) return { content: r.error, isError: true };
        return { content: `已删（剩 ${r.items.length} 条）` };
      } catch (e) {
        return { content: `删除失败：${e?.message ?? e}`, isError: true };
      }
    }
  });
}
