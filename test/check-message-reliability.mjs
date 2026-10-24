/**
 * 模型与消息可靠性判据（2026-10-22 · B 批）。
 *
 * 跑法：`node test/check-message-reliability.mjs`
 * 覆盖：群图本地文件兜底、引用取数接线、空回复 length 重试、小额 token 额度、
 * 工具参数 type 归一化。判据都尽量走纯函数；接线用源码断言。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SRC = new URL('../src/', import.meta.url).pathname;
const { flattenMessage } = await import(`${SRC}onebot.js`);
const { normalizeParameters } = await import(`${SRC}tool-registry.js`);

let pass = 0;
const fails = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass += 1; return; }
  fails.push(detail ? `${name} —— ${detail}` : name);
};

// ── ① 群图本地文件兜底 ──────────────────────────────────────────────────
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'napcat-img-'));
const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'napcat-out-'));
try {
  fs.writeFileSync(path.join(root, 'a.png'), png);
  fs.writeFileSync(path.join(outside, 'b.png'), png);
  const old = process.env.NAPCAT_IMAGE_DIR;
  process.env.NAPCAT_IMAGE_DIR = root;

  const rel = flattenMessage([{ type: 'image', data: { file: 'a.png' } }], 1);
  ok('相对文件名能在允许根里找到', rel.images.length === 1 && /^data:image\/png;base64,/.test(rel.images[0]), JSON.stringify(rel.images));

  const absIn = flattenMessage([{ type: 'image', data: { file: path.join(root, 'a.png') } }], 1);
  ok('允许根内的绝对路径也能读', absIn.images.length === 1);

  const absOut = flattenMessage([{ type: 'image', data: { file: path.join(outside, 'b.png') } }], 1);
  ok('允许根外的绝对路径不读', absOut.images.length === 0, JSON.stringify(absOut.images));

  const http = flattenMessage([{ type: 'image', data: { url: 'https://example.com/a.png' } }], 1);
  ok('http(s) 原样保留', http.images.length === 1 && http.images[0] === 'https://example.com/a.png');

  const unc = flattenMessage([{ type: 'image', data: { file: 'file://server/share/a.png' } }], 1);
  ok('UNC file:// 不读', unc.images.length === 0);

  if (old === undefined) delete process.env.NAPCAT_IMAGE_DIR;
  else process.env.NAPCAT_IMAGE_DIR = old;
} finally {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
}

// ── ② 引用取数接线（静态：必须真的 get_msg，而不是只拿 id）───────────────
const indexSrc = fs.readFileSync(`${SRC}index.js`, 'utf8');
ok('引用消息补取 get_msg', /parsed\.replyTo[\s\S]{0,500}?bot\.call\('get_msg'/.test(indexSrc));
ok('引用正文进提示词', /\[引用\$\{who \? ` \$\{who\}` : ''\}：\$\{quoted\}\]/.test(indexSrc));
ok('引用图并进识图列表且封顶 3', /qp\.images[\s\S]{0,200}?slice\(0, 3\)/.test(indexSrc));

// ── ③ 空回复 length 重试 ────────────────────────────────────────────────
const llmSrc = fs.readFileSync(`${SRC}llm.js`, 'utf8');
ok('空回复带 finish_reason 诊断', /finishReason === 'length'/.test(llmSrc) && /err\.finishReason = finishReason/.test(llmSrc));
ok('同模型抬额度只重试一次', /lengthRetry = false/.test(llmSrc) && /lengthRetry: true/.test(llmSrc) && /baseMaxTokens \* 4/.test(llmSrc));
ok('可关思考的模型重试时关思考', /THINK\.OFFABLE \? \{ mode: 'off' \}/.test(llmSrc));

// ── ④ 小额旁路额度与新装默认 ────────────────────────────────────────────
const memorySrc = fs.readFileSync(`${SRC}memory.js`, 'utf8');
const configSrc = fs.readFileSync(`${SRC}config.js`, 'utf8');
const exampleSrc = fs.readFileSync(new URL('../config.example.json', import.meta.url), 'utf8');
ok('记忆判断额度 2000', /maxTokens: 2000/.test(memorySrc));
ok('主动搭话额度 800', /maxTokens: 800/.test(indexSrc));
ok('新装默认 1200', /asInt\(raw\.llm\?\.maxTokens, 1200\)/.test(configSrc));
ok('配置模板不再写死 400', !/"maxTokens": 400/.test(exampleSrc) && /"maxTokens": 1200/.test(exampleSrc));

// ── ⑤ 工具参数 type 归一化 ──────────────────────────────────────────────
const n1 = normalizeParameters({
  type: 'object',
  properties: {
    model: { type: ['integer', 'string'] },
    list: { type: 'array', items: { type: ['string', 'null'] } },
    nested: { type: 'object', properties: { n: { type: ['number', 'null'] } } },
  },
});
ok('顶层 type 数组收敛成第一个非 null', n1?.properties?.model?.type === 'integer', JSON.stringify(n1?.properties?.model));
ok('items 里的数组也收敛', n1?.properties?.list?.items?.type === 'string', JSON.stringify(n1?.properties?.list));
ok('嵌套 properties 也收敛', n1?.properties?.nested?.properties?.n?.type === 'number');
ok('非法顶层仍拒绝', normalizeParameters({ type: 'array', properties: {} }) === null);
ok('合法单类型原样', normalizeParameters({ type: 'object', properties: { x: { type: 'string' } } })?.properties?.x?.type === 'string');

if (fails.length) {
  console.log(`模型与消息可靠性判据：${pass} 项通过，${fails.length} 项失败`);
  for (const f of fails) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`模型与消息可靠性判据：${pass} 项通过，0 项失败`);
console.log('  ✓ 群图允许根 / 引用取数 / length 重试 / token 额度 / type 归一化 都对得上');
