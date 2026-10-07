/**
 * QQ-BOT-CONTROL（本地控制台）
 * 只监听 127.0.0.1，不依赖任何第三方包。
 * 提供：状态检测 / 配置读写 / 启动停止 / 连接自检 / 实时日志
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
// 模型能力档案与「自定义工作台」的配置结构 —— 与机器人进程共用同一份，
// 面板绝不自己再写一份默认值/判定规则（写两份必然漂移，这是本项目反复踩过的坑）
import { ZHIPU_MODEL_META, capabilitiesOf, resolveFeatures, FEATURE_LABEL, THINK } from '../src/model-caps.js';
import {
  readCustom, patchCustom, SIMILAR_THRESHOLD, SCENES, REPLY_LENGTHS, FACE_PRESETS, PLAY_RULES,
  ENHANCE, ENHANCE_KEYS, ENHANCE_GROUPS,
  SKILL_IN_PROMPT, MANUAL_MEMORY_IN_PROMPT, similarity,
} from '../src/custom-config.js';
// 本地对话流的读盘口（第 16 轮 · H-10 第二半搬出，层号 L1 · 只依赖 paths.js）。
// ⚠️ `TRACE_SHOWN`（卡片显示几条）与 `TRACE_AGGREGATE`（会话聚合几条）**是两个数**：
//    共用会让会话列表永远只有 3 条记录里的 1~2 个会话 —— 而页面看起来是正常的。
import { readTrace, TRACE_SHOWN, TRACE_AGGREGATE } from './lib/trace-io.js';
import {
  listAutoMemory, clearAutoMemory, readRecords, reviewRecordById, recallForPrompt,
  AUTO_MEMORY_FILE as AUTO_MEMORY_PATH,
} from '../src/memory.js';
// 结构化记忆的**判据表**（状态中文名 / 该显示哪些按钮 / 淡忘程度）。
// 面板只做渲染，一个中文名与一个上限数字都不自存 —— 全项目唯一来源是那个零依赖叶子。
import {
  RECORD_STATUS, RECORD_STATUS_LABELS, REVIEW_ACTIONS, REVIEW_ACTIONS_FOR,
  SAMPLES_TO_CONFIRM, SAMPLES_FOR_STABLE, PROMPT_BUDGET_CHARS,
  kindShort, activationOf, looksInferred, RECALL_MAX,
} from '../src/memory-record.js';
// 入库注入闸门（B9 · INJ-GATE）。与机器人进程共用同一份模式表 ——
// 面板是**另一条写入路径**，两边各写一份规则的话，迟早出现"机器人拦得住、面板直接存进去"。
import { looksInjected } from '../src/injection.js';
import { GATE_ERROR_KIND, isBlocking } from '../src/gate-scan.js';
// 面板写路由的鉴权判定（B9c · AUTH-PANEL）。判定本身是纯函数、在 src/panel-auth.js 里，
// 这里只做**唯一的那次接线**：解析 token → 拦写路由 → 把 token 交给页面。
import { authDecision, presentedToken, newToken, injectPanelToken, TOKEN_ENV } from '../src/panel-auth.js';
// 「这个进程是不是本项目的机器人」的核验（B9d · G-5）。判定与解析都是纯函数，
// 只有 lsof 探测在这里 —— 于是"会不会误杀"这件事能被 smoke 直接断言。
import { isOurBridge, parsePgrepLine, firstPathOf, PGREP, LSOF, PGREP_LIST_FLAGS } from '../src/bridge-proc.js';
// D19 · 机器人进程侧的实例锁。**只读**：判据（"锁长什么样"）用 `src/bridge-lock.js`
// 的 `parseLock`，退出码也从那儿取 —— 面板不许再写一份"锁的格式"或再抄一个 3。
import { parseLock, LOCK_REFUSE_EXIT_CODE } from '../src/bridge-lock.js';
// ⚠️ `writeJsonAtomic` / `appendHistory` / `historyEntryOf` 的导入随 `writeConfig` 一起搬去了
//    `lib/config-io.js`；`CONFIG_FILE`（与 `configPath()` 同一语义）、`DOCKER_CANDIDATES`、
//    `MAX_LOG` 三个曾是**只出现在 import 行、正文零引用**的僵尸导入，已清掉
//    （判据：`grep -c` 各为 1，即仅 import 那一处；契约与测试均未提及它们）。
//    `PANEL_LOG` 起初同批被清，后来 `restartPanel()` 的看门狗重定向要写 panel.log，
//    与其在函数里再硬编码一遍同一段路径，不如把 paths.js 的常量接回来 —— 路径只推导一次。
import { readHistory, configAt, popHistory } from '../src/config-history.js';
import { thinkingIsLive } from '../src/ephemeral.js';
import { sweepStaleTemps, truncateLinesAtomic } from '../src/atomic-write.js';
// 当月账本的「今天」判据：与机器人侧共用 `dayKeyOf` 一份，不在本地再拼一个
// （本地那份月份/日不补零，9 月会算出 `2026-9-1`，与 src 侧的 `2026-09-01`
//   对不上 —— 注释自称同口径，实现却已经漂了）。
// ⚠️ 第 13 轮 H-11：它的唯一实现搬到了零依赖叶子 `src/holidays.js`
//    （`trace-stats` 只是 import，那才是能被 `reminder.js` 共享的落点）。
import { dayKeyOf } from '../src/holidays.js';
// ── 底座层（B11b-1 · AR-SERVERSPLIT）──────────────────────────────────────
// 路径 / 端口 / 运行状态 / HTTP 收发这四类东西搬到了 panel/lib/ 下，见各自的模块注释。
// ⚠️ `ROOT` 必须从这里来 —— 它是**搬了就静默失效**的那个常量（在 panel/lib/ 下
//    用 import.meta.url 退两级才是仓库根，写错会让整台面板用着默认配置继续跑）。
import {
  ROOT, PORT, SANDBOX, NODE, BACKEND_SOURCES,
  HOME, QWEN_SERVER, QWENCHAT_SERVER, MLX_PY,
  NAPCAT_WEBUI_PORT,
  DOCKER, DOCKER_APP,
  EFFECTIVE_FILE, THINKING_FILE, HISTORY_FILE, AUDIT_FILE, TOKEN_FILE,
  TRACE_FILE, ARCHIVE_FILE, USAGE_DIR, USAGE_FILE_RE, PIDFILE, BRIDGE_LOG, LOCAL_LOG, PANEL_LOG,
  BRIDGE_LOCK_FILE,
  DEBUG_FLAG,
} from './lib/paths.js';
// ── 控制台页面是哪一套（2026-10-02 · 新版成为**唯一**控制台）───────────────
//
// 历史：旧页面曾是 `panel/parts/` 下 16 个片段按 `PARTS` 拼装的一份 HTML（`GET /`），
// 新版是"静态分发"（`GET /next`）。**现在旧页面连同它的拼装模块一起删掉了**，
// 新版搬到**根**上：`GET /` 就是入口，`/style.css` / `/app.js` / … 是它的资产。
//
// ⚠️ 资产路径 → 资产名的映射**在叶子里派生**（`assetNameForRootPath`，与白名单同源），
//    路由这里不摆第二张"允许的路径"表 —— 两张表会漂，而多一条路径是**静默**多一个入口。
import { readNextAsset, NEXT_ENTRY, assetNameForRootPath, PANEL_CSP } from './lib/next-page.js';
import { extensionsOf } from './lib/extensions.js';
// 插件写的数据 → 面板能看的样子（2026-10-02）：情绪 / 群友档案 / 图库 / 额度情报。
// 四个读盘口收在那一个 L1 叶子里，这里只做一次调用 —— 路由里不出现任何数据文件名。
import { readBotData } from './lib/bot-data.js';
// 会话 / 存档的聚合判据（P1 分区重构）。**纯函数在 lib 里**，这里只做读盘 + 传参 ——
// 判据不落在路由里，"列表怎么算"才能被断言直接喂（本项目对判据的一贯要求）。
import { sessionsFromTrace, sessionRecordsOf, chatsFromArchive, chatDetailOf } from './lib/sessions.js';
// 控制通道（D6b · Q7 裁决①「命令文件轮询」）。下发命令 / 读回结果 / 中文名表
// 三件事的面板侧实现都在 lib 里，这里只做读盘渲染 + 一条写路由 —— 判据一处都不重写。
import { CONTROL_LABELS, controlStateOf, issueCommand } from './lib/control.js';
import { applySettingsPatch } from '../src/plugin-settings.js';
// H-03（2026-10-05 · 第 10 轮 · 开源前审查）：人格文件的**路径包含性判据**复用唯一实现。
// 它是零依赖叶子（`panel/lib/ext-install.js` 早已在用它），面板侧不许再写第二份 `..` 判断
// —— 两份判断迟早一边放行一边拒绝（本项目在 `normalizeThinking` 上真实踩过）。
import { isSafeRelPath } from '../src/plugin-manifest.js';
// H-09（同上）：面板的全局异常兜底要把异常正文写进日志，而 `/api/logs` **不鉴权** ——
// 所以出口前必须过脱敏，且必须用唯一那份实现（与 `src/logger.js` 出口同一张特征表）。
import { maskSecrets } from '../src/egress.js';
import { state, logDropped, pushLog, clearLogs } from './lib/runtime-state.js';
// D21：`readBodyBuffer` 是"原样收字节"的读法（ZIP 上传用）—— 与 `readBody` 同模块，
// 但**不动** `readBody` 的 JSON 语义与 1e6 上限（全部写路由共用它，改它等于改全局）。
import { sendJson, readBody, readBodyBuffer } from './lib/http-io.js';
// ── `config.json` 的唯一所有者（B11b-2 · AR-SERVERSPLIT）────────────────────
// 读配置 / 写配置 / 记配置历史这三件事只有这一处实现。搬了实现就要**把契约也搬过去**
// （`check-wb` 的 3i / 3k 现在扫的是 `lib/config-io.js`），否则契约会变成永远绿的摆设。
import { readConfig, writeConfig } from './lib/config-io.js';
// ── 模型元数据与判定（B11b-2 · AR-SERVERSPLIT）──────────────────────────────
// 只 import 主文件真的用得到的那 24 个 —— 模块里另有 15 个是它的内部实现细节
// （`ZHIPU_SELECTABLE` / `PROVIDER_DEFAULTS` / `mergeDeep` …），
// 导出一堆没人读的名字，只是把"依赖面"这个信息糊掉。
// ⚠️ `LOCAL_MODEL_PORT` / `QWENCHAT_PORT` 随这一节一起搬走了，主文件不再需要它们。
import {
  LOCAL_MODELS, LOCAL_CHANNELS, localChannelOf, localChannelUrl, localKeyOf,
  localModelExists, resolveLocalKey, mergeModelList, modelProviderMismatch,
  ZHIPU_DEFAULT_CHAIN, MAX_CHAIN_LEN, CLOUD_PRESETS, BUILTIN_MODELS, PRESET_KEYS,
  MODEL_LABELS, CREDIT_CLOUD_MODELS, isZhipuModel,
  normalizeThinking, buildModelCaps, readPresets, stashCurrentPreset, readZhipuPackages,
} from './lib/models.js';
// H-10 第二半：状态聚合与导出包（第 19 轮搬出）。判据由主文件注入，理由见下方接线处。
// ── 第 22 轮 H-10：审计与用量两族整块搬进 lib（实现只在新家一份）────────────
import { makeBeginAudit, readAudit, readArchive } from './lib/audit-log.js';
import { makeUsageReport } from './lib/usage-report.js';

import { makeStateCollector } from './lib/state-collector.js';
import { makeExportBundle } from './lib/export-bundle.js';
// 「保存配置」这条路由的逻辑（第 18 轮搬出 · L3）。四个判据由主文件注入，理由见下方接线处。
import { makeConfigRoute } from './lib/config-route.js';
// ── 网络地址判定（B11c · AR-DATADRIVEN）──────────────────────────────────────
// `providerOf` / `isLocalBase` **不再由 `lib/models.js` 转发**（谁实现谁导出）。
// 直接引真身：它同时是机器人进程判钱、查询余额判服务商、以及下发给页面的
// `provider` 字段的唯一来源 —— 一份实现，三个消费方，没有第二份可漂。
import { providerOf, isLocalBase, providerHostOk } from '../src/net-rules.js';
// ── 数值类设置的默认值 / 上下限（第 42 轮 B12b · SCHEMA-LITE）─────────────────
// 面板上「只保留底层的 1.5 秒防抖」「默认 23 点到 8 点」「最多 2 段」这些**数字**
// 与 `<input min max>` 的区间都从这里下发，前端一个都不自存 ——
// 与 `MODEL_LABELS` / `featureLabels` / `similarThreshold` 同款做法。
// 唯一真相源是 `src/field-schema.js`（机器人侧读的是同一份）。
import { fieldMeta } from '../src/field-schema.js';
// ── D29：账务的**来源枚举**（唯一一份）─────────────────────────────────────
// 面板读账本时要按来源分桶（主回复 / 记忆判定 / 主动话题）。桶名必须来自
// `src/usage.js` 的 `USAGE_SOURCES`，不能在面板侧再抄一份字面量 ——
// 抄一份的必然结果是"机器人多了一个来源、面板认不出它，于是那一笔全进未标注"。
import { USAGE_SOURCES } from '../src/usage.js';
// ── D21：ZIP 编解码 + 插件安装（板侧唯一实现）────────────────────────────
// 写（导出用）与读（导入用）**共用同一份 crc32** —— 两份必然漂，
// 而漂的表现是"自己打的包自己读不出"。`makeZip` 原先长在本文件里，本步搬进叶子。
import { makeZip, ZIP_UPLOAD_MAX } from './lib/zip.js';
// 安装的**判据 + 三步落盘**全在 `ext-install.js`（IO 可注入 → 能确定性地测回滚）。
import { installArchive } from './lib/ext-install.js';
// 插件的两个根（`plugins/` / `skills/`，可被 `QQBOT_*` 覆盖）—— 唯一推导处。
// 面板早就通过 `panel/lib/extensions.js` 引了 plugin-host，这里不是新的启动路径耦合。
import { extensionRoots } from '../src/plugin-host.js';
// ── 进程 / 网络 / 内存工具（B11b-2 · AR-SERVERSPLIT）────────────────────────
// ⚠️ `net` / `randomBytes` 的导入随这一节搬走了（`wsProbe` 里用的），主文件不再需要。
import {
  sh, shBuffer, killTree, pidAlive, waitFor,
  portOpen, httpGet, httpJson, wsProbe,
  ensureDocker, cachedMemory, cachedDockerUp, invalidateDockerCache, cachedDockerPs,
} from './lib/proc.js';

// `PANEL_FILE` 与上面那批**放在一起是为了对照**：它同样是"我这个文件在哪"，
// 但语义完全不同 —— 它必须是 **server.js 自己的路径**（重启看门狗要 exec 它）。
// 所以它**不许**跟着 ROOT 一起搬走，也**不许**用它去做自检（见 panelInfo 的 stale）。
const PANEL_FILE = fileURLToPath(import.meta.url);

/**
 * ══════════════════════════════════════════════════════════════════════
 *  审计日志（B9 · AU-AUDIT）
 * ══════════════════════════════════════════════════════════════════════
 *  「谁改了什么」以前完全不可追踪：控制台能改配置、能起停进程、能清账本，
 *  全都没有留痕。而这类事恰恰是**事后才想起要查**的 —— 到那时只能靠猜。
 *
 *  三条刻意的设计：
 *  ① **append-only**：只追加、从不重写。所以它不会被"下一次保存"覆盖掉；
 *     超长时按与对话流相同的办法折半截断（保留最近一半），不做轮转改名
 *     （轮转改名会让"最近一次"出现在另一个文件里，查的人根本想不到去看）。
 *  ② **成与败都记**：失败的那一次往往才是最需要看的（"我点了没反应"）。
 *     所以挂在 `res` 的 `finish` 事件上，而不是在 handler 里手动记 ——
 *     手动记必然漏掉抛错和提前 return 的分支，而**审计出现假阴性比没有审计更危险**。
 *  ③ **actor 必须有值**：拿不到来源就写 `unknown`，绝不写空串 ——
 *     空字段在界面上与"压根没记这一条"完全同形。
 */

/**
 * 「哪些请求算一次改动」——**全项目唯一一处**这样的判定。
 * B9c 的面板鉴权将复用同一张表（读写分类必须同源，否则会出现
 * "审计记了但没鉴权"或者反过来的漏洞）。
 *
 * 分类只按**状态是否被改变**，不按"是不是 POST"：
 * `/api/try`（试一句）与 `/api/custom/preview`（预览提示词）都是 POST，
 * 但它们不写任何东西（只花一次模型调用），所以两边都不该被拦。
 */
const READ_ONLY_POST = new Set([
  // 试一句：只花一次模型调用，不落盘
  '/api/try',
  // 预览提示词：纯拼装，不落盘
  '/api/custom/preview',
  // 连接自检：起一个一次性脚本探协议端，不改任何状态
  // （它是被 `check-wb` 的「写路由必须逐个分类」契约扫出来漏掉的那一个 ——
  //   这就是那条契约存在的意义：新加路由时最容易忘的就是这一行）
  '/api/check',
  // D-M3 记忆检索：POST 只是因为要带查询词，**它只读盘、不改任何状态**
  // （`recallForPrompt` 明文保证"检索不算复证、samples 一条不加"）。
  // 放这里而不是 WRITE_ROUTES：那是给"会改变状态"的请求准备的。
  '/api/memory/search',
]);

/** 写路由：🔴 写配置 / 进程控制 ／ 🟡 破坏性写 */
const WRITE_ROUTES = new Set([
  // 🔴 写配置
  '/api/config',
  '/api/config/undo', // 撤销上一次保存（B10b · O-CFGHIST）—— 它会整份覆盖配置，必须受保护
  '/api/switch',
  // 🔴 进程控制
  '/api/bridge/start', '/api/bridge/stop',
  // D6b：面板 → 机器人的命令下发（中止本轮 / 重试本轮）。它是**进程控制**的一类
  // （改变机器人的行为，只是经由文件而不是信号）—— 与 start/stop 同桌才不会被漏掉鉴权。
  '/api/bridge/command',
  '/api/local-model/start', '/api/local-model/stop',
  '/api/onekey/start', '/api/onekey/stop',
  '/api/stop-all', '/api/napcat/restart', '/api/panel/restart',
  // 🟡 破坏性写 / 有副作用的开关
  '/api/debug', '/api/qrcode/refresh',
  '/api/trace/clear', '/api/logs/clear', '/api/usage/reset',
  '/api/custom/memory/clear', '/api/custom/memory/delete',
  // ATI-5：人工复核结构化记忆（改状态 / 删一条）。它改的是 `panel/memory-records.json`，
  // 而那份文件会直接决定"下一轮提示词里带不带这条" —— 属写路由。
  '/api/memory/review',
  // D21：插件 ZIP 导入（往 `plugins/` / `skills/` 落目录）。它是**破坏性写**
  // （会新建、可覆盖已有包）→ 与 trace/logs 清理同桌，必须受鉴权与审计。
  '/api/extensions/install',
]);

