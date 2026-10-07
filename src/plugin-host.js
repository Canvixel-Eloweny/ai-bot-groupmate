/**
 * ══════════════════════════════════════════════════════════════════════
 *  扩展包宿主 —— 目录扫描 / 清单读取 / 白名单接线
 *  第 44 轮 B12d · EX-PLUGIN
 * ══════════════════════════════════════════════════════════════════════
 *  本文件是这一层**唯一碰磁盘的地方**。判据一律不在这里 ——
 *  它们全在 `src/plugin-manifest.js`（纯函数、零依赖、可被 smoke 直接喂输入）。
 *  这里只做三件事：列目录、读文件、把结论接进日志。
 *  （纪律：能切成"纯函数 + 一处接线"的，就不要把判据混进 IO 里。）
 *
 *  ────────────────────────────────────────────────────────────────────
 *  ⚠️ 第 44 轮（B12d）只识别；**第 46 轮（B12e-2）起真的执行**
 *  ────────────────────────────────────────────────────────────────────
 *  本文件现在有**两段**，职责分明：
 *
 *  | 段 | 入口 | 碰不碰磁盘 | 执行外来代码吗 |
 *  |---|---|---|---|
 *  | ① 扫描 / 校验 / 白名单 | `loadExtensions()`（第 44 轮交付，未改语义） | 读 | **不** |
 *  | ② 加载 / 执行 / 四态生命周期 | `createExtensionHost()`（第 46 轮新增） | 读 + `import()` | **是** |
 *
 *  ① 被面板侧（`panel/lib/extensions.js`）复用 —— 面板要能在**机器人没跑**的时候
 *  回答"我装的包对不对"。② 只由机器人进程调用，因为它会真的执行别人的代码。
 *  两段共用同一份判据（`plugin-manifest.js`）与同一套目录推导（`extensionRoots`）。
 *
 *  ⚠️ **不支持热插拔**（规格 v2 §5 明写）。具体含义：
 *    · `load()` 幂等 —— 第二次调用直接返回上一次的结果，不重新 import；
 *    · ESM 的模块缓存意味着"同一个包在进程里只有一个实例"，
 *      它的模块级状态（如 `复读拦截` 的 `history` Map）也就只有一份；
 *    · 改了配置要生效 → **重启机器人**。这与本项目既有的"改 src 要重启"同一条规矩。
 *
 *  ⚠️ **这是本项目第一次执行磁盘上的外来代码**（附 Q.5 风险 5）。两道闸：
 *    ① `entry` 的 realpath 校验从"警告"升级为**必查**（越界 / 不存在 / 不是文件 → 拒绝）；
 *    ② `permissions` 真的裁剪 ctx（`api.fetch` 只有声明 `web_fetch` 才给）。
 *  另外：**一个包失败只拒它自己**，其余照常加载 —— 与 `EX-APIVER` 第 44 轮的
 *  用户裁决同一条（"只拒绝那一个扩展"）。
 *
 *  ────────────────────────────────────────────────────────────────────
 *  ⚠️ 这里的 `skills/` 与本项目自己的 `src/skills.js` **是两回事**
 *  ────────────────────────────────────────────────────────────────────
 *  名字撞了，载体和范式都不同 —— 混淆它们的后果是"改了 A 以为在改 B"：
 *
 *  | | 载体 | 范式 | 怎么生效 |
 *  |---|---|---|---|
 *  | `custom.skills`（`src/skills.js`） | config.json 里的**数据** | 提示词注入 | 命中触发词就拼进提示词 |
 *  | `skills/`（本模块） | 磁盘上的**目录** | 工具调用 | 注册成模型可调用的工具 |
 *
 *  所以本模块**不许** import `./skills.js` —— 由 `check-wb` 的契约盯着。
 *  两者将来若有交汇，必须是**显式的一处接线**，不是悄悄互相引用。
 *
 *  ────────────────────────────────────────────────────────────────────
 *  ⚠️ 路径常量**不在本文件推导**
 *  ────────────────────────────────────────────────────────────────────
 *  `ROOT` 只许推导一次（`panel/lib/paths.js` 的教训：在错误层级算一次路径
 *  不会报错，只会"读不到东西然后用默认值继续跑"）。
 *  仓库根由调用方 `src/index.js` 传进来；本模块只负责拼它下面的两个子目录。
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  DIR_KINDS,
  MANIFEST_FILES,
  normalizeManifest,
  planLoad,
  stripBom,
  summarize,
} from './plugin-manifest.js';
import { buildApi, activateCtxOf, splitPermissions } from './plugin-api.js';
// 扩展包的 fetch（受出站策略约束）。与 `ext-scope.js` 同族：外来代码要碰
// 网络，就只给"审过地址"的那一条路。
import { createExtFetch } from './ext-fetch.js';
import { scopedToolId } from './tool-registry.js';

/**
 * 可覆盖根目录的环境变量名（**新增"会落盘/会读取的目录"三件套之一**）。
 * 另外两件：`.gitignore` 挡住不进 git、`test/sandbox.sh` 的 `--exclude` 挡住不进沙箱。
 * 漏掉这里的后果是 smoke 跑一遍，用户真实目录里的扩展包被当成 fixture 读进来。
 * 由 `check-wb` 的三条契约盯着（同 `QQBOT_TRACE_FILE` / `QQBOT_SESSION_ARCHIVE` 的做法）。
 */
