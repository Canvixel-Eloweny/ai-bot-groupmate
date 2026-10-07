/**
 * ══════════════════════════════════════════════════════════════════════
 *  自我记忆 —— 「自动记录」那一半
 * ══════════════════════════════════════════════════════════════════════
 *  手动记忆住在 config.json 里（用户资产，程序不该顺手清）。
 *  自动记录**故意另存一个 append-only 文件**，理由：
 *
 *    机器人是高频追加写的，而控制台保存设置时会整份重写 config.json。
 *    两个进程抢同一个文件 → 迟早出现"刚记下来的一条没了"或者 JSON 被写坏，
 *    而且这类问题不报错、只是偶尔丢数据，最难查。
 *    分开之后职责干净：机器人是这个文件的**唯一写入者**，控制台只读；
 *    控制台点「一键清空」时直接截断，最坏情况只损失那一瞬间新记的一条。
 *
 *  自动判断走的是**当前这套大脑的模型**（不额外配第二个模型）：
 *  反正一次群聊已经调过一次模型了，这里再来一次极短的判断，成本可控。
 *  全程 fire-and-forget：任何失败都只写日志，绝不影响正在进行的回复。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import scoped from './logger.js';
import { SIMILAR_THRESHOLD, similarity } from './custom-config.js';
import { looksInjected } from './injection.js';
import { GATE_ERROR_KIND, isBlocking } from './gate-scan.js';
import { recordUsage, USAGE_SOURCES } from './usage.js';
import { writeJsonAtomic } from './atomic-write.js';
// 结构化记忆（ATI-3）：判据与状态机住在 memory-record（零依赖叶子），这里只做存储与接线。
import {
  normalizeRecord,
  mergeRecord,
  selectForPrompt,
  reviewRecord,
  oppositePolarity,
  trimRecords,
  subjectMatches,
  shortIdOf,
  searchRecords,
  renderRecalled,
  SUBJECT_SELF,
  RECORDS_MAX,
} from './memory-record.js';

// 回忆的**触发判据**与**条数上限**由叶子给，这里只转出去 —— 消费方（brain）
// 只认 `memory.js` 这一个门面，就不会出现"同一件事在两处 import"的分叉。
export { wantsRecall, RECALL_MAX } from './memory-record.js';

const log = scoped('memory');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ── 读盘口与文件路径搬进了 `memory-store.js`（第 19 轮 · H-10 第二半）────────
//
// 为什么搬：那两个路径常量与 `listAutoMemory` / `readRecords` 是**纯读**，
// 而本模块因为 `import scoped from './logger.js'` → `egress.js`（import 期就编译
// 凭据特征表）会把机器人启动链拖进任何 import 它的面板进程 —— §82 白名单因此
// 一直不敢放行`memory.js`，`collectState` / `buildExport` 两块就都搬不动。
//
// **判据只有一份**：这里是 import 后**原样转出**，不是复制。
// 机器人侧现有调用方（`brain.js` / `index.js` / 测试）一个字都不用改。
// **判据只有一份**：路径怎么算住在 `memory-store.js` 的 `resolveMemoryFiles`，
// 这里是**本模块被 import 的那一刻**调它、拿到结果再显式传下去。
//
// ⚠️ **为什么必须由本模块解析、再显式传参**（第 19 轮实测踩到的坑·8 条用例报红）：
//   测试的隔离手法是「设好 `QQBOT_MEMORY_RECORDS` → `import('../src/memory.js?probe=…')`」，
//   靠**缓存穿透**拿到一份按新 env 重算的模块。若路径只在叶子算成常量，
//   穿透 `memory.js` **不会**连带穿透叶子 ⇒ 测试读到的仍是真机那份
//   `panel/memory-records.json`（实测「条数=16」正是真机的条数）。
//   这里在每次 import 时重新解析并传进去，那条既有隔离手法就照样成立。
import {
  resolveMemoryFiles, listAutoMemory as listAutoMemoryAt, readRecords as readRecordsAt,
} from './memory-store.js';

const MEM_FILES = resolveMemoryFiles();

export const AUTO_MEMORY_FILE = MEM_FILES.autoFile;
const RECORDS_FILE = MEM_FILES.recordsFile;

export function listAutoMemory() {
  return listAutoMemoryAt(AUTO_MEMORY_FILE);
}

export function readRecords() {
  return readRecordsAt(RECORDS_FILE);
}

/** 自动记忆最多留多少条。它是"锦上添花"，不该无限膨胀把提示词挤爆 */
const MAX_RECORDS = 200;
/** 提示词里最多放几条。全塞进去的话这一节会比人格本身还长，小模型会被带跑偏 */
const IN_PROMPT = 12;

/** `listAutoMemory` 已搬进 `memory-store.js`（见上方 import 处），这里原样转出。 */

/** 放进提示词的那几条（最近的在前，截断到 IN_PROMPT） */
export function autoMemoryForPrompt() {
  return listAutoMemory().slice(0, IN_PROMPT);
}

