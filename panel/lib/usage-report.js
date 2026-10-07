/**
 * ══════════════════════════════════════════════════════════════════════
 *  用量与花费的账目判据（第 22 轮 H-10 从 `panel/server.js` 整块搬出）
 * ══════════════════════════════════════════════════════════════════════
 *  为什么单独立一个模块：这一族（价目表 / 计费判定 / 分桶 / 分来源）在本文件
 *  之外**没有任何调用点** —— 它只读账本文件、只吐一个对象。
 *  混在 3000 行的主文件里，改一次价目表要翻半页。
 *
 *  ⚠️ **判据一律注入，不 import `src/`** —— 本模块除 `node:` 内置**零 import**（L1）：
 *    · `USAGE_SOURCES` / `dayKeyOf` 住在 `src/`，而 `panel/lib` 只许引**登记过的**
 *      共享模块（`check-wb` 的 §7 有双向集合核对）；为它们开白名单，下一个人
 *      就会顺手把重型模块也引进来。
 *    · `MODEL_LABELS` / `CREDIT_CLOUD_MODELS` / `isZhipuModel` / `isLocalBase`
 *      在主文件与 `lib/models.js` 各自都还有调用点 —— 复制一份必然漂。
 *
 *  ⚠️ **两个模块级缓存随实现一起走**（`usageCache` / `usageFileCache`）：
 *    唯一读者就是这里的函数；清缓存的 `resetUsageCache()` 是**唯一写口**，
 *    所以"缓存只在持有它的模块里被赋值"这条语义一字不变。
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * 造一套用量账目判据。所有外部依赖由调用方注入（理由见文件头）。
 *
 * @param {object} deps
 * @param {string} deps.USAGE_DIR 账本目录（`panel/usage-*.jsonl`）
 * @param {RegExp} deps.USAGE_FILE_RE 账本文件名判据（唯一一份，住 `paths.js`）
 * @param {Record<string,string>} deps.MODEL_LABELS 模型名 → 规范展示名
 * @param {Set<string>} deps.CREDIT_CLOUD_MODELS 走「赠送额度」的云端模型
 * @param {(m:string)=>boolean} deps.isZhipuModel
 * @param {(u:string)=>boolean} deps.isLocalBase
 * @param {(d?:Date)=>string} deps.dayKeyOf 本地日期键（唯一实现住 `src/holidays.js`）
 * @param {Record<string,string>} deps.USAGE_SOURCES 来源枚举（唯一一份住 `src/usage.js`）
 * @returns {object} 见文件末尾的 return 名单
 */
