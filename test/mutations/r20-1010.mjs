/**
 * 第 20 轮（开源前审查 · **补回一条红色已入库的线**）的变异清单 ——
 * 纯数据，供 `NODE_OPTIONS= QQBOT_MUTATE_WORK=/tmp/r20-mutate
 * node scripts/mutate.mjs test/mutations/r20-1010.mjs` 复跑。
 *
 * 本轮**没有新功能**。开工取证时发现：HEAD（`0e7d6ba`）跑 `check-wb` 就是红的 2 条 ——
 * 而红的原因是 `2fcead3`（S-07~S-10 面板侧安全修复）把 `app.js` 的 RENDER 键改名成
 * `plugin*`，**却漏改了 `schema.js`**。后果是现役控制台的**插件页 / 情绪设置 /
 * 图库设置三块在页面上空白**，反过来那四个渲染器成了死代码。
 *
 * ⚠️⚠️ **为什么这一轮的红能一直躺在库里**（本轮真正要防的东西）：
 *   ① `scripts/pre-commit.sh` **恒定 `exit 0`**（第 10 条约定：只报警不阻断）；
 *   ② 仓库**无 remote** ⇒ `.github/workflows/ci.yml` 里那条 `node scripts/check-wb.mjs`
 *      **从未被机器执行过**；
 *   ③ 于是「跑一遍工作树」成了唯一一次把关，而**工作树里躺着修红的在制品** ——
 *      本机读数全绿，红色留在库里。
 *   §69「渲染面三处同集合」其实抓得到，但它是 `2c812bb` 才加的、比改名晚，
 *   实测**一出生就是红的**（`git show 2c812bb:…` 两边各 6/8 处旧名与新名并存）。
 *   真正没人管的是 §69 **结构上照不到**的那一半：**CSS 与 DOM 那层**
 *   （HEAD 的 `style.css` 里 `.pgrid` / `.pcard` 定义数 = **0**，而 JS 在吐这两个类）。
 *
 * | 条 | 打的是 | 该由哪一层拦住 | 期望 |
 * |---|---|---|---|
 * | P1 | `.pgrid > .pcard` 不解除 `span 12` ⇒ 13 块板撑成 13 排单列 | §85① | BLOCKED |
 * | P2 | `.pgrid` 退化成普通块级堆叠（不报错，只是平铺没了） | §85① | BLOCKED |
 * | P3 | `.pcard` 自己重写一份 `backdrop-filter`（两份材质语义） | §85② | BLOCKED |
 * | P4 | 插件板不挂 `card` 类 ⇒ 玻璃材质继承不到 | §85② | BLOCKED |
 * | P5 | `bare: true` 被删 ⇒ 外面又罩一张大玻璃板 | §85③ | BLOCKED |
 * | P6 | `cardHtml` 的 `bare` 分支被删（**改了 schema 却看不到变化**） | §85③ | BLOCKED |
 * | P7 | 旧控件名 `extSettings` 残留（**改名只做一半**＝已发生过的事故） | §85④ | BLOCKED |
 * | P8 | 文案里「扩展包」字样回来（§69 判不到这一半） | §85④ | BLOCKED |
 * | P9 | B43 只留 `nowrap`、删掉 `flex: none`（**两条必须成对**） | §85⑤ | BLOCKED |
 * | P10 | `.sub` 规则整体改名 ⇒ 判据 fail-closed（不许在真空里变绿） | §85⑤ | BLOCKED |
 *
 * ⚠️ **P9 与 P10 是同一个不变量的两个方向**：P9 打「成对里少一条」（症状会换一种形态出现，
 *   所以必须两条都在），P10 打「判据自己取不到源」（`subRule85` 为空 ⇒ 必须报红而不是放过）。
 *   ⚠️ **P1 是本清单最要紧的一条**：它是这次事故里**唯一没有第二道防线**的那个形态 ——
 *   JS 照吐 `.pgrid > .pcard`、面板照跑、像素层要 Docker 才跑得到，
 *   契约层若不钉住，"平铺没了"这件事**在四层里没有任何一处会报红**。
 *
 * ⚠️ 跑测试一律 `NODE_OPTIONS= node …`（R39）；用**全新**的 `QQBOT_MUTATE_WORK` 目录（R46.1）。
 * ⚠️ 本清单**全部只打 CSS / schema / app 的静态文本**，所以 `layer: 'check-wb'` 全部够用 ——
 *   不需要起浏览器（这正是 §85 存在的理由：把像素层的事挪一层到契约层）。
 */
