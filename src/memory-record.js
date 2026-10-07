/**
 * ══════════════════════════════════════════════════════════════════════
 *  记忆记录契约（ATI-3）—— 记忆从"一堆文字"变成"可追溯、有状态、受预算"的条目
 * ══════════════════════════════════════════════════════════════════════
 *  它解决的是「记忆的准入与去向」四件事：
 *    ① **记什么** —— kind 只有三类，越界的一律不收（见下）
 *    ② **谁说的** —— provenance：哪次会话、哪条消息、谁说的、被独立观察到几次
 *    ③ **能不能用** —— status：还没被复证的（candidate）**不进 system 提示**
 *    ④ **用多少**   —— 每次注入有字符预算，超了就截，并留下"截掉了什么"
 *
 *  ⚠️ 为什么 candidate 不进提示词：
 *     自动抽取是从**群友说的话**里来的，而群里任何人都能开一句玩笑。
 *     一被观察到就进提示词 = 让玩笑变成"它认定的事实"，且没有任何确认环节。
 *     所以：第一次观察到只落盘（candidate），**被独立复证**才转为可用（confirmed）。
 *     ⚠️ 这条同时意味着"读取 / 展示 / 它自己复述"**都不算复证** —— 只有新的独立观察才算。
 *
 *  ⚠️ **零依赖叶子**：不 import 任何模块（连 node: 内置都不引）。
 *     判据模块保持零依赖，才能被 smoke 直接喂反例（本项目的一贯做法）。
 */

/** 三类记忆。**风格/事实分界**体现在这里：只有"关于人的稳定倾向"才收，具体事实不收 */
const RECORD_KINDS = Object.freeze({
  person: '群友画像（偏好 / 禁忌 / 称呼 / 口头禅）',
  // ⚠️ 这两个的长文案刻意**带一个括号**：`kindShort` 取括号前那截当短名，
  //    而短名会进提示词（每行省 15+ 字符）。不带括号的话短名就是整句。
  topic: '话题（聊过什么、答应过什么还没做）',
  self: '她自己的事（经历与约定）',
});
const RECORD_KIND_IDS = Object.freeze(Object.keys(RECORD_KINDS));

/**
 * 状态：
 *   candidate  未复证（不注入）
 *   confirmed  可用（会进提示词）
 *   rejected   已否掉
 *   archived   已收起
 *   superseded **已被后来的观察推翻**（不再注入，但**不删** —— 保留"它曾经以为过什么"）
 *
 * 最后一个是第 13 轮加的。它回答的是"事实变了怎么办"：
 * 早先记下的事被后来的观察推翻时，旧的要**失效**，而不是继续注入、
 * 也不是靠被反复看到而越滚越巩固（真机实测：一条记反的记忆涨到 4 次复证、
 * 升成已确认，越错越难纠正）。
 */
export const RECORD_STATUS = Object.freeze(['candidate', 'confirmed', 'rejected', 'archived', 'superseded']);

/**
 * 状态的中文名。给页面用 —— 本项目的一贯做法是**中文名由判据模块给**，
 * 前端一个都不自存（抄两份必然漂移，已经因此踩过四次）。
 * 覆盖率由回归盯：`RECORD_STATUS` 的每一项都必须在这里有名字。
 */
export const RECORD_STATUS_LABELS = Object.freeze({
  candidate: '候选 · 还没复证',
  confirmed: '已确认 · 会进提示词',
  rejected: '已否掉 · 不再注入',
  archived: '已收起 · 不注入也不删',
  superseded: '已被后来的观察推翻 · 不再注入',
});

/**
 * 列表里用的**短名**。`RECORD_KINDS` 那几句是"给人读全的"，
 * 摊进列表行会挤掉正文 —— 所以切法在这里定一次，页面不做字符串手术
 * （手术散到两处，某天改了一处就会两边不一致）。
 */
export function kindShort(kind) {
  const full = RECORD_KINDS[kind] || String(kind ?? '');
  const cut = full.split('（')[0];
  return cut || full;
}

/** 被**独立**观察到几次才自动转可用（经验值） */
export const SAMPLES_TO_CONFIRM = 2;
/** 几次才算"稳定"（经验值）。到这一档半衰期延长，见 `halfLifeOf` */
export const SAMPLES_FOR_STABLE = 4;
/** 稳定档的半衰期倍数（经验值）：观察 4 次以上说明是真倾向，不该按一次性印象的速度淡出 */
export const STABLE_HALF_MULTIPLIER = 3;
/** 单条渲染后的字符上限（经验值） */
const LINE_MAX = 120;
/** 记忆段每次注入的总字符预算（经验值；超出即截，并留痕） */
export const PROMPT_BUDGET_CHARS = 700;
/** 各类的淡忘半衰期（毫秒）。话题会过期，人的偏好不会 */
export const HALF_LIFE_MS = Object.freeze({
  person: 30 * 24 * 3600 * 1000,
  topic: 7 * 24 * 3600 * 1000,
  self: 90 * 24 * 3600 * 1000,
});

