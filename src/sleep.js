/**
 * 睡眠 / 作息 —— **判据层**（D31-1 · 报告 E-睡眠作息全局）。
 * ══════════════════════════════════════════════════════════════════════════
 *  它要回答的唯一问题
 * ══════════════════════════════════════════════════════════════════════════
 *  **现在该不该睡**。睡着时它不回话（主链路直接停下）—— 这是"每天都说话"的机器
 *  最像人的一件事：夜里没有人会回你消息。
 *
 *  三条硬约定，每条都对应一个曾经踩过的坑：
 *   ① **状态由计划重算，落盘里绝不写 `status`**。存一个 `status:'asleep'` 进文件，
 *      就等于让"上一次写入时它以为的状态"决定今天 —— 重启、手工改文件、时钟跳变
 *      都会让那份缓存变成谎话。判据只吃 `now` + 计划，随时可重算（与 `usage.js`
 *      的"写时定死"是相反的两件事：那里面向历史，这里面向当前）。
 *   ② **读不到计划就判醒**（fail-safe）：宁可多花一点 token，也不要无声地不响应。
 *      "静默失效"比"多花钱"贵得多 —— 与 `bridge-lock` 的 degraded 同向。
 *   ③ **不新增第二套深夜判据**：`custom.trigger.quietHours`（免打扰）管的是"主动发言"，
 *      这里管的是"整个人的作息"。两者叠加时取**交集**（都关才停），
 *      但判据各住各处 —— 在 `interject.js` 里加时段因子是被明令禁止的（契约 §41）。
 *
 * ⚠️ 零依赖叶子：不 import、不碰 IO、时间由 `now` 入参给（反例才能在测试里逐格喂）。
 */

/**
 * 叫醒词默认表（**经验值**，不是任何人的真实用词）。
 *
 * 为什么给默认值而不是"留空 = 叫不醒"：词表是**措辞**，不是权限 ——
 * 真正的开关是"有没有配主人"（`config.owner.qq`）。一个配了主人却因为没写词表
 * 而叫不醒的机器人，表现与"它坏了"完全一样（D31 反复踩的那类静默失效）。
 *
 * 都是**短词**：叫醒是"喊一声"，一句长句里的"起床"两个字也可能是正常聊天 ——
 * 但这一路的代价不对称：误唤醒 = 它回一句；漏唤醒 = 主人再喊一次。
 */
export const WAKE_WORDS_DEFAULT = Object.freeze(['起床', '醒醒', '醒一醒', '别睡了', '起来了']);

/**
 * 紧急连发的窗口与条数（**经验值**）。
 *
 * 「主人私聊 10 秒内连发 3 条」= 出事了、等不了 —— 与"说到词"是两件事：
 * 前者是一时着急，后者是明确要它起床。两条路的收尾也不同（紧急是临时醒）。
 */
export const WAKE_BURST = Object.freeze({ windowMs: 10000, count: 3 });

/** 紧急唤醒的收尾静默（**经验值**）：主人私聊安静这么久就走收尾判定。 */
export const EMERGENCY_QUIET_MS = 10 * 60 * 1000;

/**
 * `override`（叫醒态）的闭集合。
 *
 * ⚠️ 它**不是**"状态" —— 它是一个**事件记录**（"这一刻有人把它叫醒了，有效到 `until`"）。
 *    状态（此刻睡没睡）仍然每次由 `planOf` + `now` 重算，`override` 只是判据的一个入参。
 *    这正是它**可以落盘**而 `status` 不可以的原因：`until` 是绝对时刻，
 *    任何时刻重读都能算出同一个答案；`status` 是"上一次写入时的看法"，重启即说谎。
 */
const WAKE_KINDS = Object.freeze(['owner', 'emergency']);

/**
 * 默认计划（**经验值**，不是任何人的真实作息）。
 *
 * `enabled` 默认 **false** —— 与 D12b 的 Q20 裁决同款："参数化 + 可观测，总闸不开"。
 * 理由：睡着意味着**半夜不回话**，那是行为面变更，不该由一次提交替用户决定。
 * 打开它是一句话的事（`config.json` 的 `custom.sleep.enabled`）。
 */
