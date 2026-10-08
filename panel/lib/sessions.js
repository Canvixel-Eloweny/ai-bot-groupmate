/**
 * 会话与存档的**聚合判据**（面板 · P1 分区重构）。
 * ══════════════════════════════════════════════════════════════════════════
 *  为什么单独成模块
 * ══════════════════════════════════════════════════════════════════════════
 *  控制台原本只有「一张长页面 + 左侧目录」：所有信息都塞在同一屏里往下滚。
 *  参考实现（QQ-Agent 0.4 优化版本 3）是**标签页**：会话 / 存档 / 记忆 / … 各占一屏。
 *  本轮把控制台改成同样的形态，于是需要两个**新的读模型**：
 *    · 会话 = **现在**在跟谁聊、聊得怎么样（数据来自 trace）
 *    · 存档 = **之前**聊过什么（数据来自 `panel/session-archive.json`）
 *
 *  两者的数据源**故意不合并**：trace 是有界窗口（TRACE_MAX 会折半截断），
 *  存档是机器人退出时补写的全量历史。把它们合成一份，就是本项目反复在清的
 *  「一份数据两个副本」—— 而且这份会自己丢数据（第 11 条陷阱：量数载体被系统回收）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  两条硬约定
 * ══════════════════════════════════════════════════════════════════════════
 *  ① **纯函数**：不碰 IO、不读时钟（`now` 入参）。会话/存档的形状要能被断言直接喂。
 *  ② **认不出就不猜**：字段缺失一律按"未知"处理（显示成占位），不硬套当前配置、
 *     不补默认值 —— 与 `usage.js` 里 `v` / `k` 的处理是同一套约定。
 *
 * ⚠️ 层号：L1（只依赖本文件的常量，无 import）。已在 `check-wb` 的层次表登记。
 */

/** 会话键的形状（`SessionStore.key()` 的格式：`group:123` / `private:456`） */
export function keyOf(rec) {
  const scene = String(rec?.scene ?? '');
  const id = String(rec?.id ?? '');
  return scene && id ? `${scene}:${id}` : '';
}

/** 一条 trace 算不算"机器人真的回了话" */
function replied(rec) {
  return rec?.kind === 'reply' && Array.isArray(rec?.chunks) ? rec.chunks.length > 0 : rec?.kind === 'reply';
}

/**
 * 判定卡（D29）—— 一次**旁路判定**，不是一次对话往返。
 *
 * 为什么必须显式过滤、而不是"反正它在列表里也无所谓"：
 *   `count += 1` 对所有记录都加、`lastText` 取最新一条，于是判定卡一进来
 *   「这个会话聊了多少条」就虚高、列表里那一行还会显示成一张没有内容的白卡。
 *   这与 `skip` 记录不同 —— skip 是"这一轮真的来过"，判定卡是"回复发完之后又跑了一趟"。
 *
 * ⚠️ 数据**不丢**：它照旧落在 `panel/local-trace.jsonl` 里（可查、可复盘），
 *    **链路视图**还会给它一张专属短卡（Q10 已裁决"做最小渲染"，见 `judgeHtml`）。
 *    这里过滤的是**另一个消费者**："会话"那两个读模型（列表与明细）只回答
 *    "跟谁聊了什么"，判定卡不是一条消息 —— 两件事不要混。
 */
export function isJudgeCard(rec) {
  return rec?.kind === 'judge';
}

/** 一条 trace 算不算异常（模型调用失败 / 被闸门拦下） */
function errored(rec) {
  if (rec?.kind === 'error') return true;
  return Boolean(rec?.err || rec?.blocked);
}

/**
 * 把 trace 记录聚合成**会话列表**。**纯函数**。
 *
 * 一个会话 = 一个 `scene:id`（与机器人那边的 `session.key` 同形）。
 * 每条 trace 都带 `scene` / `id`，所以聚合不需要任何配置或反推。
 *
 * @param {Array<object>} records trace 记录（已解析）
 * @param {{now?:number, limit?:number}} o
 * @returns {Array<{key:string, scene:string, id:string, lastAt:number, count:number,
 *                  replies:number, errors:number, lastSender:string, lastText:string,
 *                  lastReason:string}>} 按最近活动时间倒序
 */
