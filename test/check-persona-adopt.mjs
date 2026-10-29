// 角色卡「AI 认领」判据 —— 纯函数 + 接线 + 一次真实的"拒绝路径"。
//
// 盯三件事：
//   ① 提示词与解析（`src/persona-adopt.js`）：十维一个不多一个不少、未知键丢掉、
//      空值不许写、每维有上限 —— 这是"模型胡说写进卡"的唯一防线；
//   ② 接线：面板路由进了 `API_ROUTES` 与 `READ_ONLY_POST`（**不进** `WRITE_ROUTES`：
//      它不落盘）、脚本走 stdin、提示词只有一份；
//   ③ 脚本真能起：喂一个空输入，它必须**快速报错退出**（不调模型、不挂住）。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  adoptMessages, parseAdopt, adoptFields, ADOPT_MAX_INPUT, ADOPT_DIM_CHARS, ADOPT_MAX_FIELD, ADOPT_DIM_IDS,
} from '../src/persona-adopt.js';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0;
const fails = [];
function ok(name, cond) {
  if (cond) { pass += 1; return; }
  fails.push(name);
}
const read = (rel) => fs.readFileSync(path.join(APP, rel), 'utf8');

// ── ① 提示词 ─────────────────────────────────────────────────────────────
const msgs = adoptMessages({ name: '阿蓝', text: '她住在南湖的一条船上。怕黑，晚上要开灯。' });
ok('两条消息：system + user', msgs.length === 2 && msgs[0].role === 'system' && msgs[1].role === 'user');
ok('系统提示词要求"不许编造"', /不许编造/.test(msgs[0].content));
ok('系统提示词列出了十维的 id', ADOPT_DIM_IDS.every((id) => msgs[0].content.includes(id)));
ok('系统提示词给了每维上限', msgs[0].content.includes(String(ADOPT_DIM_CHARS)));
ok('用户消息带上了名字', msgs[1].content.includes('阿蓝'));
ok('用户消息带上了卡里的文字', msgs[1].content.includes('怕黑'));
ok('素材超长会被截断', adoptMessages({ name: 'x', text: '啊'.repeat(ADOPT_MAX_INPUT * 2) })[1].content.length <= ADOPT_MAX_INPUT + 200);

// ── ② 解析：只收十维、不许空写 ────────────────────────────────────────────
const good = parseAdopt(JSON.stringify({ [ADOPT_DIM_IDS[0]]: ' 她在船上开灯 ', 自创字段: '不该收' }));
ok('解析出提到的那一维', good.byDim[ADOPT_DIM_IDS[0]] === '她在船上开灯');
ok('未知键被丢掉', !Object.keys(good.byDim).includes('自创字段'));
ok('filled 与 missing 对得上', good.filled === 1 && good.missing.length === ADOPT_DIM_IDS.length - 1);
ok('带代码块围栏也能解析', parseAdopt('```json\n{"world":"船上"}\n```').byDim.world === '船上');
ok('前面有废话也能抠出 JSON', parseAdopt(`好的，结果是：${JSON.stringify({ world: '船上' })}`).byDim.world === '船上');
ok('非字符串的值不收', Object.keys(parseAdopt(JSON.stringify({ world: 42, values: ['a'] })).byDim).length === 0);
ok('只有空格的值当成没写', Object.keys(parseAdopt(JSON.stringify({ world: '   ' })).byDim).length === 0);
ok('每维输出被截到上限', parseAdopt(JSON.stringify({ world: '啊'.repeat(ADOPT_DIM_CHARS * 2) })).byDim.world.length === ADOPT_DIM_CHARS);
const junk = parseAdopt('模型今天不想干活');
ok('垃圾输出 → 全 missing，不抛', junk.filled === 0 && junk.missing.length === ADOPT_DIM_IDS.length);
ok('数组输出也不用抛', parseAdopt('[1,2,3]').filled === 0);

// ── ③ 字段映射：只在空字段上落地 ─────────────────────────────────────────
const byDim = { world: '南湖的船上', values: '不骗人' };
const m1 = adoptFields(byDim, { fields: {} });
ok('两维各写一个字段', m1.wrote.length === 2 && Object.keys(m1.fields).length === 2);
ok('wrote 带 label / field / chars', m1.wrote.every((w) => w.label && w.field && w.chars > 0 && w.text));
ok('该维只有一个字段且已填 → 仍指向它（不覆盖由面板的「只填空字段」兜）', (() => {
  const r = adoptFields({ world: '南湖的船上' }, { fields: { world: '旧内容' } });
  return r.wrote.length === 1 && r.wrote[0].field === 'world';
})());
ok('同一字段不会被两维同时占', (() => {
  const r = adoptFields({ world: 'a', values: 'b', fear: 'c' }, { fields: {} });
  const keys = r.wrote.map((w) => w.field);
  return new Set(keys).size === keys.length;
})());
ok('没认领的维度不产生 wrote', adoptFields({}, { fields: {} }).wrote.length === 0);
ok('落进字段的内容也被截到上限', takeLong() <= ADOPT_MAX_FIELD);
function takeLong() {
  const r = adoptFields({ world: '啊'.repeat(ADOPT_MAX_FIELD * 2) }, { fields: {} });
  return r.fields[r.wrote[0].field].length;
}