/**
 * 入睡前那句晚安的**默认文案**（Q11 裁决②：做·她主动道晚安）。
 *
 * ⚠️ **经验值**，且刻意写得像一句人话而不是模板：它要表达的是"我要睡了"，
 * 不是"系统即将进入低功耗模式"。真人睡前说的那句通常很短、带一点睡意，
 * 也不会 @ 任何人。
 */
export const GOODNIGHT_DEFAULT = '困了，我先去睡啦，大家晚安～';

export const SLEEP_DEFAULTS = Object.freeze({
  enabled: false,
  /** 入睡时刻（HH:MM，本地时间） */
  bed: '02:00',
  /** 起床时刻（HH:MM，本地时间） */
  wake: '10:00',
  /** 叫醒词表（空数组 = 用 `WAKE_WORDS_DEFAULT`；归一化在 `readSleep`） */
  wakeWords: WAKE_WORDS_DEFAULT,
  /** 入睡前自己说的那句（空 / 不是字符串 → 用 `GOODNIGHT_DEFAULT`） */
  goodnight: GOODNIGHT_DEFAULT,
});

/** 状态闭集合。`waking` 留给 D31-3 的起床补看，本步只会产出前两种。 */
export const SLEEP_STATUS = Object.freeze({ awake: 'awake', asleep: 'asleep', waking: 'waking' });

/**
 * 配置面的归一化（照 `readBrowseLock` 的先例：归一化规则与判据住同一个模块）。
 *
 * ⚠️ 这里与 `planOf` 的方向**故意相反**，两处都要写清楚，否则下一个人会以为其中一个是错的：
 *   · **配置面**（这里）认不出的时刻 → **回落成默认值**（用户填错了，给一套能用的）；
 *   · **判据面**（`planOf`）认不出的计划 → **disabled = 判醒**（宁可醒着，不要无声地不响应）。
 */
export function readSleep(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const bed = parseHhmm(r.bed) ? String(r.bed).trim() : SLEEP_DEFAULTS.bed;
  const wake = parseHhmm(r.wake) ? String(r.wake).trim() : SLEEP_DEFAULTS.wake;
  // 只有**真的是 true** 才算开（字符串 "false" 之类一律当关 —— 与 browseLock 同一条约定）
  return {
    enabled: r.enabled === true,
    bed,
    wake,
    wakeWords: normalizeWakeWords(r.wakeWords),
    // Q11：那句晚安。**空串 / 全是空白 → 回落默认**（配错的代价是"它一句话不说就睡了"，
    // 而那正是"没人通知我它睡了"的观感来源）。想让它**什么也别说**，给一个全空白之外的
    // 明确空值是不行的 —— 本函数不提供"关闭"这个开关，因为关闭它等于 Q11 裁决没做。
    goodnight: typeof r.goodnight === 'string' && r.goodnight.trim() ? r.goodnight.trim() : GOODNIGHT_DEFAULT,
  };
}

/**
 * 叫醒词表的归一化。**空 / 不是数组 / 全是空白 → 用默认表**（见 `WAKE_WORDS_DEFAULT`）。
 *
 * ⚠️ 空数组**不表示"关掉叫醒"**：关叫醒的唯一开关是"有没有配主人"
 *    （`config.owner.qq` 为空 → 两条路整体关闭）。把"词表为空"也解释成关闭，
 *    就等于同一件事有两个开关，而其中一个写在配置模板里没人看得见。
 */
function normalizeWakeWords(raw) {
  if (!Array.isArray(raw)) return WAKE_WORDS_DEFAULT;
  const list = [...new Set(raw.map((w) => String(w ?? '').trim()).filter(Boolean))];
  return list.length ? list : WAKE_WORDS_DEFAULT;
}

/**
 * 正文里命中了哪一个叫醒词（没命中返回空串）。
 *
 * 用 `includes` 而不是整句相等：真人是「在吗？起床了没」这样喊的，不是只发两个字。
 * 误命中的代价是它回一句，不会说不该说的话。
 */
