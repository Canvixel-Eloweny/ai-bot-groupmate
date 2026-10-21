/**
 * 反模板闸（D 改造）判据。
 *
 * 为什么单独立一份：这道闸的动作是**改文本**（削形状），改错了的后果是
 * "它把话说到一半"，比不削更难查 —— 所以每条规则都要有能复现的样例，
 * 而且「不撞就不动」「太短就不削」「绝不削成空」三条必须是断言，不是注释。
 *
 * 跑法：node test/check-anti-template.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TEMPLATE_RULES, openingOf, skeletonOf, lenBucketOf, templateHitOf, deTemplate,
} from '../src/anti-template.js';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0; const bad = [];
const ok = (name, cond) => { if (cond) pass += 1; else bad.push(name); };

// ── ① 纯函数：形状抽取 ────────────────────────────────────────
ok('起手取三字、去引号括号', openingOf('「行吧，今天真热」') === '行吧，');
ok('短句起手原样', openingOf('嗯') === '嗯');
ok('骨架只留标点', skeletonOf('好，那就这样吧。') === '，。');
ok('骨架空串安全', skeletonOf('') === '');
ok('长度档 20 字一档', lenBucketOf('x'.repeat(20)) === 1 && lenBucketOf('') === 0);
ok('长度档封顶 4', lenBucketOf('x'.repeat(500)) === 4);

// ── ② 三条规则各自能命中 ──────────────────────────────────────
const zinger = deTemplate(['好呀——毕竟我是鱼', '行吧——毕竟我是鱼'], ['今天下雨了——毕竟我是鱼']);
ok('破折号抖机灵：命中', zinger.hit === TEMPLATE_RULES.zinger);
ok('破折号抖机灵：削到破折号前', zinger.changed && zinger.chunks[0] === '今天下雨了');

const opening = deTemplate(['行吧，今天好热', '行吧，明天也热'], ['行吧，这话我接不住']);
ok('同词起手：命中', opening.hit === TEMPLATE_RULES.opening);
ok('同词起手：削掉半句起手', opening.changed && opening.chunks[0] === '这话我接不住');

const shape = deTemplate(['今天好热，我好困。', '明天也好热，我也困。'], ['后天好热，我还困。']);
ok('同骨架（短句＋逗号＋短句、同长度档）：命中', shape.hit === TEMPLATE_RULES.shape);

// ── ③ 不该动的地方一处都不动 ──────────────────────────────────
ok('只有一句历史：不算模板', templateHitOf(['好呀——我是鱼'], ['今天——我也是鱼']) === '');
ok('没有历史：不算模板', templateHitOf([], ['今天——我也是鱼']) === '');
ok('破折号只用过一次：不动', deTemplate(['今天好热——真热'], ['下雨了——真下']).changed === false);
ok('不同起手：不动起手', deTemplate(['行吧，好热', '好嘛，好热'], ['诶，这话我接不住']).hit !== TEMPLATE_RULES.opening);
ok('不撞任何规则：原样返回', (() => {
  const r = deTemplate(['今天好热', '明天也热'], ['诶，这雨下得我发懵']);
  return r.hit === '' && r.changed === false && r.chunks[0] === '诶，这雨下得我发懵';
})());

// ── ④ 边界：削不出东西时宁可不动（绝不能把话削没）────────────────
const only = deTemplate(['——', '——'], ['——']);
ok('全是破折号：不削成空', only.chunks.length === 1 && only.chunks[0].trim() !== '');
const short = deTemplate(['行吧，热', '行吧，好热'], ['行吧，']); 
ok('起手削完太短：不动', short.changed === false && short.chunks[0] === '行吧，');
ok('空 chunks 安全', deTemplate(['行吧，热', '行吧，好热'], []).chunks.length === 0);

// ── ⑤ 接线：判据只用一处实现，管线里真的接上了 ──────────────────
const indexJs = fs.readFileSync(path.join(APP, 'src/index.js'), 'utf8');
ok('管线 import 了 deTemplate', /import \{ deTemplate \} from '\.\/anti-template\.js';/.test(indexJs));
ok('取历史里它自己说过的话', /filter\(\(m\) => m\.role === 'assistant'\)/.test(indexJs));
ok('闸在 parseReply 之后', indexJs.indexOf('deTemplate(recentOwn, parsedChunks)') > indexJs.indexOf('brain.parseReply(reply)'));
ok('削了要打日志', /反模板闸：\$\{tmpl\.hit\}/.test(indexJs));
ok('trace 落 template 字段', /rec\.template = \{ hit: tmpl\.hit, changed: tmpl\.changed \};/.test(indexJs));
ok('闸不拦整条（没有 return / silent 分支挂在它身上）', !/if \(tmpl\.hit\)[\s\S]{0,200}return;/.test(indexJs));
ok('零依赖叶子：不 import 任何模块', !/^\s*import /m.test(fs.readFileSync(path.join(APP, 'src/anti-template.js'), 'utf8')));

console.log(bad.length
  ? `反模板闸判据：${pass} 项通过，${bad.length} 项失败\n${bad.map((n) => `  ✗ ${n}`).join('\n')}`
  : `反模板闸判据：${pass} 项通过，0 项失败\n  ✓ 三条规则 / 不越界 / 绝不削空 / 管线接线 都对得上`);
process.exit(bad.length ? 1 : 0);
