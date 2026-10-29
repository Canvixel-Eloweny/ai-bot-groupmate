# Estrella Bot · API 契约文档

> 来源：`panel/server.js` 的 `http.createServer` 手写分发器（无第三方框架）。**它是唯一真相源** ——
> 本文只是它的说明；两者不一致时以代码为准，并**当场把本文改回来**（2026-10-01 清理轮实测：
> 本文停在"29 个 API"，而代码里已经有 39 条 —— 文档烂掉之后比没有文档更糟，因为它会被信）。
> 所有接口走 HTTP/1.1，面板**只监听 127.0.0.1**（本机）。Windows 产品形态（installed / portable）
> 由系统分配端口，实际地址写在 `USER_ROOT/panel/.panel.json`（`schema/pid/port/url/appId/version`）；
> dev 形态默认 `http://127.0.0.1:8788`，沙箱/CI 用 `QQBOT_PANEL_PORT` 显式固定。
> 响应统一为 JSON（`sendJson`），二进制接口单独标注。错误统一返回 `{ error }` 或 `{ ok:false, ... }`。
> 路由总数：**2 个页面（`/` 与 `/next/`）+ 63 个 API**（以 `panel/server.js` 的
> `API_ROUTES` 为准；2026-10-22 在 §41 补齐 24 条此前没有字段级契约的路由 ——
> 其中 19 条此前连独立小节都没有）。
>
> 2026-10-21（Win-v0.1.2 移植）新增 5 条：`POST /api/persona/adopt`
> （角色卡 AI 认领，写路由：token + 审计）、`GET /api/fake-qq/state`、
> `POST /api/fake-qq/{start,send,stop}`（假 QQ 会话，三条 POST 都在写路由）。
> （`/next/` 及其资产是 2026-10-02 前端初步重构接线时加的，见 §1b；它只发页面，不是 API。）

---

## 约定

- **幂等性**：标注「幂等」= 连点结果与点一次一致、无副作用累加；「非幂等」= 会改变状态/资源。
- **同步 / 异步**：凡涉及「等机器人读入新配置」「等容器就绪」的接口，会 `await` 到真可用才返回（见各条 `applied` 字段）。
- **日志**：所有状态变更都会 `pushLog(...)` 进内存环形缓冲（封顶 600 行），前端经 `/api/logs` 增量拉取。
- **沙箱隔离**：`QQBOT_SANDBOX=1` 时，`/api/bridge/start|stop`、`/api/switch`（接管分支）、`/api/onekey/*` 等会拒绝触碰真实机器人进程。

---

## 1. GET `/`（控制台入口页）

**控制台只有一套**（2026-10-02「换主」）：入口页 = `panel/next/index.html`，
由 `panel/lib/next-page.js` 的 `NEXT_ENTRY` 指认，**每次请求从磁盘读** ⇒ 改资产立即生效、无需重启面板。
token 的注入落点**只有这一处**（`injectPanelToken`，只替换 `<meta name="panel-token">`）。

- **响应**：`text/html; charset=utf-8`，`Cache-Control: no-store`。
- **副作用**：无。
- **幂等**：是。

## 1a. GET `/<资产名>`（入口页的资产，与入口**同层挂在根上**）

`GET /style.css` · `/app.js` · `/schema.js` · `/demo-state.js` —— 逐个发（**分发**，不是拼装）。

- 为什么是分发：`<script type="module">` 无法内联跨文件，硬拼就要引入一次构建 ——
  而页面层是**零构建**的（改完立刻生效，不重启面板）。
- **为什么资产必须与入口同层**：入口页里的引用是相对路径（`./app.js`）。入口在根、资产在子目录的话，
  浏览器会把 `./app.js` 解析到子目录去（404）—— 表现是 **HTML 到了、JS 与 CSS 都没到、页面白屏**，
  而两个地址各自都是 200（这类故障只能靠"相对关系"本身来判）。
- 名单与三道闸（白名单 / 名字形状 / `path.relative` 复核）都在 `panel/lib/next-page.js`（L1 叶子）；
  路径 → 资产名的映射也在那里 `assetNameForRootPath()` **派生**（不重抄一遍名字 —— 两张表会漂）。
  **目录里的 `README.md` / `verify.mjs` 取不到**：文档与自检脚本没有理由出现在 HTTP 面上。
- **出参**：CSS / text-javascript / HTML；名字未登记或读不到 → **404** `{ error }`（不静默回空）。
- **副作用**：无。**幂等**：是。不鉴权（只读）。

## 1b. GET `/next`、`/next/`、`/next/<资产>`（**老地址兼容**）

新版控制台在 2026-10-02 之前挂在 `/next/`。书签、浏览器里还开着的旧标签都指着它 ⇒ 保留一次 **302**：

- `/next`、`/next/` → **302 → `/`**；`/next/<资产>` → **302 → `/<资产>`**；未登记的 → **404**。
- ⚠️ 兼容做成**跳转**而不是"再发一次"：同一份资产两处可发 = 又多一条静的入口，而"多一条入口"不会报错。
- ⚠️ 跳转目标**只从登记过的名字里来**，绝不回显请求里的路径（否则 `Location` 就成了一个能塞任意串的地方）。
- **消费者**：Mac 的 `launcher.sh` 开根地址（dev 形态 `http://127.0.0.1:8788/`）；
  Windows 启动器先读 `panel/.panel.json`，再开发现文件里的根地址。
  自检：`node panel/next/verify.mjs`（dev 默认验 8788 根地址；产品形态用 `--url http://127.0.0.1:<port>/`）。

---


---

## 2. GET `/api/state`

全量状态快照，前端每 3 秒轮询一次。

