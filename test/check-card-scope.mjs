/**
 * 「人格按群生效 + 记忆按角色卡分库」的判据（A+B 改造）。
 *
 * 跑法：`node test/check-card-scope.mjs`
 * 为什么单独一个文件而不是塞进 smoke.js：这几条判据全部是**零依赖纯函数**，
 * 单独跑 2 秒就能定位；smoke 要起假 OneBot + 假模型，改一行等一分钟。
 *
 * ⚠️ 记忆文件路径是**模块加载时**算的，所以 env 必须在任何 import 之前设好。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-cards-'));
process.env.QQBOT_MEMORY_RECORDS = path.join(tmpDir, 'memory-records.json');
process.env.QQBOT_AUTO_MEMORY_FILE = path.join(tmpDir, 'auto-memory.jsonl');

const SRC = new URL('../src/', import.meta.url).pathname;
const { memoryScopeOf } = await import(`${SRC}memory-scope.js`);
const { pickPersonaCard, pickSkillsForPrompt } = await import(`${SRC}skills.js`);
const { selectForPrompt, searchRecords } = await import(`${SRC}memory-record.js`);
const { Brain, SessionStore } = await import(`${SRC}brain.js`);
const { MemoryKeeper } = await import(`${SRC}memory.js`);
const { sampleConfig } = await import('../scripts/prompt-diff.mjs');
const { groupEvt } = await import('./helpers/fixtures.js');

let pass = 0;
const fails = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass += 1; return; }
  fails.push(`${name}${detail ? ` —— ${detail}` : ''}`);
};

// ── ① 作用域键：有卡按卡，没卡按会话 ─────────────────────────────────────
ok('有卡 → card:<id>', memoryScopeOf('group:123', 'cardA') === 'card:cardA');
ok('没卡 → 会话键原样', memoryScopeOf('group:123') === 'group:123');
ok('空白卡号当没卡', memoryScopeOf('private:9', '   ') === 'private:9');
ok('两个会话同一张卡 → 同一个键',
  memoryScopeOf('group:1', 'cardA') === memoryScopeOf('group:2', 'cardA'));

// ── ② 选卡：按人 > 按群 > 全局；同档取第一张；停用的不算 ────────────────
const card = (id, type, extra = {}) => ({
  id, kind: 'persona', name: `卡${id}`, enabled: true,
  scope: { type, id: type === 'global' ? '' : '100' }, fields: {}, ...extra,
});
const globalCard = card('g', 'global');
const groupCard = card('G', 'group');
const userCard = { ...card('U', 'user'), scope: { type: 'user', id: '888' } };
const ctx = { groupId: '100', userId: '888' };
ok('按人优先于按群和全局', pickPersonaCard([globalCard, groupCard, userCard], ctx)?.id === 'U');
ok('没按人的卡就取按群的', pickPersonaCard([globalCard, groupCard], ctx)?.id === 'G');
ok('只对不上群就取全局', pickPersonaCard([globalCard], { groupId: '999' })?.id === 'g');
ok('停用的卡不生效', pickPersonaCard([card('x', 'global', { enabled: false })], ctx) === null);
ok('同档多张取第一张', pickPersonaCard([card('a', 'group'), card('b', 'group')], ctx)?.id === 'a');

// ── ③ 知识包照旧，卡不再占技能段 ────────────────────────────────────────
const pack = { id: 'p', kind: 'pack', name: '包', enabled: true, scope: { type: 'global', id: '' }, background: '知识', triggers: ['漆'] };
ok('角色卡不出现在技能段', pickSkillsForPrompt([globalCard, pack], ctx, '把船漆完').every((s) => s.kind === 'pack'));
ok('知识包按触发词照进', pickSkillsForPrompt([pack], ctx, '把船漆完').length === 1);

// ── ④ 注入排序：有 hint 时相关的那条排前面；没 hint 退化成旧顺序 ────────
const rec = (id, text, samples, chatKey = 'card:cardA') => ({
  id, kind: 'person', text, detail: '', status: 'confirmed',
  provenance: { chatKey, userId: '2', subjectId: '', subjectName: '' },
  samples: Array.from({ length: samples }, (_, i) => ({ at: Date.now() - i * 1000 })),
  firstSeenAt: Date.now() - 86400000, lastSeenAt: Date.now() - 1000, updatedAt: Date.now() - 1000,
});
const oldStrong = rec('r1', '他三年前在这条街开过一家修船铺', 8);
const freshRelevant = rec('r2', '他说香菜可以少放一点', 0);
const noHint = selectForPrompt([oldStrong, freshRelevant], { chatKey: 'card:cardA', userId: '2', now: Date.now() });
ok('没 hint 时按旧顺序（巩固度高的先）', noHint.picked[0].id === 'r1');
const withHint = selectForPrompt([oldStrong, freshRelevant], { chatKey: 'card:cardA', userId: '2', now: Date.now(), hint: '香菜怎么放' });
ok('给了 hint，对得上那句的排前面', withHint.picked[0].id === 'r2');
ok('hint 不放松隔离：别的卡看不到', selectForPrompt([freshRelevant], { chatKey: 'card:other', hint: '香菜' }).picked.length === 0);
ok('检索仍只在本卡里找',
  searchRecords([freshRelevant], '香菜', { chatKey: 'card:other' }).hits.length === 0
  && searchRecords([freshRelevant], '香菜', { chatKey: 'card:cardA' }).hits.length === 1);

// ── ⑤ 端到端：一张群卡真的把人格换掉，但全局口头禅留着 ──────────────────
const cfg = sampleConfig();
cfg.persona = { ...(cfg.persona || {}), name: '全局鱼', text: '' };
cfg.custom = {
  ...(cfg.custom || {}),
  persona: { ...(cfg.custom?.persona || {}), traits: '全局性格', catch: '全局口头禅' },
  enhance: { ...(cfg.custom?.enhance || {}) },
  skills: [
    { id: 'cardA', kind: 'persona', name: '干活的鱼', enabled: true, scope: { type: 'group', id: '100000001' },
      background: '', fields: { traits: '在群里很凶', desire: '想把船漆完' } },
  ],
  memory: { auto: false, manual: [] },
};
const brain = new Brain(cfg, new SessionStore(cfg));
const evt = groupEvt();
const sess = new SessionStore(cfg).get('group', String(evt.group_id));
const parsed = { text: '把船漆完', mentionedSelf: false, images: [], replyTo: null };
const sys = brain.buildMessagesWithMeta(sess, evt, parsed).messages[0].content;
ok('名字跟着卡走', sys.includes('你的名字是「干活的鱼」'));
ok('卡里的性格压过全局', sys.includes('在群里很凶') && !sys.includes('全局性格'));
ok('卡没填的项仍用全局（口头禅还在）', sys.includes('全局口头禅'));
ok('卡里的欲望进了人设', sys.includes('想把船漆完'));
ok('记忆键 = card:<卡 id>', brain.memoryKeyFor(evt, sess) === 'card:cardA');
const noCardCfg = { ...cfg, custom: { ...cfg.custom, skills: [] } };
const brain2 = new Brain(noCardCfg, new SessionStore(noCardCfg));
ok('没卡时记忆键回到会话', brain2.memoryKeyFor(evt, sess) === `group:${evt.group_id}`);

// ── ⑥ 写入侧：keeper 落盘的 provenance.chatKey 也用同一个键 ─────────────
{
  const writeCfg = { custom: { memory: { auto: true } }, persona: { name: '小鱼' } };
  const llm = {
    chatWithUsage: async () => ({
      text: JSON.stringify({ none: false, kind: 'person', text: '喜欢把船漆完', detail: '他自己说的' }),
      usage: { model: 'mock', vendor: 'zhipu', prompt: 1, completion: 1, cached: 0, attempts: 1 },
    }),
  };
  const keeper = new MemoryKeeper(() => writeCfg, llm);
  keeper.consider({
    sender: '阿岚', text: '我就是要把船漆完', reply: '好', scene: 'group', id: '100000001',
    userId: '2', memoryKey: 'card:cardA',
  });
  await new Promise((r) => setTimeout(r, 120));
  let items = [];
  try { items = JSON.parse(fs.readFileSync(process.env.QQBOT_MEMORY_RECORDS, 'utf8')).items; } catch { /* 没写就是 0 */ }
  ok('写入落在卡名下', items.length === 1 && items[0].provenance.chatKey === 'card:cardA',
    `实际 ${items.length} 条 / ${items[0]?.provenance?.chatKey ?? '空'}`);
  // 刚写的那条是**候选态**（还没被独立复证），所以不走常驻注入、走检索才看得到 ——
  // 这正是原来的纪律（"一次观察只落盘、不进提示词"），不是这条改造造成的。
  const written = JSON.parse(fs.readFileSync(process.env.QQBOT_MEMORY_RECORDS, 'utf8')).items;
  const seen = searchRecords(written, '船漆', { chatKey: 'card:cardA', includeDead: false });
  ok('刚写的这条按卡键检索得到（同一张卡）', seen.hits.length === 1);
  ok('换成别的卡就检索不到', searchRecords(written, '船漆', { chatKey: '群:100000001' }).hits.length === 0);
}

