/**
 * ══════════════════════════════════════════════════════════════════════
 *  扩展包清单（skill.json / plugin.json）的**唯一判据**
 *  第 44 轮 B12d · EX-PLUGIN / EX-APIVER
 * ══════════════════════════════════════════════════════════════════════
 *  这一层要做的事情只有一件：**在把磁盘上的东西当成插件之前，先把它看清楚**。
 *  本轮（B12d）**不执行**任何扩展包代码（不 import、不跑 hooks、不注册工具）——
 *  那是「执行层」的事，它需要 function calling 链路作为前置，本项目目前没有。
 *  所以这里判的是"这个包**像不像**一个可加载的扩展"，而不是"它能不能跑"。
 *
 *  ────────────────────────────────────────────────────────────────────
 *  ⚠️ 本轮改写了第 35 轮写下的规格（v2 §4），三条都与原规格不同
 *  ────────────────────────────────────────────────────────────────────
 *  原规格是在**没有看过真实扩展包**的情况下抽象出来的。第 44 轮开工前
 *  拿 13 个真实扩展包（QQ-Agent 扩展包 · MIT）实测，三条对不上：
 *
 *  | 规格 v2 §4 原文 | 实测的真形状 | 本文件怎么判 |
 *  |---|---|---|
 *  | `capabilities` 白名单裁剪 ctx | `capabilities` 是**提供能力**（providers）；权限声明另有其名 `permissions`（如 `web_fetch`） | 两个字段分开收，谁也不当权限判据用 |
 *  | `setup` 不许起副作用 | `setup(api)` 的本职就是注册工具，它**必须**能改状态 | 本轮不执行，所以这条暂时无处落地；见报告「偏差」 |
 *  | 无清单目录直接跳过 | 真实实现把它登记为**可见的失败条目** | **不跳过**：登记成 `no-manifest` 的拒绝项 |
 *
 *  第三条特别重要：规格原话是"静默跳过"，而本项目第 11 条纪律恰好是
 *  「**'失败会伪装成成功'是一类，要单独防**」——用户把扩展包放错一层目录，
 *  表现会是"它不存在"，日志里一个字都没有。所以这里改成**登记 + 报错**。
 *
 *  ⚠️ **目录名与 id 是解耦的**（真实扩展包的 README 明写）：
 *     目录名可以是中文（`复读拦截`），清单里的 `id` 必须是英文（`echo-guard`），
 *     **加载器以 id 为准**。所以 `normalizeManifest` 收一个 `fallbackId`，
 *     只在清单里压根没有 id 时才拿目录名兜底 —— 而兜底出来若含中文，
 *     会作为**致命问题**报出来（它注定匹配不上任何白名单项）。
 *     ⚠️ **绝不要**加一条"id 必须等于目录名"的判据：那会让 13 个真实扩展包
 *        全部加载失败，而本项目 5 个真实插件里有 5 个是中文目录名。
 *
 *  ⚠️ **零依赖叶子**：本文件不 import 任何东西 —— 连 `node:path` 都不要，
 *     路径安全判定全部用**纯字符串**完成（见 `isSafeRelPath`）。
 *     理由与 `src/gate-scan.js` 相同：它会被机器人进程与测试同时加载，
 *     多一个依赖就多一条成环的路。真正的路径拼接由 `src/plugin-host.js` 做。
 */

/** 宿主支持的扩展 API 版本。扩展包清单里 `apiVersion` 不等于它 → 拒绝加载（EX-APIVER）。 */
export const PLUGIN_API_VERSION = 1;

/**
 * 清单文件名，**按优先序**。真实生态里两个名字都在用，功能等价：
 * `skill.json` 是新形态，`plugin.json` 是旧形态（兼容）。
 * 同一个目录里两个都有时取前者 —— 必须有确定的优先序，否则
 * "今天加载的是哪一份"会随目录列举顺序变化，那是不可复现的缺陷。
 */
export const MANIFEST_FILES = ['skill.json', 'plugin.json'];

