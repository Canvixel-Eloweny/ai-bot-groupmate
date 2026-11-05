/**
 * 扩展包的**按包隔离**小 KV 存储（2026-11-03）。
 *
 * ── 它补的是哪个洞 ──
 * `storage` 一直挂在 `src/plugin-api.js` 的 `PERMISSION_NAMES` 里，也被写进
 * 给作者看的创作提示词（`src/extension-create-prompt.js`），但**宿主从来没有实现**。
 * 于是按文档写的包一调 `api.storage.get(k)` 就 `Cannot read properties of undefined` ——
 * 报错指向"这个包写错了"，而真正名实不符的是宿主自己。
 * 这类"权限白名单先于实现存在"的形状，本项目已经清掉过不止一次。
 *
 * ── 三条边界（都不是可选项）──
 * ① **按包隔离**：一个包读不到另一个包写的键。落盘是 `<dir>/<pkgId>.json` 一文件一包，
 *    所以越界在物理上就不成立，不需要"运行时判 owner"那种会漂的软约束。
 * ② **键不许含路径分隔符**：包名叫 `../x` 或键名叫 `a/../../b` 都不能变成第二个写盘点。
 *    id 用 `plugin-manifest.js` 的那一份判据（不抄第二份），键在这里判。
 * ③ **总量封顶**：这是给"记几笔状态"用的，不是数据库。超限直接拒并说清楚，
 *    而不是让一个坏包把用户磁盘写满。
 *
 * ⚠️ 写盘走 `atomic-write.js` 的 `writeJsonAtomic`（与全项目同一条落盘纪律：
 *    tmp + rename，崩溃不留半截 JSON）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from './atomic-write.js';
import { isValidPluginId } from './plugin-manifest.js';

/** 单个包的存储上限（字节，序列化后）。经验值：够几百条短状态，不够当数据库。 */
const EXT_STORAGE_MAX_BYTES = 256 * 1024;

/** 键名上限（字符）。 */
const EXT_STORAGE_KEY_MAX = 64;

/**
 * 这个键名能不能用（**纯函数**，便于直接喂反例）。
 *
 * 允许 `.`（点号分层的键是生态写法，如 `stats.today`），
 * 但**拒绝任何路径分隔符与 `..`** —— 否则键名就成了第二个路径拼接点。
 */
function isSafeStorageKey(k) {
  const s = String(k ?? '');
  if (!s || s.length > EXT_STORAGE_KEY_MAX) return false;
  if (s.includes('/') || s.includes('\\')) return false;
  if (s.includes('..')) return false;
  if (/[\0-\u001f]/.test(s)) return false;
  return true;
}

/**
 * 建一个存储门面。
 *
 * @param {{dir:string, maxBytes?:number, log?:object}} o
 * @returns {{get:Function,set:Function,remove:Function,keys:Function,fileOf:Function}}
 */
export function createExtStorage({ dir, maxBytes = EXT_STORAGE_MAX_BYTES, log } = {}) {
  const root = String(dir ?? '');
  const warn = (m) => { try { log?.warn?.(m); } catch { /* 日志不该把包带崩 */ } };

  function fileOf(id) {
    const pid = String(id ?? '');
    // id 判据复用 `plugin-manifest.js` 那一份（这里不抄第二张正则表）。
    if (!root || !isValidPluginId(pid)) return '';
    return path.join(root, `${pid}.json`);
  }

  function readMap(id) {
    const f = fileOf(id);
    if (!f) return null;
    try {
      if (!fs.existsSync(f)) return {};
      const o = JSON.parse(fs.readFileSync(f, 'utf8'));
      return (o && typeof o === 'object' && !Array.isArray(o)) ? o : null;
    } catch {
      // 半截/坏 JSON：不当成"没有数据"（那会让包以为状态被清空了），
      // 也不硬写覆盖（那会毁掉可能还能人工救的内容）。报出来，让这一笔操作明确失败。
      warn(`扩展包「${id}」的存储文件读不出来（${f}）—— 本次读写按失败处理，不去覆盖它`);
      return null;
    }
  }

  return {
    fileOf,
    get(id, key) {
      const m = readMap(id);
      if (!m) return undefined;
      if (!isSafeStorageKey(key)) return undefined;
      return m[String(key)];
    },
    keys(id) {
      const m = readMap(id);
      return m ? Object.keys(m) : [];
    },
    set(id, key, value) {
      const f = fileOf(id);
      if (!f) return { ok: false, reason: `包 id 不合法，无法定位存储文件（id=${JSON.stringify(String(id ?? ''))}）` };
      if (!isSafeStorageKey(key)) {
        return { ok: false, reason: `键名不合法（不许含 / \\ .. 与控制字符，长度 ≤${EXT_STORAGE_KEY_MAX}）：${JSON.stringify(String(key ?? ''))}` };
      }
      let serialized;
      try {
        serialized = JSON.stringify(value);
      } catch {
        return { ok: false, reason: '值不可序列化（循环引用 / BigInt / 函数）—— 只能存 JSON 能表达的东西' };
      }
      if (serialized === undefined) return { ok: false, reason: '值是 undefined，存不了' };
      const m = readMap(id);
      if (!m) return { ok: false, reason: '存储文件读不出来，拒绝写（不覆盖可能还能救的内容）' };
      m[String(key)] = value;
      let next;
      try {
        next = Buffer.byteLength(JSON.stringify(m), 'utf8');
      } catch {
        return { ok: false, reason: '合并后的内容不可序列化' };
      }
      if (next > maxBytes) {
        delete m[String(key)];
        return { ok: false, reason: `这个包的存储已满（${next} > ${maxBytes} 字节）—— 它是"记几笔状态"的地方，不是数据库` };
      }
      try {
        fs.mkdirSync(root, { recursive: true });
        writeJsonAtomic(f, m, { mode: 0o600 });
      } catch (e) {
        return { ok: false, reason: `写不进去：${e.message}` };
      }
      return { ok: true };
    },
    remove(id, key) {
      const m = readMap(id);
      if (!m || !isSafeStorageKey(key)) return { ok: false, reason: '读不出来或键名不合法' };
      const had = Object.prototype.hasOwnProperty.call(m, String(key));
      if (!had) return { ok: true, removed: false };
      delete m[String(key)];
      try {
        writeJsonAtomic(fileOf(id), m, { mode: 0o600 });
      } catch (e) {
        return { ok: false, reason: `写不进去：${e.message}` };
      }
      return { ok: true, removed: true };
    },
  };
}
