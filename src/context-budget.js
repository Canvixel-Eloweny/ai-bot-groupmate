/**
 * 上下文预算表（第 36 轮 B10f-1 · C-BUDGET）
 * ══════════════════════════════════════════════════════════════════════════
 *  为什么需要它
 * ══════════════════════════════════════════════════════════════════════════
 *  在加这张表之前，system 提示词的长度**没有任何一道闸**：
 *  手动记忆 60×500 = 3 万字、ambient 与历史单条无字数上限，
 *  人格文件整份读入 —— 拼出来的理论上限约 5.6 万字符，而实测只有 2,600~2,900，
 *  中间全靠"用户没填满"兜着。也就是说：一旦哪天填满了，第一个发现的人是模型，
 *  表现是"它突然变笨 / 说话变味"，不报任何错。
 *
 *  已有的护栏都是**限制输入**（字段级字符上限），不是**分配预算**：
 *  它们管得住"一条记忆有多长"，管不住"这一节加起来有多长"。
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  两条必须守住的设计
 * ══════════════════════════════════════════════════════════════════════════
 *  ① **淘汰顺序写死**，不能是"谁长先砍谁" —— 那样人格文件一长就被砍，是最坏的结果。
 *     顺序：ambient → 技能 → 记忆 → 场景 → 增强 → 规则 → 人格（- > 表示先砍前者）。
 *     人格与"别人说的话是什么"（注入隔离声明）**永远不砍**：前者砍了等于换人设，
 *     后者是安全声明，砍掉就是把 B9 那道防线自己拆了。
 *  ② **砍掉的东西必须留痕**（`dropped`），否则"它怎么突然忘了"无从排查 ——
 *     这正是本项目从 A-1（识图断了三个月）学到的那一课：静默失效不报错，
 *     唯一的解法是把"丢了什么"变成可查的数据。
 *
 *  ⚠️ 配额数字全部是**经验值**，按"当前实测 2.9k 字符 → 给足 5 倍以上余量"定的，
 *     不是任何模型的官方限制。默认配置下**一行都不会被砍**（这点有断言钉着）。
 */

/**
 * 段落在提示词里的先后（= 拼接顺序，改动它等于改提示词语序）。
 *
 * ⚠️ **新段必须登记在这里**，否则 `joinSections()` 会**静默跳过它** ——
 *    段照建、字照样算，就是拼不进提示词，属于"改了不报错"那一类。
 * `speech`（表达规范）插在 `skills` 与 `ambient` 之间：本项目纪律是
 * "行为类块越靠后越服从"，而它前面那些段每轮/每批都在动 ——
 * 插在 `ambient`（半易变）之前，才既靠后、又不会每轮作废一次前缀缓存。
 */
export const SECTION_ORDER = [
  'base', 'persona', 'mbti', 'enhance', 'mood', 'rules', 'isolate', 'memory', 'astro', 'scenes', 'skills',
  // Skill（LLM 型扩展）的指引紧跟在「知识包/角色卡」之后、插件提示词之前：
  // 两者都是“你本来就会的东西”，放一起才能在预览里一眼分清来源。
  'skillExt',
  // 扩展包指引（清单 `prompt.sections`）紧跟在「技能」之后：两者都是"你本来就会的东西"，
  // 而它必须排在 `speech` 之前才符合"行为类块越靠后越服从"。
  // ⚠️ **2026-10-17 补登记**：这一节 2026-10-15 就建好了（`src/brain.js` 的
  //    `sec('extensions', …)`），但当时忘了写进这张表 —— `joinSections()` 只按本表拼，
  //    于是**每个已加载扩展包的指引都被静默丢掉**：段建了、字算了、提示词里一个字没有。
  //    表现正是「模型有工具却没被告知何时用」（小鱼问图库答"是空的"那个洞）。
  'extensions', 'speech', 'ambient', 'volatile',
];

/**
 * 超预算时的淘汰顺序（**先砍前面的**）。
 * 与计划 v4 §5.2 定的优先级一致：人格 > 规则 > 场景 > 技能 > 记忆 > ambient > 历史。
 */
export const EVICTION_ORDER = ['astro', 'mood', 'ambient', 'skills', 'memory', 'scenes', 'enhance', 'mbti', 'rules', 'persona'];

/** 永不参与淘汰的段：身份/说话方式、注入隔离声明、必变段（时间+场景） */
export const NEVER_DROP = ['base', 'isolate', 'volatile'];