function wakeWordOf(text, words) {
  const t = String(text ?? '');
  if (!t) return '';
  for (const w of words || []) {
    const kw = String(w ?? '').trim();
    if (kw && t.includes(kw)) return kw;
  }
  return '';
}

/** 「这个 QQ 号是不是主人」。**逐字比较**（不经过模型 —— 这就是"模型自述不算"的结构性落实）。 */
export function isOwner(userId, owners) {
  const u = String(userId ?? '').trim();
  if (!u) return false;
  return (owners || []).some((o) => String(o) === u);
}

/** `HH:MM` → `{h, mi}`；认不出返回 `null`（**不猜**，也不回落成当前时刻）。 */
export function parseHhmm(raw) {
  const s = String(raw ?? '').trim();
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return { h, mi };
}

/**
 * 算出"当前落在哪一个作息窗口里"。**纯函数**。
 *
 * @param {{now:number, bed?:string, wake?:string}} o
 * @returns {{disabled:boolean, reason:string, inWindow:boolean, bedAt:number, wakeAt:number, cycleKey:string}}
 *   · `disabled` = 这个计划不生效（起止相同 / 认不出）→ 调用方一律按"醒着"处理；
 *   · `inWindow` = `now` 落在 `[bedAt, wakeAt)` 里；
 *   · `cycleKey` = 当前这一"夜"的唯一键（用**入睡时刻**派生，跨零点也不会混淆）。
 */
export function planOf({ now = 0, bed, wake } = {}) {
  const off = { disabled: true, reason: '', inWindow: false, bedAt: 0, wakeAt: 0, cycleKey: '' };
  const b = parseHhmm(bed);
  const w = parseHhmm(wake);
  if (!b) return { ...off, reason: '入睡时刻认不出' };
  if (!w) return { ...off, reason: '起床时刻认不出' };
  if (b.h === w.h && b.mi === w.mi) {
    // 起止相同 = 这个计划不生效。照 `inQuietHours` 的先例（from === to 就是不静默）：
    // 一个"从 3 点到 3 点睡"的配置十有八九是填错了，静默停一整天比放行糟得多。
    return { ...off, reason: '入睡与起床是同一时刻' };
  }

  const day0 = new Date(now);
  day0.setHours(0, 0, 0, 0);
  const at = (dayOffset, t) => {
    const d = new Date(day0.getTime());
    d.setDate(d.getDate() + dayOffset);
    d.setHours(t.h, t.mi, 0, 0);
    return d.getTime();
  };
  const bedMin = b.h * 60 + b.mi;
  const wakeMin = w.h * 60 + w.mi;
  const cross = bedMin > wakeMin; // 跨零点（绝大多数真实作息）

  if (!cross) {
    const bedAt = at(0, b);
    const wakeAt = at(0, w);
    return { disabled: false, reason: '', inWindow: now >= bedAt && now < wakeAt, bedAt, wakeAt, cycleKey: `d${bedAt}` };
  }
  // 跨零点：**今天凌晨那一段属于昨晚开始的窗口** —— 直接把"今天 00:00–wake"算进去的话，
  // 凌晨三点会被判成"还没到入睡时间"（那正是最该睡的时候）。
  if (now < at(0, w)) {
    const bedAt = at(-1, b);
    return { disabled: false, reason: '', inWindow: true, bedAt, wakeAt: at(0, w), cycleKey: `d${bedAt}` };
  }
  if (now >= at(0, b)) {
    const bedAt = at(0, b);
    return { disabled: false, reason: '', inWindow: true, bedAt, wakeAt: at(1, w), cycleKey: `d${bedAt}` };
  }
  const bedAt = at(0, b);
  return { disabled: false, reason: '', inWindow: false, bedAt, wakeAt: at(1, w), cycleKey: `d${bedAt}` };
}

/**
 * 由计划算出状态。**纯函数**。
 *
 * ⚠️ `plan.disabled` → 一律 `awake`（fail-safe：读不到计划时宁可醒着）。
 *
 * D31-2 加了一个入参：**叫醒态优先于计划**。叫醒的意义就是"计划说它该睡，但人把它喊起来了"，
 * 所以 `override` 必须先判 —— 顺序反了的话，叫醒这件事永远不会生效（而两条路都"看起来接上了"）。
 *
 * @param {{plan:object, override?:object, now?:number}} o
 * @returns {'awake'|'asleep'}
 */
