<div align="center">

<img src="https://gcore.jsdelivr.net/gh/Canvixel-Eloweny/ai-bot-groupmate@main/assets/logo-v5.svg" alt="Estrella Bot" width="140">

# Estrella Bot · QQ-BOT-Creative

**把 QQ 小号变成一个有脾气的群友。**
它会插话、接梗、潜水，也会偶尔自己冒个泡。

OneBot v11 · NapCat · 本机模型或 DeepSeek / 智谱 / 通义 · 零构建网页控制台

<p>
  <a href="../README.md">English</a> · <b>简体中文</b>
</p>

<p>
  <a href="https://github.com/Canvixel-Eloweny/ai-bot-groupmate/actions/workflows/ci.yml"><img alt="四层门禁" src="https://img.shields.io/github/actions/workflow/status/Canvixel-Eloweny/ai-bot-groupmate/ci.yml?branch=main&label=%E5%9B%9B%E5%B1%82%E9%97%A8%E7%A6%81&logo=githubactions&logoColor=white&style=for-the-badge"></a>
  <a href="https://github.com/Canvixel-Eloweny/ai-bot-groupmate/actions/workflows/codeql.yml"><img alt="CodeQL" src="https://img.shields.io/github/actions/workflow/status/Canvixel-Eloweny/ai-bot-groupmate/codeql.yml?branch=main&label=CodeQL&logo=github&logoColor=white&style=for-the-badge"></a>
  <a href="../LICENSE"><img alt="许可" src="https://img.shields.io/github/license/Canvixel-Eloweny/ai-bot-groupmate?label=license&logo=gnu&logoColor=white&style=for-the-badge"></a>
</p>

<p>
  <a href="../package.json"><img alt="平台" src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows-2f77c4?style=for-the-badge"></a>
  <a href="../package.json"><img alt="Node" src="https://img.shields.io/badge/node-%E2%89%A522.13-339933?logo=nodedotjs&logoColor=white&style=for-the-badge"></a>
  <a href="../package.json"><img alt="运行时依赖" src="https://img.shields.io/badge/dependencies-ws%20only-blue?style=for-the-badge"></a>
  <a href="../package.json"><img alt="零构建" src="https://img.shields.io/badge/build-none-lightgrey?style=for-the-badge"></a>
</p>

<p>
  <a href="#4-接口插件与-skill"><img alt="AI" src="https://img.shields.io/badge/AI-OpenAI--compatible-6f42c1?style=for-the-badge"></a>
  <a href="./release/CHANGELOG.md"><img alt="版本" src="https://img.shields.io/badge/release-v0.1.6-e05d44?style=for-the-badge"></a>
  <a href="https://github.com/Canvixel-Eloweny/ai-bot-groupmate/commits/main"><img alt="最后提交" src="https://img.shields.io/github/last-commit/Canvixel-Eloweny/ai-bot-groupmate?logo=git&logoColor=white&style=for-the-badge"></a>
</p>

<hr>

<p><sub><b>控制台预览画面</b> · Console preview —— 运行总览、人格、玻璃实验室与人设工厂</sub></p>

<p><img src="https://gcore.jsdelivr.net/gh/Canvixel-Eloweny/ai-bot-groupmate@main/assets/panel-preview-v3.jpg" alt="控制台：运行总览、人格、玻璃实验室与人设工厂" width="880"></p>

<hr>

<p><sub>仓库默认展示的是<b>英文版</b>（<a href="../README.md">README.md</a>）；
<b>本文件是中文版，两版不一致时以本文件为准</b>。<br>
The English README is what the repository shows by default; this Chinese edition is authoritative when the two differ.</sub></p>

</div>

