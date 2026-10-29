#!/usr/bin/env node
/**
 * 人设工厂核心合同测试（零浏览器、零依赖）。
 *
 * 它盯四件事：
 *  ① 单文件产物是最新的（源码改过但忘记 build 会红）；
 *  ② 工厂六章的字段钥匙与运行时 schema 完全对齐，没有第二套人格；
 *  ③ 预设 / 上限 / 预算 / MBTI / 星座 / 导出都按合同工作；
 *  ④ 超限只报错、不静默截断。
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const HTML = path.join(ROOT, 'panel', 'next', 'persona-factory.html');
const fails = [];
const ok = (cond, msg) => {
  console.log(`${cond ? '  ✓' : '  ✗'} ${msg}`);
  if (!cond) fails.push(msg);
};

const build = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'build-persona-factory.mjs'), '--check'], {
  cwd: ROOT, encoding: 'utf8',
});
console.log('\n── 单文件产物 ──');
ok(build.status === 0, `单文件是最新的（${(build.stdout || build.stderr || '').trim()}）`);

const html = fs.readFileSync(HTML, 'utf8');
const coreMatch = html.match(/\/\* PERSONA-STUDIO-CORE:BEGIN \*\/([\s\S]*?)\/\* PERSONA-STUDIO-CORE:END \*\//);
ok(!!coreMatch, '单文件里有唯一的 PERSONA-STUDIO-CORE 区块');
if (!coreMatch) {
  console.log(`\n${fails.length} 项失败`);
  process.exit(1);
}
const ctx = { console };
vm.createContext(ctx);
vm.runInContext(coreMatch[1], ctx, { filename: 'persona-studio-core.js' });
const C = ctx.PersonaStudioCore;
ok(!!C && !!C.PRESETS && !!C.compile, '核心在浏览器 vm 里可用');

console.log('\n── 视觉基准（参考版对齐）──');
ok(/<svg class="brand-mark"[^>]*viewBox="0 0 1024 1024"/.test(html)
  && html.includes('id="pf-brand-grad"') && html.includes('d="M512 100C282 100'),
  '品牌使用维护者提供的 SVG logo');
ok(/<span class="brand-copy"><strong>Estrella Persona Studio<\/strong><small>人设工厂<\/small><\/span>/.test(html),
  '品牌排版：英文主行在上、中文副行在下');
ok(html.includes('class="site-header"') && html.includes('class="studio-grid"') && !html.includes('class="intro"'),
  '页内顶栏 / 两栏工作台骨架在位（营销 hero 与页脚已移除）');
ok(!html.includes('class="site-footer"') && !html.includes('step-line'), '无隐藏页脚 / 无死步骤线');
ok(html.includes('class="stepper" id="chapterRail"') && html.includes('id="stepCounter"'),
  '横向步骤条与步骤计数在位');
ok(html.includes('class="preview-panel" id="preview"') && html.includes('class="button button-primary" id="btnDeliver"'),
  '右侧实时预览与页内交付入口在位');
ok(/\.site-header\s*\{[^}]*height:\s*48px/.test(html)
  && /grid-template-columns:\s*minmax\(0, 1fr\) 480px/.test(html)
  && /max-width:\s*1360px/.test(html) && /position:\s*sticky/.test(html),
  '控制台嵌入：48px 页眉、内容居中两栏（480px 预览）且不强行拉满');
ok(html.includes('class="page-deco"') && html.includes('deco-books') && html.includes('deco-spread')
  && html.includes('deco-inkwell') && html.includes('deco-bookmark') && html.includes('deco-letter')
  && html.includes('deco-sprig')
  && /--rail-center:\s*calc\(\(50vw - 680px\) \/ 2\)/.test(html)
  && /\.deco-books\s*\{[^}]*width:\s*clamp\(88px/.test(html),
  '书香装饰（七件线稿）进入产物并锚在 1360px 内容两侧');
ok(/@keyframes step-in-back/.test(html) && /\.form-step\[data-dir="back"\]/.test(html)
  && /\.preview-tab::after\s*\{[^}]*transform:\s*scaleX\(0\)/.test(html)
  && /\.button-copy\.is-copied/.test(html),
  '交互增强：回退步方向动画 / 预览页签滑入下划线 / 复制成功态');
ok(/--paper:\s*#f5f3eb/.test(html) && /--violet:\s*#6b58b9/.test(html), '参考版暖纸 / 紫罗兰主色在位');
ok(!/设计参考|PersonaResearch|research-dialog|research-data/.test(html), '外部资料抽屉与其数据未进入产物');
ok(!/ps-appbar|startScreen|id="btnTheme"/.test(html), '旧 appbar / 启动页 / 主题开关已移除');
ok(!/https?:\/\//.test(html), '产物不含外部 http(s) 请求');

const {
  PERSONA_KEYS, PERSONA_LONG_KEYS, PERSONA_FIELD_LIMITS, ENHANCE_KEYS, SCENES,
} = await import('../src/custom-config.js');
const { MBTI_AXES, MBTI_TYPES, MBTI_DEFAULT_AXES } = await import('../src/mbti.js');
const { STAR_SIGNS, ZODIAC_ANIMALS } = await import('../src/birthday.js');
const { budgetOf } = await import('../src/context-budget.js');
const { patchCustom } = await import('../src/custom-config.js');

console.log('\n── 字段合同 ──');
ok(JSON.stringify(C.PERSONA_KEYS) === JSON.stringify(PERSONA_KEYS), '人格 11 键与运行时逐字相同');
ok(JSON.stringify(C.ENHANCE_KEYS) === JSON.stringify(ENHANCE_KEYS), '增强 12 键与运行时逐字相同');
ok(JSON.stringify(C.SCENE_KEYS) === JSON.stringify(Object.keys(SCENES)), '场景 9 键与运行时逐字相同');
ok(JSON.stringify(C.FALLBACK_SCHEMA.personaLongKeys) === JSON.stringify(PERSONA_LONG_KEYS), '人格长字段名单同源');
ok(C.FALLBACK_SCHEMA.limits.name === PERSONA_FIELD_LIMITS.name
  && C.FALLBACK_SCHEMA.limits.short === PERSONA_FIELD_LIMITS.short
  && C.FALLBACK_SCHEMA.limits.long === PERSONA_FIELD_LIMITS.long
  && C.FALLBACK_SCHEMA.limits.scene === PERSONA_FIELD_LIMITS.scene
  && C.FALLBACK_SCHEMA.limits.mbtiNote === PERSONA_FIELD_LIMITS.mbtiNote, '字段上限同源');
const budgets = budgetOf({}).sections;
ok(['persona', 'enhance', 'scenes', 'mbti', 'astro'].every((k) => C.FALLBACK_SCHEMA.budgets[k] === budgets[k]),
  '预算数字同源（persona / enhance / scenes / mbti / astro）');
ok(JSON.stringify(C.FALLBACK_SCHEMA.mbti.axes) === JSON.stringify(MBTI_AXES), 'MBTI 四轴同源');
ok(JSON.stringify(Object.keys(C.FALLBACK_SCHEMA.mbti.types)) === JSON.stringify(Object.keys(MBTI_TYPES)), 'MBTI 16 型同源');
ok(JSON.stringify(C.FALLBACK_SCHEMA.birthday.signs.map((s) => s.name)) === JSON.stringify(STAR_SIGNS.map((s) => s.name)), '十二星座同源');
ok(JSON.stringify(C.FALLBACK_SCHEMA.birthday.animals) === JSON.stringify(ZODIAC_ANIMALS), '十二生肖同源');
ok(JSON.stringify(C.FALLBACK_SCHEMA.mbti.defaultAxes) === JSON.stringify(MBTI_DEFAULT_AXES), 'MBTI 默认四轴同源');
{
  const baseFile = path.join(ROOT, 'persona', 'qq-chat.md');
  const baseChars = fs.existsSync(baseFile) ? fs.readFileSync(baseFile, 'utf8').trim().length : 913;
  ok(C.FALLBACK_SCHEMA.basePersonaChars === baseChars, `离线底子字数与 persona/qq-chat.md 同源（${baseChars} 字符）`);
}

console.log('\n── 六个底色 ──');
const allowedCustom = new Set(['persona', 'enhance', 'scenes', 'replyStyle', 'mbti', 'birthday', 'astroOn']);
for (const preset of C.PRESETS) {
  const d = C.createDraft(preset.id);
  C.applyAnswers(d);
  d.personaName = '测试' + preset.name;
  const c = C.compile(d, C.FALLBACK_SCHEMA);
  const v = C.validate(d, C.FALLBACK_SCHEMA);
  const b = v.budget;
  const allPersona = PERSONA_KEYS.every((k) => typeof c.custom.persona[k] === 'string');
  const allEnhance = ENHANCE_KEYS.every((k) => typeof c.custom.enhance[k] === 'string');
  const allScenes = Object.keys(SCENES).every((k) => typeof c.custom.scenes[k] === 'string');
  const unknown = Object.keys(c.custom).filter((k) => !allowedCustom.has(k));
  const overBudget = Object.keys(b.used).filter((k) => b.limits[k] && b.used[k] > b.limits[k]);
  ok(v.errors.length === 0, `${preset.id}：预设无阻断错误（${v.errors.map((e) => e.path).join(',') || 'ok'}）`);
  ok(allPersona && allEnhance && allScenes, `${preset.id}：人格 / 增强 / 场景键齐全`);
  ok(unknown.length === 0, `${preset.id}：compile 只产出运行时认识的键（${unknown.join(',') || 'ok'}）`);
  ok(overBudget.length === 0, `${preset.id}：预设预算不超（${overBudget.join(',') || 'ok'}）`);
  ok(c.included.mbti === false && c.included.birthday === false, `${preset.id}：没碰 MBTI/生日时不会写进 patch`);
  ok(!c.custom.mbti && !c.custom.birthday && !c.custom.astroOn, `${preset.id}：可选层确实没出现在 custom 里`);
}

console.log('\n── 超限 / 预算：只报错不截断 ──');
{
  const d = C.createDraft('warm-listener');
  C.applyAnswers(d);
  d.personaName = '边界测试';
  d.fields.persona.role = '甲'.repeat(PERSONA_FIELD_LIMITS.short + 1);
  const v = C.validate(d, C.FALLBACK_SCHEMA);
  const c = C.compile(d, C.FALLBACK_SCHEMA);
  ok(v.errors.some((e) => e.path === 'persona.role'), '短字段超 300 被报错');
  ok(c.custom.persona.role.length === PERSONA_FIELD_LIMITS.short + 1, 'compile 不静默截断超限字段');

  d.fields.persona.role = '正常身份';
  d.fields.persona.logic = '乙'.repeat(PERSONA_FIELD_LIMITS.long + 1);
  ok(C.validate(d, C.FALLBACK_SCHEMA).errors.some((e) => e.path === 'persona.logic'), '长字段超 1,200 被报错');

  d.fields.persona.logic = '';
  d.fields.scenes.insulted = '丙'.repeat(PERSONA_FIELD_LIMITS.scene + 1);
  ok(C.validate(d, C.FALLBACK_SCHEMA).errors.some((e) => e.path === 'scenes.insulted'), '场景超 500 被报错');

  d.fields.scenes.insulted = '';
  d.fields.mbti.note = '丁'.repeat(PERSONA_FIELD_LIMITS.mbtiNote + 1);
  d.answers.mbtiTouched = true;
  ok(C.validate(d, C.FALLBACK_SCHEMA).errors.some((e) => e.path === 'mbti.note'), 'MBTI 备注超 500 被报错');

  d.fields.mbti.note = '';
  d.fields.persona.logic = '戊'.repeat(PERSONA_FIELD_LIMITS.long);
  d.fields.persona.desire = '己'.repeat(PERSONA_FIELD_LIMITS.long);
  d.fields.persona.fear = '庚'.repeat(PERSONA_FIELD_LIMITS.long);
  d.fields.persona.attitude = '辛'.repeat(PERSONA_FIELD_LIMITS.long);
  d.fields.persona.status = '壬'.repeat(PERSONA_FIELD_LIMITS.long);
  const b = C.budgetOfDraft(d, C.FALLBACK_SCHEMA);
  ok(b.over.includes('persona'), '人格段超预算被预测出来');
}

console.log('\n── MBTI / 星座 ──');
for (const type of Object.keys(MBTI_TYPES)) {
  ok(C.typeFromAxes(C.axesForType(type)) === type, `四轴 ↔ 类型往返：${type}`);
}
ok(C.signOf(1, 19, STAR_SIGNS).name === '摩羯座', '1/19 仍是摩羯');
ok(C.signOf(1, 20, STAR_SIGNS).name === '水瓶座', '1/20 进入水瓶');
ok(C.signOf(12, 21, STAR_SIGNS).name === '射手座', '12/21 仍是射手');
ok(C.signOf(12, 22, STAR_SIGNS).name === '摩羯座', '12/22 进入摩羯');
ok(C.animalOf({ age: 0, month: 1, day: 1 }, ZODIAC_ANIMALS) === '', '没填参考周岁时不猜生肖');
ok(ZODIAC_ANIMALS.includes(C.animalOf({ age: 30, month: 1, day: 1 }, ZODIAC_ANIMALS)), '填了参考周岁时给出有效生肖');
{
  const d = C.createDraft('warm-listener');
  C.applyAnswers(d);
  d.personaName = '可选层';
  d.fields.mbti.on = true;
  d.answers.mbtiTouched = true;
  d.fields.birthday = { age: 30, month: 8, day: 3 };
  const c = C.compile(d, C.FALLBACK_SCHEMA);
  ok(c.included.mbti && c.included.birthday, '碰过 MBTI / 填了生日后进入 patch');
  ok(c.custom.mbti.on === true && c.custom.mbti.axes.EI === d.fields.mbti.axes.EI, 'MBTI 开关与四轴被带上');
  ok(c.custom.birthday.month === 8 && c.custom.birthday.day === 3 && c.custom.astroOn === false, '生日被带上，星座注入保持关闭');
}

console.log('\n── 导出 / 回导 ──');
{
  const d = C.createDraft('calm-strategist');
  C.applyAnswers(d);
  d.personaName = '回导测试';
  const obj = C.exportJson(d, C.FALLBACK_SCHEMA);
  ok(obj.format === 'estrella-persona-studio' && obj.version === 1, '导出的 format/version 正确');
  ok(obj.personaName === '回导测试' && !!obj.custom && !!obj.studioState, '导出含 personaName / custom / studioState');
  const next = patchCustom({}, obj.custom);
  for (const k of PERSONA_KEYS) {
    ok(String(next.persona[k] || '') === String(obj.custom.persona[k] || '').slice(0, PERSONA_LONG_KEYS.includes(k) ? PERSONA_FIELD_LIMITS.long : PERSONA_FIELD_LIMITS.short),
      `回导后 persona.${k} 不被截断`);
  }
  for (const k of ENHANCE_KEYS) {
    const lim = ['values', 'habits', 'speech', 'meters'].includes(k) ? PERSONA_FIELD_LIMITS.short : PERSONA_FIELD_LIMITS.long;
    ok(String(next.enhance[k] || '') === String(obj.custom.enhance[k] || '').slice(0, lim), `回导后 enhance.${k} 不被截断`);
  }
  for (const k of Object.keys(SCENES)) {
    ok(String(next.scenes[k] || '') === String(obj.custom.scenes[k] || '').slice(0, PERSONA_FIELD_LIMITS.scene), `回导后 scenes.${k} 不被截断`);
  }
  const md = C.exportMarkdown(d, C.FALLBACK_SCHEMA);
  ok(md.includes('# 回导测试') && md.includes('## 身份') && md.includes('## 性格')
    && md.includes('## 语言') && md.includes('## 群聊') && md.includes('## 关系与边界')
    && md.includes('## 对话样例'), 'Markdown 含六章标题');
  ok(md.includes('虚构角色') && md.includes('能力以宿主'), 'Markdown 带安全声明');
}

console.log('\n── 起始方式 ──');
{
  const blank = C.createDraft('blank');
  ok(!!blank && blank.fields.persona.role === '' && blank.fields.persona.traits === '', '空白开始不预填人格');
  const current = C.fromState({
    config: { personaName: '旧名字' },
    custom: {
      persona: { role: '旧身份', traits: '旧性格' },
      enhance: { limits: '旧底线' },
      scenes: { insulted: '旧场景' },
      mbti: { on: true, axes: { EI: 30, SN: 40, TF: 60, JP: 70 }, note: '旧备注' },
      birthday: { age: 20, month: 2, day: 3 },
      astroOn: true,
      replyStyle: { length: 'long' },
    },
  });
  ok(current.personaName === '旧名字' && current.fields.persona.role === '旧身份', '从当前人格读取昵称 / 人格');
  ok(current.fields.mbti.axes.EI === 30 && current.fields.birthday.month === 2, '从当前人格读取 MBTI / 生日');
  const card = C.fromCard({ name: '旧卡', fields: { role: '卡身份', limits: '卡底线', scenes: { silent: '卡冷场' } } }, {
    config: { personaName: '当前' },
    custom: { persona: { role: '当前身份' }, enhance: {}, scenes: {}, replyStyle: { length: 'normal' } },
  });
  ok(card.personaName === '旧卡' && card.fields.persona.role === '卡身份' && card.fields.enhance.limits === '卡底线' && card.fields.scenes.silent === '卡冷场', '从角色卡读取人格 / 增强 / 场景快照');
}

console.log('');
if (fails.length) {
  console.log(`✗ 人设工厂核心合同失败 ${fails.length} 项`);
  process.exit(1);
}
console.log('✓ 人设工厂核心合同通过');
