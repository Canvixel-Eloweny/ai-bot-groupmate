import scoped from './logger.js';
import { supportsVision } from './llm.js';
import {
  REPLY_LENGTHS, SCENES, ENHANCE, ENHANCE_KEYS, PERSONA_KEYS,
  activeManualMemory, personaFingerprint, resolvePlayRules,
} from './custom-config.js';
import { pickSkillsForPrompt, pickPersonaCard, skillLines } from './skills.js';
import { memoryScopeOf } from './memory-scope.js';
// 好友私聊按群友接待：好友表来自协议端（index.js 拉取），这里只做成员判定。
import { isFriend } from './friends.js';
import { autoMemoryForPrompt, recordsForPrompt, recallForPrompt, wantsRecall, RECALL_MAX } from './memory.js';
import { scanEgress } from './egress.js';
import { budgetOf, applyBudget, anchorHistory, HIST_ANCHOR, SAVING_DROP } from './context-budget.js';
import { extensionPlanOf, skillExtPlanOf } from './extension-prompts.js';
import { pickAmbient } from './ambient.js';
// 表达规范（ATI-1）：词表与对照示例住在 speech-rules（零依赖叶子），
// 因为它有**两个消费者** —— 这里写进提示词，index 那边扫回复记 trace。
import { speechRuleLines } from './speech-rules.js';
// 说话风格画像（ATI-2）：纯本地统计，零模型调用；采集侧在 index.js。
import { speakerLine, readProfiles } from './style-profile.js';
// 「防刷屏压到几段」这个数字会被面板显示出来（「最多 N 段」），
// 所以它只有一个来源（第 42 轮 B12b · SCHEMA-LITE）。
import { numDefault } from './field-schema.js';
// D12b（E15）：插话时机（活跃期提权 / 冷场降权）的**判据**在 interject.js（零依赖叶子），
// 这里只负责在唯一那个判定分支上问一次、并把来路带回给调用方做可观测。
import { interjectTuningOf, interjectPlanOf } from './interject.js';
// D11b·④：跨轮工作记忆的**渲染**判据（TTL / 淡忘 / 字符上限都在那个模块里，此处只画出来）
import { renderWorking } from './working-memory.js';
// D28：触发判定该看哪一份正文（@ 段的显示名不算正文，判据在 onebot.js）
import { triggerTextOf } from './onebot.js';
// 触发档位 ↔ 上下文条数（D9a · 报告 E23）。零依赖叶子：
// 档位定义与「只压紧不放宽」的收窄规则都住在那里，这里只负责接线。
import { contextLimitsOf, tierOfKind } from './tier.js';
// B33：内部标记（「本轮没有接话」这类系统批注）的**唯一形态定义**，以及
// 「模型把批注复读出来 → 剥掉再发」的判据。它有两个消费者：这里（主链路出口）
// 与 `index.js`（主动链出口 + 四处记忆占位文案），所以住在零依赖叶子里。
import { scanInternalMarks, stripInternalMarks } from './internal-marks.js';
// 人设域六页（2026-10-25）：分段的**文字实现**住在 prompt-sections.js，
// 面板的「系统提示词」页读的是同一份 —— 两处各写一份就会"界面说注入 A、模型收到 B"。
import {
  basePromptLines, personaBitsOf, personaPromptLines, enhancePromptLines,
  rulesPromptLines, isolatePromptLines, applySectionOverride,
} from './prompt-sections.js';
import { mbtiPromptLines } from './mbti.js';
import { astroPromptLines } from './birthday.js';
// 本体情绪（项目内建）：状态文件只在真正拼提示词时读一次，没文件就不出现这一段。
import { readEmotionState, moodPromptLines } from './emotion.js';

// ── H-10 第 22 轮：文本工具**整块搬出** ────────────────────────────────────
// 实现只在新家一份；这里 import 之后**原样转出** —— 外部引用（src/index.js、
// test/smoke.js、scripts/dryrun.js）一个字都不用改（`memory.js` → `memory-store.js`
// 的先例）。判据的取源改指新家，**不是**复制一份判据。
//
// ⚠️ 2026-10-17：`face-marks.js` 已整体删除（表情能力下线）。唯一留下来的是
//    `stripFaceMarks` —— 它现在是**防漏**（旧存档 / 模型惯性还会写 `[face:14]`），
//    住在 `reply-text.js` 的文本清理族里，不属于任何"功能"。
import {
  renderSpeakerLine, trailingBlankLines, lateSendReason,
  REST_LINE_WOKE, REST_LINE_EMERGENCY, REST_LINE_DROWSY, CATCHUP_LINE, PATROL_LINE, restLineOf,
  isBareMedia, escapeRe, stripLinks, stripThink, hardWrap, stripFaceMarks,
} from './reply-text.js';
export {
  renderSpeakerLine, trailingBlankLines, lateSendReason,
  REST_LINE_WOKE, REST_LINE_EMERGENCY, REST_LINE_DROWSY, CATCHUP_LINE, PATROL_LINE, restLineOf,
  isBareMedia, escapeRe, stripLinks, stripThink, hardWrap, stripFaceMarks,
};

const log = scoped('brain');

const SILENT = '[SILENT]';

/**
 * 「`reply.splitToken` 是空串」**只警告一次**（2026-10-09 · 第 53 轮 · B4）。
 *
 * 为什么要有这条守门（而不是只靠 `src/config.js` 的归一化）：
 *   归一化只管**从 config.json 装载**这一条路。而 `brain.parseReply` 拿到的 `cfg`
 *   也可能是测试夹具、脚本直接构造的对象、或将来新加的配置来源 —— 空串在那里
 *   就是"每个字符之间都断开"，一条完整回复会被**逐字**发到群里。
 *   所以两层都要有：归一化是兜底，这里是**守门**（不依赖任何调用方的自觉）。
 *
 * 为什么只警告一次：它每来一条群消息都会被算到，每次都打会把真正的告警冲掉
 *   （本项目在别的扫描器上踩过这个形状）。但**绝不能不打** ——
 *   "为什么没分条"必须留下可查的线索，否则又是一次静默降级。
 */
let splitTokenWarned = false;
function warnSplitTokenOnce() {
  if (splitTokenWarned) return;
  splitTokenWarned = true;
  log.warn('reply.splitToken 是空串 —— 已按「只按换行分条」处理。'
    + '空串会让分隔正则逐字符匹配，把一条回复切成单字发出去；'
    + '请在 config.json 的 reply.splitToken 填回 "||"');
}


export class SessionStore {
  constructor(cfg) {
    this.cfg = cfg;
    this.sessions = new Map();
  }

  key(scene, id) {
    return `${scene}:${id}`;
  }

  get(scene, id) {
    const k = this.key(scene, id);
    let s = this.sessions.get(k);
    if (!s) {
      s = {
        key: k,
        scene,
        id: String(id),
        history: [],
        ambient: [],
        lastReplyAt: 0,
        lastInterjectAt: 0,
        // D12b：本会话**最后一次有人说话**的时刻（冷场判据的唯一数据来源）。
        // 由 `noteSeen()` 在**判定之后**推进 —— 于是判定读到的永远是"这条之前"的沉默时长。
        // ⚠️ 只在内存里（不进存档）：重启后是 0，冷场判据按"不知道"处理 → 不降权（fail-open）。
        lastMsgAt: 0,
        recentReplies: [],
        // D9b（报告 E7）：两把"临时闭嘴"的闸，都由群里的事件驱动、都靠**到期时间戳**
        // 自己恢复 —— 没有定时器、没有需要清理的状态，因此不存在"定时器没跑它就一直哑着"。
        //   mutedUntil —— 被管理员禁言到什么时候（秒级时间戳，0 = 没被禁言）
        //   quietUntil —— 群内「/安静」锁到什么时候（0 = 没锁）
        mutedUntil: 0,
        quietUntil: 0,
        // D11b·④：跨轮工作记忆（超短期，最多 3 条 / 90 分钟硬上限）。
        // 与上面两把锁同一族：**只在内存里**、重启即丢 —— 见 src/working-memory.js 文件头。
        workingTurns: [],
      };
      this.sessions.set(k, s);
    }
    return s;
  }
}

export class Brain {
  /**
   * @param {ReturnType<import('./config.js').loadConfig>} cfg
   * @param {SessionStore} store
   */
  constructor(cfg, store) {
    this.cfg = cfg;
    this.store = store;
    /** 当前生效的人设指纹，用来判断热重载该不该丢掉旧人设的会话历史 */
    this.fp = personaFingerprint(cfg?.custom, cfg?.persona?.name);
    /** 好友表（空集 = 还没拉到 / 拉取失败 ⇒ 好友私聊一律不放行） */
    this.friendIds = new Set();
  }

