/**
 * ══════════════════════════════════════════════════════════════════════
 *  桥接运行期的「写盘口」族（H-10 第 22 轮 · 从 `src/index.js` 整块搬出）
 * ══════════════════════════════════════════════════════════════════════
 *  为什么单独立一个模块：`src/index.js` 是最后几个**巨型文件**之一（3172 行），
 *  而这里装的是**与 `main()` 无关**的一族 —— 落盘路径常量、留档、思考标记、
 *  进程探测、trace 追加、判定卡、未读记账。它们原先散在 `main()` 之前的 300 行里，
 *  每次读 `main()` 都要先翻过它们。
 *
 *  ⚠️ **搬家纪律（第 18/19 轮为 `panel/server.js` 立的那套，这里照做）**：
 *    ① **判据一律注入 / 移交，不复制** —— `check-wb` 的取源改指这里；
 *    ② **搬完必须回头查旧变异锚点**（`test/mutations/*.mjs` 的 `file:`）；
 *    ③ 模块级 `let` / `Map` 缓存**随实现一起走**（`journalLines` / `LAST_PROMPT`）——
 *       它们的唯一访问者就是这里的函数，留在主文件反而变成"两个地方能看到它"。
 *
 *  ⚠️ 三个 `QQBOT_*` 覆盖（THINKING / TRACE / BRIDGE_JOURNAL）随常量搬到这里 ——
 *     三件套（`.gitignore` / `test/sandbox.sh` / env 覆盖）的第三件不依赖它在哪个文件。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { writeJsonAtomic, truncateLinesAtomic } from './atomic-write.js';
import { shouldClearStale } from './ephemeral.js';
import { maskSecrets } from './egress.js';
import { journalLineOf, JOURNAL_MAX_LINES } from './bridge-lock.js';
import { isOurBridge, parsePgrepLine, firstPathOf, PGREP, LSOF, PGREP_LIST_FLAGS } from './bridge-proc.js';
import { sampleOf, recordSample } from './trace-stats.js';
import { dayKeyOf } from './holidays.js';
import { unreadEntryOf, pushUnread, pendingOf, consume } from './unread.js';
import { USAGE_SOURCES } from './usage.js';

/** 仓库根（本模块在 `src/` 下，与 `index.js` 同层 —— 推导方式与它逐字一致）。 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const THINKING_FILE = process.env.QQBOT_THINKING_FILE
  || path.join(ROOT, 'panel', '.thinking.json');
// 每条回复的完整链路（群消息 → 提示词 → 模型原始输出 → 实际发出的分段）。
// 控制台有一个卡片读它，让「本地模型的输出流转」看得见、可复盘：
// 答得不好时不用猜，直接看它到底收到了什么提示词、有没有被 max_tokens 截断。
// QQBOT_TRACE_FILE 让测试能把它指去临时目录 —— 否则 smoke 跑一遍，
// mock 的假对话（「路人: 在吗」）就会落进用户真实的对话流里，那是一种静默污染。
const TRACE_FILE = process.env.QQBOT_TRACE_FILE
  ? path.resolve(process.env.QQBOT_TRACE_FILE)
  : path.join(ROOT, 'panel', 'local-trace.jsonl');
const TRACE_MAX = 120;
const JOURNAL_FILE = process.env.QQBOT_BRIDGE_JOURNAL_FILE
  ? path.resolve(process.env.QQBOT_BRIDGE_JOURNAL_FILE)
  : path.join(ROOT, 'panel', 'bridge-journal.log');

/**
 * 留档一行。**任何失败都吞掉** —— 它是排障用的附属品，
 * 绝不能因为磁盘满/权限把它自己变成"机器人起不来"或"崩不掉"的原因。
 *
 * 脱敏走 `maskSecrets`（与日志同一个实现）：留档里会出现模型名、白名单串、
 * 错误信息，其中可能夹着凭据 —— 而这份文件是给人看的、可能被贴进报告的。
 */
/** 运行期已追加的留档行数（只用来判断该不该折半，不是任何判据的输入）。 */
let journalLines = 0;

function journal(kind, msg) {
  try {
    const line = journalLineOf({ at: Date.now(), kind, pid: process.pid, msg: maskSecrets(String(msg ?? '')) });
    fs.appendFileSync(JOURNAL_FILE, line + '\n');
    // 运行期也要有界：启动那一次（main 里的 truncateLinesAtomic(JOURNAL_FILE, JOURNAL_MAX_LINES)）
    // 只在进程起来时折半一次 —— 一次长期不重启的运行里留档仍会无限长大。
    // 折半后计数归零重新数，不需要每条都碰磁盘。
    if (++journalLines > JOURNAL_MAX_LINES) {
      journalLines = 0;
      truncateLinesAtomic(JOURNAL_FILE, JOURNAL_MAX_LINES);
    }
  } catch {
    /* 留档失败不影响任何主流程 */
  }
}

