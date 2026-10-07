/**
 * ══════════════════════════════════════════════════════════════════════
 *  工具注册表 —— function calling 的**唯一**注册 / 列举 / 取名点
 *  第 46 轮 B12e-1（执行层 · 硬前置）
 * ══════════════════════════════════════════════════════════════════════
 *  解决的问题：本项目原先**没有** function 型 tools。`src/llm.js` 里那个
 *  `body.tools` 装的是**智谱内置**的 `web_search`（服务端自己实现的），
 *  不是"我们提供函数、模型决定调哪个"。而 8 个 skill 型扩展包（`registerTool`）
 *  与 5 个 plugin 型扩展包（`before-tool` 钩子）**都指向这一个前置**。
 *
 *  ────────────────────────────────────────────────────────────────────
 *  ⚠️ 本模块是**零依赖叶子**
 *  ────────────────────────────────────────────────────────────────────
 *  它 import 任何东西都会让 `src/index.js` 的依赖图多一条边。判据、
 *  取名、归一化、冻结全部用纯 JS 与纯字符串完成 —— 连 `node:path` 都不进。
 *
 *  ────────────────────────────────────────────────────────────────────
 *  ⚠️ 两条硬约束（第 45 轮 B12e-0 实测得出，代价很大，别改）
 *  ────────────────────────────────────────────────────────────────────
 *  ① **`specs()` 必须逐轮稳定**。缓存按**前缀 token 序列**匹配，固定的 tools
 *     只是让前缀变长（无害）；**每轮变化的 tools 会让前缀每轮都变 → 每轮全 miss**。
 *     实测（附 R.4）：固定 tools 对命中率的影响 < 1pp 且在噪声内；
 *     而"每轮变"在设计上是**必然全 miss**。
 *     → 所以 `specs()` 只构造一次、深冻结、缓存同一个引用；注册表一变才重建。
 *     → 并且**按 name 排序**输出：装载顺序变了也不影响前缀（多进程/重启后一致）。
 *
 *  ② **未注册工具时，请求体里不许出现 `tools`**。这是本批"零行为改变"的
 *     形式化表达 —— 有断言钉着（见 test/smoke.js T100）。
 *
 *  ────────────────────────────────────────────────────────────────────
 *  ⚠️ 工具定义的**唯一约定**：`execute(ctx, args)`（第 47 轮 B12e-3 对齐生态）
 *  ────────────────────────────────────────────────────────────────────
 *  13 个真实扩展包全部用 `execute(ctx, args)`（两个参数：ctx 是宿主注入的
 *  会话上下文，args 是模型给的实参）。参考实现（QQ-Agent 0.4 preview ·
 *  src/tool-registry.js:14,37）原话：`execute: 执行函数 (ctx, args)`，
 *  调用点 src/tools.js:1233 `def.execute(ctx, args ?? {})`。
 *  本注册表只认这一个形状 —— `handler` 这种单参数旧写法**不再受理**：
 *  两种形状并存意味着"包写得对不对"取决于它碰巧用了哪个名字，那是本项目
 *  排名第一的腐烂源（同一份判据两处定义）。测试与内部工具一并迁移。
 *
 *  ────────────────────────────────────────────────────────────────────
 *  ⚠️ 取名规则：**归一化会改变字面量，但不许静默改变语义**
 *  ────────────────────────────────────────────────────────────────────
 *  function name 有硬上限（各家实现普遍取 64），且只认 `[A-Za-z0-9_-]`。
 *  扩展包 id 里出现别的字符时，这里**替换成下划线**而不是丢弃 —— 但替换
 *  可能让两个不同的 id 撞成同一个名字，所以：
 *    · 撞名 → **拒绝后注册的那个**，并把两个原 id 一起写进 reason；
 *    · 超长截断到 64 —— 截断同样会撞名，走同一条拒绝路径。
 *  **绝不静默合并**：合并的表现是"某个工具永远调不到，而日志里什么都没有"。
 */

/**
 * function name 的长度上限。
 * 64 是 OpenAI 兼容实现的普遍取值（智谱/DeepSeek 都接受），
 * **经验值，非官方承诺** —— 改它要同时看 `normalizeToolName` 的截断逻辑。
 */
export const TOOL_NAME_MAX = 64;

/**
 * 合法的 function name 形状。
 * **由 `TOOL_NAME_MAX` 派生**，不把 64 再写一遍 —— 同一个数字写两处就是
 * 本项目排名第一的腐烂源（写在一处的收紧了、另一处的没跟上，而两者都不报错）。
 */
export const TOOL_NAME_RE = new RegExp(`^[A-Za-z0-9_-]{1,${TOOL_NAME_MAX}}$`);

/**
 * 一次最多注册多少个工具。
 * 全部工具的 schema 都会进**每一轮**请求前缀，条数直接决定固定成本。
 * 24 是**经验值**：按平均 200 token/条算约 5k token 前缀，已接近总量级上限。
 */