const CWB = 'scripts/check-wb.mjs';
const CSS = 'panel/next/style.css';
const SCHEMA = 'panel/next/schema.js';
const APP = 'panel/next/app.js';

// ── P1：`.pgrid > .pcard` 不解除 span 12（平铺静默消失）────────────────────
// ⚠️ 写成**合法 CSS**：只删那一条声明，别的都不动 —— 那才是真故障
//    （板还在、块都在，只有布局错了），语法错反而会被别的判据先拦住。
const P1 = {
  id: 'P1',
  note: 'style.css 里 .pgrid > .pcard 不再显式解除 span 12（13 块板撑成13 排单列）——',
  anchor: /^\.pgrid > \.pcard \{ grid-column: auto; \}$/m,
  count: 1,
  file: CSS,
  apply: (s) => s.replace('.pgrid > .pcard { grid-column: auto; }', '.pgrid > .pcard { align-self: start; }'),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── P2：`.pgrid` 不再是 grid（退化成块级堆叠，同样不报错）──────────────────
// ⚠️⚠️ **本条改过一次**：初版写成「在 `.pgrid {` 后面**插入** `display: block;`」，
//    实测 **NOT-BLOCKED**。复现后确认是**变异自己写错了**，不是判据失效：
//    插进去的那行排在原有 `display: grid;` **之前**，而 CSS 同属性**后者覆盖前者**
//    ⇒ 网格其实还在，`.pgrid` 仍是 grid ⇒ §85①「不该报红而没报」是对的。
//    正解是**替换掉那一条**，让 `display: grid` 真的消失。
//    ⚠️ 记这一笔是因为它正是「变异无效」与「判据失效」的区别所在：
//    量尺只查锚点与惰性，**查不出"这条变异其实没打中东西"** —— 只能靠实跑看。
const P2 = {
  id: 'P2',
  note: 'style.css 里 .pgrid 的 display:grid 被换成 block（插件板退化成普通堆叠）——',
  anchor: /^\.pgrid \{$/m,
  count: 1,
  file: CSS,
  apply: (s) => s.replace('.pgrid {\n  display: grid;', '.pgrid {\n  display: block;'),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── P3：材质重写一份（两份语义必然漂）────────────────────────────────────
const P3 = {
  id: 'P3',
  note: '.pcard 自己写 backdrop-filter（材质不再继承 .card，变成两份语义）——',
  anchor: /^\.pgrid > \.pcard \{ grid-column: auto; \}$/m,
  count: 1,
  file: CSS,
  apply: (s) => s.replace(
    '.pgrid > .pcard { grid-column: auto; }',
    '.pgrid > .pcard { grid-column: auto; backdrop-filter: blur(9px); }'
  ),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── P4：不挂 card 类（玻璃材质继承不到 ⇒ 一块没有材质的白板）──────────────
const P4 = {
  id: 'P4',
  note: 'app.js 插件板不再同时挂 card 类（玻璃材质继承不到）——',
  anchor: /class="card pcard"/,
  count: 1,
  file: APP,
  apply: (s) => s.replace('class="card pcard"', 'class="pcard"'),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── P5：bare: true 被删（外面又罩一张 span-12 大玻璃板）────────────────────
const P5 = {
  id: 'P5',
  note: 'schema.js 插件清单那张卡不再脱掉外层 .card（大玻璃板把 13 块包住）——',
  anchor: /bare: true,/,
  count: 1,
  file: SCHEMA,
  apply: (s) => s.replace('bare: true,', 'span: 12,'),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── P6：cardHtml 的 bare 分支被删（改了 schema 却看不到变化）──────────────
const P6 = {
  id: 'P6',
  note: 'app.js 的 cardHtml 不再分发到 bareHtml（bare:true 静默失效）——',
  anchor: /if\s*\(c\.bare\)\s*return\s+bareHtml\(c\);/,
  count: 1,
  file: APP,
  apply: (s) => s.replace('if (c.bare) return bareHtml(c);', '/* bare channel removed */'),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── P7：旧控件名残留（改名只做一半＝2fcead3 那次事故的形状）────────────────
// ⚠️ 锚点必须**唯一**（`count: 1`）：`pluginSettings` 在 schema.js 里有**3 处**
//    （两处 `t:` + 一处 `CTRL_KINDS` 登记），锚成 `/pluginSettings/g` 会被量尺判「命中 3/1」。
//    取**带 extId 的那一处**—— 它是唯一形状，也正是"页面上一块控件"的真实落点。
const P7 = {
  id: 'P7',
  note: 'schema.js 里旧控件名 extSettings 残留（改名只做了一半）——',
  anchor: /\{ id: 'eset', title: '注入与更新', span: 5, ctrls: \[\{ t: 'pluginSettings'/,
  count: 1,
  file: SCHEMA,
  apply: (s) => s.replace(
    "{ id: 'eset', title: '注入与更新', span: 5, ctrls: [{ t: 'pluginSettings'",
    "{ id: 'eset', title: '注入与更新', span: 5, ctrls: [{ t: 'extSettings'"
  ),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── P8：文案「扩展包」回来（§69 结构上判不到这一半）───────────────────────
// ⚠️ 注意锚点选的是**英文旧名**所在处之外的位置：这一条改的是中文文案，
//    §85④ 的正向判据查`/扩展包|拓展包/`（schema.js 原文）。改成合法字符串，
//    不是语法错 —— 否则会被 T376 那条"剥后仍可解析"先拦住，测不到本条判据。
const P8 = {
  id: 'P8',
  note: 'schema.js 页面文案里「扩展包」字样回来（界面命名不统一）——',
  anchor: /装在 <code>plugins\/<\/code> 与 <code>skills\/<\/code> 里的第三方插件/,
  count: 1,
  file: SCHEMA,
  apply: (s) => s.replace(
    '装在 <code>plugins/</code> 与 <code>skills/</code> 里的第三方插件',
    '装在 <code>plugins/</code> 与 <code>skills/</code> 里的第三方扩展包'
  ),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── P9：B43 只留 nowrap、删掉 flex:none（两条必须成对）─────────────────────
// ⚠️ 这是**成对**关系最要紧的证明：症状只是"换一种形态出现"，很容易被当成修好了。
const P9 = {
  id: 'P9',
  note: '.sub 上 flex:none 被删（B43 两条不成对：nowrap 单独留着仍会被压成多行）——',
  anchor: /white-space: nowrap; flex: none;/,
  count: 1,
  file: CSS,
  apply: (s) => s.replace('white-space: nowrap; flex: none;', 'white-space: nowrap;'),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── P10：.sub 规则改名 ⇒ 判据 fail-closed（不许在真空里变绿）──────────────
// ⚠️ 锚点必须锚在**主规则那一行**（`.sub {`，唯一），不能锚 `.sub:focus-visible`——
//    后者在 style.css 里有**2 处**（925 行的注释里提了一句 + 973 行的真规则），
//    实测被量尺判「命中 2/1」。改成 `^\.sub \{$` 只匹配 934 行那一个块。
// ⚠️ 改法是**把选择器改名**（`.sub {` → `.navsub {`）：§85⑤ 的取源正则 `\.sub\s*\{`
//    要求 `.` 紧邻 `sub`，而 `.navsub` 里 `sub` 前面是 `v` ⇒ 取不到源 ⇒ 必须报红。
const P10 = {
  id: 'P10',
  note: '.sub 主规则被改名（§85⑤ 取不到源，必须 fail-closed 而不是放过）——',
  anchor: /^\.sub \{$/m,
  count: 1,
  file: CSS,
  apply: (s) => s.replace(/^\.sub \{$/m, '.navsub {'),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

export default [P1, P2, P3, P4, P5, P6, P7, P8, P9, P10];