/**
 * 这两条命令都用 exit 1 表示"没找到"——那不是工具坏了，是"没有"。
 * ⚠️ 路径来自 `./bridge-proc.js` 的**一份可移植实现**（macOS 的 lsof 在 /usr/sbin、
 *    Linux 的在 /usr/bin —— 写死哪一边都会在另一边静默降级）。别在这里再写死一次。
 */

function runQuiet(cmd, args) {
  try {
    return { ok: true, out: String(execFileSync(cmd, args, { encoding: 'utf8', timeout: 4000 })) };
  } catch (e) {
    if (e && e.status === 1) return { ok: true, out: String(e.stdout || '') };
    return { ok: false, out: '' };
  }
}

/**
 * 探针：锁里的 pid 现在**是不是本项目的机器人**。
 *
 * 只在"pid 活着 + 心跳停滞"那一格才会被调用（起子进程不便宜，不能每次启动都跑）。
 * 判据**一份都不重写** —— 提名用 `pgrep`（宽），核验用 `isOurBridge`（严、fail-closed），
 * 与面板侧 `findBridgeProcesses` 完全同形。判据不写第二份是本项目的硬纪律（R13）。
 *
 * @returns {boolean|null} `null` = 探针不可用（工具缺失/调用失败）—— 判定阶梯里有单独一格
 */
function probeIsOurBridge(pid) {
  const nom = runQuiet(PGREP, [...PGREP_LIST_FLAGS, 'src/index\\.js']);
  if (!nom.ok) return null;
  const hit = nom.out.split('\n').map(parsePgrepLine).find((r) => r && r.pid === pid);
  if (!hit) return false; // 连提名都没有 = 不是我们的
  const txt = runQuiet(LSOF, ['-a', '-p', String(pid), '-d', 'txt', '-Fn']);
  const cwd = runQuiet(LSOF, ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']);
  if (!txt.ok || !cwd.ok) return null;
  return isOurBridge({ cmd: hit.cmd, cwd: firstPathOf(cwd.out), execPath: firstPathOf(txt.out), root: ROOT }).ours;
}

function markThinking(on, info) {
  try {
    // 带上 pid（B10c · O-EPHEMERAL）：判据从"文件写了多久"升级成"写它的进程还在不在"。
    // 之前只有时间兜底，于是 SIGKILL 崩溃（finally 跑不到）留下的孤儿记录，
    // 面板会继续显示"正在生成"最多 3 分钟 —— 而实际上那一刻它已经不说话了。
    if (on) writeJsonAtomic(THINKING_FILE, { t: Date.now(), pid: process.pid, ...info });
    else fs.unlinkSync(THINKING_FILE);
  } catch {
    /* 写不出来也不影响回复 */
  }
}

/**
 * 启动时先清掉上一次运行留下的 thinking 标记（B10c · O-EPHEMERAL）。
 *
 * 为什么需要它：正常退出走 `finally` / 退出钩子会删，但 SIGKILL、断电、崩溃
 * 都跑不到那两处。那份文件会一直躺在磁盘上，直到面板的过期判据把它判掉 ——
 * 期间用户看到的是"它在想"，而它其实已经不在了。
 *
 * 只清**不是自己写的**那份（按 pid 判断）：万一有别个实例正在生成，
 * 这一行不能把人家正在用的标记删掉。
 */
function clearStaleThinking() {
  try {
    const j = JSON.parse(fs.readFileSync(THINKING_FILE, 'utf8'));
    if (shouldClearStale(j, { isAlive: alive })) fs.unlinkSync(THINKING_FILE);
  } catch {
    /* 没有那份文件 = 本来就是干净的 */
  }
}

/** 进程还在不在。pid 复用是理论上的风险，但比起 3 分钟误报要划算得多。 */
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM'; // 存在但没权限，也算活着
  }
}

/** 把 messages 摊成给人看的文本（和 scripts/dryrun.js 的格式保持一致） */
function promptText(messages) {
  return messages
    .map((m) => {
      const body = Array.isArray(m.content)
        ? m.content.map((c) => c.text || '[图片]').join('\n')
        : m.content;
      return `【${m.role}】\n${body}`;
    })
    .join('\n\n');
}

