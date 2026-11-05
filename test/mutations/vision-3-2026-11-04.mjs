/**
 * 识图与发图（B 包识图 3.0 + 双栏紧凑页）定向变异（2026-11-04）。
 *
 * 这一族的形状是"**图交给模型之前有一段准备层，面板又要能改到后端真正读的那个键**"：
 *   `src/vision.js` 的 3 张 / 1.5MB / UA+Referer / 去重 / 回退
 *   → `src/index.js` 的 prepareVisionImages 接线与 dropped trace
 *   → `src/brain.js` 的第 N 张 + 类型优先提示 + 纯图闸门主人豁免
 *   → `src/config.js` 的 60s 默认 + 面板三件套（schema / state-collector / config-route）
 *   → `panel/next/app.js` 的 imagingHtml（必须走 cardsHtml）
 *   → `panel/lib/next-page.js` 的 vision.css 登记。
 * 任何一环退化成"自己写一份 / 绕开唯一入口 / 只改前端"，都不会报错，只会让页面或模型
 * 少看到一点东西 —— 所以每条都必须由 §182 打红。
 *
 * 跑法（串行；会改写真实工作树，失败后用 `--restore`）：
 *   NODE_OPTIONS= node scripts/mutate.mjs test/mutations/vision-3-2026-11-04.mjs
 */

const VIS = 'src/vision.js';
const IDX = 'src/index.js';
const BRAIN = 'src/brain.js';
const IMG = 'src/images.js';
const CFG = 'src/config.js';
const SAFE = 'src/safe-fetch.js';
const SCH = 'panel/next/schema.js';
const APP = 'panel/next/app.js';
const NEXT = 'panel/lib/next-page.js';

