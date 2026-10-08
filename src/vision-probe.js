/**
 * 视觉能力实测 —— 判据与测试图（D16 · 报告 E10 ①）
 * ══════════════════════════════════════════════════════════════════════════
 *  它回答一句话：**这个模型到底看不看得见图**。
 *
 *  ──────────────────────────────────────────────────────────────────────────
 *  为什么不能靠"发一张图看会不会 400"
 *  ──────────────────────────────────────────────────────────────────────────
 *  报告原文点名的坑（0.31 / opt3 都踩过）：**用 1×1 的测试图去探**，
 *  服务端把它判成非法图片，于是返回 400 —— 探测方把"**这张图不合法**"读成了
 *  "**这个模型没有视觉**"，把这个模型**永久**标记成瞎子，而它其实看得见。
 *
 *  所以本模块做两件互相兜底的事：
 *    ① 测试图**自己合成**（32×32 纯色，PNG 规范内最普通的一种），并且**自证可解析** ——
 *       不是"手边找一张图"，而是"构造一张、再按规范读回来核对"；
 *    ② 判据**三态**，且"否定"必须有**确定的证据**（服务端点名图片参数非法）；
 *       其余一律 `unknown` —— **不知道就照实写不知道**（与 `probe-functions.mjs` 同一条纪律）。
 *
 *  ──────────────────────────────────────────────────────────────────────────
 *  为什么两张图（纯红 + 纯绿）
 *  ──────────────────────────────────────────────────────────────────────────
 *  只发一张纯红图，一个**瞎的**模型被问"什么颜色"仍有大概率蒙对（颜色词就那么几个），
 *  于是"蒙对"会被记成"看得见"。两张必须**都对**才算数 —— 蒙对的概率降到个位数百分比以下。
 *  这就是报告里"用 32×32 纯红/纯绿 PNG 实测"的那句话的来历。
 *
 *  ⚠️ **零依赖**：连 `node:zlib` 都不用 —— PNG 的 IDAT 用 **stored（不压缩）deflate 块**，
 *     几十行纯 JS 就能拼出规范内合法的 PNG（见 `pngSolid`）。判据要能被 smoke 直接喂反例，
 *     所以它不碰网络、不读文件、不看时钟。
 *  ⚠️ "这张错误算不算拒绝图片"的**措辞判据不在这里**：那是 `src/llm.js` 的
 *     `isVisionRejection`（唯一实现，D8 就在用）。本模块把它当**入参**收（`isVisionRejection`）——
 *     再抄一份正则就是同一件事的第二份语义，真机上迟早分叉。
 */

/** 测试图边长。**经验值**：32×32 远大于"1×1"那种会被判非法的尺寸，又小到不值得省。 */
export const VISION_TEST_SIZE = 32;

/**
 * 探测结论。**封闭枚举** —— 调用方要按它分支，"随手加一个第四种"必须能被发现。
 *   yes      两张测试图**都答对**（硬证据：它真的看见了）
 *   no       服务端**点名图片参数非法**（确定的否定）
 *   unknown  其余一切（429 / 超时 / 答错 / 答空）——**不写 false 也不写 true**
 */
export const VISION_VERDICTS = Object.freeze(['yes', 'no', 'unknown']);

/** 两道测试题：颜色词按"中文或英文"任一命中即可（模型可能用英文回）。 */
export const VISION_TEST_CASES = Object.freeze([
  Object.freeze({ id: 'red', rgb: Object.freeze([255, 0, 0]), words: Object.freeze(['红', 'red']) }),
  Object.freeze({ id: 'green', rgb: Object.freeze([0, 128, 0]), words: Object.freeze(['绿', 'green']) }),
]);

// ── CRC32 / Adler32：PNG 需要的两个校验和。纯函数，表在首次使用时算出来。 ──────────
let CRC_TABLE = null;
function crcTable() {
  if (CRC_TABLE) return CRC_TABLE;
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  CRC_TABLE = t;
  return t;
}