/** 这次请求是不是"一次改动"。审计与将来的鉴权共用它。 */
function isWriteRequest(p, method) {
  return method === 'POST' && WRITE_ROUTES.has(p);
}

/**
 * ── 本机 Host 的形状（2026-10-05 开源前审查 · S-05）────────────────────────
 *
 * 面板只绑 `127.0.0.1`（见文件末尾 `server.listen`），所以**网络上是关着的** ——
 * 但"绑回环"不等于"没有远程入口"：恶意站点可以用 **DNS Rebinding** 让自己的域名
 * 解析到 `127.0.0.1`，浏览器随即把它判成**同源**，跨源限制整段失效。
 * 之后 `fetch('/')` 能直接读走 `<meta name="panel-token">` 里的 token，
 * 拿着它就能打全部 22 条写路由 —— 最坏一条是 `/api/extensions/install`
 * （往插件两个根落目录，宿主随后动态 `import()` ⇒ **本机任意代码执行**）。
 *
 * ⇒ 物理上只绑回环，逻辑上还要**认 Host**。
 *
 * ⚠️ **这一道挡不住 Rebinding**：重绑之后 Host 就是 `127.0.0.1:8788`，完全合法。
 *    真正能区分"用户自己的控制台页面"与"重绑过来的页面"的是 **Origin / Sec-Fetch-Site**
 *    —— 那一道见 `sameSiteWrite()`。两道是互补的，缺任何一道这条链都还是通的。
 *
 * ⚠️ 端口用 `\d+` 而不是写死 8788：面板端口可被 `QQBOT_PANEL_PORT` 覆盖（三件套之一）。
 * ⚠️ Host 缺失一律拒（fail-closed）：HTTP/1.1 必带 Host，缺它只可能是异常客户端。
 */
const LOOPBACK_HOST_RE = /^(?:127\.0\.0\.1|localhost|\[::1\]):\d+$/;

/**
 * ── 模型接口地址能不能收（2026-10-05 开源前审查 · S-08）───────────────────
 *
 * 为什么必须判：`baseUrl` 是机器人**发 HTTP 请求的目标**，请求头里带着
 * `cfg.llm.apiKey` / `cfg.llm.keys[provider]`。把它改掉之后：
 *   · 每一次群聊都会把用户的 API Key 送到那个地址；
 *   · 对方返回的文本会被当作"模型回复"**照发进用户的 QQ 群**。
 * 而这个地方原本只做了 `.trim()` —— 连"是不是合法 URL"都没问。
 *
 * 三条（按风险从硬到软）：
 *   ① **协议**：只收 https；明文 http **只对本机放行**（本机模型服务跑在
 *      `http://127.0.0.1:端口`，比如 MLX / QwenChat，那一类确实是 http）。
 *      ⇒ 这一条挡掉 `file://` / `data:` / `javascript:` 与"打到内网别台机器"。
 *   ② **自称的厂商要与域名对得上**：`https://deepseek.com.evil.com` 会被
 *      `providerOf()` 的子串匹配判成 deepseek，但它的 host 不以官方域名结尾。
 *      判据在 `src/net-rules.js` 的 `providerHostOk()`（域名字面量的唯一住处）。
 *   ③ 其余（自建 / 中转的 https 地址）放行 —— 用户确实会用自建网关，
 *      再收紧就把正常用法一起挡了。**这不是白名单被绕过，是刻意的取舍**，
 *      代价写在上面，别误以为它挡住了所有外泄。
 *
 * @returns {string} 空串 = 可以收；非空 = 给人看的拒绝理由
 */
const LOOPBACK_NAMES = new Set(['127.0.0.1', 'localhost', '::1', '0.0.0.0']);
function baseUrlReject(raw) {
  const text = String(raw || '');
  let u;
  try { u = new URL(text); } catch {
    return '不是一个合法的 URL（要写成 https://… 或 http://127.0.0.1:端口…）';
  }
  if (u.protocol === 'http:') {
    return LOOPBACK_NAMES.has(u.hostname)
      ? ''
      : '明文 http 只对本机放行（127.0.0.1）；其余一律要用 https:// —— 不然 Key 会在链路上裸奔';
  }
  if (u.protocol !== 'https:') {
    return `不支持的协议 ${u.protocol} —— 只收 https://（本机可用 http://127.0.0.1）`;
  }
  if (!providerHostOk(text)) {
    return '这个地址自称是某个服务商，但域名不是它的官方域名 —— 请核对你填的接口地址';
  }
  return '';
}

/**
 * 写操作的"是不是从控制台页面发出来的"。
 *
 * 为什么需要它：Host 那一道在 Rebinding 之后会被绕过（重绑后 Host 完全合法），
 * 而**同源写操作**浏览器一定会带上这两个头之一：
 *   · `Origin` —— 写操作必带，值必须是本机地址；
 *   · `Sec-Fetch-Site: same-origin` —— 现代浏览器在同源请求上必带。
 * 重绑过来的那个页面，它的 `Origin` 是**攻击者域名**，一眼就能分开。
 *
 * ⚠️ **两个头都不带时不拦**：那是 curl / launcher.sh 这类本机脚本（HTTP 层没有浏览器
 *    那套 Fetch 元数据）。它们仍然必须过 `authDecision` 的 token 那一关 ——
 *    那才是给"没有浏览器元数据的一类请求"准备的闸，别在这里重复造一道。
 *    所以本函数只拦"**带了却不对**"，不带的一律放行给下一道。
 */
function sameSiteWrite(headers = {}) {
  const origin = headers['origin'] ?? headers['Origin'];
  if (typeof origin === 'string' && origin) {
    let u;
    try { u = new URL(origin); } catch { return false; }
    return LOOPBACK_HOST_RE.test(u.host);
  }
  const site = headers['sec-fetch-site'] ?? headers['Sec-Fetch-Site'];
  if (typeof site === 'string' && site) return site === 'same-origin';
  return true;
}

/* ── 面板侧的**时长与截断长度**（L-07 · 2026-10-05 · 第 12 轮 · 开源前审查）──────────
 *
 * 这些数字以前散在 `:600` / `:667` / `:746` / `:1334` / `:2041` / `:2074` / `:3172`
 * / `:3607` 各处裸写。它们**不是装饰**：「HTTP 8 秒」与「本机模型 2 分钟」是两个语义，
 * 裸写成同一个数字之后，就没人分得清哪个能改、哪个改了会**误杀慢模型**。
 *
 * ⚠️ 按**用途**命名，不按数值合并。数值碰巧相同 ≠ 语义相同 ——
 *    本项目在 `normalizeThinking` 上真实踩过"两处看着一样、改一处崩另一处"。
 * ⚠️ 这几个值**一个都没改**（本轮只做具名化）：它们是**经验值**，动它们要另跑一轮取证。
 */
/** 短超时：本机 / 局域网 HTTP 与 docker 的**快**命令。够慢命令失败，又不至于把页面吊住。 */
const HTTP_TIMEOUT_MS = 8000;
/** 本机模型（mlx / qwen）**冷启动**就绪的轮询上限 —— 首次要读几 GB 权重，不能用上面那个 8 秒。 */
const MODEL_READY_TIMEOUT_MS = 120000;
/** 单次本机模型请求的硬超时（fetch 的 abort）。它是"最后一次机会"，故比轮询上限更长。 */
const MODEL_REQUEST_ABORT_MS = 180000;
/** 清掉占用端口的旧进程之后，等它真的把端口让出来。 */
const PORT_RELEASE_WAIT_MS = 2500;
/** 协议端 `get_login_info` 就绪探测：单次超时 / 两轮之间的间隔 / 总期限。 */
const ONEBOT_PROBE_TIMEOUT_MS = 2500;
const ONEBOT_PROBE_GAP_MS = 2000;
const ONEBOT_READY_DEADLINE_MS = 60000;
/** 「重启机器人」两次动作之间的沉降：等进程真的没了，再去起下一个。 */
const BRIDGE_SETTLE_MS = 1200;
/** 报错正文回显给页面的长度：够看清卡在哪一步，又不至于把整份 docker 输出塞进响应。 */
const ERR_SNIPPET_CHARS = 200;
/** 干跑（dry run）失败时回给页面的原始输出**尾巴**长度（看结尾的错误更准）。 */
const DRYRUN_TAIL_CHARS = 1200;
/** 审计里记 User-Agent 的长度：够区分浏览器与 curl，又不撑爆账本行。 */
const UA_MAX_CHARS = 60;
/** 配置差异表里单个值的最长显示长度（超了截断加省略号）。 */
const DIFF_VALUE_MAX_CHARS = 60;
/** `docker rm -f` / `docker compose up -d`：后者要重建、可能拉层，是最慢的一条外部命令。 */
const DOCKER_RM_TIMEOUT_MS = 30000;
const DOCKER_COMPOSE_TIMEOUT_MS = 240000;
/** 干跑（`scripts/dryrun.js`）要起一整个机器人进程再收尾，给得比 docker compose 还要宽。 */
const DRYRUN_TIMEOUT_MS = 240000;
/** 给一个进程发完信号后等它自己退出的宽限（超过就升级到 SIGKILL）。 */
const KILL_GRACE_MS = 3000;
/** 面板自己退出前的两点时序：先让响应的 flush 走完，再留一拍给看门狗接上。 */
const PANEL_EXIT_SETTLE_MS = 350;
const PANEL_EXIT_GRACE_MS = 1000;

/**
 * ⚠️ **有意保持裸写**的那一批（L-07 的边界，写下来免得下一个人以为是漏的）：
 *    轮询之间的短间隔（`300` / `500` / `1500` / `2000` 毫秒的那几个 `setTimeout`）**没有**具名。
 *    理由：它们的含义完全由**紧邻的那一行**给出（"再探一次" / "等它让出端口"），
 *    互相之间不存在"看着一样、其实不能混用"的风险 —— 而具名化本身要改动调用点，
 *    对一处**不影响行为**的可读性问题而言，改动面越大越不划算。
 *    真正危险的是**长时长之间**的混淆（HTTP 8 秒 vs 模型 2 分钟 vs compose 4 分钟），
 *    那些已经全部具名。要不要把短的也收，是**可以再决定的**，不是漏掉的。
 */


// ---------- 审计（第 22 轮 · H-10：实现搬进 lib/audit-log.js）----------
// `isWriteRequest` / `UA_MAX_CHARS` 由主文件**注入**：前者是安全核心
// （唯一入口表「哪些请求算改动」），后者另有一处调用点 —— 搬进 lib 会变两份实现。
const beginAudit = makeBeginAudit({ isWriteRequest, UA_MAX_CHARS });

/* ══════════════════════════════════════════════════════════════════════
 *  面板写路由鉴权（B9c · AUTH-PANEL）
 * ══════════════════════════════════════════════════════════════════════
 *  B9 的审计让「谁在改配置」第一次可见 —— 它在真机上第一次跑就记下了
 *  `actor=loopback · ua=curl/8.7.1`：**本机任何一个程序**都能起停机器人、改配置。
 *  这一节要让它做不到。
 *
 *  token 从哪来 —— 三种来源，**顺序是刻意的**：
 *    ① 环境变量 `QQBOT_PANEL_TOKEN`（沙箱 / CI / 想自己管的用户）；
 *    ② `panel/.token`（上次生成的，已 gitignore）；
 *    ③ 都没有 → 当场生成一个，写进 `panel/.token`（0600）。
 *
 *  为什么默认就生成，而不是"没设就放行"：
 *  放行等于默认不设防 —— 用户不手动设一个环境变量，这一批的收益就是 0。
 *  而"token 可被本机任意程序读走"这件事，默认放行与默认强制**一样成立**
 *  （回环服务区分不了浏览器和别的本地程序），所以没有理由拿默认不设防去换它。
 *
 *  已知残余风险（如实声明，不藏）：
 *  **本机进程仍可 `GET /` 从页面里读走 token**。本批挡住的是
 *  "没有去读 token 的那一类写请求"（陈旧脚本 / cron / 误粘贴的 curl）。
 */

/**
 * 解析出本次运行用的 token。**全项目唯一一处**。
 * 只有这里做 IO —— 判定逻辑在 `src/panel-auth.js` 里，是纯函数。
 */
function resolvePanelToken() {
  const fromEnv = String(process.env[TOKEN_ENV] || '').trim();
  if (fromEnv) return { token: fromEnv, source: 'env' };

  try {
    const saved = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    if (saved) return { token: saved, source: 'file' };
  } catch { /* 文件不存在很正常：第一次跑 */ }

  const made = newToken();
  try {
    fs.writeFileSync(TOKEN_FILE, made + '\n', { mode: 0o600 });
  } catch { /* 落不下盘也必须能用：内存里那份照样生效，只是重启后换一个 */ }
  return { token: made, source: 'generated' };
}

const PANEL_TOKEN = resolvePanelToken();

/**
 * 要不要把 token 的**正文**打进启动横幅（L-02 · 2026-10-05 · 第 12 轮 · 开源前审查）。
 *
 * 默认**否**。旧行为是"每次新生成就把 token 原文打出来"，而 stdout 会被 launcher 重定向
 * 落进 `panel/panel.log` —— 于是一份**写操作凭据**明文躺在磁盘上（虽然被 `.gitignore` 忽略，
 * 也**不是** `/api/logs` 那条路径）。它与 `SECURITY.md`「token 防的是浏览器里的其它站点」
 * 的口径有张力，而**它并不是必需的**：页面由本服务注入 token，用户真要也能 `cat panel/.token`。
 *
 * 保留这个开关是因为"要看一眼"是真需求（排障时最直接）。
 * ⚠️ 判定写在这里、只写一次：横幅那处只读这个布尔，不再自己解析环境变量。
 */
const ECHO_PANEL_TOKEN = /^(1|true|yes|on)$/i.test(String(process.env.QQBOT_PANEL_TOKEN_ECHO || '').trim());

/**
 * 鉴权不通过时回给调用方的 JSON。
 * 文案只在这里出现一次；`reason` 进日志，方便事后对账"那次到底为什么被拒"。
 */
function denyUnauthorized(res, p, verdict) {
  pushLog(`✗ 写操作被拒（${p}）—— 本机进程需要带面板 token 才能改配置或起停进程`);
  return sendJson(
    res,
    {
      ok: false,
      error: '未授权：写操作需要面板 token',
      reason: verdict.reason,
      hint: 'token 保存在 panel/.token（0600），需要时 `cat panel/.token` 查看',
    },
    verdict.status || 401,
  );
}

/**
 * ══════════════════════════════════════════════════════════════════════
 *  面板进程的「代码版本自检」—— 为什么必须有这一层
 * ══════════════════════════════════════════════════════════════════════
 *  `panel/index.html` 是**每次请求读盘**的，而 `panel/server.js` 是**启动时进内存**的。
 *  于是出现过一个很难查的状态：页面上明明有新分区（HTML 是新的），
 *  点它却毫无反应（后端还是旧代码，接口 404 / 字段没下发）。
 *  更糟的是 `launcher.sh` 的 `panel_up()` 只探端口，**活着的旧面板永远等不到重启**，
 *  于是"改了没用"能跨好几个版本一直存在。
 *
 *  这里记下启动那一刻 server.js 的 mtime；之后磁盘上的它一旦变新，
 *  `/api/state` 就会下发 `panel.stale = true`，页面据此出黄条 + 一键重启。
 */
const BOOT = { pid: process.pid, at: Date.now(), codeMtime: newestCodeMtime() };

/** 文件修改时间（毫秒）。取不到就返回 0 —— 自检本身绝不能成为新的故障点。 */
function fileMtimeMs(file) {
  try { return fs.statSync(file).mtimeMs; } catch { return 0; }
}

/**
 * 后端**全部**源文件里最新的那个 mtime。
 *
 * 为什么不能只看 `PANEL_FILE`（B11b-1 修的就是这个）：
 * 拆分之前后端只有 `panel/server.js` 一个文件，比它一个就够。
 * 拆出 `panel/lib/*.js` 之后，**改 lib 而没动 server.js 是常态** ——
 * 那时"磁盘上的代码比这个进程新"这件事就查不出来了：黄条不出现、
 * `launcher.sh` 的 `panel_restart` 也不会被触发，改动静默地不生效。
 * 而这恰恰是这段自检当初要解决的故障，等于绕一圈又回来了。
 *
 * 清单来自 `paths.js` 的 `BACKEND_SOURCES` —— 与 `check-wb` 的静态契约**同源**；
 * 漏登记的风险由一条契约用 `readdirSync` 交叉核对兜住。
 */
function newestCodeMtime() {
  let newest = 0;
  for (const rel of BACKEND_SOURCES) {
    const t = fileMtimeMs(path.join(ROOT, rel));
    if (t > newest) newest = t;
  }
  return newest;
}

/**
 * 面板自身的运行信息。`stale` = 磁盘上的代码比这个进程新，即"改完没重启"。
 * 1ms 容差是给文件系统时间戳精度留的余量。
 */
function panelInfo() {
  const now = newestCodeMtime();
  return {
    pid: BOOT.pid,
    bootedAt: BOOT.at,
    uptimeMs: Date.now() - BOOT.at,
    codeMtime: Math.round(BOOT.codeMtime),
    codeMtimeNow: Math.round(now),
    stale: BOOT.codeMtime > 0 && now > 0 && now - BOOT.codeMtime > 1,
  };
}

// ── 模型规格 / 三套大脑预设 / 智谱资源包 / 模型名册（搬去 `lib/models.js`）──────
// 这一节（原 `LOCAL_MODELS` … `providerOf`，约 500 行）整体搬去了 `lib/models.js`（B11b-2）。
// **为什么必须搬**：它里面的 `providerOf` / `isLocalBase` / `normalizeThinking` / `localKeyOf`
// 同时被主文件的 `usage` 计费段、`collectState`、`bridge` / `local` 控制段使用，
// 留在主文件就直接构成"放错层"的双向依赖（附 F.3 记的 `AGG ⇄ PKG` / `PKG ⇄ USAGE`）。

// 机器人自己写出来的「真正在用的配置」。面板靠它区分
// 「已保存且已生效」和「改了但还没被机器人读到」，避免用户误判切换成功。
// 配置回滚历史（B10b · O-CFGHIST）。config.json 被 gitignore，没有版本历史 ——
// 点错一次保存就无从回到上一版。这个文件是它唯一的"后悔药"。
// ⚠️ 里面存的是**全量**配置（含 API Key），靠 0600 + gitignore + 沙箱排除管住；
//    不能用脱敏器处理它 —— 那会让"撤销"把 Key 抹成空。详见 src/config-history.js。


// ── 进程 / 网络 / 内存工具（搬去 `lib/proc.js`）──────────────────────────
// 这一整节（原 `// ---------- 工具 ----------`：`sh` / `shBuffer` / `killTree` /
// `dockerDaemonUp` / `ensureDocker`）搬去了 `lib/proc.js`（B11b-2）。
// **为什么必须搬**：`killTree` / `pidAlive` / `portOpen` / `httpGet` 同时被
// `bridge` 控制段与 `local model` 控制段使用，留在主文件就构成"放错层"的双向依赖
// （附 F.3 记的 `BRIDGE ⇄ UTIL` / `LOCAL ⇄ UTIL`）。

