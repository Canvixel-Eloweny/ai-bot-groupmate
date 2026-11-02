/**
 * 假 QQ 的 stdout → 结构化消息（2026-11-01）
 * ══════════════════════════════════════════════════════════════════════
 *  `scripts/fake-qq.mjs` 原本只给人看终端：`机器人（群）▸ 文本` 与
 *  `↑ 你说：文本` 都是一整行。聊天界面需要「谁说的」，所以在这里做**一层纯分类**，
 *  不改脚本、也不改它已有的输出。
 *
 *  ⚠️ 分类只认脚本里真实出现过的前缀；认不出的行归 `meta`（只进原始输出，
 *     不进聊天气泡）—— 宁可少显示，也不把帮助文本/日志塞进对话。
 *  ⚠️ 机器人回复可能带换行，`console.log` 会把它拆成多行；第一行有前缀，
 *     后续行没有前缀。调用方（fake-session）用 `loose` 把这些行拼回上一条
 *     机器人消息，本函数只负责标出「这行没有前缀」。
 */

const ANSI = /\u001b\[[0-9;]*m/g;

export function cleanFakeLine(raw) {
  return String(raw ?? '').replace(ANSI, '').replace(/\r+$/g, '');
}

/**
 * @param {string} raw
 * @returns {{role:'user'|'bot'|'system'|'error'|'meta', text?:string, channel?:string, loose?:boolean, tone?:string}}
 */
export function classifyFakeLine(raw) {
  const text = cleanFakeLine(raw);
  const t = text.trim();
  if (!t) return { role: 'meta' };
  /* readline 的提示符没有换行，会被后面的输出拼成一行；单独出现时直接丢掉。 */
  if (/^群友\s*▸\s*$/.test(t)) return { role: 'meta' };

  const user = t.match(/^↑\s*你说[：:]\s*([\s\S]*)$/);
  if (user) return { role: 'user', text: user[1].trim() };

  const bot = t.match(/^机器人[（(](群|私聊)[）)]\s*▸\s*([\s\S]*)$/);
  if (bot) return { role: 'bot', channel: bot[1], text: bot[2].trim() };

  if (/^[✗!]/.test(t) || /^(启动失败|起不来)[：:]/.test(t)) {
    return { role: 'error', text: t };
  }

  /* 只把“改变会话状态”的几行做成系统提示；其余命令帮助/日志不占聊天气泡。 */
  if (/^@\s*(开|关)/.test(t)) return { role: 'system', text: t };
  if (/^(切到私聊|切回群聊|现在以 )/.test(t)) return { role: 'system', text: t };
  if (/^（会话已退出/.test(t)) return { role: 'system', text: t, tone: 'end' };
  if (/^退出。/.test(t)) return { role: 'system', text: t, tone: 'end' };

  /* 启动横幅、配置、帮助、日志尾巴、面板本地回显 —— 只留在原始输出。 */
  if (/^(\$ node|配置：|群 \d+|程序已连上|假 QQ 会话层已启动|直接打字|\/at|\/private|\/group|\/as|\/log|\/where|\/quit|│|↑ 已发出|当前：|\[(群|私聊)\s)/.test(t)) {
    return { role: 'meta' };
  }

  /* 没有已知前缀：可能是机器人多行回复的续行（loose），也可能是不认识的输出。 */
  return { role: 'meta', text: t, loose: true };
}
