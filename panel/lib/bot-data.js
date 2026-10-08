/**
 * 扩展包写的数据 → 面板能看的样子（2026-10-02）
 * ══════════════════════════════════════════════════════════════════════════
 *  这一层回答一件事：**"机器人此刻什么心情 / 它都记了谁 / 它攒了多少料"** ——
 *  这些数据一直存在磁盘上（是扩展包在写），但**从来没有出口**，所以面板上
 *  只能看到骨架页写着"未实现"。
 *
 *  面板**直接读盘**，不经机器人转发。理由：这些都是普通 JSON 文件，面板本来就能读；
 *  让机器人读一遍再下发，会把"看一眼"变成"必须机器人在跑" —— 而"机器人没在跑"
 *  恰恰是用户最想看这些数据的时候。
 *
 * ──────────────────────────────────────────────────────────────────────────
 *  ⚠️ 四条纪律（每一条都对应一种"看起来正常但其实在编数据"的失败）
 * ──────────────────────────────────────────────────────────────────────────
 *  ① **这些文件不是我们写的**。`plugins/` 与 `skills/` 里的包各有各的形状，
 *     将来还会变。所以一律**白名单投影**：只挑认识的字段，认不出的一律不显示。
 *     ⚠️ 绝不"猜一个默认值补上" —— 编一个「心情 50」出来，比空着更糟。
 *
 *  ② **不分发绝对路径**。与 `extensions.js` 同一条纪律：文件里、搜索结果里
 *     都不带 `dir` / 绝对路径。面板要排障时自己看日志，页面只要"叫什么、多少、什么状态"。
 *
 *  ③ **读不到不算错**。文件不存在 = 那个扩展包没装或还没产出数据（正常状态，
 *     不是故障）。所以 `ok:false` 时带 `reason`，页面据此说人话，**不画红**。
 *     真出错（JSON 坏了 / 权限）与"没这个文件"要分开报，不能糊成一句"失败"。
 *
 *  ④ **不抛**。`collectState()` 挂在 `/api/state` 上，每 3 秒被拉一次 ——
 *     这里抛一次就等于整个状态快照 500，页面全白。所以所有读取都兜住。
 *
 *  ⑤ **IO 全入参**（每个口都收一个可覆盖的文件/目录，默认走 `paths.js` 的常量）。
 *     这条不是为了好看：契约 §59 要**喂一份受控数据**才能验形状投影，而不能靠
 *     改 `QQBOT_DATA_DIR` —— `paths.js` 的常量是**加载时**求值的，模块缓存一旦建立，
 *     再改 env 也没用（实测踩到：判据以为在读临时目录，其实读的是真机数据，
 *     于是"假绿"）。判据零依赖 + IO 全入参是本项目既有取向（见 `ext-install.js`）。
 *
 *  依赖：只 import `node:fs` / `node:path` / `./paths.js`（L0）。本模块是 **L1**。
 *  ⚠️ **不许 import `src/`**，也不许 import `server.js`。
 */

import fs from 'node:fs';
import path from 'node:path';
import { BOT_STATE_FILE, PEOPLE_DIR, GALLERY_FILE, API_DEALS_FILE } from './paths.js';

/* ── 小工具 ─────────────────────────────────────────────────────────────── */

const isObj = (x) => !!x && typeof x === 'object' && !Array.isArray(x);

/** 读一个 JSON 文件。返回 `{ ok, data }` 或 `{ ok:false, reason }` —— **不抛**。 */
function readJson(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    // ENOENT = "还没有这份数据"（正常），其余（EACCES / EISDIR…）= 真出错。
    // 两者分开报：糊成一句"读不到"会让下一个人去查错的方向。
    return { ok: false, missing: e.code === 'ENOENT', reason: e.code === 'ENOENT' ? '还没有这份数据' : `读不到：${e.code || e.message}` };
  }
  try {
    return { ok: true, data: JSON.parse(raw) };
  } catch (e) {
    return { ok: false, missing: false, reason: `文件不是合法 JSON（${e.message}）` };
  }
}

/** 取一个有限数；不是数就 `null`（**不补 0** —— 0 与"没这个字段"是两件事）。 */
const numOr = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const strOr = (v, max = 120) => (typeof v === 'string' ? v.slice(0, max) : '');

/* ── ① 本体情绪（`plugins/本体情绪` → `data/bot-state.json`）───────────── */

/**
 * 此刻的心情 / 精力 / 压力。
 *
 * 形状来自那个包的实际落盘（2026-10-02 实测）：
 * `{ mood, arousal, energy:{physical,cognitive,emotional,will}, acuteStress, chronicStress,
 *    intent, emotions:{anger:0,…}, lastEvent:{kind,note,chatKey,at}, … }`
 * ⚠️ `emotions` 有 21 个键、绝大多数是 0。**只挑非零的**并列出来 —— 21 行里 18 行是 0
 *    的那种页面，等于没有信息量。
 */