// `localKeyOf()` 搬去 `lib/models.js`（B11b-2）—— 它由 `LOCAL_MODELS` 驱动，必须同模块。

// `sumRssKb` / `readMemory` / `portOpen` / `httpGet` / `httpJson` / `wsProbe`
// 搬去 `lib/proc.js`（B11b-2）—— 它们是同一类"与外部世界打交道"的底座。

// `configPath()` / `readConfig()` / `writeConfig()` 已搬到 `lib/config-io.js`（B11b-2）。
// 这里**故意不保留转发壳**（如 `const writeConfig = ...`）—— 壳会让"唯一所有者"
// 变成两个名字，而 `check-wb` 的契约只认一处实现；将来有人改壳不改本体就静默失效。

/**
 * 机器人「此刻真正在用的配置」。
 * bridge 进程自己写的，进程不在了就说明这份快照已经过期。
 * 面板所有"当前模式"的判断都必须以它为准，而不是以用户还没保存的输入框为准。
 */
function readEffective() {
  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(EFFECTIVE_FILE, 'utf8'));
  } catch {
    return null;
  }
  const alive = pidAlive(raw?.pid);
  return { ...raw, alive };
}

/**
 * 机器人是不是正在生成回复。
 * 本机模型一条要十几秒，没有这个提示用户只能干等。
 * 标记文件超过 3 分钟没更新就当过期（进程可能崩了，文件没来得及删）。
 */
function readThinking() {
  try {
    const j = JSON.parse(fs.readFileSync(THINKING_FILE, 'utf8'));
    // 判据只有一份，在 src/ephemeral.js（B10c · O-EPHEMERAL）——
    // 机器人侧"要不要留"与面板侧"信不信"共用它，不会各自漂移。
    if (thinkingIsLive(j, { isAlive: pidAlive })) return j;
  } catch {
    /* 没有就是没在生成 */
  }
  return null;
}

function napcatToken() {
  try {
    return fs.readFileSync(path.join(ROOT, 'napcat', '.webui_token'), 'utf8').trim();
  } catch {
    return '';
  }
}

// ---------- NapCat WebUI（换二维码要走它，OneBot 那边没有这个能力）----------

/**
 * 取 NapCat 的 WebUI token。
 *
 * 以**容器内**的 webui.json 为准：项目里的 .webui_token 只是当初 bootstrap 写下的，
 * 容器重建后 NapCat 可能自己换过 token（两边不一致时接口会返回 Unauthorized）。
 */
async function napcatWebuiToken() {
  const r = await sh(DOCKER, ['exec', 'napcat', 'sh', '-c',
    "grep -o '\"token\": *\"[^\"]*\"' /app/napcat/config/webui.json"], HTTP_TIMEOUT_MS);
  const m = (r.stdout || '').match(/"token":\s*"([^"]+)"/);
  return m ? m[1] : napcatToken();
}

/**
 * 换一张登录二维码。
 *
 * 为什么需要：面板上那张图读的是容器里的 `cache/qrcode.png`，而二维码约 2 分钟就失效。
 * 用户看到旧图去扫，QQ 只会回一句「登录失败」—— 看起来像功能坏了，其实只是码过期。
 * NapCat WebUI 的 `RefreshQRcode` 能**立刻**生成一张新的，代价是先换一次凭证：
 *   POST /api/auth/login { hash: sha256(token + ".napcat") } → Credential
 *   之后带 `Authorization: Bearer <Credential>` 调业务接口
 */
async function refreshNapcatQrcode() {
  const token = await napcatWebuiToken();
  if (!token) return { ok: false, msg: '读不到 NapCat 的 token —— 容器没在运行，换不了码' };

  const hash = createHash('sha256').update(token + '.napcat').digest('hex');
  const login = await httpJson(NAPCAT_WEBUI_PORT, '/api/auth/login', { body: { hash }, timeout: HTTP_TIMEOUT_MS });
  const cred = login.data?.data?.Credential || '';
  if (!cred) {
    const m = login.data?.message || `HTTP ${login.status}`;
    return {
      ok: false,
      msg: m === 'token is invalid'
        ? 'WebUI 凭证对不上（容器被重建过）—— 直接点「打开 QQ 登录页」手动换一张'
        : `NapCat 登录失败：${m}`,
    };
  }

  const r = await httpJson(NAPCAT_WEBUI_PORT, '/api/QQLogin/RefreshQRcode', {
    headers: { Authorization: `Bearer ${cred}` },
    timeout: 20000,
  });
  const j = r.data || {};
  if (j.code !== 0) {
    const m = String(j.message || '换码失败');
    return { ok: false, msg: /Logined/i.test(m) ? '这个号已经登录了，不需要再扫码' : m };
  }
  return { ok: true, qr: j.data?.qrcodeurl || '' };
}

/**
 * 容器的挂载源是否还指着当前项目目录；指错了就把「错的那个」返回，否则返回 false。
 *
 * 为什么需要：Docker 把 bind 的**绝对路径**存在容器里，`docker start` 会原样沿用。
 * 于是项目文件夹一旦改名/搬家，`docker start` 就会挂到那个**已不存在的旧路径**上 ——
 * Docker 不报错，而是静默新建空目录。表现是「OneBot 配置和 QQ 登录态全没了，
 * 怎么扫码都登录失败」。2026-09-17 真踩到过一次（qq-bot → QQ-BOT-Creative）。
 */
async function containerMountStale() {
  const r = await sh(DOCKER, ['inspect', 'napcat', '--format', '{{range .Mounts}}{{.Source}}{{"\\n"}}{{end}}'], 10000);
  if (!r.ok) return false;
  const srcs = (r.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean);
  if (!srcs.length) return false;
  const bad = srcs.filter((s) => !s.startsWith(ROOT + path.sep));
  return bad.length ? bad : false;
}

/**
 * 用 compose 重建容器，让挂载路径跟随当前项目目录。
 * 登录态与配置都在磁盘上（napcat/QQ、napcat/config），重建只是换掉容器的挂载指向。
 */
async function recreateNapcatContainer(say = () => {}) {
  say('… 容器挂在旧的项目路径上，正在用 compose 重建（登录态和配置在磁盘上，不会丢）');
  await sh(DOCKER, ['rm', '-f', 'napcat'], DOCKER_RM_TIMEOUT_MS);
  const r = await sh(DOCKER, ['compose', 'up', '-d'], DOCKER_COMPOSE_TIMEOUT_MS);
  say(r.ok ? '✔ 容器已重建，挂载指向当前项目目录' : `✗ 容器重建失败：${(r.stderr || '').slice(0, ERR_SNIPPET_CHARS)}`);
  return r.ok;
}

// ---------- 本地对话流（群消息 → 提示词 → 模型输出 → 发出去的段）----------
// bridge 每处理一条消息就往这个文件追一行。面板读最后几条显示，
// 让「本机模型的输出流转」看得见、可复盘 —— 尤其是它答得不好时，
// 可以直接看出是提示词太长、还是被 max_tokens 截断了、还是输出格式没按规矩来。
//
// ⚠️ 第 16 轮（H-10 第二半）：`TRACE_SHOWN` / `TRACE_AGGREGATE` / `readTrace`
//    已搬进 `lib/trace-io.js`（L1 · 只依赖 paths.js 的 TRACE_FILE）。
//    搬它的理由是**它不在下一轮要动的任何一块里，却是那三块的公共读盘口**——
//    不先把它沉掉，「拆主文件」就永远差一个前置件。

// ═══════════════════════════════════════════════════════════════════════
//  自定义工作台：下载 / 导出
// ═══════════════════════════════════════════════════════════════════════
/**
 * 组装一次导出的内容。
 *
 * 两条纪律：
 *  ① **不假装精确**。`prompt` 那一项里，真正逐字的完整提示词取自**最近一次真实调用**
 *     的记录（那才是事实）；工作台里填的东西作为"素材"单独列出，并写明它是素材。
 *     要是在这里自己拼一份"看起来像提示词"的文本，它迟早和 brain.js 里真实拼的漂移，
 *     用户拿着它去排错会被带偏 —— 这比不导出更糟。
 *  ② **API Key 一律清空**。导出文件是拿来保存/发给别人的，带上真 Key 等于泄露。
 *     用户要恢复时重新填一次即可（Key 只有十几个字符）。
 */
/**
 * 导入配置时**允许被覆盖**的工作台字段。
 *
 * 这份清单只有一个来源：前端通过 /api/state 的 customMeta.importableKeys 拿它，
 * 导入和"导入前预览"走的是同一个列表 —— 否则会出现"预览说会改 3 处、
 * 实际改了 5 处"，那比没有预览更误导人。
 *
 * 刻意**不在**里面的：模型、API Key、放行群号。那是"换一个大脑"的事，
 * 不该由一个叫「导入人格」的按钮顺手完成。
 */
const IMPORTABLE_KEYS = [
  'persona', 'enhance', 'personaResetOnChange', 'playRules', 'skills', 'replyStyle',
  'trigger', 'allowProactive', 'scenes', 'memory', 'safety',
];

/**
 * 两份配置对象之间的字段级差异（给人看的）。
 * 数组只报长度变化 —— 逐条比对数组内容会输出一大坨没人看得懂的 diff，
 * 而清单类字段的"多几条少几条"已经在 lists 那一栏单独说清楚了。
 */
function diffObject(before, after, path = '') {
  const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);
  const short = (v) => {
    const s = String(v ?? '');
    return s.length > DIFF_VALUE_MAX_CHARS ? s.slice(0, DIFF_VALUE_MAX_CHARS) + '…' : s;
  };
  const out = [];
  for (const [k, v] of Object.entries(after)) {
    const p = path ? `${path}.${k}` : k;
    const a = before?.[k];
    if (Array.isArray(v)) {
      const n0 = Array.isArray(a) ? a.length : 0;
      if (JSON.stringify(a) !== JSON.stringify(v)) out.push({ path: p, from: `${n0} 项`, to: `${v.length} 项` });
    } else if (isObj(v)) {
      out.push(...diffObject(a, v, p));
    } else if (String(a ?? '') !== String(v ?? '')) {
      out.push({ path: p, from: short(a), to: short(v) });
    }
  }
  return out;
}

// ---------- 用量与花费（第 22 轮 · H-10：实现搬进 lib/usage-report.js）----------
// 依赖全部**注入**（理由见新家文件头）：它们各自在别处还有调用点，
// 而 `panel/lib` 引 `src/` 要走白名单 —— 注入比开白名单更不容易被后人放开。
const usage = makeUsageReport({
  USAGE_DIR, USAGE_FILE_RE, MODEL_LABELS, CREDIT_CLOUD_MODELS,
  isZhipuModel, isLocalBase, dayKeyOf, USAGE_SOURCES,
});
const { listUsageFiles, readUsage, resetUsageCache } = usage;

// 「导出当前配置」的实现已搬进 `lib/export-bundle.js`（第 19 轮 · H-10 第二半）。
// 它没有任何 `server.js` 顶层依赖，所以这里不需要注入 —— 只留一次工厂调用。
const buildExport = makeExportBundle();


/**
 * 问一下官方还剩多少钱。
 * 余额要以「机器人真正在用的地址」为准：没在跑就退回配置文件里的，
 * 并且顺带告诉前端当前到底是本机还是云端，省得前端再猜一次。
 */
async function fetchBalance() {
  const cfg = readConfig();
  const eff = readEffective();
  const key = cfg?.llm?.apiKey || '';
  // 机器人跑着就用它实际在用的地址，没跑才看配置文件
  const base = (eff?.alive && eff.baseUrl ? eff.baseUrl : '') || cfg?.llm?.baseUrl || '';
  const local = isLocalBase(base);
  if (local) {
    return { ok: false, local: true, error: '本机模型不花钱，没有余额这回事' };
  }
  if (!key) return { ok: false, local: false, error: '没配置 API Key' };
  if (providerOf(base) !== 'deepseek') {
    return { ok: false, local: false, error: '当前不是 DeepSeek 云端，查不了余额' };
  }
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), HTTP_TIMEOUT_MS);
    const res = await fetch('https://api.deepseek.com/user/balance', {
      headers: { Authorization: `Bearer ${key}` },
      signal: ac.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const j = await res.json();
    const info = j?.balance_infos?.[0] || {};
    return {
      ok: true,
      currency: info.currency || 'CNY',
      total: Number(info.total_balance ?? 0),
      toppedUp: Number(info.topped_up_balance ?? 0),
      granted: Number(info.granted_balance ?? 0),
      available: j?.is_available !== false,
    };
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? '请求超时' : e.message };
  }
}

// ---------- 状态聚合 ----------

/**
 * 结构化记忆的下发形状（ATI-5 · 面板记忆页）。
 *
 * 只做**投影**：磁盘上那条记录是什么样，页面就该看到什么 —— 不在这里补默认值、
 * 不在这里算"该不该注入"（那是 `selectForPrompt` 的事，判据在叶子里）。
 * 唯一一处加工是把 `activationOf` 算成 0~1 的两位小数：它是**排序权重**，
 * 不写出来用户就看不懂"这条为什么排在后面"。
 *
 * ⚠️ 下发 ≠ 复证。把它展示给用户看**不算**新的独立观察，
 *    `samples` 一个都不加 —— 判据在 `memory-record.js` 顶部写着。
 *    这一行注释是给下一个人的：**别在这里顺手 `samples + 1`**。
 */
function memoryRecordsOf(now = Date.now()) {
  return readRecords().map((r) => ({
    id: r.id,
    kind: r.kind,
    kindShort: kindShort(r.kind),
    text: r.text,
    detail: r.detail || '',
    // 依据里带没带**模型的推测**（"暗示 / 可能 / 推测…"）。页面据此把语气标出来 ——
    // 判据在叶子里（确定性词表），页面不自己写关键词。
    inferred: looksInferred(r.detail || ''),
    status: r.status,
    samples: r.samples,
    firstSeenAt: r.firstSeenAt || 0,
    lastSeenAt: r.lastSeenAt || r.firstSeenAt || 0,
    chatKey: r.provenance?.chatKey || '',
    // ⚠️ 这两栏语义完全不同，页面要分开用（D-M1）：
    //   `userId`     = **发消息的人**（溯源：这是谁说的事）
    //   `subjectName`= **这条记忆关于谁**（渲染与判重都读它）
    // 改造前只有一个 userId，于是页面（和提示词）都把发送者当成了主语。
    userId: r.provenance?.userId || '',
    subjectId: r.provenance?.subjectId || '',
    subjectName: r.provenance?.subjectName || '',
    // 人工复核痕迹（没有就 null）。页面靠它区分"这是我自己点的"与"它自己升上来的"
    review: r.review ? { action: r.review.action, at: r.review.at } : null,
    activation: Math.round(activationOf(r, now) * 100) / 100,
  }));
}

// docker / 内存 的秒级缓存与它们的读函数搬去 `lib/proc.js`（B11b-2）。
// ⚠️ 三个缓存变量是 **module-level `let`**，只有这三个读函数会给它们赋值 ——
//    搬走前逐条 grep 过"有没有被别处赋值"（B11b-1 就是栽在"let 被别处赋值"上，
//    ESM 的 import 绑定只读，赋值会当场 TypeError）。这里 5 处赋值全在本节内。
// 「面板状态」聚合已搬进 `lib/state-collector.js`（第 19 轮 · H-10 第二半）。
// 那十一个判据由主文件注入 —— 它们各自在别处还有调用点，搬进 lib 会变成两份实现。
// ⚠️ `readUsage` / `countBridgeInstances` 持有三个模块级缓存，而那缓存**被本函数之外**的
//    `apiUsageReset` / `invalidateBridgeInstances` 赋值 —— 注入这两个函数（而不是搬它们）
//    就让缓存永远留在同一个模块里，块外赋值的语义一字不变。
const collectState = makeStateCollector({
  IMPORTABLE_KEYS, bridgeRunning, countBridgeInstances, memoryRecordsOf,
  napcatToken, panelInfo, readBridgeLock, readDebugFlag, readEffective,
  readThinking, readUsage,
});

// `buildModelCaps()` / `normalizeThinking()` 搬去 `lib/models.js`（B11b-2）。
// 理由是同一类：`normalizeThinking` 被配置读写与能力表两侧使用，属"判定"，应由 models 持有。

// ---------- 桥接进程 ----------
// 机器人日志走文件而不是管道：管道挂在控制台上，控制台一退管道就断，
// 子进程写 stdout 会 EPIPE 崩掉，"接管"就成了空话。
// 详细日志：开了之后桥接层会把「为什么跳过这条消息」也打出来

function readDebugFlag() {
  try {
    return fs.readFileSync(DEBUG_FLAG, 'utf8').trim() === '1';
  } catch {
    return false;
  }
}

function writeDebugFlag(on) {
  try {
    if (on) fs.writeFileSync(DEBUG_FLAG, '1');
    else fs.unlinkSync(DEBUG_FLAG);
  } catch { /* 无所谓 */ }
}

// `pidAlive()` 搬去 `lib/proc.js`（B11b-2）—— 极纯的小函数，被 bridge / local /
// ephemeral 读侧共用，属于最底层工具。

/** 造一个「跟着文件长」的日志搬运工 */
function makeTailer(file) {
  let pos = 0;
  return function tail() {
    let st;
    try {
      st = fs.statSync(file);
    } catch {
      return;
    }
    if (st.size < pos) pos = 0; // 日志被重写过，从头来
    if (st.size === pos) return;

    let fh;
    try {
      fh = fs.openSync(file, 'r');
      const len = st.size - pos;
      const buf = Buffer.alloc(len);
      const read = fs.readSync(fh, buf, 0, len, pos);
      pos += read;
      const text = buf.subarray(0, read).toString('utf8').replace(/\n+$/, '');
      if (text) pushLog(text);
    } catch {
      /* 读不到就算了，下一轮再试 */
    } finally {
      if (fh !== undefined) {
        try { fs.closeSync(fh); } catch {}
      }
    }
  };
}

const tailBridgeLog = makeTailer(BRIDGE_LOG);
const tailLocalLog = makeTailer(LOCAL_LOG);
setInterval(() => {
  tailBridgeLog();
  tailLocalLog();
}, 700);

/**
 * 扫出系统里在跑的机器人进程（排除自己）。
 *
 * pidfile 只记录"我们启动的那一个"。控制台被强杀、或 pidfile 没来得及写时，
 * 旧进程还活着但 pidfile 已经不可信 —— 这时再点"启动"就会起出第二个实例，
 * **两个实例都订阅 OneBot，同一条群消息会被回复两次**。
 * 所以凡是要判断"到底有没有在跑"，都得落到系统进程上，不能只看 pidfile。
 */