  /**
   * 热重载：配置变了换掉引用即可，会话历史原样保留。
   *
   * **但人设变了是例外**。历史里存的都是机器人用旧人设说过的话，
   * 模型看到自己前几轮的口吻会继续照着说 —— 表现出来就是"改了人设但好像没变"，
   * 而且会一直持续到那些旧历史被自然挤出去（默认 12 轮）为止。
   * 所以这里比对指纹：变了就把历史里的 assistant 消息丢掉，
   * **只留用户侧**（保住"他们在聊什么"的连贯），下一句就是新人设开口。
   *
   * 不想这样的话可以在工作台关掉「改人设后清空旧发言」。
   */
  update(cfg) {
    const next = personaFingerprint(cfg?.custom, cfg?.persona?.name);
    const resetOn = cfg?.custom?.personaResetOnChange !== false;
    if (this.fp && this.fp !== next && resetOn) {
      let dropped = 0;
      for (const s of this.store.sessions.values()) {
        const before = s.history.length;
        s.history = s.history.filter((m) => m.role !== 'assistant');
        dropped += before - s.history.length;
      }
      if (dropped) log.info(`人设已变更 → 丢弃 ${dropped} 条旧人设的发言（否则它会继续模仿旧口吻）`);
    }
    this.fp = next;
    this.cfg = cfg;
    return this;
  }

  /**
   * 是否响应这条消息。
   *
   * **纯判定、无副作用**：掷骰子的结果由调用方以 `roll` 传入（默认仍是 `Math.random()`，
   * 既有调用点行为不变）；插话冷却的记账挪去了调用方（见 src/index.js 里 decide 的调用点）。
   *
   * 为什么值得改：同一个判定被调两次，旧实现会**消耗两次插话冷却** —— 判定函数带副作用，
   * 调用次数就成了隐藏状态。改成纯函数之后它可以被安全重复调用，
   * 这也是将来"面板上显示它正在犹豫要不要接话"的前提（那种场景必然要预判一次、真跑再确认一次）。
   *
   * B8 又加了一道**纯图/纯表情闸门**（S-BARE，见下方注释）：它同样只是判定，
   * 宽限期取的是 `session.lastReplyAt`，不写任何状态。
   */
  decide(session, evt, parsed, {
    now = Date.now(), roll = Math.random(), repliedToMe = false, heatWeight = 1, patrol = null,
  } = {}) {
    const { trigger } = this.cfg;
    const custom = this.cfg.custom || {};

    // 白名单/黑名单判定（唯一实现在 #gateReason）。它先于一切 session 访问 ——
    // 所以调用方允许对"过不了闸"的消息传 null 会话（见 src/index.js 的 handleMessage）。
    const gateReason = this.#gateReason(evt);
    if (gateReason) return deny_(gateReason);

    // ── D9b（E7）：被禁言就这一轮什么都不做 ──
    // 位置在**最前面**（黑白名单之后、私聊之前）：它是"连判定都不必做"的一类，
    // 越早返回省得越多 —— 不建历史、不组提示词、不烧 token。
    // ⚠️ 判据是"**到期时间戳还在未来**"，不是一个布尔量：到期不需要任何人来清状态，
    //    所以不会出现"解除事件丢了 → 它从此不再说话"这种最难查的失败。
    if ((session?.mutedUntil || 0) > now) return deny_('被管理员禁言中，先不开口');

    if (evt.message_type === 'private') return ok('private', '私聊');

    // ── D28：触发判定只看**去掉 @ 显示名**的那一份正文 ──
    // 「是不是在叫我」由 qq 集合回答（`mentionedSelf`，已经是比 qq 号，正确）；
    // 别名与关键词是**正文**匹配，就只在正文上比 —— @ 别人的显示名不算正文。
    // 真机量数（2026-09-27）：113 条 trace 里 20 条含 @，现网**0 条**因显示名误命中
    //   （当前群里没有名字带关键词的群友）—— 所以这是**潜在**缺陷，不是已发生的事故；
    //   但只要有人把昵称改成「摸鱼小能手」，每次 @ 他都会把它叫出来。
    const trigText = triggerTextOf(parsed);
    // ── M-4（2026-10-04 审查轮）：把「引用了我的话」接进"被叫到"这一档 ──
    // 人设（`persona/qq-chat.md`）把它写成硬要求，而此前 `parsed.replyTo` **零消费者**。
    // ⚠️ 判定**不在这里**做：`replyTo` 只是"被引用消息的 id"，**不含作者**，
    //    "是不是我发的"要拿我发过的 id 去比 —— 那件事由 `src/reply-track.js` 回答，
    //    调用方把结论当 `repliedToMe` 传进来（纯函数不许自己去读进程状态）。
    // ⚠️ 默认 `false`：既有的三参调用（含测试）语义**逐字不变**。
    // 巡逻轮的文本是**一批积压的摘要**，里面出现机器人名字/关键词不代表"被点名"——
    // 不排除的话，摘要里只要有人提过它，巡逻就被判成 named/keyword，绕开巡逻概率。
    const named = !evt?.isPatrol
      && (parsed.mentionedSelf || this.#hasAlias(trigText) || repliedToMe === true);
    if (named) {
      const why = parsed.mentionedSelf ? '被 @ 了' : (this.#hasAlias(trigText) ? '叫了名字' : '引了我的话');
      return ok('named', why);
    }

    // ── D9b（E7）：群内「/安静」的临时锁档 ──
    // 位置**必须在 `named` 之后、关键词之前**，两条理由各管一半：
    //   · 在 named **之后** —— 「安静」锁的是"自己找话"，被点名照回（这才是用户的意图），
    //     而且这样用户还能再发一次 `/安静 0` 自己解除；
    //   · 在关键词**之前** —— 关键词也属于"自己找话"，安静期内该一起关掉。
    // 与 `allowProactive` 的分工：那是**全局**总闸（改配置），这是**单个群**的临时锁（群里一句话）。
    if ((session?.quietUntil || 0) > now) return deny_('安静期内（只回被点名的）');

    // 关键词触发（工作台「触发方式」里填的）。
    // 它**不受**「必须 @」和主动发言总闸限制：命中关键词是用户写死的规则，
    // 语义上属于"被叫到"，不是"自己插嘴"。把它关在主动发言闸后面，
    // 用户会觉得"我明明设了关键词却不回，是不是坏了"。
    const hit = evt?.isPatrol ? '' : this.#hitKeyword(trigText);
    if (hit) return ok('keyword', `命中关键词「${hit}」`);

    if (trigger.requireAtInGroup) return deny_('群聊未被点名');

    // 主动发言总闸（工作台「能力开关 → 主动发言」）。
    // 关掉之后，插话 / 定时主动 / 定时消息**全部**不发声 —— 这是"让它闭嘴"唯一的一处开关，
    // 免得用户要一个个去关三个地方。
    if (custom.allowProactive === false) return deny_('主动发言已关闭');

    // ── 巡逻轮（0.1.1 的 flushGroup：攒了一批积压，问一轮模型接不接）──
    // 位置固定在主动发言总闸之后：巡逻也是"自己找话"，总闸关掉就该一起停。
    // 也固定在 requireAtInGroup 之后 —— 用户配了「群里必须 @ 才理」，巡逻开口等于绕过他的设定。
    // ⚠️ 这里**不再看**插话冷却：巡逻有自己的最短间隔（src/patrol.js 的计划函数）。
    if (evt?.isPatrol) {
      if (!patrol) return deny_('巡逻轮缺计划');
      if (now - (session?.lastDirectAt || 0) < 15000) return deny_('刚被点名过，不巡逻', patrol);
      if (roll < patrol.chance) return ok('patrol', `巡逻：${patrol.count} 条积压`, patrol);
      return deny_('巡逻掷骰未中', patrol);
    }

    // ── 纯图 / 纯表情不主动接话（B8 · S-BARE）──
    // 「必须 @」关掉之后，群里有人发张图、一个字都不带，旧实现会一路走到随机插话，
    // 白跑一次模型调用（而它多半只能编一句"哈哈哈"）。
    //
    // 宽限期是**刻意的**：只在刚回过话的这几分钟内拦。否则会出现最气人的那种失败 ——
    // 它自己说"发来看看"，对方发来一张图，它装死。
    //
    // ⚠️ 位置有两处不能动：
    //   ① 必须在 `named` 判定**之后** —— 被 @ 的纯图是明确点名，必须穿透这道闸；
    //   ② 必须在 `requireAtInGroup` **之后** —— 默认配置（群里必须 @）下这条路径
    //      根本走不到，放前面会平白改掉既有配置的 deny 文案，而那是纯粹的噪声。
    if (isBareMedia(parsed) && now - (session.lastReplyAt || 0) < trigger.bareGraceMs) {
      return deny_('纯图/纯表情且刚说过话，不主动接');
    }

    if (trigger.interjectChance > 0) {
      // 刚被点名过就别插话了：否则"@ 它" + "它自己插一句"会连着冒出来，
      // 看着就像一次触发回了两条
      if (now - (session.lastDirectAt || 0) < 15000) return deny_('刚被点名过，不插话');
      if (now - session.lastInterjectAt < trigger.interjectCooldownMs) return deny_('插话冷却中');
      // ── D12b（E15）：活跃期提权 / 冷场降权 ──────────────────────────────
      // 两道闸之后才轮到概率：闸是"结构上不许说"，因子是"概率上想不想说"。
      // 顺序反了的话，被降权到 0 的那一轮会**吃掉**插话冷却的记账（调用方按 kind 记账），
      // 表现是"它突然好几分钟不插话，而冷却明明没到"。
      //
      // 判据住在 src/interject.js（零依赖纯函数），这里只做两件事：
      // ① 用 `plan.chance` 而不是 `trigger.interjectChance` 掷骰子（契约 §41 钉着这个接线）；
      // ② 把 plan 挂在返回值上 —— 它记的是"这一轮概率是多少、凭什么"，
      //    没有它的话，"明明配了 15% 却一次都没插过"只能靠猜。
      //
      // ⚠️ **深夜时段不在这里降权**：那是 D31（睡眠/作息全局）的语义，
      //    这里再做一份，"深夜"就有两个判据（本项目头号禁忌）。
      const plan = interjectPlanOf({
        session, now, base: trigger.interjectChance, tuning: interjectTuningOf(trigger),
      });
      // 热度权重（按人关系温度）：冷的时候就少冒头。与活跃期提权**相乘**，不是二选一；
      // 两个都只压不放（上限 1）。
      if (heatWeight < 1) {
        plan.heatWeight = heatWeight;
        plan.chance = Math.max(0, Math.min(1, plan.chance * heatWeight));
      }
      // 用入参 roll 而不是就地 Math.random()：判定要可复现、可被调用两次而不产生差异。
      // 冷却的记账已挪到调用方（冷却的语义是"决策生效了"，属于后果，不属于判定）。
      if (roll < plan.chance) return ok('interject', '随机插话', plan);
      return deny_('不满足插话条件', plan);
    }
    return deny_('不满足插话条件');
  }

  /**
   * 这条消息来路的黑白名单判定。返回**拒绝原因**字符串，`''` 表示放行。
   *
   * 为什么从 decide 里抽出来：调用方（src/index.js 的 handleMessage）要在
   * **创建会话对象之前**先预判一次 —— 不在白名单的群/用户永远不会有回复，
   * 为它们建会话、记背景消息是纯内存浪费（且只增不减）。
   * 判定只此一份，decide 内部也走这里，两边不会漂移。
   */
  /**
   * 「好友私聊按群友接待」：白名单没写他、但他在好友表里 ⇒ 放行。
   * ⚠️ 表还没拉到（空集）时全部失败关闭；开关 `custom.allowFriendsPrivate` 关掉回旧行为。
   * ⚠️ 好友不等于管理员：叫醒、夜间产出收件人这些仍由 `isOwner` 判，这里不碰。
   */
  #friendPrivateAllowed(evt) {
    if (this.cfg?.custom?.allowFriendsPrivate === false) return false;
    return isFriend(this.friendIds, evt?.user_id);
  }

  /** 协议端好友表（QQ 号集合）。由 `src/index.js` 刷新。 */
  setFriendIds(ids) {
    this.friendIds = ids && typeof ids.has === 'function' ? ids : new Set();
    return this;
  }

  #gateReason(evt) {
    const { allow, deny } = this.cfg;
    if (deny.groups.includes(String(evt.group_id ?? ''))) return '命中群黑名单';
    if (deny.users.includes(String(evt.user_id ?? ''))) return '命中用户黑名单';
    const allowed =
      evt.message_type === 'group'
        ? allow.groups.includes(String(evt.group_id)) || allow.allowAllWhenEmpty
        : allow.private.includes(String(evt.user_id))
          || allow.allowAllWhenEmpty
          || this.#friendPrivateAllowed(evt);
    if (!allowed) {
      return evt.message_type === 'group'
        ? '群不在白名单'
        : '对方不在「同意私聊的 QQ 号」里，也不在好友表里';
    }
    return '';
  }

