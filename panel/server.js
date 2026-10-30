/**
 * Estrella Bot Console（本地控制台）
 * 只监听 127.0.0.1，不依赖任何第三方包。
 * 提供：状态检测 / 配置读写 / 启动停止 / 连接自检 / 实时日志
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { spawn, execFile, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
// 「自定义工作台」的配置结构 —— 与机器人进程共用同一份，
// 面板绝不自己再写一份默认值/判定规则（写两份必然漂移，这是本项目反复踩过的坑）
import {
  readCustom, patchCustom, SIMILAR_THRESHOLD, similarity,
} from '../src/custom-config.js';
// 本地对话流的读盘口（第 16 轮 · H-10 第二半搬出，层号 L1 · 只依赖 paths.js）。
// ⚠️ `TRACE_SHOWN`（卡片显示几条）与 `TRACE_AGGREGATE`（会话聚合几条）**是两个数**：
//    共用会让会话列表永远只有 3 条记录里的 1~2 个会话 —— 而页面看起来是正常的。
import { readTrace, TRACE_SHOWN, TRACE_AGGREGATE } from './lib/trace-io.js';
import {
  listAutoMemory, clearAutoMemory, writeAutoMemory, readRecords, reviewRecordById, recallForPrompt,
} from '../src/memory.js';
// 结构化记忆的**判据表**（状态中文名 / 该显示哪些按钮 / 淡忘程度）。
// 面板只做渲染，一个中文名与一个上限数字都不自存 —— 全项目唯一来源是那个零依赖叶子。
import {
  RECORD_STATUS_LABELS, REVIEW_ACTIONS,
  kindShort, activationOf, looksInferred,
} from '../src/memory-record.js';
// 面板写路由的鉴权判定（B9c · AUTH-PANEL）。判定本身是纯函数、在 src/panel-auth.js 里，
// 这里只做**唯一的那次接线**：解析 token → 拦写路由 → 把 token 交给页面。
import { authDecision, presentedToken, newToken, injectPanelToken, TOKEN_ENV } from '../src/panel-auth.js';
// 「这个进程是不是本项目的机器人」的核验（B9d · G-5）。判定与解析都是纯函数，
// 只有 lsof 探测在这里 —— 于是"会不会误杀"这件事能被 smoke 直接断言。
import {
  isOurBridge, parsePgrepLine, firstPathOf, PGREP, LSOF, PGREP_LIST_FLAGS,
  // Windows（2026-10-08）：那边没有 pgrep / lsof。这两个是"**提名**"那一半的新工具；
  // "**核验**"仍然是同一个 `isOurBridge()` —— 换的只是怎么找到候选，判据一条没动。
  // ⚠️ 第 58 轮：原先还有一个 `winNodeListArgs`（只筛 `node.exe` 的那条查询）。
  //    真机实测 `powershell` 光启动就约 1030 ms，而本文件的进程快照**已经带回同样的字段** ⇒
  //    两个消费者改用同一次调用（见 `winProcessSnapshot`）。那条查询仍留在
  //    `src/bridge-proc.js` 并被 smoke 直接断言，只是 `/api/state` 不再走它。
  // ⚠️ 第 59 轮：`parseWinNodeProcesses`（吃 PowerShell 原始输出）换成
  //    `winProcFromRow` + `winRowsOf`（吃**已经反序列化好的行**）—— 快照那份本来就是对象，
  //    先前为了复用解析而 `JSON.stringify` 再 `JSON.parse` 绕一圈，纯属白烧 CPU；
  //    "字段怎么读"仍然只有 `winProcFromRow` 那一份（它也被 parseWinNodeProcesses 用着）。
  POWERSHELL, winRowsOf, winProcFromRow, encodePwshCommand,
} from '../src/bridge-proc.js';
// D19 · 机器人进程侧的实例锁。**只读**：判据（"锁长什么样"）用 `src/bridge-lock.js`
// 的 `parseLock` —— 面板不许再写一份"锁的格式"。
import { parseLock } from '../src/bridge-lock.js';
// ⚠️ `writeJsonAtomic` / `appendHistory` / `historyEntryOf` 的导入随 `writeConfig` 一起搬去了
//    `lib/config-io.js`；`CONFIG_FILE`（与 `configPath()` 同一语义）、`DOCKER_CANDIDATES`、
//    `MAX_LOG` 三个曾是**只出现在 import 行、正文零引用**的僵尸导入，已清掉
//    （判据：`grep -c` 各为 1，即仅 import 那一处；契约与测试均未提及它们）。
//    `PANEL_LOG` 起初同批被清，后来 `restartPanel()` 的看门狗重定向要写 panel.log，
//    与其在函数里再硬编码一遍同一段路径，不如把 paths.js 的常量接回来 —— 路径只推导一次。
import { readHistory, configAt, popHistory } from '../src/config-history.js';
import { thinkingIsLive } from '../src/ephemeral.js';
import { sweepStaleTemps, renameWithRetry } from '../src/atomic-write.js';
// 窗口记忆（2026-10-16）：窗口几何的**值域判据**与落点只有 `src/launch-mode.js` 一份 ——
// 面板只做"收下 → 过判据 → 写盘"，不许在这里再写一遍范围检查（两份必然漂移）。
import {
  normalizeWinState, windowStatePath, launchLogPath, readLaunchLog, launchOfConfig,
} from '../src/launch-mode.js';
// 当月账本的「今天」判据：与机器人侧共用 `dayKeyOf` 一份，不在本地再拼一个
// （本地那份月份/日不补零，9 月会算出 `2026-9-1`，与 src 侧的 `2026-09-01`
//   对不上 —— 注释自称同口径，实现却已经漂了）。
// ⚠️ 第 13 轮 H-11：它的唯一实现搬到了零依赖叶子 `src/holidays.js`
//    （`trace-stats` 只是 import，那才是能被 `reminder.js` 共享的落点）。
import { dayKeyOf } from '../src/holidays.js';
// ── 底座层（B11b-1 · AR-SERVERSPLIT）──────────────────────────────────────
// 路径 / 端口 / 运行状态 / HTTP 收发这四类东西搬到了 panel/lib/ 下，见各自的模块注释。
// ⚠️ 三根必须从这里来 —— 它们由 src/user-root.js 解析一次；写错会让整台面板
//    用着默认配置继续跑，且不会报错。
import {
  PROGRAM_ROOT, INSTALL_ROOT, USER_ROOT, PANEL_STATE_DIR, MODE, NAPCAT_DIR, DATA_DIR, UPDATE_DIR, ensureUserDirs,
  PORT, SANDBOX, NODE, BACKEND_SOURCES,
  APP_ID, APP_VERSION, APP_HOMEPAGE,
  IS_WIN,
  HOME, QWEN_SERVER, QWENCHAT_SERVER, MLX_PY,
  NAPCAT_WEBUI_PORT,
  DOCKER,
  CONFIG_FILE,
  EFFECTIVE_FILE, THINKING_FILE, HISTORY_FILE, TOKEN_FILE,
  TRACE_FILE, USAGE_DIR, USAGE_FILE_RE, SENT_DIR, SENT_FILE_RE, PIDFILE, BRIDGE_LOG, LOCAL_LOG, PANEL_LOG,
  BRIDGE_LOCK_FILE,
  DEBUG_FLAG,
} from './lib/paths.js';
import { createUpdater } from './lib/update.js';
import { uiIdentityState } from './lib/ui-identity.js';
import { makeUpdateRoute } from './lib/update-routes.js';
import { makeOfflineInstallerRoute, makeOfflinePrepareRoute } from './lib/update-offline.js';
// 假 QQ 会话（2026-10-21 · Win-v0.1.2 移植）：面板侧的进程壳，会话逻辑仍在 scripts/fake-qq.mjs。
import { fakeSnapshot, fakeStart, fakeSend, fakeStop, fakeDispose } from './lib/fake-session.js';
// ── 控制台页面是哪一套（2026-10-02 · 新版成为**唯一**控制台）───────────────
//
// 历史：旧页面曾是 `panel/parts/` 下 16 个片段按 `PARTS` 拼装的一份 HTML（`GET /`），
// 新版是"静态分发"（`GET /next`）。**现在旧页面连同它的拼装模块一起删掉了**，
// 新版搬到**根**上：`GET /` 就是入口，`/style.css` / `/app.js` / … 是它的资产。
//
// ⚠️ 资产路径 → 资产名的映射**在叶子里派生**（`assetNameForRootPath`，与白名单同源），
//    路由这里不摆第二张"允许的路径"表 —— 两张表会漂，而多一条路径是**静默**多一个入口。
import {
  readNextAsset, readMbtiArt, resolveContourMedia, parseByteRange,
  NEXT_ENTRY, NEXT_ASSETS, assetNameForRootPath, PANEL_CSP,
} from './lib/next-page.js';
import { extensionsOf } from './lib/extensions.js';
// 0.1.5 接口收尾（2026-10-28）：自定义背景存储 / 扩展包模板与文件夹打包 / GitHub 星数。
import {
  createBackgroundStore, sniffBackground, sanitizeBackgroundName, BG_LIMITS,
} from './lib/backgrounds.js';
import { packExtension, PACK_REQUEST_MAX } from './lib/ext-package.js';
import { createGithubStar } from './lib/github-star.js';
// 会话 / 存档的聚合判据（P1 分区重构）。**纯函数在 lib 里**，这里只做读盘 + 传参 ——
// 判据不落在路由里，"列表怎么算"才能被断言直接喂（本项目对判据的一贯要求）。
import { sessionsFromTrace, sessionRecordsOf, chatsFromArchive, chatDetailOf } from './lib/sessions.js';
// 控制通道（D6b · Q7 裁决①「命令文件轮询」）。下发命令 / 读回结果
// 两件事的面板侧实现都在 lib 里，这里只做读盘渲染 + 一条写路由 —— 判据一处都不重写。
import { issueCommand, clearCommand } from './lib/control.js';
// H-09（同上）：面板的全局异常兜底要把异常正文写进日志，而 `/api/logs` **不鉴权** ——
// 所以出口前必须过脱敏，且必须用唯一那份实现（与 `src/logger.js` 出口同一张特征表）。
import { maskSecrets } from '../src/egress.js';
import { readLastExit, writeLastExit, lastExitText, appendPanelEvent } from './lib/last-exit.js';
import { buildDiagnosticsBundle, buildDiagnosticsZip } from './lib/diagnostics.js';
// P3-1：实际监听端口的发现文件（`USER_ROOT/panel/.panel.json`）。
// 面板是**唯一写入方**；启动器 / Electron 壳 / 停止链 / 诊断只读。模块用 CJS 是为了同一份
// 实现也能被 Electron 主进程 require（那边不是 ESM）。
import panelDiscovery from '../src/panel-discovery.cjs';
import { state, logDropped, pushLog, clearLogs, onLog } from './lib/runtime-state.js';
// D21：`readBodyBuffer` 是"原样收字节"的读法（ZIP 上传用）—— 与 `readBody` 同模块，
// 但**不动** `readBody` 的 JSON 语义与 1e6 上限（全部写路由共用它，改它等于改全局）。
import { sendJson, readBody, readBodyBuffer, readBodyToFile } from './lib/http-io.js';
// 原生 NapCat（Windows 便携包）—— 定位 / 起停 / token / 本地二维码图。
// ⚠️ 为什么面板要知道"原生"这一支：便携包**不打 Docker**，协议端是被解压到
//    `app\napcat\` 的原生进程。面板原来只认 docker exec ⇒ 便携包上二维码永远裂图、
//    「重启协议端」点了没反应。详见那片叶子文件头的记录。
import {
  nativePresent, nativeLogFile, readNativeWebuiToken, readNativeWebuiPort, panelLocalQr,
  startNativeNapcat, restartNativeNapcat, stopNativeNapcat,
} from './lib/napcat-native.js';
import { resolveLoginQqIn } from '../src/napcat-login.js';
import { createProtocolGuard } from './lib/protocol-guard.js';
// ── `config.json` 的唯一所有者（B11b-2 · AR-SERVERSPLIT）────────────────────
// 读配置 / 写配置 / 记配置历史这三件事只有这一处实现。搬了实现就要**把契约也搬过去**
// （`check-wb` 的 3i / 3k 现在扫的是 `lib/config-io.js`），否则契约会变成永远绿的摆设。
import { readConfig, writeConfig } from './lib/config-io.js';
// ── 模型元数据与判定（B11b-2 · AR-SERVERSPLIT）──────────────────────────────
// 只 import 主文件真的用得到的那些 —— 模块里另有 15 个是它的内部实现细节
// （`ZHIPU_SELECTABLE` / `PROVIDER_DEFAULTS` / `mergeDeep` …），
// 导出一堆没人读的名字，只是把"依赖面"这个信息糊掉。
// ⚠️ `LOCAL_MODEL_PORT` / `QWENCHAT_PORT` 随这一节一起搬走了，主文件不再需要它们。
import {
  LOCAL_MODELS, LOCAL_CHANNELS, LOCAL_MODEL_SUPPORTED, LOCAL_MODEL_UNSUPPORTED_WHY,
  localChannelOf, localChannelUrl, localKeyOf,
  localModelExists, resolveLocalKey, mergeModelList, modelProviderMismatch,
  CLOUD_PRESETS, BUILTIN_MODELS, PRESET_KEYS,
  MODEL_LABELS,
  normalizeThinking, buildModelCaps, readPresets, stashCurrentPreset, readZhipuPackages,
  // 2026-10-17：降级链必须属于**当前这家**（自定义大脑与切换两条路都要用它）
  chainForProvider,
  // 2026-10-17：添加模型时按地址识别厂商 ⇒ 带出默认线路（唯一实现，前端不重算）
  defaultChainOf,
} from './lib/models.js';
// H-10 第二半：状态聚合与导出包（第 19 轮搬出）。判据由主文件注入，理由见下方接线处。
// ── 第 22 轮 H-10：审计与用量两族整块搬进 lib（实现只在新家一份）────────────
import { makeBeginAudit, readAudit, readArchive } from './lib/audit-log.js';
import { makeUsageReport } from './lib/usage-report.js';
import { makeSentReport, makeOverviewHeat, makeOverviewKpi } from './lib/sent-report.js';

import { makeStateCollector } from './lib/state-collector.js';
import { maybeSyncModelCatalog } from './lib/model-sync.js';
import { makeExportBundle, EXPORT_SCOPES } from './lib/export-bundle.js';
// 「保存配置」这条路由的逻辑（第 18 轮搬出 · L3）。四个判据由主文件注入，理由见下方接线处。
import { makeConfigRoute } from './lib/config-route.js';
// ── 网络地址判定（B11c · AR-DATADRIVEN）──────────────────────────────────────
// `providerOf` / `isLocalBase` **不再由 `lib/models.js` 转发**（谁实现谁导出）。
// 直接引真身：它同时是机器人进程判钱、查询余额判服务商、以及下发给页面的
// `provider` 字段的唯一来源 —— 一份实现，三个消费方，没有第二份可漂。
import { providerOf, isLocalBase, providerHostOk, consoleHostReject, onebotEndpointOf } from '../src/net-rules.js';
// L3 归一层（2026-10-20）：面板 HTTP 侧与机器人 WS 侧共用同一条"业务成功"判据，
// 不许一边 `status==='ok'`、另一边再判一次（两份判据必然漂）。
import { classifyOneBotReply } from '../src/backend/normalize.js';
// ── 「这笔花不花钱」的唯一判据（2026-10-07 · 接千问时从 lib/models.js 收敛到 src）──
// 与上面 net-rules 同款：**谁实现谁导出**，主文件直接引真身，不经 lib 转发。
// 加千问之前，"免费"这件事在三个地方各有一份名单；再加一家会让份数从 3 涨到 4。
// ⚠️ 它**不是**给这里新增的依赖 —— 是原来那两份（lib/models.js 的
//    `CREDIT_CLOUD_MODELS` / `isZhipuModel`）换了个住处，调用点一个没多。
import { quotaOf, quotaPlanOf, QUOTA_KIND } from '../src/free-quota.js';
// 自定义大脑（2026-10-07）：判据与物化都在 `src/custom-brain.js`（零依赖叶子），
// 这里只放**接线**（三条路由 + `/api/switch` 的那一支）—— 与 config-route 同款分工。
import {
  CUSTOM_FEATURE_KEYS, customBrainsOf, materializeBrain, newBrainId, normalizeCustomBrain,
} from '../src/custom-brain.js';
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
  ensureDocker, cachedDockerUp, invalidateDockerCache,
} from './lib/proc.js';

// `PANEL_FILE` 与上面那批**放在一起是为了对照**：它同样是"我这个文件在哪"，
// 但语义完全不同 —— 它必须是 **server.js 自己的路径**（重启看门狗要 exec 它）。
// 所以它**不许**跟着 PROGRAM_ROOT 一起搬走，也**不许**用它去做自检（见 panelInfo 的 stale）。
const PANEL_FILE = fileURLToPath(import.meta.url);

// 首次启动/只读程序目录：token 与日志必须先有 USER_ROOT/panel 可写。
ensureUserDirs();

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
  // 0.1.5：扩展包打包只构建 ZIP 字节、不落盘 ⇒ 与 /api/try 同类。
  '/api/extensions/package',
]);

/** 写路由：🔴 写配置 / 进程控制 ／ 🟡 破坏性写 */
const WRITE_ROUTES = new Set([
  // 🔴 写配置
  '/api/config',
  '/api/config/undo', // 撤销上一次保存（B10b · O-CFGHIST）—— 它会整份覆盖配置，必须受保护
  '/api/switch',
  // 自定义大脑（2026-10-07）：增 / 改 / 改名 / 删除，全都写 `config.json`。
  // ⚠️ 少了这四行的话，它们会**绕过鉴权与审计**（`isWriteRequest` 是两者的共同判据）——
  //    而症状只是"看起来能用"，不会有任何报错。新增路由时最容易漏的就是这里。
  '/api/custom-brain/save', '/api/custom-brain/rename', '/api/custom-brain/delete',
  // 🔴 进程控制
  '/api/bridge/start', '/api/bridge/stop',
  // D6b：面板 → 机器人的命令下发（中止本轮 / 重试本轮）。它是**进程控制**的一类
  // （改变机器人的行为，只是经由文件而不是信号）—— 与 start/stop 同桌才不会被漏掉鉴权。
  '/api/bridge/command',
  '/api/local-model/start', '/api/local-model/stop',
  '/api/onekey/start', '/api/onekey/stop',
  '/api/stop-all', '/api/protocol/start', '/api/napcat/restart', '/api/panel/restart',
  // P11（2026-10-19）：协议端没装时，面板自己去找 / 打开目录 ——
  // 前者会往 userdata\napcat 里**写文件**（复用安装器的放置逻辑），后者会拉起进程。
  '/api/napcat/import-auto', '/api/napcat/open-folder',
  // 退出控制台（2026-10-11 · 网页内置终端）：它**结束本进程**，是最彻底的进程控制。
  // ⚠️ 少了这一行，任何人（含 DNS Rebinding 过来的页面）都能一句话把控制台干掉，
  //    而它连审计都不会记（审计挂在 `isWriteRequest` 上的同一张表）。
  '/api/panel/quit',
  // 窗口记忆（2026-10-16）：面板页面把独立窗口的位置/尺寸存回来（下次开窗还原）。
  // 它**写盘**（panel/window-state.json）⇒ 照规矩进这张表 —— 少了这行会绕过鉴权与审计。
  '/api/panel/window',
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
  // P3 应用内更新：检查/下载/取消/安装都会写状态或启动安装器；全部走 token + 审计。
  '/api/update/check', '/api/update/download', '/api/update/cancel', '/api/update/install',
  // P4 离线更新：prepare 验签/暂存，installer 收原始 EXE 并校验；都会落盘。
  '/api/update/offline/prepare', '/api/update/offline/installer',
  // 角色卡 AI 认领：花一次模型调用并记入账本；结果只是预览，不直接改配置。
  '/api/persona/adopt',
  // 假 QQ：起 / 说 / 停 = 进程控制，且会写数据（沙箱时写临时目录）。
  // 少了这三行会绕过鉴权与审计（isWriteRequest 是两者的共同判据）。
  '/api/fake-qq/start', '/api/fake-qq/send', '/api/fake-qq/stop',
  // 0.1.5：自定义背景的上传 / 启用 / 删除都写用户数据目录（媒体文件 + index.json）。
  '/api/backgrounds', '/api/backgrounds/active', '/api/backgrounds/delete',
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
 * ⚠️ **这一道挡不住 Rebinding**：重绑之后 Host 就是 `127.0.0.1:<实际端口>`，完全合法。
 *    真正能区分"用户自己的控制台页面"与"重绑过来的页面"的是 **Origin / Sec-Fetch-Site**
 *    —— 那一道见 `sameSiteWrite()`。两道是互补的，缺任何一道这条链都还是通的。
 *
 * ⚠️ 端口必须**等于本次实际监听的端口**（P3-1 · 2026-10-24）：只判「回环 + 任意数字端口」
 *    会让同机另一个回环服务也过 Host 闸。产品形态默认监听 0（系统分配），实际端口只有
 *    在 listen 之后才知道，所以这里不能再用静态正则。
 * ⚠️ Host 缺失一律拒（fail-closed）：HTTP/1.1 必带 Host，缺它只可能是异常客户端。
 */
const PANEL_LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
/** 本次**实际**监听的端口；listen 成功前为 0（此时所有 Host 一律拒）。 */
let ACTUAL_PORT = 0;

function isLoopbackName(name) {
  return PANEL_LOOPBACK_HOSTS.has(String(name || '').toLowerCase());
}

/** Host 必须是回环名 + **本次实际端口**；缺端口、错端口、任意端口都不算。 */
function isLoopbackHost(raw) {
  if (!raw || !ACTUAL_PORT) return false;
  let u;
  try { u = new URL(`http://${raw}`); } catch { return false; }
  return isLoopbackName(u.hostname) && Number(u.port) === ACTUAL_PORT;
}

/** Origin 的判据与 Host 同源：回环名 + 本次实际端口。 */
function isLoopbackOrigin(u) {
  return isLoopbackName(u.hostname) && Number(u.port) === ACTUAL_PORT;
}

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
  // ④ **控制台 ≠ 接口地址**（2026-10-07 · 接千问时补）。
  // ⚠️ 它**不是** ③ 的兜底，而是 ③ 判不到的那一类：千问的控制台在 `platform.qianwenai.com`，
  //    不属于任何一家（`providerOf()` 返回 `other`），而 `providerHostOk('other')` 恒为 true
  //    ⇒ ③ 对它完全不生效，地址会一路存下去。
  //    然后表现是：切过去看着像成功了、模型名也填对了，**每次请求都失败** ——
  //    而错误来自一个根本没在提供 API 的网页服务器。
  const consoleWhy = consoleHostReject(text);
  if (consoleWhy) return consoleWhy;
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
    return isLoopbackOrigin(u);
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
/** P11：「自动查找并安装」的总时限（扫目录 + 复制最多 90MB，正常几秒级）。 */
const NAPCAT_IMPORT_TIMEOUT_MS = 180000;
/** 清掉占用端口的旧进程之后，等它真的把端口让出来。 */
const PORT_RELEASE_WAIT_MS = 2500;
/** 协议端 `get_login_info` 就绪探测：单次超时 / 两轮之间的间隔 / 总期限。 */
const ONEBOT_PROBE_TIMEOUT_MS = 2500;
const ONEBOT_PROBE_GAP_MS = 2000;
const ONEBOT_READY_DEADLINE_MS = 60000;

/**
 * 协议端**探测地址**的唯一取法：配置里机器人连的那条（判据本体住 `src/net-rules.js`
 * 的 `onebotEndpointOf()`，本函数只是"从配置取一份"的薄接线，不含任何判断）。
 *
 * ⚠️ 这个文件里原本有五处把 `3000` / `3001` 直接写在调用上：`apiGroups` 与启动等待打的是
 * HTTP 3000，`autoStartNapcatIfInstalled`、`apiNapcatRestart` 与 SSE 心跳判的是 WS 3001
 * —— 而 SSE 那颗还把结果当 `proto` 字段**每 3 秒推给页面**。写死的后果不是报错，而是
 * **换了端口的部署上面板连探都不探**：屏幕上「协议端」永远"断"、「登录账号」永远"未登录"，
 * 机器人却照常收发（用户在真机上报过一次一模一样的形状，那一半由 §96⑧ 钉在
 * `state-collector.js` 上）。**§96⑧ 只扫那一个文件**，所以本文件这一半长期没有闸 ——
 * 现在由 §96⑧b 盯着这里，配 `win-53.mjs` 的 M11–M13 三条变异。
 */
const onebotProbePorts = () => onebotEndpointOf(readConfig()?.onebot);

/**
 * 协议端**进程级**守护（2026-10-22 · 群友改版回执）。
 *
 * `src/onebot.js` 的看门狗只管连接：心跳停摆就重连。可如果 NapCat 进程整个没了，
 * 重连永远失败，机器人会一直哑着。这里补的是"进程不在了就按冷却拉回来"。
 *
 * ⚠️ 只在 Windows 且已安装原生协议端时启用；macOS / Docker 那条链一行都不碰。
 * ⚠️ 停止链必须先 `stop()` 再停协议端，否则下一拍会把它拉回来（"关不掉"）。
 */
// 启动偏好只读一次：autoProtocol 决定启动时是否拉起协议端与守护（面板重启后生效）。
const LAUNCH_PREFS = launchOfConfig(readConfig());
const protocolGuard = createProtocolGuard({
  probeAlive: IS_WIN && nativePresent()
    ? async () => {
      const { wsPort } = onebotProbePorts();
      try {
        // 未登录时 WS 端口还没开，但 WebUI(6099) 已经起来了 —— 只看 WS 会把
        // "正在等扫码"误判成"进程死了"，于是再起一个 NapCat（抢端口/掉登录态）。
        const [ws, webui] = await Promise.all([portOpen(wsPort), portOpen(NAPCAT_WEBUI_PORT)]);
        return ws || webui;
      } catch { return null; }
    }
    : null,
  launch: IS_WIN && nativePresent()
    ? async () => startNativeNapcat({ qq: knownLoginQq().qq })
    : null,
  readOnebotState: () => (readEffective()?.onebotHealth?.botOffline === true ? 'offline' : ''),
  log: (m) => pushLog(m),
});
if (IS_WIN && nativePresent() && LAUNCH_PREFS.autoProtocol !== false) protocolGuard.start();
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
/* 入口页的 ETag 要跟 token 走：同一份 HTML 注入不同 token 后是两个表示。 */
const PANEL_TOKEN_TAG = createHash('sha1').update(PANEL_TOKEN.token).digest('hex').slice(0, 8);

/* 静态资产的 gzip / ETag 进程内缓存。键 = 资产名；内容指纹（mtimeMs+size）变了才重算。 */
const ASSET_BUNDLES = new Map();

function assetHttpBundle(asset, body) {
  const isEntry = asset.name === NEXT_ENTRY;
  const etag = isEntry ? asset.etag.slice(0, -1) + '|t' + PANEL_TOKEN_TAG + '"' : asset.etag;
  const hit = ASSET_BUNDLES.get(asset.name);
  if (hit && hit.etag === etag) return hit;
  const buf = Buffer.from(body, 'utf8');
  const bundle = {
    etag,
    gzipEtag: etag.slice(0, -1) + '|gz"',
    buf,
    gzip: gzipSync(buf, { level: 6 }),
  };
  ASSET_BUNDLES.set(asset.name, bundle);
  return bundle;
}

function warmAssetBundles() {
  for (const name of Object.keys(NEXT_ASSETS)) {
    try {
      const asset = readNextAsset(name);
      const body = asset.name === NEXT_ENTRY ? injectPanelToken(asset.raw, PANEL_TOKEN.token) : asset.raw;
      assetHttpBundle(asset, body);
    } catch { /* 单个资产坏了不阻断启动；请求时仍会报 404/500 */ }
  }
}

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
let lastExitWritten = false;

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
    const t = fileMtimeMs(path.join(PROGRAM_ROOT, rel));
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
  const lastExit = readLastExit(path.join(PANEL_STATE_DIR, '.last-exit.json'));
  return {
    pid: BOOT.pid,
    bootedAt: BOOT.at,
    uptimeMs: Date.now() - BOOT.at,
    codeMtime: Math.round(BOOT.codeMtime),
    codeMtimeNow: Math.round(now),
    stale: BOOT.codeMtime > 0 && now > 0 && now - BOOT.codeMtime > 1,
    lastExit: lastExit || null,
    lastExitText: lastExitText(lastExit),
  };
}

// ── 模型规格 / 各家大脑预设 / 智谱资源包 / 模型名册（搬去 `lib/models.js`）──────
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
 * 自启要拿去快速登录的 QQ 号。判据只有一份（`src/napcat-login.js`），
 * 这里只负责告诉它 NapCat 的 config 在哪；读不到就走二维码。
 */
function knownLoginQq() {
  try {
    return resolveLoginQqIn(path.join(NAPCAT_DIR, 'config'));
  } catch {
    return { qq: '', from: '' };
  }
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
    return fs.readFileSync(path.join(NAPCAT_DIR, '.webui_token'), 'utf8').trim();
  } catch {
    return '';
  }
}

