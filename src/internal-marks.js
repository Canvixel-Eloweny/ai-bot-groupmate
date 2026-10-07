/**
 * 内部标记（internal marks）的**唯一形态定义**（B33 · 防「模型复读内部状态」外泄）。
 *
 * ══════════════════════════════════════════════════════════════════════
 *  它防的是哪一件事（真机实测，不是推测）
 * ══════════════════════════════════════════════════════════════════════
 *  `index.js` 在「模型选择潜水 / 被出口闸门拦下 / 发送前复核拦下 / 判为重复」
 *  这四种情况下，会往**会话历史里以 assistant 角色**写一句内部标记。而历史是
 *  **逐字喂给模型**的 —— 于是那句标记在模型眼里成了「我这轮说过的话」，
 *  下一轮它照着写了出来：
 *
 *    2026-10-04 10:27:03 · traceId 30253c4c23bc · 群 100000003（真机白名单群之一）
 *      raw    = `[这次没有接话]`      ← 模型原样输出
 *      chunks = `['[这次没有接话]']`  ← parseReply 放行 → 真发进群
 *      （再叠上 `atSegment`，群里看到的是 `@某某 [这次没有接话]`）
 *
 *  `brain.parseReply()` 只认 `[SILENT]` 一个控制符，于是这句话被当成**正常回复**
 *  放行了。这与 D9b 早就为「拍一拍」定过的规矩是同一个坑的另一半 ——
 *  「标记该事件不进历史，**防模型复读**」。
 *
 * ══════════════════════════════════════════════════════════════════════
 *  四条纪律
 * ══════════════════════════════════════════════════════════════════════
 *  ① **一句话只有一个出处**：四句文案住在本文件，`index.js` 只许 import。
 *     各写两份的话，改了文案忘了改词干 = 闸门**静默失效**（判据认的是词干，
 *     见 ②）——这正是本项目反复踩过的「同一份语义的第二份拷贝」。
 *
 *  ② **判据认词干，不认外壳**：模型可能不带括号、或换成全角括号复读；
 *     而**历史里还躺着改文案之前写进去的旧句子**（会话历史是持久化的，
 *     见 `panel/session-archive.json`）。所以新旧两代的独特词干**都**要认
 *     （`DEFS[].legacyCore`），外壳换什么样都拦得住。
 *
 *  ③ **两级判据：壳内宽、裸的窄**。带括号时只要壳里有宽词干就整段摘；
 *     不带括号时要**连指代一起**（`本轮没有接话` / `这次没有接话`）才算 ——
 *     因为宽词干 `没有接话` 是唯一可能出现在**正常中文**里的那条
 *     （「这事没有接话的必要」）。判宽了会把它正常的一句话咬掉半截，
 *     而判宽导致的误杀，用户看到的正是「它突然说了半句话」。
 *     剩下的兜底：整条**恰好等于**某个宽词干时照样算标记（见 `bareCoreOnly`）。
 *
 *  ④ **剥掉不留残句**：摘的是**成对外壳连同内容**，不是只抠掉词干 ——
 *     否则会留下 `[这条被…，]` 这种半截话照样发出去（比不拦更糟：看起来修过了）。
 *
 * ⚠️ 零依赖叶子：不 import 任何东西，smoke 直接喂反例。
 */

/** 标记的外壳。全角括号 + 「系统标记：」前缀，形态上就和「群友说的话」分得开。 */
const FRAME = (body) => `（系统标记：${body}）`;

/**
 * 四句标记的**定义表**。
 *
 *   · `core`       —— 现行文案里的独特词干（判据认它）
 *   · `body`       —— 现行那句（给人看的）
 *   · `legacy`     —— **改文案之前**写进历史的旧句子（会话历史是持久的，必须继续认）
 *   · `legacyCore` —— 旧句子里、现行文案里**没有**的那个词干（有才写）
 *
 * 三者的关系由 `markRegistryProblems()` 自证 —— 被 smoke 与 `check-wb` 一起消费：
 * 「改文案忘改词干」是这里最容易发生的漂移，而它的后果是**闸门静默失效**。
 */
const DEFS = {
  /** 模型自己选择不接话（`index.js` 的 silent 分支）。 */
  SILENT: {
    core: '没有接话',
    body: '本轮没有接话',
    legacy: '这次没有接话',
  },
  /** 出口闸门整条拦下（命中凭据 / 本机绝对路径）。 */
  EGRESS: {
    core: '出口闸门拦下',
    body: '这条被出口闸门拦下，没有发出',
    legacy: '这条被出口闸门拦下了，没有发出去',
  },
  /** 发送前复核不通过（判定通过之后、真发出去之前许可被改了）。 */
  LATE: {
    core: '发送前复核不通过',
    body: '发送前复核不通过，没有发出',
    legacy: '本轮在发送前被拦下：会话许可已变化，没有发出',
    legacyCore: '发送前被拦下',
  },
  /** 发送闸判为重复，一条都没发。 */
  DUP: {
    core: '与之前说过的几乎重复',
    body: '与之前说过的几乎重复，没有发出',
    legacy: '这条和之前说过的几乎一样，没有重复发出去',
    legacyCore: '和之前说过的几乎一样',
  },
};

