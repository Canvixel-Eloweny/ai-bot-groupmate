# P0 路径审计 —— 程序根与用户数据根分离

> 基线：2026-10-17T15:46:15Z · commit `1caecb8` · 工作树干净
> 验证：`check-wb` 109/109（exit 0）· `publish-audit` exit 0 · `docs/` 顶层 15 份
> 性质：**只读取证**，本文件不改任何代码。行号以该 commit 为准，后续改动可能漂移。
>
> 目标：为 P1 的 `USER_ROOT` 改造提供逐项清单。每一行都要回答三件事：
> 现在写到哪里、这属于谁、升级时怎么处理。

## 0. 方法与归属分类

### 0.1 基线命令

```bash
git rev-parse --short HEAD                 # 1caecb8
git status --porcelain                     # 空
NODE_OPTIONS= node scripts/check-wb.mjs    # 109/109，exit 0
node scripts/publish-audit.mjs             # exit 0（38 条待确认）
git -c core.quotePath=false ls-files docs | grep -v '^docs/archive/' | wc -l   # 15
```

### 0.2 归属分类

| 代号 | 含义 | 升级/卸载时的规则 |
|---|---|---|
| **P** | 程序文件（版本目录内） | 可随版本替换；卸载删除 |
| **U** | 用户数据（`USER_ROOT`） | 升级不动；卸载默认保留 |
| **C** | 缓存/派生/日志 | 可重建；升级可清理，但失败时保留用于排查 |
| **B** | 构建期文件（只在构建机/仓库） | 不进安装包 |

### 0.3 当前根模型

- 开发：`ROOT` = 仓库根（`package.json`、`panel/`、`src/` 所在处）。
- 便携包：`ROOT` = `<包根>/app`；`<包根>` 下还有 `tools/`、`runtime/`、`launcher/`。
- 目标安装版：程序根 = `<InstallRoot>/versions/<ver>/app`；用户数据根 = 独立目录。
- 现状：**程序根同时是数据根**，这是本次改造要拆掉的东西。

---

## 1. 程序根推导（11 处 + 打包侧）

`ROOT` 目前由各模块按自身文件层级自行推导。多数写法相同，但没有单一出口；搬动任何一个模块，
或把程序放进 `versions/<ver>/app`，都可能静默算错。

| # | 位置 | 表达式/符号 | 运行时指向 | 读写 | 目标归属 |
|---|---|---|---|---|---|
| 1 | `panel/lib/paths.js:34` | `ROOT = resolve(dirname(paths.js),'..','..')` | 程序根 | 读 | P |
| 2 | `src/config.js:28` | `ROOT` | 程序根 | 读 | P |
| 3 | `src/index.js:150` | `ROOT` | 程序根 | 读 | P |
| 4 | `src/bridge-io.js:35` | `ROOT` | 程序根 | 读 | P |
| 5 | `src/usage.js:8` | `ROOT` | 程序根 | 读 | P |
| 6 | `src/memory.js:48` | `ROOT` | 程序根 | 读 | P |
| 7 | `src/memory-store.js:28` | `ROOT` | 程序根 | 读 | P |
| 8 | `src/trace-stats.js:46` | `ROOT` | 程序根 | 读 | P |
| 9 | `src/style-profile.js:22` | `ROOT` | 程序根 | 读 | P |
| 10 | `src/forward-probe.js:5` | `ROOT` | 程序根 | 读 | P |
| 11 | `panel/lib/paths.js:38` | `package.json` 自检 | 程序根必须有 `package.json` | 读 | P（安装器必须保留这个标记） |
| 12 | `packaging/windows/tools/lib/common.mjs:22-23` | `ROOT` / `APP` | 包根 / `<包根>/app` | 构建/运行 | B/P |
| 13 | `scripts/win-launcher.mjs:32-34` | `ROOT = argv[2] 或脚本父目录` | 开发树根 | 运行 | B |
| 14 | `scripts/launch-mode.mjs:28,51` | `ROOT` / `configPath` | 开发树根 / 配置路径 | 运行 | B |