// ---------- NapCat WebUI（换二维码要走它，OneBot 那边没有这个能力）----------

/**
 * 取 NapCat 的 WebUI token。
 *
 * 顺序是刻意的（2026-10-12）：
 *   ① **原生**（Windows 便携包）：`app\napcat\config\webui.json` —— NapCat 自己写的那份，
 *      永远是最新的。以前没有这一支，于是便携包上"读不到 token"是必然，不是偶发。
 *   ② **容器**：`docker exec … grep webui.json`（容器重建后 NapCat 可能换过 token，
 *      项目里的 `.webui_token` 只是当初 bootstrap 写下的，两边不一致时会 Unauthorized）。
 *   ③ 兜底：本地 `.webui_token`。
 */
async function napcatWebuiToken() {
  const local = readNativeWebuiToken();
  if (local) return local;
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
/**
 * NapCat WebUI 的**候选端口**（2026-10-13 · 群友真机资料补充）。
 *
 * ⚠️ 为什么不能只读 webui.json 里的端口：NapCat 探到 6099 被占时会 **+1 重试**
 *    （源码 hm()，上限 +100），而且**不回写配置** ⇒ webui.json 里始终是 6099，
 *    实际监听可能在 6100。只认配置就会去敲一个没人的门，症状是"连不上"。
 *    群友实测：WebUI 由 **QQ 进程**监听（NapCat 把 hook 注进 QQ），端口漂移真实存在。
 * 候选顺序：配置里的端口优先，再补 4 个近邻（足以覆盖真实漂移，又不把探测拖长）。
 */
function webuiPortCandidates() {
  const base = readNativeWebuiPort() || NAPCAT_WEBUI_PORT;
  const out = [base];
  for (let i = 1; i <= 4; i += 1) out.push(base + i);
  return out;
}

async function refreshNapcatQrcode() {
  const token = await napcatWebuiToken();
  if (!token) {
    // 便携包（Windows）上没有 Docker，别再拿"容器"吓用户 —— 真因是协议端没装/没起
    return {
      ok: false,
      degrade: true,
      msg: IS_WIN && !nativePresent()
        ? (MODE === 'installed'
          ? '读不到 NapCat 的 token —— 协议端未安装：打开「总览 → 运行 → 运行状态」，点『自动查找并安装』；找不到就点『打开协议端文件夹』把文件拖进去'
          : '读不到 NapCat 的 token —— 协议端还没装好（先双击「一键安装.bat」）')
        : '读不到 NapCat 的 token —— 协议端没在运行，换不了码',
    };
  }

  const ports = webuiPortCandidates();
  const hash = createHash('sha256').update(token + '.napcat').digest('hex');
  let login = null;
  let usedPort = 0;
  for (const port of ports) {
    login = await httpJson(port, '/api/auth/login', { body: { hash }, timeout: HTTP_TIMEOUT_MS });
    usedPort = port;
    // 端口上**没有任何东西应答**才换下一个；一旦对方答了（哪怕是拒绝），就按它的答复走
    if (login.status !== 0) break;
  }
  const cred = login?.data?.data?.Credential || '';
  if (!cred) {
    const m = login?.data?.message || `HTTP ${login?.status}`;
    if (login?.status === 0) {
      return {
        ok: false,
        degrade: true,
        msg: `连不上 NapCat 的 WebUI（试过 ${ports.join(' / ')} 端口）—— 协议端可能刚起、还没开 WebUI。\n` +
             '点「重启协议端」重拉一次，几秒后再试；或看「终端」页的实时输出。',
      };
    }
    return {
      ok: false,
      msg: m === 'token is invalid'
        ? 'WebUI 凭证对不上（协议端被重建过）—— 点「重启协议端」重拉一次再试'
        : `NapCat 登录失败：${m}`,
    };
  }

  const r = await httpJson(usedPort, '/api/QQLogin/RefreshQRcode', {
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
  const bad = srcs.filter((s) => !s.startsWith(NAPCAT_DIR + path.sep));
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
// ⚠️ 2026-10-07：注入的**判据**从两样（`CREDIT_CLOUD_MODELS` + `isZhipuModel`）换成一样
//    （`quotaOf`）。理由：那两样是"智谱专用"的形状，加千问就得再注入第三样；
//    换成 `quotaOf(provider, model)` 之后，**加多少家都不用动这里**。
//    注入这个形状本身保留（不让 lib 直接 import src），理由同上。
const usage = makeUsageReport({
  USAGE_DIR, USAGE_FILE_RE, MODEL_LABELS,
  quotaOf, QUOTA_KIND, isLocalBase, dayKeyOf, USAGE_SOURCES,
});
const { listUsageFiles, readUsage, resetUsageCache } = usage;
// 发言账本：与用量账本分开读、分开缓存；写口只在机器人进程（`src/sent-stats.js`）。
const sent = makeSentReport({ SENT_DIR, SENT_FILE_RE, dayKeyOf });
const { readSent } = sent;
const heatOf = makeOverviewHeat({ dayKeyOf, weeks: 53 });
const kpiOf = makeOverviewKpi({ dayKeyOf, days: 14 });

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
  readSent,
  // B2（第 53 轮）：Windows 上没有 `vm_stat`/`sysctl`/`ps -Ao` ⇒「健康与占用」那张卡片
  // 在那边整张是 0。这份快照就是补它的。**注入而不是搬进 collector** 的理由与
  // `readUsage` / `countBridgeInstances` 同款：取数要 IO 与缓存（起 PowerShell、限频），
  // 而 collector 只该拿现成的数据去算。
  // ⚠️ 第 58 轮：函数名从 `winMemorySnapshot` 改成 `winProcessSnapshot` —— 它现在**不止是内存**，
  //    还是「实例数」（`findBridgeProcessesWin`）的唯一取数口。两个消费者共用一次调用。
  winMemory: winProcessSnapshot,
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
 * 读一个日志文件的**最后 n 行**（同步、读不到就给空串）。
 *
 * 唯一用途：`startBridge()` 的"存活确认"要把"为什么一启动就死"随响应回给界面
 * —— 而那段原因此刻**只存在于 bridge.log 里**。返回原文，脱敏交给调用方
 * （出口只有一处需要脱，放在这里等于把"谁负责脱敏"这件事打散）。
 */
function readLogTail(file, n = 8) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).slice(-n).join('\n').slice(0, 900);
  } catch {
    return '';
  }
}

/**
 * 扫出系统里在跑的机器人进程（排除自己）。
 *
 * pidfile 只记录"我们启动的那一个"。控制台被强杀、或 pidfile 没来得及写时，
 * 旧进程还活着但 pidfile 已经不可信 —— 这时再点"启动"就会起出第二个实例，
 * **两个实例都订阅 OneBot，同一条群消息会被回复两次**。
 * 所以凡是要判断"到底有没有在跑"，都得落到系统进程上，不能只看 pidfile。
 */
/**
 * 安装版的进程认领根：current + previous。
 *
 * 升级后旧版机器人可能仍在跑（它从旧版本目录的 runtime/node 启动），而安装器/
 * 面板必须认得出它才能停掉；只认 PROGRAM_ROOT 会把它判成"不是我们的"。
 * dev/portable 没有 current.json ⇒ 只认 PROGRAM_ROOT，行为不变。
 */
const BRIDGE_ROOTS = (() => {
  try {
    const cur = JSON.parse(fs.readFileSync(path.join(INSTALL_ROOT, 'current.json'), 'utf8'));
    const roots = [cur.current, cur.previous]
      .filter((v) => typeof v === 'string' && v)
      .map((v) => path.join(INSTALL_ROOT, 'versions', v, 'app'));
    return roots.length ? [...new Set(roots.map((p) => path.resolve(p)))] : [PROGRAM_ROOT];
  } catch {
    return [PROGRAM_ROOT];
  }
})();

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
  // Windows（2026-10-08）：那边没有 pgrep / lsof，提名改问 PowerShell 要 node 进程表。
  // ⚠️ 结构一步没变 —— **提名宽 → 逐个核验 → 不过就不杀**。换的只是"怎么找到候选"。
  if (IS_WIN) return findBridgeProcessesWin(exceptPids);

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
      roots: BRIDGE_ROOTS,
    });
    if (verdict.ours) { out.push(hit.pid); continue; }
    // 跳过的也要说一句 —— 否则"我以为它该被清理、它没动"又会变成一个静默失效
    pushLog(`· 不做清理：pid ${hit.pid} 命令行里提到 src/index.js，但核验未过（${verdict.reason}）—— 不是本项目的机器人`);
  }
  return out;
}

