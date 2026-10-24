/**
 * 崩溃/退出记录的归一化（P1-10 · 2026-10-23）。
 *
 * 零依赖纯函数：壳、面板、诊断包与测试共用同一份字段形状，避免三处各写一份 JSON。
 * 这里只做“字段裁剪 + 序列化”，不读盘、不脱敏（脱敏在 redact-identifiers.js）。
 */

function clip(value, max) {
  const s = String(value ?? '');
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function numOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function shellEvent({ kind, at, appVersion, electronVersion, nodeVersion, pid, isQuitting, reason, exitCode, url, type, message } = {}) {
  const out = {
    schema: 1,
    kind: clip(kind || 'unknown', 40),
    at: at || new Date().toISOString(),
  };
  if (appVersion) out.appVersion = clip(appVersion, 40);
  if (electronVersion) out.electronVersion = clip(electronVersion, 40);
  if (nodeVersion) out.nodeVersion = clip(nodeVersion, 40);
  const p = numOrNull(pid);
  if (p != null) out.pid = p;
  if (isQuitting != null) out.isQuitting = Boolean(isQuitting);
  if (reason) out.reason = clip(reason, 200);
  const code = numOrNull(exitCode);
  if (code != null) out.exitCode = code;
  if (url) out.url = clip(url, 300);
  if (type) out.type = clip(type, 60);
  if (message) out.message = clip(message, 2000);
  return out;
}

export function serializeShellEvent(event) {
  return `${JSON.stringify(shellEvent(event))}\n`;
}

export function panelExit({ code, reason, pid, at, uptimeMs, signal } = {}) {
  const out = {
    schema: 1,
    code: numOrNull(code) ?? 0,
    reason: clip(reason || 'process-exit', 120),
    at: at || new Date().toISOString(),
  };
  const p = numOrNull(pid);
  if (p != null) out.pid = p;
  const up = numOrNull(uptimeMs);
  if (up != null) out.uptimeMs = up;
  if (signal) out.signal = clip(signal, 40);
  return out;
}

export function serializePanelEvent(event) {
  return `${JSON.stringify(panelExit(event))}\n`;
}

export function tailLines(text, n = 200) {
  const lines = String(text ?? '').split(/\r?\n/);
  return lines.slice(Math.max(0, lines.length - n)).join('\n');
}

export function parseJsonl(text, limit = 200) {
  return tailLines(text, limit)
    .split(/\r?\n/)
    .map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean);
}
