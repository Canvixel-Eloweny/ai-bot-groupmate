/**
 * 会话级中止与原地重试 · 判据层（D6 / 报告 E6）。
 *
 * ══════════════════════════════════════════════════════════════════════
 *  它解决的是哪个问题
 * ══════════════════════════════════════════════════════════════════════
 * 会话是**串行**的（`sessionQueue`：同一个会话的消息排队依次处理）。
 * 于是一轮卡住（上游超时 × 重试链）会让后面所有消息一起排队干等 ——
 * 面板看得见"正在生成"，却**停不掉**它。这是运维体验上最实的缺口。
 *
 * 另外两件事也归它管：
 *   · 中止要**立刻掐断在途请求**（不是等 60 秒超时），并且账面要与
 *     「超时」「出口闸门拦截」「模型报错」分得开 —— 否则排障时四种原因会互相冒充；
 *   · 失败后要能**原地重试**：复用同一个会话、同一批触发消息重跑一遍，
 *     但**已经发过言的会话绝不许重试**（那会变成刷屏）。
 *
 * ⚠️ 零依赖叶子（`AbortController` 是全局内建）：判据做成纯函数 + 薄状态机，
 *    smoke 才能直接喂反例。
 */

/**
 * 中止错误（**唯一构造点**）。
 *
 * 为什么要有专用标记而不是只靠 message 文案：上层要靠它分流 ——
 * 中止**不可重试**（重试＝用户刚说了别说话你又去打一次模型）、
 * **不算**「模型调用失败」（不该触发情绪插件降精力等失败副作用）。
 * 靠文案判断会在某次改措辞时静默失效。
 *
 * @param {string} [reason]
 * @returns {Error & {aborted: true}}
 */
export function abortError(reason = '本轮已被中止') {
  const err = new Error(reason);
  err.aborted = true;
  return err;
}

/** 这个错误是不是"被人为中止"。判据只有这一处。 */
export function isAborted(err) {
  return !!err && err.aborted === true;
}

/**
 * 把一次失败**归类**（唯一实现）。
 *
 * 四种账面必须分得开（本项目反复强调"几类原因别互相冒充"）：
 *   aborted —— 人点的中止：不可重试、不算失败、不降精力
 *   timeout —— 模型请求超时：可重试（一条未发出时）
 *   error   —— 其它失败（HTTP 4xx/5xx、网络、空回复…）：按既有重试链处理
 *
 * @param {unknown} err
 * @returns {'aborted'|'timeout'|'error'|''}
 */
export function abortOutcome(err) {
  if (!err) return '';
  if (isAborted(err)) return 'aborted';
  const msg = String(err?.message ?? '');
  if (/超时/.test(msg)) return 'timeout';
  return 'error';
}

/**
 * 「这一轮能不能原地重试」的判据（**纯函数**，四个入参全部由调用方给）。
 *
 * 三条铁律，缺一条都会变成事故：
 *   ① **已经发过言的一律不许重试** —— 重试等于把同一段话再发一遍（刷屏）。
 *      这是本项目"宁可少说一句，也不重复说"那条的延伸。
 *   ② **只有「一条未发出的失败」才可重试**：中止与超时都属于这一类；
 *      `error` 里混杂着"其实已经发了一部分"的情形，靠 sentCount 兜住。
 *   ③ **同一个会话同时只允许一个在途**：正在跑的时候点重试，
 *      会变成两条生成抢同一份上下文 —— 拒绝，并给出可读原因。
 *
 * @param {{outcome:string, sentCount:number, inflight:boolean, hasTrigger:boolean}} p
 * @returns {{ok:boolean, reason:string}}
 */
export function retryDecision({ outcome, sentCount, inflight, hasTrigger }) {
  if (!hasTrigger) return { ok: false, reason: '没有可重放的触发消息（该会话还没处理过消息，或机器人重启过）' };
  if (inflight) return { ok: false, reason: '这个会话正在生成中 —— 先中止，再重试' };
  if (Number(sentCount) > 0) return { ok: false, reason: '这一轮已经发出过消息，重试会变成重复刷屏' };
  if (outcome === 'error') return { ok: false, reason: '这一轮不是「一条未发出的失败」，按普通失败处理（不重放）' };
  if (outcome !== 'aborted' && outcome !== 'timeout') {
    return { ok: false, reason: '这一轮没有失败记录，没什么可重试的' };
  }
  return { ok: true, reason: '' };
}