/**
 * `findBridgeProcesses()` 的 Windows 一半（2026-10-08 · Windows 适配）。
 *
 * 为什么是"第二个函数"而不是把上面那段改成平台无关：提名的**工具形状**在两边的确不同
 * （BSD/procps 的 `pgrep -f` vs PowerShell 的 `Get-CimInstance`），硬揉成一个函数只会
 * 让两边都难读。但**核验那一步共用同一个 `isOurBridge()`** —— 这才是判据的唯一实现，
 * 上面 3h 那族契约盯的也正是它。
 *
 * ⚠️ 与 macOS 一半的**唯一**实质差别：这里 `cwd` 只能传空串。
 *    Windows 没有"读别的进程工作目录"的公开手段（`Win32_Process` 就没这个字段），
 *    所以 `isOurBridge` 在拿不到 cwd 时改用**绝对入口路径落在本仓内**这条正向凭据
 *    （见 `src/bridge-proc.js` 判据③）。
 *    ⇒ **已知限制**：在 Windows 上用 `npm start`（相对入口）起的机器人，面板认不出来，
 *      也就是"实例数"看不到它、「停止机器人」停不掉它。多实例保护不受影响 ——
 *      那由机器人自己的 `.bridge.lock`（按 pid）兜着。这一条写进了用户手册。
 */
/**
 * Windows 上「整机内存 + 全量进程表」的**唯一一份**快照（第 53 轮 B2 立 · 第 58 轮改成一份供两处用）。
 *
 * 为什么要有它：Windows 上没有 `vm_stat` / `sysctl` / `ps -Ao`（那些是 macOS 专有），
 * 于是「健康与占用」那张卡片在那边**整张都是 0** —— 那不是"占用很低"，是"根本没采到"。
 *
 * ⚠️ **第 58 轮 · 真机实测后的一处改正**（Windows 11 ARM64 + UTM，数据见 §5-A）：
 *    以前这里与「实例数」**各起一次 `powershell`**，而真机量到的数是
 *    **`powershell -NoProfile -Command "exit 0"` 光启动就要约 1030 ms** ——
 *    两次调用 ≈ 2 秒是白花的。而这份快照**本来就枚举了全量进程、并且带 `CommandLine`**，
 *    识别机器人要的字段（PID / 可执行路径 / 命令行）它一个不缺。
 *    ⇒ 改成**一次调用同时供两个消费者**：
 *      · 「健康与占用」→ `winMemoryOf(snapshot)`（`panel/lib/state-collector.js`）；
 *      · 「实例数」    → `snapshot.procs` 里筛 `node.exe`，再交给**同一个**
 *        `winProcFromRow`（识别判据仍然只有那一份；第 59 轮把"字段怎么读"从
 *        `parseWinNodeProcesses` 里抽出来，两条路共用同一份）。
 *    收益：`/api/state` 从「两次 PS」降到「一次 PS」，并额外省掉一次"只筛 node.exe"的查询。
 *
 * ⚠️ **单飞（`winSnapInflight`）是必需的，不是保险**：一次 `/api/state` 会**同时**要这两份读数，
 *    若只有 TTL 缓存，两个并发调用会双双 miss、双双起 powershell —— 正好把上面省的又花回去。
 *
 * 四条纪律：
 *   · **15 秒 TTL 缓存**（与 `countBridgeInstances` 同一量级；前端 3 秒轮询会命中缓存）；
 *   · `-EncodedCommand`（与进程枚举同一套理由：没有任何字符需要转义）；
 *   · 走 `sh()` ⇒ 自动带 `windowsHide`（§97）—— 否则每取一次就闪一个黑窗；
 *   · 拿不到就返回 `null`，**绝不编一个 0 出来**（"采不到"与"占得少"是两件事）。
 *
 * ⚠️ 口径：`os` 那两个数是**整机物理内存**（TotalVisibleMemorySize / FreePhysicalMemory，
 *    单位 KB），`procs` 是**按进程**的工作集。换算与分类都在 `panel/lib/proc.js` 的
 *    `winMemoryOf()` 里（纯函数，能在 macOS 上被直接断言）。
 */
let winSnapCache = { at: 0, data: null };
let winSnapInflight = null;
/** 快照的**世代号**：`invalidateBridgeInstances()` 每次 +1，用来作废"在飞的那一趟"（见那里）。 */
let winSnapGen = 0;
async function winProcessSnapshot(maxAgeMs = 15000) {
  if (!IS_WIN) return null;
  if (winSnapCache.data && Date.now() - winSnapCache.at < maxAgeMs) return winSnapCache.data;
  if (winSnapInflight) return winSnapInflight;

  const gen = winSnapGen; // 起飞时的代号；落地时若已被作废就不许写缓存
  const flight = (async () => {
    // `ProcessId` / `ExecutablePath` 是为「实例数」那一侧加的：`isOurBridge` 的三条判据
    // 都要它们，而原来那份只筛 node.exe 的查询正是为了拿这两个字段。
    const ps = '$os = Get-CimInstance Win32_OperatingSystem '
      + '| Select-Object TotalVisibleMemorySize,FreePhysicalMemory; '
      + '$ps = Get-CimInstance Win32_Process '
      + '| Select-Object ProcessId,Name,ExecutablePath,CommandLine,WorkingSetSize; '
      + '[pscustomobject]@{ os = $os; procs = $ps } | ConvertTo-Json -Compress -Depth 4';
    let data = null;
    try {
      const r = await sh(POWERSHELL, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodePwshCommand(ps)], 15000);
      if (r.ok) {
        try { data = JSON.parse(r.stdout.trim() || 'null'); } catch { data = null; }
      }
    } catch {
      data = null; // 起不来就报"采不到"，不猜
    }
    // ⚠️ 只有"这一趟还没被作废"才准写缓存 —— 否则它会把刚被 `invalidateBridgeInstances()`
    //    清掉的缓存又写回去（那正是"刚起好机器人、实例数却还是 0"的另一条路）。
    if (gen === winSnapGen) winSnapCache = { at: Date.now(), data };
    return data;
  })();
  winSnapInflight = flight;
  try {
    return await flight;
  } finally {
    // ⚠️ **必须清，而且必须在 finally 里清**（第 59 轮补的一处真缺陷）：
    //    上面那句 `winSnapInflight = null` 原先写在 IIFE 内部、且**不在 finally 里** ——
    //    一旦 `sh()` 抛的是 try/catch 没接住的东西（或将来有人在里面加了会抛的代码），
    //    `winSnapInflight` 就会**永久停在那个 rejected promise 上**，
    //    于是 Windows 上之后每一次 `/api/state` 都直接失败、"健康与占用"永远采不到，
    //    而界面上看不出这是"卡住了"还是"真的没数据"。
    //    ⚠️ 只清"自己还是当前那一飞"的那一个 —— 并发下别把别人那一飞清掉。
    if (winSnapInflight === flight) winSnapInflight = null;
  }
}

