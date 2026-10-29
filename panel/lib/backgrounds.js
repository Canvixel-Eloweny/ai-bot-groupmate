/**
 * 自定义背景的服务端存储（2026-10-28 · 0.1.5 接口收尾）。
 *
 * 之前这块只有浏览器 IndexedDB：换浏览器就丢，视频还会被 CSP（media-src 'self'）拦掉。
 * 这里把「文件 + 索引」放到用户数据目录，页面只拿同源 URL，CSP 不用放宽。
 *
 * 三条纪律：
 *   ① 只信魔数，不信 Content-Type / 扩展名 / 文件名；文件名由服务端 id 派生。
 *   ② 所有索引变更走同一个 promise 队列，读-改-写在锁内完成；索引损坏 fail-closed。
 *   ③ 媒体文件先写临时文件，嗅探通过后再 rename；索引写失败要删掉媒体回滚。
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { writeJsonAtomic } from '../../src/atomic-write.js';

export const BG_LIMITS = Object.freeze({
  image: 8 * 1024 * 1024,
  video: 24 * 1024 * 1024,
  display: 2 * 1024 * 1024,
  items: 50,
  totalBytes: 512 * 1024 * 1024,
});

/** 格式白名单：扩展名是服务端写死的，用户输入永远不会进入路径。 */
const FORMATS = Object.freeze({
  png: { type: 'image', mime: 'image/png' },
  jpg: { type: 'image', mime: 'image/jpeg' },
  gif: { type: 'image', mime: 'image/gif' },
  webp: { type: 'image', mime: 'image/webp' },
  avif: { type: 'image', mime: 'image/avif' },
  bmp: { type: 'image', mime: 'image/bmp' },
  mp4: { type: 'video', mime: 'video/mp4' },
  webm: { type: 'video', mime: 'video/webm' },
});

const ID_RE = /^bg-\d{10,}-[a-f0-9]{8}$/;
const NAME_MAX = 80;
const SOURCE_MAX = 80;
const REV_MAX = 64;

function fail(message, status = 400) {
  const e = new Error(message);
  e.status = status;
  throw e;
}

function ascii(buf, start, end) {
  return buf.slice(start, end).toString('latin1');
}

function normalizeCrop(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const zoom = Number(src.zoom);
  const x = Number(src.x);
  const y = Number(src.y);
  return {
    zoom: Number.isFinite(zoom) ? Math.max(1, Math.min(2.6, zoom)) : 1,
    x: Number.isFinite(x) ? Math.max(-1, Math.min(1, x)) : 0,
    y: Number.isFinite(y) ? Math.max(-1, Math.min(1, y)) : 0,
  };
}

/** 只认魔数。SVG / MOV / MKV / OGV 明确拒绝：前两者可带脚本或容器复杂。 */
export function sniffBackground(input) {
  const b = Buffer.isBuffer(input) ? input : Buffer.from(input || []);
  if (b.length < 12) return null;

  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47
    && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) {
    return { type: 'image', format: 'png', mime: FORMATS.png.mime };
  }
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    return { type: 'image', format: 'jpg', mime: FORMATS.jpg.mime };
  }
  const six = ascii(b, 0, 6);
  if (six === 'GIF87a' || six === 'GIF89a') {
    return { type: 'image', format: 'gif', mime: FORMATS.gif.mime };
  }
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP') {
    return { type: 'image', format: 'webp', mime: FORMATS.webp.mime };
  }
  if (b[0] === 0x42 && b[1] === 0x4d) {
    return { type: 'image', format: 'bmp', mime: FORMATS.bmp.mime };
  }

  if (ascii(b, 4, 8) === 'ftyp') {
    const brands = [];
    const end = Math.min(b.length, 8 + 4 * 12);
    for (let off = 8; off + 4 <= end; off += 4) brands.push(ascii(b, off, off + 4).trim());
    if (brands.includes('avif') || brands.includes('avis')) {
      return { type: 'image', format: 'avif', mime: FORMATS.avif.mime };
    }
    if (brands.some((x) => ['isom', 'iso2', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42', 'avc1', 'dash', 'MSNV', 'M4V', 'mmp4'].includes(x))) {
      return { type: 'video', format: 'mp4', mime: FORMATS.mp4.mime };
    }
    // MOV（brand `qt  `）与未知 ftyp 一律拒绝：浏览器支持不稳定，且没有广告过。
    return null;
  }

  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) {
    const head = b.slice(0, Math.min(b.length, 256)).toString('latin1');
    if (/webm/i.test(head)) return { type: 'video', format: 'webm', mime: FORMATS.webm.mime };
    // MKV 也是 EBML，但没有宣传过；不猜。
    return null;
  }
  return null;
}

export function sanitizeBackgroundName(raw, fallback = '未命名素材') {
  let s = String(raw == null ? '' : raw)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[\\/]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  s = s.replace(/\.[A-Za-z0-9]{1,8}$/, '').trim();
  if (!s) s = fallback;
  return s.slice(0, NAME_MAX);
}

