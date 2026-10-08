import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { loadConfig, DATA_DIR } from './config.js';
import { OneBotClient, flattenMessage, textSegment, atSegment, replySegment, faceSegment, imageSegment, triggerTextOf } from './onebot.js';
import { LlmClient } from './llm.js';
import { supportsVision } from './model-caps.js';
import {
  Brain, SessionStore, splitFaceMarks, classifySegments, capImageSegments, IMAGE_CAP_PER_RUN, hasFaceMark, stripFaceMarks,
  renderSpeakerLine, lateSendReason,
} from './brain.js';
import { MemoryKeeper } from './memory.js';
// 表达规范观测（ATI-1）：**只记录、不拦截**（判据与词表住在 speech-rules，
// 提示词侧也引同一份 —— 两边各写一份必然漂移）。
import { scanSpeech } from './speech-rules.js';
// B33：内部标记（历史里那四句系统批注）的**唯一出处**在这儿 —— 本文件的四处
// `remember(...)` 与 `sayToGroup` 的出口都从它取。理由与出口闸门同一句话：
// 文案与判据各写两份，改了文案忘了改词干 = 闸门**静默失效**（真机已经泄过一次）。
import { INTERNAL_MARKS, stripInternalMarks } from './internal-marks.js';
// 说话风格画像（ATI-2）：采集侧在这里，提示词侧在 brain.js，判据住在 style-profile。
// ⚠️ `flushProfiles` 是**退出路径**上的一次补写（与 `flushArchive` 并排，见 `shutdown()`）：
//    它和存档一样有 30 秒防抖窗口，不补就等于"最后 30 秒的统计白采了"。
//    2026-10-01 清理轮定位：这个导出一直存在、注释也写着"进程退出前用"，但**全仓 0 调用**
//    —— 死导出在这里的真实含义是**漏接线**（对照面：存档那条做了）。
import { observeAndStore, flushProfiles } from './style-profile.js';
// 表情习惯（ATI-4）：判据在 face-habit（纯函数），这里只做**一次**接线。
import { faceDecision, applyFaceMark, createFaceMemory } from './face-habit.js';
import { FACE_PRESETS } from './custom-config.js';
// 收藏表情（D14 · 报告 E12 · 用户 Q5 翻案）：判据全在 custom-faces（零依赖叶子），
// 这里只做**两类接线** —— ① 定时拉一次只读列表 ② 出站把令牌分流成图片段。
// ⚠️ **只读**：一个写动作（add / delete / set_desc）都不调（用户 Q15 的裁决）。
import {
  CUSTOM_FACE_FETCH_COUNT, CUSTOM_FACE_REFRESH_MS,
  parseFaceUrls, customFaceEntries, shouldUseCustom, pickCustomFace,
} from './custom-faces.js';
// 用量账本：记录（一直有）+ **判档**（D8 新增，见文件内 `usageGateOf`）。
// 判据（纯函数）住在 src/usage.js，这里只做**一处接线**与一次入参传递。
import { recordUsage, usageGateOf, USAGE_SOURCES } from './usage.js';
// D31-1 · 睡眠（判据全在 `sleep.js`，零依赖叶子、`now` 入参）：计划 → 状态 → 迁移留痕。
// D31-2 加了第二条叫醒路：判据（连发窗口 / 叫醒词 / 身份 / 收尾）也全在那个叶子里，
// 这里只做**接线** —— 唯一门禁点之前一次"要不要叫醒"、唯一判定点里一次"到点收尾"。
import {
  planOf, statusOf, transitionOf, normalizeSleepState, SLEEP_STATUS,
  isOwner, wakeTriggerOf, wakePromotionOf, settleOverrideOf, overrideOf, EMERGENCY_QUIET_MS,
  // D31-3：起床补看的挑选取舍（纯函数、零模型调用）—— 判据仍在同一个叶子里。
  catchUpPlanOf, CATCHUP_MAX,
  // Q11：入睡前自己说一句晚安（判据与文案默认值都在叶子里的同一节）。
  goodnightOf, goodnightTargetOf, GOODNIGHT_DEFAULT,
} from './sleep.js';
// 上下文超长时的收缩实现（D8）：纯函数，作为 `shrink` 入参交给 llm 的重试链。
// ⚠️ 它**不在 llm.js 里**：历史该砍谁只有上层知道，在 llm 层猜必然猜错。
import { shrinkHistory } from './context-budget.js';
import { sendDelayFor } from './pace.js';
// 未读模型（D30 · Wave 4）：判据全在 unread.js（零依赖叶子，纯函数、`now` 入参），
// 这里只做**两处接线** —— `decide()` **之前**记一条、**之后**按 id 消费一条。
// ⚠️ 叶子**没有**"无参清空"形态：消费必须给 id 列表（这就是"禁 markAllRead"的落点）。
import { unreadEntryOf, pushUnread, pendingOf, consume } from './unread.js';

// 自己发出去的消息 id（M-4 · 2026-10-04 审查轮）：让「引用了我的话」真的算「被叫到」。
// ⚠️ 唯一写入点 = 发送成功之后那处 `noteSelfSent`；唯一读取点 = `decide()` 之前那处
//    `isReplyToSelf`。叶子零依赖、纯函数，状态由本文件持有（见 reply-track.js 的三条纪律）。
import { noteSelfSent, isReplyToSelf, messageIdsOf } from './reply-track.js';

/**
 * 我最近发出去的消息 id（新→旧，有界）。
 *
 * ⚠️ **只进内存、不落盘**：重启后记不得旧 id 是**可接受**的降级（重启后第一条引用
 *    识别不出来，仅此而已）；落盘会带来"上一世的消息 id 被当成这一世"的更难查的问题。
 * ⚠️ 它是一个**进程级 `let`**（不是 `const` 数组 + push）—— 因为 `noteSelfSent`
 *    返回新数组，赋值动作在下面**恰一处**，便于契约数它。
 */
let selfSentIds = [];


// 合并转发展开（D23-2 · Wave 5）：判据与上限常量全在 forward-expand.js（零依赖叶子、纯函数），
// 这里只做**一处接线** —— 调一次 `get_forward_msg`，把渲染好的文本交给 flattenMessage。
// ⚠️ 渲染器**注入**进去（`renderNode`）：段 → 文本的唯一实现是 `flattenMessage`，
//    这里不许再写第二份（本项目头号禁忌）。
import {
  readForward, forwardSegmentsOf, forwardResIdOf, forwardNodesOf, nodeSegmentsOf, renderForwardText,
} from './forward-expand.js';
// 跨会话发言（D18 · 报告 E8）：判据（目标裁决 / 文本收敛 / 可见会话列表 / 渲染）全在
// cross-send.js（零依赖叶子、纯函数、`now` 与 `sessionOf` 入参）。
// ⚠️ 这里只做**两处接线**：① 启动时按开关注册两个宿主工具；② 出口走 `sayToGroup`。
//    叶子**不发消息、不判配额** —— 配额只有一个判据，在下面 `crossBlockReason` 里复用。
import {
  CROSS_TEXT_MAX, resolveCrossTarget, normalizeCrossText, crossChatsOf, renderCrossChats,
} from './cross-send.js';
// 主动出站的配额计划与「分句 + 出口闸门」判定（B8 · S-PROACTIVE / 第 49 轮复审）——
// 判定是纯函数（smoke T134 钉行为），这里只做接线
import { planProactiveSend, plannedProactiveChunks } from './proactive.js';
import {
  writeJsonAtomic, writeTextAtomic, truncateLinesAtomic, sweepStaleTemps,
  // [W1] 独占提交 / 独占替换 —— 关掉"读→判→写"之间的 TOCTOU 窗口
  linkExclusiveSync, reclaimExclusiveSync,
} from './atomic-write.js';
import { shouldClearStale } from './ephemeral.js';
import { setRuntimeSecrets, maskSecrets } from './egress.js';
import { createSessionControl, abortOutcome } from './session-control.js';
// 进程侧实例互斥锁 + 启动/崩溃留档（D19 · 报告 E19/E20）。判据全在 bridge-lock.js
// （零依赖叶子，IO / alive / isOurs 全部入参），这里只做**两处接线**：启动占锁、退出释放。
import {
  LOCK_HEARTBEAT_MS, LOCK_REFUSE_EXIT_CODE, JOURNAL_MAX_LINES,
  acquireLock, releaseLock, heartbeatLock, journalLineOf, pidAliveOf,
} from './bridge-lock.js';
// 「这个 pid 是不是本项目的机器人」——**判据一份都不重写**：直接用面板侧那三条
// （exec 是 node / argv 收尾是入口 / cwd 是本仓），这里只补"把这三个值取出来"的探测。
import { isOurBridge, parsePgrepLine, firstPathOf } from './bridge-proc.js';
// 面板 ↔ 机器人控制通道（D6b · 用户 Q7 裁决①「命令文件轮询」）。判据全在
// control-channel.js（零依赖叶子），这里只做**唯一接线点**：一次轮询 →
// 复用 D6 那两个具名动作（与 SIGUSR1/2 走的是同一份实现）。
import { CONTROL_POLL_MS, runControlStep } from './control-channel.js';
import {
  archiveOf, restoreInto, readArchive, writeArchive, DEFAULT_MAX_AGE_MS,
} from './session-archive.js';
import { newTraceId, imageRefsOf } from './trace-id.js';
import { recordSample, sampleOf } from './trace-stats.js';
import scoped from './logger.js';
import { loadExtensions, createExtensionHost, extensionRoots } from './plugin-host.js';
import { createToolRegistry } from './tool-registry.js';
import { createToolLoop } from './tool-loop.js';
import { createHookBus } from './hook-bus.js';
import { createSendGuard } from './send-guard.js';
import { scopedOnebot } from './ext-scope.js';
// notice 事件的标准化与合成（D9b · 报告 E7）。判据全在 src/notice.js（零依赖叶子），
// 这里只做**唯一接线点**：拍一拍走主链路、禁言与「/安静」只改会话上的两个到期时间戳。
// D31-3 的补看合成事件（`catchUpEventOf`）与拍一拍同一族、同一理由，所以住在一起。
import { normalizeNotice, pokeEventOf, catchUpEventOf, parseQuietCommand, quietUntilOf } from './notice.js';
// D11b·④：跨轮工作记忆的**收口**判据（TTL / 淡忘 / 封顶都在那个零依赖叶子里，这里只接线）
import { nextTurns } from './working-memory.js';
// D17 · 提醒三件套（报告 E9）。判据全在两个零依赖叶子里（`reminder.js` 管到期与重试窗、
// `holidays.js` 管"这天算上班还是休息"），这里只做**一处接线**：挂在既有的 30 秒 tick 与
// `tickProactive()` 上 —— ⚠️ 不许再开第二条调度（唯一入口表纪律）。
import {
  REMINDER_WINDOW_MS,
  dueMsOf, keyOf, phaseOf, matchesOn, dayKindAt, pruneReminderState,
} from './reminder.js';
// 本地日期键（`dayKeyOf`）与节假日表都从同一个零依赖叶子取 —— 第 13 轮 H-11：
// 日期键的唯一实现现在住在这里（`holidays.js`），`trace-stats` 不再自己导出一份。
import { normalizeHolidays, dayKeyOf } from './holidays.js';

// ── H-10 第 22 轮：写盘口那一族**整块搬出**（`src/bridge-io.js`）────────────
// 落盘常量（thinking / trace / journal）随实现一起走；这里只 import 回来。
// ⚠️ 判据的取源改指新家（`check-wb` 里那些 `read('../src/index.js')` 的段）。
import {
  THINKING_FILE, TRACE_FILE, TRACE_MAX, JOURNAL_FILE,
  journal, promptText, noteCacheSample, writeTrace, writeSkip, writeJudgeCard,
  noteUnread, consumeUnread, runQuiet, probeIsOurBridge, alive, truncate,
  markThinking, clearStaleThinking,
} from './bridge-io.js';

const log = scoped('bridge');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_FILE = process.env.QQBOT_CONFIG
  ? path.resolve(process.env.QQBOT_CONFIG)
  : path.join(ROOT, 'config.json');
// 把「机器人此刻真正在用的配置」写出来给面板看。
// 面板之前只能读 config.json，一旦用户改了但没重启，显示的和实际跑的就是两套，
// 这才有了「切了却没生效」「统计认错对象」这一串怪事。
// 与 trace / usage / 存档 / 留档同一套纪律（三件套第三件）：测试要能把这份运行时
// 快照指去临时目录。不指走的话，`node test/smoke.js` spawn 出来的那个真入口
// （mock 模型）会把 `model: mock-model` 的快照写进用户的 panel/effective.json ——
// 而 `since` 正是「改动有没有生效」的判据来源（见 §6.5），被测试写一脚会直接污染取证。
// 外包体检（ZCode 2026-09-27）发现这一处漏了 env 覆盖。
const EFFECTIVE_FILE = process.env.QQBOT_EFFECTIVE_FILE
  || path.join(ROOT, 'panel', 'effective.json');
// D14 · 收藏表情的只读缓存（**模块级**：`writeEffective` 也要读它，把"此刻认得几张"下发到面板）。
// 写它只有一处：`main()` 里的 `refreshCustomFaces()`。URL 只活在这里，不进任何落盘文件。
const customFaceCache = { urls: [], at: 0, error: '' };
// 「正在生成回复」的标记文件。本机模型一条要十几秒，
// 面板靠它显示进度，否则用户只能干等，以为机器人坏了。
//
// ⚠️ 与上面 `EFFECTIVE_FILE` / 下面 `TRACE_FILE` 同一条理由，**必须**能指走
//    （2026-10-01 代码审查补 · 本文件里**最后一条**没有 env 覆盖的落盘常量）。
//    根因：`test/smoke.js` 是 `spawn(node, ['src/index.js'], { cwd: ROOT })` ——
//    **cwd 就是真实仓库**，而收尾是 `child.kill('SIGKILL')`。没有这条覆盖时：
//      ① mock 对话的「正在生成」快照写进**用户真实的 `panel/.thinking.json`**；
//      ② SIGKILL 打断进行中的原子写 → 临时文件会**长期累积**（实测口径见 REVIEW-1002 Q208：
//         **单跑一次新增 0 个**；09-21 基线 6 个 → 10-01 累计 **168 个**，
//         是"跨多次运行 + 真机长期使用"积出来的，不是某一次跑出来的）。
//    这是同一类缺口的**第 4 次**（09-27 EFFECTIVE_FILE / USAGE · 09-30 STYLE_PROFILE ·
//    MEMORY_RECORDS / AUTO_MEMORY_FILE）—— 纪律：凡模块级落盘常量，
//    **要么有 env 覆盖，要么在注释里写明故意不覆盖的理由**。

// ── D6b · 面板 → 机器人 的命令文件（**控制通道的落盘那一头**）──────────────
// 面板写、机器人读并写回执行结果。为什么是文件而不是端口：用户 Q7 选① ——
// 本机进程一个监听口都不多开，代价是多一份落盘（三件套见 .gitignore /
// test/sandbox.sh / 下面这个 env 覆盖）。
// `QQBOT_CONTROL_FILE` 的第三件理由不只是"测试别污染真机"：`test/smoke.js` spawn 的
// 那个真入口与用户机器上的机器人**用同一个 panel/ 目录** —— 不指走的话，测试里
// 那条命令会原样躺在真机的命令文件里，等真机器人一起来就被执行（一次没人点过的中止）。
const CONTROL_FILE = process.env.QQBOT_CONTROL_FILE
  ? path.resolve(process.env.QQBOT_CONTROL_FILE)
  : path.join(ROOT, 'panel', '.bridge-cmd.json');

// ── D17 · 提醒的运行时状态（**故意不进 config.json**）────────────────────────
// `custom` 是**用户资产**，机器人进程高频写它迟早与面板互相覆盖（D11a 的教训：自动记忆
// 就是因此单独住的）。"这条今天发过了 / 错过了 / 这天不排"是**运行态**，另住一处。
// ⚠️ 新落盘文件 → 三件套：`.gitignore` / `test/sandbox.sh --exclude` / 下面这个 env 覆盖。
// 第三件的理由与别处同一条：`test/smoke.js` spawn 的真入口与真机器人用的是同一个
// panel 目录，不指走的话测试里那些"已发出 / 已错过"会混进用户真机的状态。
// ⚠️ 上面这句刻意写成"同一个 panel 目录"而不是"共用 panel 加两个星号"：扫描器先剥注释，
//    而"斜杠紧跟星号"会被当成块注释开头，一路吃到下一个块注释结尾，把中间的真实代码
//    整段吞掉（第 41 轮在别处踩过同一件事，表现是一组互不相关的契约同时假红）。
const REMINDER_FILE = process.env.QQBOT_REMINDER_FILE
  ? path.resolve(process.env.QQBOT_REMINDER_FILE)
  : path.join(ROOT, 'panel', 'reminder-state.json');

// ── D31-1 · 睡眠的运行时状态（**不进 config.json**）────────────────────────
//
// 为什么单独一个文件、而不是并进 `data/bot-state.json`：
//   那份文件是**扩展包**在读写（`plugins/本体情绪/lib/state.js`，自己 tmp+rename，
//   不走 `writeJsonAtomic`），而 `plugins/` 在 `.gitignore` 里（无版本、无回滚）。
//   `src/` 再往同一个文件里插一段 = **两个写入方互相覆盖**（D11a 的教训）。
//   所以 `src/` 自己管一份：谁写、谁读、形状由自己定，边界清楚。
//
// 路径由 `DATA_DIR` 推出（**目录级三件套已齐**：`.gitignore` 的 `/data/`、
// `test/sandbox.sh --exclude '/data/'`、`QQBOT_DATA_DIR` —— 见 `src/config.js`）。
// ⚠️ 别再写一份 env 覆盖：目录级那一件已经够了，多一个环境变量就多一处漂移面。
const SLEEP_FILE = path.join(DATA_DIR, 'sleep-state.json');
/** 读盘状态（**只有"上一次迁移"这一点信息**；此刻睡没睡一律由计划重算）。 */
let sleepState = normalizeSleepState(null);
/** 面板要读的快照。照 `extSnapshot` 先例：`writeEffective` 在模块级，看不到 cfg 与 store。 */
let sleepSnap = null;
/**
 * 主人**私聊**的连发计数窗口（D31-2）。**内存态**：不落盘。
 * 理由同 `unread.js` —— 它是"这几秒钟里发生了什么"，重启之后那一瞬间早就过去了，
 * 把它恢复出来只会让一个已经过期的新实例误判成"主人刚连发了两条"。
 */
let wakeBurst = { firstAt: 0, count: 0, byUserId: '' };
/** 被"等窗口"挂起的正式叫醒（`{at, byUserId, word}`）；过窗未连发满 → 兑现。同样是内存态。 */
let wakePending = null;
/**
 * 起床补看的**请求位**（D31 缺陷 Q33）。
 *
 * 为什么是"请求"而不是当场跑：`settleWake` 跑在 `refreshSleep` 里，而 `refreshSleep`
 * 还被**启动**与 `applyWake` 调用 —— 在"算一次状态"里顺手翻一遍积压、合成几条事件，
 * 等于让一个判定函数带上副作用（且启动那一次会在 store 还是空的时候跑一遍）。
 * 所以这里只置位，**真跑只有一处**：既有 30 秒 tick 的尾部（零新定时器）。
 *
 * 它补的那一处是什么：`settleWake` 的兑现分支产出的是 `kind:'owner'` —— 也就是
 * **正式起床**，与 `applyWake` 走的是同一条语义（D31-3「只有正式起床才补看」）。
 * 修之前，"同样是主人喊了一声"，有没有补看取决于 tick 与主人第二条消息谁先到。
 */
let catchUpRequested = false;
/**
 * 入睡前那句晚安的**请求位**（Q11 裁决②）。
 *
 * 与 `catchUpRequested` **同一条纪律**（同一条理由：置位发生在 `refreshSleep` 里，
 * 而它还被启动与 `applyWake` 调用；说话这种副作用不该挂在"算一次状态"上）。
 * 消费点同样只有一处：既有 30 秒 tick 的尾部（零新定时器）。
 *
 * ⚠️ 所以"到点"到"那句话说出来"之间最多隔一个 tick（≤30 秒）—— 与补看同款取舍，
 *    换来的是"零新定时器"这条更硬的约束不被破坏。
 */
let goodnightRequested = false;
/**
 * 面板「让它睡 / 叫它醒」的**手动入睡标记**（Q12 裁决①）。**内存态**：重启即失。
 *
 * 为什么不落盘：它是"我刚刚按了一下"这种一次性的现场指令，不是作息本身；
 * 落盘的话，一次重启之后"它还在睡"就变成了一个没有出处的状态（而 `status`
 * 不落盘正是本步最硬的那条纪律 —— 这里不许为它开口子）。
 */
let manualAsleep = false;

function loadSleepState() {
  try {
    sleepState = normalizeSleepState(JSON.parse(fs.readFileSync(SLEEP_FILE, 'utf8')));
  } catch {
    // 读不到 / 坏了 → 空态。**状态仍由计划重算**，所以这里最坏只是多打一行 journal，
    // 绝不会"因为一个附属文件坏了就永远睡着"（fail-safe 方向）。
    sleepState = normalizeSleepState(null);
  }
}