async function findBridgeProcessesWin(exceptPids = []) {
  // ⚠️ 第 58 轮：**不再单独起一次 PowerShell**。真机实测 `powershell` 光启动就约 1030 ms，
  //    而这里要的三个字段（PID / 可执行路径 / 命令行）内存快照那一次**已经全带回来了** ⇒
  //    两个消费者共用同一份（见 `winProcessSnapshot` 的注释与那里的实测数据）。
  //    ⚠️ 解析仍然交给**同一个** `winProcFromRow`：换平台时最容易犯的错就是
  //    "顺手再写一份解析/判据"，那会让"核验严"这道防线多出第二套语义（本项目头号纪律）。
  // ⚠️ 第 59 轮：这里原先是 `parseWinNodeProcesses(JSON.stringify(nodeRows))` ——
  //    为了复用那份解析，先把已经反序列化好的行**序列化回字符串**再让对方解析一遍。
  //    整张进程表（Windows 上常 200+ 行）每 15 秒白烧一次 stringify + parse。
  //    现在直接对行做映射，"字段怎么读"仍然是同一个 `winProcFromRow`。
  const snap = await winProcessSnapshot();
  const nodeProcs = winRowsOf(snap?.procs)
    .filter((row) => String(row?.Name ?? '').toLowerCase() === 'node.exe')
    .map(winProcFromRow)
    .filter(Boolean);
  const out = [];
  for (const proc of nodeProcs) {
    if (proc.pid === process.pid || exceptPids.includes(proc.pid)) continue;

    const verdict = isOurBridge({ cmd: proc.cmd, cwd: '', execPath: proc.execPath, roots: BRIDGE_ROOTS });
    if (verdict.ours) { out.push(proc.pid); continue; }

    // 提名池是整个 node 进程表，比 pgrep 那一侧宽得多（那边至少还要求命令行里提到入口）。
    // 所以这里**先过滤再记日志** —— 否则用户每 15 秒会看到几十行"不做清理"
    // 把真正的告警冲掉。命令行里根本没提入口的，本来就不该被提名。
    if (!/src[\\/]index\.js/.test(proc.cmd)) continue;
    // 跳过的也要说一句 —— 否则"我以为它该被清理、它没动"又会变成一个静默失效
    pushLog(`· 不做清理：pid ${proc.pid} 命令行里提到 src/index.js，但核验未过（${verdict.reason}）—— 不是本项目的机器人`);
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
  // ⚠️ 第 58 轮：**必须连进程快照一起失效**。
  //    「实例数」现在从 `winProcessSnapshot()` 那份 15 秒 TTL 的快照里数（见那里的注释），
  //    而本函数正是"机器人刚起 / 刚停"那一刻被调用的（本文件 3 处 start、2 处 stop）。
  //    只失效 `bridgeInstCache` 的话，下一次 `/api/state` 会拿**起停之前**那张进程表去数 ——
  //    真机实测（Windows 11 ARM64）：面板刚起好机器人，`instances` 却一直报 0，
  //    直到 15 秒后快照自然过期才变 1。这正是本条要挡的那个"读数慢一拍"。
  winSnapCache = { at: 0, data: null };
  // ⚠️ 第 59 轮：**只清缓存还不够，还得让"在飞的那一趟"作废**。
  //    真机实测 `powershell` 光启动就约 1030 ms —— 也就是说起/停那一刻，
  //    很可能有一趟快照**正在飞**。它的结果是按"起飞时"的进程表采的，
  //    而它降落时会**照写 `winSnapCache`** ⇒ 上面那句"清缓存"当场被它覆盖回去，
  //    于是第 58 轮修掉的"刚起好机器人、instances 却报 0"又从另一条路回来了
  //    （只是这次只持续到那一趟落地，比 15 秒短、更难复现）。
  //    ⇒ 用**世代号**：失效 +1，在飞的那趟记下自己起飞时的代号，
  //      落地时只有代号没变才准它写缓存。
  winSnapGen += 1;
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

/**
 * 「起完等一会儿，再回看它死没死」的窗口（ms）。
 *
 * 为什么需要这个窗口：面板**看得见进程起没起来、看不见它有没有活下来**。
 * 而"起来之后立刻死掉"恰恰是配置类错误最典型的形态（白名单为空、Key 没填、
 * 端口被占），并且它是**静默**的 —— 界面报成功、群里永远没有回复。
 *
 * 1200 是**经验值**：真机上从启动到 `config.js` 抛错约 200~600ms，1.2 秒足够盖住
 * "启动即死"的全部形态，又不至于让「启动」按钮明显变卡。调大只会让失败更晚被发现。
 */
const BRIDGE_ALIVE_PROBE_MS = 1200;

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
    // ⚠️ 这一行的两个选项各自都有理由，别只看见一个（2026-10-09 · 第 53 轮）：
    //
    //   ① 入口必须是**绝对路径**（B3）。Windows 上拿不到别的进程的 cwd
    //      （`Win32_Process` 没有这个字段），于是认领判据只剩
    //      `absEntryInRoot()`（`src/bridge-proc.js`），而它**只认绝对入口**。
    //      用相对入口的后果是"面板认不出自己刚起的机器人"⇒「实例数」恒 0、
    //      孤儿清理也看不见它 —— 而且**一个字都不报**。
    //      ⚠️ 这件事以前写在 bridge-proc.js 的注释里，措辞是「用 `npm start`（相对入口）
    //         起的机器人面板认不出来」—— 但**面板点按钮走的正是相对入口**，
    //         所以那条"已知限制"实际盖住的是**主路径**，不是边角情况。
    //
    //   ② `windowsHide: true`（B1）。面板自己没有控制台（win-launcher 用
    //      `detached + windowsHide` 起它），不隐藏就会为机器人**多弹一个常驻黑窗**。
    const entry = path.join(PROGRAM_ROOT, 'src', 'index.js');
    child = spawn(NODE, [`--max-old-space-size=${BRIDGE_MAX_OLD_SPACE_MB}`, entry], {
      cwd: PROGRAM_ROOT,
      detached: true, // 脱离控制台，控制台关掉了它也能活
      windowsHide: true,
      env: {
        ...process.env,
        FORCE_COLOR: '0',
        QQBOT_LOG_LEVEL: readDebugFlag() ? 'debug' : 'info',
        QQBOT_USER_ROOT: USER_ROOT,
        QQBOT_MODE: MODE,
        QQBOT_CONFIG: CONFIG_FILE,
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
    // 也给 lastExit 留一份：下面那道"存活确认"读的就是它，两个失败路径不必各判一次。
    state.lastExit = { code: null, signal: null, at: Date.now(), error: e.message };
    state.bridge = null;
    state.bridgePid = null;
    try { fs.unlinkSync(PIDFILE); } catch {}
  });

  // ── 存活确认（2026-10-09 · 第 54 轮 · 真机首跑 P0）───────────────────────────
  //
  // 上面那些只证明"进程被起出来了"。`src/config.js` 有一道 fail-closed 的白名单校验
  // （白名单为空且没显式开 allowAllWhenEmpty ⇒ **启动瞬间 throw**，这是有意保留的正确行为），
  // 而它抛出的那段中文错误只会落进 `bridge.log` —— 界面显示「已启动，pid 1234」，
  // 用户去群里等一个永远不来的回复。真机首跑就是这么被卡住的。
  //
  // ⚠️ 为什么是「**等一小会儿再回看日志**」而不是「spawn 之前先 loadConfig() 预检一遍」
  //    （报告里给的第一条建议就是预检，这里刻意没照做，两个理由都写下来）：
  //      ① **分层**：`src/config.js` 是重型模块（读 env、拼整份配置、引 logger→egress），
  //         而 `panel/` 这一层只许引零依赖叶子（见 `lib/paths.js` 的说明）。
  //         真引进来等于把整份配置拖进面板进程，还破了这条分层。
  //      ② **覆盖面**：预检只盖得住"白名单"一种死法；事后读日志盖的是**全部**死法
  //         （缺依赖 / 端口被占 / 代码抛错），而且**不必在面板里复写任何一条业务规则**
  //         —— 复制一份白名单判据，就一定会与机器人那一份漂开。
  await new Promise((s) => setTimeout(s, BRIDGE_ALIVE_PROBE_MS));
  const died = state.lastExit || (!pidAlive(child.pid) ? { code: null, signal: null } : null);
  if (died) {
    const detail = maskSecrets([died.error, readLogTail(BRIDGE_LOG, 8)].filter(Boolean).join('\n'));
    const how = died.error
      ? '机器人没能起来'
      : `机器人启动后立刻退出（${died.code === null || died.code === undefined ? '被信号结束' : `退出码 ${died.code}`}）`;
    pushLog(`✗ ${how} —— 这次不报"成功"了，原因随响应一起回给界面`);
    return {
      ok: false,
      msg: detail
        ? `${how}，原因：\n${detail}`
        : `${how}，而日志里没有更多线索 —— 请检查 app\\config.json 是否填全了。`,
    };
  }

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

  // 先走优雅退出（Windows 上 `taskkill /T` 不投递 JS 信号，补写会整段丢）：
  // 写一条 shutdown 控制命令 → 每 200ms 看进程是否消失，最多 6 秒。
  let how = 'kill';
  const cmd = issueCommand('shutdown');
  if (cmd.ok) {
    for (let i = 0; i < 30 && all.some((p) => pidAlive(p)); i += 1) {
      await new Promise((s) => setTimeout(s, 200));
    }
    if (!all.some((p) => pidAlive(p))) {
      how = 'shutdown';
    } else {
      // 强杀前把这条没被执行的命令清掉：否则下一次启动会"起来即退出"。
      clearCommand(cmd.id);
    }
  }

  // 优雅退出没成（或命令发不出去）：并行收。killTree 自带 TERM →（等 grace）→ KILL，
  // 串行做会变成"点一次停止等 3 秒 × N"。
  if (all.some((p) => pidAlive(p))) {
    await Promise.all(all.map((p) => killTree(p, KILL_GRACE_MS)));
  }
  for (let i = 0; i < 20 && all.some((p) => pidAlive(p)); i += 1) {
    await new Promise((s) => setTimeout(s, 300));
  }
  const left = all.filter((p) => pidAlive(p));
  if (how !== 'shutdown') how = left.length ? 'forced' : 'kill';

  state.bridge = null;
  state.bridgePid = null;
  try { fs.unlinkSync(PIDFILE); } catch { /* 无所谓 */ }
  invalidateBridgeInstances();

  if (left.length) {
    return { ok: false, msg: `停止信号已发，但 ${left.join(', ')} 仍在，可能需要强制结束` };
  }
  return {
    ok: true,
    how,
    // 如实报数：清掉 1 个和清掉 4 个是两件事，藏起来就等于把这次事故又变成隐形的
    msg: (all.length > 1
      ? `机器人已停止（共清掉 ${all.length} 个实例：${all.join(', ')}`
      : `机器人已停止（pid ${all[0]}`)
      + `，方式：${how === 'shutdown' ? '优雅退出（补写已完成）' : how === 'kill' ? '信号停止' : '强制结束'}）`,
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
  // ⚠️ 平台守卫**只写在这一处**（2026-10-09 · 第 53 轮 · B6）：本机模型那套是
  //    Apple Silicon 专用的（MLX 模型格式 + mlx_lm.server / QwenChat），
  //    Windows 上没有对应实现。这个函数是**唯一的启动入口**（一键启动 / 切换大脑 /
  //    `/api/local-model/start` 三条路都汇到这里），所以守在这儿一处就够 ——
  //    在三个调用点各判一次，迟早会出现"新加了一条路、忘了判"。
  //    返回的是一句**能照着做**的话（去自定义大脑接 OpenAI 兼容端点），不是"不支持"。
  if (!LOCAL_MODEL_SUPPORTED) return { ok: false, msg: LOCAL_MODEL_UNSUPPORTED_WHY };

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
      windowsHide: true, // 同 startBridge：面板没有控制台，不隐藏就会多弹一个黑窗
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

/**
 * 安装器/启动器唯一的就绪信号（P2）。
 *
 * 只读、无鉴权（仅 localhost）；**不读配置、不依赖机器人**，所以配置坏了也能答。
 * 不返回路径、token、Key、群号 —— 启动器只拿 appId/version 判断“起来的是不是这一版”。
 */
async function apiHealth(req, res, url) {
  void req;
  void url;
  // 规格 §7.4：启动成功 = 200；正在退出 = 503（启动器只把 200+身份匹配当成健康）。
  const body = {
    ok: !PANEL_SHUTTING_DOWN,
    appId: APP_ID,
    version: APP_VERSION,
    pid: process.pid,
    uptimeSec: Math.floor(process.uptime()),
  };
  return sendJson(res, body, PANEL_SHUTTING_DOWN ? 503 : 200);
}

async function apiState(req, res, url) {
  /* 用户"打开控制面板"这件事在真机上是**反复发生**的（页面刷新 / 重开标签页），
     而面板进程可能已经跑了好几天。所以除了启动那一次，这里也顺带跑一次对账 ——
     6 小时节流在模块里，**不节流的代价是每 3 秒读一遍配置**。
     ⚠️ 不 await：`/api/state` 是每 3 秒轮询一次的读路由，不能让它等 IO。
     ⚠️ 它自己也**永不抛**（内部 try/catch），不会把读路由带崩。
     ⚠️ 沙箱里不跑 —— 理由同启动处那条（它会写 config.json，而测试用的是真机配置）。 */
  if (!SANDBOX) maybeSyncModelCatalog();
  // P11：协议端"装没装 + 该放哪儿"必须**每次轮询都现算**（页面每 3 秒拉一次），
  // 不能只在启动时 pushLog 一句 —— 用户装好后不重启面板也要立刻看到状态翻转。
  const stateBody = await collectState();
  const heat = heatOf(stateBody);
  return sendJson(res, {
    ...stateBody,
    /* 53 周发言网格与 KPI 近 14 天序列都在后端生成：日期键只由
       `src/holidays.js` 一份实现产生，前端不再自己拼 `YYYY-MM-DD`（H-11①）。 */
    heat,
    kpi: kpiOf({ ...stateBody, heat }),
    // 关于页只显示有来源的字段：版本/运行时来自本进程，仓库地址来自 package.json。
    appMeta: {
      version: APP_VERSION,
      runtime: process.version,
      platform: process.platform,
      repo: APP_HOMEPAGE,
    },
    /* 核心界面身份：签名清单验签 + 给前端比对 DOM 用的核心锚点。
       official / unofficial / unknown 三态；永不因为身份文件缺失让读路由 500。 */
    uiIdentity: uiIdentityState(),
    napcat: { present: nativePresent(), dir: NAPCAT_DIR, win32: IS_WIN },
    protocolGuard: protocolGuard.stateOf(),
    update: UPDATE.snapshot(),
  });
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
  const r = await httpGet(onebotProbePorts().httpPort, '/get_group_list', 10000);
  if (!r.ok) return sendJson(res, { ok: false, error: '协议端还没连上', groups: [] });
  try {
    const rep = classifyOneBotReply(JSON.parse(r.body));
    if (!rep.businessOk) {
      // ⚠️ 以前这里只判 `j.status==='ok' || retcode===0`，且失败时也回 `ok:true + 空表` ——
      //    "列群失败"在界面上长得像"这个号一个群都没有"。现在失败就说失败。
      return sendJson(res, {
        ok: false,
        error: `协议端返回业务失败：${rep.message || rep.code}`,
        groups: [],
      });
    }
    const groups = (rep.data || []).map((g) => ({ id: String(g.group_id), name: g.group_name || '' }));
    return sendJson(res, { ok: true, groups });
  } catch {
    return sendJson(res, { ok: false, error: '返回内容解析失败', groups: [] });
  }
}

async function apiBridgeStart(req, res, url) {
  const r = await startBridge();
  // ⚠️ 非 2xx 时页面读的是 **`data.error`**（见 `panel/next/app.js` 的 `api()`）——
  //    只回 `msg` 会当场退化成一句「HTTP 400」，那正是我们要消掉的那种"看不出原因"
  //    （第 54 轮：startBridge 现在会把"为什么一启动就死"写在 msg 里，别在最后一步丢掉它）。
  return sendJson(res, r.ok ? r : { ...r, error: r.msg }, r.ok ? 200 : 400);
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
  // ⚠️ 加一家（2026-10-07 千问）时**最容易漏的就是这一行**，而漏了不报错：
  //    不在表里的 target 会被下面那个 `|| 'local'` 静默兜底成"切本机"。
  //    症状是"点了『用千问』，本机模型莫名其妙被拉起来了"，而日志里一切正常。
  // ⚠️ `custom` 也必须在表里 —— 漏掉就会被下面那个 `|| 'local'` **静默兜底成切本机**。
  const ALT_TARGET = { deepseek: 'cloud', cloud: 'cloud', zhipu: 'zhipu', qwen: 'qwen', custom: 'custom', local: 'local' };
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

  // ⚠️ 切到**非自定义**目标（本机 / 云端预设）时，必须清掉自定义大脑的残留标记
  //    （2026-10-15 修 · A3 / Issue #5）。不清的后果是"界面说切了、实际没切"：
  //    `loadConfig()`（src/config.js:457）会拿残留的 `activeCustomId` 再去
  //    `materializeBrain()`，把自定义大脑的 baseUrl / model / apiKey **覆盖回扁平字段**。
  //    于是磁盘 config.json 写着 glm-5.3-flash + 智谱、面板也显示智谱，而机器人实际
  //    还在用自定义中转 —— 三个地方三个说法，且**都不报错**，最难查的一类。
  //    只在真的离开自定义大脑时清（target==='custom' 那个分支走不到这里）。
  if (target !== 'custom') {
    cfg.llm.activeCustomId = '';
    cfg.llm.declaredFeatures = undefined;
  }

  // ── 自定义大脑（2026-10-07）────────────────────────────────────────────
  // ⚠️ 它**不进 `presets`**：那张表是"服务商 → 一套设置"，而自定义是"用户命名的多套"。
  //    所以这里只做**物化**（把那套摊平到扁平字段）；切走时靠 `stashCurrentPreset`
  //    保住内置那套 —— 而它对自定义是 no-op（判据在 `PRESET_KEYS.includes` 里）。
  if (target === 'custom') {
    const id = String(body.id || '').trim();
    const allBrains = customBrainsOf(cfg).brains;
    const one = Object.hasOwn(allBrains, id) ? allBrains[id] : null;
    if (!one) {
      say(`✗ 找不到这套自定义大脑（id=${id || '空'}）`);
      return sendJson(res, { ok: false, steps, error: `找不到这套自定义大脑（id=${id || '空'}）` }, 400);
    }
    stashCurrentPreset(cfg);
    materializeBrain(cfg, one);
    /* ⚠️ 旧数据可能带着**别家的降级链**（2026-10-17 实测：一套千问大脑里躺着 8 条 GLM，
       来源是"恢复实测最优"曾经写死智谱的链）。物化会把它原样摊到扁平字段，
       机器人就会拿着一条**必然全部失败**的链去重试。
       所以切换这一下顺手按服务商过一遍：只剩这家的模型，并**说清去掉了什么**
       （静默改用户的配置是本项目最忌的一类）。链为空是合法的：就是"不降级"。 */
    const chain = chainForProvider(cfg.llm.fallbackModels, providerOf(cfg.llm.baseUrl || one.baseUrl));
    if (chain.dropped.length) {
      cfg.llm.fallbackModels = chain.kept;
      cfg.llm.customBrains[id] = { ...one, fallbackModels: [...chain.kept] };
      say(`· 已清掉 ${chain.dropped.length} 个不属于这家的降级模型：${chain.dropped.join('、')}`);
    }
    writeConfig(cfg);
    say(`✔ 已切到自定义大脑「${one.name}」（${one.model}）`);
    // ⚠️ 只有它**不跑在本机**时才收掉本机模型 —— 自定义大脑也可能指同一台机器的
    //    LM Studio（`http://127.0.0.1:1234/v1`），那种情况把本机模型停掉是帮倒忙。
    if (!isLocalBase(one.baseUrl)) await stopAnyLocalModel(say);
  } else if (target === 'local') {
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
    msg: target === 'local' ? '已切到本机模型'
      : target === 'custom' ? `已切到自定义大脑「${cfg.llm.customBrains?.[cfg.llm.activeCustomId]?.name || ''}」`
        : `已切到${CLOUD_PRESETS[presetKey]?.label || '云端'}`,
  });
}

/**
 * 自定义大脑：**新增 / 修改**（2026-10-07）。
 *
 * 与 `/api/config` 共用同一套约定，避免"同一种操作两种习惯"：
 *   · **Key 留空 = 不修改**（只改模型名不应该把 Key 弄丢）；
 *   · 地址变更时先 `stashCurrentPreset()` 把当前内置那套存回去，再物化新的。
 *
 * ⚠️ 校验用 `baseUrlReject()` —— 与 `/api/config` **同一条闸**（同源才会不漂）。
 *    它能挡 http 明文外泄、挡自称某家却不是其官方域名、**挡控制台网址**
 *    （用户照着浏览器地址栏填的那一个，见 `consoleHostReject`）。
 */
/**
 * GET `/api/provider-info?baseUrl=…` —— 添加模型时的**厂商识别**（2026-10-17 · 维护者点名）。
 *
 * 一次回答三件事：这是哪家、这家的优先线路长什么样、这家的额度/余额去哪看。
 * 全部复用既有判据（`providerOf` / `defaultChainOf` / `quotaPlanOf`），这里**不新增规则**：
 * 前端在表单里只是把结论显示出来，保存时后端还会用同一套判据再填一次。
 *
 * ⚠️ 纯读、**不落盘**，也不碰任何进程。
 * ⚠️ 地址像不像 URL 要当场说清：用户最容易填的是**控制台网页**，那会得到一个
 *    看不出所以然的 404（`baseUrlReject()` 在保存时才拦，这里先给一句人话）。
 */
async function apiProviderInfo(req, res, url) {
  const raw = String(url.searchParams.get('baseUrl') || '').trim();
  if (!raw) return sendJson(res, { ok: false, error: 'baseUrl 不能为空' }, 400);
  let host = '';
  try { host = new URL(raw).hostname; } catch { host = ''; }
  if (!host) {
    return sendJson(res, { ok: false, error: '这不像一个接口地址 —— 要写成 https://… 或本机 http://127.0.0.1:端口/v1', reason: 'bad-url' }, 400);
  }
  const provider = providerOf(raw);
  const known = PRESET_KEYS.includes(provider);
  const plan = quotaPlanOf(provider) || null;
  return sendJson(res, {
    ok: true,
    provider,
    known,
    vendor: CLOUD_PRESETS[provider]?.label
      || (provider === 'local' ? '本机模型' : '自建 / 中转网关'),
    officialBaseUrl: CLOUD_PRESETS[provider]?.baseUrl || '',
    // 这家认不认输入的这个地址（自建网关没有"官方地址"可言，恒 true）
    official: !!CLOUD_PRESETS[provider]?.baseUrl,
    chain: defaultChainOf(provider),   // **含主模型**，前端显示时按当前模型名剔掉
    quota: plan
      ? { label: plan.label, kindNote: plan.kindNote, controlUrl: plan.controlUrl, liveBalance: plan.liveBalance, mustDo: plan.mustDo }
      : null,
  });
}

async function apiCustomBrainSave(req, res, url) {
  const body = await readBody(req);
  const cfg = readConfig() || {};
  cfg.llm = cfg.llm || {};
  const { brains } = customBrainsOf(cfg);

  const wantId = String(body.id || '').trim();
  const editing = (wantId && Object.hasOwn(brains, wantId) && brains[wantId]) || null;

  // ── 地址：新增必填，编辑时留空 = 不改 ──
  const rawBase = typeof body.baseUrl === 'string' ? body.baseUrl.trim() : '';
  const baseUrl = rawBase || editing?.baseUrl || '';
  if (rawBase) {
    const why = baseUrlReject(rawBase);
    if (why) {
      pushLog(`✗ 自定义大脑的地址被拒（${why}）`);
      return sendJson(res, { ok: false, error: why, reason: 'bad-base-url' }, 400);
    }
  }
  if (!baseUrl) {
    return sendJson(res, { ok: false, error: '接口地址不能为空（要写成 https://… 或本机 http://127.0.0.1:端口…）' }, 400);
  }
  const model = String(body.model ?? '').trim() || editing?.model || '';
  if (!model) {
    // ⚠️ 这两个是"没有就发不出请求"的字段 —— 缺了必须当场说清，
    //    而不是存一个空地址进去（那样点下去会得到一个看不懂的 fetch 失败）。
    return sendJson(res, { ok: false, error: '模型名不能为空' }, 400);
  }

  // ── 模型名与服务商要对得上（2026-10-09 · 第 54 轮 · 真机首跑 P1）─────────────
  //
  // 这道闸早就写好了（`lib/models.js` 的 `modelProviderMismatch()`，中文理由很清楚），
  // `/api/config` 那条路一直在用。**自定义大脑走的是另一条独立路由，把它漏了** ——
  // 于是用户可以把 `baseUrl=https://platform.deepseek.com/usage` + `model=DS`
  // 原样存进 config.json 并激活，之后每次请求都失败，而界面上看不出任何异常。
  //
  // ⚠️ **只对云端那三家生效**（`deepseek` / `zhipu` / `qwen`），`local` / `other` 一律放行。
  //    为什么 `local` 必须放行：自定义大脑**正是** Windows 用户接本机模型的唯一通道
  //    （llama.cpp / LM Studio / Ollama 的 OpenAI 兼容地址，模型名是它们自己返回的 id，
  //    不带目录斜杠）；而 `modelProviderMismatch()` 的 `local` 那一支要求"填 MLX 模型目录路径"
  //    —— 那是 macOS 专有语义，照搬过来会把用户手册指的那条路当场拒掉，理由还是一句无关的话。
  //    判据本身复用 `PRESET_KEYS`（后端认的预设名单，唯一一份），不新开一张表。
  const provider = providerOf(baseUrl);
  if (provider !== 'local' && PRESET_KEYS.includes(provider)) {
    const mismatch = modelProviderMismatch(model, provider);
    if (mismatch) {
      pushLog(`✗ 拒绝了不匹配的模型：${model}（自定义大脑，服务商 ${provider}）`);
      return sendJson(res, { ok: false, error: mismatch, reason: 'model-provider-mismatch', provider }, 400);
    }
  }

  const name = String(body.name ?? '').trim() || editing?.name || '自定义模型';
  const features = {};
  for (const k of CUSTOM_FEATURE_KEYS) {
    features[k] = body.features && typeof body.features[k] === 'boolean'
      ? body.features[k]
      : editing?.features?.[k] === true;
  }

  const id = editing ? editing.id : newBrainId(brains, String(Date.now()));
  /* 降级链：**属于这家的才留**（2026-10-17）。保存这条路上以前完全不看服务商 ——
     复制一份别家的链进来（或编辑一套老大脑时把它原样带回去），就会得到一条
     "全是别家模型、一条都打不通"的链。判据复用 `chainForProvider`（与 /api/config 同源）。 */
  const chainRaw = Array.isArray(body.fallbackModels)
    ? body.fallbackModels.map((s) => String(s).trim()).filter(Boolean)
    : (editing?.fallbackModels || []);
  /* 新建时**没有**任何链 ⇒ 按这家的默认线路自动填一条（2026-10-17 维护者点名）。
     以前新建出来的大脑链是空的，用户以为"没有降级"是设计如此；
     而千问那类"额度按模型发"的平台，链长本身就是它的一半价值。
     ⚠️ 只在**新建**且链为空时填 —— 编辑时用户的链（哪怕是空的，他手动清过）一律尊重。 */
  const autoChain = (!editing && !chainRaw.length) ? defaultChainOf(provider).filter((m) => m !== model) : [];
  const chainPick = chainForProvider(chainRaw.length ? chainRaw : autoChain, provider);
  const one = normalizeCustomBrain({
    id, name, baseUrl, model,
    apiKey: (typeof body.apiKey === 'string' && body.apiKey.trim()) ? body.apiKey.trim() : (editing?.apiKey || ''),
    fallbackModels: chainPick.kept,
    features,
    maxTokens: Number.isFinite(body.maxTokens) && body.maxTokens > 0
      ? Math.round(body.maxTokens) : (editing?.maxTokens ?? 400),
    temperature: Number.isFinite(body.temperature) ? body.temperature : (editing?.temperature ?? 1),
  }, { id });
  if (!one) return sendJson(res, { ok: false, error: '这份配置不完整，保存失败' }, 400);

  // ⚠️ 只改这一套，不整份替换 —— 归一化副本会**丢掉坏条目**，
  //    而用户正想回头去修那个坏条目时，它会凭空消失（"我明明存过"）。
  cfg.llm.customBrains = { ...(cfg.llm.customBrains || {}), [id]: one };

  // 新增 → 自动选中（刚添的大脑显然是想用）；编辑当前那套 → 保持选中并重新物化
  const wantSwitch = !editing || String(cfg.llm.activeCustomId || '') === id;
  if (wantSwitch) {
    if (!editing) stashCurrentPreset(cfg); // 先把内置那套存回去，切回来才不丢
    materializeBrain(cfg, one);
  }
  writeConfig(cfg);
  pushLog(`${editing ? '✔ 已修改' : '✔ 已添加'}自定义大脑：${one.name}（${one.model}）`);

  const applied = wantSwitch ? await waitEffectiveApplied(cfg) : false;
  return sendJson(res, {
    ok: true, id, name: one.name,
    switched: wantSwitch, applied,
    msg: `${editing ? '已修改' : '已添加'}「${one.name}」${wantSwitch ? '并已切到它' : '（当前没在用它，点一下即可切换）'}`
      + (autoChain.length ? `，已按这家的默认线路填了 ${one.fallbackModels.length} 条备用模型` : '')
      + (chainPick.dropped.length ? `（已去掉 ${chainPick.dropped.length} 个不属于这家的降级模型）` : ''),
  });
}

/** 自定义大脑：**改名**（右键菜单）。只动名字，其它一个字节都不碰。 */
async function apiCustomBrainRename(req, res, url) {
  const body = await readBody(req);
  const cfg = readConfig() || {};
  cfg.llm = cfg.llm || {};
  const id = String(body.id || '').trim();
  const name = String(body.name ?? '').trim();
  if (!id || !Object.hasOwn(cfg.llm.customBrains || {}, id)) {
    return sendJson(res, { ok: false, error: '找不到这套大脑（可能已被删掉）' }, 404);
  }
  // ⚠️ 名字清空时**回落到兜底名**而不是存一个空串 —— 界面上会显示一个没有名字的按钮，
  //    而用户无从下手（"这是哪个？"）。
  if (!name) {
    return sendJson(res, { ok: false, error: '名字不能为空' }, 400);
  }
  cfg.llm.customBrains[id] = { ...cfg.llm.customBrains[id], name };
  writeConfig(cfg);
  pushLog(`✔ 自定义大脑已改名为：${name}`);
  return sendJson(res, { ok: true, id, name, msg: `已改名为「${name}」` });
}

/**
 * 自定义大脑：**删除**（右键菜单）。
 *
 * ⚠️ 唯一要小心的是"删的正是当前在用的那套"：那会让它**没有大脑可用**。
 *    处理：把当前内置那套存回去之后**显式切回智谱**，并在回执里说清。
 *    （不替用户猜"该回哪一套" —— 智谱是默认大脑，切回去是可预期的。）
 */
async function apiCustomBrainDelete(req, res, url) {
  const body = await readBody(req);
  const cfg = readConfig() || {};
  cfg.llm = cfg.llm || {};
  const id = String(body.id || '').trim();
  if (!id || !Object.hasOwn(cfg.llm.customBrains || {}, id)) {
    return sendJson(res, { ok: false, error: '找不到这套大脑（可能已经删过了）' }, 404);
  }
  const gone = cfg.llm.customBrains[id];
  delete cfg.llm.customBrains[id];

  let fellBack = false;
  if (String(cfg.llm.activeCustomId || '') === id) {
    cfg.llm.activeCustomId = '';
    cfg.llm.declaredFeatures = undefined;
    /* ⚠️ 这里**不能** `stashCurrentPreset(cfg)`（2026-10-17 删掉的那一行）：
       走得到这一步就说明"刚才用的是这套自定义大脑"⇒ 扁平字段是它物化出来的，
       不属于任何内置预设。存回去的后果是 `presets[qwen]` 被这套的模型名 +
       它自己那条（常为空的）降级链覆盖 —— 之后切回内置千问就是这个残缺状态，
       而且不报错。与 `models.js` 里 `stashCurrentPreset` 的守卫是同一条判据。 */
    const P = readPresets(cfg).zhipu || {};
    cfg.llm.baseUrl = P.baseUrl || CLOUD_PRESETS.zhipu.baseUrl;
    cfg.llm.model = P.model || CLOUD_PRESETS.zhipu.model;
    cfg.llm.apiKey = cfg.llm.keys?.zhipu || '';
    cfg.llm.fallbackModels = [...(P.fallbackModels || [])];
    cfg.llm.features = { ...(P.features || {}) };
    fellBack = true;
  }
  writeConfig(cfg);
  pushLog(`✔ 已删除自定义大脑：${gone?.name || id}${fellBack ? '（它正在被使用，已切回智谱）' : ''}`);
  const applied = fellBack ? await waitEffectiveApplied(cfg) : false;
  return sendJson(res, {
    ok: true, id, fellBack, applied,
    msg: `已删除「${gone?.name || id}」${fellBack ? '—— 它刚才正在用，已自动切回智谱' : ''}`,
  });
}

/** 一键启动：Docker → 容器 → 模型 → 机器人，每步都有进度 */
async function apiOnekeyStart(req, res, url) {
  const steps = [];
  const say = makeSay(steps);

  say('▶ 开始一键启动');

  // ── 容器这一步：按平台分支（2026-10-08 · Windows 适配）──────────────────────
  // ⚠️ Windows 走**原生 NapCat**（README 的「安装」一节）：那边没有 Docker，容器也不是
  //    需要被拉起的东西 —— NapCat 是用户自己双击启动的一个应用。
  //    少了这个分支，Windows 用户点「一键启动」会**在第一步就整体失败**
  //    （`ensureDocker` 不 ok 就直接 `return 400`，报"没找到 Docker Desktop"）——
  //    而用户手册第 9 节让他点的正是这个按钮。**那属于"文档写了一条走不通的路"。**
  // ⚠️ 取向是**零风险**：下面那个 else 分支**逐字保持原样**，macOS 的容器链路一点没动。
  if (IS_WIN) {
    say('· Windows 走原生 NapCat（不用 Docker）：跳过容器这一步');
  } else {
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
  }

  // 「等协议端就绪」和「把本机模型拉起来」**互不依赖**：协议端是容器那边的事，
  // 模型是另一个进程。以前串着做 —— 容器刚重启时 NapCat 要 20 秒才应答、模型又要
  // 加载 40 秒，用户得干等一分钟。现在同时发，谁慢等谁（日志按各自完成的时刻落）。
  const cfg = readConfig();
  const needLocal = isLocalBase(cfg?.llm?.baseUrl);
  say(needLocal
    ? '… 等待协议端就绪，同时启动本机模型（并行）'
    : '… 等待 QQ 协议端就绪');

  const onebotHttpPort = onebotEndpointOf(cfg?.onebot).httpPort;
  const onebotTask = waitFor(async () => (await httpGet(onebotHttpPort, '/get_login_info', ONEBOT_PROBE_TIMEOUT_MS)).ok, ONEBOT_READY_DEADLINE_MS, ONEBOT_PROBE_GAP_MS)
    .then((ok) => {
      // ⚠️ Windows 上的失败原因**不是**"扫码/容器"：NapCat 是个独立窗口的应用，
      //    最常见的情形是用户压根没启动它。提示必须指向那里，否则会把人引去翻容器。
      say(ok ? '✔ 协议端已就绪' : (IS_WIN
        ? '✗ 协议端没响应 —— 请先启动协议端并完成登录（NapCat / SnowLuma 等；它是个单独的窗口，不在容器里）'
        : '✗ 协议端没响应（可能要扫码登录，看左侧状态）'));
      return ok;
    });

  const [onebotReady, localReady] = await Promise.all([
    onebotTask,
    needLocal ? ensureLocalModelReady(cfg, say) : Promise.resolve(false),
  ]);

  if (!needLocal) {
    say('· 云端模式，不需要本机模型');
    if (await stopAnyLocalModel(say)) say('✔ 已关掉本机模型，省内存');
  }

  let bridge = { ok: true, msg: '机器人已在运行' };
  if (bridgeRunning()) {
    say('· 机器人已在运行');
  } else {
    bridge = await startBridge();
    say(bridge.ok ? `✔ ${bridge.msg}` : `✗ ${bridge.msg}`);
  }

  invalidateDockerCache();

  // ── 回执必须**如实**反映子步骤（2026-10-09 · 第 54 轮 · 真机首跑 P0）──────────
  //
  // 以前这里无论协议端连没连上、机器人起没起来，一律回
  // `{ ok: true, msg: '一键启动完成' }` —— 于是"协议端没起来"和"机器人没起来"
  // 在界面上都是**完成**，用户只能去群里干等一个永远不来的回复。
  // 这是"失败只写在文件里"的另一种形态：**接口回 200，而业务从没成立过**。
  //
  // ⚠️ 用 200 + `ok:false`（而不是 400）：这条响应里带着 `steps`（失败的**那一步**在哪，
  //    对非技术用户比错误类型有用得多），而前端只在**非 2xx** 时抛异常、把 `steps` 丢掉。
  //    前端据 `ok` 决定提示颜色（见 `panel/next/app.js` 的 `onekey.start`）。
  const failed = [];
  if (!onebotReady) {
    failed.push(IS_WIN
      ? '协议端没响应 —— 请先启动协议端并完成登录（NapCat / SnowLuma 等；它是个单独的窗口，不在容器里）'
      : '协议端没响应（可能要扫码登录，看左侧状态）');
  }
  if (needLocal && !localReady) failed.push('本机模型没起来');
  if (!bridge.ok) failed.push(bridge.msg);

  if (failed.length) {
    return sendJson(res, { ok: false, steps, msg: `没能完全启动 —— ${failed.join('；')}` });
  }
  return sendJson(res, { ok: true, steps, msg: '一键启动完成' });
}

/**
 * 结束本次运行：机器人 + 本机模型 + 容器 + （可选）Docker Desktop 全关，
 * 回到启动之前的干净状态，内存一次性释放干净。
 */

/**
 * P7：收掉"我们开的那只控制台窗口"。
 *
 * 只认启动跟踪里记的 openedPid，且**命令行必须同时含 --app= 与控制台端口**才杀 ——
 * 误杀用户自己的浏览器是不可接受的事故，校验不过就宁可留着窗口。
 * 非 win32 一律不动：标签页归用户自己的浏览器托管。
 */
async function closeConsoleWindowIfOurs() {
  if (process.platform !== 'win32') return { ok: true, reason: '非 Windows：标签页归用户浏览器托管，不杀' };
  let entry = null;
  try {
    entry = (readLaunchLog(launchLogPath(CONFIG_FILE, PANEL_STATE_DIR), { limit: 1 }) || [])[0] || null;
  } catch { entry = null; }
  const pid = Number(entry && entry.openedPid);
  if (!entry || entry.kind !== 'window' || !pid) return { ok: true, reason: '启动跟踪里没有独立窗口 pid，无需关窗' };
  let cmd = '';
  try {
    const ps = spawnSync('powershell', ['-NoProfile', '-Command',
      `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`],
      { windowsHide: true, timeout: 8000, encoding: 'utf8' });
    cmd = String(ps.stdout || '').trim();
  } catch { cmd = ''; }
  if (!cmd.includes('--app=') || !cmd.includes(String(ACTUAL_PORT || PORT))) {
    return { ok: false, reason: `pid ${pid} 的命令行不像我们开的控制台窗口，不杀` };
  }
  spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 8000 });
  return { ok: true, reason: `已关控制台窗口（pid ${pid}）` };
}

/** P7：「结束本次运行」的最后一程：关窗 → 停 HTTP → 退出本进程。 */
async function exitPanelNow() {
  const r = await closeConsoleWindowIfOurs();
  if (r && r.reason) console.log(`· 关控制台窗口：${r.reason}`);
  if (!lastExitWritten) {
    writeLastExit(path.join(PANEL_STATE_DIR, '.last-exit.json'), {
      code: 0, reason: 'onekey-stop', pid: BOOT.pid, uptimeMs: Date.now() - BOOT.at,
    });
    lastExitWritten = true;
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), BRIDGE_SETTLE_MS);
}