export const EXTENSION_ENV = ['QQBOT_PLUGINS_DIR', 'QQBOT_SKILLS_DIR'];

/** 两个根：`plugins/`（确定性型）+ `skills/`（LLM 型）。环境变量优先级高于默认值。 */
export function extensionRoots(root) {
  const [envPlugins, envSkills] = EXTENSION_ENV.map((k) => process.env[k]);
  return [
    {
      dir: envPlugins ? path.resolve(envPlugins) : path.join(root, 'plugins'),
      kind: DIR_KINDS.plugins,
      name: 'plugins',
    },
    {
      dir: envSkills ? path.resolve(envSkills) : path.join(root, 'skills'),
      kind: DIR_KINDS.skills,
      name: 'skills',
    },
  ];
}

/** 这个路径是不是目录（能把目录符号链接一起收进来，又不会把指向文件的链接当目录）。 */
function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 列出直接子目录。返回 `null` 表示**根目录本身**读不到（不存在 / 无权限）——
 * 这与"目录存在但是空的"是两件不同的事，必须能区分：
 * 前者是"用户还没建这个目录"（正常），后者可能意味着"路径配错了"（要报）。
 *
 * ⚠️ `.sort()` 不是为了好看：目录列举顺序不确定时，"今天加载的是哪一份"
 *    会随文件系统变化，而不可复现的缺陷最难查。
 */
function listSubdirs(dir) {
  let ents;
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  return ents
    // ⚠️ 跳过 `.` 开头的目录（D21）：扩展包安装的 staging / 备份临时目录名字
    //    沿用 `atomic-write.js` 的临时文件形状（`.<名字>.<pid>.<8hex>.tmp`），
    //    一律以点开头。不过滤的话，一次安装过程会被扫成一个**坏包**
    //    （无清单 → reject）显示在面板上 —— 用户看到的是"我没装过这个东西"。
    .filter((e) => !e.name.startsWith('.')
      && (e.isDirectory() || (e.isSymbolicLink() && isDir(path.join(dir, e.name)))))
    .map((e) => e.name)
    .sort();
}

/**
 * 读一个目录里的清单：按 `MANIFEST_FILES` 的优先序取第一份存在的。
 * 缺失返回 `error`，解析失败也返回 `error` —— 两种情况在调用方都折成同一条拒绝，
 * 但文案不同（"缺少清单" vs "清单解析失败：Unexpected token"）。
 */
function readManifest(dir) {
  for (const file of MANIFEST_FILES) {
    const p = path.join(dir, file);
    if (!fs.existsSync(p)) continue;
    const source = file.replace(/\.json$/, '');
    try {
      return { raw: JSON.parse(stripBom(fs.readFileSync(p, 'utf8'))), source };
    } catch (e) {
      return { error: `清单解析失败（${file}）：${e.message}`, source };
    }
  }
  return { error: `缺少清单文件（${MANIFEST_FILES.join(' / ')}）`, source: null };
}

