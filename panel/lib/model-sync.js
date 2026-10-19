/**
 * 官方模型目录对账（2026-10-17 · 维护者点名）
 * ══════════════════════════════════════════════════════════════════════════
 *  它回答一句用户会问的话：「你面板上显示的这个模型，还是官方现在那个吗？」
 *
 *  ── 做的三件事 ──────────────────────────────────────────────────────────
 *  ① **地址**：官方大脑的 `baseUrl` 与目录里的官方地址不一致 ⇒ 改成官方的
 *     （只对属于官方域名的大脑生效 —— `providerOf()` 判得出来，自建网关一律不碰）；
 *  ② **模型 id**：目录里有 `renames` 映射时按映射改（模型改名的那种更新）；
 *  ③ **通知**：版本号比上次记录的新 ⇒ 生成一条事件，页面右下角弹一次。
 *
 *  ⚠️ **只改"官方大脑"**（`llm.customBrains` 里地址属官方域名的那几套）。
 *     用户自己起的名字（"1"、"12"）、模型勾选**一律不动** —— 那是他的东西。
 *  ⚠️ **不动扁平字段之外的任何东西**；如果被改的正好是"当前在用"的那套，
 *     物化一次让扁平字段跟上（复用 `materializeBrain`，不写第二份）。
 *  ⚠️ 版本号只能来自我们的目录（`MODEL_VERSIONS`）：`/models` 接口返回的是稳定别名，
 *     拿不到 `V4.1-Flash-1017` 这种版本 —— 这一点写在 models.js 那个常量上面。
 *
 *  ── 为什么要有节流 ──────────────────────────────────────────────────────
 *  `/api/state` 每 3 秒被轮询一次。对账要读配置、可能写配置，不能每次都跑。
 *  ⇒ 6 小时一次（`panel/model-sync.json` 记上次时间）。启动时也跑一次。
 */
import { providerOf } from '../../src/net-rules.js';
import { materializeBrain } from '../../src/custom-brain.js';
import { readModelSync, writeModelSync, SYNC_THROTTLE_MS, MAX_SYNC_EVENTS } from './model-sync-state.js';
import { CLOUD_PRESETS, MODEL_LABELS, catalogOf } from './models.js';
import { readConfig, writeConfig } from './config-io.js';

/** 地址比较：忽略尾斜杠 / http(s) 差异，只认"是不是同一个接口"。 */
const norm = (u) => String(u || '').trim().replace(/\/+$/, '').toLowerCase();

/**
 * **纯函数**：算出这次对账要改什么、要不要通知。不写盘、不读盘。
 *
 * @param {object} cfg 完整配置（不会被修改）
 * @param {number} [now]
 * @returns {{changes: Array<{id:string,name:string,fields:string[],from:object,to:object}>,
 *            events: Array<{id:string,at:number,title:string,detail:string,url:string}>}}
 */
export function planModelSync(cfg, now = Date.now()) {
  const changes = [];
  const events = [];
  const brains = cfg?.llm?.customBrains;
  if (!brains || typeof brains !== 'object') return { changes, events };

  for (const [id, raw] of Object.entries(brains)) {
    const brain = raw || {};
    const provider = providerOf(brain.baseUrl);
    const cat = catalogOf(provider);
    if (!cat) continue;                                  // 不是官方那几家
    const meta = cat.models?.[brain.model];
    if (!meta) continue;                                 // 目录里没登记这个型号

    const want = CLOUD_PRESETS[provider]?.baseUrl || '';
    const fields = [];
    const from = {};
    const to = {};
    // ① 地址对齐（只在"同一家、但地址写法过时"时才改）
    if (want && norm(want) !== norm(brain.baseUrl)) {
      fields.push('baseUrl'); from.baseUrl = brain.baseUrl; to.baseUrl = want;
    }
    // ② 模型改名（目录给了 renames 才动）
    const renamed = cat.renames?.[brain.model];
    if (renamed) {
      fields.push('model'); from.model = brain.model; to.model = renamed;
    }
    // ③ 版本：比记录的新 ⇒ 生成一条通知（**不依赖 fields**，纯能力更新也要说）
    if (String(brain.catalogVersion || '') !== meta.version) {
      fields.push('catalogVersion');
      from.catalogVersion = brain.catalogVersion || '';
      to.catalogVersion = meta.version;
      events.push({
        id: `${provider}:${brain.model}:${meta.version}`,
        at: now,
        // 用**模型名**而不是用户给大脑起的名字（"1"、"12"）：这条是系统提示，
        // 读的人要知道"哪个模型变了"，而不是"我给那一套起的绰号变了"。
        title: `${MODEL_LABELS[brain.model] || brain.model} 已更新到 ${meta.version}`,
        detail: `${meta.at ? `（${meta.at}）` : ''}${meta.note || '官方发布了新版本'}`
          + `${fields.length > 1 ? '；模型名/地址已为你同步' : '；模型名与地址无需改动'}`,
        url: cat.docsUrl || '',
      });
    }
    if (fields.length) changes.push({ id, name: brain.name || '', fields, from, to });
  }
  return { changes, events };
}

/**
 * 把 `planModelSync()` 的结论写进配置（**就地修改**）。
 * @returns {object} 改过的 cfg
 */
export function applyModelSync(cfg, plan) {
  for (const c of plan.changes) {
    const brain = cfg.llm.customBrains[c.id];
    if (!brain) continue;
    for (const f of c.fields) brain[f] = c.to[f];
  }
  // 被改的正好是"现在在用"的那套 ⇒ 扁平字段要跟上（materialize 只有一份实现）
  const active = String(cfg.llm.activeCustomId || '');
  const touched = plan.changes.some((c) => c.id === active);
  if (active && touched && cfg.llm.customBrains[active]) {
    materializeBrain(cfg, cfg.llm.customBrains[active]);
  }
  return cfg;
}

/**
 * 跑一次对账（有节流）。**永不抛** —— 它跑在启动与轮询路径上。
 *
 * @param {{force?:boolean}} [opts] `force` 只给测试与"手动重新对账"用
 * @returns {{ran:boolean, changed:number, events:object[]}}
 */
export function maybeSyncModelCatalog({ force = false } = {}) {
  try {
    const st = readModelSync();
    if (!force && Date.now() - st.lastAt < SYNC_THROTTLE_MS) return { ran: false, changed: 0, events: [] };

    const cfg = readConfig() || {};
    const plan = planModelSync(cfg);
    if (plan.changes.length) writeConfig(applyModelSync(cfg, plan), { via: 'model-catalog-sync' });

    // 事件按 id 去重：同一版本只留一条
    const seen = new Set(st.events.map((e) => e.id));
    const fresh = plan.events.filter((e) => !seen.has(e.id));
    const events = [...st.events, ...fresh].slice(-MAX_SYNC_EVENTS);
    writeModelSync({ events });
    return { ran: true, changed: plan.changes.length, events: fresh };
  } catch {
    return { ran: false, changed: 0, events: [] };
  }
}
