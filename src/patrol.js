/**
 * 巡逻（批量轮）
 * ══════════════════════════════════════════════════════════════════════════
 *  解决的问题：一个群里一下午没人找它，但它也不是没看见 —— 消息都停在未读里。
 *  「随机插话」只看**当前这一条**的冷场时长，「定时主动」到点就问模型「说点什么」，
 *  两者都不读积压。于是「群友在聊一件它其实知道的事，它全程没吭声」没有出口。
 *
 *  巡逻 = 群里安静下来之后，把这段时间的未读**合成一条摘要**，走既有回复链路问一轮：
 *  模型看摘要决定接一句还是 `qq_quiet`。这就是 0.1.1 `flushGroup` 的语义。
 *
 *  ⚠️ 三条纪律（与 `src/notice.js` 的补看事件同族）：
 *  ① **先取快照、再消费**：消费的是快照里的 id —— 巡逻期间新到的必然还留在未读；
 *  ② **走既有 `enqueueFor`**：串行队列 / 判定 / 限流 / 花费闸 / 出口闸门 / 发送节奏 /
 *     会话存档一样都不少，**不另开一条发送路径**；
 *  ③ **零隐藏定时器**：计划函数是纯的，挂在哪一次 tick 由调用方（`tickProactive`）决定。
 *
 *  ⚠️ 零依赖叶子（不许 import 任何模块）。
 * @module patrol
 */

/** 巡逻的默认参数（工作台可改，落 `custom.trigger.patrol`）。 */
export const PATROL_DEFAULTS = Object.freeze({
  /** 总开关。关掉 = 不再有巡逻轮。 */
  enabled: true,
  /** 至少攒够几条未读才值得问一轮模型。 */
  minUnread: 5,
  /** 群里安静多少分钟之后才巡逻（还在聊就别插队）。 */
  silenceMin: 10,
  /** 同一个群两轮巡逻至少隔多少分钟。 */
  minGapMin: 20,
  /** 基础概率（0–1），再乘热度权重。 */
  chance: 0.5,
  /** 摘要最多带几条 / 多少字。 */
  maxLines: 24,
  maxChars: 1800,
});

/** 归一化 `custom.trigger.patrol`：只认认识的键，坏值回默认。 */
export function patrolTuningOf(trigger) {
  const p = trigger && typeof trigger === 'object' ? (trigger.patrol || {}) : {};
  const num = (v, def, lo, hi) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return def;
    return Math.min(hi, Math.max(lo, n));
  };
  return {
    enabled: p.enabled !== false,
    minUnread: Math.round(num(p.minUnread, PATROL_DEFAULTS.minUnread, 1, 200)),
    silenceMin: num(p.silenceMin, PATROL_DEFAULTS.silenceMin, 0, 24 * 60),
    minGapMin: num(p.minGapMin, PATROL_DEFAULTS.minGapMin, 0, 24 * 60),
    chance: num(p.chance, PATROL_DEFAULTS.chance, 0, 1),
    maxLines: Math.round(num(p.maxLines, PATROL_DEFAULTS.maxLines, 1, 60)),
    maxChars: Math.round(num(p.maxChars, PATROL_DEFAULTS.maxChars, 100, 6000)),
  };
}