/**
 * 目录 → 语义类型。真实生态里这是**分类**，不是新旧：
 *   `plugins/`  确定性型 —— 提供能力或钩子，满足条件就一定被执行
 *   `skills/`   LLM 型   —— 注册工具，用不用由模型自己判断
 * 本轮两者都只做到"被识别、被校验、被报告"，行为上等价；
 * 保留这个字段是为了报告里能说清"这个包本来该在哪一档"。
 */
export const DIR_KINDS = { plugins: 'plugin', skills: 'skill' };

/**
 * 最多允许启用的扩展条目数（经验值，非官方阈值）。
 * 它**不是**性能上限，是"配置写坏了"的兜底：一个把目录名写成通配符的
 * `enabled` 列表不该让机器人去扫一万个包。与 `SKILL_MAX` 同一性质。
 */
export const PLUGIN_MAX = 20;

/** 入口文件默认名。清单里 `entry` 缺省时用它。 */
const DEFAULT_ENTRY = 'index.js';

/**
 * 合法 id：**必须是英文**（字母开头，后跟字母/数字/下划线/连字符，总长 ≤ 40）。
 *
 * 为什么这么严：id 会变成日志前缀、白名单键、以及（将来的）工具名前缀。
 * 真实扩展包的 README 原话是"写成中文会导致加载失败" —— 这里把那条经验
 * 变成一条能提前报出来的判据，而不是等运行期炸。
 */
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;

/**
 * id 合法性判据的**唯一出口**。
 *
 * 为什么要 export：配置侧的白名单（`custom.plugins.enabled`）与清单侧
 * （`plugin.json` 的 `id`）用的是**同一条正则**。两边各写一遍必然漂移，
 * 而漂移的表现是"清单能正常加载、白名单却怎么填都匹配不上" ——
 * 不报错、只是没效果，正是本项目最难查的那一类。
 * 所以 `src/custom-config.js` 的归一化也 import 这一个函数，不另写判据。
 */
export function isValidPluginId(s) {
  return typeof s === 'string' && ID_RE.test(s);
}

/**
 * 去掉 UTF-8 BOM。
 *
 * 真实生态踩过的坑，原样保留：Windows 上的记事本 / 部分 VS Code 配置 /
 * PowerShell 的 `Out-File -Encoding utf8` 都会写 BOM，而 `JSON.parse`
 * 遇到 `\uFEFF` 会直接抛 "Unexpected token"，**报错信息完全不提 BOM**。
 * 用户看到的是"清单明明是对的却加载失败"，无从查起。
 *
 * ⚠️ 纯函数、只吃字符串 —— 本模块不做 IO，读文件是 `plugin-host.js` 的事。
 */