/**
 * 入口文件是否逃出了包目录 —— **要 realpath 之后才判得准**。
 *
 * 纯字符串层（`isSafeRelPath`）已经拦住了 `../` 与绝对路径；
 * 这里补的是**符号链接**：包目录里放一个 `index.js -> /etc/passwd`，
 * 字符串层看它是老实的相对路径，只有 realpath 才露馅。
 *
 * 返回值：`null` = 没越界；字符串 = 越界原因。
 * ⚠️ 本轮不执行入口，所以"文件不存在"**不算越界**，由调用方记为警告而非拒绝。
 */
function entryEscapeReason(dir, entry) {
  const entryPath = path.resolve(dir, entry);
  const rel = path.relative(dir, entryPath);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return `entry 越出了包目录：${entry}`;
  try {
    const realDir = fs.realpathSync(dir);
    const realEntry = fs.realpathSync(entryPath);
    const relReal = path.relative(realDir, realEntry);
    if (relReal.startsWith('..') || path.isAbsolute(relReal)) {
      return `entry 经符号链接指向包外：${entry}`;
    }
  } catch {
    // realpath 失败 = 文件不存在或链接断掉 → 不是越界，交给调用方判"入口缺失"
  }
  return null;
}

/** 扫描一个包目录，产出一条 entry（形状见 `planLoad` 的 @param 说明）。 */
function scanOne(dir, dirName, kind) {
  const base = { dir, dirName, kind, source: null, manifest: null, fatal: [], problems: [] };

  const found = readManifest(dir);
  base.source = found.source;
  if (found.error) {
    // ⚠️ 这里**不是**静默跳过（规格 v2 §4 原话是"无清单目录直接跳过"）——
    //    用户把包多套了一层目录、或者清单名写错，跳过之后它在界面上"不存在"，
    //    日志里一个字都没有。本项目吃过这个形状的亏（第 11 条纪律）。
    base.fatal.push({ code: 'no-manifest', text: found.error });
    return base;
  }

  const { manifest, fatal, problems } = normalizeManifest(found.raw, { fallbackId: dirName, kind });
  base.manifest = manifest;
  base.fatal = fatal;
  base.problems = problems;
  if (fatal.length) return base;

  const esc = entryEscapeReason(dir, manifest.entry);
  if (esc) {
    base.fatal = [{ code: 'entry-escapes', text: esc }];
    return base;
  }
  const entryPath = path.resolve(dir, manifest.entry);
  if (!fs.existsSync(entryPath)) {
    // 本轮不执行，所以只是警告 —— 但它必须**被报出来**：
    // 这个包将来接执行层时一定加载失败，早点说比那时候再说便宜。
    base.problems.push({ code: 'entry-missing', text: `入口文件不存在：${manifest.entry}` });
  } else if (!fs.statSync(entryPath).isFile()) {
    base.problems.push({ code: 'entry-not-file', text: `entry 指向的不是文件：${manifest.entry}` });
  }
  return base;
}

/** 扫一个根目录下所有包。`missing: true` 表示这个根目录本身不存在。 */
function scanRoot({ dir, kind, name }) {
  const names = listSubdirs(dir);
  if (names === null) return { dir, kind, name, missing: true, entries: [] };
  return { dir, kind, name, missing: false, entries: names.map((n) => scanOne(path.join(dir, n), n, kind)) };
}

/**
 * ★ 宿主的**唯一接线点** ★
 *
 * 扫两个根 → 逐条校验 → 按白名单决定"加载 / 未启用 / 拒绝" → 写日志。
 *
 * @param {{root:string, enabled?:Iterable<string>, log?:{info?,warn?}}} opts
 *        `root` 由调用方给（不在这里推导，见文件头）。
 *        `enabled` 是 config 里显式启用的 **id** 集合。
 * @returns {{plan:Array, sum:object, scans:Array, roots:Array}}
 */
