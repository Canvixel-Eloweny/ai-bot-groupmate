/**
 * 夜间产出的判据（挂在定时消息上：`custom.trigger.scheduled[]` 的 prompt / target）。
 *
 * 这一份只钉**纯函数**与**接线**，不起进程、不连模型：
 *   · nightly.js 的三件纯事（认不认、投哪、提示词长什么样）；
 *   · 归一化**往返之后仍在**（D17 的教训：只断言"面板有没有渲染"是不够的，
 *     字段在 readCustom 里被静默剥掉的话，表现是"看起来能用"的死路）；
 *   · index.js 的三处接线（夜间一轮跑在睡眠之前 / 群发循环跳过 owner 条目 / 第二个发送点不存在）。
 *
 * 跑法：node test/check-nightly.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isNightly, nightlyTargetOf, nightlyMessages, transcriptOf, NIGHTLY_MAX_CHARS, NIGHTLY_MAX_TOKENS } from '../src/nightly.js';
import { readCustom } from '../src/custom-config.js';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const indexJs = fs.readFileSync(path.join(APP, 'src', 'index.js'), 'utf8');
const appJs = fs.readFileSync(path.join(APP, 'panel', 'next', 'app.js'), 'utf8');

let pass = 0;
const fails = [];
const ok = (name, cond) => { if (cond) pass += 1; else fails.push(name); };
const eq = (name, got, want) => ok(`${name}（得到 ${JSON.stringify(got)}）`, JSON.stringify(got) === JSON.stringify(want));

/* ── ① 认不认：只有 prompt 有内容才算"要生成" ───────────────────────── */
ok('只有 text 的条目不是夜间产出', !isNightly({ at: '04:00', text: '早安' }));
ok('prompt 有内容 → 是夜间产出', isNightly({ at: '04:00', prompt: '写摘要' }));
ok('prompt 只有空白 → 不是', !isNightly({ at: '04:00', prompt: '   ' }));
ok('空条目不崩', !isNightly(null) && !isNightly(undefined));
ok('两条都填时仍按 prompt 生成', isNightly({ text: '旧文案', prompt: '写周报' }));

/* ── ② 投哪：认不出回落 group（写错不该静默丢件） ───────────────────── */
eq('owner 目标', nightlyTargetOf({ target: 'owner' }), 'owner');
eq('缺省目标', nightlyTargetOf({ target: 'group' }), 'group');
eq('乱填的目标回落 group', nightlyTargetOf({ target: '私聊' }), 'group');

/* ── ③ 素材整理 ───────────────────────────────────────────────────── */
eq('空记录给空串', transcriptOf([]), '');
eq('压平换行、丢掉过短行', transcriptOf(['群友：你好\n在吗', 'x', '   ', '我：在呢']), '群友：你好 在吗\n我：在呢');
const long = transcriptOf(Array.from({ length: 200 }, (_, i) => `群友：第 ${i} 条消息，长度够 4 个字`));
ok('超限截尾（取最后 N 字符）', long.length <= NIGHTLY_MAX_CHARS && long.endsWith('字'));
const many = transcriptOf(Array.from({ length: 200 }, (_, i) => `群友：第 ${i} 条`), { maxLines: 5 });
eq('maxLines 只留最后 5 行', many.split('\n').length, 5);
ok('maxChars 下界不被 0 或负数搞坏', transcriptOf(['群友：abcdefgh'], { maxChars: 0 }).length === 0);

/* ── ④ 提示词形状 ─────────────────────────────────────────────────── */
const msgs = nightlyMessages({ name: '小鱼', prompt: '把今天群里聊的事写个摘要', transcript: '群友：今天在修船' });
eq('两条消息（system + user）', msgs.length, 2);
ok('system 带名字', msgs[0].content.includes('小鱼'));
ok('system 要求纯文本、不 @ 人', /纯文本/.test(msgs[0].content) && /不要 @ 任何人/.test(msgs[0].content));
ok('user 带任务与素材', msgs[1].content.includes('把今天群里聊的事写个摘要') && msgs[1].content.includes('群友：今天在修船'));
ok('没素材时明确"别编造"', nightlyMessages({ prompt: '写摘要' })[1].content.includes('别编造'));
ok('maxTokens 是给夜间产出用的常量', NIGHTLY_MAX_TOKENS > 0 && NIGHTLY_MAX_TOKENS <= 2000);

