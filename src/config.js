import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import scoped from './logger.js';
import { readCustom } from './custom-config.js';
import { PACE_DEFAULTS } from './pace.js';
import { budgetOf } from './context-budget.js';
import { DEFAULT_AMBIENT_BATCH } from './ambient.js';
// D12b（E15）：插话时机的四个参数。默认值**只住在 src/interject.js** ——
// 这里只是把归一化后的值摊平进 `cfg.trigger`（`trigger` 是白名单构造的，
// 漏一个键就等于用户配了也不生效，是最典型的"改了不报错"）。
import { interjectTuningOf } from './interject.js';
// 数值类设置的默认值与上下限（第 42 轮 B12b · SCHEMA-LITE）。
// 与 `custom-config.js` 共用同一份 —— 它在面板上会作为提示文字显示出来，
// 所以"哪个数字对"必须只有一个答案。**这里不许再写那个数字本身**。
import { numOr } from './field-schema.js';
// 本机 / 局域网判定与服务商判定（B11c · AR-DATADRIVEN）。
// 这两条判据曾经在五个文件里各有一份拷贝，本模块是唯一的实现。
import { isLocalBase, providerOf } from './net-rules.js';
// 自定义大脑（2026-10-07）：用户自己填地址 / Key / 模型名的那些，能存好多套。
// 判据与归一化是零依赖叶子 —— 同目录下的模块，不需要过 lib→src 白名单。
import { customBrainsOf, materializeBrain } from './custom-brain.js';

const log = scoped('config');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 扩展包可以用的**长期数据目录**（第 47 轮 B12e-3 · EX-DATADIR）。
 *
 * ⚠️ 这个名字不是我们起的，是**生态约定**：真实扩展包（13 个里 6 个）直接
 *    `import { DATA_DIR } from '../../src/config.js'` —— 参考实现
 *    （QQ-Agent 0.4 preview · `src/config.js:24`）就是这么导出的。
 *    导出名一旦不同，它们**一行都改不了地加载失败**（smoke T125 红的根因）。
 *
 * 语义：**机器人自己的长期数据**（bot-state.json、图库、印象档…），
 * 与 `panel/` 下那些"面板运行期产物"分开 —— `panel/` 是被 git 跟踪的目录，
 * 扩展包往里写会污染仓库（这正是它必须独立成一个目录的理由）。
 *
 * ⚠️ 三件套必须齐（本项目第 10 条陷阱：新增任何**会落盘**的路径，
 *    少任何一件都**不报错**，只会在某天发现"不该出现的内容出现在了不该出现的地方"）：
 *      ① `.gitignore` 锚定（`/data/`，前导斜杠——否则会匹配任意层级）
 *      ② `test/sandbox.sh` 的 rsync `--exclude`（别把用户数据拷进 /tmp）
 *      ③ **本行的 `QQBOT_DATA_DIR` env 覆盖**（测试指去 tmp，不碰用户真数据）
 *    三件都由 `scripts/check-wb.mjs` 的契约盯着。
 */