/**
 * ────────────────────────────────────────────────────────────────────────
 *  主语：这条记忆是**关于谁的**（D-M1 · 记忆体检后修）
 * ────────────────────────────────────────────────────────────────────────
 *  ⚠️ 为什么必须与"发送者"分开存：
 *     体检（2026-10-04）在真机数据上抓到 **18/35 条**的正文主语是**机器人自己的
 *     名字**，而 `provenance.userId` 记的是**发消息的人**。两者被拼进同一行提示词，
 *     模型读到的是「<某群友的 QQ 号>：<关于别人的陈述>」—— 主语系统性错位，
 *     而且是"记得越多、错得越多"。
 *     修法：记忆存**主语**（`subjectId` / `subjectName`），发送者退化成纯溯源字段。
 *
 *  ⚠️ `subjectId` 是 **QQ 号**（稳定键）；`subjectName` 是**当时的显示名**（只作展示，
 *     改名后仍能看出当时叫什么）。这与 `auto-memory.jsonl` 里 `fromId`/`fromName`
 *     的分工是同一条纪律：**显示名不能当键**。
 */
export const SUBJECT_SELF = 'self';

/**
 * 由 QQ 号派生一个**短身份标签**，只给判官看（拼成 `【阿岚 #1234】`）。
 *
 * ⚠️ 它只是"这一轮 prompt 里的代词"，**不是存储键** —— 存的是完整 QQ 号。
 *    所以碰撞（同群后 4 位相同）只会让判官认错人一次，不会污染落盘数据；
 *    拼接方负责保证本轮内唯一（撞了就延长后缀，见 `memory.js` 的 `#judge`）。
 */
export function shortIdOf(userId, len = 4) {
  const s = String(userId ?? '').trim();
  if (!s) return '';
  return `#${s.slice(-Math.max(1, len))}`;
}

/**
 * 两条记录是不是**同一个主语**？只在"能不能当成同一条去复证"这一步用。
 *
 * fail-safe 方向：**拿不准就返回 false** —— 不合并只多出一条候选（它仍要被独立
 * 复证才可能进提示词），而合并错了会让错的那条 `samples +1`、越错越巩固。
 *   · 两边都有 subjectId → 相等才算同一个人；
 *   · 只有一边有 → **不算**（"明确是谁"与"不知道是谁"不能混成一条）；
 *   · 两边都没有（改造前的旧数据）→ 算（与既有行为逐字兼容，不让老记录集体失联）。
 */
export function subjectMatches(a, b) {
  const x = String(a?.provenance?.subjectId ?? '').trim();
  const y = String(b?.provenance?.subjectId ?? '').trim();
  if (x && y) return x === y;
  if (!x && !y) return true;
  return false;
}

/**
 * detail 里有没有**模型的推测**（"暗示 / 可能 / 推测…"）。
 *
 * 用途只有一个：渲染时把这类依据降级成"听他说"的口气，**不让它长得像实测事实**。
 * 判据是**确定性**的（词表命中），不调模型 —— 与参考规范里「推断不许混进事实层」
 * 是同一条纪律，但用最便宜的方式落地。
 */
const INFERRED_RE = /(暗示|可能|也许|大概|似乎|推测|估计|应该是|猜|感觉像)/;
export function looksInferred(text) {
  return INFERRED_RE.test(String(text ?? ''));
}

/**
 * 注入下限：激活度低于它就**不再进提示词**（D11a · 报告 E13）。
 *
 * ⚠️ **经验值**，不是官方阈值。取 0.25 的换算结果（按上面的半衰期）：
 *     `topic` 约 14 天 · `person` 约 60 天 · `self` 约 180 天没被再观察到 → 停止注入。
 *
 * ⚠️ 改造前 `activationOf` **只当排序键**（`selectForPrompt` 里那句 `y.a - x.a`）——
 *    也就是说淡忘**只影响先后，不影响去留**：只要预算装得下，三个月前的旧印象
 *    照样进提示词。报告 E13 的原话是「无时间衰减时三个月前的旧印象与昨天的同等权重，
 *    长期会『记性越来越怪』」——它说的正是这个缺口。
 *
 * ⚠️ 这是「**时间到权重渐隐**」，不是「时间到就删」：
 *     低于阈值的记录**一条都不动**（不删、不改状态），只是不再注入 ——
 *     想看随时能在面板里看到，人工 `confirm` 之后也照旧可用（见 `reviewRecord`）。
 */
export const ACTIVATION_FLOOR = 0.25;

/**
 * 每次注入的**条数**上限（D11a · 报告 E13「条数与字符上限」）。
 *
 * ⚠️ **经验值**。与 `PROMPT_BUDGET_CHARS` 并存、**谁先到算谁**：
 *     字符上限管"这一节多长"，条数上限管"别把一整节变成清单"——
 *     后者是"拟人"层面的：一屏十几条"你记得 XX"，模型会开始逐条应付。
 *     按 700 字符 / 每行约 55 字符算，字符上限本来就在 12 条上下先到；
 *     这个数字是给它兜底的（短行很多时才生效）。
 */
