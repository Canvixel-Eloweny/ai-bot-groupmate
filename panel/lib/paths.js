/**
 * 面板进程的**路径与端口常量**（第 37 轮 B11b-1 · AR-SERVERSPLIT）
 * ══════════════════════════════════════════════════════════════════════════
 *  为什么单独抽一个模块 —— 因为 `ROOT` 是**搬了就静默失效**的东西
 * ══════════════════════════════════════════════════════════════════════════
 *  搬之前它在 `panel/server.js` 里：
 *
 *      const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
 *
 *  `..` 正好等于仓库根，因为文件就在 `panel/` 下面。
 *  **一旦某个 helper 被搬到 `panel/lib/`，同一个表达式算出来的就是 `panel/`** ——
 *  于是 config.json / panel/*.json 全部指向不存在的路径。
 *  而这个错误**不报错**：读不到 config.json 的路径本来就是「用默认配置继续跑」
 *  （见 `readConfig()` 的 try/catch），所以表现是"面板突然变回默认配置"，
 *  没人会往"路径算错了"上想。
 *
 *  所以：**ROOT 只在这里算一次**，任何模块要用都从这里 import。
 *  本文件里那句 `'..', '..'` 是本仓库唯一一处"用相对层级推导仓库根"的地方。
 *
 *  ⚠️ 下面这个自检**故意做成抛错**而不是打日志：
 *     路径全错的情况下继续启动，只会得到一台"配置全是默认值、写盘也写错地方"的面板，
 *     那比启动失败更难查。宁可当场崩，也不要静默跑错。
 *
 *  ⚠️ 本模块**不许 import 面板里的其它模块** —— 它是依赖图的最底层（F.3 的 L0）。
 *     一旦它开始依赖别人，B11b 辛苦消掉的那些循环就会从底部长回来。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 仓库根。本文件位于 `panel/lib/`，所以要在本文件目录上退**两级**。 */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// 自检：仓库根一定有 package.json（`"type": "module"` 就写在里面，本文件能当 ESM 跑全靠它）。
// 算错了 ROOT 时这里会立刻炸，而不是让整台面板用着默认配置继续跑。
if (!fs.existsSync(path.join(ROOT, 'package.json'))) {
  throw new Error(
    `ROOT 算错了：${ROOT} 下没有 package.json。` +
      ' 这几乎一定是 panel/lib/paths.js 的相对层级写错（应为 ../..），别再往下跑。'
  );
}

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
export const HOME = process.env.HOME || '';
export const QWEN_SERVER = path.join(HOME, 'models', 'bin', 'qwen-server');
export const QWENCHAT_SERVER = path.join(HOME, 'models', 'app', 'server.py');
export const MLX_PY = path.join(HOME, '.workbuddy', 'binaries', 'python', 'envs', 'mlx', 'bin', 'python');

// ── docker 可执行文件：按候选表找第一个真的存在的 ─────────────────────────
export const DOCKER_CANDIDATES = [
  '/Applications/Docker.app/Contents/Resources/bin/docker',
  '/usr/local/bin/docker',
  '/opt/homebrew/bin/docker',
];
export const DOCKER = DOCKER_CANDIDATES.find((p) => fs.existsSync(p)) || 'docker';
export const DOCKER_APP = '/Applications/Docker.app';

// ── 数据文件 ──────────────────────────────────────────────────────────────
// 集中在一处的理由与 ROOT 相同：这些路径散落在各节时，搬动任何一节都要重新核对一遍。
/** 机器人的配置（面板是它的**唯一所有者**，见 src/index.js 的单一所有者契约） */
export const CONFIG_FILE = path.join(ROOT, 'config.json');
export const EFFECTIVE_FILE = path.join(ROOT, 'panel', 'effective.json');
export const THINKING_FILE = path.join(ROOT, 'panel', '.thinking.json');
export const HISTORY_FILE = path.join(ROOT, 'panel', 'config-history.jsonl');
export const AUDIT_FILE = path.join(ROOT, 'panel', 'audit.jsonl');
export const TOKEN_FILE = path.join(ROOT, 'panel', '.token');
export const TRACE_FILE = path.join(ROOT, 'panel', 'local-trace.jsonl');
/** 会话存档（机器人侧 `src/session-archive.js` 写，面板**只读**）。不入库：里面是真实聊天内容。 */
export const ARCHIVE_FILE = path.join(ROOT, 'panel', 'session-archive.json');
export const USAGE_DIR = path.join(ROOT, 'panel');
export const USAGE_FILE_RE = /^usage(-\d{4}-\d{2})?\.jsonl$/;
export const PIDFILE = path.join(ROOT, 'panel', '.bridge.pid');
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
  : path.join(ROOT, 'panel', '.bridge.lock');
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
  : path.join(ROOT, 'panel', '.bridge-cmd.json');
export const BRIDGE_LOG = path.join(ROOT, 'panel', 'bridge.log');
export const LOCAL_LOG = path.join(ROOT, 'panel', 'local-model.log');
export const PANEL_LOG = path.join(ROOT, 'panel', 'panel.log');
export const DEBUG_FLAG = path.join(ROOT, 'panel', '.debug');

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
export const NEXT_DIR = path.join(ROOT, 'panel', 'next');

/**
 * 扩展包的**数据目录**（2026-10-02 · 让情绪 / 群友档案可见）。
 *
 * ⚠️ 这是 `src/config.js` 的 `DATA_DIR` 的**镜像**，故意不 import 它：
 *    `src/config.js` 是重型模块（读 env、拼整份配置），而 `panel/lib/*` 只许引
 *    **零依赖叶子**（见 `check-wb` 的 `LIB_SRC_ALLOW`）—— 引进来会把机器人进程的
 *    启动链拖进面板。所以这里按**同一条规则**自己推：env 优先，否则 `<root>/data`。
 *    `QQBOT_DATA_DIR` 这个名字是与 `src/config.js` 共用的约定（沙箱靠它把数据指去 tmp），
 *    两处**必须同名** —— 不同名时沙箱里会读到真机的数据，而不会有任何报错。
 *
 * 下面的文件名与子目录名来自**各个扩展包自己的约定**（不是本项目的发明）：
 *   · `data/bot-state.json`         ← `plugins/本体情绪`（跨群共享的心情/精力/压力）
 *   · `data/memory/people/*.json`   ← `skills/群友印象`（按 QQ 号跨群共享，一档一文件）
 *   · `data/images-lib/index.json`  ← `skills/自定义图库`
 *   · `data/api-deals.json`         ← `skills/AI额度情报`
 * ⚠️ 这些文件**不是我们写的**，形状不归我们管 —— 所以 `bot-data.js` 里的读取
 *    一律"认不出就不显示"，绝不猜、绝不补默认值。
 */
export const DATA_DIR = process.env.QQBOT_DATA_DIR
  ? path.resolve(process.env.QQBOT_DATA_DIR)
  : path.join(ROOT, 'data');
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
];

