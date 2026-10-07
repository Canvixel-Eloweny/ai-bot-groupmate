import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// 月份键与「今天」同源：唯一实现住在零依赖叶子 `holidays.js`（第 13 轮 H-11 收敛前，
// 这里是第二份 `monthKey`，与 `trace-stats.dayKeyOf` 各拼各的补零）。
import { monthKeyOf } from './holidays.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 账本文件路径：**按月切分**，默认 `panel/usage-YYYY-MM.jsonl`。
 *
 * 为什么切分而不是截断：用户明确要"留全账"，所以绝不删记录；
 * 但单文件只增不减，半年后每 3 秒轮询都要全量解析数千行。
 * 按月切分后**往月的文件永不改动**，读取侧可以逐文件缓存 —— 两边都满足。
 *
 * `QQBOT_USAGE_FILE` 让测试把它指去临时目录 —— 与 `QQBOT_CONFIG` / `QQBOT_TRACE_FILE`
 * 同一套做法。每次调用都重新读环境变量（而不是模块加载时读一次）：
 * 这样测试能**在运行时**改，也免得踩"改完环境变量却不生效"那种只有跑起来才发现的坑。
 */
export function usageFilePath() {
  if (process.env.QQBOT_USAGE_FILE) return path.resolve(process.env.QQBOT_USAGE_FILE);
  return path.join(ROOT, 'panel', `usage-${monthKeyOf()}.jsonl`);
}

/* ══════════════════════════════════════════════════════════════════════════
 *  D29 · 账务的「来源」维度
 * ══════════════════════════════════════════════════════════════════════════
 *
 *  要回答的问题只有一个：**今天这些 token 是谁花的**。
 *  在此之前所有账目混在一本账里，于是"主回复烧了多少 / 判定类偷烧了多少"
 *  只能靠 `c <= 160` 这种近似口径去猜（见外包方案 §2.6 的量数说明）——
 *  而那是**猜**，不是账。
 *
 *  ⚠️ 这里**只加一列**，不加第二本账。按调用点各写一份文件会立刻产生
 *     "哪本账算进日额度"的第二套口径，与 D8 刚建立的三档熔断正面冲突。
 *
 *  ⚠️ 三个值**只放真正有生产写入口的**。空串（老记录 / 没声明）一律按「未标注」，
 *     与 `v` / `local` / `k` 是同一套约定：**不猜、不回填**。
 *     D31 的 `sleepJudge` 由 D31 自己往这张表加一行 —— 不提前预写"没人写也没人读"的值。
 */
export const USAGE_SOURCES = Object.freeze({
  /** 主回复：`index.js` 主链路（含其中的工具回合，账记的是聚合值） */
  agent: 'agent',
  /** 记忆判官：`memory.js` 的 `#judge`（自己那一份账自己拿） */
  memoryJudge: 'memoryJudge',
  /** 主动话题生成：`index.js` 的 `composeTopic`（故意不带会话键） */
  proactiveTopic: 'proactiveTopic',
});

/**
 * 记一条模型用量。统计失败绝对不能影响正常回复，所以整段都吞异常。
 * @param {{model:string,base:string,vendor:string,prompt:number,completion:number,
 *          reasoning:number,cached:number,attempts:number,chat?:string,source?:string}|null} u
 */
export function recordUsage(u) {
  if (!u) return;
  try {
    const FILE = usageFilePath();
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.appendFileSync(
      FILE,
      JSON.stringify({
        t: Date.now(),
        model: u.model || '',
        b: u.base || '', // 接口地址：本机地址 = 不花钱
        // 服务商：和 base 一样在**写入时定死**，统计时就不必再反推。
        // 老记录没有这个字段 → 统计那边标成「未知渠道」，不猜、不硬套当前配置。
        v: u.vendor || '',
        // 落盘时就把「本地/云端」「思考档位」写死。
        // 统计只看这条记录自身，不依赖"当前配置"，切换模式就不会张冠李戴。
        local: u.local === undefined ? undefined : !!u.local,
        think: u.think || 'auto',
        level: u.level || 'medium',
        p: u.prompt || 0, // 输入 token
        c: u.completion || 0, // 输出 token（含思考）
        r: u.reasoning || 0, // 其中思考 token
        h: u.cached || 0, // 其中命中缓存的输入 token
        // 这一条账背后实际发了几次 HTTP（重试 / 降级 / 去参数重试都算）。
        // 只记「返回了 usage 的那一次」的 token，绝不把失败尝试相加（429 通常不计费、
        // 500 未必计了，相加会让账目虚高）；次数单独放在这里，就能看出"打了几枪"。
        a: u.attempts ?? 1,
        // ── D8 新增：这一笔账属于哪个会话 ────────────────────────────────
        // 格式与 `SessionStore.key()` **逐字一致**（`group:123` / `private:456`），
        // 由调用方直接把 `session.key` 传进来 —— 这里**不重新拼一遍**，
        // 否则就是同一份语义的第二份拷贝（两份漂移的表现是"某个群的账永远为空"）。
        //
        // ⚠️ 老记录没有这个字段 → perChat 统计时**不计入任何会话**（不猜、
        //    不硬套当前会话），与 `v` / `local` 的处理是同一套约定。
        //    当日**总量**照旧把老记录算进去 —— 否则限额会被历史空白低估。
        k: u.chat || '',
        // ── D29 新增：这一笔账是**谁**花的 ────────────────────────────────
        // 取值只来自 `USAGE_SOURCES`，由调用点**写时定死**（面板绝不按"当前配置"反推 ——
        // 与 `v` / `local` / `k` 同一条纪律）。
        //
        // ⚠️ 老记录没有这个字段 → 分来源统计时归「未标注」，**不猜、不回填**。
        // ⚠️ **不参与任何限额计算**：`tokenTotalOf` / `sumUsageOf` / `usageLevelOf` /
        //    `usageGateOf` 一个字都没改 —— 来源是"事后归因"用的，不是第二套额度。
        s: u.source || '',
      }) + '\n'
    );
  } catch {
    /* 忽略 */
  }
}