/**
 * 会话级控制器（薄状态机：**只记状态、不做 IO、不发请求**）。
 *
 * 它不负责真正的取消 —— 取消动作落在 `llm.js`（`signal` 贯穿 fetch）与调用方
 * （`index.js` 把 signal 喂进去）。这里只回答三件事：
 * **谁在途 · 上一轮结果如何 · 能不能重试**。
 *
 * 两张表刻意分开：
 *   `states` —— **在途**（一轮跑完就删；读者是"中止"与面板快照）
 *   `last`   —— **上一轮的结果**（要活过这一轮；读者是"重试"判据）
 * 合成一张表会在轮次结束时被迫二选一：要么丢在途（中止失效），要么留幽灵（面板显示假运行中）。
 */
export function createSessionControl({ keep = 50 } = {}) {
  /** key → { controller, startedAt, sentCount, trigger }（在途） */
  const states = new Map();
  /** key → { outcome, sentCount, at, trigger }（上一轮；有上限，防只增不减） */
  const last = new Map();

  /** 写入"上一轮"，并维持上限（本项目对只增不减的容器一律设上限）。 */
  function remember(key, rec) {
    last.set(key, rec);
    while (last.size > keep) last.delete(last.keys().next().value);
  }

  return {
    /**
     * 开始一轮。返回 `signal`（喂给 `llm.chatWithUsage`）。
     * 重复 begin 同一个 key 会覆盖旧的那条 —— 调用方靠 sessionQueue 保证串行；
     * 真出现并发说明队列坏了，覆盖比抛错更不容易把主链路拖死。
     */
    begin(key, trigger = null) {
      states.set(key, { controller: new AbortController(), startedAt: Date.now(), sentCount: 0, trigger });
      return states.get(key).controller.signal;
    },

    /**
     * 一轮结束（成功/失败/中止**都走这里**）。`outcome` 由调用方用 `abortOutcome` 归类后给出。
     * 把在途那份搬进"上一轮"，这样重试判据才读得到 sentCount 与 outcome。
     */
    end(key, outcome = '') {
      const st = states.get(key);
      if (st) {
        remember(key, { outcome, sentCount: st.sentCount, at: Date.now(), trigger: st.trigger });
        states.delete(key);
      } else {
        // 没有在途记录（例如本轮在 begin 之前就失败了）：保留原有 outcome，别把它抹成空串
        const prev = last.get(key);
        if (prev) remember(key, { ...prev, outcome: outcome || prev.outcome });
      }
    },

    /** 真的发出第一条之后记账 —— 重试判据的关键输入。**在途与已结束两种状态都要记**。 */
    markSent(key) {
      const st = states.get(key);
      if (st) {
        st.sentCount += 1;
        return;
      }
      const prev = last.get(key);
      if (prev) remember(key, { ...prev, sentCount: prev.sentCount + 1 });
    },

    /**
     * 中止。返回是否真的掐到了在途的一轮 —— 调用方要靠它区分
     * "停掉了" 与 "本来就没事可停"（后者不该报错，也不该写审计）。
     */
    abort(key) {
      const st = states.get(key);
      if (!st) return false;
      // 把**带标记的中止错误**作为 reason 交给 AbortController：这样 `signal.reason`
      // 天然就是那个带 `aborted: true` 的错误，tool-loop / llm 两侧都不必再构造一次
      // （止于一处：中止错误的形状只有一个来源）。
      st.controller.abort(abortError());
      return true;
    },

    /** 在途吗。 */
    inflight(key) {
      return states.has(key);
    },

    /** 在途快照（面板/日志读它；**不返回 controller**，避免外部乱掐）。 */
    snapshot() {
      return [...states.entries()].map(([key, st]) => ({
        key,
        startedAt: st.startedAt,
        sentCount: st.sentCount,
        ms: Date.now() - st.startedAt,
      }));
    },

    /**
     * 这个会话能不能重试，以及要重放哪一批触发消息。
     * 判据本身在纯函数 `retryDecision` 里 —— 这里只负责取四个入参。
     */
    retryPlan(key) {
      const prev = last.get(key);
      const decision = retryDecision({
        outcome: prev?.outcome ?? '',
        sentCount: prev?.sentCount ?? 0,
        inflight: states.has(key),
        hasTrigger: !!prev?.trigger,
      });
      return { ...decision, trigger: prev?.trigger ?? null };
    },

    /** 观测用：上一轮的原始记录（测试与排障读它）。 */
    lastOf(key) {
      return last.get(key) ?? null;
    },
  };
}