export function loadExtensions({ root, enabled = [], log = {} } = {}) {
  const info = typeof log.info === 'function' ? log.info.bind(log) : () => {};
  const warn = typeof log.warn === 'function' ? log.warn.bind(log) : () => {};

  const roots = extensionRoots(root);
  const scans = [];
  const entries = [];
  for (const r of roots) {
    const sc = scanRoot(r);
    scans.push(sc);
    entries.push(...sc.entries);
  }

  const plan = planLoad(entries, enabled);
  const sum = summarize(plan);

  // 有问题的一条**逐条**报（这条线绝对不能只给汇总数字 —— 用户要靠它定位是哪个包）。
  for (const p of plan) {
    if (p.action === 'reject') warn(`扩展包 ✗ ${p.dirName}（id ${p.id}）：${p.detail}`);
  }
  for (const p of plan) {
    if (p.action === 'load') info(`扩展包 ✓ ${p.dirName}（id ${p.id} v${p.manifest?.version || '?'}）：已启用`);
    for (const w of p.problems || []) {
      if (p.action !== 'reject') warn(`扩展包 ⚠ ${p.dirName}：${w.text}`);
    }
  }

  // 汇总行必须**把扫描基数打出来**：否则"一个都没扫到"与"扫到了但全被拒绝"
  // 在日志里长得一模一样（纪律第 13 条：输入基数必须打印）。
  const scanned = scans
    .map((s) => `${s.name} ${s.missing ? '（目录不存在）' : `${s.entries.length} 个`}`)
    .join(' · ');
  info(
    `扩展包 | 扫描：${scanned} | 合计 ${sum.total} 个 → ` +
      `可加载 ${sum.load} · 未启用 ${sum.skip} · 有问题 ${sum.reject}` +
      (sum.reject ? `（${Object.entries(sum.byReason).filter(([k]) => k !== 'not-enabled' && k !== 'enabled').map(([k, v]) => `${k}×${v}`).join(' ')}）` : '')
  );
  // ① 这一段**只做识别与校验**，不执行扩展代码 —— 执行在 `createExtensionHost()` 里。
  //    这句话必须留在日志里，否则看面板/日志的人会以为"可加载"就是"已经在跑"
  //    （面板侧调用的就是这一段，它确实不执行）。
  if (sum.load || sum.skip) info('扩展包 | 识别与校验完成；**执行**由宿主的 createExtensionHost() 负责（机器人进程内）');

  return { plan, sum, scans, roots };
}
// ══════════════════════════════════════════════════════════════════════════
//  ② 加载 / 执行 / 四态生命周期（第 46 轮 B12e-2 · EX-LIFECYCLE）
// ══════════════════════════════════════════════════════════════════════════

/**
 * 生命周期四态（规格 v2 §5 的 `EX-LIFECYCLE` 原文：
 * 「`setup / activate / deactivate / dispose`；**不支持热插拔**」）。
 *
 * ⚠️ 这**不是**"发现 / 加载 / 跳过 / 失败"那四个**状态** ——
 *    那是给用户看的 `HOST_STATE`（见下）。两件事必须分开：
 *    · `LIFECYCLE`  —— 扩展包被调用的四个**函数**（有副作用、有顺序）
 *    · `HOST_STATE` —— 每个包**当前处在哪个状态**（给人读的一句话）
 *    第 44 轮把两者写成同一个词（"四态"），实测代码之后才发现是两件事。
 */
export const LIFECYCLE = Object.freeze(['setup', 'activate', 'deactivate', 'dispose']);

/** 宿主状态（给日志 / 面板读）。`pending` 与 `skipped` 的区别见 `createExtensionHost`。 */
export const HOST_STATE = Object.freeze({
  PENDING: 'pending',   // 发现了、但没在 config 白名单里启用（正常状态，不是错误）
  LOADED: 'loaded',     // 真的加载并执行了
  SKIPPED: 'skipped',   // 启用了、也 import 成功了，但入口没有可执行的东西
  FAILED: 'failed',     // 校验不过 / import 抛错 / setup 抛错
});

