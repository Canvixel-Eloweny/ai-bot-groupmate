/**
 * 面板进程的**路径与端口常量**（第 37 轮 B11b-1 · AR-SERVERSPLIT）
 * ══════════════════════════════════════════════════════════════════════════
 *  为什么路径要单独抽一个模块 —— 因为 `ROOT` 是**搬了就静默失效**的东西
 * ══════════════════════════════════════════════════════════════════════════
 *  P1（2026-10-18）起，根解析的唯一实现在 `src/user-root.js`：它同时服务
 *  面板、机器人与打包工具，并区分 program / install / user 三根。本文件只消费结果。
 *  历史上这里推导过 ROOT；搬动 helper 会让相对层级算错，而错误表现为
 *  “面板突然变回默认配置”——不报错，所以根解析必须只有一处。
 *
 *  ⚠️ 下面这个自检**故意做成抛错**而不是打日志：
 *     路径全错的情况下继续启动，只会得到一台"配置全是默认值、写盘也写错地方"的面板，
 *     那比启动失败更难查。宁可当场崩，也不要静默跑错。
 *
 *  ⚠️ 本模块**不许 import 面板里的其它模块** —— 它是依赖图的最底层（F.3 的 L0）。
 *     `src/user-root.js` 是零业务依赖叶子（已登记 `LIB_SRC_ALLOW`），可以 import。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveRoots, ensureUserDirs, programFile, userFile, panelFile, UPDATE_DIR } from '../../src/user-root.js';

// 根解析的唯一实现在 src/user-root.js（P1 · 2026-10-18）。
// 这里只消费结果，不再导出 ROOT 别名。
const ROOTS = resolveRoots();

export const PROGRAM_ROOT = ROOTS.programRoot;
export const INSTALL_ROOT = ROOTS.installRoot;
export const USER_ROOT = ROOTS.userRoot;
export const MODE = ROOTS.mode;
export const PANEL_STATE_DIR = ROOTS.panelStateDir;
export const NAPCAT_DIR = ROOTS.napcatDir;
export { ensureUserDirs, UPDATE_DIR };

// 自检：程序根一定有 package.json（`"type": "module"` 就写在里面）。
// 根算错时立刻炸，而不是让整台面板用着默认配置继续跑。
if (!fs.existsSync(programFile('package.json'))) {
  throw new Error(
    `PROGRAM_ROOT 算错了：${PROGRAM_ROOT} 下没有 package.json。` +
      ' 检查 src/user-root.js 与 package.json 的层级。'
  );
}

/**
 * 安装器/健康端点的身份字段。**只从程序根的 package.json 读一次** ——
 * 这是版本与 appId 的唯一来源（P2 §108）；另写一份常量就会在升级后漂移。
 */
const PKG = JSON.parse(fs.readFileSync(programFile('package.json'), 'utf8'));
if (typeof PKG.appId !== 'string' || !PKG.appId.trim() || typeof PKG.version !== 'string' || !PKG.version.trim()) {
  throw new Error('package.json 必须同时有非空的 appId 与 version（安装器/健康端点依赖它们）');
}
export const APP_ID = PKG.appId.trim();
export const APP_VERSION = PKG.version.trim();

/** 面板监听端口。`QQBOT_PANEL_PORT` 让沙箱/多实例能改（既有约定，不变）。 */
export const PORT = Number(process.env.QQBOT_PANEL_PORT) || 8788;

/**
 * 沙箱隔离开关：`test/sandbox.sh` 起面板时置 1。
 * 开了之后面板**绝不**接管/启动/停止任何真实机器人进程 —— 这是沙箱的**唯一有效防线**
 * （另外两道 rsync 排除 / 前置闸门只是纵深）。见项目记忆里的两次误杀事故。
 * ⚠️ 加载期读取：测试里改 `process.env` 无效（进程已经起来了）。
 */
export const SANDBOX = process.env.QQBOT_SANDBOX === '1';

/** node 可执行文件。重启看门狗用它 exec 新面板。 */
export const NODE = process.execPath;