结论：P1 必须把这 11 处（第 1–10 项以及第 11 项的自检语义）收敛到一个
`src/user-root.js`；`panel/lib/paths.js` 是 L0，允许 import 该叶子，但必须登记进
`LIB_SRC_ALLOW` 并通过 §82 的传递闭包判据。打包侧 `common.mjs` 的 `APP` 是构建期概念，
不进运行时根解析。

---

## 2. 运行期写盘清单

### 2.1 配置、凭据、身份

| 当前路径 | 写入者 | 读取者 | 处置 | 归属 |
|---|---|---|---|---|
| `<ROOT>/config.json` | `panel/lib/config-io.js:39,95`；`src/index.js:151` | 面板与机器人 | **复制**（核心数据） | U |
| `<ROOT>/panel/.token` | `panel/server.js:485-496` | 面板鉴权 | **重新生成**，不复制旧 token | U/C |
| `<ROOT>/panel/config-history.jsonl` | `src/config-history.js:44-52` | 面板回滚 | **复制**（含明文 Key，按敏感文件处理） | U |
| `<ROOT>/.env` | 人工/开发 | Docker Compose、检查脚本 | 存在则复制 | U |
| `<ROOT>/napcat/config/webui.json` | NapCat | `panel/lib/napcat-native.js:42,108-119` | **复制** | U |
| `<ROOT>/napcat/.webui_token` | NapCat/面板回退 | `panel/server.js:655` | **复制**（敏感） | U |
| `<ROOT>/napcat/config/napcat_<QQ>.json` | NapCat | `common.mjs:481-523` | **复制**（登录证据） | U |
| `<ROOT>/napcat/config/napcat_protocol_<QQ>.json` | NapCat | `common.mjs:481-523` | **复制** | U |
| `<ROOT>/napcat/QQ/` | NapCat | NapCat / `docker-compose.yml:68-69` | **复制**（登录态，绝不可丢） | U |

### 2.2 面板与机器人运行态

| 当前路径 | 写入者 | 读取者 | 处置 | 归属 |
|---|---|---|---|---|
| `<ROOT>/panel/effective.json` | `src/index.js:306` | 面板 | 可重建；复制可选 | C |
| `<ROOT>/panel/.thinking.json` | `src/bridge-io.js:37-38` | 面板 | 可重建 | C |
| `<ROOT>/panel/audit.jsonl` | `panel/lib/audit-log.js:41-46` | 面板 | 复制 | U |
| `<ROOT>/panel/local-trace.jsonl` | `src/bridge-io.js:44-46` | 面板 | 复制 | U |
| `<ROOT>/panel/session-archive.json` | `src/session-archive.js:152` | 面板 | **复制**（真实聊天内容） | U |
| `<ROOT>/panel/usage-*.jsonl` | `src/usage.js:22-23,60-61` | 面板 | 复制 | U |
| `<ROOT>/panel/.bridge.pid` | `panel/server.js:1256,1434` | 面板 | **绝不复制**（旧 PID 会误接管） | C |
| `<ROOT>/panel/.bridge.lock` | `panel/lib/paths.js:158-160`；`src/index.js:462` | 机器人 | **绝不复制**（旧锁会阻止启动） | C |
| `<ROOT>/panel/.bridge-cmd.json` | `panel/lib/control.js:98` | 机器人 | **绝不复制**（陈旧命令） | C |
| `<ROOT>/panel/bridge.log` | `panel/server.js:1384` | 面板/诊断 | 可重建；失败注入时保留 | C |
| `<ROOT>/panel/local-model.log` | `panel/lib/paths.js:173` | 面板/诊断 | 可重建 | C |
| `<ROOT>/panel/panel.log` | `panel/lib/paths.js:174`；`console.mjs:29` | 诊断 | 可重建 | C |
| `<ROOT>/panel/.debug` | `panel/server.js:999-1000` | 面板 | 可复制（用户偏好） | C |
| `<ROOT>/panel/model-sync.json` | `panel/lib/model-sync-state.js:19,39` | 面板 | 可重建；复制可选 | C |
| `<ROOT>/panel/launch-log.jsonl` | `src/launch-mode.js:151,167` | 启动器/面板 | 可复制 | C |
| `<ROOT>/panel/window-state.json` | `src/launch-mode.js:239-240`；`panel/server.js:3377` | 启动器 | 复制 | U/C |
| `<ROOT>/panel/prompt-stats.json` | `src/trace-stats.js:92-93,214` | 面板 | 复制 | U |
| `<ROOT>/panel/style-profile.json` | `src/style-profile.js:29-31,185` | 机器人/面板 | 复制 | U |
| `<ROOT>/panel/forward-probe.jsonl` | `src/forward-probe.js:9-11,46,61` | 面板 | 复制 | U |
| `<ROOT>/panel/auto-memory.jsonl` | `src/memory-store.js:46-51` | 机器人/面板 | 复制 | U |
| `<ROOT>/panel/memory-records.json` | `src/memory.js:100,159-161,182` | 机器人/面板 | 复制 | U |
| `<ROOT>/panel/bridge-journal.log` | `src/bridge-io.js:48-50,65` | 诊断 | 可复制 | C |
| `<ROOT>/panel/reminder-state.json` | `src/index.js:199-201,1983` | 机器人 | 复制 | U |
| `<ROOT>/data/sleep-state.json` | `src/index.js:214,274` | 机器人 | 复制 | U |
| `<ROOT>/panel/console-profile/` | `src/launch-mode.js:267-268`；Chromium | 启动器 | **不复制**（含 Edge Wallet 等私有缓存，可重建） | C |
| `<包根>/app/panel/start.log` | `packaging/windows/launcher/launch-hidden.vbs:28` | 诊断 | 改到 `userdata/panel/start.log`；不复制 | C |

