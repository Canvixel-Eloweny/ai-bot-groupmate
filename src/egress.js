/**
 * 出口闸门 + 日志脱敏（B8 · S-EGRESS / S-LOGMASK）。
 *
 * 三件事共用**同一份特征表**，这是刻意的：
 *   · `scanEgress()`  —— 模型要发出去的内容命中凭据 / 本机路径 ⇒ 报**规则名**（绝不报原文）
 *   · `maskEgress()`  —— 出口侧就地打码：抹掉命中片段后**照发**，并自证打干净了（2026-11-03）
 *   · `maskSecrets()` —— 日志里出现的同一批凭据 → 替换成 `***`
 * 如果各写一份模式，迟早出现"闸门拦得住、日志里却明晃晃写着"这种自相矛盾的状态 ——
 * 那正是本项目反复踩过的「同一份语义的第二份拷贝」。
 *
 * ⚠️ 出口侧从"整条不发"改成"打码照发"之后，fail-closed **仍然成立**，靠的是
 *    `maskEgress()` 最后那一次自证：打完再用 `scanEgress` 扫一遍，还扫得到就判
 *    "打不干净"，调用方据此**退回整条不发**。所以"规则表被改坏"不会变成"凭据照发"
 *    —— 变的只是"认得出来且抹得干净"那一类，它本来就不该让整条消息消失。
 *
 * ⚠️ 保守优先：只认**形态明确**的东西。**不认中文词**（"密码""身份证""银行卡"）。
 *    理由：群里聊"密码"太常见，按词拦会天天误杀；一旦用户发现正常聊天被拦，
 *    他能做的只有把闸门整个关掉 —— 那比不做更糟。
 *
 * ── 规则自身出错时：**拦下**（fail-closed，第 42 轮 B12c · GUARD-LITE）──
 * 遍历规则表这件事已收敛到 `src/gate-scan.js`（唯一实现）。它在规则抛错时
 * 返回一个哨兵值 `GATE_ERROR_KIND`，本模块**原样透出**：
 * 调用方看到的是"命中了一个叫「闸门规则异常」的东西"，于是**整条不发**。
 * 这是刻意的 —— 这道闸门保护的是"凭据/本机路径不外泄到群里"，
 * 它自己坏掉时**宁可这一轮不说话**，也不能把 `sk-…` 发出去。
 * （注入口那道闸门的取向**相反**，见 `src/injection.js` 与 `src/gate-scan.js` 的对照表。）
 *
 * 因此本文件**不该**再出现"遍历规则 + try/catch"这类循环：多一份实现就是
 * 多一处会各自漂移的判据。故障注入（变异）与 `check-wb.mjs` 第 12 节一起钉住这一条。
 */

import { scanRules, kindOf, GATE_ERROR_KIND } from './gate-scan.js';

/**
 * ── 运行时凭据阻断集（第 56 轮 F1-1 · E21 的第二半）────────────────────
 *
 * **为什么需要它**：特征表只认「形态」（`sk-…` / `apiKey: …` / 私钥块）。
 * 而本机实际生效的那把 key 是**智谱格式**（`32位hex.16位hex`）——
 * 它既没有 `sk-` 前缀，也不一定紧跟在关键词后面。实测（第 56 轮，真机 config.json）：
 *
 *   · 「我刚才看了一下，是 <真实 key> 这个样子」→ 特征表**漏过去**
 *   · `maskSecrets('extra={"key":"<真实 key>"}')` → **值原样留在日志里**
 *   · 只有 `sk-` 那把（DeepSeek）被拦住
 *
 * 也就是说：**形态匹配挡不住"模型把 key 原样复述出来"这一种最坏情况**。
 * 唯一能挡住它的是**值匹配** —— 启动时把本次生效的凭据值装进来，逐条做子串比对。
 *
 * ⚠️ 三条纪律（与 §4.10「存凭据的东西靠边界管」同规）：
 *   ① **只进内存**：不落盘、不进日志、不做任何持久化；进程退出即消失。
 *      所以这里**没有** getter —— 一旦能读出来，下一个人就会拿它去写日志。
 *   ② 值本身**永远不出现在返回值/日志里**：只回报"命中"这个事实。
 *   ③ 太短的值不参与 —— 见 `RUNTIME_SECRET_MIN_LEN`（防误杀日常文本）。
 */