export default [
  {
    id: 'V1',
    note: '3 张上限改成 4 张 —— §182① 必须变红（多带一张就多一份请求体与额度）',
    file: VIS,
    anchor: /export const VISION_MAX_IMAGES = 3;/g,
    count: 1,
    apply: (s) => s.replace('export const VISION_MAX_IMAGES = 3;', 'export const VISION_MAX_IMAGES = 4;'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'V2',
    note: '删掉图片 Referer —— §182② 必须变红（QQ 图床回 403，日志只看到"下载失败"）',
    file: VIS,
    anchor: /Referer: 'https:\/\/im\.qq\.com\/',/g,
    count: 1,
    apply: (s) => s.replace("Referer: 'https://im.qq.com/',", "Referer: '',"),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'V3',
    note: 'sha256 去重失效（两处都换成 if (false)）—— §182① 必须变红（同一张图重复占上下文）',
    file: VIS,
    anchor: /if \(seenBytes\.has\(key\)\) continue;/g,
    count: 2,
    apply: (s) => s.replace(/if \(seenBytes\.has\(key\)\) continue;/g, 'if (false) continue;'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'V4',
    note: '单张失败不再回退原 URL（6 处 push 全删）—— §182① 必须变红（一张下载失败就把图从上下文里抹掉）',
    file: VIS,
    anchor: /images\.push\(raw\);/g,
    count: 6,
    apply: (s) => s.replace(/images\.push\(raw\);/g, 'void 0;'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'V5',
    note: '看图提示词退回"一两句话描述" —— §182⑥ 必须变红（模型不再先判类型/逐项核对）',
    file: IMG,
    anchor: /先判断这是什么类型的图（照片\/截图\/表情包\/聊天记录\/文档\/商品图等），再按顺序回答四件事：/g,
    count: 1,
    apply: (s) => s.replace(
      '先判断这是什么类型的图（照片/截图/表情包/聊天记录/文档/商品图等），再按顺序回答四件事：',
      '用一两句话描述这张图里有什么（人、物、文字、明显的气氛）。',
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'V6',
    note: '纯图宽限默认改回 300000 —— §182⑦ 必须变红（宽限期又变成 5 分钟）',
    file: CFG,
    anchor: /bareGraceMs: Math\.max\(0, asInt\(raw\.trigger\?\.bareGraceMs, 60000\)\),/g,
    count: 1,
    apply: (s) => s.replace(
      'bareGraceMs: Math.max(0, asInt(raw.trigger?.bareGraceMs, 60000)),',
      'bareGraceMs: Math.max(0, asInt(raw.trigger?.bareGraceMs, 300000)),',
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'V7',
    note: '删掉纯图闸门的主人豁免 —— §182⑤ 必须变红（主人刚说过话再发图会被装死）',
    file: BRAIN,
    anchor: /!isOwner\(evt\.user_id, this\.cfg\.owner\?\.qq \|\| \[\]\)/g,
    count: 1,
    apply: (s) => s.replace('!isOwner(evt.user_id, this.cfg.owner?.qq || [])', 'true'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'V8',
    note: '把识图总开关搬回模型页（留着识图页那份）—— §182⑧ 必须变红（两份开关互相覆盖）',
    file: SCH,
    anchor: /识图总开关已移到 <b>发言 → 识图与发图<\/b>/g,
    count: 1,
    apply: (s) => s.replace(
      "{ t: 'note', text: '识图总开关已移到 <b>发言 → 识图与发图</b>（与模型能力表同源）。这一页只留联网查询，不做两份副本。' },",
      "{ t: 'featSwitch', feat: 'vision', label: '识图', hint: '重复开关', when: (s) => customFeatureVisible(s, 'vision') },\n"
        + "              { t: 'note', text: '识图总开关已移到 <b>发言 → 识图与发图</b>（与模型能力表同源）。这一页只留联网查询，不做两份副本。' },",
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'V9',
    note: '纯图宽限从 bindSys 改成 bind —— §182⑧ 必须变红（会写进 custom，后端读不到）',
    file: SCH,
    anchor: /bindSys: 'bareGraceMs'/g,
    count: 1,
    apply: (s) => s.replace("bindSys: 'bareGraceMs'", "bind: 'trigger.bareGraceMs'"),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'V10',
    note: '自定义识图页不再走 cardsHtml —— §182⑨ 必须变红（用户隐藏的卡会在这一页复活）',
    file: APP,
    anchor: /cardsHtml\((?:left|right)\)/g,
    count: 2,
    apply: (s) => s.replace(/cardsHtml\((?:left|right)\)/g, "''"),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'V11',
    note: 'vision.css 从 NEXT_ASSETS 摘掉 —— §182⑩ 与 §58 双向比对必须变红（页面 404）',
    file: NEXT,
    anchor: /'vision\.css': 'text\/css; charset=utf-8',/g,
    count: 1,
    apply: (s) => s.replace("  'vision.css': 'text/css; charset=utf-8',\n", ''),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'V12',
    note: 'index.js 不再把 dropped 接进 parsed —— §182④ 必须变红（trace 看不到哪张没内联）',
    file: IDX,
    anchor: /parsed\.visionDropped = preparedVision\.dropped;/g,
    count: 1,
    apply: (s) => s.replace('      parsed.visionDropped = preparedVision.dropped;\n', ''),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'V13',
    note: 'safeFetch 不再把 headers 传给每一跳 —— §182③ 必须变红（图片头只对首跳生效）',
    file: SAFE,
    anchor: /\.\.\.\(headers \? \{ headers \} : \{\}\),/g,
    count: 1,
    apply: (s) => s.replace('      ...(headers ? { headers } : {}),\n', ''),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'V14',
    note: 'index.js 调 safeFetch 时不再带图片头 —— §182④ 必须变红（headers 定义了但没交给网络）',
    file: IDX,
    anchor: /headers: VISION_FETCH_HEADERS/g,
    count: 1,
    apply: (s) => s.replace('headers: VISION_FETCH_HEADERS', 'headers: {}'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
];