/* ── ⑤ 归一化往返：prompt / target 必须活下来（D17 的坑） ──────────── */
const rt = readCustom({
  custom: {
    trigger: {
      scheduled: [
        { id: 'n1', at: '04:00', prompt: '把今天群里聊的事写个摘要', target: 'owner', enabled: true },
        { id: 'n2', at: '09:00', text: '早安', enabled: true },
        { id: 'n3', at: '10:00', prompt: '写周报', target: 'group', on: 'workday' },
      ],
    },
  },
});
const got = rt.trigger.scheduled;
eq('三条都留下（prompt-only 不被丢）', got.length, 3);
eq('prompt 往返后仍在', got[0].prompt, '把今天群里聊的事写个摘要');
eq('target 往返后仍在', got[0].target, 'owner');
eq('没写 target 的回落 group', got[1].target, 'group');
eq('只有 prompt 的条目 text 是空串（不是 undefined）', got[2].text, '');
eq('on 与 prompt 同时活下来', got[2].on, 'workday');
const bad = readCustom({ custom: { trigger: { scheduled: [{ id: 'x', at: '04:00' }] } } });
eq('既没 text 也没 prompt 的条目仍被丢掉', bad.trigger.scheduled.length, 0);

/* ── ⑥ 接线：index.js ─────────────────────────────────────────────── */
ok('导入 nightly 模块', /from '\.\/nightly\.js'/.test(indexJs));
// 调度线只有一条（第二处 dueMsOf 就是第二个发件口）
ok('到期判定只有一处 dueMsOf', (indexJs.match(/dueMsOf\(/g) || []).length === 1);
// 睡眠/免打扰改成逐条判断：owner 夜间产出豁免，其它条目照旧被挡
ok('睡眠与免打扰改成逐条判断（不再提前 return 整条链）',
  !/if \(sleepSnap\?\.asleep\) return;/.test(indexJs) && /const asleep = !!sleepSnap\?\.asleep;/.test(indexJs)
  && /const quiet = inQuietHours\(hour\);/.test(indexJs));
ok('owner 夜间产出豁免睡眠/免打扰，其它条目仍被挡',
  /const toOwner = isNightly\(s\) && nightlyTargetOf\(s\) === 'owner';\n\s*if \(!toOwner && \(asleep \|\| quiet\)\) continue;/.test(indexJs));
ok('主动开口仍受睡眠/免打扰管', /if \(asleep \|\| quiet\) return;/.test(indexJs));
ok('owner 条目走私聊、且不占群发计划', /if \(toOwner\) await sayToOwner\(body\);/.test(indexJs)
  && /const targets = toOwner \? \[\{ group: ownerIds\(\)\[0\] \|\| '-', send: true \}\] : planFor\(groups\);/.test(indexJs));
ok('群发循环里 prompt 条目现写', /const body = isNightly\(s\) \? await composeNightly\(s\) : s\.text;/.test(indexJs));
// 主链路那一条 + 主动链那一条（deliverFromBot）。
// 2026-10-19：再加一处 —— 图片工具 `send_image`（它发的是图片段，没有文字可供
// 「分句 / 出口闸门 / 发送节奏」处理，所以刻意不走 deliverFromBot；只发当前会话）。
ok('发送点只有三处：主链路 + deliverFromBot + 发图工具', (indexJs.match(/await bot\.sendMsg\(/g) || []).length === 3
  && /bot\.sendMsg\(scene, id, payload\)/.test(indexJs)
  && /bot\.sendMsg\(scene, String\(chatId\), \[textSegment/.test(indexJs)
  && /bot\.sendMsg\(scene, chatId, \[imageSegment\(imageFileOf\(got\.bytes\)\)\]\)/.test(indexJs));
ok('私聊出站走 deliverFromBot，不另开第二条', /async function sayToOwner\(text\)/.test(indexJs) && /deliverFromBot\('private', id, text\)/.test(indexJs));
ok('没配 owner.qq 时明确报错（不静默吞掉）', /没配 owner\.qq，夜间产出没有收件人/.test(indexJs));
ok('生成时关思考（小额度会被 reasoning 吃光）', /thinking: \{ mode: 'off' \}/.test(indexJs.slice(indexJs.indexOf('async function composeNightly'))));
ok('夜间产出的花费计入用量（别偷账）', /recordUsage\(\{ \.\.\.usage, source: USAGE_SOURCES\.nightly \}\)/.test(indexJs));

/* ── ⑦ 接线：面板 ─────────────────────────────────────────────────── */
ok('面板能编辑 prompt', /data-p="\$\{i\}\|prompt"/.test(appJs));
ok('面板能选投递目标', /data-p="\$\{i\}\|target"/.test(appJs) && /发主人私聊/.test(appJs));

/* ── 结果 ─────────────────────────────────────────────────────────── */
const total = pass + fails.length;
if (fails.length) {
  console.log(`\n夜间产出判据：${pass} 项通过，${fails.length} 项失败`);
  for (const f of fails) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`\n夜间产出判据：${total} 项通过，0 项失败`);
console.log('  ✓ 认条目 / 投递目标 / 素材整理 / 提示词 / 归一化往返 / 接线 都对得上');
