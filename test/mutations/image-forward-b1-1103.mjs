/**
 * 批 B1（图片链路）定向变异（2026-11-03）。
 *
 * 修的是两条"我们看得见、模型看不见"的缺陷：
 *   ① 合并转发**节点里的图片**整段丢弃 —— renderNode 只取 `.text`，
 *      flattenMessage 收好的 images 没人接 ⇒ 转发的截图她只看到一串「[图片]」。
 *   ② 入站图片把 QQ 的**带签名、会过期**临时 URL 原样交给模型 ⇒ 服务端取不到，
 *      DeepSeek 这类兼容端直接 400；而 `view_image` 工具一直是内联的，主链路漏了。
 *
 * §133 以前只钉到"采集得到图"（①群图允许根 ②引用取数），没钉"交出去的是字节"，
 * 也没钉"节点里的图有人接" —— 所以这两条能一路绿到发布。下面每条打在新判据上。
 *
 * 跑法（串行；会改写真实工作树，失败后用 `--restore`）：
 *   NODE_OPTIONS= node scripts/mutate.mjs test/mutations/image-forward-b1-1103.mjs
 */

const IDX = 'src/index.js';
const IMG = 'src/images.js';
const VIS = 'src/vision.js';

export default [
  {
    id: 'F1',
    note: 'renderNode 退回只取 .text —— §133⑩ 必须变红（转发节点里的图又整段丢掉）',
    file: IDX,
    anchor: /for \(const u of flat\.images \|\| \[\]\) forwardImages\.push\(u\);/g,
    count: 1,
    apply: (s) => s.replace('      for (const u of flat.images || []) forwardImages.push(u);\n', ''),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'F2',
    note: '收集到的图不并进 parsed.images —— §133⑩ 必须变红（收了等于没收，brain 只看 parsed.images）',
    file: IDX,
    anchor: /parsed\.images = \[\.\.\.new Set\(\[\.\.\.\(parsed\.images \|\| \[\]\), \.\.\.forward\.images\]\)\]\.slice\(0, 3\);/g,
    count: 1,
    apply: (s) => s.replace(
      'parsed.images = [...new Set([...(parsed.images || []), ...forward.images])].slice(0, 3);',
      'parsed.text = parsed.text;',
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'F3',
    note: '引用「一条聊天记录」不再展第二层 —— §133⑩/⑪ 必须变红（引用转发的正文与图照旧看不见）',
    file: IDX,
    anchor: /const qf = await expandForwardText\(\{ message: qMsg, message_id: parsed\.replyTo, self_id: evt\.self_id \}\);/g,
    count: 1,
    apply: (s) => s.replace(
      "const qf = await expandForwardText({ message: qMsg, message_id: parsed.replyTo, self_id: evt.self_id });\n          const qp = flattenMessage(qMsg, selfId, { probe: false, forwardText: qf.text });",
      'const qp = flattenMessage(qMsg, selfId, { probe: false });',
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'F4',
    note: '识图准备层写了但主链路不叫 —— §133⑨ / §182④ 必须变红（本项目头号形状：定义了 ≠ 生效了）',
    file: IDX,
    anchor: /const preparedVision = await prepareVisionImages\(\{ list: parsed\.images, imageBytesOf, log \}\);/g,
    count: 1,
    apply: (s) => s.replace(
      '      const preparedVision = await prepareVisionImages({ list: parsed.images, imageBytesOf, log });\n',
      '      const preparedVision = { images: parsed.images, dropped: [] };\n',
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'F5',
    note: '单张下载失败就把这张图抹掉 —— §133⑨ / §182① 必须变红（fail-open 变 fail-drop，图从上下文消失）',
    file: VIS,
    anchor: /images\.push\(raw\);/g,
    count: 6,
    apply: (s) => s.replace(/images\.push\(raw\);/g, 'void 0;'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'F6',
    note: '内联上限退回 view_image 的 8MB —— §133⑨ 必须变红（三张大图把一次请求的 body 撑爆）',
    file: IMG,
    anchor: /export const VISION_INLINE_MAX_BYTES = 1_500_000;/g,
    count: 1,
    apply: (s) => s.replace('export const VISION_INLINE_MAX_BYTES = 1_500_000;', 'export const VISION_INLINE_MAX_BYTES = 8_000_000;'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
];
