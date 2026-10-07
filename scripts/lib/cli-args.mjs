/**
 * `node xxx.js` 之后的 argv 拆成「选项」与「数据」两段（2026-10-05 · 第 10 轮 · H-04）
 * ══════════════════════════════════════════════════════════════════════════
 *  这个模块只回答一个问题：**哪些是开关，哪些是正文**。
 *
 * ── 为什么需要它 ─────────────────────────────────────────────────────────
 *  `scripts/dryrun.js` 收一个"要试的句子"。原来它用
 *  `argv.filter(a => a !== '--json' && a !== '--tools')` 取正文 —— 于是
 *  **以 `-` 开头的句子会被当成新选项**（`node scripts/dryrun.js "-这句话"`）。
 *  面板那条路更早：`panel/server.js` 把用户输入的 text 直接追加进参数数组，
 *  连一个分隔符都没有。
 *
 *  这类"数据与选项混在一条 argv 里"的缺陷属**参数注入**：不是命令注入
 *  （`panel/lib/proc.js` 用的是 `execFile` + 数组传参，没有 shell），
 *  但足以让"用户输入的一句话"变成"给这个脚本的一个选项"。
 *  标准解法是 POSIX 的 `--` 分隔符：**它之后一律是数据**。
 *
 * ── 为什么单独一个可 import 的叶子 ───────────────────────────────────────
 *  判据不能写成"源码里有没有 `indexOf('--')`" —— 本项目第 53 条陷阱就是
 *  **"判据别写死 argv 长什么样"**（一个 `--max-old-space-size=384` 曾让两处
 *  argv 判据同时失效，而四层回归全绿）。
 *  抽成零依赖叶子之后，`test/smoke.js` 能直接 import 它跑真值表 ——
 *  于是护栏管的是**行为**（`-` 开头的句子到底有没有被当成正文），不是形状。
 *
 * ── 语义（与改造前**逐字兼容**，只多了一条 `--` 规则）─────────────────────
 *  选项：永远只从 `--` **之前**的那一段里认（`knownFlags` 中的才算）。
 *  正文：`--` 之前的非开关参数 **加上** `--` 之后的一切。
 *
 *  ⚠️ "之前的非开关参数"这一半不能省：否则 `node x.js 甲 -- 乙` 会把「甲」**静默丢掉**
 *     —— 那是比"参数注入"更坏的失效形态（用户输入凭空消失，而没有任何东西报错）。
 *     这是 `test/smoke.js` 的 T378 真值表当场抓出来的：那一格本来写的就是
 *     `[10, '--', null]`，第一版实现只还回了 `null`。
 *
 *  没有 `--` 时：行为与改造前逐字相同（`knownFlags` 里的算选项、其余全算正文，
 *  **包括"未知的 `-x` 仍然被当成正文"这个历史上的宽容行为** —— 收紧它属于
 *  另一个改动，不在本轮范围内）。
 *  多个 `--`：取**第一个**，它之后的都算数据（与 POSIX 一致）。
 *
 * @param {unknown} argv 通常是 `process.argv.slice(2)`
 * @param {string[]} [knownFlags] 这个脚本认识的开关
 * @returns {{flags: string[], words: string[], sep: boolean}} `sep` = 出现过 `--`
 */
export function splitCliArgs(argv, knownFlags = []) {
  const a = (Array.isArray(argv) ? argv : []).map((x) => String(x));
  const known = (Array.isArray(knownFlags) ? knownFlags : []).map((x) => String(x));
  const i = a.indexOf('--');
  const head = i >= 0 ? a.slice(0, i) : a;
  return {
    flags: head.filter((x) => known.includes(x)),
    // `--` 之前的非开关参数 + `--` 之后的一切（后者哪怕以 `-` 开头也算正文）
    words: head.filter((x) => !known.includes(x)).concat(i >= 0 ? a.slice(i + 1) : []),
    sep: i >= 0,
  };
}
