/**
 * ══════════════════════════════════════════════════════════════════════
 *  「自定义工作台」的配置：结构、默认值、校验 —— 全项目唯一真相源
 * ══════════════════════════════════════════════════════════════════════
 *  为什么单独开一个模块而不是各写各的：
 *    这份配置有**两个写入方**（控制台的 /api/custom）和**两个读取方**
 *    （src/config.js 组装机器人配置、panel/server.js 下发给面板渲染）。
 *    如果默认值在面板里写一份、在机器人里再写一份，加一个字段就要改两处，
 *    漏一处就是「面板上填了、机器人压根没读」—— 这类 bug 不报错、只是没效果，
 *    是最难查的一类。所以两边都 import 这里。
 *
 *  ⚠️ 面板是**零构建单文件 HTML**，不能 import。它只从 /api/state 拿服务端
 *     序列化好的 custom，并在提交时按同一份字段名回写。字段名改动要同时改
 *     panel/index.html 里的 WB_* 常量（那边有对应的注释锚点）。
 */
import { createHash } from 'node:crypto';
// 数值类设置的默认值与上下限（第 42 轮 B12b · SCHEMA-LITE）。
// 这张表是零依赖叶子模块，所以 `config.js` 与 `custom-config.js` 都能 import 它，
// 不会形成循环。**这里不许再把那些数字抄一遍** —— 抄了就等于本批白做。
import { numDefault, numBounds, numOr } from './field-schema.js';
// 扩展包（第 44 轮 B12d · EX-PLUGIN）的两个常量。
// 与上面同理：上限数字与「什么算合法 id」都由**拥有它的模块** export，这里 import 使用，
// 不在两处各写一遍。`plugin-manifest.js` 是零依赖叶子，import 它不会成环。
import { isValidPluginId, PLUGIN_MAX } from './plugin-manifest.js';
// 浏览锁定（D15 · 报告 E11 ②）。同样是"默认值与归一化只有一处"：
// 那份判据叶子 export 了默认值与 `readBrowseLock`，这里 import 使用 ——
// 不在这里再写一遍 `{enabled:false, hosts:[]}`（写了就是第二份会漂的真相）。
import { BROWSE_LOCK_DEFAULTS, readBrowseLock } from './browse-lock.js';
// D31-1 · 睡眠的**判据层**（计划解析 / 状态重算 / 读写归一化）。默认值也从这里 import ——
// 与 browseLock 同款：配置面不许再手写一份真相。
import { SLEEP_DEFAULTS, readSleep } from './sleep.js';
// D23-2 · 合并转发展开：默认值与归一化也在拥有那份判据的叶子里（同 browseLock / sleep）。
import { FORWARD_DEFAULTS, readForward } from './forward-expand.js';
// D18 · 跨会话发言：同上 —— 默认值与归一化都在拥有那份判据的叶子里。
import { CROSS_DEFAULTS, readCrossSend } from './cross-send.js';
// 提醒的"哪天算工作日"表（D17）。归一化归它（`normalizeHolidays` 拥有"什么算合法登记"的判据），
// 闭集合 `REMINDER_ON` 也归 `reminder.js` —— 这里只取用，不自己再写一份名单。
import { parseIsoDay, normalizeHolidays } from './holidays.js';
import { REMINDER_ON } from './reminder.js';

/** 昵称等纯文本字段的长度上限，防止有人把整篇文章贴进来把提示词撑爆 */
const TEXT_MAX = 300;
/**
 * 「叙述型」字段的上限。人设里"核心欲望 / 行为逻辑 / 当前状态"这类天生就是要写一段话的，
 * 300 字根本不够（一个像样的角色卡光"行为逻辑"就要两三百字）。
 * 但不能无限：这些字段每轮都要进 system 提示词，撑爆了模型会开始忽略别的部分。
 */
const TEXT_LONG = 1200;
/** 记忆条目数上限：条数一多，提示词里那一节会盖过人格本身 */
const MEMORY_MAX = 60;
/** 技能条数上限。技能是"按需注入"的，但同时命中的可能不止一条，所以上限要压住 */
const SKILL_MAX = 20;
/** 单条技能的背景文本上限 */
const SKILL_BG_MAX = 1500;
/**
 * 人格的字段名，顺序就是提示词里的呈现顺序。
 * 放在这里是为了让「人设归一化」和「角色卡快照」共用同一份列表 ——
 * 两处各写一份列表，加字段时漏一处就是这个项目反复踩过的坑。
 * 前 7 个是短字段（一句话能说完），后 5 个是叙述型（天生要写一段）。
 */
export const PERSONA_KEYS = ['age', 'role', 'world', 'traits', 'tone', 'catch', 'faces', 'desire', 'fear', 'logic', 'attitude', 'status'];
const PERSONA_LONG_KEYS = ['desire', 'fear', 'logic', 'attitude', 'status'];

/**
 * ══════════════════════════════════════════════════════════════════════
 *  「增强项」—— 需求文档 §1 的【增强 12 项（可选）：让 AI 演得更像人】
 * ══════════════════════════════════════════════════════════════════════
 *  和 PERSONA_KEYS 是**两层**而不是一层，理由是它们的定位不同：
 *    · 人格 12 字段＝"这个人是谁"，必填心智负担低，填两三句就能用；
 *    · 增强 12 项＝"演得更像人的细节"，写起来累、但写好了效果差距最大。
 *  上一层是骨架，这一层是血肉 —— 所以界面上分成两个分区。
 *
 *  **"可选、非必填"是靠"留空就不进提示词"实现的**，不是靠 12 个复选框：
 *  填了就该生效，再加一个"填了却关着"的开关只会多一层坑。
 *
 *  `label` 同时被三处用：提示词里的小标题、面板上的字段名、导出文档的条目名。
 *  三处共用一份，就不可能出现"面板上叫这个、提示词里叫那个"。
 *
 *  `group` 是面板上的分组（4 组），让 12 个框不至于排成一堵墙。
 */
