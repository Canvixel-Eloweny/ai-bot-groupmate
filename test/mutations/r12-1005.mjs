/**
 * 第 12 轮（开源前审查 · **P3 的低优先级块** L-01…L-08）的变异清单 —— 纯数据，
 * 供 `NODE_OPTIONS= node scripts/mutate.mjs test/mutations/r12-1005.mjs` 复跑。
 *
 * 打的对象：本轮新加的五段契约（§74 heredoc/sandbox · §75 token/pidfile ·
 * §76 launcher osascript · §77 仓库属性/时长常量 · §78 行为准则）。
 * **每一条新契约都配一组只打它的变异**（本项目第 4.0.3 条纪律）。
 *
 * | 条 | 打的是 | 该由哪一层拦住 | 期望 |
 * |---|---|---|---|
 * | M1 | `sandbox.sh` 的 heredoc 正文里写回反引号（会被当命令替换） | check-wb §74 | BLOCKED |
 * | M2 | 收尾说明写回"故意没有把面板自检接进来"（与实现矛盾） | check-wb §74 | BLOCKED |
 * | M3 | `exit "$rc"` 改回 `exit 0`（退出码被吞 = 假绿） | check-wb §74 | BLOCKED |
 * | M4 | `ECHO_PANEL_TOKEN` 闸被换成 `if (true)`（token 正文无条件打印） | check-wb §75 | BLOCKED |
 * | M5 | 鉴权 `hint` 改回"会打印在 panel/panel.log"（文案与行为不一致） | check-wb §75 | BLOCKED |
 * | M6 | PIDFILE 写失败改回空 catch（失败又静默了） | check-wb §75 | BLOCKED |
 * | M7 | `notify` 丢掉 `"$1"`（argv 没被绑定 → 通知文案丢失） | check-wb §76 | BLOCKED |
 * | M8 | `notify` 改回双引号插值的 osascript（脚本注入的形状） | check-wb §76 | BLOCKED |
 * | M9 | `.gitattributes` 摘掉 `*.sh text eol=lf` | check-wb §77 | BLOCKED |
 * | M10 | 一处已具名的时长改回裸写（`180000`） | check-wb §77 | BLOCKED |
 * | M11 | 行为准则「归属」写回"改编自" | check-wb §78 | BLOCKED |
 * | M12 | 行为准则「执行」的举报段被删（准则没有落地入口） | check-wb §78 | BLOCKED |
 *
 * ⚠️ 这批"只打它"是逐个核对过的：每条只改一处，且只有对应的那一节会红。
 * ⚠️ 跑测试一律 `NODE_OPTIONS= node …`（R39）；用全新的 `QQBOT_MUTATE_WORK` 目录（R46.1）。
 */
const SB = 'test/sandbox.sh';
const SRV = 'panel/server.js';
const LSH = 'QQ-BOT-CONTROL.app/Contents/Resources/launcher.sh';
const GA = '.gitattributes';
const COC = 'CODE_OF_CONDUCT.md';

