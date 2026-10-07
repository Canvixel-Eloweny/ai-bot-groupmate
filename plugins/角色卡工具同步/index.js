// 角色卡「可用工具」区与工具白名单联动 —— 移植自魔改版 tool-role-sync.js
// 0.3.1 里：activate 时同步一次；也可在设置页改完配置后重新激活。
//
// ⚠️ 2026-10-04：原版 `import { getConfig, updateConfig } from '../../src/config.js'` 是
//    **参考实现（QQ-Agent）的接口**，本宿主的 `src/config.js` 没有这两个导出 →
//    ESM 链接期 SyntaxError，包**加载即失败**（本包当前未启用，所以只是休眠的雷）。
//    已改成本宿主的人设**文件**模型（`config.json` 的 `persona.file`），与 `skills/自我印象`
//    用同一套做法。⚠️ 本包其余部分仍假设参考实现的 `cfg.skills` / `cfg.tools`，
//    在本宿主下取不到值（都走 `?.` / `|| {}` 兜底，不会抛）—— 要真正启用它需要按本宿主重写，
//    那是独立一件事，不在本次修复范围。

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

export const ROLE_TOOLS_START = '<!--tools:start-->';
export const ROLE_TOOLS_END = '<!--tools:end-->';

export const TOOL_ROLE_GUIDES = {
  send_message: 'send_message：想说话就调用；分条用字符串数组。正文不会发到 QQ。',
  finish: 'finish：结束本轮。mood 可选。',
  get_recent_messages: 'get_recent_messages：往前翻更早的聊天记录；#数字 是 messageId。',
  get_message_detail: 'get_message_detail：按 messageId 查单条详情。',
  send_sticker: 'send_sticker：发表情；stickerId 必须是 list_stickers 返回的 id。不能和文字同气泡。',
  list_stickers: 'list_stickers：查/搜收藏表情库，拿到可用的 stickerId。',
  get_sticker_image: 'get_sticker_image：看一张没备注的表情图。',
  sticker_note: 'sticker_note：给表情写备注/tags。',
  collect_sticker: 'collect_sticker：收藏别人刚发的表情/图片进自己的库。',
  send_image: 'send_image：发网图直链。',
  search_images: 'search_images：搜图拿直链，再 send_image。',
  identify_image: 'identify_image：以图认人/认角色。认不出就别瞎猜。',
  get_message_images: 'get_message_images：看某条消息里的图片/表情。',
  web_search: 'web_search：联网搜实时信息/不确定的事实。',
  web_fetch: 'web_fetch：打开网页读正文。',
  send_poke: 'send_poke：QQ 拍一拍。',
  get_active_members: 'get_active_members：查当前会话最近活跃成员。',
  read_forward: 'read_forward：展开合并转发。',
  send_forward: 'send_forward：把多条内容发成合并转发。',
  memory_append: 'memory_append：记印象必须填 userId=对方 QQ 号；≤80字。',
  memory_query: 'memory_query：查全局印象。',
  memory_remove: 'memory_remove：删过时印象。',
  memory_search: 'memory_search：按关键词搜跨会话旧聊天。',
  memory_archive: 'memory_archive：按天翻聊天存档。',
  memory_favor: 'memory_favor：查看/微调好感度（0~100，单次 ±10）。',
  memory_meme_save: 'memory_meme_save：存内部梗/结论（≤60字）。',
  memory_meme_search: 'memory_meme_search：搜内部梗库。',
  image_lib_search: 'image_lib_search：搜自定义图库。',
  image_lib_send: 'image_lib_send：发图库图片。',
  bili_info: 'bili_info：解析 B 站视频标题/简介（不下载）。',
  wiki_lookup: 'wiki_lookup：查外部百科条目摘要。',
  self_impression_add: 'self_impression_add：记一条低权重自我印象。',
  report_feedback: 'report_feedback：给管理员报一条反馈（不会发到群里）。'
};

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildSection(lines) {
  return [
    '## 可用工具（由工具白名单自动生成，改白名单会同步这里）',
    ROLE_TOOLS_START,
    lines.join('\n') || '- （当前白名单未开任何角色卡已知工具）',
    ROLE_TOOLS_END
  ].join('\n');
}

export function syncRoleToolsSection(roleText, enabledTools) {
  const text = String(roleText ?? '');
  const all = !Array.isArray(enabledTools) || !enabledTools.length;
  const set = all ? null : new Set(enabledTools.map(String));
  const lines = [];
  for (const [name, guide] of Object.entries(TOOL_ROLE_GUIDES)) {
    if (set && !set.has(name)) continue;
    lines.push(`- ${guide}`);
  }
  const re = new RegExp(`${escapeRe(ROLE_TOOLS_START)}[\\s\\S]*?${escapeRe(ROLE_TOOLS_END)}`, 'm');
  if (re.test(text)) {
    return text.replace(re, `${ROLE_TOOLS_START}\n${lines.join('\n') || '- （未开工具）'}\n${ROLE_TOOLS_END}`);
  }
  const heading = /^##\s*可用工具[^\n]*\n[\s\S]*$/m;
  if (heading.test(text)) {
    return text.replace(heading, buildSection(lines));
  }
  const t = text.replace(/\s+$/, '');
  return `${t}\n\n${buildSection(lines)}\n`;
}

function runSync(log) {
  try {
    const role = String(readRoleText());
    if (!role.trim()) return;
    const tools = null; // 0.31 config.tools 是对象，没有白名单数组；null=写全量指南骨架
    const next = syncRoleToolsSection(role, tools);
    if (next !== role) {
      writeTextAtomic(personaFile(), next);
      log?.('[role-tool-sync] 已同步角色卡工具区');
    }
  } catch (e) {
    log?.('[role-tool-sync] 同步失败', e?.message ?? e);
  }
}

let log = () => {};

export function setup(api) {
  log = (...a) => api.log?.(...a);
}

export function activate() {
  // 延迟一点：等配置完全就绪
  setTimeout(() => runSync(log), 2000);
}