/* ══════════════════════════════════════════════════════════════════════════
 *  D8 · 花费熔断（报告 E3）
 * ══════════════════════════════════════════════════════════════════════════
 *
 *  它解决的是"用法没有上限"这件事：账本一直在写（`recordUsage` 只增不减），
 *  但**没有任何地方读它** —— 也就是说，无论这个机器人一天烧掉多少 token，
 *  都没有任何一段代码会因此改变行为。这与本项目已修掉的"无上限"类缺陷同型
 *  （提示词长度、重连代际号…），区别只在于计量对象换成了 token。
 *
 *  三档语义（**判据是纯函数，接线各一处**）：
 *    ok       正常
 *    trim     达到 `trimAt` → **只砍 ambient / skills 两段**（见 context-budget 的
 *             `SAVING_DROP`）；`persona` 与**本次消息永不砍**
 *    degrade  达到 100% → **不哑掉**：停止主动发言，但被 @ / 私聊照常回复
 *             （项目既有先例：`llm.js` 里"宁可多花一次等待，也不能让机器人在群里彻底哑掉"）
 *
 *  ⚠️ 所有阈值都是**经验值**，不是任何服务商的官方限额。定标依据是真机账本实测
 *     （2026-09-26，`panel/usage-2026-09.jsonl` 541 条，已排除 mock 与本机探测流量）：
 *       · 单条请求合计 token：中位 2189 / p90 3588 / p99 5348 / 最大 6896
 *       · 稳态日合计：9/24 = 120,833 · 9/25 = 118,396 · 9/23 = 258,232（改造日偏高）
 *     取"稳态日最大值 × 2 以上"作为日额度 —— 目的是**封住无上限**，
 *     不是让正常使用被砍（默认配置下一天最多进 trim 档一次都难）。
 *
 *  ⚠️ 真机主链路走的是智谱**免费档**（`isBillable` 判定为不花钱），
 *     所以"熔断"在这里的真实意义是**用量**而不是**花钱** ——
 *     免费档同样有限流与额度。报告里不许把它写成"省钱"（§4.2 定性必须如实）。
 */

/** 经验值（见上方定标依据）。改它之前先重新量一遍账本，别照着旧数字调。 */
export const USAGE_LIMITS = Object.freeze({
  /** 一个自然日（本地时间）允许的总 token */
  dailyTokens: 600000,
  /** 同一个会话（群 / 私聊）一天内允许的总 token。
   *  ⚠️ 这一条**没有历史分布可依**：老账本没有 `k` 字段（D8 才开始记），
   *     所以它按"单会话最多吃掉日额度的 1 / 2"设计。等 `k` 攒出真实分布后按实测定。 */
  perChatTokens: 300000,
  /** 达到额度的这个比例就进入 trim 档（规格原话：达 85% 只砍 ambient / skills） */
  trimAt: 0.85,
});

/** 一条账的 token 合计。只认 `p` / `c` 两个字段 —— 思考 token 已含在 `c` 里，不许再加一遍。 */
export function tokenTotalOf(rec) {
  return (Number(rec?.p) || 0) + (Number(rec?.c) || 0);
}

/**
 * 本地时间的当日零点。与面板「今天」的口径一致（都是本地时间，不是 UTC）。
 * @param {number} now
 */