export function isBackgroundId(id) {
  return ID_RE.test(String(id == null ? '' : id));
}

function displayFilePath(dir, id) {
  return path.join(dir, `${id}.display.jpg`);
}

function originalFilePath(dir, id, format) {
  const f = FORMATS[format];
  if (!f) fail(`不认识的背景格式：${format}`, 415);
  if (!isBackgroundId(id)) fail('背景 id 不合法', 400);
  return path.join(dir, `${id}.${format}`);
}

function normalizeDisplay(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const bytes = Number(raw.bytes);
  if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > BG_LIMITS.display) return null;
  const rev = typeof raw.rev === 'string' && raw.rev ? raw.rev.slice(0, REV_MAX) : '0';
  return { bytes, rev, crop: normalizeCrop(raw.crop) };
}

function normalizeItem(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const id = String(raw.id == null ? '' : raw.id);
  if (!isBackgroundId(id)) return null;
  const format = String(raw.format == null ? '' : raw.format).toLowerCase();
  const f = FORMATS[format];
  if (!f || f.type !== raw.type) return null;
  const bytes = Number(raw.bytes);
  if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > BG_LIMITS[raw.type]) return null;
  const createdAt = Number.isFinite(Number(raw.createdAt)) ? Number(raw.createdAt) : 0;
  const rev = typeof raw.rev === 'string' && raw.rev ? raw.rev.slice(0, REV_MAX) : String(createdAt || 0);
  const item = {
    id,
    type: f.type,
    format,
    name: sanitizeBackgroundName(raw.name),
    bytes,
    createdAt,
    rev,
  };
  if (typeof raw.sourceKey === 'string' && raw.sourceKey) item.sourceKey = raw.sourceKey.slice(0, SOURCE_MAX);
  const display = normalizeDisplay(raw.display);
  if (display) item.display = display;
  return item;
}

function publicItem(item) {
  const base = '/api/backgrounds/media';
  const q = `id=${encodeURIComponent(item.id)}`;
  const url = `${base}?${q}&v=original&rev=${encodeURIComponent(item.rev)}`;
  const displayUrl = item.display
    ? `${base}?${q}&v=display&rev=${encodeURIComponent(item.display.rev)}`
    : url;
  return {
    id: item.id,
    type: item.type,
    name: item.name,
    format: item.format,
    bytes: item.bytes,
    createdAt: item.createdAt,
    crop: item.display ? item.display.crop : null,
    url,
    displayUrl,
  };
}

function statsFrom(index) {
  let totalBytes = 0;
  for (const it of index.items) totalBytes += (it.bytes || 0) + (it.display?.bytes || 0);
  return { items: index.items.length, totalBytes };
}

/**
 * @param {{dir:string, now?:()=>number, logger?:{warn?:Function}}} opts
 */
