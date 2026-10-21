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
  '用一两句话描述这张图里有什么（人、物、文字、明显的气氛）。看不清就直接说看不清，别猜、别编。';
