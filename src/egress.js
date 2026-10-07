/**
 * 出口闸门 + 日志脱敏（B8 · S-EGRESS / S-LOGMASK）。
 *
 * 两件事共用**同一份特征表**，这是刻意的：
 *   · `scanEgress()`  —— 模型要发出去的内容命中凭据 / 本机路径 → **整条不发** + 告警
 *   · `maskSecrets()` —— 日志里出现的同一批凭据 → 替换成 `***`
 * 如果各写一份模式，迟早出现"闸门拦得住、日志里却明晃晃写着"这种自相矛盾的状态 ——
 * 那正是本项目反复踩过的「同一份语义的第二份拷贝」。
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

import { scanRules, kindOf } from './gate-scan.js';

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

/** 凭据类：既拦出口、也从日志里抹掉。 */
const SECRET_RULES = [
  { kind: '私钥块', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, to: '-----BEGIN *** PRIVATE KEY-----' },
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
 */
const PATH_RULES = [
  { kind: '本机绝对路径', re: /(\/(?:Users|home)\/)[A-Za-z0-9._-]+/, to: '$1***' },
  { kind: 'Windows 绝对路径', re: /([A-Za-z]:\\Users\\)[^\\\s]+/i, to: '$1***' },
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
  // ① 先做**值匹配**（第 56 轮 · E21 第二半）：它挡的是"把真实 key 原样复述出来"，
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
  // ② 再走特征表。**注意不能短路掉它** —— 阻断集只覆盖"本次生效的那几把"，
  //    日志里/群里出现的别人家的 key、私钥块、本机路径都只有特征表认得出。
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
  // 值匹配先跑：特征表对"智谱格式的 key"一个字都认不出（实测），
  // 而它一旦原样落进日志，那条日志本身就是一次泄漏。
  for (const v of runtimeSecrets) s = s.split(v).join('***');
  for (const r of SECRETS) s = s.replace(r.g, r.to);
  return s;
}
