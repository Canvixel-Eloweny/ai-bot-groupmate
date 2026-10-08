/**
 * 面板 ↔ 机器人 控制通道 · 判据层（D6b · 用户 Q7 裁决①「命令文件轮询」）。
 *
 * ══════════════════════════════════════════════════════════════════════
 *  它补的是哪个缺口
 * ══════════════════════════════════════════════════════════════════════
 * D6 把「中止本轮 / 原地重试本轮」的**能力**做出来了（`session-control.js` +
 * `llm.js` 掐断在途 + `tool-loop` 两个检查点），但触发方式只有两个 Unix 信号
 * （`kill -USR1` / `kill -USR2`）—— 要开终端才能用，而用户明确说过不愿开终端。
 *
 * 缺的不是能力，是**通道**：面板 spawn 机器人时 `stdio: ['ignore', fd, fd]`，
 * 两者之间一个字节都传不过去。Q7 给了三个选项（命令文件轮询 / 回环控制端口 /
 * `stdio: pipe`），用户选了 **①命令文件轮询**。理由与代价：
 *   · 不开口子 —— 本机进程仍然一个监听端口都不多；
 *   · 代价是**延迟**（轮询间隔）与**多一份落盘**（多一个要进三件套的文件）。
 *
 * ══════════════════════════════════════════════════════════════════════
 *  三条必须守住的语义（都不是可选项）
 * ══════════════════════════════════════════════════════════════════════
 * ① **命令种类是闭集合**。它是一条能改变机器人行为的通道，多一个动词就多一片攻击面。
 *    `abort` / `retry` 之外一律拒 —— **默认拒绝**是这类边界唯一正确的默认。
 * ② **过期命令不许执行**。机器人可能正断着，用户在面板上点了「重试本轮」，
 *    十分钟后机器人起来 —— 这一条要是执行了，就是"恢复一个早就结束的状态"。
 *    本项目对这类问题有先例结论：**恢复一个过期的状态比不恢复更糟**（B10d）。
 *    所以过期就地把结果写成"已忽略"，让面板看得见，而不是静默丢掉。
 * ③ **一条命令只执行一次**。两道保险：文件里的 `done` 是**持久**的那道
 *    （进程重启也认），内存里的 `lastId` 是快的那道。只有前者也能成立 ——
 *    这也是为什么"执行结果"必须写回**同一个文件**而不是只打日志：
 *    机器人重启后靠它认得出"这条已经办过了"。
 *
 * ⚠️ 零依赖叶子：本文件**不许 import 任何模块**（`now` / IO / 执行体全部入参）。
 *    原因与 `session-control.js` / `interject.js` 相同 —— 判据要在 smoke 里
 *    被直接喂反例，而不是只能靠"起一台真机器人再点按钮"。
 */

/**
 * 命令种类（**闭集合**，唯一住处）。面板侧与契约都从这里取，不许各抄一份。
 *
 * Q12 裁决①加了 `sleep` / `wake` 两个 —— 它们是"手动让它睡 / 叫它醒"，
 * 与 `abort` / `retry`（动的是"正在生成的那一轮"）不是同一层，
 * 但同样走这一条通道（Q7 的裁决就是"要加新动作就加进闭集合，不另开通道"）。
 */
export const CONTROL_KINDS = ['abort', 'retry', 'sleep', 'wake'];

/**
 * 命令的最大寿命（毫秒）。**经验值，非官方阈值。**
 *
 * 取 2 分钟的理由：本通道的用途是"对这一轮做干预"，而一轮生成的量级是
 * 十几秒到一分钟（本机模型更慢）。超过两分钟还在排队的命令，它想干预的那一轮
 * 几乎一定已经结束了。再长就是"恢复过期状态"。
 */
export const CONTROL_MAX_AGE_MS = 2 * 60 * 1000;

/**
 * 轮询间隔（毫秒）。**经验值，非官方阈值。**
 *
 * 1500ms 是"用户按下去到机器人动起来"的可接受手感与 IO 成本之间的折中：
 * 每次轮询在**没有命令时只做一次 `existsSync`**（不做读、不做解析），
 * 所以常态开销接近 0 —— 真正读盘只发生在文件存在时。
 */
export const CONTROL_POLL_MS = 1500;

/**
 * 生成一个命令 id（纯函数：`now` / `rand` 都注入，测试才能拿到确定值）。
 *
 * 为什么要 id 而不是只靠时间戳：同一毫秒内连点两下要能分辨成两条命令。
 * 形状与 `trace-id.js` 的 `newTraceId` 同族（时间戳 + 随机尾），但**故意不共用**：
 * 那个是给日志串起来的，格式要稳定；这个是给人读的"哪一次点击"。
 */