### 2.3 业务数据与扩展

| 当前路径 | 写入者 | 读取者 | 处置 | 归属 |
|---|---|---|---|---|
| `<ROOT>/data/` | 扩展包；`panel/lib/paths.js:213-219`；`src/config.js:49` | 面板/机器人 | **整树复制**（`bot-state.json`、`memory/people/`、`images-lib/`、`api-deals.json`） | U |
| `<ROOT>/plugins/` | `panel/lib/ext-install.js:156-204`；`src/plugin-host.js:81-99` | 面板/机器人 | **整树复制** | U |
| `<ROOT>/skills/` | 同上 | 面板/机器人 | **整树复制** | U |
| `<ROOT>/persona/` | 人工/面板；`src/config.js:554-561` | 机器人 | **整树复制** | U |
| `<ROOT>/.qqbot-portable-setup.json` | `onekey.mjs:188`；`setup.mjs:230`；`common.mjs:31` | `diag.mjs:231,235` | 迁移为 `userdata/setup-state.json`，旧文件保留 | U |
| `<ROOT>/diag-out/` | `diag.mjs:30,173,231,276-320` | 人工诊断 | 可选复制；默认不复制 | C |
| 桌面 `Estrella Bot.lnk` | `make-shortcut.mjs:74-80` | Windows | 安装器重建；卸载器删除 | 系统 |

### 2.4 NapCat（含登录态）

