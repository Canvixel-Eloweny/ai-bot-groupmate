<div align="center">

<img src="https://gcore.jsdelivr.net/gh/Canvixel-Eloweny/ai-bot-groupmate@main/assets/logo-v2.png" alt="QQ-BOT-Creative" width="140">

# QQ 群 AI 群友机器人 · QQ-BOT-Creative

**把 QQ 小号变成一个有脾气的群友。**
它会插话、接梗、潜水，也会偶尔自己冒个泡。

OneBot v11 · NapCat · 本机模型或 DeepSeek / 智谱 / 通义 · 零构建网页控制台

<p>
  <a href="./README.md">English</a> · <b>简体中文</b>
</p>

<img src="https://gcore.jsdelivr.net/gh/Canvixel-Eloweny/ai-bot-groupmate@main/assets/panel-overview.png" alt="控制台：运行总览、模型状态与容器健康在一屏内" width="880">

<p>
  <a href="https://github.com/Canvixel-Eloweny/ai-bot-groupmate/actions/workflows/ci.yml"><img alt="四层门禁" src="https://img.shields.io/github/actions/workflow/status/Canvixel-Eloweny/ai-bot-groupmate/ci.yml?branch=main&label=%E5%9B%9B%E5%B1%82%E9%97%A8%E7%A6%81&logo=githubactions&logoColor=white&style=for-the-badge"></a>
  <a href="https://github.com/Canvixel-Eloweny/ai-bot-groupmate/actions/workflows/codeql.yml"><img alt="CodeQL" src="https://img.shields.io/github/actions/workflow/status/Canvixel-Eloweny/ai-bot-groupmate/codeql.yml?branch=main&label=CodeQL&logo=github&logoColor=white&style=for-the-badge"></a>
  <a href="./LICENSE"><img alt="许可" src="https://img.shields.io/github/license/Canvixel-Eloweny/ai-bot-groupmate?label=license&logo=gnu&logoColor=white&style=for-the-badge"></a>
</p>

<p>
  <a href="./package.json"><img alt="平台" src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows-2f77c4?style=for-the-badge"></a>
  <a href="./package.json"><img alt="Node" src="https://img.shields.io/badge/node-%E2%89%A522.13-339933?logo=nodedotjs&logoColor=white&style=for-the-badge"></a>
  <a href="./package.json"><img alt="运行时依赖" src="https://img.shields.io/badge/dependencies-ws%20only-blue?style=for-the-badge"></a>
  <a href="./package.json"><img alt="零构建" src="https://img.shields.io/badge/build-none-lightgrey?style=for-the-badge"></a>
</p>

<p>
  <a href="./README.zh-CN.md#3-四套大脑预设与切换"><img alt="AI" src="https://img.shields.io/badge/AI-OpenAI--compatible-6f42c1?style=for-the-badge"></a>
  <a href="./CHANGELOG.md"><img alt="版本" src="https://img.shields.io/badge/release-v0.1.1-e05d44?style=for-the-badge"></a>
  <a href="https://github.com/Canvixel-Eloweny/ai-bot-groupmate/commits/main"><img alt="最后提交" src="https://img.shields.io/github/last-commit/Canvixel-Eloweny/ai-bot-groupmate?logo=git&logoColor=white&style=for-the-badge"></a>
</p>

<p><sub>仓库默认展示的是<b>英文版</b>（<a href="./README.md">README.md</a>）；
<b>本文件是中文版，两版不一致时以本文件为准</b>。<br>
The English README is what the repository shows by default; this Chinese edition is authoritative when the two differ.</sub></p>

</div>

## 三步跑起来

两条路线，终点都是同一个控制台（`127.0.0.1:8788`）。

**macOS / Linux —— Docker**（macOS 上推荐）。NapCat 跑在容器里，**你自己的 QQ 客户端完全不动**：

```bash
bash scripts/bootstrap.sh      # 检查环境 → 起容器 → 打印 WebUI 登录地址
node scripts/check-onebot.js   # 确认协议端活着，并列出你已加入的群
npm start                      # 跑机器人
```

**Windows —— 完全不需要 Docker。** 从 [Releases](../../releases/latest) 下载打包好的压缩包，
解压后依次运行 `1-SETUP.bat` → `3-START-NAPCAT.bat` → `2-START.bat`。

