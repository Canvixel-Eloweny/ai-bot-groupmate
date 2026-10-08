/**
 * ══════════════════════════════════════════════════════════════════════
 *  扩展包 ctx（`api`）—— 按声明裁剪的**唯一构造点**
 *  第 46 轮 B12e-2 · EX-CAPCTX（执行层第二步）
 * ══════════════════════════════════════════════════════════════════════
 *  `setup(api)` 拿到的东西就是本模块造出来的。它是**执行外来代码的边界** ——
 *  这个对象上有什么、没什么，等于"外来代码能做什么"。
 *
 *  ────────────────────────────────────────────────────────────────────
 *  ⚠️ 字段清单是**实测出来的**，不是照规格写的
 *  ────────────────────────────────────────────────────────────────────
 *  规格（v2 §5）对 `EX-CAPCTX` 的原话是「`capabilities` 白名单 → 只给声明过的
 *  ctx 字段」，验收是"未声明能力时 ctx 字段为 `undefined`"。
 *  本批开工前把 **13 个真实扩展包**（QQ-Agent · MIT）逐个 grep 了一遍，
 *  它们实际用到的 ctx 字段只有四个：
 *
 *  | 字段 | 用它的包 | 说明 |
 *  |---|---|---|
 *  | `api.config` | 13 / 13 | **函数**（`api.config()` 取该包设置），不是对象 |
 *  | `api.log` | 8 / 13 | 函数 |
 *  | `api.registerTool` | 8 / 13（全部 skill 型） | 函数，返回注册后的名字 |
 *  | `api.dataDir` | 3 / 13 | `if (api.dataDir) …` —— **有就用、没有就自己兜底** |
 *
 *  ⚠️ **参考实现里根本没有 `dataDir`**（`createSkillApi` 全文核过），
 *     也就是说 `undefined` 是**生态里的正常状态**，不是缺陷。
 *     → 于是"未声明能力时字段为 undefined"这条验收**落在 `dataDir` 上**
 *       （本模块不提供它 —— 与参考一致），而不是靠"给每个字段造一个空壳"。
 *
 *  ⚠️ 参考实现给 `fetch` 的是**会 reject 的函数**（而不是 `undefined`）：
 *     没声明 `web_fetch` 时 `api.fetch(...)` 得到一条明确的错误，而不是
 *     `TypeError: api.fetch is not a function`（后者会把包自己的 try/catch
 *     绕过去，报错信息也完全不指向"你没声明权限"）。
 *     → 这里跟样本走，**不跟规格原文走**（与本项目第 34 条纪律一致：
 *       "规格里照抄某个生态的抽象，必须拿真实样本核一遍"）。
 *
 *  ⚠️ **本模块不提供 `fs` / `path` / `process`** —— 不是"忘了"，是不给。
 *     外来代码要碰磁盘只有一条路：宿主主动给的 `dataDir`（将来提供时才给），
 *     且它必须被限制在包自己的目录下。
 *
 *  ⚠️ **零依赖叶子**：不 import 任何东西（连 `node:path` 都不进）。
 *     路径拼接与 IO 属于宿主（`src/plugin-host.js`）。
 */

/**
 * 认识的权限名。**只有在这里登记过的权限才可能被发放** ——
 * 扩展包写一个不存在的权限名不会报错，只是永远拿不到对应能力（与参考一致）。
 */
export const PERMISSION_NAMES = Object.freeze(['web_fetch', 'send_image', 'storage']);

/**
 * 该包声明的权限（归一化：去空格、去重、只留认识的）。
 *
 * 不认识的权限名**保留在 `unknown` 里报出来**，不静默丢弃 ——
 * 用户写了 `web_fatch`（拼错）时，"权限声明了却没生效"是最难查的一类。
 *
 * @param {string[]} declared 清单里的 `permissions`
 * @returns {{known:string[], unknown:string[]}}
 */
export function splitPermissions(declared) {
  const known = [];
  const unknown = [];
  const seen = new Set();
  for (const raw of Array.isArray(declared) ? declared : []) {
    const s = String(raw ?? '').trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    if (PERMISSION_NAMES.includes(s)) known.push(s);
    else unknown.push(s);
  }
  return { known, unknown };
}

