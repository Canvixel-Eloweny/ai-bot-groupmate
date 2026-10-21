// 「聊天等待 + 图片两件套」判据 —— 纯函数 + 归一化 + 接线。
//
// 盯的是四件容易悄悄退化的事：
//   ① 等待参数归一化（布尔 false / 上下界 / 垃圾值回落）；
//   ② 停顿区间（随机两端都不能越界、关掉就恒为 0）；
//   ③ 图片判据（三种来源、嗅探、私网/相对路径不被当成可发的东西）；
//   ④ 接线（连发合并只走 enqueueFor、垫话走同一出口、两个工具按开关注册、面板有控件）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  WAIT_DEFAULTS, waitTuningOf, humanDelayMs,
} from '../src/waiting.js';
import {
  classifyImageArg, imageMimeOf, imageFileOf, looksLikeImagePath, IMAGE_MAX_BYTES, VIEW_IMAGE_PROMPT,
} from '../src/images.js';
import { readCustom } from '../src/custom-config.js';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0;
const fails = [];
function ok(name, cond) {
  if (cond) { pass += 1; return; }
  fails.push(name);
}
const read = (rel) => fs.readFileSync(path.join(APP, rel), 'utf8');

// ── ① 归一化 ─────────────────────────────────────────────────────────────
ok('看图提示词只描述、不替模型编内容', VIEW_IMAGE_PROMPT.includes('描述') && VIEW_IMAGE_PROMPT.length > 10);
const d = waitTuningOf({});
ok('缺省 = 默认值（开、400–2500、每字 15、合并 1.2s、垫话 6s）',
  d.enabled === true && d.minMs === 400 && d.maxMs === 2500 && d.perCharMs === 15
  && d.mergeMs === 1200 && d.holdMs === 6000 && d.typing === true);
ok('只认布尔 false 作为关闭',
  waitTuningOf({ wait: { enabled: 'no' } }).enabled === true
  && waitTuningOf({ wait: { enabled: false } }).enabled === false);
ok('垃圾数字回落默认（"abc" / -5）',
  waitTuningOf({ wait: { minMs: 'abc', perCharMs: -5 } }).minMs === WAIT_DEFAULTS.minMs
  && waitTuningOf({ wait: { perCharMs: -5 } }).perCharMs === WAIT_DEFAULTS.perCharMs);
ok('maxMs 至少不低于 minMs（填反了也不会算出负区间）',
  (() => { const t = waitTuningOf({ wait: { minMs: 900, maxMs: 100 } }); return t.minMs === 900 && t.maxMs === 900; })());
ok('垫话文案截到 40 字，缺省是「我想想…」',
  waitTuningOf({ wait: { holdText: 'x'.repeat(100) } }).holdText.length === 40
  && waitTuningOf({}).holdText === WAIT_DEFAULTS.holdText);
ok('typing 也只认布尔 false', waitTuningOf({ wait: { typing: 0 } }).typing === true);

// ── ② 停顿区间 ───────────────────────────────────────────────────────────
ok('关掉 ⇒ 恒 0（不管字数、不管随机）',
  humanDelayMs({ chars: 999, tuning: { ...WAIT_DEFAULTS, enabled: false } }) === 0);
ok('随机两端都在 [min, max] 内',
  humanDelayMs({ tuning: WAIT_DEFAULTS, rng: () => 0 }) === WAIT_DEFAULTS.minMs
  && humanDelayMs({ tuning: WAIT_DEFAULTS, rng: () => 1 }) === WAIT_DEFAULTS.maxMs);
ok('字数往上加但不越上限',
  humanDelayMs({ chars: 30, tuning: { ...WAIT_DEFAULTS, minMs: 100, maxMs: 400, perCharMs: 20 }, rng: () => 0 }) === 400);
ok('rng 越界也被夹住', humanDelayMs({ tuning: WAIT_DEFAULTS, rng: () => 9 }) === WAIT_DEFAULTS.maxMs);

// ── ③ 图片判据 ───────────────────────────────────────────────────────────
ok('http(s) 认成 url', classifyImageArg('https://a/b.png').kind === 'url');
ok('Windows 绝对路径认成 file', classifyImageArg('C:\\pics\\a.jpg').kind === 'file');
ok('POSIX 绝对路径认成 file', classifyImageArg('/tmp/a.png').kind === 'file');
ok('base64:// 剥掉协议头', (() => { const r = classifyImageArg('base64://AAAA'); return r.ok && r.kind === 'base64' && r.value === 'AAAA'; })());
ok('空 / 相对路径 / 超长一律拒（不猜）',
  !classifyImageArg('').ok && !classifyImageArg('a/b.png').ok && !classifyImageArg(`https://a/${'x'.repeat(2100)}`).ok);