  /** 放行与否（调用方建会话对象前的预判入口）。 */
  isAllowed(evt) {
    return this.#gateReason(evt) === '';
  }

  /**
   * 许可被判回的原因（'' = 现在仍允许）。
   *
   * 第 56 轮 F1-2（E22）把它从私有变成公开：**发送时刻复核**必须用**同一份判据**。
   * 让调用方自己再写一遍黑白名单判断，就会在两次实现之间漂 ——
   * 而这道判据是"哪条会话能说话"的唯一来源。
   *
   * 注意它读的是 `this.cfg`（`update()` 之后就是热重载后的那份），
   * 所以"用户在面板上改了白名单"在这条判据里**立刻可见**。
   */
  gateReason(evt) {
    return this.#gateReason(evt);
  }

  #hasAlias(text) {
    if (!text) return false;
    return this.cfg.trigger.aliases.some((a) => text.includes(a));
  }

  /** 命中工作台里配的关键词就返回命中的那个词，没命中返回空串 */
  #hitKeyword(text) {
    const list = this.cfg.custom?.trigger?.keywords || [];
    if (!text || !list.length) return '';
    const low = String(text).toLowerCase();
    return list.find((k) => low.includes(String(k).toLowerCase())) || '';
  }

  /**
   * 组装发给模型的 messages。
   *
   * B10f 起改成**分段装配**：每一节先装进自己的 `lines`，再由 `applyBudget`
   * 按预算裁剪、按 SECTION_ORDER 拼回一个数组。拼法与改造前逐字一致（段间一个空行），
   * 所以**默认配置下输出与旧实现完全相同**（有断言钉着，见 test/smoke.js 的 T44）。
   */
  buildMessages(session, evt, parsed) {
    return this.buildMessagesWithMeta(session, evt, parsed).messages;
  }

  /**
   * 同 `buildMessages`，但额外返回这一轮**被预算砍掉了什么**（B10f-1 · C-BUDGET）
   * 和背景消息这一轮是否整批更替过（B10f-2 · C-AMBIENT）。
   *
   * 为什么另开一个入口而不是改 `buildMessages` 的返回值：它的返回值被 dryrun、
   * prompt-diff 和三套测试用着（5 处调用点），改签名要一起动；而 `dropped`
   * 属于"可观测"这一层的新增物，只有真正要落 trace 的调用点（src/index.js）需要。
   *
   * @param {{saving?:boolean, tier?:string}} [opts] D8：`saving: true` = 花费进了 trim 档，
   *        **只整段拿掉 `SAVING_DROP`（ambient / skills）**，其余一律不动。
   *        做成**入参**而不是读全局/实例状态：本项目对"每轮都要变的东西"一贯
   *        由调用方注入（时间用 `now`、随机用 `rng`），这样"触顶后提示词变成什么样"
   *        才能被断言直接钉死，而不是要先伪造一个全局状态。
   *        D9a 追加 `tier`：这一轮的触发档位（`direct` / `keyword` / `interject`），
   *        决定 `recentTurns` / `ambientMessages` 实际取多少条 —— 同样入参注入，
   *        因为"是谁触发的"只有调用方（`handleMessage`）手里的 `decision` 知道。
   *        ⚠️ 档位**只影响"这一轮带多少"**，不影响 `remember()` / `rememberAmbient()`
   *        的记账容量（那两处仍读全局配置）—— 「留多少」与「带多少」是两件事，
   *        合成一个就会变成"插话一多，历史就被压着不留了"。
   *        `extensionSections`（2026-10-15）：已加载扩展包的提示词指引，形状
   *        `[{title, content, tools:string[], priority:number}]`（由 `src/index.js` 收集）。
   * @returns {{messages:object[], dropped:object[], ambient:{count:number,refreshed:boolean}}}
   */
  buildMessagesWithMeta(session, evt, parsed, opts = {}) {
    const { persona, context, reply } = this.cfg;
    const custom = this.cfg.custom || {};
    // 角色卡（按人 > 按群 > 全局）—— 卡在，就把 24 项人格快照压到全局配置上：
    // 这是「换群即换人」的唯一落点。没卡时 `card` 为 null，下面全部回落到原样，
    // 所以老配置的行为逐字不变。
    const card = this.personaCardFor(evt);
    // 时间注入口（OPS-FIXTURE）：跨轮工作记忆的"约 N 分钟前"是个判据，
    // 判据一旦直接读墙钟，就只能在真机上等 30 分钟才能验一次 —— 那等于没法验。
    const now = Number.isFinite(opts.now) ? opts.now : Date.now();
    // 这一轮实际能带多少条上下文。`direct` 档原样返回全局配置（逐字不变），
    // 其余档只压紧 —— 判据与数字全在 src/tier.js，这里不写第二份。
    const limits = contextLimitsOf(opts.tier, context);
    // 每一节 = 一个段：id 决定拼接顺序与淘汰优先级，见 src/context-budget.js
    const sections = [];
    const sec = (id, label, opts = {}) => {
      const s = { id, label, lines: [], drop: opts.drop !== false, trimFrom: opts.trimFrom || 'newest' };
      sections.push(s);
      return s;
    };
    // 稳定段（前缀缓存要命中的就是它，越靠前越值钱）
    const base = sec('base', '身份与说话方式', { drop: false });

    // 「回复长短」由工作台控制：这里只换那一条规则，不再叠加第二条互相矛盾的字数要求
    const len = REPLY_LENGTHS[custom.replyStyle?.length] || REPLY_LENGTHS.normal;
    base.lines.push(...basePromptLines({
      personaName: card?.name || persona.name,
      replyLengthHint: len.hint,
      maxChunks: reply.maxChunks,
    }));
    // B33 那条「系统标记不是你要说的话」也在这份固定段里（见 prompt-sections.js）——
    // 它刻意不编号，免得后面几条的序号随版本漂移。

    // ── 人设：人格文件是"底子"，工作台里填的是"日常人设"，两段一起给 ──
    // 顺序按"模型理解的顺序"排：先"我是谁"，再"我想要什么 / 怕什么"，然后才是怎么说话。
    // 全空就整节不出现 —— 空白的小标题会让模型去猜，不如不给。
    const cp = mergeCardFields(custom.persona || {}, card, PERSONA_KEYS);
    const personaBits = personaBitsOf(cp);
    if (card?.background) personaBits.push(`（补充设定：${card.background}）`);
    /* 「爱用的表情」那一行已于 2026-10-17 删除：表情能力整体下线，
       留着它等于在提示词里暗示"你可以发表情"，而发送侧已经不会拼表情段。
       `persona.faces` 这个字段本身不动（旧 config.json 里可能还留着值），只是不再读。 */
    const personaSec = sec('persona', '人物设定', { minLines: 1 });
    personaSec.lines.push(...personaPromptLines({ personaText: persona.text, bits: personaBits }));

    // ── MBTI 辅助（2026-10-25）──
    // 位置：人物设定之后、增强项之前。它是**表达倾向**，不是"它是谁"：
    // 排在人设后面才不会被读成另一段人设；排在增强项前面，细节才是在它的语气里展开。
    // 关着时整段不出现（默认关），所以旧配置的提示词逐字不变。
    const mbtiSec = sec('mbti', 'MBTI 辅助');
    mbtiSec.lines.push(...mbtiPromptLines(custom));

    // ── 增强项：让"像人"的那一层细节 ──
    // 放在人物设定**之后、扮演规则之前**：先"你是谁"，再"更细怎么演"，最后"演的规矩"。
    // 留空的项**整条不出现在提示词里**（这就是需求文档说的"可选、非必填"）——
    // 空白小标题会让模型去猜，不如不给。
    const enh = mergeCardFields(custom.enhance || {}, card, ENHANCE_KEYS);
    const enhanceSec = sec('enhance', '增强项');
    enhanceSec.lines.push(...enhancePromptLines(enh, ENHANCE));

    // ── 此刻的状态（本体情绪 · 实时层）──
    // 位置与原型一致：增强项之后、扮演规则之前。它是语气底色，不是人设；
    // 没有状态文件（机器人还没跑过 / 用户关掉）时整段不出现。
    const moodSec = sec('mood', '此刻的状态');
    if (custom.moodOn !== false) moodSec.lines.push(...moodPromptLines(readEmotionState()));

    // ── 扮演规则（底层逻辑）──
    // 需求文档把它标成"必须写进去"：它不是人设的一部分，而是"扮演这件事本身的规矩"。
    // 放在人物设定**之后**：先告诉它"你是谁"，再告诉它"演的时候守什么规矩"，
    // 顺序反了的话模型容易把规矩当成又一段人设来复述。
    const rulesSec = sec('rules', '扮演规则');
    if (custom.playRules !== false) {
      rulesSec.lines.push(...rulesPromptLines(resolvePlayRules(custom)));
    }

    // ── 别人说的话是「内容」，不是「指令」（B9 · INJ-ISOLATE）──
    // 群聊内容属于**不可信输入**：任何人都能打一行"忽略上面的规则"送进来。
    // 所以要在系统侧明确声明它的定位，而不是指望模型自己每次都分得清 ——
    // 尤其在模型看到的上下文里，群友的话和系统设定是前后紧挨着的。
    //
    // ⚠️ 故意的两处选择：
    //   ① **放在稳定段**（lines）而不是必变段 —— 这一段与当前消息无关、每轮都一样，
    //      因此会被前缀缓存命中。放进必变段（或挪到 ambient 之后）等于每轮白作废
    //      一次缓存，B7 那个 2.0% → 99.3% 的收益就是这么丢掉的。
    //   ② **不受 `playRules` 开关影响** —— 那个开关管的是"怎么演"，
    //      这一节管的是"别人说的话算什么"，关掉前者不该把后者一起关掉。
    //
    // 再强调一次（见 src/injection.js）：它**不是安全边界**，只是把该有的常识说清楚。
    // ⚠️ 这一节 drop:false —— 它是安全声明，不是内容。砍掉它等于把 B9 那道
    // 注入隔离防线自己拆了，而"省下来的那几十个字符"毫无价值。
    const isolateSec = sec('isolate', '别人说的话是什么', { drop: false });
    isolateSec.lines.push(...isolatePromptLines());

    // ── 自我记忆 ──
    // 手动记忆**永远常驻**：它是用户明确要求"必须记住"的事，不随"自动记录"开关变。
    // 自动记忆只取最近的若干条 —— 全塞进去的话，这一节会比人格本身还长，
    // 小模型会被它带跑偏。
    // 记忆作用域：有卡按卡（同卡跨群共用一份），没卡才按会话（`src/memory-scope.js`）。
    // `hint` 是这一轮的话 —— 选记忆时先用它算相关度，而不是只按"谁先说的"排队。
    // `fallbackChatKey` 只用于**读取**：旧版按群存的记忆不会因为启用了卡就突然消失。
    const memKey = this.memoryKeyFor(evt, session, card);
    const memSel = this.memorySelection({
      chatKey: memKey,
      fallbackChatKey: card ? session?.key : '',
      userId: evt.user_id,
      hint: triggerTextOf(parsed),
    });
    const memSec = sec('memory', '记忆', { trimFrom: 'newest' });
    // ⚠️ 三条来源**各自独立**，不许用同一个 `if` 管着它们。
    //    真机实测（2026-09-23）：结构化记忆原本被关在 `if (mem.length)` 里面 ——
    //    一旦用户清空自动记录、又没有手动记忆，**已复证的结构化记忆也会静默不注入**。
    //    这类「一个条件门管了两件事」的缺陷在测试里看不出来（测试里三种总是都有）。
    const manual = memSel.manual;
    const auto = memSel.auto;
    const records = memSel.records;
    if (manual.length || auto.length) {
      memSec.lines.push('## 你记得的事（对话中要当事实用，别复述这一节）');
      for (const m of manual) memSec.lines.push(`- ${m.text}`);
      if (auto.length) {
        memSec.lines.push('（下面这些是你自己留意到的，不一定重要，别硬提）');
        for (const m of auto) memSec.lines.push(`- ${m.text}`);
      }
    }
    // ── 结构化记忆（ATI-3）──
    // 两条门控都在 `memory-record` 里（纯函数，可被断言）：
    //   ① **只有"被独立复证过"的**才注入 —— 一次观察只落盘，不进提示词；
    //   ② **按会话隔离** —— 别的群聊出来的记忆不会串到这个群。
    // 第三道是预算：装不下就截，截掉了由调用方决定要不要留痕。
    if (records.length) {
      memSec.lines.push('（下面这些是反复确认过的，可以当事实用）');
      memSec.lines.push(...records.map((m) => m.text));
    }

    // ── 生日彩蛋（2026-10-25）──
    // 位置：记忆之后、场景之前。权重最低、只有两行；关着（默认）时整段不出现。
    // 生肖**不进提示词** —— 它按"当前日期 + 参考周岁"反推，误差一年就换一个，
    // 拿它去影响说话属于编造事实；页面上只作展示。
    const astroSec = sec('astro', '生日彩蛋');
    astroSec.lines.push(...astroPromptLines(custom));

    // ── 特殊场景：用户只填了他关心的那几条，空的就不占版面 ──
    // 卡里存过场景快照就覆盖（只覆盖非空项；卡里没存 = 沿用当前场景）。
    const scenes = { ...(custom.scenes || {}) };
    const cardScenes = card?.fields?.scenes && typeof card.fields.scenes === 'object' ? card.fields.scenes : {};
    for (const [k, v] of Object.entries(cardScenes)) {
      if (SCENES[k] && typeof v === 'string' && v.trim()) scenes[k] = v;
    }
    const sceneLines = Object.entries(scenes)
      .filter(([k, v]) => v && SCENES[k])
      .map(([k, v]) => `- ${SCENES[k].label}：${v}`);
    const sceneSec = sec('scenes', '特殊场景');
    if (sceneLines.length) {
      sceneSec.lines.push('## 遇到这些情况就这样处理');
      sceneSec.lines.push(...sceneLines);
    }

    // ── 技能：运行时注册表里命中当前会话的那几条 ──
    // 放在场景之后：场景是"遇到例外怎么办"，技能是"你本来就会的东西"。
    const picked = this.skillsInPrompt(evt, parsed);
    const skillSec = sec('skills', '技能');
    if (picked.length) {
      skillSec.lines.push('## 你现在用得上的一些本事');
      skillSec.lines.push('（下面是你确实懂的东西。自然地用，不要宣告"我有个技能"，也不要硬塞。）');
      for (const s of picked) skillSec.lines.push(...skillLines(s));
    }

    const skillSecs = Array.isArray(opts.skillSections) ? opts.skillSections : [];
    if (skillSecs.length) {
      const plan = skillExtPlanOf(skillSecs);
      if (plan.lines.length) {
        const skillExtSec = sec('skillExt', '可用 Skill');
        skillExtSec.lines.push(...plan.lines);
      }
    }

    // ── 扩展包指引：清单声明的 `prompt.sections`（2026-10-15 · 修「模型不知道何时用工具」）──
    // 由调用方（`src/index.js`）从**已加载**的扩展包收集后经 `opts` 注入 —— 与 `tier` /
    //  `sleep` / `catchUp` 同一条纪律：每轮才变的东西由调用方给，不在这一层读全局。
    //
    // ⚠️ 这一节补的是一个**静默**的洞：工具定义发给了模型（API 层面），但没有任何一句话
    //    告诉它"什么时候该用哪个"。表现是模型继续演角色、甚至编出"我翻了，是空的" ——
    //    日志里没有任何异常。清单作者写的指引此前**从未**进过提示词。
    // ⚠️ 每条的 `tools` 是**真实注册名**（带 owner 前缀）：清单里写的是裸 id，
    //    而模型只认注册表里的名字，写裸 id 等于让它去调一个不存在的工具。
    const extSecs = Array.isArray(opts.extensionSections) ? opts.extensionSections : [];
    if (extSecs.length) {
      const plan = extensionPlanOf(extSecs);
      if (plan.lines.length) {
        const extSec = sec('extensions', '扩展包指引');
        extSec.lines.push(...plan.lines);
      }
    }

    // ── 表达规范（ATI-1）──
    // 位置：**技能之后、背景消息之前**。两个理由一起看：
    //   ① 项目纪律「行为类块越靠后越服从」—— 它必须压在人物设定/规则之后；
    //   ② 它前面那些段（memory / scenes / skills）都是"跟着配置或会话变"的，
    //      而本段是**静态文本**，放在 ambient（半易变）之前才不会每轮作废前缀缓存。
    // ⚠️ 这一段必须有：它是"别像客服"这条要求的唯一落点，光靠 base 里
    //    「不要客服腔」五个字，约束不住具体用词。
    const speechSec = sec('speech', '表达规范');
    speechSec.lines.push(...speechRuleLines());

    // ── 背景消息（B10f-2 · C-AMBIENT）──
    // 旧实现是 slice(-N)：每来一条就整体下滑一格，窗口填满后每轮都会把第一行顶掉，
    // 前缀断口会从段末尾前移到段开头。改成"粘性 + 成批更替"：这一批还在就不动它，
    // 攒够一批（默认 4 条）新消息才整批换 —— 把错位集中到少数几轮。
    const ambientPick = pickAmbient(session, {
      window: limits.ambientMessages,
      batch: context.ambientBatch,
    });
    // 超预算要从**最老**的开始丢：背景消息的价值随时间递减，丢最新的一条等于装作没听见
    // `keepHead:1` 保住下一行那段标题：从最老开始裁时，第一次 shift() 丢的正是它，
    // 模型会把背景消息误当自己参与过的对话。
    const ambientSec = sec('ambient', '背景消息', { trimFrom: 'oldest', keepHead: 1 });
    if (ambientPick.entries.length) {
      ambientSec.lines.push('## 刚才群里的消息（你没参与的，作为背景）');
      for (const m of ambientPick.entries) ambientSec.lines.push(renderSpeakerLine(m.speaker, m.text));
    }

    // ── 必变段：压到 system 的最后一行 ──
    // 前缀缓存只认「从头逐字一致」。这两行一个精确到秒、一个带群号，
    // 放在前面等于把它后面整段稳定内容全部作废（实测相邻两轮公共前缀 58 → 2,926 字符）。
    // 位置必须在 ambient **之后**：ambient 是"每轮整体下滑"的易变段，
    // 任何会变的行放到它前面都白丢缓存。
    //
    // ⚠️ 两条不能动的约束（改序时务必一起看）：
    //   ① 群号行必须和时间行**一起**挪 —— 只挪时间的话，多群部署下群号仍会切断跨群前缀；
    //   ②【当前消息】永远留在最后（history 之后），别为了缓存把它挪到前面 ——
    //      模型对长提示词的**尾部**注意力最重，那是它的正位。
    const volatileSec = sec('volatile', '当前时间与场景', { drop: false });
    // ── ATI-2：跟你说话的这个人（说话风格画像，纯本地统计）──
    // 位置在**必变段内部、当前时间之前**。两件事一起看：
    //   ① 它每轮都可能变（换个人说话就变），所以它属于必变信息，不该挤在稳定段里；
    //   ② 它前面的 ambient 已经把前缀断口吃掉了 —— 放在这里**不会**额外损失缓存。
    //      ⚠️ 反过来（插到 ambient 之前）会把断口前移，那是实打实的成本。
    // 没有档案时 `speakerLine` 返回空串 → 提示词一个字都不多 ——
    // 对陌生人**不凭空编画像**，这与"不编造"是同一条纪律。
    const spLine = speakerLine({ chatKey: session?.key, userId: evt.user_id }, readProfiles());
    if (spLine) {
      volatileSec.lines.push(`跟你说话的这个人：${spLine}。跟着 TA 的节奏来，别自顾自说。`);
    }
    // ── D11b·④：跨轮工作记忆（"刚才进行到哪"）──
    // 位置：必变段内部、**当前时间之前**。三条一起看，缺一会退步：
    //   ① 它每轮都可能变（换一轮就多一条、"约 N 分钟前"也在动），所以它属于必变信息，
    //      放进稳定段等于每轮白作废一次前缀缓存；
    //   ② 放在**时间行之前**而不是之后：时间行精确到秒、每轮必变，公共前缀
    //      本来就在它那里断开 —— 所以这一段放它前面还是后面，缓存上没有差别，
    //      但放前面能让 system 的**末尾两行**仍然是「时间 + 场景」
    //      （`checkVolatileTail` 那条结构断言盯的正是这个形状，不必为它开口子）；
    //   ③ 它挂在永不砍的 volatile 段里（NEVER_DROP），所以字符上限必须由它自己管
    //      —— 判据在 `renderWorking`（≤160 字符，含标题行）。
    // 没有可交代的东西时返回空串 → 提示词**一个字都不多**
    // （真机基线 2026-09-27 实测：system 段中位 4431 字符、必变尾段中位 82 字符）。
    const workLine = renderWorking(session?.workingTurns, { now });
    if (workLine) volatileSec.lines.push(workLine);
    // ── D-M3 · 按需回忆（"你还记得吗"）──────────────────────────────────────
    // 位置：必变段内部、**当前时间之前**（与上面两条同一条理由：它每轮都可能变，
    // 放进稳定段等于每轮白作废一次前缀缓存）。
    // ⚠️ 只有**这一轮问得出回忆意图**才去捞（`wantsRecall`），零额外模型调用 ——
    //    每轮全量检索既浪费、又会把无关旧事塞进提示词。
    // ⚠️ 检索**不算复证**（`samples` 一条都不加）、不落盘、不改状态。
    //    用户问"你还记得吗"，答"不太确定，好像是…"比答"我不记得"更接近真人。
    // ⚠️ `opts.recallQuery` 是**测试注入口**（OPS-FIXTURE 的同一条纪律：
    //    判据不硬读现场，否则测它就得先造一整轮真实聊天）。
    const recallQ = opts.recallQuery !== undefined
      ? String(opts.recallQuery || '')
      : triggerTextOf(parsed);
    const recalled = recallQ && wantsRecall(recallQ)
      ? recallForPrompt(recallQ, { chatKey: session?.key, now, max: RECALL_MAX })
      : { lines: [], hits: [], scanned: 0 };
    if (recalled.lines.length) {
      // 口气很重要：这些是**翻出来的**旧记录，不是"你现在记得的事"。
      // 少了这句，模型会把它当常驻事实宣示（"我记得你…"）。
      volatileSec.lines.push('## 你刚想起来的事（翻出来的旧记录，随口提一句就好）');
      volatileSec.lines.push(...recalled.lines);
    }
    // ── D31-3 · 作息状态行 ──────────────────────────────────────────────
    // 位置：必变段内部、**当前时间之前**（与上面工作记忆行同一条理由：
    // system 的末尾两行必须仍是「时间 + 场景」，`checkVolatileTail` 盯的正是这个形状）。
    //
    // ⚠️ 作息总闸**关着时一个字都不加**（`restLineOf` 返回空串）——
    //    默认配置下的提示词必须与改动前**逐字相同**（有断言钉着，见 smoke T44）。
    // ⚠️ 文案是**状态**，不是指令：只说它现在是什么状态（犯困 / 刚醒 / 被整醒），
    //    不说"你应该怎么回答" —— 后者是人格文件的地盘，挤进来会让两者互相打架。
    const restLine = restLineOf(opts.sleep, { now });
    if (restLine) volatileSec.lines.push(restLine);
    // ── 关系温度（2026-10-22 · DeepSleep 移植）─────────────────────────────
    // 只加**状态行**；满温/无快照时调用方传空串 ⇒ 默认提示词逐字不变。
    // 位置在必变段内部、当前时间之前（与作息行同一条理由：system 末尾两行仍是时间+场景）。
    if (opts.heatLine) volatileSec.lines.push(String(opts.heatLine));
    // ── D31-3 · 刚起床补看（只有补看轮才有）─────────────────────────────
    // 补看轮回的是一条**几小时前的**消息，不给这句话，模型会当成"刚发生的"来接，
    // 或者反过来开始道歉"我刚才没看手机" —— 那不是人，那是客服。
    if (opts.catchUp) volatileSec.lines.push(CATCHUP_LINE);
    if (opts.patrol) volatileSec.lines.push(PATROL_LINE);
    volatileSec.lines.push(`当前时间：${new Date(now).toLocaleString('zh-CN', { hour12: false })}`);
    volatileSec.lines.push(
      evt.message_type === 'group'
        ? `场景：QQ 群（群号 ${evt.group_id}）。群里不止你们两个人，说话要像群友闲聊。`
        : `场景：与某人的 QQ 私聊。`
    );

    // ── 分段覆盖（2026-10-25 · 「系统提示词」页）──
    // 只覆盖**这一段自己的文字**，不改变分段顺序 / 预算 / 永不砍清单。
    // 关闭中的段（MBTI / 彩蛋 / 扮演规则）即使存着旧覆盖也不复活 ——
    // 否则用户关了开关却发现它还在提示词里，开关就成了假的。
    for (const s of sections) {
      if (s.id === 'mbti' && custom.mbti?.on !== true) continue;
      if (s.id === 'astro' && custom.astroOn !== true) continue;
      if (s.id === 'rules' && custom.playRules === false) continue;
      if (s.id === 'mood' && custom.moodOn === false) continue;
      applySectionOverride(s, custom.promptSections);
    }

    // ── 预算淘汰（B10f-1 · C-BUDGET）──
    // 预算内 = 与改造前逐字一致；超了按 EVICTION_ORDER 砍（人格最后一道、
    // 身份/隔离声明/必变段永不砍），砍掉的留进 dropped 交给调用方落 trace。
    //
    // D8：花费进 trim 档时多带一个 `drop: SAVING_DROP`（只整段拿掉 ambient / skills）。
    // 走的仍是**同一个** `applyBudget` —— 没有第二套淘汰实现，也不会出现
    // "哪一份清单说了算"的问题（两份清单漂移的表现是它偶尔忘掉一整个背景段）。
    const budget = budgetOf(this.cfg.context?.budget);
    const fitted = applyBudget(sections, budget, opts.saving ? { drop: SAVING_DROP } : {});

    // ── 历史段：锚定窗口（2026-10-23 · 回迁维护者补丁）──
    // 以前是 `slice(-recentTurns)` 再 `fitHistory`：窗口第一格每轮都在滑，
    // 请求前缀跟着每轮变，服务商的前缀缓存每轮作废（费用问题，不是功能问题）。
    // 现在由 `anchorHistory` 一起算「条数 + 字符」并把起点按 6 条粒度跳；
    // `recentTurns` 仍是**按档位收窄**过的那份（D9a），逐字不变。
    const histFit = anchorHistory(session.history, budget, {
      recentTurns: limits.recentTurns,
      // 显式传粒度：与导出的 `HIST_ANCHOR` 同一个来源，不在这里再写一个 6。
      step: HIST_ANCHOR.step,
    });

    // 注意：只能有「一条」system 消息，且必须在最前。
    // 部分推理后端（mlx_lm / Qwen 的 chat template）遇到第二条 system 会直接
    // 报 404 "System message must be at the beginning."，所以背景信息要并进来。
    const messages = [{ role: 'system', content: fitted.lines.join('\n') }];

    for (const m of histFit.items) {
      messages.push({ role: m.role, content: m.content });
    }

    const speaker = evt.sender?.card || evt.sender?.nickname || `用户${evt.user_id}`;
    const text = renderSpeakerLine(speaker, parsed.text);

    // 开了识图、且当前模型真的看得懂图，才把图片一起发给模型（最多 3 张，避免上下文炸掉）。
    // 这里用 supportsVision 做第一道闸：纯文本模型组了图也会被 llm 层剥掉，
    // 白白多下载一次图片、多占上下文，所以干脆不组。
    // ⚠️ 必须把 provider 一起传进去：本机是目录路径、云端是模型 id，
    //    同一个模型名在不同服务商下的能力未必一样（能力表按服务商分桶）。
    // ⚠️ 也必须把 `declaredFeatures` 传进去（2026-10-12 修）：自定义大脑的能力**只在声明里**，
    //    不传的话这道闸会把它永远判成"看不见"——用户勾了"能看图"，图片在这里就被剥成
    //    `[图片]`，而配置页那边说"支持"。同一件事两套口径，用户没法自证是哪边错。
    const canSee = supportsVision(this.cfg.llm?.model, this.cfg.llm?.provider, this.cfg.llm?.declaredFeatures)
      && this.cfg.llm?.features?.vision;
    const imgs = canSee && Array.isArray(parsed.images)
      ? parsed.images.filter(Boolean).slice(0, 3)
      : [];

    if (imgs.length) {
      messages.push({
        role: 'user',
        content: [
          ...imgs.map((u) => ({ type: 'image_url', image_url: { url: u } })),
          { type: 'text', text },
        ],
      });
    } else {
      messages.push({ role: 'user', content: text });
    }
    return {
      messages,
      dropped: fitted.dropped.concat(histFit.dropped),
      // 锚点信息只给 trace / 测试用，不进提示词。没有它，"这轮为什么只带了 17 条"
      // 只能靠猜；有了它就能直接看出窗口起点是不是按 6 条粒度跳的。
      historyAnchor: histFit.anchor,
      ambient: { count: ambientPick.entries.length, refreshed: ambientPick.refreshed },
      // D11a：这一轮**记忆没提什么**。带出去给 trace 落痕 ——
      // 只在函数内部算、不往外传的话，"它怎么突然不提那件事了"就查不出来
      // （而淡忘与超预算的处置完全不同：一个本就不该提，一个该调预算）。
      memory: {
        droppedStale: memSel.droppedStale,
        droppedBudget: memSel.droppedBudget,
        used: records.length,
        // D-M3：这一轮**按需回忆**捞到了什么（没触发就是空数组）。
        // 不带出去的话，「它记着却没提」与「它根本没捞到」在界面上同形 ——
        // 而这正是"静默失效"那一类最难查的形态。
        recalled: recalled.lines,
      },
    };
  }

  /**
   * 把模型输出解析成要发送的分段。
   *
   * 返回 `{ silent, chunks, blocked, internal }`：
   *   · `chunks.length === 0` 或 `silent` → 不发；
   *   · `blocked` 非空（B8 · S-EGRESS）→ 出口闸门命中，`chunks` 已清空，
   *     调用方**必须**把 `blocked` 记进日志与 trace —— 拦了不留痕就是静默失效。
   *   · `internal` 非空（B33）→ 模型复读了内部标记，那些标记**已从 `chunks` 里剥掉**；
   *     调用方**必须**把它记进日志与 trace（同为"拦了不留痕"那一条）。
   */
  parseReply(raw) {
    const text = stripThink(String(raw ?? '').trim());
    if (!text) return { silent: true, chunks: [], internal: [] };
    if (text === SILENT || text.startsWith(`${SILENT}`)) return { silent: true, chunks: [], internal: [] };

    const { splitToken, maxChunks, maxCharsPerChunk } = this.cfg.reply;
    const safety = this.cfg.custom?.safety || {};
    // ⚠️ 空 token **绝不能**进正则（2026-10-09 · 第 53 轮 · B4）：
    //    `new RegExp('|\\n+')` 会在**每个字符之间**都匹配 ⇒ `split` 把整段回复切成单字
    //    （实测 `"今天天气"` → `["今","天","天","气"]`），群里的表现是「一个字一个字地发」。
    //    空 token 的语义定为「只按换行分条」—— 不丢功能，只是少一个分隔符。
    const token = typeof splitToken === 'string' ? splitToken : '';
    if (!token.trim()) warnSplitTokenOnce();
    const splitter = token.trim() ? new RegExp(`${escapeRe(token)}|\\n+`) : /\n+/;
    let chunks = text
      .split(splitter)
      .map((s) => s.trim().replace(/^["“”']|["“”']$/g, '').trim())
      // 小模型经常把 [SILENT] 混在中间某一段里输出，混进来就整段丢掉，
      // 否则群里会真的冒出一句「[SILENT] 上班被骂确实烦…」
      .map((s) => (s.includes(SILENT) ? s.replace(new RegExp(escapeRe(SILENT), 'g'), '').trim() : s))
      // 表情能力已于 2026-10-17 下线（维护者：它只会发那几个黄豆脸）。
      // 这里**无条件**剥掉残留标记 —— 历史记忆与旧会话存档里还留着 `[face:14]`，
      // 模型自己也会凭惯性写；不剥就会原样发进群里。
      .map((s) => stripFaceMarks(s))
      .filter(Boolean);

    // ── 工作台「安全设置」的三道过滤 ──
    // 顺序有讲究：先过滤链接（它可能正好是敏感词的一部分），再判敏感词。
    if (safety.filterLinks) chunks = chunks.map(stripLinks).filter(Boolean);
    if (Array.isArray(safety.banned) && safety.banned.length) {
      const hit = (s) => safety.banned.find((w) => w && s.includes(w));
      chunks = chunks.map((s) => {
        const w = hit(s);
        if (!w) return s;
        // 只命中敏感词的**那一段**丢掉，不是整条回复丢掉 ——
        // 整条丢会让机器人"突然哑掉"，比说出半句更难查。
        log.warn(`回复命中敏感词「${w}」，已丢弃这一段`);
        return '';
      }).filter(Boolean);
    }

    // ── 内部标记清洗（B33 · 防「模型复读内部状态」外泄）──
    // 历史里那几句批注（「本轮没有接话」「被出口闸门拦下」…）是**以 assistant 角色**
    // 喂给模型的 —— 于是它会把批注当成"我说过的话"照抄出来。真机实测（不是推测）：
    //   2026-10-04 10:27:03 · traceId 30253c4c23bc · 群 100000003（真机白名单群之一）
    //     raw = `[这次没有接话]` → chunks 放行 → 真发进群
    // 口径：**剥掉标记、其余照发**。与出口闸门对凭据的"整条不发"**刻意分开** ——
    // 这里泄的只是自家批注，没必要连它本来要说的话一起吞掉（那会变成"它突然哑了"）。
    // 剥完为空 = 它这一轮其实没话说（实测正是这个形态），由下面的 `silent` 收口。
    // 剥的是标记的**词干**（含改文案之前的旧措辞），外壳换成什么都拦得住 —— 见该模块头。
    const internalRaw = [];
    chunks = chunks
      .map((s) => {
        const cleaned = stripInternalMarks(s);
        // ⚠️ 判据是"**真的剥掉了**"，不是"扫到了词干"：`没有接话` 是唯一可能落在
        //    正常中文里的宽词干（「这事没有接话的必要」）——那种句子 strip 完一字未改，
        //    不该在 trace 里记成一次"它复读了内部标记"（日志只记真的发生过的事）。
        if (cleaned === s) return s;
        internalRaw.push(...scanInternalMarks(s));
        return cleaned;
      })
      .filter(Boolean);
    const internal = [...new Set(internalRaw)];

    // 防刷屏：正常最多 reply.maxChunks 条，开了防刷屏压到「最多几段」那个声明值
    // （数值在 src/field-schema.js 的 antiFloodChunks，面板上的「最多 N 段」显示同一份）
    const cap = safety.antiFlood ? Math.min(maxChunks, numDefault('antiFloodChunks')) : maxChunks;
    chunks = chunks.slice(0, cap).map((c) => hardWrap(c, maxCharsPerChunk));

    // ── 出口闸门（B8 · S-EGRESS）──
    // 上面那三道只在**段落**级别过滤，丢的是"敏感词所在的这一段"。凭据和本机路径
    // 不属于敏感词：模型一旦把自己家的绝对路径或一个 API Key 说出来，**整条**都不该发
    // （丢一段留一段，剩下的半句照样把上下文泄了）。
    //
    // 命中就把 chunks 清空并**把原因交回调用方**去记日志与 trace ——
    // 这里不自己打日志：没有会话上下文，报了也不知道是哪一轮。而"静默拦掉"
    // 正是本项目最怕的失败模式（用户只看到"它突然不理我"）。
    const blocked = scanEgress(chunks.join('\n'));
    if (blocked) return { silent: true, chunks: [], blocked, internal };

    return { silent: chunks.length === 0, chunks, internal };
  }

  /**
   * 结构化记忆这一轮**选了什么、又漏掉了什么**（D11a）。
   *
   * 为什么单独开一个入口（而不是让 `memoryInPrompt` 顺手多返回几个字段）：
   * `memoryInPrompt` 的返回值被面板与 trace 当"注入了哪几条"直接消费，
   * 改它的形状会波及那两处；而"截掉了什么"只有**组提示词的那一处**需要。
   * 于是：`memoryInPrompt` 继续回数组、委托给这里；组提示词时用完整形状。
   *
   * ⚠️ `recordsForPrompt`（→ `selectForPrompt`）的**唯一消费点在这里** ——
   *    改造前它在 `memoryInPrompt` 体内，但它拿不到 `droppedStale / droppedBudget`，
   *    "淡忘了"与"装不下"就分不开（两种处置完全不同）。
   */
  memorySelection(ctx) {
    const custom = this.cfg.custom || {};
    // 手动记忆由 activeManualMemory 按 custom.memory.promptMax 封顶
    //（默认 12，见 field-schema 的 memoryPromptMax）。
    // 面板报出去的也只是**实际注入的这几条**，
    // 不是"用户填了多少条" —— 否则又变成把没发生的事说成发生了。
    const manual = activeManualMemory(custom).map((m) => ({ kind: 'manual', text: m.text }));
    const auto = custom.memory?.auto
      ? autoMemoryForPrompt().map((m) => ({ kind: 'auto', text: m.text }))
      : [];
    // ── 结构化记忆（ATI-3）**同样是"这一刻真的注入了"的一份** ──
    // ⚠️ 它必须出现（而不是只算结构化那部分），否则 `memoryUsed` 会**漏报**：
    //    真机实测（2026-09-23）—— 一条已复证的结构化记忆明明进了提示词
    //    （在完整 prompt 里搜得到），而 `memoryUsed` 里只有旧的 auto 存量；
    //    面板与复盘窗口看到的是"新记忆没生效"，**与事实相反**。
    // ⚠️ 它需要 `ctx`（`{chatKey, userId}`）才选得出来 —— 结构化记忆是**按会话隔离**的。
    //    没有 ctx 就返回空（无参调用仍然是"手动 + 自动"那份老语义，向后兼容）。
    const sel = ctx
      ? recordsForPrompt(ctx)
      : { lines: [], picked: [], dropped: 0, droppedStale: 0, droppedBudget: 0 };
    return {
      manual,
      auto,
      records: sel.lines.map((line) => ({ kind: 'record', text: line })),
      // 这一轮"漏掉了什么"。落进 trace —— 静默失效是本项目最怕的失败模式。
      droppedStale: sel.droppedStale || 0,
      droppedBudget: sel.droppedBudget || 0,
    };
  }

  /**
   * 这一次真正被塞进提示词的记忆条目。
   *
   * 面板要如实显示"给了它哪几条"，**不能**假装知道"它用了哪条" ——
   * 记忆是跟人格一起塞进 system 提示词的，模型不会回报"我参考了第 3 条"。
   * 把可观测的东西（注入了什么）说成不可观测的东西（用了什么），
   * 就是在编数据；报错的时候用户会被这个假信息带偏。
   */
  memoryInPrompt(ctx) {
    const s = this.memorySelection(ctx);
    return [...s.manual, ...s.auto, ...s.records];
  }

  /**
   * 这一次真正被注入提示词的技能。
   *
   * 和 memoryInPrompt 同一个规矩：面板只能如实显示**给了它什么**，
   * 不能假装知道"它用了哪条"。技能的命中是确定的（开关 + 范围 + 触发词），
   * 所以这里报出去的东西是可以逐条对上的 —— 排查时能直接判断
   * "是不是那条技能把语气带跑了"。
   *
   * @param {object} evt OneBot 事件（取群号 / 用户号做范围匹配）
   * @param {{text:string}} parsed 这一轮群友说的话（用来判触发词）
   */
  skillsInPrompt(evt, parsed) {
    const custom = this.cfg.custom || {};
    return pickSkillsForPrompt(
      custom.skills,
      { groupId: evt?.group_id, userId: evt?.user_id },
      parsed?.text,
      // 预算由配置面送入（2026-10-23 可配）；缺省由 skills.js 回落常量。
      { max: custom.skillPrompt?.max, chars: custom.skillPrompt?.chars }
    );
  }

  /**
   * 这一轮生效的角色卡（`custom.skills` 里 `kind:'persona'` 的那张）。
   * 判据全在 `src/skills.js` 的 `pickPersonaCard`（纯函数、可单测）。
   */
  personaCardFor(evt) {
    return pickPersonaCard(this.cfg.custom?.skills, {
      groupId: evt?.group_id, userId: evt?.user_id,
    });
  }

  /**
   * 这一轮记忆该落在哪个作用域（`card:<卡 id>` 或原会话键）。
   * ⚠️ 读写必须用**同一个**键：写进 `card:x`、读却按 `群:y` 过滤，
   * 表现就是「它一个字都不记得」—— 而且日志里什么都看不出来。
   */
  memoryKeyFor(evt, session, card = null) {
    return memoryScopeOf(session?.key, (card || this.personaCardFor(evt))?.id);
  }

  /**
   * 角色卡切换时清掉该会话里**旧卡说过的话**（保留用户侧，保住"在聊什么"）。
   * 对方把这件事故意留成已知限制（全局指纹管不到按群的卡），这里补上：
   * 否则在面板上给某个群换卡，旧口吻会一直残留到 12 轮历史自然挤掉。
   */
  syncCard(session, evt) {
    if (!session) return null;
    const card = this.personaCardFor(evt);
    const id = card?.id || '';
    if (session.cardId !== id) {
      const before = Array.isArray(session.history) ? session.history.length : 0;
      if (before) session.history = session.history.filter((m) => m.role !== 'assistant');
      session.cardId = id;
      const dropped = before - (Array.isArray(session.history) ? session.history.length : 0);
      if (dropped) log.info(`角色卡切换（${session.key}）→ 丢弃 ${dropped} 条旧卡发言（避免继续模仿旧口吻）`);
    }
    return card;
  }

  remember(session, role, content) {
    session.history.push({ role, content });
    // ⚠️ 这里用**全局** recentTurns，不是档位收窄后的那份（D9a）——
    //    「留多少」与「带多少」是两件事：按档位收窄等于"插话一多，历史就不留了"，
    //    那是把缓存容量当成了显示窗口，下一轮带满历史时会发现中间空了一截。
    // 2026-10-23：改**批量回收**（维护者补丁 4）。以前每条超 cap 就 splice 一条 →
    // 存下来的历史本身每轮滑一格，就算带上来的窗口锚定了，内容照样往前挪。
    // 现在涨到 HIGH 才一次砍回 LOW：两次回收之间历史只追加不删除，前缀连续多轮不变。
    const high = this.cfg.context.recentTurns * 2;
    const low = this.cfg.context.recentTurns;
    if (session.history.length >= high) session.history.splice(0, session.history.length - low);
  }

  /**
   * 记一条背景消息。
   *
   * @param {object} session
   * @param {string} speaker 展示名（群名片 > 昵称 > 兜底）
   * @param {string} text
   * @param {string|number} [userId] QQ 号。**只有判官要用它**（D-M1：给发言人一个
   *   身份号，它才能回答"这条记忆是关于谁的"）。提示词里的背景消息段**不带**它 ——
   *   `pickAmbient` 渲染的仍是 `名字: 正文`，一个字都没变。
   */
  rememberAmbient(session, speaker, text, userId = '') {
    // ⚠️ 同上：容量读全局 ambientMessages，与这一轮的档位无关。
    const cap = this.cfg.context.ambientMessages * 2;
    // 每条给一个自增 id：C-AMBIENT 的"粘性"要认得出来"上一条还是不是这一条"。
    // 只靠下标不行 —— 窗口每滑一次下标就全变了，粘性会永远失配。
    // 存档恢复回来的条目没有 id，由 pickAmbient 里的 ensureIds 补（幂等）。
    // `at` 是巡逻的唯一时间依据（存档会把它剥掉；旧条目因此不被巡逻误读）。
    session.ambientSeq = (Number.isFinite(session.ambientSeq) ? session.ambientSeq : 0) + 1;
    session.ambient.push({ id: session.ambientSeq, speaker, text, userId: String(userId || ''), at: Date.now() });
    if (session.ambient.length > cap) session.ambient.splice(0, session.ambient.length - cap);
  }

  /**
   * 这一次要不要限流。返回**原因字符串**表示不许发，`null` 表示放行。
   *
   * 两层窗口，缺一不可：
   *   · 分钟级 —— 防"一条消息触发两轮回复"这种偶发重复；
   *   · 小时级（B8 · S-HOUR）—— 只看分钟级的话，8 条/分钟 × 60 = 理论上限
   *     **480 条/小时**，这个数字对"别让账号看起来像机器"毫无约束力。
   *
   * 返回原因而不是抛错是刻意的：限流是**正常状态**，不是异常。抛错会把
   * "它这轮没接话"变成一条错误日志，反而更难查；而静默跳过又会让用户以为它坏了。
   * 所以调用方拿到原因字符串就跳过，并**把它写进日志** —— 见 src/index.js 与
   * src/proactive.js 的两个调用点。
   */
  throttleReason(session, now = Date.now(), { kind = '' } = {}) {
    const { minIntervalMs, perMinutePerSession, perHourPerSession } = this.cfg.throttle;
    if (now - session.lastReplyAt < minIntervalMs) return `距上次回复不足 ${minIntervalMs}ms`;
    // 记录**保留一小时**：分钟窗口要从这里面再筛一次，小时窗口直接看长度。
    // 以前这里只留 60 秒就丢掉，于是"这个会话一小时发了多少条"这个问题
    // **在数据结构上根本无法回答** —— 不是算错，是压根没存。
    session.recentReplies = session.recentReplies.filter((t) => now - t < 3600000);
    const lastMinute = session.recentReplies.filter((t) => now - t < 60000).length;
    if (lastMinute >= perMinutePerSession) return `本会话一分钟内已回复 ${lastMinute} 次`;
    // 直呼类（私聊 / @ / 叫名字 / 关键词）**不受小时上限**：它是用户点名要的回复，
    // 被"今天配额用完了"静默拦掉，表现就是"它明明在线却不理我"。
    // 但分钟级与 1.5 秒防抖仍生效 —— 那两道防的是瞬时刷屏，不是总量。
    // `markReplied` 照旧记录所有出口：直呼回复仍占小时额度，会让后续随机插话更早停下。
    const direct = kind === 'private' || kind === 'named' || kind === 'keyword';
    if (!direct && session.recentReplies.length >= perHourPerSession) {
      return `本会话一小时内已回复 ${session.recentReplies.length} 次（上限 ${perHourPerSession}，直呼类不受此限）`;
    }
    return null;
  }

  /**
   * D12b：记一笔"这个会话最后一次有人说话"的时刻（冷场判据的唯一数据来源）。
   *
   * ⚠️ **必须在 `decide()` 之后调用**：判定要读的是"这条消息**之前**已经沉默了多久"，
   *    先推进再判，冷场时长恒为 0 —— 那个因子就成了永远为假的死代码
   *    （契约 §41 用源码顺序钉着这一点，光看调用点看不出来）。
   *
   * ⚠️ 拍一拍合成的那条**不算"话"**（D9b 的既有口径：它不进背景段、不进风格统计），
   *    所以调用方对 `isPoke` 要跳过 —— 否则一次拍一拍会把冷场计时清零。
   */
  noteSeen(session, now = Date.now()) {
    if (session) session.lastMsgAt = now;
  }

  markReplied(session, now = Date.now()) {
    session.lastReplyAt = now;
    session.recentReplies.push(now);
  }
}

/**
 * 放行类判定。
 *
 * ⚠️ `kind` 是**稳定枚举**，`reason` 是**给人看的文案** —— 两者刻意分开（D9a）。
 * 改造前调用方拿 `reason` 当中文枚举用（`decision.reason === '随机插话'` 这种），
 * 于是"改一个字的文案"会静默改掉分支。现在分支与档位都认 `kind`。
 * `tier` 由 `TIER_OF_KIND` **唯一映射**给出，不在这里现算。
 */
function ok(kind, reason, interject) {
  const r = { respond: true, kind, tier: tierOfKind(kind), reason };
  // D12b：只有插话那一支会带上 `interject`（概率与它的来路）。
  // 用条件附加而不是恒给 null：其余分支的返回形状**逐字不变**，
  // 免得"多了一个值为 null 的键"被当成形状变化而牵动别的断言。
  if (interject) r.interject = interject;
  return r;
}
/**
 * 把角色卡的 24 项快照压到全局人格/增强上：**只覆盖非空项**。
 * 卡里没填的字段沿用全局设定 —— 这是"卡只换一部分人设"也能工作的前提。
 */
function mergeCardFields(base, card, keys) {
  const out = { ...(base || {}) };
  const fields = card?.fields && typeof card.fields === 'object' ? card.fields : {};
  for (const k of keys) {
    const v = fields[k];
    if (typeof v === 'string' && v.trim()) out[k] = v;
  }
  return out;
}

function deny_(reason, interject) {
  const r = { respond: false, reason };
  if (interject) r.interject = interject;
  return r;
}

// SILENT 只在模块内部使用（提示词里教模型输出它、解析时识别它），
// 不对外导出 —— 外部不该知道"沉默"是怎么实现的。