export const PROMPT_MAX_ITEMS = 12;

/**
 * 人工复核：**人是最终裁决者**，与"自动复证"是两条互不替代的路径。
 *
 *   · 自动复证（`mergeRecord`）：只认**新的独立观察**，累加 `samples`；
 *   · 人工复核（`reviewRecord`）：由人按下，直接改 `status` ——
 *     它**不是**新证据，所以**不碰 `samples`**。
 *     若在这里把 samples 加一，"我确认了一下"就会伪装成"又被独立观察到一次"，
 *     巩固度与注入排序一起被污染 —— 而那正是本模块开头那条"防自强化"要拦的事。
 *
 *  ⚠️ `restore` 是 reject / archive 的**唯一回退路**：
 *     `mergeRecord` 明文规定"被否过的不因再次观察到而复活"，`archived` 同理
 *     （人工定过的状态不再被自动复证改写）——
 *     没有 restore，一次误点就是永久损失。真正不可撤销的只有 `delete`。
 */
export const REVIEW_ACTIONS = Object.freeze({
  confirm: '认可：进提示词',
  reject: '否掉：永不注入（只有人能让它回来）',
  archive: '收起：不注入、也不删，随时可收回',
  restore: '收回人工判定：回到按独立证据推出的自然状态',
  delete: '删除：从文件里移除，不可撤销',
});
export const REVIEW_ACTION_IDS = Object.freeze(Object.keys(REVIEW_ACTIONS));

/** 人工动作 → 落状态。`restore` / `delete` 不在这张表里（一个回自然状态，一个把记录摘掉） */
const REVIEW_STATUS_OF = Object.freeze({ confirm: 'confirmed', reject: 'rejected', archive: 'archived' });

/** **会落盘**的人工动作。由上面那张表的键派生 —— 不另抄一份名单（抄了就一定会漂） */
const REVIEW_STORED = Object.freeze(Object.keys(REVIEW_STATUS_OF));

/**
 * 每种状态下**该显示哪些按钮**。也是判据（页面不许自己列）——
 * 放这里还有一个好处：它让"已确认的那条还给你一个「认可」按钮"这种
 * 说了等于没说的界面变不成。
 */
export const REVIEW_ACTIONS_FOR = Object.freeze({
  candidate: Object.freeze(['confirm', 'reject', 'delete']),
  confirmed: Object.freeze(['archive', 'reject', 'delete']),
  rejected: Object.freeze(['restore', 'confirm', 'delete']),
  archived: Object.freeze(['confirm', 'restore', 'delete']),
  // superseded **不给 confirm/settle 之类**：它已经被后来的观察推翻了，
  // 再点一次"认可"只是把矛盾重新请回提示词。想让它回来，只能先 `restore`
  // （那会把推翻它的那条一并收回 —— 见 memory.js 的 restoreSuperseded）。
  superseded: Object.freeze(['restore', 'delete']),
});

/**
 * 由**独立证据次数**推出的自然状态。**唯一实现** ——
 * `normalizeRecord` 的兜底与 `reviewRecord` 的 restore 都读它；
 * 两处各写一遍必然漂移（本项目在 `normalizeThinking` 上真踩过一次）。
 */
export function naturalStatusOf(record) {
  const s = Number(record?.samples);
  // ⚠️ 被推翻的**不会因再次看到而复活**。`restore` 只收回**人工**那一部分
  //    （它清的是 `review` 痕迹），而 `supersededBy` 是**事实** ——
  //    只要推翻它的那条还在，这条就得继续失效，否则一条已被推翻的记忆
  //    会绕个弯又爬回提示词，矛盾反而变成两条并存。
  if (record?.supersededBy) return 'superseded';
  return (Number.isFinite(s) ? s : 1) >= SAMPLES_TO_CONFIRM ? 'confirmed' : 'candidate';
}

const str = (v, max) => String(v ?? '').trim().slice(0, max);

/**
 * 归一化一条记录。非法项**直接丢弃**（宁缺勿烂）——
 * 一条写坏的记录会跟着它进提示词，比它不存在更糟。
 *
 * @returns {object|null}
 */