/**
 * 入口文件的可执行性检查 —— **必查**（第 46 轮从"警告"升级）。
 *
 * 四类都要拦，且**给得出人话**：
 *   · 越界（字符串层 + 符号链接层）
 *   · 不存在
 *   · 不是文件（是个目录）
 *   · **不可读**（权限位不对）—— 这一类最阴：存在、是文件，但 `import()` 会抛
 *     EACCES，而那条报错里没有包名，用户不知道是哪个包的问题。
 *
 * @returns {string|null} null = 可执行；字符串 = 拒绝原因
 */
function entryProblem(dir, entry) {
  const esc = entryEscapeReason(dir, entry);
  if (esc) return esc;
  const p = path.resolve(dir, entry);
  let st;
  try {
    st = fs.statSync(p);
  } catch {
    return `入口文件不存在：${entry}`;
  }
  if (!st.isFile()) return `entry 指向的不是文件：${entry}`;
  try {
    fs.accessSync(p, fs.constants.R_OK);
  } catch {
    return `入口文件不可读（权限位）：${entry}`;
  }
  return null;
}

/** 收集模块导出的钩子，挂到总线上。返回挂上去的 [点, 数量] 列表。 */
function attachHooks(mod, id, bus, warn) {
  const out = [];
  const hooks = mod?.hooks;
  if (!hooks || typeof hooks !== 'object') return out;
  for (const [point, fn] of Object.entries(hooks)) {
    // 一个钩子点可以挂多个函数（数组形式）—— 参考实现支持，这里也支持。
    const fns = Array.isArray(fn) ? fn : [fn];
    let n = 0;
    for (const f of fns) if (bus.on(point, f, { owner: id })) n += 1;
    if (n) out.push([point, n]);
    else warn(`扩展包「${id}」的钩子「${point}」没挂上（未知钩子点或不是函数）`);
  }
  return out;
}

/**
 * 建宿主。**只由机器人进程调用** —— 它会真的执行磁盘上的外来代码。
 *
 * @param {{root:string, registry:object, bus:object,
 *          getCustom?:Function, log?:{info?,warn?}, now?:Function}} deps
 */