export function statusOf({ plan, override, now = 0 } = {}) {
  if (overrideActive(override, now)) return SLEEP_STATUS.awake;
  if (!plan || plan.disabled) return SLEEP_STATUS.awake;
  return plan.inWindow ? SLEEP_STATUS.asleep : SLEEP_STATUS.awake;
}

/**
 * 造一个叫醒态。`kind` 不在闭集合里 → 返回 `null`（**不猜**，也不回落成任何一种）。
 *
 * ⚠️ 它带 `byUserId` 是为了"是谁叫醒的"这件事可查 —— 与"叫醒靠纯 QQ 号比较"同一取向：
 *    身份只留客观数据，不留模型的自述。
 */
export function overrideOf({ kind, until, byUserId = '', now = 0 } = {}) {
  if (!WAKE_KINDS.includes(kind)) return null;
  const u = Number(until);
  if (!Number.isFinite(u) || u <= 0) return null;
  return { kind, until: u, byUserId: String(byUserId ?? ''), at: Number(now) || 0 };
}

/**
 * 这个叫醒态此刻还有效吗。**纯函数**（`now` 入参）。
 *
 * 判据只有一条：`until` 还没到。`kind` 不合法 / 结构不对 → 无效（fail-safe：回到"按计划"）。
 */
export function overrideActive(override, now = 0) {
  if (!override || !WAKE_KINDS.includes(override.kind)) return false;
  const u = Number(override.until);
  return Number.isFinite(u) && u > Number(now);
}

/**
 * 状态文件的白名单形状 + 归一化。**纯函数**（读取由 `index.js` 做）。
 *
 * ⚠️ 这里**没有 `status`** —— 见文件头 ①。曾经写进去过的版本会让"上一次写入时的
 *    状态"决定今天，而那个值在重启/改文件之后必然是错的。
 * ✅ 但**有 `override`**：它是一个事件记录（"这一刻有人把它叫醒了，有效到 until"），
 *    判据是"now 跟一个绝对时刻比"，任何时刻重读都得到同一个答案 —— 与 status 是两件事。
 *    **它必须落盘**：主人凌晨三点把它叫起来，机器人四分钟后重启一次又睡回去，
 *    用户看到的是"我叫了它，它答应了一下又睡了"。
 * ⚠️ 版本不符 / 结构不对 → 整份丢弃（返回空态），**不猜**。
 * ⚠️ 过期的 override **不在这里丢** —— 丢弃要留痕（`settleOverrideOf` 干这件事）。
 *    在这里静默丢掉，就等于"叫醒过但日志里没有任何痕迹"。
 */
export function normalizeSleepState(raw) {
  const empty = { version: 1, cycleKey: '', lastTransition: null, override: null };
  if (!raw || typeof raw !== 'object') return empty;
  if (Number(raw.version) !== 1) return empty;
  const t = raw.lastTransition;
  const ok = t && typeof t === 'object'
    && (t.status === SLEEP_STATUS.awake || t.status === SLEEP_STATUS.asleep)
    && Number.isFinite(Number(t.at));
  const o = raw.override;
  const override = o && typeof o === 'object'
    && WAKE_KINDS.includes(o.kind)
    && Number.isFinite(Number(o.until)) && Number(o.until) > 0
    ? { kind: o.kind, until: Number(o.until), byUserId: String(o.byUserId ?? ''), at: Number(o.at) || 0 }
    : null;
  return {
    version: 1,
    cycleKey: String(raw.cycleKey ?? ''),
    lastTransition: ok
      ? { status: t.status, at: Number(t.at), cycleKey: String(t.cycleKey ?? '') }
      : null,
    override,
  };
}

/**
 * 算"这次要不要留痕"。**纯函数**。
 *
 * 留痕的判据是**状态变了**（或换了一夜）—— 每 30 秒 tick 都写一行日志的话，
 * 一晚上会刷出上千行，真正的信息（几点睡的、几点起的）反而淹掉了。
 *
 * @returns {{changed:boolean, next:object|null}}
 */