export function normalizeRecord(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const kind = RECORD_KIND_IDS.includes(raw.kind) ? raw.kind : null;
  if (!kind) return null;
  const text = str(raw.text, LINE_MAX);
  if (!text) return null;

  const p = raw.provenance && typeof raw.provenance === 'object' ? raw.provenance : {};
  const samples = Number.isFinite(raw.samples)
    ? Math.max(1, Math.round(raw.samples))
    : (Number.isFinite(p.samples) ? Math.max(1, Math.round(p.samples)) : 1);

  const firstSeenAt = Number(raw.firstSeenAt) || Number(p.firstSeenAt) || Date.now();
  const status = RECORD_STATUS.includes(raw.status)
    ? raw.status
    : naturalStatusOf({ samples, supersededBy: raw.supersededBy });

  return {
    id: str(raw.id, 40) || `r${firstSeenAt.toString(36)}`,
    kind,
    text,
    detail: str(raw.detail, 160),
    counter: str(raw.counter, 160),
    provenance: {
      chatKey: str(p.chatKey || raw.chatKey, 60),
      userId: str(p.userId || raw.userId, 24),
      messageId: str(p.messageId, 24),
      lastMessageId: str(p.lastMessageId || p.messageId, 24),
      // ── 主语（D-M1）────────────────────────────────────────────────────
      // 这条记忆是**关于谁**的：QQ 号 + 当时的显示名。
      // `subjectId === ''` 分两种：改造前的旧记录（不知道主语），或 kind=topic
      // 这种本来就不指向某个人的事 —— 两种在渲染上都不带"谁"的标签。
      // `SUBJECT_SELF` 表示"关于机器人自己"（渲染成她的名字，见 `recordLine`）。
      // ⚠️ 必须在这个白名单里显式列出：归一是白名单形状，漏一个字段就会在
      //    "读盘 → 归一 → 写回"之间被静默抹掉（本文件已有先例，见 review 那段）。
      subjectId: str(p.subjectId || raw.subjectId, 24),
      subjectName: str(p.subjectName || raw.subjectName, 40),
    },
    samples,
    status,
    // 被哪一条推翻了（空串 = 没有）。与 `review` **分开存放**是刻意的：
    // `review` 是人工痕迹（restore 会清掉），而这是**事实** ——
    // 只要它还指向一条还存在的记录，这条就得继续失效。
    supersededBy: str(raw.supersededBy, 40) || '',
    // 人工复核痕迹。**这里必须显式保留** —— 归一是白名单形状，
    // 任何没被列出来的字段都会在"读盘 → 归一 → 写回"之间被静默抹掉，
    // 表现是"面板上点过确认，下一次打开又变回候选"，而没有任何地方会报错。
    review: (raw.review && REVIEW_STORED.includes(raw.review.action))
      ? { action: raw.review.action, at: Number(raw.review.at) || 0 }
      : null,
    firstSeenAt,
    lastSeenAt: Number(raw.lastSeenAt) || firstSeenAt,
    updatedAt: Number(raw.updatedAt) || firstSeenAt,
  };
}

/**
 * 合并同一条记忆的新观察。**首次观察时间永不改写** ——
 * 整理/重写让一条旧记忆"变成刚发生"，是这类系统最典型的失真。
 */
export function mergeRecord(prev, next) {
  const a = normalizeRecord(prev);
  const b = normalizeRecord(next);
  if (!b) return a;
  if (!a) return b;
  return {
    ...b,
    id: a.id,
    // ① 关键：继承最早的观察时间
    firstSeenAt: Math.min(a.firstSeenAt, b.firstSeenAt),
    // ② 复证次数累加（**只有新观察才调它**；读取 / 展示 / 复述都不算）
    samples: a.samples + 1,
    // ③ 状态：**人工定过的一律不动**，自动复证只管"人没管过"的那些。
    //    旧行为（`a.status === 'rejected'` 不复活）被这一条完整包含 ——
    //    因为 `a.review` 只有人工复核才会产生，本字段存在之前**没有任何记录命中过新分支**，
    //    所以对既有数据是逐字兼容的。
    //    为什么 archive 也要冻结：人工收起的那条若被下一次观察自动放回来，
    //    用户会看到"我明明收起来了它还在说" —— 界面在说一件没发生的事（比不生效更糟）。
    status: a.review
      ? a.status
      : (a.status === 'rejected'
          ? 'rejected' // 被否过的不因再次观察到而复活（与人格材料那条纪律同形）
          : (a.samples + 1 >= SAMPLES_TO_CONFIRM ? 'confirmed' : 'candidate')),
    review: b.review || a.review,
    detail: b.detail || a.detail,
    counter: b.counter || a.counter,
    // ⚠️ 主语：新的那次观察优先（它的显示名更近），缺省回落到旧的。
    //    `subjectId` 不会因为回落而"换人" —— 落进这里的前提是
    //    `subjectMatches(a, b)` 已成立（见 `appendRecord`）。
    provenance: {
      ...a.provenance,
      lastMessageId: b.provenance.messageId || a.provenance.lastMessageId,
      subjectId: b.provenance.subjectId || a.provenance.subjectId,
      subjectName: b.provenance.subjectName || a.provenance.subjectName,
    },
  };
}

