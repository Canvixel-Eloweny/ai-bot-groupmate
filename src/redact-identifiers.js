/**
 * 诊断包的自由文本脱敏（P1-10 · 2026-10-23）。
 *
 * 与 `src/egress.js` 的 `maskSecrets` 分工：
 *   · `maskSecrets` 管**凭据形态**（sk-/Bearer/私钥/键值），模型出口与日志已在用；
 *   · 本模块管**身份**（QQ/群号/用户名路径），只给诊断包/导出面用。
 * 不改 `maskSecrets` 的语义 —— 在模型出口抹数字会把排障信息一起抹掉。
 *
 * 兜底策略是“宁可多抹”：5–12 位裸数字一律 `***`（会顺带抹掉部分 PID/端口，
 * 但诊断包还能从 summary 拿到版本/状态；泄漏一个 QQ 号是不可逆的）。
 */

const SECRET_PATTERNS = [
  { label: 'sk-key', re: /\bsk-[A-Za-z0-9_-]{16,}\b/ },
  { label: 'bearer', re: /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/i },
  { label: 'private-key', re: /-----BEGIN [A-Z ]+PRIVATE KEY-----/ },
  { label: 'json-secret', re: /"(?:apiKey|api_key|accessToken|access_token|token|secret|password)"\s*:\s*"[^"]{8,}"/i },
];

export function scanResidualSecrets(text) {
  const s = String(text ?? '');
  const hits = [];
  for (const { label, re } of SECRET_PATTERNS) {
    if (re.test(s)) hits.push(label);
  }
  return hits;
}

export function maskIdentifiers(text, { qqIds = [], groupIds = [] } = {}) {
  let out = String(text ?? '');
  const known = [...new Set([...qqIds, ...groupIds].map((v) => String(v || '').trim()).filter(Boolean))];
  for (const id of known) out = out.split(id).join('***');

  // 本机用户名（诊断包要能发出去；绝对路径本身保留，用户名换掉）。
  // JSON 里的反斜杠是转义的（C:\\Users\\Name），普通文本是单个反斜杠；两种都要认。
  out = out.replace(/([A-Za-z]:\\\\Users\\\\)[^\\\r\n]+/g, '$1<user>');
  out = out.replace(/([A-Za-z]:\\Users\\)[^\\\r\n]+/g, '$1<user>');
  out = out.replace(/(\/Users\/)[^/\r\n]+/g, '$1<user>');
  out = out.replace(/(\/home\/)[^/\r\n]+/g, '$1<user>');

  // 带上下文的 QQ/群号。
  out = out.replace(/\b(self_id|user_id|group_id|userId|groupId|uin|qq)\b(\s*[=:]\s*)(\d{5,12})/gi, '$1$2***');
  out = out.replace(/(群|主人|账号|QQ|扣扣)\s*[：:=]?\s*(\d{5,12})/g, '$1 ***');
  out = out.replace(/\b(group|private):\d{5,12}(?::\d{5,12})?/g, '$1:***');

  // 兜底：裸的 5–12 位数字。避开小数/版本（前后有 `.` 或数字时不匹配）。
  out = out.replace(/(?<![\d.])\d{5,12}(?![\d.])/g, '***');
  return out;
}

export function redactLines(text, { maskSecrets = (s) => s, qqIds = [], groupIds = [] } = {}) {
  const redactions = [];
  const clean = String(text ?? '')
    .split(/\r?\n/)
    .map((line) => {
      const masked = maskIdentifiers(maskSecrets(line), { qqIds, groupIds });
      const hits = scanResidualSecrets(masked);
      if (!hits.length) return masked;
      for (const h of hits) redactions.push(h);
      return `[REDACTED: ${[...new Set(hits)].join(',')}]`;
    })
    .join('\n');
  return { text: clean, redactions: [...new Set(redactions)] };
}
