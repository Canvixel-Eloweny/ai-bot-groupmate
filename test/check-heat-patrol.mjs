// 「热度权重 + 巡逻」判据 —— 两个纯函数叶子 + 判定接线 + 面板/落盘接线。
//
// 盯三类容易悄悄退化的事：
//   ① 热值算式（回升 / 扣温 / 冷却链 / 底线 / 群活跃度）—— 改了数字或顺序要有人知道；
//   ② 巡逻计划（门槛 / 间隔 / 概率随热度走 / 摘要形状）与合成事件形状；
//   ③ 接线：判定里真有那一支、tick 里真挂了它、面板真读得到、关掉真能关。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HEAT_BASE, HEAT_FLOOR, HEAT_NIGHT_FLOOR, HEAT_JITTER, HEAT_CHAIN_MAX, HEAT_COOL_STEP,
  heatIsNight, heatFloor, newHeatEntry, normalizeHeatEntry, noteHeatTurn,
  heatCoolOf, heatWeightOf, heatBandOf, chatHeatOf, CHAT_HEAT_TARGET, heatLine,
  FEEDBACK_HEAT_FLOOR, feedbackHeatOf, noteFeedbackHeat,
} from '../src/heat.js';
import {
  PATROL_DEFAULTS, patrolTuningOf, patrolDigestOf, patrolPlanOf, patrolEventOf,
} from '../src/patrol.js';
import { Brain } from '../src/brain.js';
import { restLineOf, REST_LINE_SLEEPY, REST_LINE_VERY_TIRED } from '../src/reply-text.js';
import { readCustom } from '../src/custom-config.js';
import { DECISION_KINDS, TIER_OF_KIND } from '../src/tier.js';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0;
const fails = [];
function ok(name, cond) {
  if (cond) { pass += 1; return; }
  fails.push(name);
}
const read = (rel) => fs.readFileSync(path.join(APP, rel), 'utf8');
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;
const DAY = new Date(2026, 9, 18, 14, 0, 0).getTime(); // 本地 14:00（非半夜）
const NIGHT = new Date(2026, 9, 18, 1, 0, 0).getTime();

// ── ① 热值算式 ───────────────────────────────────────────────────────────
{
  const e = newHeatEntry(DAY, 0.5);
  ok('新建条目在基线附近（±抖动）', near(e.w, HEAT_BASE) && HEAT_JITTER === 0.03);
  ok('新建条目字段齐（w/at/decayedAt/chain）',
    e.at === DAY && e.decayedAt === DAY && e.chain === 0);

  const bad = normalizeHeatEntry({ w: 5, at: 'x', chain: 99 }, DAY);
  ok('读旧账本：越界夹住、坏值回默认',
    bad.w <= 1 && bad.chain === HEAT_CHAIN_MAX && bad.at === DAY);
  ok('null 条目 ⇒ 新建（不编一个看起来正常的数）', normalizeHeatEntry(null, DAY).w >= 0.7);

  const t = newHeatEntry(DAY, 0.5);
  // at 与 now 对齐 ⇒ 回升为 0，只剩扣温那一项可断言。
  t.at = DAY + 60_000;
  noteHeatTurn(t, DAY + 60_000);
  ok('聊一轮：扣 0.02、链 +1', near(t.w, HEAT_BASE - 0.02) && t.chain === 1);
  const w1 = t.w;
  noteHeatTurn(t, DAY + 90_000);
  ok('60 秒内再聊不叠加扣温（只回升）', t.w >= w1 && t.chain === 1);
  const w2 = t.w;
  noteHeatTurn(t, DAY + 180_000);
  ok('隔 60 秒再聊：按链加重（>0.02）', t.chain === 2 && t.w < w2 - 0.02);

  const cold = { w: HEAT_FLOOR, at: DAY, decayedAt: DAY, chain: 2 };
  noteHeatTurn(cold, DAY);
  ok('到白天地板就不再掉（0.6）', near(cold.w, HEAT_FLOOR) && cold.chain === 2);

  const night = { w: HEAT_NIGHT_FLOOR, at: NIGHT, decayedAt: NIGHT, chain: 0 };
  noteHeatTurn(night, NIGHT);
  ok('半夜底线是 0.3', heatFloor(NIGHT) === HEAT_NIGHT_FLOOR && near(night.w, HEAT_NIGHT_FLOOR));
  ok('半夜判定跨零点（23–3）', heatIsNight(new Date(2026, 9, 18, 23, 30).getTime())
    && heatIsNight(new Date(2026, 9, 18, 2, 0).getTime())
    && !heatIsNight(new Date(2026, 9, 18, 12, 0).getTime()));

  const rec = { w: 0.5, at: DAY - 2 * 3_600_000, decayedAt: DAY, chain: 0 };
  noteHeatTurn(rec, DAY);
  ok('安静两小时回升 0.3、封顶基线', near(rec.w, HEAT_BASE));

  ok('冷却权重 = 链 × 0.15（封顶 1）',
    near(heatCoolOf({ chain: 2 }), 2 * HEAT_COOL_STEP) && heatCoolOf({ chain: 99 }) === 1);
  ok('开口权重 = 1 - 冷却', near(heatWeightOf({ chain: 2 }), 1 - 2 * HEAT_COOL_STEP)
    && heatWeightOf(null) === 1);

  ok('温度档：热络 / 有点烦 / 冷淡 / 很不耐烦',
    heatBandOf(0.8) === '热络' && heatBandOf(0.65) === '有点烦'
    && heatBandOf(0.4) === '冷淡' && heatBandOf(0.1) === '很不耐烦');

  ok('群活跃度：空 / 越新越热 / 满热有上限',
    chatHeatOf([], DAY) === 0
    && chatHeatOf([{ at: DAY }], DAY) > 0
    && chatHeatOf([{ at: DAY }], DAY) >= chatHeatOf([{ at: DAY - 20 * 60_000 }], DAY)
    && chatHeatOf(Array.from({ length: CHAT_HEAT_TARGET }, () => ({ at: DAY })), DAY) <= 1);
  ok('群活跃度：窗口外的老消息不算', chatHeatOf([{ at: DAY - 3 * 3_600_000 }], DAY) === 0);
}