export function transitionOf({ state, status, plan, now = 0 } = {}) {
  const prev = state?.lastTransition || null;
  if (prev && prev.status === status && prev.cycleKey === plan?.cycleKey) return { changed: false, next: prev };
  return { changed: true, next: { status, at: now, cycleKey: String(plan?.cycleKey ?? '') } };
}

/**
 * ══════════════════════════════════════════════════════════════════════════
 *  Q11 · 入睡前自己说一句晚安（用户裁决②：做·她主动道晚安）
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 它补的是"到点就睡"最后那一格：**真人睡前会说一句**。到点突然不出声了，
 * 观感是"它掉线了"，不是"它睡了" —— 而那一句话正是这两者的分界。
 *
 * 三条边界（都是为了避免它变成骚扰）：
 *   ① **只在"跑着跑着自己睡着"时说**。进程启动时就已经在睡眠窗里（`prev` 为空）
 *      不算"它要睡了" —— 那句话说出来就是一句没头没尾的话，而且重启一次就多一句。
 *   ② **一夜最多一句**（`transitionOf` 的 `cycleKey` 已经保证了这一点：
 *      同一夜里状态不变就不再 `changed`，本判据**不另造第二道闸**）。
 *   ③ **只说给"最近跟它说过话的群"**。它没参与过的群里冒出一句晚安，
 *      那是广播，不是人。
 */

/**
 * 这一夜要不要自己说一句晚安。**纯函数**。
 *
 * @param {{prev?:object|null, status?:string, cycleKey?:string}} o
 * @returns {{say:boolean, reason:string}}
 */
export function goodnightOf({ prev = null, status = '', cycleKey = '' } = {}) {
  if (status !== SLEEP_STATUS.asleep) return { say: false, reason: '这次不是入睡' };
  if (!prev || prev.status !== SLEEP_STATUS.awake) {
    // 启动时已经在窗内（`prev` 为空）或本来就是睡着 → 都不是"它这一刻要睡了"。
    return { say: false, reason: '不是由醒转睡（启动时已在睡眠窗内不算）' };
  }
  return { say: true, reason: `由醒转睡（本夜 ${String(cycleKey || '').slice(0, 12)}）` };
}

/**
 * 那句晚安说给谁。**纯函数**。
 *
 * 判据只有一条：**最近一次跟它说过话的、且在放行名单里的群**。
 * 没有 → 返回 `null`（调用方应当**如实留痕**然后静默睡下，
 * 而不是挑一个它今天根本没说话的群去冒一句 —— 那是广播，不是人）。
 *
 * @param {{sessions?:Array<{key:string,scene:string,id:string|number,lastAt:number}>,
 *          allow?:Array<string|number>}} o
 * @returns {{key:string, scene:string, id:string|number}|null}
 */
export function goodnightTargetOf({ sessions = [], allow = [] } = {}) {
  const ok = new Set((allow || []).map((g) => String(g)).filter(Boolean));
  if (!ok.size) return null;
  let best = null;
  for (const s of sessions || []) {
    const id = String(s?.id ?? '');
    if (!id || !ok.has(id)) continue;
    const at = Number(s?.lastAt) || 0;
    if (at <= 0) continue; // 从没说过话的群不进候选（见上）
    if (!best || at > best.at) best = { key: String(s.key || ''), scene: String(s.scene || ''), id, at };
  }
  return best ? { key: best.key, scene: best.scene, id: best.id } : null;
}