// ── ④ 接线 ───────────────────────────────────────────────────────────────
const scriptRel = 'scripts/adopt-card.mjs';
ok('脚本存在', fs.existsSync(path.join(APP, scriptRel)));
const script = read(scriptRel);
ok('脚本复用同一份提示词（不许自己再写一遍）', /from '\.\.\/src\/persona-adopt\.js'/.test(script));
ok('脚本关掉思考（小额度必须配 thinking）', /thinking: \{ mode: 'off' \}/.test(script));
ok('脚本记进用量账本', /recordUsage\(/.test(script));
ok('脚本吃 stdin（卡文本不走 argv）', /for await \(const c of process\.stdin\)/.test(script));

const srv = read('panel/server.js');
ok('路由登记了 /api/persona/adopt', /path: '\/api\/persona\/adopt', method: 'POST', handler: apiPersonaAdopt/.test(srv));
const wrBlock = srv.slice(srv.indexOf('const WRITE_ROUTES'), srv.indexOf('function isWriteRequest'));
// 我们的口径与对方不同：认领会花一次模型调用并记用量，所以归 WRITE_ROUTES
// （token + 审计 + 同源），而不是无鉴权的 READ_ONLY_POST。
ok('进了 WRITE_ROUTES（花模型调用，必须带 token + 审计）', wrBlock.includes("'/api/persona/adopt'"));
const roBlock = srv.slice(srv.indexOf('const READ_ONLY_POST'), srv.indexOf('const WRITE_ROUTES'));
ok('没有混进 READ_ONLY_POST（它与"只读"不是一回事）', !roBlock.includes("'/api/persona/adopt'"));
ok('服务端也挡了"太短的卡"', /text\.trim\(\)\.length < 20/.test(srv));
ok('进程壳把卡文本写进子进程 stdin', /child\.stdin\.write\(JSON\.stringify\(payload\)\)/.test(srv));
ok('调用有超时（本机模型慢，也不许永远挂着）', /ADOPT_TIMEOUT_MS = \d+/.test(srv) && /setTimeout\(\(\) => \{[\s\S]{0,120}child\.kill\(\)/.test(srv));

const appjs = read('panel/next/app.js');
ok('动作 cg.adopt 在 ACTIONS 里', /'cg\.adopt': \(i\) => adoptCard\(Number\(i\)\)/.test(appjs));
ok('分级页有「AI 认领」按钮', /data-a="cg\.adopt"/.test(appjs));
ok('前端打的是 adopt 路由', /\/api\/persona\/adopt/.test(appjs) && /method: 'POST'/.test(appjs));
ok('合并时**只填空字段**', /if \(String\(fields\[w\.field\] \|\| ''\)\.trim\(\)\) continue;/.test(appjs));
ok('写进卡之后重新保存（否则分级看不到变化）', /function applyAdopt\(\)[\s\S]{0,1200}commitDraft\(\)/.test(appjs));

// ② 数据目录：完整包不带空目录，入口得自己建
const idx = read('src/index.js');
ok('入口建了 DATA_DIR（完整包解压后没有 app\\data）', /ensureUserDirs\(\)/.test(idx));

// ── ⑤ 脚本真能起：空输入必须快速报错退出（不调模型）──────────────────────
const r = spawnSync(process.execPath, [path.join(APP, scriptRel)], { input: '{}', encoding: 'utf8', timeout: 20000 });
let out = null;
try { out = JSON.parse(String(r.stdout || '').trim().split('\n').filter(Boolean).pop() || ''); } catch { /* 下面判 */ }
ok('空输入 → 退出码非 0', r.status !== 0);
ok('空输入 → 输出 ok:false 且说明了原因', !!(out && out.ok === false && /20 字/.test(out.error)));

if (fails.length) {
  for (const f of fails) console.log(`✗ ${f}`);
  console.log(`\n✗ check-persona-adopt：${fails.length} 项失败 / ${pass} 项通过`);
  process.exit(1);
}
console.log(`✓ check-persona-adopt：${pass} 项通过`);