async function apiOnekeyStop(req, res, url) {
  const body = await readBody(req);
  const quitDocker = body.quitDocker !== false; // 默认连 Docker 一起退，才叫"干净"
  const steps = [];
  const say = makeSay(steps);

  say('■ 开始结束本次运行');

  // ⚠️ 顺序：先停守护，再停协议端。反了的话协议端刚被收掉、守护下一拍又把它拉回来
  //    ⇒ 用户点了「结束本次运行」，协议端十几秒后自己回来（"关不掉"）。
  await protocolGuard.stop();
  say('· 协议端守护已停（否则它会把刚停掉的协议端再拉回来）');

  // 机器人、本机模型、QQ 容器三件事互不依赖，以前是一件一件等 ——
  // 光 docker stop 那一步就要 10~30 秒，串起来用户只能盯着进度条。
  // 现在容器先发出去停，同时收机器人和模型，最后只等容器那一步。
  // ⚠️ 平台分派（2026-10-22 · 群友改版回执）：Windows 便携/安装版的协议端是**原生 NapCat**，
  //    Docker 根本没在跑。以前这里只 `cachedDockerUp()`，为假就整段跳过 ⇒ 点「结束本次运行」
  //    协议端一个进程都不动，界面却报「已回到启动前的干净状态」。判据仍只有一处（paths.js 的 IS_WIN）。
  const dockerUpFirst = IS_WIN ? false : await cachedDockerUp();
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

  let napcatStop = null;
  if (IS_WIN) {
    // 原生协议端：收掉 QQ.exe 那一族（判据与实现都在 napcat-native.js）。
    // 文案与启动侧对齐：用户问的是"我的协议端停了没有"，不是"Docker 在不在"。
    say('· Windows 走原生 NapCat（不用 Docker）：容器这一步跳过');
    const { wsPort } = onebotProbePorts();
    napcatStop = await stopNativeNapcat(killTree, { wsPort });
    say(napcatStop.ok ? `✔ ${napcatStop.msg}` : `· ${napcatStop.msg}`);
    if (napcatStop.ok && /已停止/.test(napcatStop.msg)) {
      say('· 协议端那个窗口会停在自己按任意键上，关掉它即可');
    }
  } else if (dockerUpFirst) {
    say('… 正在停止 QQ 容器');
    const r = await containerStop;
    say(r.ok ? '✔ QQ 容器已停止' : `· 容器停止：${(r.stderr || '').slice(0, 150) || '已经停了'}`);

    if (quitDocker) {
      // 只**发起**退出，不等它退完。Docker 退出要 10~20 秒，而它退不退都不影响
      // 前面已经做完的清理（机器人 / 模型 / 容器都停了）。等在这里纯属让用户干瞪眼 ——
      // 页面上「Docker」那一项会自己变灰，比一句"处理中"直观得多。
      // ⚠️ 平台分支（2026-10-08）：Windows 上没有 `osascript`。那边 Docker Desktop
      //    是个 exe，按镜像名收掉它（`/T` 连它拉起的子进程一起）。
      if (IS_WIN) execFile('taskkill', ['/IM', 'Docker Desktop.exe', '/T'], { windowsHide: true }, () => {});
      else execFile('/usr/bin/osascript', ['-e', 'tell application "Docker" to quit'], { windowsHide: true }, () => {});
      state.dockerQuitAt = Date.now(); // 给「一键启动」留个记号：它正在退出，别撞上去
      say('· 已让 Docker Desktop 退出（后台进行，约 10–20 秒，不用等它 —— 上面那项会自己变灰）');
    }
  } else {
    say('· Docker 本来就没在运行');
  }

  try { fs.unlinkSync(EFFECTIVE_FILE); } catch { /* 本来就没有 */ }
  invalidateDockerCache();
  // ⚠️ 收尾这句必须看协议端有没有收掉：`stopNativeNapcat` 失败时它是**唯一**还把
  //    "协议端没停"说出来的地方。照旧报"已回到干净状态"= 用户看到全都结束了、QQ 还在跑。
  const napcatLeft = !!napcatStop && !napcatStop.ok && !/没找到/.test(napcatStop.msg);
  say(napcatLeft
    ? '· 除协议端之外的清理都已完成 —— 协议端还在跑（原因见上面那行）'
    : '✔ 已回到启动前的干净状态');
  // 协议端没停掉时**不退面板**：退了用户连重试的地方都没有，只能去双击 bat。
  const exitPanel = body.exitPanel !== false && !napcatLeft;
  if (exitPanel) say('· 面板自身与它开的控制台窗口也一起收（约半秒后本进程退出，页面会显示"已退出"）');
  sendJson(res, {
    ok: !napcatLeft,
    steps,
    msg: napcatLeft
      ? '机器人和本机模型已停，但协议端没停掉 —— 面板先留着'
      : (exitPanel ? '已全部结束，面板即将退出' : '已全部结束，内存已释放'),
    panelExiting: exitPanel,
  });
  if (exitPanel) setTimeout(() => { void exitPanelNow(); }, PANEL_EXIT_SETTLE_MS);
  return;
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
  const r = await sh(NODE, [path.join(PROGRAM_ROOT, 'scripts', 'dryrun.js'), '--json', '--', text], DRYRUN_TIMEOUT_MS);
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
    // `listAutoMemory()` 是「最新在前」，磁盘是「最旧在前」—— 顺序还原在唯一写口里做。
    writeAutoMemory(rows);
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
  const kindRaw = url.searchParams.get('kind');
  const expectedKind = kindRaw === 'skill' || kindRaw === 'plugin' ? kindRaw : null;
  if (kindRaw && !expectedKind) {
    return sendJson(res, { ok: false, error: '安装 kind 只能是 skill 或 plugin' }, 400);
  }
  const r = installArchive({ bytes: got.buf, roots: extensionRoots(USER_ROOT), overwrite, expectedKind });
  if (!r.ok) {
    pushLog(`· 扩展安装失败：${r.error}`);
    return sendJson(res, { ok: false, error: r.error }, r.code || 400);
  }
  // 装完立刻刷一次扩展快照（模块内有 10 秒 TTL 缓存）—— 不为它新开一个 force 接口。
  const cfgNow = readConfig() || {};
  const exNow = cfgNow.custom?.extensions;
  const hasExNow = exNow && typeof exNow === 'object' && !Array.isArray(exNow);
  extensionsOf(hasExNow
    ? { plugin: exNow.plugins?.enabled || [], skill: exNow.skills?.enabled || [] }
    : { plugin: cfgNow.custom?.plugins?.enabled || [], skill: cfgNow.custom?.plugins?.enabled || [] },
  {
    force: true,
    maxPlugins: cfgNow.custom?.extensions?.max ?? cfgNow.custom?.plugins?.max,
  });
  pushLog(`· 插件已安装：${r.dir} → ${r.root}/（${r.files} 个文件${r.replaced ? '，已覆盖旧版' : ''}；未自动启用）`);
  return sendJson(res, {
    ok: true, id: r.id, kind: r.kind, dir: r.dir, files: r.files, replaced: r.replaced,
  });
}

// ── 自定义工作台：下载 / 导出 ──
// what = all | persona | prompt | rules | memory | skills | log | config
// format = json | txt | zip
async function apiCustomExport(req, res, url) {
  const what = String(url.searchParams.get('what') || 'all');
  const format = String(url.searchParams.get('format') || 'json');
  // mask=0 时保留群号（自己留档用）。默认脱敏到底，因为导出文件多半是要发出去的。
  const mask = url.searchParams.get('mask') !== '0';
  const cfg = readConfig() || {};
  if (what === 'diag') {
    const listOf = (v) => (Array.isArray(v) ? v : []);
    const knownIds = {
      qqIds: [
        cfg?.account?.userId, cfg?.onebot?.selfId,
        ...listOf(cfg?.allow?.users), ...listOf(cfg?.deny?.users),
      ].filter(Boolean).map(String),
      groupIds: [
        ...listOf(cfg?.allow?.groups), ...listOf(cfg?.deny?.groups),
      ].filter(Boolean).map(String),
    };
    const bundle = buildDiagnosticsBundle({
      userRoot: USER_ROOT,
      installRoot: INSTALL_ROOT,
      programRoot: PROGRAM_ROOT,
      maskSecrets,
      knownIds,
    });
    const buf = buildDiagnosticsZip(bundle);
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    const name = `estrella-diag-${stamp}.zip`;
    pushLog(`· 已导出诊断包（${Object.keys(bundle.files).length} 个文件${bundle.redactions.length ? `，${bundle.redactions.length} 处二次脱敏` : ''}）`);
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${name}"`,
      'Content-Length': buf.length,
    });
    return res.end(buf);
  }
  // 按范围导出（P2）：用户只传 scope id，文件名仍是本文件的常量表；
  // dry=1 只回每个范围的真实字节数，不生成附件。
  const scopeIds = String(url.searchParams.get('scopes') || '')
    .split(',').map((x) => x.trim()).filter(Boolean);
  const scopeMap = new Map(EXPORT_SCOPES.map((s) => [s.id, s]));
  const badScopes = scopeIds.filter((id) => !scopeMap.has(id));
  const isDry = url.searchParams.get('dry') === '1';
  // dry 不要求先选范围：它要告诉前端"有哪些范围可选"。
  if (what === 'selected' && !isDry && (!scopeIds.length || badScopes.length)) {
    return sendJson(res, {
      ok: false,
      error: `导出范围只接受 ${EXPORT_SCOPES.map((s) => s.id).join(' / ')}`
        + `${badScopes.length ? `（认不出 ${badScopes.join(',')}）` : '（至少选一项）'}`,
    }, 400);
  }
  if (isDry) {
    const all = buildExport(cfg, 'all', mask);
    const rows = EXPORT_SCOPES.map((s) => {
      const files = s.files.filter((f) => Object.prototype.hasOwnProperty.call(all.files, f));
      const bytes = files.reduce((n, f) => n + Buffer.byteLength(String(all.files[f]), 'utf8'), 0);
      return { id: s.id, label: s.label, files, bytes };
    });
    return sendJson(res, {
      ok: true,
      dry: true,
      scopes: rows,
      totalBytes: rows.reduce((n, r) => n + r.bytes, 0),
      mask,
      generatedAt: new Date().toISOString(),
    });
  }

  let bundle = buildExport(cfg, what === 'selected' ? 'all' : what, mask);
  if (what === 'selected') {
    const allow = new Set(scopeIds.flatMap((id) => scopeMap.get(id).files));
    bundle = {
      ...bundle,
      files: Object.fromEntries(Object.entries(bundle.files).filter(([name]) => allow.has(name))),
    };
  }
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
  // 同「结束本次运行」：先停守护，再停协议端。
  await protocolGuard.stop();
  // 同样是并发：容器停得慢（10~30 秒），先发出去，同时收机器人和本机模型。
  // 原来这里直接 docker stop，Docker 没起来时会白等一整轮超时。
  // 平台分派（2026-10-22）：Windows 原生 NapCat 不在容器里，Docker 为假不代表无事可做。
  const dockerUp = IS_WIN ? false : await cachedDockerUp();
  const stopContainer = dockerUp
    ? sh(DOCKER, ['stop', '-t', '10', 'napcat'], 20000)
    : Promise.resolve(null);

  await stopBridge();
  // 两条本地通道都收（哪条在跑就收哪条），别留下一条偷偷占着内存
  await stopAnyLocalModel(null);

  if (IS_WIN) {
    const { wsPort } = onebotProbePorts();
    const n = await stopNativeNapcat(killTree, { wsPort });
    invalidateDockerCache();
    pushLog(n.ok ? `✔ ${n.msg}` : `· ${n.msg}`);
    // "没找到在跑的协议端"不是失败；只有真的收不掉才留面板（用户还要重试）。
    const left = !n.ok && !/没找到/.test(n.msg);
    if (!left) setTimeout(() => shutdown('stop-all'), PANEL_EXIT_SETTLE_MS);
    return sendJson(res, {
      ok: !left,
      quit: !left,
      msg: left
        ? '机器人和本机模型已停，但协议端没停掉 —— 控制台先留着'
        : '机器人、本机模型、协议端都停了，控制台也在关闭',
    });
  }

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