有两样东西永远要你自己准备：一个 **OneBot v11 协议端**（实际用 NapCatQQ）和一个**模型**
（本机跑，或一个 API Key）。逐步操作、以及每一步失败怎么办，见
[`USER-GUIDE.zh-CN.md`](./USER-GUIDE.zh-CN.md)。

---

把一个 QQ 小号接给任意 **OpenAI 兼容** 模型，让 AI 像群友一样插话、接梗、潜水、偶尔主动冒泡。
配套一个**零构建的浏览器控制台**（`panel/`），负责换大脑、看状态、改人设、管技能和记忆，全部点击完成。

```
QQ 小号 ──► NapCat(Docker, OneBot v11) ──► 桥接进程 src/index.js ──► 模型
              ws/http :3000/:3001               │ 触发判定 / 上下文 / 提示词组装 / 分句
                                                ├─ 本机  : MLX(:8080) / QwenChat(:8765)
                                                ├─ 云端  : DeepSeek API
                                                ├─ 云端  : 智谱 GLM（唯一支持联网+识图）
                                                └─ 云端  : 千问 Qwen（额度按模型发 · 90 天有效）
                         ┌──────────────────────┴──────────────────────┐
                         │  控制台 panel/server.js(:8788, 只听 127.0.0.1) │
                         │  ├─ 前端 panel/next/（零构建静态资产，每 3s 轮询 /api/state）
                         │  └─ 管理桥接进程启停、四套大脑预设、自定义工作台
                         └───────────────────────────────────────────────┘
```

> 项目显示名 `QQ-BOT-Creative`（原名 `qq-bot`，2026-09-17 改名）；本仓库在 GitHub 上的 slug 是
> `ai-bot-groupmate`（2026-10-07 由 `ai-group-chat` 换过来）—— slug 用便于检索的描述性英文，
> 显示名沿用既有叫法。
> 启动器为 `QQ-BOT-CONTROL.app`。
>
> **只想把它跑起来？** 直接看 **[用户使用说明](./USER-GUIDE.zh-CN.md)** —— 安装 → 登录 → 配置 → 启动，
> 写给不想先读源码的人。

---

## 1. 本地自测（不需要 QQ、不需要模型）

```bash
cd QQ-BOT-Creative
npm install
npm test                # 机器人本体断言（端到端 + 纯函数/纯判定防退化）
npm run test:panel      # 隔离沙箱跑完整回归：后端断言 + 面板前端断言（真实浏览器）
npm run verify          # 上面三项串起来跑一遍（README 里的断言数字一律以它为准）
```

预期：**四层全绿**（`verify-presets` 四套大脑接口 · `panel/next/verify.mjs` 真实浏览器 ·
`check-wb` 结构契约 · `smoke` 行为回归）。

> ⚠️ **本 README 刻意不写死"契约段数 / 断言条数"** —— 那组数字**腐烂过四次**
> （同一份文件里一度 `424` 与 `432` 自相矛盾，而**没有任何契约盯着它**：
> `check-wb` 只看代码与页面、不读 README 里的数字）。
> 根因是**同一个事实被手写了两遍**（代码里一份、README 里一份）—— 删掉这一份，就没有再漂的余地。
> 要数字请直接看 `npm run verify` 的**实测输出**。
> ⚠️ 两个口径别混：`check-wb` 报的是**段数**（不是"输出行数 / ✓ 条数"）；
> 而脚本最后会打印一行汇总（`── 全部通过 ──`），所以「✓ 条数」恒比「输出行数」少 1。
> （历史尸体与每次口径变化见 `CHANGELOG.md` 与 git log。）

> 门禁数字**只增不减**（删断言要么是退役了被断言的对象，要么就是在丢覆盖）——
> 也正因为它只增不减，手写的数字才一定会腐烂：**命令不会**。
> 提交前还有一层 `pre-commit` 自检（`scripts/pre-commit.sh`，装法：`bash scripts/pre-commit.sh --install`），
> 它**只报警、绝不阻断**（项目第 10 条约定：不许为了迁就检查器去改好代码）。

---

## 2. 协议端：三条路线（**先读这段再动手**）

### 路线 A（**macOS** 用户推荐）：Docker + Linux arm64

NapCat 的 **Linux arm64 支持是当前的**（版本覆盖到 build 52892），容器自带配套 Linux QQ，
**完全绕开 macOS 的 QQ 版本匹配问题，你本机的 QQ 一个字节都不用动。**

👉 **完整安装步骤见 [`INSTALL-DOCKER.md`](./INSTALL-DOCKER.md)**