// ── ② 巡逻计划 ───────────────────────────────────────────────────────────
{
  const t = patrolTuningOf({});
  ok('默认值镜像 PATROL_DEFAULTS（enabled / minUnread=5 / silence=10 / gap=20）',
    t.enabled === true && t.minUnread === 5 && t.silenceMin === 10 && t.minGapMin === 20
    && t.chance === PATROL_DEFAULTS.chance);
  const clamp = patrolTuningOf({ patrol: { minUnread: 0, chance: 9, silenceMin: -5, enabled: false } });
  ok('坏值夹住（minUnread≥1 / chance≤1 / silence≥0 / enabled 只认 false）',
    clamp.minUnread === 1 && clamp.chance === 1 && clamp.silenceMin === 0 && clamp.enabled === false);

  // 巡逻的素材是背景窗口（`ambient`），不是未读账本：字段用 speaker/at。
  const unread = [
    { id: 1, at: DAY - 600_000, userId: '9', speaker: '甲', text: '在吗' },
    { id: 2, at: DAY - 590_000, userId: '9', speaker: '甲', text: '  今天  干嘛 ' },
    { id: 3, at: DAY - 580_000, userId: '8', speaker: '乙', text: '' },
    { id: 4, at: DAY - 570_000, userId: '7', speaker: '丙', text: '嗯' },
    { id: 5, at: DAY - 560_000, userId: '7', speaker: '丙', text: '好' },
  ];
  const digest = patrolDigestOf(unread, { maxLines: 10 });
  ok('摘要每行「时:分 昵称：内容」、空白压平、空文本跳过',
    /^\d\d:\d\d 甲：在吗$/m.test(digest) && /甲：今天 干嘛/.test(digest) && !/乙/.test(digest));
  const cut = patrolDigestOf(
    Array.from({ length: 6 }, (_, i) => ({ id: String(i), at: DAY, sender: '甲', text: `第${i}条` })),
    { maxLines: 2 },
  );
  ok('摘要超行数：从最旧的丢', !cut.includes('第3条') && cut.includes('第5条'));

  const chat = (over = {}) => ({
    key: 'group:1', scene: 'group', id: '1', recent: unread,
    lastMsgAt: DAY - 600_000, lastPatrolAt: 0, ...over,
  });
  const plan1 = patrolPlanOf({ chats: [chat()], now: DAY, tuning: t, heatOf: () => 0.8 });
  ok('攒够 + 安静够 ⇒ 选出（chance 随热度缩）',
    plan1.picked.length === 1 && plan1.picked[0].count === 5
    && plan1.picked[0].chance > 0 && plan1.picked[0].chance <= t.chance);
  ok('攒得不够就不巡逻', patrolPlanOf({ chats: [chat({ recent: unread.slice(0, 2) })], now: DAY, tuning: t }).picked.length === 0);
  ok('还在聊就不巡逻', patrolPlanOf({ chats: [chat({ lastMsgAt: DAY - 60_000 })], now: DAY, tuning: t }).picked.length === 0);
  ok('刚巡逻过就不巡逻',
    patrolPlanOf({ chats: [chat({ lastPatrolAt: DAY - 60_000 })], now: DAY, tuning: t }).picked.length === 0);
  ok('巡逻过的那些条不再重复问（按 lastPatrolAt 切一刀）',
    patrolPlanOf({ chats: [chat({ lastPatrolAt: DAY - 590_000 })], now: DAY, tuning: { ...t, minUnread: 2, minGapMin: 0 } })
      .picked[0].count === 3);
  ok('关掉总开关 ⇒ 一条都不选、并如实记原因',
    patrolPlanOf({ chats: [chat()], now: DAY, tuning: patrolTuningOf({ patrol: { enabled: false } }) })
      .skipped.some((x) => x.why.includes('关闭')));
  const coldPlan = patrolPlanOf({ chats: [chat()], now: DAY, tuning: t, heatOf: () => 0 });
  ok('群很冷 ⇒ 概率只有一半（0.5 + 0.5×热度）', near(coldPlan.picked[0].chance, t.chance * 0.5));

  const two = patrolPlanOf({
    chats: [chat({ key: 'group:2', id: '2' }), chat({ key: 'group:1', id: '1' })],
    now: DAY, tuning: t, heatOf: (c) => (c.id === '2' ? 0.2 : 0.9),
  });
  ok('越热越先巡逻', two.picked[0].id === '1');

  const ev = patrolEventOf(plan1.picked[0], '10000');
  ok('合成事件：isPatrol 标记 + 计划里的概率',
    ev.isPatrol === true && near(ev.patrol.chance, plan1.picked[0].chance) && ev.patrol.count === 5);
  ok('合成事件：不带 @、不带 message_id（不进未读、不自我繁殖）',
    !ev.message.some((seg) => seg.type === 'at') && ev.message_id === undefined);
  ok('合成事件：正文就是摘要、发到那个群',
    ev.message[0].data.text === plan1.picked[0].digest && ev.group_id === '1');
}

