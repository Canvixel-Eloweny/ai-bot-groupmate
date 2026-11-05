// PEM 私钥块脱敏（2026-11-05 · 外部评估 P1）
//   ① 完整块（含正文）在 split / hardWrap 之前被整块替换；
//   ② 未闭合块、CRLF、多块、长运行时凭据都不漏；
//   ③ 只有标头、没有正文的代码示例保持可读；
//   ④ 日志/诊断/逐段出口都走同一份识别规则。
import {
  redactPemBlocks, redactCredentialsBeforeShape, hasPemSecret,
  scanEgress, maskEgress, maskSecrets, maskSecretsDeep, setRuntimeSecrets,
} from '../src/egress.js';
import { Brain, SessionStore } from '../src/brain.js';
import { sampleConfig } from '../scripts/prompt-diff.mjs';

let pass = 0;
const fails = [];
const ok = (name, cond, extra = '') => {
  if (cond) { pass += 1; return; }
  fails.push(`${name}${extra ? `  → ${extra}` : ''}`);
};

const BODY_A = 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ejAxMjM0NTY3ODk=';
const BODY_B = 'Wm9yZG9vbW9vbmVyb3V2d3hlZHl6YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXowMTIzNDU2Nzg5QUJDREVGRw==';
// 字面量在运行时拼出来：源码里不出现连续的 PEM 头，publish-audit 不会把
// 合成样例误报成"仓库里有私钥"（不是给扫描器开后门 —— 样例正文本来就是假的）。
const pemBegin = (label) => `-----BEGIN ${label}-----`;
const pemEnd = (label) => `-----END ${label}-----`;
const pemBlock = (label, body, eol = '\n') => `${pemBegin(label)}${eol}${body}${eol}${pemEnd(label)}`;
const PEM_LABEL_OPENSSH = 'OPENSSH PRIVATE KEY';
const PEM_LABEL_RSA = 'RSA PRIVATE KEY';
const PEM_LABEL_EC = 'EC PRIVATE KEY';
const PEM_OPENSSH = pemBlock(PEM_LABEL_OPENSSH, BODY_A);
const PEM_RSA = pemBlock(PEM_LABEL_RSA, BODY_A);
const PEM_B = pemBlock(PEM_LABEL_EC, BODY_B);
const PROSE_PEM = `PEM 以 ${pemBegin('PRIVATE KEY')} 开头，正文在下一行。`;

// ── ① 纯函数边界 ─────────────────────────────────────────────────────────
{
  const r = redactPemBlocks(`前文\n${PEM_OPENSSH}\n后文`);
  ok('完整块被整块替换，前后文保留',
    !r.text.includes(BODY_A) && r.text.includes('前文') && r.text.includes('后文')
      && r.text.includes('[私钥块已脱敏]') && r.redacted === 1,
    JSON.stringify(r));

  const two = redactPemBlocks(`${PEM_RSA}\n中间的正文\n${PEM_B}`);
  ok('多块一次全抹',
    !two.text.includes(BODY_A) && !two.text.includes(BODY_B) && two.redacted === 2 && two.text.includes('中间的正文'),
    JSON.stringify(two));

  const crlf = redactPemBlocks(PEM_OPENSSH.replace(/\n/g, '\r\n'));
  ok('CRLF 块同样被抹', !crlf.text.includes(BODY_A) && crlf.redacted === 1, JSON.stringify(crlf));

  const unclosed = redactPemBlocks(`${pemBegin(PEM_LABEL_RSA)}\n${BODY_A}\n`);
  ok('未闭合块保守遮到末尾', !unclosed.text.includes(BODY_A) && unclosed.redacted === 1, JSON.stringify(unclosed));

  const prose = PROSE_PEM;
  const proseR = redactPemBlocks(prose);
  ok('只有标头的代码示例保持可读',
    proseR.text === prose && proseR.redacted === 0 && !hasPemSecret(prose), JSON.stringify(proseR));

  ok('hasPemSecret 对完整块为真', hasPemSecret(PEM_OPENSSH) === true);
  ok('scanEgress 对完整块报规则名', scanEgress(PEM_OPENSSH) === '私钥块', String(scanEgress(PEM_OPENSSH)));
  const masked = maskEgress(`说明\n${PEM_OPENSSH}\n结尾`);
  ok('maskEgress 打码后自证通过且不漏正文',
    masked.trusted === true && !masked.text.includes(BODY_A)
      && masked.rules.includes('私钥块') && masked.text.includes('说明') && masked.text.includes('结尾'),
    JSON.stringify(masked));
  const log = maskSecrets(`日志：${PEM_OPENSSH}`);
  ok('maskSecrets 抹掉日志里的完整块', !log.includes(BODY_A) && log.includes('[私钥块已脱敏]'), log);
  const deep = maskSecretsDeep({ raw: PEM_OPENSSH, nested: { prompt: `前 ${PEM_B} 后` }, n: 1 });
  ok('maskSecretsDeep 抹掉嵌套对象里的所有块',
    !JSON.stringify(deep).includes(BODY_A) && !JSON.stringify(deep).includes(BODY_B)
      && deep.n === 1 && deep.nested.prompt.includes('前') && deep.nested.prompt.includes('后'),
    JSON.stringify(deep));
}

