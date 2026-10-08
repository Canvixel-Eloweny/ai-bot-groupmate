/**
 * D14（收藏表情只读接入）的变异清单 —— 纯数据，供 `node scripts/mutate.mjs test/mutations/d14.mjs` 复跑。
 *
 * 为什么把它从"当轮临时脚本"搬进仓库：这六条当时是用一次性 bash + python 手写的，
 * 结果**两次踩坑**（还原把变异洗进基线、锚点随实现搬家后静默失效）。
 * 搬进来之后，同一条纪律由 `mutate.mjs` 统一保证，任何人改完 `src/custom-faces.js`
 * 都能一条命令复核"这六条防线还在不在"。
 *
 * 期望：六条全部 `BLOCKED`（layer=check-wb；M1/M2 会同时打红 smoke，见 §5 记录）。
 */

export default [
  {
    id: 'M1',
    note: '令牌判据恒假（形状判据失效）',
    file: 'src/custom-faces.js',
    anchor: /export function isCustomFaceToken\(id\) \{/,
    count: 1,
    apply: (s) => s.replace(
      'export function isCustomFaceToken(id) {',
      'export function isCustomFaceToken(id) {\n  if (id) return false;'
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M2',
    note: '分类不再分流（收藏被当内置 face id 发出去）',
    file: 'src/face-marks.js',
    anchor: /if \(!isCustomFaceToken\(s\.id\)\) return \{ type: 'face', id: s\.id \};/,
    count: 1,
    apply: (s) => {
      const from = "      if (!isCustomFaceToken(s.id)) return { type: 'face', id: s.id };\n"
        + "      const url = get(s.id);\n"
        + "      return url ? { type: 'image', url } : null;";
      return s.replace(from, "      return { type: 'face', id: s.id };");
    },
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M3',
    note: '关贴纸清理改回"自己写一份"（漏掉自定义令牌）',
    file: 'src/brain.js',
    anchor: /stripFaceMarks\(s\)/,
    count: 1,
    apply: (s) => s.replace(
      '.map((s) => (this.cfg.llm?.features?.stickers ? s : stripFaceMarks(s)))',
      ".map((s) => (this.cfg.llm?.features?.stickers ? s : s.replace(/\\[face:\\d+\\]/g, '').trim()))"
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M4',
    note: '叶子里出现收藏表情的**写**动作（越过 Q15 的只读边界）',
    file: 'src/custom-faces.js',
    anchor: /import \{ imageHash \} from '\.\/trace-id\.js';/,
    count: 1,
    apply: (s) => s.replace(
      "import { imageHash } from './trace-id.js';",
      "import { imageHash } from './trace-id.js';\n\nconst WRITE_ACTION = 'add_custom_face'; // 变异：越界"
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M5',
    note: '刷新挪进新开的定时器（不挂在既有 tick 上）',
    file: 'src/index.js',
    // ⚠️ 锚点必须唯一：`refreshCustomFaces().catch(...)` 在 index.js 里出现**两次**
    //    （ready 钩子一次、30 秒 tick 一次）。只锚函数名会命中 2 处 → 脚手架报 INVALID
    //    并拒绝下结论 —— 这正是它该做的（本机实测第一版就命中 2/1）。
    //    这里把下一行 `tickProactive()` 一并纳入，锚定"定时器回调里的那一次"。
    anchor: /refreshCustomFaces\(\)\.catch\(\(e\) => log\.warn\(`收藏表情同步异常: \$\{e\.message\}`\)\);\n    tickProactive\(\)\.catch\(/,
    count: 1,
    apply: (s) => {
      const from = "    refreshCustomFaces().catch((e) => log.warn(`收藏表情同步异常: ${e.message}`));\n"
        + "    tickProactive().catch((e) => log.error(`定时任务异常: ${e.message}`));\n"
        + '  }, 30000);';
      const to = "    tickProactive().catch((e) => log.error(`定时任务异常: ${e.message}`));\n"
        + '  }, 30000);\n'
        + '  setInterval(() => refreshCustomFaces().catch(() => {}), 30000);';
      return s.replace(from, to);
    },
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M6',
    note: '令牌不复用短哈希（一份语义两份实现）',
    file: 'src/custom-faces.js',
    anchor: /return `\$\{CUSTOM_FACE_TOKEN_PREFIX\}\$\{imageHash\(url\)\}`;/,
    count: 1,
    apply: (s) => s.replace(
      'export function customFaceToken(url) {\n  return `${CUSTOM_FACE_TOKEN_PREFIX}${imageHash(url)}`;\n}',
      'export function customFaceToken(url) {\n'
      + '  let h = 0;\n'
      + '  const str = String(url);\n'
      + "  for (let i = 0; i < str.length; i += 1) h = (h * 31 + str.charCodeAt(i)) >>> 0;\n"
      + "  return `${CUSTOM_FACE_TOKEN_PREFIX}${h.toString(16).padStart(8, '0').slice(0, 8)}`;\n}"
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
];
