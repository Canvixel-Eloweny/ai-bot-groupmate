# QQ-BOT-Creative · API 契约文档

> 来源：`panel/server.js` 的 `http.createServer` 手写分发器（无第三方框架）。**它是唯一真相源** ——
> 本文只是它的说明；两者不一致时以代码为准，并**当场把本文改回来**（2026-10-01 清理轮实测：
> 本文停在"29 个 API"，而代码里已经有 39 条 —— 文档烂掉之后比没有文档更糟，因为它会被信）。
> 所有接口走 HTTP/1.1，面板地址默认 `http://127.0.0.1:8788`，**只监听 127.0.0.1**（本机）。
> 响应统一为 JSON（`sendJson`），二进制接口单独标注。错误统一返回 `{ error }` 或 `{ ok:false, ... }`。
> 路由总数：**2 个页面（`/` 与 `/next/`）+ 38 个 API**。
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
- **消费者**：`QQ-BOT-CONTROL.app` 的 `launcher.sh` **开根地址**（`http://127.0.0.1:8788/`）。
  自检：`node panel/next/verify.mjs`（默认就验根地址，并单独断言这条 302）。

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
  - `emotion` / `people` / `gallery` / `apiDeals`（2026-10-02 新增）—— **插件写的数据**，
    由 `panel/lib/bot-data.js` **直接读盘**后白名单投影：`data/bot-state.json`（本体情绪）·
    `data/memory/people/*.json`（群友印象）· `data/images-lib/index.json`（自定义图库，只报张数）·
    `data/api-deals.json`（AI 额度情报）。四者都**不做机器人转发**（"机器人没在跑"正是用户最想
    看这些数据的时候），都**读不到不抛**，且 `ok:false` 时带一个人能看懂的 `reason` ——
    所以前端**不许把 `ok:false` 画成红色故障**（"那个包还没被用到过"是正常状态）。
  - `zhipuPackages`（带 60s 缓存）、`models`（本机已装规格）
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

保存全部配置（含三套大脑预设物化、工作台局部合并、降级链校验、能力收敛）。

- **入参**（全部可选，缺省忽略）：
  - `baseUrl` / `apiKey` / `model` / `fallbackModels[]` / `thinking`（`{mode,level}` 或 `"auto"|"on"|"off"`）/ `maxTokens`
  - `localChannel`（`mlx`|`qwenchat`，只在本机大脑有意义）
  - `context.recentTurns` / `context.ambientMessages`
  - `features.{webSearch,vision,stickers}`（第三道闸，落盘前按模型能力收敛）
  - `groups[]` / `denyGroups[]` / `denyUsers[]` / `requireAtInGroup` / `interjectChance` / `aliases[]` / `personaName`
  - `custom` —— 工作台那一块（走 `patchCustom` 局部合并）
- **出参**：`{ ok, bridgeRunning, applied, autoDisabled[], autoDisabledMsg, msg }`
  - `applied`：机器人是否已真正读入新配置（热重载约 1s 延迟，会 `await` 后再返回）
  - `autoDisabledMsg`：换到不支持的模型时**如实告知**被自动关掉的能力（如「已自动关闭 识图」）
- **校验失败返回 400**：跨服务商模型、降级链含「始终思考」模型、链超长（`MAX_CHAIN_LEN`）。
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

一键切换三套大脑（local / cloud=DeepSeek / zhipu），连带把该开的开了、该关的关了，等到真可用才返回。

- **入参**：`{ target: 'local'|'cloud'|'zhipu', size?, channel? }`
  - ⚠️ 命名两套：`target` 用 `cloud`（非 `deepseek`）；预设键才是 `deepseek`。`deepseek` 会被映射成 `cloud`。
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
  这也是 `verify-panel` 能真的点一次按钮的前提。

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

## 28. POST `/api/extensions/install?overwrite=1`

插件 ZIP 导入（落目录到 `plugins/` 或 `skills/`）。

- **入参**：**原始字节**（不是 base64）；上限 `ZIP_UPLOAD_MAX`。查询串 `overwrite=1` 才允许覆盖已有包。
- **出参**：成功 `{ ok, id, kind, dir, files, replaced }`；失败 `{ ok:false, error }`；
  **ZIP 过大 → 413**（与"上传中断"的 400 分开）。
- **副作用**：语义三步 —— 先在内存里**全部校验**（路径 / 符号链接 / 体积 / 清单）→ 备份 → 替换（失败回滚）；
  装完刷新一次扩展快照。⚠️ **装完不自动启用**：目录里有 ≠ 会生效，勾选仍由用户在扩展列表上点，
  这里**一个字节都不写** `custom.plugins.enabled`。
- **幂等**：否（`overwrite=1` 时覆盖旧版）。🟡 **写路由**（会新建、可覆盖）。

---

## 29. GET `/api/custom/export`

导出工作台配置（下载）。

- **入参**：`?what=all|persona|prompt|rules|memory|skills|log|faces`、`?format=json|txt|zip`、`?mask=0`（保留群号，默认脱敏）。
- **响应**：`application/json | text/plain | application/zip`，`Content-Disposition: attachment`。
  - `zip`：零依赖手写 store 模式 + CRC32，多文件打包。
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

- **入参**：`?provider=local|deepseek|zhipu`（缺省取当前配置服务商）。
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
