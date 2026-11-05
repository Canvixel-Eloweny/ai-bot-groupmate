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
import { fileURLToPath } from 'node:url';

// `new URL(...).pathname` 会把非 ASCII 路径**百分号编码**（群友迁移报告里那批扩展
// 就是在中文目录下 import 失败），本机路径含中文时这个脚本会一样打不开。用 fileURLToPath。
const SRC = fileURLToPath(new URL('../src/', import.meta.url));
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
// 2026-11-03 重锚：引用侧的图现在**两个来源**（引用消息自己的图 + 引用那条聊天记录里的图），
// 所以旧的"qp.images 之后 200 字符内出现 slice(0,3)"这种距离启发式不再描述实现。
// 改成逐个点名：并集那一步在、封顶那一步在 —— 比距离匹配更严，也不会因为加注释就假红。
ok('引用图与引用聊天记录里的图一起并入（两个来源都收）',
  /const qImages = \[\.\.\.\(qp\.images \|\| \[\]\), \.\.\.\(qf\.images \|\| \[\]\)\];/.test(indexSrc));
ok('引用侧并进识图列表且封顶 3',
  /parsed\.images = \[\.\.\.new Set\(\[\.\.\.qImages, \.\.\.mine\]\)\]\.slice\(0, 3\);/.test(indexSrc));

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

// ── ⑥ 合并转发节点里的图片 + 入站图内联（2026-11-03 · 群友报告复验）────────
// 旧症状：转发一段带截图的聊天记录给她，模型只看到一串「[图片]」；
//         直接发图问"这是啥"，回的是"我这边刷不出来"，而 trace 的 vision 记着 1 张。
const { nodeSegmentsOf } = await import(`${SRC}forward-expand.js`);
const nodeImgs = flattenMessage(
  nodeSegmentsOf({ message: [{ type: 'text', data: { text: '看这张' } }, { type: 'image', data: { url: 'https://gchat.qpic.cn/x.png' } }] }),
  1,
  { probe: false },
);
ok('节点段里的图能被 flattenMessage 收出来（收集源在）', nodeImgs.images.length === 1, JSON.stringify(nodeImgs.images));

const fe = fs.readFileSync(`${SRC}forward-expand.js`, 'utf8');
const imagesSrc = fs.readFileSync(`${SRC}images.js`, 'utf8');
const visionSrc = fs.readFileSync(`${SRC}vision.js`, 'utf8');
ok('renderNode 把 flat.images 推进收集数组（不再是只取 .text）',
  /for \(const u of flat\.images \|\| \[\]\) forwardImages\.push\(u\)/.test(indexSrc));
ok('expandForwardText 的返回体带 images',
  /return \{ text, images: forwardImages\.slice\(0, 3\), stat \}/.test(indexSrc));
ok('失败回落时 images 一起回落成空数组（不留下半截图）',
  /return \{ text: '', images: \[\], stat \}/.test(indexSrc));
ok('收集到的图并进 parsed.images 且去重封顶 3',
  /new Set\(\[\.\.\.\(parsed\.images \|\| \[\]\), \.\.\.forward\.images\]\)\]\.slice\(0, 3\)/.test(indexSrc));
ok('引用「一条聊天记录」复用同一个展开器（不另写第二份展开）',
  /await expandForwardText\(\{ message: qMsg/.test(indexSrc));
// 内联这一条是"我们看到了图、模型没看到"的根因：QQ 的地址带签名且会过期。
ok('识图准备层在位且走取字节 + data URL',
  /export async function prepareVisionImages\(/.test(visionSrc) && /data:\$\{mime\};base64/.test(visionSrc));
ok('主链路真的调用它（写了没人读是本项目的头号形状）',
  /prepareVisionImages\(\{ list: parsed\.images, imageBytesOf, log \}\)/.test(indexSrc)
  && /parsed\.images = preparedVision\.images/.test(indexSrc));
ok('只在开了识图且模型支持时才下载（纯文本模型不必白拉一次字节）',
  /supportsVision\(cfg\.llm\?\.model[\s\S]{0,200}cfg\.llm\?\.features\?\.vision[\s\S]{0,120}prepareVisionImages/.test(indexSrc));
ok('单张下载失败原样保留 URL（不抹掉这张图）',
  /images\.push\(raw\)/.test(visionSrc));
ok('内联上限独立于 view_image 的 8MB', /VISION_INLINE_MAX_BYTES = 1_500_000/.test(imagesSrc));

if (fails.length) {
  console.log(`模型与消息可靠性判据：${pass} 项通过，${fails.length} 项失败`);
  for (const f of fails) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`模型与消息可靠性判据：${pass} 项通过，0 项失败`);
console.log('  ✓ 群图允许根 / 引用取数 / length 重试 / token 额度 / type 归一化 / 转发节点图 / 入站图内联 都对得上');