export const DATA_DIR = process.env.QQBOT_DATA_DIR
  ? path.resolve(process.env.QQBOT_DATA_DIR)
  : path.join(ROOT, 'data');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function asInt(v, fallback) {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function idList(v, field) {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new Error(`${field} 必须是数组，例如 [123456]`);
  return v.map((x) => String(x).trim()).filter(Boolean);
}

/**
 * `reply.splitToken` 的归一化（2026-10-09 · 第 53 轮 · B4）。
 *
 * ⚠️ 这里**不能**写成 `raw.reply?.splitToken ?? '||'` —— `??` 只对 `null`/`undefined` 生效，
 *    而真正会出问题的那一形态是**空串**，它会原样通过。
 *    空串进 `brain.parseReply` 的 `text.split(new RegExp('|\\n+'))` 会**逐字符**切开整段回复
 *    （本机实测：`"今天天气"` → `["今","天","天","气"]`）——
 *    群里的表现就是「**一个字一个字地发**」。
 *
 * 空串有**真实来路**，不是假想：
 *   `scripts/sanitize-config.mjs` 的凭据判据（`…|token|…$`）曾把 `splitToken` 当成密钥清空，
 *   于是 `config.example.json` 里写着 `"splitToken": ""`；而**全新安装必然走模板**
 *   （`loadConfig` 找不到 `config.json` 时直接用模板；便携包 `tools/setup.mjs` 也从模板生成）
 *   ⇒ 每个新用户都会拿到它。脱敏器那侧已修（见 `isCredentialKey` 的例外表），
 *   但**老用户盘上的 config.json / 旧模板仍然是空串**，所以兜底这一层不能省。
 *
 * 纯函数、零依赖 —— smoke 可以直接喂各种形态（见 §98）。
 * 想禁用分条请用 `maxChunks: 1` 或 `replyStyle.multiMessage: false`，**不要**用空 token：
 * 那在实现上等价于"每个字符之间都断开"，是个陷阱不是开关。
 */
export function normalizeSplitToken(v) {
  const s = typeof v === 'string' ? v : '';
  return s.trim() ? s : '||';
}

/**
 * 解析「可能是环境变量引用」的密钥值（B9 · K-ENV）。
 *
 * 写法：整个值写成 `"env:ZHIPU_API_KEY"` → 取 `process.env.ZHIPU_API_KEY`。
 *
 * 为什么需要它：`config.json` 里躺着明文 Key，等于任何读得到这个文件的东西
 * （备份、同步盘、误发的截图、我自己的审查命令）都拿到了账号额度。
 *
 * ⚠️ 只有**整个值**形如 `env:NAME` 才算引用，**不做部分替换**。
 *    部分替换会让"这串到底是明文还是引用"需要肉眼判断 —— 而它恰好是那种
 *    "看着像 Key、其实是引用"的静默陷阱（真要排查时会先去查 Key 有没有过期）。
 *
 * ⚠️ 作用范围是**全部三个凭据字段**（`llm.apiKey` / `llm.keys.*` / `onebot.accessToken`），
 *    不是只管 llm 那两个。只改一半就是**半迁移** —— 本项目明令禁止：
 *    同一件事两种范式共存，下一个人只会照着最近改的那半边写。
 */
const ENV_REF_RE = /^env:([A-Za-z_][A-Za-z0-9_]*)$/;

export function resolveSecret(v) {
  const s = String(v ?? '');
  const m = ENV_REF_RE.exec(s);
  if (!m) return s;
  const got = process.env[m[1]];
  if (got === undefined || got === '') {
    // 说清楚是"环境变量没设置"，不要让它表现成"Key 无效"——
    // 那会把排查方向整个带偏（会去查额度、查服务商，而问题在本机环境变量）。
    log.warn(`配置引用了环境变量 ${m[1]}，但它当前没有设置 → 这个位置会被当成空密钥`);
  }
  return got || '';
}

/**
 * 「配置里写着 apiKeyEnv，但那个环境变量是空的」—— 这时真正生效的是**明文**。
 *
 * 为什么值得一条独立判据（第 56 轮 F0-1 实测）：
 * 真机 `config.json` 设了 `llm.apiKeyEnv = QQBOT_API_KEY`，而 `QQBOT_API_KEY`
 * **并没有被设置**（取证：`bridge.log` 里从来没有那条"两个同时存在"的告警）。
 * 于是这份配置**看起来**用了环境变量、**实际**在用文件里的明文 ——
 * 任何人来审计（包括我自己）都会据此认为"Key 不在文件里"。
 *
 * 这是本项目最爱的一类缺陷：**改了不报错、看起来还更好**。
 * 本函数只负责**说出来**，不改变任何解析结果（那是既有优先级，Q12 已裁决维持）。
 *
 * 纯函数：四个入参都由调用方给，便于 smoke 直接喂反例。
 *
 * @param {object} p
 * @param {boolean} p.hasEnvRef 配了 `apiKeyEnv`
 * @param {boolean} p.envHasValue 那个环境变量当前有值
 * @param {boolean} p.plaintextPresent 同一份配置里还有明文 `apiKey`
 * @returns {string} '' = 没什么好说的；否则是要打进日志的一句话
 */
export function plaintextFallbackNotice({ hasEnvRef, envHasValue, plaintextPresent }) {
  if (!hasEnvRef || envHasValue || !plaintextPresent) return '';
  return '配置里设了 llm.apiKeyEnv 但它指向的环境变量当前为空 → '
    + '**实际生效的是 config.json 里的明文 apiKey**。'
    + '想让环境变量生效，请先设置它（这条只提醒，不改任何解析结果）。';
}

/**
 * `config.json` 的权限够不够严（2026-10-05 · 第 10 轮 · 开源前审查 H-08）。
 *
 * 为什么值得一条独立判据：同一个仓库里 `.env` 与 `panel/.token` 都是 `0600`，
 * 而 `config.json` 是进程按 umask 建出来的 —— 实测 `0644`。
 * 它偏偏是**唯一**明摆着持仓的那个设置文件（`SECURITY.md` 的"设计边界"表里写着
 * 「配置是明文 …… 文件权限应为 0600」，但**没有任何东西保证它**）。
 * 于是"同机的任何用户可读"这条，一直是靠人记得 `chmod`。
 *
 * 纯函数：`mode` 由调用方给（`fs.statSync().mode`，**含文件类型位**，
 * 所以这里自己 `& 0o777`），便于 smoke 直接喂反例（600 / 640 / 644 / 666 各一）。
 *
 * ⚠️ 判据与副作用分开：本函数只**说**，动手的是 `loadConfig` ——
 *    而且只往**严**的方向改（0600），绝不放宽。
 *
 * @param {number} mode `fs.statSync(file).mode`
 * @param {boolean} [tightened] 调用方随后真的把它改成 0600 了吗
 * @returns {string} '' = 没问题；否则是要打进日志的一句话
 */
export function configPermNotice(mode, tightened = false) {
  const m = Number(mode) & 0o777;
  // 组 / 其他用户一个位都不许有（0600 = 只有属主）。
  if (!Number.isFinite(m) || (m & 0o077) === 0) return '';
  // 八进制**带前导 0**（`0600` 这种四位写法）—— 与 `SECURITY.md` 和 `.gitignore` 里的
  // 记法一致。输出 `644` 也看得懂，但同一份文档里两种写法并存，下一个人会以为是两个值。
  const oct = '0' + m.toString(8).padStart(3, '0');
  const how = tightened
    ? '已自动收紧为 600（只收紧、不放宽）'
    : '收紧失败（只读挂载 / 非 POSIX 文件系统），请手工 chmod 600';
  return `config.json 的权限是 ${oct} —— 同机其他用户可以读到它，`
    + '而它里面有明文 API Key。' + how
    + '（想彻底不放明文：把 llm.apiKey 换成 "env:你的环境变量名"）。';
}

/** 把一整张「服务商 → Key」表里的值逐个过一遍引用解析 */
function resolveSecretMap(v) {
  if (!v || typeof v !== 'object') return {};
  const out = {};
  for (const [k, val] of Object.entries(v)) out[k] = resolveSecret(val);
  return out;
}

/**
 * 读取并校验配置。config.json 不存在时回落到 config.example.json。
 * @param {string} [overridePath]
 */
export function loadConfig(overridePath) {
  const file = overridePath
    ? path.resolve(overridePath)
    : path.join(ROOT, fs.existsSync(path.join(ROOT, 'config.json')) ? 'config.json' : 'config.example.json');

  if (!fs.existsSync(file)) throw new Error(`配置文件不存在: ${file}`);
  // H-08（第 10 轮 · 开源前审查）：它是**唯一**持仓明文的设置文件，
  // 而权限是进程按 umask 建出来的（实测 0644，而 `.env` / `panel/.token` 都是 0600）。
  // ⚠️ 判据在纯函数里（`configPermNotice`，smoke 直接喂反例）；
  //    这里只做那次**往严的方向**的收紧 —— 绝不放宽、也绝不因为改不动就拦住启动。
  try {
    const perm = fs.statSync(file).mode;
    if ((perm & 0o077) !== 0) {
      let tightened = false;
      try { fs.chmodSync(file, 0o600); tightened = true; } catch { /* 文案里会说"请手工 chmod" */ }
      log.warn(configPermNotice(perm, tightened));
    }
  } catch { /* stat 失败只说明"这条提示给不出来"，不是启动条件 */ }
  const raw = readJson(file);
  log.info(`加载配置: ${file}`);

  const allow = {
    private: idList(raw.allow?.private, 'allow.private'),
    groups: idList(raw.allow?.groups, 'allow.groups'),
    allowAllWhenEmpty: raw.allow?.allowAllWhenEmpty === true,
  };

  if (allow.private.length === 0 && allow.groups.length === 0) {
    if (!allow.allowAllWhenEmpty) {
      throw new Error(
        '白名单为空且 allow.allowAllWhenEmpty 不为 true。\n' +
          '  请填写 allow.private / allow.groups，或显式把 allow.allowAllWhenEmpty 设为 true。\n' +
          '  ⚠️ 后者等于把 QQ 账号控制权交给模型，强烈不建议。'
      );
    }
    log.warn('白名单为空且 allowAllWhenEmpty=true —— 任何人和任何群都能指挥这个账号，请确认这是你要的');
  }

  // D31-2 · 主人（**叫醒路**的唯一身份判据）。
  //
  // 为什么单独立一节而不是复用 `allow.private`：两者回答的是**两个不同的问题** ——
  //   · `allow.private` = 「允许它跟谁说话」（一条宽泛的通信许可）；
  //   · `owner.qq`      = 「谁有权把它从睡眠里叫醒」（一个明确的、更小的动作授权）。
  // 合成一份的后果是两个方向各错一次：把某个群友加进私聊白名单，顺手就给了他"叫醒"的权力；
  // 而想收紧叫醒范围时又只能连通信许可一起收。
  //
  // ⚠️ **不填 = 两条叫醒路整体关闭**（fail-closed）。这不是"默认放行"的那种默认值：
  //    叫醒会改变它的作息，缺省必须是"没人能改"。
  // ⚠️ 它住在**顶层**（与 `allow` / `deny` 同级）而不是 `custom` 里：`custom` 是面板的工作台资产，
  //    而这个列表是权限。面板保存配置走的是 patchCustom + 顶层保留，两边都不会误伤。
  const owner = { qq: idList(raw.owner?.qq, 'owner.qq') };
  if (owner.qq.length === 0) {
    log.info('未配置 owner.qq —— 睡眠期间的两条叫醒路整体关闭（自然起床不受影响）');
  }
  // ── Q26f 裁决③：**自动补** `allow.private`（只补主人那几个号，一次都不补别人）──
  //
  // 为什么不维持"只提示"：真机 `allow.private = []` → 主人的私聊**先被白名单闸挡掉**，
  // 于是 D31-2 的"主人私聊叫醒"从交付那天起就是空转 —— 主人找她、她不醒，
  // 这与"拟人"直接矛盾，而用户看不到任何门在响（那条 warn 只在启动日志里出现过一次）。
  //
  // ⚠️ 补在**配置归一化**里而不是运行时改某个对象：面板保存配置会触发热重载
  //    （`loadConfig` 重跑一遍），补在别处就会在"保存一次之后"悄悄失效 ——
  //    那正是本项目最贵的那类失败（改了、生效了、然后又不生效了）。
  // ⚠️ 只**加**不删：用户自己填的号一个都不动；补进去的号由 `ownerAutoPrivate`
  //    如实标出来（它是**派生**字段，不落盘、不进 config.json）。
  const ownerAutoPrivate = owner.qq.filter((q) => !allow.private.includes(q));
  if (ownerAutoPrivate.length) {
    allow.private = [...allow.private, ...ownerAutoPrivate];
    log.warn(
      `已自动把主人 ${ownerAutoPrivate.join(',')} 补进 allow.private（Q26f 裁决③）—— `
        + '不补的话他们的私聊叫醒永远进不来（群 @ 叫醒不受影响）。'
    );
  }

  // 优先级刻意保持原样：`apiKeyEnv` 指的环境变量 > `llm.apiKey` 本身。
  // 只是给 `apiKey` 也加上了 `env:NAME` 这种写法（见 resolveSecret）——
  // 不然同一个文件里会出现"有的字段能用 env: 有的不能"，那比不支持更让人困惑。
  const apiKey = (raw.llm?.apiKeyEnv ? process.env[raw.llm.apiKeyEnv] : '') || resolveSecret(raw.llm?.apiKey) || '';

  // 「配了 apiKeyEnv、但它指向的变量是空的」是另一种坑，与下面那条**互补**（第 56 轮 F0-1）：
  // 那条说"两把都在、生效的是环境变量"，这条说"看起来用了环境变量、其实在用明文"。
  // 实测真机就是这一种（见 plaintextFallbackNotice 的注释）。只说事实，不改解析结果。
  {
    const notice = plaintextFallbackNotice({
      hasEnvRef: !!raw.llm?.apiKeyEnv,
      envHasValue: !!process.env[raw.llm?.apiKeyEnv],
      plaintextPresent: !!raw.llm?.apiKey,
    });
    if (notice) log.warn(notice);
  }

  // 「两把 Key 同时存在」要当场说出来（B9 · K-ENV）。
  // 配了 apiKeyEnv、环境变量里也确实有值，同时 llm.apiKey 又不为空 ——
  // 这时**只有环境变量那把生效**，另一把是死的。不提醒的话，用户改了那把他以为生效了，
  // 而界面上、日志里都不会有任何异常（这正是"填了不生效"里最难查的一种）。
  // 这里只在**真正冲突**（env 有值）时告警：env 指向的变量为空时 apiKey 会顶上来，不算冲突。
  if (raw.llm?.apiKeyEnv && process.env[raw.llm.apiKeyEnv] && raw.llm?.apiKey) {
    log.warn(
      `llm.apiKeyEnv=${raw.llm.apiKeyEnv} 与 llm.apiKey 同时存在 —— 实际生效的是**环境变量那把**，` +
        '配置里写的那把不会被使用。想用配置里那把，请把 apiKeyEnv 删掉。'
    );
  }
  const baseUrl = String(raw.llm?.baseUrl ?? '').replace(/\/+$/, '');
  if (!baseUrl) throw new Error('llm.baseUrl 不能为空');

  // ── 自定义大脑（2026-10-07）─────────────────────────────────────────────
  // 归一化一遍，并把每把 Key 过一次 `resolveSecret()`（支持 `env:NAME` 引用）。
  // ⚠️ 必须与 `llm.apiKey` / `llm.keys.*` **同一套写法** —— 三种形态并存就是"半迁移"，
  //    而"半迁移"在本项目里是明令禁止的：下一个人只会照着最近改的那半边写。
  //
  // ⚠️ 归一化会**丢掉坏条目**（缺接口地址或模型名的），丢掉的 id 进日志。
  //    静默丢弃的表现是"我明明保存了，刷新就没了"，那正是本项目最贵的失败形态。
  const { brains: customBrains, dropped: droppedBrains } = customBrainsOf(raw);
  for (const b of Object.values(customBrains)) b.apiKey = resolveSecret(b.apiKey);
  if (droppedBrains.length) {
    log.warn(
      `自定义大脑里有 ${droppedBrains.length} 条用不了（缺接口地址或模型名）已跳过：${droppedBrains.join('、')}`
    );
  }
  const activeCustomId = String(raw.llm?.activeCustomId ?? '').trim();
  const activeCustom = (activeCustomId && customBrains[activeCustomId]) || null;

  // 本机 / 局域网地址上的模型跑在自己的机器上，不产生任何费用。
  // 判据只有一份（`src/net-rules.js`）—— 面板后端与页面读的是同一份结论，
  // 不会再出现「同一份配置，机器人按本机免费算、面板按云端计费算」的错账。
  const isLocalLLM = isLocalBase(baseUrl);

  const cfg = {
    root: ROOT,
    onebot: {
      wsUrl: String(raw.onebot?.wsUrl ?? 'ws://127.0.0.1:3001'),
      // 协议端令牌同样是凭据，同样支持 `env:NAME`（B9 · K-ENV）。
      // 同一份文件里"有的凭据能走环境变量、有的不能"就是半迁移，会误导下一个人。
      accessToken: resolveSecret(raw.onebot?.accessToken),
      reconnectBackoffMs: Array.isArray(raw.onebot?.reconnectBackoffMs) && raw.onebot.reconnectBackoffMs.length
        ? raw.onebot.reconnectBackoffMs.map((x) => asInt(x, 5000))
        : [1000, 2000, 5000, 10000, 30000],
    },
    llm: {
      baseUrl,
      apiKey,
      model: String(raw.llm?.model ?? 'deepseek-flash'),
      // 本机地址 = 免费；云端 = 按量计费。价格统计和思考参数写法都靠它分支
      isLocal: isLocalLLM,
      // 服务商标识：切换时靠它取回对应的 Key（各家 Key 不通用）
      provider: providerOf(baseUrl),
      // 降级链：主模型不可用（限流/故障）时按顺序往下换。
      // 免费档晚高峰常被限流，一条链比单个备用更稳。
      fallbackModels: Array.isArray(raw.llm?.fallbackModels)
        ? raw.llm.fallbackModels.map((s) => String(s).trim()).filter(Boolean)
        : [],
      // 旧字段（单个备用），仍兼容
      fallbackModel: String(raw.llm?.fallbackModel ?? ''),
      // 各家 API Key 分开存，一键切换时才不会张冠李戴。
      // 每个值都可以写成 `env:NAME` 走环境变量（B9 · K-ENV）。
      keys: resolveSecretMap(raw.llm?.keys),
      // 思考（思维链）：
      //   mode  auto=不干预 / off=强制关 / on=强制开
      //   level low|medium|high —— 只有云端(DeepSeek)支持分档，本机模型只有开/关
      thinking: normalizeThinking(raw.llm?.thinking),
      // 三个能力开关，默认都关，由用户在面板上自己打开
      features: {
        // 联网搜索：走智谱内置的 web_search 工具，模型能查实时信息（梗、新闻、人物）
        webSearch: raw.llm?.features?.webSearch === true,
        // 识图：群里有人发图时，把图交给多模态模型看（需要模型支持，如 GLM-4.6V-Flash）
        vision: raw.llm?.features?.vision === true,
        // 表情：允许机器人在回复里插 QQ 内置表情（[face:ID] 语法）
        stickers: raw.llm?.features?.stickers === true,
      },
      // ── 自定义大脑（2026-10-07）──
      // ⚠️ **刻意不进 `presets`**：那张表的形状是"服务商 → 一套设置"，而自定义是
      //    "用户自己命名的多套"。硬塞进去就要把 `PRESET_KEYS` 改成动态名单，
      //    牵动 `readPresets` / `stashCurrentPreset` / `buildModelCaps` / `keySaved`
      //    等十几处 —— 漏改任何一处都是**静默失效**。分开存则一个都不用动。
      // ⚠️ 这里存的是**归一化后**的那份（Key 已解析）。机器人侧只认这一份。
      customBrains,
      activeCustomId: activeCustom ? activeCustom.id : '',
      temperature: Number(raw.llm?.temperature ?? 1.0),
      maxTokens: asInt(raw.llm?.maxTokens, 400),
      timeoutMs: asInt(raw.llm?.timeoutMs, 60000),
    },
    allow,
    // D31-2 · 主人（叫醒路的唯一身份判据）。默认空 = 两条叫醒路关闭。
    owner,
    /**
     * Q26f：**本次加载自动补进 `allow.private` 的主人号**（空数组 = 一个都没补）。
     *
     * ⚠️ 它是**派生**字段（不落盘、不进 config.json），唯一的用途是让启动时的
     *    「留痕」有据可依 —— 不然"它为什么能收到我的私聊"这件事查不到出处，
     *    而那正是宿主替用户改权限白名单这类动作必须留下的线索。
     */
    ownerAutoPrivate,
    deny: {
      users: idList(raw.deny?.users, 'deny.users'),
      groups: idList(raw.deny?.groups, 'deny.groups'),
    },
    trigger: {
      requireAtInGroup: raw.trigger?.requireAtInGroup !== false,
      aliases: Array.isArray(raw.trigger?.aliases) ? raw.trigger.aliases.map((s) => String(s)).filter(Boolean) : [],
      interjectChance: Math.min(1, Math.max(0, Number(raw.trigger?.interjectChance ?? 0))),
      interjectCooldownMs: asInt(raw.trigger?.interjectCooldownMs, 300000),
      /**
       * D12b（报告 E15）：插话时机的四个参数 —— 活跃期 TTL / 活跃期乘子 / 冷场阈值 / 冷场乘子。
       *
       * 用展开而不是逐个键抄一遍：`interjectTuningOf` 是这四个值的**唯一定义处**
       * （默认值、夹取区间都在那里），在这里重抄一份就等于多一处会漂的默认值。
       */
      ...interjectTuningOf(raw.trigger),
      /**
       * 纯图/纯表情闸门的宽限期（B8 · S-BARE）。
       *
       * ⚠️ **经验值，不是 QQ 官方阈值** —— 对齐参考实现的默认 5 分钟。
       * 它决定"刚回过话之后多久，纯图就不再唤醒它"。
       * 取太短 → 群里刷图它每次都白跑一次模型调用；取太长 → 它刚说"发来看看"、
       * 对方发来图，它装死（那是最气人的失败模式）。所以只拦"刚说过话"这一小段。
       */
      bareGraceMs: Math.max(0, asInt(raw.trigger?.bareGraceMs, 300000)),
    },
    reply: {
      splitToken: normalizeSplitToken(raw.reply?.splitToken),
      sendDelayMs: asInt(raw.reply?.sendDelayMs, 700),
      /**
       * 出站节奏（B8 · S-GAP）。
       *
       * 默认值从 src/pace.js 现取 —— 这里**不写第二份数字**。
       * 缺省（config.json 里没有这一段）就是启用随机节奏；
       * 想回到老的固定延迟，显式写 `"pace": { "enabled": false }`，
       * 那时 `sendDelayMs` 重新生效。
       */
      pace: {
        enabled: raw.reply?.pace?.enabled !== false,
        minMs: asInt(raw.reply?.pace?.minMs, PACE_DEFAULTS.minMs),
        maxMs: asInt(raw.reply?.pace?.maxMs, PACE_DEFAULTS.maxMs),
        perCharMs: asInt(raw.reply?.pace?.perCharMs, PACE_DEFAULTS.perCharMs),
      },
      maxChunks: Math.max(1, asInt(raw.reply?.maxChunks, 4)),
      maxCharsPerChunk: Math.max(20, asInt(raw.reply?.maxCharsPerChunk, 300)),
      quoteOnReply: raw.reply?.quoteOnReply === true,
    },
    context: {
      recentTurns: Math.max(2, asInt(raw.context?.recentTurns, 12)),
      ambientMessages: Math.max(0, asInt(raw.context?.ambientMessages, 20)),
      /**
       * 背景消息窗口的「成批更替」粒度（B10f-2 · C-AMBIENT）。
       * 攒够几条新消息才把整批背景换掉（而不是每轮补一格 —— 那样窗口一满，
       * 前缀断口就从段末尾前移到段开头）。**经验值** 4：背景最多落后群里 4 条。
       */
      ambientBatch: Math.max(1, asInt(raw.context?.ambientBatch, DEFAULT_AMBIENT_BATCH)),
      /**
       * 上下文预算表（B10f-1 · C-BUDGET）。配额数字的真相源在
       * src/context-budget.js 的 DEFAULT_BUDGET —— 这里**不写第二份数字**。
       */
      budget: budgetOf(raw.context?.budget),
    },
    throttle: {
      minIntervalMs: numOr('minIntervalMs', raw.throttle?.minIntervalMs, asInt),
      perMinutePerSession: Math.max(1, asInt(raw.throttle?.perMinutePerSession, 8)),
      /**
       * 小时级上限（B8 · S-HOUR）。
       *
       * ⚠️ **经验值，不是 QQ 官方阈值**。取 60（平均 1 条/分钟）的理由：
       * 分钟级单看只有"8 条/分钟"，乘出来是 480 条/小时 —— 那个数字对
       * "别让账号看起来像机器"没有任何约束力。
       * 它不是"发够了就报错"，而是让超过的部分**静默不发**并把原因写进日志。
       */
      perHourPerSession: Math.max(1, asInt(raw.throttle?.perHourPerSession, 60)),
      globalConcurrency: Math.max(1, asInt(raw.throttle?.globalConcurrency, 1)),
    },
    persona: {
      name: String(raw.persona?.name ?? '机器人'),
      text: loadPersona(raw.persona?.file),
    },
    // 「自定义工作台」那一整块设置。默认值/校验都在 src/custom-config.js 里，
    // 面板写的是同一个结构 —— 两处不各写一份默认值，才不会出现"面板上填了、机器人没读"。
    custom: readCustom(raw),
  };

  // ── 当前用的是自定义大脑 ⇒ 把它的设置**物化**到扁平字段 ──────────────────
  //
  // 为什么要这一层：机器人侧（brain.js / llm.js）**只认扁平字段**
  // （`cfg.llm.baseUrl` / `.model` / `.apiKey`），它不知道有 customBrains 这回事。
  // 所以"选中哪套"这件事必须在这里摊平，不能指望每个调用点自己去翻。
  //
  // ⚠️ 放在 `cfg` 构造**之后**：上面那几个字段（isLocal / provider）是按
  //    `raw.llm.baseUrl` 算的，自定义大脑的地址不同 ⇒ 必须**重算**，否则
  //    "自定义大脑明明是云端，却被算成本机免费"（本项目真发生过的那类错账）。
  if (activeCustom) {
    // 物化逻辑**只有一份**（住 `src/custom-brain.js`） —— 面板切换时用的是同一个函数。
    materializeBrain(cfg, activeCustom);
    // ⚠️ 这两个派生值必须**按新地址重算**：上面那两个是按 `raw.llm.baseUrl` 算的，
    //    自定义大脑的地址不同 ⇒ 不重算就会出现"云端被算成本机免费"那类错账。
    cfg.llm.isLocal = isLocalBase(activeCustom.baseUrl);
    cfg.llm.provider = providerOf(activeCustom.baseUrl);
  }

  // 工作台上填的「连续回复冷却时间」是**在底层防抖之上**再加的间隔。
  // 取两者的大值，而不是覆盖：throttle.minIntervalMs 是代码层的安全底线
  // （防止一条消息触发两轮回复这种偶发重复），不该被界面上的一个数字抹掉。
  const uiCooldownMs = Math.round((cfg.custom?.replyStyle?.cooldownSec || 0) * 1000);
  if (uiCooldownMs > cfg.throttle.minIntervalMs) cfg.throttle.minIntervalMs = uiCooldownMs;

  // 工作台的「一件事多条消息发 / 总结成一条长消息发」。
  // 刻意**映射到已有的 reply.maxChunks = 1**，而不是在发送层再写一套合并逻辑 ——
  // 拆分与合并是同一件事的两端，各写一份迟早不一致（回复长度那条已经踩过一次）。
  if (cfg.custom?.replyStyle?.multiMessage === false) cfg.reply.maxChunks = 1;

  return cfg;
}

// `isLocalBase()` / `providerOf()` 搬去 `src/net-rules.js`（B11c · AR-DATADRIVEN）。
//
// 为什么搬而不是"三处保持手工同步"：这两条判据决定**花不花钱**，
// 而它们曾经有五个拷贝，并且真的漂过一次（前端那份少了 172.16–31 内网段，
// 于是"本机免费"被算成"云端计费"）。手工同步不是一个可执行的约定 ——
// 能执行的是"只留一份，剩下的去 import 它"。

/**
 * 思考配置归一化。
 * 兼容两种写法：旧的字符串（"auto" / "on" / "off"）和新的对象（{mode, level}）。
 * 老配置文件里的字符串照旧能读，不会把用户之前的设置弄丢。
 */
function normalizeThinking(v) {
  // 智谱的思考档位是 low / high / max（实测它不认 medium），
  // DeepSeek 是 low / medium / high。这里统一存下四档，由 provider 决定怎么映射。
  const level = (s) => (['low', 'medium', 'high', 'max'].includes(s) ? s : 'medium');
  if (v && typeof v === 'object') {
    const mode = ['auto', 'on', 'off'].includes(v.mode) ? v.mode : 'auto';
    return { mode, level: level(v.level) };
  }
  if (['auto', 'on', 'off'].includes(v)) return { mode: v, level: 'medium' };
  return { mode: 'auto', level: 'medium' };
}

function loadPersona(relFile) {
  if (!relFile) return '';
  const file = path.resolve(ROOT, relFile);
  if (!fs.existsSync(file)) {
    log.warn(`人格文件不存在，将使用空人格: ${file}`);
    return '';
  }
  return fs.readFileSync(file, 'utf8').trim();
}