async function findBridgeProcesses(exceptPids = []) {
  // ⚠️ pgrep 在这里**只用来提名候选** —— 判定全部交给 isOurBridge()，本函数返回什么，
  //    就等于"哪些 pid 会被 killTree 掉"，所以提名必须**宁可宽**。
  //
  // ⚠️ 第 7 轮修过一次真机事故：原来是 `pgrep -fl 'node src/index.js'` ——
  //    那是一个**字面量**，要求命令行里正好有 "node src/index.js" 这串。
  //    而真机 argv 是 `…/bin/node --max-old-space-size=384 src/index.js`，
  //    **那段字面量根本不存在** → pgrep 返回空 → 一个残留都清不掉 →
  //    每"结束→启动"一次就多挂一个实例（实测 4 个）。
  //    现在改成按**入口文件名**提名：任何命令行里提到 `src/index.js` 的进程都会被提，
  //    再由 isOurBridge() 用"exec 是 node + 入口收尾 + cwd 是本仓"三条把它筛掉。
  //    这样参数怎么排都拦得住，而"杀错一个"的防线**一点没松**（它本来就不在提名这一步）。
  const r = await sh(PGREP, [...PGREP_LIST_FLAGS, 'src/index\\.js'], 4000);
  const out = [];
  for (const line of (r.stdout || '').split('\n')) {
    const hit = parsePgrepLine(line);
    if (!hit || hit.pid === process.pid || exceptPids.includes(hit.pid)) continue;

    const [cwdHit, execHit] = await Promise.all([
      sh(LSOF, ['-a', '-p', String(hit.pid), '-d', 'cwd', '-Fn'], 4000),
      sh(LSOF, ['-a', '-p', String(hit.pid), '-d', 'txt', '-Fn'], 4000),
    ]);
    const verdict = isOurBridge({
      cmd: hit.cmd,
      cwd: firstPathOf(cwdHit.stdout),
      execPath: firstPathOf(execHit.stdout),
      root: ROOT,
    });
    if (verdict.ours) { out.push(hit.pid); continue; }
    // 跳过的也要说一句 —— 否则"我以为它该被清理、它没动"又会变成一个静默失效
    pushLog(`· 不做清理：pid ${hit.pid} 命令行里提到 src/index.js，但核验未过（${verdict.reason}）—— 不是本项目的机器人`);
  }
  return out;
}

/** 控制台重启后，认领之前留下的机器人进程，避免重复启动出两个 */
async function adoptExistingBridge() {
  // 沙箱里绝不接管宿主机上的真实机器人：一旦接管就会把真 pid 写进自己的 .bridge.pid，
  // 收尾时 stop() 按那个 pid 一杀，真机器人就被误杀了（2026-09-19 事故实录）。
  if (SANDBOX) { pushLog('· 沙箱模式：不接管任何真实机器人进程'); return; }
  if (state.bridge) return;

  let pid = 0;
  try {
    pid = Number.parseInt(fs.readFileSync(PIDFILE, 'utf8').trim(), 10);
  } catch { /* 没有 pid 文件就是没跑过 */ }

  if (pidAlive(pid) && pid !== process.pid) {
    state.bridgePid = pid;
    pushLog(`↻ 接管已在运行的机器人 (pid ${pid})`);
    return;
  }

  // pidfile 不可信 —— 直接问系统
  const strays = await findBridgeProcesses([pid]);
  if (strays.length) {
    state.bridgePid = strays[0];
    try { fs.writeFileSync(PIDFILE, String(strays[0])); } catch { /* 无所谓 */ }
    pushLog(`↻ 接管已在运行的机器人 (pid ${strays[0]})`);
    if (strays.length > 1) {
      pushLog(`⚠ 发现 ${strays.length} 个机器人进程同时在跑（${strays.join(', ')}），建议点「停止机器人」再重新启动，只留一个`);
    }
  } else if (pid) {
    try { fs.unlinkSync(PIDFILE); } catch { /* 无所谓 */ }
  }
}

/**
 * 读机器人进程侧的实例锁（D19）—— **只读，永不写、永不删**。
 *
 * 三个刻意的取舍：
 *   ① 解析用 `src/bridge-lock.js` 的 `parseLock`（"锁长什么样"只有那一处实现）——
 *      面板自己 `JSON.parse` 一遍就等于"格式有两份"，某天加了字段就会两边不一致；
 *   ② 读不到 / 坏 JSON → `null`（页面按"没有锁"处理）。一个可选文件的读数失败
 *      不该让 `/api/state` 500；
 *   ③ **不做"要不要接管"的判断** —— 那是机器人启动时才该做的决定，
 *      面板在这里判一次就会多出第二套"心跳多旧算陈旧"。
 */
function readBridgeLock() {
  try {
    const lock = parseLock(fs.readFileSync(BRIDGE_LOCK_FILE, 'utf8'));
    return lock ? { pid: lock.pid, at: lock.at, beatAt: lock.beatAt } : null;
  } catch {
    return null;
  }
}

function bridgeRunning() {
  return !!(state.bridge || (state.bridgePid && pidAlive(state.bridgePid)));
}

/**
 * 「现在系统里有几个机器人实例」—— 给页面看的数字，也是"多实例"这件事**唯一能被看见的地方**。
 *
 * 为什么需要它：这个缺陷（第 7 轮修的）在面板上**完全隐形** ——
 * 页面照样显示"机器人运行中 pid 67750"，而实际上还挂着 3 个孤儿在抢同一条群消息。
 * 用户唯一的线索是"它怎么回了两遍"。把实例数摆到明面上，这件事才有入口。
 *
 * ⚠️ 三个约束：
 *   ① 真扫一次是 pgrep + 每个候选两次 lsof，**不能每 3 秒来一遍**（面板轮询 /api/state）
 *      → 15 秒 TTL 缓存，与 `extensionsOf` 同一量级；start/stop 之后强制失效。
 *   ② **永不抛**：扫不出来就返回 null，页面按"未知"处理 —— 一个读数的失败不该让 /api/state 500。
 *   ③ 沙箱里返回 null：那里不该去数宿主机上的真机器人（与 adoptExistingBridge 同一条纪律）。
 */
let bridgeInstCache = { at: 0, n: null };
function invalidateBridgeInstances() {
  bridgeInstCache = { at: 0, n: null };
}
async function countBridgeInstances(maxAgeMs = 15000) {
  if (SANDBOX) return null;
  const now = Date.now();
  if (bridgeInstCache.n !== null && now - bridgeInstCache.at < maxAgeMs) return bridgeInstCache.n;
  let n = null;
  try {
    n = (await findBridgeProcesses([])).length;
  } catch {
    n = null; // 扫不动就报"未知"，不猜
  }
  bridgeInstCache = { at: now, n };
  return n;
}

/**
 * 机器人进程的 V8 老生代上限（MB）。
 *
 * ⚠️ **如实定性：这是「封顶」，不是「省内存」。**
 *    实测机器人 RSS 只有 46 MB，加了这个参数之后它**不会变小** —— 它做的是把上界从
 *    Node 的默认值（这台 16 GB 机器上约 2 GB）压下来，让"某天某个缓存悄悄无界增长"
 *    这类事故以**明确的 OOM + 看门狗拉起**收场，而不是慢慢把整台机器拖死。
 *
 * 384 是**经验值，非官方阈值**：取当时实测 RSS 的 8 倍余量（46 MB → 384 MB），
 * 留得足够宽，正常波动不会被误伤。
 * 本机模型是**独立进程**，不吃这个额度（模型那份内存在 MLX/QwenChat 侧）。
 */
const BRIDGE_MAX_OLD_SPACE_MB = 384;

async function startBridge() {
  // 沙箱里任何「启动机器人」的入口（一键启动 / /api/bridge/start / 调试重启）一律禁掉，
  // 免得拉起一个连着真实 QQ 的假机器人，在群里重复刷屏。
  if (SANDBOX) return { ok: false, msg: '沙箱模式：禁止启动真实机器人' };
  if (bridgeRunning()) {
    return { ok: false, msg: `机器人已经在运行了（pid ${state.bridge?.pid || state.bridgePid}）` };
  }

  // 启动前扫一遍系统里的孤儿进程。
  // 只看 pidfile 是不够的：pidfile 丢了而旧进程还活着时，会起出第二个实例，
  // 两个实例都订阅 OneBot → 同一条群消息被回复两次。
  const strays = await findBridgeProcesses([state.bridge?.pid, state.bridgePid].filter(Boolean));
  if (strays.length) {
    pushLog(`· 发现 ${strays.length} 个残留的机器人进程（${strays.join(', ')}），先清理掉`);
    for (const pid of strays) await killTree(pid, 2000);
    await new Promise((s) => setTimeout(s, 500));
    invalidateBridgeInstances();
  }

  let fd;
  try {
    fd = fs.openSync(BRIDGE_LOG, 'w'); // 每次启动清空，日志清爽
  } catch (e) {
    return { ok: false, msg: `写不了日志文件：${e.message}` };
  }

  let child;
  try {
    child = spawn(NODE, [`--max-old-space-size=${BRIDGE_MAX_OLD_SPACE_MB}`, 'src/index.js'], {
      cwd: ROOT,
      detached: true, // 脱离控制台，控制台关掉了它也能活
      env: {
        ...process.env,
        FORCE_COLOR: '0',
        QQBOT_LOG_LEVEL: readDebugFlag() ? 'debug' : 'info',
      },
      stdio: ['ignore', fd, fd],
    });
  } catch (e) {
    try { fs.closeSync(fd); } catch { /* 无所谓 */ }
    return { ok: false, msg: `启动机器人失败：${e.message}` };
  }
  try { fs.closeSync(fd); } catch {}

  child.unref(); // 不再吊着控制台的事件循环

  state.bridge = child;
  state.bridgePid = child.pid;
  state.bridgeStartedAt = Date.now();
  state.lastExit = null;
  invalidateBridgeInstances(); // 刚起了一个，让页面下一轮就报准数
  // L-06（2026-10-05 · 第 12 轮 · 开源前审查）：这一处空 catch **不是**清理惯用法。
  // 写在盘上的 pid 是面板**下次启动**时 `adoptExistingBridge()` 唯一的接管线索；
  // 写不进去的后果是"下次开面板说机器人没在运行"（而它其实正在群里说话），
  // 用户会再去点一次「启动」——于是同一个机器人被起出两份。**失败有后果，所以留痕。**
  // ⚠️ 日志正文里不写绝对路径（pushLog 的内容会经 `/api/logs` 下发），只说相对名。
  try { fs.writeFileSync(PIDFILE, String(child.pid)); }
  catch (e) { pushLog(`⚠️ 写 panel/.bridge.pid 失败（${e.code || e.message}）—— 面板重启后可能接管不到这个机器人`); }
  pushLog(`▶ 启动机器人 (pid ${child.pid})`);

  child.on('exit', (code, sig) => {
    pushLog(`■ 机器人已退出 (code=${code} signal=${sig || '-'})`);
    state.lastExit = { code, signal: sig, at: Date.now() };
    state.bridge = null;
    state.bridgePid = null;
    try { fs.unlinkSync(PIDFILE); } catch {}
  });
  child.on('error', (e) => {
    pushLog(`✗ 启动失败: ${e.message}`);
    state.bridge = null;
    state.bridgePid = null;
    try { fs.unlinkSync(PIDFILE); } catch {}
  });

  return { ok: true, msg: `已启动，pid ${child.pid}` };
}

/**
 * 停机器人。之前只是"发个信号就返回"，进程其实可能还活着并在群里说话，
 * 用户以为停了其实没停。这里改成等到进程确认消失才返回。
 */
async function stopBridge() {
  // 沙箱里没有任何「自己的」机器人（不接管也不启动），所以绝不该去杀任何进程。
  if (SANDBOX) return { ok: false, msg: '沙箱模式：不触碰任何机器人进程' };

  // ⚠️ 第 7 轮的要点：这里**不许只看 pid 记录**。
  //    原来只清 `state.bridge?.pid || state.bridgePid` 那一个 —— 而多实例恰恰就是
  //    "pid 记录里只有一个、系统里挂着好几个"这种形态，于是点一次「停止」只杀掉一个，
  //    剩下的继续抢同一条群消息，用户以为已经停干净了。
  //    判据与「启动前清场」共用同一套 findBridgeProcesses()（提名宽、核验严），
  //    **本文件里第二次出现进程识别的地方一处都没有**。
  const tracked = [state.bridge?.pid, state.bridgePid].filter(Boolean);
  const all = [...new Set([...tracked, ...(await findBridgeProcesses([]))])].filter((p) => pidAlive(p));

  if (!all.length) {
    state.bridge = null;
    state.bridgePid = null;
    try { fs.unlinkSync(PIDFILE); } catch { /* 本来就没有 */ }
    invalidateBridgeInstances();
    return { ok: false, msg: '机器人没在运行' };
  }

  // 并行收：killTree 自带 TERM →（等 grace）→ KILL，串行做会变成"点一次停止等 3 秒 × N"。
  await Promise.all(all.map((p) => killTree(p, KILL_GRACE_MS)));
  for (let i = 0; i < 20 && all.some((p) => pidAlive(p)); i += 1) {
    await new Promise((s) => setTimeout(s, 300));
  }
  const left = all.filter((p) => pidAlive(p));

  state.bridge = null;
  state.bridgePid = null;
  try { fs.unlinkSync(PIDFILE); } catch { /* 无所谓 */ }
  invalidateBridgeInstances();

  if (left.length) {
    return { ok: false, msg: `停止信号已发，但 ${left.join(', ')} 仍在，可能需要强制结束` };
  }
  return {
    ok: true,
    // 如实报数：清掉 1 个和清掉 4 个是两件事，藏起来就等于把这次事故又变成隐形的
    msg: all.length > 1
      ? `机器人已停止（共清掉 ${all.length} 个实例：${all.join(', ')}）`
      : `机器人已停止（pid ${all[0]}）`,
  };
}

// ---------- 本地模型服务 ----------

/** 找出占着某个端口的进程并杀掉（处理上次没退干净的僵尸） */
async function freePort(port) {
  const r = await sh(LSOF, ['-nP', '-ti', `tcp:${port}`], 6000);
  const pids = r.stdout.split('\n').map((s) => Number.parseInt(s.trim(), 10)).filter(Number.isFinite);
  for (const pid of pids) {
    if (pid === process.pid) continue;
    try { process.kill(pid, 'SIGTERM'); } catch {}
  }
  if (pids.length) {
    pushLog(`· 清掉占用 ${port} 端口的旧进程 ×${pids.length}`);
    await new Promise((s) => setTimeout(s, PORT_RELEASE_WAIT_MS));
    for (const pid of pids) {
      if (pidAlive(pid)) {
        try { process.kill(pid, 'SIGKILL'); } catch {}
      }
    }
  }
  return pids.length;
}

// `waitFor()` 搬去 `lib/proc.js`（B11b-2）—— 通用轮询工具，被本机模型控制的
// 三个阶段（等加载 / 等生效 / 等端口）共用。

/** 等本机模型加载完（首次要 20–60 秒）。channel 决定等哪条通道的端口。 */
function waitLocalReady(timeoutMs = MODEL_READY_TIMEOUT_MS, channel = 'mlx') {
  const port = LOCAL_CHANNELS[localChannelOf(channel)].port;
  return waitFor(async () => (await httpGet(port, '/v1/models', 1500)).ok, timeoutMs, 1500);
}

/**
 * 预热本机模型：加载完先发一条极短的请求。
 * 第一次真实推理要额外做 Metal 内核准备和显存分配，
 * 不预热的话，用户进群后发的**第一条**消息会莫名干等很久。
 */
async function warmupLocal(channel = 'mlx') {
  const port = LOCAL_CHANNELS[localChannelOf(channel)].port;
  try {
    const r = await httpGet(port, '/v1/models', 2000);
    if (!r.ok) return false;
    const id = (JSON.parse(r.body)?.data || [])[0]?.id;
    if (!id) return false;

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), MODEL_REQUEST_ABORT_MS);
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: id,
        messages: [{ role: 'user', content: '你好' }],
        max_tokens: 8,
        stream: false,
      }),
      signal: ac.signal,
    });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * 比较两个接口地址是否相同 —— **必须忽略尾斜杠**。
 *
 * 配置里写的是 `https://open.bigmodel.cn/api/paas/v4/`（智谱文档要求带斜杠），
 * 而 bridge 内部 loadConfig 会把它 normalize 成不带斜杠的版本再写进 effective.json。
 * 直接字符串比较永远不相等 → 面板一直显示"待同步"、
 * /api/switch 的 applied 也永远返回 false（之前那个"切了却没生效"的误判就是它）。
 */
function sameUrl(a, b) {
  const norm = (u) => String(u || '').replace(/\/+$/, '');
  return norm(a) === norm(b);
}

/**
 * 等机器人把新配置真正读进去（热重载约 1 秒）。
 *
 * 不等待的后果很具体：保存完立刻返回，前端马上刷新状态，
 * 读到的还是机器人那边的旧值，于是把用户刚点选的单选按钮又戳回原样。
 * 用户看到"没反应"就会再点，直到某次刷新恰好赶在热重载之后才成功
 * —— 这就是「要点两三下」的由来。
 */
async function waitEffectiveApplied(cfg, timeoutMs = 12000) {
  if (!bridgeRunning()) return false;
  const mode = cfg.llm.thinking?.mode ?? cfg.llm.thinking ?? 'auto';
  const level = cfg.llm.thinking?.level ?? 'medium';
  return waitFor(() => {
    const e = readEffective();
    return !!(
      e?.alive &&
      sameUrl(e.baseUrl, cfg.llm.baseUrl) &&
      e.model === cfg.llm.model &&
      (e.thinking?.mode ?? 'auto') === mode &&
      (e.thinking?.level ?? 'medium') === level
    );
  }, timeoutMs, 300);
}

/** 收掉占着某条本地通道端口的进程，并等到端口真的空出来 */
async function stopLocalByPort(channel = 'mlx') {
  const port = LOCAL_CHANNELS[localChannelOf(channel)].port;
  await freePort(port);
  for (let i = 0; i < 20; i += 1) {
    if (!(await portOpen(port))) return true;
    await new Promise((s) => setTimeout(s, 500));
  }
  return !(await portOpen(port));
}

/**
 * 一个通道该不该被我们收掉。
 *
 * MLX 通道（:8080）是本项目专属端口 → 谁占着都是我们的事，直接收。
 * QwenChat 通道（:8765）不一样：它是用户自己也会双击打开来聊天的界面。
 * 如果那是一个用户手动开的、跟本次机器人运行无关的实例，就不能动手 ——
 * 否则会出现「切个大脑，我正在聊的窗口被关了」这种莫名其妙的体验。
 * 只有「本次运行是控制台拉起来的」才收。
 */
function mayStopChannel(name) {
  if (name === 'qwenchat') return state.localChannel === 'qwenchat';
  return true;
}

/**
 * 两条通道互斥：启动一条之前，先把另一条收掉。
 *
 * 这是硬约束，不是洁癖：模型文件是同一份，两条通道各自加载一份进内存。
 * 4B 一份 2.9GB，两份就 5.8GB —— 16GB 的机器会连带把 Docker 一起挤死
 * （历史上就是这么"容器凭空消失"的）。
 */
async function stopOtherLocalChannels(keep, say) {
  for (const [name, c] of Object.entries(LOCAL_CHANNELS)) {
    if (name === keep) continue;
    if (!(await portOpen(c.port))) continue;
    if (!mayStopChannel(name)) {
      if (say) {
        say(`⚠ ${c.label} 正在运行（:${c.port}），但它是你自己打开的、不是本次运行拉起的，` +
          `所以没动它 —— 注意它和即将启动的模型会各占一份内存`);
      }
      continue;
    }
    if (say) say(`· 先收掉另一条本机通道（${c.label}）—— 两条同时开会各占一份模型内存`);
    await stopLocalByPort(name);
  }
}