export const ENHANCE = {
  values: {
    group: '他怎么想', label: '价值观排序', hint: '什么排前面', ph: '自由 > 家人 > 正义；或者任务 > 自己 > 感情',
  },
  decide: {
    group: '他怎么想', label: '决策算法', hint: '先观察还是先动手', ph: '先看对方情绪，再决定是逗他还是安静陪着',
  },
  stress: {
    group: '他怎么想', label: '压力反应', hint: '战斗 / 逃跑 / 僵住 / 讨好 / 讽刺 / 沉默', ph: '先吐槽两句，再认真帮忙；嘴上说不管，实际偷偷管',
  },
  emotion: {
    group: '他怎么想', label: '情绪触发', hint: '被夸 / 被质疑 / 被背叛 / 被示好时分别什么反应',
    ph: '被夸：「哼，我知道啦」（其实很开心）；被质疑：会突然安静，然后说「随便你」',
  },
  habits: {
    group: '他怎么表现', label: '习惯小动作', hint: '写成文字的小动作', ph: '说话带「哼」、会发颜文字、说狠话后补一句软话',
  },
  speech: {
    group: '他怎么表现', label: '语言指纹', hint: '常用词、骂人方式、幽默感、称呼变化', ph: '爱用「我跟你讲」「不是吧」；幽默靠自嘲，不靠谐音梗',
  },
  lines: {
    group: '他怎么表现', label: '示例台词', hint: '2–3 句他真正会说的话（最能锁定语气）', textarea: true,
    ph: '「喂喂喂，你今天怎么这么安静？是不是又偷偷难过不告诉我？」\n「哼，我才不是特意来问你的，我只是刚好路过。」',
  },
  secrets: {
    group: '他知道什么', label: '秘密与信息差', hint: '他知道什么、不知道什么、误以为什么',
    ph: '他知道群里很多梗；不知道老王最近在闹分手；误以为小李只是懒',
  },
  limits: {
    group: '他知道什么', label: '底线与禁忌', hint: '绝不会做什么、什么情况下会破例',
    ph: '不拿别人的家人开玩笑；但如果对方先骂人，他会破例怼回去',
  },
  relation: {
    group: '他会怎么变', label: '关系变化条件', hint: '做什么会从防备变信任，或从好感变敌意',
    ph: '多回应他几次 → 变黏人；冷落他 → 先闹，再安静，最后主动找',
  },
  growth: {
    group: '他会怎么变', label: '成长 / 堕落条件', hint: '什么事件会让他改变', ph: '被当众拆穿一次之后会收敛，不再乱开玩笑',
  },
  meters: {
    group: '他会怎么变', label: '状态值', hint: '信任度 / 情绪值 / 目标队列', ph: '信任 20/100（戒备）；情绪 60/100；目标：找个话题把人拉出来聊天',
  },
};
export const ENHANCE_KEYS = Object.keys(ENHANCE);
/** 面板上的分组顺序（就是 ENHANCE 里 group 的出现顺序，去重） */
export const ENHANCE_GROUPS = [...new Set(ENHANCE_KEYS.map((k) => ENHANCE[k].group))];
/**
 * 短的增强项（一句话能说完）。其余按"叙述型"放宽到 1200 字 ——
 * 「情绪触发」「示例台词」这种天生就是要写一段的，300 字根本不够。
 */
const ENHANCE_SHORT_KEYS = ['values', 'habits', 'speech', 'meters'];

/**
 * ══════════════════════════════════════════════════════════════════════
 *  AI 扮演规则 —— 需求文档里标着「必须写进去，底层逻辑」的那 10 条
 * ══════════════════════════════════════════════════════════════════════
 *  第 31 轮之前这里**一条都没有**（全项目搜「不跳出角色」零命中）。
 *  它不是"人设的一部分"，而是"扮演这件事本身的规矩"：
 *  前 5 条管住边界（不越权、不编造、有惯性），后 5 条管住手感（别总结、别全知、
 *  关系要渐进）。少了它们，模型最常见的毛病正好就是这几条 ——
 *  替用户说话、一本正经地总结全文、一回合从陌生变生死之交。
 *
 * ⚠️⚠️ 2026-10-02：12 → 10 条。用户点名要保留 8 条，**本轮只删了 2 条**
 *    （`mayRefuse` / `notOmniscient`，理由见各自行内注释）。
 *    被删的原话留在行注释里 —— 「当初为什么在」本身是有价值的信息：
 *    哪天机器人又犯某个毛病，翻回去就知道该加回什么。
 *
 * ⏸️ **用户想删但本轮没删，等他观察真实表现后再定**（两条都别当成"忘了"）：
 *    · noAuto「不替用户决定、行动、感受或说话」
 *      防的是「替用户说话」—— 模型最常见的崩坏。风险是真的。
 *      ⇒ 若真发生（机器人替群友做决定 / 表态），把下面 noAuto 那行注释放回去。
 *    · noSpam「主动找话题可以，但不刷屏、不抢话」
 *      防的是**主动发言**那条链（`allowProactive`）刷屏；
 *      它与 `allAges` 一样标了 `safety: true`（界面上单列、提示用户别关）。
 *      删了它之后，主动发言的频次上限就只剩代码里的那一道。
 *
 *  标了 `safety: true` 的两条（全年龄 / 不碰政治）属于边界，和 `safety` 分区
 *  的那几个开关是一类东西，所以在界面上单列出来提示用户别关。
 *
 *  为什么写成常量而不是让用户逐条编辑：这是"底层逻辑"，逐条可编辑反而更容易
 *  把规则改到互相矛盾（比如把 noAuto 关掉，模型就会开始替用户说话）。
 *  界面给的是一个总开关 + 一份只读清单。要做逐条编辑的话得先解决冲突检测。
 */