function dayStartOf(now = Date.now()) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * 从账本行里算出「今天用了多少 / 这个会话今天用了多少」。**纯函数**（`now` 入参）。
 *
 * 两条口径必须分开（写错任何一条都会让限额失真）：
 *   · **当日总量**：所有今天的记录都算，**含 `k` 为空的老记录** ——
 *     老记录也是真花出去的 token，漏掉会让限额被低估；
 *   · **单会话量**：只算 `k` 与 `chatKey` 逐字相等的。`k` 为空的老记录
 *     **不计入任何会话**（不猜它是谁），这是"认不出就不算"的既有约定。
 *
 * @param {Array<object>} records 账本行（已解析）
 * @param {{now?:number, chatKey?:string}} o
 * @returns {{dayTokens:number, chatTokens:number, dayCalls:number, chatCalls:number}}
 */
export function sumUsageOf(records, { now = Date.now(), chatKey = '' } = {}) {
  const from = dayStartOf(now);
  let dayTokens = 0;
  let dayCalls = 0;
  let chatTokens = 0;
  let chatCalls = 0;
  for (const r of records || []) {
    if (!r || (Number(r.t) || 0) < from) continue;
    const n = tokenTotalOf(r);
    dayTokens += n;
    dayCalls += 1;
    if (chatKey && r.k === chatKey) {
      chatTokens += n;
      chatCalls += 1;
    }
  }
  return { dayTokens, chatTokens, dayCalls, chatCalls };
}

/**
 * 三档判定。**纯函数**：给定用量与额度，返回档位（smoke 直接喂合成数字断言）。
 *
 * 判据取两条额度里**更紧的那一条**：日额度用掉 90% 与单会话用掉 90%，
 * 都该进同一档 —— 分开判的话会出现"单会话超额了但整体还宽裕，于是什么都不做"。
 *
 * @param {{dayTokens:number, chatTokens:number, limits?:typeof USAGE_LIMITS}} p
 * @returns {{level:'ok'|'trim'|'degrade', ratio:number, which:'day'|'chat'|''}}
 */
export function usageLevelOf({ dayTokens = 0, chatTokens = 0, limits = USAGE_LIMITS } = {}) {
  const L = limits || USAGE_LIMITS;
  const dayRatio = L.dailyTokens > 0 ? dayTokens / L.dailyTokens : 0;
  const chatRatio = L.perChatTokens > 0 ? chatTokens / L.perChatTokens : 0;
  const ratio = Math.max(dayRatio, chatRatio);
  const which = chatRatio > dayRatio ? 'chat' : dayRatio > 0 ? 'day' : '';
  const trimAt = Number.isFinite(L.trimAt) ? L.trimAt : USAGE_LIMITS.trimAt;
  const level = ratio >= 1 ? 'degrade' : ratio >= trimAt ? 'trim' : 'ok';
  return { level, ratio, which: level === 'ok' ? '' : which };
}

/** 只读**当月**账本文件（今天一定落在当月，所以日额度不需要翻旧文件）。 */
function readCurrentMonthRecords() {
  const FILE = usageFilePath();
  try {
    const st = fs.statSync(FILE);
    // 同一个大小 + 同一个 mtime = 同一份内容，不必重复解析。
    // ⚠️ 缓存只加速、**绝不截断**：账本是 append-only，这份文件只会变长。
    if (_cache.sig === `${st.size}:${st.mtimeMs}`) return _cache.recs;
    const recs = [];
    for (const line of fs.readFileSync(FILE, 'utf8').split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try {
        recs.push(JSON.parse(t));
      } catch {
        /* 坏行跳过：写入是 append，进程被杀会留下半行 —— 不该让整个限额体判据挂掉 */
      }
    }
    _cache = { sig: `${st.size}:${st.mtimeMs}`, recs };
    return recs;
  } catch {
    return []; // 没有账本 = 今天还没花过，从零开始算，不是错误
  }
}
let _cache = { sig: '', recs: [] };

/**
 * 机器人侧的唯一一处「这一轮该用什么档」入口（IO 只在这里）。
 *
 * ⚠️ 它**不是**面板 `readUsage()` 的第二份拷贝：那个是"整本账、给人看的展示聚合"，
 *    带逐文件缓存为 3 秒轮询服务；这一处只回答一个问题 ——
 *    **今天 / 这个会话用了多少、该不该收敛**，只读当月一份文件。
 *    两者共用的是 `usageFilePath()`（路径的唯一推导处），不是同一份判据。
 *
 * @param {{now?:number, chatKey?:string, limits?:typeof USAGE_LIMITS}} o
 */
export function usageGateOf({ now = Date.now(), chatKey = '', limits = USAGE_LIMITS } = {}) {
  const sum = sumUsageOf(readCurrentMonthRecords(), { now, chatKey });
  const { level, ratio, which } = usageLevelOf({
    dayTokens: sum.dayTokens,
    chatTokens: sum.chatTokens,
    limits,
  });
  return { level, ratio, which, ...sum, limits: limits || USAGE_LIMITS };
}
