// 预设回存只拥有面板自己的上下文字段（2026-11-05 · 外部评估 P2）
//   ① `ownedContextOf` 只取 recentTurns / ambientMessages；
//   ② stash 不再把 budget / ambientBatch 写进服务商预设；
//   ③ 旧预设里的多余键在下一次保存时收敛，不继续影响生效值。
import { ownedContextOf, stashCurrentPreset } from '../panel/lib/models.js';

let pass = 0;
const fails = [];
const ok = (name, cond, extra = '') => {
  if (cond) { pass += 1; return; }
  fails.push(`${name}${extra ? `  → ${extra}` : ''}`);
};

const ctx = ownedContextOf({ recentTurns: 12, ambientMessages: 20, ambientBatch: 4, budget: { total: 1 } });
ok('只保留 recentTurns / ambientMessages',
  ctx.recentTurns === 12 && ctx.ambientMessages === 20
  && !('budget' in ctx) && !('ambientBatch' in ctx), JSON.stringify(ctx));
ok('坏值不写进预设', Object.keys(ownedContextOf({ recentTurns: 'x', ambientMessages: null })).length === 0);

const cfg = {
  llm: {
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-flash',
    fallbackModels: [],
    maxTokens: 400,
    temperature: 1,
    thinking: { mode: 'auto' },
    features: {},
    presets: {
      deepseek: { context: { recentTurns: 1, ambientMessages: 2, budget: { stale: true }, ambientBatch: 9 } },
    },
  },
  context: { recentTurns: 12, ambientMessages: 20, ambientBatch: 4, budget: { enabled: true, total: 16000 } },
};
const presets = stashCurrentPreset(cfg);
const back = presets.deepseek;
ok('预设里的 context 只有两个拥有键',
  back.context.recentTurns === 12 && back.context.ambientMessages === 20
  && !('budget' in back.context) && !('ambientBatch' in back.context),
  JSON.stringify(back.context));
ok('全局 budget / ambientBatch 仍留在根 context',
  cfg.context.budget.enabled === true && cfg.context.ambientBatch === 4,
  JSON.stringify(cfg.context));
ok('其它业务字段仍按服务商保存（模型/降级链/温度）',
  back.model === 'deepseek-flash' && Array.isArray(back.fallbackModels) && back.temperature === 1,
  JSON.stringify({ model: back.model, chain: back.fallbackModels, temperature: back.temperature }));

if (fails.length) {
  console.log(`预设上下文字段判据：${pass} 项通过，${fails.length} 项失败`);
  for (const f of fails) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`预设上下文字段判据：${pass} 项通过，0 项失败`);