/**
 * ══════════════════════════════════════════════════════════════════════════
 *  D31-2 · 两条叫醒路（M2 §4.5「形状对照，防混」）
 * ══════════════════════════════════════════════════════════════════════════
 *
 *   维度        | 正式叫醒（kind `owner`）           | 紧急唤醒（kind `emergency`）
 *   ------------|-----------------------------------|----------------------------------
 *   触发        | 主人**私聊**说到词；或主人在群里   | 主人**私聊**在 10 秒窗口内连发 3 条
 *               | **@ 它**并说到词                    |
 *   私聊延迟    | **先等过连发窗口再判**（见下）      | 第 3 条到达即触发，立刻生效
 *   时效        | 到本夜计划起床点（`plan.wakeAt`）  | 主人私聊安静 10 分钟即收尾
 *   收尾        | 交还给计划（那时它本来就该醒）      | 过起床点 → 转正式；没过 → 回去睡
 *
 * 为什么"私聊要等过窗口"（这是本步最容易写错的一处）：
 *   主人着急时会连发三条。如果第 1 条带词就立刻走"正式叫醒"（本夜不再睡），
 *   那第 3 条到达时"紧急"这条路已经被自己堵死了 —— 用户看到的是"我叫了三声，
 *   它倒是醒了，但一直醒到早上"，而它其实只想要一次临时清醒。
 *   → 所以：私聊**带词也不立刻醒**，先记账；窗口过后仍未连发满 → 才兑现正式叫醒。
 *
 * 复评点**零定时器**：窗口到期由**既有的 30 秒 tick** 复评，或主人在窗口后的
 *   任意一条消息到达时立刻复评（`wakePromotionOf`）。最坏情况是"只发一条关键词
 *   然后就不说话了" → 最多等一个 tick（≤30 秒）才醒 —— **已知边界**，
 *   与"为此新开一条定时器"（本项目明令禁止）之间选择了前者。
 */

/**
 * 连发计数。**纯函数**：同一个人、还在窗口内 → 计数 +1；否则开新窗口。
 *
 * @returns {{burst:{firstAt:number,count:number,byUserId:string}, fire:boolean}}
 */
function burstStep(burst, { now = 0, userId = '', windowMs = WAKE_BURST.windowMs } = {}) {
  const b = burst && typeof burst === 'object' ? burst : {};
  const uid = String(userId ?? '');
  const same = Number(b.firstAt) > 0 && String(b.byUserId ?? '') === uid
    && Number(now) - Number(b.firstAt) < windowMs;
  const next = same
    ? { firstAt: Number(b.firstAt), count: Number(b.count) + 1, byUserId: uid }
    : { firstAt: Number(now), count: 1, byUserId: uid };
  return { burst: next, fire: next.count >= WAKE_BURST.count };
}

/**
 * 一条**刚到达**的消息要不要把它叫醒。**纯函数**（`now` 入参，不碰 IO）。
 *
 * @param {{scene:string, userId:string|number, mentionedSelf:boolean, text:string,
 *          owners:string[], words:string[], burst:object, wakeAt:number, now:number}} o
 * @returns {{action:'none'|'hold'|'owner'|'emergency', reason:string,
 *            burst:object, pending:object|null, override:object|null}}
 *   · `none`      与叫醒无关（未配主人 / 不是主人 / 没说到词）
 *   · `owner`     正式叫醒 —— 主人**群 @** 且说到词（即时生效，没有连发这回事）
 *   · `hold`      主人**私聊**说到词，但还在连发窗口内 → 先记账，等窗口过（见上）
 *   · `emergency` 主人私聊在窗口内连发到第 N 条 → 紧急唤醒
 *
 * ⚠️ 未配主人时**整体关闭**（fail-closed）：「叫不醒」是配置没填，不是代码坏了。
 */