export function newControlId({ now = Date.now(), rand = Math.random } = {}) {
  const tail = Math.floor(rand() * 0x1000000).toString(36).padStart(4, '0');
  return `c${now.toString(36)}-${tail}`;
}

/**
 * 解析命令文件的内容。**只做形状校验，不做可否执行的判断**（那是 `controlDecision`）。
 *
 * @param {string|object|null|undefined} raw 文件原文（或已解析的对象）
 * @returns {{id:string, cmd:string, at:number, done:object|null}|null} 不是一条像样的命令就给 null
 *
 * @sync-with json-object-guard —— 下面那段"原文 → 对象或 null"的守卫与
 *   `src/bridge-lock.js` 的 `parseLock` **逐字相同**。两个文件都是**零依赖叶子**
 *   （契约 §42① / §43① 各自钉死"一个 import 都不许有"），谁都不许 import 谁 ⇒ 抽不出公共模块；
 *   于是按 §9 的登记体例处置：`check-wb` 的抽取器证明两份逐字一致（改一处漏一处从此可见）。
 */
export function parseControlRecord(raw) {
  if (raw === null || raw === undefined) return null;
  let obj = raw;
  if (typeof raw === 'string') {
    const text = raw.trim();
    if (!text) return null;
    try {
      obj = JSON.parse(text);
    } catch {
      return null; // 半个 JSON（写盘被打断）与"没有它"同等对待：不猜
    }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const id = typeof obj.id === 'string' ? obj.id.trim() : '';
  if (!id) return null;
  const cmd = typeof obj.cmd === 'string' ? obj.cmd : '';
  const at = Number(obj.at);
  const done = obj.done && typeof obj.done === 'object' && !Array.isArray(obj.done) ? obj.done : null;
  return { id, cmd, at: Number.isFinite(at) ? at : 0, done };
}

/**
 * 「这一条命令现在能不能执行」的判据（**纯函数**，四个入参全部由调用方给）。
 *
 * @param {object|null} rec   `parseControlRecord` 的产物
 * @param {object} opts
 * @param {number} opts.now   当前时刻（注入，别读全局时钟）
 * @param {string} opts.lastId 本进程已经处理过的最后一条 id
 * @param {number} opts.maxAgeMs
 * @returns {{ok:boolean, action:'run'|'expire'|'none', id?:string, cmd?:string, reason:string}}
 *
 * `action` 三态是刻意的 —— 调用方要能区分"什么都别做"与"写一条'已忽略'回去"：
 *   run    —— 执行
 *   expire —— **不执行**，但要把结果写回文件，让面板看得见它被忽略了
 *   none   —— 与这条命令无关（还没消费完的、已办过的、不认识的）
 */
export function controlDecision(rec, { now = Date.now(), lastId = '', maxAgeMs = CONTROL_MAX_AGE_MS } = {}) {
  if (!rec) return { ok: false, action: 'none', reason: '没有待执行的命令' };
  if (rec.id === lastId) return { ok: false, action: 'none', id: rec.id, cmd: rec.cmd, reason: '这条命令已经处理过了' };
  // `done` 是持久的那道闸：机器人重启后 lastId 归零，全靠它认得出"这条办过了"。
  if (rec.done) {
    return { ok: false, action: 'none', id: rec.id, cmd: rec.cmd, reason: `这条命令已经有执行结果了（${rec.done.msg || ''}）` };
  }
  if (!CONTROL_KINDS.includes(rec.cmd)) {
    return { ok: false, action: 'none', id: rec.id, cmd: rec.cmd, reason: `不认识的命令「${rec.cmd}」—— 本通道只认 ${CONTROL_KINDS.join(' / ')}` };
  }
  // 没有时间戳的命令**不当成过期处理**（那会把它算成"执行过了"），而是拒绝执行。
  // 理由：无法判断它有多旧时，唯一安全的答案是"不动"。
  if (!(rec.at > 0)) {
    return { ok: false, action: 'none', id: rec.id, cmd: rec.cmd, reason: '命令没有发出时刻，无法判断是否过期 —— 拒绝执行' };
  }
  if (now - rec.at > maxAgeMs) {
    const ageS = Math.round((now - rec.at) / 1000);
    return {
      ok: false,
      action: 'expire',
      id: rec.id,
      cmd: rec.cmd,
      reason: `命令已过期（${ageS} 秒前发出，上限 ${Math.round(maxAgeMs / 1000)} 秒），已忽略 —— 它想干预的那一轮早就结束了`,
    };
  }
  return { ok: true, action: 'run', id: rec.id, cmd: rec.cmd, reason: '' };
}

/** 执行结果落进文件的形状（唯一构造点）。`pid` 是**执行者**的 pid，排障时靠它认出是哪台机器办的。 */
export function controlDoneOf({ ok = false, msg = '', at = Date.now(), pid = 0 } = {}) {
  return { ok: !!ok, msg: String(msg ?? ''), at: Number(at) || 0, pid: Number(pid) || 0 };
}

/**
 * 跑一轮轮询（`runControlStep` 是**一次轮询的整个动作**，不是"检查一下"）。
 *
 * 为什么把 IO 做成入参而不是直接 `import fs`：这样 smoke 能用一个假的文件系统
 * 把整条链路（读 → 判 → 执行 → 写回 → 竞态复核）跑一遍，而不必起一台真机器人。
 * 真实调用点只有一处（`src/index.js` 的 `pollControl`）。
 *
 * ⚠️ 执行完之后**必须重新读一次文件**再写回。这中间面板可能又下发了一条新的
 *    （用户连点两下）—— 那就不能拿旧记录去覆盖它，否则文件的 `id` 会退回去，
 *    而新命令因此永远拿不到 `done`（表现是"点了没反应"，且不报错）。
 *    这种情况下**宁可把这条结果丢在日志里**，也不覆盖新命令。
 *
 * @param {object} p
 * @param {() => (string|null)} p.readRaw   读命令文件原文（读不到给 null）
 * @param {(rec:object) => void} p.writeRec 原子写回整条记录
 * @param {(cmd:string) => ({ok:boolean,msg:string})} p.exec 执行命令（真实实现只在 index.js 给）
 * @returns {Promise<{action:'run'|'expired'|'none', id?:string, cmd?:string, ok?:boolean, reason:string, lost?:boolean}>}
 */
export async function runControlStep({
  readRaw,
  writeRec,
  exec,
  now = Date.now(),
  lastId = '',
  maxAgeMs = CONTROL_MAX_AGE_MS,
  pid = 0,
} = {}) {
  let raw = null;
  try {
    raw = readRaw();
  } catch {
    return { action: 'none', reason: '读不到命令文件（当作没有命令）' };
  }
  const rec = parseControlRecord(raw);
  if (!rec) {
    return { action: 'none', reason: '没有待执行的命令' };
  }
  const d = controlDecision(rec, { now, lastId, maxAgeMs });

  if (d.action === 'expire') {
    // 过期也要留痕：写回 `done` 之后面板才看得见"它被忽略了、为什么"。
    try {
      writeRec({ ...rec, done: controlDoneOf({ ok: false, msg: d.reason, at: now, pid }) });
    } catch {
      /* 写不回去只影响可观测性，不影响"没有执行"这个结论 */
    }
    return { action: 'expired', id: rec.id, cmd: rec.cmd, ok: false, reason: d.reason };
  }
  if (!d.ok) return { action: 'none', id: rec.id, cmd: rec.cmd, reason: d.reason };

  let result = { ok: false, msg: '执行体没有返回结果' };
  try {
    result = (await exec(rec.cmd)) || result;
  } catch (e) {
    // 执行体抛错要如实记成"执行失败"，**不许**当成"没执行过"——
    // 后者会让这条命令每轮都被重跑一遍（而它每次都会再抛一次）。
    result = { ok: false, msg: `执行异常：${e.message}` };
  }

  // ⚠️ `done.at` 记的是**这一轮轮询的时刻**（注入的 `now`），不是"执行返回的那一刻"。
  //    两个理由：① 执行是这一轮里的一个瞬间，毫秒级精度对这条记录没有意义；
  //    ② 时间源只有一个 —— 注入 `now` 才能让"写回去的记录"在 smoke 里被逐字断言
  //    （同一个函数里出现两个时钟，下一个人一定会问"哪个才算数"）。
  const done = controlDoneOf({ ok: result.ok, msg: result.msg, at: now, pid });

  let curRec = null;
  try {
    curRec = parseControlRecord(readRaw());
  } catch {
    curRec = null;
  }
  if (curRec && curRec.id === rec.id) {
    try {
      writeRec({ ...rec, done });
    } catch {
      return { action: 'run', id: rec.id, cmd: rec.cmd, ok: result.ok, reason: `${result.msg}（结果写不回文件，机器人日志里还能查到）` };
    }
  } else {
    return {
      action: 'run',
      id: rec.id,
      cmd: rec.cmd,
      ok: result.ok,
      lost: true,
      reason: `${result.msg}（结果未写回：面板已下发新命令）`,
    };
  }
  return { action: 'run', id: rec.id, cmd: rec.cmd, ok: result.ok, reason: result.msg };
}