export function readEmotion(file = BOT_STATE_FILE) {
  const r = readJson(file);
  if (!r.ok) return { ok: false, reason: r.reason, missing: !!r.missing };
  const d = r.data;
  if (!isObj(d)) return { ok: false, reason: '状态文件不是对象' };

  const emo = isObj(d.emotions)
    ? Object.entries(d.emotions)
      .map(([k, v]) => [k, numOr(v)])
      .filter(([, v]) => v !== null && Math.abs(v) >= 1)   // <1 的当作"没有这个情绪"
      .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
      .slice(0, 8)
    : [];

  const energy = isObj(d.energy)
    ? ['physical', 'cognitive', 'emotional', 'will'].reduce((o, k) => {
      const v = numOr(d.energy[k]);
      if (v !== null) o[k] = v;
      return o;
    }, {})
    : {};
  // 那个包将来加/改名时，多余的键**照实带出来**（不丢），但键名原样显示 —— 见模块头 ①
  const energyExtra = isObj(d.energy)
    ? Object.keys(d.energy).filter((k) => !(k in energy)).slice(0, 6)
    : [];

  const ev = isObj(d.lastEvent)
    ? { kind: strOr(d.lastEvent.kind, 40), note: strOr(d.lastEvent.note, 160), at: numOr(d.lastEvent.at), chatKey: strOr(d.lastEvent.chatKey, 60) }
    : null;

  return {
    ok: true,
    mood: numOr(d.mood), arousal: numOr(d.arousal),
    acuteStress: numOr(d.acuteStress), chronicStress: numOr(d.chronicStress),
    energy, energyExtra,
    emotions: emo,
    intent: strOr(d.intent, 160),
    lastEvent: ev,
    updatedAt: numOr(d.updatedAt),
  };
}

/* ── ② 群友档案（`skills/群友印象` → `data/memory/people/<QQ>.json`）──── */

/**
 * 群友档案列表。
 *
 * 形状来自那个包的 `defaultPerson()`（2026-10-02 实测）：
 * `{ userId, nicknames:[], favor:50, impressions:[{content,…}], attitude?, updatedAt }`
 *
 * ⚠️ 一个坏文件**只跳过它自己**，不让整张列表变空 —— 与 `skills/记忆管理`
 *    的 `readAllPeople()` 同一取向（那边也是 `catch { skip bad file }`）。
 */
export function readPeople(limit = 200, dir = PEOPLE_DIR) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (e) {
    return { ok: false, missing: e.code === 'ENOENT', reason: e.code === 'ENOENT' ? '还没有群友档案（那个技能没被用到过）' : `读不到目录：${e.code || e.message}` };
  }
  const items = [];
  let broken = 0;
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const r = readJson(path.join(dir, name));
    if (!r.ok || !isObj(r.data)) { broken += 1; continue; }
    const p = r.data;
    const imps = Array.isArray(p.impressions) ? p.impressions : [];
    items.push({
      // userId 原样（页面要靠它认人 / 搜索）；文件名与绝对路径**不下发**
      userId: strOr(p.userId, 24) || name.replace(/\.json$/, ''),
      nickname: Array.isArray(p.nicknames) && p.nicknames.length ? strOr(p.nicknames[0], 40) : '',
      favor: numOr(p.favor),
      attitude: strOr(p.attitude, 120),
      impressionCount: imps.length,
      // 只带最近 3 条：这一页是"扫一眼"，全文检索是那个技能自己的工具的事
      impressions: imps.slice(-3).map((x) => ({
        content: strOr(isObj(x) ? x.content : x, 200),
        at: isObj(x) ? numOr(x.at) : null,
      })).filter((x) => x.content),
      updatedAt: numOr(p.updatedAt),
    });
    if (items.length >= limit) break;
  }
  items.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return { ok: true, count: items.length, broken, items };
}

/* ── ③ 自定义图库（`skills/自定义图库` → `data/images-lib/index.json`）── */

/**
 * ⚠️ 只报**张数**，不报分类：那个包写的索引里有 `images` 数组，
 *    但**条目字段名我们不知道**（本机 `data/images-lib/` 还不存在，没样本可核）。
 *    所以这里不猜字段名 —— 猜一个 `cat` / `category` 出来，页面会显示一个
 *    永远为空的分组，而没人会想到是"面板猜错了字段名"。
 */
export function readGallery(file = GALLERY_FILE) {
  const r = readJson(file);
  if (!r.ok) return { ok: false, reason: r.reason, missing: !!r.missing };
  const n = isObj(r.data) && Array.isArray(r.data.images) ? r.data.images.length : null;
  if (n === null) return { ok: false, reason: '索引里没有 images 数组（那个包的形状变了？）' };
  return { ok: true, count: n };
}

/* ── ④ AI 免费额度情报（`skills/AI额度情报` → `data/api-deals.json`）──── */

/**
 * 形状实测：`{ items:[{id,title,brand,amount,deadline,url,source,free,at}], lastRefresh, lastError }`
 * 这一页在旧控制台里是一张**骨架页**（写着"已有等价物，只缺一个看得见的地方"）——
 * 这里就是那个地方。
 */
export function readApiDeals(limit = 40, file = API_DEALS_FILE) {
  const r = readJson(file);
  if (!r.ok) return { ok: false, reason: r.reason, missing: !!r.missing };
  const d = r.data;
  const list = isObj(d) && Array.isArray(d.items) ? d.items : [];
  const items = list.slice(0, limit).map((x) => (isObj(x) ? {
    title: strOr(x.title, 160),
    brand: strOr(x.brand, 40),
    amount: strOr(x.amount, 60),
    deadline: strOr(x.deadline, 40),
    url: strOr(x.url, 300),
    source: strOr(x.source, 30),
    free: x.free === true,
    at: numOr(x.at),
  } : null)).filter((x) => x && x.title);
  return {
    ok: true,
    count: list.length,
    items,
    lastRefresh: isObj(d) ? numOr(d.lastRefresh) : null,
    lastError: isObj(d) ? strOr(d.lastError, 160) : '',
  };
}

/* ── 一次读全（`collectState()` 用这一个口）────────────────────────────── */

/** `collectState()` 里只调这一个 —— 四个读盘口在此收口，路由里不出现任何文件名。 */
export function readBotData() {
  return {
    emotion: readEmotion(),
    people: readPeople(),
    gallery: readGallery(),
    apiDeals: readApiDeals(),
  };
}