export function createBackgroundStore({ dir, now = Date.now, logger = null } = {}) {
  if (!dir) throw new Error('背景存储必须给 dir');
  const indexFile = path.join(dir, 'index.json');
  let cached = null;
  let queue = Promise.resolve();
  const warn = (msg) => { try { logger?.warn?.(msg); } catch { /* 日志失败不影响存储 */ } };

  function emptyIndex() {
    return { version: 1, activeId: null, items: [] };
  }

  function normalizeIndex(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      fail('背景索引损坏（顶层不是对象）—— 请检查 data/backgrounds/index.json', 500);
    }
    const items = [];
    for (const it of Array.isArray(raw.items) ? raw.items : []) {
      const n = normalizeItem(it);
      if (n) items.push(n);
      else warn('背景索引里有一条无法识别，已跳过');
    }
    const activeId = typeof raw.activeId === 'string' && items.some((x) => x.id === raw.activeId)
      ? raw.activeId
      : null;
    return { version: 1, activeId, items };
  }

  function load() {
    if (cached) return cached;
    try {
      cached = normalizeIndex(JSON.parse(fs.readFileSync(indexFile, 'utf8')));
    } catch (e) {
      if (e && e.code === 'ENOENT') cached = emptyIndex();
      else if (e && e.status) throw e;
      else fail(`背景索引读取失败：${e.message}`, 500);
    }
    return cached;
  }

  function save(next) {
    fs.mkdirSync(dir, { recursive: true });
    writeJsonAtomic(indexFile, next);
    cached = next;
  }

  function withLock(fn) {
    const run = queue.then(fn, fn);
    queue = run.then(() => {}, () => {});
    return run;
  }

  function newId() {
    return `bg-${now()}-${randomBytes(4).toString('hex')}`;
  }

  function newRev() {
    return `${now()}-${randomBytes(3).toString('hex')}`;
  }

  function list() {
    const index = load();
    return {
      activeId: index.activeId,
      limits: BG_LIMITS,
      items: index.items.map(publicItem),
    };
  }

  function stats() {
    return statsFrom(load());
  }

  function get(id) {
    const index = load();
    const item = index.items.find((x) => x.id === id);
    return item ? { id: item.id, type: item.type, format: item.format } : null;
  }

  /**
   * @param {{format:string,type:string,name:string,bytes:number,sourceKey?:string,
   *          saveFile:(abs:string)=>void|Promise<void>}} opts
   */
  async function add({ format, type, name, bytes, sourceKey = '', saveFile } = {}) {
    return withLock(async () => {
      const index = load();
      const key = typeof sourceKey === 'string' ? sourceKey.slice(0, SOURCE_MAX) : '';
      if (key) {
        const hit = index.items.find((x) => x.sourceKey === key);
        if (hit) return { item: publicItem(hit), deduped: true };
      }
      const f = FORMATS[format];
      if (!f || f.type !== type) fail('不支持的背景格式', 415);
      if (!Number.isSafeInteger(bytes) || bytes <= 0) fail('背景文件为空', 400);
      if (bytes > BG_LIMITS[type]) {
        fail(`${type === 'video' ? '视频' : '图片'}超过 ${Math.round(BG_LIMITS[type] / 1024 / 1024)} MB`, 413);
      }
      const st = statsFrom(index);
      if (st.items >= BG_LIMITS.items) fail(`最多只能放 ${BG_LIMITS.items} 个背景`, 413);
      if (st.totalBytes + bytes > BG_LIMITS.totalBytes) {
        fail(`背景总大小超过 ${Math.round(BG_LIMITS.totalBytes / 1024 / 1024)} MB`, 413);
      }
      if (typeof saveFile !== 'function') throw new Error('背景存储缺少 saveFile');

      const id = newId();
      const abs = originalFilePath(dir, id, format);
      await saveFile(abs);
      const item = {
        id,
        type: f.type,
        format,
        name: sanitizeBackgroundName(name),
        bytes,
        createdAt: now(),
        rev: newRev(),
      };
      if (key) item.sourceKey = key;
      const next = { ...index, items: [...index.items, item] };
      try {
        save(next);
      } catch (e) {
        try { fs.rmSync(abs, { force: true }); } catch { /* 回滚失败交给人工 */ }
        throw e;
      }
      return { item: publicItem(item), deduped: false };
    });
  }

  /**
   * @param {{id:string,bytes:number,crop:object,saveFile:(abs:string)=>void|Promise<void>}} opts
   */
  async function setDisplay({ id, bytes, crop, saveFile } = {}) {
    return withLock(async () => {
      const index = load();
      const item = index.items.find((x) => x.id === id);
      if (!item) fail('背景不存在', 404);
      if (item.type !== 'image') fail('只有图片能调整画面', 400);
      if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > BG_LIMITS.display) {
        fail(`裁切图超过 ${Math.round(BG_LIMITS.display / 1024 / 1024)} MB`, 413);
      }
      if (typeof saveFile !== 'function') throw new Error('背景存储缺少 saveFile');
      const abs = displayFilePath(dir, id);
      await saveFile(abs);
      const display = { bytes, rev: newRev(), crop: normalizeCrop(crop) };
      const next = {
        ...index,
        items: index.items.map((x) => (x.id === id ? { ...x, display } : x)),
      };
      try {
        save(next);
      } catch (e) {
        try { fs.rmSync(abs, { force: true }); } catch { /* 回滚失败交给人工 */ }
        throw e;
      }
      return { item: publicItem({ ...item, display }) };
    });
  }

  async function setActive(id) {
    return withLock(() => {
      const index = load();
      let activeId = null;
      if (id != null && id !== '') {
        if (!index.items.some((x) => x.id === id)) fail('背景不存在', 404);
        activeId = String(id);
      }
      save({ ...index, activeId });
      return activeId;
    });
  }

  async function remove(id) {
    return withLock(() => {
      const index = load();
      const item = index.items.find((x) => x.id === id);
      if (!item) fail('背景不存在', 404);
      const activeId = index.activeId === id ? null : index.activeId;
      save({ ...index, activeId, items: index.items.filter((x) => x.id !== id) });
      try { fs.rmSync(originalFilePath(dir, item.id, item.format), { force: true }); } catch { /* 文件被占用时留给人工/清扫 */ }
      if (item.display) {
        try { fs.rmSync(displayFilePath(dir, item.id), { force: true }); } catch { /* 同上 */ }
      }
      return { activeId };
    });
  }

  function media(id, variant = 'original') {
    const index = load();
    const item = index.items.find((x) => x.id === id);
    if (!item) fail('背景不存在', 404);
    const v = variant === 'display' ? 'display' : 'original';
    if (v === 'display' && !item.display) fail('这个背景还没有裁切图', 404);
    const abs = v === 'display'
      ? displayFilePath(dir, item.id)
      : originalFilePath(dir, item.id, item.format);
    const type = v === 'display' ? 'image/jpeg' : FORMATS[item.format].mime;
    return { abs, type, variant: v, item: publicItem(item) };
  }

  function tmpPathFor(kind = 'upload') {
    return path.join(dir, `.${kind}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  }

  return { list, stats, get, add, setDisplay, setActive, remove, media, tmpPathFor, indexFile };
}