/**
 * 四句标记的**唯一出处**：`index.js` 的四处 `remember()` 全从这儿取。
 * 键名即用途，别再在别处拼一遍文案。
 */
export const INTERNAL_MARKS = Object.freeze(
  Object.fromEntries(Object.entries(DEFS).map(([k, d]) => [k, FRAME(d.body)]))
);

/**
 * 壳内判据认的词干（新旧两代都在里面）。
 * ⚠️ 顺序即摘除顺序 —— 由自证钉住「互不为子串」，所以顺序不影响结果。
 */
export const MARK_CORES = Object.freeze(
  Object.values(DEFS).flatMap((d) => [d.core, d.legacyCore].filter(Boolean))
);

/**
 * 裸判据：**不带括号**时必须按完整说法删（判据 ③）。
 * 取的是现行与旧的那两句正文本身 —— 它们都含指代（`本轮` / `这次` / `这条`），
 * 正常中文里不会整句出现。
 */
export const BARE_FORMS = Object.freeze(
  Object.values(DEFS).flatMap((d) => [d.body, d.legacy])
);

/** 外壳的左右半边。四种括号都算 —— 模型复读时未必用哪一种。 */
const OPEN = '[【(（';
const CLOSE = ']】)）';

/**
 * 外壳与词干之间允许的最大距离（字符）。
 * 超过就当「那对括号跟这个词干无关」，不拆括号 ——
 * 否则一句长话里恰好撞上同一个词干时，会被连壳一起吃掉。
 * **经验值**：四句标记的壳内正文最长 16 字。
 */
const WRAP_WINDOW = 40;

/** 从 `i` 往左找回一个**孤立的**左括号；中间先撞到右括号或换行 = 不配成一对。 */
function openBefore(s, i) {
  for (let j = i - 1; j >= 0 && i - j <= WRAP_WINDOW; j -= 1) {
    const c = s[j];
    if (c === '\n' || CLOSE.includes(c)) return -1;
    if (OPEN.includes(c)) return j;
  }
  return -1;
}

/** 从 `i` 往右找第一个**孤立的**右括号；同上。 */
function closeAfter(s, i) {
  for (let j = i; j < s.length && j - i <= WRAP_WINDOW; j += 1) {
    const c = s[j];
    if (c === '\n' || OPEN.includes(c)) return -1;
    if (CLOSE.includes(c)) return j;
  }
  return -1;
}

/** 去掉一切空白与标点后，剩下的**恰好**是一个宽词干吗（裸复读的兜底形态）。 */
function bareCoreOnly(s) {
  const t = String(s ?? '').replace(/[\s，。、；：!！?？~～\-—·\[\]【】()（）]/g, '');
  return MARK_CORES.includes(t);
}

/** 句子摘掉一块之后的样子：清空外壳、收空白、去掉摘完裸露在首尾的标点。 */
function tidy(s) {
  let t = String(s ?? '');
  // 只摘了内层时可能留下空壳（`[（…）]` → `[]`）
  t = t.replace(/\[\s*\]|【\s*】|\(\s*\)|（\s*）/g, '');
  t = t.replace(/[ \t]{2,}/g, ' ').trim();
  // 摘完以标点开头的，那个标点是摘剩下的尾巴，不是它想说的话
  t = t.replace(/^[，。、；：!！?？~～]+/, '').trim();
  // 整句只剩标点 → 等于没说话（判空，别把「，」发出去）
  return /^[\s，。、；：!！?？~～\-—·]*$/.test(t) ? '' : t;
}

/**
 * 摘掉**成对外壳连同内容**（判据 ③ 的"壳内宽"那一半）。
 *
 * 只摘"壳里没有嵌套括号"的那些 —— 嵌着说明那对括号不是包着这个词干的
 * （`（系统标记：…）` 里的 `：` 之后的正文本身不含括号，所以正常情况必定可摘）。
 */
function cutWrapped(s) {
  // 找**最早**出现的那个词干：摘除位置只由它在原文里的位置决定，
  // 与 `MARK_CORES` 的声明顺序无关（顺序无关性另有 `markRegistryProblems()` 钉着）。
  let best = -1;
  let bestLen = 0;
  for (const core of MARK_CORES) {
    const at = s.indexOf(core);
    if (at >= 0 && (best < 0 || at < best)) {
      best = at;
      bestLen = core.length;
    }
  }
  if (best < 0) return s;
  const open = openBefore(s, best);
  const close = closeAfter(s, best + bestLen);
  const inner = open >= 0 && close >= 0 ? s.slice(open + 1, close) : '';
  const wrapped = open >= 0 && close >= 0 && !/[\[\]【】()（）]/.test(inner);
  // 有壳 → 连壳带内容整段摘掉，从头再扫（摘完可能又并成一对新壳）
  if (wrapped) return cutWrapped(s.slice(0, open) + s.slice(close + 1));
  // 没壳 → 这一处原样留着（交给裸判据），继续扫它后面的部分
  return s.slice(0, best + bestLen) + cutWrapped(s.slice(best + bestLen));
}

