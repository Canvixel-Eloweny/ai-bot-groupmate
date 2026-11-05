/**
 * 图片的**判据**（纯函数、零 IO）：地址归类、格式嗅探、段构造。
 *
 * 为什么单独一个叶子：发图 / 看图两条链都要判「这是不是一个能用的图」，
 * 而判据一旦写两份，迟早出现"发得出去、看不了"这种两个口各说一套的情况。
 * 真正的网络与文件读取在 `index.js` 的两个工具执行器里（`toolSendImage` / `toolViewImage`），
 * 这里只做纯计算 —— 于是它可以在 smoke / check 里被直接钉住。
 *
 * ⚠️ 远端的图**一律先下载**再以 `base64://` 交给协议端，理由有两条：
 *   ① 协议端去抓任意 URL 等于把"它能被拿来当跳板"这件事交给对面；
 *   ② 下载走 `safeFetch`（逐跳重校验、私网地址拒绝、超时有上限），
 *      于是"发一张内网地址"这类请求当场被拦，而不是悄悄发出去。
 */

/** 一张图的字节上限（经验值）：够一张手机截图，又不会把 base64 撑爆内存 */
export const IMAGE_MAX_BYTES = 8 * 1024 * 1024;

/**
 * **主链路内联**时的一张图上限（2026-11-03），比 `IMAGE_MAX_BYTES` 小一档。
 *
 * 两个上限不是一回事：`view_image` 是"工具按需拉一张来看"，8MB 无所谓；
 * 主链路是把图**编进这一次请求的 body**，base64 还要再胀 1/3 ——
 * 三张 8MB 的原图会直接把一次模型请求撑到 30MB 以上。
 * 1.5MB 的定标依据：QQ 群里绝大多数截图/表情包在 300KB–1.2MB 之间，
 * 超出的按"原样交 URL + 交给 llm 层既有重试"降级，不因为一张大图整轮失败。
 */
export const VISION_INLINE_MAX_BYTES = 1_500_000;

/**
 * 带图片段的请求，输出额度**下限**（2026-10-23）。
 *
 * 真机反馈的旧症状：`max_tokens` 只有 150 / 400 时，视觉模型把额度花在
 * 图像编码 / 思考上，正文返回空 —— 群友的绕过办法是"手动调到 700"。
 * 这类洞不该让用户自己调：主链路默认 1200 不受影响，但 `view_image` 旁路
 * 曾经只给 400，所以这里定一个统一下限，由 `llm.js` 的 `#chatOnce` 兜住
 * **所有带图的请求**（主链路 / 看图工具 / 工具回合 / length 重试）。
 *
 * 700 是**经验值**：够一段正常描述，又不会让每次看图都烧掉一大笔。
 */
export const VISION_MIN_MAX_TOKENS = 700;

/** 认得的图片扩展名（本地路径用） */
const IMAGE_EXTS = Object.freeze(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp']);

/** 按字节头嗅探 MIME。认不出返回空串 —— **不猜** */
export function imageMimeOf(buf) {
  const b = buf;
  if (!b || b.length < 4) return '';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46) return 'image/webp';
  if (b[0] === 0x42 && b[1] === 0x4d) return 'image/bmp';
  return '';
}

/**
 * 把参数归类成三种来源之一。**不碰网络、不碰磁盘**。
 *
 * @param {string} raw 模型给的 url / 本地路径 / 已经带协议的 base64
 * @returns {{ok:true, kind:'url'|'file'|'base64', value:string} | {ok:false, reason:string}}
 */
export function classifyImageArg(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return { ok: false, reason: '没给图片地址' };
  if (s.length > 2000) return { ok: false, reason: '地址太长（超过 2000 字）' };
  if (/^https?:\/\//i.test(s)) return { ok: true, kind: 'url', value: s };
  if (/^base64:\/\//i.test(s)) return { ok: true, kind: 'base64', value: s.slice('base64://'.length) };
  if (/^[a-zA-Z]:[\\/]/.test(s) || s.startsWith('/') || s.startsWith('\\\\')) {
    return { ok: true, kind: 'file', value: s };
  }
  return { ok: false, reason: '只认 http(s) 地址、绝对路径或 base64://' };
}

/**
 * 本地路径的扩展名像不像图。只用来**提前给一句人话**，
 * 真正的判据是下载/读文件之后的字节嗅探（`imageMimeOf`）。
 */
export function looksLikeImagePath(p) {
  const m = /\.([a-zA-Z0-9]{2,5})$/.exec(String(p ?? '').trim());
  return !!m && IMAGE_EXTS.includes(m[1].toLowerCase());
}

/**
 * 交给协议端的图片段 `file` 值。OneBot v11 的 CQ 码约定：
 * 二进制走 `base64://`，协议端自己解码 —— 这样本地路径与远端 URL 都只留一份实现。
 *
 * @param {Buffer} bytes
 * @returns {string}
 */
export function imageFileOf(bytes) {
  return `base64://${Buffer.from(bytes).toString('base64')}`;
}

/**
 * 看图工具的问法。写成常量而不是散在调用点：改措辞只改这一处。
 */
export const VIEW_IMAGE_PROMPT =
  '先判断这是什么类型的图（照片/截图/表情包/聊天记录/文档/商品图等），再按顺序回答四件事：'
  + '① 图里最显眼的是什么；② 有没有文字，有就逐字读出来；③ 人物/动物/物品各在做什么；'
  + '④ 整体气氛或用途是什么。看不清的地方直接说看不清，别猜、别编。';