/**
 * ────────────────────────────────────────────────────────────────────────
 *  否定极性：两条字面很像的话，是不是**同一个方向**？
 * ────────────────────────────────────────────────────────────────────────
 *  ⚠️ 这是第 13 轮那次"机械启发式"**唯一被留下来的那一半**，用途换了：
 *     那次拿它去**主动判定矛盾并让旧记忆失效** —— 误报代价极高
 *     （把「喜欢追剧」和「不喜欢被叫臭肥鱼」判成了矛盾，误伤一条还有效的记忆）→ 已撤。
 *  本轮它只用来回答一个**窄得多**的问题：**这两条能不能当成同一条去复证？**
 *
 *  结论方向是 **fail-safe**：判定"方向可能相反"时**不合并**（只多出一条候选，
 *  它仍要被独立复证才可能进提示词），而不是把相反的记成"又被看到一次"。
 *
 *  ⚠️ 这个区别就是它能留下来的全部理由 ——
 *     真机实测过那条最贵的错误（2026-09-24）：「他喜欢加喵」被后续观察
 *     「他不喜欢加喵」判成了**同一条**，于是错的那条 `samples` +1、越错越巩固。
 *     相似度越高越容易撞上（两句只差一个"不"字），所以这一层必须站在相似度**之上**。
 *
 *  ⚠️ 已知边界（如实写，不夸大）：
 *     · 只认**否定词的有无**，不认反义词（"喜欢" vs "讨厌" 都是否定词缺失 → 判不出）；
 *     · 两条**都带**否定词时判不出（「不喜欢被叫臭肥鱼」vs「不吃香菜」）—— 那是
 *       相似度那一层的事，本函数**不假装**能解决它；
 *     · "不错" 这类词会被误判成否定极性，代价只是一次"没合并"，可接受。
 */
const NEGATION_RE = /(不|没|无|别|勿|禁止|拒绝|讨厌|忌|避|反感|受不了)/;

/** 一条正文是否带否定极性 */
function hasNegation(text) {
  return NEGATION_RE.test(String(text ?? ''));
}

/**
 * 两条正文的否定极性**相反**吗？（一条带否定、另一条不带）
 * @returns {boolean} true = 方向可能相反，**不该当成同一条去复证**
 */
export function oppositePolarity(a, b) {
  const x = hasNegation(a);
  const y = hasNegation(b);
  return x !== y;
}

/** 结构化记忆上限。**经验值**；与 `trimRecords` 同住一处，别在别处再写一遍 */
export const RECORDS_MAX = 300;

/**
 * 超上限时**淘汰谁**。纯函数：只排顺序，不碰 IO、不改输入。
 *
 * ⚠️ 为什么不能继续用 `slice(-n)`（留最近的一半）：
 *    失效 / 被否 / 已收起的那些**永远不进提示词**，却同样占着配额；
 *    按"最近"截会把**还在生效的老记忆**先挤掉 —— 越用越久、失效的越多，
 *    真正管用的反而先没。这是"失效记忆会积累"这条遗留的真缺陷部分。
 *
 * 淘汰顺序（**单向 fail-safe**：宁可留着失效的，也不先删生效的）：
 *   ① 失效类（superseded / rejected / archived）先走；
 *   ② 其余按 `lastSeenAt` 从旧到新。
 * 保留目标沿用折半（`max/2`）—— 与既有行为一致，避免每次追加都重写整份文件。
 *
 * @returns {{kept:object[], evicted:object[]}} `kept` **保持原顺序**
 */
export function trimRecords(items, { max = RECORDS_MAX } = {}) {
  const list = (items || []).filter(Boolean);
  if (list.length <= max) return { kept: list, evicted: [] };
  const target = Math.max(1, Math.round(max / 2));
  const dead = (r) => r.status === 'superseded' || r.status === 'rejected' || r.status === 'archived';
  const dropCount = list.length - target;
  const doomed = new Set(
    list
      .map((r, i) => ({ i, rank: dead(r) ? 0 : 1, last: Number(r.lastSeenAt) || 0 }))
      // 稳定排序：同档时旧的先走，再按原下标兜底（保证结果可复现）
      .sort((x, y) => x.rank - y.rank || x.last - y.last || x.i - y.i)
      .slice(0, dropCount)
      .map((o) => o.i)
  );
  return {
    kept: list.filter((_, i) => !doomed.has(i)),
    evicted: list.filter((_, i) => doomed.has(i)),
  };
}

/**
 * 对一条记录做一次人工复核。**纯函数**：返回一条新记录，不改原对象、不碰 IO。
 *
 * 为什么不在这里直接落盘：判定与落盘分开，这个模块才能继续当零依赖叶子，
 * "5 个动作 × 4 种起始状态"这张表也才能在 smoke 里被直接喂（本项目的一贯做法）。
 *
 * ⚠️ 删除**不返回记录**（`record: null`），由调用方从列表里摘掉 ——
 *    这样"摘掉"这一步的判据留在唯一那个落盘口，叶子只回答"这条该变成什么样"。
 *
 * @param {object} record
 * @param {string} action  `REVIEW_ACTION_IDS` 之一
 * @param {number} now     注入的时间（测试要能断言它落进了 review.at）
 * @returns {{ok:boolean, action?:string, record?:object|null, removed?:boolean, reason?:string}}
 */