/**
 * 参与值匹配的最短长度（**经验值，非官方阈值**）。
 *
 * 取 12 的理由：真实凭据都在 30 字符以上（实测 35 / 49），而 12 以下的短串
 * （如 `password`、4 位数字）在日常聊天里**会自然出现**，装进来就是自造误杀。
 * 与文件头那句"保守优先"同一条原则：**宁可少拦一种形态，也不要让用户把闸门整个关掉**。
 */
export const RUNTIME_SECRET_MIN_LEN = 12;

/** 模块级阻断集。只由 `setRuntimeSecrets()` 写，只由本文件的两个判据读。 */
let runtimeSecrets = [];

/**
 * 装入本次生效的凭据值（**唯一写入口**，由 `src/index.js` 启动时调一次）。
 *
 * 幂等、可重复调用；传空数组等于清空（测试用）。
 * 空值 / 非字符串 / 短于 `RUNTIME_SECRET_MIN_LEN` 的一律丢弃 —— 它们不是凭据，
 * 装进来只会制造误杀。
 *
 * @param {Iterable<string>} values
 */
export function setRuntimeSecrets(values) {
  const seen = new Set();
  for (const v of values ?? []) {
    if (typeof v !== 'string') continue;
    const t = v.trim();
    if (t.length < RUNTIME_SECRET_MIN_LEN) continue;
    seen.add(t);
  }
  runtimeSecrets = [...seen];
}

/** 命中阻断集时用的规则名。**与特征表的名字区分开** —— 日志里一眼能看出是"值命中"。 */
export const RUNTIME_SECRET_KIND = '运行时凭据值';

/**
 * 文本里有没有本次生效的真实凭据值。
 *
 * 刻意**不用正则**：凭据值可能含 `.` / `-` / `_` 等正则元字符，
 * `split().join()` 是逐字面量比对，语义最直白也最不容易写错。
 *
 * @param {string} text
 * @returns {boolean}
 */
function hasRuntimeSecret(text) {
  for (const v of runtimeSecrets) if (text.includes(v)) return true;
  return false;
}

/* ── PEM 私钥块（2026-11-05 · 外部评估 P1）────────────────────────────────
 * 旧规则只匹配 BEGIN 标头，正文原样留在回复/日志里 —— 而私钥的危险恰恰在正文。
 * 这里用 indexOf 配对 BEGIN/END（不用跨行正则，避免回溯），一次线性扫描找出整块；
 * 未闭合但后面确实跟着 base64 正文的，按"遮到末尾"处理（fail-closed）。
 * 只出现标头、后面没有正文迹象的（正常代码示例）保持可读。
 *
 * ⚠️ 替换文本**不能**再含 `BEGIN ... PRIVATE KEY`，否则 maskEgress 的自证会永远失败。
 */
