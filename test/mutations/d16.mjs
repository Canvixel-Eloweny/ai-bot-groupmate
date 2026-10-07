/**
 * D16（视觉链路 · 报告 E10 ①）的变异清单 —— 纯数据，供
 * `node scripts/mutate.mjs test/mutations/d16.mjs` 复跑。
 *
 * 为什么每一步都要配变异：这一批的每一处判错都**不会报错**，只会安静地给出错误结论 ——
 *   · 测试图不合法 → 服务端 400 → 读成"这个模型没有视觉" → **模型被永久标成瞎子**；
 *   · 把"未能判定"写成 false → 一个其实看得见的模型就此永远静默；
 *   · 能力表与实测脱钩 → 每轮带图然后 400，或者永远看不到群里的图。
 * 所以这一组同时打"图合法"、"三态"、"表与实测一致"三件事。
 *
 *   | 组 | 打的是 | 该由哪一层拦住 |
 *   |---|---|---|
 *   | M1  | 判据层不许长依赖（要能被 smoke 直接喂反例） | check-wb §45 |
 *   | M2  | 顺序：**先核对测试图，再花 API 额度** | check-wb §45 |
 *   | M3  | 尺寸不许退化成 1×1（报告点名的那个坑） | check-wb §45 |
 *   | M4  | 结论三态是封闭枚举 | check-wb §45 |
 *   | M5  | 顺序：**"确定的否定"优先于"未能判定"** | check-wb §45 + smoke |
 *   | M6  | 颜色判据：先判"说错颜色"、再判"没说到" | smoke |
 *   | M7  | 测试图的 CRC 校验被摘掉（"核对过"变成空话） | smoke |
 *   | M8  | 能力表与实测脱钩（把一个看不见的模型标成看得见） | check-wb §45 + smoke |
 *   | M9  | 拒图措辞不许抄第二份（探测与生产各判一次必然分叉） | check-wb §45 |
 *   | M10 | 视频地址不许混进"发给模型的图片" | check-wb §45 + smoke |
 *
 * 期望：十条全部 `BLOCKED`，`INVALID` 为 0。
 *
 * ⚠️ 跑这一批时若看到 `自测异常` 里带 `[safe-delete]`，那是**沙箱的批量删除保护**
 *    在冒充"被拦住"（不是断言失败）—— 必须换**前台 + 非沙箱**复跑同一组再下结论
 *     （D6b / D19 / D15 那几批实测踩过，见 R33/R34/R36）。
 */