// ── 缓存命中率的长期留档（第 37 轮 · O-CACHESTAT）──────────────────────────
// 为什么需要：`local-trace.jsonl` 被 `TRACE_MAX` 折半截断，它是"给面板看最近几条"的
// 有界窗口 —— 于是「改序后真机中位 95.7%」这个复量基准被自己吃掉了，闸门无样可量。
// 这里把每轮的**公共前缀占比**单独折进 `panel/prompt-stats.json`（只增不减、固定体积）。
//
// 上一轮 prompt 存在内存里就够：它只用于和"这一轮的 prompt"逐字比对。
// ⚠️ 刻意**不挂到 session 上** —— session 会被 `session-archive.js` 整份序列化落盘，
//    一份 prompt 约 3~4 KB，挂上去等于让存档文件白白胖几倍，而且 prompt 属于
//    "瞬时态不落盘"这一类（B10c 的纪律）。所以用模块级 Map，带简单 LRU 上限。
const LAST_PROMPT = new Map();
const LAST_PROMPT_MAX = 64;

/** 把这一轮的 prompt 与同一会话上一轮的做比对，折进留档。任何异常都不许影响回复。 */
function noteCacheSample(rec) {
  try {
    if (typeof rec?.prompt !== 'string' || !rec.prompt) return;
    const key = `${rec.scene}:${rec.id}`;
    const prev = LAST_PROMPT.get(key);
    if (prev) {
      const s = sampleOf(prev, rec.prompt);
      if (s) recordSample({ day: dayKeyOf(new Date(rec.t || Date.now())), ...s });
    }
    // 提到最新；超上限先从最旧的键开始丢（群/私聊数量有限，这只是兜底防涨）
    LAST_PROMPT.delete(key);
    LAST_PROMPT.set(key, rec.prompt);
    while (LAST_PROMPT.size > LAST_PROMPT_MAX) {
      LAST_PROMPT.delete(LAST_PROMPT.keys().next().value);
    }
  } catch {
    /* 统计失败绝不能影响正常回复 */
  }
}

/** 追加一条链路记录。超过上限就折半截断，不让文件无限长（面板只看最近几条） */
function writeTrace(rec) {
  // 留档的**唯一接线点**：所有记录（含 skip）都从这里过，但只有带 prompt 的那些
  // 才产生样本 —— 与 prompt-diff 读 trace 的口径（只取带 prompt 的记录）严格一致，
  // 否则两边算出来的中位数会系统性对不上。
  noteCacheSample(rec);
  try {
    fs.appendFileSync(TRACE_FILE, JSON.stringify(rec) + '\n');
    // 截断也走原子写（B10a · O-ATOMIC）：旧实现是原地 `writeFileSync` 覆盖，
    // 它和同一时刻的 append 撞车时，刚 append 进来的那一行会被整段覆盖掉 ——
    // 表现是"刚刚那条记录不见了"，而且再也查不到。
    truncateLinesAtomic(TRACE_FILE, TRACE_MAX, 0.5);
  } catch {
    /* 记不下来也绝不能影响正常回复 */
  }
}

/**
 * 记一条「**没回**」的记录（B10a · O-SKIP）。
 *
 * 为什么值得单独立一条：项目最常被问的问题就是"它为什么不理我"，
 * 而在本批之前，这条路径**只进 `log.debug`** —— 默认日志级别是 info，
 * 也就是说它**根本不输出**。不落盘、不打日志、界面上什么都没有，
 * 于是"被 @ 了也没反应"和"它真的坏了"完全同形，只能靠猜。
 *
 * 形状刻意与正常记录**保持一致**（同样的字段集），只是 `kind:'skip'`：
 * 面板那套渲染逻辑就不用为它单独开一条分支。
 */