ok('嗅探 png / jpeg / gif / webp / bmp',
  imageMimeOf(Buffer.from([0x89, 0x50, 0x4e, 0x47])) === 'image/png'
  && imageMimeOf(Buffer.from([0xff, 0xd8, 0xff, 0xe0])) === 'image/jpeg'
  && imageMimeOf(Buffer.from('GIF89a')) === 'image/gif'
  && imageMimeOf(Buffer.from('RIFF0000WEBP')) === 'image/webp'
  && imageMimeOf(Buffer.from('BM0000')) === 'image/bmp');
ok('认不出的字节返回空串（不猜）', imageMimeOf(Buffer.from('hello')) === '');
ok('交给协议端的形状是 base64://',
  imageFileOf(Buffer.from('hi')).startsWith('base64://'));
ok('扩展名只用来提前给一句人话', looksLikeImagePath('a.PNG') && !looksLikeImagePath('a.exe'));
ok('字节上限有值且不是 0', IMAGE_MAX_BYTES >= 1024 * 1024);

// ── ④ readCustom 往返（面板保存整份替换，这里漏了就等于抹掉用户设置）──
const back = readCustom({ custom: { wait: { holdMs: 9000, holdText: '等我翻翻' }, image: { view: false } } });
ok('wait 经 readCustom 之后还在',
  back.wait.holdMs === 9000 && back.wait.holdText === '等我翻翻');
// 我们的口径：图片工具默认关（开着会改变每次请求的工具定义），只有真的是 true 才开。
const backImg = readCustom({ custom: { image: { send: true, view: false } } });
ok('image 经 readCustom 之后还在（只认布尔 true/false）',
  backImg.image.view === false && backImg.image.send === true
  && readCustom({}).image.send === false && readCustom({}).image.view === false);

// ── ⑤ 接线（静态）────────────────────────────────────────────────────────
const idx = read('src/index.js');
ok('连发合并只有一处入队（enqueueWithMerge → enqueueFor）',
  /function enqueueWithMerge\(evt\)/.test(idx) && /void enqueueFor\(evt\);/.test(idx));
ok('合并只并同一个人（key 带发送者），不把两个人的话揉成一个人的',
  /const key = `\$\{scene\}:\$\{chatId\}:\$\{evt\.user_id \?\? ''\}`/.test(idx));
ok('点名（@/引用）不等、也不被合并掉（mentionsSelf → 立刻入队 + 把前一批冲出去）',
  /function mentionsSelf\(evt\)/.test(idx) && /if \(mentionsSelf\(evt\)\) \{/.test(idx));
ok('合并掉的几条进背景段（mergedLines → rememberAmbient）',
  /mergedLines/.test(idx) && /rememberAmbient\(session, ln\.sender/.test(idx));
ok('停顿时长只用 humanDelayMs 算', /humanDelayMs\(/.test(idx) && idx.match(/humanDelayMs\(/g).length === 1);
ok('停顿在 markThinking 之前、判定之后', idx.indexOf('humanDelayMs(') < idx.indexOf('markThinking(true, { scene, id: String(id)'));
ok('垫话走同一个出口 deliverFromBot', /deliverFromBot\(scene, id, waitTuning\.holdText\)/.test(idx));
ok('正在输入用 set_input_status（私聊才发）',
  /set_input_status/.test(idx) && /scene !== 'private'/.test(idx));
ok('收尾处一定收气泡（stopTyping 在 finally 里）',
  /if \(holdTimer\) \{ clearTimeout\(holdTimer\); holdTimer = null; \}\n      stopTyping\(\);/.test(idx));
ok('两个工具都注册了', /id: 'send_image'/.test(idx) && /id: 'view_image'/.test(idx));
ok('发图先下载再以 base64 交给协议端', /imageFileOf\(got\.bytes\)/.test(idx) && /safeFetch\(src\.value/.test(idx));
ok('看图小额旁路显式关思考', /maxTokens: 400, thinking: \{ mode: 'off' \}/.test(idx));
ok('看图前先判模型看不看得见（与入站看图同源）',
  /supportsVision\(cfg\.llm\?\.model, cfg\.llm\?\.provider, cfg\.llm\?\.declaredFeatures\)/.test(idx)
  && /if \(!canSee\) \{/.test(idx));
ok('两个开关都只在启动时决定注册', /if \(cfg\.custom\?\.image\?\.send === true\)/.test(idx)
  && /if \(cfg\.custom\?\.image\?\.view === true\)/.test(idx));

const sch = read('panel/next/schema.js');
ok('面板有「聊天等待与图片」页', /label: '聊天等待与图片'/.test(sch));
ok('等待与图片都绑到 custom 下的新字段',
  /bind: 'wait\.enabled'/.test(sch) && /bind: 'wait\.mergeMs'/.test(sch)
  && /bind: 'image\.send'/.test(sch) && /bind: 'image\.view'/.test(sch));

// ── 结果 ─────────────────────────────────────────────────────────────────
if (fails.length) {
  console.error(`✗ check-wait-images：${fails.length} 项失败`);
  for (const f of fails) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`✓ check-wait-images：${pass} 项通过`);