export const PLAY_RULES = [
  { id: 'inCharacter', text: '始终以角色身份说话和行动，不跳出角色。' },
  { id: 'noAuto', text: '不替用户决定、行动、感受或说话。' },
  { id: 'noInvent', text: '不知道的信息不编造，可以怀疑、猜测、沉默。' },
  { id: 'inertia', text: '情绪和关系有惯性，不无缘无故好感或敌意。' },
  // ← 原 mayRefuse 已删（2026-10-02 · 用户点名）：「可以拒绝、误解、隐瞒、嘴硬，不必永远配合」
  //    删它是**要"允许顶嘴"这个手感**，不是遗漏。它与 noAuto（不替用户说话）方向相反：
  //    两者同时在时模型取交集 ⇒ 角色过分顺从。想加回：把下面这行注释去掉即可。
  { id: 'consistent', text: '保持称呼、口癖、底线一致。' },
  { id: 'advance', text: '每次回复推进一点互动，不要总结全文。' },
  { id: 'ooc', text: '需要出戏时，只响应 OOC: 开头的消息。' },
  // ← 原 notOmniscient 已删（2026-10-02 · 用户点名）：「不轻易全知，不读心，不预知剧情」
  //    noInvent（不编造信息）已覆盖"不知道就不编"；"不读心 / 不预知剧情"
  //    是更强的约束，模型在群聊里用不上那么多。
  { id: 'gradual', text: '关系变化要有过程，不能一回合从敌人变恋人。' },
  { id: 'allAges', text: '全年龄向，不碰政治、不碰低俗。', safety: true },
  { id: 'noSpam', text: '主动找话题可以，但不刷屏、不抢话。', safety: true },
];
/** 一轮里最多注入几条技能 —— 再多就会盖过人格本身，理由同自动记忆只放 12 条 */
export const SKILL_IN_PROMPT = 3;
/** 注入提示词的技能背景总字数上限（所有命中技能加起来） */
export const SKILL_CHARS_IN_PROMPT = 2000;

/**
 * 一轮里最多注入几条**手动记忆**。
 *
 * 手动记忆原先被当成"用户明确要求必须记住的事"，于是无条件全量注入、一条闸都没有。
 * 而它每条上限 500 字、最多 60 条 → 光这一节理论上就能到 **3 万字**，
 * 是整份 system 提示词里最大的一个口子（固定部分合计约 5.6 万字符）。
 * 后果不只是费钱：这一节比人格本身还长，小模型会被它带跑偏。
 *
 * 取 12 与「自动记忆只放 12 条」对齐，理由一致：**记忆是背景，不是主角**。
 * 超出部分不是被删掉，只是**不进这一轮的提示词**（数据仍在，面板上能看能改），
 * 所以面板必须把这个上限写明，免得用户以为"我填了却不生效"。
 */
export const MANUAL_MEMORY_IN_PROMPT = 12;

/**
 * QQ 内置表情的常用档 —— 机器人**可以发**的那一批（id → 人看的名字）。
 *
 * ⚠️ 消费者**只有一处**：工作台的「下载表情 ID 表」（`panel/server.js` 拿它拼清单）。
 *    ⚠️ 2026-10-01 清理轮更正：这里原先写着"机器人要把它写进提示词（教模型怎么插表情）"，
 *       那句已经**不再成立** —— 第 14 轮定案「表情不由模型自己插」之后，
 *       `brain.js` 的提示词里只留一句"不要自己写 [face:ID]"（见其 9. 条），
 *       由 `face-habit` 那道确定性闸统一决定。同批删掉了配它的 `facePresetPhrase()`
 *       （那句拼装函数全仓 0 调用，是那次改动的遗留）。
 *    ⚠️ 但**别顺手把这个表删掉**：`src/index.js` 把它下发给面板（`presets:`），
 *       而 `face-habit.pickFace()` 的 `presets` 入参就是它 —— 删了它表情就没得挑了。
 */
export const FACE_PRESETS = [
  [14, '微笑'], [1, '呲牙'], [5, '流泪'], [13, '惊讶'], [4, '得意'],
  [124, '狗头'], [178, '尴尬'], [182, '亲亲'], [22, '憨笑'], [32, '大兵'],
  [28, '流汗'], [33, '鼓掌'], [58, '抓狂'], [76, '赞'], [103, '别烦我'],
];

export const REPLY_LENGTHS = {
  short: { label: '短', hint: '每条尽量 15 字以内，像随手打的' },
  normal: { label: '中等', hint: '每条 20–40 字' },
  long: { label: '长', hint: '可以到 60 字，把话说完整一点' },
};

/**
 * 「特殊场景」预置场景。
 * 键名就是 config 里的字段名，面板按这个表渲染列表 —— 加场景只改这一处。
 *
 * `ph` 是输入框的示例文案。放在这里而不是前端：前端原来是**自己抄了一份表**
 * （含这些示例文字），于是加一个场景要改两处，两份迟早漂移。
 * 现在后端通过 /api/state 的 customMeta.scenes 下发，前端只渲染、不自存。
 *
 * ⚠️ 这里只放**提示词级**的场景 —— 也就是模型自己判断得了的。
 *    「连续追问 / 重复问题 / 刷屏」这类需要**运行时信号**（频率统计、相似度比对）
 *    才判得准，光写进提示词等于没做，所以不放进来。要做得先补运行时判定。
 */
export const SCENES = {
  insulted: {
    label: '被骂 / 被怼',
    hint: '有人在群里骂你、阴阳你时怎么回',
    ph: '例如：不还嘴，阴阳一句就走',
  },
  silent: {
    label: '冷场',
    hint: '话题断了、没人接话的时候怎么起个话头',
    ph: '例如：自己找个话题抛出来，别硬接上面那句',
  },
  lateNight: {
    label: '深夜',
    hint: '凌晨时段的说话风格',
    ph: '例如：话少一点，催人早点睡',
  },
  newMember: {
    label: '新人入群',
    hint: '有人刚进群时怎么打招呼',
    ph: '例如：欢迎一句就行，别追着问',
  },
  searchFail: {
    label: '搜不到结果',
    hint: '联网查了但没查到东西时怎么说',
    ph: '例如：直说没查到，别编',
  },
  visionFail: {
    label: '识图失败',
    hint: '看不懂这张图、识别失败时怎么接',
    ph: '例如：说自己看不清楚，让对方文字描述',
  },
  webFail: {
    label: '联网查询失败',
    hint: '联网报错时怎么圆场',
    ph: '例如：别暴露报错信息，直接答别的',
  },
  typo: {
    label: '错别字 / 看不懂的缩写',
    hint: '群友打错字、用了你不认识的网络缩写时怎么办',
    ph: '例如：按上下文猜一句，猜不准就直接问"你说的 xx 是啥意思"',
  },
  complaint: {
    label: '投诉 / 表达不满',
    hint: '有人对你不满、说你答得不好时怎么处理',
    ph: '例如：先认下来别辩解，问一句他希望你怎么改',
  },
};