// ── 面板接线（只断言"忘了接"会红的几处）────────────────────────────────
{
  const appJs = fs.readFileSync(new URL('../panel/next/app.js', import.meta.url), 'utf8');

  ok('面板有「存当前人格」（否则按群生效的卡从面板造不出来）',
    /'skill\.snap':/.test(appJs) && /function snapPersonaCard\(/.test(appJs)
    && /data-a="skill\.snap"/.test(appJs));
  // 我们的 applyPersonaCard 用 `enhanceKeys.has(k)` 路由（比对方的 `enh.includes(k)` 多一层
  // 「归属名单缺失时退回 persona」的保护）；判据只看"增强项最终写进 enhance.${k}"。
  ok('套用卡时增强项归 enhance 段（不能一律写 persona）',
    /(enh\.includes\(k\)|enhanceKeys\.has\(k\))/.test(appJs) && appJs.includes('enhance.${k}'));
  ok('卡的范围控件还在（指定群靠它）', /skill\.set" data-p="\$\{i\}\|scopeType"/.test(appJs));
}

fs.rmSync(tmpDir, { recursive: true, force: true });
if (fails.length) {
  console.log(`卡片作用域判据：${pass} 项通过，${fails.length} 项失败`);
  for (const f of fails) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`卡片作用域判据：${pass} 项通过，0 项失败`);
console.log('  ✓ 选卡优先级 / 人格合并 / 记忆按卡分库 / 按句相关度排序 都对得上');