| 当前路径 | 写入者 | 读取者 | 处置 | 归属 |
|---|---|---|---|---|
| `<ROOT>/napcat/` 整体（含 `NapCat.Shell.zip`、解压树、启动器） | `setup.mjs:82-104`；`repair.mjs:173-179,232-239` | `napcat-native.js`、启动器 | **迁移到 `<USER_ROOT>/napcat/`**（安装版程序也归用户级，随登录态一起保留） | U |
| `<ROOT>/napcat/config/` | `setup.mjs:129-162`；`start-napcat.mjs:85-104`；`common.mjs:396-400,549-552` | NapCat | 复制 | U |
| `<ROOT>/napcat/QQ/` | NapCat | NapCat | 复制（**登录态**） | U |
| `<ROOT>/napcat/napcat.log` | `napcat-native.js:40`；`start-napcat.mjs:36,45-47`；`panel/server.js:3340` | 诊断 | 可重建 | C |
| `<ROOT>/napcat/cache/qrcode.png` | NapCat；`napcat-native.js:43,158-162` | 面板 | 可重建 | C |
| `<ROOT>/napcat/INSTALLED.json` | `versions.mjs:160,175` | 升级判据 | 复制 | U |
| `<ROOT>/napcat/.update-tmp/` | `repair.mjs:264-273` | 升级 | 不复制 | C |
| `<USER_ROOT>/napcat.new-<ts>/`（P6 离线放包的暂存目录） | `napcat-local.mjs:placeNapcatFromLocal` | 放包流程自己（验完形状后 rename 成 `napcat/`） | 不复制；崩溃残留由启动器清理 | C |
| `<USER_ROOT>/update/napcat-status.txt`（P6：`OK/MISMATCH/UNVERIFIED/SLOW/SKIPPED/REFUSED/FAILED` 第一行） | `bootstrap.mjs` | NSIS 安装页（决定要不要弹一句）、`diag.mjs` | 可重建 | C |
| 用户自带的 NapCat 件（zip 或已解压目录，任意路径） | 用户 | `napcat-local.mjs`（**只读**：不 rename、不删、不写回） | 永不改动；装完把原路径打印给用户，删不删由他决定 | X |

### 2.5 更新缓存（新增，P3）

| 目标路径 | 写入者 | 读取者 | 处置 | 归属 |
|---|---|---|---|---|
| `<USER_ROOT>/update/cache/` | 更新器 | 更新器 | 可清理；安装包校验后保留 | C |
| `<USER_ROOT>/update/state.json` | 更新器 | 面板 | 可重建 | C |
| `<USER_ROOT>/update/logs/` | 更新器/安装器 | 诊断 | 保留最近若干份 | C |

---

## 3. 程序资产清单（不得混入用户数据）

| 资产 | 当前来源 | 目标位置 | 备注 |
|---|---|---|---|
| `package.json` | 仓库 | `<ver>/app/package.json` | 版本单一来源；`panel/lib/paths.js:38` 自检依赖它 |
| `panel/server.js`、`panel/lib/`、`panel/next/` | 仓库 | `<ver>/app/panel/` | 页面资产每次读盘，零构建 |
| `src/` | 仓库 | `<ver>/app/src/` | 机器人主链 |
| `tools/` | `packaging/windows/tools/` | `<InstallRoot>/tools/` | 稳定安装器/启动器工具；跨版本共用 |
| `launcher/` | `packaging/windows/launcher/` | `<InstallRoot>/launcher/` | 隐藏启动 VBS、图标 |
| `runtime/node/` | 构建时嵌入 | `<InstallRoot>/runtime/node/` | Node 22.13+；构建时校验官方哈希 |
| `node_modules/ws/` | 构建时复制 | `<ver>/app/node_modules/ws/` | 唯一运行时依赖 |
| `README.html`、`LICENSE`、`THIRD-PARTY-NOTICES.md` | 仓库/构建 | 安装根/文档目录 | 用户说明；不进入数据根 |
| `packaging/`、`test/`、`.github/` | 仓库 | **不进 payload** | P2 的 payload 白名单显式剔除 |

---

## 4. 模式矩阵（P1 必须用同一张表）

| 模式 | 判定输入 | `PROGRAM_ROOT` | `INSTALL_ROOT` | `USER_ROOT` | 说明 |
|---|---|---|---|---|---|
| dev | 无 `install.json`；程序根不是包内 `app`；或 `QQBOT_MODE=dev` | 仓库根 | 仓库根 | 仓库根（原位，兼容现状） | Mac 开发、四层回归不变 |
| portable | `PROGRAM_ROOT/<pkg>/app` 且同级有 `tools/`、`runtime/`；或 `QQBOT_MODE=portable` | `<pkg>/app` | `<pkg>` | `<pkg>/userdata` | zip 备用/VM 通道 |
| installed | 从 `PROGRAM_ROOT` 向上找到 `install.json`；或 `QQBOT_MODE=installed` | `<InstallRoot>/versions/<ver>/app` | `<InstallRoot>` | `install.json.userRoot`，缺省 `%LOCALAPPDATA%\EstrellaBot\userdata` | NSIS 主形态 |
| sandbox | `QQBOT_SANDBOX=1` + `QQBOT_DATA_DIR=<tmp>` | 仓库根 | 仓库根 | 仓库根（但 `data/` 指到 tmp） | 现有测试不迁移 |
| CI | `QQBOT_MODE=dev` + 临时目录 | 仓库根 | 仓库根 | 临时 `userdata` | Windows runner 只跑契约 |

