/**
 * ══════════════════════════════════════════════════════════════════════
 *  扩展包的**只读快照**（面板侧）
 *  第 44 轮 B12d · EX-PLUGIN
 * ══════════════════════════════════════════════════════════════════════
 *  为什么面板要自己扫一遍，而不是让机器人把结果通过 `effective.json` 带过来：
 *
 *  · 机器人没在跑的时候，那**正是用户最想看"我装的包对不对"的时候**；
 *  · 面板扫目录 + 校验清单是**纯读**操作，零运行时风险，不需要机器人在场；
 *  · `effective.json` 的语义是"机器人此刻**正在用**什么"，而"磁盘上有哪些包"
 *    与"机器人跑不跑"无关 —— 把两件事塞进一份快照会污染那份语义。
 *
 *  ⚠️ 这是本项目第 5 条 `lib → src/` 的依赖边（前 4 条见 check-wb 的 LIB_SRC_ALLOW）。
 *     引的是 `src/plugin-host.js` 这个**零业务依赖**的扫描器 ——
 *     它不碰 llm / brain / onebot 那些重型模块，所以不会把面板的启动路径
 *     和机器人进程的启动路径缠在一起（那正是 LIB_SRC_ALLOW 要防的事）。
 *
 *  ⚠️ **绝对路径不许下发到页面**。`loadExtensions` 的每条结果里都带 `dir`
 *     （面板自己要拿它排障），但页面只需要"叫什么、什么状态、哪里不对"。
 *     所以这里做一次**白名单式投影**：只挑认识的字段，`dir` 根本不进返回值。
 *     多一层的原因见 `detail` 的过滤：万一将来有人往文案里加了路径，
 *     那一层兜底能挡住，而不是靠"我记得没写路径"。
 */

import { loadExtensions } from '../../src/plugin-host.js';
import { settingsSpec } from '../../src/plugin-settings.js';
import { ROOT } from './paths.js';

/**
 * 缓存时长。
 * `/api/state` 每 3 秒被页面拉一次，而页面**同时**在看扫描结果 ——
 * 不缓存就是每 3 秒 readdir×2 + 每个包若干次 stat。13 个包时还看不出问题，
 * 但这属于"随包数量线性增长的常驻开销"，给它一个固定上限更稳。
 * ⚠️ 10 秒的取舍：用户拷进一个新包后最多等 10 秒就能看见。
 *    真机重启/热重载不受影响（那是另一个进程自己的扫描）。
 */
const TTL_MS = 10000;

/** 进程内缓存。形状 `{key, at, value}` —— 三个字段一起换，避免读到半份。 */
let cache = null;

/** 把 detail 里可能出现的本机绝对路径换成占位，防止路径随接口下发到浏览器。 */
function scrubPaths(s) {
  return String(s || '')
    .replace(/\/Users\/[^\s，。；;、）)]*/g, '（本机路径）')
    .replace(/\/home\/[^\s，。；;、）)]*/g, '（本机路径）')
    .replace(/[A-Za-z]:\\[^\s，。；;、）)]*/g, '（本机路径）');
}

/**
 * 把宿主的一条结果投影成**可以下发给页面**的形状。
 * 只挑字段，不做"删掉 dir"这种反向操作 —— 白名单式投影在加字段时
 * 默认是安全的（新字段不会自动泄露），黑名单式默认是危险的。
 */
function projectItem(p) {
  return {
    id: String(p.id || ''),
    dirName: String(p.dirName || ''),
    name: String(p.manifest?.name || p.id || ''),
    version: String(p.manifest?.version || ''),
    kind: p.kind ?? null,
    action: p.action,
    reason: p.reason,
    detail: scrubPaths(p.detail),
    problems: (p.problems || []).map((w) => scrubPaths(w.text)),
    // 清单里自带的**默认设置**（第 55 轮）：页面要用它做两件事 ——
    // ① 告诉用户"这个包有哪些键可以填"（否则只能靠猜）；
    // ② 用户没填过时显示的就是这个值，而不是一片空白。
    // ⚠️ 只下发这一段：**用户填的那份**由页面从 custom 里自己取（那是它本来就有的数据）。
    settings: (p.manifest?.settings && typeof p.manifest.settings === 'object'
      && !Array.isArray(p.manifest.settings)) ? p.manifest.settings : {},
    // D21 · Q26a：这个包**自带联网**（清单里声明了 `web_fetch`）。
    // 为什么值得单独下发一个位：已实测 —— 声明了 `web_fetch` 的包用的是**裸 `global fetch`**，
    // 不经宿主注入的 `api.fetch`，所以它**不受出站策略（safe-fetch / 浏览锁定）约束**。
    // 页面据此标一行提示：这不是"包有问题"，而是"这道闸管不到它"，用户有权知道。
    // ⚠️ 只做可观测：**不改那些包的源码**（它们不在 git 里，改了没有版本、回归也看不见）。
    netSelf: (Array.isArray(p.manifest?.capabilities) ? p.manifest.capabilities : [])
      .map(String).includes('web_fetch'),
  };
}

function scan(enabled) {
  let r;
  try {
    r = loadExtensions({ root: ROOT, enabled, log: {} });
  } catch (e) {
    // 与 `/api/state` 那条纪律一致：这个模块**不许抛**。
    // 一个坏掉的扩展包目录让整页停止刷新，是比"扩展包列表空着"严重得多的错误。
    return {
      ok: false,
      reason: scrubPaths(e.message),
      sum: { total: 0, load: 0, skip: 0, reject: 0, byReason: {}, byKind: {} },
      roots: [],
      items: [],
    };
  }
  return {
    ok: true,
    sum: r.sum,
    roots: r.scans.map((s) => ({ name: s.name, missing: s.missing, count: s.entries.length })),
    items: r.plan.map(projectItem),
  };
}

/**
 * 取扩展包快照。**永不抛**（任何异常都折成 `ok:false`）。
 *
 * @param {Iterable<string>} enabled config 里显式启用的 id 集合
 * @param {{now?:number, force?:boolean}} opts
 *        `now` 由入参给（测试要能控制时间，不在函数里直接读 Date.now()）；
 *        `force` 跳过缓存 —— 测试与"刚改完白名单"时用。
 */
export function extensionsOf(enabled = [], { now = Date.now(), force = false, userSettings = {} } = {}) {
  const key = Array.from(enabled || [], String).join(',');
  let value;
  if (!force && cache && cache.key === key && now - cache.at < TTL_MS) value = cache.value;
  else {
    value = scan(enabled);
    cache = { key, at: now, value };
  }
  // D7：把每个包的设置算成**控件描述**（类型 / 是否密码框 / 当前值）随状态下发。
  //
  // ⚠️ 注解刻意放在**缓存之外**：缓存只按 `enabled` 做键，而 spec 依赖用户填的值 ——
  //    放进缓存的话，用户改完一项要等 10 秒 TTL 才看到自己填的东西（表现就是"改了没反应"）。
  //    spec 本身是对 ≤36 个键的纯映射，每 3 秒算一次的开销可以忽略。
  const items = (value.items || []).map((it) => ({
    ...it,
    settingsSpec: settingsSpec(it.settings, userSettings[it.id]),
  }));
  return { ...value, items };
}
