/**
 * Electron 壳的导航/外链判据。
 *
 * 壳加载的是本机面板（dev 为 http://127.0.0.1:8788/；产品形态为系统分配端口，
 * 由发现文件 panel/.panel.json 给出）。页面内导航必须留在同一 origin；
 * 外链只允许 http/https 交给系统浏览器，file/data/javascript 一律拒绝。
 */

export function isPanelUrl(raw, panelUrl) {
  try {
    const a = new URL(String(raw));
    const b = new URL(String(panelUrl));
    return a.origin === b.origin;
  } catch {
    return false;
  }
}

export function classifyExternal(raw) {
  try {
    const u = new URL(String(raw));
    if (u.protocol === 'http:' || u.protocol === 'https:') return { ok: true, url: u.href };
    return { ok: false, reason: `只允许 http/https 外链（收到 ${u.protocol}）` };
  } catch {
    return { ok: false, reason: 'URL 解析失败' };
  }
}