function hhmm(at) {
  const d = new Date(Number(at) || 0);
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

/**
 * 把未读压成摘要正文：每行 `HH:MM 昵称：内容`，超上限从**最旧**的丢。
 * 空文本的行跳过（表情包、纯图在摘要里没内容），但计数不受影响。
 */
export function patrolDigestOf(unread, { maxLines = PATROL_DEFAULTS.maxLines, maxChars = PATROL_DEFAULTS.maxChars } = {}) {
  const list = Array.isArray(unread) ? unread : [];
  const lines = [];
  for (const item of list) {
    const text = String(item?.text ?? '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const who = String(item?.speaker ?? '') || String(item?.sender ?? '') || String(item?.userId ?? '') || '某人';
    lines.push(`${hhmm(item?.at)} ${who}：${text.slice(0, 200)}`);
  }
  while (lines.length > maxLines) lines.shift();
  let out = lines.join('\n');
  if (out.length > maxChars) out = out.slice(out.length - maxChars);
  return out;
}

/**
 * 这一轮该不该巡逻、巡逻哪几个群。
 *
 * ⚠️ 素材是 `session.ambient`（背景窗口），**不是** `session.unread`：
 *    `unread` 是门禁账本 —— `decide()` 一返回就被消费掉了（跳过的那条也算"处理完"），
 *    所以巡逻去看它永远看到 0。而 ambient 记的正是"群里刚说了什么"，
 *    也是它当时没接的那些话。两次巡逻之间用 `lastPatrolAt` 切一刀，就不会重复问。
 *
 * @param {object} args
 * @param {Array<{key:string, scene:string, id:string, recent:Array<{speaker?:string,text?:string,at?:number,userId?:string}>,
 *                lastMsgAt:number, lastPatrolAt:number}>} args.chats
 * @param {number} args.now
 * @param {object} args.tuning `patrolTuningOf()` 的结果
 * @param {(chat:object)=>number} [args.heatOf] 群活跃度（0–1），默认 1（不看活跃度）
 * @returns {{picked:Array<object>, skipped:Array<{key:string, why:string}>}}
 */
export function patrolPlanOf({ chats, now, tuning, heatOf }) {
  const t = tuning || PATROL_DEFAULTS;
  const heat = typeof heatOf === 'function' ? heatOf : () => 1;
  const picked = [];
  const skipped = [];
  if (!t.enabled) {
    for (const c of chats || []) skipped.push({ key: String(c?.key ?? ''), why: '巡逻已关闭' });
    return { picked, skipped };
  }
  for (const chat of chats || []) {
    const key = String(chat?.key ?? '');
    if (!key || chat.scene !== 'group') continue;
    const since = Number(chat.lastPatrolAt) || 0;
    const recent = (Array.isArray(chat?.recent) ? chat.recent : [])
      .filter((m) => Number.isFinite(Number(m?.at)) && Number(m.at) > since);
    if (recent.length < t.minUnread) continue; // 攒得不够，安静跳过（不是问题，不用记）
    const lastMsgAt = Number(chat.lastMsgAt) || Number(recent[recent.length - 1]?.at) || 0;
    const silenceMs = now - lastMsgAt;
    if (silenceMs < t.silenceMin * 60_000) continue; // 还在聊
    if (now - since < t.minGapMin * 60_000) continue; // 刚巡逻过
    const last = recent[recent.length - 1] || {};
    const weight = Math.min(1, Math.max(0, heat(chat)));
    picked.push({
      key,
      scene: chat.scene,
      id: String(chat.id ?? ''),
      count: recent.length,
      sinceMs: silenceMs,
      heat: weight,
      chance: Math.min(1, Math.max(0, t.chance) * (0.5 + 0.5 * weight)),
      digest: patrolDigestOf(recent, t),
      lastUserId: String(last.userId ?? ''),
      lastSender: String(last.speaker ?? ''),
    });
  }
  // 越热越先。（`picked.sort` 稳定，分数相同按会话顺序。）
  picked.sort((a, b) => b.heat - a.heat || b.count - a.count);
  return { picked, skipped };
}

/**
 * 合成巡逻事件：形状与真事件一致（`enqueueFor` 之后判定/组提示词/发送全都照旧），
 * 只多一个宿主侧标记 `isPatrol`。
 *
 * ⚠️ **不放 @**：巡逻不是被人叫，判定必须走「巡逻」那一支；
 *    ⚠️ 也**不给 message_id**：它不能被当成一条新未读再记一遍（自我繁殖）。
 */
export function patrolEventOf(p, selfId) {
  const text = String(p?.digest ?? '');
  const sender = String(p?.lastSender ?? '') || '群里的人';
  return {
    post_type: 'message',
    message_type: 'group',
    group_id: String(p?.id ?? ''),
    user_id: String(p?.lastUserId ?? ''),
    self_id: String(selfId ?? ''),
    sender: { card: sender, nickname: sender },
    message: [{ type: 'text', data: { text } }],
    // 宿主侧标记（与 `isCatchUp` 同款）：这一轮是巡逻，提示词里要多一句。
    isPatrol: true,
    // 计划里算好的概率也带上：判定（`decide`）只认这个值，不自己再掷一次配置。
    patrol: { count: Number(p?.count) || 0, sinceMs: Number(p?.sinceMs) || 0, chance: Number(p?.chance) || 0 },
  };
}