/** 不管模型跑在哪条通道上，能收的都收掉 */
async function stopAnyLocalModel(say) {
  let stopped = false;
  for (const [name, c] of Object.entries(LOCAL_CHANNELS)) {
    if (!(await portOpen(c.port))) continue;
    if (!mayStopChannel(name)) {
      if (say) say(`· ${c.label}（:${c.port}）是你自己开着的，保留不动`);
      continue;
    }
    const r = await stopLocalModel(name);
    if (say && r.ok) say(`✔ 已关掉本机模型（${c.label}），释放内存`);
    stopped = stopped || r.ok;
  }
  state.localModel = null;
  state.localModelKey = '';
  state.localChannel = '';
  return stopped;
}

/**
 * 启动本机模型。同一时刻只允许「一个规格 + 一条通道」存在：
 * 同一时刻只留一个规格 + 一条通道 —— 否则内存直接翻倍。
 *
 * @param {string} key 规格（见 LOCAL_MODELS）
 * @param {'mlx'|'qwenchat'} [channel] 推理通道，默认 mlx（老行为）
 * @param {(m:string)=>void} [onSay] 想把进度也显示到面板的「切换步骤」里就传它
 */
async function startLocalModel(key, channel, onSay) {
  const ch = localChannelOf(channel);
  const port = LOCAL_CHANNELS[ch].port;
  const k = resolveLocalKey(key);

  if (!localModelExists(k)) {
    return {
      ok: false,
      msg: `本机模型目录不存在：${LOCAL_MODELS[k]?.path || '(未配置)'}` +
        ` —— 请把模型放回 ~/models 下，或改用云端大脑`,
    };
  }
  if (ch === 'mlx' && !fs.existsSync(QWEN_SERVER)) {
    return { ok: false, msg: `找不到本地模型启动脚本：${QWEN_SERVER}` };
  }
  if (ch === 'qwenchat' && !fs.existsSync(QWENCHAT_SERVER)) {
    return { ok: false, msg: `找不到 QwenChat 服务程序：${QWENCHAT_SERVER}` };
  }

  // 另一条通道在跑就先收掉（互斥，见 stopOtherLocalChannels 的说明）。
  // 警告类信息同时写日志和面板步骤 —— 「内存会翻倍」这种事必须让用户看见。
  const tell = (m, toSteps = false) => {
    pushLog(m);
    if (toSteps && onSay) onSay(m);
  };
  await stopOtherLocalChannels(ch, (m) => tell(m, true));

  // 本通道端口上已经有服务：同一个规格就别重复起，是另一个就先关掉
  const alive = await httpGet(port, '/v1/models', 2000);
  if (alive.ok) {
    let curKey = state.localChannel === ch ? state.localModelKey : '';
    if (!curKey) {
      try {
        const ids = (JSON.parse(alive.body)?.data || []).map((m) => m.id);
        curKey = localKeyOf(ids[0]);
      } catch { /* 解析不出来就当未知 */ }
    }
    if (curKey === k) {
      // 只记「现在跑的是哪个规格」，**不认领**这个进程：它是之前就在跑的
      // （多半是用户自己双击 QwenChat 打开的）。state.localChannel 的语义是
      // 「这个进程是本次运行由控制台拉起来的」，只有那种才允许被自动收掉。
      state.localModelKey = k;
      return { ok: true, msg: `${k.toUpperCase()} 已经在运行了`, already: true };
    }
    pushLog(`· 切换本机模型 ${(curKey || '未知').toUpperCase()} → ${k.toUpperCase()}，先停掉旧的`);
    state.localModel = null;
    state.localModelKey = '';
    state.localChannel = '';
    await stopLocalByPort(ch);
  } else if (state.localModel && state.localChannel === ch) {
    return { ok: false, msg: '本机模型正在加载中，请稍等' };
  } else {
    // 端口被占但连不上 = 上次的僵尸，先清掉
    await freePort(port);
  }

  // 走到这里说明「本通道上没有可复用的模型，准备新起一个」。
  // 起之前再看一眼另一条通道：如果那边有一份模型是**用户自己开的**（我们无权收掉），
  // 就不要再起第二份 —— 4B 一份 2.9GB，两份就是 5.8GB，16GB 的机器会立刻开始交换，
  // 连带把 Docker 挤死（历史上就是这么"容器凭空消失"的）。
  // 这种情况**拒绝并说清怎么选**，比闷头起两份、事后让用户去查内存要好。
  for (const [name, c] of Object.entries(LOCAL_CHANNELS)) {
    if (name === ch) continue;
    if (!(await portOpen(c.port))) continue;
    if (mayStopChannel(name)) continue; // 是我们自己起的，stopOtherLocalChannels 已经收掉了
    return {
      ok: false,
      msg:
        `${c.label}（:${c.port}）上已经跑着一份模型，而且它不是本次运行拉起的，我不会去关它。` +
        `再启动 ${LOCAL_CHANNELS[ch].label} 会同时加载两份、白占约 3 GB 内存。` +
        `两个办法：把「推理通道」改成 ${c.label} 直接复用它，或者先把它关掉再启动。`,
    };
  }

  let fd;
  try {
    fd = fs.openSync(LOCAL_LOG, 'w');
  } catch (e) {
    return { ok: false, msg: `写不了日志文件：${e.message}` };
  }

  let cmd;
  let args;
  if (ch === 'qwenchat') {
    if (!fs.existsSync(MLX_PY)) {
      try { fs.closeSync(fd); } catch { /* 无所谓 */ }
      return { ok: false, msg: `找不到 Python 环境：${MLX_PY}` };
    }
    cmd = MLX_PY;
    args = [QWENCHAT_SERVER, String(port)];
  } else {
    // MLX 通道的思考开关是服务端启动参数，启动时就带上，
    // 这样即使请求级参数不生效，行为也和界面上选的一致。
    cmd = QWEN_SERVER;
    args = ['--model', k];
    try {
      const cfg = readConfig();
      if ((cfg?.llm?.thinking?.mode ?? cfg?.llm?.thinking) === 'on') args.push('--think');
    } catch { /* 读不到就按默认 */ }
  }

  let child;
  try {
    // QWENCHAT_OPEN 故意不设：不要让它自己弹浏览器窗口，这里是后台服务
    const env = { ...process.env };
    delete env.QWENCHAT_OPEN;
    child = spawn(cmd, args, {
      cwd: path.join(HOME, 'models'),
      detached: true,
      stdio: ['ignore', fd, fd],
      env,
    });
  } catch (e) {
    try { fs.closeSync(fd); } catch { /* 无所谓 */ }
    return { ok: false, msg: `启动本机模型失败：${e.message}` };
  }
  try { fs.closeSync(fd); } catch {}
  child.unref();

  state.localModel = child;
  state.localModelKey = k;
  state.localChannel = ch;
  pushLog(
    `▶ 启动本机模型 ${k.toUpperCase()}（通道：${LOCAL_CHANNELS[ch].label}）` +
      `${ch === 'mlx' && args.includes('--think') ? '（思考开）' : ''}（首次加载要等 20–60 秒）`
  );

  child.on('exit', (code) => {
    pushLog(`■ 本机模型已退出 (code=${code})`);
    state.localModel = null;
    state.localModelKey = '';
    state.localChannel = '';
  });
  child.on('error', (e) => {
    pushLog(`✗ 本机模型启动失败: ${e.message}`);
    state.localModel = null;
    state.localModelKey = '';
    state.localChannel = '';
  });

  // QwenChat 通道起来后，把它切到用户选的那个规格（它默认加载的是 DEFAULT 里那个）。
  // 这一步失败不影响使用（默认模型照样能聊），只如实记一笔。
  if (ch === 'qwenchat') {
    setTimeout(async () => {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/api/load`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: k }),
          // 与本文件其余 fetch（1223 / 1943 / 3350）同款：Node 的fetch 只有
          // body idle 超时，没有整体超时 —— 端口被占但服务不响应时这个 promise 会永久挂着。
          signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
        });
        pushLog(r.ok ? `· QwenChat 通道已切到 ${k.toUpperCase()}` : `· QwenChat 切换规格失败（HTTP ${r.status}）`);
      } catch (e) {
        pushLog(`· QwenChat 切换规格失败：${e.message}`);
      }
    }, 2000);
  }

  return { ok: true, msg: `正在加载 ${k.toUpperCase()}，约 20–60 秒后可用` };
}

/**
 * 停本机模型。除了自己 spawn 的进程，还要按端口兜底 ——
 * 服务可能是上次控制台启动的（或用户手动起的），本控制台手里没有它的 pid。
 */
/**
 * 「把本机模型准备好」的完整一段：没跑就拉起来 → 等到真的能应答 → 预热一条。
 *
 * 单独成函数是为了能和一键启动里的「等协议端就绪」**并行**跑 —— 两者互不依赖，
 * 串着做等于白等（容器刚重启时 NapCat 要 20 秒应答、模型加载 40 秒，加起来一分钟）。
 * 返回是否就绪，调用方只用来决定日志怎么写。
 */
async function ensureLocalModelReady(cfg, say = () => {}) {
  const size = resolveLocalKey(localKeyOf(cfg.llm.model) || cfg.llm.localSize);
  const channel = localChannelOf(cfg.llm.localChannel);

  if ((await httpGet(LOCAL_CHANNELS[channel].port, '/v1/models', 2000)).ok) {
    say('· 本机模型已在运行');
    return true;
  }

  say(`… 正在启动本机模型 ${size.toUpperCase()}（${LOCAL_CHANNELS[channel].label}）`);
  const r = await startLocalModel(size, channel, say);
  if (!r.ok) {
    say(`✗ ${r.msg}`);
    return false;
  }
  if (!(await waitLocalReady(MODEL_READY_TIMEOUT_MS, channel))) {
    say('✗ 模型加载超时，请看日志');
    return false;
  }
  say('✔ 本机模型已就绪');
  say('… 预热中（先悄悄跑一条）');
  say((await warmupLocal(channel)) ? '✔ 预热完成' : '· 预热没成功，第一条会慢一点');
  return true;
}

async function stopLocalModel(channel) {
  const ch = localChannelOf(channel || state.localChannel || 'mlx');
  const port = LOCAL_CHANNELS[ch].port;
  const pid = state.localChannel === ch ? state.localModel?.pid : undefined;
  const hadOwn = !!pid;
  if (hadOwn) await killTree(pid, KILL_GRACE_MS);

  state.localModel = null;
  state.localModelKey = '';
  state.localChannel = '';

  const wasUp = await portOpen(port);
  if (!wasUp) return hadOwn ? { ok: true, msg: '本机模型已停止' } : { ok: false, msg: '本机模型没在运行' };

  await stopLocalByPort(ch);
  const stillUp = await portOpen(port);
  return stillUp
    ? { ok: false, msg: '本机模型没能完全停下，端口仍被占用' }
    : { ok: true, msg: '本机模型已停止' };
}

// ---------- 静态资源 ----------


/**
 * 进度回报闭包工厂：把带图标的进度文本同时做两件事 ——
 *   ① pushLog 进运行日志（保留 ✔·✗ 图标，给人看）；
 *   ② 剥掉图标前缀后推进 steps 数组（回传前端做"步骤清单"，只要纯文本）。
 * steps 是每个路由自己的局部数组，必须按引用传进来。
 * 「切大脑 / 一键启动 / 结束运行」三处的回报逻辑完全一样，收拢到这里，
 * 避免三份逐字复制日后各自漂移。
 */
function makeSay(steps) {
  return (m) => {
    pushLog(m);
    steps.push(String(m).replace(/^[·✔✗…▶■]\s*/, ''));
  };
}


// ---------- 路由 ----------
/* ══════════════ API 路由表（H-10 · 第 15 轮「巨型文件拆分」第一半）══════════════
 * 原来 39 条 `if (p === …)` 链埋在 createServer 回调里（约 1200 行），
 * 加一条路由就续一截，谁也看不全「面板到底开了几个口」。现在：
 *   · 每条路由一个模块级 handler，签名统一 `(req, res, url)` —— 体是**逐字搬来**的，
 *     只有缩进变了（鉴权 / 审计仍挂在分发**之前**的回调里，位置没动）；
 *   · `API_ROUTES` 是唯一的路由清单：{path, method, handler}，method 缺省 = GET；
 *   · 分发器在下面的 createServer 回调里（查表 → 调用），`return await` 被 §81 逐字钉住
 *     —— 不 await 的话 handler 的拒绝绕过本层 try/catch，静默掉进 unhandledRejection。
 * ⚠️ check-wb §3e 的「读写分类同源」改从这张表抽 POST 路由：新加 POST 路由时
 *    「忘了进 WRITE_ROUTES / READ_ONLY_POST」仍然会被当场点名。
 */

async function apiState(req, res, url) {
  return sendJson(res, await collectState());
}

// 审计日志（B9 · AU-AUDIT）。只读路由 —— 不鉴权、不审计。
// 有它才可能被断言：不然"改一次配置会不会留痕"只能靠人去翻文件。
async function apiAudit(req, res, url) {
  const limit = Number(url.searchParams.get('limit') || 100);
  return sendJson(res, { file: 'panel/audit.jsonl', lines: readAudit(limit) });
}

async function apiLogs(req, res, url) {
  const since = Number(url.searchParams.get('since') || 0);
  // total 是「累计第几行」的单调递增编号，不是数组长度 —— 数组长度满了就不动了，
  // 用它当 total 正是日志冻住的根因。
  const total = logDropped + state.logs.length;
  // 隔着一次清空或一次面板重启，客户端的游标会指向一个根本不存在的编号
  // （比如它停在 300，而服务端已经从 0 重新数）。这时把现存日志整份给它并标 reset，
  // 让它一次性追平 —— 否则它会一直卡在够不着的下标上，表现为"日志再也不动了"。
  const stale = since > total;
  const lines = stale ? state.logs.slice() : state.logs.slice(Math.max(0, since - logDropped));
  return sendJson(res, { lines, total, dropped: logDropped, reset: stale });
}

// ⚠️ 2026-10-01 清理轮**删除**了 GET `/api/config/history`。
//    它把 `config-history.jsonl` 的摘要整列出来，但**全仓 0 个消费者**：
//    前端只用 `/api/state` 下发的 `configHistory`（条数，见 `collectState()`），
//    脚本与契约都不调它。契约扫不出"没人用的只读路由"，所以它一直静静躺着。
//    若将来真要做「配置历史」页面，再把它加回来 —— 模块层（`readHistory`）原样保留。

// ── 会话（P1 分区重构）────────────────────────────────────────────────
// 「现在在跟谁聊」。数据源是 **trace**，不是存档 —— 两者故意不合并：
//   trace  = 有界窗口（折半截断），反映**最近的**活动；
//   存档   = 机器人退出时补写的全量历史，反映**聊过什么**。
// 合成一份的话，截断时会静默丢数据（本项目第 11 条陷阱的同形）。
//
// ⚠️ `TRACE_SHOWN` 是"对话流卡片显示几条"，**不是**"会话聚合能看几条"
//    —— 用前者会让会话列表永远只有 3 条记录里的 1~2 个会话。
//    所以这里单独读一个更大的窗口（`TRACE_AGGREGATE`）。
async function apiSessions(req, res, url) {
  const limit = Number(url.searchParams.get('limit') || 200);
  return sendJson(res, {
    file: 'panel/local-trace.jsonl',
    items: sessionsFromTrace(readTrace(TRACE_AGGREGATE), { limit }),
    window: TRACE_AGGREGATE,
  });
}

async function apiSessionsDetail(req, res, url) {
  const key = String(url.searchParams.get('key') || '');
  const limit = Number(url.searchParams.get('limit') || 50);
  const items = key
    ? sessionRecordsOf(readTrace(TRACE_AGGREGATE), key, { limit })
    : [];
  return sendJson(res, { key, items });
}

// ── 存档（P1 分区重构）────────────────────────────────────────────────
// 「之前聊过什么」。`panel/session-archive.json` 由机器人侧写（O-SESSION），
// 面板**只读** —— 存档该不该恢复是机器人的判据，面板不碰那个决定。
async function apiChats(req, res, url) {
  return sendJson(res, { file: 'panel/session-archive.json', items: chatsFromArchive(readArchive()) });
}

async function apiChatsDetail(req, res, url) {
  const key = String(url.searchParams.get('key') || '');
  return sendJson(res, { key, detail: key ? chatDetailOf(readArchive(), key) : null });
}

// 撤销上一次保存。它**整份覆盖** config.json，所以必须是写路由、受 token 保护 ——
// 否则任何人都能把你的配置退回到任意一版。
async function apiConfigUndo(req, res, url) {
  const body = await readBody(req);
  const back = Math.max(1, Number(body.steps) || 1);
  const target = configAt(HISTORY_FILE, back - 1);
  if (!target) {
    return sendJson(res, { ok: false, error: '没有可撤销的历史（已经是能回溯到的最早一版了）' }, 400);
  }
  // 撤销**自己不进历史**，并把被恢复的那些条目弹掉 ——
  // 否则再撤一次同样的步数会跳回刚离开的那版，撤销就变成了来回切换。
  writeConfig(target, { via: 'undo', history: false });
  let popped = 0;
  for (let i = 0; i < back; i += 1) if (popHistory(HISTORY_FILE)) popped += 1;
  pushLog(`↩ 已撤销最近 ${popped} 次保存（回到那之前的一版）`);
  return sendJson(res, { ok: true, steps: popped, msg: `已回到 ${popped} 步之前` });
}

// 「保存配置」这条路由的**全部逻辑**在 `lib/config-route.js`（第 18 轮 · H-10 第二半搬出）。
// 这里只留**一次接线**：把那四个共享判据注入进去。
// ⚠️ 判据本身**不许搬进 lib** —— `bridgeRunning` 在主文件里另有 7 个调用点，
//    搬进去就得留两份实现，后改的那份不生效（ESM 的 import 绑定在外部只读）。
const apiConfig = makeConfigRoute({ baseUrlReject, sameUrl, bridgeRunning, waitEffectiveApplied });

async function apiGroups(req, res, url) {
  const r = await httpGet(3000, '/get_group_list', 10000);
  if (!r.ok) return sendJson(res, { ok: false, error: '协议端还没连上', groups: [] });
  try {
    const j = JSON.parse(r.body);
    const groups = (j.data || []).map((g) => ({ id: String(g.group_id), name: g.group_name || '' }));
    return sendJson(res, { ok: true, groups });
  } catch {
    return sendJson(res, { ok: false, error: '返回内容解析失败', groups: [] });
  }
}

async function apiBridgeStart(req, res, url) {
  const r = await startBridge();
  return sendJson(res, r, r.ok ? 200 : 400);
}

async function apiBridgeStop(req, res, url) {
  // stopBridge 是 async（要等进程真的退出），这里必须 await，
  // 否则拿到的是 Promise，序列化成 "{}"，前端什么都看不到
  const r = await stopBridge();
  return sendJson(res, r, r.ok ? 200 : 400);
}

// D6b：把一条命令写进命令文件，等机器人下一轮轮询取走。
//
// ⚠️ 这里**只负责写**，不负责执行、也不假装知道结果：结果由机器人写回同一个
//    文件的 `done` 字段，页面从 `/api/state` 的 `bridge.control` 读回来。
//    "点完立刻回成功"是错的 —— 它只证明文件写下去了（可能机器人根本没在跑）。
async function apiBridgeCommand(req, res, url) {
  const body = await readBody(req);
  const r = issueCommand(String(body?.cmd || ''));
  return sendJson(res, r, r.ok ? 200 : 400);
}

async function apiCheck(req, res, url) {
  pushLog('… 开始连接自检');
  const r = await sh(NODE, ['scripts/check-onebot.js'], 20000);
  const out = (r.stdout + r.stderr).trim();
  pushLog(out);
  return sendJson(res, { ok: r.ok, output: out });
}

async function apiLocalModelStart(req, res, url) {
  const body = await readBody(req);
  const cfg = readConfig() || {};
  const channel = localChannelOf(body.channel || cfg?.llm?.localChannel);
  const r = await startLocalModel(body.model, channel);
  return sendJson(res, r, r.ok ? 200 : 400);
}

async function apiLocalModelStop(req, res, url) {
  const body = await readBody(req);
  const cfg = readConfig() || {};
  const channel = localChannelOf(body.channel || state.localChannel || cfg?.llm?.localChannel);
  const r = await stopLocalModel(channel);
  return sendJson(res, r, r.ok ? 200 : 400);
}

/**
 * 一键切换云端 / 本机。
 * 和「保存设置」不同：这里会连带把该开的开起来、该关的关掉，
 * 并且一直等到真正可用才返回，中途每一步都回传给前端显示进度。
 */
async function apiSwitch(req, res, url) {
  const body = await readBody(req);
  // ⚠️ 这里有两套名字，别混：
  //   接口层的 target：local / cloud / zhipu（老面板一直这么传，不能改，改了前后端就对不上）
  //   预设的键     ：local / deepseek / zhipu（按服务商命名，方便归档 Key）
  // 之前用 'deepseek' 当 target 判断，结果「切 DeepSeek」被静默当成「切本机」——
  // 因为 'deepseek' 不在白名单里，被兜底成了 'local'。必须显式映射。
  const ALT_TARGET = { deepseek: 'cloud', cloud: 'cloud', zhipu: 'zhipu', local: 'local' };
  const target = ALT_TARGET[String(body.target || '')] || 'local';
  const presetKey = target === 'cloud' ? 'deepseek' : target;
  const steps = [];
  const say = makeSay(steps);

  const cfg = readConfig() || {};
  cfg.llm = cfg.llm || {};

  // 先把当前用的 Key 按服务商归档。各家 Key 不通用，
  // 不归档的话切回去就得重新填一遍。
  const fromProvider = providerOf(cfg.llm.baseUrl);
  if (fromProvider !== 'local' && fromProvider !== 'other') {
    cfg.llm.keys = { ...(cfg.llm.keys || {}), [fromProvider]: cfg.llm.apiKey };
  }
  // 再把这套扁平配置整个存回「它所属的大脑」的预设，切走之后什么都不丢
  const presets = stashCurrentPreset(cfg);

  if (target === 'local') {
    const P = presets.local;
    const size = LOCAL_MODELS[body.size] && localModelExists(body.size)
      ? body.size
      : resolveLocalKey(P.size);
    const channel = localChannelOf(P.channel);
    cfg.llm.baseUrl = localChannelUrl(channel);
    cfg.llm.model = LOCAL_MODELS[size].path;
    cfg.llm.localSize = size;
    cfg.llm.localChannel = channel;
    // 下面这些值全部来自「本机」自己那套预设，不是沿用刚离开的云端、
    // 也不是"上一次刚好是什么"。用户在本机页改过的值会被原样保留。
    cfg.llm.maxTokens = P.maxTokens || 160;
    // 小模型温度要低才稳；0.7 是 Qwen 官方推荐、也是 QwenChat 界面在用的值
    cfg.llm.temperature = Number.isFinite(P.temperature) ? P.temperature : 0.7;
    cfg.context = { ...(cfg.context || {}), ...(P.context || {}) };
    cfg.llm.thinking = body.thinking ? normalizeThinking(body.thinking) : normalizeThinking(P.thinking);
    cfg.llm.features = { ...P.features };
    // 选中的规格和通道要立刻记进本机预设本身。
    // 否则 stashCurrentPreset 那一步（发生在选规格之前）记下的还是旧的 size，
    // 下次切回本机就又变回老规格了。
    cfg.llm.presets = {
      ...(cfg.llm.presets || {}),
      local: { ...(cfg.llm.presets?.local || {}), size, channel },
    };
    writeConfig(cfg);
    say(`✔ 已切到本机模型 ${size.toUpperCase()}（${LOCAL_CHANNELS[channel].label}）`);
    say(`· 单条上限 ${cfg.llm.maxTokens} token，上下文 ${cfg.context.recentTurns} 轮 / 背景 ${cfg.context.ambientMessages} 条（可在不卡的前提下自己调）`);

    const lport = LOCAL_CHANNELS[channel].port;
    const alive = await httpGet(lport, '/v1/models', 2000);
    let curKey = '';
    if (alive.ok) {
      try {
        curKey = localKeyOf((JSON.parse(alive.body)?.data || [])[0]?.id);
      } catch { /* 解析不出来就当未知 */ }
    }

    if (curKey === size) {
      say('· 该模型已在运行，无需重启');
    } else {
      if (curKey) say(`· 正在关掉 ${curKey.toUpperCase()}，换 ${size.toUpperCase()}`);
      const r = await startLocalModel(size, channel, say);
      if (!r.ok) {
        say(`✗ ${r.msg}`);
        return sendJson(res, { ok: false, steps, msg: r.msg }, 400);
      }
      say('… 模型加载中（首次约 20–60 秒）');
      const ready = await waitLocalReady(MODEL_READY_TIMEOUT_MS, channel);
      if (!ready) {
        say('✗ 等待超时，请看运行日志');
        return sendJson(res, { ok: false, steps, msg: '本机模型启动超时' }, 400);
      }
      say('✔ 本机模型已就绪');
      say('… 预热中（先悄悄跑一条，免得你在群里发的第一句干等）');
      say((await warmupLocal(channel)) ? '✔ 预热完成，可以开聊了' : '· 预热没成功，第一条会慢一点');
    }
  } else {
    // 切到某个云端预设（DeepSeek 便宜 / 智谱免费）。
    // 默认值只在该大脑「第一次被使用」时兜底，之后一律以它自己的预设为准。
    const preset = CLOUD_PRESETS[presetKey] || CLOUD_PRESETS.deepseek;
    const P = presets[presetKey] || {};
    if (isLocalBase(cfg.llm.baseUrl || '')) cfg.llm.localSize = localKeyOf(cfg.llm.model) || cfg.llm.localSize;
    cfg.llm.baseUrl = P.baseUrl || preset.baseUrl;
    cfg.llm.model = P.model || preset.model;
    cfg.llm.fallbackModels = P.fallbackModels || preset.fallbackModels || [];
    cfg.llm.fallbackModel = ''; // 兼容旧字段，预设接管后不再用
    // 取回这家上次用的 Key；没有就留空，面板会提示去填
    cfg.llm.apiKey = cfg.llm.keys?.[preset.provider] || '';
    cfg.llm.maxTokens = P.maxTokens || 400;
    cfg.llm.temperature = Number.isFinite(P.temperature) ? P.temperature : 1;
    cfg.context = { ...(cfg.context || {}), ...(P.context || {}) };
    // 该大脑自己记住的思考设置。智谱那套默认就是「关」——
    // 实测它默认带思考、思考 token 会把 max_tokens 吃光（正文直接是空字符串）。
    cfg.llm.thinking = body.thinking ? normalizeThinking(body.thinking) : normalizeThinking(P.thinking);
    // 能力开关也各归各家：DeepSeek 那套里联网永远是关的（它根本没有这个内置工具）
    cfg.llm.features = { ...(P.features || {}) };
    writeConfig(cfg);
    const chain = [cfg.llm.model, ...(cfg.llm.fallbackModels || [])];
    say(`✔ 已切到${preset.label}`);
    if (chain.length > 1) say(`· 降级链：${chain.join(' → ')}`);

    // 用云端就不需要本机模型占着内存了（两条本地通道一起收掉）
    await stopAnyLocalModel(say);
  }

  // 机器人在跑的话，等它热重载确认后再返回（理由同 /api/config）
  const wasRunning = bridgeRunning();
  const applied = await waitEffectiveApplied(cfg);
  say(
    !wasRunning
      ? '· 机器人没在运行，配置已保存，启动时生效'
      : applied
        ? '✔ 机器人已切换到新配置'
        : '· 机器人还没确认切换，稍后看运行日志'
  );

  invalidateDockerCache();
  return sendJson(res, {
    ok: true,
    target,
    preset: presetKey,
    applied,
    steps,
    msg: target === 'local' ? '已切到本机模型' : `已切到${CLOUD_PRESETS[presetKey]?.label || '云端'}`,
  });
}

/** 一键启动：Docker → 容器 → 模型 → 机器人，每步都有进度 */
async function apiOnekeyStart(req, res, url) {
  const steps = [];
  const say = makeSay(steps);

  say('▶ 开始一键启动');

  const d = await ensureDocker(150000, (m) => say('· ' + m));
  if (!d.ok) {
    say(`✗ ${d.msg}`);
    return sendJson(res, { ok: false, steps, msg: d.msg }, 400);
  }
  invalidateDockerCache();
  if (d.waitedMs) say(`✔ Docker 已就绪（等了 ${Math.round(d.waitedMs / 1000)} 秒）`);

  // 先确认容器挂在哪儿。项目文件夹改过名/搬过家时，`docker start` 会沿用它创建时记下的
  // 旧绝对路径（Docker 不报错，而是静默新建空目录）→ OneBot 配置和 QQ 登录态等于丢了。
  // 这种情况必须先重建容器，否则后面怎么扫码都登录不上。
  const stale = await containerMountStale();
  if (stale) {
    say(`⚠ 容器挂载指向旧路径：${stale[0]}`);
    await recreateNapcatContainer(say);
    invalidateDockerCache();
  }

  // 优先 start（保留原有容器和登录态），起不来再 compose 重建
  const psr = await sh(DOCKER, ['ps', '--filter', 'name=napcat', '--format', '{{.Names}}'], 10000);
  if (!/napcat/.test(psr.stdout || '')) {
    say('… 正在启动 QQ 容器');
    const r1 = await sh(DOCKER, ['start', 'napcat'], 40000);
    if (r1.ok) {
      say('✔ 容器已启动');
    } else {
      const r2 = await sh(DOCKER, ['compose', 'up', '-d'], DOCKER_COMPOSE_TIMEOUT_MS);
      say(r2.ok ? '✔ 容器已创建并启动' : `✗ 容器启动失败：${(r2.stderr || '').slice(0, ERR_SNIPPET_CHARS)}`);
    }
  } else {
    say('· 容器已在运行');
  }

  // 「等协议端就绪」和「把本机模型拉起来」**互不依赖**：协议端是容器那边的事，
  // 模型是另一个进程。以前串着做 —— 容器刚重启时 NapCat 要 20 秒才应答、模型又要
  // 加载 40 秒，用户得干等一分钟。现在同时发，谁慢等谁（日志按各自完成的时刻落）。
  const cfg = readConfig();
  const needLocal = isLocalBase(cfg?.llm?.baseUrl);
  say(needLocal
    ? '… 等待协议端就绪，同时启动本机模型（并行）'
    : '… 等待 QQ 协议端就绪');

  const onebotTask = waitFor(async () => (await httpGet(3000, '/get_login_info', ONEBOT_PROBE_TIMEOUT_MS)).ok, ONEBOT_READY_DEADLINE_MS, ONEBOT_PROBE_GAP_MS)
    .then((ok) => {
      say(ok ? '✔ 协议端已就绪' : '✗ 协议端没响应（可能要扫码登录，看左侧状态）');
      return ok;
    });

  await Promise.all([
    onebotTask,
    needLocal ? ensureLocalModelReady(cfg, say) : Promise.resolve(false),
  ]);

  if (!needLocal) {
    say('· 云端模式，不需要本机模型');
    if (await stopAnyLocalModel(say)) say('✔ 已关掉本机模型，省内存');
  }

  if (bridgeRunning()) {
    say('· 机器人已在运行');
  } else {
    const r = await startBridge();
    say(r.ok ? `✔ ${r.msg}` : `✗ ${r.msg}`);
  }

  invalidateDockerCache();
  return sendJson(res, { ok: true, steps, msg: '一键启动完成' });
}

/**
 * 结束本次运行：机器人 + 本机模型 + 容器 + （可选）Docker Desktop 全关，
 * 回到启动之前的干净状态，内存一次性释放干净。
 */
async function apiOnekeyStop(req, res, url) {
  const body = await readBody(req);
  const quitDocker = body.quitDocker !== false; // 默认连 Docker 一起退，才叫"干净"
  const steps = [];
  const say = makeSay(steps);

  say('■ 开始结束本次运行');

  // 机器人、本机模型、QQ 容器三件事互不依赖，以前是一件一件等 ——
  // 光 docker stop 那一步就要 10~30 秒，串起来用户只能盯着进度条。
  // 现在容器先发出去停，同时收机器人和模型，最后只等容器那一步。
  const dockerUpFirst = await cachedDockerUp();
  // `-t 10` = 给容器 10 秒优雅退出的时间，超时才强杀。**显式写出来**而不是吃 docker
  // 的默认值：NapCat 要靠这段时间把登录态落盘，默认值以后要是变了就是无声的坑。
  // 后面的 20000 是 node 侧的兜底超时（10 秒优雅期 + 启动开销 + 余量）——
  // 原来写 60000，万一 docker 命令挂住，用户要干等一分钟。
  const containerStop = dockerUpFirst
    ? sh(DOCKER, ['stop', '-t', '10', 'napcat'], 20000)
    : Promise.resolve(null);

  const b = await stopBridge();
  say(b.ok ? `✔ ${b.msg}` : `· ${b.msg}`);

  // 兜底：pidfile 里可能还留着别的机器人进程
  try {
    const pid = Number.parseInt(fs.readFileSync(PIDFILE, 'utf8').trim(), 10);
    if (pid && pid !== process.pid && pidAlive(pid)) {
      await killTree(pid, 2000);
      say('· 已清理残留的机器人进程');
    }
  } catch { /* 没有 pidfile 就算了 */ }
  try { fs.unlinkSync(PIDFILE); } catch { /* 无所谓 */ }

  // 本机模型：能收的都收掉。用户自己开的 QwenChat 会保留（日志里会说明原因），
  // 因为那不是本次运行拉起来的，关掉它等于把用户正在聊的窗口关了。
  const l = await stopAnyLocalModel(say);
  say(l ? '✔ 本机模型已停止，内存已释放' : '· 本机模型本来就没在运行');

  if (dockerUpFirst) {
    say('… 正在停止 QQ 容器');
    const r = await containerStop;
    say(r.ok ? '✔ QQ 容器已停止' : `· 容器停止：${(r.stderr || '').slice(0, 150) || '已经停了'}`);

    if (quitDocker) {
      // 只**发起**退出，不等它退完。Docker 退出要 10~20 秒，而它退不退都不影响
      // 前面已经做完的清理（机器人 / 模型 / 容器都停了）。等在这里纯属让用户干瞪眼 ——
      // 页面上「Docker」那一项会自己变灰，比一句"处理中"直观得多。
      execFile('/usr/bin/osascript', ['-e', 'tell application "Docker" to quit'], () => {});
      state.dockerQuitAt = Date.now(); // 给「一键启动」留个记号：它正在退出，别撞上去
      say('· 已让 Docker Desktop 退出（后台进行，约 10–20 秒，不用等它 —— 上面那项会自己变灰）');
    }
  } else {
    say('· Docker 本来就没在运行');
  }

  try { fs.unlinkSync(EFFECTIVE_FILE); } catch { /* 本来就没有 */ }
  invalidateDockerCache();
  say('✔ 已回到启动前的干净状态');
  return sendJson(res, { ok: true, steps, msg: '已全部结束，内存已释放' });
}

async function apiBalance(req, res, url) {
  return sendJson(res, await fetchBalance());
}

/**
 * 「试一句」：不碰 QQ，走「配置 → 人格 → 模型 → 分段」整条链，
 * 把**完整提示词、模型原始输出、最终会发出去的段**一次全给前端。
 *
 * 这就是用户要的「输出流转看得见」：本地模型答得不好时，
 * 不用猜，直接看它到底收到了什么提示词、被截断在哪。
 */
async function apiTry(req, res, url) {
  const body = await readBody(req);
  const text = String(body.text || '').slice(0, 500).trim();
  if (!text) return sendJson(res, { ok: false, error: '先说一句要试的话' }, 400);
  pushLog(`… 试一句（不碰 QQ）：${text}`);

  // 本机模型一条要十几秒，超时给足 4 分钟，别让它半路被砍
  // ⚠️ `'--'` 不能省（H-04）：`text` 是**用户输入**，以 `-` 开头时会被下游当成一个选项。
  //    这不是命令注入（`panel/lib/proc.js` 用 execFile + 数组传参、没有 shell），
  //    但"一句话"变成"一个开关"就是参数注入。分隔符之后的都被下游当正文 ——
  //    拆分规则只有一份实现（`scripts/lib/cli-args.mjs`），由 smoke 的真值表盯着。
  const r = await sh(NODE, [path.join(ROOT, 'scripts', 'dryrun.js'), '--json', '--', text], DRYRUN_TIMEOUT_MS);
  const lines = (r.stdout || '').trim().split('\n').filter(Boolean);
  let data = null;
  try {
    data = JSON.parse(lines[lines.length - 1] || '');
  } catch {
    /* 下面统一报错 */
  }
  if (!data) {
    const detail = (r.stdout + r.stderr).slice(-DRYRUN_TAIL_CHARS);
    pushLog('✗ 试一句失败：干跑输出解析不出来');
    return sendJson(res, { ok: false, error: '干跑没能跑通，看下面的原始输出', output: detail }, 500);
  }
  pushLog(
    data.ok
      ? `✔ 试一句完成（${data.ms} ms，会发 ${data.chunks.length} 段）`
      : `✗ 试一句失败：${data.error}`
  );
  return sendJson(res, data);
}

async function apiTraceClear(req, res, url) {
  try { fs.unlinkSync(TRACE_FILE); } catch { /* 本来就没有 */ }
  pushLog('· 对话流记录已清空');
  return sendJson(res, { ok: true, msg: '对话流记录已清空' });
}

// ── 自定义工作台：自动记忆的删除 / 清空 ──
// 自动记忆文件由机器人进程写入（唯一写入者），面板这里只做**用户点的那一下**。
// 和机器人的追加写理论上可能撞车，代价最多是丢掉"刚好那一瞬间"的新记录 ——
// 比两个进程都整份重写同一个 JSON 安全得多（那样会真的把文件写坏）。
async function apiCustomMemoryClear(req, res, url) {
  const r = clearAutoMemory();
  pushLog(r.ok ? '· 自动记忆已清空' : `✗ 清空自动记忆失败：${r.error}`);
  return sendJson(res, r.ok ? { ok: true, msg: '自动记录已清空（手动记忆不受影响）' } : { ok: false, error: r.error });
}

async function apiCustomMemoryDelete(req, res, url) {
  const body = await readBody(req);
  const rows = listAutoMemory().filter((m) => m.id !== String(body.id || ''));
  try {
    fs.writeFileSync(
      AUTO_MEMORY_PATH,
      rows.map((m) => JSON.stringify(m)).join('\n') + (rows.length ? '\n' : '')
    );
    pushLog('· 已删除 1 条自动记忆');
    return sendJson(res, { ok: true, msg: '已删除' });
  } catch (e) {
    return sendJson(res, { ok: false, error: e.message }, 500);
  }
}

// ── 记忆检索（D-M3）──
// 与机器人那句"你还记得吗"**共用同一份判据**（`recallForPrompt` → `searchRecords`）：
// 面板上搜不到的东西，机器人在群里同样捞不出来 —— 两边必须同源，
// 否则"面板能查到、它却不记得"会变成一个解释不清的现象。
// ⚠️ 只读：不改状态、不加 samples（`recallForPrompt` 的边界声明）。
async function apiMemorySearch(req, res, url) {
  const body = await readBody(req);
  const query = String(body?.query || '').trim();
  if (!query) return sendJson(res, { ok: false, error: '没有填要搜什么' }, 400);
  // `chatKey` 可选：页面默认看全部（人找记忆），机器人默认只看本会话（隔离纪律）。
  const out = recallForPrompt(query, {
    chatKey: String(body?.chatKey || ''),
    limit: 20,
    max: 20,
  });
  return sendJson(res, { ok: true, ...out });
}

// ── 结构化记忆的人工复核（ATI-5）──
// 判定在 `src/memory-record.js`（纯函数），落盘在 `src/memory.js` 的 `reviewRecordById`
// —— 本路由只做三件事：读 body、调那一个函数、按结果回话。
// ⚠️ 沙箱**不拦**这条：`memory-records.json` 本来就被排除在沙箱之外
//    （见 `test/sandbox.sh`），所以在沙箱里它改的是 /tmp 那份副本，
//    这也正是 `verify-panel` 能真的点一次按钮的前提。
async function apiMemoryReview(req, res, url) {
  const body = await readBody(req);
  const id = String(body?.id || '');
  const action = String(body?.action || '');
  const r = reviewRecordById(id, action);
  if (!r.ok) {
    pushLog(`✗ 结构化记忆复核失败（${action || '无动作'}）：${r.error}`);
    // 404 只留给"这条不在了" —— 它是页面最常见的一种过期状态（另一个窗口刚删过），
    // 与"参数写错"分开，前端才能给出不同的提示。
    return sendJson(res, { ok: false, error: r.error, reason: r.reason }, r.reason === 'not-found' ? 404 : 400);
  }
  const label = REVIEW_ACTIONS[r.action] || r.action;
  pushLog(`· 结构化记忆：${label}${r.removed ? '（已删除）' : ` → ${RECORD_STATUS_LABELS[r.status] || r.status}`}`);
  return sendJson(res, {
    ok: true,
    action: r.action,
    status: r.status,
    removed: r.removed,
    msg: r.removed ? '已删除这条记忆' : `已${label.split('：')[0]}`,
  });
}

// ── 自定义工作台：导入前预览 ──
// 只比**工作台那一块**，和导入真正会改的范围严格一致 ——
// 预览的内容和实际会发生的事不一致，比没有预览更糟（用户会照着一份假清单做决定）。
async function apiCustomPreview(req, res, url) {
  const body = await readBody(req);
  const incoming = body && typeof body === 'object' ? (body.custom || body) : {};
  const cur = readCustom(readConfig());
  const pick = {};
  for (const k of IMPORTABLE_KEYS) if (incoming[k] !== undefined) pick[k] = incoming[k];
  if (!Object.keys(pick).length) {
    return sendJson(res, { ok: false, error: '这份文件里没有工作台认识的字段' });
  }
  const next = patchCustom(cur, pick);

  // 字段级差异
  const changes = diffObject(cur, next);
  // 清单类：按 id 对一下，说清楚"会多几条、少几条"，比只看数量有用
  const listDelta = (a, b, name) => {
    const A = new Map((a || []).map((x) => [x.id, x]));
    const B = new Map((b || []).map((x) => [x.id, x]));
    const added = [...B.values()].filter((x) => !A.has(x.id)).map((x) => x.name || x.text || x.id);
    const removed = [...A.values()].filter((x) => !B.has(x.id)).map((x) => x.name || x.text || x.id);
    const changed = [...B.values()]
      .filter((x) => A.has(x.id) && JSON.stringify(A.get(x.id)) !== JSON.stringify(x))
      .map((x) => x.name || x.text || x.id);
    return { name, added, removed, changed };
  };
  const lists = [
    listDelta(cur.skills, next.skills, '技能'),
    listDelta(cur.memory.manual, next.memory.manual, '手动记忆'),
    listDelta(cur.trigger.scheduled, next.trigger.scheduled, '定时消息'),
  ];

  // 冲突：导入的手动记忆和已有/自动记录里的条目高度相似 —— 提醒用户这是"同一件事记两遍"
  const auto = listAutoMemory();
  const seen = [...next.memory.manual];
  const dupIncoming = [];
  for (let i = 0; i < seen.length; i += 1) {
    for (let j = i + 1; j < seen.length; j += 1) {
      if (similarity(seen[i].text, seen[j].text) >= SIMILAR_THRESHOLD) {
        dupIncoming.push(`导入的「${seen[i].text}」和「${seen[j].text}」像是在说同一件事`);
      }
    }
  }
  const autoDup = next.memory.manual
    .filter((m) => auto.some((r) => similarity(m.text, r.text) >= SIMILAR_THRESHOLD))
    .map((m) => `「${m.text}」和自动记录里的一条很像`);

  return sendJson(res, {
    ok: true,
    changes,
    lists: lists.filter((l) => l.added.length || l.removed.length || l.changed.length),
    conflicts: [...dupIncoming, ...autoDup].slice(0, 20),
    // 导入期间不会被碰的字段，明说一句 —— 用户才敢点确认
    untouched: IMPORTABLE_KEYS.filter((k) => pick[k] === undefined),
  });
}

// ── D21 · 插件 ZIP 导入 ──────────────────────────────────────────────
// 语义三步：**先在内存里全部校验**（路径 / 符号链接 / 体积 / 清单）→ 备份 → 替换（失败回滚）。
// ⚠️ 装完**不自动启用**：目录里有 ≠ 会生效，勾选仍由用户在扩展列表上点。
//    所以这里一个字节都不写 `custom.plugins.enabled`。
// ⚠️ 它必须出现在 `WRITE_ROUTES` 里 —— 审计与鉴权共用同一份分类（`isWriteRequest`）。
async function apiExtensionsInstall(req, res, url) {
  const got = await readBodyBuffer(req, { maxBytes: ZIP_UPLOAD_MAX });
  if (!got.ok) {
    const tooBig = got.error === 'too-large';
    pushLog(`· 插件上传失败（${tooBig ? `超过 ${ZIP_UPLOAD_MAX} 字节上限` : got.error}）`);
    return sendJson(
      res,
      { ok: false, error: tooBig ? `ZIP 太大（上限 ${Math.round(ZIP_UPLOAD_MAX / 1024 / 1024)} MB）` : '上传中断' },
      tooBig ? 413 : 400
    );
  }
  const overwrite = url.searchParams.get('overwrite') === '1';
  const r = installArchive({ bytes: got.buf, roots: extensionRoots(ROOT), overwrite });
  if (!r.ok) {
    pushLog(`· 插件安装失败：${r.error}`);
    return sendJson(res, { ok: false, error: r.error }, r.code || 400);
  }
  // 装完立刻刷一次扩展快照（模块内有 10 秒 TTL 缓存）—— 不为它新开一个 force 接口。
  const cfgNow = readConfig() || {};
  extensionsOf(cfgNow.custom?.plugins?.enabled || [], { force: true });
  pushLog(`· 插件已安装：${r.dir} → ${r.root}/（${r.files} 个文件${r.replaced ? '，已覆盖旧版' : ''}；未自动启用）`);
  return sendJson(res, {
    ok: true, id: r.id, kind: r.kind, dir: r.dir, files: r.files, replaced: r.replaced,
  });
}

// ── 自定义工作台：下载 / 导出 ──
// what = all | persona | prompt | rules | memory | skills | log | faces
// format = json | txt | zip
async function apiCustomExport(req, res, url) {
  const what = String(url.searchParams.get('what') || 'all');
  const format = String(url.searchParams.get('format') || 'json');
  // mask=0 时保留群号（自己留档用）。默认脱敏到底，因为导出文件多半是要发出去的。
  const mask = url.searchParams.get('mask') !== '0';
  const cfg = readConfig() || {};
  const bundle = buildExport(cfg, what, mask);
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  const base = `qq-bot-${what === 'all' ? '完整配置' : what}-${stamp}`;

  if (format === 'zip') {
    // 多份内容打成一包。不引第三方库：整个面板是"零依赖"的。
    // ⚠️ D21 起 `makeZip` 搬去 `panel/lib/zip.js`（与读侧共用同一份 crc32）。
    const entries = Object.entries(bundle.files).map(([name, text]) => ({ name, text: String(text) }));
    const buf = makeZip(entries);
    pushLog(`· 已导出 ZIP（${entries.length} 个文件）`);
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${encodeURIComponent(base)}.zip"`,
      'Content-Length': buf.length,
    });
    return res.end(buf);
  }
  if (format === 'txt') {
    const text = Object.entries(bundle.files)
      .map(([name, body]) => `${'='.repeat(60)}\n${name}\n${'='.repeat(60)}\n\n${body}`)
      .join('\n\n');
    pushLog('· 已导出 TXT');
    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': `attachment; filename="${encodeURIComponent(base)}.txt"`,
    });
    return res.end(text);
  }
  // json：单个 what 就直接给那一份内容，all 给整个包
  const payload = what === 'all' ? bundle : { [what]: bundle.files };
  pushLog('· 已导出 JSON');
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Disposition': `attachment; filename="${encodeURIComponent(base)}.json"`,
  });
  return res.end(JSON.stringify(payload, null, 2));
}

