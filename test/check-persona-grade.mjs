/**
 * 角色卡十维判据（0.1.2）。
 *
 * 为什么这些断言必须存在：
 *   面板上那个颜色是**用来决定"这张卡能不能上"的**。分数算错不会报错，
 *   只会让人以为卡已经好了 —— 所以每一档门槛、每一条证据来源都要有能复现的样例。
 *   特别是"只靠关键词进不了现实格"这条：它是用户「现实格要均满分」要求的实现。
 *
 * 跑法：node test/check-persona-grade.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TEN_DIMS, CARD_TIERS, CELL_TIER, TIER_LABEL, tierOf, gradePersonaCard, adviceOf, fieldForDim,
} from '../src/persona-grade.js';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0; const bad = [];
const ok = (name, cond) => { if (cond) pass += 1; else bad.push(name); };
const F = (s) => 'x'.repeat(0) + s;

/** 十维全写实（每维字段 ≥20 字）→ 应该判「现实格」。 */
function fullCard(extra = {}) {
  const fields = {};
  for (const d of TEN_DIMS) for (const k of d.fields) if (!fields[k]) fields[k] = `${k}：这是一段够长的说明文字，用来让这一维有实物证据。`;
  return { name: '全写实', fields: { ...fields, limits: '不懂编程，也不会写代码，遇到技术问题只能听人说。', secrets: '没读过大学，这件事只在被问到时才说。', ...extra } };
}

// ── ① 维度表本身 ────────────────────────────────────────────────
ok('十维', TEN_DIMS.length === 10);
ok('每维都有问法与字段', TEN_DIMS.every((d) => d.question && d.fields.length));
ok('字段键都在 24 项人格键内', TEN_DIMS.flatMap((d) => d.fields).every((k) =>
  ['world','values','decide','stress','emotion','habits','speech','lines','secrets','limits','relation',
   'age','role','traits','tone','catch','faces','desire','fear','logic','attitude','status','growth','meters'].includes(k)));

// ── ② 五色阶梯（灰 绿 蓝 紫 金）──────────────────────────────────
ok('阶梯边界：0.29 灰', tierOf(0.29) === 'gray');
ok('阶梯边界：0.30 绿', tierOf(0.30) === 'green');
ok('阶梯边界：0.50 蓝', tierOf(CARD_TIERS.low) === 'blue');
ok('阶梯边界：0.66 紫', tierOf(CARD_TIERS.full) === 'purple');
ok('阶梯边界：0.90 金', tierOf(CARD_TIERS.real) === 'gold');
ok('五格→五色：残缺灰/演绎绿/完美蓝/具像紫/现实金',
  CELL_TIER['残缺格'] === 'gray' && CELL_TIER['演绎格'] === 'green' && CELL_TIER['完美格'] === 'blue'
  && CELL_TIER['具像格'] === 'purple' && CELL_TIER['现实格'] === 'gold');
ok('档位有中文', TIER_LABEL.gold === '金');

// ── ③ 每一维的两路证据 ──────────────────────────────────────────
const one = gradePersonaCard({ name: 'a', fields: { world: '这是一个当代都市的世界，有超自然但不多。' } });
const w = one.dims.find((d) => d.id === 'world');
ok('字段 ≥20 字：满分 1.0', w.score === 1 && w.source === 'field');
const short = gradePersonaCard({ name: 'b', fields: { world: '都市' } });
ok('字段有字但太短：0.6 半截', short.dims.find((d) => d.id === 'world').score === 0.6);
const cue = gradePersonaCard({ name: 'c', fields: { age: '世界 时代 设定 大陆' } });
ok('只靠关键词：命中多个也只到 0.8（进不了金档）', cue.dims.find((d) => d.id === 'world').score === 0.8);
ok('关键词证据封顶 < 现实门槛', 0.8 < CARD_TIERS.real);
const none = gradePersonaCard({ name: 'd', fields: {} });
ok('空卡：十维全 0、残缺格', none.dims.every((d) => d.score === 0) && none.cell === '残缺格');

// ── ④ 五格阶梯（严格、先中先出）──────────────────────────────────
const gold = gradePersonaCard(fullCard());
ok('十维全写实：现实格（每一维都到金档）', gold.cell === '现实格' && gold.allReal && gold.minScore >= CARD_TIERS.real);
ok('现实格是 gold', gold.cellTier === 'gold');
const goldAdvice = adviceOf('现实格');
ok('现实格话术点明"每一维都到金档"', /每一维都到金档/.test(goldAdvice));