function writeSkip(info) {
  writeTrace({
    t: Date.now(),
    traceId: info.traceId,
    kind: 'skip',
    // stage 区分"压根没答应"和"答应了但被限流" —— 这两种的处置完全不同
    stage: info.stage,
    scene: info.scene,
    id: String(info.id),
    sender: info.sender,
    reason: info.reason,
    text: info.text,
    model: info.model || '',
    baseUrl: info.baseUrl || '',
    used: '',
    downgraded: false,
    thinking: null,
    prompt: '',
    messageCount: 0,
    ms: 0,
    usage: null,
    raw: '',
    silent: true,
    chunks: [],
    error: '',
    // ↓ 与正常记录（rec）保持同一字段集 —— 但**目前没有任何消费方读这六个字段**：
    //   面板对 skip 走专用卡片 skipHtml（只读 stage/reason/text/traceId）；
    //   noteCacheSample 对空 prompt 直接 return；renderTrace 的指纹只读 8 个字段且有兜底。
    //   补上它们是「形状一致」这条自身约定，也是将来统一渲染时不出现字段缺失 ——
    //   不是「修了一个会崩的 bug」。旧注释声称「面板会拿到 undefined」，实测不成立（第 49 轮复审）。
    //   这里给的是中性的空值（没拦截 / 没图 / 没砍段 / 没背景 / 没记忆 / 没技能）。
    blocked: '',
    vision: { supports: false, featureOn: false, imagesCount: 0, images: [] },
    dropped: [],
    ambient: { count: 0, refreshed: false },
    memoryUsed: [],
    skillsUsed: [],
    // D12b：插话因子（活跃期 / 冷场 / 最终概率）—— 只在**走到插话分支**的那轮才有值，
    // 别的 skip 是 null。它回答的是"它这次为什么没来接话"里**最不好猜的那一半**：
    // 「不满足插话条件」这句话本身没说概率被压到了多少、凭什么。
    // ⚠️ 面板的 skipHtml **不读**它（渲染不变），只给排查与真机观察用。
    interject: info.interject || null,
    // D30：这一轮消费掉的未读（消费前 / 本次消费 / 消费后剩余 / 被消费的 id / 丢过几条）。
    // "它不理我"与"它没看见"的分界线就在这里 —— 没过黑白名单的消息没有会话、没有未读，
    // 所以这一格如实是 null，而不是一个看起来"处理了 0 条"的空壳。
    unread: info.unread || null,
    // D23-2：这一条消息里的合并转发**到底展开成什么了**（几条 / 多少字符 / 走了哪条路 /
    // 失败原因）。没有转发段时如实是 null（不是"展开了 0 条"的空壳）。
    // ⚠️ 面板不读它（渲染不变），它回答的是排查口径的问题 ——
    //    "它说看不见转发内容"这句话，从这里能一眼分出是"没展开成功"还是"展开了但没读懂"。
    forward: info.forward || null,
  });
}

/**
 * 记一张「判定卡」—— D29 · 判定可见性。
 *
 * 为什么需要它：本项目里会有**不经过主链路、但同样花 token** 的判断（现在是记忆判官，
 * 将来是 D31 的挑消息）。这些调用原本只留下两样东西 —— 一本账里的一行（看不出是谁花的）
 * 和一行 `log.warn`（失败了才有，而且默认级别下"成功但什么都没记"与"根本没判成"同形）。
 * 于是"它今天为什么一条记忆都没记"永远只能靠猜。判定卡把**过程**变成可查数据：
 * 用了哪个模型 / 多久 / 多少 token / 判成了什么 / 失败原因。
 *
 * ⚠️ **落的是既有 trace 文件**（`panel/local-trace.jsonl`），不新开文件 → 三件套不适用。
 *    它随既有的 `TRACE_MAX` 折半截断 —— 有界是特性（与 skip 记录同一族）。
 * ⚠️ **不进会话存档**：`session-archive.js` 的 `archiveOf` 是白名单，判定卡不在其列。
 * ⚠️ 走 `writeTrace` 这**唯一一处**写入点：新开第二个写 trace 的地方，
 *    两边的截断与缓存采样必然漂移（R5 的教训）。
 * ⚠️ 三个终态与账本口径一致：`recorded`（真的记了一条）/ `nothing`（判了但没记）/
 *    `error`（判定本身失败）。失败**也要留卡** —— "判定失败装死"必须在账面上看得见。
 */
function writeJudgeCard(info) {
  writeTrace({
    t: Date.now(),
    traceId: info.traceId,
    kind: 'judge',
    scene: info.scene,
    id: String(info.id),
    // 来源与账本 `s` 用**同一个枚举**（USAGE_SOURCES）—— 两处各写一份字面量迟早漂移。
    source: USAGE_SOURCES.memoryJudge,
    // 配置里写的模型 / 实际应答的模型（降级可查）—— 与 reply 记录同口径。
    model: info.model || '',
    used: info.used || '',
    ms: Number(info.ms) || 0,
    usage: info.usage || null,
    result: info.result,
    // 判官原始输出（截断）：回答"它凭什么这么判"。截断是因为它是模型原话，长度不可控。
    out: String(info.out ?? '').slice(0, 200),
    error: info.error || '',
  });
}