export function makeUsageReport({
  USAGE_DIR, USAGE_FILE_RE, MODEL_LABELS, CREDIT_CLOUD_MODELS,
  isZhipuModel, isLocalBase, dayKeyOf, USAGE_SOURCES,
}) {
  // ---------- 用量与花费 ----------
  // 账本按月切分：`usage-YYYY-MM.jsonl`。
  // `usage.jsonl`（旧的单文件）也照读 —— 切分的是**写入**，不是历史："永久保留"是明确约定，
  // 所以读取侧同时认这两种名字，不做数据搬迁。

  // 官方价目表（元 / 百万 token，闲时档）。
  // 高峰时段（工作日 09:00–12:00、14:00–18:00）价格翻倍，所以这里是下限估值。
  const RATES = {
    'deepseek-flash': { in: 1, inCached: 0.02, out: 4 },
    'deepseek-v4-pro': { in: 4.5, inCached: 0.15, out: 13.5 },
    // 已停用的旧名字，但会静默跳转到 flash，早期记录按同价算
    'deepseek-chat': { in: 1, inCached: 0.02, out: 4 },
    'deepseek-reasoner': { in: 1, inCached: 0.02, out: 4 },
  };
  // 注意：这里**故意不再提供"默认费率"**。
  // 以前有个 RATE_FALLBACK，认不出的模型名就套 DeepSeek 的价格，
  // 结果把本机模型和智谱免费档都算成了花钱。认不出来就该按 0 处理并标注出来。
  // 智谱免费档在 FREE_CLOUD_MODELS 里单独维护。

  // `LOCAL_HOST_RE` / `isLocalBase()` 先搬去 `lib/models.js`（B11b-2），
  // 再搬去 `src/net-rules.js`（B11c）—— 最终落点以 `src/net-rules.js` 为准。
  // 它被 `isBillable` / `isLocalCall` / `shortModel` 与 models 自己共用 ——
  // 留在计费段里会让"计费"与"模型元数据"互相依赖。

  /**
   * 这条记录要不要花钱。
   *
   * 关键：只看「这条记录自己」的来源，跟当前配置、跟用户选了什么完全无关。
   * 之前面板拿"当前配置"去解释历史统计，于是切一次模式，账就串一次。
   *
   * 三级判定，越靠前越可信：
   *   1. local 标记 —— 调用发生时直接写死的，最准
   *   2. b（接口地址）—— 按地址判本机 / 云端
   *   3. 都没有 —— 早期记录，只认登记过的云端模型名，其余一律当免费（宁可少算不多算）
   */
  function isBillable(r) {
    const model = String(r.model || '');
    // 智谱模型优先判断：接口地址是公网，光看地址会被误判成付费。
    // 官方免费档和走赠送额度的，当前都不产生实际扣费。
    if (isZhipuModel(model)) return false;
    if (typeof r.local === 'boolean') return !r.local;
    if (r.b) return !isLocalBase(r.b);
    return !!RATES[model];
  }

  /** 这条记录有没有可用的价目（没有就别猜，标出来让用户自己看） */
  function rateKnown(r) {
    if (!isBillable(r)) return true;
    return !!RATES[String(r.model || '')];
  }

  /** 这条记录的来源确定吗（用于提示早期数据可能不准） */
  function originKnown(r) {
    return typeof r.local === 'boolean' || !!r.b;
  }

  /**
   * 这条记录走的是本机模型吗。
   * 注意和 isBillable 是两件事：智谱免费档走的是**云端**、但**不花钱**。
   * 之前把"免费"直接等同于"本机"，导致免费云端调用被算进本机那一栏，是错的。
   */
  function isLocalCall(r) {
    if (typeof r.local === 'boolean') return r.local;
    if (r.b) return isLocalBase(r.b);
    return false;
  }

  function costOf(r) {
    if (!isBillable(r)) return 0;
    // 价目表里没有的模型**不猜价格**。之前这里回落到 DeepSeek 默认价，
    // 结果把本机模型、免费模型统统算成了花钱 —— 认不出就不该收钱。
    const rate = RATES[String(r.model || '')];
    if (!rate) return 0;
    const hit = Math.min(r.h || 0, r.p || 0);
    const miss = Math.max(0, (r.p || 0) - hit);
    return (miss * rate.in + hit * rate.inCached + (r.c || 0) * rate.out) / 1e6;
  }

  /** 把模型名整理成看得懂的样子：长路径缩成末段，已知模型给出规范名 */
  function shortModel(model, base) {
    const m = String(model || '');
    if (!m) return '(未知)';
    if (m.includes('/')) {
      const tail = m.split('/').filter(Boolean).pop() || m;
      return isLocalBase(base) ? `${tail}（本机）` : tail;
    }
    return MODEL_LABELS[m] || m;
  }

  // 全量账本每次轮询都重算太贵：按「所有账本文件的大小+mtime 签名 + 当天日期」缓存，
  // 没变就返回上次结果。用户要求"留全账"—— 缓存只加速、绝不截断文件。
  let usageCache = { sig: '', dateKey: '', data: null };
  // 逐文件缓存解析结果：账本按月切分之后，**只有当月那份会变**，
  // 往月的永远命中缓存、不再重复解析 —— 这正是切分要换来的东西。
  const usageFileCache = new Map(); // path -> { sig, recs }

  /** 账本文件清单（含历史遗留的单文件），按文件名排序 = 按月份排序 */
  function listUsageFiles() {
    let names = [];
    try {
      names = fs.readdirSync(USAGE_DIR).filter((n) => USAGE_FILE_RE.test(n));
    } catch {
      return []; // 目录都读不了，就当没有账本
    }
    return names
      .map((n) => {
        const p = path.join(USAGE_DIR, n);
        try {
          const s = fs.statSync(p);
          return { path: p, sig: `${s.size}:${s.mtimeMs}` };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  /** 所有账本记录（已解析），按文件逐个缓存 */
  function usageRecords() {
    const out = [];
    for (const f of listUsageFiles()) {
      let e = usageFileCache.get(f.path);
      if (!e || e.sig !== f.sig) {
        const recs = [];
        try {
          for (const line of fs.readFileSync(f.path, 'utf8').split('\n')) {
            const t = line.trim();
            if (!t) continue;
            try {
              recs.push(JSON.parse(t));
            } catch {
              /* 坏行跳过：账本是 append-only，写一半的行不该让整页统计挂掉 */
            }
          }
        } catch {
          /* 读不了就当这一份是空的 */
        }
        e = { sig: f.sig, recs };
        usageFileCache.set(f.path, e);
      }
      out.push(...e.recs);
    }
    return out;
  }

  /**
   * 账务来源 → 给人看的中文标签（D29）。
   *
   * ⚠️ 契约 §47 会断言「`USAGE_SOURCES` 的每一个值都在这里有标签」——
   *    少一个的话，D31 加第四个来源时面板上会冒出一个英文裸键，而**没有任何门会响**。
   *    （这就是"人工挑出来的表要钉回客观证据"那条纪律：表不许靠自觉保持同步。）
   */
  const SOURCE_LABEL = {
    agent: '主回复',
    memoryJudge: '记忆判定',
    proactiveTopic: '主动话题',
  };

  function readUsage() {
    const files = listUsageFiles();
    const sig = files.map((f) => f.sig).join('|');
    const dateKey = dayKeyOf();
    if (usageCache.data && usageCache.sig === sig && usageCache.dateKey === dateKey) {
      return usageCache.data;
    }
    const empty = {
      calls: 0, paidCalls: 0, freeCalls: 0,
      prompt: 0, completion: 0, reasoning: 0, cached: 0, cost: 0,
      today: { calls: 0, paidCalls: 0, freeCalls: 0, cost: 0, cloudCost: 0, localCalls: 0 },
      cloud: { calls: 0, cost: 0, paidCalls: 0, freeCalls: 0, prompt: 0, completion: 0, reasoning: 0 },
      local: { calls: 0, cost: 0, paidCalls: 0, freeCalls: 0, prompt: 0, completion: 0, reasoning: 0 },
      legacyUnknown: 0,
      unknownRate: 0,
      creditUsage: { calls: 0, prompt: 0, completion: 0, total: 0 },
      bySource: [],
      avgCost: 0, lastAt: null, recent: [], rates: RATES,
    };
    if (!files.length) {
      usageCache = { sig, dateKey, data: empty };
      return empty; // 还没产生过用量
    }
    const records = usageRecords();

    const t0 = new Date();
    t0.setHours(0, 0, 0, 0);
    const dayStart = t0.getTime();

    let calls = 0, paidCalls = 0, freeCalls = 0;
    let prompt = 0, completion = 0, reasoning = 0, cached = 0, cost = 0;
    let todayCalls = 0, todayPaid = 0, todayFree = 0, todayCost = 0, todayLocal = 0;
    let legacyUnknown = 0, unknownRate = 0;
    // 走「赠送额度」的模型累计消耗了多少 token。
    // 智谱没有公开的余量查询接口（探测过 account/balance 等路径都不存在），
    // 所以只能把自己这边用掉的数量算出来，让用户对消耗速度有个概念。
    const creditUsage = { calls: 0, prompt: 0, completion: 0, total: 0 };
    // 云端桶里再区分"免费档"和"计费档"，本机桶永远 0 花费
    const cloud = { calls: 0, cost: 0, paidCalls: 0, freeCalls: 0, prompt: 0, completion: 0, reasoning: 0 };
    const local = { calls: 0, cost: 0, paidCalls: 0, freeCalls: 0, prompt: 0, completion: 0, reasoning: 0 };
    // ── D29 · 按来源分账 ──────────────────────────────────────────────────────
    // 要回答的问题是"今天这些 token 是谁花的"。**口径与 `legacyUnknown` 同源**：
    // 记录里没有 `s` 的老账一律进「未标注」，不猜、不回填。
    // ⚠️ 桶名来自 `src/usage.js` 的 `USAGE_SOURCES`（**唯一一份枚举**）——
    //    在面板侧再抄一份字面量，D31 加来源时就会两边漂移。
    const srcKeys = Object.values(USAGE_SOURCES);
    const bySrc = new Map(srcKeys.map((k) => [k, { calls: 0, tokens: 0 }]));
    const unmarked = { calls: 0, tokens: 0 };
    const recent = [];

    for (const r of records) {
      const free = !isBillable(r);
      const c = costOf(r);
      if (!originKnown(r)) legacyUnknown += 1;
      if (isBillable(r) && !rateKnown(r)) unknownRate += 1;

      calls += 1;
      prompt += r.p || 0;
      completion += r.c || 0;
      reasoning += r.r || 0;
      cached += r.h || 0;
      cost += c;
      if (free) freeCalls += 1;
      else paidCalls += 1;

      // 按「走本机还是走云端」分桶。免费云端仍算云端，只是不花钱。
      if (CREDIT_CLOUD_MODELS.has(String(r.model || ''))) {
        creditUsage.calls += 1;
        creditUsage.prompt += r.p || 0;
        creditUsage.completion += r.c || 0;
        creditUsage.total += (r.p || 0) + (r.c || 0);
      }

      const bucket = isLocalCall(r) ? local : cloud;
      bucket.calls += 1;
      bucket.cost += c;
      bucket.prompt += r.p || 0;
      bucket.completion += r.c || 0;
      bucket.reasoning += r.r || 0;
      if (!isLocalCall(r)) {
        if (free) bucket.freeCalls += 1;
        else bucket.paidCalls += 1;
      }

      if (r.t >= dayStart) {
        todayCalls += 1;
        todayCost += c;
        if (free) { todayFree += 1; todayLocal += 1; }
        else todayPaid += 1;
      }

      // D29：按来源分桶。认不出的 `s`（含老记录的空串）进「未标注」——
      // 与上面 `originKnown(r)` 处理 `v` 是同一套约定：认不出就不猜。
      {
        const bucket = bySrc.get(String(r.s || '')) || unmarked;
        bucket.calls += 1;
        bucket.tokens += (r.p || 0) + (r.c || 0);
      }

      recent.push({
        t: r.t,
        model: shortModel(r.model, r.b),
        rawModel: r.model,
        free,
        // 来源看「走本机还是走云端」，不是看花不花钱
        // （智谱免费档是云端、但免费，这两件事必须分开）
        origin: isLocalCall(r) ? 'local' : 'cloud',
        // 云端但没花钱的，再细分「官方免费」和「走赠送额度」——
        // 前者永远免费，后者额度用完就会变
        freeCloud: !isLocalCall(r) && free,
        credit: CREDIT_CLOUD_MODELS.has(String(r.model || '')),
        think: r.think || 'auto',
        level: r.level || 'medium',
        p: r.p || 0,
        c: r.c || 0,
        r: r.r || 0,
        cost: c,
      });
    }

    const result = {
      calls, paidCalls, freeCalls,
      prompt, completion, reasoning, cached, cost,
      today: {
        calls: todayCalls, paidCalls: todayPaid, freeCalls: todayFree,
        cost: todayCost, cloudCost: todayCost, localCalls: todayLocal,
      },
      cloud,
      local,
      legacyUnknown,
      unknownRate,
      creditUsage,
      // D29：按来源分账。**只给出有过调用的桶**（全 0 的那种不占版面），
      // 顺序 = 声明顺序，最后才是「未标注」。标签在这里定死，页面只负责渲染 ——
      // 页面自带一份枚举的话，D31 加第四个来源时两边必然漂移。
      bySource: [
        ...srcKeys.map((k) => ({ key: k, label: SOURCE_LABEL[k] || k, ...bySrc.get(k) })),
        ...(unmarked.calls ? [{ key: '', label: '未标注', ...unmarked }] : []),
      ].filter((b) => b.calls > 0),
      // 单条均价只按「真正花钱的那些」算，不然一堆免费的本机调用会把均值拉低到没意义
      avgCost: paidCalls ? cost / paidCalls : 0,
      lastAt: recent[recent.length - 1]?.t || null,
      recent: recent.slice(-25).reverse(),
      rates: RATES,
    };
    usageCache = { sig, dateKey, data: result };
    return result;
  }

  /**
   * 清空账本缓存（`apiUsageReset` 的唯一入口）。
   *
   * ⚠️ 缓存是**模块级**的，写它的地方只有这里与 `readUsage` 末尾 ——
   *    赋值点仍然全在同一个模块里（第 18/19 轮的纪律：缓存留在持有它的模块）。
   */
  function resetUsageCache() {
    usageCache = { sig: '', dateKey: '', data: null };
  }

  return {
    RATES, SOURCE_LABEL, isBillable, rateKnown, originKnown, isLocalCall,
    costOf, shortModel, listUsageFiles, usageRecords, readUsage, resetUsageCache,
  };
}