/** config.json 里 `custom` 段的完整默认值 */
const CUSTOM_DEFAULTS = {
  version: 2,
  /**
   * 人格：说话时额外叠加在一 persona 文件之上的「日常人设」。
   *
   * 字段按需求文档的「主选项」摊开。为什么拆这么多而不是一个自由文本框：
   * 拆开之后每一项都能给一句"该怎么填"的提示，小白照着填就能用；
   * 一个两三千字的空文本框，绝大多数人第一反应是关掉。
   *
   * ⚠️ 姓名（昵称）不在这里 —— 它住在 config.personaName，
   *    与「机器人设置」共用同一个值。同一个东西存两份必然漂移。
   */
  persona: {
    age: '',        // 年龄
    role: '',       // 身份（职业 / 在群里的角色）
    world: '',      // 时代 / 世界观（现实都市 / 仙侠 / 赛博朋克…）
    desire: '',     // 核心欲望：他最想要什么
    fear: '',       // 核心恐惧 / 弱点：最怕什么、什么会让他失控
    traits: '',     // 性格关键词
    tone: '',       // 说话方式：语气、称呼、句子长短、口头禅
    logic: '',      // 行为逻辑：遇事怎么决定、压力下怎么反应、底线是什么
    attitude: '',   // 对用户的初始态度：亲近 / 防备 / 服从 / 敌对 / 试探
    status: '',     // 当前状态：现在在哪、想做什么、情绪如何（用户可随时手改）
    catch: '',      // 口头禅
    faces: '',      // 爱用的表情
  },
  /**
   * 增强 12 项（可选）。留空 = 不进提示词 —— 这就是需求文档说的"非必填"，
   * 不需要再加 12 个复选框（填了就该生效，多一层开关只会多一个坑）。
   */
  enhance: Object.fromEntries(ENHANCE_KEYS.map((k) => [k, ''])),
  /**
   * 人设一改，是否把会话历史里**机器人自己说过的话**丢掉。
   *
   * 为什么需要这个开关：Brain.update(cfg) 只换配置引用，会话历史是原样保留的。
   * 于是改完人设之后，模型在提示词里看到自己前几轮用**旧口吻**说的话，
   * 会继续照着那个口吻说 —— 表现出来就是"改了人设但好像没变"，
   * 而且它会一直持续到那 12 轮历史被自然挤出去为止。
   * 默认开：宁可丢掉一点上下文连贯，也不能让人设更新看起来失效。
   */
  personaResetOnChange: true,
  /**
   * 是否把「AI 扮演规则」那 12 条写进提示词。默认开。
   * 关掉只影响"扮演的规矩"，不动人设本身 —— 所以它是独立开关，不是 personas 的一部分。
   */
  playRules: true,
  /**
   * 技能注册表（运行时注册，不是编译期常量）。
   *
   * 一个技能 = 一段背景 + 命中条件 + 生效范围。两种 kind：
   *   persona —— 一整套人格（角色卡），通常 scope 是 global，用来"换一个机器人"
   *   pack    —— 一个知识包（星座 / 冷笑话 / 某个游戏的攻略），靠 triggers 命中才注入
   *
   * 为什么要有这一层：以前「特殊场景」这种表是写死在代码里的常量，加一项要改
   * 后端表 + 前端表 + 导出文案三处。技能是可增长的东西，写死迟早腐烂。
   */
  skills: [],
  /**
   * 扩展包白名单（第 44 轮 B12d · EX-PLUGIN）。
   *
   * ⚠️ 为什么是**白名单**而不是"目录里有就加载"：
   *   规格（v2 §4）原意是纯目录扫描。但本项目既有先例是显式登记
   *   （`allow.groups`、上面那个 `skills` 都是"登记了才生效"），而 `plugins/`
   *   里将来放的是**会被执行的代码**。在一台每天在真实 QQ 群里说话的机器上，
   *   "丢个文件进目录就被执行"这条隐式路径不能存在。
   *   第 44 轮由用户裁决，见报告「偏差」。
   *
   * 元素是扩展包的 **id**（英文，即清单里的 `id`）—— 不是目录名。
   * 目录名可以是中文（`复读拦截`），加载器以 id（`echo-guard`）为准。
   *
   * ⚠️ 本轮只做识别 / 校验 / 报告，**不执行**这里列出的任何一条。
   */
  /**
   * `settings`：用户在面板上改的**各包设置**（第 55 轮）。形状 `{ [包 id]: { 键: 值 } }`。
   * 清单默认值仍在包自己的 `plugin.json` / `skill.json` 里 ——
   * 两份**不是**同一件事（一个是"包自带的默认"，一个是"这个人填的"），
   * 合成一份会让"升级包之后新键从哪来"说不清。
   */
  plugins: { enabled: [], settings: {} },
  /**
   * 浏览锁定（D15 · 报告 E11 ②）—— 抓取**范围**：只允许去名单内的站点。
   *
   * 它是 `src/browse-lock.js` 那道判据的配置面。两个字段：
   *   · `enabled` —— 开关。**默认关**：一开就会把已启用的联网技能（百科 / B 站 /
   *     额度情报）的可达范围砍到名单之内，那是**行为面变化**，得有人明确点头
   *     （与 D12b「参数化 + 可观测，总闸不开」同款）。
   *   · `hosts`   —— 允许的主机名，**子域自动包含**（`example.com` 命中 `a.b.example.com`）。
   *     可以先写成整条地址（`https://zh.wikipedia.org/api/rest_v1`），归一化时只取主机名。
   *
   * ⚠️ 默认值从 `browse-lock.js` import（`BROWSE_LOCK_DEFAULTS`）——
   *    这里**不许**再手写一份，两份真相必然漂。
   * ⚠️ 它**只在走 `api.fetch` 的扩展包上生效**：真实联网技能目前用的是裸 `global fetch`
   *    （见台账 Q26a），本开关管不到它们 —— 这件事必须如实写在这里，不能让人以为"开了就全覆盖"。
   */
  browseLock: { ...BROWSE_LOCK_DEFAULTS, hosts: [] },
  /**
   * 睡眠 / 作息（D31-1）。三个字段：
   *   · `enabled` —— 开关。**默认 false**（与 browseLock 同款理由）：睡着意味着
   *     **半夜不回话**，那是行为面变更，不该由一次提交替用户决定。
   *   · `bed` / `wake` —— 入睡与起床时刻（`HH:MM` 本地时间，跨零点也支持）。
   * ⚠️ 本步**不加面板写控件**（按 E23 先例：没有控件就不硬声明）；要开是改这里 + 重启机器人。
   * ⚠️ 运行时状态（今天睡过没有）**不进 config** —— 落 `data/sleep-state.json`（`src/` 独写）。
   */
  sleep: { ...SLEEP_DEFAULTS },
  /**
   * 合并转发展开（D23-2 · Wave 5）—— 别人转发了一段聊天记录给它，它看不看得见。
   *
   * 一个字段：`enabled` —— **默认 true**（与 browseLock / sleep 的"默认 false"方向相反）。
   * 理由：关掉它 = 它继续只能看见 `[合并转发]` 四个字，而这**正是 D23-2 要修的那个缺陷**
   * （真机实证：用户 @ 它发了一条合并转发，它回「我看不见转发的具体内容」）。
   * 打开它**不改变触发判据** —— 展开的内容只进 `text`（给人/模型看），不进 `bareText`
   * （触发判定看的那一份），见 `onebot.flattenMessage` 的 forward 分支。
   *
   * ⚠️ 默认值从 `forward-expand.js` import，这里**不许**再手写一份（同 browseLock / sleep）。
   * ⚠️ 本步**不加面板写控件**（按 E23 先例：没有控件就不硬声明）；要关是改这里 + 重启机器人。
   */
  forwardExpand: { ...FORWARD_DEFAULTS },
  /**
   * 跨会话发言（D18 · 报告 E8）—— 它能不能**去别的群**说一句话。
   *
   * 一个字段：`enabled` —— **默认 false**。理由与 browseLock / sleep 同向：
   * 它是"它主动跑去一个你不一定盯着的群开口"，属**行为面变更**；
   * 而且它**不是修缺陷**（不像 D23-2 的 forwardExpand 那样关着就等于缺陷还在）。
   *
   * 打开之后，模型会多拿到两个工具（`get_chats` / `send_to`）——
   * **它们只在开闸时才注册**，关着时注册表为空、请求体与不装工具时逐字节相同。
   * 出口仍然是 `sayToGroup`（出口闸门 / 分句 / 节奏都在那儿），
   * 目标也仍然只能在 `allow.groups` 名单里 —— 见 `src/cross-send.js` 的文件头。
   *
   * ⚠️ 默认值从 `cross-send.js` import，这里**不许**再手写一份（同 browseLock / sleep）。
   * ⚠️ 本步**不加面板写控件**（按 E23 先例）；**改它要重启机器人**才生效（注册在启动时定）。
   */
  crossSend: { ...CROSS_DEFAULTS },
  /** 回复方式 */
  replyStyle: {
    // short / normal / long
    length: 'normal',
    // 群里回话时有没有 @ 上说话的人
    mentionAt: false,
    // 连续回复的最小间隔（秒）。0 = 用底层防抖（它的数值在 src/field-schema.js）
    cooldownSec: numDefault('cooldownSec'),
    /**
     * true ＝ 允许把一句话拆成几条发（像真人连着打字）
     * false ＝ 不管模型怎么拆，都合并成一条长消息
     * 底层实现是 reply.maxChunks = 1，不另立一套发送逻辑。
     */
    multiMessage: true,
  },
  /**
   * 触发方式的**补充**部分。
   * 「必须 @」和「随机插话概率」不在这里 —— 那两个住在 config.trigger 里，
   * 与「机器人设置」共用同一份值（两处 UI 镜像同一个字段，不做第二份）。
   */
  trigger: {
    // 命中任一词就回（空数组 = 不启用）
    keywords: [],
    // 定时主动开新话题：到点自己抛一句。间隔的默认值与上下限在 src/field-schema.js
    proactive: { enabled: false, intervalMin: numDefault('proactiveIntervalMin'), text: '' },
    // 定时消息：[{ id, at:'HH:MM', text, enabled }]
    scheduled: [],
    /**
     * 免打扰时段：这个区间内**不主动开口**（插话、定时主动、定时消息全都不发）。
     * 以前这段是硬编码在 src/index.js 里的 23:00–08:00，界面上只能写"这条是写死的"。
     * from === to 表示不启用静默（可以全天主动说话）。
     */
    quietHours: { from: numDefault('quietFrom'), to: numDefault('quietTo') },
  },
  /**
   * 主动发言总闸。
   * 和 trigger.interjectChance 不是一回事：那个是「随机插话的概率」，
   * 这个是「允不允许它自己开口」——关掉之后，插话、定时主动、定时消息**全部**不发声。
   * 对应需求里「遇到特殊情况时可自主打开或关闭主动发言」。
   */
  allowProactive: true,
  /** 特殊场景 -> 追加的行为规则。空字符串 = 不干预 */
  scenes: Object.fromEntries(Object.keys(SCENES).map((k) => [k, ''])),
  /**
   * 自我记忆。
   *  manual —— 用户手填，**永远常驻**，不受 auto 开关影响。
   *                   存在 config.json 里（它是用户资产，不能被程序顺手清掉）。
   *  auto   —— 机器人自己判断记下来的条目。**故意不放在 config.json 里**：
   *                   那段记录是机器人进程高频追加写的，而 config.json 还要被
   *                   控制台整份重写，两个写入方抢同一个文件迟早互相覆盖。
   *                   所以自动记忆单独存 panel/auto-memory.jsonl（见 src/memory.js），
   *                   谁写谁读各有一个明确的归属。这里只留一个开关。
   */
  memory: { auto: false, manual: [] },
  /** 安全设置 */
  safety: { banned: [], antiFlood: false, filterLinks: false },
};