// ── ③ 判定接线 ───────────────────────────────────────────────────────────
{
  const cfgOf = (over = {}) => ({
    allow: { groups: ['1'], private: [], allowAllWhenEmpty: false },
    deny: { groups: [], users: [] },
    owner: { qq: ['9000'] },
    trigger: { requireAtInGroup: false, interjectChance: 0.5, interjectCooldownMs: 0, bareGraceMs: 60000, aliases: [] },
    custom: { allowProactive: true, trigger: { keywords: [], aliases: [] }, ...(over.custom || {}) },
    ...(over.root || {}),
  });
  const sess = () => ({ key: 'group:1', lastInterjectAt: 0, lastDirectAt: 0, quietUntil: 0, lastReplyAt: 0, unread: [] });
  const evt = (over = {}) => ({
    post_type: 'message', message_type: 'group', group_id: '1', user_id: '9', self_id: '10000',
    sender: { card: '甲', nickname: '甲' },
    message: [{ type: 'text', data: { text: '攒了一批' } }], isPatrol: true,
    patrol: { count: 3, sinceMs: 600000, chance: 0.4 }, ...over,
  });
  const parsed = (text = '攒了一批') => ({ text, mentionedSelf: false, images: [], replyTo: '' });

  const b = new Brain(cfgOf(), { sessions: new Map() });
  const s1 = sess();
  const d1 = b.decide(s1, evt(), parsed(), { patrol: evt().patrol, roll: 0.1 });
  ok('巡逻轮：掷中 ⇒ 放行 kind=patrol', d1.respond === true && d1.kind === 'patrol');
  ok('巡逻档位与插话同档（省上下文）', d1.tier === 'interject' && TIER_OF_KIND.patrol === 'interject');
  ok('DECISION_KINDS 登记了 patrol', DECISION_KINDS.includes('patrol'));
  const d2 = b.decide(sess(), evt(), parsed(), { patrol: evt().patrol, roll: 0.9 });
  ok('巡逻轮：没掷中 ⇒ 拒绝并带计划（可查）',
    d2.respond === false && !!d2.interject && d2.interject.count === 3);
  ok('巡逻轮：没给计划 ⇒ 拒绝（fail-closed）',
    b.decide(sess(), evt(), parsed(), { roll: 0.1 }).respond === false);

  const off = new Brain(cfgOf({ custom: { allowProactive: false } }), { sessions: new Map() });
  ok('巡逻受主动发言总闸管（关掉 ⇒ 不巡逻）',
    off.decide(sess(), evt(), parsed(), { patrol: evt().patrol, roll: 0.0 }).respond === false
    && off.decide(sess(), evt(), parsed(), { patrol: evt().patrol, roll: 0.0 }).reason.includes('主动发言'));

  const mustAt = new Brain({ ...cfgOf(), trigger: { ...cfgOf().trigger, requireAtInGroup: true } }, { sessions: new Map() });
  ok('巡逻受「必须 @」管（配了就必须 @，巡逻也不开口）',
    mustAt.decide(sess(), evt(), parsed(), { patrol: evt().patrol, roll: 0 }).respond === false);

  const par = { text: '随便说一句', mentionedSelf: false, images: [], replyTo: '' };
  const i1 = b.decide(sess(), evt({ isPatrol: false }), par, { roll: 0.0, heatWeight: 1 });
  ok('普通群消息：插话概率不受热度影响时与原来一致', i1.respond === true && i1.kind === 'interject');
  const i2 = new Brain(cfgOf(), { sessions: new Map() })
    .decide(sess(), evt({ isPatrol: false }), par, { roll: 0.3, heatWeight: 0.5 });
  ok('热度权重乘进插话概率（0.5×0.5=0.25 ⇒ roll 0.3 不中）', i2.respond === false);
  const i3 = new Brain(cfgOf(), { sessions: new Map() })
    .decide(sess(), evt({ isPatrol: false }), par, { roll: 0.2, heatWeight: 0.5 });
  ok('该中的还是中（0.25 > 0.2），且计划里留了权重',
    i3.respond === true && i3.interject.heatWeight === 0.5);

  // 提示词：巡逻轮那句只在巡逻轮出现（`PATROL_LINE`）。
  const src = read('src/brain.js');
  ok('提示词接线：opts.patrol ⇒ PATROL_LINE', /if \(opts\.patrol\) volatileSec\.lines\.push\(PATROL_LINE\)/.test(src));
  ok('巡逻那句不汇报"我在翻记录"', /别汇报你在翻记录/.test(read('src/reply-text.js')));
}