export function sessionsFromTrace(records, { now = Date.now(), limit = 200 } = {}) {
  const by = new Map();
  for (const r of Array.isArray(records) ? records : []) {
    if (isJudgeCard(r)) continue; // 判定卡不是这个会话的一条消息（见 isJudgeCard 的注释）
    const key = keyOf(r);
    if (!key) continue; // 认不出是谁 → 不猜，直接不进列表
    let s = by.get(key);
    if (!s) {
      s = {
        key,
        scene: String(r.scene ?? ''),
        id: String(r.id ?? ''),
        lastAt: Number(r.t) || 0,
        count: 0,
        replies: 0,
        errors: 0,
        lastSender: '',
        lastText: '',
        lastReason: '',
      };
      by.set(key, s);
    }
    s.count += 1;
    if (replied(r)) s.replies += 1;
    if (errored(r)) s.errors += 1;
    // ⚠️ 只认**更新的**那条：trace 是追加写，但文件被折半截断后顺序仍是从旧到新，
    //    用 `>=` 而不是无条件覆盖，免得最后一条恰好是老数据时把"最近"弄反。
    const t = Number(r.t) || 0;
    if (t >= s.lastAt) {
      s.lastAt = t;
      s.lastSender = String(r.sender ?? '');
      s.lastText = String(r.text ?? '');
      s.lastReason = String(r.reason ?? '');
    }
  }
  const out = [...by.values()].sort((a, b) => b.lastAt - a.lastAt);
  return limit > 0 ? out.slice(0, limit) : out;
}

/**
 * 从一个会话里挑出"要看的那几条"（**纯函数**）：按时间倒序，封顶。
 *
 * ⚠️ 为什么不返回全部：trace 文件可能上百条，一次全塞进 DOM 会让页面卡住 ——
 *    本项目对"只增不减"的数据一律设上限（日志 600、trace 120、会话 200）。
 */
export function sessionRecordsOf(records, key, { limit = 50 } = {}) {
  const hit = (Array.isArray(records) ? records : [])
    .filter((r) => !isJudgeCard(r) && keyOf(r) === key);
  hit.sort((a, b) => (Number(b.t) || 0) - (Number(a.t) || 0));
  return limit > 0 ? hit.slice(0, limit) : hit;
}

/**
 * 把机器人写的**会话存档**转成存档列表。**纯函数**。
 *
 * 存档的形状是 `{ v, fp, t, sessions: [...] }`（`src/session-archive.js` 写的），
 * 这里只做投影 —— 不重新实现"哪些会话该恢复"（那是机器人的判据，不在面板）。
 *
 * @param {{sessions?:Array<object>}|null} archive
 * @param {{limit?:number}} o
 * @returns {Array<{key:string, scene:string, id:string, turns:number, lastLine:string}>}
 */
export function chatsFromArchive(archive, { limit = 200 } = {}) {
  const list = Array.isArray(archive?.sessions) ? archive.sessions : [];
  const out = list.map((s) => {
    const hist = Array.isArray(s?.history) ? s.history : [];
    const last = hist[hist.length - 1];
    return {
      key: String(s?.key ?? keyOf(s)),
      scene: String(s?.scene ?? ''),
      id: String(s?.id ?? ''),
      turns: hist.length,
      // 只留最后一句的**前 80 字**：列表页不需要全文，详情里才给全
      lastLine: String(last?.content ?? '').slice(0, 80),
    };
  }).filter((c) => c.key);
  const sorted = out.sort((a, b) => b.turns - a.turns);
  return limit > 0 ? sorted.slice(0, limit) : sorted;
}

/**
 * 某一个会话的**存档详情**。**纯函数**。
 *
 * @returns {{key:string, turns:number, lines:Array<{role:string, content:string}>}|null}
 */
export function chatDetailOf(archive, key) {
  const list = Array.isArray(archive?.sessions) ? archive.sessions : [];
  const hit = list.find((s) => String(s?.key ?? keyOf(s)) === String(key));
  if (!hit) return null;
  const hist = Array.isArray(hit.history) ? hit.history : [];
  return {
    key: String(hit.key ?? keyOf(hit)),
    turns: hist.length,
    lines: hist.map((m) => ({ role: String(m?.role ?? ''), content: String(m?.content ?? '') })),
  };
}