/**
 * P10（2026-10-19 群友回执：不想再进文件夹点任何东西）：
 * 安装形态下双击桌面图标 = 控制台 + 协议端一次到位。面板启动时自查一次 ——
 * 协议端装了但没跑就用 launch-napcat-hidden.vbs 隐藏拉起（无黑窗、无任务栏按钮）；
 * 3001 已在听就不重复起（起第二个 = 抢端口 = 掉登录态）；没装就只在日志里如实说出路。
 * 刻意不 await：协议端慢或缺席，绝不能拖住「控制台已启动」。
 */
async function autoStartNapcatIfInstalled() {
  if (!nativePresent()) {
    pushLog('· 协议端未安装 —— 打开「总览 → 运行 → 运行状态」，点『自动查找并安装』（会扫描下载/桌面里已解压的 NapCat）');
    return;
  }
  const { wsPort } = onebotProbePorts();
  if (await portOpen(wsPort)) { pushLog(`· 协议端已经在运行（${wsPort} 有应答）—— 没有重复拉起`); return; }
  const login = knownLoginQq();
  if (login.qq) pushLog(`· 快速登录：${login.qq}（来源：${login.from}）—— 登录态有效时不弹二维码`);
  else pushLog('· 没拿到已登录的 QQ 号 —— 走二维码登录（首次或换号时正常）');
  const r = startNativeNapcat({ qq: login.qq });
  // 自启已经发起过一次拉起（无论成败）⇒ 允许守护后续按冷却重试；
  // 首次安装仍不替用户开窗口（自启本身只在已装且 Windows 时跑）。
  protocolGuard.noteAttempt();
  pushLog(r.ok ? `✔ ${r.msg}` : `✗ ${r.msg}`);
}

/**
 * P11（2026-10-19 维护者回执）：协议端没装时，面板自己去找 / 引导，
 * 不再让用户去 `%LOCALAPPDATA%\EstrellaBot\userdata` 里手动放文件
 * （原话："一直卡在 AppData 这一块，是没有这个东西的"）。
 *
 * 查找逻辑住在 `tools/import-napcat.mjs` —— 它**复用**安装器的 `placeNapcatFromLocal`
 * （只复制、不移动、已装不覆盖）。面板只负责拉起它，不在这里重写一份位置判据。
 */
function toolFile(name) {
  const cands = [
    path.join(INSTALL_ROOT, 'tools', name),
    path.resolve(PROGRAM_ROOT, '..', 'tools', name),
    path.join(PROGRAM_ROOT, 'packaging', 'windows', 'tools', name),
  ];
  for (const p of cands) {
    try { if (fs.existsSync(p)) return p; } catch { /* 继续找下一个 */ }
  }
  return '';
}

async function apiNapcatImportAuto(req, res, url) {
  if (!IS_WIN) return sendJson(res, { ok: false, msg: '这个功能只在 Windows 安装版上可用' }, 400);
  const tool = toolFile('import-napcat.mjs');
  if (!tool) return sendJson(res, { ok: false, msg: '找不到 import-napcat.mjs（安装件不完整）' }, 500);
  pushLog('… 正在这台电脑上查找已解压的 NapCat（下载 / 桌面 / 文档）');
  const r = await new Promise((resolve) => {
    execFile(NODE, [tool, '--install-root', INSTALL_ROOT, '--user-root', USER_ROOT], {
      timeout: NAPCAT_IMPORT_TIMEOUT_MS, windowsHide: true, maxBuffer: 8 * 1024 * 1024,
      // 工具自己会按 --user-root 设 QQBOT_*（必须在它 import common 之前）；
      // 这里只负责把安装器留下的 ESTRELLA_NSIS 清掉，否则输出会被 ASCII 化成问号。
      env: { ...process.env, ESTRELLA_NSIS: '' },
    }, (err, stdout, stderr) => resolve({ err, stdout, stderr }));
  });
  const line = String(r.stdout || '').split('\n').reverse().find((l) => l.startsWith('JSON:'));
  let j = null;
  try { j = line ? JSON.parse(line.slice(5)) : null; } catch { /* 落到下面统一报错 */ }
  if (!j) {
    pushLog('✗ 查找脚本没有给出结果（详见面板日志）');
    return sendJson(res, { ok: false, msg: '查找脚本没有给出结果', output: String(r.stderr || r.stdout || '').slice(-2000) }, 500);
  }
  if (j.action === 'imported') pushLog(`✔ 已从 ${j.from} 装好协议端（${j.status}）`);
  else if (j.action === 'already') pushLog('· 协议端已经装好，无需重复导入');
  else if (j.action === 'not-found') pushLog('· 没找到已解压的 NapCat —— 可以点「打开协议端文件夹」自己放进去');
  else pushLog(`✗ 导入失败：${j.error || j.status || j.action}`);
  return sendJson(res, j);
}

async function apiNapcatOpenFolder(req, res, url) {
  if (!IS_WIN) return sendJson(res, { ok: false, msg: '这个功能只在 Windows 安装版上可用' }, 400);
  try {
    fs.mkdirSync(NAPCAT_DIR, { recursive: true });
    spawn('explorer.exe', [NAPCAT_DIR], { detached: true, windowsHide: true, stdio: 'ignore' }).unref();
    pushLog(`· 已打开协议端文件夹：${NAPCAT_DIR}`);
    return sendJson(res, { ok: true, dir: NAPCAT_DIR });
  } catch (e) {
    return sendJson(res, { ok: false, msg: `打不开文件夹：${e.message}` }, 500);
  }
}

/**
 * 手动拉起协议端。与守护定时器共用 `runStep`（**唯一实现**），`force` 只越过
 * 「从没起来过 / 冷却中 / 超过上限」，永不越过「账号掉线 / 协议端还活着」。
 */
async function apiProtocolStart(req, res, url) {
  try {
    const r = await protocolGuard.runStep({ force: true });
    const launched = r.act === 'spawn' && r.ok !== false;
    const msg = launched
      ? '已发起拉起协议端（它登录好了才会开端口，最多等 90 秒）'
      : `没有拉起：${r.reason}`;
    pushLog(`… 手动拉起协议端：${msg}`);
    return sendJson(res, { ok: launched, msg });
  } catch (e) {
    return sendJson(res, { ok: false, msg: `拉起协议端出错：${e && e.message ? e.message : e}` }, 500);
  }
}

async function apiNapcatRestart(req, res, url) {
  // ── 原生协议端优先（2026-10-12 · Windows 便携包）────────────────────────────
  // 便携包里没有 Docker，协议端是 `app\napcat\` 下的原生进程。原来这里一上来就
  // `ensureDocker(150000, …)` ⇒ 用户点「重启协议端」，屏幕要等**两分半**才回一句
  // "Docker 没起来"。这条分支让它变成一两秒的事。
  //
  // ⚠️ 已经在跑时**不重启**：NapCat 的重启 = 掉登录态 = 要重新扫码。
  //    "拉起"是用户这一刻真正需要的；"重启"留给以后做成显式动作。
  if (nativePresent() && !(await cachedDockerUp())) {
    const { wsPort } = onebotProbePorts();
    if (await portOpen(wsPort)) {
      pushLog(`· 协议端已经在运行（${wsPort} 有应答）—— 没有重启它（重启会掉登录态）`);
      return sendJson(res, { ok: true, output: '协议端已经在运行 —— 没有动它' });
    }
    // ⚠️ 没登录时**真重启**（杀干净再拉起）：以前这里只 `startNativeNapcat()`，
    //    旧的 NapCat 还活着 ⇒ 点多少次"重启协议端"二维码都不会换（2026-10-13 真机）。
    pushLog('… 重启协议端（先停掉旧的，再拉起）');
    const r = await restartNativeNapcat(killTree, { wsPort: onebotProbePorts().wsPort });
    pushLog(r.ok ? `✔ ${r.msg}` : `✗ ${r.msg}`);
    return sendJson(res, { ok: r.ok, output: r.msg }, r.ok ? 200 : 400);
  }

  // P10（2026-10-19 群友截图）：Windows 的安装版/便携版都没有 Docker 那一套 ——
  // 协议端没装时原来会跌进 ensureDocker，两分半后冒出一句莫名其妙的「没找到 Docker Desktop」。
  // 现在如实报「协议端未安装」并给出路；容器那一支只留给 macOS。
  if (IS_WIN) {
    const m = MODE === 'installed'
      ? '协议端未安装：打开「总览 → 运行 → 运行状态」，点『自动查找并安装』，或点『打开协议端文件夹』自己放'
      : '协议端未安装：先双击「一键安装.bat」把协议端装进 app\\napcat';
    pushLog(`✗ ${m}`);
    return sendJson(res, { ok: false, output: m }, 400);
  }

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

/**
 * 取登录二维码（`GET /api/qrcode`，页面上「打开二维码登录」按钮走它）。
 *
 * ⚠️ 顺序是**本地优先**（2026-10-12 · 真机修正）：
 *    便携包里 NapCat 是原生进程，图片就躺在 `app\napcat\cache\qrcode.png` ——
 *    直接读盘，比"先登录 WebUI 换凭证再取图"短三条街，也不受 WebUI 端口/令牌影响。
 *    原来只有 `docker exec` 那一支 ⇒ 便携包上这个接口**必然 404**，
 *    页面上就是一张永远裂着的图（用户报的就是这个现象）。
 *    容器那一支保留在后面：macOS 主线仍然跑容器。
 * ⚠️ 且"本地优先"必须带**形态前提**（2026-10-16 · Mac 真机修）：
 *    只看"文件在不在"是不够的 —— macOS 上容器根本没挂 cache，而开发树的 `napcat/` 下
 *    可能躺着一张历史遗留的 qrcode.png（本机实测：2026-09-16 的孤儿文件），
 *    只看文件存在就会**永远**发那张陈旧的码：点「换一张」，后端在容器里真换了，
 *    前端取回的却还是旧图 —— 症状就是"显示已刷新，但二维码切换不了"。
 *    判据本体在 `panelLocalQr()`（napcat-native.js），这里只接线。
 */
async function apiQrcode(req, res, url) {
  const local = panelLocalQr(nativePresent());
  if (local) {
    res.writeHead(200, {
      'Content-Type': 'image/png',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Content-Length': local.length,
    });
    return res.end(local);
  }
  // 容器那一支（判据不变：实时取，避免给用户一张已经过期的静态图）
  const r = await shBuffer(DOCKER, ['exec', 'napcat', 'cat', '/app/napcat/cache/qrcode.png']);
  if (!r.ok || !r.buf.length) {
    // ⚠️ 404 的正文会被页面**显示给用户**（前端不再拿 <img> 硬啃），
    //    所以这里写的是"下一步做什么"，不是一句"取不到"。
    // ⚠️ 文案按平台分流（2026-10-13 真机截图）：便携包（Windows）上根本没有 Docker，
    //    「容器没在运行？」纯属误导 —— 真正的原因是协议端还没装（一键安装没跑）
    //    或者还没把启动器拉起来。
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end(nativePresent()
      ? '还没有二维码 —— 协议端要么没在跑，要么还没开始生成。\n点上面的「重启协议端」把它拉起来，几秒后这张图会自动出现。'
      : (IS_WIN
        ? (MODE === 'installed'
          ? '取不到二维码 —— 协议端未安装。\n打开「总览 → 运行 → 运行状态」，点『自动查找并安装』（或『打开协议端文件夹』把文件拖进去），再点「重启协议端」。'
          : '取不到二维码 —— 协议端还没装好。\n先回包的根目录双击「一键安装.bat」（它会把协议端装进 app\\napcat），装完再点「重启协议端」。')
        : '暂时取不到二维码（容器没在运行？）'));
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
  pushLog(r.ok ? '✔ 已换一张新二维码（旧的扫不动就是因为过期了）' : `✗ 换二维码失败：${String(r.msg).split('\n')[0]}`);
  // ⚠️ 失败也回 **200**（2026-10-13 · 群友真机资料第③条）：
  //    前端 `post()` 一见非 2xx 就 throw，而 throw 会把响应体整个丢掉 ⇒
  //    用户只看到「HTTP 400」，真正那句原因（连不上 WebUI / 已登录 / 没在运行）
  //    一个字都到不了眼前。这里与 /api/onekey/start 的回执同一取向：
  //    **业务失败走 200 + ok:false，原因由调用方显示出来。**
  return sendJson(res, r, 200);
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

/* ══════════════ 网页内置终端（2026-10-11）══════════════════════════════════════
 *  它要解决的毛病是**具体**的：控制台以前是一个前台 cmd 窗口 ——
 *  窗口关不掉（关了就等于杀进程）、目录删不掉（进程占着文件）。
 *  正解不是教用户怎么关窗口，而是**不再需要那个窗口**：
 *     · 面板以无窗口方式起（见 `packaging/windows/tools/lib/console.mjs`）
 *     · 运行日志实时推到网页（本节的 SSE）
 *     · 要停就在页面里点「退出控制台」（`/api/panel/quit`）—— 进程真退，目录随即能删
 *
 *  ⚠️ 为什么是 **SSE 而不是 WebSocket**：
 *     面板**刻意零第三方依赖**（`ws` 是给机器人用的，不是给面板用的），
 *     而 SSE 是纯 HTTP —— 一条 `text/event-stream` 响应就够了，不需要握手、不需要新端口。
 *     方向上也正好合适：日志是**单向**推送，命令走现成的 POST 写路由。
 *
 *  ⚠️ 为什么**不给**"在网页里执行任意命令"：那等于把本机 shell 开给浏览器里
 *     的任何脚本（DNS Rebinding 之后攻击者就是同源，见上面 S-05 那段）。
 *     终端页上的动作是**固定的几条**（起停 / 重启 / 自检 / 退出），
 *     每条都过 token + 跨源闸 —— 与页面其它写操作同一套闸门。
 */
const SSE_CLIENTS = new Set();

/**
 * 每压一行日志就推给所有在线的终端页。
 *
 * ⚠️ 为什么**只推增量**：页面自己有完整缓冲，重发整份会让"刷一下就重来一遍"。
 * ⚠️ 写失败（客户端已断开）就把它移出集合 —— 否则每来一行都要对一个死连接 write 一次。
 */
onLog((lines) => {
  if (SSE_CLIENTS.size === 0) return;
  const payload = `event: log\ndata: ${JSON.stringify({ lines })}\n\n`;
  for (const res of SSE_CLIENTS) {
    try { res.write(payload); } catch { SSE_CLIENTS.delete(res); }
  }
});

/** 把一帧 update 推给所有在线页面（与日志共用同一个 SSE 连接）。 */
function broadcastUpdate(payload) {
  if (SSE_CLIENTS.size === 0) return;
  const frame = `event: update\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of SSE_CLIENTS) {
    try { res.write(frame); } catch { SSE_CLIENTS.delete(res); }
  }
}

const UPDATE = createUpdater({
  onUpdate: (snapshot) => broadcastUpdate(snapshot),
  requestShutdown: () => shutdown('update-install'),
});

/**
 * 终端页的日志流（SSE）。
 *
 * 三帧：`hello`（连上先给一份现有日志，页面不用等）、`log`（增量）、`state`（心跳，
 * 让页面能显示"机器人在不在 / 协议端在不在"而**不必**去轮询 /api/state）。
 */
async function apiConsoleStream(req, res, url) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // 中间若有代理，别缓冲它 —— 缓冲住的 SSE 表现为"日志隔很久才跳一批"
    'X-Accel-Buffering': 'no',
    'X-Content-Type-Options': 'nosniff',
  });
  res.write('retry: 3000\n\n');
  res.write(`event: hello\ndata: ${JSON.stringify({
    lines: state.logs.slice(-200),
    total: logDropped + state.logs.length,
  })}\n\n`);
  res.write(`event: update\ndata: ${JSON.stringify(UPDATE.snapshot())}\n\n`);

  SSE_CLIENTS.add(res);
  let closed = false;
  const stop = () => { if (closed) return; closed = true; clearInterval(beat); SSE_CLIENTS.delete(res); };
  // 心跳：既是 liveness（浏览器能自己重连），也把"在不在跑"带下去
  // ⚠️ WS 端口在**这条流打开时取一次**（不写死 3001）：换端口要重连才生效，而浏览器自己会重连；
  //    每 3 秒读一次 config.json 不值得。这颗结果是当 `proto` 推给页面的 —— 它就是"屏幕上的端口"。
  const beatWsPort = onebotProbePorts().wsPort;
  const beat = setInterval(() => {
    if (closed) return;
    Promise.resolve(portOpen(beatWsPort))
      .then((proto) => {
        if (closed) return;
        res.write(`event: state\ndata: ${JSON.stringify({
          t: Date.now(), bridge: bridgeRunning(), proto, pid: process.pid,
        })}\n\n`);
      })
      .catch(() => {});
  }, 3000);
  req.on('close', stop);
  res.on('close', stop);
}

/** 从文件末尾读 N 行（**不整份读进内存** —— NapCat 的日志会长到几百 MB）。 */
function tailLines(file, maxLines = 200, maxBytes = 256 * 1024) {
  let size = 0;
  try { size = fs.statSync(file).size; } catch { return { lines: [], missing: true }; }
  const from = Math.max(0, size - maxBytes);
  const len = size - from;
  if (len <= 0) return { lines: [], missing: false };
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(len);
    let got = 0;
    while (got < len) {
      const n = fs.readSync(fd, buf, got, len - got, from + got);
      if (!n) break;
      got += n;
    }
    const all = buf.subarray(0, got).toString('utf8').split('\n');
    // 第一行通常是被截断的半行 —— 丢掉它，比显示一段乱码好
    if (from > 0 && all.length > 1) all.shift();
    return { lines: all.filter((l) => l.trim()).slice(-maxLines), missing: false };
  } finally {
    try { fs.closeSync(fd); } catch { /* 关不掉也无所谓 */ }
  }
}

/**
 * 终端页的"另一半"日志：协议端（NapCat）自己的输出。
 *
 * 路径从 `nativeLogFile()` 来（P1 起 NapCat 整树在 USER_ROOT/napcat）。
 */
async function apiConsoleTail(req, res, url) {
  const src = String(url.searchParams.get('src') || 'napcat');
  const n = Math.min(Math.max(Number(url.searchParams.get('lines') || 200), 1), 500);
  const file = src === 'panel' ? PANEL_LOG : nativeLogFile();
  const r = tailLines(file, n);
  return sendJson(res, {
    src, file: path.relative(USER_ROOT, file),
    lines: r.lines,
    missing: Boolean(r.missing),
    hint: r.missing ? '这个文件还不存在（协议端第一次跑起来之后才会写它）' : '',
  });
}

/**
 * 退出控制台。
 *
 * ⚠️ 存在的理由就是用户报的那个毛病：**要能关掉**。以前唯一的办法是在任务管理器里
 *    杀 node —— 而"杀进程"这件事普通用户不该被逼着去做，且杀完还会留下锁文件。
 * ⚠️ 只退**面板**。机器人是独立进程，这里绝不顺手杀它（与 `shutdown()` 同一条纪律）。
 * ⚠️ 先把响应发出去再退 —— 立刻 `process.exit` 的话浏览器只会看到"连接被掐断"，
 *    而用户需要的是一句"已退出"。
 */
/**
 * 窗口几何上报（2026-10-16）：独立窗口里的页面在 resize / 移动 / 关闭前把
 * screenX / screenY / outerWidth / outerHeight POST 到这里 ⇒ 写进
 * `panel/window-state.json`；下次启动由启动器 `--window-size/--window-position` 还原。
 *
 * ⚠️ 值域判据（normalizeWinState）只有 `src/launch-mode.js` 一份 —— 这里只接线。
 *    不合格就 400，**绝不把脏值落盘**（宁可不记，也不要"记住一个开不出来的位置"）。
 * ⚠️ 写盘失败如实回 500：本次开窗本来就不受影响，但页面那边会看到 ——
 *    将来排"为什么没记住"时，能分辨是"页面没报"还是"盘写不进去"。
 */
async function apiPanelWindow(req, res, url) {
  void url; // 统一签名（§81）：本 handler 用不到 url，但形状必须与全表一致 —— 少一个形参静态判据直接红
  const body = await readBody(req);
  const st = normalizeWinState(body);
  if (!st) return sendJson(res, { ok: false, error: '窗口几何不合法（尺寸越界或形状不对）' }, 400);
  try {
    const file = windowStatePath(CONFIG_FILE, PANEL_STATE_DIR);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify({ ...st, updatedAt: new Date().toISOString() }, null, 2)}\n`, 'utf8');
  } catch (e) {
    return sendJson(res, { ok: false, error: `窗口状态写不进去：${e && e.message ? e.message : e}` }, 500);
  }
  return sendJson(res, { ok: true });
}

async function apiPanelQuit(req, res, url) {
  pushLog('■ 正在退出控制台（页面点了「退出控制台」）—— 机器人不受影响');
  sendJson(res, { ok: true, msg: '控制台正在退出，约 1 秒后页面不再响应' });
  setTimeout(() => shutdown('quit'), 400);
  return undefined;
}

/* ══════════════ 角色卡「AI 认领」（2026-10-21 · Win-v0.1.2 移植）══════════
 * 把一张不标准格式的卡里的文字，归到十维的标准字段上 —— 这是"完整但不标准的卡
 * 永远分不出级"的解法。提示词与解析都在 `src/persona-adopt.js`（纯函数叶子），
 * 这里只做进程壳；认领**不直接改配置**：结果先回前端预览，用户点「写进这张卡」
 * 才合并进草稿，保存仍走 `/api/config`。
 *
 * ⚠️ 它花一次模型调用 → 归写路由（token + 审计 + 同源），而不是 READ_ONLY_POST。
 */
const ADOPT_TIMEOUT_MS = 110000;
function runAdopt(payload) {
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let done = false;
    const finish = (r) => { if (!done) { done = true; resolve(r); } };
    let child;
    try {
      child = spawn(NODE, [path.join(PROGRAM_ROOT, 'scripts', 'adopt-card.mjs')], {
        cwd: PROGRAM_ROOT,
        env: { ...process.env, QQBOT_CONFIG: CONFIG_FILE },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (e) {
      return finish({ ok: false, error: `起不来认领脚本：${e?.message || e}` });
    }
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* 已经退了 */ }
      finish({ ok: false, error: `认领超时（${Math.round(ADOPT_TIMEOUT_MS / 1000)} 秒）—— 本机模型慢的话再点一次` });
    }, ADOPT_TIMEOUT_MS);
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    child.on('error', (e) => { clearTimeout(timer); finish({ ok: false, error: `起不来认领脚本：${e?.message || e}` }); });
    child.on('close', () => {
      clearTimeout(timer);
      const lines = out.trim().split('\n').filter(Boolean);
      let data = null;
      try { data = JSON.parse(lines[lines.length - 1] || ''); } catch { /* 下面统一报错 */ }
      finish(data || { ok: false, error: '认领脚本没输出可解析的 JSON', detail: (out + err).slice(-800) });
    });
    // 卡文本走 stdin：它是用户输入，进 argv 会撞上"以 - 开头"和长度两道坑。
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

async function apiPersonaAdopt(req, res, url) {
  const body = await readBody(req);
  const name = String(body.name || '').slice(0, 40);
  const text = String(body.text || '').slice(0, 12000);
  const fields = body.fields && typeof body.fields === 'object' && !Array.isArray(body.fields) ? body.fields : {};
  if (text.trim().length < 20) {
    return sendJson(res, { ok: false, error: '这张卡里没有可认领的文字（至少 20 字）' }, 400);
  }
  pushLog(`… 角色卡 AI 认领：${name || '未命名'}（${text.length} 字）`);
  const r = await runAdopt({ name, text, fields });
  pushLog(r.ok ? `✓ AI 认领：认出 ${r.wrote.length} 维` : `✗ AI 认领失败：${r.error}`);
  return sendJson(res, r, r.ok ? 200 : 500);
}

/* ══════════════ 假 QQ 会话（2026-10-21 · Win-v0.1.2 移植）══════════════════
 * 四条路由只做**转发**：会话逻辑（斜杠命令、什么时候能说话）仍然只有
 * `scripts/fake-qq.mjs` 那一份实现，这里只是它的进程壳。
 * ⚠️ start 的"真机器人在不在跑"在**这一层**问：写进 lib 就得在那里引 pidfile/进程扫描。
 * ⚠️ SANDBOX 只挡"起真机器人"；假 QQ 恰恰是它的替代品，所以这里不拦。
 */
async function apiFakeState(req, res, url) {
  return sendJson(res, fakeSnapshot(Number(url.searchParams.get('since') || 0)));
}

async function apiFakeStart(req, res, url) {
  const body = await readBody(req);
  return sendJson(res, fakeStart(
    { offline: body.offline === true, sandbox: body.sandbox === true },
    { bridgeRunning: bridgeRunning() },
  ));
}

async function apiFakeSend(req, res, url) {
  const body = await readBody(req);
  return sendJson(res, fakeSend(body.text));
}

async function apiFakeStop(req, res, url) {
  return sendJson(res, fakeStop());
}

/* ── 0.1.5 接口收尾（2026-10-28）：背景 / 星标 / 扩展包 ───────────────── */
const BACKGROUNDS = createBackgroundStore({
  dir: path.join(DATA_DIR, 'backgrounds'),
  logger: { warn: (msg) => pushLog(`· ${msg}`) },
});
const STAR = createGithubStar({
  homepage: APP_HOMEPAGE,
  cacheFile: path.join(PANEL_STATE_DIR, 'github-star.json'),
  userAgent: `EstrellaBot-Panel/${APP_VERSION}`,
  logger: { warn: (msg) => pushLog(`· ${msg}`) },
});

/** 只看文件头，不把 24 MB 视频整份读进内存。 */
function readFileHead(file, n = 256) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(n);
    const got = fs.readSync(fd, buf, 0, n, 0);
    return buf.subarray(0, got);
  } finally {
    try { fs.closeSync(fd); } catch { /* 已关 */ }
  }
}