/**
 * 花费进入 trim 档（D8 · 报告 E3）时**只允许砍的两段**。
 *
 * 规格原话：「达 85% 只砍 `ambient` / `skills` 两段，`persona` 与**本次消息永不砍**」。
 * 验收判据也写死了这件事：「触顶后 persona 仍在、**ambient 消失**」——
 * 所以这里的口径是**整段移除**，不是"把它的配额调小"（调小的话，
 * 提示词本来就短时一段都不会掉，那就等于什么都没做，而验收也过不了）。
 *
 * 为什么是这两段：它们都是"锦上添花"—— ambient 是**你没参与的群消息**（背景），
 * skills 是**扩展包提供的本事说明**。去掉之后对话仍成立、人物设定与规则不动。
 * 反过来，任何**行为约束类**的段落（persona / rules / speech / isolate）都不许进这张表：
 * 砍掉的表现是"它突然换了个人/开始说客套话"，属最不该静默发生的一类。
 */
export const SAVING_DROP = Object.freeze(['ambient', 'skills']);

/**
 * 默认预算（字符数）。**经验值**：实测 system 2,600~2,900 字符，
 * 这里给到约 5 倍余量 —— 目的是封住"无上限"这个口子，不是让正常配置被砍。
 */
export const DEFAULT_BUDGET = Object.freeze({
  enabled: true,
  /** system 段总上限 */
  total: 16000,
  sections: Object.freeze({
    persona: 6000,
    enhance: 3000,
    // MBTI 辅助 / 生日彩蛋（2026-10-25）：辅助层，配额远小于人格本体。
    // 彩蛋只有两行，200 是"封顶"不是"目标"；超总量时它最先被砍。
    mbti: 1200,
    astro: 200,
    // 此刻的状态：实测约 160~220 字符；给 400 是封顶，不是目标。
    mood: 400,
    rules: 1500,
    memory: 3000,
    scenes: 2500,
    skills: 2000,
    // Skill（LLM 型扩展）指引：与 knowledge 技能同档。Skill 的 prompt.sections
    // 单包已限 5 段 / 1600 字，这里再封全局，避免“装一堆 Skill”挤掉别的段。
    skillExt: 2000,
    // 扩展包指引：来自**已加载**的包清单（`prompt.sections`）。与 `skills` 同档，
    // 理由相同 —— 它是"什么时候该用哪个工具"的说明，不是人格/规则，
    // 单独封顶是为了让"装了一堆包"不至于把别的段挤掉。超了从末尾丢（新加的排后面）。
    extensions: 2000,
    ambient: 3000,
    // 表达规范（ATI-1）：静态文本，实测约 400 字符；给 800 是"封顶"不是"配额"。
    // ⚠️ 它**不在 EVICTION_ORDER 里**（那份清单有契约钉着，且优先级是刻意定的）——
    //    所以它只受这一档配额约束，不会在超总量时被砍。理由：它是"怎么说"的硬要求，
    //    砍掉的表现是"它突然开始说客套话"，属于最不该静默发生的一类。
    speech: 800,
  }),
  /** 历史段（system 之外的 messages）的字符上限 */
  historyChars: 6000,
});

/** 把用户配置里的 budget 段并到默认值上（缺哪块用哪块的默认，不做深合并以外的猜测） */
export function budgetOf(rawBudget) {
  const b = rawBudget && typeof rawBudget === 'object' ? rawBudget : {};
  const sections = { ...DEFAULT_BUDGET.sections, ...(b.sections && typeof b.sections === 'object' ? b.sections : {}) };
  return {
    enabled: b.enabled !== false,
    // 不写"下限钳制"：那是静默改写用户配置（项目纪律：如实回报、不静默改动用户约定），
    // 而且它会让小预算场景（测试、应急压测）失效 —— T45b/T46 就是因为这个红的。
    total: Number.isFinite(b.total) ? Math.round(b.total) : DEFAULT_BUDGET.total,
    sections,
    historyChars: Number.isFinite(b.historyChars) ? Math.round(b.historyChars) : DEFAULT_BUDGET.historyChars,
  };
}