// 智谱赠送资源包的余额（面板上那几条进度条）。
// ?refresh=1 表示用户点了「刷新」，跳过 60 秒缓存。
async function apiZhipuPackages(req, res, url) {
  return sendJson(res, await readZhipuPackages(url.searchParams.get('refresh') === '1'));
}

async function apiModels(req, res, url) {
  // 问官方要一份真实可用的模型列表，别让用户填了个已下线的名字。
  //
  // 关键点：**按请求的那家去问**，而不是一律用「当前配置里的那家」。
  // 以前不管前端在看哪个大脑，都拿配置里的 baseUrl 去读，于是在智谱页面读到的
  // GLM 列表会留在下拉框里，切到 DeepSeek 之后一点就写进配置 → 必然报错。
  const cfg = readConfig();
  const want = String(url.searchParams.get('provider') || '');
  const provider = PRESET_KEYS.includes(want) ? want : providerOf(cfg?.llm?.baseUrl);

  // 本机：不走网络，直接给它本机已装的两个规格
  if (provider === 'local') {
    return sendJson(res, {
      ok: true,
      provider,
      models: Object.keys(LOCAL_MODELS),
      builtin: Object.keys(LOCAL_MODELS),
      source: 'local',
    });
  }

  // 该家的地址和 Key：优先用它自己预设里的，而不是当前配置里的
  const preset = readPresets(cfg)[provider] || {};
  const isCurrent = providerOf(cfg?.llm?.baseUrl) === provider;
  const base = String(preset.baseUrl || (isCurrent ? cfg?.llm?.baseUrl : '') || '').replace(/\/+$/, '');
  const key = (isCurrent ? cfg?.llm?.apiKey : '') || cfg?.llm?.keys?.[provider] || '';
  const builtin = BUILTIN_MODELS[provider] || [];

  if (!base) {
    return sendJson(res, { ok: true, provider, models: builtin, builtin, source: 'builtin' });
  }
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), HTTP_TIMEOUT_MS);
    const r = await fetch(`${base}/models`, {
      headers: key ? { Authorization: `Bearer ${key}` } : {},
      signal: ac.signal,
    });
    clearTimeout(timer);
    if (!r.ok) {
      return sendJson(res, {
        ok: false, provider, error: `HTTP ${r.status}`, models: builtin, builtin, source: 'builtin',
      });
    }
    const j = await r.json();
    const remote = (j?.data || []).map((m) => m.id).filter(Boolean);
    // 内置名单在前：智谱的免费档不在 /models 返回值里，只信接口就永远选不到它们
    return sendJson(res, { ok: true, provider, models: mergeModelList(provider, remote), builtin, source: 'both' });
  } catch (e) {
    return sendJson(res, {
      ok: false, provider,
      error: e.name === 'AbortError' ? '请求超时' : e.message,
      models: builtin, builtin, source: 'builtin',
    });
  }
}

