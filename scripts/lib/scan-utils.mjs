/**
 * 契约扫描器的**纯文本工具**（M-2 首切口 · 2026-10-04）。
 * ══════════════════════════════════════════════════════════════════════════
 *  这 7 个函数原本住在 `scripts/check-wb.mjs` 里（12,135 行）。它们**与任何契约无关** ——
 *  输入是字符串、输出是字符串或数，没有 IO、没有状态，是这个文件里唯一能"整块搬走而不
 *  改变任何断言"的部分。搬出来有两个实在的好处：
 *
 *   ① **重复的代价是刚发生过的**：该文件里 `fnBody` 曾被**逐字复制 6 份**，
 *      而给 `decide()` 加一个可选参数时，我只改了 2 处、漏了 6 处 —— 判据当场失效。
 *      现在抽取逻辑只有这一份。
 *   ② 新写的扫描器（或临时脚本）可以直接 import，不必再抄一遍正则。
 *
 *  ⚠️ 搬的时候**一字未改**（只加了 `export`）—— 语义等价是这次搬运成立的全部理由，
 *     所以不要在这里"顺手优化"。改动它等于同时改几十条判据的输入。
 */

/**
 * 扫源码之前**必须先剥注释**。
 *
 * 本项目已经两次踩到同一件事：注释里原样引用了旧写法（`href="#i-xxx"`、
 * `data-mirror="allowProactive"`、`if (!wbCustom) return;`），扫描器把它当成真实
 * 代码 —— 于是要么误报、要么更糟：**给出一个虚假的"全部通过"**。
 * 注释里的东西不是契约，扫之前一律去掉。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ⚠️⚠️ **第 8 轮（2026-10-05 · 开源前审查）· js 侧改成"字符串感知"** —— 这条改动
 *     一次移动了几十条判据的输入，所以它单独占一轮（第 7 轮交接件「第 8 轮」）。
 * ══════════════════════════════════════════════════════════════════════════
 * 旧实现是三条正则，**它不认字符串**：`/\/\*[\s\S]*?\*\//g` 只要在源码里看到
 * "斜杠 + 星号"就当成**块注释起点** —— 哪怕那两个字符正住在一个字符串里。
 *
 * ⚠️ **本注释自己就踩过这条坑**（2026-10-05 当场）：第一版把两处"斜杠 + 星号"
 *    按字面抄进了注释（一处是 schema.js 那条通配路径原文、一处是正则字符类的例子），
 *    于是**这个文件自己**开了一个洞、`import` 当场 `SyntaxError`。
 *    想描述这个形状就**用文字绕着写**（"`people/` 紧跟一个星号"），别抄字面量 ——
 *    与 §11 记的"源码注释里不许出现斜杠紧跟两个星号"是同一条。
 *
 * 实测到的真实伤害（不是假想）：
 *   · `panel/next/schema.js` 的 `desc` 里写着一条通配路径（`data/memory/people/`
 *     紧跟一个星号）。那个星号被当成块注释起点，一路吃到下一个收口 ——
 *     **实测吞掉 5865 字符**：`t: 'people'` 与 `t: 'importFile'` 两张卡整块消失。
 *     后果是 §69「三处同集合」判据**误报两个"死渲染器"**，
 *     而 §3h / smoke T76 只能**绕行取原文**才活得下来。
 *   · 注释里写出同样的序列（本项目第 24 / 41 条坑）—— 也是同一个成因。
 *
 * 新实现：逐字符扫描 + **显式模式栈**（`code / expr / sq / dq / tpl`），
 *   · 单引号串 / 双引号串 / 模板字面量**内部一律不当注释看**；模板里的 `${…}`
 *     回到"代码"模式（所以插值里的真注释照剥，与旧行为一致），
 *     栈式处理是因为插值里还会再嵌模板 / 字符串 —— 一维状态机在这里会失步
 *     （本项目第 13 条坑记的就是这个：实测 134 个声明只认出 45 个，而输出仍打印"无循环"）。
 *   · **整行 `//` 注释**的剥离口径与旧实现**逐字一致**（只剥"行首到此处全是空白"
 *     的那一种；行尾 `//` 归 `stripTrailingComments`，别在这里顺手加）。
 *   · 给"剥块注释"补了**收口守卫**：找不到收口标记就**不剥**（把那两个字符当普通文本）。
 *     旧正则天然如此（它要求配到收口才成一段）；一维状态机版本会**一路吃到文件尾** ——
 *     那正是同一类"静默吞掉半页"的伤害，所以守卫必须显式写出来。
 *
 * ⚠️ 非 js 取源（`kind: 'html'` / `'sh'`）**保持旧的正则行为**，理由：
 *    HTML 里的引号是属性引号，散文里还有 `it's` 这种撇号 —— js 扫描器会把它们
 *    当字符串起点，跨过 `<!-- … -->` 收口，反而**漏剥**。HTML / shell 的注释语法
 *    本来就与 JS 不同（`<!-- -->` / `#`），本轮只针对 JS，别顺手一起换。
 *    ⚠️ **`sh` 的`#` 行注释是第 21 轮补的**（此前 `kind: 'sh'` 只剥块注释与双斜杠注释，
 *    剥不掉 shell 自己的注释）—— 起因是 §86 判`pre-commit.sh` 时被自家注释误伤：
 *    注释里写一句「为什么不用 `git archive`」就被判成「用了 git archive」⇒ 假红。
 *    这正是本项目那条老教训的又一形态：**判据必须看代码，不能看注释里提到过什么**。
 * ⚠️ **已知识别的盲区**（写明，别假装它是硬闸）：正则字面量里出现"斜杠 + 星号"相邻
 *    （形如字符类里斜杠与星号挨着写）**仍**会被当成块注释起点 —— 与旧实现同形。
 *    要闭合得解析 AST，与收益不成比例。本项目正是把这类盲区写下来、而不是假装它不存在。
 */