async function apiGithubStar(req, res, url) {
  const r = await STAR.get();
  if (r.ok) {
    return sendJson(res, {
      ok: true,
      count: r.count,
      cached: r.cached === true,
      fetchedAt: Number.isFinite(r.fetchedAt) ? r.fetchedAt : Date.now(),
    });
  }
  return sendJson(res, { ok: false, reason: r.reason || 'upstream_unavailable' }, 502);
}

async function apiBackgroundsList(req, res, url) {
  return sendJson(res, { ok: true, ...BACKGROUNDS.list() });
}

async function apiBackgroundsMedia(req, res, url) {
  let media;
  try {
    media = BACKGROUNDS.media(url.searchParams.get('id'), url.searchParams.get('v') || 'original');
  } catch (e) {
    return sendJson(res, { ok: false, error: e.message }, e.status || 404);
  }
  let stat;
  try { stat = fs.statSync(media.abs); } catch {
    return sendJson(res, { ok: false, error: '背景文件不存在' }, 404);
  }
  if (!stat.isFile()) return sendJson(res, { ok: false, error: '背景文件不存在' }, 404);

  const range = parseByteRange(req.headers.range, stat.size);
  const headers = {
    'Content-Type': media.type,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=31536000, immutable',
    'X-Content-Type-Options': 'nosniff',
  };
  if (range && range.invalid) {
    res.writeHead(416, { ...headers, 'Content-Range': `bytes */${stat.size}`, 'Content-Length': '0' });
    return res.end();
  }
  const sendStream = (start, end, status, extra) => {
    res.writeHead(status, { ...headers, ...extra });
    const stream = fs.createReadStream(media.abs, start == null ? undefined : { start, end });
    stream.on('error', (e) => {
      pushLog(`✗ 背景媒体发送失败：${e.message}`);
      res.destroy();
    });
    res.on('close', () => stream.destroy());
    return stream.pipe(res);
  };
  if (range) {
    return sendStream(range.start, range.end, 206, {
      'Content-Range': `bytes ${range.start}-${range.end}/${stat.size}`,
      'Content-Length': String(range.end - range.start + 1),
    });
  }
  return sendStream(null, null, 200, { 'Content-Length': String(stat.size) });
}

async function handleBackgroundDisplay(req, res, url) {
  const id = String(url.searchParams.get('id') || '');
  const meta = BACKGROUNDS.get(id);
  if (!meta) return sendJson(res, { ok: false, error: '背景不存在' }, 404);
  if (meta.type !== 'image') return sendJson(res, { ok: false, error: '只有图片能调整画面' }, 400);

  const tmp = BACKGROUNDS.tmpPathFor('display');
  const got = await readBodyToFile(req, { file: tmp, maxBytes: BG_LIMITS.display });
  if (!got.ok) {
    const tooBig = got.error === 'too-large';
    return sendJson(res, { ok: false, error: tooBig ? '裁切图超过 2 MB' : '上传中断' }, tooBig ? 413 : 400);
  }
  let sniff = null;
  try { sniff = sniffBackground(readFileHead(tmp)); } catch { /* 下面按 415 处理 */ }
  if (!sniff || sniff.format !== 'jpg') {
    fs.rmSync(tmp, { force: true });
    return sendJson(res, { ok: false, error: '裁切图必须是 JPEG' }, 415);
  }
  const crop = {
    zoom: Number(url.searchParams.get('zoom')),
    x: Number(url.searchParams.get('x')),
    y: Number(url.searchParams.get('y')),
  };
  try {
    const r = await BACKGROUNDS.setDisplay({
      id,
      bytes: got.size,
      crop,
      saveFile: (abs) => renameWithRetry(tmp, abs),
    });
    return sendJson(res, { ok: true, item: r.item });
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    return sendJson(res, { ok: false, error: e.message }, e.status || 400);
  }
}

async function apiBackgroundsUpload(req, res, url) {
  if (url.searchParams.get('slot') === 'display') return handleBackgroundDisplay(req, res, url);

  const name = sanitizeBackgroundName(url.searchParams.get('name'));
  const sourceKey = url.searchParams.get('sourceKey') || '';
  const tmp = BACKGROUNDS.tmpPathFor('original');
  const got = await readBodyToFile(req, { file: tmp, maxBytes: BG_LIMITS.video });
  if (!got.ok) {
    const tooBig = got.error === 'too-large';
    return sendJson(res, { ok: false, error: tooBig ? '视频超过 24 MB' : '上传中断' }, tooBig ? 413 : 400);
  }
  let sniff = null;
  try { sniff = sniffBackground(readFileHead(tmp)); } catch { /* 下面按 415 处理 */ }
  if (!sniff) {
    fs.rmSync(tmp, { force: true });
    return sendJson(res, {
      ok: false,
      error: '只支持 JPG/PNG/WEBP/GIF/AVIF/BMP 与 MP4/WEBM（SVG/MOV/MKV 不支持）',
    }, 415);
  }
  if (got.size > BG_LIMITS[sniff.type]) {
    fs.rmSync(tmp, { force: true });
    return sendJson(res, {
      ok: false,
      error: `${sniff.type === 'video' ? '视频' : '图片'}超过 ${Math.round(BG_LIMITS[sniff.type] / 1024 / 1024)} MB`,
    }, 413);
  }
  try {
    const r = await BACKGROUNDS.add({
      format: sniff.format,
      type: sniff.type,
      name,
      bytes: got.size,
      sourceKey,
      saveFile: (abs) => renameWithRetry(tmp, abs),
    });
    if (r.deduped) fs.rmSync(tmp, { force: true });
    return sendJson(res, { ok: true, item: r.item, deduped: r.deduped === true });
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    return sendJson(res, { ok: false, error: e.message }, e.status || 400);
  }
}

async function apiBackgroundsActive(req, res, url) {
  const body = await readBody(req);
  try {
    const activeId = await BACKGROUNDS.setActive(body.id == null ? null : String(body.id));
    return sendJson(res, { ok: true, activeId });
  } catch (e) {
    return sendJson(res, { ok: false, error: e.message }, e.status || 400);
  }
}

async function apiBackgroundsDelete(req, res, url) {
  const body = await readBody(req);
  try {
    const r = await BACKGROUNDS.remove(String(body.id || ''));
    return sendJson(res, { ok: true, activeId: r.activeId });
  } catch (e) {
    return sendJson(res, { ok: false, error: e.message }, e.status || 400);
  }
}

async function apiExtensionsPackage(req, res, url) {
  const got = await readBodyBuffer(req, { maxBytes: PACK_REQUEST_MAX });
  if (!got.ok) {
    return sendJson(res, {
      ok: false,
      error: got.error === 'too-large' ? '打包请求太大（上限 6 MB）' : '上传中断',
    }, got.error === 'too-large' ? 413 : 400);
  }
  let body;
  try {
    body = JSON.parse(got.buf.toString('utf8') || '{}');
  } catch {
    return sendJson(res, { ok: false, error: '请求不是合法 JSON' }, 400);
  }
  try {
    const r = packExtension(body && typeof body === 'object' ? body : {});
    return sendJson(res, {
      ok: true,
      kind: r.kind,
      root: r.root,
      files: r.files,
      zipBytes: r.zip.length,
      zipBase64: r.zip.toString('base64'),
    });
  } catch (e) {
    return sendJson(res, { ok: false, error: e.message }, e.status || 400);
  }
}

const apiUpdateState = makeUpdateRoute({ updater: UPDATE, action: 'state' });
const apiUpdateCheck = makeUpdateRoute({ updater: UPDATE, action: 'check' });
const apiUpdateDownload = makeUpdateRoute({ updater: UPDATE, action: 'download' });
const apiUpdateInstall = makeUpdateRoute({ updater: UPDATE, action: 'install' });
const apiUpdateCancel = makeUpdateRoute({ updater: UPDATE, action: 'cancel' });
const apiUpdateOfflinePrepare = makeOfflinePrepareRoute({ updater: UPDATE });
const apiUpdateOfflineInstaller = makeOfflineInstallerRoute({ updater: UPDATE });