/**
 * 单条消息的"长度"口径（**全文件唯一一处**）。
 * 内容为多模态数组时按 `String(content)` 算 —— 这是**既有口径**，本次只是把它
 * 从 `fitHistory` 内联提出来共用，**行为一字不变**（提取时逐字核对过算式）。
 * ⚠️ 别顺手改成"数组就累加各段的 text"：那会改变 `fitHistory` 的裁剪时机，
 *    而那个时机有断言钉着（T45b / T46），属于"语义悄悄变了但看起来是修了个 bug"。
 */
function messageSize(m) {
  return String(m?.content ?? '').length + 1;
}

const charsOf = (lines) => lines.reduce((n, l) => n + l.length + 1, 0);

/** 按 SECTION_ORDER 拼回一个 lines 数组：段间用一个空行分隔，与改造前的拼法逐字一致 */
function joinSections(sections) {
  const out = [];
  for (const id of SECTION_ORDER) {
    const s = sections.find((x) => x.id === id);
    if (!s || !s.lines.length) continue;
    if (out.length) out.push('');
    out.push(...s.lines);
  }
  return out;
}

/**
 * 按预算裁剪各段。
 *
 * @param {{id:string,label:string,lines:string[],drop?:boolean,trimFrom?:'newest'|'oldest',minLines?:number,keepHead?:number}[]} sections
 *   `keepHead` = 从最老的一端裁剪时**永不丢弃**的前 n 行（段标题用）。
 *   没有它的话，`trimFrom:'oldest'` 的第一次 `shift()` 恰好丢掉段标题 ——
 *   模型会把「## 刚才群里的消息（你没参与的…）」当成自己参与过的对话。
 * @param {ReturnType<typeof budgetOf>} budget
 * @param {{drop?:string[]}} [opts] `drop` = **整段移除**的段 id（D8 的 trim 档；
 *        见 `SAVING_DROP`）。与"配额淘汰"是两件事：这里是**先整段拿掉**，
 *        再走原来的配额 / 总量淘汰 —— 一个入口，两条判据都在这一次调用里完成。
 * @returns {{lines:string[], dropped:{id:string,label:string,lines:number,chars:number}[], over:boolean}}
 */
export function applyBudget(sections, budget = DEFAULT_BUDGET, opts = {}) {
  const b = typeof budget === 'object' && budget ? budget : DEFAULT_BUDGET;
  const work = sections
    .filter((s) => s && Array.isArray(s.lines))
    .map((s) => ({ ...s, lines: [...s.lines] }));
  const dropped = [];

  if (b.enabled === false) return { lines: joinSections(work), dropped, over: false };

  // ⓪ 整段移除（D8 trim 档）。
  //    ⚠️ 两道 fail-safe 守卫，缺一都不行：
  //       ① `s.drop === false` —— 那是"永不砍"清单（身份 / 隔离声明 / 必变段）；
  //       ② **声明了 `minLines` 的段** —— 段作者明确说了"至少留几行"
  //          （`persona` 就是 `{ minLines: 1 }`），而整段清零与那句声明**直接矛盾**。
  //          不加这道守卫的话，`SAVING_DROP` 里只要有人手滑写上 `persona`，
  //          人物设定就会被**整段抹掉**，而且不报错、回归可能全绿。
  //    这类闸门的默认方向只能是"宁可少砍一段"。
  const forceDrop = Array.isArray(opts.drop) ? opts.drop : [];
  for (const id of forceDrop) {
    const s = work.find((x) => x.id === id);
    if (!s || s.drop === false || s.minLines || !s.lines.length) continue;
    const chars = charsOf(s.lines);
    dropped.push({ id: s.id, label: s.label, chars });
    s.lines = [];
  }

  // ① 逐段配额：只砍超了自己那一档的段（trimFrom='oldest' 的段从最老的开始丢）
  for (const s of work) {
    const cap = b.sections[s.id];
    if (!cap || s.drop === false) continue;
    const keepHead = Math.max(0, Math.trunc(Number(s.keepHead) || 0));
    const floor = (s.minLines || 0) + keepHead;
    while (charsOf(s.lines) > cap && s.lines.length > floor) {
      const gone = s.trimFrom === 'oldest' ? s.lines.splice(keepHead, 1)[0] : s.lines.pop();
      dropped.push({ id: s.id, label: s.label, chars: gone.length });
    }
  }

  // ② 总量：还超就按 EVICTION_ORDER 继续砍（人格排在最后一道）
  let joined = joinSections(work);
  let total = charsOf(joined);
  if (total > b.total) {
    for (const id of EVICTION_ORDER) {
      const s = work.find((x) => x.id === id);
      if (!s || s.drop === false) continue;
      const keepHead = Math.max(0, Math.trunc(Number(s.keepHead) || 0));
      const floor = (s.minLines || 0) + keepHead;
      while (total > b.total && s.lines.length > floor) {
        const gone = s.trimFrom === 'oldest' ? s.lines.splice(keepHead, 1)[0] : s.lines.pop();
        total -= gone.length + 1;
        dropped.push({ id: s.id, label: s.label, chars: gone.length });
      }
      if (total <= b.total) break;
    }
  }
  if (total > b.total) {
    // 全部可砍的都砍完了仍然超（说明是人格文件/身份这种不可砍的段本身太大）——
    // 不静默接受：把 over 标出来交给调用方记进 trace。
    return { lines: joinSections(work), dropped: fold(dropped), over: true };
  }
  return { lines: joinSections(work), dropped: fold(dropped), over: false };
}