// ── 端口（可用环境变量覆盖）──────────────────────────────────────────────
// 为什么都做成可覆盖：沙箱过去是用 `perl -pi -e` **就地改 server.js 里的字面量**来换端口的。
// 那是"搬家就静默失效"的老毛病（perl 找不到就不再替换，而且不报错）——
// 沙箱于是还在用真机端口，隔离的前提悄悄没了。
// 改成环境变量之后，常量放哪都不影响，文本补丁也彻底不需要了。
//
// @sync-with sandbox-port-env
//   两个变量名必须与 `test/sandbox.sh` 里设的那两个**逐字相同**。
//   以前只查了这一侧（`paths.js` 里有没有这个名字），没查沙箱那边 ——
//   一侧改名、另一侧没跟，表现是"沙箱用回真机端口"，要等真机在跑时才炸。
/** 本机 mlx 通道端口（`mlx_lm.server`） */
export const LOCAL_MODEL_PORT = Number(process.env.QQBOT_LOCAL_MODEL_PORT) || 8080;
/** QwenChat 通道端口（`~/models/app/server.py` 自带的服务） */
export const QWENCHAT_PORT = Number(process.env.QQBOT_QWENCHAT_PORT) || 8765;
/** NapCat 的 WebUI 端口（换二维码走它） */
export const NAPCAT_WEBUI_PORT = 6099;

// ── 本机已有的一些程序路径（沿用上一个项目留下的布局）────────────────────
/**
 * 当前平台是不是 Windows（2026-10-08 · Windows 适配）。
 *
 * ⚠️ **平台判据只在这里下一份**，别处一律 `import` 它 —— 与 `ROOT` 同一条纪律：
 *    散开之后，"哪几个地方会按平台分支"就没人答得上来了，而
 *    **分支漏一处不会报错**（只会表现为某个平台上一个按钮点了没反应）。
 */
export const IS_WIN = process.platform === 'win32';

/**
 * 用户主目录。⚠️ `process.env.HOME` **在 Windows 上通常不存在**（那边叫 `USERPROFILE`）——
 * 所以必须回落到 `os.homedir()`，否则本机模型那几条路径会拼成 `/models/bin/…`
 * 这种相对路径（既不存在、也不报错）。
 */
export const HOME = process.env.HOME || os.homedir() || '';
export const QWEN_SERVER = path.join(HOME, 'models', 'bin', 'qwen-server');
export const QWENCHAT_SERVER = path.join(HOME, 'models', 'app', 'server.py');
// ⚠️ 2026-10-17 从 ~/.workbuddy/binaries/python/envs/mlx 迁出（WorkBuddy 平台目录已删）。
// 迁移方式是整份复制 base 解释器 + venv 后重指符号链接，docstring 见
// memory/logs/2026-10-17.md；换机器时按同样结构重建即可。
export const MLX_PY = path.join(HOME, 'Library', 'Application Support', 'estrella-mlx', 'venv', 'bin', 'python');

// ── docker 可执行文件：按候选表找第一个真的存在的 ─────────────────────────
/**
 * ⚠️ Windows 上 Docker Desktop 把 CLI 放在 `…\Docker\Docker\resources\bin\docker.exe`，
 *    **不在 PATH 里** —— 装完不重开终端就是 `docker: command not found`。
 *    找不到时回落到裸命令名（交给 PATH）。
 */
export const DOCKER_CANDIDATES = IS_WIN
  ? [
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Docker', 'Docker', 'resources', 'bin', 'docker.exe'),
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Docker', 'Docker', 'resources', 'bin', 'docker'),
    ]
  : [
      '/Applications/Docker.app/Contents/Resources/bin/docker',
      '/usr/local/bin/docker',
      '/opt/homebrew/bin/docker',
    ];
export const DOCKER = DOCKER_CANDIDATES.find((p) => fs.existsSync(p)) || 'docker';

/**
 * Docker Desktop 的**应用入口** —— "把它拉起来"用的那个东西。
 *
 * ⚠️ 两个平台上它完全是两种东西：macOS 是个 `.app` **目录**（要 `open -a`），
 *    Windows 是个 `.exe`（直接起进程）。代码里不许再各自写 `/usr/bin/open`。
 * ⚠️ 找不到时 Windows 一支**允许是空串**（而不是一条猜的路径）：
 *    `fs.existsSync('')` 为 false ⇒ 调用方能如实说"没找到 Docker Desktop，请手动启动"，
 *    而不是去 `open` 一个不存在的路径然后报一个看不懂的错。
 */