const oneLow = gradePersonaCard(fullCard({ world: '' }));
ok('差一维（有一维 <0.50）：不是现实格，是演绎格', oneLow.cell === '演绎格' && oneLow.hasLow);

// 全部 ≥0.66 但没有边界 → 具像格。
// 造法只能靠证据词：`limits/secrets` **就是**边界那两格，字段写实了边界必然为 1 ——
// 所以"十维够材料却没边界"只可能出现在"词都提过、字段没写实"的卡上（这正是它要提醒的病）。
const noBounds = { name: '无边界', fields: { age: TEN_DIMS.flatMap((d) => d.cues).join('、') } };
const concrete = gradePersonaCard(noBounds);
ok('十维都够材料（≥0.66）却没有边界：具像格',
  concrete.cell === '具像格' && concrete.boundary === 0 && concrete.allFilled);

// 没有低维、有边界、但覆盖不够满 → 完美格
const midFields = {};
for (const d of TEN_DIMS) for (const k of d.fields) if (!midFields[k]) midFields[k] = 'x'.repeat(0) + '这一段文字有二十个字以上，用来当实物证据。';
midFields.world = '短';  // 一维只有 0.6（有字但太短）：不低于 0.50，所以不是演绎
const perfect = gradePersonaCard({ name: 'p', fields: midFields });
ok('无低维、有边界、覆盖不满：完美格', perfect.cell === '完美格' && !perfect.allReal && !perfect.hasLow);

const broken = gradePersonaCard({ name: 'q', fields: { world: '短' } });
ok('材料本来就不够（覆盖 <0.30）：残缺格', broken.cell === '残缺格' && broken.coverage < 0.30);

// ── ⑤ 缺项清单 & 补全字段 ───────────────────────────────────────
ok('缺项带问法', gold.gaps.length === 0 && broken.gaps.every((g) => g.question));
ok('缺项带目标字段', broken.gaps.every((g) => g.field && g.field.length > 0));
ok('补全选第一个空字段', fieldForDim({ fields: { logic: '已有' } }, 'logic') === 'decide' || fieldForDim({ fields: { logic: '已有' } }, 'logic') === 'logic');
ok('全填了还给第一个字段（有地方可写）', fieldForDim(fullCard(), 'reasoning') === 'lines');
ok('grid 里没有重复维度', new Set(gold.dims.map((d) => d.id)).size === 10);

// ── ⑥ 接线：面板确实读得到，且判据只此一份 ───────────────────────
const collector = fs.readFileSync(path.join(APP, 'panel/lib/state-collector.js'), 'utf8');
const schemaJs = fs.readFileSync(path.join(APP, 'panel/next/schema.js'), 'utf8');
const appJs = fs.readFileSync(path.join(APP, 'panel/next/app.js'), 'utf8');
const css = fs.readFileSync(path.join(APP, 'panel/next/style.css'), 'utf8');
ok('状态下发里算了分级', /personaCards: \(custom\.skills \|\| \[\]\)/.test(collector) && /gradePersonaCard\(sk\)/.test(collector));
ok('面板页存在（角色卡分级）', schemaJs.includes("id: 'cardgrade'") && schemaJs.includes("t: 'cardGrade'"));
ok('渲染器存在', /cardGrade: \(x\) =>/.test(appJs));
ok('补全动作接线', appJs.includes('cg.fill') && appJs.includes('cg.do') && /function fillCardDim\(/.test(appJs));
ok('补全写的是 gap.field 且会保存', /gap\.field/.test(appJs) && /return commitDraft\(\)/.test(appJs));
ok('五色圆点 CSS 齐全', ['gray','green','blue','purple','gold'].every((t) => css.includes(`.cgdot.t-${t}`)));
ok('零依赖叶子：判据模块自己 import 任何东西了吗', !/^\s*import /m.test(fs.readFileSync(path.join(APP, 'src/persona-grade.js'), 'utf8')));

console.log(bad.length
  ? `角色卡十维判据：${pass} 项通过，${bad.length} 项失败\n${bad.map((n) => `  ✗ ${n}`).join('\n')}`
  : `角色卡十维判据：${pass} 项通过，0 项失败\n  ✓ 十维 / 五色阶梯 / 两路证据 / 五格严格阶梯 / 缺项补全 / 面板接线 都对得上`);
process.exit(bad.length ? 1 : 0);