export function wakeTriggerOf({
  scene, userId, mentionedSelf, text, owners, words, burst, wakeAt = 0, now = 0,
} = {}) {
  const base = { action: 'none', reason: '', burst: burst || {}, pending: null, override: null };
  if (!Array.isArray(owners) || owners.length === 0) return { ...base, reason: '未配置主人（叫醒路整体关闭）' };
  if (!isOwner(userId, owners)) return { ...base, reason: '不是主人' };
  const word = wakeWordOf(text, words);

  if (scene !== 'private') {
    // 群里：**必须 @ 它**再说词。不 @ 就生效的话，群里任何人一句"起床"都能把它喊起来。
    if (!mentionedSelf) return { ...base, reason: '群里没 @ 它' };
    if (!word) return { ...base, reason: '没说到叫醒词' };
    const o = overrideOf({ kind: 'owner', until: wakeAt, byUserId: userId, now });
    if (!o) return { ...base, reason: '本夜计划起床点不可用（计划不生效）' };
    return { ...base, action: 'owner', reason: `群 @ + 「${word}」`, override: o };
  }

  const step = burstStep(burst, { now, userId });
  const out = { ...base, burst: step.burst };
  if (step.fire) {
    const o = overrideOf({ kind: 'emergency', until: Number(now) + EMERGENCY_QUIET_MS, byUserId: userId, now });
    return { ...out, action: 'emergency', reason: `私聊 ${WAKE_BURST.windowMs / 1000} 秒内连发 ${step.burst.count} 条`, override: o };
  }
  if (word) {
    return { ...out, action: 'hold', reason: `说到「${word}」，先等过连发窗口`, pending: { at: Number(now), byUserId: String(userId), word } };
  }
  return { ...out, reason: '没说到叫醒词' };
}

/**
 * 被 `hold` 住的正式叫醒，现在该兑现了吗。**纯函数**。
 *
 * 复评点有两个，都是既有的：30 秒 tick、以及主人后来的任意一条消息到达。
 * 零新定时器。
 */
export function wakePromotionOf({ pending, now = 0, wakeAt = 0 } = {}) {
  if (!pending || typeof pending !== 'object') return { promote: false, reason: '', override: null };
  if (Number(now) - Number(pending.at) < WAKE_BURST.windowMs) {
    return { promote: false, reason: '还在连发窗口内（先别醒，否则紧急会被误判成正式）', override: null };
  }
  const o = overrideOf({ kind: 'owner', until: wakeAt, byUserId: pending.byUserId, now });
  if (!o) return { promote: false, reason: '本夜计划起床点不可用（计划不生效）', override: null };
  return { promote: true, reason: '窗口过后仍未连发满，兑现正式叫醒', override: o };
}

/**
 * 起床补看一次最多回几个会话（**经验值**）。
 *
 * 为什么是 2：真人睡醒翻手机，顶多回一两个最要紧的，剩下的"看过了"就算了 ——
 * 把积压的十几条全回一遍，那是客服在清工单，不是人。
 */
export const CATCHUP_MAX = 2;

/**
 * 起床补看的挑选（**纯函数**，零模型调用）。
 *
 * 三条判据，缺一都会变成"不像人"：
 *   ① **只翻"本来就该回"的那几条**：会话里没有 @ 它、也没有主人发言 → 整个会话跳过。
 *      睡了一夜把群里所有闲话都回一遍，那是巡群机器人，不是人。
 *   ② **排序是确定的**（@ 条数 → 主人条数 → 最新一条的时刻 → key），
 *      **不掷骰**：同一份积压每次醒来得到同一批，这个行为才可被断言钉死。
 *   ③ **不提前造投影**：选谁由调用方喂进来的未读数组决定，本函数只排序取前 N。
 *
 * ⚠️ 挑谁**不用模型**（与外包方案 M2 的"挑消息用主模型"不同）：
 *    那一次调用是"睡着期间唯一的 token 出口"，而它换来的只是"挑哪两个" ——
 *    用三条客观排序就能定下来的事，不值得为它破掉"睡着期间零 token"这条更硬的保证。
 *    （要不要改成模型来挑，已登记为 **Q47** 待用户裁决。）
 *
 * @param {{sessions:Array<{key:string,scene:string,id:string|number,unread:Array<object>}>,
 *          owners?:string[], max?:number, skipKey?:string}} o
 * @returns {{picked:Array<object>, consumeByKey:Array<{key:string,ids:string[]}>, considered:number, skipped:number}}
 */