async function apiUsageReset(req, res, url) {
  // 按月切分之后，"清零"清的是**所有账本**。只删当月那份的话，往月的数字还在，
  // 按下去看着没反应 —— "按钮说清零了、数字却没变"最容易让人以为功能坏了。
  let removed = 0;
  for (const f of listUsageFiles()) {
    try {
      fs.unlinkSync(f.path);
      removed += 1;
    } catch {
      /* 删不掉就算了，不因为一个文件让整个操作失败 */
    }
  }
  if (removed) resetUsageCache();
  const msg = removed ? `用量统计已清零（删除 ${removed} 个账本文件）` : '用量统计已清零（本来就没有账本）';
  pushLog(`· ${msg}`);
  return sendJson(res, { ok: true, msg });
}

async function apiDebug(req, res, url) {
  const body = await readBody(req);
  const on = body.on === true;
  writeDebugFlag(on);
  const wasRunning = bridgeRunning();
  if (wasRunning) {
    await stopBridge();
    await new Promise((s) => setTimeout(s, BRIDGE_SETTLE_MS));
  }
  let restarted = null;
  if (wasRunning) restarted = await startBridge();
  pushLog(`⚙ 详细日志已${on ? '开启' : '关闭'}${wasRunning ? '，机器人已重启' : ''}`);
  return sendJson(res, {
    ok: true,
    msg: `详细日志已${on ? '开启' : '关闭'}${restarted ? '，机器人已重启' : ''}`,
  });
}

async function apiStopAll(req, res, url) {
  pushLog('… 全部停止');
  // 同样是并发：容器停得慢（10~30 秒），先发出去，同时收机器人和本机模型。
  // 原来这里直接 docker stop，Docker 没起来时会白等一整轮超时。
  const dockerUp = await cachedDockerUp();
  const stopContainer = dockerUp
    ? sh(DOCKER, ['stop', '-t', '10', 'napcat'], 20000)
    : Promise.resolve(null);

  await stopBridge();
  // 两条本地通道都收（哪条在跑就收哪条），别留下一条偷偷占着内存
  await stopAnyLocalModel(null);

  if (!dockerUp) {
    invalidateDockerCache();
    pushLog('· Docker 没在运行，无需停容器');
    return sendJson(res, { ok: true, msg: '机器人和本机模型已停（Docker 本来就没运行）' });
  }
  const r = await stopContainer;
  pushLog(r.ok ? '✔ QQ 容器已停止' : `✗ 容器停止失败: ${r.stderr}`);
  invalidateDockerCache();
  // 注意：Docker Desktop 本身还留着，想彻底省内存请用顶部的「结束本次运行」
  return sendJson(res, {
    ok: r.ok,
    msg: r.ok ? '机器人、本机模型、QQ 容器都停了（Docker Desktop 仍在运行）' : '其余已停，但容器没停掉',
  });
}

async function apiNapcatRestart(req, res, url) {
  pushLog('… 重启 NapCat 容器');
  // 以前 Docker 没起来时这条会一直挂到超时，点下去像死了一样。
  // 现在先把 Docker 拉起来，期间还会往日志里汇报进度。
  const d = await ensureDocker(150000, (m) => pushLog('· ' + m));
  if (!d.ok) {
    pushLog(`✗ ${d.msg}`);
    invalidateDockerCache();
    return sendJson(res, { ok: false, output: d.msg }, 400);
  }
  // 重启不会修正挂载路径：容器若还挂在旧的项目路径上，先重建再重启，
  // 否则用户点「重启容器」只是把「配置和登录态丢了」的状态又重演一遍。
  const staleOnRestart = await containerMountStale();
  if (staleOnRestart) {
    pushLog(`⚠ 容器挂载指向旧路径：${staleOnRestart[0]}`);
    const okRec = await recreateNapcatContainer((m) => pushLog(m));
    invalidateDockerCache();
    return sendJson(res, {
      ok: okRec,
      output: okRec ? '容器已按当前项目路径重建' : '容器重建失败，看运行日志',
    });
  }
  const r = await sh(DOCKER, ['restart', 'napcat'], 90000);
  pushLog(r.ok ? '✔ 容器已重启' : `✗ 重启失败: ${r.stderr}`);
  invalidateDockerCache();
  return sendJson(res, { ok: r.ok, output: (r.stdout + r.stderr).trim() || (r.ok ? '容器已重启' : '') });
}

async function apiQrcode(req, res, url) {
  // 实时取容器里的登录二维码，避免给用户一张已经过期的静态图
  const r = await shBuffer(DOCKER, ['exec', 'napcat', 'cat', '/app/napcat/cache/qrcode.png']);
  if (!r.ok || !r.buf.length) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('暂时取不到二维码');
  }
  res.writeHead(200, {
    'Content-Type': 'image/png',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'Content-Length': r.buf.length,
  });
  return res.end(r.buf);
}

async function apiQrcodeRefresh(req, res, url) {
  // 手动换一张：旧的那张多半已经过期，扫了只会「登录失败」
  const r = await refreshNapcatQrcode();
  pushLog(r.ok ? '✔ 已换一张新二维码（旧的扫不动就是因为过期了）' : `✗ 换二维码失败：${r.msg}`);
  return sendJson(res, r, r.ok ? 200 : 400);
}

async function apiLogsClear(req, res, url) {
  // 清空必须走 clearLogs()：`state.logs` 与 `logDropped` 是一对不变量
  // （见 runtime-state.js）。而且 ESM 的 import 绑定只读 —— 这里直接写
  // `logDropped = 0` 会抛 TypeError（B11b-1 搬完第一次跑沙箱就撞上了）。
  clearLogs();
  return sendJson(res, { ok: true });
}

// 一键重启面板。launcher.sh 每次打开 .app 也会调它 —— 所以这里**必须幂等**：
// 代码没变就直接回"已是最新"，绝不做无谓的重启。
async function apiPanelRestart(req, res, url) {
  const r = restartPanel();
  return sendJson(res, r, r.ok ? 200 : 400);
}