// ── ② 已知运行时凭据：折行前先抹，不能靠分段后匹配 ────────────────────────
{
  const SECRET = 'runtime-secret-value-1234567890-abcdef';
  setRuntimeSecrets([SECRET]);
  const pre = redactCredentialsBeforeShape(`key=${SECRET} 后面`);
  ok('redactCredentialsBeforeShape 先抹运行时凭据',
    !pre.text.includes(SECRET) && pre.text.includes('***') && pre.rules.includes('运行时凭据值'),
    JSON.stringify(pre));
  setRuntimeSecrets([]);

  const cfg = sampleConfig();
  cfg.reply = { ...cfg.reply, splitToken: '||', maxCharsPerChunk: 20, maxChunks: 6 };
  const brain = new Brain(cfg, new SessionStore(cfg));
  setRuntimeSecrets([SECRET]);
  const reply = brain.parseReply(`key=${SECRET}`);
  ok('长凭据在 hardWrap（20 字）之前就被抹掉',
    reply.chunks.length > 0 && !reply.chunks.join('').includes(SECRET)
      && !reply.chunks.join('').includes('runtime-secret-value'),
    JSON.stringify(reply));
  setRuntimeSecrets([]);
}

// ── ③ parseReply / 主动链：块级脱敏先于分段 ──────────────────────────────
{
  const cfg = sampleConfig();
  cfg.reply = { ...cfg.reply, splitToken: '||', maxCharsPerChunk: 20, maxChunks: 6 };
  const brain = new Brain(cfg, new SessionStore(cfg));

  const normal = brain.parseReply(`第一段 || ${PEM_OPENSSH} || 第三段`);
  ok('parseReply 的分段里没有 PEM 正文',
    !normal.chunks.join('\n').includes(BODY_A) && normal.chunks.join('\n').includes('第一段')
      && normal.chunks.join('\n').includes('第三段') && String(normal.masked || '').includes('私钥块'),
    JSON.stringify(normal));

  const longBody = brain.parseReply(PEM_RSA);
  ok('只有私钥块时不会把正文当回复发出去',
    !longBody.chunks.join('\n').includes(BODY_A), JSON.stringify(longBody));

  const prose = brain.parseReply(PROSE_PEM);
  ok('parseReply 不误杀只有标头的说明文字',
    prose.chunks.join('\n').includes(pemBegin('PRIVATE KEY')) && !prose.masked,
    JSON.stringify(prose));
}

if (fails.length) {
  console.log(`PEM 脱敏判据：${pass} 项通过，${fails.length} 项失败`);
  for (const f of fails) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`PEM 脱敏判据：${pass} 项通过，0 项失败`);