export function stripComments(src, kind = 'js') {
  if (kind !== 'js') return stripCommentsByRegex(src, kind);
  return stripJsComments(src);
}

/** 旧的纯正则剥注释 —— **只留给非 js 取源**（HTML / shell，理由见上）。 */
function stripCommentsByRegex(src, kind) {
  let s = src.replace(/\/\*[\s\S]*?\*\//g, '');        // /* 块注释 */
  s = s.replace(/^[ \t]*\/\/.*$/gm, '');               // 整行 // 注释（不会碰到 URL 里的 //）
  if (kind === 'html') s = s.replace(/<!--[\s\S]*?-->/g, ''); // HTML 注释
  // ⚠️ shell 的行注释 `#`：**只在行首（可带空白）或 shebang 之后**才当注释。
  //    条件写成 `(^|\n)[ \t]*#` 而不是 `\n#`，是为了连**整份文件第一行**的
  //    `#!/bin/bash` 也剥掉（`^` 分支）。而**行中间的 `#` 一律保留** ——
  //    `${var#prefix}`、`echo "a#b"` 都是真代码，剥掉就是改语义。
  //    ⚠️ 已知盲区（与上面同性质，写明不假装）：`echo '# 文字'` 这种
  //    **引号内的 #** 仍会被剥 —— shell 的引号语义要真解析才做得对，
  //    本项目的判据不靠引号里的内容，故按可接受的取舍处理。
  if (kind === 'sh') s = s.replace(/(^|\n)[ \t]*#.*$/gm, '$1');
  return s;
}

/** js 侧的字符串感知扫描器。模式栈：code（代码）· expr（模板插值）· sq / dq / tpl（三种字面量）。 */
function stripJsComments(src) {
  const n = src.length;
  let out = '';
  let i = 0;
  const modes = ['code'];
  const depths = [0]; // 仅 expr 帧用：本层还没闭合的 `{` 个数（嵌套对象字面量的收口靠它）
  const opens = [null]; // 仅 sq / dq 帧用：{ outLen, idx, ch } —— 行内回退要用（见下）
  const lineStartOf = () => out.lastIndexOf('\n') + 1;
  while (i < n) {
    const top = modes.length - 1;
    const mode = modes[top];
    const c = src[i];

    if (mode === 'sq' || mode === 'dq') {
      // 单/双引号串：JS 里它们**不许跨行**（续行必须带反斜杠，下一行就处理）
      if (c === '\\') { out += src.slice(i, i + 2); i += 2; continue; }
      if (c === '\n') {
        // ⚠️ **第三个守卫（第 8 轮）**：走了整行还没闭合 ⇒ 这个开点是**假的**。
        //    最常见的成因是**正则字面量里的那个引号**（`/^'/`、`/'/`）：本实现不解析
        //    正则字面量（已知识别的盲区），于是把引号当成字符串起点。假串本身不致命 ——
        //    致命的是它**吞掉本行后面的闭合反引号**，把模板帧多留一层，从此整份源码的
        //    模式栈整体错位（实测 `check-wb.mjs` 第 8777 行：`/^'/` 让 `''` 的奇偶反了，
        //    一路错到 §56，**剥后源码无法解析**）。
        //    ⇒ 回退：把开点当普通文本，父模式重扫这一行。回退后的模式栈最多错一层，
        //      而这一层会在本行结束前被同一个判据再纠一次 —— 不再累积。
        const o = opens[top];
        out = out.slice(0, o.outLen) + o.ch;
        i = o.idx + 1;
        modes.pop(); depths.pop(); opens.pop();
        continue;
      }
      if ((mode === 'sq' && c === "'") || (mode === 'dq' && c === '"')) {
        modes.pop(); depths.pop(); opens.pop(); out += c; i += 1; continue;
      }
      out += c; i += 1; continue;
    }

    if (mode === 'tpl') {
      if (c === '\\') { out += src.slice(i, i + 2); i += 2; continue; }
      if (c === '`') { modes.pop(); depths.pop(); opens.pop(); out += c; i += 1; continue; }
      if (c === '$' && src[i + 1] === '{') { modes.push('expr'); depths.push(0); opens.push(null); out += '${'; i += 2; continue; }
      out += c; i += 1; continue; // 模板里的文字段整段照抄（注释记号在这里**不是**注释）
    }

    // code / expr
    if (c === "'" || c === '"') {
      modes.push(c === "'" ? 'sq' : 'dq'); depths.push(0);
      opens.push({ outLen: out.length, idx: i, ch: c });
      out += c; i += 1; continue;
    }
    if (c === '`') { modes.push('tpl'); depths.push(0); opens.push(null); out += c; i += 1; continue; }
    if (mode === 'expr') {
      if (c === '{') { depths[top] += 1; out += c; i += 1; continue; }
      if (c === '}') {
        if (depths[top] > 0) { depths[top] -= 1; out += c; i += 1; continue; }
        modes.pop(); depths.pop(); opens.pop(); out += c; i += 1; continue; // 插值的收口 → 回模板
      }
    }
    if (c === '/' && src[i + 1] === '*') {
      const e = src.indexOf('*/', i + 2);
      if (e < 0) { out += c; i += 1; continue; }   // 守卫：没有收口就不剥
      i = e + 2; continue;                         // 整块丢掉（含首尾标记）
    }
    if (c === '/' && src[i + 1] === '/') {
      // 从这里到行尾是**注释区**，两件事分开办：
      //   · **整行**注释（本行至今没有任何非空白输出）→ 照旧删掉（口径与旧实现逐字一致）；
      //   · **行尾**注释 → 文字**保留**（`stripTrailingComments` 才是剥它的地方），
      //     但**不解释它内部的东西** —— 引号 / 反引号 / 注释记号一律当死文本。
      // ⚠️ 后半句是第 8 轮补的**第二个守卫**，它和字符串感知是同一件事的两半：
      //    行尾注释里写一句 `` 见 `src/xxx.js` ``（markdown 式行内代码）会**开出一个
      //    模板字面量**，把后面几十行当成模板正文 —— 实测 `check-wb.mjs` 第 1169 行的
      //    行尾注释就是这个形状，一路错到 §56，**剥后源码整个无法解析**。
      //    而它平时看不出来：`check-wb` 只拿剥后文本做正则匹配，从不重新解析它。
      const ls = lineStartOf();
      const nl = src.indexOf('\n', i);
      const end = nl < 0 ? n : nl;
      if (!/[^\t \r\n]/.test(out.slice(ls))) { out = out.slice(0, ls); i = end; continue; }
      out += src.slice(i, end); i = end; continue;
    }
    out += c; i += 1;
  }
  return out;
}
/**
 * 再剥一层：**行尾** `//` 注释。给**计数类**判据专用（**不是** `stripComments` 的替代品）。
 *
 * ⚠️ 为什么单开一个而不是改 `stripComments`（F-2 · 2026-10-01 评审件 REVIEW-1002 §4）：
 *    `stripComments` 是**所有**结构判据的输入，动它等于一次性移动几十条判据的输入
 *    —— 回归面大到无法归因（本项目纪律：一次只动一件事）。而真正被行尾注释伤到的，
 *    只是"数某个动作出现几次"这一类：维护者在行尾写一句 `// 老写法是 session.unread = [];`
 *    就会收到一条**看不懂的红**，而**它的代价不是那次红，是它会诱导人把判据改松**。
 *
 * ⚠️ 为什么不直接"把行尾的 `//` 一路吃到行末"：那会把 `http://` / `ws://` 砍成 `http:`
 *    （`§50②` 的局部特例就踩在这个边缘上）。所以要求 `//` 的**前一个字符**不是
 *    `:`（URL 协议头）也不是标识符字符或引号（字符串/模板里的 `'a//b'`）。
 *    行首的整行注释由 `stripComments` 先行剥掉，这里只管**行尾**那一半。
 */
export function stripTrailingComments(s) {
  return s.replace(/(^|[^:'"`\w])\/\/[^\n]*$/gm, '$1');
}
/** 计数类判据的**唯一**入口：先剥行尾注释，再数。新写"数次数"的判据一律用它。 */
export const countOf = (src, re) => [...stripTrailingComments(src).matchAll(re)].length;

/**
 * 子判据登记（Q87）：`subHit(桶)` 在**判据执行到**的位置调一次，`subCountOf(桶)` 读总数。
 *
 * 为什么需要它（外包 v5 回执的 E1b 形态）：§51 的段数自证只数"打了几条 ✓" ——
 * 把一整段包进 `if (false) { … }`，那一段的 ✓ 照样打出来（`problems` 是空的）、
 * 段数一个不少，于是**失败伪装成成功**（81 段照跑、全绿、✓ 文案照旧宣告四条已生效）。
 * 子计数把"段内到底跑了几条子判据"变成一个数字，并由 §51 核下限。
 *
 * 口径：只给**多子判据的重段**用（轻段没必要）；数的是"执行到"，不是"通过"。
 */
export const subRan = new Map();
export function subHit(bucket) { subRan.set(bucket, (subRan.get(bucket) ?? 0) + 1); }
export const subCountOf = (bucket) => subRan.get(bucket) ?? 0;
/**
 * 结构契约一律扫这一份（已剥注释）。
 * ⚠️ **S-12 第六批（2026-10-05）**：这里原来附着另一条说明 —— "单文件时与改造前逐字相同
 * （`joinParts` 只有一个元素时不加分隔符），由第 6 节的断言钉着"。那个对象（旧页的
 * 片段拼装）已整块删除，配套的两处断言也一并摘除（`check-wb` 的第 6 节自证第 ④ 条、
 * `smoke` 的 T69）。本函数本身不受影响：它一直只做"剥注释"这一件事。
 */

/**
 * 源码里**所有 import 的模块名** —— 「判据叶子不许有依赖」这条契约的**唯一实现**。
 *
 * ⚠️ 为什么要有它（2026-09-29 · 外包任务1 复核 FG-1 / FG-2 实测，已在本仓复现）：
 *    在此之前，五个"叶子零依赖"的契约各自内联了一条
 *    `^[ \t]*import[^\n]*from '([^']+)'` —— 它**只认「单行 + 单引号」**：
 *      · **多行命名导入**（`import {\n readFileSync,\n} from 'node:fs'`）→ 0 命中；
 *      · **双引号**（`from "node:fs"`）→ 0 命中；
 *      · 再配一个**解构出来的裸调用**（`readFileSync(...)`，不写 `fs.`）→ IO 判据也 0 命中。
 *    于是"叶子长出文件系统依赖"这件事可以整条绕过两道判据，而契约照旧打 ✓。
 *    把五份正则收敛成这一处，同时补上跨行与两种引号。
 *
 * 形状：`import x from 'm'` / `import 'm'` / `import {…} from "m"`（**可跨行**）/
 *       `import('m')` / `export {…} from 'm'`。
 * 方向：**宁可多报**（多报会让人来看一眼），不可漏报 —— 与 §6 第 13 条同一条取舍。
 *
 * ⚠️ 已知盲区（写明，别假装它是硬闸）：只认**字面量**模块名。
 *    用变量拼出来的 import、`createRequire` / `process.binding` 这类运行时取模块的路子
 *    它一个都拦不到 —— 那些属于"已经在写恶意代码"，不是"顺手抄一行 import"能比的。
 *
 * @param {string} src 已剥注释的源码
 * @returns {string[]} 去重后的模块名
 */
export function importsOf(src) {
  const out = [];
  for (const m of String(src ?? '').matchAll(/\bfrom\s*['"]([^'"]+)['"]/g)) out.push(m[1]);
  for (const m of String(src ?? '').matchAll(/\bimport\s*\(?\s*['"]([^'"]+)['"]/g)) out.push(m[1]);
  return [...new Set(out)];
}

/**
 * 从下标 `b`（必须指向 `{`）起**配平**取出整段（含首尾花括号）；配不平返回空串。
 *
 * 为什么要单抽这一层（2026-10-01 轮 · 回收 v10/v5 回执 → Q85）：
 * 在这之前"取某个对象 / 块的体"是靠 `src.slice(i, i + 2800)` 这种**固定窗口**做的 ——
 * 窗尾会越出真正的体（本仓实测：㉔ 那处**越出 `rec` 约 74 行**），于是窗外
 * （甚至别的函数里）写一句形状吻合的注释就能替它过检。配平提取把"体的边界"
 * 交回给花括号自己，替检面归零；同时"插两行日志 / 换一种缩进"这类**误红**也一并消失。
 *
 * @param {string} src 已剥注释的源码
 * @param {number} b 指向 `{` 的下标（传 -1 或指向别的字符一律返回 ''）
 */
export function braceAt(src, b) {
  if (b < 0 || src[b] !== '{') return '';
  let depth = 0;
  for (let k = b; k < src.length; k += 1) {
    if (src[k] === '{') depth += 1;
    else if (src[k] === '}') { depth -= 1; if (depth === 0) return src.slice(b, k + 1); }
  }
  return '';
}

/**
 * 从 `head` 起取**花括号体**：`{}` 形态对象 / 块体的唯一取法。
 *
 * 与 `fnSlice` 的分工：`fnSlice` 认"函数签名 + 参数列表"（要先跳过参数再找体），
 * 本函数直接认"从 head 起第一个 `{`" —— 给 `const rec = {`、`if (sp.asleep) {`
 * 这类**不是函数**的体用。
 *
 * @param {string} src 已剥注释的源码
 * @param {string} head 起点字面量（可以自带 `{`）
 */
export function braceSlice(src, head) {
  const i = src.indexOf(head);
  if (i < 0) return '';
  return braceAt(src, src.indexOf('{', i));
}

/**
 * 从 `head`（函数签名开头）起：先配平括号**跳过参数列表**，再配平花括号取出整段函数体。
 *
 * 为什么不"从函数名往后找第一个 `{`"：`fn({ a, b } = {})` 这种**参数解构**会让那一版
 * 拿到参数对象的小括号段，于是抽出来的是一截不相干的代码 —— 本项目第 55 条教训的原样。
 * 抽不出来/抽出来太短就返回空串，**调用方一律当失败**（fail-closed，防改名后静默变空）。
 *
 * 2026-09-27 起 2b（data-mirror）与 3c（出口闸门）都靠它把判据**锁进函数体** ——
 * 外包体检（ZCode）证实这两处的全局搜判据是假绿。
 *
 * ⚠️ `minLen` 曾经是**死参数**（Q88）：头注释承诺"太短就返回空串（fail-closed）"，
 *    而函数体从不读它 —— 于是"函数被改名 / 被抽成一层"时抽出来一小截**照样往下走**，
 *    判据在真空里变绿。现在真的兑现它（不达标一律按抽取失败处理）；
 *    各调用点的取值口径见 §51 ④b 与那几处注释（**实测体长的 ~60%**）。
 *
 * @param {string} src 已剥注释的源码
 * @param {string} head 函数签名开头，如 'function renderState('
 * @param {number} minLen 抽出结果的最小长度（过短 = 抽取规则已失效）
 */
export function fnSlice(src, head, minLen = 60) {
  const i = src.indexOf(head);
  if (i < 0) return '';
  let j = i;
  while (j < src.length && src[j] !== '(') j += 1;
  if (j >= src.length) return '';
  let pd = 0;
  for (; j < src.length; j += 1) {
    if (src[j] === '(') pd += 1;
    else if (src[j] === ')') { pd -= 1; if (pd === 0) { j += 1; break; } }
  }
  const b = src.indexOf('{', j);
  const body = braceAt(src, b);
  if (!body) return '';
  // ⚠️ 返回值仍**从函数签名开头算起**（`src.slice(i, …)`）—— 与改造前逐字一致：
  //    下游有几条判据是在"签名 + 体"这一段里找东西的，改动它会静默改变它们的输入。
  const out = src.slice(i, b + body.length);
  return out.length >= minLen ? out : '';
}
