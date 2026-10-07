/**
 * 跨轮工作记忆（超短期）：只记「上一轮做到哪」，不记它心里在想什么。
 *
 * ── 它解决的是哪一种"不像人" ──────────────────────────────────────────
 * 群里的上下文是**滚动**的：背景窗口（ambient）只有最近若干条，历史也按档位收窄。
 * 于是二十分钟前它问过群里一句"你呢？"，等对方回过神来答一句，
 * 它已经看不见自己问过什么了 —— 真人记得，它不记得。
 * 这一节就是那点"刚才进行到哪"的连续性：**极短**（90 分钟硬上限）、**极省**（≤160 字符）。
 *
 * ── 纪律：只存客观状态，绝不存心理活动 ────────────────────────────────
 * 对面那份 MIT 实现（QQ-Agent `conversation-memory/cross-turn.js`）把这条写在了文件头：
 * 它逐条看过 4732 条真实注入行，发现把"未发送的想法"喂回模型会**每轮教它继续潜水**
 * （负向强化）、会让它去接早已翻篇的事、还会把思考块的措辞习惯教给它的语气。
 * 所以那里改成只注入三类客观状态。本模块照这个结论裁剪（不是照抄代码）：
 *
 *   ① `ask`      上一轮**发出过**一句问句、还没等到回答 —— 下一轮才认得出"这是在回答我"
 *   ② `unsaid`   上一轮有话要说、却**没说出口**（许可变了 / 发送中断）—— 下一轮知道有半截话
 *   ③ ~~`lastQuery` 上一轮检索过什么线索~~ —— **不做**：本项目没有"检索线索"这回事
 *      （对面靠 `memory_search` 这类工具，我们没有），硬造一个只会多一份没人读的字段。
 *
 * ── 为什么**不落盘**（重启即丢是有意的）────────────────────────────────
 * 它是 90 分钟 TTL 的超短期状态，与 `mutedUntil` / `quietUntil` 同一族：
 * 到期时间戳自己会失效，没有定时器、没有需要清理的东西。
 * 落盘就要回答"重启后要不要把它恢复回来" —— 而恢复一个**过期的**"刚才进行到哪"
 * 比没有更糟（它会接上一个早就结束的话题，看起来有记忆，其实没有）。
 * 失忆是诚实的，假记忆不是。代价只是重启后第一句少一点连贯，可接受。
 *
 * ⚠️ 本模块是**零依赖叶子**：不 import 任何本地模块、不碰 IO、不读墙钟
 *    （`now` 一律由入参给）。这样"淡忘到什么程度"才能在测试里直接被断言。
 */

/** 整体硬上限：超过这么久的一律丢掉（经验值 —— E13 规格给的 90 分钟，非官方阈值） */
export const WORK_TTL_MS = 90 * 60 * 1000;

/** 逐条淡忘：每静默满这么久，丢掉**最早**的一条（经验值 —— 同上，30 分钟） */
export const WORK_DECAY_MS = 30 * 60 * 1000;

/** 最多留几条（经验值；再多就变成"复读聊天记录"了） */
export const WORK_MAX_TURNS = 3;

/** 注入的**总**字符上限（含标题行）—— E13 规格给的 160 */
export const WORK_MAX_CHARS = 160;

/** 引文（自己上一句问了什么）最多留多少字 */
const WORK_QUOTE_CHARS = 20;

/** 段标题。⚠️ 带"别照着念"：这一段写的是它自己说过的话，不写这句它会复读出来。 */
export const WORK_HEADER = '【刚才聊到哪】（别当成现在的事，别照着念）';

/**
 * 这一句是不是在**问对方**（等一个回答）。
 *
 * 判据全部来自对面那份实现的实测结论：
 *   · 1200 个真实会话里，末句真是提问的只有 6.8% —— 这个状态本来就该是稀有的；
 *   · 抽查到的提问里混着「你们搁这做数学题呢」这类**对全场的反问**，
 *     它们不是在等某个人回答，所以这里把它们排除掉。
 *
 * @returns {boolean}
 */
