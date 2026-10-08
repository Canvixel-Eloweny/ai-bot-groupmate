// 复读拦截 —— before-tool 钩子否决重复 send_message
// 来源：魔改版 tools.js 内联去重逻辑的通用子集（不改核心）

let cfg = () => {};
let log = () => {};

/** chatKey → { texts: string[], at: number[] } */
const history = new Map();

function windowMs() {
  return Math.max(1, Number(cfg()?.windowMin) || 20) * 60 * 1000;
}

function minLen() {
  return Math.max(2, Number(cfg()?.minLen) || 6);
}

function maxPerRun() {
  return Math.max(1, Number(cfg()?.maxPerRun) || 6);
}

function norm(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[\s　]+/g, '')
    .replace(/[。．.!！?？~～…、,，;；:："'"'“”‘’()（）\[\]【】]/g, '');
}

/** 轻量相似：一方包含另一方 / 编辑距离启发 */
function isNearDup(a, b) {
  if (a === b) return true;
  const [x, y] = a.length <= b.length ? [a, b] : [b, a];
  if (x.length >= minLen() && y.includes(x)) return true;
  if (y.length - x.length <= 2) {
    let diff = 0;
    for (let i = 0, j = 0; i < x.length && j < y.length; i++, j++) {
      if (x[i] !== y[j]) {
        diff++;
        if (diff > 2) return false;
        if (x[i] === y[j + 1]) j++;
        else if (x[i + 1] === y[j]) i++;
      }
    }
    return diff <= 2;
  }
  return false;
}

function prune(chatKey) {
  const h = history.get(chatKey);
  if (!h) return null;
  const cut = Date.now() - windowMs();
  const texts = [];
  const at = [];
  for (let i = 0; i < h.texts.length; i++) {
    if ((h.at[i] || 0) >= cut) {
      texts.push(h.texts[i]);
      at.push(h.at[i]);
    }
  }
  const next = { texts, at };
  history.set(chatKey, next);
  return next;
}

function remember(chatKey, text) {
  const h = history.get(chatKey) || { texts: [], at: [] };
  h.texts.push(text);
  h.at.push(Date.now());
  if (h.texts.length > 80) {
    h.texts = h.texts.slice(-80);
    h.at = h.at.slice(-80);
  }
  history.set(chatKey, h);
}

export function setup(api) {
  cfg = api.config;
  log = (...a) => api.log?.(...a);
}

export const hooks = {
  'before-tool': ({ toolName, argsRaw, session } = {}) => {
    try {
      if (!/send_message/i.test(String(toolName || ''))) return;
      if (cfg()?.enabled === false) return;

      let args = argsRaw;
      if (typeof args === 'string') {
        try { args = JSON.parse(args); } catch { args = null; }
      }
      const msgs = [];
      const raw = args?.messages;
      if (Array.isArray(raw)) msgs.push(...raw.map(String));
      else if (raw != null) msgs.push(String(raw));
      if (!msgs.length) return;

      const chatKey = String(session?.chatKey || '');
      const h = prune(chatKey);
      const blocked = [];
      const pass = [];
      for (const m of msgs) {
        const n = norm(m);
        if (n.length < minLen()) { pass.push(m); continue; }
        const dup = (h?.texts || []).some((prev) => isNearDup(n, prev));
        if (dup) blocked.push(m);
        else pass.push(m);
      }

      // 全拦
      if (!pass.length && blocked.length) {
        return {
          block: true,
          reason: `复读拦截：「${String(blocked[0]).slice(0, 30)}」和刚发过的几乎一样。换个说法，或直接结束。`
        };
      }

      // 超限
      const sentCount = Array.isArray(session?.sent)
        ? session.sent.filter((s) => s?.type === 'text').length
        : 0;
      if (sentCount + pass.length > maxPerRun()) {
        return {
          block: true,
          reason: `这一轮已经发了 ${sentCount} 条（上限 ${maxPerRun()}），别再刷了。`
        };
      }

      // 部分重复：只放行新的（改写 args 不在 hook 契约里，用 reason 提示 + 记录通过的）
      for (const m of pass) remember(chatKey, norm(m));
      if (blocked.length) {
        // 不 block 整次：通过的会照发；被拦的在 reason 里说明（部分实现会忽略 reason 当成功）
        log(`[echo-guard] 跳过 ${blocked.length} 条复读`);
      }
      return undefined;
    } catch (e) {
      log('[echo-guard]', e?.message ?? e);
      return undefined;
    }
  }
};