```bash
bash scripts/bootstrap.sh     # 检查环境 → 起容器 → 打印 WebUI 登录地址
node scripts/check-onebot.js  # 探活 + 列出已加入的群（群号从这里拿）
npm start                     # 跑桥接
```

### 路线 B：macOS 原生（**当前受阻**）

NapCat 官方有 Mac 安装器 `NapNeko/NapCat-Mac-Installer`（v1.6，2026-09-12），
但它的 macOS arm64 版本白名单**只覆盖 `6.9.82-40768` ~ `6.9.93-47354`**，而：

| 项 | 值 |
|---|---|
| 你本机 QQ 的映射键 | `6.9.96-49738-arm64` |
| 白名单上限 | `6.9.93-47354-arm64` |
| 结果 | **不命中** |

而且 QQ 官网当前 Mac 版已到 **7.0.1**（QQNT 9.9.35 = build 52892），**比白名单上限还新**；
NapCat 官方给的那个 `QQ_v6.9.82.40990.dmg` 链接已 404，腾讯不存档旧版。

结论：走这条路需要先弄到一个**已下架的 QQ 版本**。不要从第三方下载站装 QQ —— 聊天客户端是这个
账号的全部凭据所在，来源不明的安装包风险不可接受。

> 版本白名单是写死在 NapCat 仓库里的，可自行核对：
> `packages/napcat-core/external/napi2native.json` 与 `packet.json`

### 路线 C：Windows 原生 NapCat（**Windows 用户走这条**）

Windows **不需要 Docker**。NapCat 官方就有 Windows 原生版，而且是**当期的** ——
macOS 之所以要容器，纯粹是因为它的版本白名单停在半年前（见上面 A/B）。
这条路省掉 Docker Desktop ＋ WSL2 整整一条链，而 NapCat 的 WebUI 仍在 6099、
OneBot 的 WS / HTTP 仍在 **3001 / 3000** —— 与桥接默认端口**逐字相同**，
所以**桥接与控制台一行都不用改**。