const API_ROUTES = [
  // 安装器/启动器就绪信号（P2）：只读、无鉴权；启动器只认它来判断版本。
  { path: '/api/health', handler: apiHealth },
  // 应用内更新（P3）：GET state 只读；4 个 POST 在 WRITE_ROUTES。
  { path: '/api/update/state', handler: apiUpdateState },
  { path: '/api/update/check', method: 'POST', handler: apiUpdateCheck },
  { path: '/api/update/download', method: 'POST', handler: apiUpdateDownload },
  { path: '/api/update/install', method: 'POST', handler: apiUpdateInstall },
  { path: '/api/update/cancel', method: 'POST', handler: apiUpdateCancel },
  // P4 离线更新：两段式，先清单/签名，再原始 EXE 字节。
  { path: '/api/update/offline/prepare', method: 'POST', handler: apiUpdateOfflinePrepare },
  { path: '/api/update/offline/installer', method: 'POST', handler: apiUpdateOfflineInstaller },
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
  // 2026-10-17：添加模型时按地址识别厂商（纯读：厂商名 / 默认线路 / 额度官网）
  { path: '/api/provider-info', handler: apiProviderInfo },
  { path: '/api/custom-brain/save', method: 'POST', handler: apiCustomBrainSave },
  { path: '/api/custom-brain/rename', method: 'POST', handler: apiCustomBrainRename },
  { path: '/api/custom-brain/delete', method: 'POST', handler: apiCustomBrainDelete },
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
  { path: '/api/protocol/start', method: 'POST', handler: apiProtocolStart },
  { path: '/api/napcat/restart', method: 'POST', handler: apiNapcatRestart },
  // P11：协议端没装时的两条自助路（自动查找导入 / 打开目录）。
  { path: '/api/napcat/import-auto', method: 'POST', handler: apiNapcatImportAuto },
  { path: '/api/napcat/open-folder', method: 'POST', handler: apiNapcatOpenFolder },
  { path: '/api/qrcode', handler: apiQrcode },
  { path: '/api/qrcode/refresh', method: 'POST', handler: apiQrcodeRefresh },
  { path: '/api/logs/clear', method: 'POST', handler: apiLogsClear },
  { path: '/api/panel/restart', method: 'POST', handler: apiPanelRestart },
  // 网页内置终端（2026-10-11）：流是**只读**的（GET），退出是写路由（见 WRITE_ROUTES）。
  { path: '/api/console/stream', handler: apiConsoleStream },
  { path: '/api/console/tail', handler: apiConsoleTail },
  { path: '/api/panel/quit', method: 'POST', handler: apiPanelQuit },
  // 窗口记忆（2026-10-16）：独立窗口的位置与尺寸上报（页面 resize / 移动 / 关窗前发）。
  { path: '/api/panel/window', method: 'POST', handler: apiPanelWindow },
  // 角色卡 AI 认领（2026-10-21）：写路由（花一次模型调用、记用量），结果只预览。
  { path: '/api/persona/adopt', method: 'POST', handler: apiPersonaAdopt },
  // 假 QQ 会话（2026-10-21）：状态 GET；起 / 说 / 停是 POST（在 WRITE_ROUTES）。
  { path: '/api/fake-qq/state', handler: apiFakeState },
  { path: '/api/fake-qq/start', method: 'POST', handler: apiFakeStart },
  { path: '/api/fake-qq/send', method: 'POST', handler: apiFakeSend },
  { path: '/api/fake-qq/stop', method: 'POST', handler: apiFakeStop },
  // 0.1.5 接口收尾（2026-10-28）：星标 / 自定义背景 / 扩展包构建。
  { path: '/api/github/star', handler: apiGithubStar },
  { path: '/api/backgrounds', handler: apiBackgroundsList },
  { path: '/api/backgrounds/media', handler: apiBackgroundsMedia },
  { path: '/api/backgrounds', method: 'POST', handler: apiBackgroundsUpload },
  { path: '/api/backgrounds/active', method: 'POST', handler: apiBackgroundsActive },
  { path: '/api/backgrounds/delete', method: 'POST', handler: apiBackgroundsDelete },
  { path: '/api/extensions/package', method: 'POST', handler: apiExtensionsPackage },
];
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${ACTUAL_PORT || PORT}`);
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
  // ⚠️ 这一道**挡不住** Rebinding（重绑之后 Host 就是 `127.0.0.1:<实际端口>`，完全合法）；
  //    那一半由下面鉴权段里的 `sameSiteWrite()` 负责。两道互补，缺一链就还是通的。
  if (!isLoopbackHost(String(req.headers.host || ''))) {
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
    // ── MBTI 官方场景图（2026-10-26）────────────────────────────────────
    // 页面在 `/`，所以相对引用落在 `/assets/mbti/<file>`；不能写 `/next/assets/…`
    // （那会被下面的旧地址兼容分支当 302 处理）。只发 16 张白名单 jpg，
    // 名字校验与路径囚笼在 `readMbtiArt()` 里，不在这里再抄一份名单。
    if (p.startsWith('/assets/mbti/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return sendJson(res, { error: 'method not allowed' }, 405);
      }
      try {
        const art = readMbtiArt(p.slice('/assets/mbti/'.length));
        res.writeHead(200, {
          'Content-Type': art.type,
          'Cache-Control': 'public, max-age=86400',
          'X-Content-Type-Options': 'nosniff',
        });
        return res.end(req.method === 'HEAD' ? undefined : art.raw);
      } catch (e) {
        return sendJson(res, { error: `MBTI 场景图取不到：${e.message}` }, 404);
      }
    }

    // ── 等高线背景媒体（2026-10-26）──────────────────────────────────────
    // 10MB 级视频必须支持 Range：没有 Accept-Ranges 时浏览器会重复整段请求，
    // 循环/换主题都会重新下载；全量 readFileSync 也会把整段视频常驻服务端内存。
    // 名字白名单与路径囚笼在 `resolveContourMedia()` 里，不在这里再抄一份。
    if (p.startsWith('/assets/contour/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return sendJson(res, { error: 'method not allowed' }, 405);
      }
      let media;
      try {
        media = resolveContourMedia(p.slice('/assets/contour/'.length));
      } catch (e) {
        return sendJson(res, { error: `等高线媒体取不到：${e.message}` }, 404);
      }
      let stat;
      try {
        stat = fs.statSync(media.abs);
      } catch (e) {
        return sendJson(res, { error: `等高线媒体取不到：${e.message}` }, 404);
      }
      if (!stat.isFile()) return sendJson(res, { error: 'not found' }, 404);
      const range = parseByteRange(req.headers.range, stat.size);
      const baseHeaders = {
        'Content-Type': media.type,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'public, max-age=31536000, immutable',
        'X-Content-Type-Options': 'nosniff',
      };
      if (range && range.invalid) {
        res.writeHead(416, {
          ...baseHeaders,
          'Content-Range': `bytes */${stat.size}`,
          'Content-Length': '0',
        });
        return res.end();
      }
      const sendStream = (start, end, headers) => {
        res.writeHead(headers.status, headers.headers);
        if (req.method === 'HEAD') return res.end();
        const stream = fs.createReadStream(media.abs, start == null ? undefined : { start, end });
        stream.on('error', (e) => {
          pushLog(`✗ 等高线媒体发送失败：${e.message}`);
          res.destroy();
        });
        res.on('close', () => stream.destroy());
        return stream.pipe(res);
      };
      if (range) {
        return sendStream(range.start, range.end, {
          status: 206,
          headers: {
            ...baseHeaders,
            'Content-Range': `bytes ${range.start}-${range.end}/${stat.size}`,
            'Content-Length': String(range.end - range.start + 1),
          },
        });
      }
      return sendStream(null, null, {
        status: 200,
        headers: { ...baseHeaders, 'Content-Length': String(stat.size) },
      });
    }

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
      const bundle = assetHttpBundle(asset, body);
      const useGzip = /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''));
      const etag = useGzip ? bundle.gzipEtag : bundle.etag;
      const payload = useGzip ? bundle.gzip : bundle.buf;
      const isEntry = asset.name === NEXT_ENTRY;
      const headers = {
        'Content-Type': asset.type,
        // 资产允许浏览器存，但每次必须回源协商（ETag/304）；入口页带 token，仍不落盘。
        'Cache-Control': isEntry ? 'no-store' : 'no-cache',
        // 类型是上面那张表按扩展名写死的，不许浏览器再嗅探一遍（H-02 的配套加固）
        'X-Content-Type-Options': 'nosniff',
        'ETag': etag,
        'Vary': 'Accept-Encoding',
        'Content-Length': String(payload.length),
      };
      if (useGzip) headers['Content-Encoding'] = 'gzip';
      const inm = String(req.headers['if-none-match'] || '');
      if (!isEntry && inm.split(',').map((s) => s.trim()).includes(etag)) {
        delete headers['Content-Length'];
        delete headers['Content-Encoding'];
        res.writeHead(304, headers);
        return res.end();
      }
      // CSP **只发入口页**（2026-10-05 · 开源前审查第 10 轮 · H-02）。
      // 两条理由（完整版见 `PANEL_CSP` 的注释，别在这儿再抄一遍）：
      //   ① CSP 只对**文档**生效 —— JS/CSS 资产不是文档，发了没有意义；
      //   ② `panel/next/` 下的 `lab-*.html` 是自带**内联样式**的独立实验室页，
      //      套同一份策略会把它们当场打坏（而它们是"判据的可视化"，要能双击打开）。
      if (asset.name === NEXT_ENTRY) headers['Content-Security-Policy'] = PANEL_CSP;
      res.writeHead(200, headers);
      return res.end(payload);
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
  writeLastExit(path.join(PANEL_STATE_DIR, '.last-exit.json'), {
    code: 1, reason: e.code === 'EADDRINUSE' ? 'addr-in-use' : `listen-${e.code || 'error'}`,
    pid: BOOT.pid, uptimeMs: Date.now() - BOOT.at,
  });
  lastExitWritten = true;
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', async () => {
  // P3-1：系统分配端口之后，**实际端口**只能从 listen 的地址里拿。
  // 发现文件必须在任何其它启动工作之前写：启动器正在轮询它，晚一步就是"面板起来了但窗不开"。
  const addr = server.address();
  ACTUAL_PORT = addr && typeof addr === 'object' ? Number(addr.port) : 0;
  try {
    panelDiscovery.writeDiscovery(USER_ROOT, {
      pid: process.pid,
      port: ACTUAL_PORT,
      appId: APP_ID,
      version: APP_VERSION,
      mode: MODE,
      startedAt: new Date(BOOT.at).toISOString(),
    });
  } catch (e) {
    // 写不出发现文件 = 启动器/壳永远找不到这个端口。宁可当场退出并留痕，也不留一台"活着但打不开"的面板。
    console.error(`✗ 面板端口发现文件写不进去：${e && e.message ? e.message : e}`);
    if (!lastExitWritten) {
      writeLastExit(path.join(PANEL_STATE_DIR, '.last-exit.json'), {
        code: 1, reason: 'discovery-write-failed', pid: BOOT.pid, uptimeMs: Date.now() - BOOT.at,
      });
      lastExitWritten = true;
    }
    process.exit(1);
  }

  // 静态资产的 gzip/ETag 缓存：延后 100ms 预热，先让发现文件与健康检查拿到响应。
  setTimeout(warmAssetBundles, 100).unref?.();

  // 新面板已经把旧面板接回来了；重启看门狗的使命结束，删掉 intent 免得下次退出时误杀。
  try { fs.rmSync(path.join(PANEL_STATE_DIR, '.restart.json'), { force: true }); } catch { /* 没有就算了 */ }
  // 第 58 轮 · **预热 Windows 进程快照**。
  // 真机实测：`powershell` 光启动就约 1030 ms，而窗口刚起来时用户正好会点开页面 ⇒
  // 不预热的话那一次 `/api/state` 要把整条冷路径走完，观感就是"面板卡住了"。
  // 这里**刻意不 await**：让它与下面的清扫 / 接管并发跑；15 秒 TTL 足够覆盖"打完枪 → 用户点开"。
  // 失败无害 —— `winProcessSnapshot` 自己吞异常并返回 null，只是退回原来的冷启动。
  if (IS_WIN) winProcessSnapshot().catch(() => {});

  // 清扫"属主已死"的原子写临时文件（第 48 轮 B12e-4 · EX-TEMPSWEEP）。
  // 机器人与面板**各扫一次是刻意的**：两个进程都可能被杀，谁先起来谁先清干净。
  // 判据（"不是我的 && 够旧"）保证不会删掉另一个**活着**进程正在写的那一份。
  // ⚠️ 清扫面**必须含插件的两个根**（D21）：插件安装的 staging / 备份临时目录
  //    就落在 `plugins/` 与 `skills/` 里（与目标同根同级，rename 才是原子的）。
  const swept = sweepStaleTemps([
    PANEL_STATE_DIR, DATA_DIR, path.join(DATA_DIR, 'backgrounds'), UPDATE_DIR,
    ...extensionRoots(USER_ROOT).map((r) => r.dir),
  ]);
  if (swept.length) pushLog(`清理了 ${swept.length} 个残留的原子写临时文件（上次被强杀时留下的）`);

  await adoptExistingBridge();
  pushLog('控制台已启动');
  UPDATE.start();
  // P10：安装形态（桌面图标那条链）启动时把协议端顺手带起来，见函数头注释。
  // 设置里关掉 autoProtocol 时连守护一起跳过 —— 否则手动启动后进程一死，
  // 守护又会把它拉回来，与「不自动拉起」自相矛盾。
  if (IS_WIN && MODE === 'installed' && !SANDBOX) {
    if (LAUNCH_PREFS.autoProtocol === false) pushLog('· 协议端自动拉起已关闭（设置里关的）—— 只手动启动，守护也不会自动重启');
    else void autoStartNapcatIfInstalled();
  }
  /* 官方模型目录对账（2026-10-17 · 2026-10-19 P10 修）：启动这一下跑一次 —— DeepSeek 之类改了版本/地址，
     会在这里被对齐，并把一条事件留给页面弹右下角提示。
     ⚠️ `maybeSyncModelCatalog()` 是**同步且永不抛**的叶子（model-sync.js 头部写着）——
        原来这里挂着 `.catch(() => {})`：对非 Promise 调 .catch 直接 TypeError，
        真机每次启动在日志里红一条"面板未处理的 Promise 拒绝"（沙箱跳过这行，所以回归一直没吭声）。
        用 setImmediate 挪出 listen 回调 = 原注释"不拖住首屏"的本意。
     ⚠️ 节流 6 小时在模块里，`/api/state` 也会调它（用户天天开着面板也能覆盖到）。
     ⚠️ **沙箱里不跑**：它会**写 config.json**，而 `test/panel-dom.mjs` / `panel-boot.mjs`
        起的是"沙箱标志 + 真机配置"（沙箱只挡进程，不挡文件）。让它在那儿跑，
        等于每次跑一遍回归就改一次用户配置 —— 那类副作用以前踩过（见 sandbox.sh 顶部的注释）。 */
  if (!SANDBOX) setImmediate(() => maybeSyncModelCatalog());
  console.log(`\n  Estrella Bot Console 已启动`);
  console.log(`  → http://127.0.0.1:${ACTUAL_PORT}（本次实际端口，已写入 panel/.panel.json）\n`);
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
/**
 * 把一段字符串包成 PowerShell 的**单引号字面量**（2026-10-08）。
 *
 * ⚠️ 用单引号而不是双引号：PowerShell 的 `"…"` 会**做变量插值**（`$` / 反引号都会被解释），
 *    而项目路径里出现 `$` 不是天方夜谭。单引号里唯一的元字符是 `'` 本身 ——
 *    按 PowerShell 的规矩写成两个 `''` 即可。
 * ⚠️ 这与 launcher.sh 那条"通知文案走参数、不拼进 AppleScript 源码"是**同一条纪律**：
 *    数据永远不进代码通道。
 */
function psQuote(s) {
  return "'" + String(s ?? '').replace(/'/g, "''") + "'";
}

let restarting = false;
/** 正在退出时 /api/health 回 503（规格 §7.4）；启动器只认 200 + 身份匹配。 */
let PANEL_SHUTTING_DOWN = false;
function restartPanel() {
  if (restarting) return { ok: true, restarted: false, msg: '面板正在重启中，稍等它自己回来' };
  const info = panelInfo();
  // 没换过代码就什么都不做：launcher.sh 每次开 .app 都会调一次，幂等是硬要求
  if (!info.stale) return { ok: true, restarted: false, msg: `面板已是最新代码（pid ${info.pid}）` };

  restarting = true;
  const log = PANEL_LOG;
  // P3-1：重启必须**沿用实际端口**。否则看门狗起的新进程会再分配一个端口，而页面还停在
  // 旧 origin 上 —— 表现就是"点了重启，页面再也连不上"，且新端口没人知道。
  const restartEnv = { ...process.env, QQBOT_PANEL_PORT: String(ACTUAL_PORT || PORT || 0) };
  // ── 看门狗命令：两个平台是两种 shell（2026-10-08）─────────────────────────
  // ⚠️ Windows 上没有 `/bin/sh`，也没有 `kill -0` / `exec` / `>>` 这套写法。
  //    那一支用 PowerShell：`Wait-Process` 等旧进程退、`Set-Location` 换目录、
  //    `&` 调用、`*>>` 把**所有**流一起追加进日志（`1>`+`2>` 会漏掉 warning/verbose）。
  //    仍然走 `-EncodedCommand`，理由与进程枚举那一处相同（引号一个字都不用转义）。
  // ⚠️ 两支都**必须 detached + unref**：它是我们的"遗言"，跟着一起死就没人拉起来了。
  try {
    if (IS_WIN) {
      const ps = `Wait-Process -Id ${BOOT.pid} -ErrorAction SilentlyContinue; `
        + `Set-Location -LiteralPath ${psQuote(PROGRAM_ROOT)}; `
        + `& ${psQuote(NODE)} ${psQuote(PANEL_FILE)} *>> ${psQuote(log)}`;
      const child = spawn(POWERSHELL, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodePwshCommand(ps)], { detached: true, stdio: 'ignore', windowsHide: true, env: restartEnv });
      child.unref();
      try {
        fs.writeFileSync(path.join(PANEL_STATE_DIR, '.restart.json'), `${JSON.stringify({ watchdogPid: child.pid, oldPanelPid: BOOT.pid, at: new Date().toISOString() })}\n`);
      } catch { /* 看门狗标记写不进去不阻断重启 */ }
    } else {
      const cmd = `while kill -0 ${BOOT.pid} 2>/dev/null; do sleep 0.2; done; `
        + `cd ${JSON.stringify(PROGRAM_ROOT)} && exec ${JSON.stringify(NODE)} ${JSON.stringify(PANEL_FILE)} `
        + `>> ${JSON.stringify(log)} 2>&1`;
      const child = spawn('/bin/sh', ['-c', cmd], { detached: true, stdio: 'ignore', windowsHide: true, env: restartEnv });
      child.unref();
      try {
        fs.writeFileSync(path.join(PANEL_STATE_DIR, '.restart.json'), `${JSON.stringify({ watchdogPid: child.pid, oldPanelPid: BOOT.pid, at: new Date().toISOString() })}\n`);
      } catch { /* 同上 */ }
    }
  } catch (e) {
    restarting = false;
    return { ok: false, error: `重启器起不来：${e.message}` };
  }
  pushLog('控制台正在重启（加载新代码）…');
  // 先让响应发出去再退出 —— 立刻 process.exit 的话浏览器只会看到"连接被掐断"
  setTimeout(() => shutdown('restart'), PANEL_EXIT_SETTLE_MS);
  return { ok: true, restarted: true, msg: '面板正在重启，约 2 秒后自动回来', oldPid: BOOT.pid };
}

function shutdown(reason = 'quit') {
  if (!lastExitWritten) {
    writeLastExit(path.join(PANEL_STATE_DIR, '.last-exit.json'), {
      code: 0, reason, pid: BOOT.pid, uptimeMs: Date.now() - BOOT.at,
    });
    lastExitWritten = true;
  }
  PANEL_SHUTTING_DOWN = true;
  // P3-1：只清**自己的**发现文件（pid 必须匹配）。重启时空窗由新进程 listen 后重新写。
  try { panelDiscovery.clearDiscovery(USER_ROOT, process.pid); } catch { /* 退出路径不许再抛 */ }
  // 面板退出也要停守护；否则它会在进程退出前最后一拍把协议端拉起来（留下孤儿）。
  void protocolGuard.stop();
  try { UPDATE.stop(); } catch { /* 退出路径不许再抛 */ }
  // 假 QQ 是面板起的子进程 —— 面板退了她也活不成（它会攥着临时锁，变成孤儿）。
  try { fakeDispose(); } catch { /* 退出路径不许再抛 */ }
  // 故意不杀机器人：控制台只是「面板」，机器人是独立进程。
  // 要停机器人请用面板里的「一键全停」。
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), PANEL_EXIT_GRACE_MS);
}
process.on('SIGINT', () => shutdown('sigint'));
process.on('SIGTERM', () => shutdown('sigterm'));
process.on('exit', (code) => {
  // 强杀/异常退出也要收掉自己的发现文件；不匹配的（已经是新面板写的）不碰。
  try { panelDiscovery.clearDiscovery(USER_ROOT, process.pid); } catch { /* 退出路径不许再抛 */ }
  if (lastExitWritten) return;
  writeLastExit(path.join(PANEL_STATE_DIR, '.last-exit.json'), {
    code, reason: 'process-exit', pid: BOOT.pid, uptimeMs: Date.now() - BOOT.at,
  });
});

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
  appendPanelEvent(path.join(PANEL_STATE_DIR, 'crashes', 'panel-events.jsonl'), {
    kind: 'panel-uncaught', reason: kind, message: body,
  });
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
