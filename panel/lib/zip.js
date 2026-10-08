/**
 * ZIP 编解码 —— **零第三方依赖**（只用 `node:zlib`），读与写共用同一份 CRC32。
 * ══════════════════════════════════════════════════════════════════════════
 *  为什么自己写（D21 · 报告 E16）
 * ══════════════════════════════════════════════════════════════════════════
 *  整个面板的取舍是"零第三方依赖"（对外只依赖 node 内置）。原实现里已经有一个
 *  **只写不读**的 store 模式打包器（`/api/custom/export` 导 ZIP 用）——
 *  本模块是把它**收进来 + 补上读**，于是：
 *    · 写与读共用**同一份** CRC32 实现（两份必然漂，而漂的表现是"自己打的包自己读不出"）；
 *    · 可以用"**自合成 → 自回读**"做零 fixture 的往返测试（与 D16 的视觉探针同一套路）；
 *    · 跨平台：不依赖宿主有没有 `unzip` 命令 —— 本项目最恨的失败形态就是
 *      "某台机器上少个东西 → 功能静默失效"。
 *
 * ⚠️ 层号：L1（只依赖 `node:zlib` 与 `node:buffer` 内置）。已在 `check-wb` 层次表登记。
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  读侧的边界：**不认识的一律拒绝，绝不猜**
 * ══════════════════════════════════════════════════════════════════════════
 *  ZIP 是个"格式自由度很高"的容器，以下五类**显式拒绝**并给出可操作文案
 *  （宁可让用户重打一次包，也不要把半个包装进用户目录）：
 *    · ZIP64（>4GiB / >65535 条目）—— 扩展包不可能这么大；
 *    · 加密包（通用位 0）—— 我们不处理口令；
 *    · 压缩方式不是 store(0) / deflate(8)；
 *    · 文件名编码认不出（既不是 UTF-8 也不是 GBK）；
 *    · CRC 对不上 / 解压后大小与目录声明不一致（**压缩炸弹**与**损坏包**都在这里被挡）。
 */
import { inflateRawSync } from 'node:zlib';

/* ── 四个上限（三个是**不同的量**，别合并） ──────────────────────────────────
 *  upload 护**内存**（读完就不该超过它）；total / file / entry 护**磁盘与解压**。
 *  ⚠️ 全部是**经验值**：13 个真实扩展包都是文本/代码，量级几十 KB。
 */
/** 上传的 ZIP 本体上限（读进内存前就把它挡住） */
export const ZIP_UPLOAD_MAX = 4 * 1024 * 1024;
/** 解压后**总量**上限 */
export const ZIP_TOTAL_MAX = 16 * 1024 * 1024;
/** 解压后**单个文件**上限 */
export const ZIP_FILE_MAX = 2 * 1024 * 1024;
/** 条目数上限（目录条目也算） */
export const ZIP_ENTRY_MAX = 200;

/** 标准 CRC32（ZIP 每个条目都要）。写侧与读侧**只有这一份**。 */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

export function crc32(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf ?? '');
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i += 1) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * 最小可用的 ZIP 打包（store 模式，不压缩）。
 *
 * 不压缩是有意的 —— 导出/自合成的内容都是文本，压不压差不了多少，
 * 但省掉一整条 deflate 写出路径（读侧仍然支持 deflate，因为别人的包多半是压过的）。
 *
 * @param {Array<{name:string, text:string}>} entries
 * @returns {Buffer}
 */
export function makeZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;

  const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n & 0xffff); return b; };
  const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };

  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const data = Buffer.from(e.text ?? '', 'utf8');
    const crc = crc32(data);
    const local = Buffer.concat([
      u32(0x04034b50), u16(20), u16(0x0800), u16(0), // 标志位 0x800 = 文件名用 UTF-8
      u16(0), u16(0), u32(crc), u32(data.length), u32(data.length),
      u16(nameBuf.length), u16(0), nameBuf,
    ]);
    chunks.push(local, data);

    central.push(Buffer.concat([
      u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(0),
      u16(0), u16(0), u32(crc), u32(data.length), u32(data.length),
      u16(nameBuf.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), nameBuf,
    ]));
    offset += local.length + data.length;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.concat([
    u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length),
    u32(centralBuf.length), u32(offset), u16(0),
  ]);
  return Buffer.concat([...chunks, centralBuf, end]);
}

const EOCD_SIG = 0x06054b50;
const CDH_SIG = 0x02014b50;
const LFH_SIG = 0x04034b50;
/** 通用位：置位 = 文件名是 UTF-8；置位 0 = 加密 */
const FLAG_UTF8 = 0x800;
const FLAG_ENCRYPTED = 0x1;
/** 外部属性高 16 位是 Unix 权限位；0xA000 = 符号链接 */
const S_IFLNK = 0xa000;

/**
 * 解出文件名。**认不出就认不出，不猜**。
 *
 * 真实痛点：本仓扩展包的目录名是中文，而 Windows 上用资源管理器/部分工具打的包
 * 文件名是 **GBK**。置了 UTF-8 位就直接按 UTF-8 解；没置位先按 UTF-8 试，
 * 出现替换字符（U+FFFD = 解错了）再按 GBK 试一次，仍失败就**拒绝整包**
 * 并告诉用户怎么重打 —— 静默把中文名解成乱码，装出来的包在面板上会是一串问号。
 *
 * @returns {string|null} null = 认不出
 */