/**
 * 该包的设置：**清单默认值**为底，**用户在面板上填的**盖在上面。
 *
 * ⚠️ 第 55 轮接上了"编辑"这一半（`custom.plugins.settings[id]`）。
 *    在此之前 `config()` 返回的恒是清单默认值 —— 于是清单里写着 `cookie`
 *    的「B站视频解析」**永远只能拿空字符串**，用户填不进去（附 T.7 第 1 条）。
 *
 * ⚠️ 为什么是"默认值打底 + 用户值覆盖"而不是直接给用户的那份：
 *    清单会随包升级而多出一个键，只给用户的那份会让新键**凭空消失**，
 *    包里读到 `undefined` 却不报错（它没法区分"用户没填"和"这个键不存在"）。
 *    打底之后两种情形都稳定。
 *
 * ⚠️ 不做逐键白名单校验：设置项的形状只有包自己知道，宿主猜必然猜错。
 *    宿主的责任止于"它是个对象"（归一化在 `custom-config.js`）。
 *
 * @param {object|null} manifest
 * @param {object} [user] 用户填的那份（已归一化成对象）
 * @returns {() => object}
 */
export function settingsOf(manifest, user) {
  const base = manifest && typeof manifest.settings === 'object' && manifest.settings && !Array.isArray(manifest.settings)
    ? { ...manifest.settings }
    : {};
  const over = user && typeof user === 'object' && !Array.isArray(user) ? { ...user } : {};
  return () => ({ ...base, ...over });
}

/**
 * 造一个扩展包的 ctx。
 *
 * @param {{manifest:object, log?:{info?,warn?,error?}, now?:()=>number,
 *          registerTool?:Function, isActive?:Function, fetch?:Function, settings?:object}} deps
 *   · `fetch` —— **受出站策略约束的那份**（生产由 `createExtFetch()` 造）。
 *     不传 → 即使声明了 `web_fetch` 也拿不到（默认拒绝）。
 *   · `settings` —— 用户在面板上填的那份（`custom.plugins.settings[id]`）；没有则只用清单默认值。
 * @returns {object} `api`
 */
export function buildApi({ manifest, log, now, registerTool, isActive, fetch, settings } = {}) {
  const m = manifest || {};
  const id = String(m.id ?? '');
  const kind = m.kind ?? null;
  const { known, unknown } = splitPermissions(m.permissions);
  const has = (name) => known.includes(String(name ?? ''));

  const tag = `[ext:${id}]`;
  const mk = (level) => (...args) => {
    const fn = log?.[level] || log?.info;
    if (typeof fn === 'function') fn(`${tag}`, ...args);
  };
  const config = settingsOf(m, settings);

  // 不识别的权限名要**当场说出来**（见 splitPermissions 的注释）
  if (unknown.length) {
    const fn = log?.warn;
    if (typeof fn === 'function') {
      fn(`${tag} 声明了不认识的权限：${unknown.join(' / ')}（支持的：${PERMISSION_NAMES.join(' / ')}）`);
    }
  }

  const api = {
    id,
    name: String(m.name ?? id),
    version: String(m.version ?? ''),
    kind,
    /** 该包设置（清单默认值）。**函数**，与生态一致 */
    config,
    log: mk('info'),
    warn: mk('warn'),
    error: mk('error'),
    /** 自检：我拿到这个权限了吗 */
    has,
    /** 只看结论、不看原始输入：包自己判"另一个包在不在"，用来做软依赖 */
    isActive: (other) => (typeof isActive === 'function' ? isActive(String(other ?? '')) === true : false),
  };

  // ── fetch：只有声明了 web_fetch 才给 ──────────────────────────────────
  // 这是 EX-CAPCTX 的**主落点**：未声明 → 拿到的是一个「一调就报明确错误」的函数，
  // 而不是能用的 fetch。参考实现用的就是这个形状（见文件头）。
  //
  // ⚠️ 第 55 轮的修正：**拿到的那份必须是受出站策略约束的**，不再默认给裸 fetch。
  //    之前 `api.fetch = globalThis.fetch` —— 声明了权限的包可以直接打到
  //    `169.254.169.254` / `127.0.0.1:8080`（本机模型端口）而没有任何拦截，
  //    那正是 B13 建 `src/safe-fetch.js` 时要防的东西，只是当时它 0 个调用方。
  //    → 判据仍然只有 safe-fetch 那一份，适配（还原成 Response 形状）在 `ext-fetch.js`。
  //
  // ⚠️ **默认拒绝**（与 `ext-scope.js` 那条"其余一律拒绝"同一条纪律）：
  //    宿主没给 `fetch` 就**不给**，而不是退回 `globalThis.fetch` ——
  //    "宿主忘了接线"不该让外来代码拿到一张 unrestricted 的网络通行证。
  //    生产侧由 `plugin-host.js` 传入 `createExtFetch()` 造的那份（契约盯这个接线点）。
  if (has('web_fetch') && typeof fetch === 'function') {
    api.fetch = fetch;
  } else {
    api.fetch = () => Promise.reject(new Error(
      has('web_fetch')
        ? `扩展包「${id}」声明了 web_fetch，但宿主没有提供受策略约束的 fetch —— 这是宿主的接线遗漏，按拒绝处理`
        : `扩展包「${id}」没有声明 web_fetch 权限，不能访问网络（清单 permissions 里加上 "web_fetch" 即可）`
    ));
  }

  // ── registerTool：两种型都给 ──────────────────────────────────────────
  // 第 47 轮 B12e-3 修正（此前这里对 plugin 型**抛错**，是照一份没核实出处的
  // "lint" 写的）：拿参考实现（QQ-Agent 0.4 preview）的真实样本核过 ——
  //   · src/skills/manifest.js:37 原话：「这只是**语义归类**，不是能力限制」；
  //   · src/plugin-loader.js:70 createSkillApi 对两种型给同一个 registerTool；
  //   · 真实包「本体情绪」就放在 plugins/ 下、注册 2 个工具 + 4 个钩子。
  // plugins/（确定性型）与 skills/（LLM 型）的区别只是"默认怎么被触发"，
  // 不是"能不能注册工具"。撞名防护由注册表统一管（owner 前缀 + 撞名拒绝）。
  api.registerTool = (def) => {
    if (typeof registerTool !== 'function') throw new Error('宿主未提供 registerTool');
    return registerTool(def, { owner: id });
  };

  if (typeof now === 'function') api.now = now;

  return api;
}