export function catchUpPlanOf({ sessions, owners = [], max = CATCHUP_MAX, skipKey = '' } = {}) {
  const scored = [];
  let skipped = 0;
  for (const s of sessions || []) {
    const list = Array.isArray(s?.unread) ? s.unread : [];
    if (!list.length) continue;
    if (skipKey && String(s.key) === String(skipKey)) { skipped += 1; continue; }
    const atCount = list.filter((x) => !!x?.mentionedSelf).length;
    const ownerCount = list.filter((x) => isOwner(x?.userId, owners)).length;
    if (atCount === 0 && ownerCount === 0) { skipped += 1; continue; }
    const latest = list[list.length - 1];
    scored.push({ s, atCount, ownerCount, latestAt: Number(latest?.at) || 0, latest });
  }
  scored.sort((a, b) => (b.atCount - a.atCount)
    || (b.ownerCount - a.ownerCount)
    || (b.latestAt - a.latestAt)
    || String(a.s.key).localeCompare(String(b.s.key)));

  const cap = Math.max(1, Number(max) || CATCHUP_MAX);
  const picked = [];
  const consumeByKey = [];
  for (const x of scored.slice(0, cap)) {
    const id = String(x.latest?.id || '');
    if (!id) continue; // 没有 message_id 的条目拿来回不了（引用不了原消息）
    picked.push({
      key: String(x.s.key),
      scene: String(x.s.scene || ''),
      id: x.s.id,
      messageId: id,
      userId: String(x.latest?.userId || ''),
      sender: String(x.latest?.sender || ''),
      text: String(x.latest?.text || ''),
    });
  }
  // 消费范围 = **所有被考虑过的会话**（含没挑中的）—— 挑中的要回，没挑中的算"看过了"。
  // ⚠️ 只消费快照里的 id：补看期间新到的那条**必然还在未读**（禁 markAllRead 的同一条理由）。
  for (const x of scored) {
    const ids = x.s.unread.map((e) => String(e?.id || '')).filter(Boolean);
    if (ids.length) consumeByKey.push({ key: String(x.s.key), ids });
  }
  return { picked, consumeByKey, considered: scored.length, skipped };
}

/**
 * 叫醒态的**收尾判定**。**纯函数**（`now` 入参）。
 *
 * 三种情形各一句话（这也是它必须集中在一处的原因 —— 散在 tick 与消息路径里必然漂）：
 *   · `owner` 且已到 `until` → 交还给计划（`until` 取的就是本夜起床点，那时计划本来就判醒）；
 *   · `emergency` 且已到 `until`：**已过计划起床点 → 转正式起床**（否则白天又睡回去，坑#9），
 *     没过 → 清掉（于是回到"按计划 = 继续睡"）。最小版收尾 = **静默回睡**，不发文案；
 *   · 其余 → 原样保留（**什么都不做**，包括没过期的叫醒态）。
 *
 * ⚠️ 过期的叫醒态**不在这里静默丢**：清掉要留一条痕（`changed` + `reason` 交给调用方写 journal）。
 *
 * @returns {{override:object|null, changed:boolean, reason:string}}
 */
export function settleOverrideOf({ override, wakeAt = 0, now = 0 } = {}) {
  const o = override;
  if (!o || !WAKE_KINDS.includes(o.kind)) {
    return { override: null, changed: !!o, reason: '' };
  }
  if (Number(o.until) > Number(now)) {
    // 还没到期。唯一会"提前变"的是紧急态碰到起床点 —— 那时它应当转成正式起床。
    if (o.kind === 'emergency' && Number(wakeAt) > 0 && Number(now) >= Number(wakeAt)) {
      return {
        override: overrideOf({ kind: 'owner', until: wakeAt, byUserId: o.byUserId, now }),
        changed: true,
        reason: '紧急唤醒收尾：已过计划起床点 → 转正式起床',
      };
    }
    return { override: o, changed: false, reason: '' };
  }
  if (o.kind === 'emergency' && Number(wakeAt) > 0 && Number(now) >= Number(wakeAt)) {
    return {
      override: overrideOf({ kind: 'owner', until: wakeAt, byUserId: o.byUserId, now }),
      changed: true,
      reason: '紧急唤醒收尾：安静够久了，且已过计划起床点 → 转正式起床',
    };
  }
  return {
    override: null,
    changed: true,
    reason: o.kind === 'emergency' ? '紧急唤醒收尾：安静够久了 → 回去睡' : '叫醒到期 → 交还给计划',
  };
}