/** 只做已知键的深合并，不认识的键原样带过去（不丢用户已有数据） */
function mergeDeep(base, over) {
  const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);
  if (!isObj(over)) return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = isObj(v) && isObj(base[k]) ? mergeDeep(base[k], v) : v;
  }
  return out;
}

const str = (v, max = TEXT_MAX) => String(v ?? '').slice(0, max);
const bool = (v) => v === true;
const num = (v, def, min, max) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
};

/** 记忆条目：统一形状，非法项直接丢弃（宁缺勿烂） */
function memoryItems(v, limit = MEMORY_MAX) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const it of v) {
    if (!it) continue;
    const text = str(it.text, 500).trim();
    if (!text) continue;
    out.push({
      id: str(it.id, 40) || `m${Date.now().toString(36)}${out.length}`,
      text,
      // 手动条目用 on 开关；自动条目没有 on（要停就整段关掉自动记录）
      ...(it.on === undefined ? {} : { on: it.on !== false }),
      t: Number(it.t) || Date.now(),
      ...(it.score === undefined ? {} : { score: num(it.score, 0.5, 0, 1) }),
      ...(it.from === undefined ? {} : { from: str(it.from, 40) }),
    });
    if (out.length >= limit) break;
  }
  return out;
}

/** 定时消息：时:分 + 内容 */
function scheduledItems(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const it of v) {
    if (!it) continue;
    const at = str(it.at, 5);
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(at)) continue; // 时间格式不对的直接丢
    const text = str(it.text, 500).trim();
    if (!text) continue;
    // ══ D17 的另外两个维度：日期（只在那天发一次）与频次（工作日 / 休息日）══
    //
    // ⚠️ 2026-10-02 修：这两个字段此前**不在这张白名单里**，于是被静默剥掉，整条链
    //    表现为"看起来能用"的死路：
    //      · 面板上照旧渲染 date / on 两个控件（`14-script.html` 的 wbRenderSched），填了也在页面上；
    //      · `patchCustom` → `readCustom` → 这里剥掉 → 存进 config.json 的没有这两格；
    //      · 机器人侧 `matchesOn(s.on, kind)`：`REMINDER_ON.includes(undefined)` 为假
    //        → 回落 `'any'` → **恒真**；`dueMsOf(entry)` 读不到 `date` → 用今天 → 退化成每天。
    //      · 而回归全绿 —— 因为 D17 的用例把 `dueMsOf({at,date})` / `matchesOn('workday',…)`
    //        当**纯函数直接喂字段**，没有一条走"经 readCustom 一遍"的路径。
    //    这就是本项目那条纪律的又一次现身：**"断言存在" ≠ "断言接线"**。
    //    修法只有一处（就是这里），并且契约 §46 已升级成"往返之后仍在"。
    //
    // 认不出的日期**留空**而不是回落成某个默认值：留空 = "每天"（`dueMsOf` 对空串的语义），
    // 而写错的日期如果被静默当成每天，用户会以为"我限定了那一天"——`dueMsOf` 那边对
    // "填了却认不出"是返回 `null`（不做每天），这里与它同一取向：宁可回空串。
    const date = parseIsoDay(str(it.date, 10).trim()) ? str(it.date, 10).trim() : '';
    const on = REMINDER_ON.includes(it.on) ? it.on : 'any';
    out.push({
      id: str(it.id, 40) || `s${out.length}`, at, text, enabled: it.enabled !== false, date, on,
    });
  }
  return out.slice(0, 20);
}