<p align="center"><sub>
<a href="#1-这个项目是什么">1. 这个项目是什么</a> ·
<a href="#2-为什么是-estrella-bot">2. 为什么是 Estrella Bot</a> ·
<a href="#3-安装">3. 安装</a> ·
<a href="#4-接口插件与-skill">4. 接口、插件与 Skill</a> ·
<a href="#5-它是怎么工作的">5. 它是怎么工作的</a> ·
<a href="#6-已知限制">6. 已知限制</a> ·
<a href="#7-路线图">7. 路线图</a> ·
<a href="#8-参与本项目">8. 参与本项目</a> ·
<a href="#9-联系方式">9. 联系方式</a> ·
<a href="#10-许可与出处">10. 许可与出处</a>
</sub></p>

## 1. 这个项目是什么

Estrella Bot 是一个 **OneBot v11 桥接器**：把一个 QQ 小号接到任意 **OpenAI 兼容**模型上，再配一个**零构建的浏览器控制台**。它要做的不是一个"命令机器人"，而是群里的一个成员：会跟着话题走、被点名会答、偶尔自己插一句、记得人和梗，也知道什么时候该安静。

速览：

- **像群友一样聊天** —— @、叫名字、按概率插话并带冷却、作息时间、长消息分句、按人的节奏发送。
- **自带大脑选择** —— 本机模型（MLX / QwenChat）、DeepSeek、智谱 GLM、通义千问，或任何 OpenAI 兼容接口。
- **真正的控制台** —— 启停机器人、切换模型、编辑人设、管理记忆与扩展、看日志与用量，全部在本地浏览器里完成。
- **小而自包含** —— 机器人单进程，运行时只依赖一个 `ws`，没有构建步骤，没有中心服务。

你需要准备三样东西：一个 **QQ 小号**、一个 **OneBot v11 协议端**（实际用 NapCatQQ）、一个**模型**（本机接口或 API Key）。源码运行需要 Node.js ≥22.13；Windows 安装器自带运行时。

> **关于名字。** Estrella Bot 是这个软件的名字。项目最初叫 `qq-bot`，此后改过两次名，GitHub slug 保持 `ai-bot-groupmate` 不变，好让已有链接与搜索结果仍然落到这里。完整沿革见 [`CHANGELOG.md`](./release/CHANGELOG.md)。

## 2. 为什么是 Estrella Bot

- **它像群成员，不像回复机器。** 独立判定层先回答一个问题：这条消息到底该不该回 —— @、叫名字、提问形态、插话概率与冷却、作息窗口、每位群友的说话风格。回复会分句并按人的节奏发出，而且绝不回自己。
- **模型自由，不被锁死。** 四套预设把本机和云端分开；切换只做"物化"，设置不会串到别的大脑。任何 OpenAI 兼容接口都能加成自定义大脑，按模型勾选能力，并在服务商失败时走降级链。
- **本地优先，数据在自己手里。** 机器人、控制台、记忆和日志都在你的机器上。本机模型不出本机；云端调用只去你配置的那一家。没有中心账号系统，也没有托管服务。
- **全部可点。** 控制台是零构建静态前端 + 本地 HTTP 服务：启停、扫码登录协议端、编辑人设与记忆、看日志/用量/追踪，都不需要打包器，改完刷新即可。
- **安全是默认，不是选项。** 白名单为空且未显式放行就拒绝启动；出站内容一律用消息段数组，模型输出的 CQ 码不会变成指令；自己的消息直接丢弃；SSRF 与浏览路径有闸门；测试沙箱绝不碰真实机器人。
- **可扩展，但没变成框架。** 插件与 Skill 共用同一套宿主、加载器与设置界面。确定性钩子和模型可调用工具是同一个包体系的两种 kind，不是两套 API。
- **跨平台，且把取舍写清楚。** Windows 有原生安装器、不需要 Docker；macOS 走 Docker 容器，因为 NapCat 的 macOS QQ 版本白名单停在半年前。没有藏起来的平台魔法。
- **体积小，门禁硬。** 运行时只依赖 `ws`，界面零构建；改动要过四层门禁加变异测试。本 README **不冻结门禁计数** —— 唯一权威数字在 `npm run verify` 的实测输出里。

## 3. 安装

所有路线最后都到同一个本地控制台。按你的系统选一条。