export const DOCKER_APP_CANDIDATES = IS_WIN
  ? [
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Docker', 'Docker', 'Docker Desktop.exe'),
      path.join(process.env.LOCALAPPDATA || '', 'Docker', 'Docker Desktop.exe'),
    ]
  : ['/Applications/Docker.app'];
export const DOCKER_APP = DOCKER_APP_CANDIDATES.find((p) => p && fs.existsSync(p))
  || (IS_WIN ? '' : '/Applications/Docker.app');

// ── 数据文件（P1：全部落 USER_ROOT/panel）────────────────────────────────
// 这些常量原先都挂在 ROOT/panel 下；现在根由 src/user-root.js 解析一次。
/** 机器人的配置（面板是它的**唯一所有者**，见 src/index.js 的单一所有者契约） */
export const CONFIG_FILE = process.env.QQBOT_CONFIG
  ? ROOTS.configFile
  : userFile('config.json');
export const EFFECTIVE_FILE = panelFile('effective.json');
export const THINKING_FILE = panelFile('.thinking.json');
export const HISTORY_FILE = panelFile('config-history.jsonl');
export const AUDIT_FILE = panelFile('audit.jsonl');
export const TOKEN_FILE = panelFile('.token');
export const TRACE_FILE = panelFile('local-trace.jsonl');
/** 会话存档（机器人侧 `src/session-archive.js` 写，面板**只读**）。不入库：里面是真实聊天内容。 */
export const ARCHIVE_FILE = panelFile('session-archive.json');
export const USAGE_DIR = PANEL_STATE_DIR;
export const USAGE_FILE_RE = /^usage(-\d{4}-\d{2})?\.jsonl$/;
export const PIDFILE = panelFile('.bridge.pid');
/**
 * 机器人**进程侧**的实例互斥锁（D19 · E19）。面板**只读**它 —— 谁持锁、心跳多新，
 * 用于在"点了启动会被拒"之前就把这件事说出来。
 *
 * ⚠️ 面板**不许删它**（Q19 已裁决：不做"强制接管"按钮 —— 删锁重启是危险动作）。
 * ⚠️ 与 `PIDFILE` 语义不同：那个是"面板眼里的 pid"（面板写、面板删），
 *    这个是机器人自己的排他声明（谁都不能替别人删）。
 */
export const BRIDGE_LOCK_FILE = process.env.QQBOT_BRIDGE_LOCK_FILE
  ? path.resolve(process.env.QQBOT_BRIDGE_LOCK_FILE)
  : panelFile('.bridge.lock');
/**
 * 面板 → 机器人 的**命令文件**（D6b · Q7 裁决①「命令文件轮询」）。
 *
 * 谁写谁读：**面板写、机器人读并写回执行结果**（同一个文件，两个作者 ——
 * 竞态由 `src/control-channel.js` 的"执行后重读核对 id"兜住）。
 * 机器人侧读的是**同一个 env 变量**，所以沙箱/测试只要设一次就把两侧一起指走；
 * 不设的话两侧都落在真机那份文件上（`test/smoke.js` 会 spawn 真入口，必须指走）。
 */
export const CONTROL_FILE = process.env.QQBOT_CONTROL_FILE
  ? path.resolve(process.env.QQBOT_CONTROL_FILE)
  : panelFile('.bridge-cmd.json');
export const BRIDGE_LOG = panelFile('bridge.log');
export const LOCAL_LOG = panelFile('local-model.log');
export const PANEL_LOG = panelFile('panel.log');
export const DEBUG_FLAG = panelFile('.debug');

