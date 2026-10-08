#!/usr/bin/env node
/**
 * 从真实的 config.json 生成 config.example.json（自动脱敏）。
 *
 * 为什么要有它：example 是手写的，结果早就跟真实配置对不上了 ——
 * 真实 llm 段有 21 个键（presets / keys / features / localChannel…），
 * example 里只有 7 个。照着它写配置会缺一大半字段，属于"看着有用其实害人"的文档。
 *
 * 以后 config.json 加了字段，跑一下这个脚本就能同步：
 *   node scripts/make-config-example.mjs
 *
 * 脱敏规则：键名里带 key / token / secret / password 的一律清空，
 * 群号与个人白名单清空（避免把真实群号和个人信息写进仓库）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// 脱敏规则**不在这里**（B9 · K-SANDBOX 把它抽走了）：与 test/sandbox.sh 共用
// `scripts/sanitize-config.mjs` 里的同一份规则 + 同一份自检。
// 这是刻意的 —— 两处各写一份，就会出现「example 抹干净了、沙箱副本漏了」
// 这种**从代码上看不出来**的差别，而沙箱副本是会躺进 /tmp 的。
import { sanitizeConfig, findLeaks } from './sanitize-config.mjs';
// m-4：模板回填用的**默认值单一来源**（不在这里手写数字）
import { interjectTuningOf } from '../src/interject.js';
import { DEFAULT_AMBIENT_BATCH } from '../src/ambient.js';
import { budgetOf } from '../src/context-budget.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'config.json');
const DST = path.join(ROOT, 'config.example.json');

const cfg = JSON.parse(fs.readFileSync(SRC, 'utf8'));
const example = sanitizeConfig(cfg, { blankGroups: true, dropDeadKeys: true });

// ── m-4（2026-10-04 审查轮）：把「代码会读、模板里却没有」的键补进来 ──────────
//
// 为什么模板会缺：生成器是**从真实 config.json 抄**的 —— 用户没显式改过的键
// 就永远不会出现在模板里。实测缺 6 个：
//   `trigger.interject*`（4 个，住 src/interject.js）· `context.ambientBatch` · `context.budget`
// 后果不是崩溃，而是**照着模板配不出这些行为**（"看着有用其实害人"的文档）。
//
// ⚠️ 值**不许在这里手写数字**：四个插话参数只从 `interjectTuningOf()` 取、
//    批粒度只从 `DEFAULT_AMBIENT_BATCH` 取、预算表只从 `budgetOf()` 取 ——
//    改默认值永远只改那一处（"同一份语义两份拷贝"是本项目头号杀手）。
const tuning = interjectTuningOf({});
example.trigger = example.trigger || {};
// 注意方向：**输入键名**是 `interjectXxx`（`config.js` 把归一化后的结果摊平进 cfg.trigger，
// 摊平后叫 `activeWindowMs` —— 那是运行时的名字，写进模板反而无效）。
example.trigger.interjectActiveWindowMs = tuning.activeWindowMs;
example.trigger.interjectActiveBoost = tuning.activeBoost;
example.trigger.interjectColdGapMs = tuning.coldGapMs;
example.trigger.interjectColdFactor = tuning.coldFactor;
example.context = example.context || {};
example.context.ambientBatch = DEFAULT_AMBIENT_BATCH;
example.context.budget = budgetOf({});

// ── 2026-10-07（接千问）：`llm.keys` 补一格 ────────────────────────────────
// 理由与上面 m-4 那段**一模一样**：生成器是"从真机 config.json 抄"的，
// 而真机那份 `keys` 里只有 `deepseek` / `zhipu` 两格 —— 千问是后加的，
// 没人显式填过就**永远不会出现在模板里**。
// 后果不是崩溃，是"照着模板配的人不知道有这一格可填"（本项目最忌讳的
// "看着有用其实害人"的文档）。实测真机就是这种状态。
//
// ⚠️ 值必须是**空串**：模板的约定是"空 = 这里该填"。
//    别写占位文案 —— `findLeaks` 会把非空的凭据键当作泄漏拦下（它正好会扫这块）。
example.llm = example.llm || {};
example.llm.keys = example.llm.keys || {};
if (!('qwen' in example.llm.keys)) example.llm.keys.qwen = '';

// ── 2026-10-07（自定义大脑）：模板里补上这两个键 ──────────────────────────
// 理由与上面 `keys.qwen` 一模一样：生成器是"从真机 config.json 抄"的，
// 而用户还没添过任何自定义大脑 ⇒ 这两个键**根本不存在** ⇒
// 照着模板配的人不知道有这个入口（又是"看着有用其实害人"的文档）。
// ⚠️ 安全：这里写的是**空对象 / 空串**，不含任何凭据；等到用户真添了大脑，
//    里面的 `apiKey` 会被 `sanitize-config` 的判据照常清掉（键名以 `Key` 结尾）。
if (!example.llm.customBrains || typeof example.llm.customBrains !== 'object') example.llm.customBrains = {};
if (!('activeCustomId' in example.llm)) example.llm.activeCustomId = '';

// ⚠️ 这里**刻意不补 `presets.qwen`**（对照：上面补了 `keys.qwen`）—— 两者的区别是
//    "缺失时有没有人兜底"：
//      · `keys` 缺一格 ⇒ 只能靠人来填，模板不写就没人知道；
//      · `presets` 缺一套 ⇒ `readPresets()` 会用 `PROVIDER_DEFAULTS` **自动补齐**，
//        用户第一次切到千问时 `stashCurrentPreset()` 就会把它写进配置。
//    在生成器里手抄一份千问预设，等于给"默认值"造了第二个来源（本项目头号杀手），
//    而且它会**悄悄腐烂**：`PROVIDER_DEFAULTS.qwen` 改了，模板里那份不会跟着变。

// 写出去之前先自检 —— **顺序不能反**：先落盘再检查的话，
// 中间那一瞬间真 Key 已经在磁盘上了（沙箱副本走的正是这条路，见 test/sandbox.sh）。
const leaks = findLeaks(example);
if (leaks.length) {
  console.error(`✗ 脱敏后自检不通过，拒绝写出 config.example.json：${leaks.join('；')}`);
  process.exit(1);
}

// 群号清空后给个占位，让人知道这里该填什么（空数组容易被当成"不允许任何群"）
if (example.allow && Array.isArray(example.allow.groups)) {
  example.allow.groups = ['填你的群号，例如 123456789'];
}

// ── 昵称 / 别名：**类型化扫描扫不到它们** ──────────────────────────────────
// `publish-audit` 只认号码与凭据形态，一个中文昵称在它眼里就是一段普通文字；
// 而本文件是**从真机 config.json 生成的**，所以真机那个人设里的昵称会被原样抄进
// 会随仓库发布的那份模板里 —— 09-27 手改过一次（改成 小鱼/小肥鱼），
// 09-29 重新跑生成器时又被带回来了（发布审计当场拦下，1 项阻断）。
// 结论：**抹昵称这件事只能由生成器自己负责**（人是靠不住的那一环）。
// 值照 09-27 的替换结果固定下来，与 `scripts/known-real.mjs` 里那条 placeholder 同一族。
if (example.persona && typeof example.persona.name === 'string') {
  example.persona.name = '小鱼';
}
if (example.trigger && Array.isArray(example.trigger.aliases)) {
  example.trigger.aliases = ['小鱼', '小肥鱼', '肥鱼'];
}
for (const key of ['owner']) {
  // 主人的 QQ 号由 `sanitize-config` 的 PRIVATE_LISTS 清空（值还没填时也是空的）。
  // 这里只是**再核一次**：那一节长了内容就说明脱敏规则漏了，宁可立刻失败。
  const list = example[key]?.qq;
  if (Array.isArray(list) && list.length) {
    console.error(`✗ ${key}.qq 脱敏后仍有 ${list.length} 项 —— 规则漏了，拒绝写出（模板会随仓库发布）`);
    process.exit(1);
  }
}

fs.writeFileSync(DST, JSON.stringify(example, null, 2) + '\n');
const keys = Object.keys(cfg.llm || {}).length;
console.log(`✅ 已生成 ${path.relative(ROOT, DST)}（llm 段 ${keys} 个字段，敏感信息已清空并自检通过）`);