const PEM_BEGIN_RE = /-----BEGIN ([A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?)-----/g;
const PEM_MAX_SPAN = 256 * 1024;
const PEM_REPLACEMENT = '[私钥块已脱敏]';
const KEY_BODY_HINT = /^[ \t]*[A-Za-z0-9+/=]{32,}[ \t]*$/m;

function pemSpans(text) {
  const spans = [];
  if (typeof text !== 'string' || !text) return spans;
  PEM_BEGIN_RE.lastIndex = 0;
  let m;
  while ((m = PEM_BEGIN_RE.exec(text))) {
    const label = m[1];
    const endMark = `-----END ${label}-----`;
    const endAt = text.indexOf(endMark, PEM_BEGIN_RE.lastIndex);
    if (endAt !== -1 && endAt - m.index <= PEM_MAX_SPAN) {
      spans.push([m.index, endAt + endMark.length]);
      PEM_BEGIN_RE.lastIndex = endAt + endMark.length;
      continue;
    }
    if (endAt === -1) {
      const tail = text.slice(PEM_BEGIN_RE.lastIndex, PEM_BEGIN_RE.lastIndex + 4096);
      if (KEY_BODY_HINT.test(tail)) {
        spans.push([m.index, text.length]);
        break;
      }
    }
  }
  return spans;
}

/** 文本里有没有完整的（或未闭合但带正文的）PEM 私钥块。 */
export function hasPemSecret(text) {
  return pemSpans(text).length > 0;
}

/**
 * 在任何 split / 截断 / 折行之前调用：把完整 PEM 块替换成固定文案。
 * 返回新串与命中块数（只用于日志留痕，不含原文）。
 */
export function redactPemBlocks(text) {
  if (typeof text !== 'string' || !text) {
    return { text: typeof text === 'string' ? text : '', redacted: 0 };
  }
  const spans = pemSpans(text);
  if (!spans.length) return { text, redacted: 0 };
  let out = '';
  let last = 0;
  for (const [a, b] of spans) {
    out += text.slice(last, a) + PEM_REPLACEMENT;
    last = b;
  }
  out += text.slice(last);
  return { text: out, redacted: spans.length };
}

/** 凭据类：既拦出口、也从日志里抹掉。 */
const SECRET_RULES = [
  { kind: 'sk 密钥', re: /\bsk-[A-Za-z0-9_-]{16,}\b/, to: 'sk-***' },
  { kind: 'JWT', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b/, to: '[JWT已脱敏]' },
  { kind: 'Bearer 令牌', re: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/i, to: 'Bearer ***' },
  {
    kind: '键值型凭据',
    /**
     * 分隔符允许被引号包住，值是"不含引号/逗号/右花括号"的连续串。
     *
     * 这两处都不是随手写的，JSON 是凭据最常见的落脚处（日志里 `emit` 输出的
     * `extra` 就是 JSON）：
     *   · 不容忍 `"key":"value"` 里那对引号 → `"apiKey":"…"` 会**一条都匹配不到**，
     *     等于脱敏在最需要它的地方失效；
     *   · 值用 `\S{6,}` → 它会一路吃到 `","n":1}`，把后面的 JSON 结构一起吞掉，
     *     替换完就不是合法 JSON 了（排障时反而更难读）。
     */
    re: /\b(api[_-]?key|apikey|access[_-]?token|auth[_-]?token|secret|password|passwd|pwd)\b(\s*["']?\s*[:=]\s*["']?\s*)([^\s"',}]{6,})/i,
    to: '$1$2***',
  },
];

/**
 * 本机路径类：**只在出口闸门里拦**，日志里不抹。
 *
 * 为什么不抹日志：日志里出现的绝对路径绝大多数是**本项目自己的**路径
 * （`/Users/xxx/WorkBuddy/...`），抹掉之后每一次排障都先要人肉还原路径，
 * 而它根本不是秘密。日志只在高危字段（凭据）上跑脱敏 —— 见 `maskSecrets` 的注释。
 *
 * ⚠️ 2026-11-03：这两条的匹配范围从"只到下一个反斜杠/只吃掉用户名那一段"
 *    扩到**整条路径**。原因是行为从"命中就整条不发"改成了"打码后照发" ——
 *    旧范围在旧行为下无所谓（整条都没了），在新行为下会留下
 *    `[已脱敏]\x.txt` 与 `/Users/<name>/secret.json` 这种**文件名照发**的半成品，
 *    那等于把"少泄露一点"变成"泄露得更有选择性"。
 *    字符类刻意排掉中文标点（`，。！？；：、`），否则一句中文里
 *    「见 /Users/a.txt，里面有两行」会把「，里面有两行」一起吃掉。
 *    检测语义没变（同样这两条规则、同样的 `kind` 名），只是命中范围更完整。
 */
const PATH_RULES = [
  { kind: '本机绝对路径', re: /\/(?:Users|home)\/[^\s，。！？；：、]*/, to: '[本机路径已脱敏]' },
  { kind: 'Windows 绝对路径', re: /[A-Za-z]:\\Users\\[^\s，。！？；：、]*/i, to: '[本机路径已脱敏]' },
  { kind: 'SSH 私钥路径', re: /\.ssh\/id_(?:rsa|ed25519|ecdsa|dsa)/, to: '.ssh/id_***' },
];

/**
 * 给每条规则备一份带 `g` 的副本，专供 `String.replace` 用。
 *
 * 为什么不直接给规则加 `g`：带 `g` 的正则 `.test()` 是**有状态**的
 * （`lastIndex` 会留在上次命中的位置），同一个规则被连调两次会给出不同答案 ——
 * 那是这类扫描器最经典的假阴性来源。所以：`test()` 用不带 `g` 的那份（无状态），
 * `replace()` 用带 `g` 的那份。
 */
function compiled(rules) {
  return rules.map((r) => ({ ...r, g: new RegExp(r.re.source, r.re.flags.includes('g') ? r.re.flags : `${r.re.flags}g`) }));
}

const SECRETS = compiled(SECRET_RULES);
const EGRESS = [...SECRETS, ...compiled(PATH_RULES)];