/**
 * 控制台前端的目录（2026-10-02 · 新版是**唯一**控制台）。
 *
 * 2026-10-02 起只剩这一个：旧的 `parts/`（16 个片段由服务端**拼装**成一份 HTML）
 * 连同 `PARTS_DIR` 与 `page-parts.js` 在 **S-12 第六批（2026-10-05）一起删掉了**。
 * 现在页面是**独立静态资产**，由浏览器**分别请求**（`GET /`、`/style.css`、`/app.js`…）。
 *
 * ⚠️ 为什么不做"把四个文件拼成一份 HTML"：`<script type="module">` 无法内联跨文件，
 *    硬拼就等于引入一次构建 —— 而本项目是零构建的（改完立刻生效，不用重启面板）。
 *
 * ⚠️ 这里的文件**不进** `BACKEND_SOURCES`：它们每次请求读盘，改了立刻生效，
 *    不存在"改了没重启"这回事。进来了只会让面板常年误报 stale。
 *
 * ⚠️ 它也是"页面由哪些文件构成"的**唯一声明处**（`next-page.js` 的 `NEXT_ASSETS`）——
 *    旧的那份声明（`PARTS`）已删除，"清单只有一处"这条纪律没有变，只是换了载体。
 */
export const NEXT_DIR = programFile('panel/next');

/**
 * 扩展包的**数据目录**（2026-10-02 · 让情绪 / 群友档案可见）。
 *
 * 根与 `QQBOT_DATA_DIR` 的解析统一在零依赖叶子 `src/user-root.js`（P1）；
 * 面板与机器人读同一份结果，不再各推一次。`QQBOT_DATA_DIR` 只覆盖
 * `DATA_DIR` 这一棵子树，不改变 config / panel / napcat 的位置。
 *
 * 下面的文件名与子目录名来自**各个扩展包自己的约定**（不是本项目的发明）：
 *   · `data/bot-state.json`         ← `plugins/本体情绪`（跨群共享的心情/精力/压力）
 *   · `data/memory/people/*.json`   ← `skills/群友印象`（按 QQ 号跨群共享，一档一文件）
 *   · `data/images-lib/index.json`  ← `skills/自定义图库`
 *   · `data/api-deals.json`         ← `skills/AI额度情报`
 * ⚠️ 这些文件**不是我们写的**，形状不归我们管 —— 所以 `bot-data.js` 里的读取
 *    一律"认不出就不显示"，绝不猜、绝不补默认值。
 */
export const DATA_DIR = ROOTS.dataDir;
export const PERSONA_DIR = ROOTS.personaDir;
export const BOT_STATE_FILE = path.join(DATA_DIR, 'bot-state.json');
export const PEOPLE_DIR = path.join(DATA_DIR, 'memory', 'people');
export const GALLERY_FILE = path.join(DATA_DIR, 'images-lib', 'index.json');
export const API_DEALS_FILE = path.join(DATA_DIR, 'api-deals.json');

/**
 * 后端**源文件**清单（不含页面片段，那些每次请求读盘）。
 *
 * 用途有两个，都必须同源，否则会互相打架：
 *   ① `panelInfo()` 的 `stale` 自检 —— "磁盘上的代码比这个进程新"要比**全部**后端文件，
 *      只比 `server.js` 的话，改了 `panel/lib/*.js` 就不报 stale，黄条不出现、自愈机制失效；
 *   ② `scripts/check-wb.mjs` 的静态契约扫描目标。
 *
 * ⚠️ 新增后端模块**必须加进这张表** —— 漏登记不会有任何报错，只会让它在两边都"隐身"。
 *    所以 `check-wb` 有一条契约用 `readdirSync('panel/lib')` 交叉核对这张表的完整性
 *    （**两个方向都判**：盘上有没登记的 / 表里有已不存在的）。
 *
 * ⚠️ 页面资产（`panel/next/*`）**故意不进这张表**：它们每次请求读盘，
 *    改了立刻生效，不存在"改了没重启"这回事；进来了反而会让面板每次无谓地报 stale。
 */