/** 控制台「一键清空」用 */
export function clearAutoMemory() {
  try {
    fs.writeFileSync(AUTO_MEMORY_FILE, '');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * 注入闸门的**唯一落点**（自动记忆与结构化记忆共用）。
 *
 * 为什么收成一处：这两条落盘路径此前各写了一份逐字相同的判据，只差日志文案。
 * 判据一改（例如把 fail-open 的落点挪个位置）就必然只改一处 —— 而漏掉的那处
 * 会安静地按旧规则放行，没有任何报错。
 *
 * `label` 只进日志：两个调用点的措辞不同（"自动记忆" / "结构化记忆"），
 *   那是给人看的，不参与判断。`sample` 是日志里截给排查者看的那段文本。
 *
 * 返回 `null` = 放行（可以落盘）；返回对象 = 被拦下，调用方原样return。
 * `kind` 有三种取值：命中名 / null / 哨兵。判"拦不拦"只能用 `isBlocking()`——
 *   写成 `if (kind)` 会把哨兵当命中，等于安静地变成 fail-closed
 *   （那样闸门一坏，记忆就再也不落盘，且没人知道）。
 */
function injectionGate(text, label, sample) {
  const kind = looksInjected(text);
  if (kind === GATE_ERROR_KIND) {
    log.warn(`注入闸门规则自身出错，这条按放行处理（fail-open）: ${sample}`);
    return null;
  }
  if (isBlocking(kind)) {
    log.warn(`${label}被注入闸门拦下（${kind}），未落盘: ${sample}`);
    return { ok: true, skipped: 'injection' };
  }
  return null;
}

/**
 * 追加一条。同一条不再重复记 —— 群友的偏好会被反复提到，
 * 不判重的话同一条事实会记几十遍，把提示词那一节塞满。
 */
export function appendAutoMemory(entry) {
  const text = String(entry?.text || '').trim();
  if (!text) return { ok: false, error: '空内容' };

  // ── 入库闸门（B9 · INJ-GATE）──
  // 闸门放在**唯一的写入函数**里，而不是调用方：这样以后多出别的写入者
  // （面板、脚本、插件）也自动被覆盖。放在调用方的话，下一个写入者必然是漏的。
  //
  // 为什么自动记忆特别需要这道闸：它每轮都会被重新塞进提示词，
  // 一条脏记忆的污染是**持续**的；而它又是**别人说的话**里提取出来的 ——
  // 也就是全项目唯一一条"外部内容直接落盘、之后反复进提示词"的路径。
  //
  // ⚠️ 命中就**丢弃**而不是改写：改写一批自己都不确定语义的文本，
  //    只会把"拦没拦住"变成一件说不清的事。见 src/injection.js 的边界声明。
  const hit = injectionGate(text, '自动记忆', text.slice(0, 40));
  if (hit) return hit;

  const exists = listAutoMemory().some((m) => m.text === text || similarity(m.text, text) >= SIMILAR_THRESHOLD);
  if (exists) return { ok: true, skipped: 'already-known' };
  try {
    fs.mkdirSync(path.dirname(AUTO_MEMORY_FILE), { recursive: true });
    fs.appendFileSync(
      AUTO_MEMORY_FILE,
      JSON.stringify({
        id: `a${Date.now().toString(36)}`,
        text,
        t: Date.now(),
        // `from` 存的是**显示名**（群名片 > 昵称 > 兜底）：会改名、会重名，
        // 它只能用来"展示这是谁"，**不能当"这是谁"的键**。
        // ⚠️ 这里**不改 from 的语义**（旧记录里它已经是昵称；改成 QQ 号会让同一个
        //    字段前后两种含义，正是本项目明令禁止的"一个字段两个语义"）。
        //    稳定键另开两个新字段，见下。
        ...(entry.from ? { from: String(entry.from).slice(0, 40) } : {}),
        // 稳定身份键（ATI-P0）：按人检索 / 按人画像**只能**用它。
        // 消费方在 ATI-3 落地前，这两个字段是"先把数据记对"，不是"修正正在显形的缺陷"。
        ...(entry.fromId ? { fromId: String(entry.fromId).slice(0, 20) } : {}),
        // 当时的显示名：只作展示与追溯，**不作键**（改名后仍能看出当时叫什么）
        ...(entry.fromName ? { fromName: String(entry.fromName).slice(0, 40) } : {}),
      }) + '\n'
    );
    // 超上限就折半截断（和对话流一个做法），保留最近的一半
    const all = fs.readFileSync(AUTO_MEMORY_FILE, 'utf8').split('\n').filter(Boolean);
    if (all.length > MAX_RECORDS) {
      fs.writeFileSync(AUTO_MEMORY_FILE, all.slice(-Math.round(MAX_RECORDS / 2)).join('\n') + '\n');
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * ════════════════════════════════════════════════════════════════════
 *  结构化记忆（ATI-3）
 * ════════════════════════════════════════════════════════════════════
 *  与上面那份"自动记录"的关系（**必须说清，否则会变成两份拷贝**）：
 *    · `panel/auto-memory.jsonl` —— **存量**，本轮起**不再新增**，仍按原样注入（不破坏既有行为）；
 *    · `panel/memory-records.json` —— **增量**，新判断出来的都写这里，带 kind / 来源 / 状态 / 复证次数。
 *  二者不是"同一件事两份"：旧的冻结不再写，新的只写一处。旧记录会随容量折半自然退出。
 *
 *  为什么新记录默认不进提示词（`candidate`）：
 *    群里任何人都能开一句玩笑，一被看到就当事实 = 没有确认环节。
 *    所以第一次只落盘，**被独立复证**才转为可用。见 `memory-record.js` 的 `mergeRecord`。
 */

/**
 * `readRecords` 与 `RECORDS_FILE` 已搬进 `memory-store.js`（见文件上方 import 处）。
 * 写入**仍留在这里** —— 它要走 `atomic-write.js` 的原子写纪律，而面板侧只读不写。
 */
export function writeRecords(items) {
  writeJsonAtomic(RECORDS_FILE, { v: 1, items });
}

/**
 * 追加（或复证）一条结构化记忆。
 *
 * 复证 = 又**独立**观察到一次；读取 / 展示 / 它自己复述**都不算** ——
 * 否则反复曝光会让一条记忆自己变可信（这是这类系统最典型的失真）。
 *
 * @param {object} raw
 * @param {{supersedes?:string}} [opts] `supersedes` = 被这一条**推翻**的旧记忆的正文
 *   （由判断环节给出；给空就是"没推翻任何一条"）。
 * @returns {{ok:boolean, skipped?:string, merged?:boolean, supersededId?:string|null, error?:string}}
 */
export function appendRecord(raw, opts = {}) {
  const rec = normalizeRecord(raw);
  if (!rec) return { ok: false, error: '非法记录（kind 或正文缺失）' };
  // 时间注入口（OPS-FIXTURE）：`supersededAt` 要落盘，判据就不能直接读墙钟
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();

  // 注入闸门与自动记忆**共用同一道**（唯一实现在 injection.js）：
  // 结构化记忆同样是从"别人说的话"里提取的，同样会被注入提示词，没有理由少这一道。
  const hit = injectionGate(`${rec.text} ${rec.detail}`, '结构化记忆', rec.text.slice(0, 40));
  if (hit) return hit;

  // ⚠️ 这一条**推翻了旧的** → 不许被判成"复证"。
  //    "喜欢 X" 与"不喜欢 X" 字面极其相似，只看相似度会把它俩当成同一件事，
  //    于是错的那条 samples +1、越错越巩固 —— 这正是要打断的那个环。
  //
  // ── D-M2：先找目标，找不到就**不认那句 supersedes**（2026-10-04 体检后修）──
  //    改造前是"只要模型给了 supersedes 就一律新增一条"，而模型填的原文经常
  //    匹配不上（措辞被改、显示名变了、或它根本记错了）。后果在真机上看得见：
  //    同一件事在盘上堆成 4~5 份副本，随后副本互相推翻 —— 46% 的 superseded
  //    是这么来的，**不是"人改了主意"**。
  //    修完的方向是 fail-safe：找不到目标 → 本条按普通新观察走（该复证就复证、
  //    该新增才新增），不会凭一句不可信的 supersedes 又抄一份出来。
  const supersedes = String(opts.supersedes || '').trim();
  const items = readRecords();
  const supersededIdx = supersedes
    ? items.findIndex((r) => r && r.status !== 'superseded'
        && similarity(r.text, supersedes) >= SIMILAR_THRESHOLD)
    : -1;
  const realSupersede = supersededIdx >= 0;

  // ── 这一条是不是已有的同一条（能不能复证）──
  const sameIdx = realSupersede
    ? -1
    : items.findIndex((r) => {
      if (r?.id === rec.id) return true;
      if (!r?.text || similarity(r.text, rec.text) < SIMILAR_THRESHOLD) return false;
      // ── 字面像但**方向相反** → 不许当成同一条去复证 ──
      // 「他喜欢加喵」与「他不喜欢加喵」只差一个"不"字，相似度必然过阈值。
      // 合并的代价是错的那条 samples +1（真机实测涨到 4 次、升成已确认，越错越难纠正）；
      // 不合并的代价只是多一条候选（它仍要被独立复证才可能进提示词）—— 方向是 fail-safe。
      // 判据在 `memory-record.js`（零依赖叶子），这里只是接线点。
      if (oppositePolarity(r.text, rec.text)) return false;
      // ── 主语不同 → 不是同一条（D-M1）──
      // 「阿岚不吃香菜」与「小北不吃香菜」字面几乎一样，却是两个人的事。
      // 不合并只是多一条候选；合并了等于把两个人的印象混成一个 ——
      // 体检里"同一个 QQ 号下挂 3 种不同主语"就是从这一步进来的。
      return subjectMatches(r, rec);
    });
  let next;
  let merged = false;
  if (sameIdx >= 0) {
    // 同一件事 → 复证：samples +1，首次观察时间**沿用旧的**
    next = [...items];
    next[sameIdx] = mergeRecord(items[sameIdx], rec);
    merged = true;
  } else {
    next = [...items, rec];
  }

  // ── 时间维度（第 13 轮）：这一条**推翻**了某条旧记忆 ──
  // 旧的那条**不删除**（保留"它曾经以为过什么"），标成 superseded 让它不再注入。
  // ⚠️ 判据**由判断环节给出**（它看得见语境），这里只负责按相似度把它对上号 ——
  //    让代码猜"两句话是不是矛盾"必然误伤（试过：字重合 + 否定词的启发式
  //    把"喜欢追剧"和"不喜欢被叫臭肥鱼"判成了矛盾）。
  // ⚠️ 匹配不上就**什么都不做**并如实记一条日志：误伤一条还有效的记忆，
  //    比漏掉一次失效更糟（D-M2 也只是不认那句 supersedes，不会顺手标错人）。
  let supersededId = null;
  if (realSupersede) {
    const targetId = items[supersededIdx]?.id;
    const vIdx = next.findIndex((r) => r && r.id === targetId && r.status !== 'superseded');
    if (vIdx >= 0) {
      supersededId = next[vIdx].id;
      // `supersededAt` 是**观测留档**：第 13 轮那条遗留是"superseded 在真机上
      // 还没自然触发过一次"，留了时刻才能事后回答"到底触发过几次、什么时候"。
      // `now` 由入参给（OPS-FIXTURE 的同一条纪律：判据不直接读墙钟，否则测不了）。
      next[vIdx] = { ...next[vIdx], status: 'superseded', supersededBy: rec.id, supersededAt: now };
      log.info(`记忆失效（被更新的观察推翻）：${next[vIdx].text} → 改为 ${rec.text}`);
    }
  } else if (supersedes) {
    log.info(`判断说推翻了「${supersedes.slice(0, 30)}」，但没找到能对上号的那条 → 本条按普通观察处理（D-M2）`);
  }

  // 超上限时**先淘汰失效的**，不是"留最近的一半"（判据与理由见 `trimRecords`）。
  // 淘汰要**留痕**：静默丢一批记忆，正是本项目最怕的那类"改了不报错"。
  const { kept, evicted } = trimRecords(next, { max: RECORDS_MAX });
  if (evicted.length) {
    const dead = evicted.filter((r) => r.status === 'superseded' || r.status === 'rejected' || r.status === 'archived').length;
    log.info(`记忆超上限（${next.length} > ${RECORDS_MAX}）→ 淘汰 ${evicted.length} 条（其中失效 ${dead} 条）`);
  }
  writeRecords(kept);
  return { ok: true, merged, supersededId, evicted: evicted.length };
}

/**
 * 这一轮要注入的结构化记忆。**只返回可用（confirmed）且在本会话范围内的**。
 * 预算与排序的判据在 `memory-record.js`（那里是纯函数，能被直接断言）。
 */
export function recordsForPrompt(opts = {}) {
  return selectForPrompt(readRecords(), opts);
}

/**
 * ────────────────────────────────────────────────────────────────────────
 *  按需回忆（D-M3）
 * ────────────────────────────────────────────────────────────────────────
 *  与 `recordsForPrompt` 的分工（写清楚，免得变成两份实现）：
 *    · `recordsForPrompt` —— **常驻**那份：已复证、按预算挑最该提的，不问也进；
 *    · `recallForPrompt`  —— **被问到**那份：按问句去捞，**允许捞出候选态**
 *      （它还没复证，只能当线索；渲染时带「（还没复证）」的标记）。
 *
 *  ⚠️ 检索**不算复证**：捞出来看一眼、甚至说给用户听，都不是新的独立观察，
 *     `samples` 一条都不加（同"展示不算复证"的纪律）。
 *  ⚠️ 它**不落盘、不改状态**：只读一次盘、返回几行文本。
 *
 * @param {string} query 用户那句话
 * @param {{chatKey?:string, userId?:string, now?:number, limit?:number, max?:number}} opts
 * @returns {{lines:string[], hits:object[], scanned:number, reason?:string}}
 */
export function recallForPrompt(query, opts = {}) {
  const out = searchRecords(readRecords(), query, {
    chatKey: opts.chatKey,
    now: opts.now,
    limit: opts.limit,
    // 只捞「可用态」（confirmed / candidate）—— 候选态**允许**出现：用户问"你还记得吗"，
    // 答"我不确定，好像是…"比答"我不记得"更接近真人。标记由 `renderRecalled` 负责。
    // ⚠️ 键名必须是 `includeDead` —— `memory-record.js` 的 `searchRecords` 认的就是它
    //    （见那里第 `!opts.includeDead && …` 那一行）。
    //    2026-10-04 审查轮修正：此处原写 `includeUnavailable: false`，那个键**根本不存在** ——
    //    它被静默忽略，行为碰巧正确（`includeDead` 默认 falsy），所以四层全绿而错字一直在。
    //    这正是"死参数"最危险的地方：**它看起来在工作**。
    includeDead: false,
  });
  return {
    lines: renderRecalled(out.hits, { max: opts.max }),
    hits: out.hits,
    scanned: out.scanned,
    reason: out.reason,
  };
}

/**
 * ────────────────────────────────────────────────────────────────────────
 *  人工复核一条结构化记忆（ATI-5 · 面板记忆页）
 * ────────────────────────────────────────────────────────────────────────
 *  「什么时候忘」原来只有两条自动路径：复证升级（`mergeRecord`）与半衰淡忘
 *  （`activationOf`，只影响排序）。**人插不上手** —— 而 `rejected` 这个状态
 *  在这一批之前根本没有生产者：`mergeRecord` 专门写了"被否过的不复活"，
 *  却没有一处能把状态设成 `rejected`。
 *
 *  这里是「人工改状态」**唯一的落盘口**：判定全在 `memory-record.js` 的纯函数里，
 *  本函数只做"读 → 找 → 改 → 写"。
 *
 *  ⚠️ 整份重写（原子写），与 `appendRecord` 同款。机器人进程也会写这份文件 ——
 *    两者理论上会撞车，代价最多是丢掉"刚好那一瞬间"的一方改动。
 *    这是**已知且有意接受**的，与 `/api/custom/memory/delete` 完全同款：
 *    另一个选择是让面板按行追写，而这份文件是 JSON 数组、不是行式存储。
 *    真正的风险（两个进程都整份重写、把文件写坏）由 `writeJsonAtomic` 挡住。
 *
 * @returns {{ok:boolean, action?:string, status?:string|null, removed?:boolean, error?:string, reason?:string}}
 */
export function reviewRecordById(id, action, now = Date.now()) {
  const key = String(id ?? '').trim();
  if (!key) return { ok: false, error: '没有指定要复核哪一条', reason: 'no-id' };

  const items = readRecords();
  const idx = items.findIndex((r) => r?.id === key);
  // 找不到就说"不在了"，**不要**顺手新建一条 —— 面板点一个过期的按钮，
  // 不该在磁盘上凭空长出一条记录（那是"界面在说一件没发生的事"的反向版本）。
  if (idx < 0) return { ok: false, error: '这条记忆已经不在了（可能刚被删过）', reason: 'not-found' };

  const out = reviewRecord(items[idx], action, now);
  if (!out.ok) {
    return {
      ok: false,
      reason: out.reason,
      error: out.reason === 'action-unknown' ? `不认识的动作：${action}` : '这条记忆读不出来',
    };
  }

  const next = out.removed
    ? items.filter((_, i) => i !== idx)
    : items.map((r, i) => (i === idx ? out.record : r));

  try {
    writeRecords(next);
  } catch (e) {
    return { ok: false, error: `写不进记忆文件：${e.message}`, reason: 'write-failed' };
  }
  return { ok: true, action: out.action, removed: !!out.removed, status: out.record ? out.record.status : null };
}

/**
 * 让模型判断这一轮对话里有没有值得长期记住的事。
 *
 * 提示词刻意写得**极其克制**：宁可漏记，也不能把"今天天气不错"这种话记下来 ——
 * 记错的东西会一直跟在后面影响每一轮回复，比不记更糟。
 */
const JUDGE_SYSTEM = [
  '你是一个记忆筛选器。下面会给你一段 QQ 群聊。',
  '你的任务：判断其中有没有**关于某个人或这个群的、长期稳定的倾向**值得记住。',
  '',
  '值得记的例子：某人明确说过不喜欢被怎么叫、稳定的偏好或忌口、固定作息、',
  '群里约定过的规矩、某人明确要求"别跟我说什么话题"。',
  '**也包括关于你自己的事**（who 填 "self"）：别人给你起了什么外号你不喜欢、',
  '群里已经习惯了怎么叫你、你在群里答应过谁什么事 —— 这些同样值得记。',
  '',
  '**不值得记**的例子：某次聊天的具体内容、临时的心情、天气、新闻、玩笑、寒暄。',
  '',
  '⚠️ **方向绝不能搞反**（这是真机上实测最容易错的一处）：',
  '- 他说「以后别这样 / 不用加 / 去掉吧」→ 他**不要**这个；记成「他喜欢」就是反的。',
  '- 他自己要求去掉某样东西 → 那东西**不受欢迎**，不是他喜欢。',
  '- 「他自己不带 ✨」≠「他不喜欢别人带 ✨」—— 别把主语换掉。',
  '- **text 必须与 detail 同向**：detail 里写「他同意去掉」，text 就不能写「他喜欢」。',
  '',
  '⚠️ **出现一次不算稳定**：只出现过一次的事（有人问了一次某话题、说过一次某句话）',
  '  不是「长期稳定的倾向」—— 那属于「某次聊天的具体内容」，**不要记**。',
  '',
  '输出**只有一行 JSON**（不要解释、不要代码块）：',
  '  {"none":false,"kind":"person","who":"#1234","text":"四十字以内的陈述","detail":"六十字以内的依据","supersedes":""}',
  '  {"none":true}',
  '',
  '⚠️ `who`：**这条记忆是关于谁的** —— 最容易搞错、也是最要紧的一栏。',
  '  只能填三种值：',
  '  ① 下面消息里给出的**身份号**（形如 `#1234`）→ 说的是那个群友；',
  '  ② `"self"` → 说的是**你自己**（你的名字、你的喜好、你的经历、你被怎么称呼）；',
  '  ③ `""` → 说的是这个群整体的事，或实在说不清是谁。',
  '  ⚠️ **谁说的 ≠ 说的是谁**：群里 A 在议论 B，`who` 要填 **B** 的号，不是 A 的。',
  '  ⚠️ 别人聊你、给你起外号、说你不喜欢什么 —— 那属于 `"self"`，**不是**那个人的偏好。',
  '  ⚠️ **不许填名字**（名字会重复、会改）；认不出是谁就填 `""`，别硬猜。',
  '  ⚠️ **照抄上面给出的那串 `#` 号**（给的是 `#7549`，`who` 就写字面的 `"#7549"`）——',
  '    不要补全、不要改写、更不要把它还原成完整 QQ 号：写错一个字符就等于认不出是谁。',
  '',
  '⚠️ `text` 里**不许出现任何人的名字或身份号** —— 主语由 `who` 表达，正文只写陈述句：',
  '  ✓ who="#1234" text="不喜欢被叫臭肥鱼"',
  '  ✗ who="" text="阿岚不喜欢被叫臭肥鱼"（名字塞进正文，换个人就串了）',
  '',
  '⚠️ `supersedes`：**这一条推翻了之前记下的哪一条**（"时间维度"）。',
  '- 人会改主意：他以前喜欢 X，现在明确说不要 X —— 那就是推翻了。',
  '- 填被推翻那条**原文**（照抄，别改写 —— 下面要靠它去对上号）；没有就填空字符串。',
  '- **拿不准就填空**：误把一条还有效的记忆判成失效，比漏掉一次失效更糟。',
  '',
  'kind **只有这三个取值**，别的都算错（它必须与 `who` 对得上）：',
  '- person：关于**某个群友**的稳定倾向（偏好 / 禁忌 / 称呼 / 口头禅）→ who 必须是某个号',
  '- topic ：话题与未竟事项（聊过什么、答应过什么还没做）→ who 可以空',
  '- self  ：**你自己**的经历、约定、被怎么称呼 → who 必须是 `"self"`',
  '',
  '⚠️ 只收**稳定倾向**，不收具体事实：群里的一句玩笑不能当成"TA 就是这样的人"。',
].join('\n');

/**
 * 归一 `who`：只认 `#<身份号>`、`self`、空串三种。
 *
 * 别的（模型写了名字、写了"阿岚"、写了简体说明）一律降级成空串 ——
 * 空串的含义是"不知道是谁"，渲染时不带主语标签（正文原样给）。
 * 这比"硬塞一个错的人"安全：**错的主语比没有主语更糟**，因为读的人会当真。
 *
 * ⚠️ 允许**不带 `#`** 的纯数字（真机 2026-10-04 01:18 实测：模型两次都自己改了形式，
 *    一次补全成完整号、一次可能漏掉 `#`）—— 形式不该成为丢掉主语的理由。
 */
function normalizeWho(v) {
  const s = String(v ?? '').trim();
  if (!s) return '';
  if (s.toLowerCase() === SUBJECT_SELF) return SUBJECT_SELF;
  const m = s.match(/^#?([A-Za-z0-9]{1,12})$/);
  return m ? `#${m[1]}` : '';
}

/**
 * 按身份号查人。**两段**，第二段是真机逼出来的。
 *
 *   ① 精确命中（`#7549`）—— 正常路径；
 *   ② **唯一后缀命中** —— 真机实测（2026-10-04 01:18:35）：模型看到 `【阿岚 #7549】`
 *      之后，把标签"补全"成了完整号 `#<完整号>` 填进 `who`。精确匹配落空 →
 *      `subjectId` 被留空 → **那条记忆至今没有主语**（新机制上线后第一条就撞上）。
 *      补这一步：把号去掉 `#` 之后，若**恰好一个**成员与它互为前后缀 → 认定是他。
 *
 * ⚠️ 命中**不唯一**时返回 `null`（= 不知道是谁），**绝不猜**：
 *    多个候选里挑一个，正是体检里那 18 条"错挂在别人名下"的产生方式。
 *    代价只是这一条少个主语，而它仍会被独立复证 —— 方向是 fail-safe。
 */
function lookupSubject(tag, idMap) {
  const exact = idMap.get(tag);
  if (exact) return exact;
  const digits = String(tag || '').replace(/^#/, '');
  // ⚠️ 太短的号不做后缀匹配：`#1` 会跟"任何以 1 结尾的号"撞上，那是**猜**而不是认。
  //    真机那次模型给的是完整号（10 位），这个门槛够用。
  if (digits.length < 3) return null;
  const hits = [];
  for (const v of idMap.values()) {
    const id = String(v?.id || '');
    if (!id) continue;
    if (id === digits || id.endsWith(digits) || digits.endsWith(id)) hits.push(v);
  }
  // 同一个人的多个标签（理论上不会出现）不算歧义 —— 按**人**去重后再判。
  if (new Set(hits.map((h) => h.id)).size !== 1) return null;
  return hits[0];
}

/**
 * 把判官的 `who` 翻译成落盘用的主语（D-M1）。
 *
 * 纯函数（`idMap` 由调用方给），所以能被 smoke 直接喂：
 *   · `#1234` → 查表得到 `{id, name}`；
 *   · `self`  → `{id: SUBJECT_SELF, name: 机器人名}`，并把 kind 拉回 `self`
 *     （判官偶尔会写 kind=person + who=self，以 who 为准 —— 主语是更硬的事实）；
 *   · 认不出的标签 / 空 → `{id:'', name:''}`（不知道是谁，渲染时不带标签）。
 *
 * ⚠️ `kind` 由 `resolveSubject` 改写**只发生在 `self` 这一支**；其余情况原样带回。
 */
export function resolveSubject(who, idMap = new Map(), botName = '', kind = '') {
  const w = String(who ?? '').trim();
  if (w === SUBJECT_SELF) {
    return { kind: 'self', subjectId: SUBJECT_SELF, subjectName: String(botName || '') };
  }
  const hit = w ? lookupSubject(normalizeWho(w) || w, idMap) : null;
  if (hit) return { kind, subjectId: String(hit.id || ''), subjectName: String(hit.name || '') };
  return { kind, subjectId: '', subjectName: '' };
}

/**
 * 解析筛选器的输出。**宁可不记，也不猜** ——
 * 模型偶尔不听话写一长段，认不出来就返回 null（这次不记），绝不去文本里硬抠。
 *
 * @returns {{kind:string, who:string, text:string, detail:string, supersedes:string}|null}
 */
export function parseJudge(out) {
  const s = String(out ?? '').trim();
  if (!s) return null;
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) return null; // 旧格式 / 胡说 → 不记
  try {
    const o = JSON.parse(s.slice(start, end + 1));
    if (!o || o.none === true) return null;
    const text = String(o.text ?? '').trim();
    if (!text || text.length < 3) return null;
    return {
      kind: String(o.kind ?? '').trim(),
      // 主语（D-M1）。判官有时不写这个字段（旧提示词的习惯）→ 空串 = 不知道是谁。
      who: normalizeWho(o.who),
      text: text.slice(0, 40),
      detail: String(o.detail ?? '').trim().slice(0, 60),
      // 被这一条**推翻**的旧记忆（原文）。模型可能不写这个字段 —— 那就是"没推翻任何一条"。
      supersedes: String(o.supersedes ?? '').trim().slice(0, 80),
    };
  } catch {
    return null;
  }
}

export class MemoryKeeper {
  /**
   * @param {() => object} getCfg 取当前配置（配置会热重载，所以传函数而不是快照）
   * @param {{chat: Function}} llm 复用当前大脑的模型
   */
  constructor(getCfg, llm) {
    this.getCfg = getCfg;
    this.llm = llm;
    /** 上一次判断的时间，用来限流 */
    this.lastAt = 0;
    /** 正在判断中就别并发再开一个 */
    this.busy = false;
  }

  /**
   * 考虑记一条。**永远不 await、永远不抛**：调用方 fire-and-forget 即可。
   * @param {{sender:string, text:string, reply:string, scene:string, id:string,
   *          userId?:string, senderName?:string}} ctx
   *   · `sender`     —— 显示名（保留：只传它的旧调用方行为完全不变）
   *   · `userId`     —— QQ 号，**稳定键**；ATI-3 的"按人筛选记忆"要用它
   *   · `senderName` —— 当时的显示名（缺省回落到 `sender`）
   * @param {{now?:number, onResult?:(r:object)=>void}} [opts] 时间注入口（OPS-FIXTURE）—— 不传就走墙钟；
   *   `onResult` 是 **D29 的判定卡出口**：判定跑完（成功 / 没记 / 失败三种都算）回调一次，
   *   由宿主（`index.js`）交给 `writeTrace`。记忆模块**不认识 trace**，只报事实。
   */
  consider(ctx, opts = {}) {
    const cfg = this.getCfg();
    if (!cfg?.custom?.memory?.auto) return;
    if (this.busy) return;

    // 限流：群里刷得快的时候，每两条消息都去问一次模型纯属烧钱。
    // 90 秒一次足够 —— 值得长期记住的事不会只出现一次。
    //
    // ⚠️ `now` 由入参给（默认才是墙钟）：这条限流是个**判据**，
    // 判据一旦直接读墙钟，就只能在真机上等 90 秒才能验一次 —— 那等于没法验。
    const now = opts.now ?? Date.now();
    if (now - this.lastAt < 90000) return;
    this.lastAt = now;
    this.busy = true;

    // ── D29 · 判定卡的唯一出口 ──────────────────────────────────────────────
    // 三种结果都要报：`recorded` / `nothing` / `error`。
    // "判定失败装死"在账面上必须看得见 —— 这正是本节要治的形态：
    // 判官是 fire-and-forget，失败原来只有一行 warn 日志（默认级别 info 以上才打），
    // 于是"它今天一条记忆都没记"和"它根本没判成"在界面上完全同形。
    //
    // ⚠️ 留痕自身抛错**绝不许**影响回复：调用方是整个 fire-and-forget 链的起点。
    const report = (result, r, err) => {
      try {
        opts.onResult?.({
          result,
          ms: r?.ms || 0,
          usage: r?.usage
            ? { prompt: r.usage.prompt, completion: r.usage.completion, reasoning: r.usage.reasoning }
            : null,
          model: r?.usage?.model || '',
          out: String(r?.out ?? '').slice(0, 200),
          error: err ? String(err.message || err) : '',
        });
      } catch {
        /* 留痕失败绝不影响回复 */
      }
    };

    this.#judge(ctx)
      .then((r) => {
        const parsed = r?.parsed || null;
        if (!parsed) { report('nothing', r); return; }
        // ── D-M1：主语落盘 ──────────────────────────────────────────────────
        // 判官给的 `who` 翻成 QQ 号（用的是 #judge 建好的**同一份** idMap）。
        // `who === 'self'` 时这里会把 kind 拉回 self —— 主语是比 kind 更硬的事实。
        const subj = resolveSubject(
          parsed.who, r?.idMap, this.getCfg()?.persona?.name || '机器人', parsed.kind
        );
        // 写**结构化**记忆（ATI-3），不再往旧的自动记录文件里追加 ——
        // 那份（auto-memory.jsonl）冻结为存量，避免同一件事两处拷贝。
        const res = appendRecord({
          kind: subj.kind,
          text: parsed.text,
          detail: parsed.detail,
          provenance: {
            chatKey: `${ctx.scene}:${ctx.id}`,
            // 发送者：只作**溯源**（这是谁在说这件事），不再是这条记忆的主语
            userId: ctx.userId,
            messageId: ctx.messageId,
            // 主语：这条记忆**关于谁**（渲染与合并判据都读它）
            subjectId: subj.subjectId,
            subjectName: subj.subjectName,
          },
          // ⚠️ 时间维度（第 13 轮）：这一条**推翻**了哪条旧记忆。
          //    判据由判断环节给出（它看得见"之前记过什么"），这里只是把它带过来。
        }, { supersedes: parsed.supersedes });
        if (res.ok && !res.skipped) {
          log.info(`记忆${res.merged ? '复证' : '新增'}：${parsed.text}`);
          report('recorded', r);
        } else {
          // 判官给了内容、但没落成新记录（重复 / 被合并）—— 那不算"记了一条"，如实报 nothing。
          report('nothing', r);
        }
      })
      .catch((e) => {
        report('error', null, e);
        log.warn(`自动记忆判断失败（不影响回复）: ${e.message}`);
      })
      .finally(() => {
        this.busy = false;
      });
  }

  async #judge(ctx) {
    // ── 让判断看见**语境** ──
    // 只给一条孤立的消息，模型根本没法判断「方向」。真机实测（2026-09-24）：
    // 把「他说以后别加喵」记成了「他喜欢加喵」—— 它只看到一句带"喵"的话；
    // 而且**它自己写的 detail 里明明写着"并同意去掉"**，text 却写反了。
    // 另一条同形：「他自己要求不带✨」被记成「他不喜欢**别人**带✨」。
    // 所以把群里的环境消息（带说话人）一起给它。
    // 当前这条也在 ambient 里（index.js 在处理早期就记了），按「同一个人 + 同一句话」
    // 排除掉，免得拼两遍。
    const name = this.getCfg()?.persona?.name || '机器人';

    // ── 身份号（D-M1）──────────────────────────────────────────────────────
    // 给每个发言人一个**本轮内唯一**的短标签（`【阿岚 #1234】`），判官用它回答
    // "这条是关于谁的"。
    // ⚠️ 标签只是 prompt 里的代词，**落盘存的是完整 QQ 号** —— 所以标签撞车
    //    只影响这一次判断，不会污染数据（与 `shortIdOf` 的边界声明一致）。
    // ⚠️ 后 4 位撞了就加长到唯一；真撞到底（两个号互为后缀）才用带序号的兜底标签。
    const idMap = new Map(); // tag -> {id, name}
    const tagFor = (userId, speaker) => {
      const uid = String(userId || '');
      if (!uid) return ''; // 没有 QQ 号（旧存档条目）→ 不给标签，判官也就不可能指认它
      for (let len = 4; len <= uid.length; len += 2) {
        const tag = shortIdOf(uid, len);
        const prev = idMap.get(tag);
        if (!prev || prev.id === uid) {
          idMap.set(tag, { id: uid, name: String(speaker || '') });
          return tag;
        }
      }
      const tag = `#u${idMap.size + 1}`;
      idMap.set(tag, { id: uid, name: String(speaker || '') });
      return tag;
    };
    const line = (speaker, text, userId) => {
      const tag = tagFor(userId, speaker);
      return `【${speaker}${tag ? ` ${tag}` : ''}】${text}`;
    };

    const recent = (ctx.history || []).filter(
      (h) => h && h.text && !(h.speaker === ctx.sender && h.text === ctx.text)
    );
    const convo = [
      ...recent.map((h) => line(h.speaker, h.text, h.speakerId)),
      line(ctx.sender, ctx.text, ctx.userId),
      // 她自己那句话单独标注：判官要能分清"这是谁说的"与"说的是谁"。
      ctx.reply ? `【${name}（这是你自己说的话）】${ctx.reply}` : '',
    ].filter(Boolean).join('\n');

    // ── 让它看得见「之前记过什么」，才能判断这一条是不是把旧的**推翻**了 ──
    // 第 13 轮加。之前它只看着眼前这段对话，于是"他以前喜欢 X、现在说不要 X"
    // 会被当成两个独立的事实，旧的继续注入、还因反复看到而越滚越巩固。
    // 只给**同一会话**（按会话隔离的纪律不能破），且跳过已经失效 / 被否掉的。
    const chatKey = `${ctx.scene}:${ctx.id}`;
    const userId = String(ctx.userId || '');
    // ⚠️ D-M1：范围要**同时**认出"这个人说的"与"关于这个人的" ——
    //    改造前只看发送者，于是"他以前不喜欢 X、后来说不要 Y"这类**同一主语**的
    //    先后观察根本不在判官眼前，supersedes 自然填不对（副本堆积正是从这里开始的）。
    const known = readRecords()
      .filter((r) => r
        && r.status !== 'superseded' && r.status !== 'rejected' && r.status !== 'archived'
        && (r.provenance?.chatKey === chatKey
            || (userId && r.provenance?.userId === userId)
            || (userId && r.provenance?.subjectId === userId)))
      .slice(-6)
      // 带主语名：判官要能看出"这是关于谁的"，才判得动"这一条有没有推翻它"
      .map((r) => {
        const who = r.provenance?.subjectId === SUBJECT_SELF
          ? `${name}（你自己）`
          : (r.provenance?.subjectName || '');
        return `- ${who ? `${who}：` : ''}${r.text}`;
      })
      .join('\n');
    const prompt = known ? `${convo}\n\n（你之前在这个群里记过：\n${known}\n）` : convo;

    // 走 chatWithUsage 而不是 chat：**自己那一份账自己拿**。
    // 这条判断与主链路共用同一个 LlmClient，而 llm.lastUsage 是实例上的共享可变字段 ——
    // 用 chat() 的话，keeper 的用量既不会被记进账本（主链路早就记完自己那份了），
    // 还可能反过来盖掉主链路的账（谁后写完谁生效，看时序）。
    const t0 = Date.now();
    const { text: out, usage } = await this.llm.chatWithUsage(
      [
        { role: 'system', content: JUDGE_SYSTEM },
        { role: 'user', content: prompt },
      ],
      // 判断用不着创造力，温度压到 0；输出改成 JSON 后要略微放宽 max_tokens。
      //
      // ⚠️ **必须显式关思考**：这 160 个 token 是留给那行 JSON 的，而配置里
      //    `thinking.mode` 可能是 `on` —— 开着思考时额度会被 reasoning 吃满，
      //    content **恒为空**、`finish_reason` 是 `length`。
      //    真机实测（2026-09-23）：5 次调用 5 次失败，表现是结构化记忆
      //    **在真机上一条都没落过盘**，而四层回归全绿（mock 不模拟"思考吃额度"）。
      //    判断只是"这段群聊里有没有值得记的"，用不着思维链。
      { temperature: 0, maxTokens: 160, thinking: { mode: 'off' } }
    );
    // 补上这笔"看不见的固定支出"。
    // 它在旧实现里从来没进过 usage.jsonl：recordUsage(llm.lastUsage) 在主链路上
    // 已经执行完了，而 consider() 是**故意不 await** 的。
    //
    // D8：带上会话键（就是上面第 498 行已经算出来的那个 `chatKey`）——
    // 不带的话这一笔只进"当日总量"、不进任何会话，于是"这个群今天花了多少"
    // 会**系统性偏低**，而 perChat 限额就是按它判的。
    recordUsage({ ...usage, chat: chatKey, source: USAGE_SOURCES.memoryJudge });

    // ── D29 · 判定可见性 ────────────────────────────────────────────────────
    // 返回**报告**而不是只回解析结果：调用方要能如实地把"这次判定花了多久 /
    // 用了多少 / 它到底吐了什么 / 有没有失败"写到 trace 上。
    //
    // ⚠️ 只往返回里**加字段**，不改 `parseJudge` 的语义 —— 落盘的记忆内容仍然
    //    只由 `parsed` 说了算，判定卡是**另一个消费者**（过程复盘），不是它的改写。
    return {
      parsed: parseJudge(out),
      // ⚠️ `idMap` 必须随报告一起交出去：`consider()` 要用**同一份**映射把
      //    `who` 翻成 QQ 号。在这里再建一份就是"同一件事两份实现"的开端。
      idMap,
      out: String(out ?? ''),
      usage,
      ms: Date.now() - t0,
    };
  }
}