export function looksLikeAsk(text) {
  const t = String(text ?? '').replace(/[「」"'“”]/g, '').trim();
  if (!t || t.length > 60) return false;
  // 「你们搁这做数学题呢」「这不就是日常的我吗」—— 都是**对全场的反问**，
  // 不是在等某个人回答。判据宁可漏认、不可误认：把"不是提问"当成提问，
  // 下一轮就会以为"我还在等人回话"，而其实没人欠它一个回答。
  if (/你们|大家|各位|楼上|楼下|这不就是|咱这/.test(t)) return false;
  if (/[？?]\s*$/.test(t)) return true;
  // 群里不一定打问号，「…吗」「…呢」结尾同样是提问（「吧」不算：多是建议或祈使）
  return /(吗|呢)[~～!！。.…\s]*$/.test(t);
}

/** 「约 N 分钟前 / 约 2 小时前」—— 给它时间感，免得把隔了很久的事当成刚发生。 */
export function ageLabel(at, now) {
  const ms = Math.max(0, Number(now) - (Number(at) || 0));
  const min = Math.floor(ms / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `约${min}分钟前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `约${h}小时前`;
  return `约${Math.floor(h / 24)}天前`;
}

/**
 * 从一轮的**客观结果**里提炼一条工作记忆。
 *
 * @param {{now:number, sentTexts?:string[], unsaid?:boolean}} opts
 *   · `sentTexts` —— 这一轮**真的发出去**的文字（与记忆里记的同一个口径：没发出去的不算）
 *   · `unsaid`    —— 有话要说却没说出口（许可变了 / 发送中断）
 * @returns {{at:number, ask:string, unsaid:boolean}|null} null = 这一轮没什么可交代
 */
export function turnOf(opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const list = (Array.isArray(opts.sentTexts) ? opts.sentTexts : []).filter((s) => String(s ?? '').trim());
  const last = list.slice(-1)[0] || '';
  const ask = last && looksLikeAsk(last)
    ? String(last).replace(/\s+/g, ' ').trim().slice(0, WORK_QUOTE_CHARS)
    : '';
  // 空轮不占名额：既没问过、也没有半截话的轮次，记进去只会把真正的状态挤出队列
  if (!ask && !opts.unsaid) return null;
  return { at: now, ask, unsaid: !!opts.unsaid };
}

/**
 * 按**空窗**淡忘：空窗 = 现在距最新一轮过去了多久；每满一个 decayMs 丢掉最早一条。
 * 停 30 分钟再聊 → 最早那条已经没了；一直聊 → 一条都不丢。
 *
 * @returns {object[]} 新数组（不修改入参）
 */
export function decayTurns(turns, opts = {}) {
  const maxTurns = Number.isFinite(opts.maxTurns) ? opts.maxTurns : WORK_MAX_TURNS;
  const decayMs = Number.isFinite(opts.decayMs) ? opts.decayMs : WORK_DECAY_MS;
  const list = (Array.isArray(turns) ? turns : []).filter(Boolean).slice(0, maxTurns);
  if (!list.length || !(decayMs > 0)) return list;
  const gap = Number(opts.now) - (Number(list[0].at) || 0);
  if (gap < decayMs) return list;
  const drop = Math.floor(gap / decayMs);
  if (drop <= 0) return list;
  return list.slice(0, Math.max(0, list.length - drop));
}

/**
 * 一轮结束后的**唯一**收口：过期的丢掉 → 按空窗淡忘 → 新的一条压在最前 → 封顶。
 *
 * ⚠️ 空轮**不清除**已有历史（turnOf 返回 null 时原样返回）：
 *    对面那版以前是"空轮就 unlink 文件"，于是前几轮一起被冲掉了。
 *    这里连文件都没有，更没有理由清空 —— 静默丢一批正是本项目最怕的失败形态。
 *
 * @param {object[]|undefined} turns 会话上现有的那些
 * @param {{now:number, sentTexts?:string[], unsaid?:boolean}} opts
 */
export function nextTurns(turns, opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const ttlMs = Number.isFinite(opts.ttlMs) ? opts.ttlMs : WORK_TTL_MS;
  const decayMs = Number.isFinite(opts.decayMs) ? opts.decayMs : WORK_DECAY_MS;
  const maxTurns = Number.isFinite(opts.maxTurns) ? opts.maxTurns : WORK_MAX_TURNS;

  // ① 硬上限：超过 TTL 的整条不要（"一个小时前问过什么"不该再影响现在这句话）
  const fresh = (Array.isArray(turns) ? turns : [])
    .filter((t) => t && Number.isFinite(t.at) && now - t.at <= ttlMs);
  // ② 逐条淡忘：空窗越久，留下的越少
  const kept = decayTurns(fresh, { now, decayMs, maxTurns });
  // ③ 新的一条压在最前（读的时候按顺序叫"最近 / 上次 / 更早"）
  const turn = turnOf({ now, sentTexts: opts.sentTexts, unsaid: opts.unsaid });
  if (!turn) return kept;
  return [turn, ...kept].slice(0, maxTurns);
}

/**
 * 渲染成要塞进提示词的那一小段。
 *
 * ⚠️ 上限是**硬**的（`WORK_MAX_CHARS`）：这一段挂在必变段里（永不砍），
 *    所以它自己必须有字符上限 —— 否则"永不砍的段"会变成一个无底的口子。
 *
 * @returns {string} 没有可交代的东西时返回空串（提示词一个字都不多）
 */
export function renderWorking(turns, opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const maxChars = Number.isFinite(opts.maxChars) ? opts.maxChars : WORK_MAX_CHARS;
  const maxTurns = Number.isFinite(opts.maxTurns) ? opts.maxTurns : WORK_MAX_TURNS;
  const list = (Array.isArray(turns) ? turns : []).filter(Boolean).slice(0, maxTurns);

  const lines = [];
  for (const [i, t] of list.entries()) {
    const bits = [];
    if (t.ask) bits.push(`问过「${t.ask}」，还没等到回答`);
    if (t.unsaid) bits.push('有句话上一轮没说出口');
    if (!bits.length) continue;
    const tag = i === 0 ? '最近' : i === 1 ? '上次' : '更早';
    lines.push(`- ${tag}(${ageLabel(t.at, now)})：${bits.join('；')}`);
  }
  if (!lines.length) return '';

  const out = `${WORK_HEADER}\n${lines.join('\n')}`;
  return out.length > maxChars ? `${out.slice(0, maxChars - 1)}…` : out;
}