function saveSleepState() {
  try {
    // 原子写（与提醒状态同一套）。写的是**白名单形状**（`normalizeSleepState` 定死字段），
    // 所以这里不可能顺手把 `status` 之类"看起来方便"的东西写进去。
    writeJsonAtomic(SLEEP_FILE, sleepState, { mode: 0o600 });
  } catch {
    /* 附属文件：失败绝不能拖垮主流程（下一次 tick 还会再试） */
  }
}

// ── D19 · 机器人进程侧的实例互斥锁与启动/崩溃留档 ───────────────────────────
//
// 锁（`.bridge.lock`）：**机器人自己的"我在这里跑"**。与 `panel/.bridge.pid` 语义不同 ——
// 那个是"面板眼里的 pid"（面板写、面板删），这个是排他声明（谁都不能替别人删）。
// R13 补的是面板侧那一半（启动前扫残留、停止时杀全部），本步补的是**任何发起方**
// 都会被拦住的那一半：直接 `node src/index.js`、`.app` 的脚本、用户自己的终端都不经过面板。
//
// 留档（`bridge-journal.log`）：面板 spawn 时把 stdout/stderr 落 `bridge.log`，而且
// **每次启动都 'w' 截断** —— 于是"上一次为什么崩/为什么被拒"永远查不到。这个文件
// append-only + 折半截断，专门治"截断造成的不可回溯"。
//
// ⚠️ 两个 `QQBOT_*` 覆盖是**硬需求**（三件套第三件）：`test/smoke.js` 会 spawn 真入口，
//    不指走的话测试的子进程会去抢/删**真机**的锁与留档（锁被拒 → 测试红一片；
//    留档被折半 → 真机日志丢）。
const LOCK_FILE = process.env.QQBOT_BRIDGE_LOCK_FILE
  ? path.resolve(process.env.QQBOT_BRIDGE_LOCK_FILE)
  : path.join(ROOT, 'panel', '.bridge.lock');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const startedAt = Date.now();

function writeEffective(cfg) {
  try {
    // 原子写（B10a · O-ATOMIC）：机器人每 20 秒刷一次、面板每 3 秒读一次，
    // 原地覆盖的话面板偶尔会读到半个 JSON —— 表现为"某个字段短暂空白"，
    // 谁也不会往"写坏了"上想。rename 保证读侧要么看到旧的全份、要么看到新的全份。
    writeJsonAtomic(EFFECTIVE_FILE, {
      pid: process.pid,
      since: startedAt,
      alive: true,
      model: cfg.llm.model,
      baseUrl: cfg.llm.baseUrl,
      isLocal: cfg.llm.isLocal,
      fallbackModel: cfg.llm.fallbackModel || '',
      fallbackModels: cfg.llm.fallbackModels || [],
      thinking: cfg.llm.thinking,
      temperature: cfg.llm.temperature,
      maxTokens: cfg.llm.maxTokens,
      // 扩展包的**运行期**状态（B12e-2）。放这里的理由与整个文件一致：
      // 「机器人此刻**正在用**什么」。
      // ⚠️ 面板自己**扫目录**得到的是"磁盘上有什么"（`panel/lib/extensions.js`），
      //    两件事不同：一个包能通过扫描但加载失败。页面要能同时看到这两层。
      extensions: extSnapshot,
      // D14 · 收藏表情（只读）：此刻认得几张 / 上次拉取时刻 / 最近一次失败原因。
      // 为什么值得下发：没有它，"一条收藏都没有"与"永远选中内置表情"在账面上一模一样 ——
      // 而这两件事的排查方向完全相反（前者去 QQ 里收藏，后者要查选择逻辑）。
      customFaces: {
        count: customFaceCache.urls.length,
        at: customFaceCache.at,
        error: customFaceCache.error,
      },
      updatedAt: Date.now(),
      // D31-1 · 睡眠：此刻睡没睡 / 计划 / 下一次入眠与起床的时刻 / 积压几条未读。
      // ⚠️ `null` = **还没算过**（机器人刚起来的那一瞬）—— 与"醒着"是两件不同的事，
      //    页面按 null 不显示，而不是显示成"醒着"（那会让"门禁没接上"看起来一切正常）。
      sleep: sleepSnap,
    });
  } catch {
    /* 写不出来也不影响机器人跑 */
  }
}

// 注：这里原来有个 clearEffective()，退出时把 effective.json 删掉。
// 已移除 —— 面板判断"机器人还在不在"靠的是文件里的 pid 是否存活，
// 不需要删文件；而删文件会在"系统里还有别的实例"时误伤，把活着的实例写的快照一起清掉。

/**
 * 扩展包**运行期**状态的最后一份快照（B12e-2）。
 *
 * 为什么用一个模块级变量而不是参数一路传：它只在 `main()` 里产生、只被
 * `writeEffective()` 消费，而 `writeEffective` 有 3 个调用点（启动 / 热重载 /
 * 20 秒定时），其中两个在别的函数里。传参要改三处签名，还得把 host 一起带过去 ——
 * 而"20 秒定时刷"这条路径本来就在 `main()` 的闭包里，改 `writeEffective` 的签名
 * 反而会把 host 的生命周期搅进"写快照"这件小事里。
 * ⚠️ 初值 `null` = "还没加载过"，与"加载了 0 个"是**两件不同的事**：
 *    前者表示"这一栏没有数据"，后者表示"一个都没启用"。页面按 `null` 不显示。
 */
let extSnapshot = null;

/** 配置文件的 mtime，用来判断是不是真的变了（编辑器保存可能触发多次事件） */
let cfgMtime = 0;
try {
  cfgMtime = fs.statSync(CONFIG_FILE).mtimeMs;
} catch {
  /* 文件不存在就用 0，后面 watch 不到也不会有副作用 */
}

/**
 * 盯着 config.json，改了就立刻重新加载。
 * 之前配置只在启动时读一次，面板上改了模型/思考模式完全不生效，
 * 用户却以为切成功了 —— 这是最坑的一个 bug。
 */
function watchConfig(onReload) {
  try {
    fs.watchFile(CONFIG_FILE, { interval: 800 }, (curr) => {
      const m = curr?.mtimeMs || 0;
      if (!m || m === cfgMtime) return;
      cfgMtime = m;
      // 文件可能才写了一半，稍等一下再读，免得读到半个 JSON
      setTimeout(() => onReload(), 200);
    });
  } catch (e) {
    log.warn(`配置文件监听失败，改动需要手动重启才生效: ${e.message}`);
  }
}

function createSemaphore(limit) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= limit || queue.length === 0) return;
    active += 1;
    const { run, resolve, reject } = queue.shift();
    run().then(resolve, reject).finally(() => {
      active -= 1;
      next();
    });
  };
  return (run) =>
    new Promise((resolve, reject) => {
      queue.push({ run, resolve, reject });
      next();
    });
}

/**
 * 把本次生效的三处凭据装进出口闸门的**运行时阻断集**（第 56 轮 F1-1 · E21 第二半）。
 *
 * 为什么必须有这一步（实测，不是推测）：出口闸门只认「形态」，
 * 而真机生效的那把 key 是智谱格式（`32位hex.16位hex`）——
 * 既没有 `sk-` 前缀、也不一定挨着关键词。第 56 轮量数：把真值原样放进一句普通聊天，
 * **三把里漏两把**；日志脱敏同样漏那两把。形态匹配挡不住"模型把 key 复述出来"。
 *
 * ⚠️ 三条边界：
 *   ① 只装**内存**，不落盘、不进日志（`setRuntimeSecrets` 那边同样没有 getter）；
 *   ② 这里**不打印装了几把之外任何东西** —— 尤其不打印值，也不打印 `apiKeyEnv` 解析出的结果；
 *   ③ 启动与热重载**两处都调**。热重载就是换 Key 的路径，漏了它等于防线上有个洞。
 *
 * @param {ReturnType<typeof loadConfig>} cfg
 */
function armRuntimeSecrets(cfg) {
  setRuntimeSecrets([
    cfg.llm?.apiKey,
    ...Object.values(cfg.llm?.keys ?? {}),
    cfg.onebot?.accessToken,
  ]);
}