/** 人格：短字段守 TEXT_MAX，叙述型字段用 TEXT_LONG */
function personaFields(v) {
  const src = v && typeof v === 'object' ? v : {};
  return Object.fromEntries(
    PERSONA_KEYS.map((k) => [k, str(src[k], PERSONA_LONG_KEYS.includes(k) ? TEXT_LONG : TEXT_MAX)])
  );
}

/** 增强 12 项的归一化。短的那几个按 300 卡，叙述型的按 1200 卡。 */
function enhanceFields(v) {
  const src = v && typeof v === 'object' ? v : {};
  return Object.fromEntries(
    ENHANCE_KEYS.map((k) => [k, str(src[k], ENHANCE_SHORT_KEYS.includes(k) ? TEXT_MAX : TEXT_LONG)])
  );
}

/**
 * 角色卡里存的那份"人格快照"＝ 人格 12 字段 + 增强 12 项。
 *
 * 为什么增强项也要跟着卡走：角色卡的意义是"一键换人"。
 * 只存骨架、不存血肉的话，套用一张卡换回来的只是个半成品 ——
 * 用户会发现"语气对了但细节全没了"，然后只能手工再补一遍。
 */
function cardFields(v) {
  return { ...personaFields(v), ...enhanceFields(v) };
}

/**
 * 技能条目归一化。
 * 非法项直接丢弃（宁缺勿烂）—— 一条写坏的技能如果留着，会在每一轮提示词里
 * 塞一段垃圾，比它不存在更糟，而且很难联想到是它干的。
 */
function skillItems(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const it of v) {
    if (!it) continue;
    const background = str(it.background, SKILL_BG_MAX).trim();
    const name = str(it.name, 40).trim();
    // 角色卡即使没写背景，只要存过人格快照也算有内容；知识包则必须有背景
    const hasFields = it.kind === 'persona' && Object.values(it.fields || {}).some((x) => String(x || '').trim());
    if (!background && !name && !hasFields) continue; // 连名字和内容都没有的，纯占位
    const scopeType = ['global', 'group', 'user'].includes(it.scope?.type) ? it.scope.type : 'global';
    out.push({
      id: str(it.id, 40) || `k${out.length}${Date.now().toString(36)}`,
      // persona = 一整套人格（角色卡）；pack = 一个知识包
      kind: it.kind === 'persona' ? 'persona' : 'pack',
      name: name || '(未命名技能)',
      enabled: it.enabled !== false,
      scope: {
        type: scopeType,
        // global 不带 id；group / user 必须带，否则这条技能永远匹配不到任何会话
        id: scopeType === 'global' ? '' : str(it.scope?.id, 40).trim(),
      },
      triggers: (Array.isArray(it.triggers) ? it.triggers : [])
        .map((s) => str(s, 40).trim()).filter(Boolean).slice(0, 20),
      background,
      examples: (Array.isArray(it.examples) ? it.examples : [])
        .map((s) => str(s, 200).trim()).filter(Boolean).slice(0, 5),
      // 角色卡额外带一份人格快照 —— 有了它「存多张卡、一键换人」才成立。
      // 知识包不带这个字段：它只提供背景知识，不换人。
      ...(it.kind === 'persona' ? { fields: cardFields(it.fields) } : {}),
    });
    if (out.length >= SKILL_MAX) break;
  }
  return out;
}