优先级：`QQBOT_USER_ROOT` > `install.json.userRoot` > 模式默认。
`QQBOT_DATA_DIR` 只覆盖 `<USER_ROOT>/data`，不改变其他路径。

---

## 5. 环境变量契约

### 5.1 现有名字（必须保留）

`QQBOT_CONFIG` · `QQBOT_TRACE_FILE` · `QQBOT_BRIDGE_JOURNAL_FILE` ·
`QQBOT_BRIDGE_LOCK_FILE` · `QQBOT_SESSION_ARCHIVE` · `QQBOT_THINKING_FILE` ·
`QQBOT_REMINDER_FILE` · `QQBOT_PROMPT_STATS` · `QQBOT_DATA_DIR` ·
`QQBOT_PLUGINS_DIR` · `QQBOT_SKILLS_DIR`

另有测试/端口开关：`QQBOT_PANEL_PORT`、`QQBOT_SANDBOX`、`QQBOT_LOCAL_MODEL_PORT`、
`QQBOT_QWENCHAT_PORT`、`QQBOT_CONTROL_FILE`。

### 5.2 新增名字（P1）

| 名字 | 作用 | 谁读 |
|---|---|---|
| `QQBOT_USER_ROOT` | 用户数据根覆盖（测试/高级用户） | `src/user-root.js`、`panel/lib/paths.js`、包装工具 |
| `QQBOT_MODE` | 强制 `dev` / `portable` / `installed` | `src/user-root.js` |

### 5.3 现状裂缝

- `panel/lib/paths.js:138` 的 `CONFIG_FILE` 是 `<ROOT>/config.json`，**不读** `QQBOT_CONFIG`；
  `src/index.js:151-153` 则读 `QQBOT_CONFIG`。只设一个变量 ⇒ 面板与机器人读写两份不同配置。
- 同类裂缝：`TRACE_FILE`（`paths.js:144` vs `bridge-io.js:44-46`）、
  `ARCHIVE_FILE`（`paths.js:146` vs `index.js:757-759`）、
  `USAGE_DIR`（`paths.js:147` vs `usage.js:22-23`）、
  `THINKING_FILE`（`paths.js:140` vs `bridge-io.js:37-38`）。
- `src/index.js:162-163` 的 `EFFECTIVE_FILE` 环境值没有 `path.resolve`，与同族不一致。
- 所有相对 `QQBOT_*` 值都按 cwd 解析；现有测试总是 `cwd=ROOT`，没有覆盖“cwd ≠ 程序根”。

---

## 6. 跨进程契约