### 你需要准备什么

| 项 | 说明 |
|---|---|
| 一个 QQ 小号 | 建议用小号；第三方协议端存在账号被限制的风险 |
| 一个 OneBot v11 协议端 | 实际使用 NapCatQQ。它**不随本包分发** —— 其许可不允许再分发 |
| 一个模型 | 本机 OpenAI 兼容接口，或 DeepSeek / 智谱 / 通义的 API Key |
| Node.js ≥22.13 | 仅源码运行需要；Windows 安装器自带运行时 |
| Docker Desktop | 仅 macOS / Linux 的容器路线需要；Windows 安装器不需要 Docker |

### Windows —— 安装器（推荐）

1. 从 [Releases](../../../releases/latest) 下载 `Estrella-Bot-Setup-<版本>.exe`。
2. 运行安装器。在**协议端**那一页，可以让安装器现在下载 NapCat，也可以指向已经解压好的 `NapCat.Shell` 文件夹。NapCat **不随安装器内置**。
3. 从桌面或开始菜单启动 **Estrella Bot**。控制台会打开，协议端在后台启动。
4. 在控制台的协议端页面，用手机 QQ 扫码登录小号。
5. 填好**放行的群号**和模型 API Key，点右上角 **一键启动**。

注意：

- **扫码前先完全退出电脑端 QQ**，扫码后让协议端进程保持运行。NapCat 通过注入 QQ NT 工作，而 QQ NT 是单实例的；这是"昨天还好好的"最常见的原因。
- 不需要 Docker，不需要 WSL2，也不需要另外装 Node。
- 想用手动/便携方式？看 [用户使用说明第 9 节](./guides/USER-GUIDE.zh-CN.md#9-windows-用户)。

### macOS / Linux —— Docker（macOS 推荐）

macOS 上用 Docker，是为了绕开 NapCat 过期的 macOS QQ 版本白名单：容器里自带配套的 Linux QQ，**你本机的 QQ 客户端一个字节都不用动**。

```bash
git clone https://github.com/Canvixel-Eloweny/ai-bot-groupmate.git
cd ai-bot-groupmate
npm install
cp config.example.json config.json        # 然后填 allow.groups
bash scripts/bootstrap.sh                 # 起容器，并打印 WebUI 登录地址
node scripts/check-onebot.js              # 确认协议端活着，并列出已加入的群
```

启动控制台，在页面里点**一键启动**；或者用命令行分别跑控制台和机器人：

```bash
node panel/server.js    # 控制台：http://127.0.0.1:8788
npm start               # 只跑机器人；控制台里也能启动它
```

macOS 也可以直接双击 **`Estrella-Bot.app`**：它会启动控制台、打开页面，再到后台拉起 Docker 与容器。

- 完整容器安装手册（含回滚）：[`INSTALL-DOCKER.md`](./guides/INSTALL-DOCKER.md)。
- macOS 原生路线**当前受阻**（NapCat 的版本白名单）。不要从第三方下载站装 QQ —— 聊天客户端是这个账号的全部凭据所在。
- 没有 macOS 安装包或 DMG；macOS 直接从仓库运行。

### 手动 / 开发方式（任意系统）

Windows 上先装好 Node.js、QQ NT 和原生 NapCat，打开 WebSocket `3001` 与 HTTP `3000`，然后：

```bat
npm install
copy config.example.json config.json
```

用 `scripts\Estrella-Bot.bat` 启动控制台，或者分别运行 `node panel/server.js` 与 `npm start`。逐步操作、以及每一步失败怎么办：[用户使用说明](./guides/USER-GUIDE.zh-CN.md) · [English guide](./guides/USER-GUIDE.md)。

### 第一次运行

1. 用 QQ 小号登录 NapCat。
2. 把要放行的群号填进 `allow.groups`。留空且 `allowAllWhenEmpty:false` 时，进程会拒绝启动。
3. 在控制台或 `config.json` 里设置模型地址与密钥（用 `apiKeyEnv` 比把 key 写进文件更安全）。
4. 打开控制台。桌面版会把实际地址写进 `USER_ROOT/panel/.panel.json`；源码运行默认 `http://127.0.0.1:8788`。
5. 点 **一键启动**，然后在放行的群里 @ 它或叫它的名字。

### 验证安装

源码运行时，`npm test` 会在不需要 QQ、不需要模型的情况下跑行为回归；`npm run verify` 会跑完整四层门禁。本 README 不冻结门禁数字；唯一权威计数以 `npm run verify` 的实测输出为准。

## 4. 接口、插件与 Skill

这个项目有四类接口：协议端、模型、控制台 API 和扩展包。

| 接口 | 连接 | 是什么 |
|---|---|---|
| OneBot v11 | QQ ↔ 机器人 | WebSocket `3001`、HTTP `3000`；实际用 NapCat |
| 模型 | 机器人 ↔ LLM | 任意 OpenAI 兼容的 `/chat/completions` 接口 |
| 控制台 API | 浏览器 ↔ 面板 | 本地 HTTP，只绑 `127.0.0.1`；每条路由都有文档 |
| 扩展 | 扩展包 ↔ 宿主 | 插件与 Skill 共用同一套宿主与加载器 |

### 控制台 —— 给人用的界面

控制台由 `panel/server.js` 提供，只监听 `127.0.0.1`。它是控制室：运行总览、启停、协议端登录、人设工坊、记忆、定时消息、扩展、日志、用量、追踪和设置。前端是 `panel/next/` 下的零构建静态资产 + `schema.js` 数据驱动控件表，没有打包步骤。桌面版由系统分配端口并把实际地址写进 `USER_ROOT/panel/.panel.json`；源码运行默认 `127.0.0.1:8788`。

更多：[`docs/FRONTEND-V2.md`](./FRONTEND-V2.md) · [`docs/MOTION-METHODOLOGY.md`](./MOTION-METHODOLOGY.md)。

### 本地 HTTP API —— 给自动化用的接口

控制台做的每件事都是一条本地 HTTP 路由：状态、配置、启停桥接、协议端登录、切换模型、记忆、扩展、日志与诊断。每条路由的入参、出参、副作用与幂等性都在 [`docs/API_CONTRACT.md`](./API_CONTRACT.md)。前端轮询 `/api/state`；外部工具也可以这样做，或直接调用具体路由。面板只绑回环并校验 Host 与 Origin，默认不会暴露到局域网。

### 模型 —— 四套预设 + 自定义

控制台把模型配置组织成四套预设。切换只把其中一套**物化**成扁平字段给桥接进程；预设之间绝不串设置，改过的设置按大脑各存各的。

| 预设键 | 名字 | baseUrl | 特点 |
|---|---|---|---|
| `local` | 本机模型 | `http://127.0.0.1:<port>/v1`（MLX 或 QwenChat） | 离线、免费、数据不出本机；两条本机通道**互斥**（同一份模型内存） |
| `deepseek` | DeepSeek 云端 | `https://api.deepseek.com/v1` | 性价比高，纯文本 |
| `zhipu` | 智谱 GLM | `https://open.bigmodel.cn/api/paas/v4` | **唯一支持联网 + 识图**的预设；另有"始终思考"系列 |
| `qwen` | 千问（阿里云） | `https://dashscope.aliyuncs.com/compatible-mode/v1` | 免费额度**按模型发**（每模型 100 万 token、90 天）；降级链故意排得长。额度会用完，而平台的"免费用尽即停"开关默认是关的 —— 记得打开 |

**自定义模型（用自己的 Key）。** 只要接口是 OpenAI 兼容的就能加：公司网关、自建中转、另一台机器上的 LM Studio，或我们还没接的服务商。填名字、API 地址、密钥、模型名，再勾它到底能做什么：

| 勾选 | 实际会发生什么 |
|---|---|
| 能看图 | 群里的图片才会发给它。不勾就剥掉，只看到 `[图片]`。 |
| 能思考 | 才带思考参数。服务端不认会自动去掉重发。 |
| 能联网 | 才带联网工具。⚠️ 这是智谱的形状，别家大多不认。 |

**勾了的才会显示**，不会摆一排点不动的灰开关。想存几套就存几套，和其它大脑一样切换；在某套上**点右键**可以改名或删除。地址要填 **API 地址**（提供 `/chat/completions` 的那个），不是服务商的控制台网页。

自定义模型存在 `llm.customBrains`（一套一个条目），不进 `llm.presets`。模型能力的唯一真相源是 `src/model-caps.js`（思考档位、联网、识图、降级链可用性）；视觉判定唯一入口是 `supportsVision()`。

### 插件与 Skill —— 扩展接口

`plugins/` 与 `skills/` 共用**同一套宿主、加载器、清单契约、工具注册表与钩子总线**。`kind` 只决定默认语义，不是第二套 API，也**不是沙箱**。

| | 插件（`plugins/<id>/`） | Skill（`skills/<id>/`） |
|---|---|---|
| 适合 | 确定性能力：钩子、拦截、固定时机必跑 | 给模型用的能力：注册工具 + 可选提示词指引 |
| 入口 | `setup` / `activate` / `hooks`（至少一个） | 同上；纯提示词包用 `prompt.sections` |
| 执行 | 钩子命中就必跑 | 由模型判断是否调用工具 |
| 提示词 | 可选扩展指引 | 可选 `skillExt` 段 |
| 白名单 | `custom.extensions.plugins.enabled` | `custom.extensions.skills.enabled` |
| 控制台页 | 工厂 → 插件管理 | 工厂 → Skill |

最小纯提示词 Skill 只有两个文件：

```text
skills/group-etiquette/
  skill.json   # id / apiVersion / entry + prompt.sections[]
  index.js     # 内容可以只是: export {};
```

两型共享：

- 同一份清单契约（`plugin.json` / `skill.json`）：`id`、`apiVersion`、`entry`、可选 `permissions`。
- 同一张工具注册表与工具上限；同一个钩子总线与单条超时。
- 同一套设置界面，含敏感键处理与越界拒绝。
- 每一型各一份启用名单。包放在目录里会被**扫描并报告，但不会加载** —— 直到它的 id 进入白名单。
- **不支持热插拔**：改白名单需要重启机器人才生效。
- 失败可见：加载失败、钩子没挂上、工具没注册都会进报告，不静默。
- 扩展钩子 **fail-open**（写坏的包不该让机器人彻底不说话）；出站凭据闸门是 fail-closed。

扩展**不是沙箱** —— 包在机器人进程内加载，能直接 `import fs`。只安装你信任的包。宿主会用裁剪过权限的 API（`fetch` 白名单、只读 OneBot 代理）、出站配额与清单校验来限制它，但那是边界，不是牢笼。见 [`docs/SKILLS.md`](./SKILLS.md) 与 [`SECURITY.md`](../.github/SECURITY.md)。

**默认不随仓附带任何扩展包。** 为本项目写的那些包已经移除；你可以把自己的包放进 `plugins/` 或 `skills/`，也可以在控制台里安装 ZIP，然后到白名单里启用。你自己新增的第三方包不会入库（见 `.gitignore`）。

> 别把磁盘上的 `skills/` 扩展包和 `config.json` 里的 `custom.skills` 搞混：前者是可执行代码，后者是提示词数据。

## 5. 它是怎么工作的

### 系统形状

```text
QQ 小号 ──► NapCat（OneBot v11）──► src/index.js ──► 模型
              ws 3001 / http 3000      │ 触发 → 上下文 → 提示词 → 分句
                                       ├─ 本机  : MLX / QwenChat
                                       ├─ 云端  : DeepSeek / 智谱 / 千问
                                       └─ 自定义: 任意 OpenAI 兼容接口
                 ┌─────────────────────┴─────────────────────┐
                 │ panel/server.js（127.0.0.1）               │
                 │  ├─ panel/next/ 静态界面，轮询状态         │
                 │  └─ 启停、配置、记忆、扩展                 │
                 └───────────────────────────────────────────┘
```

### 一条消息的生命周期

1. `src/onebot.js` 把 OneBot 事件拍平成文本、图片 URL 和"有没有 @ 我"。
2. `src/index.js` 过白/黑名单、作息与叫醒规则、限流闸门。
3. `src/brain.js` 的 `decide()` 用纯函数回答一个问题：**这条消息到底该不该回？**
4. `src/context-budget.js` 组装提示词：稳定段在前、易变上下文压到末尾，控制在字符预算内。
5. `src/llm.js` 调模型，带降级链与显式 400 语义处理。
6. `src/tool-loop.js` 在模型请求工具时跑工具回合。
7. `src/brain.js` 分句并剥内部标记；`src/egress.js` 走出站闸门。
8. `src/pace.js` 按人的节奏发送，并在每次发送前复核白名单。

### 配置

```bash
cp config.example.json config.json   # config.json 已预填，且被 .gitignore 排除
```

最小可用配置（本机 MLX）：

```jsonc
{
  "llm": {
    "baseUrl": "http://127.0.0.1:8080/v1",
    "model": "qwen3-8b",
    "localChannel": "mlx",            // 走哪条本机通道：mlx / qwenchat
    "thinking": { "mode": "off", "level": "low" }
  },
  "allow": { "groups": [100000001], "private": [], "allowAllWhenEmpty": false },
  "persona": { "name": "小鱼", "file": "persona/qq-chat.md" }
}
```

云端 DeepSeek —— 密钥放环境变量，不写进文件：

```jsonc
{ "llm": { "baseUrl": "https://api.deepseek.com/v1", "apiKeyEnv": "QQBOT_API_KEY", "model": "deepseek-flash" } }
```

```bash
export QQBOT_API_KEY=sk-xxxx
node src/index.js
```

关键配置项：

| 字段 | 说明 |
|---|---|
| `allow.groups` / `allow.private` | 白名单。**留空且 `allowAllWhenEmpty:false` 时进程直接拒绝启动** |
| `allow.allowAllWhenEmpty` | 设为 `true` 等于把账号交给模型，只在本地调试时用 |
| `deny.groups` / `deny.users` | 黑名单，优先级高于白名单 |
| `trigger.requireAtInGroup` | 群聊是否必须被 @ 或叫名字才回 |
| `trigger.aliases` | 触发用的名字（如 `["小鱼"]`），群友叫名字也算点名 |
| `trigger.interjectChance` | 没点名时随机插话的概率（0~1），默认 0（不插话） |
| `trigger.interjectCooldownMs` | 插话冷却 |
| `reply.splitToken` | 模型用它分隔多条消息，默认 `\|\|` |
| `reply.sendDelayMs` | 多条之间的间隔，防触发频率限制 |
| `throttle.globalConcurrency` | **本机模型必须设 1**（Apple Silicon 上并发会让延迟翻倍） |
| `throttle.perMinutePerSession` | 每会话每分钟回复上限 |
| `llm.presets.<key>` | 四套大脑各自保存的设置（切换时物化，勿手改语义） |
| `custom` | 自定义工作台数据（人格、增强项、技能、记忆、定时消息、扮演规则、安全、其它） |

### 人设与记忆

人设就是 `persona/qq-chat.md` 里的一段自然语言。`src/brain.js` 的 `buildMessages()` 按这个顺序拼提示词：

```text
说话方式规则 → 人格 → 增强项 → 扮演规则 → 群聊背景 → 上下文 → 当前消息
```

想让回复更"生动"，按性价比排序：写实人格（具体到口头禅、说话长度、什么时候不接话） · 在人格文件里加 few-shot 示例 · 调低 `temperature`（0.8 左右更稳，1.2 以上会开始胡说） · 换更大的模型。

自定义工作台是数据驱动的，结构定义在 `src/custom-config.js`。局部更新走 `patchCustom()`，它是合并而不是整份替换，所以改一个字段不会把别的冲掉。改人设后会用指纹让旧会话历史失效；记忆刻意不算进指纹，所以加一条记忆不会清历史。

### 仓库结构

| 路径 | 里面是什么 |
|---|---|
| `src/` | 机器人本体：协议 IO、触发判定、提示词组装、模型客户端、工具、记忆、扩展宿主 |
| `panel/` | `server.js`（本地 HTTP API）+ `next/`（零构建前端）+ `lib/`（后端分层） |
| `plugins/` · `skills/` | 扩展包 —— 默认不随仓附带 |
| `scripts/` | 引导、OneBot 探活、干跑、事件抓包、契约门禁 |
| `test/` | 行为回归、沙箱、面板启动/DOM 检查、变异测试、E2E 脚本 |
| `packaging/` | Windows NSIS 安装器、便携包、更新清单与签名 |
| `docs/` | 用户手册、API 契约、架构、Skill 文档、法务声明 |
| `persona/` | 人设文本 |
| `config.example.json` · `docker-compose.yml` | 脱敏配置模板与 NapCat 容器 |

分层与依赖方向见 [`docs/ARCHITECTURE.md`](./ARCHITECTURE.md)。

### 设计取舍

- **CQ 注入防护** —— 发给协议端的消息一律用**消息段数组**而不是 CQ 码字符串。模型即使输出 `[CQ:at,qq=all]`，也只是一段普通文字。
- **防自问自答** —— `user_id === self_id` 的事件直接丢弃，否则机器人会回自己的消息形成死循环。
- **白名单兜底** —— 白名单为空且未显式放行 → **拒绝启动**，而不是默默全放行。
- **断线重连** —— 指数退避（1s→30s），`pending` 请求在断线时全部 reject，不会悬挂。
- **限流** —— 会话级最小间隔 + 每分钟上限 + 全局并发信号量。
- **超长切分** —— 优先在句号/逗号处切，避免被协议端截断。
- **降级链收敛** —— 换模型 / 存配置时前后端双闸校验：跨服务商、重复、超长、以及"始终思考"模型进链一律拒掉并说清原因。
- **日志环形缓冲** —— `state.logs` 封顶，后端维护 `dropped` 计数让 `total` 单调递增，前端游标落后太多下发 reset 重画。
- **沙箱隔离** —— `test/sandbox.sh` 起面板带 `QQBOT_SANDBOX=1`；服务器在该模式下绝不接管/启停任何真实机器人进程，杜绝回归测试误杀真机器人。

## 6. 已知限制

- **不做流式转发** —— 整段回复生成完再发（群里逐字蹦字更不像人）。
- **语音/视频只转成占位文本。** 图片在**支持视觉的模型**下会真的识图，纯文本模型仍只收占位符。
- **跨重启上下文靠会话存档**，但超过新鲜度的存档会被**拒绝恢复**（宁可失忆，也不要接上一个早就结束的话题）。
- **机器人是单进程单实例，没有做多账号。**
- **面板是「每次请求读盘」零构建形态。** 改 `server.js` 后必须重启面板进程才生效（`POST /api/panel/restart` 幂等）。
- **插件与 Skill 能执行，但"目录里有"与"会生效"仍是两件事** —— 包会被扫描并列出，只有白名单里的 id 才会加载，而且不支持热插拔。

## 7. 路线图

以下都是**已知未做**的项，来源是上一节的「已知限制」。不是许愿池，也没有时间承诺：这个项目由一个人维护，优先级会随实际使用中遇到的痛点调整。

- [ ] **多账号支持** —— 机器人当前是单进程单实例。
- [ ] **语音 / 视频消息的内容理解** —— 现在只转成占位文本。
- [ ] **出站富媒体** —— 主动发图。（发表情已于 2026-10-17 **整条移除**：它只会在 QQ 自带的黄豆脸里挑。）
- [ ] **macOS 原生协议端** —— 卡在 NapCat 的 QQ 版本白名单。
- [ ] **插件热更新** —— 改白名单目前必须重启机器人才生效。

## 8. 参与本项目

先读 [`CONTRIBUTING.md`](../.github/CONTRIBUTING.md)。动手之前有三件事必须知道：

1. **门禁是四层** —— `check-wb` 静态契约、`smoke` 行为回归，以及沙箱里的 `presets` 与面板自检。完整命令：`npm run verify`。
2. **每一处修复都要配一条"只打它那一条"的变异测试。** "断言存在"不等于"断言接上了"。
3. **门禁计数刻意不写死在这份文档里。** 那组数字腐烂过四次；真实数字只有一个地方：`npm run verify` 的实测输出。参见 [`test/mutations/README.md`](../test/mutations/README.md)。

也请读 [`CHANGELOG.md`](./release/CHANGELOG.md)、[`SECURITY.md`](../.github/SECURITY.md)（含已知设计边界）、[`CODE_OF_CONDUCT.md`](../.github/CODE_OF_CONDUCT.md) 与 [`THIRD-PARTY-NOTICES.md`](./legal/THIRD-PARTY-NOTICES.md)。

## 9. 联系方式

| 渠道 | 用途 |
|---|---|
| [Issues](../../../issues) | **首选**。提问、报缺陷、提需求都走这里 —— 公开讨论的结论能被下一个遇到同样问题的人搜到，私信不能 |
| [`SECURITY.md`](../.github/SECURITY.md) | 安全漏洞**私密上报**；不要开公开 issue |

两处例外，请先处理后再说：

- 消息里出现**真实 QQ 号 / 群号 / 聊天记录**时，先脱敏再贴。
- 报缺陷前先跑一遍 `npm run verify` 并把输出贴上 —— 一份能复现的最小步骤，比一段长描述有用得多。

## 10. 许可与出处

| 项 | 值 |
|---|---|
| 本项目的许可 | **Apache-2.0**（全文见 [`LICENSE`](../LICENSE)，署名通知见 [`NOTICE`](./legal/NOTICE)） |
| 第三方声明 | 见 [`THIRD-PARTY-NOTICES.md`](./legal/THIRD-PARTY-NOTICES.md) |
| 运行时依赖 | 只有 `ws`（MIT）。零构建、无其他第三方运行时依赖 |

**三句话读懂 Apache-2.0。** ① 可以随便用：读、跑、改、自己用、闭源分发都行，不需要问任何人。② 带上两样东西：`LICENSE` 全文与 `NOTICE` 署名通知要随附，改过的文件要标注你改过。③ 它有明文专利授权，也明确不授予商标权；但它**不要求**你公开自己的改动（没有网络条款）。

**NapCat 不是本仓库的一部分。** 运行需要 OneBot v11 协议端（本项目实际使用 NapCatQQ）。它的许可是自定义的 *Limited Redistribution License*，**不在 OSI 认可的开源许可列表里**，且明确限制"基于 NapCat 代码开发其他项目"。因此本项目**只通过官方渠道调用它、不与它共享代码、不随仓库分发它的任何代码或二进制**。请自行按官方渠道获取并遵守其许可。

`plugins/` 与 `skills/` **默认不随仓附带扩展包**：为本项目写的那些包已经移除。宿主仍支持你自己往这两个目录里放包，启用哪些由 `config.json` 的 `custom.extensions.plugins.enabled` / `custom.extensions.skills.enabled` 决定（旧配置的 `custom.plugins` 会被派生）。⚠️ **不支持热插拔**，改了白名单必须重启机器人才生效（面板会当场提示）。两型的差别与写法见 [`docs/SKILLS.md`](./SKILLS.md)。不随本仓库分发的还有：`napcat/`（协议端）与扩展包运行期写出的数据目录，原因见 [`THIRD-PARTY-NOTICES.md`](./legal/THIRD-PARTY-NOTICES.md) §3。

---

<div align="center">
  <sub><a href="../README.md">English</a> · <b>简体中文</b></sub>
</div>