// ── ④ 配置与落盘/面板接线 ────────────────────────────────────────────────
{
  const c = readCustom({ custom: { trigger: { patrol: { minUnread: 9, chance: 0.3, enabled: false, maxLines: 12, maxChars: 900 } } } });
  ok('readCustom 保留巡逻设置（面板保存不会抹掉）',
    c.trigger.patrol.minUnread === 9 && near(c.trigger.patrol.chance, 0.3) && c.trigger.patrol.enabled === false
    && c.trigger.patrol.maxLines === 12 && c.trigger.patrol.maxChars === 900);
  ok('readCustom 的默认值来自 PATROL_DEFAULTS（不写第二份数字）',
    readCustom({ custom: {} }).trigger.patrol.minUnread === PATROL_DEFAULTS.minUnread);

  const idx = read('src/index.js');
  ok('index：记账（noteHeatTurn + heatEntryOf）', /noteHeatTurn\(heatEntryOf\(/.test(idx));
  ok('index：判定前算权重并传给 decide',
    /const heatEntry = session \? heatEntryOf\(session\.key, evt\.user_id\) : null;/.test(idx)
    && /const heatWeight = heatWeightOf\(heatEntry\);/.test(idx)
    && /patrol: evt\.isPatrol \? evt\.patrol : null/.test(idx));
  ok('index：巡逻挂在既有 tick 上（runPatrolTick 在 tickProactive 里被调）',
    /if \(runPatrolTick\(now\.getTime\(\)\) > 0\) return;/.test(idx));
  ok('index：巡逻不消费未读（素材是背景窗口，不碰门禁账本）',
    !/function runPatrolTick[\s\S]{0,4000}consumeUnread\(/.test(idx));
  ok('index：掷骰没中不记账（下一个 tick 还会再问）',
    /function runPatrolTick[\s\S]{0,4000}heatState\.patrol\[item\.key\] =/.test(idx) === false);
  ok('index：真的回了才写 lastPatrolAt',
    /if \(decision\.kind === 'patrol' && session\) \{\s*heatState\.patrol\[session\.key\] = Date\.now\(\);/.test(idx));
  ok('index：素材取 `session.ambient`（不是 unread）',
    /recent: Array\.isArray\(s\.ambient\) \? s\.ambient : \[\]/.test(idx));
  ok('index：零新增定时器（runPatrolTick 里没有 setInterval）',
    !/function runPatrolTick[\s\S]{0,2400}setInterval/.test(idx));
  ok('index：启动读账本、退出补写', /loadHeatState\(\);/.test(idx) && /saveHeatState\(true\);/.test(idx));

  ok('tier：patrol 有档位（tierOfKind 不会回 undefined）',
    TIER_OF_KIND.patrol === 'interject');

  const p = read('panel/lib/paths.js');
  const bd = read('panel/lib/bot-data.js');
  ok('面板：快照文件名进 paths（DATA_DIR 镜像同一套规则）',
    /PATROL_SNAPSHOT_FILE = path\.join\(DATA_DIR, 'patrol-state\.json'\)/.test(p));
  ok('面板：bot-data 白名单投影读快照', /export function readPatrol\(\)/.test(bd)
    && /patrol: readPatrol\(\)/.test(bd));

  const sch = read('panel/next/schema.js');
  ok('面板：巡逻页有开关与六个可调项（bind 指向 custom.trigger.patrol.*）',
    /bind: 'trigger\.patrol\.enabled'/.test(sch) && /bind: 'trigger\.patrol\.minUnread'/.test(sch)
    && /bind: 'trigger\.patrol\.silenceMin'/.test(sch) && /bind: 'trigger\.patrol\.minGapMin'/.test(sch)
    && /bind: 'trigger\.patrol\.chance', min: 0, max: 100, step: 5, pct: true/.test(sch)
    && /bind: 'trigger\.patrol\.maxLines'/.test(sch) && /bind: 'trigger\.patrol\.maxChars'/.test(sch));
  ok('面板：现状表控件已登记 CTRL_KINDS', /'patrolView',/.test(sch));
  ok('面板：渲染器存在（读 S.state.patrol，缺失不报错）',
    /patrolView: \(\) => \{/.test(read('panel/next/app.js')) && /\(S\.state \|\| DEMO\)\.patrol/.test(read('panel/next/app.js')));

  // ── §C1：关系温度进提示词（2026-10-22）─────────────────────────────────
  const noon = Date.parse('2026-10-22T12:00:00');
  const hotEntry = { w: 0.8, at: noon, decayedAt: noon, chain: 0 };
  ok('heatLine：满温不出行（默认提示词逐字不变）', heatLine(hotEntry, noon) === '');
  const coolLine = heatLine({ ...hotEntry, w: 0.72 }, noon);
  ok('heatLine：冷温出行且带百分数', coolLine.includes('关系温度') && coolLine.includes('72%'), coolLine);
  ok('heatLine：半夜带标记', heatLine({ ...hotEntry, w: 0.5 }, Date.parse('2026-10-22T00:30:00')).includes('半夜'));
  ok('brain：接住 heatLine 入参', /opts\.heatLine/.test(read('src/brain.js')));
  ok('index：同一 entry 两处共读', /heatLineText = heatEntry \? heatLine\(heatEntry\)/.test(read('src/index.js')));

  // ── §C2：群级反馈热（看过没出声 → 降温；回话 → 回满）────────────────────
  ok('反馈热：沉默一轮 ×0.5', noteFeedbackHeat(1, false) === 0.5);
  ok('反馈热：连沉默到地板 0.2', noteFeedbackHeat(noteFeedbackHeat(1, false), false) === 0.25
    && noteFeedbackHeat(0.25, false) === FEEDBACK_HEAT_FLOOR);
  ok('反馈热：回话回满', noteFeedbackHeat(0.2, true) === 1);
  ok('反馈热：坏值按满热处理', feedbackHeatOf(undefined) === 1 && feedbackHeatOf('x') === 1);
  ok('index：巡逻概率乘反馈热', /chatHeatFor\(chat\.key, nowMs\) \* feedbackHeatFor\(chat\.key\)/.test(idx));
  ok('index：沉默/回话两条记账都在', /noteFeedbackTurn\(session\.key, false\)/.test(idx)
    && /noteFeedbackTurn\(session\.key, true\)/.test(idx));

  // ── §C3：困倦分级（沿用 sleep 快照，不新增第二套深夜判据）────────────────
  const snapAt = (ms) => ({ enabled: true, asleep: false, bedAt: noon + ms, wakeAt: 0 });
  ok('困倦：两小时内 → 有点犯困', restLineOf(snapAt(90 * 60000), { now: noon }) === REST_LINE_SLEEPY);
  ok('困倦：半小时内 → 犯困', /犯困/.test(restLineOf(snapAt(20 * 60000), { now: noon })));
  ok('困倦：已过入睡点但没睡 → 很困', restLineOf(snapAt(-60000), { now: noon }) === REST_LINE_VERY_TIRED);
  ok('困倦：总闸关着 → 一个字都不加', restLineOf({ enabled: false, asleep: false, bedAt: noon + 60000 }, { now: noon }) === '');
}

if (fails.length) {
  console.error(`✗ check-heat-patrol：${fails.length} 项失败`);
  for (const f of fails) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`✓ check-heat-patrol：${pass} 项通过`);