export function createExtensionHost({ root, registry, bus, getCustom, log = {}, now } = {}) {
  const info = typeof log.info === 'function' ? log.info.bind(log) : () => {};
  const warn = typeof log.warn === 'function' ? log.warn.bind(log) : () => {};

  /** id → 运行记录。**只由本闭包写**（快照从它投影出来）。 */
  const records = new Map();
  /**
   * id → 模块命名空间。**故意不进快照** —— 它含函数与闭包，既不安全也不可序列化。
   * 用途只有一个：`deactivate` / `dispose` 时要把 `mod` 传回去。
   */
  const modules = new Map();
  /**
   * 「不支持热插拔」的实现点：`load()` 只生效一次。
   * 第二次调用直接返回快照 —— 不重新 import、不重新 setup。
   * （真去重载会让模块级状态与钩子表各出现两份，而那正是最难查的一类幽灵。）
   */
  let loaded = false;

  function record(id, fields) {
    records.set(id, {
      id,
      dirName: fields.dirName ?? '',
      kind: fields.kind ?? null,
      name: fields.name ?? id,
      version: fields.version ?? '',
      state: fields.state,
      reason: fields.reason ?? '',
      detail: fields.detail ?? '',
      tools: [],
      hooks: [],
      life: { setup: 'none', activate: 'none', deactivate: 'none', dispose: 'none' },
      permissions: fields.permissions ?? { known: [], unknown: [] },
      settingsKeys: fields.settingsKeys ?? [],
      toolErrors: [],
      ...(fields.patch || {}),
    });
  }

  async function activateOne(p) {
    const m = p.manifest || {};
    const perms = splitPermissions(m.permissions);
    const base = {
      dirName: p.dirName,
      kind: p.kind,
      name: m.name || p.id,
      version: m.version || '',
      permissions: perms,
      // 只留**键名**：面板要能说"这个包有 3 项设置"，但不该把清单原样下发。
      // ⚠️ 读的是归一化出的 `settingsKeys`（= `configSchema` 的键 ∪ `settings` 的键）——
      //    生态里 13 个真实包用的都是 `settings`，只读 `schemaKeys` 会一律得到空数组。
      settingsKeys: Array.isArray(m.settingsKeys) ? m.settingsKeys : [],
    };

    // ① realpath 必查（B12d 时只是警告）
    const problem = entryProblem(p.dir, m.entry);
    if (problem) {
      record(p.id, { ...base, state: HOST_STATE.FAILED, reason: 'entry-unusable', detail: problem });
      warn(`扩展包 ✗ ${p.dirName}（id ${p.id}）：${problem}`);
      return;
    }

    const entryPath = path.resolve(p.dir, m.entry);
    let mod;
    try {
      // ⚠️ 必须用 `pathToFileURL`：包目录名可以是中文（真实生态就是这样），
      //    直接拼 `file://` 会因未转义而在 import 时抛 ERR_UNSUPPORTED_ESM_URL_SCHEME。
      mod = await import(pathToFileURL(entryPath).href);
    } catch (e) {
      const detail = `import 失败：${e?.message ?? e}`;
      record(p.id, { ...base, state: HOST_STATE.FAILED, reason: 'import-failed', detail });
      warn(`扩展包 ✗ ${p.dirName}（id ${p.id}）：${detail}`);
      return;
    }
    modules.set(p.id, mod);

    const hasSetup = typeof mod?.setup === 'function';
    const hasActivate = typeof mod?.activate === 'function';
    const hookCount = mod?.hooks && typeof mod.hooks === 'object' ? Object.keys(mod.hooks).length : 0;
    if (!hasSetup && !hasActivate && !hookCount) {
      // 启用了、也能 import，但入口什么都没导出 —— 既不是错误，也不该算"跑起来了"。
      record(p.id, {
        ...base,
        state: HOST_STATE.SKIPPED,
        reason: 'no-entry-contract',
        detail: '入口没有导出 setup / activate / hooks',
      });
      warn(`扩展包 ⚠ ${p.dirName}（id ${p.id}）：入口没有 setup / activate / hooks，跳过`);
      return;
    }

    // ② 造 ctx（按 permissions 裁剪）→ 跑 setup
    // 每个包**各造一份** fetch：被拦下时能带上自己的 id 进日志
    // （"某个包在偷偷访问内网"必须看得见是谁 —— 与 ext-scope 拒绝发言时既抛错又告警同款）。
    // D15（E11 ②）：顺手把**浏览锁定**传下去 —— 名单外的站点一律拒（未开启时放行）。
    // ⚠️ 读的是宿主启动时那份 custom，与白名单 / 包设置同一条纪律：**改完要重启**才生效。
    //    不给她读盘口子（每次 fetch 现读 config.json 会让"名单"多出一个随时间变化的副本）。
    const extFetch = createExtFetch({
      log: (msg) => warn(`扩展包 ${p.id}：${msg}`),
      lock: getCustom?.()?.browseLock,
    });
    const life = { setup: 'none', activate: 'none', deactivate: 'none', dispose: 'none' };
    const toolErrors = [];
    let setupFailed = null;
    /**
     * setup 的 api。**声明在 if 外面** —— 第 48 轮起 `activate(ctx)` 要拿它的
     * 只读投影（`activateCtxOf`），所以它的作用域必须活到下面那一步。
     * 没有 setup 的包保持 null → activate 拿到 `{}`（不是 undefined，形状仍然稳定）。
     */
    let api = null;
    if (hasSetup) {
      api = buildApi({
        manifest: m,
        log,
        now,
        // 用户在面板上填的设置（第 55 轮）。读的是**宿主启动时那份 custom** ——
        // 改了设置要重启才生效，与白名单同一条纪律（不支持热插拔）。
        settings: (getCustom?.()?.plugins?.settings || {})[p.id],
        isActive: (other) => records.get(String(other))?.state === HOST_STATE.LOADED,
        // 受出站策略约束的 fetch（第 55 轮）：声明了 web_fetch 的包拿到的**就是这份**，
        // 不再是裸 `globalThis.fetch`。判据只有 `safe-fetch` 那一份，
        // `ext-fetch.js` 只负责把结果还原成真的 Response（扩展包写的是 res.json()）。
        // ⚠️ 不给它 → `buildApi` 按默认拒绝处理（连声明了权限的包也拿不到网络）。
        fetch: extFetch,
        registerTool: (def, { owner }) => {
          const name = scopedToolId(owner, def?.id ?? def?.name);
          const r = registry.register({ ...def, id: name, owner });
          if (!r.ok) {
            // ★ 不抛：**一个工具注册不上，不该把整个包判死**（其余钩子 / 工具照常用）。
            //   但必须**可见** —— 静默丢弃的表现是"某个工具永远调不到，而日志里什么都没有"。
            toolErrors.push({ id: String(def?.id ?? ''), reason: r.reason });
            warn(`扩展包「${owner}」注册工具失败：${r.reason}`);
            return '';
          }
          return r.name;
        },
      });
      try {
        await mod.setup(api);
        life.setup = 'ok';
      } catch (e) {
        life.setup = 'failed';
        setupFailed = `setup 抛错：${e?.message ?? e}`;
      }
    }

    if (setupFailed) {
      // setup 抛错 → 这个包不可用。**已注册的工具要收回**，否则会留下"幽灵工具"：
      // 它在模型的能力列表里，一调就报"不存在"，而没人知道它从哪来。
      let removed = 0;
      for (const t of registry.meta()) if (t.owner === p.id && registry.unregister(t.name)) removed += 1;
      record(p.id, {
        ...base,
        state: HOST_STATE.FAILED,
        reason: 'setup-failed',
        detail: setupFailed,
        patch: { life, toolErrors },
      });
      warn(`扩展包 ✗ ${p.dirName}（id ${p.id}）：${setupFailed}${removed ? `（已收回 ${removed} 个工具）` : ''}`);
      return;
    }

    // ③ 挂钩子（放在 setup **之后**：setup 抛错的包不该留下钩子）
    const hooks = attachHooks(mod, p.id, bus, warn);

    // ④ activate（起副作用：定时器 / 监听）
    //    ⚠️ 第 48 轮起**带参**：生态契约是 `activate(ctx)`，无参调用会让包里的
    //       `ctx?.sender` 恒为 undefined → 它静默地什么都不做（"装了不用"）。
    //       ctx 是 setup 那份 api 的**只读投影**（能力全摘，也没有 onebot/sender）——
    //       理由见 `activateCtxOf` 的注释。
    if (hasActivate) {
      try {
        await mod.activate(activateCtxOf(api));
        life.activate = 'ok';
      } catch (e) {
        life.activate = 'failed';
        // activate 失败 ≠ 不可用：钩子已经挂上了，就让它继续跑，只把失败报出来。
        warn(`扩展包 ⚠ ${p.dirName}（id ${p.id}）：activate 抛错（钩子仍生效）：${e?.message ?? e}`);
      }
    }

    const tools = registry.meta().filter((t) => t.owner === p.id).map((t) => t.name);
    record(p.id, {
      ...base,
      state: HOST_STATE.LOADED,
      reason: 'ok',
      detail: '',
      patch: { life, tools, hooks, toolErrors },
    });
    info(
      `扩展包 ✓ ${p.dirName}（id ${p.id} v${base.version || '?'}）：已加载` +
        ` · 工具 ${tools.length} · 钩子 ${hooks.map(([k, n]) => `${k}×${n}`).join('/') || '无'}` +
        ` · 权限 ${perms.known.join('/') || '无'}` +
        (perms.unknown.length ? `（不认识：${perms.unknown.join('/')}）` : '')
    );
  }

  return {
    /**
     * 加载并执行（**幂等**，见 `loaded` 的注释）。
     * @returns {Promise<{items:Array, sum:object}>}
     */
    async load() {
      if (loaded) return this.snapshot();
      loaded = true;

      const enabled = getCustom?.()?.plugins?.enabled || [];
      const { plan } = loadExtensions({ root, enabled, log });
      for (const p of plan) {
        if (p.action === 'load') continue; // 稍后逐条异步处理
        record(p.id, {
          dirName: p.dirName,
          kind: p.kind,
          name: p.manifest?.name || p.id,
          version: p.manifest?.version || '',
          state: p.action === 'skip' ? HOST_STATE.PENDING : HOST_STATE.FAILED,
          reason: p.reason,
          detail: p.detail,
          // 同上：读归一化的 `settingsKeys`，别读 `schemaKeys`（真实包写的是 `settings`）
          settingsKeys: Array.isArray(p.manifest?.settingsKeys) ? p.manifest.settingsKeys : [],
        });
      }
      for (const p of plan) {
        if (p.action !== 'load') continue;
        // eslint-disable-next-line no-await-in-loop -- 顺序加载是刻意的：注册顺序 = 钩子判定顺序
        await activateOne(p);
      }

      const snap = this.snapshot();
      const s = snap.sum;
      // ⚠️ 汇总必须**把每个状态的基数打出来**（本项目第 13 条纪律：输入基数必须打印）。
      //    否则"一个都没启用"与"启用了但全失败"在日志里长得一模一样。
      info(
        `扩展包 | 执行：扫描 ${plan.length} 个 → 已加载 ${s.loaded} · 未启用 ${s.pending}` +
          ` · 无入口契约 ${s.skipped} · 失败 ${s.failed}` +
          ` | 工具 ${typeof registry.size === 'function' ? registry.size() : '?'}` +
          ` · 钩子 ${typeof bus.total === 'function' ? bus.total() : '?'}`
      );
      return snap;
    },

    /** 某个包此刻是不是"加载中且可用"（`api.isActive` 的落点） */
    has(id) {
      return records.get(String(id ?? ''))?.state === HOST_STATE.LOADED;
    },

    get(id) {
      return records.get(String(id ?? '')) || null;
    },

    /** 快照（可安全下发 / 打印：不含 api / mod / 绝对路径） */
    snapshot() {
      const items = [...records.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      const sum = { total: items.length, loaded: 0, pending: 0, skipped: 0, failed: 0 };
      for (const it of items) sum[it.state] = (sum[it.state] || 0) + 1;
      return { items, sum };
    },

    /**
     * 停副作用（`deactivate`）。进程退出前调用；**不摘钩子** ——
     * 摘钩子是 `dispose` 的事，两者分开才表达得出"先停、再释放"。
     * @returns {Promise<{ran:number, errors:Array}>}
     */
    async deactivateAll() {
      let ran = 0;
      const errors = [];
      for (const [id, r] of records) {
        if (r.state !== HOST_STATE.LOADED) continue;
        const fn = modules.get(id)?.deactivate;
        if (typeof fn !== 'function') {
          r.life.deactivate = 'absent';
          continue;
        }
        try {
          // eslint-disable-next-line no-await-in-loop -- 逐个停，顺序可预测
          await fn();
          r.life.deactivate = 'ok';
          ran += 1;
        } catch (e) {
          r.life.deactivate = 'failed';
          errors.push({ id, message: String(e?.message ?? e) });
          warn(`扩展包「${id}」deactivate 抛错：${e?.message ?? e}`);
        }
      }
      return { ran, errors };
    },

    /**
     * 释放资源（`dispose`）并摘掉钩子。
     * @returns {Promise<{ran:number, hooksRemoved:number, errors:Array}>}
     */
    async disposeAll() {
      let ran = 0;
      let hooksRemoved = 0;
      const errors = [];
      for (const [id, r] of records) {
        if (r.state !== HOST_STATE.LOADED) continue;
        const fn = modules.get(id)?.dispose;
        if (typeof fn === 'function') {
          try {
            // eslint-disable-next-line no-await-in-loop
            await fn();
            r.life.dispose = 'ok';
            ran += 1;
          } catch (e) {
            r.life.dispose = 'failed';
            errors.push({ id, message: String(e?.message ?? e) });
            warn(`扩展包「${id}」dispose 抛错：${e?.message ?? e}`);
          }
        } else {
          r.life.dispose = 'absent';
        }
        hooksRemoved += bus.offOwner(id);
      }
      return { ran, hooksRemoved, errors };
    },
  };
}