/**
 * 文本里命中了哪几个内部标记的词干（按定义表顺序，去重）。
 *
 * ⚠️ 只回答「有没有」这一个问题 —— 「要不要拦」是调用方的事：
 * 主链路（`brain.parseReply`）选择**剥掉标记、其余照发**；整条不发只留给凭据那一类。
 *
 * @param {string} text
 * @returns {string[]} 命中的词干（空数组 = 干净）
 */
export function scanInternalMarks(text) {
  const s = String(text ?? '');
  return MARK_CORES.filter((core) => s.includes(core));
}

/**
 * 把内部标记摘掉，返回**可以发出去**的那部分。
 *
 * 剥完可能是空串 —— 那就是「它这一轮其实没话说」（实测就是这样：模型整条只输出了
 * 那句标记）。空串由调用方当「这一段不发」处理，**不要**在这里补一句兜底文案。
 *
 * @param {string} text
 * @returns {string}
 */
export function stripInternalMarks(text) {
  let s = String(text ?? '');
  if (bareCoreOnly(s)) return '';
  s = cutWrapped(s);
  for (const form of BARE_FORMS) s = s.split(form).join('');
  return tidy(s);
}

/**
 * 这一整条**就是**一句内部标记吗（剥完什么都不剩）。
 *
 * 与 `stripInternalMarks()` 分开是因为语义不同：前者答「这条该不该整段丢」，
 * 后者答「这条剥完还剩什么」。混成一个就会出现「剥完剩半句，却被整段丢掉」。
 *
 * @param {string} text
 * @returns {boolean}
 */
export function isInternalMark(text) {
  const s = String(text ?? '').trim();
  if (!s) return false;
  return scanInternalMarks(s).length > 0 && stripInternalMarks(s) === '';
}

/**
 * 定义表自证（**纯函数**，返回问题清单；空数组 = 一致）。
 *
 * 四条不变式，任何一条破了都意味着「防御静默失效」：
 *   ① `body` 必须含 `core` —— 否则改了文案就会漏拦（判据找的是词干）；
 *   ② 每句**标记成品**必须能被剥成空串 —— 否则会留下半截括号话照样发进群；
 *   ③ 现行与旧文案（`body` / `legacy`）**脱掉外壳后**也必须能被剥成空串 ——
 *      模型不带括号复读时走的就是这条判据；
 *   ④ 词干互不为子串、且互不重复 —— 否则摘除顺序会影响结果，
 *      「一句话的判据依赖遍历顺序」是查不出来的那类漂移。
 *
 * ⚠️ 消费方是 smoke（行为）与 `check-wb`（静态），**不在运行时调用** ——
 *    它是开发期的不变式，不是热路径上的判据。
 *
 * @returns {string[]}
 */
export function markRegistryProblems() {
  const problems = [];
  for (const [key, d] of Object.entries(DEFS)) {
    if (!d.body.includes(d.core)) {
      problems.push(`${key}: 文案里找不到词干「${d.core}」—— 改了文案没改词干，闸门会静默失效`);
    }
    if (d.legacyCore && !d.legacy.includes(d.legacyCore)) {
      problems.push(`${key}: 旧文案里找不到 legacyCore「${d.legacyCore}」—— 历史里那批旧句子会漏拦`);
    }
  }
  for (const [key, mark] of Object.entries(INTERNAL_MARKS)) {
    if (scanInternalMarks(mark).length < 1) problems.push(`${key}: 标记成品扫不出任何词干 —— 它自己都不被闸门认`);
    if (stripInternalMarks(mark) !== '') {
      problems.push(`${key}: 标记成品剥不干净（剩「${stripInternalMarks(mark)}」）—— 会留下半截话发进群`);
    }
  }
  for (const form of BARE_FORMS) {
    if (stripInternalMarks(form) !== '') {
      problems.push(`裸正文「${form}」剥不干净（剩「${stripInternalMarks(form)}」）—— 不带括号复读时会漏拦`);
    }
  }
  for (const a of MARK_CORES) {
    for (const b of MARK_CORES) {
      if (a === b) continue;
      if (a.includes(b)) problems.push(`词干「${b}」是「${a}」的子串 —— 摘除顺序会改变结果`);
    }
  }
  if (new Set(MARK_CORES).size !== MARK_CORES.length) problems.push('词干有重复');
  return problems;
}