| 契约 | 位置 | 现状 | 目标 |
|---|---|---|---|
| 面板 → 机器人 | `panel/server.js:1405-1412` | `cwd=ROOT`，入口 `<ROOT>/src/index.js`，只注入 `QQBOT_LOG_LEVEL` | `cwd=PROGRAM_ROOT`，入口 `<PROGRAM_ROOT>/src/index.js`，显式注入 `QQBOT_USER_ROOT` 与 `QQBOT_MODE` |
| 工具 → 面板 | `packaging/windows/tools/lib/console.mjs:60-75` | `cwd=APP`，`NODE_EXE=<pkg>/runtime/node/node.exe`，日志 `app/panel/panel.log` | `cwd=<ver>/app`，日志 `userdata/panel/panel.log`；安装器先停旧进程 |
| VBS 启动器 | `packaging/windows/launcher/launch-hidden.vbs:25-42` | 硬编码 `root\runtime\node\node.exe`、`root\tools\start.mjs`、`root\app\panel\start.log` | 读 `current.json` 选版本；日志写 `userdata/panel/start.log` |
| 单实例锁 | `panel/lib/paths.js:158-160`；`src/index.js:462` | `<ROOT>/panel/.bridge.lock` | `<USER_ROOT>/panel/.bridge.lock`（跨版本唯一） |
| 进程认领 | `src/bridge-proc.js:151-159` | 只认 `<root>/src/index.js` 绝对入口 | 同时认 current 与 previous 的 `PROGRAM_ROOT`，避免升级后把上一版机器人判成“不是我们的” |
| 快捷方式 | `packaging/windows/tools/make-shortcut.mjs:74-80` | `WorkingDirectory=ROOT`，指向 `launch-hidden.vbs` | 安装器重建；`WorkingDirectory=INSTALL_ROOT` |
| 面板端口 | `panel/lib/paths.js` `requestedPanelPort()` | 8788（`QQBOT_PANEL_PORT` 覆盖） | 产品形态默认 0（系统分配）；实际端口写 `USER_ROOT/panel/.panel.json`，dev 仍 8788 |
| 面板 API | `panel/server.js` 路由表 | `/api/state`、`/api/config`、`/api/panel/quit`、`/api/audit` 等 | P3 新增 update 路由，必须同步 `API_ROUTES` + `WRITE_ROUTES` + §81 |

---

## 7. 冲突与阻塞（P1 必须逐条处理）

| # | 冲突 | 证据 | 处理方向 |
|---|---|---|---|
| H1 | 两套配置宇宙 | `paths.js:138` vs `index.js:151-153` | P1 统一由 `src/user-root.js` 产出路径，面板与机器人读同一份 |
| H2 | 11 处独立 `ROOT` | §1 | P1 全部改 import；失败即启动报错，不静默回落 |
| H3 | 程序根即数据根 | `paths.js:138-175`、`data/`、`plugins/`、`skills/`、`persona/`、`napcat/` | P1 引入 `USER_ROOT`，版本目录只留程序 |
| H4 | NapCat 登录态在程序树内 | `napcat-native.js:39-43`；`docker-compose.yml:68-69` | 整个 `napcat/` 迁到 userdata；安装版用原生 NapCat |
| H5 | 只读安装会炸 | `server.js:1384`（bridge.log）、`config-io.js:95`（配置保存）、`console.mjs:65`（panel.log）、`setup.mjs:230`（marker） | 所有写点改到 userdata；程序目录按只读验证 |
| H6 | cwd/相对 env 未测试 | `server.js:1406`、`common.mjs:334-339`；测试总是 `cwd=ROOT` | P1 增加 `cwd ≠ PROGRAM_ROOT` 与只读程序目录夹具 |
| H7 | `console-profile` / 聊天存档 / 配置历史 / .lnk / diag-out 会丢 | §2.2、§2.3 | 存档/历史/画像复制；console-profile 重建；.lnk 重建；diag-out 可选 |
| H8 | `EFFECTIVE_FILE` 未 resolve | `src/index.js:162-163` | P1 与同族统一 `path.resolve` |
| H9 | `napcat-native.js` 的 runtime 相对路径 | `napcat-native.js:207-210`（`ROOT/../runtime/node`） | 改用 `INSTALL_ROOT/runtime/node`，不能从 `versions/<ver>/app` 推 |
| H10 | Docker 相对挂载 | `docker-compose.yml:67-69` | 安装版不用 Docker；Docker 只在开发/Mac，compose 保持相对 |
| H11 | `launch-hidden.vbs` 日志在 `app/panel` | `launch-hidden.vbs:28` | 改到 `userdata/panel/start.log` |
| H12 | 快捷方式工作目录指向旧根 | `make-shortcut.mjs:74-80` | 安装器重建；`INSTALL_ROOT` |
| H13 | 上一版机器人不被认领 | `bridge-proc.js:151-159` | 认 current + previous 两个程序根 |
| H14 | 版本号漂移 | `package.json:3`；`onekey.mjs:38`；`setup.mjs:30` | P1/P2 建漂移门禁，全部读 `package.json` |
| H15 | 无健康检查 | 当前无 `/api/health` | P3/P4 增加只读健康端点，不依赖配置/机器人 |
| H16 | `zip.js` 上限太小 | `panel/lib/zip.js:34-40`（4MB/16MB/2MB/200） | P3 更新包不走这个接口；若复用需单列放行，不直接放宽全局 |