- **出参**（节选）：
  - `bridge`（running/pid/uptimeMs/self_id）、`docker`（up/containerInfo）
  - `llm`（baseUrl/model/provider/thinking/features/maxTokens/keys 掩码）
  - `allow` / `deny` / `trigger`、`persona`、`custom`（工作台 8 分区）
  - `usage`（用量，**按账本文件签名 + 当天日期缓存**，逐文件解析结果也各自缓存）、`localChannel`（本机两条通道互斥状态）
  - `panel`（pid/bootedAt/codeMtime/codeMtimeNow/**stale**）—— 用于检测「面板进程跑旧代码」
  - `appMeta`（`version` / `runtime` / `platform` / `repo`）—— 关于页的唯一来源；`runtime` 是本进程的 Node 版本，
    `repo` 来自程序根 `package.json` 的 `homepage`，前端不手抄第二份 URL。
  - `uiIdentity`（`state` / `reason` / `checkedAt` / `anchors` / `manifest.sha256` / `key.fingerprint`）——
    `official` = 签名清单与当前界面骨架一致；`unofficial` = 整体替换/签名不符；`unknown` = 清单或公钥缺失/旧后端。
    `anchors` 只含核心域/页/外壳选择器/渲染入口，前端据此检查本地 DOM；加新页面/新插件不受影响。
  - **第 53 轮（Windows 适配）新增 / 改动的几项**（2026-10-09）：
    · `container.applicable` —— **这台机器走没走"容器"这条路**。`false` = 原生 NapCat
      （Windows 便携版不装 Docker）⇒ 页面**不许**把"容器没跑"当故障显示（那是假警报，
      用户会去查一个不存在的容器）。判据在后端，前端不按平台自己猜。
    · `ports.onebot`（`http` / `ws` / `wsConfigured` / `httpIsDefault`）—— 面板**探的是哪两个端口**。
      端口取自 `config.onebot.wsUrl`（**不再写死 3000/3001**，那两个数字只是 macOS 的
      Docker 路线"容器端口映射"的巧合）；下发这四个数字是为了让用户能一眼核对。
    · `localModel.supported` / `localModel.unsupportedWhy` —— 本机模型那套（MLX + QwenChat）
      是 **Apple Silicon 专用**的。Windows 上 `supported: false`，页面据此**整块隐藏并指路**
      （而不是摆一堆点了必然失败的控件 —— 这条是本项目 M7 那条教训的直接应用）。
    · `config.splitToken` —— `reply.splitToken` 从此**面板可改**（见第 10 节 `POST /api/config`，
      **空串会被忽略、保持原值**）。它以前只有直接编辑 `config.json` 才能改，而**空串**会让
      回复被**逐字**发出去（分隔正则退化成"每个字符之间都匹配"）。
    · `memory` 可能是 **`null`**（Windows 上采不到、或命令失败）—— 页面渲染成**「暂不支持」**，
      **绝不许**兜成 `0`：`0 MB` 会被读成"它不占内存"，那是撒谎。
  - `emotion` / `people` / `gallery` / `apiDeals`（2026-10-02 新增）—— **插件写的数据**，
    由 `panel/lib/bot-data.js` **直接读盘**后白名单投影：`data/bot-state.json`（本体情绪）·
    `data/memory/people/*.json`（群友印象）· `data/images-lib/index.json`（自定义图库，只报张数）·
    `data/api-deals.json`（AI 额度情报）。四者都**不做机器人转发**（"机器人没在跑"正是用户最想
    看这些数据的时候），都**读不到不抛**，且 `ok:false` 时带一个人能看懂的 `reason` ——
    所以前端**不许把 `ok:false` 画成红色故障**（"那个包还没被用到过"是正常状态）。
  - `zhipuPackages`（带 60s 缓存）、`models`（本机已装规格）
  - `zhipuMeta` / `zhipuDefaultChain` / `modelCaps`（按服务商算好的能力表 —— 面板**不自己抄模型名单**）、
    `defaultChain`（**当前这家**的默认链路，含它自己的主模型；2026-10-17 新增，面板「恢复实测最优」用它，
    以前写死取 `zhipuDefaultChain` ⇒ 在千问页面上会提交一条 GLM 链）、
    `quotaPlans`（**各家的免费额度是什么性质**，2026-10-07 接千问时新增）。
    唯一实现住 `src/free-quota.js`，是「这笔花不花钱」的判据；它回答**规则**（永久免费 / 限时额度 / 计费），
    **不是余额**。余额只有智谱查得到（`liveBalance: 'api'`）—— 千问的用量查询要账号级签名，
    API Key 拿不到，所以它对千问标 `'none'`：**面板照实说"要去官网看"，不许编数字**。
- **副作用**：热路径上有缓存（`docker ps` 8s TTL、`usage` 按文件签名缓存 + 逐文件解析缓存），**不会每次重算**。
- **幂等**：是（只读）。

---


---

## 3. GET `/api/audit?limit=N`

读审计留档 —— `panel/audit.jsonl`（append-only，环形封顶 500 行，超出折半保留后半）。

- **入参**：`limit`（默认 100）。
- **出参**：`{ file: 'panel/audit.jsonl', lines }`（最新在前）。
- **副作用**：无。只读路由 —— 不鉴权、不进审计（它自己不该被自己记一笔）。
- **幂等**：是。
- **消费者**：面板 UI **不读它**；`test/verify-presets.mjs` 拿它断言"改一次配置真的留了痕"。
  留着它的理由正是后者 —— 没有它，「审计有没有记」只能靠人去翻文件。

---

## 4. GET `/api/logs`

增量拉取面板日志（环形缓冲，封顶 600 行）。

- **入参**：`since` = 客户端当前游标（累计第几行）。
- **出参**：`{ lines, total, dropped, reset }`
  - `total = dropped + state.logs.length`（单调递增，永不冻住）
  - `reset: true` = 客户端游标已过期（清过日志/重启过），`lines` 为全量，前端应清空后追平。
- **副作用**：无。
- **幂等**：是（只读）。
- **契约**：沙箱测试【24】覆盖「填满 600 行后游标仍拿得到新行」与 `reset` 行为。

---


---

## 5. GET `/api/sessions?limit=N`

会话聚合 —— 「现在在跟谁聊」。**数据源是 trace，不是存档**（两者故意不合并：
trace 是有界窗口、反映最近活动；存档是机器人退出时补写的全量历史 —— 合成一份会在截断时静默丢数据）。

- **入参**：`limit`（默认 200）。
- **出参**：`{ file: 'panel/local-trace.jsonl', items, window }`。
- ⚠️ `window` 用的是 `TRACE_AGGREGATE`，**不是**对话流卡片的 `TRACE_SHOWN` ——
  用前者只是"列表少几条"，用后者会让会话列表**永远只剩一两个会话**。
- **副作用**：无（只读 trace）。**幂等**：是。

---

## 6. GET `/api/sessions/detail?key=&limit=`

某个会话的最近若干条记录（数据源同上，仍是 trace）。

- **入参**：`key`（如 `group:100000001`）、`limit`（默认 50）。
- **出参**：`{ key, items }`；**`key` 为空时 `items: []`**（不发一次无意义的全量扫描）。
- **副作用**：无。**幂等**：是。
- ⚠️ 会话文本是**群聊原文**，前端渲染必须过 `esc()`（契约 §30 钉着）。

---

## 7. GET `/api/chats`

会话存档列表 —— 「之前聊过什么」。读 `panel/session-archive.json`。

- **出参**：`{ file: 'panel/session-archive.json', items }`。
- **副作用**：无。存档由**机器人侧**写（O-SESSION），面板**只读** ——
  "该不该恢复存档"是机器人的判据，面板不碰那个决定。**幂等**：是。

---

## 8. GET `/api/chats/detail?key=`

某个存档会话的明细（历史消息 + 背景）。

- **入参**：`key`。
- **出参**：`{ key, detail }`；`key` 为空或查不到 → `detail: null`（**不抛**）。
- **副作用**：无。**幂等**：是。

---

## 9. POST `/api/config/undo`

撤销最近 N 次保存（把配置**整份**退回那一版）。

- **入参**：`{ steps? }`（≥1，默认 1）。
- **出参**：成功 `{ ok, steps, msg }`；**没有可撤的历史 → 400** `{ ok:false, error }`。
- **副作用**：写 `config.json`；并把**被消费掉的历史条目弹掉**。
  ⚠️ 撤销**自己不进历史** —— 否则再撤同样步数会跳回刚离开的那一版，「撤销」就变成了来回切换。
- **幂等**：否。🔴 **写路由**（它整份覆盖配置，必须受 token 保护 + 进审计）。
- **页面**：顶栏「撤销上一次保存」按钮；可撤销的次数由 `/api/state` 的 `configHistory` 下发（**只下发条数** —— 那份文件里是完整的 config.json，含 API Key）。

---

## 10. POST `/api/config`

保存全部配置（含各家大脑预设物化、工作台局部合并、降级链校验、能力收敛）。

- **入参**（全部可选，缺省忽略）：
  - `baseUrl` / `apiKey` / `model` / `fallbackModels[]` / `thinking`（`{mode,level}` 或 `"auto"|"on"|"off"`）/ `maxTokens`
  - `localChannel`（`mlx`|`qwenchat`，只在本机大脑有意义）
  - `context.recentTurns` / `context.ambientMessages`
  - `features.{webSearch,vision}`（第三道闸，落盘前按模型能力收敛）
    ⚠️ `stickers`（发 QQ 表情）已于 2026-10-17 随该能力整体下线删除 —— 传入会被忽略。
  - `groups[]` / `denyGroups[]` / `denyUsers[]` / `requireAtInGroup` / `interjectChance` / `aliases[]` / `personaName`
  - `custom` —— 工作台那一块（走 `patchCustom` 局部合并）
  - `launch.{mode,openOnStart,closeAction,autoProtocol}` —— 桌面端启动/关闭偏好
    （`mode` 只收 `browser` | `window`；`openOnStart` / `autoProtocol` 只收布尔；
    `closeAction` 只收 `tray` | `quit`，默认 `tray`）。
    ⚠️ 它由**启动器**（Windows 快捷方式 / Mac 图标 / 命令行）在启动时读取一次 ——
    **保存成功 ≠ 立刻生效，下次启动才换形态**（面板上的提示语照此措辞）。
- **出参**：`{ ok, bridgeRunning, applied, autoDisabled[], autoDisabledMsg, msg }`
  - `applied`：机器人是否已真正读入新配置（热重载约 1s 延迟，会 `await` 后再返回）
  - `autoDisabledMsg`：换到不支持的模型时**如实告知**被自动关掉的能力（如「已自动关闭 识图」）
- **校验失败返回 400**：跨服务商模型、降级链含「始终思考」模型、链超长（`MAX_CHAIN_LEN`）、
  `launch.mode` 越界 / `openOnStart`、`autoProtocol` 非布尔 / `closeAction` 不在 `tray|quit`
  （值域与判定唯一一份在 `src/launch-mode.js`）。
- **副作用**：写 `config.json`、物化到对应大脑预设、可能触发 `stashCurrentPreset`、等待机器人热重载。
- **幂等**：否（会覆盖落盘配置；重复提交同值 = 幂等效果，但本身是写操作）。

---


---

## 11. GET `/api/groups`

列出机器人已加入的群（经 OneBot 协议端 `:3000/get_group_list`）。

- **出参**：`{ ok, groups:[{id,name}] }`；协议端未连上则 `{ ok:false, groups:[] }`。
- **副作用**：无。
- **幂等**：是（只读）。

---


---

## 12. POST `/api/bridge/start`

启动桥接进程（spawn `src/index.js`）。

- **出参**：`{ ok, msg, pid? }`（失败 400）。
- **副作用**：拉起机器人进程，写 `.bridge.pid`；**沙箱模式下直接拒绝**。
- **幂等**：是（已在跑则复用，不重复 spawn）。

---


---

## 13. POST `/api/bridge/stop`

停止桥接进程（`await` 到进程真正退出）。

- **出参**：`{ ok, msg }`（失败 400）。
- **副作用**：kill 进程树、清 `.bridge.pid`；**沙箱模式下直接拒绝**。
- **幂等**：是（没在跑则直接返回成功）。

---


---

## 14. POST `/api/bridge/command`

面板 → 机器人的命令下发（D6b · Q7 裁决①「命令文件轮询」）。

- **入参**：`{ cmd }`（闭集合，见 `src/control-channel.js`）。
- **出参**：`{ ok, msg }`（失败 400）。
- **副作用**：**只写**命令文件 `panel/.bridge-cmd.json`，等机器人下一轮轮询取走。
  ⚠️ 这里**不执行、也不假装知道结果** —— 结果由机器人写回同一个文件的 `done` 字段，
  页面从 `/api/state` 的 `bridge.control` 读回来。「点完立刻回成功」是错的：
  它只证明文件写下去了（机器人可能根本没在跑）。
- **幂等**：否（一条命令消费一次；重复点 = 多发一条）。🔴 **写路由**（它改变机器人的行为，只是经由文件而不是信号）。

---

## 15. POST `/api/check`

连接自检（跑 `scripts/check-onebot.js`）。

- **出参**：`{ ok, output }`，output 为脚本 stdout+stderr。
- **副作用**：运行一次外部脚本（只读探测，不改状态）。
- **幂等**：是。

---


---

## 16. POST `/api/local-model/start`

启动本机模型推理服务（MLX `:8080` 或 QwenChat `:8765`，**两通道互斥**）。

- **入参**：`{ channel?, model? }`。
- **出参**：`{ ok, msg }`（失败 400）。
- **副作用**：拉起对应通道的 Python 服务，占用该通道模型内存。
- **幂等**：是（已在跑则复用）。

---


---

## 17. POST `/api/local-model/stop`

停止本机模型推理服务。

- **入参**：`{ channel? }`（缺省取当前通道）。
- **出参**：`{ ok, msg }`。
- **副作用**：释放模型内存；用户自己手动开的 QwenChat 窗口**保留**（非本次运行拉起）。
- **幂等**：是。

---


---

## 18. POST `/api/switch`

一键切换大脑（local / cloud=DeepSeek / zhipu / qwen=千问 / custom=自定义），连带把该开的开了、该关的关了，等到真可用才返回。

### 自定义大脑（2026-10-07 新增）

用户自己填地址 / 密钥 / 模型名的那些，能存好多套；判据住 `src/custom-brain.js`。
⚠️ **不进 `llm.presets`** —— 那张表是"一个服务商 → 一套设置"，而自定义是"用户命名的多套"，
形状不同。分开存可以让十几处"假定名单固定"的代码一个都不用改。

| 路由 | 入参 | 说明 |
|---|---|---|
| `POST /api/custom-brain/save` | `{ id?, name, baseUrl, model, apiKey?, fallbackModels?, features? }` | 新增或改一套。**密钥留空 = 不修改**（改模型名不该把 Key 弄丢）。新增后自动切到它 |
| `POST /api/custom-brain/rename` | `{ id, name }` | 只改名字，其它一个字节都不动 |
| `POST /api/custom-brain/delete` | `{ id }` | 删除。**删的若是当前在用的那套，会自动切回智谱**并在回执里说清 |

三条都属于**写路由**（受鉴权与审计：`isWriteRequest` 是两者的共同判据）。

`features` 只认三项，每项都对应一件我们真做得到的事：
`vision`（发不发图片）· `thinking`（带不带思考参数）· `webSearch`（带不带联网工具）。
⚠️ 第四项 `functions`（工具调用）**不接受声明**，恒 false —— 没有实测手段，判宽了会让整条请求 400。

**界面只显示勾过的**：后端下发 `config.customVisibleFeatures`（结论数组），
前端**不许**自己按 `features` 再判一遍（那会变成两套口径，而两边看起来都正常）。
⚠️ `/api/state` **不鉴权**，所以下发的列表里**没有密钥**，只给 `hasKey`（填没填）。

- **入参**：`{ target: 'local'|'cloud'|'zhipu'|'qwen', size?, channel? }`
  - ⚠️ 命名两套：`target` 用 `cloud`（非 `deepseek`）；预设键才是 `deepseek`。`deepseek` 会被映射成 `cloud`。
  - ⚠️ **不在 `ALT_TARGET` 表里的 target 会被静默兜底成 `local`（切本机）** —— 加一家时最容易漏的就是那一行。
- **出参**：`{ ok, steps[], msg }`，steps 为逐步进度（前端实时展示）。
- **副作用**：归档当前 Key、物化目标预设、可能启停本机模型/桥接、写 `config.json`。
- **幂等**：否（状态切换）；切到当前大脑 = 基本无操作。

---


---

## 19. POST `/api/onekey/start`

一键启动整套：Docker → 容器（优先 start，起不来再 compose up）→ 等协议端就绪 + 并行拉本机模型 → 起桥接。

- **出参**：`{ ok, steps[], msg }`。
- **副作用**：可能 `docker start/compose up`、重建挂载过期的容器、启动本机模型与桥接；**沙箱模式禁用**。
- **幂等**：否（启动流程）；已就绪的部分会跳过（如「容器已在运行」）。

---


---

## 20. POST `/api/onekey/stop`

一键结束：机器人 + 本机模型 + 容器 +（默认）Docker Desktop，回到启动前干净状态，内存一次性释放。

- **入参**：`{ quitDocker?: boolean }`（默认 `true`）。
- **出参**：`{ ok, steps[], msg }`。
- **副作用**：停容器（`-t 10` 优雅期）、kill 残留 pid、停模型、删 `effective.json`、清 docker 缓存；`quitDocker` 时后台退出 Docker Desktop。
- **幂等**：是（没在跑的部分直接跳过）。

---


---

## 21. GET `/api/balance`

查询智谱赠送资源包余额（进度条数据源）。

- **出参**：余额结构（带 60s 缓存；`?` 无 refresh 参数）。
- **副作用**：无（只读，缓存命中不联网）。
- **幂等**：是。

---


---

## 22. POST `/api/try`

「试一句」：不碰 QQ，走「配置 → 人格 → 模型 → 分段」整条链，返回完整提示词 + 模型原始输出 + 最终分段。

- **入参**：`{ text }`（≤500 字，必填）。
- **出参**：`{ ok, prompt, raw, chunks[], ms, error? }`；失败 400/500 并附原始输出。
- **副作用**：跑 `scripts/dryrun.js` 子进程（只读，不改 QQ / 不写记忆）。
- **幂等**：是。

---


---

## 23. POST `/api/trace/clear`

清空对话流记录（`local-trace.jsonl`）。

- **出参**：`{ ok, msg }`。
- **副作用**：删 `TRACE_FILE`。
- **幂等**：是（删了再删还是成功）。

---


---

## 24. POST `/api/custom/memory/clear`

清空自动记忆（机器人写入的那份）。**手动记忆不受影响。**

- **出参**：`{ ok, msg }` / `{ ok:false, error }`。
- **副作用**：清空自动记忆文件（与机器人的追加写可能极小概率丢「刚写入那一瞬」的新记录，安全可接受）。
- **幂等**：是。

---


---

## 25. POST `/api/custom/memory/delete`

删除一条自动记忆。

- **入参**：`{ id }`。
- **出参**：`{ ok, msg }` / `{ ok:false, error }`（500）。
- **副作用**：重写自动记忆文件（按 id 过滤）。
- **幂等**：否（删过的 id 再删 = 无变化，但属写操作）。

---


---

## 26. POST `/api/memory/review`

结构化记忆的**人工复核**（改状态 / 删一条）。判定在 `src/memory-record.js`（纯函数），
落盘在 `src/memory.js` 的 `reviewRecordById` —— 本路由只做三件事：读 body、调那一个函数、按结果回话。

- **入参**：`{ id, action }`。
- **出参**：成功 `{ ok, action, status, removed, msg }`；失败 `{ ok:false, error, reason }`。
  ⚠️ `reason === 'not-found'` → **404**（"这条不在了"是页面最常见的一种过期状态，另一个窗口刚删过），
  其余 → **400**（参数写错）。两者分开，前端才能给出不同的提示。
- **副作用**：改 `panel/memory-records.json`（直接决定"下一轮提示词里带不带这条"）。
- **幂等**：否。🟡 **写路由**。
- ⚠️ 沙箱**不拦**这条：`memory-records.json` 本来就被排除在沙箱之外，沙箱里改的是 /tmp 副本 ——
  这也是 `panel/next/verify.mjs` 能真的点一次按钮的前提。

---

## 27. POST `/api/custom/preview`

导入前预览：比「工作台那一块」的字段级差异（不落盘）。

- **入参**：`{ custom }` 或 `{ ...工作台字段 }`。
- **出参**：`{ ok, changes, lists[], conflicts[], untouched[] }`
  - `lists`：技能/手动记忆/定时消息的增删改（按 id 比对）
  - `conflicts`：导入内容与已有/自动记忆高度相似的「同一件事记两遍」提醒
  - `untouched`：本次导入**不会碰**的字段（让用户敢点确认）
- **副作用**：无（只读比对）。
- **幂等**：是。

---


---

## 28. POST `/api/extensions/install?overwrite=1&kind=plugin|skill`

扩展包 ZIP 导入（落目录到 `plugins/` 或 `skills/`）。

- **入参**：**原始字节**（不是 base64）；上限 `ZIP_UPLOAD_MAX`。查询串 `overwrite=1` 才允许覆盖已有包。
  `kind` 可选：带上时校验包与声明一致（`expectedKind`），且 Skill 包必须有 `index.js`
  （纯提示词 Skill 也一样，内容可为 `export {}`）。
- **出参**：成功 `{ ok, id, kind, dir, files, replaced }`；失败 `{ ok:false, error }`；
  **ZIP 过大 → 413**（与"上传中断"的 400 分开）。
- **副作用**：语义三步 —— 先在内存里**全部校验**（路径 / 符号链接 / 体积 / 清单 / 双清单 /
  kind 一致性）→ 备份 → 替换（失败回滚）；装完刷新一次扩展快照。
  ⚠️ **装完不自动启用**：目录里有 ≠ 会生效，勾选仍由用户在扩展列表上点，
  这里**一个字节都不写** `custom.extensions.plugins.enabled` / `custom.extensions.skills.enabled`。
- **幂等**：否（`overwrite=1` 时覆盖旧版）。🟡 **写路由**（会新建、可覆盖）。

---

## 29. GET `/api/custom/export`

导出工作台配置（下载）。

- **入参**：`?what=all|persona|prompt|rules|memory|skills|log|faces|diag|selected`、`?format=json|txt|zip`、`?mask=0`（保留群号，默认脱敏）。
  - `what=selected` 时用 `?scopes=config,persona,prompt,rules,memory,skills,log` 选范围；未知 id 返回 400。
  - `?dry=1` 只返回每个范围的真实字节数与文件清单，不生成附件。
- **响应**：`application/json | text/plain | application/zip`，`Content-Disposition: attachment`。
  - `zip`：零依赖手写 store 模式 + CRC32，多文件打包。
  - `selected`：只打包所选范围；`dry=1` 返回 `{ok, dry, scopes:[{id,label,bytes,files}], totalBytes, mask}`。
  - `diag`：强制 ZIP；固定清单（壳/面板/机器人/更新/回滚日志 + 崩溃事件 + 版本指针），
    不扫目录，故 `config.json`、`.token`、`bridge.log`（聊天正文）、`napcat/` 不会进包；
    逐行 `maskSecrets` + QQ/群号/用户名脱敏，残余凭据 fail-closed 替换。
- **副作用**：无（只读，默认脱敏群号）。
- **幂等**：是。

---


---

## 30. GET `/api/zhipu/packages`

智谱赠送资源包余额（同 `/api/balance` 数据源，带 60s 缓存）。

- **入参**：`?refresh=1` 跳过缓存强制刷新。
- **出参**：资源包结构。
- **幂等**：是。

---


---

## 31. GET `/api/models`

按服务商取可用模型列表（避免填到已下线的名字）。

- **入参**：`?provider=local|deepseek|zhipu|qwen`（缺省取当前配置服务商）。
- **出参**：`{ ok, provider, models[], builtin[], source: 'local'|'builtin'|'both' }`
  - `local`：直接给本机已装规格（不走网络）
  - 云端：优先用该预设自己的 baseUrl/Key 去问官方 `/models`，内置名单在前（免费档不在接口返回值里）
- **副作用**：可能发一次外部 `fetch`（超时 8s，失败回落 `builtin`）。
- **幂等**：是（只读；云端调用有网络副作用但无状态变更）。

---


---

## 32. POST `/api/usage/reset`

清零用量统计（**所有账本文件**：`usage.jsonl` + `usage-YYYY-MM.jsonl`）。

- **出参**：`{ ok, msg }`，msg 里会带上删了几个文件。
- **副作用**：逐个删掉 `panel/` 下所有 `usage*.jsonl` 并清缓存。
  账本自第 35 轮起**按月切分**，所以"清零"必须清全部 —— 只删当月那份的话，
  往月的数字还在，按下去看着没反应。
- **幂等**：是（没有账本时返回"本来就没有账本"）。

---


---

## 33. POST `/api/debug`

开关详细日志（写 `.debug` 标志），若桥接在跑则重启让它生效。

- **入参**：`{ on: boolean }`。
- **出参**：`{ ok, msg }`。
- **副作用**：写 debug 标志、可能 stop+start 桥接。
- **幂等**：否（状态切换）；设成当前值 = 无变化。

---


---

## 34. POST `/api/stop-all`

全停：机器人 + 本机模型 + QQ 容器（Docker Desktop 仍留着）。比「一键结束」轻量，不停 Docker。

- **出参**：`{ ok, msg }`。
- **副作用**：停容器、桥接、两条本机通道；清 docker 缓存。
- **幂等**：是（没在跑的跳过）。

---


---

## 35. POST `/api/napcat/restart`

重启 NapCat 容器。挂载指向旧项目路径时**先重建再重启**（否则只是把「配置/登录态丢失」重演一遍）。

- **出参**：`{ ok, output }`（失败 400）。
- **副作用**：`ensureDocker` → 必要时 `recreateNapcatContainer` → `docker restart napcat`；清 docker 缓存。
- **幂等**：否（重启动作）；容器已是最新状态则只是 restart。

---


---

## 36. GET `/api/qrcode`

实时取容器内登录二维码（PNG，避免给过期的静态图）。

- **响应**：`image/png`，`no-store`；取不到则 404 `text/plain`。
- **副作用**：`docker exec napcat cat .../qrcode.png`（只读）。
- **幂等**：是。

---


---

## 37. POST `/api/qrcode/refresh`

换一张新二维码（旧的多半已过期，扫了只会「登录失败」）。

- **出参**：`{ ok, msg }`（失败 400）。
- **副作用**：刷新容器内二维码。
- **幂等**：否（生成新码）；重复刷新 = 多张新码。

---


---

## 38. POST `/api/logs/clear`

清空面板日志环形缓冲。

- **出参**：`{ ok:true }`。
- **副作用**：`state.logs=[]` **且 `logDropped=0`**（两者必须同步归零，否则 `total` 从旧数字继续涨、与前端归零游标对不上）。
- **幂等**：是（清空再清空仍成功）。

---


---

## 39. POST `/api/panel/restart`

一键重启面板（`.app` 每次打开也会调它，**必须幂等**：代码没变就回「已是最新」，绝不无谓重启）。

- **出参**：`{ ok, msg, restarted? }`（失败 400）。
- **副作用**：detached shell 看门狗「等旧 pid 死 → exec 新进程」；前端用 **pid 变了** 判定「换好了」（而非「接口能通」）。
- **幂等**：是（看门狗保证；顺序反了会 EADDRINUSE 把面板搞没）。


---

## 40. POST `/api/panel/window`

窗口几何上报（2026-10-16）：独立窗口里的页面在 resize / 移动 / 关闭前把
`{x, y, w, h}`（screenX / screenY / outerWidth / outerHeight）POST 回来，
写进 `panel/window-state.json`（与 `config.json` 同辈）—— 下次启动由启动器
`--window-size` / `--window-position` 还原：窗口回到上次的位置与尺寸（两端一致）。

- **入参**：`{x, y, w, h}` 都是数字；`w`/`h` 取整后必须落在 `400×300 … 10000×10000`，位置限 ±20000
  （多显示器在主屏左侧时坐标为负 —— 合法）。值域判据唯一一份在 `src/launch-mode.js` 的 `normalizeWinState`（写侧 / 读侧共用）。
- **出参**：`{ ok:true }`；几何不合法 **400**；写盘失败 **500**（本次开窗不受影响 —— 只是"没记住"）。
- **副作用**：写 `panel/window-state.json`。
- **幂等**：是（同值重复上报 = 覆盖同样的内容）。
- **谁在发**：只有独立窗口的页面（URL 带启动器加的 `__win=1` 标记时才上报）—— 标签页不上报。

---

## 41. 补充路由契约（2026-10-22）

> 70 条 API 中，46 条已在 §1–§40 有独立字段章节；剩下的 **24 条**在本节补字段级契约
> （其中 19 条此前连独立小节都没有，另外 5 条此前只在表格/导语里出现过）。
> 2026-10-28 的 7 条新路由放在 §42–§48（都有独立编号章节，不占这 24 条字段契约）。
> 写路由仍统一走 token + 审计（`WRITE_ROUTES`）；业务失败通常是 **HTTP 200 + `ok:false`**，
> 只有参数/传输/鉴权失败才用 4xx/5xx。

### 41.1 路由总表（机器可核对）

> 这一段由 `check-wb` §135 与 `panel/server.js` 的 `API_ROUTES` 双向核对；加删路由必须
> 同时改总表、`WRITE_ROUTES`（若是 POST）和 §135 的精确计数。

<!-- api-inventory:begin -->
| 方法 | 路径 |
|---|---|
| GET | `/api/health` |
| GET | `/api/update/state` |
| POST | `/api/update/check` |
| POST | `/api/update/download` |
| POST | `/api/update/install` |
| POST | `/api/update/cancel` |
| POST | `/api/update/offline/prepare` |
| POST | `/api/update/offline/installer` |
| GET | `/api/state` |
| GET | `/api/audit` |
| GET | `/api/logs` |
| GET | `/api/sessions` |
| GET | `/api/sessions/detail` |
| GET | `/api/chats` |
| GET | `/api/chats/detail` |
| POST | `/api/config/undo` |
| POST | `/api/config` |
| GET | `/api/groups` |
| POST | `/api/bridge/start` |
| POST | `/api/bridge/stop` |
| POST | `/api/bridge/command` |
| POST | `/api/check` |
| POST | `/api/local-model/start` |
| POST | `/api/local-model/stop` |
| POST | `/api/switch` |
| GET | `/api/provider-info` |
| POST | `/api/custom-brain/save` |
| POST | `/api/custom-brain/rename` |
| POST | `/api/custom-brain/delete` |
| POST | `/api/onekey/start` |
| POST | `/api/onekey/stop` |
| GET | `/api/balance` |
| POST | `/api/try` |
| POST | `/api/trace/clear` |
| POST | `/api/custom/memory/clear` |
| POST | `/api/custom/memory/delete` |
| POST | `/api/memory/search` |
| POST | `/api/memory/review` |
| POST | `/api/custom/preview` |
| POST | `/api/extensions/install` |
| GET | `/api/custom/export` |
| GET | `/api/zhipu/packages` |
| GET | `/api/models` |
| POST | `/api/usage/reset` |
| POST | `/api/debug` |
| POST | `/api/stop-all` |
| POST | `/api/protocol/start` |
| POST | `/api/napcat/restart` |
| POST | `/api/napcat/import-auto` |
| POST | `/api/napcat/open-folder` |
| GET | `/api/qrcode` |
| POST | `/api/qrcode/refresh` |
| POST | `/api/logs/clear` |
| POST | `/api/panel/restart` |
| GET | `/api/console/stream` |
| GET | `/api/console/tail` |
| POST | `/api/panel/quit` |
| POST | `/api/panel/window` |
| POST | `/api/persona/adopt` |
| GET | `/api/fake-qq/state` |
| POST | `/api/fake-qq/start` |
| POST | `/api/fake-qq/send` |
| POST | `/api/fake-qq/stop` |
| GET | `/api/github/star` |
| GET | `/api/backgrounds` |
| GET | `/api/backgrounds/media` |
| POST | `/api/backgrounds` |
| POST | `/api/backgrounds/active` |
| POST | `/api/backgrounds/delete` |
| POST | `/api/extensions/package` |
<!-- api-inventory:end -->

---

> 2026-10-28 新增的 §42–§48 放在 §41.2 之前：§135 的字段契约体是「最后一个 api-fields 标记到文档末尾」，
> 新章节若放在 41.2 之后会把 persona/adopt 的四行计数污染成 8。

## 42. GET `/api/github/star`

设置 → 关于 → 星标胶囊的实时星数。浏览器不直连 GitHub（CSP `connect-src 'self'`），由面板同源代理。

- **入参**：无。
- **出参**：`{ok:true, count:number, cached:boolean, fetchedAt:number}`；上游不可用 **502** `{ok:false, reason:'upstream_unavailable'}`（不在 200 里伪装成功）。
- **副作用**：服务端 GET `api.github.com/repos/<owner>/<repo>`（固定 URL、4 秒超时、64 KB 上限、带 User-Agent），成功时写 `PANEL_STATE_DIR/github-star.json` 缓存 5 分钟。
- **幂等**：是（读接口；缓存命中时不发上游请求）。

---

## 43. GET `/api/backgrounds`

自定义背景列表与当前启用项。

- **入参**：无。
- **出参**：`{ok:true, activeId:string|null, limits:{image,video,display,items,totalBytes}, items:[{id,type,name,format,bytes,createdAt,crop,url,displayUrl}]}`。
- **副作用**：读 `DATA_DIR/backgrounds/index.json`；不写盘。
- **幂等**：是。

---

## 44. GET `/api/backgrounds/media?id=…&v=original|display&rev=…`

自定义背景媒体（图片/视频）的同源读取口。

- **入参**：query `id`（服务端生成）、`v=original|display`（缺省 original）、`rev`（仅用于缓存 bust，不参与查找）。
- **出参**：二进制；`Content-Type` 按格式白名单；支持单段 `Range`（206 + `Content-Range`），乱码/越界 416；不存在 404。
- **副作用**：无；响应带 `Accept-Ranges`、`X-Content-Type-Options: nosniff`、`Cache-Control: private, max-age=31536000, immutable`。
- **幂等**：是。

---

## 45. POST `/api/backgrounds?slot=original|display`

上传背景原文件或 16:9 裁切图（raw body，不是 JSON/base64）。

- **入参**：`slot=original` 时 query `name`、可选 `sourceKey`（迁移幂等键）；`slot=display` 时 query `id`、`zoom`、`x`、`y`（裁切参数）。原文件只认魔数：JPG/PNG/WEBP/GIF/AVIF/BMP 与 MP4/WEBM。
- **出参**：`{ok:true, item, deduped?}`；超过 8/24 MB 或 2 MB（display）→ 413；不支持的格式 → 415；索引损坏 → 500。
- **副作用**：原图/视频写入 `DATA_DIR/backgrounds/<id>.<ext>`；裁切图写 `<id>.display.jpg`；更新 `index.json`（原子写 + 进程内串行）。写索引失败会删媒体回滚。
- **幂等**：original 带相同 `sourceKey` 时复用已有条目；display 重复上传为覆盖（rev 更新）。

---

## 46. POST `/api/backgrounds/active`

启用 / 停用自定义背景。

- **入参**：`{id:string|null}`。
- **出参**：`{ok:true, activeId:string|null}`；id 不存在 404。
- **副作用**：写 `index.json.activeId`。
- **幂等**：是（同值重复写 = 覆盖同样内容）。

---

## 47. POST `/api/backgrounds/delete`

删除一条自定义背景（含原文件与裁切图）。

- **入参**：`{id:string}`。
- **出参**：`{ok:true, activeId:string|null}`；删除的是当前启用项时 `activeId` 清空。
- **副作用**：先改索引，再 best-effort 删除媒体文件（Windows 被占用时可能留文件，不影响列表）。
- **幂等**：否；重复删除同一 id 返回 404。

---

## 48. POST `/api/extensions/package`

插件工厂的模板创建 / 文件夹打包：只构建 ZIP 字节，**不落盘**；安装仍走 §28 的唯一安装接口。

- **入参**：`{mode:'create'|'folder', meta?, kind?, root?, files?}`；`create` 的 `meta` 含 `{kind,id,name,description?,category?,toolName?,toolDescription?,prompt?}`；`folder` 的 `files` 是 `[{path,contentBase64}]`。
- **出参**：`{ok:true, kind, root, files:[{path,bytes,text?}], zipBytes, zipBase64}`；路径/体积/清单不合法 400，超过 6 MB 请求或 3 MB 内容 413。
- **副作用**：无（内存中调 `makeZip`；校验复用 `isSafeRelPath` / `normalizeManifest`）。
- **幂等**：是（同样的输入产出同样的 ZIP；不写任何状态）。

### 41.2 字段契约（24 条）

#### 41.2.1 GET `/api/health`

<!-- api-fields: GET /api/health -->
- **入参**：无。
- **出参**：`{ok, appId, version, pid, uptimeSec}` —— 只有身份与存活信息，不含路径/token/Key/群号。
- **副作用**：无；不读配置、不依赖机器人，配置坏了也能答。
- **幂等**：是；正在退出时回 **503** 且 `ok:false`。

#### 41.2.2 GET `/api/update/state`

<!-- api-fields: GET /api/update/state -->
- **入参**：无。
- **出参**：`{ok, enabled, testMode, phase, reason, currentVersion, latest|null, progress|null, error, checkedAt, downloadedAt, offline|null, source}`。
- **副作用**：只读状态机快照，不联网、不落盘。
- **幂等**：是。

#### 41.2.3 POST `/api/update/check`

<!-- api-fields: POST /api/update/check -->
- **入参**：无强制字段。
- **出参**：`{ok, ...snapshot}`；检查失败时 `phase:'error'`、`error` 可读，HTTP 仍 200。
- **副作用**：联网拉取签名清单并验签；更新 `checkedAt`，失败原因写入状态机。
- **幂等**：是；检查已在进行中时直接回当前快照。

#### 41.2.4 POST `/api/update/download`

<!-- api-fields: POST /api/update/download -->
- **入参**：无。
- **出参**：`{ok, ...snapshot}`；进度经 SSE 的 `update` 帧推送。
- **副作用**：下载 EXE 到更新缓存；受 `ready`/下载中状态保护。
- **幂等**：否；已有下载/待安装时只回快照，不重复启动。

#### 41.2.5 POST `/api/update/install`

<!-- api-fields: POST /api/update/install -->
- **入参**：`{silent?:boolean}` —— 只有显式 `true` 才静默安装。
- **出参**：`{ok, ...snapshot}`；业务失败仍 200 + `ok:false`。
- **副作用**：从 `ready` 显式启动安装器；安装前停应用，安装后由启动器接管（见 §109/§110）。
- **幂等**：否；这是两次点击契约里的第二次。

#### 41.2.6 POST `/api/update/cancel`

<!-- api-fields: POST /api/update/cancel -->
- **入参**：无。
- **出参**：`{ok, ...snapshot}`。
- **副作用**：中止下载并清进度，回到可重试状态。
- **幂等**：是。

#### 41.2.7 POST `/api/update/offline/prepare`

<!-- api-fields: POST /api/update/offline/prepare -->
- **入参**：`{manifestBase64, sigBase64}` —— 都是 base64 **文本**；`.sig` 文件内容不要再二次 base64。
- **出参**：`{ok, ...snapshot}`；验签/校验失败 200 + `ok:false`。
- **副作用**：按原始字节验签、校验清单，把 `latest.json` + `.sig` 暂存到 pending；**不联网**。
- **幂等**：否；重复提交会覆盖 pending（同值结果一致，但本身是写操作）。

#### 41.2.8 POST `/api/update/offline/installer`

<!-- api-fields: POST /api/update/offline/installer -->
- **入参**：请求体是**原始 EXE 字节**（不是 JSON）；上限 256 MiB（Electron 载荷约 150 MiB，P1-7 实测后校准）。
- **出参**：`{ok, ...snapshot}`；过大 413、上传中断/为空 400。
- **副作用**：校 size + SHA-256，通过后移入 cache，`phase` 置 `ready`。
- **幂等**：否；每次上传都会覆盖待安装包。

#### 41.2.9 GET `/api/console/stream`

<!-- api-fields: GET /api/console/stream -->
- **入参**：无。
- **出参**：SSE 长连接 —— `hello` 帧 `{lines,total}`、`update` 帧（更新快照）、每 3 秒 `state` 帧 `{t,bridge,proto,pid}`。
- **副作用**：保持连接与心跳定时器；连接关闭时清定时器、移出客户端集合。
- **幂等**：是；每次连接各自拿一份快照。

#### 41.2.10 GET `/api/console/tail`

<!-- api-fields: GET /api/console/tail -->
- **入参**：query `src=napcat|panel`（缺省 `napcat`）；`lines=1..500`（缺省 200）。
- **出参**：`{src, file, lines, missing, hint}`；`file` 是相对 `USER_ROOT` 的路径。
- **副作用**：只读文件尾部（最多回看 256 KiB），不整份读入内存。
- **幂等**：是。

#### 41.2.11 POST `/api/panel/quit`

<!-- api-fields: POST /api/panel/quit -->
- **入参**：无。
- **出参**：`{ok:true, msg}` —— 先回响应，约 400ms 后退出面板。
- **副作用**：只退出控制台，**不动机器人**。
- **幂等**：是；重复点只是再触发一次退出。

#### 41.2.12 GET `/api/provider-info`

<!-- api-fields: GET /api/provider-info -->
- **入参**：query `baseUrl`（必填）。
- **出参**：`{ok, provider, known, vendor, officialBaseUrl, official, chain, quota|null}`；`chain` 含主模型，前端按当前模型名剔除。
- **副作用**：无；纯读，不落盘、不碰进程。
- **幂等**：是；坏地址 400 + `reason:'bad-url'`。

#### 41.2.13 POST `/api/custom-brain/save`

<!-- api-fields: POST /api/custom-brain/save -->
- **入参**：`{id?, name?, baseUrl, model, apiKey?, fallbackModels?, features?, maxTokens?, temperature?}`；编辑时地址留空 = 不改，新增时 `baseUrl`/`model` 必填。
- **出参**：`{ok, id, name, switched, applied, msg}`；400 可带 `reason:'bad-base-url'|'model-provider-mismatch'`。
- **副作用**：写 `config.json`；新增或编辑当前套时切换并等待热重载；降级链只保留属于该服务商的模型。
- **幂等**：否；会写入/切换。

#### 41.2.14 POST `/api/custom-brain/rename`

<!-- api-fields: POST /api/custom-brain/rename -->
- **入参**：`{id, name}`；`name` 必填。
- **出参**：`{ok, id, name, msg}`；找不到 404，空名 400。
- **副作用**：只改名字并写 `config.json`，其它字段不动。
- **幂等**：是；同值重复结果一致（仍是写操作）。

#### 41.2.15 POST `/api/custom-brain/delete`

<!-- api-fields: POST /api/custom-brain/delete -->
- **入参**：`{id}`。
- **出参**：`{ok, id, fellBack, applied, msg}`；找不到 404。
- **副作用**：删除该套；若正在使用则切回智谱并等待热重载。
- **幂等**：否；第二次调用会因找不到而 404。

#### 41.2.16 POST `/api/memory/search`

<!-- api-fields: POST /api/memory/search -->
- **入参**：`{query, chatKey?}`；`query` 必填。
- **出参**：`{ok, lines, hits, scanned, reason?}`；与机器人“你还记得吗”共用同一份检索判据。
- **副作用**：无；只读，不加 samples、不落盘。
- **幂等**：是；空 query 400。

#### 41.2.17 POST `/api/protocol/start`

<!-- api-fields: POST /api/protocol/start -->
- **入参**：无。
- **出参**：`{ok, msg}`；拉起失败 500，`msg` 可读。
- **副作用**：强制跑一次协议端守护步骤（与定时守护共用 `runStep`）；`force` 只越过“从没起来/冷却/超限”，不越“账号掉线/协议端仍活着”。
- **幂等**：否；重复调用可能再次尝试拉起或等待冷却。

#### 41.2.18 POST `/api/napcat/import-auto`

<!-- api-fields: POST /api/napcat/import-auto -->
- **入参**：无；仅 Windows 安装版可用。
- **出参**：导入脚本的 JSON（`{ok, action, from?, status?, error?}`）；非 Windows 400。
- **副作用**：扫描下载/桌面/文档并复制 NapCat 到 `userdata/napcat`；可能继续下载。
- **幂等**：是；已装好时回 `already`，不重复导入。

#### 41.2.19 POST `/api/napcat/open-folder`

<!-- api-fields: POST /api/napcat/open-folder -->
- **入参**：无；仅 Windows 安装版可用。
- **出参**：`{ok, dir}`；失败 500，非 Windows 400。
- **副作用**：创建协议端目录并拉起 `explorer.exe`。
- **幂等**：是。

#### 41.2.20 GET `/api/fake-qq/state`

<!-- api-fields: GET /api/fake-qq/state -->
- **入参**：query `since`（上次看到的行号，缺省 0）。
- **出参**：`{running, pid, startedAt, opts, seq, lines, exited, script}`；`lines` 只回 `n > since` 的新行。
- **副作用**：无。
- **幂等**：是。

#### 41.2.21 POST `/api/fake-qq/start`

<!-- api-fields: POST /api/fake-qq/start -->
- **入参**：`{offline?:boolean, sandbox?:boolean}`。
- **出参**：`{ok, msg, pid?}`；真机器人在跑且未勾 `sandbox` 时 `ok:false`。
- **副作用**：spawn `scripts/fake-qq.mjs`，stdin/stdout 作为会话输入/回显。
- **幂等**：否；已有会话在跑时拒绝再起。

#### 41.2.22 POST `/api/fake-qq/send`

<!-- api-fields: POST /api/fake-qq/send -->
- **入参**：`{text}`；换行会被拍平，上限 2000 字。
- **出参**：`{ok, msg}`。
- **副作用**：向假 QQ 子进程 stdin 写一行（斜杠命令也走这里）。
- **幂等**：否；每次都是一句新输入。

#### 41.2.23 POST `/api/fake-qq/stop`

<!-- api-fields: POST /api/fake-qq/stop -->
- **入参**：无。
- **出参**：`{ok, msg}`；本来没在跑也回 `ok:true`。
- **副作用**：关 stdin + SIGTERM，4 秒后补 SIGKILL。
- **幂等**：是。

#### 41.2.24 POST `/api/persona/adopt`

<!-- api-fields: POST /api/persona/adopt -->
- **入参**：`{name?, text, fields?}`；`text` 至少 20 字、截 12000；`name` 截 40。
- **出参**：认领脚本 JSON（`{ok, fields, wrote[]}`，或 `{ok:false, error, detail?}`）；失败 500。
- **副作用**：花一次模型调用；**不直接改配置**，结果只回预览，写回仍走 `/api/config`。
- **幂等**：否；每次都会重新调用模型。

---