function decodeName(buf, flags) {
  if (flags & FLAG_UTF8) return buf.toString('utf8');
  const asUtf8 = buf.toString('utf8');
  if (!asUtf8.includes('\uFFFD')) return asUtf8;
  try {
    const asGbk = new TextDecoder('gbk').decode(buf);
    if (!asGbk.includes('\uFFFD')) return asGbk;
  } catch {
    /* 该 Node 构建没有 GBK 解码器 → 走下面的拒绝 */
  }
  return null;
}

/**
 * 读一个 ZIP。**纯内存**（不碰文件系统）—— 于是它能在测试里被逐格喂反例。
 *
 * @param {Buffer|Uint8Array} input
 * @param {{entryMax?:number, fileMax?:number, totalMax?:number}} [opts]
 * @returns {{ok:true, entries:Array<{name:string, data:Buffer, dir:boolean, link:boolean}>}
 *          | {ok:false, error:string}}
 */
export function readZip(input, { entryMax = ZIP_ENTRY_MAX, fileMax = ZIP_FILE_MAX, totalMax = ZIP_TOTAL_MAX } = {}) {
  const b = Buffer.isBuffer(input) ? input : Buffer.from(input ?? []);
  if (b.length < 22) return { ok: false, error: '文件太小，不是一个 ZIP' };

  // EOCD 在**文件尾部**（注释区最长 65535），从后往前找第一条签名。
  let eocd = -1;
  const floor = Math.max(0, b.length - 22 - 0xffff);
  for (let i = b.length - 22; i >= floor; i -= 1) {
    if (b.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) return { ok: false, error: '找不到 ZIP 目录结尾（EOCD）—— 文件可能被截断' };

  const count = b.readUInt16LE(eocd + 10);
  const cdSize = b.readUInt32LE(eocd + 12);
  const cdOffset = b.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    return { ok: false, error: '不支持 ZIP64（请用普通 ZIP 重新打包）' };
  }
  if (count > entryMax) return { ok: false, error: `条目数 ${count} 超过上限 ${entryMax}` };
  if (cdOffset + cdSize > b.length) return { ok: false, error: 'ZIP 中央目录越界 —— 文件可能被截断' };

  const entries = [];
  let total = 0;
  let p = cdOffset;
  for (let i = 0; i < count; i += 1) {
    if (p + 46 > b.length || b.readUInt32LE(p) !== CDH_SIG) {
      return { ok: false, error: `第 ${i + 1} 条中央目录记录不完整` };
    }
    const flags = b.readUInt16LE(p + 8);
    const method = b.readUInt16LE(p + 10);
    const crcExpect = b.readUInt32LE(p + 16);
    const csize = b.readUInt32LE(p + 20);
    const usize = b.readUInt32LE(p + 24);
    const nameLen = b.readUInt16LE(p + 28);
    const extraLen = b.readUInt16LE(p + 30);
    const commentLen = b.readUInt16LE(p + 32);
    const extAttrs = b.readUInt32LE(p + 38);
    const lho = b.readUInt32LE(p + 42);
    const nameBuf = b.subarray(p + 46, p + 46 + nameLen);

    if (flags & FLAG_ENCRYPTED) return { ok: false, error: '带了口令的 ZIP 不支持（请重新打包不带密码）' };
    if (method !== 0 && method !== 8) {
      return { ok: false, error: `不支持的压缩方式 ${method}（只支持 store / deflate）` };
    }
    const name = decodeName(nameBuf, flags);
    if (name === null || !name) {
      return { ok: false, error: '文件名编码认不出（请用 UTF-8 文件名重新打包）' };
    }
    const link = ((extAttrs >>> 16) & 0xffff & 0xf000) === S_IFLNK;
    const dir = name.endsWith('/');

    if (p + 46 + nameLen > b.length) {
      return { ok: false, error: `第 ${i + 1} 条的文件名越界` };
    }
    if (lho + 30 > b.length || b.readUInt32LE(lho) !== LFH_SIG) {
      return { ok: false, error: `第 ${i + 1} 条的本地文件头签名不对` };
    }
    // ⚠️ 只信**中央目录**的长度（本地头在"数据描述符"模式下可能是 0）；
    //    本地头这里只用来算数据的起始偏移。
    const dataStart = lho + 30 + b.readUInt16LE(lho + 26) + b.readUInt16LE(lho + 28);
    if (dataStart + csize > b.length) {
      return { ok: false, error: `第 ${i + 1} 条的数据越界 —— 文件可能被截断` };
    }

    let data = Buffer.alloc(0);
    if (!dir && !link) {
      if (usize > fileMax) {
        return { ok: false, error: `「${name}」解压后 ${usize} 字节，超过单文件上限 ${fileMax}` };
      }
      const raw = b.subarray(dataStart, dataStart + csize);
      try {
        data = method === 8 ? inflateRawSync(raw) : Buffer.from(raw);
      } catch (e) {
        return { ok: false, error: `「${name}」解压失败（${e?.message ?? e}）` };
      }
      // 两道一起才挡得住压缩炸弹：**声明的大小**与**实际解出来的大小**都要对得上。
      if (data.length !== usize) {
        return { ok: false, error: `「${name}」解压后大小与目录声明不一致（声明 ${usize}，实得 ${data.length}）` };
      }
      if (crc32(data) !== crcExpect) {
        return { ok: false, error: `「${name}」CRC 校验失败 —— 包已损坏` };
      }
      total += data.length;
      if (total > totalMax) {
        return { ok: false, error: `解压总量超过上限 ${totalMax} 字节` };
      }
    }

    entries.push({ name, data, dir, link });
    p += 46 + nameLen + extraLen + commentLen;
  }

  return { ok: true, entries };
}