/**
 * 历史段（system 之外的 messages）按字符裁剪，**从最老的开始丢**。
 * 它不在 EVICTION_ORDER 里 —— 历史是会话本身，砍它等于砍对话，所以只在
 * 真的过长（单条无字数上限，长文能把上下文顶穿）时才动。
 */
export function fitHistory(items, budget = DEFAULT_BUDGET) {
  const b = typeof budget === 'object' && budget ? budget : DEFAULT_BUDGET;
  const list = [...(items || [])];
  const sizeOf = (arr) => arr.reduce((n, m) => n + messageSize(m), 0);
  const dropped = [];
  if (b.enabled === false) return { items: list, dropped };
  while (list.length > 1 && sizeOf(list) > b.historyChars) {
    const gone = list.shift();
    dropped.push({ id: 'history', label: '历史', chars: String(gone?.content ?? '').length });
  }
  return { items: list, dropped: fold(dropped) };
}

/**
 * 锚定历史窗口的粒度（2026-10-23 · 回迁维护者补丁）。
 *
 * `fitHistory` 每轮都可能从最老的丢一条 ⇒ 窗口第一格每轮都换 ⇒ 请求前缀每轮都变
 * ⇒ 服务商的前缀缓存**每轮失效**（缓存只认「从头开始逐字相同」的最长前缀）。
 * 这里把起点按 `step` 条一批地跳：两次跳之间窗口是**纯追加**，前缀稳定。
 *
 * `countFactor` 是"窗口最多比最近轮次多留几个 batch"的上限保护（当前实现最多
 * 多留 `step-1` 条，天然在这个上限内）；保留这个字段是为了与维护者的补丁
 * （与 token-guard 的自检）逐字对齐，不要因为"看起来没用到"就删掉。
 */
export const HIST_ANCHOR = Object.freeze({ step: 6, countFactor: 2 });

/**
 * 锚定式历史窗口。**纯函数**，与 `fitHistory` 同形返回。
 *
 * 不变量（每一条都有 smoke 断言）：
 *   ① **最近 `recentTurns` 条永不因锚点被丢**（字符预算再紧也不动它们）；
 *   ② 起点尽量落在 `step` 的整数倍上；两次锚点之间追加 1..step-1 条，起点不变；
 *   ③ 字符预算不足时从最老开始丢；丢掉多少如实记进 `dropped`；
 *   ④ `dropped` 与 `fitHistory` 同形（`{id,label,lines,chars}`），trace 拼接不用改。
 *
 * ⚠️ **不要把窗口算成 `recentTurns * countFactor`**：`remember()` 的 HIGH 就是
 *    `recentTurns * 2`，那样算窗口永远等于整段历史，本函数变成空操作 ——
 *    门禁会绿、行为一点没变（本批最危险的假绿形状）。
 *
 * @param {Array<object>} items
 * @param {object} budget `DEFAULT_BUDGET` 形状（只用 `enabled` / `historyChars`）
 * @param {{recentTurns?:number, step?:number}} opts
 * @returns {{items:Array, dropped:Array, anchor:{start:number,size:number,step:number,keep:number}}}
 */