/**
 * 扩展包白名单归一化：只留**合法英文 id**，去重，压到上限（第 44 轮 B12d · EX-PLUGIN）。
 *
 * ⚠️ 「什么算合法 id」的判据**不在这里**，来自 `src/plugin-manifest.js` 的
 *    `isValidPluginId()`。清单侧与白名单侧必须用同一条正则，各写一遍必然漂移 ——
 *    而漂移的表现是"清单能正常加载、白名单却怎么填都匹配不上"：不报错、只是没效果。
 *
 * 非法项**静默丢弃**（与 `skillItems` 的"宁缺勿烂"同一取舍）：
 * 一条写错的白名单项留着，只会让人以为"我明明启用了它，却没生效"。
 */
function pluginIds(v) {
  const list = Array.isArray(v) ? v : [];
  const out = [];
  const seen = new Set();
  for (const it of list) {
    if (typeof it !== 'string') continue;
    const s = it.trim();
    if (!s || seen.has(s) || !isValidPluginId(s)) continue;
    seen.add(s);
    out.push(s);
    if (out.length >= PLUGIN_MAX) break;
  }
  return out;
}

/**
 * 扩展包的**用户设置**（第 55 轮）。形状 `{ [包 id]: { 键: 值 } }`。
 *
 * ⚠️ 只归到"是对象"这一层，**不逐键校验**：设置项的形状只有包自己知道
 *    （`cookie` 是字符串、`keepDays` 是数字、`sources` 是数组），宿主猜必然猜错。
 *    宿主的责任止于"它确实是一个对象"，其余交给包自己去兜。
 *
 * ⚠️ **包被卸载 / 改名后它的设置会被丢掉**：留着的话这份配置会长出一批
 *    永远读不到的键（"写了没人读"是本项目明令要清的那一类）。
 *    ⚠️ 但它**只**在归一化时被丢 —— 用户没保存过就不会碰到，且丢的是"读不到的东西"。
 *
 * @param {object} v
 * @param {string[]} enabled 当前启用的 id（去掉没启用的那些的设置）
 */
function pluginSettings(v, enabled = []) {
  const src = v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  const on = new Set(enabled);
  const out = {};
  for (const [k, val] of Object.entries(src)) {
    const id = String(k ?? '').trim();
    if (!id || !isValidPluginId(id) || !on.has(id)) continue;
    if (!val || typeof val !== 'object' || Array.isArray(val)) continue;
    out[id] = { ...val };
  }
  return out;
}

/** `custom.plugins` 的**唯一归一化口**（白名单 + 各包设置）。 */
function pluginFields(v) {
  const enabled = pluginIds(v?.enabled);
  return { enabled, settings: pluginSettings(v?.settings, enabled) };
}

/** 免打扰时段：整数小时。**区间与默认值都取自 src/field-schema.js**，这里不写第二份数字。
 *  from === to 表示不启用静默 */
function quietHours(v) {
  const [lo, hi] = numBounds('quietFrom');
  const hour = (x, def) => {
    const n = Number.parseInt(x, 10);
    return Number.isFinite(n) && n >= lo && n <= hi ? n : def;
  };
  return { from: hour(v?.from, numDefault('quietFrom')), to: hour(v?.to, numDefault('quietTo')) };
}

/**
 * 把 config.json 里的 `custom` 段归一化成完整可用的结构。
 * 任何缺失/非法字段都回落到默认值 —— 老的 config.json 不做迁移也能跑。
 */
export function readCustom(raw) {
  const c = mergeDeep(CUSTOM_DEFAULTS, raw?.custom);

  const length = Object.keys(REPLY_LENGTHS).includes(c.replyStyle.length) ? c.replyStyle.length : 'normal';

  return {
    version: num(c.version, 2, 1, 99),
    persona: personaFields(c.persona),
    enhance: enhanceFields(c.enhance),
    personaResetOnChange: c.personaResetOnChange !== false,
    playRules: c.playRules !== false,
    skills: skillItems(c.skills),
    // 扩展包白名单（EX-PLUGIN）。**只有这里有值，别处不许再解析一遍** ——
    // 消费方 `src/plugin-host.js` 的 `loadExtensions({enabled})` 直接吃这个数组。
    // `settings` 依赖 `enabled` 的结果（没启用的包不留设置）—— 所以先算出 enabled，
    // 一个变量只承担一个用途（第 49 轮那条纪律）。
    plugins: pluginFields(c.plugins),
    replyStyle: {
      length,
      mentionAt: bool(c.replyStyle.mentionAt),
      cooldownSec: numOr('cooldownSec', c.replyStyle.cooldownSec),
      multiMessage: c.replyStyle.multiMessage !== false,
    },
    trigger: {
      keywords: (Array.isArray(c.trigger.keywords) ? c.trigger.keywords : [])
        .map((s) => str(s, 40).trim()).filter(Boolean).slice(0, 50),
      proactive: {
        enabled: bool(c.trigger.proactive.enabled),
        intervalMin: numOr('proactiveIntervalMin', c.trigger.proactive.intervalMin),
        text: str(c.trigger.proactive.text, 500),
      },
      scheduled: scheduledItems(c.trigger.scheduled),
      quietHours: quietHours(c.trigger.quietHours),
    },
    allowProactive: c.allowProactive !== false,
    // 浏览锁定（D15 · E11 ②）：归一化交给拥有它那份判据的模块（`readBrowseLock`），
    // 这里只负责"从 c 里取出来喂给它"——归一化规则不许有两份。
    browseLock: readBrowseLock(c.browseLock),
    // 睡眠（D31-1）：归一化交给拥有那份判据的模块（`readSleep`），这里只负责取出来喂给它。
    sleep: readSleep(c.sleep),
    // 合并转发展开（D23-2）：同上 —— 归一化归 `readForward`，这里只负责取出来。
    forwardExpand: readForward(c.forwardExpand),
    // 跨会话发言（D18）：同上 —— 归一化归 `readCrossSend`，这里只负责取出来。
    crossSend: readCrossSend(c.crossSend),
    scenes: Object.fromEntries(Object.keys(SCENES).map((k) => [k, str(c.scenes[k], 500)])),
    // ══ 节假日表（D17）══
    //
    // ⚠️ 2026-10-02 修：这一格此前**不在返回对象里**。而这个函数是"白名单投影" ——
    //    没列出来的键一律被丢掉。面板保存走 `cfg.custom = patchCustom(cfg.custom, body.custom)`
    //    （整份替换），于是**任何一次面板保存都会把用户手改的节假日表从 config.json 里抹掉**，
    //    而机器人侧的 `normalizeHolidays(c.holidays)` 从此拿到空表 → 只能按星期几兜底。
    //
    //    最值得记的一点：前端 `14-script.html` 的 `wbCollect` **确实带上了 `holidays`**，
    //    注释还写着"不带的话保存一次就会清空" —— 那句话是对的，但**补救写在了白名单错的一侧**，
    //    所以它从来没有生效过。契约 §46 当时只盯到"面板有没有带上"，没盯"经归一化之后还在不在"。
    //
    //    归一化归 `holidays.js`（它拥有"什么算合法登记"的判据），这里只取出来喂给它 ——
    //    与 browseLock / sleep / forwardExpand / crossSend 同一条纪律。
    holidays: normalizeHolidays(c.holidays),
    memory: {
      auto: bool(c.memory.auto),
      manual: memoryItems(c.memory.manual),
    },
    safety: {
      banned: (Array.isArray(c.safety.banned) ? c.safety.banned : [])
        .map((s) => str(s, 40).trim()).filter(Boolean).slice(0, 200),
      antiFlood: bool(c.safety.antiFlood),
      filterLinks: bool(c.safety.filterLinks),
    },
  };
}