export const TOOL_MAX = 24;

/** 工具描述的长度上限（同样进每一轮前缀，且是固定成本里最容易被忽略的一块） */
const TOOL_DESC_MAX = 512;

/** 非法字符的替换字符 */
const BAD_RUN_RE = /[^A-Za-z0-9_-]+/g;

/**
 * 把任意来源的 id 收敛成合法的 function name。
 *
 * @param {unknown} raw
 * @returns {string} 合法名字；**收敛不出合法名字时返回空串**（调用方必须当失败处理，
 *   不许拿空串去注册 —— 空串在多数服务端会被当成"没给名字"而静默忽略整个工具）
 */
export function normalizeToolName(raw) {
  let s = String(raw ?? '').trim();
  if (!s) return '';
  s = s.replace(BAD_RUN_RE, '_');
  // 首尾下划线去掉：`_echo-guard_` 与 `echo-guard` 收敛成同一个名字，
  // 否则同一份扩展包在不同命名习惯下会被当成两个工具。
  s = s.replace(/^_+/, '').replace(/_+$/, '');
  if (!s) return '';
  return s.slice(0, TOOL_NAME_MAX);
}

/**
 * 描述归一化：**必须压成单行**。
 * 换行会让 schema 在服务端的解析边界变得不确定，也会让面板上的展示裂成多行；
 * 而"把描述写清楚"本身就是给模型看的，不需要排版。
 */
function normalizeDescription(raw) {
  const s = String(raw ?? '').replace(/\s+/g, ' ').trim();
  return s.slice(0, TOOL_DESC_MAX);
}

/**
 * 参数 schema 归一化。
 *
 * 只接受 object 型的 JSON Schema —— function calling 的 `parameters` 约定如此。
 * 缺省补成「无参数」的合法形状，**不是** undefined：某些服务端收到 `parameters: undefined`
 * 与收到 `{type:'object',properties:{}}` 的行为不同（前者可能整条 tools 被忽略）。
 *
 * @returns {object|null} null 表示形状不可救（调用方拒绝注册，别猜一个出来）
 */
export function normalizeParameters(raw) {
  if (raw === undefined || raw === null) return { type: 'object', properties: {} };
  if (typeof raw !== 'object' || Array.isArray(raw)) return null;
  const type = raw.type ?? 'object';
  if (type !== 'object') return null;
  const properties = raw.properties ?? {};
  if (typeof properties !== 'object' || Array.isArray(properties)) return null;
  const out = { ...raw, type: 'object', properties };
  if (out.required !== undefined && !Array.isArray(out.required)) return null;
  return out;
}

/**
 * 一条工具定义归一化。宿主与测试**共用这一份** —— 在别处再写一套"什么算合法工具"，
 * 就等于把本批要钉住的语义又抄了一遍。
 *
 * @param {{id?:string, name?:string, title?:string, description?:string,
 *          parameters?:object, execute?:Function, owner?:string}} def
 * @returns {{ok:true, name:string, spec:object, execute:Function, owner:string, origin:string}
 *          |{ok:false, reason:string}}
 */
export function normalizeToolDef(def) {
  if (!def || typeof def !== 'object') return { ok: false, reason: '工具定义不是对象' };
  const origin = String(def.id ?? def.name ?? '').trim();
  const name = normalizeToolName(def.id ?? def.name);
  if (!name) return { ok: false, reason: `工具 id「${origin}」收敛不出合法的 function name` };
  if (typeof def.execute !== 'function') {
    // 生态约定是 execute(ctx, args)（见文件头）。缺了它的定义注册了也调不到，
    // 当场拒绝并给中文原因 —— 静默收下等于"模型列表里有个永远报错的幽灵"。
    return { ok: false, reason: `工具「${name}」没有 execute 函数 —— 注册了也调不到，等于摆设` };
  }
  const parameters = normalizeParameters(def.parameters);
  if (!parameters) {
    return { ok: false, reason: `工具「${name}」的 parameters 不是 object 型 JSON Schema` };
  }
  const description = normalizeDescription(def.description ?? def.title);
  return {
    ok: true,
    name,
    spec: { type: 'function', function: { name, description, parameters } },
    execute: def.execute,
    owner: String(def.owner ?? '').trim(),
    origin,
  };
}

/**
 * 深冻结。
 * `specs()` 返回的数组会**跨轮次复用**，一旦有谁就地改了一下（例如补一个默认值），
 * 后面每一轮的前缀都会带着那个改动 —— 而"tools 逐轮稳定"这条约束就静默失效了。
 * 冻结把"约定"变成"结构上做不到"。
 */
function deepFreeze(o) {
  if (!o || typeof o !== 'object' || Object.isFrozen(o)) return o;
  Object.freeze(o);
  for (const v of Object.values(o)) deepFreeze(v);
  return o;
}