export function anchorHistory(items, budget = DEFAULT_BUDGET, { recentTurns = 0, step = HIST_ANCHOR.step } = {}) {
  const b = typeof budget === 'object' && budget ? budget : DEFAULT_BUDGET;
  const list = [...(items || [])];
  const n = list.length;
  const batch = Math.max(1, Math.trunc(Number(step)) || HIST_ANCHOR.step);
  const keep = Math.max(1, Math.min(n || 1, Math.trunc(Number(recentTurns)) || 1));
  const maxStart = Math.max(0, n - keep);
  const sizeOf = (arr) => arr.reduce((m, x) => m + messageSize(x), 0);
  const dropped = [];
  if (b.enabled === false) {
    return { items: list, dropped, anchor: { start: 0, size: n, step: batch, keep } };
  }

  // ① 字符预算：从最老开始丢，但**绝不动最近 keep 条**（不变量 ①）。
  let charStart = 0;
  let total = sizeOf(list);
  while (charStart < maxStart && total > b.historyChars) {
    const gone = list[charStart];
    total -= messageSize(gone);
    charStart += 1;
  }

  // ② 锚定：条数窗口本身也要收（否则字符预算宽松时它带着整段历史，等于没锚）。
  //    起点 = min(条数起点, 字符起点) 之后按 batch 取整：
  //      · 字符没逼着丢 → **向下取整**，窗口落在 [keep, keep+batch-1]；
  //      · 字符逼着丢   → **向上取整**（宁可少带，也不超预算），但不越过 maxStart。
  const countStart = maxStart;
  const desired = Math.max(countStart, charStart);
  const anchored = desired > countStart
    ? Math.min(Math.ceil(desired / batch) * batch, maxStart)
    : Math.floor(countStart / batch) * batch;
  for (const gone of list.slice(0, anchored)) {
    dropped.push({ id: 'history', label: '历史', chars: String(gone?.content ?? '').length });
  }

  return {
    items: list.slice(anchored),
    dropped: fold(dropped),
    anchor: { start: anchored, size: n - anchored, step: batch, keep },
  };
}

/**
 * 上下文超长时的**收缩重试**（D8 · 报告 E3 的"语义降级层"）。**纯函数**。
 *
 * 什么时候用：服务端回了 400 且响应正文点名"上下文过长"。
 * 这时重发同一条请求只会再被拒一次，唯一有效的动作是**把历史砍短**。
 *
 * 两条硬约束（规格原话：「`persona` 与**本次消息永不砍**」）：
 *   ① 首条（system，内含 persona / 规则 / 隔离声明）**原样保留**；
 *   ② **最后一条（本次消息）原样保留** —— 砍掉它等于答非所问，
 *      比"上下文超长"更糟（表面上还成功了，而模型根本没看到它要说的话）。
 *   中间的历史段**从最老的开始丢**，与 `fitHistory` 同向。
 *
 * ⚠️ 缩不动时**原样返回同一个引用**：调用方靠 `next !== messages` 判断"这次降级
 *    有没有真的改变请求"。返回一个内容相同的新数组会让判据失效 →
 *    重发一次一模一样的请求（白打一枪），而且日志里会写着"已收缩"。
 *
 * @param {Array<object>} messages
 * @param {number} ratio 目标比例（**经验值**：留 60%，一次砍够免得再来一轮）
 * @returns {Array<object>} 缩不动时返回入参本身
 */
export const SHRINK_RATIO = 0.6;

export function shrinkHistory(messages, ratio = SHRINK_RATIO) {
  const list = Array.isArray(messages) ? messages : [];
  // 只剩「system + 本次消息」时没有任何历史可砍 —— 原样返回（别把这两条动掉）
  if (list.length <= 2) return list;
  const head = list[0];
  const tail = list[list.length - 1];
  const mid = list.slice(1, -1);
  const sizeOf = (arr) => arr.reduce((n, m) => n + messageSize(m), 0);
  const target = sizeOf(list) * (Number.isFinite(ratio) ? ratio : SHRINK_RATIO);
  const kept = [...mid];
  while (kept.length && sizeOf([head, ...kept, tail]) > target) kept.shift();
  if (kept.length === mid.length) return list; // 一条都没缩掉 → 引用不变，调用方据此放弃
  return [head, ...kept, tail];
}

/** 把逐行丢掉的记录压成"每段一条"，避免 trace 里塞几十行同 id 的碎片 */
function fold(list) {
  const by = new Map();
  for (const d of list) {
    const cur = by.get(d.id) || { id: d.id, label: d.label, lines: 0, chars: 0 };
    cur.lines += 1;
    cur.chars += d.chars;
    by.set(d.id, cur);
  }
  return [...by.values()];
}
