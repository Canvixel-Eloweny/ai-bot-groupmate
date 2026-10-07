/**
 * 背景消息（ambient）窗口的选择策略（第 36 轮 B10f-2 · C-AMBIENT）
 * ══════════════════════════════════════════════════════════════════════════
 *  为什么改
 * ══════════════════════════════════════════════════════════════════════════
 *  旧实现是 `session.ambient.slice(-N)` —— 一个**每来一条就整体下滑一格**的滑动窗口。
 *  B10e 的真机测量（中位 95.7%）显示：现在决定前缀命中率的已经不是时间行，而是这一段。
 *  而滑动窗口的性质是：窗口没填满时新消息只是追加（前缀能一直匹配到追加处），
 *  **一旦填满，每来一条就挤掉最老的一条，这一段的第一行就变了** —— 断口会从段末尾
 *  前移到段开头，命中率会掉一大截（这是**推断**，真机上窗口还没填满，尚未撞到）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  口径：密度 = 稳定性
 * ══════════════════════════════════════════════════════════════════════════
 *  判据不是"谁说话多/多久/多长"，而是"这一条被选进来之后，下一轮它还在不在"。
 *  实现成两条：
 *   ① **粘性** —— 上一轮进了提示词的那批条目，这一轮继续留着（不再每轮重排）；
 *   ② **成批更替** —— 需要换的时候整批换，而不是每轮滑一格，把"错位"集中到少数几轮。
 *
 *  ⚠️ `batch` 的默认值是**经验值**：攒够 4 条新消息才整批换一次。
 *     它决定"背景消息最多落后群里 4 条"，调小更实时、调大更省缓存。
 *
 * ⚠️ 跨重启：粘性批次只存在内存里，**重启后第一批必然重新选**（与"绝对锚点归零"
 *    同一个已知取舍，计划 v4 已记录为接受项，不另做落盘）。
 */

/** 攒够几条新消息才整批换一次。**经验值**，可用 `context.ambientBatch` 覆盖。 */
export const DEFAULT_AMBIENT_BATCH = 4;

/** 给没有 id 的条目（多是存档恢复回来的）补 id —— 幂等，重复调用不会改写已有 id */
function ensureIds(session, all) {
  let seq = Number.isFinite(session.ambientSeq) ? session.ambientSeq : 0;
  for (const m of all) {
    if (m && m.id == null) m.id = ++seq;
    if (m && Number.isFinite(m.id) && m.id > seq) seq = m.id;
  }
  session.ambientSeq = seq;
  return seq;
}

/**
 * 挑出这一轮要进提示词的背景消息。
 *
 * @param {object} session 会话（用 `ambientBatch` / `ambientBatchSeq` 记住当前这批）
 * @param {{window?:number, batch?:number}} opts window = context.ambientMessages
 * @returns {{entries:object[], refreshed:boolean, stale:number}}
 *   refreshed = 这一轮整批换过；stale = 自成批以来又新到了几条消息
 */
export function pickAmbient(session, { window = 20, batch = DEFAULT_AMBIENT_BATCH } = {}) {
  const all = Array.isArray(session?.ambient) ? session.ambient : [];
  if (!(window > 0) || !all.length) return { entries: [], refreshed: false, stale: 0 };

  ensureIds(session, all);
  // 注意 byId 用的是**整个后备数组**（上限 2×window），不是当前窗口：
  // 冻结期间被展示的旧条目要还能查得到 —— 这正是"粘性"的全部意义。
  const byId = new Map(all.map((m) => [m.id, m]));

  const prev = Array.isArray(session.ambientBatch) ? session.ambientBatch : [];
  const size = Math.max(1, Math.round(batch));
  // 自成批以来新到达的消息数。用它（而不是"有几条被挤出后备数组"）做触发器，
  // 否则后备数组上限 2×window 之下条目迟迟不被清出，粘性批次会**永远不刷新**、
  // ambient 永久冻结 —— 写 T47 推演时抓到的一个真 bug。
  const seq = Number.isFinite(session.ambientSeq) ? session.ambientSeq : 0;
  const mark = Number.isFinite(session.ambientBatchSeq) ? session.ambientBatchSeq : seq;
  const since = Math.max(0, seq - mark);

  let cur = prev.filter((id) => byId.has(id));
  let refreshed = false;
  if (!cur.length || since >= size) {
    // 整批换：取最新 window 条，全部换掉 —— 把"错位"集中到少数几轮
    cur = all.slice(-window).map((m) => m.id);
    refreshed = true;
  }
  // ⚠️ D9a：**粘性批次也要收进当前窗口**。
  //   改造前 `cur` 必然 ≤ window（它由 `all.slice(-window)` 生成，且 window 是常量），
  //   所以这条 slice 是恒等的、看不出必要。但档位上线之后 window 会**逐轮变**
  //   （插话档 8、被 @ 档 20）：不带这一刀的话，从 20 档切到 8 档时，
  //   上一轮那 20 个 id 全都 "byId.has" 成立 → 照样把 20 条塞进提示词，
  //   **档位静默失效**，而每一层断言都还是绿的。
  //   加了这一刀，`cur ⊆ 当前窗口` 才是这一节的不变量。
  cur = cur.slice(-window);
  if (refreshed) session.ambientBatchSeq = seq;
  session.ambientBatch = cur;
  return { entries: cur.map((id) => byId.get(id)).filter(Boolean), refreshed, stale: since };
}