async function main() {
  let cfg = loadConfig(process.env.QQBOT_CONFIG);
  armRuntimeSecrets(cfg);

  // ── D19 · 先占锁，再干别的 ─────────────────────────────────────────────
  //
  // 位置是刻意的：**早占位、早拒绝**。放在 `sweepStaleTemps` 之前 —— 拒绝启动时
  // 连清扫都不做（那本就是在替"上一次运行"收拾残局，而我们刚刚决定不启动）。
  // 更关键的是：拒绝必须发生在 `bot.start()` **之前**，否则它会先连上 QQ、
  // 开始在群里说话，然后才退出 —— 那就成了"双开且都说话"。
  //
  // ⚠️ 写不进去 → degraded 放行（`acquireLock` 内部定的口径）：不愿意因为一个
  //    附属文件把机器人挡在门外。这一支会如实写进留档，不静默。
  const lockOut = await acquireLock({
    readRaw: () => (fs.existsSync(LOCK_FILE) ? fs.readFileSync(LOCK_FILE, 'utf8') : null),
    writeRec: (body) => writeTextAtomic(LOCK_FILE, `${JSON.stringify(body)}\n`, { mode: 0o600 }),
    // [W1a/W1c] 两条独占路径：首次占锁用"不存在才创建"，接管用"回收令牌 + 二次验旧"。
    // 两者都给到之后，同一把锁上**不可能有两个进程都拿到 ok**（外包实测：6/6 轮双抢 → 0/6）。
    claimRec: (body) => linkExclusiveSync(LOCK_FILE, `${JSON.stringify(body)}\n`, { mode: 0o600 }),
    reclaimRec: (body, verify) => reclaimExclusiveSync(LOCK_FILE, `${JSON.stringify(body)}\n`, { verify, mode: 0o600 }),
    ownPid: process.pid,
    alive: (pid) => pidAliveOf(pid),
    isOurs: (pid) => probeIsOurBridge(pid),
  });
  /** 锁的结论（进 start 留档行；拒绝那一支已经在下面退出，走不到这里） */
  const lockNote = lockOut.degraded ? `degraded（写不进锁：${lockOut.reason}）` : `已持有（${lockOut.reason}）`;
  if (!lockOut.ok) {
    journal('refuse', `启动被拒：${lockOut.reason} —— 同一份数据目录只允许一个机器人`);
    log.error(`启动被拒：${lockOut.reason}`);
    log.error(`  （已经有实例在跑；确认真要重启就先停掉它。锁文件：${LOCK_FILE}）`);
    process.exit(LOCK_REFUSE_EXIT_CODE);
  }
  if (lockOut.degraded) {
    journal('degraded', lockOut.reason);
    log.warn(lockOut.reason);
  } else if (lockOut.tookOver) {
    // 只有**真的接管了一份存在的东西**（残留的 / 损坏的 / 别人的）才留痕 ——
    // 首次启动不该在留档里冒充一次接管，而"接管"恰恰是排障时最想知道的那件事。
    journal('takeover', lockOut.reason);
    log.warn(`接管启动锁：${lockOut.reason}`);
  }
  // 留档的折半截断：与 trace 同族（有界 + 保留一半），不做轮转改名。
  try {
    truncateLinesAtomic(JOURNAL_FILE, JOURNAL_MAX_LINES);
  } catch {
    /* 截断失败不影响启动 */
  }

  // ── Q26f 裁决③ · 每次启动留一条痕 ──────────────────────────────────────
  // 宿主替用户改权限白名单（把主人补进 `allow.private`）属于"它自己动了配置"，
  // 这类动作**每次启动都要看得见** —— 不然"为什么我老婆能私聊叫醒它"
  // 在半年后完全没有出处。补的动作在 `config.js` 的归一化里（热重载也会重跑），
  // 这里只负责**把它说出来**。
  if (Array.isArray(cfg.ownerAutoPrivate) && cfg.ownerAutoPrivate.length) {
    journal('wake', `启动留痕：已自动把主人 ${cfg.ownerAutoPrivate.join(',')} 补进 allow.private`
      + '（Q26f 裁决③ —— 只补 owner.qq 里的号；要收回就把它从 owner.qq 里去掉）');
  }

  // 清扫"属主已死"的原子写临时文件（第 48 轮 B12e-4 · EX-TEMPSWEEP）。
  // 放在启动最前面：此刻还没开始写任何东西，扫到的必然是**上一次运行/上一次崩溃**的残留。
  // 判据（"不是我的 && 够旧"，两个条件都朝 fail-safe 方向）见 src/atomic-write.js。
  // ⚠️ 清扫面含扩展包的两个根（D21）：那里会留下安装用的 staging / 备份临时**目录**。
  const swept = sweepStaleTemps([ROOT, path.join(ROOT, 'panel'), ...extensionRoots(ROOT).map((r) => r.dir)], { log });
  if (swept.length) log.info(`清理了 ${swept.length} 个残留的原子写临时文件（上次被强杀时留下的）`);

  const store = new SessionStore(cfg);
  const brain = new Brain(cfg, store);
  const llm = new LlmClient(cfg.llm);
  const bot = new OneBotClient(cfg.onebot);
  // ⚠️ 必须是 let：globalConcurrency 改了之后 reload() 会重建信号量（见下方 reload）。
  //    旧实现只在启动时建一次，改并发数要重启才生效，面板还不提示。
  let gate = createSemaphore(cfg.throttle.globalConcurrency);
  /** 当前信号量的上限，供 reload 比对"改没改"。与 gate 成对更新，不许只改一个。 */
  let gateLimit = cfg.throttle.globalConcurrency;
  // 「自我记忆 → 自动记录」。传 getCfg 而不是 cfg 快照：配置会热重载，
  // 抓快照的话开关改了它永远看不到。
  const keeper = new MemoryKeeper(() => cfg, llm);
  /** 表情习惯的会话级状态（最近用过哪几张 / 上次什么时候发的）。纯运行时，不进会话存档 */
  const faceHabit = createFaceMemory();

  /**
   * D14 · 收藏表情的**只读缓存刷新**（唯一的拉取点）。
   *
   * 四条设计约束，每条都对应一个具体的失败形态：
   *   ① **只读**（用户 Q15 裁决：他自己去收藏）—— 只调 `fetch_custom_face`，
   *      写动作（add / delete / set_desc）一个都不许出现在这个文件里，契约有反向断言盯着；
   *   ② **失败不清空** —— 拉取失败保留上一次的结果。清空的表现是"它突然不认识收藏表情了"，
   *      而那看起来与"用户删了图"一模一样，事后无法分辨；
   *   ③ **不新增定时器** —— 挂在既有的 30 秒 tick 上，且**在 `tickProactive()` 之前**：
   *      后者内部有好几条提前 return（总闸关着 / 免打扰 / 没有白名单群…），
   *      挂在它后面会被那些分支吃掉，表现是"白天能用、晚上不用了"；
   *   ④ **失败也不马上重试** —— 先记时间戳再拉：否则协议端一挂，每 30 秒打一次，
   *      日志会被同一个错误刷满（这个项目为"日志噪声掩盖真问题"踩过坑）。
   */
  async function refreshCustomFaces(now = Date.now()) {
    if (now - customFaceCache.at < CUSTOM_FACE_REFRESH_MS) return;
    customFaceCache.at = now;
    try {
      // `bot.call` 解包后的就是 `data`（见 onebot.js 的 resolve 分支），
      // 即协议端的「表情URL列表」。`parseFaceUrls` 两种形状都收。
      const res = await bot.call('fetch_custom_face', { count: CUSTOM_FACE_FETCH_COUNT }, 8000);
      customFaceCache.urls = parseFaceUrls(res);
      customFaceCache.error = '';
      log.info(`收藏表情已同步：${customFaceCache.urls.length} 张`);
    } catch (err) {
      customFaceCache.error = String(err?.message || err);
      log.warn(`拉取收藏表情失败（保留上一次的 ${customFaceCache.urls.length} 张）：${customFaceCache.error}`);
    }
  }

  /**
   * 工具注册表 + 工具回合执行器（第 46 轮 B12e-1 · 执行层）。
   *
   * ⚠️ **本批只把链路铺好，注册表是空的** —— 扩展包执行是 B12e-2 的活。
   *    空注册表下 `specs()` 返回 `[]` → `body.tools` **不出现** →
   *    请求体与改造前逐字节相同、且只发一次请求。这不是"碰巧没事"，
   *    是有断言钉着的（smoke T100 + T101），因为它的反面（多带一个空 `tools`
   *    字段、或多打一枪）都属于"改了主链路却不报错"那一类。
   */
  const toolRegistry = createToolRegistry();

  /**
   * ── D18 · 跨会话发言：两个**宿主工具**的注册 ──────────────────────────────
   *
   * ⚠️ **只在开闸时注册**（`custom.crossSend.enabled === true`）——
   *    关着的时候一个都不注册 ⇒ `specs()` 为空 ⇒ 请求体与本改动之前**逐字节相同**
   *    （上面那段注释说的 T100/T101 不变量，这里必须继续成立）。
   * ⚠️ 于是 **改这个开关要重启机器人才生效**（注册发生在启动路径上）——
   *    与 `custom.sleep`、扩展包白名单同一条先例（R4：不支持热插拔）。
   * ⚠️ 注册进来的只是"入口"；**真正的出口与闸门都在 `sayToGroup`**——
   *    见本文件里 `toolGetChats` / `toolSendTo` 的注释（那两个函数在文件后半段，
   *    函数声明会提升，注册这一刻只是把引用存进表里，**不会当场执行**）。
   */
  if (cfg.custom?.crossSend?.enabled === true) {
    // 两条注册的返回值**必须看**：撞名 / 超上限时它返回 `{ok:false}`，
    // 不看的话表现是"开关开着、模型却没有这两个工具"，而日志里什么都没有。
    const r1 = toolRegistry.register({
      id: 'get_chats',
      owner: '',
      description: '看它还在哪些群里活跃：每个群的群号、多久之前有人说话、最后一句是什么。想换个群开口之前先看这个。',
      parameters: { type: 'object', properties: {} },
      execute: toolGetChats,
    });
    const r2 = toolRegistry.register({
      id: 'send_to',
      owner: '',
      description: `去**另一个**群说一句话（group 必须是 get_chats 列出来的群号）。只说一句、${CROSS_TEXT_MAX} 字以内；不要用它回你正在说话的这个群。`,
      parameters: {
        type: 'object',
        properties: {
          group: { type: 'string', description: '目标群号，必须来自 get_chats 的列表' },
          text: { type: 'string', description: '要说的话，一句话' },
        },
        required: ['group', 'text'],
      },
      execute: toolSendTo,
    });
    for (const r of [r1, r2]) {
      if (!r.ok) log.warn(`跨会话发言的工具没能注册：${r.reason}`);
    }
    log.info(`跨会话发言已开启：注册了 ${toolRegistry.size()} 个宿主工具`);
  }

  const toolLoop = createToolLoop({
    client: llm,
    registry: toolRegistry,
    log,
    onRound: ({ round, calls }) => {
      // 工具回合**必须留痕**：模型突然开始调工具时，日志里要能看出"这一轮做了什么"，
      // 否则"它怎么答成那样"永远查不出来。
      log.info(`[工具] 第 ${round} 轮回合，调用 ${calls.map((c) => c.name).join('/')}`);
    },
    // ── 扩展包钩子：after-tool（第 47 轮 B12e-3，参考实现 orchestrator.js:1132）──
    //
    // ⚠️ 这里**刻意比参考实现窄两处**，别照着"对齐生态"的名义补回来：
    //    ① 参考实现把整个 `skillContext` 和**脑会话对象**一起展开进载荷
    //       （`{...skillContext, toolName, argsRaw, result, session}`）；
    //       本项目一律只投影可读字段 —— 钩子拿到可变宿主对象后能改写状态，
    //       而那属于"改了不报错、事后无人能查"那一类（第 30 / 41 条同族）。
    //    ② 参考实现只在 `execute(ctx)` 的 ctx 上给 `onebot` / `sender`
    //       （orchestrator.js:888），钩子侧（orchestrator.js:749 的 skillContext）没有。
    //       本项目的钩子载荷沿用这条边界：**钩子能读会话信息，拿不到"能直接发言"的能力。**
    //
    //    与另两条钩子的形状对照（三者都是投影，不是宿主对象）：
    //      before-tool   → `{toolName, argsRaw, session:{chatKey, sent}}`（src/send-guard.js）
    //      after-tool    → 本行
    //      after-response→ `{response, session:{chatKey, sent, error, toolResults}}`（下方）
    onToolCall: ({ name, argsRaw, result, isError, ctx }) =>
      hookBus.emit('after-tool', {
        chatKey: String(ctx?.chatKey ?? ''),
        toolName: name,
        argsRaw,
        result,
        isError: Boolean(isError),
      }),
  });

  /**
   * 钩子总线 + 发送闸（第 46 轮 B12e-2 · EX-LIFECYCLE）。
   *
   * 插件型扩展包（`plugins/` 下那 5 个）不注册工具，它们**靠钩子介入**。
   * `复读拦截` 声明的是 `before-tool`，落在"即将发出这一条"那一刻。
   *
   * ⚠️ 没有钩子时 `sendGuard.check()` 直接短路放行 —— 所以**一个包都没启用时，
   *    主发送路径是零行为改变**（有断言钉着，见 smoke T115）。
   */
  const hookBus = createHookBus({ log });
  const sendGuard = createSendGuard({ bus: hookBus, log });

  /**
   * 扩展包用的 sender 适配器（第 47 轮 B12e-3）。
   * 「合并转发发送」优先走 `ctx.sender.sendSegments(target, segments)`
   * （参考实现 orchestrator.js:897 同形状）；没有适配器时它会退回 `ctx.onebot.call`，
   * 两条路殊途同归 —— 但适配器让**优先路径**真的可用，而不是每次都落进"退化"分支。
   * target 形如 'group:123' / 'private:456'；segments 里装 [{type:'forward', data:[...节点]}]。
   * ⚠️ 只支持合并转发段：别的段型说明包把它当通用发送口用，那是越界，当场抛错。
   */
  const extSender = {
    async sendSegments(target, segments = []) {
      const [kind, rawId] = String(target ?? '').split(':');
      const fwd = Array.isArray(segments) ? segments.find((s) => s?.type === 'forward') : null;
      if (!fwd || !rawId) {
        throw new Error(`sendSegments 只支持合并转发段（target=${String(target)}）`);
      }
      const action = kind === 'private' ? 'send_private_forward_msg' : 'send_group_forward_msg';
      const key = kind === 'private' ? 'user_id' : 'group_id';
      return bot.call(action, { [key]: Number(rawId), messages: fwd.data });
    },
  };

  /**
   * 扩展包宿主（第 44 轮 B12d 只识别；**第 46 轮 B12e-2 起真的执行**）。
   *
   * 这是本项目**第一次执行磁盘上的外来代码**，所以两道闸都在宿主里：
   *   ① `entry` 的 realpath 校验（越界 / 不存在 / 不是文件 / 不可读 → 拒绝那一条）
   *   ② `permissions` 真的裁剪 ctx（`api.fetch` 只有声明 `web_fetch` 才给）
   * 另外：**一个包失败只拒它自己**，其余照常加载。
   *
   * ⚠️ 它**绝不允许**拖垮启动：宿主逐条兜错，这里再包一层 try。
   *    理由与 `/api/state` 那条纪律相同：**次要功能的故障不该升级成整体故障**。
   *    "一个没写好的扩展包让机器人起不来"，比"扩展包没生效"严重得多。
   *
   * 放在这里而不是更晚：它属于**启动自检**。早一点报出来，用户就不必等到
   * 机器人开始回话才发现"我装的包一个都没被认出来"。
   */
  const extHost = createExtensionHost({
    root: ROOT,
    registry: toolRegistry,
    bus: hookBus,
    getCustom: () => cfg.custom,
    log,
  });
  /** 启动那一刻的白名单（逗号串，用于比对"改了没生效"）。`null` = 还没读过配置。**此后不再变**。 */
  let enabledAtBoot = null;
  /**
   * 已经"告警到"的那一份 —— **只用来防重复刷**，不参与"要不要重启"的判定。
   * ⚠️ 两个变量必须分开（第 49 轮复审修复）：上一个实现把告警基线同步进
   * enabledAtBoot，等于让一个变量承担两个语义 —— 白名单 A→B→A 往返时，
   * 第 3 步会拿"运行态基线=B"判出一次**假告警**（配置已回到 A，
   * 而机器人一直跑的就是 A），文案还显示"B → A"，误导用户去做一次不必要的重启。
   */
  let enabledAlerted = null;
  /** 当前白名单（归一化后的 id 列表 → 逗号串）。**只此一处**，比对与日志都读它。 */
  const enabledList = () => (cfg?.custom?.plugins?.enabled || []).join(',');

  const refreshExtensions = async () => {
    try {
      extSnapshot = await extHost.load();
      writeEffective(cfg); // 立刻落盘：面板要能马上看到"哪个包加载失败了"
    } catch (e) {
      log.warn(`扩展包加载失败（不影响机器人运行）: ${e.message}`);
    }
  };

  writeEffective(cfg);
  enabledAtBoot = enabledList();
  // 「已告警到」的初值 = 启动那一刻那一份，否则第一次重载就会白报一条
  // （不严谨地初始化成 null 的话，任何一次 reload 都会先打一条"白名单已改动"，而实际没改）。
  // 两个变量成对初始化，见上面 enabledAlerted 的注释。
  enabledAlerted = enabledAtBoot;
  await refreshExtensions();

  // ── D19 · 启动摘要（留档） ──────────────────────────────────────────────
  //
  // 为什么写在这里而不是更早：它要含**扩展包加载计数**，而那个数在上一行才拿到。
  // 这就是原 D20"就绪度体检卡"被并进 D19 的那一半 —— 体检结论落在一份 append-only
  // 的文件里，跨重启可回溯（`bridge.log` 每次启动被 'w' 截断，查不到上一次）。
  //
  // ⚠️ 这里**只记录、不做任何判断**：不因为"扩展包全挂了"就拒绝启动
  //    （那是启动自检该报警的事，不是完整性闸门该拦的事）。
  journal('start', `模型=${cfg?.llm?.model || '(未配置)'}`
    + ` · 白名单群=${(cfg?.onebot?.groups || []).length}`
    + ` · 白名单扩展=${enabledAtBoot ? enabledAtBoot.split(',').filter(Boolean).length : 0}`
    + `（已加载 ${extSnapshot?.sum?.loaded ?? '?'}/${extSnapshot?.sum?.total ?? '?'}）`
    + ` · 锁=${lockNote}`);

  // ── 会话存档（B10d · O-SESSION）──
  // 每次重启都从零开始记，是"它记性变差了"的真正原因。这里让历史跨重启活下来。
  // QQBOT_SESSION_ARCHIVE 让测试把它指去临时目录 —— 否则 smoke 跑一遍，
  // mock 出来的假对话就会落进用户真实的会话存档里（与 QQBOT_TRACE_FILE 同一个道理）。
  const ARCHIVE_FILE = process.env.QQBOT_SESSION_ARCHIVE
    ? path.resolve(process.env.QQBOT_SESSION_ARCHIVE)
    : path.join(ROOT, 'panel', 'session-archive.json');
  {
    const r = restoreInto(store, readArchive(ARCHIVE_FILE), { fp: brain.fp });
    if (r.stale) log.info(`会话存档已过期（超过 ${Math.round(DEFAULT_MAX_AGE_MS / 3600000)} 小时）→ 不恢复 ${r.stale} 个会话，从零开始记`);
    else if (r.restored) {
      log.info(`已从存档恢复 ${r.restored} 个会话（重启前聊到哪，现在还接得上）`
        + (r.personaDropped ? `；人设已变更 → 丢掉 ${r.personaDropped} 条旧人设的发言` : ''));
    }
  }
  /** 防抖计时器。高频群里一次写盘覆盖多条消息，I/O 不会压到回复延迟上。 */
  let archiveTimer = null;
  function scheduleArchive() {
    if (archiveTimer) return; // 已经在等了 —— 这段时间里的改动会被同一次写盘带走
    archiveTimer = setTimeout(() => {
      archiveTimer = null;
      flushArchive();
    }, 3000);
    archiveTimer.unref?.(); // 别挡着进程退出
  }
  function flushArchive() {
    try {
      writeArchive(ARCHIVE_FILE, archiveOf(store.sessions, { fp: brain.fp }));
    } catch (e) {
      // 存不下档绝不能影响回话。但**要说出来** —— 不然"为什么还是失忆"无从查起
      log.warn(`会话存档写入失败（不影响回复）: ${e.message}`);
    }
  }

  /**
   * 热更新配置：模型 / 接口地址 / 思考模式改了，不用重启机器人，
   * 下一条消息就用上新配置。会话历史和 QQ 连接都不断。
   */
  const reload = () => {
    try {
      const next = loadConfig(process.env.QQBOT_CONFIG);
      const changed =
        next.llm.model !== cfg.llm.model ||
        next.llm.baseUrl !== cfg.llm.baseUrl ||
        next.llm.thinking.mode !== cfg.llm.thinking.mode ||
        next.llm.thinking.level !== cfg.llm.thinking.level;
      cfg = next;
      // 热重载换的就是凭据（换服务商 / 换 Key），阻断集**必须跟着换** ——
      // 不换的话：旧 Key 拆不下来（它已经被卸任了，还拦着）、新 Key 装不上去
      // （最坏情况：新 Key 被模型复述出来却无人拦）。放在 cfg = next 之后，读的是新的那份。
      armRuntimeSecrets(next);
      // 并发上限变了就重建信号量（P0 修复：旧实现改了要重启才生效）。
      // 在途请求仍在旧信号量上自然排空，不迁移；新请求走新的。
      // 非 finite 的脏值不重建 —— 与启动时的行为一致，别让一次坏配置把限流整个拆掉。
      const nextLimit = Number(next.throttle?.globalConcurrency);
      if (Number.isFinite(nextLimit) && nextLimit !== gateLimit) {
        gateLimit = nextLimit;
        gate = createSemaphore(nextLimit);
        log.info(`并发上限已更新 → ${nextLimit}`);
      }
      brain.update(cfg);
      llm.update(cfg.llm);
      // D31（Q29，外包任务1 复核发现）：作息改了也要**立刻**重算 ——
      // 快照原本只由 30 秒 tick 刷新，于是"面板上把作息打开"之后最长要等 30 秒才拦，
      // 而那 30 秒里用户看到的是"开关坏了"。热重载的语义本来就是"改了立刻生效"。
      refreshSleep();
      writeEffective(cfg);
      // ── 扩展包白名单改了 ────────────────────────────────────────────────
      // ⚠️ **不支持热插拔**（规格 v2 §5 明写），所以这里**只能提示**，不能重载：
      //    真去重载会让同一个包的模块级状态与钩子表各出现两份 —— 那是最难查的幽灵。
      //    但"改了没生效"是本项目反复踩的坑（当初连换模型都要重启），
      //    所以**必须当场说清楚**，而不是让用户以为改坏了。
      // 判据：两个变量各回答一个问题（第 49 轮复审修复）——
      //   · 与「启动时生效值」不同 → 运行态跟配置不一致 → 该告警（回答「要不要重启」）
      //   · 与「上次已告警值」不同 → 这条还没说过 → 才真的打（回答「要不要打扰用户」）
      // 用一个变量同时回答这两件事，会在「A→B→A」往返时判出假告警，见 enabledAlerted 的注释。
      if (enabledList() !== enabledAtBoot && enabledList() !== enabledAlerted) {
        log.warn(
          `扩展包白名单已改动（${enabledAtBoot || '空'} → ${enabledList() || '空'}），`
            + '但本项目**不支持热插拔** —— 需要重启机器人才能生效。'
        );
        // 只同步「已告警值」，**绝不动** enabledAtBoot —— 它记的是运行态。
        // 改了它，下一个人就会把「配置 vs 运行态」误读成「配置 vs 上次告警」，假告警会回来。
        enabledAlerted = enabledList();
      }
      if (changed) log.info(`⚙ 配置已更新并立即生效 → ${llm.label}`);
      return true;
    } catch (e) {
      // 配置写坏了就继续用旧的，绝不能让机器人因此挂掉
      log.error(`配置更新失败，继续沿用旧配置: ${e.message}`);
      return false;
    }
  };
  watchConfig(reload);

  bot.on('ready', () => {
    log.info(`桥接就绪 | 模型: ${llm.label}`);
    log.info(
      `白名单 | 群: ${cfg.allow.groups.join(',') || '空'} | 私聊: ${cfg.allow.private.join(',') || '空'}` +
        ` | 空放行: ${cfg.allow.allowAllWhenEmpty}`
    );
    if (!cfg.llm.apiKey && /^https:/.test(cfg.llm.baseUrl)) {
      log.warn('目标是 https 端点但没有配置 apiKey，请求很可能被拒绝');
    }
    // D14：连上就拉一次收藏表情（只读）。**不 await** —— 它不该拖慢就绪流程，
    // 拿不到也只是"这一轮用不上收藏表情"（退化成内置表情，即现状）。
    refreshCustomFaces().catch((e) => log.warn(`收藏表情同步异常: ${e.message}`));
  });

  /**
   * 会话级串行调度。
   *
   * 之前每条消息各跑各的，于是「随机插话」和「被@了」能在几秒内同时进入处理，
   * 各自回复一条 —— 用户视角就是「@ 它一次，它蹦出两条」。
   * 这里让同一个会话的消息排队依次处理：排在后面的那条会重新走一遍限流检查，
   * 发现前面刚回过就自动放弃。
   */
  const sessionQueue = new Map();

  /**
   * 会话级中止 / 重试控制器（D6）。判据在 `src/session-control.js`（零依赖叶子），
   * 这里只是**唯一接线点**：把 signal 喂给模型调用链、把"真的发出去了"记回去。
   */
  const sessionCtl = createSessionControl();
  /** 最近一个"一条未发出的失败"（中止或超时）的会话 key —— SIGUSR1 重放要用它。 */
  let lastStalled = '';

  /**
   * 原地重放一次被中止/超时的会话（D6）。
   *
   * "原地"的三个含义（都是刻意的）：
   *   · 复用**同一个 session 对象**（不新建、不换 id）—— 否则会话列表会随重试膨胀；
   *   · 复用**同一条触发消息**（`retryPlan` 从控制器里取）—— 重放的是刚才那一句；
   *   · 仍然走**同一个 sessionQueue**（排队，不并发）—— 两条生成抢同一份上下文最坏。
   *
   * ⚠️ 三条拒绝理由来自纯函数 `retryDecision()`，这里**不自己判**：
   *    已发过言 / 正在途 / 没有失败记录。理由都直接打进日志，不静默。
   */
  function replayStalled(key) {
    const plan = sessionCtl.retryPlan(key);
    if (!plan.ok) {
      log.warn(`重试被拒（${key}）：${plan.reason}`);
      lastStalled = '';
      return { ok: false, reason: plan.reason };
    }
    const evt = plan.trigger;
    lastStalled = '';
    log.info(`原地重试 ${key}：复用同一个会话与同一条触发消息（这一轮此前一条都没发出）`);
    // D9b：排队机制收敛成 `enqueueFor` 一处 —— 这里只保留"重试"自己的措辞差异。
    enqueueFor(evt, '重试处理异常');
    return { ok: true, reason: '' };
  }

  /**
   * 把一条事件排进它所属会话的串行队列（**唯一入口**）。
   *
   * D9b 抽出来：拍一拍会**合成一条普通消息事件**送进来，如果各写一份排队代码，
   * 「串行 / 存档 / 出队」这三件事就有两份实现 —— 而它们一定会漂。
   *
   * @param {object} evt OneBot 消息事件（真消息，或 `pokeEventOf` 合成的）
   * @param {string} [errLabel] 异常日志的前缀（重试路径要区分出来）
   */
  function enqueueFor(evt, errLabel = '处理消息异常') {
    const scene = evt.message_type === 'group' ? 'group' : 'private';
    const key = `${scene}:${scene === 'group' ? evt.group_id : evt.user_id}`;
    const prev = sessionQueue.get(key) || Promise.resolve();
    const next = prev
      .then(() => handleMessage(evt))
      .catch((err) => log.error(`${errLabel}: ${err.message}`))
      .finally(() => {
        // 会话存档（B10d · O-SESSION）。挂在队列收尾而不是每条 remember 后面 ——
        // handleMessage 里有好几处提前 return（被闸门拦下、选择潜水…），
        // 挂在 remember 后面必然漏掉其中几支。这里一支都不漏。
        // 里面自带防抖，高频群里不会每条消息都真写一次盘。
        scheduleArchive();
        if (sessionQueue.get(key) === next) sessionQueue.delete(key);
      });
    sessionQueue.set(key, next);
    return next;
  }

  bot.on('message', (evt) => {
    enqueueFor(evt);
  });

  /**
   * ── notice 事件接线（D9b · 报告 E7）────────────────────────────────────
   *
   * 改造前 `onebot.js` 一直在 `emit('notice')`，而**没有任何监听者** ——
   * 拍一拍、禁言、群管事件全部停在门外。这里把其中两类接上：
   *
   *   ① 拍一拍（被拍的是机器人）→ **合成一条群消息**走同一条主链路（见 `pokeEventOf`）。
   *      展示名尽力从协议端取；取不到就用空串，`handleMessage` 会回落成「用户<号>」——
   *      **不编造**一个名字（对陌生人不凭空画像，是与说话风格画像同一条纪律）。
   *   ② 群禁言 / 解除 → 只改会话上的 `mutedUntil` 到期时间戳。
   *      不建会话、不打 API、不烧 token；到期靠时间自己恢复。
   *
   * 其余 notice（撤回、戳一戳以外的 notify、群管…）**不处理**，但记一条 debug ——
   * 静默丢弃正是本项目最怕的失败模式。
   */
  bot.on('notice', async (evt) => {
    // ⚠️ `onebot.js` 对**所有非 message 报文**都 emit('notice') —— 心跳（`meta_event`）
    // 也在其中，约每 30 秒一次。它们不是"我们没处理的 notice"，只是别的事件：
    // 不过滤的话默认日志级别下会每半分钟刷一行「notice 未处理（post_type 不是 notice）」，
    // 一天两千多行纯噪声，把真正要看的那几行淹掉（重启后实测到的）。
    if (evt?.post_type !== 'notice') return;

    const n = normalizeNotice(evt, bot.selfId ?? evt?.self_id ?? '');
    if (n.kind === 'other') {
      log.debug(`notice 未处理（${n.reason}）`);
      return;
    }

    if (n.kind === 'muted' || n.kind === 'unmuted') {
      // 只关心"被禁言的是不是机器人"：别人之间的禁言与我们无关。
      if (!n.aboutSelf) {
        log.debug(`群禁言 notice 与机器人无关（被禁言者 ${n.targetId || '未知'}），不处理`);
        return;
      }
      const session = store.get('group', n.id);
      if (n.kind === 'muted') {
        session.mutedUntil = Date.now() + n.durationSec * 1000;
        log.warn(`被禁言 ${n.durationSec} 秒（群 ${n.id}）→ 这段时间它不再开口；到期自动恢复`);
      } else {
        session.mutedUntil = 0;
        log.info(`禁言已解除（群 ${n.id}）→ 恢复开口`);
      }
      return;
    }

    if (n.kind === 'poke') {
      if (!n.aboutSelf) return; // 拍的是别人，与我们无关
      // ── Q13 裁决①（先取证）：**私聊**戳一戳只留痕，不合成事件 ──────────────
      //
      // 取证结论先说清楚（三路都跑过）：
      //   ① 本机第一手证据 = **0**（`panel/local-trace.jsonl` 与协议端容器日志里一条 poke 都没有）；
      //   ② 协议端静态：`/app/napcat/napcat.mjs` 里 `poke` 只出现在**消息段类型枚举**中，
      //      压缩产物里读不到"事件侧推不推私聊"的直接结论；
      //   ③ 生态侧（二手）：AstrBot 的 poke 插件按"群友**或私聊用户**的戳一戳"实现，
      //      koishi 那个也说 NapCat 支持私聊发起与响应 ⇒ **倾向"会推"**。
      //
      // 所以之前那条路是**实打实的错路**：`pokeEventOf` 硬编码 `message_type:'group'`，
      // 私聊 poke 一旦到达，会拿**发起者的 QQ 号当群号**去 `get_group_member_info`、并把一句
      // 「（拍了拍你）」当成**群消息**发出去。这里把它改成"只留痕、不动作"：
      // 既消掉那个错路，也把"协议端到底推不推"这件事**变成可观测**（下次真机收到就有第一手证据）。
      // ⚠️ 不是新行为：原来那条路从来没被走到过（第一手证据为 0），关掉它不损失任何现有能力。
      if (n.scene !== 'group') {
        journal('notice', `私聊戳一戳（来自 ${n.fromId}）：协议端确实推来了 —— 当前按 Q13 只留痕、不处理`);
        log.warn(`[notice] 收到私聊戳一戳（${n.fromId}）→ 按 Q13 只留痕不处理（这是"协议端到底推不推"的第一手证据）`);
        return;
      }
      // 展示名：尽力取，取不到就不写（宁可显示「用户<号>」也不编一个名字）。
      let name = '';
      try {
        const info = await bot.call('get_group_member_info', { group_id: n.id, user_id: n.fromId, no_cache: false }, 5000);
        name = String(info?.card || info?.nickname || '');
      } catch (err) {
        log.debug(`取拍一拍发起者昵称失败（用「用户<号>」代替）：${err.message}`);
      }
      log.info(`[notice] 被 ${name || `用户${n.fromId}`} 拍了拍（群 ${n.id}）→ 视为召唤`);
      enqueueFor(pokeEventOf(n, bot.selfId ?? evt?.self_id ?? '', name));
    }
  });

  /**
   * ── D23-2 · 合并转发展开（**唯一入口**）──────────────────────────────
   *
   * 入站的合并转发有两种形态，这里都只在**有需要时**动手（没有转发段就一条语句都不做）：
   *   ① `forward` 型 —— 段里只有一个 id，真正的内容要再调一次 `get_forward_msg`；
   *   ② `node` 型 —— 段里内嵌节点，本来就能直接读（下面走同一个渲染器）。
   *
   * ⚠️ **参数用 `message_id`，不是段里的那个 id** —— 参考实现的真机实测
   *    （2026-09-05，SnowLuma/NapCat）：`get_forward_msg` **只认 `message_id`**；
   *    转发卡片里的 `res_id` 会过期，报 `payload is empty`。所以段里那个 id 只作**兜底**重试
   *    （多一次调用，但能覆盖"协议端两种行为都有"的现实）。两个都不行 → 退回占位符。
   * ⚠️ 整条消息**最多调两次**（message_id 一次 + res_id 兜底一次），且只渲染一次。
   * ⚠️ **fail-open**：任何异常都不许影响这条消息的处理 —— 宁可它只看见 `[合并转发]`。
   *    成功与失败都要留痕（`forward` 那一格进 trace），否则"它说看不见"无从复盘。
   *
   * @param {object} evt OneBot 消息事件
   * @returns {Promise<{text:string, stat:object|null}>} `stat` 为 null = 这条消息没有转发段
   */
  async function expandForwardText(evt) {
    const segs = forwardSegmentsOf(evt.message);
    if (!segs.length) return { text: '', stat: null };
    // 关掉这个开关 → 与 D23-2 之前的行为**逐字相同**（仍是占位符），但仍然留痕 ——
    // 否则"为什么它看不见转发"会变成一条查不出来的谜（用户自己关了）。
    if (!cfg.custom.forwardExpand.enabled) {
      return { text: '', stat: { off: true, segs: segs.length, nodes: 0, chars: 0, ms: 0, error: '' } };
    }

    const renderNode = (node) => flattenMessage(
      nodeSegmentsOf(node),
      bot.selfId ?? String(evt.self_id ?? ''),
      { probe: false },
    ).text;
    const t0 = Date.now();
    const stat = { off: false, segs: segs.length, nodes: 0, chars: 0, ms: 0, via: '', error: '' };

    // 优先 message_id（协议端只认它）；没有 message_id 或它失败了，再拿段里的 res_id 试一次。
    const attempts = [];
    if (evt.message_id !== undefined && evt.message_id !== null && String(evt.message_id)) {
      attempts.push({ via: 'message_id', params: { message_id: Number(evt.message_id) || evt.message_id } });
    }
    const resId = forwardResIdOf(evt.message);
    if (resId) attempts.push({ via: 'res_id', params: { id: resId } });

    for (const at of attempts) {
      try {
        const data = await bot.call('get_forward_msg', at.params, 5000);
        const nodes = forwardNodesOf(data);
        if (!nodes.length) {
          // 形状不对 / 空 → 换下一种参数再试；全试完仍为空就退回占位符（不编内容）。
          stat.error = stat.error || 'empty';
          continue;
        }
        const text = renderForwardText(nodes, { renderNode });
        stat.via = at.via;
        stat.nodes = nodes.length;
        stat.chars = text.length;
        stat.ms = Date.now() - t0;
        stat.error = '';
        log.info(`[${evt.message_id}] 合并转发展开：${nodes.length} 条 / ${text.length} 字符（走 ${at.via}，${stat.ms}ms）`);
        return { text, stat };
      } catch (err) {
        stat.error = err.message;
      }
    }

    stat.ms = Date.now() - t0;
    log.warn(`合并转发展开失败（保留占位符）：${stat.error || '未知原因'}（seg=${segs.length}）`);
    return { text: '', stat };
  }

  async function handleMessage(evt) {
    const selfId = bot.selfId ?? String(evt.self_id ?? '');

    // 自己发的消息不要当成输入，否则会自问自答形成死循环。
    // ⚠️ D23-2 起这一句**提到了最前面**：展开要发一次协议端调用，没道理为"自己的回声"
    //    白调一次（群里会出现机器人自己发的合并转发）。顺带把探针的口径收得更严 ——
    //    D23-1 说的本来就是「**入站** forward/node 段探针」，自己的消息不算入站。
    if (String(evt.user_id) === selfId) return;

    // ── D23-2 · 合并转发展开（在 flattenMessage 之前：展开文本要就位才能进 text）──
    const forward = await expandForwardText(evt);
    const forwardStat = forward.stat;
    const parsed = flattenMessage(evt.message, selfId, { forwardText: forward.text });

    const scene = evt.message_type === 'group' ? 'group' : 'private';
    const id = scene === 'group' ? evt.group_id : evt.user_id;
    // 过不了黑白名单的消息**不建会话对象**（P1 修复）：它们永远不会有回复，
    // 为它们建 session、记背景消息是纯内存浪费（且只增不减 —— 每个见过的群/用户一条）。
    // 预判与 decide 用的是同一份判定（brain.#gateReason），两边不会漂移。
    // skip 记录照写（writeSkip 不需要 session），日志与之前逐字一致。
    const allowed = brain.isAllowed(evt);
    const session = allowed ? store.get(scene, id) : null;

    const sender = evt.sender?.card || evt.sender?.nickname || `用户${evt.user_id}`;
    // ⚠️ `!evt.isPoke`：拍一拍合成的那条**不进背景段**（D9b）。
    //    背景段的用途是"让模型知道刚才群里谁在说什么"；一次拍一拍不是"话"，
    //    记进去等于往上下文里塞一句自己没见过的动作，更容易诱发复读。
    if (allowed && scene === 'group' && !evt.isPoke) {
      brain.rememberAmbient(session, sender, parsed.text, evt.user_id);
    }

    // ── ATI-2：记一笔这个人的说话风格（纯本地统计，**零模型调用**）──
    // 只在建了会话的情况下记 —— 过不了黑白名单的群不统计（理由同 rememberAmbient：
    // 它们永远不会有回复，为它们攒数据只是白占磁盘）。
    // 机器人自己发的消息在上面第 585 行已经 return，不会混进来污染统计。
    // ⚠️ 落盘是 30 秒防抖。**进程被强杀**（SIGKILL）最多丢这 30 秒的**统计**（不是事实数据），
    //    这可以接受；但**正常退出**（SIGINT/SIGTERM）必须补写一次 —— 与会话存档同一条纪律。
    //    ⚠️ 2026-10-01 清理轮更正：这句注释此前写的是"与会话存档的做法一致"，
    //    而当时**并不一致** —— 存档在 `shutdown()` 里补（`flushArchive()`），画像没有
    //    （`flushProfiles` 导出在、全仓 0 调用）。现在两处并排（见 `shutdown()`），
    //    并且由契约 §55 + smoke T349 盯着这个对称性。
    // ⚠️ `!evt.isPoke`：拍一拍合成的那条**不进背景、不进风格统计**（D9b）。
    //    背景段的用途是"让模型知道刚才群里谁在说什么"；一次拍一拍不是"话"，
    //    记进去会让模型在下一轮看到一句自己没见过的动作，反而更容易复读。
    if (allowed && !evt.isPoke) {
      observeAndStore({
        chatKey: session.key,
        userId: evt.user_id,
        text: parsed.text,
        hour: new Date().getHours(),
        // 入站 QQ 表情被 flattenMessage 折成 `[表情]` 占位符 —— 按占位符判，
        // 不要去猜协议端原始段结构（那属于 onebot 层的事）。
        hasFace: parsed.text.includes('[表情]'),
      });
    }

    // ── D30 · 未读记录（**唯一写入点**）────────────────────────────────────
    // 位置刻意与上面那两条记录同段（`isAllowed` 之后、`decide()` 之前）：
    // 三条同源同序，但职责分开 —— ambient 是"背景窗口"，风格统计是"这个人怎么说话"，
    // 未读是"这一条被门禁处理完了没有"。
    // ⚠️ 拍一拍不进未读：它不是"话"（D9b 既有口径），而且合成事件没有 message_id ——
    //    两道一起挡（叶子里那条是结构性的，这里这条是显式的）。
    if (allowed && !evt.isPoke) {
      noteUnread(session, {
        messageId: evt.message_id,
        userId: evt.user_id,
        sender,
        text: parsed.text,
        mentionedSelf: parsed.mentionedSelf,
        now: Date.now(),
      });
    }

    // 这一轮的唯一把手（B10a · O-TRACE）。放在决策**之前**：跳过的那一轮同样要带上它，
    // 否则"面板上没回"和"bridge.log 里那几行"还是对不上。
    const traceId = newTraceId();

    // ── D31-2 · 叫醒路（**必须排在睡眠门禁之前**：它是门禁唯一的例外）──────
    // 位置就是语义：排在门禁之后，睡着的分支会在进到这里**之前**直接 return，
    // 于是"叫醒"永远轮不到 —— 而它自己还"看起来接上了"（两侧都在同一个函数里）。
    // ⚠️ 它零模型调用（纯 QQ 号比较 + 词表 `includes`）—— 否则"睡着期间不花 token"被自己破了。
    // ⚠️ 正文用 `triggerTextOf(parsed)`（**不含 @ 显示名**）：叫醒是触发判据，
    //    群里 @ 一个名字里带「起床」的群友不该把它叫醒（D28 的同一条理由）。
    // ⚠️ 拍一拍**天然叫不醒**：它的合成正文是「（拍了拍你）」，词表里没有 ——
    //    这不是巧合而是一种口径：拍一拍的语义是"召唤"，不是"叫起床"（D9b 既有口径）。
    const wokeNow = evaluateWake({
      scene, userId: evt.user_id, mentionedSelf: parsed.mentionedSelf,
      text: triggerTextOf(parsed), now: Date.now(),
      // D31-3：补看要跳过**当前**这个会话 —— 叫醒的那条正被处理，它本来就会被回。
      sessionKey: session ? session.key : store.key(scene, id),
    });
    if (wokeNow) log.info(`[${traceId}] 被叫醒（${sleepSnap?.wakeKind}）→ 这一条照常处理`);

    // ── Q86 裁决① · 这一轮的睡眠处境**生成前冻结同一份引用** ────────────────
    // 提示词侧（下面 `buildMessagesWithMeta`）与记录侧（trace 的 `sleep` 格）
    // 中间隔着一次 `await`（模型生成，几秒到几十秒）—— 而 `sleepSnap` 每 30 秒
    // 会被 tick 改写。以前两边各自读一次：极端情况下提示词里写着"刚睡醒"、
    // trace 里记着"没被叫醒"，两处**都有值、都对不上**，而没人会红（结构成立、差异未复现）。
    // 冻结一份同刻的值给两边用，是这里唯一能同时满足"提示词与记录一致"的写法。
    const sleepRound = { wakeKind: String(sleepSnap?.wakeKind || ''), catchUp: !!evt.isCatchUp };

    // ── D31-1 · 睡眠门禁（**唯一门禁点**）──────────────────────────────────
    // 位置就是语义：在 D30 的**未读记录之后**、`decide()` 与**未读消费之前**。
    // 睡着时直接 return ⇒ `decide()` 不跑 ⇒ `consumeUnread` 也不跑 ⇒ 这一条**原样留在未读**，
    // 醒来之后按快照消费（D30 专门为这件事留的语义，见 unread.js 文件头 ①）。
    // ⚠️ 它必须在**任何会调模型的东西之前**（buildMessages / toolLoop / keeper.consider 全在后面）。
    // ⚠️ 留一条 skip：睡着时"为什么不回"必须查得到（否则用户看到的是"它坏了吗"）。
    if (sleepSnap?.asleep) {
      writeSkip({
        traceId, stage: 'sleep', scene, id, sender,
        text: `${sender}: ${parsed.text}`,
        reason: `它在睡觉（计划 ${sleepSnap.bed}–${sleepSnap.wake}）`,
        model: cfg.llm.model, baseUrl: cfg.llm.baseUrl,
        // 睡着时**不消费未读** ⇒ 这里如实是 null（不是"处理了 0 条"）。
        unread: null,
        forward: forwardStat,
      });
      log.info(`[${traceId}] 休眠中跳过 ${session ? session.key : store.key(scene, id)} ${sender}: ${truncate(parsed.text)}`);
      return;
    }

    // ── M-4（2026-10-04 审查轮）：把"引用了我的话"算进"被叫到" ──────────────
    // 判据本身在 `src/reply-track.js`（零依赖叶子），这里只做**接线**：
    // `parsed.replyTo` 只是"被引用消息的 id"（不含作者），拿它去比"我发过的 id"。
    // ⚠️ 只读一次、传进去 —— 不让 `decide()` 自己去碰进程状态（保持它是纯函数）。
    const repliedToMe = isReplyToSelf(selfSentIds, parsed.replyTo);
    const decision = brain.decide(session, evt, parsed, { repliedToMe });

    // ── D30 · 单点消费（**唯一消费点**）────────────────────────────────────
    // `decide()` 一返回就消费：respond 与 skip 都算"已被门禁处理完毕"，
    // 上面那些 return（跳过 / 群内指令 / 限流）**全都在这条线之后** ——
    // 所以"没回"与"没看见"在账面上从此分得开。
    // ⚠️ 过不了黑白名单的消息**没有会话**（也就不建未读）→ 这一处如实回 null，
    //    不要写一个全 0 的 stat（那会让面板显示成"处理了 0 条"）。
    const unreadStat = session ? consumeUnread(session, evt.message_id) : null;

    // ── D12b：冷场判据的记账（唯一调用点，覆盖下面所有分支）──────────────
    // 位置**必须**在 decide 之后：判定要读的是"这条消息之前沉默了多久"，
    // 先记账再判会让冷场时长恒为 0（那个因子就成了永远为假的死代码）。
    // ⚠️ 拍一拍不是"话"（D9b 既有的口径：它不进背景段、不进风格统计）——
    //    让它推进就等于一次拍一拍把冷场计时清零。
    if (session && !evt.isPoke) brain.noteSeen(session);

    if (!decision.respond) {
      // B10a · O-SKIP：以前只有 log.debug（默认级别 info，**根本不输出**），
      // 于是"它为什么不理我"没有任何地方可查。现在落盘 + 打 info 级日志。
      writeSkip({
        traceId, stage: 'decide', scene, id, sender,
        text: `${sender}: ${parsed.text}`, reason: decision.reason,
        model: cfg.llm.model, baseUrl: cfg.llm.baseUrl,
        // D12b：走到插话分支的那轮才有值（别的 skip 是 undefined → 落 null）。
        interject: decision.interject,
        // D30：这一轮消费掉的未读（"没回"≠"没看见"的活证据）。
        unread: unreadStat,
        forward: forwardStat,
      });
      log.info(`[${traceId}] 跳过(${decision.reason}) ${session ? session.key : store.key(scene, id)} ${sender}: ${truncate(parsed.text)}`);
      return;
    }

    // ── D9b（E7）：群内「/安静」指令 ────────────────────────────────────
    // 只在**被点名**时认（`kind === 'named'`）：不带 @ 的一句「安静」可能是群里
    // 有人在说别的，不该让它闭嘴。`/安静 0` 就是解除。
    //
    // ⚠️ 执行完**直接 return，不回复**：一条"让我安静点"的指令，回一句"好的我安静了"
    //    是反讽（而且白烧一次模型调用）。可查性由 writeSkip 与日志保证 ——
    //    用户想知道有没有生效，看面板的「没回复」记录或 bridge.log，都写着原因。
    if (scene === 'group' && decision.kind === 'named') {
      const cmd = parseQuietCommand(parsed.text);
      if (cmd) {
        session.quietUntil = quietUntilOf(Date.now(), cmd.minutes);
        const what = cmd.minutes > 0 ? `安静 ${cmd.minutes} 分钟` : '解除安静';
        log.info(`[${traceId}] 群内指令「${truncate(parsed.text)}」→ ${what}（群 ${id}）；指令本身不回复`);
        writeSkip({
          traceId, stage: 'command', scene, id, sender,
          text: `${sender}: ${parsed.text}`,           reason: `群内指令：${what}（已生效，不回复）`,
          model: cfg.llm.model, baseUrl: cfg.llm.baseUrl,
          unread: unreadStat,
          forward: forwardStat,
        });
        return;
      }
    }

    // 插话判定一旦成立就吃掉这次冷却。
    // decide() 现在是纯函数（roll 由入参给），所以"记账"必须搬到这里 ——
    // 放在限流之前是刻意保持与旧行为一致：旧实现是在 decide() 内部就写了，
    // 所以即便紧接着被限流拦下，冷却也已经扣掉了。
    // ⚠️ D9a：认的是 `kind`（稳定枚举）而不是 `reason`（中文文案）——
    //    拿文案当枚举的话，改一个字的措辞就会静默改掉这里的分支。
    if (decision.kind === 'interject') session.lastInterjectAt = Date.now();

    const throttled = brain.throttleReason(session);
    if (throttled) {
      // 同上：被限流也是一种"没回"，而且要跟"决策就没答应"区分开（处置完全不同）。
      writeSkip({
        traceId, stage: 'throttle', scene, id, sender,
        text: `${sender}: ${parsed.text}`, reason: throttled,
        model: cfg.llm.model, baseUrl: cfg.llm.baseUrl,
        unread: unreadStat,
        forward: forwardStat,
      });
      log.info(`[${traceId}] 限流跳过(${throttled}) ${session.key}`);
      return;
    }

    // 记一下"刚被点名"的时间：插话逻辑靠它避让，
    // 否则前脚被 @、后脚它自己又插一句，看起来就是没头没脑的两条
    // （D9a：同上，改认 `kind`。）
    if (decision.kind === 'private' || decision.kind === 'named') {
      session.lastDirectAt = Date.now();
    }

    log.info(`[${traceId}] 响应(${decision.reason}) ${session.key} ${sender}: ${truncate(parsed.text)}`);

    // ── 扩展包钩子：before-context（第 47 轮 B12e-3）──
    // 与参考实现 orchestrator.js:763 同名同位（触发消息到手、上下文未建）。
    // 「本体情绪」靠它读入站文本的情绪暗示。空钩点时 emit 直接短路，零开销。
    await hookBus.emit('before-context', {
      triggerEntries: [{ text: String(parsed.text ?? ''), atMe: Boolean(parsed.mentionedSelf) }],
    });

    // 用 WithMeta 入口：C-BUDGET 砍掉了什么必须落进 trace，否则"它怎么突然忘了"
    // 无从排查 —— 静默失效的定义就是不报错，唯一解法是把"丢了什么"变成可查数据。
    //
    // ── D8：先问一次「今天 / 这个会话花了多少」────────────────────────────
    // 三档语义见 src/usage.js 头部。这里只做两件事：把档位**传下去**，并按档位
    // 决定提示词怎么组。**判据不在这一层**（本项目对"是不是写对了"的判据一律
    // 放在可被断言的纯函数里，接线点只负责把值送对地方）。
    const usageGate = usageGateOf({ chatKey: session.key });
    if (usageGate.level !== 'ok') {
      // 必须留痕：没有这条日志的话，"它今天怎么突然不爱理背景消息了"
      // 会被归因到人格或模型上，而真因是一张账。
      log.warn(
        `花费${usageGate.level === 'degrade' ? '触顶' : '进入收敛档'}（${usageGate.which === 'chat' ? '本会话' : '当日'}`
          + `已用 ${usageGate.which === 'chat' ? usageGate.chatTokens : usageGate.dayTokens}`
          + ` · 比例 ${(usageGate.ratio * 100).toFixed(1)}%）→ ${usageGate.level === 'degrade' ? '停止主动发言' : '只保留核心段落'}`
      );
    }
    const built = brain.buildMessagesWithMeta(session, evt, parsed, {
      saving: usageGate.level === 'trim',
      // D9a：这一轮带多少历史由**触发档位**决定（谁叫的它）。
      // 档位由 decide() 产出 —— 这里只是把值送过去，不在这一层做判定。
      tier: decision.tier,
      // D31-3：作息状态行与"刚起床补看"那句。两者都由**入参**送进去 ——
      // 本轮是不是补看轮，只有调用方手里的 `evt.isCatchUp` 知道（与 `tier` 同款），
      // 而作息状态是那个唯一判定点重算出来的快照（`sleepSnap`），不在这一层再算一遍。
      sleep: sleepSnap,
      catchUp: !!evt.isCatchUp,
    });
    const messages = built.messages;

    // ── 扩展包钩子：before-llm-messages（第 47 轮 B12e-3，orchestrator.js:857）──
    // 钩子可以直接改 messages（「本体情绪」往首条 system 追加状态行）。
    // 之后的 trace 记的是**改完之后**的 prompt —— 注入了什么如实可见。
    await hookBus.emit('before-llm-messages', { messages });

    // 工具 ctx（第 47 轮 B12e-3）：生态约定 execute(ctx, args) 的第一个参数。
    // 字段对照参考实现 orchestrator.js:888 —— 只放**真实在用的包需要**的，
    // 不 speculative 塞满（memory/stickers/reminders 没有包用时不上，要用再加）。
    //
    // ⚠️ `onebot` **不是**真实客户端，而是 `scopedOnebot()` 的代理（第 48 轮 B12e-4 · EX-SCOPE）：
    //    原始客户端是"绕过宿主一切出站策略"的口子（出口闸门 / 发送节奏 / 主动配额 / 会话存档
    //    全都不经过，而日志里只显示"工具调用成功"）。代理只放行只读动作，
    //    **发言类（send_*）一律拒绝并告警** —— 发言只走 `sender` 那条有闸门的路。
    //    理由与"为什么此处与参考实现有意不同"写在 `src/ext-scope.js` 文件头。
    const toolCtx = {
      chatKey: session.key,
      kind: scene,
      chatId: String(id),
      selfId,
      botName: cfg.persona?.botName ?? '',
      onebot: scopedOnebot(bot, { log }),
      sender: extSender,
      // ⚠️ **这里刻意不给 `session`**（P1 修复 → 第 49 轮复审去冗余，两步都走过）：
      //    ① 它起初给的是**整个可变的会话宿主对象** —— 本文件对钩子载荷的纪律是
      //       「只投影可读字段」（见 toolLoop 的 onToolCall）；交出去等于让外来代码
      //       就地改写 history / recentReplies，属于"改了不报错、事后无人能查"那一类；
      //    ② 收紧成 `{ chatKey }` 之后**仍是冗余** —— 顶层已经有 `chatKey` 了。
      //       实测全项目 `ctx.session` 零引用（plugins/ 下 5 个包都不读它），
      //       所以按原先注释自己承诺的「真有包要读时再按需加」直接去掉。
      //    要加回来之前，先用工具回合断言钉住它的形状 —— 否则又是"说不清该有什么"。
    };

    markThinking(true, { scene, id: String(id), sender, reason: decision.reason, traceId });
    let reply = '';
    let chatErr = null;
    let runToolResults = [];
    const t0 = Date.now();
    // ── D6：登记"这一轮在途"，并把 signal 交给模型调用链 ────────────────
    // 触发消息**随 begin 一起登记**：中止/失败之后要能**原地重放**（复用同一个会话，
    // 不新建、不换 id —— 换了会让会话列表膨胀，而重放的意义正是"接着刚才那句"）。
    // 它跟着 end() 一起搬进"上一轮"记录，重试判据才读得到。
    const signal = sessionCtl.begin(session.key, evt);
    try {
      reply = await gate(async () => {
        llm.lastUsage = null; // 清掉上一次的，避免请求失败时记错账
        // D18：跨会话发言的留痕按**轮**归零（工具往里累加，见 `toolSendTo`）。
        // 与 `llm.lastUsage = null` 同一位置、同一理由：不清的话上一轮的痕迹会跟着漏下来，
        // 而 trace 里那格是"这一轮做了什么"的答案。
        crossStat = null;
        // 工具回合（B12e-1）：注册表为空时**就是一次普通请求**，请求体逐字节不变。
        // ⚠️ 账务记的是**聚合值** —— 一次回复可能对应多次 HTTP（工具回灌后要再问一次），
        //    只记最后一次会让中间几轮的 token 一笔都不进账本。
        //    聚合实现在 src/tool-loop.js 的 aggregateUsage()，**单次请求时原样返回
        //    同一个 usage 对象**，所以下游读到的形状与改造前完全一致。
        const run = await toolLoop.run({
          messages,
          meta: { traceId, scene, id: String(id), sender, ctx: toolCtx },
          signal,
          // D8：服务端报"上下文过长"时用来收缩历史（纯函数，缩不动时返回原引用，
          // llm 据此放弃重发 —— 免得白打一枪还留一条"已收缩"的不实告警）。
          shrink: shrinkHistory,
        });
        llm.lastUsage = run.usage;
        runToolResults = run.toolResults || [];
        return run.text;
      });
    } catch (err) {
      // 不直接往上抛：先把这条链路记下来（控制台要能看到失败的那一次长什么样），
      // 再按原来的方式结束这一轮。
      chatErr = err;
    } finally {
      markThinking(false);
      // 一轮结束（成功/失败/中止都到这里）：把在途记录搬进"上一轮"。
      // ⚠️ 放在 finally 而不是 try 之后 —— 上面那条 catch 会 return，
      //    写在 try 之后的话"失败"这一支永远不会登记结果，重试判据就永远是空的。
      const outcome = abortOutcome(chatErr);
      sessionCtl.end(session.key, outcome);
      // 只有"一条未发出的失败"才登记为待重放。成功/普通错误都不登记 ——
      // 登记成功那一轮会让下一次 SIGUSR1 变成"把刚才的回复合法地再说一遍"。
      if (outcome === 'aborted' || outcome === 'timeout') lastStalled = session.key;
    }
    const ms = Date.now() - t0;
    // D8：带上会话键。**必须判空再展开** —— `{ ...null }` 是个真值对象，
    // 直接展开会把"这次根本没有可记的用量"变成一条全 0 的假账。
    if (llm.lastUsage) recordUsage({ ...llm.lastUsage, chat: session.key, source: USAGE_SOURCES.agent });

    // 记链路。失败的那条也记 —— 「模型没回话」时最需要看到的就是它收到了什么。
    // 先只填共同字段，等 parseReply 出来再补上「最终会发哪几段」，最后统一落盘。
    const usedModel = llm.lastUsage?.model || '';
    const rec = {
      t: Date.now(),
      // 贯穿全程的把手（B10a · O-TRACE）：面板上这一条与 bridge.log 里那几行靠它对上
      traceId,
      kind: 'reply',
      scene,
      id: String(id),
      sender,
      reason: decision.reason,
      model: cfg.llm.model,
      baseUrl: cfg.llm.baseUrl,
      used: usedModel,
      downgraded: !!(usedModel && usedModel !== cfg.llm.model),
      thinking: cfg.llm.thinking,
      text: `${sender}: ${parsed.text}`,
      prompt: promptText(messages),
      messageCount: messages.length,
      ms,
      usage: llm.lastUsage
        ? { prompt: llm.lastUsage.prompt, completion: llm.lastUsage.completion, reasoning: llm.lastUsage.reasoning }
        : null,
      raw: String(reply ?? ''),
      silent: false,
      chunks: [],
      error: '',
      // 这一轮实际塞进提示词的记忆（工作台「测试」要显示"给了它哪几条"）。
      // 如实记"注入了什么"，不假装知道"它参考了哪条"——见 brain.memoryInPrompt 的注释。
      // ⚠️ 必须带 ctx：结构化记忆（ATI-3）是**按会话隔离**的，不给上下文就选不出来，
      //    于是 memoryUsed 会漏记它（真机实测 2026-09-23：prompt 里有、这里没有）。
      memoryUsed: brain.memoryInPrompt({ chatKey: session.key, userId: evt.user_id }),
      // 同上，技能：命中是确定的（开关 + 范围 + 触发词），所以这里报出去的可以逐条对上。
      // 排查"是不是某条技能把语气带跑了"就靠它。
      skillsUsed: brain.skillsInPrompt(evt, parsed).map((s) => ({ kind: s.kind, name: s.name })),
      // 识图这条链有三道输入：模型支不支持、开关开没开、这条消息到底带了几张图。
      // 之前三道**一个都不落盘** → 界面上「开了识图却没反应」和「根本没收到图」完全同形，
      // 只能靠猜。三个值如实记下来，是谁挡住的（还是压根没图）一眼可辨。
      vision: {
        supports: supportsVision(cfg.llm?.model, cfg.llm?.provider),
        featureOn: !!cfg.llm?.features?.vision,
        imagesCount: Array.isArray(parsed.images) ? parsed.images.length : 0,
        // B10a · O-IMGURL：只留 8 位哈希，**不落原始 URL** ——
        // QQ 图片地址常带签名 / 临时 token，原样写进 local-trace.jsonl 等于泄凭据。
        // 有它就能判"这条到底带了几张、是不是同一张"，又拿不到可访问的地址。
        images: imageRefsOf(parsed.images),
        // Q26b 裁决②：**这一枪实际用的模型是不是瞎的**。
        // `supports` 看的是**配置的**主模型，而真机上常常降到链上的下一个 ——
        // 降级链首位 `glm-4.5-air` 实测看不见图，于是"识图开着"与"它看到了图"
        // 在界面上是两件分不开的事。`null` = 图片正常发给了它（或压根没图）。
        blind: llm.lastBlind || null,
      },
      // C-BUDGET 这一轮被预算砍掉的段落（默认预算下恒为空数组）。
      // 「它怎么突然忘了」这个问题第一次有地方可查。
      dropped: built.dropped,
      // C-AMBIENT：这一轮背景窗口带了几条、是不是整批换过（复量"ambient 变动率"的数据源）。
      ambient: built.ambient,
      // D11a：这一轮**记忆没提什么**（淡忘掉的 / 超预算掉的，分开记）。
      // ⚠️ 直接取 `built.memory`，**不在这里重选一遍** —— 重选等于把同一份判据跑两遍，
      //    还可能因为时间流逝选出不同结果，于是 trace 与真发的提示词对不上。
      memoryDropped: built.memory,
      // D30：这一轮消费掉的未读。放在 reply 记录上之后，"它没回"（skip）与
      // "它回了但没看见那条"在复盘窗口里是**同一列的两种取值**，一眼可比。
      unread: unreadStat,
      // Q37：这一轮的**睡眠处境**（是不是被叫醒的 / 是不是补看轮）。
      // 之前这两件事只能靠提示词正文（REST_LINE / CATCHUP_LINE）或 journal 间接关联 ——
      // 想回答"它这句为什么是这个口气"要人肉把三处对起来。落进 trace 之后，
      // 面板的复盘窗口能直接按它筛（补看轮 vs 正常轮）。
      // ⚠️ 只**记录**、不参与任何判定（`decide` 与闸门都不读它）。
      // ⚠️ Q86：用**生成前冻结的那一份**（`sleepRound`），不在这里再读一次快照 ——
      //    再读一次就等于"提示词一句、trace 一句"，两边在跨 tick 时会各说各话。
      sleep: sleepRound,
      // D23-2：这条消息里的合并转发展开成了什么（`null` = 这条消息压根没有转发段）。
      // 与 skip 记录同一格 —— "它说看不见转发"是不是真的，两处口径一致。
      forward: forwardStat,
      // D18：这一轮它**跑去别的群说了什么**（`null` = 没跨群说过话）。
      // 跨会话发言是"你不在场的那个群里多出了一句"—— 面板与 journal 是事后唯一的线索，
      // 所以这一格不是可观测的锦上添花，而是这个功能的**审计面**。
      cross: crossStat,
    };

    if (chatErr) {
      // ── D6：中止不是失败，必须与"模型调用失败"分开走 ──────────────────
      // 三种后果都不一样，混在一起会同时错三处：
      //   ① 日志：报「模型调用失败」会把人引去查服务商，而真相是用户自己点了停止；
      //   ② 副作用：`after-response` 的 error 会让「本体情绪」降精力 ——
      //      人点个停止就掉精力，那是拿用户的耐心换一个 bug；
      //   ③ 账面：trace 里必须留下 `outcome: 'aborted'`，否则事后分不清
      //      "它答不上来" 与 "人让它别说"。
      const outcome = abortOutcome(chatErr);
      rec.outcome = outcome;
      rec.error = chatErr.message;
      writeTrace(rec);
      if (outcome === 'aborted') {
        log.info(`[${traceId}] 本轮已被中止（没有发出任何消息）(${session.key})`);
        // 中止**不发** after-response 的 error 分支：它不是失败事件。
        // 但要发一个"本轮结束"的事实，否则钩子那边会以为这一轮还在跑。
        await hookBus.emit('after-response', {
          response: '',
          session: { chatKey: session.key, sent: [], aborted: true, toolResults: [] },
        });
        return;
      }
      log.error(`模型调用失败: ${chatErr.message}`);
      // after-response 在**失败路径**也要发（第 47 轮 B12e-3）：「本体情绪」
      // 靠失败事件降精力，缺了它模型报错时情绪永远停在原地。
      await hookBus.emit('after-response', {
        response: '',
        session: { chatKey: session.key, sent: [], error: chatErr.message, toolResults: [] },
      });
      return;
    }

    const { silent, chunks, blocked, internal } = brain.parseReply(reply);

    // ── ATI-4：表情习惯（确定性闸，全项目**只在此一处**接线）──
    // 判据在 face-habit（纯函数，`rng`/`now` 全由入参给）；这里只做"问一次"，
    // **真的发出去之后**才记账（发送失败的那段不算 —— 与记忆"只记真的发出去的"同一口径）。
    // 三条：不是每条都带（冷却 + 概率）· 位置不一定在末尾（三种位置）· 类型不单一（最近用过的降权）。
    // ⚠️ 只开表情开关且模型自己没插过的段落才加 —— 模型自己插的不再叠加（每轮最多 1 个）。
    let faceId = null;
    // 观测留档（第 15 轮）：ATI-4 那三张 golden 表（频率 / 位置 / 类型）一直"待真机数据"，
    // 而真机上唯一能回答"闸到底触发过几次"的东西不在任何日志里 —— 只有一处 `log.info`。
    // 落进 trace 之后，数据会**自己攒起来**，不用再靠人去等一次偶发。
    // ⚠️ 只加字段、不改判据：`faceDecision` 的入参与调用时机一个字没动。
    let facePlace = '';
    let faceSelf = false;
    // D14：这一轮用的是内置表情还是收藏表情。**与 faceId 分开存** ——
    // `faceId` 一个变量一个语义（"用了哪一张"），类别是另一个语义（见"一个变量不许两个语义"）。
    let faceKind = '';
    // 本轮用到的自定义表情令牌 → URL。**刻意只活在本轮**：URL 可能带临时签名，
    // 跨轮留着等于缓存一个过期地址；而且它不进 trace / 日志 / 会话历史 ——
    // 那些地方只会出现令牌（=URL 的短哈希）本身。
    const roundCustom = new Map();
    const outChunks = [];
    for (const c of chunks) {
      if (faceId !== null || !cfg.llm?.features?.stickers || hasFaceMark(c)) {
        // 模型自己写了 [face:N]（含自定义令牌）—— 这正是"代码闸一次都没被用上"的原因，如实记下来
        if (hasFaceMark(c)) faceSelf = true;
        outChunks.push(c);
        continue;
      }
      const st = faceHabit.stateOf(session.key);
      const d = faceDecision({
        now: Date.now(),
        lastFaceAt: st.lastFaceAt,
        recentFaces: st.recentFaces,
        presets: FACE_PRESETS,
      });
      if (!d.attach) {
        outChunks.push(c);
        continue;
      }
      // ── D14 二级选择：这一轮**已经**决定"要带一个"了，再决定带内置还是带收藏 ──
      // ⚠️ 这**不是第二道闸**：冷却 / 概率 / 位置仍然只由 `faceDecision` 说了算，
      //    所以那三张 golden（频率 / 类型轮转 / 位置分布）继续有效。
      // 一条收藏都没有（或上次拉取失败且无旧值）→ `shouldUseCustom` 恒假 → 退化成内置表情
      //    = **与今天逐字相同的现状**。接口抖动不会改变它的说话方式。
      const custom = shouldUseCustom({ has: customFaceCache.urls.length > 0 })
        ? pickCustomFace(customFaceEntries(customFaceCache.urls), { recent: st.recentFaces })
        : null;
      if (custom) {
        // 令牌进文本（可以被 trace / 历史安全保存），URL 只留在本轮的内存表里
        roundCustom.set(custom.token, custom.url);
        faceId = custom.token;
        faceKind = 'custom';
      } else {
        faceId = d.faceId;
        faceKind = 'builtin';
      }
      facePlace = d.place;
      outChunks.push(applyFaceMark(c, faceId, facePlace));
    }
    if (faceId !== null) {
      log.info(`这一轮带表情 [face:${faceId}]（${faceKind === 'custom' ? '收藏' : '内置'}）(${session.key})`);
    }

    rec.chunks = outChunks;
    // 三个字段一起才回答得了"闸到底有没有在工作"：
    //   gateOff = 开关没开（不是闸的问题）· selfWritten = 模型自己插了（闸被短路，第 14 轮的成因）
    //   attached = 代码闸真的动手了 —— 只有它为真，那三张 golden 才谈得上被真机验过。
    rec.face = {
      gateOff: !cfg.llm?.features?.stickers,
      selfWritten: faceSelf,
      attached: faceId !== null,
      faceId: faceId === null ? null : faceId,
      // D14：'builtin' 还是 'custom'。**空串 = 这一轮没带表情**。
      // 有它才能回答"收藏表情那条路到底有没有被走通过"——没有这个字段，
      // 收藏为空与"永远选中内置"在账面上一模一样。
      kind: faceKind,
      place: facePlace,
    };
    // 出口闸门拦下的原因如实落盘：拦了却不留痕，用户只能看到"它突然不理我"。
    rec.blocked = blocked || '';
    // B33：模型复读了内部标记时命中的词干（已从要发的内容里剥掉）。
    // 落盘的理由与 `blocked` 完全同一条：拦了不留痕，下一次只能靠人去群里偶然看到
    // ——而这一条的**表现是"它突然沉默"**，比"它不理我"更难归因。
    rec.internal = internal;

    // ── 表达规范观测（ATI-1）──
    // **只记录、不拦截**：命中只是"它这句说了客服腔"，拦掉一整条比它本身更糟。
    // 这一步的目的是把"像不像人"从主观印象变成**能看趋势的数字**（先攒频率，再谈收紧）。
    // 口径：只看**真要发出去的**那几段（被出口闸门拦下的整条已经在下面 return 了）。
    // ⚠️ 面板当前**没有**这一项的专用卡片 —— 它随记录一起落进复盘窗口，
    //    查得到，但不是"界面上看得见的功能"，别把这两件事混起来说。
    const speech = scanSpeech(outChunks.join(' '));
    rec.speech = speech;
    if (speech.count) {
      log.info(
        `表达规范命中 ${speech.count} 处（${speech.groups.join('/')}）：${speech.hits.map((h) => h.word).join('、')} (${session.key})`
      );
    }
    writeTrace(rec);

    // ── 出口闸门（B8 · S-EGRESS）──
    // 命中凭据 / 本机路径 → **整条不发**（不是丢一段）。
    // 这里**必须打日志**：静默拦掉是本项目最怕的失败模式。
    if (blocked) {
      log.warn(`出口闸门拦截（${blocked}）→ 这条不发 ${session.key}`);
      // D9b：拍一拍那一轮**不进历史**（报告 E7 原话："标记该事件不进历史，防模型复读"）。
      // 三处 remember 都要守 —— 只守主路径的话，"被拦下"和"选择潜水"两支照样把它记进去。
      if (!evt.isPoke) {
        brain.remember(session, 'user', renderSpeakerLine(sender, parsed.text));
        brain.remember(session, 'assistant', INTERNAL_MARKS.EGRESS);
      }
      // 仍然记账：这一轮确实被"消费"掉了。不记的话下一 tick 可能立刻重试同一条，
      // 变成"被拦住 → 再生成 → 再被拦住"的空转（而且每次都要烧一次模型调用）。
      brain.markReplied(session);
      return;
    }

    if (silent) {
      // B33：这一支现在有**两种**来路，日志必须分开 —— 否则"它自己不想说"与
      // "它复读了内部标记、被我们剥空了"在日志里同形，而后者是要盯的缺陷信号。
      if (internal.length) {
        log.warn(
          `模型复读了内部标记（${internal.join('/')}）→ 已剥掉；剥完没有剩下可发的内容，这一轮不说话 ${session.key}`
        );
      } else {
        log.info(`模型选择潜水 ${session.key}`);
      }
      if (!evt.isPoke) {
        brain.remember(session, 'user', renderSpeakerLine(sender, parsed.text));
        brain.remember(session, 'assistant', INTERNAL_MARKS.SILENT);
      }
      brain.markReplied(session);
      return;
    }

    // B33：剥掉了内部标记，但还有真话要说 → 照发，同时**留痕**。
    // 这一条日志是"它少说了一句"与"它说了不该说的"之间的分界：没有它，
    // 只能靠人去群里偶然发现"它今天是不是漏了半句"。
    if (internal.length) {
      log.warn(`模型复读了内部标记（${internal.join('/')}）→ 已剥掉，其余照发 ${session.key}`);
    }

    const segments = [];
    if (cfg.reply.quoteOnReply && scene === 'group' && evt.message_id) {
      segments.push(replySegment(evt.message_id));
    }
    // 被 @ 了当然要 @ 回去；工作台里勾了「回复时 @ 人」的话，主动接话时也带上。
    if (scene === 'group' && (parsed.mentionedSelf || cfg.custom?.replyStyle?.mentionAt)) {
      segments.push(atSegment(evt.user_id), textSegment(' '));
    }

    // ── 发送闸（第 46 轮 B12e-2）──
    // 每一条**发出之前**合成一次 `send_message` 工具调用，喂给 `before-tool` 钩子。
    // 扩展包（如 `复读拦截`）看到的东西与它在参考实现里看到的逐字段相同 ——
    // 而本项目的"说话方式"一个字都没变（见 src/send-guard.js 文件头）。
    //
    // ⚠️ **没有钩子时 `check()` 直接短路**：`sentTexts` 就是 `chunks`，
    //    日志与记忆内容与改造前逐字相同（断言 T115 钉着这一点）。
    const sentTexts = [];
    const guardBlocked = [];
    const lateBlocked = [];
    // ── 出站媒体护栏（D15 · 报告 E11 ③）──
    // 图片张数的口径是**整轮**（跨分段），所以计数器必须活在循环**外面**；
    // 而裁剪判据本身是 `brain.js` 的纯函数 `capImageSegments`（零 IO、smoke 直接钉）。
    // ⚠️ 只在这里接一处：别在分段的构造器里再判一次 —— 那样"一轮几张"就有了第二份口径。
    let imagesSent = 0;
    let imagesSeen = [];
    for (let i = 0; i < outChunks.length; i += 1) {
      // ── 发送时刻复核（第 56 轮 F1-2 · E22）──
      // 「判定通过」到「真的发出去」之间隔着模型生成（秒级）与逐条节奏（每条 1s 起），
      // 而面板支持热改白名单 —— 在那段窗口里把群移出白名单，旧回复会照发。
      // 所以**在真正调用 sendMsg 之前**再核一次：许可现值 + 会话还是不是当初那一个。
      // 判据本身在 `src/brain.js` 的 `lateSendReason()`（纯函数，与 `isAllowed` 同源）。
      // ⚠️ 位置刻意在 `sendGuard.check()` **之后**、`bot.sendMsg()` **之前**：
      //    前者管扩展包的否决权，后者才是真正把字发出去的那一刻。
      const late = lateSendReason(brain.gateReason(evt), store.sessions.get(session.key) === session);
      if (late) {
        // 拦下**必须留痕**（B6「静默失效见光」）：否则表现是"它话说到一半停了"，
        // 而日志里只有"已回复 N 条"，查不出为什么少了一段。
        lateBlocked.push({ text: outChunks[i], reason: late });
        log.warn(`[${traceId}] 发送前复核拦下第 ${i + 1}/${outChunks.length} 条：${late}`);
        break; // 后续分段同属这一轮，许可已经变了 —— 整轮停掉，不做"跳一条接着发"
      }
      const verdict = await sendGuard.check({ chunks: [outChunks[i]], chatKey: session.key, sentTexts });
      if (verdict.vetoed) {
        // 拦住**必须留痕**：静默丢一条的表现是"它突然少说了一句"，而日志里什么都没有。
        guardBlocked.push({ text: outChunks[i], owner: verdict.vetoed.owner, reason: verdict.vetoed.reason });
        log.warn(`发送闸拦下第 ${i + 1} 条（${verdict.vetoed.owner}）：${verdict.vetoed.reason}`);
        continue;
      }
      // 把 [face:14] 这类标记拆成真正的 QQ 消息段，和文字一起发。
      // D14：自定义令牌（`cf-…`）分流成**图片段** —— 收藏表情没有 face id 可寻址，
      //      协议端给的就是图片 URL（实测 `fetch_custom_face` 返回「表情URL列表」）。
      // 分类判据在 `classifySegments`（brain.js 里的纯函数，smoke 直接钉它）；
      // 这里只剩"三态 → 三个 Segment 构造器"。
      // D15（E11 ③）：分流之前先过**出站媒体护栏**（整轮去重 + 张数上限）。
      // ⚠️ 裁掉必须留痕 —— 否则表现是"它这一轮少发了一个表情"，日志里什么都没有。
      const capped = capImageSegments(classifySegments(outChunks[i], (tok) => roundCustom.get(tok)), {
        used: imagesSent,
        seen: imagesSeen,
      });
      if (capped.dropped) {
        log.warn(
          `[${traceId}] 出站媒体护栏裁掉 ${capped.dropped} 张图（本轮已发 ${capped.used} 张，上限 ${IMAGE_CAP_PER_RUN}）` +
            '—— 同一张图只发一次，且一轮不超过上限'
        );
      }
      imagesSent = capped.used;
      imagesSeen = capped.seen;
      const parts = capped.parts
        .map((s) => {
          if (s.type === 'face') return faceSegment(s.id);
          if (s.type === 'image') return imageSegment(s.url);
          return textSegment(s.text);
        });
      // 兜底也用 `stripFaceMarks`：原样兜底会把认不出的令牌当文字发出去。
      if (!parts.length) parts.push(textSegment(stripFaceMarks(outChunks[i])));
      const payload = sentTexts.length === 0 ? [...segments, ...parts] : parts;
      try {
        // M-4：把自己发出去的 message_id 记下来，供"引用了我的话"判定用。
        // ⚠️ 记的是**响应里的** id（不是我们自己编的）—— 只有它才和后面对端回传的
        //    `reply` 段 id 是同一套编号。取不到就返回空数组（不猜），见 reply-track.js。
        selfSentIds = noteSelfSent(selfSentIds, messageIdsOf(await bot.sendMsg(scene, id, payload)));
      } catch (err) {
        log.error(`发送失败: ${err.message}`);
        // 中断必须**说出来**：break 之后剩余分段既不发出也不进记忆，
        // 静默丢弃的表现是"话说到一半"，日志里却什么都不剩。
        const remaining = outChunks.length - i - 1;
        if (remaining > 0) log.warn(`发送中断：本次还有 ${remaining} 段未发出（协议端可能断连）`);
        break;
      }
      sentTexts.push(outChunks[i]);
      // D6：记"这一轮真的发出去了" —— 重试判据靠它挡住"重复刷屏"。
      // ⚠️ 位置必须在 sendMsg **成功之后**：记在发送前的话，一次发送失败也会被
      //    当成"已发言"，于是那一轮就永远不许重试了（可重试性凭空消失）。
      sessionCtl.markSent(session.key);
      if (i < outChunks.length - 1) await sleep(sendDelayFor(outChunks[i], cfg.reply));
    }

    // ATI-4 记账：**只在真的发出去之后**（发送中断的话表情没落地，不算）
    if (faceId !== null && sentTexts.length) {
      faceHabit.note(session.key, faceId, Date.now());
    }

    // ⚠️ 记忆里记的必须是**真的发出去的**那几条。记 `chunks` 的话，
    //    被闸门拦掉的内容会进历史 —— 下一轮模型会以为自己说过那句话。
    // ⚠️ 而"一条都没发"时的占位文字必须**按原因分岔**（本批引入，别退回一句话）：
    //    发送闸拦下 = 内容重复（那个占位是对的）；发送前复核拦下 = **许可变了**，
    //    套用"内容重复"会让下一轮的模型与面板都读到一个错误的原因。
    if (!evt.isPoke) {
      brain.remember(session, 'user', renderSpeakerLine(sender, parsed.text));
      brain.remember(
        session,
        'assistant',
        sentTexts.length
          ? sentTexts.join(' ')
          : lateBlocked.length
            ? INTERNAL_MARKS.LATE
            : INTERNAL_MARKS.DUP
      );
    }
    brain.markReplied(session);

    // ── D11b·④：跨轮工作记忆的**唯一**收口 ──────────────────────────────
    // 位置在**这一轮真的发完之后**（全局设计约束第 5 条：状态变更延到本轮回复发完之后）。
    // 只记两类客观状态：问过一句还没等到回答 / 有话没说出口。心理活动一律不记 ——
    // 理由见 src/working-memory.js 文件头（对面那份实现逐条看过 4732 条真实注入行）。
    //
    // ⚠️ 上面那些提前 return 的分支**故意不记**，每一条都有理由：
    //   被中止 / 模型失败 —— 前者是"人让它别说"，记成"有半截话"会诱导下一轮补上；
    //   出口闸门拦下      —— 那句话按判据**不该**发出去，同样不该提醒它再说一遍；
    //   模型选择潜水      —— 它自己决定不开口，不是"没交代"。
    // 反过来说，这里记的 `unsaid` 只可能是"外界原因没说出口"（许可变了 / 发送中断），
    // 而**不是**"内容不该说"（那一条由 `guardBlocked` 排除）。
    session.workingTurns = nextTurns(session.workingTurns, {
      now: Date.now(),
      sentTexts,
      unsaid: !sentTexts.length && outChunks.length > 0 && !guardBlocked.length,
    });

    if (sentTexts.length) log.info(`已回复 ${sentTexts.length} 条 (${session.key})`);
    else if (lateBlocked.length) {
      log.info(`这一轮没有发出任何消息（发送前复核拦下 ${lateBlocked.length} 条：${lateBlocked[0].reason}）(${session.key})`);
    } else log.info(`这一轮没有发出任何消息（发送闸全拦 ${guardBlocked.length} 条）(${session.key})`);

    // ── 扩展包钩子：after-response（第 47 轮 B12e-3，orchestrator.js:997）──
    // 「本体情绪」按本轮结果更新状态。sent 只含**真的发出**的文本（被发送闸
    // 拦下的不在内）——与记忆里的口径一致；toolResults 来自工具回合的逐调用记录。
    await hookBus.emit('after-response', {
      response: String(reply ?? ''),
      session: {
        chatKey: session.key,
        sent: sentTexts.map((text) => ({ type: 'text', text })),
        error: '',
        toolResults: runToolResults,
      },
    });

    // 「自我记忆 → 自动记录」：让它判断刚才这段有没有值得长期记住的事。
    // **故意不 await** —— 判断本身要花一次模型调用，等它等于让群里多等几秒，
    // 而"记住"晚半分钟毫无影响。里面自带限流与失败兜底，绝不打扰正常回复。
    //
    // ATI-P0：`sender` 是**显示名**（群名片 > 昵称 > 兜底），会改名、会重名，
    // 拿它当"这是谁"的键迟早把两个人的印象挂到一起。所以额外带上 `user_id`。
    // 显示名也一起传：改名之后仍看得出"当时叫什么"。
    keeper.consider({
      sender,
      text: parsed.text,
      reply: outChunks.join(' '),
      scene,
      id: String(id),
      userId: String(evt.user_id),
      senderName: sender,
      // ATI-3 的判断要**看见语境**：只给一条孤立的消息，模型没法判断「方向」——
      // 真机实测（2026-09-24）：把「他说以后别加喵」记成了「他喜欢加喵」，
      // 把「他自己不带 ✨」记成了「他不喜欢别人带 ✨」。
      // 用群里的环境消息（带说话人）当上下文；当前这条也在 ambient 里，由 #judge 去重。
      // 只取最近 8 条：够看清语境，又不至于把每次判断的成本抬上去（90 秒一次）。
      // ⚠️ D-M1：**必须带上 QQ 号**（`speakerId`）。判官要回答"这条记忆是关于谁的"，
      //    而它只认身份号 —— 只给显示名的话，它只能猜，而体检证明它猜错了 18/35 次。
      //    号只在判官那一份 prompt 里用（拼成 `【阿岚 #1234】`），**不进主提示词**。
      history: (session.ambient || [])
        .slice(-8)
        .map((a) => ({ speaker: a.speaker, text: a.text, speakerId: a.userId })),
      // ATI-3：记忆要能追溯到**是哪一条消息**说的，否则"这条记忆从哪来"永远答不出
      messageId: String(evt.message_id ?? ''),
    }, {
      // ── D29 · 判定卡（判定可见性）────────────────────────────────────────
      // 判官跑完（成功 / 没记 / 失败三种都算）回调一次，落到这张卡上。
      // `traceId` 由**这里**闭包带进去 —— 记忆模块不认识 trace，也不该认识：
      // 它只报事实，写哪里、写什么形状由宿主说了算（这样它才能被单独喂输入断言）。
      onResult: (rep) => writeJudgeCard({
        ...rep,
        traceId,
        scene,
        id,
        // 与 reply 记录同口径：`model` = 配置里写的那个，`used` = 实际应答的那个。
        // 判官用的是**同一个** LlmClient，所以降级链一样可能换掉它 —— 记下来才查得动。
        model: cfg.llm.model,
        used: rep.model || '',
      }),
    });
  }

  /**
   * ════════════════════════════════════════════════════════════════════
   *  定时主动说话 / 定时消息（工作台「触发方式」）
   * ════════════════════════════════════════════════════════════════════
   *  两条规则共用一套投递逻辑，区别只是"说什么"：
   *    定时消息     —— 用户写死的文本，到点原样发
   *    定时主动     —— 到间隔了让模型起一个新话题（没填文本时）
   *
   *  免打扰时段**默认 23:00–08:00**（可在工作台改）。理由：用户设了"每 90 分钟主动说一句"
   *  之后忘了关，凌晨三点在群里冒一句，是那种"一次就够丢人"的事故。
   *  界面上写明了这条规则，所以它不是隐藏行为。想取消就把起止设成同一个小时。
   */

  /**
   * 现在是不是免打扰时段。
   *
   * ⚠️ 这个区间通常是**跨零点**的（23 → 8），所以不能写成 from <= h < to ——
   * 那样 23 点到 8 点之间会因为 from > to 而永远判成"不在静默期"，
   * 等于这个功能悄悄失效，而且不报错。
   */
  function inQuietHours(hour) {
    const q = cfg.custom?.trigger?.quietHours || { from: 23, to: 8 };
    if (q.from === q.to) return false; // 起止相同 = 不静默
    if (q.from < q.to) return hour >= q.from && hour < q.to;
    return hour >= q.from || hour < q.to;
  }

  async function sayToGroup(groupId, text) {
    // 分句 + 出口闸门判定在 src/proactive.js 的 plannedProactiveChunks（纯函数，
    // smoke T134 钉行为）。这里是它**唯一的接线点**（check-wb 契约钉住接线不被摘掉）：
    // 命中凭据/本机路径就**整条不发** —— 与 brain.parseReply 的口径一致：
    // 丢一段留一段，剩下的半句照样把上下文泄了。
    // 抛错而不是返回 0：让 tickProactive 现成的 catch 把原因记进日志，
    // 也避免调用方把"被拦下"误当成"已发出"去记账（markReplied）。
    const { chunks, blocked, internal: profInternal } = plannedProactiveChunks(text, { maxChunks: cfg.reply.maxChunks });
    if (blocked) {
      throw new Error(`出口闸门拦截（${blocked}）→ 主动/定时消息整条不发`);
    }
    // B33：同一条留痕纪律 —— 剥了标记必须说出来，否则表现是"它今天话变短了"，
    // 而日志里什么都不剩（主动链没有 trace 记录，日志是唯一现场）。
    if (profInternal.length) {
      log.warn(`主动链复读了内部标记（${profInternal.join('/')}）→ 已剥掉，其余照发 群 ${groupId}`);
    }
    for (let i = 0; i < chunks.length; i += 1) {
      await bot.sendMsg('group', String(groupId), [textSegment(chunks[i])]);
      // 主动路径与主链路共用同一处节奏计算（src/pace.js）——
      // 两处各写一遍的话，迟早出现"主动消息还是那个整齐的固定延迟"。
      if (i < chunks.length - 1) await sleep(sendDelayFor(chunks[i], cfg.reply));
    }
    return chunks.length;
  }

  // ── D18 · 跨会话发言：两个宿主工具的实现（**唯一执行处**）──────────────────
  //
  // ⚠️ **出口只有一个**：`sayToGroup`（出口闸门 / 分句 / 发送节奏全在它里面）。
  //    这里**不许**出现 `bot.sendMsg` —— 那就是第二条发送路径（§3.2 第 1 条）。
  // ⚠️ **限额只有一个**：`planFor`（与主链路、定时消息同一个限流判据，含花费档位）——
  //    不在这里另判一套；两套各判一次迟早不一致。
  // ⚠️ 每种拒绝都**回灌成文本**、绝不抛错：抛错会被工具回合吞成一句"执行失败"，
  //    而这里的理由每一条都是模型能据以改主意的（换一个群号 / 换一个时机）。
  // ⚠️ 失败一律带 `isError: true` —— 让 `after-tool` 钩子（本体情绪）看得见"它碰壁了"。

  /**
   * 本轮跨会话发言的留痕（trace 的 `cross` 一格）。
   * `null` = 这一轮没有跨群说话 —— 与 `forward` 同一口径：**没发生过的事如实是 null**，
   * 而不是"发了 0 条"的空壳（那种壳会让排查的人以为"它试过了但没成"）。
   * 由 `handleMessage` 在**跑工具回合之前**置空，工具往里累加。
   */
  let crossStat = null;

  /**
   * 这个群此刻能不能开口。空串 = 可以。
   * 四道判据**全部复用既有实现**，一条新写的都没有：总闸是 `allowProactive`、
   * 睡着看 `sleepSnap`、免打扰是 `inQuietHours`、配额是主链路同一个 `planFor`。
   */
  function crossBlockReason(group) {
    const c = cfg.custom;
    if (!c || c.allowProactive === false) return '主动发言的总闸是关着的';
    if (sleepSnap?.asleep) return `它在睡觉（计划 ${sleepSnap.bed}–${sleepSnap.wake}）`;
    if (inQuietHours(new Date().getHours())) return '现在是免打扰时段';
    const item = planFor([String(group)])[0];
    return item && !item.send ? item.reason : '';
  }

  /** `get_chats`：它还能去哪些群说话（**只读**，不产生任何副作用） */
  function toolGetChats(ctx = {}) {
    const groups = (cfg.allow.groups || []).filter(Boolean);
    // `selfGroup` 只对群会话有意义：私聊里"当前会话"不是一个群，没有可标记的对象。
    const selfGroup = ctx.kind === 'group' ? String(ctx.chatId ?? '') : '';
    const list = crossChatsOf({ groups, sessionOf: sessionOfGroup, now: Date.now() });
    return { content: renderCrossChats(list, { selfGroup }) };
  }

  /** `send_to`：去**另一个**群说一句话（出口是 `sayToGroup`，见上） */
  async function toolSendTo(ctx = {}, args = {}) {
    const groups = (cfg.allow.groups || []).filter(Boolean);
    const target = resolveCrossTarget(args.group, groups);
    if (!target.ok) return { content: `没发出去：${target.reason}`, isError: true };
    if (ctx.kind === 'group' && String(ctx.chatId ?? '') === target.group) {
      return { content: '这就是你正在说话的群 —— 直接回答就行，不用工具。', isError: true };
    }
    const why = crossBlockReason(target.group);
    if (why) return { content: `现在不能发：${why}`, isError: true };
    const norm = normalizeCrossText(args.text);
    if (!norm.ok) return { content: `没发出去：${norm.reason}`, isError: true };

    try {
      const n = await sayToGroup(target.group, norm.text);
      // 主动出站也要**记账**（D17 的同一条）：不记的话它根本不算"发过话"，
      // 这道配额闸门就只是装饰品。
      brain.markReplied(sessionOfGroup(target.group));
      // 留痕在**第一次真的发出去**时才建 —— 于是 `crossStat === null` 就等于
      // "这一轮没有跨群说过话"，而不是"说过 0 句"的空壳。
      if (!crossStat) crossStat = { chunks: 0, groups: [] };
      crossStat.chunks += n;
      if (!crossStat.groups.includes(target.group)) crossStat.groups.push(target.group);
      journal('cross', `跨会话发言 → 群 ${target.group}：${truncate(norm.text, 40)}`);
      log.info(`跨会话发言（群 ${target.group}，${n} 段）：${truncate(norm.text)}`);
      return { content: `已发到群 ${target.group}。` };
    } catch (e) {
      // 出口闸门拦下 / 发送失败都走到这里。**如实告诉模型**（否则它会以为已经说出去了，
      // 然后在自己的回复里说"我刚在那边说了一句"—— 而群里什么都没看见）。
      return { content: `没发出去：${e.message}`, isError: true };
    }
  }

  /** 生成一句主动开场白。用户填了文本就用用户的，没填才问模型 */
  async function composeTopic(p) {
    if (p.text && p.text.trim()) return p.text.trim();
    const name = cfg.persona?.name || '机器人';
    const out = await gate(async () => {
      // 旁路记账（P1 修复）：llm.chat() 会写共享的 lastUsage，与主链路互相覆盖
      // —— 正是 llm.js 文件头点名反对的用法。chatWithUsage 把这一笔的 usage
      // 直接交回调用方，在这里落账，谁也不盖谁。
      const { text, usage } = await llm.chatWithUsage(
        [
          {
            role: 'system',
            content:
              `你是 QQ 群里的普通群友，名字是「${name}」。群里已经很久没人说话了。` +
              '请你起一个新话题，像真人随口抛一句那样。' +
              '要求：一句话，30 字以内，口语化；不要问候式开场（别用"大家好""在吗"）；' +
              '不要 @ 任何人；不要 Markdown；不要解释你在做什么。',
          },
          { role: 'user', content: '（群里静了很久）' },
        ],
        // ⚠️ 同 `memory.js` 那条判断：**小额额度 + 开着思考 = content 恒为空**
        //    （这 80 个 token 会被 reasoning 吃满）。这里要的只是一句随口抛的开场白，
        //    用不着思维链，所以显式关掉。
        { temperature: 1, maxTokens: 80, thinking: { mode: 'off' } }
      );
      // ⚠️ D8：这一笔**故意不带会话键** —— 一次生成的文案要发给 plan 里的
      //    多个群，把它记到其中任意一个群的账上都是错的（那个群的 perChat
      //    额度会被凭空吃掉）。它仍计入**当日总量**，那才是它的真实归属。
      recordUsage({ ...usage, source: USAGE_SOURCES.proactiveTopic });
      return text;
    });
    return String(out || '').trim();
  }

  // ── D17 · 提醒的运行时状态（**不进 config.json**，落 `panel/reminder-state.json`）──
  //
  // 形状：`{ "<id>@<dueMs>": { status: 'sent'|'missed'|'skipped', at, reason? } }`。
  // 键里带**到期时刻**而不是"今天的日期串"，于是跨天天然不同、"某年某月某日那一次"
  // 天然唯一 —— 去重不需要第二份"今天几号"的口径。
  let reminderState = {};
  /** 亲眼看着它到过点的那些（`missed` 只给它们记 —— 见 reminder.js 文件头 ⑤）。 */
  const seenDue = new Set();
  /** 这一条最近一次**没能发出**的原因，供超窗时写进 `missed` 的留痕（Q16 要的"留痕"）。 */
  const lastBlock = new Map();

  function loadReminderState() {
    try {
      const raw = fs.readFileSync(REMINDER_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      reminderState = pruneReminderState(parsed, { now: Date.now() });
    } catch {
      // 读不到 / 坏了 → 从空开始。提醒状态是**可重建的**：最坏情况只是今天到点的
      // 那几条再试一次，绝不该因为一个附属文件起不来（与 bridge-lock 的 degraded 同向）。
      reminderState = {};
    }
  }

  function saveReminderState() {
    try {
      writeJsonAtomic(REMINDER_FILE, pruneReminderState(reminderState, { now: Date.now() }), { mode: 0o600 });
    } catch (e) {
      log.warn(`提醒状态写入失败（不影响发送）：${e.message}`);
    }
  }

  let lastProactiveAt = Date.now(); // 启动时不该立刻主动说一句

  /**
   * 主动出站这一步要发给哪些群（B8 · S-PROACTIVE）。
   *
   * 交给 `src/proactive.js` 算，判据用**主链路同一个** `brain.throttleReason()` ——
   * 主动消息以前完全绕过限流：定时到点就发，跟"群里刚回过话"毫无关系，
   * 用户视角就是"它突然自己冒出三条"。
   *
   * D8：再把**花费档位**传进去 —— 触顶（`degrade`）时主动路径整体停工，
   * 但**被 @ / 私聊的回复照旧**（用户裁决：「只降档不哑掉」）。
   * 档位判据在 `src/usage.js`，这里只取一次值、传一次参。
   */
  const sessionOfGroup = (g) => store.get('group', String(g));
  const planFor = (groups) =>
    planProactiveSend({
      groups,
      sessionOf: sessionOfGroup,
      throttle: (session) => brain.throttleReason(session),
      budgetLevel: usageGateOf().level,
    });

  async function tickProactive() {
    const c = cfg.custom;
    if (!c) return;
    // 总闸。关掉之后定时消息也不发 —— 用户在界面上看到的就是"关掉它就是彻底闭嘴"
    if (c.allowProactive === false) return;

    // ── D31-1 · 睡眠：睡着时**整条主动链停工**（含定时消息）─────────────────
    // 为什么不只挡"主动话题"：定时消息虽不花 token，但"睡着期间不开口"是作息语义的一部分
    // （一条 03:00 的定时问候会把"睡着了"这件事当场演砸）。
    // ⚠️ 这里**不推进** `lastProactiveAt`（与"被限流不推进"同一取舍）：醒来立刻就能开口，
    //    而不是"再等一个间隔"。
    // ⚠️ 记忆判官不需要单独挡 —— 它只在主链路尾部被调，而主链路已被门禁挡住。
    // ⚠️ 收藏表情刷新**照跑**（它是协议端只读拉取、不是模型调用）：停掉会变成
    //    "睡觉期间收藏不同步"的静默退化，而那是另一件事。
    if (sleepSnap?.asleep) return;

    const groups = (cfg.allow.groups || []).filter(Boolean);
    if (!groups.length) return;

    const now = new Date();
    const hour = now.getHours();
    if (inQuietHours(hour)) return;

    // ── D17 · 定时消息（提醒）：日期维度 + 到点后的 30 分钟重试窗 + missed 收尾 ──
    //
    // ⚠️ **不新开第二条调度**（唯一入口表纪律）：就挂在这个既有的 30 秒 tick 上，
    //    判据与状态形状全在两个零依赖叶子里（`reminder.js` / `holidays.js`）。
    // ⚠️ 与旧写法最大的差别：以前是 `s.at !== hhmm` 的**精确分钟匹配**，到点那一分钟
    //    没发出去就永久没了；现在是"到期时刻 + 30 分钟窗口"，被限流挡一下会**自己重试**，
    //    超窗才收尾成 `missed`。窗口起点是到期时刻（用户 Q24 裁决：静默期计入窗口）——
    //    于是 07:50 到期、免打扰到 08:00 的那条，08:00 出静默后仍在窗口内，正常补发。
    const holidays = normalizeHolidays(c.holidays);
    let reminderDirty = false;
    for (const s of c.trigger?.scheduled || []) {
      if (!s.enabled) continue;
      const dueMs = dueMsOf(s, now.getTime());
      if (dueMs == null) continue; // at / date 认不出 → 整条不触发（见 reminder.js ①②）
      const rkey = keyOf(s.id, dueMs);
      const phase = phaseOf({ now: now.getTime(), dueMs, status: reminderState[rkey]?.status });
      if (phase === 'pending' || phase === 'sent' || phase === 'skipped') continue;
      if (phase === 'missed') {
        // 只有**亲眼看着它到点**却没发出去的才算"错过" —— 进程启动时就已经过窗的那些
        // 不该记成 missed（那时它根本没在跑，记了就是一条假的事故）。
        if (!seenDue.has(rkey)) continue;
        reminderState[rkey] = {
          status: 'missed',
          at: Date.now(),
          reason: lastBlock.get(rkey)
            || `到点后 ${Math.round(REMINDER_WINDOW_MS / 60000)} 分钟内始终没能发出`,
        };
        reminderDirty = true;
        log.info(`提醒错过（${s.at}${s.date ? ` ${s.date}` : ''}）：${reminderState[rkey].reason}`);
        continue;
      }

      // ── phase === 'due' ──
      seenDue.add(rkey);
      const kind = dayKindAt(dueMs, holidays);
      if (!matchesOn(s.on, kind)) {
        // 「这天不排」≠「这天错过」：标 skipped 之后当天不再考虑，也**不会在次日补发**
        // （周一早上补一条周六的工作日提醒，比不发更讨厌）。
        reminderState[rkey] = {
          status: 'skipped',
          at: Date.now(),
          reason: `当天是 ${kind}，与 on=${s.on || 'any'} 不符`,
        };
        reminderDirty = true;
        log.info(`提醒当天不排（${s.at}${s.date ? ` ${s.date}` : ''}）：${reminderState[rkey].reason}`);
        continue;
      }

      let sent = false;
      for (const item of planFor(groups)) {
        // 被配额拦下时**必须记日志说明原因**。不记的话用户看到的是
        // "我设的定时消息有时候不发" —— 那比"发多了"更难查。
        if (!item.send) {
          lastBlock.set(rkey, `限流：${item.reason}`);
          log.info(`定时消息被限流跳过（${s.at} → 群 ${item.group}）：${item.reason}`);
          continue;
        }
        try {
          await sayToGroup(item.group, s.text);
          // 主动出站也要**计入配额**：不记账的话它根本不算"发过话"，
          // 这道闸门就只是装饰品。
          brain.markReplied(sessionOfGroup(item.group));
          sent = true;
          log.info(`定时消息已发出（${s.at} → 群 ${item.group}）`);
        } catch (e) {
          lastBlock.set(rkey, `发送失败：${e.message}`);
          log.error(`定时消息发送失败（群 ${item.group}）: ${e.message}`);
        }
      }
      // 只要**有一个群**发出去了就收工：再试一次会让已经收到过的那个群再收一遍，
      // 重复一遍的代价比漏一个群大（见 reminder.js 文件头 ④）。
      if (sent) {
        reminderState[rkey] = { status: 'sent', at: Date.now() };
        reminderDirty = true;
      }
    }
    if (reminderDirty) saveReminderState();

    const p = c.trigger?.proactive;
    if (!p?.enabled) return;
    if (now.getTime() - lastProactiveAt < p.intervalMin * 60000) return;

    // 先算配额再生成话题：全群都在配额内的话，先生成就是白烧一次模型调用。
    const plan = planFor(groups);
    const targets = plan.filter((x) => x.send);
    if (!targets.length) {
      log.info(`主动开口被限流跳过：${plan.map((x) => `群 ${x.group} ${x.reason}`).join('；')}`);
      // 刻意**不推进** lastProactiveAt：被限流不是"已经开过口了"，
      // 下个 tick 配额一松就该说话。推进的话等于这一轮主动发言被永久吃掉。
      return;
    }

    lastProactiveAt = now.getTime();
    let text = '';
    try {
      text = await composeTopic(p);
    } catch (e) {
      log.error(`生成主动话题失败: ${e.message}`);
      return;
    }
    if (!text) return;
    for (const item of targets) {
      try {
        await sayToGroup(item.group, text);
        brain.markReplied(sessionOfGroup(item.group));
        log.info(`主动开口（群 ${item.group}）：${truncate(text)}`);
      } catch (e) {
        log.error(`主动开口发送失败（群 ${item.group}）: ${e.message}`);
      }
    }
  }

  // 30 秒扫一次。定时消息的精度是"分钟"，30 秒足够，
  // 而且这个频率对 CPU 完全无感（不涉及任何网络请求，只在到点时才动）
  //
  // D17：提醒状态在**启动时要读回来** —— 不读的话，机器人重启一次，今天已经发过的那几条
  // 就会再发一遍（旧实现的去重表在内存里，重启即失忆）。读了才有"提醒不重复"这件事。
  loadReminderState();
  // D31-1 · 睡眠：读一次状态 + **立刻算一次**（面板第一眼就要能看到它睡没睡，
  // 而不是等第一次 30 秒 tick）。
  loadSleepState();
  refreshSleep();

  /**
   * 主人列表（叫醒路的**唯一身份判据**）。
   *
   * ⚠️ 这里只是把配置取出来，**不做任何判优** —— 判据是叶子里的 `isOwner`（逐字比较）。
   */
  function ownerIds() {
    return Array.isArray(cfg?.owner?.qq) ? cfg.owner.qq : [];
  }

  /**
   * 主人的**私聊**叫醒此刻通不通。
   *
   * 这不是冗余检查，而是把一条真实的前置条件说出来（第 24 次量数的发现）：
   * 私聊消息要先过 `brain.#gateReason` 的 `allow.private`，配了主人却没进白名单的话，
   * 叫得醒、回不出来 —— 用户看到的表现与"它聋了"一模一样。
   */
  function privateWakeReachable() {
    const owners = ownerIds();
    if (!owners.length) return false;
    const priv = Array.isArray(cfg?.allow?.private) ? cfg.allow.private : [];
    return owners.some((q) => priv.includes(String(q)));
  }

  /**
   * 把一次叫醒落到状态上（**唯一写入点**），然后让那个唯一判定点**立刻重算**。
   *
   * 顺序就是语义：不立刻重算的话，下面那道门禁读到的还是"睡着"，
   * 于是叫醒了、但叫醒的那一条消息又被自己挡下去 —— 用户看到的是"我喊了，它没应，
   * 再喊一句它才活"。这种"差一步"的失败最难查，因为它看起来像网络抖动。
   */
  function applyWake(override, reason, { skipKey = '' } = {}) {
    sleepState = { ...sleepState, override };
    const wasAsleep = !!sleepSnap?.asleep;
    refreshSleep(); // ← 同一个判定点，不是第二个
    journal('wake', `${override.kind === 'emergency' ? '紧急唤醒' : '叫醒'}：${reason}`
      + ` · 主人 ${override.byUserId}${wasAsleep ? '' : '（它本来就没睡着）'}`);
    // D31-3：只有**正式起床**才补看（紧急唤醒是"临时醒"，人在等回话，
    //        不适合同时去翻一夜的积压 —— 那时它该先应付眼前这个人）。
    if (override.kind === 'owner') runCatchUp({ owners: ownerIds(), skipKey });
    return true;
  }

  /**
   * 起床补看（D31-3 · 批 D）：翻一遍睡着期间积压的未读，挑一两条回。
   *
   * 三条顺序，反了就会出事：
   *   ① **先消费、后补看** —— 反过来的话，补看轮新到的那条会被当成"睡着时的积压"
   *      再消费一次（而它本来就在未读里该留着）；
   *   ② **按**快照 id **消费**（挑中与没挑中的都消费）—— 补看期间新到的**必然还在**；
   *   ③ **合成事件走既有 `enqueueFor`** —— 于是串行队列 / 判定 / 限流 / 花费闸 /
   *      出口闸门 / 发送节奏 / 会话存档一个都不少。另开一条发送路径等于把这六道抄一遍。
   *
   * ⚠️ **当前会话不进补看**：叫醒的那一条正被处理，它本来就会被回 ——
   *    再合成一条等于同一个会话连着回两遍。
   * ⚠️ 零模型调用（挑选是纯函数排序），所以"睡着期间零 token"这条**仍然绝对成立**。
   */
  function runCatchUp({ owners, skipKey = '' } = {}) {
    try {
      const list = [];
      for (const s of store.sessions.values()) {
        if (!s?.unread?.length) continue;
        const key = String(s.key || '');
        const i = key.indexOf(':');
        list.push({
          key,
          scene: key.slice(0, Math.max(0, i)),
          id: key.slice(i + 1),
          unread: s.unread,
        });
      }
      if (!list.length) return 0;
      const plan = catchUpPlanOf({ sessions: list, owners, skipKey });
      for (const item of plan.consumeByKey) {
        const s = store.sessions.get(item.key);
        if (s) consumeUnread(s, item.ids);
      }
      let n = 0;
      for (const p of plan.picked) {
        const s = store.sessions.get(p.key);
        if (!s) continue;
        enqueueFor(catchUpEventOf(p, bot.selfId ?? ''), '起床补看处理异常');
        n += 1;
      }
      if (plan.considered) {
        journal('wake', `起床补看：翻了 ${plan.considered} 个会话的积压（跳过 ${plan.skipped} 个没 @ 它的）`
          + ` → 回 ${n} 个（上限 ${CATCHUP_MAX}，经验值）`);
      }
      return n;
    } catch (e) {
      // 补看失败绝不能影响"它已经醒了"这件事 —— 最坏只是这一次没翻积压。
      log.warn(`起床补看失败（不影响运行）: ${e.message}`);
      return 0;
    }
  }

  /**
   * 到点的收尾：叫醒到期 / 紧急态转正式起床 / 过窗的正式叫醒兑现。
   *
   * ⚠️ 复评点只有**既有的 30 秒 tick**（经 `refreshSleep`）与"下一条消息到达"，
   *    **没有新定时器** —— 见 `sleep.js` 里那段「复评点零定时器」。
   *
   * @returns {boolean} 叫醒态在这轮里有没有变（变了要留痕）
   */
  function settleWake(now, plan) {
    const wakeAt = Number(plan?.wakeAt) || 0;
    try {
      // ① 挂着的正式叫醒：窗口过了、又没连发满 → 兑现（私聊延迟判定的下半段）。
      //    ⚠️ 这里**不调 `applyWake`**（它会再调一次 `refreshSleep` → 递归）；
      //    因为本函数就跑在 `refreshSleep` 里，状态紧接着就会被同一个 `statusOf` 重算。
      const p = wakePromotionOf({ pending: wakePending, now, wakeAt });
      if (p.promote && p.override) {
        wakePending = null;
        sleepState = { ...sleepState, override: p.override };
        journal('wake', `叫醒：${p.reason} · 主人 ${p.override.byUserId}`);
        // Q33：兑现出来的同样是**正式起床**（`kind === 'owner'`），所以它也要补看 ——
        //    与 `applyWake` 那条同一条语义。⚠️ 这里只**置位**，真跑在 tick 尾部
        //    （见 `catchUpRequested` 的说明）：本函数跑在 `refreshSleep` 里，不该带副作用。
        if (p.override.kind === 'owner') catchUpRequested = true;
        return true;
      }
      // ② 紧急态的收尾 / 叫醒到期
      const s = settleOverrideOf({ override: sleepState.override, wakeAt, now });
      if (s.changed) {
        sleepState = { ...sleepState, override: s.override };
        if (s.reason) journal('wake', `收尾：${s.reason} · 主人 ${sleepState.override?.byUserId || '—'}`);
        return true;
      }
    } catch (e) {
      log.warn(`叫醒收尾失败（不影响运行）: ${e.message}`);
    }
    return false;
  }

  /**
   * 一条刚到达的消息让不让它醒（**叫醒路的唯一接线点**）。
   *
   * ⚠️ 位置：必须**排在睡眠门禁之前**。门禁读的是同一份 `sleepSnap`，所以这里只需要
   *    把状态改对 —— 门禁自己会放行。放在门禁之后就永远轮不到它（睡着了先 return 了）。
   * ⚠️ 它**不产生任何模型调用**（纯 QQ 号比较 + 词表 `includes`）：叫醒这条路本身
   *    必须是零 token 的，否则"睡着期间不花 token"这条前提就被自己破坏掉了。
   *
   * @returns {boolean} 是不是因为它这一条而醒过来（只用于日志措辞；状态已经写好了）
   */
  function evaluateWake({ scene, userId, mentionedSelf, text, now, sessionKey = '' }) {
    if (!sleepSnap) return false;
    try {
      const owners = ownerIds();
      const words = cfg?.custom?.sleep?.wakeWords || [];

      // ① 已经在紧急态：**主人的私聊让"安静 10 分钟"重新计时**。
      //    这一支和"睡着"无关（它现在是醒的），所以必须在"睡着了才判"之前处理。
      if (sleepState.override?.kind === 'emergency'
        && scene === 'private' && isOwner(userId, owners)) {
        sleepState = {
          ...sleepState,
          override: { ...sleepState.override, until: now + EMERGENCY_QUIET_MS },
        };
        // Q34：**刷新完必须落盘**。唯一的落盘点（`refreshSleep` 里）挂在"状态**迁移**"上，
        //    而紧急态恒 awake → 永远不迁移 → 主人每说一句刷新出来的 `until` 只活在内存里。
        //    重启一次就打回上一个 `until`，那个值多半已经过期 → 场景收尾 → 主人还在说话
        //    它却回去睡了（低概率，但表现为"我叫了它，它答应了一句就又不理我了"）。
        //    频率被"紧急态 + 主人私聊"限定，一天也写不了几次。
        saveSleepState();
        return false;
      }

      if (!sleepSnap.asleep) return false;

      // ② 这一条要不要叫醒（临时醒 / 正式 / 先记账等窗口）
      const r = wakeTriggerOf({
        scene, userId, mentionedSelf, text,
        owners, words, burst: wakeBurst,
        wakeAt: Number(sleepSnap.wakeAt) || 0, now,
      });
      wakeBurst = r.burst;
      if ((r.action === 'owner' || r.action === 'emergency') && r.override) {
        wakePending = null;
        return applyWake(r.override, r.reason, { skipKey: sessionKey });
      }
      if (r.action === 'hold') wakePending = r.pending;

      // ③ 复评：主人后来的这条消息刚好过了窗口 → 立刻兑现正式叫醒（不等下一个 tick）
      const p = wakePromotionOf({ pending: wakePending, now, wakeAt: Number(sleepSnap.wakeAt) || 0 });
      if (p.promote && p.override) {
        wakePending = null;
        return applyWake(p.override, p.reason, { skipKey: sessionKey });
      }
    } catch (e) {
      // 判据坏了 → **继续睡**（fail-safe 方向与 plan 一致：宁可不醒也不要乱醒）。
      log.warn(`叫醒判定失败（按继续睡处理）: ${e.message}`);
    }
    return false;
  }

  /**
   * 算一次睡眠状态（**唯一判定点**：计划 → 叫醒收尾 → 状态 → 迁移留痕 → 快照）。
   *
   * 为什么"状态由计划重算"是本步的硬约束：文件里只留"上一次迁移发生过什么"这件事，
   * 此刻睡没睡**每次都重算**。存一个 `status` 进文件，就等于让上一次写入时它以为的状态
   * 决定今天 —— 重启、手工改文件、时钟跳变都会让那份缓存变成谎话。
   *
   * ⚠️ `settleWake` 排在 `statusOf` **之前**：顺序也是判据 —— 反过来排的话，
   *    到期那一刻算出来的状态比新的状态晚一轮（表现是"叫醒晚了 30 秒 / 收尾晚了 30 秒"）。
   */
  function refreshSleep() {
    try {
      const sc = cfg?.custom?.sleep || {};
      const now = Date.now();
      const plan = planOf({ now, bed: sc.bed, wake: sc.wake });
      // D31-2：先把到期的收尾结算掉（`sleepState` 可能被改写），再算状态。
      settleWake(now, plan);
      // 作息总闸**关掉时清掉叫醒态**：叫醒只对"睡着"有意义，总闸关了它就成了
      // 一个没人解释得清的残留 —— 留着它，等于让"上一次有人把它叫醒过"决定今天的作息。
      // （这也是本步唯一的重置路径：关掉再打开，就是一个干净的新的一夜。）
      if (sc.enabled !== true && sleepState.override) {
        sleepState = { ...sleepState, override: null };
        journal('wake', '作息总闸已关 → 清掉叫醒态（叫醒只对睡着有意义）');
      }
      // ── Q12 · 面板「让它睡 / 叫它醒」：手动入睡（内存态，重启即失）────────────
      // 它是**主人当场按的那一下**，所以总闸关着时也生效（否则按钮点了没反应，
      // 而那正是最容易读成"面板坏了"的失败形态）。
      // ⚠️ 起床点一到就自动解除 —— 手动睡不是"睡到天荒地老"，它睡的是**这一夜**。
      //    不解除的表现是：白天你忘了按"叫它醒"，它就一整天不回话。
      // ⚠️ 计划**不可读**时不自动解除（那时根本没有起床点可谈）：那种情况下
      //    手动睡会一直有效到你按「叫它醒」—— 与其猜一个起床点把它放出来，
      //    不如把解除权留在按按钮的那个人手里（这也在留档里写清楚）。
      if (manualAsleep && !plan.disabled && !plan.inWindow) {
        manualAsleep = false;
        journal('sleep', '手动入睡已到期（计划起床点到了）→ 自动解除');
      }
      // 总闸默认关（`SLEEP_DEFAULTS.enabled = false`）：关着时恒判醒，与计划无关。
      // 叫醒态（`override`）**优先于计划** —— 叫醒的意义就是"计划说该睡，但人把我喊起来了"。
      // ⚠️ `manualAsleep` 又优先于两者：它是人刚刚按下的那一下，
      //    而叫醒态存在的意义正是"别让它睡着" —— 两者冲突时按"人最后说了什么"算。
      const status = manualAsleep
        ? SLEEP_STATUS.asleep
        : (sc.enabled === true
          ? statusOf({ plan, override: sleepState.override, now })
          : SLEEP_STATUS.awake);
      const prevTransition = sleepState.lastTransition;
      const { changed, next } = transitionOf({ state: sleepState, status, plan, now });
      if (changed) {
        sleepState = { ...sleepState, cycleKey: plan.cycleKey, lastTransition: next };
        saveSleepState();
        journal('sleep', status === SLEEP_STATUS.asleep
          ? `入睡了（计划 ${sc.bed}–${sc.wake}）`
          : `醒了（计划 ${sc.bed}–${sc.wake}${plan.disabled ? ` · 计划不生效：${plan.reason}` : ''}）`);
        // Q11：由醒转睡的那一夜，自己去说一句晚安。**只置位**，真说在 tick 尾部。
        const gn = goodnightOf({ prev: prevTransition, status, cycleKey: plan.cycleKey });
        if (gn.say) {
          goodnightRequested = true;
          journal('sleep', `准备说晚安（${gn.reason}）`);
        }
      }
      const ov = sleepState.override;
      sleepSnap = {
        enabled: sc.enabled === true,
        asleep: status === SLEEP_STATUS.asleep,
        bed: String(sc.bed || ''),
        wake: String(sc.wake || ''),
        wakeAt: Number(plan.wakeAt) || 0,
        bedAt: Number(plan.bedAt) || 0,
        reason: plan.disabled ? plan.reason : '',
        // 睡着期间积压了几条未读 —— 它是"它到底看没看见"的正面证据（D30 的 pending 汇总）。
        pending: pendingUnread(),
        // D31-2 · 叫醒态：`emergency` 是临时醒（还会回去睡），`owner` 是本夜正式起床。
        mode: ov?.kind === 'emergency' ? 'emergency' : 'normal',
        wakeKind: String(ov?.kind || ''),
        wakeUntil: Number(ov?.until) || 0,
        // 叫醒路通不通（这两行专为"配了但没生效"这类**看不见的失败**留的）
        owners: ownerIds().length,
        privateWake: privateWakeReachable(),
        updatedAt: now,
      };
    } catch (e) {
      log.warn(`睡眠状态重算失败（不影响运行）: ${e.message}`);
    }
    return sleepSnap;
  }

  /**
   * 入睡前那句晚安（Q11 裁决②：做·她主动道晚安）。
   *
   * 三件事各一次，**顺序就是语义**：
   *   ① 挑目标（纯函数 `goodnightTargetOf`，只认"最近跟它说过话 + 在放行名单里"的群）；
   *   ② 走 `sayToGroup` —— 出口闸门 / 分句 / 发送节奏全在那儿，**不另开第二条发送路径**；
   *   ③ 留痕（说了 / 以及**没说**都要留 —— 后者是最容易变成"它今天没道晚安，为什么"的那种）。
   *
   * ⚠️ 不走配额与免打扰：它一夜只有一句，且是"作息"这件事本身的一部分
   *    （主动发言那条链是"找话说"，这一句是"要睡了"，两回事）。
   */
  async function sayGoodnight() {
    const sc = cfg?.custom?.sleep || {};
    const text = String(sc.goodnight || '').trim() || GOODNIGHT_DEFAULT;
    const list = [];
    for (const s of store.sessions.values()) {
      const key = String(s?.key || '');
      const i = key.indexOf(':');
      if (i < 0) continue;
      list.push({
        key,
        scene: key.slice(0, i),
        id: key.slice(i + 1),
        lastAt: Math.max(Number(s?.lastReplyAt) || 0, Number(s?.lastInterjectAt) || 0),
      });
    }
    const target = goodnightTargetOf({ sessions: list, allow: (cfg?.allow?.groups || []).filter(Boolean) });
    if (!target) {
      // 没得说就**如实留痕**然后静默睡下 —— 绝不挑一个今天没说过话的群去冒一句
      // （那是广播，不是人；而"它今晚没道晚安"这件事必须查得到原因）。
      journal('sleep', '该说晚安了，但没有可说话的群（allow.groups 里没有今天跟它说过话的群）→ 静默入睡');
      return 0;
    }
    try {
      await sayToGroup(target.id, text);
      journal('sleep', `道晚安（群 ${target.id}）：${text}`);
      return 1;
    } catch (e) {
      log.warn(`道晚安发送失败（不影响入睡）: ${e.message}`);
      journal('sleep', `道晚安失败（群 ${target.id}）：${e.message}`);
      return 0;
    }
  }

  /** 全会话未读总数（睡着期间的积压量）。 */
  function pendingUnread() {
    let n = 0;
    try {
      for (const s of store.sessions.values()) n += (s?.unread?.length || 0);
    } catch { /* 读不到就当 0 —— 它只是面板上的一个数字 */ }
    return n;
  }

  setInterval(() => {
    // D31-1：**先**重算睡眠（门禁与快照都读它的结果），再跑收藏刷新与主动链。
    refreshSleep();

    // D31 缺陷 Q33：**兑现**出来的正式叫醒也要补看（tick 路过时把请求位消费掉）。
    // ⚠️ 消费点**只有这一处**（契约数的是这行赋值在全库恰 1）—— 挪进 `refreshSleep`
    //    就等于让"算一次状态"去翻积压并合成事件（它还被启动与 applyWake 调用）。
    if (catchUpRequested) {
      catchUpRequested = false;
      runCatchUp({ owners: ownerIds() });
    }

    // Q11：入睡前那句晚安（消费点**只有这一处**，与补看同款：置位在 refreshSleep 里）。
    if (goodnightRequested) {
      goodnightRequested = false;
      void sayGoodnight();
    }

    // D14：**先**刷新收藏表情（只读），再跑主动链。
    // ⚠️ 顺序不能反 —— `tickProactive()` 内部有好几条提前 return
    //    （主动发言总闸关着 / 免打扰时段 / 没有白名单群…），挂在它后面会被那些分支吃掉，
    //    表现是"白天能用、晚上（免打扰）就不刷新了"。
    // 两者都是 fire-and-forget，各自 catch —— 一个的异常不许影响另一个。
    refreshCustomFaces().catch((e) => log.warn(`收藏表情同步异常: ${e.message}`));
    tickProactive().catch((e) => log.error(`定时任务异常: ${e.message}`));
  }, 30000);

  // ── D6 · 会话级中止与原地重试：两个**具名动作**（唯一实现处）─────────────
  //
  // 为什么抽成函数而不是把逻辑直接写在信号回调里：触发方式现在有**两种**
  // （D6 的 Unix 信号 + D6b 的面板命令文件），而"中止了哪几个会话、重试为什么被拒"
  // 只能有一个答案。写成两份必然漂 —— 表现是"面板点了有效、kill 无效"（或反过来），
  // 而两边各自看起来都对。两个信号回调与 `runControlCommand` 都只调它们。
  //
  // ⚠️ 两者都**不打印任何凭据/正文**，只打会话 key 与原因。
  function abortAllInFlight() {
    const live = sessionCtl.snapshot();
    if (!live.length) return { ok: false, msg: '当前没有在途的生成，无事可做' };
    for (const s of live) sessionCtl.abort(s.key);
    return { ok: true, msg: `已中止 ${live.length} 个在途会话（${live.map((s) => s.key).join('、')}）` };
  }

  /**
   * 重放"最近一次一条未发出的失败"。
   * ⚠️ 判据不在这里（`retryDecision` 在 session-control.js）—— 这里只把它的拒绝理由原样带出去。
   */
  function replayLastFailure() {
    if (!lastStalled) {
      return { ok: false, msg: '没有待重放的会话（只有「中止」或「超时」且一条未发出的失败才可重放）' };
    }
    const key = lastStalled;
    const r = replayStalled(key);
    return { ok: r.ok, msg: r.ok ? `已原地重放 ${key}` : `重试被拒（${key}）：${r.reason}` };
  }

  // 中止能力**不能没有 caller**：本项目把「写了没人读」当独立缺陷。
  // 信号是零新增面的触发方式（不开端口、不落盘）；面板那条通道见下面的 D6b 轮询。
  //
  //   kill -USR2 <pid>  → 中止**所有**在途（面板上"停掉这一轮"的运维等价物）
  //   kill -USR1 <pid>  → 对**最近一次"一条未发出的失败"**原地重放
  process.on('SIGUSR2', () => {
    const r = abortAllInFlight();
    if (r.ok) log.warn(`收到 SIGUSR2：${r.msg}`);
    else log.info(`收到 SIGUSR2：${r.msg}`);
  });
  process.on('SIGUSR1', () => log.info(`收到 SIGUSR1：${replayLastFailure().msg}`));

  // ── D6b · 命令文件轮询（面板 → 机器人的唯一控制通道）──────────────────────
  //
  // 为什么轮询而不是 `fs.watch`：watch 在"读到写了一半的 JSON"与"原子写 rename
  // 换掉 inode 之后监听静默失效"这两件事上都不可靠，而这条链路的失败形态是**静默的**
  // （命令没被执行，用户只看到"点了没反应"）。轮询没有这两种坑：
  // 读到半个 JSON 时判据层判 null → 下一轮再读，自己就好了。
  // 代价是延迟与空转 —— 后者接近 0：没有命令时只做一次 existsSync。
  /** 本进程已处理过的最后一条命令 id（**快**的那个闸；**持久**的那个是文件里的 `done`）。 */
  let lastControlId = '';

  /**
   * Q12 裁决① · 面板「让它睡」。
   *
   * ⚠️ 它是**内存态**（不落盘）：手动睡是"刚刚按了一下"，不是作息本身 ——
   *    落盘的话，一次重启之后"它还在睡"就成了一个没有出处的状态，
   *    而"状态不落盘"是本步最硬的那条纪律（`normalizeSleepState` 里连 `status` 都没有）。
   */
  function manualSleepNow() {
    if (manualAsleep) return { ok: false, msg: '它已经在睡了（手动入睡还挂着）' };
    manualAsleep = true;
    // ⚠️ **不在这里调 `refreshSleep`**：判定点的调用位置是"启动 / tick / 叫醒后 / 热重载"
    //    四处（契约数着它），多一处就多一个"状态在哪儿被算出来"的答案。
    //    代价是"按下去到生效"最多隔一个 30 秒心跳 —— 这与 Q33 的补看是同一个取舍：
    //    宁可慢半拍，也不给"算一次状态"这个函数再开一个入口。
    journal('sleep', '面板手动：让它睡（内存态，重启即失；计划起床点到了会自动解除）');
    return { ok: true, msg: '已让它睡（下一个心跳生效，最多 30 秒）—— 到计划起床点会自动醒，也可以再按「叫它醒」' };
  }

  /**
   * Q12 裁决① · 面板「叫它醒」。
   *
   * ⚠️ 只清手动标记**不够**：如果此刻计划本身就判"睡"，下一轮它又被判回睡着 ——
   *    表现是"按了叫醒，它醒了一下又睡了"。那种情况走**既有的正式叫醒**
   *    （`owner` override 到本夜起床点），不新造第二种"醒着"的状态。
   *    代价是它会顺带做一次起床补看 —— 那是"正式起床"本来就带的语义（D31-3）。
   */
  function manualWakeNow() {
    const wasManual = manualAsleep;
    manualAsleep = false;
    const sc = cfg?.custom?.sleep || {};
    const now = Date.now();
    const plan = planOf({ now, bed: sc.bed, wake: sc.wake });
    if (!plan.disabled && plan.inWindow) {
      const o = overrideOf({ kind: 'owner', until: plan.wakeAt, byUserId: ownerIds()[0] || 'panel', now });
      // `applyWake` 内部就走那个"叫醒后"的判定点（不新增调用位置）。
      if (o) applyWake(o, '面板手动叫醒（按了「叫它醒」）');
      return { ok: true, msg: `已叫它醒（${wasManual ? '解除手动入睡 + ' : ''}本夜不再回睡）` };
    }
    journal('wake', '面板手动：叫它醒（此刻计划本来就没判睡）');
    return { ok: true, msg: wasManual ? '已叫它醒（解除了手动入睡）' : '已叫它醒（它本来就没在睡）' };
  }

  /**
   * 命令 → 动作。闭集合的**唯一接线点**（`CONTROL_KINDS` 住在 control-channel.js）。
   * 走到兜底那句说明判据层放行了集合外的命令 —— 那是判据坏了，不是命令合法，所以如实说。
   */
  function runControlCommand(cmd) {
    if (cmd === 'abort') return abortAllInFlight();
    if (cmd === 'retry') return replayLastFailure();
    if (cmd === 'sleep') return manualSleepNow();
    if (cmd === 'wake') return manualWakeNow();
    return { ok: false, msg: `不认识的命令「${cmd}」（判据层没拦住，请检查 control-channel.js）` };
  }

  async function pollControl() {
    try {
      const out = await runControlStep({
        readRaw: () => (fs.existsSync(CONTROL_FILE) ? fs.readFileSync(CONTROL_FILE, 'utf8') : null),
        writeRec: (rec) => writeJsonAtomic(CONTROL_FILE, rec),
        exec: runControlCommand,
        lastId: lastControlId,
        pid: process.pid,
      });
      if (out.id) lastControlId = out.id;
      if (out.action === 'run') log.info(`面板命令 ${out.cmd}（${out.id}）：${out.reason}`);
      else if (out.action === 'expired') log.warn(`面板命令 ${out.cmd}（${out.id}）未执行：${out.reason}`);
    } catch (e) {
      // 这一层只兜"判据层自己炸了"（IO 失败在 runControlStep 内部已各自 catch）。
      // 单次失败不当成致命：下一轮还会再来，而机器人说话不受影响。
      log.warn(`控制通道轮询异常: ${e.message}`);
    }
  }
  setInterval(() => { void pollControl(); }, CONTROL_POLL_MS);

  // 先把上一次运行可能留下的"正在生成"标记清掉（B10c · O-EPHEMERAL）。
  // 放在 bot.start() **之前**：接上真实 QQ 之后才清理的话，
  // 这一瞬间面板上的状态会跟真实情况对不上。
  clearStaleThinking();
  bot.start();

  // 定期重刷「机器人此刻在用什么」的快照。
  //
  // 为什么不能只在配置变化时写一次：如果有孤儿实例退出（比如控制台误起了两个，
  // 清理掉其中一个），那个进程的退出钩子会把这个文件删掉，
  // 而还活着的这一个不会主动重写 → 面板就读不到"当前生效"，显示成空白。
  setInterval(() => writeEffective(cfg), 20000);

  // ── D19 · 心跳与释放（锁的另外两处接线）──────────────────────────────────
  //
  // 心跳让"另一个实例"能区分**活着的我**与**残留的我**：没有心跳，任何一次
  // SIGKILL 留下的锁都得靠"pid 还在不在"来判断，而 pid 会回绕、也会被复用。
  // 45s 一次、**unref** —— 一个心跳绝不该成为"这个进程还不能退出"的理由。
  // [W2] 丢锁要"**两拍确认**"后自逐：
  //   · 不是瞬时自逐 —— 单拍可能是换 inode 那一瞬的误读，会把好实例打掉；
  //   · 也不是维持现状 —— 输掉竞争还继续说话，正是本步要消灭的形态
  //     （外包实测：`heartbeatLock` 返回 false 后旧实例既不写、也不报错、也不退出）。
  //   退出走既有 `shutdown()`（flush 存档、bot.stop、留档可见），比裸 `process.exit` 好：
  //   防抖窗口里的对话不会丢；释放锁那条守卫保证不误删**当前持有者**的锁。
  let lostBeatOnce = false;
  function heartbeatStep() {
    const hb = heartbeatLock({
      readRaw: () => (fs.existsSync(LOCK_FILE) ? fs.readFileSync(LOCK_FILE, 'utf8') : null),
      writeRec: (body) => writeTextAtomic(LOCK_FILE, `${JSON.stringify(body)}\n`, { mode: 0o600 }),
      ownPid: process.pid,
    });
    if (hb.wrote) { lostBeatOnce = false; return; }
    // ⚠️ 按 `kind` 分支，**不比中文文案**（"调用方不拿文案当枚举"，D9 就踩过）：
    //    read-fail / write-fail 是"我暂时写不动"的 degraded 家族 —— 不是易主，不打扰。
    if (hb.kind !== 'not-owner') return;
    if (!lostBeatOnce) {
      lostBeatOnce = true;
      log.warn(`启动锁疑似易主（${hb.reason}）—— 下一拍再确认一次`);
      return;
    }
    log.warn(`启动锁已不属于本实例（${hb.reason}）—— 自逐：输掉竞争的实例不该继续说话`);
    journal('exit', `锁易主自逐：${hb.reason}`);
    shutdown('锁易主');
  }
  // ⚠️ 回调保持"短形状"：check-wb §43⑤ 的窗口契约（`setInterval(…{0,400}…}, LOCK_HEARTBEAT_MS)`）
  //    在盯着它 —— 逻辑搬进具名函数，窗口才不会被撑爆。
  const heartbeat = setInterval(() => { heartbeatStep(); }, LOCK_HEARTBEAT_MS);
  heartbeat.unref();

  /**
   * 释放锁（**两处调用：shutdown 与 `process.on('exit')`**）。
   * `releaseLock` 自带"不是我的锁就不删"的判断，所以重复调用是安全的。
   */
  function releaseOwnLock(why) {
    const r = releaseLock({
      readRaw: () => (fs.existsSync(LOCK_FILE) ? fs.readFileSync(LOCK_FILE, 'utf8') : null),
      unlink: () => fs.unlinkSync(LOCK_FILE),
      ownPid: process.pid,
    });
    if (r.released) log.info(`已释放启动锁（${why}）`);
    return r;
  }

  const shutdown = (sig) => {
    log.info(`收到 ${sig}，正在退出`);
    // 故意**不删** effective.json。
    // 面板是靠文件里的 pid 还活着没有来判断的（pidAlive），进程一退它就自动"失效"。
    // 删文件反而有害：万一系统里还有别的实例在跑（孤儿进程），
    // 先退出的那个会把活着的实例写的快照一起删掉，面板就什么都读不到了。
    markThinking(false);
    // 退出前补一次落盘：防抖窗口内的改动还没写出去，不补就等于"最后几句白聊了"
    flushArchive();
    // 同一条纪律的第二处（2026-10-01 清理轮补上）：说话风格画像**同样是 30 秒防抖**
    // （`style-profile.js` 的 `FLUSH_MS`），只补存档不补画像 = 最后 30 秒的统计永久丢。
    // ⚠️ 两处必须**并排出现**在退出路径上 —— 契约 §55 判的就是这个对称性，
    //    而不是"某个标识符存在"（那样删掉 `flushProfiles` 的调用点也照样绿）。
    flushProfiles();
    bot.stop();
    // 锁要在**正常退出**这条路上主动释放：不释放的话，下一次启动会走"接管残留锁"
    // 那一条（虽然也能起来），但留档里就多了一条误导性的 takeover。
    releaseOwnLock(sig);
    journal('exit', `收到 ${sig}，正常退出`);
    // 扩展包的生命周期收尾（B12e-2 · EX-LIFECYCLE 的后两态）。
    // **先 deactivate 再 dispose**，顺序不能反：前者是"停副作用"，后者是"释放资源"。
    // ⚠️ 不 await：退出路径上不能让一个写坏的扩展包把进程卡住；
    //    给它的窗口就是下面那 300ms，跑不完也只是它自己的收尾没做完。
    void (async () => {
      try {
        await extHost.deactivateAll();
        await extHost.disposeAll();
      } catch (e) {
        log.warn(`扩展包退出收尾失败（不影响退出）: ${e.message}`);
      }
    })();
    setTimeout(() => process.exit(0), 300);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // ── D19 · 崩溃留档（**不改崩溃语义**）────────────────────────────────────
  //
  // ⚠️ 加这两个监听器本身就会**改变 Node 的默认行为**（默认：未捕获异常直接崩溃退出；
  //    未处理的 Promise 拒绝在 Node 15+ 也是崩溃），所以两个都必须**记录完就退出** ——
  //    任何"吞掉异常继续跑"的写法都是行为变更，不在本步里做。
  //    顺序也刻意：先写留档（同步 appendFileSync，崩到一半也能落上），再 log，再 exit。
  const fatal = (kind, e) => {
    const msg = e && (e.stack || e.message) ? String(e.stack || e.message) : String(e);
    journal('fatal', `${kind}：${msg}`);
    log.error(`${kind}: ${msg}`);
    releaseOwnLock(kind);
    process.exit(1);
  };
  process.on('uncaughtException', (e) => fatal('未捕获异常', e));
  process.on('unhandledRejection', (e) => fatal('未处理的 Promise 拒绝', e));

  // 兜底：任何路径的退出（含上面两处 `process.exit`）都会经过它。
  // 不能 await，但 unlink 是同步的 —— 这正是它放这儿能成立的原因。
  process.on('exit', () => { releaseOwnLock('进程退出'); });
}

main().catch((err) => {
  log.error(`启动失败: ${err.message}`);
  process.exit(1);
});