---

## 8. 复验命令

```bash
# 11 处 ROOT
grep -rnE "^(export )?const ROOT\b|^const ROOT\b" src panel/lib packaging/windows/tools scripts

# 面板不认 QQBOT_CONFIG
sed -n '136,148p' panel/lib/paths.js; sed -n '149,166p' src/index.js

# NapCat 登录态
grep -n "QQ" docker-compose.yml | head; grep -n "NAPCAT_NATIVE_DIR" panel/lib/napcat-native.js

# 版本三处
grep -n '"version"' package.json; grep -n "const VERSION" packaging/windows/tools/onekey.mjs packaging/windows/tools/setup.mjs

# 只读写点
grep -n "bridge.log\|panel.log\|writeFileSync(PIDFILE" panel/server.js panel/lib/paths.js packaging/windows/tools/lib/console.mjs

# 上一版认领
sed -n '144,160p' src/bridge-proc.js

# 测试 cwd
grep -n "cwd:" test/smoke.js test/panel-boot.mjs test/panel-dom.mjs | head -20
```

---

## 9. P1 落地状态（2026-10-18）

本审计里的 11 处根推导已收敛到 `src/user-root.js`：

- `panel/lib/paths.js` 只消费解析器；面板/机器人/工具三侧共用。
- `USER_ROOT` 下接管 config、panel 运行态、data、plugins、skills、persona、napcat。
- `panel/server.js` 的 spawn 注入 `QQBOT_USER_ROOT` / `QQBOT_MODE` / `QQBOT_CONFIG`。
- `tools/migrate.mjs` 只复制迁移；`setup`/`onekey` 在创建新配置/NapCat 前调用。
- NapCat 与 ④b 的路径改为 `userdata/napcat`；公开 zip 对两处 NapCat 都做硬闸。
- 证据：`check-wb` 110/110 · `installer-p1` 13/13 · `smoke` 467/467 ·
  `sandbox` 210/0 · `mutate-lint` 645/0/0。

仍未落地的部分（P2/P3）：`versions/<ver>` 实际安装布局、`current.json`/`install.json`、
NSIS/卸载器、`/api/health`、更新缓存目录。

---

## 10. P2 落地状态（2026-10-18）

- 安装版布局已落地：`PROGRAM_ROOT=<InstallRoot>/versions/<ver>/app`，
  `INSTALL_ROOT` 由 `src/user-root.js` 向上找 `install.json` 得到；
  `USER_ROOT` 由 `install.json.userRoot` 决定，缺省
  `%LOCALAPPDATA%\EstrellaBot\userdata`。
- `install-commit.mjs` 是目录交换的唯一入口：先 `stop.mjs`（含 `/api/bridge/stop`），
  再备份/替换 `runtime/node`、`versions/<ver>`、`tools/`、`launcher/`、`resources/`，
  失败按 `versions/.txn.json` 恢复；`install.json`/`current.json` 原子写。
- `launcher.mjs` 只从 current/previous 取程序根；面板 spawn 注入
  `QQBOT_MODE=installed`、`QQBOT_USER_ROOT`、`QQBOT_CONFIG`；
  `/api/health` 是唯一就绪信号。
- `src/bridge-proc.js` 的进程认领扩到 current + previous 两个程序根。
- 卸载器从 HKCU 卸载项读 `UserRoot`，默认保留；删除前校验
  `.estrellabot-user-root` 标记并二次确认。
- 仍未落地（P3/P4）：更新缓存/清单/签名/下载安装界面、健康失败自动回滚、
  旧版本目录清理。