/**
 * 在**第一次分段 / 折行 / 截断之前**擦除凭据（2026-11-05 · 外部评估 P1）。
 *
 * 为什么不能等 `parseReply` 分完段再扫：`hardWrap` 会把一段长文本按 300 字切开，
 * 一个 600 字的已知 Key 被切成两半后，任何"整串值匹配"都认不出来；
 * PEM 正文更是多行，分段后连 BEGIN/END 都不在同一段里。
 *
 * 只做两类：**完整 PEM 块**与**运行时已知凭据值**。其余形态（sk / JWT / 键值）
 * 留给现有的出口 `maskEgress` —— 在这里提前跑一遍会改变它"打码后自证"的输入，
 * 把 T26b 那条退路变成不可达（已有测试当场变红）。
 *
 * @returns {{text:string, rules:string[]}}
 */
export function redactCredentialsBeforeShape(text) {
  if (typeof text !== 'string' || !text) {
    return { text: typeof text === 'string' ? text : '', rules: [] };
  }
  const rules = [];
  const pem = redactPemBlocks(text);
  let s = pem.text;
  if (pem.redacted) rules.push('私钥块');
  for (const v of runtimeSecrets) {
    if (!s.includes(v)) continue;
    rules.push(RUNTIME_SECRET_KIND);
    s = s.split(v).join('***');
  }
  return { text: s, rules: [...new Set(rules)] };
}

/**
 * 要发出去的内容里有没有不该出现的东西。
 *
 * 命中就返回**规则名**（如 `'sk 密钥'`），没命中返回 `null`；
 * **规则自身抛错时返回哨兵 `GATE_ERROR_KIND`** —— 它和"命中"同义（fail-closed），
 * 但日志里能一眼看出是**闸门坏了**，而不是模型真说了什么不该说的。
 * 只回报名字不回报匹配到的原文 —— 否则"为了记日志"反而把凭据抄进了日志。
 *
 * @param {string} text
 * @returns {string|null}
 */
export function scanEgress(text) {
  // ① PEM 是**整块**判据：只看标头会把正文放过去（旧实现的真实漏洞）。
  //    这里的 `hasPemSecret` 与 `redactPemBlocks` 共用同一份配对扫描。
  if (typeof text === 'string' && hasPemSecret(text)) return '私钥块';
  // ② 再做**值匹配**（第 56 轮 · E21 第二半）：它挡的是"把真实 key 原样复述出来"，
  //    而这正是特征表唯一拦不住的那一类（实测：智谱格式的 key 一路漏过去）。
  //    放在规则之前不是为了快，而是为了让命中原因在日志里更准确 ——
  //    "运行时凭据值"比"键值型凭据"更说明问题（后者依赖关键词恰好出现在旁边）。
  //
  // ⚠️ **必须是 `typeof text === 'string'`，不许写 `String(text ?? '')`**：
  //    T80 用了一个 `toString()` 会抛错的坏输入来验证"两个闸门都不穿透"。
  //    写成 `String(...)` 等于把这次强转**挪到了受保护的 `scanRules` 之前** ——
  //    坏输入在这儿就抛出去了，根本轮不到哨兵接管，**fail-closed 被绕过**。
  //    （这不是假设：第一版就是这么写的，T80 当场变红 —— 那是已有的断言在替我兜底。）
  if (typeof text === 'string' && hasRuntimeSecret(text)) return RUNTIME_SECRET_KIND;
  // ③ 再走特征表。**注意不能短路掉它** —— 阻断集只覆盖"本次生效的那几把"，
  //    日志里/群里出现的别人家的 key、本机路径都只有特征表认得出。
  return kindOf(scanRules(EGRESS, text));
}

/**
 * 日志脱敏：把**凭据类**特征替换成 `***`。本机路径不动（理由见 PATH_RULES）。
 *
 * 纯函数，返回新串。只在高危字段上跑 —— 目前唯一接线点是 `logger.js` 的 `emit()`，
 * 也就是"写进日志之前"那一步。
 *
 * @param {string} text
 * @returns {string}
 */
