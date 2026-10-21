/**
 * §116 · G4 tag 的唯一入口与闸门分离（2026-10-20）的变异清单 —— 纯数据。
 *
 * 五条各打红 §116 的一个判据（①–⑤），形状参考 `test/mutations/ctx-menu-1020.mjs`。
 * 输入对象是 `scripts/g4-tag.mjs`（持有不发、不进对外拷贝的那两个发布工具之一）。
 *
 * ⚠️ **§116⑥ 不在本清单里**：它盯的是仓外件 `~/.qqbot/finish-ai-bot-groupmate.sh`。
 *    变异器只改仓内路径，改不到 `$HOME` 底下 ⇒ ⑥ 是**结构性不可变异盲区**，
 *    已按 §34（known-real）同规在 `scripts/CONTRACTS-HISTORY.md` 的 §116 那一行如实登记，
 *    而不是假装这一条也有反证。它今天的反证是手工实跑（见那份历史行的 ⑤）。
 *
 * 跑法（**必须先提交**：`mutate.mjs` 要求工作树 == pristine，它会就地变异再还原）：
 *   `NODE_OPTIONS= node scripts/mutate.mjs test/mutations/g4tag-1020.mjs`
 * 静态体检（不碰工作树，可先跑）：`NODE_OPTIONS= node scripts/mutate-lint.mjs`
 */

const G4 = 'scripts/g4-tag.mjs';

export default [
  {
    id: 'G1',
    note: '把 `export function verify(` 改名 —— §116① 必须变红（唯一入口的形状被搬走，'
      + '②–⑤ 立刻变成"对一个不存在的函数体报通过"）。其余四条不该跟着红。预期 BLOCKED',
    file: G4,
    anchor: /export function verify\(api, tag, expectSha, log = out\) \{/,
    count: 1,
    apply: (s) => s.replace(
      'export function verify(api, tag, expectSha, log = out) {',
      'export function verifyTag(api, tag, expectSha, log = out) {', 1),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'G2',
    note: '摘掉 `--create` 的批准闸门（`&& !argv.includes(\'--approved\')` → `&& false`）—— §116② 必须变红。'
      + '这是本段最值钱的一条：坏了之后任何一次手滑 `--create` 都会把版本号写进不可逆的公开历史'
      + '（AGENTS.md §4 的 0.1.2 事故形状），而脚本表面上一切如常。预期 BLOCKED',
    file: G4,
    anchor: /if \(mode === '--create' && !argv\.includes\('--approved'\)\) \{/,
    count: 1,
    apply: (s) => s.replace(
      "if (mode === '--create' && !argv.includes('--approved')) {",
      "if (mode === '--create' && false) {", 1),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'G3',
    note: '加一个 `--sha` 第二入口 —— §116③ 必须变红。这个参数是**刻意不提供**的：有了它就能把 tag'
      + '打在本地开发 sha 上，等于让"已发布的版本号"指向一份从未进公开血缘的代码。'
      + '⚠️ 判据跑在剥注释后的源码上（文件头本来就要提"不提供 --sha"，按原始 blob 数会假红），'
      + '所以这条变异把字样放进了**代码行**。预期 BLOCKED',
    file: G4,
    anchor: /const tag = argv\.find\(\(a\) => !a\.startsWith\('--'\)\);/,
    count: 1,
    apply: (s) => s.replace(
      "const tag = argv.find((a) => !a.startsWith('--'));",
      "const tag = argv.find((a) => !a.startsWith('--'));\n  const shaOpt = argv.find((a) => a.startsWith('--sha'));", 1),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'G4',
    note: '把 curl 传输"顺手改回 fetch" —— §116④ 必须变红。这条专门钉**这台机器的物理事实**：'
      + '本机 Node 的 fetch/node:https 过不了 TLS（`unable to verify the first certificate`，实测要 --use-system-ca），'
      + '同一 URL 用 curl 拿 200。改完在别人的机器上是绿的，在这台机器上红在发布那一刻。'
      + '（变异保持语法合法：不写 `await`，因为 `api()` 不是 async 函数。）预期 BLOCKED',
    file: G4,
    anchor: /const raw = execFileSync\('curl', args, \{ encoding: 'utf8', maxBuffer: 16 \* 1024 \* 1024 \}\);/,
    count: 1,
    apply: (s) => s.replace(
      "const raw = execFileSync('curl', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });",
      'const raw = fetch(baseUrl + apiPath).then((r) => r.text());', 1),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'G5',
    note: '把 `--selftest` 指向一个不存在的夹具文件名 —— §116⑤ 必须变红（只红"引用"这一子项：'
      + '文件本体仍在、`--selftest` 关键字仍在，所以这条能精确指出残缺在哪一处）。'
      + '没有 mock 夹具，那十条自检只能对着真 GitHub 跑 —— 每一条断言都变成一次写操作。预期 BLOCKED',
    file: G4,
    anchor: /path\.join\(HERE, 'mock-github-server\.mjs'\)/,
    count: 1,
    apply: (s) => s.replace(
      "path.join(HERE, 'mock-github-server.mjs')",
      "path.join(HERE, 'mock-github-server-removed.mjs')", 1),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
];
