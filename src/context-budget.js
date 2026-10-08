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
const SECTION_ORDER = [
  'base', 'persona', 'enhance', 'rules', 'isolate', 'memory', 'scenes', 'skills', 'speech', 'ambient', 'volatile',
];

/**
 * 超预算时的淘汰顺序（**先砍前面的**）。
 * 与计划 v4 §5.2 定的优先级一致：人格 > 规则 > 场景 > 技能 > 记忆 > ambient > 历史。
 */
export const EVICTION_ORDER = ['ambient', 'skills', 'memory', 'scenes', 'enhance', 'rules', 'persona'];

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
const DEFAULT_BUDGET = Object.freeze({
  enabled: true,
  /** system 段总上限 */
  total: 16000,
  sections: Object.freeze({
    persona: 6000,
    enhance: 3000,
    rules: 1500,
    memory: 3000,
    scenes: 2500,
    skills: 2000,
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
 * @param {{id:string,label:string,lines:string[],drop?:boolean,trimFrom?:'newest'|'oldest',minLines?:number}[]} sections
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
    while (charsOf(s.lines) > cap && s.lines.length > (s.minLines || 0)) {
      const gone = s.trimFrom === 'oldest' ? s.lines.shift() : s.lines.pop();
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
      while (total > b.total && s.lines.length > (s.minLines || 0)) {
        const gone = s.trimFrom === 'oldest' ? s.lines.shift() : s.lines.pop();
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