👉 **完整安装步骤见 [`USER-GUIDE.zh-CN.md` · 第 9 节](./USER-GUIDE.zh-CN.md#9-windows-用户)**

```bat
npm install
copy config.example.json config.json
```

装 NapCat、开两条通道、以及**五处平台差异**（没有本机模型 / 内存卡片 / 实例数 / Docker 那一环 / 黑窗口）
与「真机第一次跑该回报什么」，那一节里逐条都写了。

---

## 3. 四套大脑（预设）与切换

控制台把模型配置组织成**四套预设**（presets），切换时只做「物化」：把那套预设里的设置落盘成
扁平字段给桥接进程用，**绝不串到别的大脑上**。改过的设置按大脑各存各的，切走再切回来什么都不丢。

| 预设键 | 名字 | baseUrl | 特点 |
|---|---|---|---|
| `local` | 本机模型 | `http://127.0.0.1:<port>/v1`（MLX 或 QwenChat） | 离线、免费、数据不出本机；两条推理通道**互斥**（同一份模型内存，不能同时开） |
| `deepseek` | DeepSeek 云端 | `https://api.deepseek.com/v1` | 性价比高，纯文本 |
| `zhipu` | 智谱 GLM | `https://open.bigmodel.cn/api/paas/v4` | **唯一支持联网查询 + 识图**；另有「始终思考」系列（glm-5.3 等） |
| `qwen` | 千问（阿里云） | `https://dashscope.aliyuncs.com/compatible-mode/v1` | 免费额度**按模型发**（每模型 100 万 token、90 天有效）—— 所以降级链**故意排得长**：换一个模型等于换一份额度。这份额度**会用完**，而平台那个「免费额度用尽即停」开关**默认是关的**，不开就会开始扣钱 |

> **关于「免费」**：它不是一回事。本机永远不花钱；智谱有几个 Flash 档是**永久免费**；
> 智谱的赠送包与**千问的全部档位**都是**会到期**的额度。三种情况由**同一条判据**决定
> （`src/free-quota.js`），控制台会写明当前属于哪一种、什么时候到期限。
> 实时余额**只有智谱查得到**（千问的用量查询是账号级的，光有 API Key 拿不到）——
> 查不到时控制台照实说「要去官网看」，**不会编一个数字出来**。

### 自定义模型（用自己的 Key）

四套都不合用，就自己加一套。**只要接口是 OpenAI 兼容的就行** —— 公司网关、自建中转、
另一台机器上的 LM Studio、或者我们还没接的某一家。填名字、接口地址、你的密钥、模型名，
然后勾一下它到底能做什么：

| 勾了 | 实际会发生什么 |
|---|---|
| 能看图 | 群里的图片才会发给它。不勾就剥掉，它只看到「[图片]」。 |
| 能思考 | 才带思考参数。各家写法不一样，所以这里用**最通用**的那种 —— 服务端不认会自动去掉重发，不会卡住。 |
| 能联网 | 才带联网工具。⚠️ 那个形状是**智谱的**，别家大多不认。 |

**勾了的才会显示** —— 不会摆一排点不动的灰开关。想存几套就存几套，和其它大脑一样点一下就切；
在某一套上**点右键**可以改名或删除。

地址要填 **API 地址**（提供 `/chat/completions` 的那个），不是服务商的控制台网页 ——
填了控制台网址会被直接拦下并告诉你该填什么，而不是存一份每条请求都失败的配置。
自建和中转地址都可以。

自定义模型单独存在 `llm.customBrains`（一套一个条目），**不进 `llm.presets` ——
那张表是"一个服务商 → 一套设置"，把"用户自己命名、还是多套"的东西硬塞进去，
就得改掉十几处"假定名单固定"的代码，漏一处就是静默失效。

接口层有两套名字（历史包袱，不能混）：
- **target**（老前端一直这么传）：`local` / `cloud` / `zhipu` / `qwen` —— 其中 `cloud` 即 DeepSeek。
- **预设键**：`local` / `deepseek` / `zhipu` / `qwen` —— 按服务商命名，方便归档 Key。
映射：`deepseek→cloud→deepseek`、`zhipu→zhipu`、`qwen→qwen`、`local→local`。
⚠️ **不在上面这张表里的 target 会被静默当成 `local`（切本机）** —— 加一家服务商时最容易漏的就是这一行。

模型能力（思考档位 low/high/max、是否支持联网/识图、是否在降级链里可用）的唯一真相源是
`src/model-caps.js`，前端下拉、后端校验全部读它。**视觉判定唯一入口是 `supportsVision()`。**

---

## 4. 配置

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

云端 DeepSeek：

```jsonc
{
  "llm": {
    "baseUrl": "https://api.deepseek.com/v1",
    "apiKeyEnv": "QQBOT_API_KEY",   // 从环境变量读，不把 key 写进文件
    "model": "deepseek-flash"
  }
}
```

```bash
export QQBOT_API_KEY=sk-xxxx          # 用云端时
node src/index.js
```

### 关键配置项

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
| `custom` | 自定义工作台数据（多分区，详见下节；**分区数量刻意不写死** —— 那个数腐烂过） |

---

## 5. 自定义工作台（custom-config）

控制台「自定义」区是一个**数据驱动的模块化工作台**，所有结构定义在 `src/custom-config.js`
（唯一真相源），前端动态渲染、后端 `patchCustom()` 局部合并（绝不整份替换，避免「只改一处、别的没了」）。

分区（按展示顺序）：

1. **人格设定** —— 12 个结构化字段（短字段 300 字、叙述型字段 1200 字上限）。
2. **增强项** —— 12 个可选字段（留空不进提示词），提示词节名「更细的演法」。
3. **技能** —— `skills[]`，`kind: pack|persona` + `scope: global|group|user` + 触发词 + 示例。
4. **记忆** —— 自动记忆（机器人写入）+ 手动记忆（用户维护），前端按 id 增量渲染。
5. **定时消息** —— `trigger.scheduled[]`。
6. **扮演规则** —— `PLAY_RULES`（12 条，在「人物设定」之后注入提示词）。
7. **安全** —— 出网与注入相关的开关（浏览锁定等）。
8. **其它** —— 作息、跨会话发言、合并转发等各有独立分区。

（上表是**当前的分区形状**，不是"一共 8 个、永远不变"的承诺 —— 增删分区是常事，
写死条数只会让文档和现实脱节。）

> **人设版本约定**：改人设后要让旧会话历史失效，靠 `personaFingerprint` 判定（记忆刻意不算进指纹，免得加一条就清历史）。
> 导入配置后前端会把所有控件标成「接管」，否则轮询会把导入值冲回服务端旧值。

---

## 6. 人格

编辑 `persona/qq-chat.md` 即可，就是一段自然语言自述。`src/brain.js` 的 `buildMessages()` 会自动拼装：
说话方式规则 → 人格 → 增强项 → 扮演规则 → 群聊背景 → 上下文 → 当前消息。

想让回复更"生动"，按性价比排序：

1. **写实人格**（具体到口头禅、说话长度、什么时候不接话）
2. **加 few-shot**：在人格文件里贴几段你想要的真实对话样例
3. **调低 temperature**（0.8 左右更稳，1.2 以上会开始胡说）
4. 换更大的模型 —— 本机 8B 的人设保持能力明显弱于云端旗舰模型

---

## 7. 设计要点（为什么这么写）

- **CQ 注入防护**：发给协议端的消息一律用**消息段数组**而不是 CQ 码字符串。
  这样模型即使输出 `[CQ:at,qq=all]`，也只是一段普通文字，不会被解析成真实指令。
- **防自问自答**：`user_id === self_id` 的事件直接丢弃，否则机器人会回自己的消息形成死循环。
- **白名单兜底**：白名单为空且未显式放行 → **拒绝启动**，而不是默默全放行。
- **断线重连**：指数退避（1s→30s），`pending` 请求在断线时全部 reject，不会悬挂。
- **限流**：会话级最小间隔 + 每分钟上限 + 全局并发信号量。
- **超长切分**：优先在句号/逗号处切，避免被协议端截断。
- **降级链收敛**：换模型 / 存配置时前端与后端双闸校验——跨服务商、重复、超长、以及"始终思考"模型进链一律拒掉并说清原因（400 不属于可重试错误，进链会让整条链白排）。
- **日志环形缓冲**：`state.logs` 封顶 600 行，后端维护 `dropped` 计数让 `total` 单调递增，前端游标落后太多下发 `reset` 重画——避免了"日志到 600 条就冻住"的坑。
- **沙箱隔离**：`test/sandbox.sh` 起面板带 `QQBOT_SANDBOX=1`，服务器在该模式下**绝不接管/启停任何真实机器人进程**，杜绝回归测试误杀真机器人。

---

## 8. 目录

```
QQ-BOT-Creative/
  README.md
  INSTALL-DOCKER.md            # ← 容器路线安装手册（含回滚）
  QQ-BOT-CONTROL.app           # ← 双击启动：拉 Docker/容器 + 开控制台页面
  config.json                  # 你的实际配置（已预填，gitignore）
  config.example.json          # 配置模板（scripts/make-config-example.mjs 从真实配置生成并脱敏）
  docker-compose.yml           # NapCat 容器
  persona/qq-chat.md           # 人格设定
  plugins/                     # 扩展包 · 确定性型（提供能力 / 钩子）—— 本仓自带 5 个
  skills/                      # 扩展包 · LLM 型（注册工具）—— 本仓自带 8 个
                               #   ⚠️ 上面两个目录里是**代码**；config.json 里的"技能"是**数据**（提示词注入），
                               #     两者是两回事：本目录的 src/skills.js 管后者。
                               #   宿主会扫描 / 校验 / 报告，并在白名单内**真的加载执行**
                               #     （白名单 = config.json 的 custom.plugins.enabled，改了要重启）。
                               #   ⚠️ 这两个目录里**你自己新增**的包不入库（逐条点名，见 .gitignore）——
                               #     本仓自带的那 13 个是入库的，第三方代码请别直接塞进来。
  panel/                       # 控制台（浏览器面板 + 本地服务）
    server.js                  #   :8788，状态/配置/启停/换二维码等全部接口 + 路由分发
    next/                      #   现役前端：零构建静态资产（HTML/CSS/JS ＋ schema.js 控件表），每 3s 轮询
    lib/                       #   后端按 ESM 分层（L0 路径与状态 → L1 配置/页面/进度/插件 → L2 模型/进程）
    *.log / effective.json / local-trace.jsonl / usage-*.jsonl   # 运行时产物（gitignore）
  scripts/
    bootstrap.sh               # 一键起容器 + 抓 WebUI token
    check-onebot.js            # 协议端探活 + 列群
    check-wb.mjs               # 结构契约：唯一入口 / 双份实现必须一致 / 能力表与实测逐卡比对 / 扫描器自证
    dryrun.js                  # 干跑整条回复链（面板「试一句」就是调它）
    sniff.js                   # 抓 OneBot 事件，查「@ 了没反应」
    status.sh                  # 一屏看全套状态
    launcher.swift             # 启动器外壳源码（编译进 .app）
    make-appicon.py            # 生成 .app 图标
    make-config-example.mjs    # 从真实配置生成脱敏的 example
    probe-models.mjs           # 探测可用模型列表
  src/                         # 机器人（ESM 零构建，按职责分模块 —— 不写死条数，那个数腐烂过）
    ── 核心链路 ──
    index.js                   # 装配与主循环（协议接入、消息队列、热重载、主动 tick）
    onebot.js                  # OneBot v11 WS 客户端 + 消息段解析
    bridge-io.js               # 协议端出网：发消息、取历史、上报
    brain.js                   # 触发判定 + 上下文 + 提示词组装 + 分句/潜水（**没有 LLM 主循环**）
    llm.js                     # OpenAI 兼容客户端（降级链 + 熔断）+ toolsForRequest() 判据
    tool-loop.js               # 工具回合循环（B12e-1 起是 LLM 主路径；llm.chat 只剩主动话题一处旁路）
    tool-registry.js           # 工具注册 / 取名 / 稳定 specs（零依赖叶子）
    pace.js                    # 发送节奏（唯一入口）
    egress.js                  # 出口闸门 + 日志脱敏（共用特征表）
    interject.js               # 没被点名时的插话判定（掷骰 + 冷却 + 因子表）
    reply-text.js              # 回复分句、潜水占位、内部标记剥除
    ambient.js / context-budget.js  # 背景消息粘性窗口 / 提示词预算与淘汰
    config.js                  # 配置加载 + 白名单安全校验 + 服务商判定 + DATA_DIR
    custom-config.js           # 工作台数据结构唯一真相源（8 分区 + 字段契约）
    model-caps.js              # 模型能力唯一真相源（思考档/联网/识图/降级链可用性）
    field-schema.js            # 数值字段的默认值与区间唯一声明表（零依赖叶子）
    ── 运行时调度 ──
    sleep.js                   # 作息计划与叫醒（状态由计划重算，不落 status）
    reminder.js                # 定时提醒（窗口三态 + 节假日兜底）
    notice.js                  # 戳一戳 / 通知类入站事件
    session-control.js         # 会话级中止与重试
    cross-send.js              # 跨会话发言（默认关 · 有配额与审计）
    forward-expand.js          # 合并转发展开（节段上限 / 深度 / 只进正文）
    forward-probe.js           # 真机探针：转发事件的真实形状
    ── 能力与判据 ──
    gate-scan.js               # 闸门规则表的唯一遍历实现 + 失败哨兵（零依赖叶子）
    injection.js               # 注入闸门（脏记忆不落盘，fail-open）
    net-rules.js               # 判「花不花钱」（与 safe-fetch 不许互相 import）
    safe-fetch.js              # 判「能不能去这个地址」SSRF 判据（扩展包出网走 ext-fetch.js）
    browse-lock.js             # 浏览锁定（名单 + 锁定开关，fail-closed）
    ext-fetch.js               # 扩展包出网口（自带出站配额，接 safe-fetch + 网关）
    text-hygiene.js            # 请求体文本卫生（Unicode / 代理项，零依赖叶子）
    internal-marks.js          # 内部标记的唯一出处（不许外泄进群）
    tier.js                    # 用量档位与计费口径
    holidays.js                # 节假日查表（先查表、后按星期几兜底）
    vision-probe.js            # 视觉能力实测探针（测试图自造，不写业务数据）
    speech-rules.js            # 说话规则（分句 / 潜水 / 收尾）
    skills.js                  # 技能注册与匹配（kind/scope/触发词）——config 里的**数据**，走提示词注入
    memory.js                  # 自动记忆
    usage.js                   # 调用量记录（花费面板数据源）
    trace-id.js / trace-stats.js   # traceId 与图片哈希 / 缓存命中率长期留档
    ── 持久化 ──
    atomic-write.js            # 原子写（JSON/文本/折半截断）+ 启动时清扫残留临时文件
    session-archive.js         # 会话存档落盘与恢复（超新鲜度**拒绝恢复**）
    memory-record.js           # 结构化记忆记录（复证 / 推翻 / 淡忘 / 人工复核）
    memory-store.js            # 记忆的读盘口（面板与机器人共用，零 src 依赖）
    working-memory.js          # 跨轮工作记忆（TTL + 逐条淡忘，只存客观状态）
    style-profile.js           # 群友风格画像（说话特征统计）
    reply-track.js             # 回复记账（谁在哪一轮说过什么）
    unread.js                  # 未读模型（有界计数；不用 markAllRead 那种清空式 API）
    custom-faces.js            # 自定义收藏表情（只读接入）
    face-habit.js / face-marks.js  # 表情使用习惯 / 表情标记的判据
    ephemeral.js               # 瞬时态判据（"正在生成"算不算数），写侧与读侧共用同一份
    config-history.js          # 配置回滚历史
    ── 插件执行层（B12d 宿主 + B12e 执行层）──
    plugin-manifest.js         # 清单判据：id / apiVersion / entry 三道闸（零依赖）
    plugin-host.js             # 宿主：扫目录、读清单、按白名单**加载并执行**（四态生命周期，不支持热插拔）
    plugin-api.js              # 按权限造 api（ctx 裁剪）+ activateCtxOf()
    plugin-settings.js         # 扩展设置（敏感键、越界拒绝、按 kind 渲染）
    hook-bus.js                # 钩子总线（5 个点；出错 **fail-open**）
    send-guard.js              # 每条发出前合成一次 send_message 喂给 before-tool
    ext-scope.js               # scopedOnebot()：onebot 白名单代理（send_* 一律拒绝 + 告警）
    control-channel.js         # 面板 → 机器人控制通道（中止/重试，命令文件 + 幂等）
    ── 辅助 ──
    logger.js · bridge-proc.js（进程核验，fail-closed）· bridge-lock.js（实例互斥锁）
    panel-auth.js（鉴权判定纯函数）· proactive.js
  test/
    smoke.js                   # 行为回归断言（端到端 + 纯函数/纯判定防退化）
    sandbox.sh                 # 隔离沙箱 + 面板回归（npm run test:panel）
    verify-presets.mjs         # 四套大脑接口断言（后端）
    e2e/                       # 5 支真机/真浏览器脚本（不进 npm test，手动跑）
    mock-onebot.js / mock-llm.js
    audit-align.mjs            # 审查前后代码对齐校验
```

## 9. 接口文档

全部 API 路由的入参 / 出参 / 副作用 / 幂等性见 **[`docs/API_CONTRACT.md`](./docs/API_CONTRACT.md)**。

## 10. 已知限制

- 不做流式转发，整段回复生成完再发（群里逐字蹦字更不像人）。
- 语音/视频只转成占位文本；图片在**支持视觉的模型**（如 glm-4.6v-flash）下会真的识图，
  纯文本模型仍只收占位符。
- 会话上下文跨重启靠**存档恢复**（B10d · O-SESSION），但超过新鲜度的存档会被**拒绝恢复**
  （宁可失忆，也不要接上一个早就结束的话题）。
- 单进程单实例，没有做多账号。
- 面板是「每次请求读盘」零构建形态；改 `server.js` 后必须重启面板进程才生效（`POST /api/panel/restart` 幂等）。
- **插件已能执行（B12e 起），但"目录里有"与"会生效"仍是分开的两件事**：
  `plugins/` 与 `skills/` 会被扫描、清单会被校验、面板上会列出来，
  **只有在白名单里（`config.json` 的 `custom.plugins.enabled`）才会真的加载并执行**。

## 11. 路线图

以下都是**已知未做**的项，来源是上一节的「已知限制」与本项目的内部台账 —— 不是许愿池，
也没有时间承诺：这个项目由一个人维护，优先级会随实际使用中遇到的痛点调整。

- [ ] **多账号支持** —— 当前是单进程单实例，多开要手工隔开数据目录。
- [ ] **语音 / 视频消息的内容理解** —— 现在只转成占位文本，模型看不到里面说了什么。
- [ ] **出站富媒体** —— 主动发图 / 用收藏表情。目前表情包是**只读**接入（读得到、发不出）。
- [ ] **macOS 原生协议端**（即第 2 节的「路线 B」）—— 卡在 NapCat 的 QQ 版本白名单，
      需要先弄到一个腾讯已下架的 QQ 版本。
- [ ] **插件热更新** —— 改插件白名单目前必须重启机器人才生效（面板会当场提示这一条）。

有想优先做的，开个 issue 把使用场景讲清楚就行。

## 12. 参与本项目

这个项目是一个人维护的，欢迎带着**具体的复现步骤**来提问题。动手之前先读这几份：

| 文件 | 讲什么 |
|---|---|
| [`CONTRIBUTING.md`](./CONTRIBUTING.md) | 怎么跑四层门禁、提交信息怎么写、哪些改动不会被合 |
| [`SECURITY.md`](./SECURITY.md) | **漏洞怎么私密上报**（别开公开 issue）；以及本项目**已知的设计边界**（哪些"看起来像漏洞"其实是有意为之） |
| [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md) | 交流的基本约定 |
| [`CHANGELOG.md`](./CHANGELOG.md) | 每个批次改了什么、为什么改 |
| [`THIRD-PARTY-NOTICES.md`](./THIRD-PARTY-NOTICES.md) | 借鉴了谁的思想、边界画在哪儿（它同时是**本仓库不构成许可传染**的凭据） |
| 维护者自查 | 发布前会跑一遍 `npm run publish:audit`（只读、按阻断项给退出码）。⚠️ 它与去标识对照表**都只住在维护者仓库里**，不随公开仓库发布 —— 你 clone 下来没有这条命令，这是有意的 |

⚠️ 一条**改代码之前必须知道**的：本项目的门禁是**四层**（`check-wb` 静态契约、
`smoke` 行为回归、沙箱里的 `presets` 与面板自检），而且**每一处修复都要配一条"只打它那一条"的
变异测试**（见 [`test/mutations/README.md`](./test/mutations/README.md)）。
只跑 `npm test` 是不够的 —— 完整命令与"为什么这么设计"都在 `CONTRIBUTING.md`。

（本节 2026-10-05 补：此前仓库里已经有这五份治理文件，而 README **一个都没引用** ——
从 README 进来的外部贡献者根本看不到它们。这是开源前审查的 M-01。）

## 13. 联系方式

| 渠道 | 用途 |
|---|---|
| [Issues](../../issues) | **首选**。提问、报缺陷、提需求都走这里 —— 公开讨论的结论能被下一个遇到同样问题的人搜到，私信不能 |
| 安全漏洞 | **不要开公开 issue**。私密上报的入口，以及本项目「看起来像漏洞、其实是有意为之」的边界清单，都在上一节那张表里的 `SECURITY.md` |

两处例外，请先处理后再说：

- 消息里出现**真实 QQ 号 / 群号 / 聊天记录**时，先脱敏再贴。
- 报缺陷前先跑一遍 `npm run verify` 并把输出贴上 —— 一份能复现的最小步骤，比一段长描述有用得多。

如果只是想问「这个能不能做」，**先说清使用场景**比说清期望有用。

## 14. 许可与出处

| 项 | 值 |
|---|---|
| 本项目的许可 | **Apache-2.0**（全文见 [`LICENSE`](./LICENSE)，署名通知见 [`NOTICE`](./NOTICE)） |
| 第三方声明 | 见 [`THIRD-PARTY-NOTICES.md`](./THIRD-PARTY-NOTICES.md) |
| 运行时依赖 | 只有 `ws`（MIT）。零构建、无其他第三方运行时依赖 |
| 发布前审计 | `npm run publish:audit`（只读、按阻断项给退出码）。⚠️ 该脚本与它读的去标识对照表**都只住在维护者的仓库里**，不随公开仓库发布 —— 别人 clone 下来并没有这条命令 |

### 三句话读懂 Apache-2.0

1. **可以随便用**：读、跑、改、自己用、闭源分发都行，不需要问任何人。
2. **带上两样东西**：`LICENSE` 全文与 `NOTICE` 署名通知要随附，改过的文件要标注你改过。
3. **它有明文专利授权，也明确不授予商标权**；但它**不要求**你公开自己的改动（没有网络条款）。

### ⚠️ NapCat 不是本仓库的一部分

运行需要 OneBot v11 协议端（本项目实际使用 NapCatQQ）。它的许可是自定义的
*Limited Redistribution License*，**不在 OSI 认可的开源许可列表里**，且明确限制
"基于 NapCat 代码开发其他项目"。因此本项目**只通过官方渠道调用它、不与它共享代码、
不随仓库分发它的任何代码或二进制**。请自行按官方渠道获取并遵守其许可。

`plugins/` 与 `skills/` 里**本仓自带 13 个扩展包**（确定性型 5 个 + LLM 型 8 个），
随仓库分发，直接可用。你自己往这两个目录里加的第三方包**不入库**（见 `.gitignore` 的逐条点名）。
启用哪些由 `config.json` 的 `custom.plugins.enabled` 决定 —— ⚠️ **不支持热插拔**，改了白名单必须重启机器人才生效（面板会当场提示）。
不随本仓库分发的还有：`napcat/`（协议端）与扩展包运行期写出的数据目录，原因见 `THIRD-PARTY-NOTICES.md` §3。