// ── M1：L-08 —— heredoc 正文里的反引号（会被 shell 当**命令替换**执行掉）─────────
const SB_BODY = /它排在 verify-presets 之前/;
const M1 = {
  id: 'M1',
  note: '把 sandbox 收尾说明里的一处写成**反引号**包裹（未加引号的 heredoc 里它会被当命令替换跑掉）——',
  anchor: SB_BODY,
  count: 1,
  file: SB,
  apply: (s) => s.replace(SB_BODY, '它排在 verify-presets 之前（见 `panel/next/verify.mjs`）'),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M2：L-08 —— 收尾说明写回那句**与实现矛盾**的过期结论 ─────────────────────
const M2 = {
  id: 'M2',
  note: '把"故意没有把面板自检接进来"写回收尾说明（而 ③ 明明在跑它）——',
  anchor: SB_BODY,
  count: 1,
  file: SB,
  apply: (s) => s.replace(SB_BODY, '它排在 verify-presets 之前；这里故意没有把面板自检接进来'),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M3：L-08 —— 退出码被吞（M-1 修掉过的那类假绿）────────────────────────────
const SB_EXIT = /\n  exit "\$rc"\n/;
const M3 = {
  id: 'M3',
  note: '把 `--run` 结尾的 `exit "$rc"` 改回 `exit 0`（各层失败被一起吞掉）——',
  anchor: SB_EXIT,
  count: 1,
  file: SB,
  apply: (s) => s.replace(SB_EXIT, '\n  exit 0\n'),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M4：L-02 —— token 打印闸被换成恒真 ──────────────────────────────────────
const SRV_GUARD = /if \(ECHO_PANEL_TOKEN\) \{/;
const M4 = {
  id: 'M4',
  note: '把 token 正文的打印闸 `if (ECHO_PANEL_TOKEN)` 换成 `if (true)`（凭据又无条件进 panel.log）——',
  anchor: SRV_GUARD,
  count: 1,
  file: SRV,
  apply: (s) => s.replace(SRV_GUARD, 'if (true) {'),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M5：L-02 —— 文案与行为不一致（hint 还指着 panel.log）────────────────────
const SRV_HINT = /hint: 'token 保存在 panel\/\.token（0600），需要时 `cat panel\/\.token` 查看',/;
const M5 = {
  id: 'M5',
  note: '把鉴权失败的 `hint` 改回"启动时会打印在 panel/panel.log"（那已经不再发生）——',
  anchor: SRV_HINT,
  count: 1,
  file: SRV,
  apply: (s) => s.replace(SRV_HINT, "hint: 'token 保存在 panel/.token；控制台启动时也会把它打印在 panel/panel.log',"),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M6：L-06 —— PIDFILE 写失败又静默了 ──────────────────────────────────────
const SRV_PID = /  try \{ fs\.writeFileSync\(PIDFILE, String\(child\.pid\)\); \}\n  catch \(e\) \{ pushLog\([\s\S]*?\); \}/;
const M6 = {
  id: 'M6',
  note: '把"写 panel/.bridge.pid 失败 → pushLog"改回**空 catch**（失败有后果却静默）——',
  anchor: SRV_PID,
  count: 1,
  file: SRV,
  apply: (s) => s.replace(SRV_PID, '  try { fs.writeFileSync(PIDFILE, String(child.pid)); } catch {}'),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M7：L-01 —— argv 没被绑定（通知文案当场丢失）─────────────────────────────
const LSH_ARGV = /           -e 'end run' "\$1" >\/dev\/null 2>&1/;
const M7 = {
  id: 'M7',
  note: "把 notify 里作为**参数**传的 `\"$1\"` 摘掉（on run argv 没被绑定，通知会把文案丢了）——",
  anchor: LSH_ARGV,
  count: 1,
  file: LSH,
  apply: (s) => s.replace(LSH_ARGV, "           -e 'end run' >/dev/null 2>&1"),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M8：L-01 —— 回到"把 $1 拼进 AppleScript 源码串"的老写法 ──────────────────
const LSH_BLOCK = /notify\(\) \{\n  osascript -e 'on run argv' \\\n           -e 'display notification \(item 1 of argv\) with title "QQ-BOT-CONTROL"' \\\n           -e 'end run' "\$1" >\/dev\/null 2>&1\n\}/;
const M8 = {
  id: 'M8',
  note: '把 notify 整块改回**双引号插值**的老写法（`$1` 重新变成 AppleScript 源码的一部分）——',
  anchor: LSH_BLOCK,
  count: 1,
  file: LSH,
  apply: (s) => s.replace(LSH_BLOCK, 'notify() {\n  osascript -e "display notification \\"$1\\" with title \\"QQ-BOT-CONTROL\\"" >/dev/null 2>&1\n}'),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M9：L-05 —— `.gitattributes` 少了脚本的 LF 声明 ─────────────────────────
const GA_SH = /^\*\.sh text eol=lf$\n/m;
const M9 = {
  id: 'M9',
  note: '从 .gitattributes 里摘掉 `*.sh text eol=lf`（CRLF 的 shebang 在 Linux 上必然失败）——',
  anchor: GA_SH,
  count: 1,
  file: GA,
  apply: (s) => s.replace(GA_SH, ''),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M10：L-07 —— 一处已具名的时长改回裸写 ───────────────────────────────────
const SRV_NAKED = /setTimeout\(\(\) => ac\.abort\(\), MODEL_REQUEST_ABORT_MS\)/;
const M10 = {
  id: 'M10',
  note: '把 `MODEL_REQUEST_ABORT_MS` 那一处改回裸写的 `180000`（"看着一样、其实语义不同"的老路）——',
  anchor: SRV_NAKED,
  count: 1,
  file: SRV,
  apply: (s) => s.replace(SRV_NAKED, 'setTimeout(() => ac.abort(), 180000)'),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M11：L-03 —— 「归属」写回"改编自" ───────────────────────────────────────
const COC_OWN = /只\*\*参考了它的章节框架\*\*/;
const M11 = {
  id: 'M11',
  note: '把行为准则「归属」的"参考框架"改回"改编自"（指向衍生作品，带署名/许可义务）——',
  anchor: COC_OWN,
  count: 1,
  file: COC,
  apply: (s) => s.replace(COC_OWN, '**改编自**它的章节框架'),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

// ── M12：L-03 —— 「执行」节的举报段被删（准则没有落地入口）──────────────────
// ⚠️ 锚点认的是「举报通道这一段」而不是它某一句的措辞（2026-10-07 修）：
//   原文案里有一句「本节与 `SECURITY.md` 一起补上真实入口」—— 那句话本身是**过时的错误陈述**
//   （当时仓库还没有发布地址），照着它写死锚点，等于**把一条过时文案钉成契约**：
//   文档一改对，锚点就命中 0/1，这条变异从此 INVALID。
//   现在锚的是"举报通道开头 → 不要开公开 issue"这段的**边界**，措辞可以自由迭代。
const COC_ENF = /举报走\*\*与 `SECURITY\.md` 同一个私密通道\*\*[\s\S]*?不要开公开 issue/;
const M12 = {
  id: 'M12',
  note: '把行为准则「执行」节的举报通道整段删掉（准则变成没有入口的声明）——',
  anchor: COC_ENF,
  count: 1,
  file: COC,
  apply: (s) => s.replace(COC_ENF, ''),
  layer: 'check-wb',
  expect: 'BLOCKED',
};

export default [M1, M2, M3, M4, M5, M6, M7, M8, M9, M10, M11, M12];