export default [
  {
    id: 'M1',
    note: '测试图判据长出依赖（"图合法 / 三态"就没法在 smoke 里逐格喂反例了）',
    file: 'src/vision-probe.js',
    anchor: /^\/\*\* 测试图边长。/m,
    count: 1,
    apply: (s) => s.replace(
      'export const VISION_TEST_SIZE = 32;',
      "import zlib from 'node:zlib'; // 变异：叶子不许有依赖\n\nexport const VISION_TEST_SIZE = 32;"
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M2',
    note: '顺序反了：**先发请求、后核对测试图** —— 不合法的那次请求已经花掉额度，而且结论是错的',
    file: 'scripts/probe-vision.mjs',
    anchor: /  for \(const img of VISION_TEST_IMAGES\) \{/,
    count: 1,
    apply: (s) => {
      const from = s.indexOf('  for (const img of VISION_TEST_IMAGES) {');
      const to = s.indexOf('  const cfg = readCfg();');
      if (from < 0 || to < 0 || to < from) return s; // 锚点不在 → 命中数校验兜住
      const block = s.slice(from, to);
      const rest = s.slice(0, from) + s.slice(to);
      // ⚠️ 必须搬到**请求循环之后**（搬到位居它之前等于没搬 —— 第一次写就是这么假绿的）
      const at = rest.indexOf('  const out = outIdx >= 0 ?');
      if (at < 0) return s;
      return rest.slice(0, at) + block + rest.slice(at);
    },
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M3',
    note: '测试图退化成 1×1（报告点名的坑：服务端判非法 → 模型被永久标成瞎子）',
    file: 'src/vision-probe.js',
    anchor: /export const VISION_TEST_SIZE = 32;/,
    count: 1,
    apply: (s) => s.replace('export const VISION_TEST_SIZE = 32;', 'export const VISION_TEST_SIZE = 1;'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M4',
    note: '结论枚举里多出第四种（调用方的分支没有对应处理，而没人发现）',
    file: 'src/vision-probe.js',
    anchor: /export const VISION_VERDICTS = Object\.freeze\(\['yes', 'no', 'unknown'\]\);/,
    count: 1,
    apply: (s) => s.replace(
      "export const VISION_VERDICTS = Object.freeze(['yes', 'no', 'unknown']);",
      "export const VISION_VERDICTS = Object.freeze(['yes', 'no', 'unknown', 'maybe']);"
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M5',
    note: '顺序反了：「确定的否定」被「未能判定」先接住 —— 能力表就永远拿不到 no',
    file: 'src/vision-probe.js',
    anchor: /  const rejected = entries\.find\(\(\{ color, r \}\) => reject\(/,
    count: 1,
    apply: (s) => {
      const from = s.indexOf('  const rejected = entries.find(({ color, r }) => reject(');
      const to = s.indexOf('  const matched = entries.map(({ color, r }) => colorMatchOf(r.content, color.words));');
      if (from < 0 || to < 0 || to < from) return s;
      const head = s.slice(from, to);
      const rest = s.slice(0, from) + s.slice(to);
      const at = rest.indexOf('  const matched = entries.map(({ color, r }) => colorMatchOf(r.content, color.words));');
      if (at < 0) return s;
      // 把「确定性否定」那一段整体搬到"答了但不对劲"之后
      const after = rest.indexOf('  return {\n    verdict: \'unknown\',\n    evidence: `答了但不对劲');
      if (after < 0) return s;
      const end = rest.indexOf('};\n', after) + 3;
      return rest.slice(0, end) + head + rest.slice(end);
    },
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M6',
    note: '颜色判据顺序写反：把"说成另一种颜色"判成"什么都没答"（答错与没答是两件事）',
    file: 'src/vision-probe.js',
    anchor: /  if \(hitOther && !hitExpected\) return 'wrong';/,
    count: 1,
    apply: (s) => s.replace(
      "  if (hitOther && !hitExpected) return 'wrong';\n  if (hitExpected && !hitOther) return 'right';",
      "  if (!hitExpected) return 'none';\n  if (hitOther) return 'wrong';\n  return 'right';"
    ),
    layer: 'smoke',
    expect: 'BLOCKED',
  },
  {
    id: 'M7',
    note: '测试图的 CRC 校验被摘掉（"我把图读回来核对过了"变成一句空话）',
    file: 'src/vision-probe.js',
    anchor: /    if \(crc32\(Uint8Array\.from\(\[\.\.\.\[\.\.\.type\]\.map\(\(c\) => c\.charCodeAt\(0\)\), \.\.\.body\]\)\) !== want\) \{/,
    count: 1,
    apply: (s) => s.replace(
      '    if (crc32(Uint8Array.from([...[...type].map((c) => c.charCodeAt(0)), ...body])) !== want) {',
      '    if (false) {'
    ),
    layer: 'smoke',
    expect: 'BLOCKED',
  },
  {
    id: 'M8',
    note: '能力表与实测脱钩：把一个**实测看不见**的模型标成 vision: true（每轮带图然后 400）',
    file: 'src/model-caps.js',
    anchor: /  'glm-4\.5-air': \{ functions: true, ms: 408,/,
    count: 1,
    apply: (s) => s.replace(
      "  'glm-4.5-air': { functions: true, ms: 408,",
      "  'glm-4.5-air': { functions: true, vision: true, ms: 408,"
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M9',
    note: '拒图措辞抄了第二份（探测与生产各判一次"像不像拒图"，真机上迟早分叉）',
    file: 'scripts/probe-vision.mjs',
    anchor: /import \{ isVisionRejection \} from '\.\.\/src\/llm\.js';/,
    count: 1,
    apply: (s) => s.replace(
      "import { isVisionRejection } from '../src/llm.js';",
      "const isVisionRejection = (e) => /image_url|multimodal/i.test(String(e?.message ?? '')) && /非法|invalid/i.test(String(e?.message ?? '')); // 变异：抄一份"
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'M10',
    note: '视频地址混进"发给模型的图片"（宣称视频已经能发过去，而这条链路在本架构根本不存在）',
    file: 'src/onebot.js',
    anchor: /      case 'video':\n/,
    count: 1,
    apply: (s) => s.replace(
      "      case 'video':\n        text += '[视频]';",
      "      case 'video':\n        if (/^https?:\\/\\//i.test(String(data.url || data.file || ''))) images.push(String(data.url || data.file));\n        text += '[视频]';"
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
];