/** CRC32（PNG 每个 chunk 的尾部校验）。 */
export function crc32(bytes) {
  const t = crcTable();
  let c = 0xffffffff;
  for (const b of bytes) c = t[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Adler32（zlib 流的尾部校验）。 */
function adler32(bytes) {
  let a = 1;
  let b = 0;
  for (const x of bytes) {
    a = (a + x) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

const u32 = (n) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];

/**
 * 把原始字节包成一个 zlib 流，**用 stored（不压缩）块**。
 *
 * 为什么不压缩：压就要 `node:zlib`，而这个模块要保持零依赖（判据要能被 smoke 直接喂反例）。
 * stored 块是 deflate 规范里合法的一种（BTYPE=00），任何解码器都认 —— 代价只是文件大一点，
 * 而 32×32 的图本来就只有几 KB。
 */
function zlibStored(raw) {
  const out = [0x78, 0x01]; // zlib 头：deflate、无预设字典
  const MAX = 65535;
  for (let off = 0; off < raw.length; off += MAX) {
    const chunk = raw.slice(off, off + MAX);
    const last = off + MAX >= raw.length ? 1 : 0;
    out.push(last, chunk.length & 0xff, (chunk.length >> 8) & 0xff);
    const nlen = (~chunk.length) & 0xffff;
    out.push(nlen & 0xff, (nlen >> 8) & 0xff);
    out.push(...chunk);
  }
  if (!raw.length) out.push(1, 0, 0, 0xff, 0xff); // 空输入也要有一个空的终结块
  out.push(...u32(adler32(raw)));
  return Uint8Array.from(out);
}

function chunk(type, data) {
  const typeBytes = [...type].map((c) => c.charCodeAt(0));
  const body = Uint8Array.from([...typeBytes, ...data]);
  return Uint8Array.from([...u32(data.length), ...body, ...u32(crc32(body))]);
}

/**
 * 合成一张 `w×h` 的**纯色** PNG（RGB 真彩、位深 8）。
 *
 * ⚠️ 每行开头那个 0 是 PNG 的 **filter 类型**（0 = None）。漏了它整张图会错位 ——
 *    而且很多解码器仍然"能打开"，只是颜色全乱（这正是"看起来没问题"的假象）。
 *
 * @param {number} w
 * @param {number} h
 * @param {[number,number,number]} rgb
 * @returns {Uint8Array}
 */
export function pngSolid(w, h, rgb) {
  const [r, g, b] = rgb;
  const raw = [];
  for (let y = 0; y < h; y += 1) {
    raw.push(0); // filter: None
    for (let x = 0; x < w; x += 1) raw.push(r, g, b);
  }
  const ihdr = [
    ...u32(w), ...u32(h),
    8,  // 位深
    2,  // 色彩类型 2 = truecolor（RGB）
    0,  // 压缩方法（0 = deflate，规范里只有这一个）
    0,  // 过滤方法（0）
    0,  // 隔行扫描（0 = 不隔行）
  ];
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  return Uint8Array.from([
    ...sig,
    ...chunk('IHDR', ihdr),
    ...chunk('IDAT', zlibStored(raw)),
    ...chunk('IEND', []),
  ]);
}

/**
 * 按规范把一张 PNG **读回来核对**（本模块的自证）。
 *
 * 为什么值得写：探测的整条判据都建立在"这张图是合法的"之上。而不合法的测试图
 * 会让服务端返回 400 —— 那会被判成"模型没有视觉"，把一个看得见的模型**永久**标成瞎子。
 * 所以"图是合法的"不能靠肉眼看着像，要**读回来量**：签名 / IHDR 里的宽高与色彩类型 /
 * IDAT 解出来的原始字节数与"每行 1 字节 filter + w×3 字节像素"**逐字节对账**。
 *
 * @param {Uint8Array} png
 * @returns {{ok:boolean, reason:string, w?:number, h?:number, byteLength?:number}}
 */
export function verifyPng(png) {
  const bytes = png instanceof Uint8Array ? png : Uint8Array.from(png || []);
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 8 || !sig.every((b, i) => bytes[i] === b)) return { ok: false, reason: 'PNG 签名不对' };
  const chunks = [];
  let p = 8;
  while (p + 8 <= bytes.length) {
    const len = (bytes[p] << 24) | (bytes[p + 1] << 16) | (bytes[p + 2] << 8) | bytes[p + 3];
    const type = String.fromCharCode(bytes[p + 4], bytes[p + 5], bytes[p + 6], bytes[p + 7]);
    const body = bytes.slice(p + 8, p + 8 + len);
    const want = ((bytes[p + 8 + len] << 24) | (bytes[p + 9 + len] << 16) | (bytes[p + 10 + len] << 8) | bytes[p + 11 + len]) >>> 0;
    if (crc32(Uint8Array.from([...[...type].map((c) => c.charCodeAt(0)), ...body])) !== want) {
      return { ok: false, reason: `${type} 的 CRC 不对` };
    }
    chunks.push({ type, body: Uint8Array.from(body) });
    p += 12 + len;
  }
  const ihdr = chunks.find((c) => c.type === 'IHDR');
  if (!ihdr || ihdr.body.length !== 13) return { ok: false, reason: '没有 IHDR / IHDR 长度不对' };
  const w = (ihdr.body[0] << 24) | (ihdr.body[1] << 16) | (ihdr.body[2] << 8) | ihdr.body[3];
  const h = (ihdr.body[4] << 24) | (ihdr.body[5] << 16) | (ihdr.body[6] << 8) | ihdr.body[7];
  if (ihdr.body[8] !== 8 || ihdr.body[9] !== 2) return { ok: false, reason: `色彩类型/位深不是 8bit 真彩（${ihdr.body[8]}/${ihdr.body[9]}）` };
  const idat = chunks.filter((c) => c.type === 'IDAT').map((c) => c.body);
  if (!idat.length) return { ok: false, reason: '没有 IDAT' };
  const stream = Uint8Array.from(idat.flatMap((b) => [...b]));
  if (stream[0] !== 0x78) return { ok: false, reason: 'IDAT 不是 zlib 流' };
  // stored 块的原始字节：跳过 2 字节 zlib 头，逐块按 LEN 读，末尾 4 字节是 adler32
  const raw = [];
  let q = 2;
  while (q + 5 <= stream.length - 4) {
    const len = stream[q + 1] | (stream[q + 2] << 8);
    q += 5;
    if (q + len > stream.length - 4) return { ok: false, reason: 'stored 块长度越界' };
    for (let i = 0; i < len; i += 1) raw.push(stream[q + i]);
    q += len;
  }
  const expectBytes = h * (1 + w * 3);
  if (raw.length !== expectBytes) {
    return { ok: false, reason: `IDAT 解出 ${raw.length} 字节，按"每行 1 字节 filter + ${w}×3 像素"应为 ${expectBytes}` };
  }
  if (raw.some((v, i) => i % (1 + w * 3) === 0 && v !== 0)) {
    return { ok: false, reason: '行首的 filter 字节不是 0' };
  }
  return { ok: true, reason: '', w, h, byteLength: bytes.length };
}

/** 一次探测真正发出去的两张图（内存里生成一次，别每轮重算）。 */
export const VISION_TEST_IMAGES = Object.freeze(
  VISION_TEST_CASES.map((c) => Object.freeze({
    id: c.id,
    words: c.words,
    bytes: pngSolid(VISION_TEST_SIZE, VISION_TEST_SIZE, c.rgb),
  }))
);

/** 一张图的探测请求体（`data:` URI，服务端自己去取，不必我们先上传）。 */
export function visionTestBody(id, model) {
  const img = VISION_TEST_IMAGES.find((x) => x.id === id);
  if (!img) return null;
  return {
    model,
    max_tokens: 16,
    // 关掉思考：思考会吃掉 max_tokens，回来的是空的 reasoning_content ——
    // 那会被判成"答不出来"，而它其实只是没答完（`probe-functions` 踩过同款）。
    thinking: { type: 'disabled' },
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: '这张图是什么颜色？只回一个颜色词，不要解释。' },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${base64Of(img.bytes)}` } },
      ],
    }],
  };
}

/** 小工具：Uint8Array → base64（Node 的 Buffer 在这里够用，本模块不做流式）。 */
function base64Of(bytes) {
  return Buffer.from(bytes).toString('base64');
}

/**
 * 单张图：这段回答认没认出来是哪个颜色。
 *
 * 判据刻意**只看颜色词**，且要求"对的出现了、错的没出现"：
 * 一个瞎的模型可能把红说成绿，也可能绕圈子说一句"我看到一张图" —— 后者算没答出来。
 *
 * @returns {'right'|'wrong'|'none'}
 */
export function colorMatchOf(text, words) {
  const s = String(text ?? '').toLowerCase();
  const hit = (w) => s.includes(String(w).toLowerCase());
  const other = VISION_TEST_CASES.find((c) => !c.words.includes(words[0]));
  const hitExpected = words.some(hit);
  const hitOther = !!other && other.words.some(hit);
  // ⚠️ 顺序要紧：**先判"说错颜色"**。反过来的话，"说成另一种颜色"会先被
  //   "没出现期望的颜色词"接住，判成 `none` —— 而它是**答错**，不是没答。
  //   （变异 M6 打的就是这一步：回一个错颜色必须与"回一句废话"区分开。）
  if (hitOther && !hitExpected) return 'wrong';
  if (hitExpected && !hitOther) return 'right';
  return 'none'; // 都没提到，或两种颜色都说到了（纯色图上这属于没答清楚）
}

/**
 * 把**两张图各自的探测结果**合成一个结论。**纯函数**。
 *
 * ⚠️ 判"no"的门槛刻意很高：必须有**确定的否定证据**（服务端点名图片参数非法）。
 *    其余一切（429、超时、答错、答空、网络错误）都是 `unknown` ——
 *    **不许**把"没能判定"写成 false：那份表会被 prompt 侧当"它看不见"用，
 *    于是一个其实看得见的模型会被永久静音掉图像，而界面上只会说"这个模型不能看图"。
 *
 * @param {{red:object, green:object}} perImage 每次的 `{status, ok, content, error}`
 * @param {{isVisionRejection?:(s:string)=>boolean}} [deps] 措辞判据由调用方注入（见文件头）
 * @returns {{verdict:string, evidence:string}}
 */
export function probeVerdictOf(perImage, { isVisionRejection } = {}) {
  const reject = typeof isVisionRejection === 'function' ? isVisionRejection : () => false;
  const entries = VISION_TEST_CASES.map((c) => ({ color: c, r: perImage?.[c.id] || {} }));

  const rejected = entries.find(({ color, r }) => reject(`${r?.error || ''} ${r?.content || ''} ${r?.raw || ''}`));
  if (rejected) {
    return { verdict: 'no', evidence: `服务端返回 ${rejected.r?.status ?? '?'} 且点名图片参数非法` };
  }
  const bad = entries.filter(({ color, r }) => !(r?.ok === true && (r?.status === 200)));
  if (bad.length) {
    return {
      verdict: 'unknown',
      evidence: bad.map(({ color, r }) => `${color.id}: ${r?.error || `HTTP ${r?.status ?? '?'}`}`).join('；'),
    };
  }
  const matched = entries.map(({ color, r }) => colorMatchOf(r.content, color.words));
  if (matched.every((m) => m === 'right')) {
    return { verdict: 'yes', evidence: VISION_TEST_CASES.map((c, i) => `${c.id}=${matched[i]}`).join(' · ') };
  }
  return {
    verdict: 'unknown',
    evidence: `答了但不对劲：${VISION_TEST_CASES.map((c, i) => `${c.id}=${matched[i]}`).join(' · ')}`,
  };
}