export function reviewRecord(record, action, now = Date.now()) {
  const n = normalizeRecord(record);
  // 取不到一条合法记录就**什么都不做** —— 宁可让面板报"这条读不出来"，
  // 也不要拿一条残缺记录去覆盖磁盘上那条好的（归一化会把缺的字段按默认值补齐）。
  if (!n) return { ok: false, reason: 'record-invalid' };
  if (!REVIEW_ACTION_IDS.includes(action)) return { ok: false, reason: 'action-unknown' };
  if (action === 'delete') return { ok: true, action, record: null, removed: true };

  const restored = action === 'restore';
  return {
    ok: true,
    action,
    removed: false,
    record: {
      ...n,
      status: restored ? naturalStatusOf(n) : REVIEW_STATUS_OF[action],
      // `restore` 把人工痕迹清成 null —— 不清的话 `mergeRecord` 会继续冻着状态
      // （它判的是 `a.review` 有没有值），"收回人工判定"就变成一句空话。
      review: restored ? null : { action, at: Number(now) || Date.now() },
    },
  };
}

/**
 * 巩固程度：只看**独立证据的次数**，与"它被读过多少次"无关。
 * 这是防"自强化"的关键 —— 反复曝光不会让一条记忆变得更可信。
 */
export function consolidationOf(r) {
  const s = Number(r?.samples) || 0;
  if (s >= SAMPLES_FOR_STABLE) return 0.8;
  if (s >= SAMPLES_TO_CONFIRM) return 0.5;
  return 0.2;
}

/**
 * 这条记录的**实际半衰期**。
 *
 * ⚠️ 与 `HALF_LIFE_MS` 分开是刻意的：那张表按 kind 给**基准**，
 *    这一层再叠加"稳定档"（观察够多次 → 淡得慢）。
 *    为什么必须叠加：体检（2026-10-04）发现一个"长期记忆真的留不住"的隐患 ——
 *    半衰期只按 kind 算时，一条被独立复证 6 次的偏好和一条只见过 1 次的印象
 *    **以同样的速度淡出**，60 天后一起停止注入。观察次数越多、越该留得久，
 *    否则"长期记忆"只是碰巧被反复提到的东西。
 *
 * 缺半衰期时返回 0（= 不淡忘），不做凭空猜测。
 */
export function halfLifeOf(record) {
  const base = HALF_LIFE_MS[record?.kind];
  if (!base) return 0;
  return (Number(record?.samples) || 0) >= SAMPLES_FOR_STABLE ? base * STABLE_HALF_MULTIPLIER : base;
}

/**
 * 淡忘（激活度）：半衰衰减，只影响"还提不提"，**不表示它变假了**。
 * 缺 lastSeenAt 或半衰期时返回 1（不淡忘），不做凭空猜测。
 */
export function activationOf(r, now = Date.now()) {
  const last = Number(r?.lastSeenAt) || 0;
  const half = halfLifeOf(r);
  if (!last || !half) return 1;
  const dt = Math.max(0, now - last);
  return Math.pow(2, -dt / half);
}

/**
 * 渲染成提示词里的一行。
 *
 * 三处与改造前不同，每一处都有真机证据（2026-10-04 体检）：
 *   ① **用短类名**（`kindShort`，如"群友画像"）而不是 `RECORD_KINDS` 那句全称 ——
 *      全称 23 字符，700 字符的预算里每行白扔约 3%；
 *   ② **不写数字 QQ 号**。旧行是 `<某人号>：群主最严厉的主人…`（号码原样写在报告里，此处不再复述），模型读到的
 *      是"这个号码的人如何如何"，而号码（发送者）与正文里的名字根本不是同一个人；
 *   ③ **主语取自 `provenance.subject*`**，不再用 `userId`。旧记录没有主语 →
 *      不带标签，正文原样给（它自己就带着名字，比硬安一个错的人好）。
 */
function recordLine(r) {
  const n = normalizeRecord(r);
  if (!n) return '';
  const who = n.provenance.subjectName || '';
  // 推测降级：依据里出现"暗示 / 可能 / 推测"时加前缀，别让它长得像实测事实。
  const tail = n.detail ? `（${looksInferred(n.detail) ? '听他说：' : ''}${n.detail}）` : '';
  return `- [${kindShort(n.kind)}]${who ? ` ${who}` : ''}：${n.text}${tail}`.slice(0, LINE_MAX);
}

/**
 * 这句话是不是在**要它回忆**？（D-M3 的触发判据）
 *
 * 触发才去检索 —— 每一轮都全量捞一遍是纯浪费（而且会把无关旧事塞进提示词）。
 * 判据是**确定性**的词表命中，零模型调用：想回忆就问得出来，
 * 而"问法千变万化"这件事交给下面的词表兜，不交给模型猜。
 *
 * ⚠️ 词表可以按真机表现增补；**宁可多触发**（多几行本地检索结果），
 *    也不要漏触发（那等于"它又装不记得了"，正是这一条要修的病）。
 */