/**
 * `activate(ctx)` 的那个 ctx —— **从 setup 的 api 投影出的只读子集**（第 48 轮 B12e-4 · EX-SCOPE）。
 *
 *  ────────────────────────────────────────────────────────────────────
 *  为什么要有它：生态契约是 `activate(ctx)`，而宿主此前调用的是**无参** `activate()`
 *  ────────────────────────────────────────────────────────────────────
 *  参考实现（`src/plugin-loader.js` · `skillManager.activate(id, context)`）带上下文。
 *  无参调用的后果很隐蔽：包里的 `activate(ctx)` 拿到 `undefined`，
 *  `ctx?.sender` 恒为 undefined → 它**静默地什么都不做**（"装了不用"，第 12 条那一类）。
 *
 *  ────────────────────────────────────────────────────────────────────
 *  ⚠️ 但**不能**把 setup 的 api 原样传进去 —— 那是两件不同的事
 *  ────────────────────────────────────────────────────────────────────
 *  参考实现传的 context 里带 `sender`，等于让包在**生命周期阶段**就能发言 ——
 *  而此刻**根本没有会话**（activate 是包级的、启动时跑一次）。
 *  所以这里只给"能读、能记日志、能自检"的部分，**能力一律摘掉**：
 *
 *    | 摘掉的 | 为什么 |
 *    |---|---|
 *    | `registerTool` | 注册工具是 `setup` 的职责；activate 阶段注册 = 热插拔，而本项目**不支持**热插拔 |
 *    | `fetch` | 生命周期阶段发起网络请求，没有任何会话上下文能解释它为什么发 |
 *    | `isActive` | 那是"包之间的软依赖"，只在 setup 判定一次即可，不需要在 activate 再判一次 |
 *    | `onebot` / `sender` | **根本上不存在** —— 发言只发生在钩子与工具里（那时才有会话） |
 *
 *  偏差已记在计划附 V.4。
 *
 *  ⚠️ 它**不重新 buildApi**（那会二次触发"声明了不认识的权限"的告警，同一件事报两遍）。
 *     纯投影、纯函数、不碰 IO。
 *
 * @param {object} [api] `buildApi()` 的产物；没有 setup 的包传 undefined → 得到 `{}`
 * @returns {object} 只读的 activate 上下文
 */
export function activateCtxOf(api) {
  if (!api || typeof api !== 'object') return {};
  const { id, name, version, kind, config, log, warn, error, has, now } = api;
  const ctx = { id, name, version, kind, config, log, warn, error, has };
  if (typeof now === 'function') ctx.now = now;
  return ctx;
}