/**
 * 记一条未读（D30）—— **唯一写入点**，在 `decide()` **之前**调用。
 *
 * 语义边界（写清楚，免得后来人以为它和 `rememberAmbient` 是同一件事）：
 *   · `ambient`  = **背景窗口**（给模型看"刚才群里谁在说什么"，有条数上限、会整批换）；
 *   · `unread`   = **门禁状态**（这一条被处理完了没有，只能按 id 消费）。
 *   两条记录同源同序，但回答的是两个不同的问题。
 *
 * ⚠️ 计数失败绝不影响回复（与 writeTrace / recordUsage 同一条纪律）：
 *    它是记账，不是主链路的一步。
 */
function noteUnread(session, info) {
  try {
    if (!session) return;
    const entry = unreadEntryOf(info);
    if (!entry) return; // 没有 message_id → 不记（不给它编一个 id，否则永远消费不掉）
    const r = pushUnread(session.unread, entry);
    session.unread = r.items;
    // 丢了几条必须可见 —— 只留"最多 200 条"这个数字的话，
    // "它昨晚积压了 800 条"就会静默变成"积压 200 条"，而那两件事的处置完全不同。
    if (r.dropped) session.unreadDropped = (Number(session.unreadDropped) || 0) + r.dropped;
  } catch {
    /* 未读记账失败绝不影响回复 */
  }
}

/**
 * 按 id 消费（D30）—— **唯一消费点**，在 `decide()` **之后**调用。
 *
 * 为什么是"`decide()` 之后"而不是"发出去之后"：消费是**宿主自己的记账**
 * （"这条已经被本会话的门禁处理完了"），不是"由模型输出驱动的全局状态变更"。
 * 若改成发完才消费，run 失败 / 被中止时这条消息会**永远是未读**，
 * 并与 D6 的原地重放纠缠（重放复用同一条触发消息 → 同一条被消费两次）。
 * 提交消费 + 不退还，是唯一自洽的口径。
 *
 * ⚠️ **消费 ≠ 回复**：respond 与 skip **都**算"已被门禁处理"。
 *    这正是本步要治的形态 —— "它不理我"与"它没看见"必须在账面分得开。
 * ⚠️ 只消费**这一条**的 id，绝不整组清空：将来 D31 睡着期间积压的那些
 *    必须原样留在未读（叶子那边连"无参清空"的函数都不存在）。
 *
 * ⚠️ D31-3 起 `ids` 可以是**一个 id 或一组 id**：起床补看要成批消费**一整个会话的快照**，
 *    而"再写一个成批消费函数"就等于给同一个不变量开第二个口子（"会话上的未读由谁改写"
 *    会从一处变两处）。所以入口仍然只有这一个，只是入参更宽 ——
 *    形状上仍旧**必须给 id**（不给就什么都不清，"禁 markAllRead"这条没有被放宽）。
 */
function consumeUnread(session, ids) {
  try {
    if (!session) return { pending: 0, consumed: 0, left: 0, ids: [], dropped: 0 };
    const before = pendingOf(session.unread); // 先取快照（消费前）
    const want = (Array.isArray(ids) ? ids : [ids])
      .map((x) => String(x ?? '')).filter(Boolean);
    const r = consume(session.unread, want);
    session.unread = r.items;
    const dropped = Number(session.unreadDropped) || 0;
    session.unreadDropped = 0;
    return {
      pending: before.length,
      consumed: r.consumed.length,
      left: r.items.length,
      // 只留前 5 个 id（截断到前 5 + 总数由调用方拼），免得 trace 被一串 id 撑爆。
      ids: r.consumed.slice(0, 5),
      dropped,
    };
  } catch {
    return { pending: 0, consumed: 0, left: 0, ids: [], dropped: 0 };
  }
}

function truncate(s, n = 60) {
  const t = String(s ?? '').replace(/\s+/g, ' ');
  return t.length > n ? `${t.slice(0, n)}…` : t;
}


// ── 导出名单（H-10 第 22 轮）────────────────────────────────────────────
// ⚠️ **刻意用文件末尾的导出名单，不用逐个 `export` 前缀**：
//    `check-wb` 的 §37 有一台**行级状态机**（`^\s*const NAME = `）在数
//    "panel/ 落盘常量"；前缀式导出会让它整条看不见（实测：三条常量当场判"找不到"）。
//    导出名单不影响模块边界，但对那台状态机是透明的。
export {
  THINKING_FILE, TRACE_FILE, TRACE_MAX, JOURNAL_FILE,
  journal, promptText, noteCacheSample, writeTrace, writeSkip, writeJudgeCard,
  noteUnread, consumeUnread, runQuiet, probeIsOurBridge, alive, truncate,
  markThinking, clearStaleThinking,
};