export function maskSecrets(text) {
  let s = String(text ?? '');
  if (!s) return s;
  // 整块 PEM 先抹：只抹标头的话，正文会原样落进日志。
  s = redactPemBlocks(s).text;
  // 值匹配再跑：特征表对"智谱格式的 key"一个字都认不出（实测），
  // 而它一旦原样落进日志，那条日志本身就是一次泄漏。
  for (const v of runtimeSecrets) s = s.split(v).join('***');
  for (const r of SECRETS) s = s.replace(r.g, r.to);
  // 调用方若把 PEM 正文拆成独立的 base64 行再逐行记录，上面的配对就看不到了。
  // 日志侧保守地把"整行都是长 base64"的内容打码（宁可多抹，也不漏正文）。
  s = s.replace(/^[ \t]*[A-Za-z0-9+/=]{64,}[ \t]*$/gm, '[疑似密钥正文已脱敏]');
  return s;
}

/** 对对象/数组的每个字符串做 `maskSecrets`（trace / dryrun 这类整条记录落盘用）。 */
export function maskSecretsDeep(value, depth = 0) {
  if (typeof value === 'string') return maskSecrets(value);
  if (Array.isArray(value)) return value.map((x) => maskSecretsDeep(x, depth + 1));
  if (value && typeof value === 'object' && depth < 8) {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = maskSecretsDeep(v, depth + 1);
    return out;
  }
  return value;
}

/**
 * 出口侧的就地打码（2026-11-03 · 维护者批准把"整条不发"改成"打码后照发"）。
 *
 * ── 它补的是哪个洞 ──
 * 安全目标从来是**"不泄露匹配到的那一段"**，不是**"不开口"**。旧行为把这两件事绑在一起：
 * 一句回复里带一个 API Key 或一段本机绝对路径 ⇒ **整条丢弃**，群里一个字都没有，
 * 也没有任何解释 ⇒ 用户视角是"她突然不理我"（主动发言场景里就是"该说话时一声不吭"）。
 * 一句话里带个路径就让整段消失，代价落在用户身上，而收益只有"少泄露那 20 个字符"。
 *
 * ── 为什么这道改法仍然算 fail-closed ──
 * 关键在最后那一次**自证**：打完码之后，用**同一道 `scanEgress`** 再扫一遍打码结果。
 *   · 扫干净了 ⇒ `trusted: true`，调用方照发；
 *   · 还扫得到东西 ⇒ 说明这次打码**没打全**（规则表被改坏、或某条规则的替换文本
 *     自己还留着锚点，上面 Windows 那条就是实例），`trusted: false` ⇒ 调用方整条不发。
 * 所以"闸门坏了"这一支**没有变成放行**，只是从"命中就沉默"变成"打不干净才沉默"。
 * 这条自证同时兜住了 `GATE_ERROR_KIND`：哨兵不是 `null`，一律落进 `trusted: false`。
 *
 * ⚠️ 与 `scanEgress` 同一条纪律：**不许**对入参做无守卫的 `String(...)`。
 *    T80 递的是一个 `toString()` 会抛的坏对象，它必须走到哨兵那一侧，
 *    而不是在这里把异常抛穿出去（那等于绕过 fail-closed）。
 *
 * @param {string} text 要发出去的那一段
 * @returns {{text:string, rules:string[], trusted:boolean}}
 *   `rules` 命中的**规则名**（绝不含匹配到的原文 —— 记日志不该顺手把凭据抄进日志）。
 */
export function maskEgress(text) {
  if (typeof text !== 'string') {
    // 不是字符串：无从打码，按"不可信"交回调用方（调用方据此整条不发）。
    return { text: '', rules: [GATE_ERROR_KIND], trusted: false };
  }
  const rules = [];
  // ① 整块 PEM：必须在任何后续打码/分段之前换成固定文案。
  const pem = redactPemBlocks(text);
  let s = pem.text;
  if (pem.redacted) rules.push('私钥块');
  // ② 值匹配：本次生效的真实凭据（特征表认不出智谱格式，实测过）。
  for (const v of runtimeSecrets) {
    if (!s.includes(v)) continue;
    rules.push(RUNTIME_SECRET_KIND);
    s = s.split(v).join('***');
  }
  // ③ 特征表：凭据类 + 本机路径类**都打**（日志侧只打凭据，出口侧连路径一起打 ——
  //    路径是这次"整条消失"最常见的触发原因，留着它就等于没修）。
  for (const r of EGRESS) {
    if (!r.re.test(s)) continue;
    rules.push(r.kind);
    s = s.replace(r.g, r.to);
  }
  // ④ 自证：打完再扫一遍。还命中 = 没打干净 = 不照发。
  const left = scanEgress(s);
  return { text: s, rules: [...new Set(rules)], trusted: left === null };
}