const RECALL_RE = /(还记得|记不记得|记不记的|你记得|你记不|之前说|上次说|上回说|以前说|我跟你说过|和你说过|说过的|提到过的)/;
export function wantsRecall(text) {
  return RECALL_RE.test(String(text ?? ''));
}

/**
 * 一次回忆最多带几条。**经验值** —— 问一句就铺一屏"我记得 XX"是它在背清单，不是人在回忆。
 * 与注入预算（700 字符 / 12 条）的关系：这两条是**各自独立**的池子
 * （回忆是"被问到才出现"的一次性补充，不占常驻记忆的预算）。
 */
export const RECALL_MAX = 3;

/**
 * ────────────────────────────────────────────────────────────────────────
 *  本地检索（D-M3 · 把"你还记得吗"变成能答的问题）
 * ────────────────────────────────────────────────────────────────────────
 *  改造前记忆**只有一条出路**：被动地按会话注入那几条。用户问"你还记得上次
 *  说的那事吗"，机器人答不上 —— 不是因为它没记，而是因为没有任何通路能把
 *  那条找出来（参考体系里对应 R 维度："找不到的记忆等于不存在"）。
 *
 *  ⚠️ 这一层**不调模型、不落盘、不改状态**：纯函数，只回答"按这个问法能捞出哪几条"。
 *     所以它能被 smoke 直接喂反例，也不会让"检索"变成一条隐形的写路径。
 *
 *  ⚠️ 检索**不算复证**：捞出来看一眼、甚至说给用户听，都不是"新的独立观察"。
 *     `samples` 一条都不加（与"展示不算复证"是同一条纪律）。
 *
 *  打分（可解释，`why` 就是命中的字段名）：
 *    · 主语名命中 3 分（问"阿岚"最该出阿岚的事）
 *    · 正文命中 2 分
 *    · 依据命中 1 分
 *    排序：分数 → 巩固度 → 激活度（与注入排序同一套权重，不另立一套）。
 *
 * @param {object[]} items 全量记录（调用方给，本函数不读盘）
 * @param {string} query 用户那句话（或关键词）
 * @param {{chatKey?:string, now?:number, limit?:number, includeDead?:boolean}} opts
 *   · `chatKey` 给了就只在**这个会话**里找（与注入的隔离口径一致）；
 *   · `includeDead` 默认 false —— **失效类**（被推翻 / 否掉 / 收起）不进结果。
 *     ⚠️ 它**不排除候选态**：候选是"还没被复证"，可以当线索说出口（渲染带标记）；
 *        失效类是"已经判定不成立"，说出去就是造事实 —— 两者不能混为一谈。
 * @returns {{hits:object[], scanned:number, reason?:string}}
 */
export function searchRecords(items, query, opts = {}) {
  const q = String(query ?? '').trim();
  if (!q) return { hits: [], scanned: 0, reason: 'empty-query' };
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const limit = Number.isFinite(opts.limit) ? Math.max(1, opts.limit) : 5;
  const chatKey = String(opts.chatKey ?? '').trim();

  // 拆词：中文不切词，按 2 字及以上的连续片段 + 整句一起匹配。
  // 用**包含**而不是相等：用户问"还记得臭肥鱼吗"，正文是"不喜欢被叫臭肥鱼"，
  // 只判相等会一条都捞不出来。
  const terms = new Set();
  for (const m of q.match(/[\u4e00-\u9fa5A-Za-z0-9]+/g) || []) {
    if (m.length >= 2) terms.add(m);
    // 长句再切 2 字滑窗，让"臭肥鱼吗"也能命中"臭肥鱼"
    for (let i = 0; i + 2 <= m.length; i += 1) terms.add(m.slice(i, i + 2));
  }
  if (!terms.size) return { hits: [], scanned: 0, reason: 'no-terms' };

  const hits = [];
  let scanned = 0;
  for (const raw of items || []) {
    const n = normalizeRecord(raw);
    if (!n) continue;
    scanned += 1;
    if (chatKey && n.provenance.chatKey !== chatKey) continue;
    if (!opts.includeDead && n.status !== 'confirmed' && n.status !== 'candidate') continue;
    let score = 0;
    const why = [];
    for (const t of terms) {
      if (n.provenance.subjectName && n.provenance.subjectName.includes(t)) { score += 3; why.push('主语'); break; }
    }
    for (const t of terms) {
      if (n.text.includes(t)) { score += 2; why.push('正文'); break; }
    }
    for (const t of terms) {
      if (n.detail && n.detail.includes(t)) { score += 1; why.push('依据'); break; }
    }
    if (score <= 0) continue;
    // 候选态排在可用态之后：它还没被复证，只能当线索、不能当事实。
    if (n.status === 'candidate') score -= 0.5;
    hits.push({ record: n, score, why: [...new Set(why)].join('+') });
  }

  hits.sort((x, y) =>
    y.score - x.score ||
    consolidationOf(y.record) - consolidationOf(x.record) ||
    activationOf(y.record, now) - activationOf(x.record, now) ||
    (y.record.lastSeenAt || 0) - (x.record.lastSeenAt || 0));

  return { hits: hits.slice(0, limit), scanned };
}