export function stripBom(text) {
  if (typeof text !== 'string') return '';
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * 相对路径安全判定 —— **纯字符串**，不碰 fs，不碰 path。
 *
 * 拦的是四类（每一类都有真实的越界写法）：
 *   · 绝对路径        `/etc/passwd`、`C:\windows\x.js`
 *   · 上跳段          `../../outside.js`、`a/../b.js`
 *   · 空段 / 尾斜杠    `a//b.js`、`index.js/`（拼出来指向目录，不是文件）
 *   · NUL 注入        `index.js\u0000.png`
 *
 * ⚠️ 判据用**分段相等**判 `..`，不用子串包含 —— `..foo.js` 是合法文件名，
 *    用 `includes('..')` 会把它误杀（这类误杀比漏放更贵，见纪律第 25 条）。
 * ⚠️ `./index.js` 是**允许**的：它归一化之后仍在目录内，
 *    而真实清单里确实有人这么写。
 * ⚠️ 本判据只看字符串。**符号链接**要 realpath 之后才判得出，
 *    那是 `plugin-host.js` 的活（它才有 fs）。
 */
export function isSafeRelPath(p) {
  if (typeof p !== 'string' || !p) return false;
  if (p.includes('\u0000')) return false;
  if (p.startsWith('/') || p.startsWith('\\')) return false;
  if (/^[A-Za-z]:/.test(p)) return false;
  const segs = p.split(/[\\/]/);
  return segs.every((s) => s !== '' && s !== '..');
}

/** 归一化一个字符串数组字段（对非字符串项直接丢弃，并记一条警告）。 */
function strList(v, max, problems, field) {
  const raw = Array.isArray(v) ? v : [];
  const out = [];
  for (const it of raw) {
    if (typeof it !== 'string') {
      problems.push({ code: 'bad-list-item', text: `${field} 里有非字符串项，已丢弃` });
      continue;
    }
    const s = it.trim();
    if (s) out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * 把一份原始清单归一化成宿主认得的结构。
 *
 * @param {unknown} raw 已经 `JSON.parse` 过的对象
 * @param {{fallbackId?:string, kind?:string}} opts
 *        `fallbackId` 是**目录名**（可以含中文），只在清单里没有可用 id 时兜底；
 *        `kind` 由所在目录决定（见 `DIR_KINDS`）。
 * @returns {{manifest:object|null, fatal:Array<{code,text}>, problems:Array<{code,text}>}}
 *        `fatal` 非空 = **不可用**（调用方据此拒绝这一条，且只拒这一条）；
 *        `problems` 非空但仍可用 = 能加载，只是有瑕疵需要报出来。
 *        ⚠️ 两者**故意分开**：混成一个数组的话，调用方只能靠字符串猜
 *           "这条算不算致命"，而本项目的教训正是"判据不该靠猜"。
 */
export function normalizeManifest(raw, { fallbackId = '', kind = null } = {}) {
  const fatal = [];
  const problems = [];

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    fatal.push({ code: 'not-an-object', text: '清单顶层不是一个对象' });
    return { manifest: null, fatal, problems };
  }

  // ── id：清单优先，目录名兜底 ──────────────────────────────────────────
  const rawId = typeof raw.id === 'string' ? raw.id.trim() : '';
  let id = rawId;
  if (!id) {
    const fb = String(fallbackId || '').trim();
    if (fb) {
      id = fb;
      problems.push({ code: 'id-from-dirname', text: `清单没写 id，回退成目录名「${fb}」` });
    }
  }
  if (!id) fatal.push({ code: 'bad-id', text: '清单没有 id，目录名也取不到' });
  else if (!isValidPluginId(id)) {
    fatal.push({
      code: 'bad-id',
      text: `id「${id}」不是合法英文 id（需字母/数字/下划线/连字符，≤40 字）`,
    });
  }

  // ── apiVersion：定死，不符即拒（EX-APIVER）────────────────────────────
  const apiVersion = Number(raw.apiVersion);
  if (!Number.isInteger(apiVersion)) {
    fatal.push({ code: 'bad-api-version', text: `apiVersion 不是整数：${JSON.stringify(raw.apiVersion)}` });
  } else if (apiVersion !== PLUGIN_API_VERSION) {
    fatal.push({
      code: 'api-version-mismatch',
      text: `apiVersion ${apiVersion} 与宿主 ${PLUGIN_API_VERSION} 不符`,
    });
  }

  // ── entry：默认 index.js，必须在包内（纯字符串层先拦一次）──────────────
  const entry = raw.entry == null || raw.entry === '' ? DEFAULT_ENTRY : String(raw.entry).trim();
  if (!isSafeRelPath(entry)) {
    fatal.push({ code: 'bad-entry', text: `entry 必须是包内的相对路径：${entry}` });
  }

  const version = typeof raw.version === 'string' && raw.version.trim() ? raw.version.trim() : '0.0.0';
  if (version === '0.0.0' && String(raw.version ?? '').trim() !== '0.0.0') {
    problems.push({ code: 'missing-version', text: '清单没写 version，按 0.0.0 记' });
  }
  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : id || '(未命名)';
  if (!(typeof raw.name === 'string' && raw.name.trim())) {
    problems.push({ code: 'missing-name', text: '清单没写 name，用 id 代替' });
  }

  const schemaKeys = raw.configSchema && typeof raw.configSchema === 'object' && !Array.isArray(raw.configSchema)
    ? Object.keys(raw.configSchema)
    : [];
  if (schemaKeys.length === 0 && raw.configSchema) {
    problems.push({ code: 'bad-schema', text: 'configSchema 不是对象，已忽略' });
  }

  // ── 清单自带的**默认设置**，必须原样带出去（第 55 轮修）───────────────
  // ⚠️ 这里此前**只留 `schemaKeys`、丢掉整个 schema**，注释写的是"本轮不渲染配置界面，
  //    留着没人读"。那句话当时是对的 —— 但第 55 轮把设置编辑做起来了，
  //    `settingsOf()` 与面板都要读它，于是"丢掉"变成了真缺陷：
  //    **`api.config()` 返回的一直是空对象**，13 个真实包里所有清单默认值
  //    （`cookie` / `maxSubtitleChars` / `defaultSource`…）从来没到过包手里。
  //    而 T117 / T167 用手搓的 manifest 直接调 `buildApi`，**绕过了归一化** →
  //    生产是坏的、测试是绿的（本项目第 12 条那一类："mock 不模拟 = 测试里不存在"）。
  // ⚠️ 生态真实用法是 `settings`（13 个包全是它），`configSchema` 是 v2 §5 的设想，两者都认。
  const settings = raw.settings && typeof raw.settings === 'object' && !Array.isArray(raw.settings)
    ? { ...raw.settings }
    : {};
  if (!Object.keys(settings).length && raw.settings) {
    problems.push({ code: 'bad-settings', text: 'settings 不是对象，已忽略' });
  }
  /** 设置项**键名**（给面板/运行态快照用）：声明式 schema 的键 ∪ 默认值的键，去重 */
  const settingsKeys = [...new Set([...schemaKeys, ...Object.keys(settings)])];

  // 既然已经致命了就不必再收细节字段 —— 返回的 manifest 只做排障用，不该被当真。
  const manifest = {
    id,
    name,
    version,
    apiVersion: Number.isInteger(apiVersion) ? apiVersion : null,
    kind,
    category: typeof raw.category === 'string' ? raw.category.trim() : '',
    description: typeof raw.description === 'string' ? raw.description.trim() : '',
    author: typeof raw.author === 'string' ? raw.author.trim() : '',
    /** 清单里声明"默认就启用"。本轮**不采信**它 —— 启用只认 config 白名单（见 plugin-host.js）。 */
    enabledByDefault: raw.enabledByDefault === true,
    /** 该包**提供**的能力（providers 的名字）。⚠️ 不是权限，别当权限判据用。 */
    capabilities: strList(raw.capabilities, 20, problems, 'capabilities'),
    /** 该包**申请**的权限（如 web_fetch）。本轮只记录，不发放（没有执行层可发）。 */
    permissions: strList(raw.permissions, 20, problems, 'permissions'),
    /** 硬依赖：清单里声明"缺了就别启用我"的其它包 id。 */
    requires: strList(raw.requires, 20, problems, 'requires'),
    entry,
    /** 声明式 schema 的键名（`configSchema` 那一套）。 */
    schemaKeys,
    /**
     * 清单自带的**默认设置**（生态真实用法）。**必须带出去** ——
     * `settingsOf()` 以它打底、面板用它列出"这个包有哪些键可填"。
     * 丢了它就等于所有包的设置都成了空对象，且不报错。
     */
    settings,
    /** 设置项的键名合计（`schemaKeys` ∪ `settings` 的键）。消费方只读这一份。 */
    settingsKeys,
  };

  return { manifest, fatal, problems };
}

/**
 * 白名单判定 —— **纯函数**，宿主据此决定"扫到了但要不要加载"。
 *
 * ⚠️ 这是第 44 轮**用户裁决**与规格相冲突的那一条，单独写清楚：
 *   规格（v2 §4）写的是"`plugins/<id>/plugin.json` 就加载"，即**纯目录扫描**。
 *   本项目既有先例是**白名单**（`allow.groups`、`custom.skills` 都是"显式登记才生效"）。
 *   在"丢个文件进目录就被执行"与"多写一行配置"之间，用户选了后者 ——
 *   这是一台每天在真实 QQ 群里说话的机器，隐式执行路径不是它的风格。
 *   所以：目录扫描**只负责发现候选**，真正加载必须在 `config.json` 里显式列出。
 *
 * ⚠️ 白名单项是 **id**（英文），不是目录名 —— 与"以 id 为准"同一条约定。
 *
 * @param {Array} entries 扫描结果，每项形如
 *        `{dir, dirName, kind, source, manifest, fatal, problems}`
 * @param {Iterable<string>} enabledIds config 里显式启用的 id 集合
 * @returns {Array<{id, dir, dirName, kind, action, reason, problems}>}
 *        `action`：`load`（可加载）｜`skip`（发现了但没启用，**不是错误**）｜`reject`（有问题）
 *        `reason`：`enabled` / `not-enabled` / `no-manifest` / 或 fatal[0].code
 */
export function planLoad(entries, enabledIds) {
  const want = new Set();
  for (const x of enabledIds || []) want.add(String(x));

  const out = [];
  for (const e of entries || []) {
    if (!e) continue;
    const dirName = String(e.dirName || '');
    const id = e.manifest?.id || dirName;
    // `detail` 是**给人看的那一句**：`reason` 是给机器判的 code，两者都要有。
    // 只给 code 的后果是日志里写着 `reject: bad-entry`，用户得回来翻源码才知道哪里错了。
    // `manifest` 一起带出去：报告里要能报版本 / 名称，不能只留一个 id。
    const base = {
      id,
      dir: e.dir,
      dirName,
      kind: e.kind ?? null,
      manifest: e.manifest || null,
      problems: e.problems || [],
      detail: '',
    };

    // ① 没有清单 → 拒绝并**登记**（不是静默跳过）。
    //    真实实现把这一步做成"可见的失败条目"，本项目第 11 条纪律（失败不许伪装成成功）
    //    支持同一个方向：用户把包放错一层，应当立刻在报告里看见，而不是"它不存在"。
    if (!e.manifest) {
      const reason = e.fatal?.[0]?.code || 'no-manifest';
      const detail = e.fatal?.[0]?.text || '缺少 skill.json / plugin.json';
      out.push({ ...base, action: 'reject', reason, detail });
      continue;
    }

    // ② 清单本身不可用（id / apiVersion / entry 出问题）→ 拒绝。
    //    EX-APIVER 的落点：版本不符**只拒这一条**，其余照常（第 44 轮用户裁决）。
    if (e.fatal?.length) {
      out.push({ ...base, action: 'reject', reason: e.fatal[0].code, detail: e.fatal[0].text });
      continue;
    }

    // ③ 没在白名单里 → skip。**这不是错误**，是正常状态：
    //    用户把包拷进来只是"我装了"，启用与否是配置里的事。
    if (!want.has(id)) {
      out.push({ ...base, action: 'skip', reason: 'not-enabled', detail: '未在 config 的白名单里启用' });
      continue;
    }

    out.push({ ...base, action: 'load', reason: 'enabled', detail: '已启用' });
  }
  return out;
}

/**
 * 把计划折成一份可直接进日志 / 报告的汇总。
 *
 * ⚠️ 必须把**每个原因的出现次数**都算出来，而不是只给三个总数 ——
 *    本项目的教训（纪律第 13 条）是"输入基数必须打印"，
 *    否则"全被拒绝了"与"一个都没扫到"在汇总长得一模一样。
 */
export function summarize(plan) {
  const s = {
    total: 0, load: 0, skip: 0, reject: 0,
    byReason: {},
    byKind: {},
  };
  for (const p of plan || []) {
    s.total += 1;
    s[p.action] = (s[p.action] || 0) + 1;
    s.byReason[p.reason] = (s.byReason[p.reason] || 0) + 1;
    const k = p.kind || 'unknown';
    s.byKind[k] = (s.byKind[k] || 0) + 1;
  }
  return s;
}