export const BACKEND_SOURCES = [
  'src/user-root.js',
  'panel/server.js',
  'panel/lib/paths.js',
  'panel/lib/runtime-state.js',
  'panel/lib/http-io.js',
  'panel/lib/config-io.js',
  'panel/lib/models.js',
  'panel/lib/proc.js',
  // ⚠️ S-12 第六批（2026-10-05）：`panel/lib/page-parts.js` 已随之删除，登记一并摘除。
  //    它曾在 2026-10-02「换主」之后作为**过渡期的技术债**留在表里（改它会让面板自报一次
  //    stale，而服务端已经不再 import 它）—— 那笔债在本批结清。
  // 控制台的资产名白名单与读盘口（2026-10-02）。**这个模块**要进表（改了它得重启
  // 面板才生效）；它读的那个**目录** `panel/next/` 不进表（那里面是页面源码，
  // 每次请求读盘、改完立刻生效）。
  'panel/lib/next-page.js',
  // 扩展包写的数据 → 面板能看的样子（2026-10-02：情绪 / 群友档案 / 图库 / 额度情报）。
  // **这个模块**要进表（改了它得重启面板）；它读的 `data/` 目录**不进表**
  // （那是扩展包在写的数据，一直在变 —— 进来会让 stale 常年误报，与 plugins/ 同理）。
  'panel/lib/bot-data.js',
  // 扩展包快照（B12d · EX-PLUGIN）。**这个模块**要进表（面板改了它得重启才生效）；
  // 它读的两个**目录** `plugins/` 与 `skills/` **不进表**（那不是代码，是用户装的包，
  // 每加一个包都会变 —— 进来会让 stale 常年误报）。
  'panel/lib/extensions.js',
  // 会话与存档的聚合判据（P1 分区重构）。纯函数、零 import（L1），
  // 但要进表：面板改了它必须重启才生效，否则"页面换了而判据还是旧的"。
  'panel/lib/sessions.js',
  // 控制通道（D6b · Q7 裁决①）：命令文件的读写口，**面板侧唯一一处**。
  // 进表的理由同 sessions.js —— 改了它必须重启面板才生效。
  'panel/lib/control.js',
  // 原生 NapCat（Windows 便携包，2026-10-12）：定位 / 起停 / WebUI token / 本地二维码图。
  // 进表的理由同 control.js —— 改了它必须重启面板才生效，否则"页面换了而取码方式还是旧的"。
  'panel/lib/napcat-native.js',
  // D21：ZIP 编解码（读与写共用**同一份** crc32）与扩展包安装（staging / 备份 / 回滚）。
  // 进表的理由同上 —— 改了它们必须重启面板才生效，否则"页面换了而判据还是旧的"。
  'panel/lib/zip.js',
  'panel/lib/ext-install.js',
  // 本地对话流的读盘口（第 16 轮 · H-10 第二半搬出）。它读的那个 `local-trace.jsonl`
  // **不进表**（桥接进程一直在追加写，属于"数据一直在变"，进来会让 stale 常年误报）；
  // 但**这个模块**要进表 —— 改了它得重启面板才生效。
  'panel/lib/trace-io.js',
  // 「保存配置」这条路由的全部逻辑（第 18 轮 · H-10 第二半，从主文件搬出）。
  // 进表的理由同 trace-io.js —— 改了它必须重启面板才生效；
  // 而它**读的那份 config.json** 由 `config-io.js` 管，不在本表。
  'panel/lib/config-route.js',
  // 导出配置 / 面板状态聚合（第 19 轮 · H-10 第二半收尾）。进表理由同上：
  // 改了它们得重启面板才生效；它们**读**的那几个文件**不进表**
  // （auto-memory.jsonl / memory-records.json 一直在变，进来会让 stale 常年误报）。
  'panel/lib/export-bundle.js',
  'panel/lib/state-collector.js',
  // 审计 / 用量两族（第 22 轮 · H-10 从主文件搬出）。进表理由同上 ——
  // 改了它们必须重启面板才生效；它们**读**的那几个文件**不进表**
  // （`audit.jsonl` / `usage-*.jsonl` 一直在变，进来会让 stale 常年误报）。
  'panel/lib/audit-log.js',
  'panel/lib/usage-report.js',
  // 官方模型目录对账（2026-10-17）。进表理由同上 —— 改了它得重启面板才生效，
  // 否则会出现"页面说已同步、实际还是旧的对账逻辑"。
  // 读/写拆成两个文件是为了层次单向（L3 只许 import 更低层，见 check-wb §06）。
  'panel/lib/model-sync-state.js',
  'panel/lib/model-sync.js',
  // P3 更新协议（2026-10-18）：改了任意一个都要重启面板才生效。
  'panel/lib/update-version.js',
  'panel/lib/update-manifest.js',
  'panel/lib/update-signature.js',
  'panel/lib/update-download.js',
  'panel/lib/update.js',
  'panel/lib/update-routes.js',
  'panel/lib/update-offline.js',
];