/**
 * 把检索结果渲染成注入用的一行（`searchRecords` 的配套）。
 *
 * 与 `recordLine` 的区别只有一个：**带"这是想起来的"口气**，并且明确排在
 * "你现在记得的事"之外 —— 检索到的东西不该被当成常驻事实，它只是"被问到了，翻出来看看"。
 */
export function renderRecalled(hits, { max = 3 } = {}) {
  const lines = (hits || []).slice(0, max).map((h) => {
    const r = h.record;
    // 主语名只在"确实知道是谁"时有值（`resolveSubject` 对 `self` 填的就是机器人名，
    // 认不出的号留空）—— 所以这里不需要再判一次 `subjectId`。
    const who = r.provenance.subjectName || '';
    const mark = r.status === 'candidate' ? '（还没复证）' : '';
    return `- ${who ? `${who}：` : ''}${r.text}${mark}`;
  });
  return lines;
}

/**
 * 选这一轮要注入的记录。**纯函数**：范围 → 状态 → 淡忘 → 排序 → 预算。
 *
 * 顺序是刻意的（先门控，再排序，最后分预算）：
 *   先砍掉不该看的（范围 / 状态 / 淡忘），再决定看哪些，最后才看放不放得下。
 *   反过来做会出现"预算被不该看的东西占满"。
 *
 * ⚠️ **四道门控与两种"没进去"要分开记账**（D11a）：
 *   · `droppedStale` —— 被**淡忘**挡下的（还在盘上、只是不再提）；
 *   · `droppedBudget` —— 门控都过了、只是**装不下 / 超条数**的。
 *   混成一个 `dropped` 的话，"它怎么突然不提那件事了"会被归因到预算，
 *   而真因是那条已经淡出阈值 —— 这两种处置完全不同（一个该调预算，一个本就不该提）。
 *
 * @param {object[]} records
 * @param {{chatKey?:string, userId?:string, now?:number, budgetChars?:number,
 *          maxItems?:number, activationFloor?:number}} opts
 * @returns {{lines:string[], picked:object[], dropped:number, droppedStale:number,
 *           droppedBudget:number, budgetChars:number, maxItems:number}}
 */
export function selectForPrompt(records, opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const budget = Number.isFinite(opts.budgetChars) ? opts.budgetChars : PROMPT_BUDGET_CHARS;
  const maxItems = Number.isFinite(opts.maxItems) ? opts.maxItems : PROMPT_MAX_ITEMS;
  const floor = Number.isFinite(opts.activationFloor) ? opts.activationFloor : ACTIVATION_FLOOR;
  const chatKey = String(opts.chatKey ?? '').trim();
  const userId = String(opts.userId ?? '').trim();

  // ①②③ 门控一次走完：范围（按会话隔离）→ 状态（未复证一律不进）→ 淡忘（低于阈值不进）
  const kept = [];
  let droppedStale = 0;
  for (const r of records || []) {
    const n = normalizeRecord(r);
    if (!n) continue;
    if (n.status !== 'confirmed') continue;
    if (chatKey && n.provenance.chatKey !== chatKey) continue;
    // ⚠️ 缺 lastSeenAt / 半衰期时 `activationOf` 回 1（不淡忘）—— 于是这里**不会**误拦
    //    （宁可多带一条，也不要因为"记录不完整"把有效记忆静默丢掉）。
    if (activationOf(n, now) < floor) { droppedStale += 1; continue; }
    kept.push(n);
  }

  // ④ 排序：本人优先 → 巩固度 → 激活度 → 最近
  const scored = kept
    .map((r) => ({
      r,
      me: userId && r.provenance.userId === userId ? 1 : 0,
      c: consolidationOf(r),
      a: activationOf(r, now),
    }))
    .sort((x, y) =>
      y.me - x.me || y.c - x.c || y.a - x.a || y.r.lastSeenAt - x.r.lastSeenAt);

  // ⑤ 预算：**条数与字符谁先到算谁**；装不下就留痕，不静默丢
  const lines = [];
  const picked = [];
  let used = 0;
  let droppedBudget = 0;
  for (const it of scored) {
    const line = recordLine(it.r);
    if (!line) continue;
    if (picked.length >= maxItems || used + line.length + 1 > budget) {
      droppedBudget += 1;
      continue;
    }
    lines.push(line);
    picked.push(it.r);
    used += line.length + 1;
  }
  return {
    lines,
    picked,
    dropped: droppedStale + droppedBudget,
    droppedStale,
    droppedBudget,
    budgetChars: budget,
    maxItems,
  };
}