/**
 * 扩展包注册工具时的**取名规则** —— 纯函数，全项目唯一一处。
 *
 * 为什么要前缀：两个扩展包各自注册一个叫 `search` 的工具是**很正常的事**，
 * 而 tools 数组进的是同一份 function 列表，撞名只能有一个生效。
 * 撞名若被静默处理，"谁的工具在跑"就变成未解之谜。
 *
 * 形状与参考实现（QQ-Agent v0.31 · `createSkillApi`）一致：
 *   `owner__toolId`，owner 截 24、工具名截 38，加两个下划线正好 ≤ 64。
 *   ⚠️ 上限来源是 **`TOOL_NAME_MAX`**（同一个数字不写两遍）。
 *   ⚠️ 分隔符用双下划线：`:` / `.` 会被严格端点判成非法 function name，
 *      直接 400 掉**整个请求**（不是掉这一个工具）。
 *
 * @param {string} owner 扩展包 id（清单里的英文 id）
 * @param {string} rawId 扩展包自己的工具 id
 * @returns {string} 合法 function name；两个入参都收敛不出名字时返回空串
 */
export function scopedToolId(owner, rawId) {
  const o = normalizeToolName(owner);
  const t = normalizeToolName(rawId);
  if (!o && !t) return '';
  if (!o) return t.slice(0, TOOL_NAME_MAX);
  if (!t) return o.slice(0, TOOL_NAME_MAX);
  const sep = '__';
  const ownerPart = o.slice(0, 24);
  const room = TOOL_NAME_MAX - ownerPart.length - sep.length;
  return `${ownerPart}${sep}${t.slice(0, Math.max(1, room))}`;
}

/**
 * 建一个注册表。**纯内存，不碰 IO** —— 宿主持盘、这里只装结果。
 *
 * 为什么把"谁去磁盘上找扩展包"留在外面：那是 `src/plugin-host.js` 的活。
 * 这里一旦也去读盘，就会出现"两处各自知道怎么发现扩展包"，
 * 而这正是本项目反复在清的那种重复。
 */
export function createToolRegistry() {
  /** @type {Map<string, {spec:object, execute:Function, owner:string, origin:string}>} */
  const items = new Map();
  /**
   * 缓存的 specs。`null` = 需要重建。
   * ⚠️ 只由本闭包赋值，外部拿不到写入口 —— 这是"逐轮稳定"的实现基础。
   */
  let cache = null;

  const registry = {
    /**
     * 注册一个工具。
     * @returns {{ok:true, name:string}|{ok:false, reason:string}}
     */
    register(def) {
      const n = normalizeToolDef(def);
      if (!n.ok) return { ok: false, reason: n.reason };
      const prev = items.get(n.name);
      if (prev) {
        // 撞名 → 拒绝。**不许覆盖**：覆盖的表现是"某个插件悄悄把别人的工具顶掉了"，
        // 而它不会有任何日志。热重载要换实现请先 unregister。
        return {
          ok: false,
          reason: prev.origin === n.origin
            ? `工具「${n.name}」已经注册过（同一来源 ${n.origin} 重复注册）`
            : `工具名撞车：「${n.origin}」与「${prev.origin}」都收敛成「${n.name}」`,
        };
      }
      if (items.size >= TOOL_MAX) {
        return { ok: false, reason: `工具数已达上限 ${TOOL_MAX}（不再注册「${n.name}」）` };
      }
      items.set(n.name, { spec: n.spec, execute: n.execute, owner: n.owner, origin: n.origin });
      cache = null;
      return { ok: true, name: n.name };
    },

    /** 注销。返回"之前有没有"，便于调用方区分"删掉了"与"本来就没有"。 */
    unregister(name) {
      const key = normalizeToolName(name);
      if (!key || !items.has(key)) return false;
      items.delete(key);
      cache = null;
      return true;
    },

    has(name) {
      return items.has(normalizeToolName(name));
    },

    size() {
      return items.size;
    },

    /** 已注册的名字（**已排序**，顺序与 specs() 一致） */
    names() {
      return [...items.keys()].sort();
    },

    /** 元信息（面板展示用：别把 execute 下发出去，它不可序列化） */
    meta() {
      return [...items.values()]
        .map((v) => ({ name: v.spec.function.name, owner: v.owner, origin: v.origin, description: v.spec.function.description }))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    },

    /**
     * 给 `body.tools` 用的数组。**同一个引用，直到注册表变化**。
     * 顺序固定为按 name 升序 —— 与装载顺序无关。
     */
    specs() {
      if (cache) return cache;
      cache = deepFreeze([...items.values()].map((v) => v.spec)
        .sort((a, b) => (a.function.name < b.function.name ? -1 : a.function.name > b.function.name ? 1 : 0)));
      return cache;
    },

    /**
     * 取 execute。**调用方负责 try/catch** —— 工具自己抛错不该炸掉这一轮回复，
     * 但那属于工具回合的职责（见 src/tool-loop.js），不在这里吞。
     */
    executorOf(name) {
      return items.get(normalizeToolName(name))?.execute ?? null;
    },
  };

  return registry;
}