/**
 * 在已有 custom 之上打一个补丁，再整份归一化。
 *
 * 为什么不直接 `readCustom({custom: body.custom})`：那是**从默认值开始**合并的，
 * 前端只提交一块（比如只改安全设置）时，其余七块会被冲回默认值。
 * 表现是"我只动了敏感词，人格怎么没了"—— 而且是静默的。
 */
export function patchCustom(existing, patch) {
  return readCustom({ custom: mergeDeep(existing || {}, patch || {}) });
}

/**
 * 这一轮真正要注入提示词的手动记忆（开着的，且**最多 MANUAL_MEMORY_IN_PROMPT 条**）。
 *
 * 封顶放在这里而不是调用方：全项目只有 brain.memoryInPrompt() 一个消费者，
 * 而面板列清单读的是 `custom.memory.manual` 本身 —— 所以在这里截断
 * **不会让任何一条记忆从界面上消失**，只影响"进不进这一轮提示词"。
 */
export function activeManualMemory(custom) {
  return (custom?.memory?.manual || [])
    .filter((m) => m.on !== false)
    .slice(0, MANUAL_MEMORY_IN_PROMPT);
}

/**
 * 相似度（0–1）：用来在工作台里高亮「手动记忆」和「自动记录」中重复的条目。
 *
 * 用字符二元组重叠而不是"包含"：中文里"不要理张三"和"别搭理张三"一个字都不重合，
 * 但它们说的是同一件事。二元组能抓住"张三"这个共同部分，纯包含则完全抓不到。
 * 阈值交给调用方 —— 面板用来标黄，不需要精确。
 */
export function similarity(a, b) {
  const grams = (s) => {
    const t = String(s || '').replace(/\s+/g, '').toLowerCase();
    const out = new Set();
    for (let i = 0; i < t.length - 1; i += 1) out.add(t.slice(i, i + 2));
    if (t.length === 1) out.add(t);
    return out;
  };
  const A = grams(a);
  const B = grams(b);
  if (!A.size || !B.size) return 0;
  let hit = 0;
  for (const g of A) if (B.has(g)) hit += 1;
  return hit / Math.min(A.size, B.size);
}

/** 判定"两条记忆在说同一件事"的阈值。0.5 是实测下来中文短句的合理位置 */
export const SIMILAR_THRESHOLD = 0.5;

/**
 * ══════════════════════════════════════════════════════════════════════
 *  人设指纹 —— 判断"这一轮的人设还是不是上一轮那一套"
 * ══════════════════════════════════════════════════════════════════════
 *  为什么必须有这个：Brain.update(cfg) 换配置引用时**会话历史是原样保留的**。
 *  于是改完人设之后，提示词里还带着机器人前几轮用**旧口吻**说的那 12 轮话，
 *  模型会继续照着那个口吻说 —— 用户看到的是"改了人设但好像没变"，
 *  而且会一直持续到旧历史被自然挤出去。这是一类不报错、只是看起来没生效的问题。
 *  有了指纹，重载时就能判断"该丢历史了"。
 *
 *  算进去的：人格 12 个字段 + 机器人昵称 + 生效的场景规则 + 启用中的技能背景。
 *  刻意**不算**的：
 *    · 记忆 —— 记忆是渐变的，加一条就清空历史太粗暴；
 *    · 回复长短 / 开关类 —— 它们不影响"它是谁"，清历史只会损失上下文连贯。
 */
export function personaFingerprint(custom, personaName) {
  const c = custom || {};
  const p = c.persona || {};
  const parts = [
    String(personaName ?? ''),
    ...PERSONA_KEYS.map((k) => p[k]),
    // 增强 12 项也是人设的一部分：改完它同样要让模型丢掉"按旧演法说过的话"
    ...ENHANCE_KEYS.map((k) => `${k}=${c.enhance?.[k] || ''}`),
    // 扮演规则也算进指纹：关掉"不替用户说话"之后，模型前几轮按旧规矩说过的话
    // 同样会被它继续模仿 —— 和人设、技能背景是同一个道理。
    `playRules=${c.playRules !== false}`,
    ...Object.keys(SCENES).map((k) => `${k}=${c.scenes?.[k] || ''}`),
    ...(c.skills || [])
      .filter((s) => s && s.enabled)
      .map((s) => `${s.id}:${s.kind}:${s.scope?.type || ''}:${s.scope?.id || ''}:${s.background || ''}:${JSON.stringify(s.fields || {})}`),
  ];
  return createHash('sha1').update(parts.map((x) => String(x ?? '')).join('\u0001')).digest('hex').slice(0, 12);
}