const API_ROUTES = [
  { path: '/api/state', handler: apiState },
  { path: '/api/audit', handler: apiAudit },
  { path: '/api/logs', handler: apiLogs },
  { path: '/api/sessions', handler: apiSessions },
  { path: '/api/sessions/detail', handler: apiSessionsDetail },
  { path: '/api/chats', handler: apiChats },
  { path: '/api/chats/detail', handler: apiChatsDetail },
  { path: '/api/config/undo', method: 'POST', handler: apiConfigUndo },
  { path: '/api/config', method: 'POST', handler: apiConfig },
  { path: '/api/groups', handler: apiGroups },
  { path: '/api/bridge/start', method: 'POST', handler: apiBridgeStart },
  { path: '/api/bridge/stop', method: 'POST', handler: apiBridgeStop },
  { path: '/api/bridge/command', method: 'POST', handler: apiBridgeCommand },
  { path: '/api/check', method: 'POST', handler: apiCheck },
  { path: '/api/local-model/start', method: 'POST', handler: apiLocalModelStart },
  { path: '/api/local-model/stop', method: 'POST', handler: apiLocalModelStop },
  { path: '/api/switch', method: 'POST', handler: apiSwitch },
  { path: '/api/onekey/start', method: 'POST', handler: apiOnekeyStart },
  { path: '/api/onekey/stop', method: 'POST', handler: apiOnekeyStop },
  { path: '/api/balance', handler: apiBalance },
  { path: '/api/try', method: 'POST', handler: apiTry },
  { path: '/api/trace/clear', method: 'POST', handler: apiTraceClear },
  { path: '/api/custom/memory/clear', method: 'POST', handler: apiCustomMemoryClear },
  { path: '/api/custom/memory/delete', method: 'POST', handler: apiCustomMemoryDelete },
  { path: '/api/memory/search', method: 'POST', handler: apiMemorySearch },
  { path: '/api/memory/review', method: 'POST', handler: apiMemoryReview },
  { path: '/api/custom/preview', method: 'POST', handler: apiCustomPreview },
  { path: '/api/extensions/install', method: 'POST', handler: apiExtensionsInstall },
  { path: '/api/custom/export', handler: apiCustomExport },
  { path: '/api/zhipu/packages', handler: apiZhipuPackages },
  { path: '/api/models', handler: apiModels },
  { path: '/api/usage/reset', method: 'POST', handler: apiUsageReset },
  { path: '/api/debug', method: 'POST', handler: apiDebug },
  { path: '/api/stop-all', method: 'POST', handler: apiStopAll },
  { path: '/api/napcat/restart', method: 'POST', handler: apiNapcatRestart },
  { path: '/api/qrcode', handler: apiQrcode },
  { path: '/api/qrcode/refresh', method: 'POST', handler: apiQrcodeRefresh },
  { path: '/api/logs/clear', method: 'POST', handler: apiLogsClear },
  { path: '/api/panel/restart', method: 'POST', handler: apiPanelRestart },
];
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const p = url.pathname;

  // 审计挂在这**一个**地方（B9 · AU-AUDIT）：写路由的成与败都记下来。
  // 挂 res 的 finish 而不是在 handler 里手动记 —— 手动记必然漏掉抛错和提前 return
  // 的分支，而"审计出现假阴性"比"没有审计"更危险（会让人以为那次没发生）。
  const audit = beginAudit(req, p);
  res.on('finish', () => audit.done(res.statusCode));

  // ── Host 白名单（2026-10-05 开源前审查 · S-05）───────────────────────────
  // 面板只绑 127.0.0.1，但**绑回环不等于没有远程入口**：恶意站点用 DNS Rebinding
  // 让自己的域名解析到 127.0.0.1，浏览器随即判成同源 —— 跨源限制整段失效，
  // `fetch('/')` 直接读走 `<meta name="panel-token">` 里的 token（注入点见下），
  // 拿到它就能打全部 22 条写路由，最坏一条是插件安装 → 宿主动态 import → 本机 RCE。
  //
  // 位置：挂在**审计之后、鉴权之前** —— 与鉴权同一条纪律：被拒的那一次也要留痕
  // （"有人用奇怪的 Host 探过这个端口"本身就是事后要查的事）。
  //
  // ⚠️ 这一道**挡不住** Rebinding（重绑之后 Host 就是 `127.0.0.1:8788`，完全合法）；
  //    那一半由下面鉴权段里的 `sameSiteWrite()` 负责。两道互补，缺一链就还是通的。
  if (!LOOPBACK_HOST_RE.test(String(req.headers.host || ''))) {
    audit.done(403);
    return sendJson(res, { ok: false, error: 'bad host', reason: 'host-not-loopback' }, 403);
  }

  // 鉴权（B9c · AUTH-PANEL）。位置是刻意的：在**路由分发之前**，
  // 但在审计挂好之后 —— 被拒的那一次也要留痕（"有人试图改但没改成"同样是要查的事）。
  // 读写分类复用 isWriteRequest()：判定与审计**同源**，不会出现"审计记了但没鉴权"。
  {
    // ⚠️ 这里**照旧内联** `isWriteRequest(`：check-wb 第 3g 节就盯着这个形状
    //    （`isWrite:\s*isWriteRequest\(`），它防的是"读写分类变成两份"。
    //    所以下面那道跨源闸**再问一次**，不跟这里共用一个变量 —— 共用一个变量
    //    看起来更省，但那正是"两个闸其实同源"这个判据要盯的东西。
    const verdict = authDecision({
      isWrite: isWriteRequest(p, req.method),
      presented: presentedToken(req.headers),
      expected: PANEL_TOKEN.token,
    });
    if (!verdict.allow) return denyUnauthorized(res, p, verdict);
    // 写路由**再**加一道跨源闸（S-05 的后一半）。token 那一关防的是"不知道 token 的人"；
    // 而 DNS Rebinding 之后攻击者**就是**同源、且能从页面里读到 token —— 只有 Origin
    // 能把"用户自己的控制台"与"重绑过来的页面"分开。两者防的不是同一件事，都要有。
    if (isWriteRequest(p, req.method) && !sameSiteWrite(req.headers)) {
      pushLog(`✗ 写操作被拒（${p}）—— 跨源请求（Origin 不是本机），已挡下可能的 DNS Rebinding`);
      return sendJson(res, { ok: false, error: 'cross-site write rejected', reason: 'cross-site' }, 403);
    }
  }

  try {
    // ── 控制台页面：**只有一套**，挂在根上（2026-10-02）──────────────────
    //
    // 路径 → 资产名的对应**全部由叶子派生**（`assetNameForRootPath`，白名单是安全主闸）：
    //   `/`              → 入口页（NEXT_ENTRY，token 注入的唯一落点）
    //   `/style.css` …   → 同名资产
    // 这条分支**只发登记过的资产**：`README.md` / `verify.mjs` 之类取不到；
    // 将来谁往 `panel/next/` 里放一份 `config.json`，它**自动**就不可达。
    //
    // ⚠️ 为什么资产必须与入口**同层挂在根上**：页面里的引用是相对路径（`./app.js`）。
    //    入口在根、资产在 `/next/` 的话，浏览器会把 `./app.js` 解析成 `/app.js` ⟶ 404，
    //    表现是 HTML 到了、JS 与 CSS 都没到 —— **白屏**，而两个地址各自都是 200。
    const assetName = p === '/' ? NEXT_ENTRY : assetNameForRootPath(p);
    if (assetName) {
      let asset;
      try {
        asset = readNextAsset(assetName);
      } catch (e) {
        // 未登记 / 读失败 —— 说清原因。静默回空模块的表现是白屏，而服务端一片安静。
        return sendJson(res, { error: `控制台资产取不到：${e.message}` }, 404);
      }
      // token 只注入**入口页**：只有 HTML 里才有那个 meta，JS/CSS 里出现它等于开后门。
      // ⚠️ 这一行**保持原样**（不要为了少判一次 `asset.name` 而抽成 `isEntry` 变量）：
      //    `check-wb` 有一条契约逐字钉着这个三元的形状（"只给入口页注入 token"）。
      //    抽变量不是错，但会让那条**与本次改动无关**的判据假红 —— 而假红会逼人
      //    去改松判据（本项目 §3.7「改动范围只覆盖本批任务」的由来）。
      const body = asset.name === NEXT_ENTRY ? injectPanelToken(asset.raw, PANEL_TOKEN.token) : asset.raw;
      const headers = {
        'Content-Type': asset.type,
        'Cache-Control': 'no-store',
        // 类型是上面那张表按扩展名写死的，不许浏览器再嗅探一遍（H-02 的配套加固）
        'X-Content-Type-Options': 'nosniff',
      };
      // CSP **只发入口页**（2026-10-05 · 开源前审查第 10 轮 · H-02）。
      // 两条理由（完整版见 `PANEL_CSP` 的注释，别在这儿再抄一遍）：
      //   ① CSP 只对**文档**生效 —— JS/CSS 资产不是文档，发了没有意义；
      //   ② `panel/next/` 下的 `lab-*.html` 是自带**内联样式**的独立实验室页，
      //      套同一份策略会把它们当场打坏（而它们是"判据的可视化"，要能双击打开）。
      if (asset.name === NEXT_ENTRY) headers['Content-Security-Policy'] = PANEL_CSP;
      res.writeHead(200, headers);
      return res.end(body);
    }

    // 老地址兼容：新版页面在 2026-10-02 之前挂在 `/next/` —— 书签、浏览器里开着的标签、
    // 以及旧版启动器都指着它，**跳一下**就回到根上的等价地址，不会打到 404。
    // ⚠️ 兼容做成 **302 跳转**而不是"再发一次"：同一份资产两处可发 = 又多一条静的入口，
    //    而"多一条入口"这种事不会报错（见上面那句"两张表会漂"）。
    // ⚠️ 跳转目标只从**登记过的名字**里来，绝不回显请求里的路径 —— 否则 `Location`
    //    就成了一个可以塞任意串的地方。
    if (p === '/next' || p.startsWith('/next/')) {
      const name = p === '/next' || p === '/next/' ? NEXT_ENTRY : assetNameForRootPath(p.slice('/next'.length));
      if (!name) return sendJson(res, { error: 'not found' }, 404);
      res.writeHead(302, { Location: name === NEXT_ENTRY ? '/' : `/${name}`, 'Cache-Control': 'no-store' });
      return res.end();
    }

    // ── API 路由分发（H-10 · 路由表化）──────────────────────────────────────
    // 39 条 `if (p === …)` 链已收成上面那张 API_ROUTES 表；这里只做「查表 → 调用」。
    // ⚠️ `return await` 被逐字钉住（§81）：handler 的拒绝必须在**本层** try/catch
    //    里变成 500 —— 不 await 的话它发生在 try 之外，静默掉进 unhandledRejection。
    // ⚠️ method 缺省按 GET 匹配：POST 路由用 GET 打 → 查不到表项 → 走下面的 404，
    //    与改链前的行为逐字一致。
    const route = API_ROUTES.find((r) => r.path === p && (r.method || 'GET') === req.method);
    if (route) return await route.handler(req, res, url);

    sendJson(res, { error: 'not found' }, 404);
  } catch (e) {
    pushLog(`✗ 服务端错误: ${e.message}`);
    sendJson(res, { error: e.message }, 500);
  }
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`端口 ${PORT} 已被占用 —— 控制台可能已经在运行了。`);
    console.error(`直接打开 http://127.0.0.1:${PORT} 即可。`);
  } else {
    console.error(e.message);
  }
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', async () => {
  // 清扫"属主已死"的原子写临时文件（第 48 轮 B12e-4 · EX-TEMPSWEEP）。
  // 机器人与面板**各扫一次是刻意的**：两个进程都可能被杀，谁先起来谁先清干净。
  // 判据（"不是我的 && 够旧"）保证不会删掉另一个**活着**进程正在写的那一份。
  // ⚠️ 清扫面**必须含插件的两个根**（D21）：插件安装的 staging / 备份临时目录
  //    就落在 `plugins/` 与 `skills/` 里（与目标同根同级，rename 才是原子的）。
  const swept = sweepStaleTemps([ROOT, path.join(ROOT, 'panel'), ...extensionRoots(ROOT).map((r) => r.dir)]);
  if (swept.length) pushLog(`清理了 ${swept.length} 个残留的原子写临时文件（上次被强杀时留下的）`);

  await adoptExistingBridge();
  pushLog('控制台已启动');
  console.log(`\n  QQ-BOT-CONTROL 已启动`);
  console.log(`  → http://127.0.0.1:${PORT}\n`);
  console.log('  这个窗口保持开着即可，关掉窗口 = 控制台停止');
  console.log('  （机器人是独立进程，关掉控制台不会停掉机器人）\n');

  // 面板 token（B9c · AUTH-PANEL）。
  // ⚠️ 走 console.log 而**不是** pushLog：pushLog 的内容会经 /api/logs 下发，
  //    而 /api/logs 是读路由、不鉴权 —— 把 token 推进去等于从后门把它又交出去了。
  //    本文件的所有 console.log 由 launcher 重定向到 panel/panel.log（已在 .gitignore）。
  // ⚠️ **L-02（2026-10-05 · 第 12 轮）**：默认连 panel.log 里也不留**正文**。
  //    下面那条 `if (ECHO_PANEL_TOKEN)` 是这个文件里**唯一**读 token 正文去打印的地方；
  //    想看到它要么开环境变量，要么 `cat panel/.token`（两份是同一个值）。
  if (PANEL_TOKEN.source === 'generated') {
    if (ECHO_PANEL_TOKEN) {
      console.log('  面板 token（本次新生成，写操作需要它）:');
      console.log(`    ${PANEL_TOKEN.token}`);
    } else {
      console.log('  面板 token（本次新生成）已写入 panel/.token（0600）—— 页面自己会带上，无需手工操作。');
      console.log('  要在终端里看到它：`cat panel/.token`；或设 QQBOT_PANEL_TOKEN_ECHO=1 后再启动控制台。\n');
    }
  } else {
    console.log(`  面板 token 来源: ${PANEL_TOKEN.source === 'env' ? `环境变量 ${TOKEN_ENV}` : 'panel/.token'}\n`);
    console.log('  写操作（改配置 / 起停进程）需要该 token；页面由本服务注入，无需手工填写。\n');
  }
});

/**
 * 重启面板自己 —— 把内存里的旧代码换成磁盘上的新代码。
 *
 * 顺序是「**先等旧进程死掉，再起新的**」，不能反过来：端口只有一个，
 * 先起新的必然撞 EADDRINUSE 直接退出，那面板就真的没了。
 * 所以这里 spawn 一个独立的 shell 看门狗：它轮询本进程的 pid，等我们消失后再 exec 新面板。
 * 看门狗必须 detached —— 它是我们的"遗言"，跟着一起死就没人拉起来了。
 *
 * 只重启面板。机器人是独立进程，这里绝不碰它。
 */
let restarting = false;
function restartPanel() {
  if (restarting) return { ok: true, restarted: false, msg: '面板正在重启中，稍等它自己回来' };
  const info = panelInfo();
  // 没换过代码就什么都不做：launcher.sh 每次开 .app 都会调一次，幂等是硬要求
  if (!info.stale) return { ok: true, restarted: false, msg: `面板已是最新代码（pid ${info.pid}）` };

  restarting = true;
  const log = PANEL_LOG;
  const cmd = `while kill -0 ${BOOT.pid} 2>/dev/null; do sleep 0.2; done; `
    + `cd ${JSON.stringify(ROOT)} && exec ${JSON.stringify(NODE)} ${JSON.stringify(PANEL_FILE)} `
    + `>> ${JSON.stringify(log)} 2>&1`;
  try {
    spawn('/bin/sh', ['-c', cmd], { detached: true, stdio: 'ignore' }).unref();
  } catch (e) {
    restarting = false;
    return { ok: false, error: `重启器起不来：${e.message}` };
  }
  pushLog('控制台正在重启（加载新代码）…');
  // 先让响应发出去再退出 —— 立刻 process.exit 的话浏览器只会看到"连接被掐断"
  setTimeout(shutdown, PANEL_EXIT_SETTLE_MS);
  return { ok: true, restarted: true, msg: '面板正在重启，约 2 秒后自动回来', oldPid: BOOT.pid };
}

function shutdown() {
  // 故意不杀机器人：控制台只是「面板」，机器人是独立进程。
  // 要停机器人请用面板里的「一键全停」。
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), PANEL_EXIT_GRACE_MS);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

/* ══════════════ 全局异常兜底（2026-10-05 · 第 10 轮 · 开源前审查 H-09）══════════════
 * 机器人侧 `src/index.js` 早就有 `uncaughtException` / `unhandledRejection`
 * （`fatal()` 记完 `process.exit(1)`，由 `check-wb` 的一条契约盯着）。
 * 面板侧原本**一处都没有** —— 于是路由体 try/catch 之外任何抛错
 * （`server.listen` 回调里的 `await adoptExistingBridge()`、`res.on('finish')`
 * 回调、以及任何没 await 的 promise）都会让控制台**静默退出**：
 * 用户看到的是"面板无缘无故打不开了"，而日志里一个字都没有。
 *
 * ⚠️ **取向与机器人侧刻意相反：只记不退。** 理由是职责不同，不是偷懒：
 *   · 面板是**唯一**能把机器人和自己拉起来的东西（`/api/bridge/start`、
 *     `/api/panel/restart`）。它一退，自愈路径就断了 —— 而机器人是独立进程，
 *     跟这里退不退无关；
 *   · 机器人退出是对的：一个半坏的机器人**还在群里说话**，代价大于"停一下"；
 *     面板出错时最多是"某个页面少了数据"，它继续活着明显更好。
 *   → 所以这条差异是**有意的**，别为了"两侧对称"给它加 exit。
 *
 * ⚠️ 正文必须过 `maskSecrets`：日志经 `/api/logs` 下发，而那条路由**不鉴权**
 *   （与"panel token 为什么不能走 pushLog"是同一条理由）。异常消息里出现 URL、
 *   请求头、配置片段都是常事 —— 不脱敏等于从后门把凭据交出去。
 *
 * ⚠️ 同一条异常**连续**重复时折叠：`pushLog` 是 600 行的环形缓冲，
 *   一个每 3 秒抛一次的异常两分钟内就会把面板其它日志整片挤掉 ——
 *   那比"不记"更糟（真正的问题被淹了，而且看不出发生过什么）。
 */
const fatalFold = { key: '', n: 0 };
function onPanelFatal(kind, e) {
  const body = maskSecrets(String((e && (e.stack || e.message)) || e)).slice(0, 800);
  const key = `${kind}｜${body}`;
  if (key === fatalFold.key) { fatalFold.n += 1; return; }
  const again = fatalFold.n > 1 ? `（上一条同类连续出现了 ${fatalFold.n} 次）` : '';
  fatalFold.key = key;
  fatalFold.n = 1;
  try {
    pushLog(`✗ 面板${kind}${again}：${body}`);
  } catch { /* 兜底自己绝不能再抛：连 pushLog 都坏了就只能放弃这一次记录 */ }
}
process.on('unhandledRejection', (e) => onPanelFatal('未处理的 Promise 拒绝', e));
process.on('uncaughtException', (e) => onPanelFatal('未捕获异常', e));
