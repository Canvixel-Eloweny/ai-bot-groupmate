# Estrella Bot · Windows 安装器与更新架构（P0 冻结）

> 冻结日期：2026-10-17 · 基线 commit `1caecb8` · 状态：P0 方案冻结（P1 起按本文件实现）
> 范围：**只做 Windows**。Mac 不打包；不使用 Electron；不随公开包分发 NapCat。
> 本文件是 P1–P5 的规格正本。实现偏离必须在本文件追加“订正段”，写清原因、影响面与迁移方式，
> 不允许在代码里悄悄改语义。路径审计证据见 `PATH-AUDIT.md`。
>
> ⚠️ **订正（2026-10-23 · P1-7）：上面“不使用 Electron”已过期，旧表述保留作历史。**
> 自 B2a 起安装载荷包含 **Electron 44.9.3 win32-x64 完整运行时**，落在
> `versions/<ver>/app/electron/`（不是共享的 `<InstallRoot>/electron`）；壳与 app 同版本回滚。
> Edge `--app` 仍保留为壳缺失时的回退。详见 §6.3.1 与 `README.md` 的 P1 构建步骤。

---

## 0. 决策登记

| ID | 决策 | 冻结值 | 状态 |
|---|---|---|---|
| D-01 | 分发形态 | NSIS EXE 为主；便携 zip 保留为备用/VM/离线通道；Mac 不打包 | Frozen |
| D-02 | 安装根 | 默认 `%LOCALAPPDATA%\Programs\Estrella-Bot`，按用户安装，向导可选目录 | Frozen |
| D-03 | 程序布局 | `versions/<ver>/app` + 稳定 `tools/`、`launcher/`、`runtime/node/`、`install.json`、`current.json`、`uninstall.exe` | Frozen |
| D-04 | Node 运行时 | 共享 `runtime/node`；安装器先停应用，替换前备份 `runtime/node.previous`，回滚一并恢复 | Frozen |
| D-05 | 用户数据根 | 安装版 `%LOCALAPPDATA%\EstrellaBot\userdata`；便携版 `<包根>\userdata`；开发版仓库根原位 | Frozen |
| D-06 | 模式判定 | 向上找 `install.json` ⇒ installed；`<pkg>/app` 且同级有 `tools`/`runtime` ⇒ portable；否则 dev；`QQBOT_MODE` 可覆盖 | Frozen |
| D-07 | 数据归属 | 所有可变状态进 `USER_ROOT`；版本目录只放程序文件 | Frozen |
| D-08 | NapCat | 安装版只用原生 NapCat，整个 `napcat/` 放 `USER_ROOT`；公开 EXE 不打包；Docker 只用于开发/Mac | Frozen（默认；P1 前可改） |
| D-09 | 旧数据迁移 | 只复制、不移动/删除；目标优先；冲突进 `.migration-conflicts/`；`migration.json` 幂等 | Frozen |
| D-10 | 根解析 | P1 单一 `src/user-root.js`；11 处 ROOT 全部改读；面板 spawn 注入 `QQBOT_USER_ROOT` | Frozen |
| D-11 | 更新源 | 固定 `releases/latest/download/latest.json` + `latest.json.sig`；Ed25519；不用 GitHub API | Frozen |
| D-12 | 更新交互 | 自动检查；**下载/安装都必须用户点击**；服务端代理；两击契约 | Frozen |
| D-13 | 安装器 | NSIS 3.x / Unicode / per-user；payload 白名单；硬拒用户数据与 NapCat | Frozen |
| D-14 | 卸载 | 默认保留 `USER_ROOT`；勾选“彻底删除”并二次确认才删；不删 Docker | Frozen |
| D-15 | 版本/发布 | `package.json` 唯一版本源；版本号按 G4 由维护者指定；发布走 G3–G6 | Frozen |
| D-16 | 代码签名 | 清单 Ed25519 必做；首个 EXE 暂不做 Authenticode（接受 SmartScreen 提示） | Frozen（默认；P5 再定证书） |
| D-17 | 标识/系统 | `appId=com.estrellabot.windows`；显示名 `Estrella Bot`；最低 Windows 10 1809 x64 | Frozen |
| D-18 | 文档落点 | P0 文档放 `packaging/windows/`；不进包内 `app/`；不新增 `docs/` 文件 | Frozen |

---

## 1. 范围与非目标

### 1.1 范围

- 首次安装：双击 EXE，向导选择目录，创建桌面/开始菜单快捷方式，注册“应用和功能”卸载项。
- 打开体验：双击快捷方式 → 无黑窗 → Edge `--app` 独立窗口；没有 Edge 回退 Chrome/默认浏览器。
- 数据连续性：首次安装可导入旧便携包数据；升级/卸载默认不碰用户数据。
- 更新：面板检查 GitHub Release 的签名清单；用户点击下载新 EXE；校验后用户再点击安装。
- 回滚：新版本启动失败时回到上一版；失败证据保留。
- 标准卸载：安装目录有卸载器，Windows 设置里也能卸载。

### 1.2 非目标

- 不做 Mac 分发包、Mac 更新器（Mac 继续本地跑仓库代码）。
- 不用 Electron；不引入构建步骤；面板仍是零构建静态资产。
- 不自动下载、不自动安装、不静默运行任何 EXE。
- 不随公开 EXE 分发 NapCat/QQ；NapCat 由用户首次运行时下载或由 ④b/VM 预装迁移。
- P0 不改任何运行时代码。

---

## 2. 安装布局

### 2.1 安装根

```
<InstallRoot>\
  install.json                  # 安装元数据（安装器写）
  current.json                  # 当前/上一版指针（原子写）
  versions\
    <ver>\
      app\                      # 程序文件（git 跟踪面，无用户数据）
        package.json
        panel\
        src\
        node_modules\ws\
        ...
  runtime\
    node\                       # 共享 Node 运行时（node.exe 等）
    node.previous\              # 升级时的上一份 runtime（回滚用；成功后清理）
  tools\                        # 稳定工具（跨版本共用）
    launcher.mjs
    updater.mjs
    stop.mjs
    migrate.mjs
  launcher\
    Estrella-Bot.vbs            # 隐藏启动入口（ASCII-only）
    estrella-bot.ico
  resources\
    update-pubkey.pem           # 更新清单验签公钥（可含 keyring）
  uninstall.exe
  README.html
  LICENSE
  THIRD-PARTY-NOTICES.md
  BUILD-INFO.txt                # 可选：构建溯源，供诊断
```

### 2.2 用户数据根

```
<USER_ROOT>\
  config.json
  .env                          # 存在则保留；不进安装包
  panel\                        # 面板/机器人运行态（日志、token、历史、存档、usage…）
  data\
  plugins\
  skills\
  persona\
  napcat\                       # 原生 NapCat：程序 + config + QQ 登录态 + 日志 + 缓存
  update\
    cache\                      # 已校验的安装包
    state.json                  # 更新状态（可重建）
    logs\
  migration.json                # 迁移记录（幂等标记）
  setup-state.json              # 原 .qqbot-portable-setup.json 的新家
```

### 2.3 归属规则

| 类别 | 位置 | 升级 | 卸载 |
|---|---|---|---|
| 程序 | `versions/<ver>/app`、`runtime`、`tools`、`launcher`、`resources` | 可替换 | 删除 |
| 安装元数据 | `install.json`、`current.json`、`uninstall.exe` | 安装器更新 | 删除 |
| 用户数据 | `USER_ROOT` 下除 `update/cache` 外全部 | **不动** | 默认保留 |
| 缓存 | `USER_ROOT/update/cache`、`panel/console-profile`、`diag-out` | 可清理/重建 | 默认保留或删除均可 |

**硬规则：`USER_ROOT` 不允许位于 `<InstallRoot>` 内部。** 安装器必须校验；
如果用户把数据根指到安装目录里（高级覆盖），安装器拒绝继续。

---

## 3. 根解析与模式

### 3.1 唯一策略

P1 新建 `src/user-root.js`（零业务依赖；允许 `node:fs`；传递闭包不得触达
`llm / brain / onebot / index / config / logger`）。它导出：

- `MODE`：`dev` / `portable` / `installed`
- `PROGRAM_ROOT`：当前版本的程序根
- `INSTALL_ROOT`：安装根（dev/portable 也有定义）
- `USER_ROOT`：用户数据根
- `CONFIG_FILE`、`PANEL_STATE_DIR`、`DATA_DIR`、`PLUGINS_DIR`、`SKILLS_DIR`、
  `PERSONA_DIR`、`NAPCAT_DIR`、`UPDATE_DIR`

所有路径由它拼出。`panel/lib/paths.js` 只保留“面板路径目录”角色，根解析改为 import
（登记 `LIB_SRC_ALLOW` 并通过 §82）。11 处 `ROOT` 全部删除自算。

### 3.2 优先级

```
QQBOT_USER_ROOT  >  install.json.userRoot  >  模式默认
QQBOT_MODE       >  自动判定
QQBOT_DATA_DIR   >  <USER_ROOT>/data        （只覆盖 data 子树）
```

`QQBOT_MODE` 值域：`dev` / `portable` / `installed`；非法值启动即报错。

### 3.3 模式矩阵

| 模式 | 判定 | `PROGRAM_ROOT` | `INSTALL_ROOT` | `USER_ROOT` |
|---|---|---|---|---|
| dev | 无 `install.json`、不是包内 `app`，或 `QQBOT_MODE=dev` | 仓库根 | 仓库根 | 仓库根（原位） |
| portable | `<pkg>/app` 且有同级 `tools`/`runtime`，或 `QQBOT_MODE=portable` | `<pkg>/app` | `<pkg>` | `<pkg>/userdata` |
| installed | 向上找到 `install.json`，或 `QQBOT_MODE=installed` | `<InstallRoot>/versions/<ver>/app` | `<InstallRoot>` | `install.json.userRoot` 或 `%LOCALAPPDATA%\EstrellaBot\userdata` |

### 3.4 跨进程一致性

- 面板 spawn 机器人（`panel/server.js:1405-1412`）必须注入：
  `QQBOT_USER_ROOT`、`QQBOT_MODE`、`QQBOT_DATA_DIR`（若显式设了）。
- tools 起面板（`console.mjs:60-75`）同样注入，并把 `cwd` 设为 `PROGRAM_ROOT`。
- 单实例锁、pid、命令文件都放 `USER_ROOT/panel`，跨版本唯一。
- 进程认领（`src/bridge-proc.js:151-159`）必须同时认 current 与 previous 的
  `PROGRAM_ROOT`，否则升级后会把上一版机器人判成“不是我们的”。

### 3.5 夹具契约（P1 测试表）

同一组输入必须在面板进程、机器人进程、tools 进程得到完全相同的根：

| 输入 | 期望 |
|---|---|
| `QQBOT_MODE=dev`，仓库根 | `USER_ROOT=仓库根` |
| `QQBOT_MODE=portable`，`<pkg>/app` | `USER_ROOT=<pkg>/userdata` |
| `QQBOT_MODE=installed` + `install.json` | `USER_ROOT=install.json.userRoot` |
| `QQBOT_USER_ROOT=<tmp>` 覆盖以上 | 全部指向 `<tmp>` |
| `QQBOT_DATA_DIR=<tmp2>` | 只有 `DATA_DIR` 变，其他路径不变 |
| 程序目录只读 | 启动不写程序目录；写 userdata 成功 |
| `cwd` ≠ `PROGRAM_ROOT` | 解析结果不变 |

---

## 4. 数据分类

### 4.1 必须复制（用户数据）

`config.json` · `panel/audit.jsonl` · `panel/local-trace.jsonl` ·
`panel/session-archive.json` · `panel/usage-*.jsonl` · `panel/config-history.jsonl`（含明文 Key） ·
`panel/prompt-stats.json` · `panel/style-profile.json` · `panel/forward-probe.jsonl` ·
`panel/auto-memory.jsonl` · `panel/memory-records.json` · `panel/window-state.json` ·
`data/` · `plugins/` · `skills/` · `persona/` · `.env` · `napcat/` 整树 ·
`.qqbot-portable-setup.json`（迁移为 `setup-state.json`）。

### 4.2 重建/不复制（缓存与运行态）

`panel/.token`（重新生成）· `panel/.bridge.pid` · `panel/.bridge.lock` ·
`panel/.bridge-cmd.json` · `panel/effective.json` · `panel/.thinking.json` ·
`panel/bridge.log` · `panel/local-model.log` · `panel/panel.log` ·
`panel/model-sync.json` · `panel/console-profile/` · `panel/start.log` ·
`diag-out/`（可选保留）· `napcat/napcat.log` · `napcat/cache/qrcode.png` ·
`napcat/.update-tmp/`。

### 4.3 绝不复制

程序文件（`panel/server.js`、`panel/lib/`、`panel/next/`、`src/`、`package.json`）·
`runtime/` · `versions/` · `tools/` · `launcher/` · `node_modules/` · 任何 `.exe`/`.dll` 运行时。

### 4.4 敏感文件

`config-history.jsonl`、`.env`、`panel/.token`、`napcat/.webui_token`、
`panel/session-archive.json` 按敏感文件处理：复制后不打印内容；日志只记路径与大小。

---

## 5. 首次安装与旧数据迁移

### 5.1 触发

- 安装版第一次启动：`USER_ROOT/migration.json` 不存在。
- 便携版第一次启动：`USER_ROOT` 不存在或为空，且旧数据在程序根。
- 安装器升级：**不运行迁移**（数据已在 `USER_ROOT`）。
- 开发模式：不迁移（原位）。

### 5.2 算法

1. 解析根；若 `USER_ROOT` 不存在则创建。
2. 若 `migration.json` 存在且 `status=complete`、`schema>=1`，跳过。
3. 获取 `USER_ROOT/.migration.lock`（`wx` 创建）。已存在且新鲜（<10 分钟）⇒ 中止并提示；
   不自动删锁，避免两个进程同时迁移。
4. 找旧数据源：
   - 安装器传入 `--import-from <旧包根>`；
   - 或 `<PROGRAM_ROOT>` 下存在 `config.json` / `panel` / `data` / `napcat`（旧便携布局）。
5. 写 `migration.json`：`status=in_progress`、`source`、`startedAt`、`schema=1`。
6. 按 §4.1 白名单逐项复制：
   - 单文件：临时文件 + fsync + rename；目标已存在且非空 ⇒ 目标优先，源文件复制到
     `.migration-conflicts/<ts>/<相对路径>`。
   - 目录：递归复制；跳过 §4.2/§4.3；冲突同样进 conflicts。
   - 复制后对 `config.json` 做 JSON 解析；对 `data/`、`plugins/`、`skills/`、`napcat/` 记条目数。
7. 成功：写 `migration.json` 的 `status=complete`、`completedAt`、`counts`、
   `configSha256`；释放锁。
8. 失败：写 `status=failed`、`error`、`failedAt`；**源数据保持原样**；不启动机器人，
   面板显示“迁移失败”横幅与日志路径，允许用户重试。
9. 任何情况下不删除旧包/旧数据。

### 5.3 冲突与幂等

- 同一 `source` + 同一 `USER_ROOT` 重跑：已完成的 marker 直接跳过。
- 目标已有用户数据：永不覆盖；冲突文件进 `.migration-conflicts/<ts>/`。
- 不复制旧 `.bridge.lock` / `.bridge.pid` / `.bridge-cmd.json` / `.token`；
  避免旧锁导致新进程起不来、旧命令被重放。

### 5.4 安装器导入页

升级/首装检测到旧便携包时，显示“导入旧数据”页：

- 自动探测同目录/用户选择的旧包根；
- 只读展示将导入的类别与数量；
- 用户确认后由 `tools/migrate.mjs` 执行同一算法；
- 失败不阻断安装，但明确提示“数据未导入，旧数据仍在原处”。

---

## 6. 安装器（NSIS）

### 6.1 基本参数

- NSIS 3.x，`Unicode true`，x64。
- `RequestExecutionLevel user`；`SetShellVarContext current`；默认安装根
  `$LOCALAPPDATA\Programs\Estrella-Bot`。
- 页面：欢迎 → 许可（Apache-2.0）→ 安装目录 → 组件（桌面快捷方式/开始菜单/开机启动，
  默认勾选前两项，自启不勾）→ **协议端来源**（P6 新增：三选一 —— 我已有 zip /
  我已解压好的目录 / 现在联网下载；**默认谁都不勾**）→ 导入旧数据 → 安装 →
  完成（默认勾选“启动 Estrella Bot”）。
- 升级检测：读 HKCU
  `Software\Microsoft\Windows\CurrentVersion\Uninstall\Estrella-Bot` 的
  `InstallLocation`。存在则走“升级”页，固定使用该目录；要换目录必须先卸载。
- `/D=` 必须是最后一个参数且不加引号（NSIS 约定）；路径含空格时由 NSIS 处理。
- 快捷方式：桌面 + 开始菜单，目标 `wscript.exe "<InstallRoot>\launcher\Estrella-Bot.vbs"`，
  图标 `resources\estrella-bot.ico`，工作目录 `<InstallRoot>`。
- 开机启动（可选）：写 HKCU `Run` 或启动文件夹；默认不勾；卸载时删除。

### 6.2 安装事务

1. 校验安装根可用、`USER_ROOT` 不在安装根内。
2. 停止应用：`runtime\node\node.exe tools\stop.mjs --root <InstallRoot>`；
   它先调 `/api/panel/quit`，再等待；仍存活则中止并提示用户手动关闭。
   只杀命令行包含 `<InstallRoot>` 的 node 进程，不按镜像名杀。
3. 把 payload 解到 `versions\<ver>.tmp`；校验 `SHA256SUMS` / 文件数 / `package.json` 版本。
4. 备份 `runtime\node` → `runtime\node.previous`（如已存在则先移除旧的备份）。
5. 替换 `runtime\node`（payload 内 Node）；把 `versions\<ver>.tmp` 改名为
   `versions\<ver>`。
6. 写 `install.json`（含 `installRoot`、`userRoot`、`installedVersion`、`installedAt`）。
7. 原子写 `current.json`：`current=<ver>`，`previous=<旧 current>`，`health=pending`。
8. 创建/更新快捷方式与 HKCU 卸载项。
9. 失败：删除 `.tmp`、恢复 `runtime\node`（从 `.previous`）、保持旧 `current.json`；
   提示错误并保留日志。
10. 完成后可选启动应用；启动失败不回滚安装器（由启动器健康检查处理）。

### 6.3 Payload 白名单

允许：

- `versions/<ver>/app/**`（仅程序文件）
- `runtime/node/**`
- `tools/**`（稳定工具）
- `launcher/**`
- `resources/**`
- `uninstall.exe`
- `README.html`、`LICENSE`、`THIRD-PARTY-NOTICES.md`、`BUILD-INFO.txt`

禁止（构建时 exit 1）：

- `config.json`、`data/**`、`plugins/**`、`skills/**`、`persona/**`、`.env`
- `panel/.token`、`panel/config-history.jsonl`、`panel/session-archive.json`、
  `panel/*.log`、`panel/console-profile/**`
- `napcat/**`（含 `NapCat.Shell.zip`、`NapCatWinBootMain.exe`、`VM-ONLY.txt`）
- `test/**`、`.github/**`、`packaging/**`、`.git/**`
- 任何 `.lnk`、`diag-out/**`、`*.part`

硬闸：发现 NapCat 启动器或 `VM-ONLY.txt` ⇒ 拒绝构建（与 `make-zip.py` 的
`refuse_vm_bundle()` 同义）；`package.json` 版本与构建版本不一致 ⇒ 拒绝；
`SHA256SUMS` 不匹配 ⇒ 拒绝。

### 6.3.1 订正（P1-7 · 2026-10-23）：Electron 载荷

- 壳的代码（`electron/main.js`、`preload.js`、`error.html`、`package.json`）与
  **Electron 44.9.3 win32-x64 完整运行时**（`electron.exe`、DLL、`resources/`、`locales/` 等）
  一起进 `versions/<ver>/app/electron/`。它不是共享 runtime：回滚到上一版时旧壳随旧 app 一起回去。
- 运行时来源由 `installer/toolchain.json.electron` 钉死（版本 / zip / size / SHA-256）；
  `fetch-electron-runtime.mjs` 优先镜像、官方兜底，哈希不符拒绝解压。
- `make-installer-payload.mjs` 断言 `electron.exe`、`version`、`resources/default_app.asar`
  在位，BUILD-INFO 写 `electronRuntime` / `electronFiles` / `electronBytes`；
  `check-nsi.mjs` 对 stage 再做一次同样断言。
- 安装根**不再有** `<InstallRoot>/electron`；`launcher.mjs` 从 `programRoot/electron` 找壳，
  `QQBOT_DESKTOP_DIR` / `QQBOT_ELECTRON_EXE` 只作 dev/救急覆盖。
- 体积基线（2026-10-23 实测）：win32-x64 dist **368.2 MiB / 77 文件**（`electron.exe` 235 MB），
  stage **473 MB / 2327 文件**；NSIS 3.13 `makensis` **0 warning**，最终 EXE
  **140,886,210 B（134.3 MiB）**，SHA-256 `b8d7fcb0f27768656a080b2f0a2d4b8cecf4bcc3209e4caed921f50c7681a440`。
  P0-4 的 256 MiB 上限余量充足，维持不变。

### 6.4 构建宿主

- 本机 macOS 没有 `makensis` / 7z / brew；**NSIS 必须在 Windows 上跑**。
- 首选：Windows VM（反向桥可执行命令/传文件），用便携 NSIS 3.x；
- 备选：GitHub Actions `windows-latest` 构建 job（只产构建产物，不自动发布）。
- macOS 负责：`make-app.mjs` 出 payload、`scan-package.mjs` 真值复扫、
  `SHA256SUMS`、清单生成、离线签名。
- Windows 负责：`makensis` 编译 `.nsi`、产出 EXE、回传。
- P2 开始时先做只读可行性检查（桥状态、`where makensis`）；安装 NSIS 属于 P2。

---

## 7. 启动器与 `current.json`

### 7.1 `current.json` ABI v1

```json
{
  "schema": 1,
  "current": "1.2.3",
  "previous": "1.2.2",
  "health": "ok",
  "failures": 0,
  "updatedAt": "2026-10-17T00:00:00Z"
}
```

- 原子写：临时文件 + fsync + rename。
- 校验：`versions/<current>/app/package.json` 存在且版本等于 `current`；
  `previous` 可空；非法则尝试 previous；两者都非法 ⇒ 显示错误对话框，不启动。
- `health`：`pending` / `ok` / `failed`。
- `failures`：连续启动失败计数；健康成功后归零。

### 7.2 启动流程

1. `launcher\Estrella-Bot.vbs`（ASCII-only）检查 `runtime\node\node.exe`，
   以隐藏方式运行 `tools\launcher.mjs`。
2. `launcher.mjs` 解析 `INSTALL_ROOT`（自身位置），读 `current.json`。
3. 以 `cwd=<PROGRAM_ROOT>` 启动
   `runtime\node\node.exe <PROGRAM_ROOT>\panel\server.js`，注入
   `QQBOT_MODE=installed`、`QQBOT_USER_ROOT=<USER_ROOT>`；
   stdout/stderr 写 `USER_ROOT/panel/panel.log`。
4. 从 `USER_ROOT\panel\.panel.json` 读面板实际端口，轮询
   `http://127.0.0.1:<port>/api/health`，30 秒超时；返回必须包含
   `appId=com.estrellabot.windows` 且 `version=current`。启动器启动面板时传
   `QQBOT_PANEL_PORT=0`（系统分配）；8788 只用于识别/停掉 P3-1 之前的旧面板。
5. 健康：写 `current.json.health=ok`、`failures=0`；动态 import
   `<PROGRAM_ROOT>/src/launch-mode.js` 打开 Edge `--app`（失败回退 Chrome/默认浏览器）。
   动态 import 必须用 `pathToFileURL(...).href`，禁止裸绝对路径（Windows 上会被当 URL 协议）。
6. 不健康：停止进程；`failures++`；若 `current != previous` 且 `failures >= 2`：
   - 恢复 `runtime\node.previous`（如果本次升级替换过）；
   - `current.json` 翻回 `previous`，`health=pending`，`failures=0`；
   - 用上一版重启。
7. 首装没有 `previous`：显示错误对话框 + 日志路径；不循环重启。
8. 已有一个同版本面板在跑：直接打开窗口，不重复起进程。
9. 旧版本在跑：安装器负责先停；启动器发现端口被占且版本不符 ⇒ 提示先退出。

### 7.3 应用窗口

- 复用 `src/launch-mode.js` 的 `planOpen`：Edge → Chrome → 默认浏览器；
  `--app=<url>`、专用 `--user-data-dir`、窗口尺寸/位置记忆。
- 专用 profile 放 `USER_ROOT/panel/console-profile`；不复制旧 profile（缓存）。
- 没有 Edge/Chrome 时回退默认浏览器标签页；不阻断使用。
- 不引入 Electron；窗口体验的边界（无原生菜单、无托盘）在 README 说明。

### 7.4 健康端点

`GET /api/health`（P3/P4）：

- 只读、无鉴权（仅 localhost），不读配置、不依赖机器人；
- 返回 `{ ok, appId, version, pid, uptimeSec }`；
- 不得包含 token、Key、群号、路径；
- 面板启动完成即应答；失败返回 503。

---

## 8. 更新协议

### 8.1 固定地址

```
https://github.com/Canvixel-Eloweny/ai-bot-groupmate/releases/latest/download/latest.json
https://github.com/Canvixel-Eloweny/ai-bot-groupmate/releases/latest/download/latest.json.sig
```

- 不用 GitHub API，避免未认证限流。
- `releases/latest` 只指向最新正式 Release；草稿/预发布不算。
- 镜像只加速下载：`gh-proxy.com` / `ghproxy.net` 前缀可配置；验签与 SHA-256 不放松。

### 8.2 清单

字段与 `update-manifest.example.json` 一致：

| 字段 | 含义 |
|---|---|
| `schemaVersion` | 固定 1 |
| `appId` | 必须等于 `com.estrellabot.windows` |
| `channel` | `stable`（v1 只支持 stable） |
| `version` | 语义化版本，必须 > 当前版本 |
| `minVersion` | 允许升级的最低当前版本；低于它提示先装桥接版 |
| `minWindows` | 最低 Windows 版本（`10.0.17763`） |
| `generatedAt` / `expiresAt` | ISO-8601；过期清单拒绝 |
| `notesUrl` | Release 页面，供用户查看说明 |
| `installer.kind` | `nsis` |
| `installer.url` | 指向**固定 tag** 的 EXE，不用 `latest` |
| `installer.mirrors` | 可选镜像 URL 数组 |
| `installer.size` | 字节数 |
| `installer.sha256` | 64 位小写十六进制 |

> 示例文件里的 `0.0.0-example`、`size=94371840`、`REPLACE_WITH_64_HEX_SHA256`
> 都是占位值，不是发布版本/真实大小/真实哈希；构建时由脚本覆盖。

### 8.3 验签与校验顺序

1. HTTPS 取 `latest.json` 原始字节（上限 64 KiB）与 `latest.json.sig`（base64）。
2. 用固定公钥 `resources/update-pubkey.pem` 验证 Ed25519 签名（覆盖原始字节，
   不做 JSON 规范化）；失败 ⇒ 拒绝，界面显示“更新清单签名无效”。
3. 解析 JSON；校验 schema/appId/channel/版本/有效期/minVersion/minWindows。
4. 解析 installer URL；只允许 HTTPS + host allowlist（`github.com`、
   `objects.githubusercontent.com`、`release-assets.githubusercontent.com`、配置的镜像域名）。
   ⚠️ GitHub 现在会把 release 资产 302 到 `release-assets.githubusercontent.com`；
   客户端校验的是**最终 URL**，这个 host 必须在白名单里，否则清单和 EXE 都会被拒。
5. 下载到 `USER_ROOT/update/cache/<version>.exe.part`（Range 续传、镜像重试）；
   校验 `size` 与 `sha256`；成功后 rename 为 `.exe`，状态 `ready`。
6. 只有 `ready` 才允许“立即安装”。安装前再校验一次哈希。

**任何一步失败都不执行下载物。**

### 8.4 状态机

```
idle → checking → up_to_date
                → available → downloading → ready → installing → done
                ↘ error（可重试）
```

- `checking` 超时 10 秒；错误不阻塞面板。
- 下载进度通过 SSE `update` 事件推送；取消下载删除 `.part`。
- 安装启动后状态 `installing`；安装器取消/失败后应用重启，状态回 `available`/`error`。

### 8.5 检查时机

- 面板加载后 3 秒检查一次（可关）；
- 每 6 小时检查一次（抖动 ±10 分钟）；
- 维护页“检查更新”按钮；
- `QQBOT_SANDBOX=1`、dev 模式、无 `install.json` 时不检查；
- 手动检查失败要显示原因；自动检查失败静默写日志。

### 8.6 API（P3）

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/api/update/state` | 当前状态/版本/进度 |
| POST | `/api/update/check` | 立即检查 |
| POST | `/api/update/download` | 用户点击后下载 |
| POST | `/api/update/install` | 用户第二次点击后运行安装器 |
| POST | `/api/update/cancel` | 取消下载 |

所有 POST 进 `WRITE_ROUTES`，走现有 token 鉴权；新增路由必须同步
`API_ROUTES`、`WRITE_ROUTES` 与 `check-wb` §81。前端只调本地 API，不直连 GitHub。

### 8.7 UI 两击契约

- 第一屏：当前版本、最新版本、更新说明链接、`下载更新` 按钮；
- 下载中：进度、取消；
- 下载完成：显示大小/校验通过，`立即安装`；
- 安装前提示“应用将关闭，安装完成后重新打开”；
- **没有“自动安装”开关**；没有任何代码路径在用户未点击时运行 EXE。

### 8.8 离线更新

- 支持用户选择本地 `Estrella-Bot-Setup-<ver>.exe` + `latest.json` + `.sig`；
- 同样先验签、再验哈希、再允许安装；
- 离线包不绕过任何校验。

---

## 9. 回滚与版本保留

- 安装器只负责“文件就位 + 翻指针”；**不判断新版本是否可用**。
- 启动器拥有健康检查与回滚；`/api/health` 是唯一成功信号。
- 回滚动作：`current.json` 翻回 `previous`；如本次替换过 runtime，恢复
  `runtime/node.previous`；写 `USER_ROOT/update/rollback.json`（时间、from、to、原因）。
- 只保留 current + previous 两个版本目录；健康成功后清理更老的版本目录和
  `runtime/node.previous`。清理只删程序文件，不碰 `USER_ROOT`。
- 配置前向迁移：新版本写 `config.schemaVersion`；写前备份
  `USER_ROOT/config-backup-<ver>.json`；迁移只许追加字段，不许删除/改名旧字段。
  若 previous 支持的 schema 低于当前配置 schema，拒绝自动回滚，提示用户
  “新版本已升级配置，回滚需先恢复备份”；提供备份路径，不自动改配置。
- 反循环：同一版本连续失败 2 次后不再自动重试；等待用户手动启动/修复。

---

## 10. 卸载

- 注册 HKCU
  `Software\Microsoft\Windows\CurrentVersion\Uninstall\Estrella-Bot`：
  `DisplayName=Estrella Bot`、`DisplayVersion`、`Publisher`、`InstallLocation`、
  `DisplayIcon`、`UninstallString`、`NoModify=1`、`NoRepair=1`。
- 卸载器自拷贝到 `%TEMP%` 再运行，避免删除自身失败。
- 停止应用（同 §6.2 的 stop 流程）。
- 删除：安装目录、快捷方式、HKCU 卸载项、开机启动项。
- **默认保留** `USER_ROOT`。提供“同时删除用户数据”复选框；勾选后二次确认，
  删除 `USER_ROOT`（`update/cache` 一并删除）。
- 不删除 Docker Desktop / Docker 容器 / 外部 NapCat；如果检测到 Docker，
  提示用户自行处理。
- 卸载完成后可保留一份 `uninstall.log` 在 `%TEMP%` 供排查。

---

## 11. 版本、构建与发布

### 11.1 版本单一来源

- `package.json` 的 `version` 是唯一来源。
- `onekey.mjs`、`setup.mjs`、构建脚本、清单生成、zip/EXE 命名全部读它；
  禁止再写死字符串。
- P1/P2 增加漂移门禁：任何一处与 `package.json` 不一致 ⇒ 构建失败/契约红。
- 版本号由维护者按 G4 指定；AI 不自拟版本。

### 11.2 产物

- `Estrella-Bot-Setup-<version>.exe`
- `latest.json`
- `latest.json.sig`
- `SHA256SUMS.txt`（EXE + 清单 + 签名）
- 可选：`Estrella-Bot-<version>-portable.zip`（备用通道，不主推）

### 11.3 构建流水线

1. macOS：干净工作树 → `make-app.mjs` 出 payload → 嵌入 `runtime/node` + `node_modules/ws`
   → `scan-package.mjs` 0 命中 → 生成 payload 清单。
2. Windows：`makensis` 编译 `.nsi` → 输出 EXE → 回传。
3. macOS：计算 EXE SHA-256 → 生成 `latest.json` → 用离线私钥签 `latest.json.sig`
   → 生成 `SHA256SUMS`。
4. 发布（G3/G4/G6）：创建 tag `v<version>` → 上传 EXE / `latest.json` / `.sig` /
   `SHA256SUMS` → 验证 `releases/latest/download/latest.json` 可访问。
5. 发布前检查：清单版本 = EXE 版本 = tag；`minVersion` 合理；`expiresAt` 未过期；
   Release 不是草稿/预发布；资产齐全。

### 11.4 首次发布与桥接版

- 0.1.2 便携版没有更新器；第一批用户必须手动安装一次**桥接版**（首个 EXE），
  之后才具备自动更新能力。
- 桥接版必须包含：数据迁移、版本目录、更新器、签名清单校验。
- 首个 EXE 的版本号由维护者按 G4 指定；`latest.json` 示例中的版本只是占位。

### 11.5 签名密钥

- Ed25519 私钥离线保存，**不进仓库、不进 CI、不进安装包**。
- 公钥 `resources/update-pubkey.pem` 随程序发布。
- 签发步骤在维护者机器上执行；AI 只准备待签字节。
- 轮换：新公钥由旧私钥签名的过渡清单发布；旧公钥至少保留一个版本周期。
- Authenticode 与清单签名是两件事：前者影响 SmartScreen，后者保证更新完整性。

---

## 12. 安全边界

| 面 | 规则 |
|---|---|
| 更新清单 | 固定 URL、HTTPS、Ed25519 原始字节签名、64 KiB 上限、过期时间 |
| 安装包 | HTTPS、大小 + SHA-256、下载后不自动运行、安装前复验 |
| 安装路径 | 只信 `install.json` / HKCU，不信清单字段 |
| 本地 API | 仅 127.0.0.1；POST 走 token；更新 API 不返回 Key/路径 |
| 日志 | 不打印 token、Key、群号、配置文件内容；迁移日志只记路径/大小 |
| NapCat | 校验值住在 `napcat.json.knownGood`（每条 = tag + SHA-256 + size，取自 GitHub Release 的 `assets[].digest`）；下载按版本正查、用户自带件按**哈希反查**；未命中只标"未校验"不中止；不随公开包分发 |
| 威胁模型 | 防御网络/镜像/仓库资产被篡改；同用户权限的本地攻击者不在范围内 |
| 降级 | 拒绝 `version <= current`；拒绝过期清单；拒绝 `minVersion` 不满足 |
| 重放 | `expiresAt` + 版本比较；不信任清单里的安装路径 |

---

## 13. P1–P5 验收标准

| 阶段 | 产物 | 完成判据 |
|---|---|---|
| **P1 数据分离** | `src/user-root.js`、11 处 ROOT 收敛、迁移工具、夹具测试 | 旧便携数据模拟升级不丢；dev/portable/installed 三模式根一致；只读程序目录可启动；四层回归绿 |
| **P2 可安装** | NSIS 脚本、payload 白名单、启动器、卸载器、干净 VM 原型 | 干净 Win11：双击 EXE → 可选目录 → 桌面图标 → 独立窗口 → 设置里可卸载；卸载后数据还在；全程无管理员 |
| **P3 可升级** | `/api/health`、更新 API/UI、下载/验签、运行安装器 | 旧版 → 新 EXE，数据不丢；坏签名/坏哈希被拒；不点按钮不动 |
| **P4 可回滚/发布候选** | 回滚、失败注入、镜像/离线、保留策略、发布候选 | 坏版本连续失败 2 次自动回滚；断电/锁文件/缺资产有明确错误；候选包通过真机验收 |
| **P5 正式发布** | G5 压缩、G6 发布、Release 资产、发布后验证 | 维护者手动发布；`latest.json`/`.sig`/EXE 齐全；新装与升级各验一遍 |

---

## 14. 风险与待定

| 风险 | 影响 | 缓解 | 阶段 |
|---|---|---|---|
| 无 Authenticode | SmartScreen “未知发布者”，安装率下降 | 文档说明；P5 评估 OV/EV 证书；清单签名保证完整性 | P5 |
| 共享 runtime 被占用 | 安装器无法替换 `node.exe` | 安装前 stop + 等待 + 中止提示；失败恢复 `.previous`；必要时每版本独立 runtime | P2/P4 |
| NSIS 构建宿主 | Mac 无 `makensis` | Windows VM/CI；P0 只读检查；P2 落地 | P2 |
| GitHub 网络/代理 | 检查/下载失败 | 固定 `latest` 资产 + 镜像 + 续传；签名/哈希不降级；错误可读 | P3/P4 |
| Release 缺资产 | 更新通道静默失效 | P4 发布前检查清单/签名/EXE/`latest` 可访问；发布后验证 | P4/P5 |
| 首次版本号 | G4 未指定 | P0 占位；发布前由维护者点名 | P5 |
| 配置前向迁移 | 回滚后旧版读不懂新配置 | 只追加字段 + 备份 + schema 检查；不满足则拒绝自动回滚 | P4 |
| Docker/NapCat | 安装版不接 Docker，用户可能困惑 | README 明确“安装版用原生 NapCat”；Docker 文档只留开发/Mac | P2 |
| 数据根默认位置 | 用户找不到数据 | 面板显示数据目录；卸载保留；README 说明 | P2 |
| Win10 1809 以下 | 不支持 | 安装器检测并提示；P2 在 VM 实测 | P2 |
| 反病毒误报 | 未签名 NSIS 可能被拦 | 文档说明；P5 证书；不混淆/不加壳 | P5 |

### 待定（不阻塞 P0）

1. 首个 EXE 版本号（G4，维护者指定）。
2. Authenticode 证书预算（P5）。
3. 更新检查是否默认开启（本规格默认开启检查，永不自动下载）。
4. 签名私钥由谁保管、轮换周期（P4/P5）。

---

## 15. P1 落地记录（2026-10-18）

P1 已按本规格完成数据分离，**未开始 P2 安装器**：

- 新增 `src/user-root.js`：程序/安装/用户三根、dev/portable/installed 模式、env 优先级；
  panel、bot、tools 三侧共用。
- `panel/lib/paths.js` 只消费解析器；`CONFIG_FILE` 与机器人同源（`QQBOT_CONFIG` 两边都认）。
- 面板 spawn 注入 `QQBOT_USER_ROOT` / `QQBOT_MODE` / `QQBOT_CONFIG`；cwd 改为 `PROGRAM_ROOT`。
- 面板运行态、`data/`、`plugins/`、`skills/`、`persona/`、`napcat/` 全部落 `USER_ROOT`；
  NapCat 含 `config/` 与 `QQ/` 登录态。
- `packaging/windows/tools/migrate.mjs`：只复制、目标优先、冲突留档、marker 幂等；
  `setup`/`onekey` 在创建新 config/NapCat 之前调用。
- 工具层 `user-root-loader.mjs` + `common.mjs` 消费同一解析器；④b 的 NapCat 注入改为
  `userdata/napcat`，`make-zip.py` 对 `app/napcat` 与 `userdata/napcat` 双硬闸。
- 版本号统一读 `package.json`（`onekey`/`setup` 不再各写一份）。

验证（本机）：

- `check-wb` **110/110**（新增 §107 单一根解析）
- `test/installer-p1.mjs` **13/13**
- `smoke` **467/467**（新增 T395）
- `sandbox` **210 通过 / 0 失败**
- `panel-boot` / `panel-dom` 通过
- `mutate-lint` **75 份 / 645 条 / 失效 0 / 惰性 0**
- `install-p1-1017` 定向变异 **6/6**（M1–M5 BLOCKED · C1 NOT-BLOCKED）

Errata（实现时有意推迟）：

- `UPDATE_DIR` 导出延到 P3（更新缓存才需要；P1 不制造死导出）。
- 真正的 `versions/<ver>` / `current.json` / `install.json` / NSIS / 卸载器在 P2。
- VBS 参数化、`start.log` 的安装版落点、`bridge-proc` 认领上一版程序根在 P2。
- P1 改动默认**未提交**；等维护者点名再本地提交。

---

## 16. P2 落地记录（2026-10-18）

P2 已按本规格完成可安装形态；版本由维护者按 G4 指定为 **0.1.3**，
`package.json` 新增 `appId=com.estrellabot.windows` 作为唯一来源。

已落地：

- **布局**：`versions/<ver>/app` + 稳定 `tools/`、`launcher/`、`resources/`、
  共享 `runtime/node`、`install.json`、`current.json`、`uninstall.exe`。
- **事务**：`packaging/windows/tools/install-commit.mjs` 负责 stage 校验、
  userRoot 双向校验、先停应用、journal 恢复、runtime/版本目录/稳定目录交换、
  原子写指针；拒绝降级；同版本按修复处理。
- **启动器**：`launcher/Estrella-Bot.vbs` + `tools/launcher.mjs`；
  读 current（坏则回退 previous）、注入 installed 根、轮询 `/api/health`、
  写 `health=ok`、用 Edge/Chrome `--app` 开独立窗口；启动锁防双击竞态。
- **首装**：`tools/bootstrap.mjs` 在 commit 后运行：只复制迁移旧数据、
  生成 config（已有不覆盖）、按 `--napcat-mode skip|zip|folder|auto` 处理协议端
  （P6：**默认 skip**，谁都不勾就是什么都不下载；zip/folder 全程零网络；
  只有 auto 联网，且带超时与总预算，永不挂死）。失败不阻断安装。
- **健康端点**：`GET /api/health` 提前到 P2（启动器唯一成功信号）；
  只返回 appId/version/pid/uptimeSec，不读配置、不返回路径/token。
- **进程认领**：`src/bridge-proc.js` 的 `isOurBridge` 同时认 current + previous
  程序根；升级后旧版机器人仍能被停掉。
- **安装器**：`packaging/windows/installer/Estrella-Bot.nsi`，MUI2 / Unicode /
  per-user / 可选目录 / 桌面与开始菜单 / 可选自启 / 可选 NapCat / 旧数据导入页；
  升级时读 HKCU 卸载项的 InstallLocation/UserRoot 并固定目录。
- **卸载器**：默认保留 USER_ROOT；自定义页勾选 + `MB_YESNO` 二次确认才删；
  删除前校验 `.estrellabot-user-root` 标记；不碰 Docker/外部 NapCat；
  不依赖程序内 Node（PowerShell 兜底）。
- **构建**：`make-installer-payload.mjs` 以 git 发布拷贝为基础按显式白名单裁剪，
  生成 `payload-manifest.json`/`BUILD-INFO.txt`/`version.nsh`，自校验 + 真值复扫；
  `toolchain.json` 钉住 Node 22.23.3 与官方 SHA-256；Windows VM 用便携 NSIS 编译。
- **契约/测试**：`check-wb §108`、`test/installer-p2.mjs`（19 项）、
  `install-p2-1018` 定向变异 7/7、`mutate-lint 76/652/0/0`。

### Errata（实现时有意偏离/推迟）

1. §7.4 原写 `/api/health` 在 P3/P4；P2 提前落地只读版（启动器必须有就绪信号），
   更新 API/签名/下载仍在 P3。
2. §6.1 组件页原未列 NapCat；P2 增加“可选下载（默认勾选）”，公开 payload 仍不含 NapCat；
   静默安装默认不下载，`/INSTALLNAPCAT` 显式开启。
3. §2.1 把 `uninstall.exe` 列在安装根布局里；它由 NSIS `WriteUninstaller` 生成，
   **不进 payload**（避免自删除混淆）。
4. 图标统一放 `launcher/estrella-bot.ico`（`resources/` 另存一份供将来使用）；
   快捷方式指向 `launcher/estrella-bot.ico`。
5. 安装器实际顺序是“解 stage → 停应用 → commit”；stage 解包不碰运行中的程序文件，
   停应用发生在任何目录交换之前。
6. P2 只做“无效 current 回退 previous”；健康失败连续两次自动回滚、旧版本目录清理
   仍在 P4（P2 刻意不删旧版本目录，宁可多留）。
7. **订正（2026-10-18 · P6，不改旧值、另起一条）**：上面第 2 条的“可选下载（默认勾选）”
   已经作废。P6 起协议端有独立一页、**默认谁都不勾**，并且多两条完全离线的路
   （选 zip / 选已解压目录）；联网下载仍在，但带超时与 5 分钟总预算，超了就明确转交
   而不是挂着。理由见 §6.1 的病根：NSIS 进度条在 `nsExec` 这种外部进程里不会推进，
   一次 2.6–12.7 分钟（两个镜像差 5 倍，见 §21 表第 3 行）的下载在用户屏幕上就叫做“安装器卡死”。
7. §3.4 的 previous 程序根认领在 P2 落地（P1 曾显式推迟）。
8. P2 的 NSIS 界面文案用英文 ASCII（避免 NSIS 源码编码在英文 Windows 上出错）；
   应用本体的中文界面不变。
9. 静默安装完成后 `.stage-<ver>` 可能因文件句柄暂时留下；**首次启动时由
   `launcher.mjs` 清理**（NSIS 也会延迟重试一次）。正常向导默认勾选“启动”，
   所以用户路径上不会留下这份临时目录。
10. 停止链不再每次读 WMI：优先用 `/api/health` 的 pid + `tasklist` 快速确认；
    只有快速路径失败才读全量进程表。未安装 NapCat 时卸载不读 WMI。
11. 卸载删除用户数据前，PowerShell 兜底会先关闭使用
    `<UserRoot>\panel\console-profile` 的 Edge 实例（它锁着该目录），
    再停 NapCat、删数据。

### VM 验收（2026-10-18）

环境：Windows 11 ARM64（10.0.26200.9711）· NSIS 3.13（VM 上 winget 安装）·
Non-admin Startup 会话（最终一轮 `ADMIN=False`）。

最终候选：`Estrella-Bot-Setup-0.1.3.exe`（25,577,698 字节）
SHA-256 `840287b047183675b5becaa8864e83de44a2d0608d881ca8dbcf0cb7f9ecc66d`。

| 场景 | 结果 |
|---|---|
| 全新静默安装 | exit 0 · `current.json`/`install.json` 正确 · config `launch.mode=window` |
| 启动 + health | launcher exit 0 · `/api/health` = `com.estrellabot.windows 0.1.3` · 1 个 Edge `--app` + 专用 console-profile |
| stage 清理 | 安装后暂留，首次启动后消失（`.stage-0.1.3` False） |
| 面板运行中重装（repair） | exit 0 · 数据标记保留 · 再次启动 health 正常 · stage 被启动器清理 |
| 默认卸载 | exit 0 · 安装目录/快捷方式/注册表全清 · `config.json` 与数据标记保留 |
| 重装 + `/S /DELETEUSERDATA` | exit 0 · 安装目录、`USER_ROOT`、注册表全清（Edge 窗口先被关闭）· 该项经 system 通道（elevated）执行；安装/重装/默认卸载为 non-admin |

未验证：Win10 1809 真机、Authenticode（P5）、真实多版本 0.1.3→0.1.4 升级
（G4 未指定 0.1.4；同版本修复与事务夹具已覆盖升级代码路径）。

P6 起协议端这一段的**实测事实**（不再写"未验证"）：下载器的五道时间上限、
续传起点核验、尺寸核验、哈希自愈与"离线放包四条路"都由 `test/installer-p6.mjs`
（25 条）在本机用假服务器实跑覆盖，联网源速率是在 Windows 11 测试机上用 3MB
Range 探针量出来的（gh-proxy.com 44KB/s、ghproxy.net 30KB/s、github.com 与
api.github.com 均 DNS 直失败 ⇒ 35,884,742 字节那份 ≈ 13 分钟）。
**仍需 VM 复跑的是安装器界面本身**（自定义页在静默模式下的行为、`GetOptions`
对含空格路径的引号处理 —— 这两点静态确认不了）。

> **订正（同日 2026-10-18 晚 · 不改旧值、另起一条）**：上面那句里"44KB/s、30KB/s、≈13 分钟"
> 是誊写时**没有回读探针原文**造成的转写错误。探针实测（同一台机器、同一轮）是
> `gh-proxy.com` **229,064 B/s（3,000,001 B / 13.097 s）**、`ghproxy.net`
> **46,919 B/s（1,173,044 B / 25.003 s，且 25 s 处被 `--max-time` 截断 rc=28）**、
> `github.com` 与 `api.github.com` **0 字节 rc=6** ⇒ 35,884,742 字节按第一候选 ≈ **2.6 分钟**、
> 按第二候选 ≈ **12.7 分钟**。**结论方向不变**（两个镜像差 5 倍、最坏一档十几分钟、
> NSIS 进度条在此期间不会推进 ⇒ 仍然是"看起来卡死"），但数字以 §21 表第 3 行与
> 其末尾的探针原文为准。教训：**誊写别人（哪怕是十分钟前的自己）记下的数字，必须回读原始输出。**

---

## 17. P3 落地记录（2026-10-18）

P3 已按 §8/§9/§11.5/§13 完成；最终产品版本仍为 **0.1.3**。

已落地：
- 面板侧更新器：`panel/lib/update-version.js` / `update-manifest.js` /
  `update-signature.js` / `update-download.js` / `update.js` / `update-routes.js`。
- 5 条 API：GET state + POST check/download/install/cancel；4 个 POST 进
  `WRITE_ROUTES`（31 条写路由）；路由表 53/35。
- 固定 GitHub HTTPS 清单 + `.sig`；64 KiB/8 KiB 上限；原始字节 Ed25519 验签后才
  JSON.parse；schema/appId/channel/version/minVersion/minWindows/expiresAt；
  HTTPS+host 白名单（github.com / objects.githubusercontent.com /
  release-assets.githubusercontent.com / gh-proxy.com / ghproxy.net）。
  ⚠️ 最后那个 `release-assets` 是 GitHub release 资产的最终 302 目标；漏了它，
  清单与 EXE 下载都会在最终 URL 校验处失败。
- 下载 `.part` Range 续传、镜像回退、size+sha256 校验后 rename；取消删除 `.part`；
  状态机 disabled/idle/checking/up_to_date/available/downloading/ready/installing/error；
  SSE `update` 复用 `/api/console/stream`。
- 两击 UI：下载更新 → 进度/取消 → 立即安装；没有自动安装；
  `QQBOT_UPDATE_TEST=1` 才允许回环 http 与 `install {silent:true}`。
- 公钥 `resources/update-pubkey.pem`（P3 验收密钥，指纹 `sha256:b1b7f3…`）；
  私钥在维护者机器仓库外；`make-app` 剔除 `app/resources`，安装器 payload 复制公钥到
  `<InstallRoot>/resources`。
- 契约 §109 + `test/installer-p3.mjs` 23/23 + `install-p3-1018` 变异 12/12；
  check-wb 112/112；smoke 467/467；sandbox 210/0。

### VM 验收（Windows 11 ARM64 10.0.26200.9711 · non-admin 用户会话）

| 场景 | 结果 |
|---|---|
| 全新静默安装 0.1.3(P3) | exit 0 · `current.json`/`install.json` 0.1.3 · `resources/update-pubkey.pem` 在位 |
| 自动/手动检查 | `available` · latest `0.1.4`（一次性验收构建，非发布版） |
| 下载 | `ready` 100% · size+sha256 通过 |
| 不自动安装 | 下载完成后等待 15s，无安装器进程；状态停在 `ready` |
| 显式安装 | `current=0.1.4` · `previous=0.1.3` · health `0.1.4` · 数据标记 `p3-data-marker-2026-10-18` 保留 · `versions/` 同时保留 0.1.3/0.1.4 |
| 坏签名清单 | `check` 返回 `ok:false`/`phase:error`；面板日志“更新清单签名无效”；无下载 |
| 取消/坏哈希 | 本机 `test/installer-p3.mjs` 覆盖（VM 未重复跑） |

### Errata（实现时有意偏离/推迟）

1. 更新器在**面板侧**（`panel/lib/update*.js`）；规格 §2.1 的 `tools/updater.mjs` 不建 ——
   离线更新在 P4 再评估。
2. §8.8 离线更新按 §13 验收表放 **P4**；P3 只做在线检查/下载/安装。
3. 验收目标用 **0.1.4**（一次性构建），不是 `0.1.4-p3.1`：NSIS `VIProductVersion`
   只接受 `X.X.X.X`，带预发布后缀会编译失败。最终产品版本仍 **0.1.3**；
   0.1.4 测试构建不提交、不发布。
4. 当前 `resources/update-pubkey.pem` 是 **P3 验收密钥**；P5 正式发布前必须生成并
   轮换正式密钥。
5. `version == current` 在客户端判为 `up_to_date`（不误报降级）；`version < current` 仍拒绝。
6. SSE `update` 复用现有 `/api/console/stream`，没有新增流路由；路由 53/35、
   `WRITE_ROUTES` 31。
7. 安装器环境注意：任何占用共享 `runtime/node` 的外部进程（例如本机验收用的更新
   HTTP 服务器）都会阻止安装器替换 runtime；安装前必须停掉。P3 的面板/机器人停止链
   本身不会停外部测试服务器。

---

## 18. P4 落地记录（2026-10-18）

P4 按 §7.2 / §8.8 / §9 / §13 完成；最终产品版本仍为 **0.1.3**。

已落地：
- 启动器回滚：`packaging/windows/tools/launcher.mjs` 保留 child.pid；失败时先停本次
  spawn 的面板，再 `failures+1`；`current != previous` 且 `failures >= 2` 时：
  备份证据 → 交换 runtime → 翻 `current.json` → 写 `USER_ROOT/update/rollback.json`
  → 用上一版重启一次。首装/同版本重装无 previous ⇒ 第二次失败 terminal，不循环。
- runtime 交换：`runtime/node → runtime/node.failed-<stamp>`、`runtime/node.previous →
  runtime/node`；第二步失败则把第一步改回、**不翻指针**。⚠️ **Windows 实测订正**：
  “运行中的 exe 可以改名”只对 exe 文件成立；**包含运行中 node.exe 的目录不能改名**
  （Win11 ARM64 实测 EPERM）。因此 Windows 上由启动器创建独立计划任务
  `Estrella-Rollback-<pid>` 运行 `tools/rollback-restore.ps1`，等启动器退出后再交换
  runtime、写 `current.json`/`rollback.json` 并重启。直接 `spawn` 的助手会随启动器/
  桥的作业对象一起被杀（连日志都来不及写），所以不能省掉计划任务。`node.failed-*`
  在本次 launcher 运行期间删不掉时，留给下一次启动的保留策略清理。
- 安装事务：`versions/.txn.json` 的 entries 在**每个 rename 之前**落盘；断电后下一次
  安装能按 journal 恢复。若指针已是 journal.version 且版本目录合法，则按“已提交”
  收口，不把成功的新版回滚。仅测试环境变量 `QQBOT_INSTALL_TEST=1` +
  `QQBOT_INSTALL_FAULT=after-journal|after-backup[:n]` 可注入退出 97。
- 保留策略：`packaging/windows/tools/lib/retention.mjs` 只保留 current + previous；
  只删 `versions/` 与 `runtime/` 的直接子目录；未知名字、软链、无 current、正在运行的
  runtime 一律不动；健康成功后执行，删除失败只记日志。
- 离线更新（§8.8）：`panel/lib/update-offline.js` 两条写路由：
  `POST /api/update/offline/prepare`（manifest/sig base64，先验签后解析）与
  `POST /api/update/offline/installer`（原始 EXE，256 MiB 上限，先 size+sha256 再
  落 cache）。离线路径**不 fetch**；仍然只有 `ready` 且用户点“立即安装”才会运行安装器。
- 镜像：`installer.mirrors` 与 `installer.url` 都要求固定 tag，显式拒绝 `latest`。
- `/api/health` 在面板退出中返回 503；启动器只把 `200 + appId/version 匹配` 当健康。
- 契约 §110 + `test/installer-p4.mjs` 22/22 + `install-p4-1018` 变异 17/17；
  check-wb 113/113；路由 55/37；`WRITE_ROUTES` 33。

### P4 决策补充（规格未定义项）

1. **失败计数不设时间窗口**：只在健康成功后归零。隔一天再点一次仍算连续失败；
   否则“坏版本 + 隔天重试”会永远不回滚。
2. **回滚后 `previous=null`**：失败版本不再作为下一次自动回滚目标，从结构上消灭
   “回滚到已知坏版本”的循环。失败版本目录保留到本次回滚后的健康成功，再由保留策略
   清理；清理前把 `panel.log` 尾部、`current.json` 快照与原因写到
   `USER_ROOT/update/logs/rollback-<from>-<stamp>/`（**不复制 config.json**）。
3. **配置 schema 闸**：`package.json` 增加 `configSchema`；`config.json.schemaVersion`
   缺省按 1。上一版支持的 schema 低于当前配置 schema ⇒ 拒绝自动回滚，写
   `rollback.json.result=blocked`，提示 `USER_ROOT/config-backup-<previous>.json`。
   当前没有真正的配置迁移，因此不主动写 `schemaVersion`、不生成空备份；首个改 schema
   的版本负责写 `schemaVersion` 与备份。
4. **健康失败窗口**：单次健康轮询仍是 30 秒；没有“两次失败之间”的额外时间窗口。
5. **离线暂存**：`USER_ROOT/update/offline/pending/`；超过 1 小时未完成上传由
   `UPDATE.start()` 清理。离线 ready 仍复用 `<version>.json/.sig/.exe` 缓存，
   面板重启后由 `restore()` 复验。
6. **RC 口径**：P4 的“发布候选”指本地构建、待真机验收的 0.1.3 包/安装器，不涉及
   G5/G6；版本号仍由维护者按 G4 指定。

### VM 验收（Windows 11 ARM64 10.0.26200 · non-admin 用户会话 · 2026-10-18）

| 场景 | 结果 |
|---|---|
| P4 0.1.3 安装/health/数据 | ✅ exit 0 · current 0.1.3 · health ok · `p4-data-marker.txt` 保留 · runtime `.runtime.json` installedBy=0.1.3 |
| 坏版本两次失败自动回滚 | ✅ 缺 `panel/server.js` 计数 1；崩溃 server 第 2 次触发 → 计划任务助手交换 runtime → current 0.1.3 / previous null / health ok / `runtimeRestored=true` / versions 只剩 0.1.3 / 坏版本目录被清理 |
| 离线三件套升级 | ✅ prepare+installer 均 200 → `ready` · `source=offline`；同一 EXE 静默安装 → 0.1.4 / previous 0.1.3 / 数据标记保留 |
| 保留策略 | ✅ 播种 `versions/0.1.2` 被删；未知 `keepme`、`USER_ROOT` 标记、current/previous 全部保留 |
| 锁文件/缺资产明确错误 | ✅ 锁住 `runtime/node/node.exe` 后安装器 exit 2；current 不变；`.txn.json` 有 entries 且 status=failed、error=EPERM；安装日志可读；释放后 0.1.4 仍健康 |
| 窗口 | ⚠ VM 的 `run-hidden.vbs` 仍报 `ps-failed`（P3 已有环境问题，不是 P4 引入）；面板 `/api/health` 正常，不影响上述判据 |


---

## 19. P5 落地记录（2026-10-18）

P5 完成“正式发布收尾”的**本地部分**；GitHub 发布未执行（维护者明确“先不动”）。

### 19.1 正式更新密钥

- 新公钥：`resources/update-pubkey.pem`；
  指纹 `sha256:20a9a6b2f509fcedadb8544d8c41e4ef4a30e098c169fb36768fce2f73122f0d`。
- 私钥：`~/Desktop/estrella-dist/update-keys/p5-formal-2026-10-18/private.pem`
  （0600，仓库外；不打印、不入库、不入包、不进对话）。
- 旧 P3 验收公钥/说明已归档到同目录 `previous/`（旧指纹 `sha256:b1b7f3…`）；
  旧私钥目录原样保留，不删除。
- `resources/UPDATE-KEY-INFO.txt`：`purpose=P5 formal release`、
  `rotateBefore=2027-10-18`。
- **不发布过渡清单**：P3/P4 的 0.1.3/0.1.4 都是本地验收构建，从未公开发布，
  不存在持旧公钥的公开用户；直接换正式公钥即可。此条是对 §11.5“轮换需旧私钥
  签过渡清单”的**有理由偏离**，记录在此。
- 轮换入口：`keygen.mjs --rotate`（无该开关仍拒绝覆盖）；旧公钥/说明归档到
  `<out>/previous/`，`private.pem` 永远不允许覆盖。

### 19.2 0.1.3 正式清单与发布资产

- `make-manifest.mjs` 增加 `--allow-current`：只在 `version == package.json.version`
  时放行；更低版本仍拒绝。默认行为不变（测试/日常构建仍要求严格更高版本）。
- 正式清单：`version=0.1.3`、`appId=com.estrellabot.windows`、`channel=stable`、
  `minVersion=0.1.0`、`minWindows=10.0.17763`、固定 tag `v0.1.3`。
- `expiresAt=2027-10-18`（一年，P5 运维决定；默认 30 天只适合临时清单）。
- 新增 `packaging/windows/update/release-check.mjs`：原始字节验签 → 解析/校验 →
  版本/tag/文件名/size/sha256/`SHA256SUMS`/过期时间/私钥扫描。退出码 0/1。
- 发布资产目录：`~/Desktop/estrella-dist/release-v0.1.3/`，含
  `Estrella-Bot-Setup-0.1.3.exe`、`latest.json`、`latest.json.sig`、`SHA256SUMS`、
  `README-发布交接.txt`。**只准备，不上传**。
- 0.1.4 只作一次性升级验收目标（`p5-rc-0.1.4-test/`），不提交、不发布、不进 ③。

### 19.3 Authenticode

- 本轮没有代码签名证书：正式安装器**保持未签名**，SmartScreen 会显示“未知发布者”。
- Ed25519 清单签名只保证更新完整性，不等于 Authenticode；**不自签证书冒充**。
- 证书采购/签名仍是维护者的预算决定；不阻塞本次 0.1.3 本地发布候选。
- VM 用 `Get-AuthenticodeSignature` 记录真实状态（见 §19.5）。

### 19.4 发布边界

- **G5 已做**：④ → ③ 的压缩在本地完成。
- **G3/G4/G6 未执行**：不 push、不打 TAG、不建 Release、不发布到群/任何外部渠道。
- 最终产品版本固定 **0.1.3**（维护者指定）。
- 在线更新通道在 GitHub Release 上传 `latest.json` / `.sig` / EXE 之前不会生效；
  P5 验收的是**离线三件套 + 本地发布资产**，不把“在线检查失败”当产品缺陷。

### 19.5 VM 验收（Windows 11 ARM64 10.0.26200 · non-admin 用户会话）

| 场景 | 结果 |
|---|---|
| 新装正式 0.1.3 | ✅ 卸载旧程序（保留数据）→ `/S` 安装 exit 0 · `current=0.1.3` / `previous=null` · `/api/health` = 0.1.3 |
| 公钥指纹 = 新指纹 | ✅ 安装根 `resources/update-pubkey.pem` = `sha256:20a9a6…` |
| 0.1.4 离线升级（新私钥签名） | ✅ 面板 offline prepare 200 → `ready` 100% / `source=offline` → `/S` 安装 0.1.4 → `current=0.1.4` / `previous=0.1.3` / health ok / runtime `installedBy=0.1.4` / 数据标记保留 |
| 恢复 0.1.3 + 数据保留 | ✅ 卸载 0.1.4 → 安装正式 0.1.3 → `current=0.1.3` / `previous=null` / health ok / `versions` 仅 0.1.3 / 数据标记保留 / update `idle` |
| Authenticode | ⚠ `Get-AuthenticodeSignature` = `NotSigned`（预期；SmartScreen 会提示“未知发布者”） |

补充口径：
- 面板 `install {silent:true}` 只在 `QQBOT_UPDATE_TEST=1` 可用（生产有意禁止静默安装）；
  P5 VM 用同一份 0.1.4 EXE 直接 `/S` 完成升级验收，离线 prepare/ready 走面板 API。
- 0.1.3 正式清单的签名也在 VM 上被面板接受：prepare 返回“离线清单就是当前版本 0.1.3”
  （验签与校验已通过，仅被版本相等规则拒绝）。
- 验收后 VM 已恢复为最终 0.1.3；`USER_ROOT/update/cache` 为空、无 pending；
  `C:\Users\Public\p5-*` 为验收临时件，未删除。
  （**本节该行已被 §20.1 取代**：同一天的收尾清理把这些临时件删掉了。）

## 20. P5 收尾（2026-10-18 · 清理、私钥离线备份、代码签名与 Win10 裁决）

### 20.1 中间产物清理（维护者点名批准的 G7 删除）

删除范围只限**本安装/更新线产出的中间物**，删前逐条取证、删后当场复量：

| 处 | 删除内容 | 释放 |
|---|---|---|
| Mac `~/Desktop/estrella-dist/` | P2/P3/P5 构建暂存目录、P4 的 0.1.3/0.1.4 一次性构建（4 份）、`p4-rc-0.1.4-test`、`p5-rc-0.1.4-test`、`update-test-0.1.4`、过期 zip `Win-v0.1.3-pre-p3-*.zip`、`_archive/`（六天份旧包与日志）、`share-the-win/Estrella-Bot-napcat` 陈旧副本、两份额外 bridge.zip 备份、**已作废的 P3 密钥目录** | **3.63 GB** |
| Mac `~/Documents/UTM-Share/` | 传件通道残留：p2/p3/p4/p5 构建目录与 tar/tgz、一次性 `Estrella-Bot-Setup-0.1.4.exe`、正式安装器的通道副本、5 份 `.nsi` 草稿、调试日志与截图 | （含在上行同类别） |
| Win11 VM `C:\Users\Public\` | `p3` `p3-test` `p3-test-014` `p4` `p5-013` `p5-014` `p5-accept` `p5-oldkey` 与两份 `p5-*-build.tgz` | **≈1.20 GB**（按各项 du 求和 1227 MB） |

**删除前的证据（不是“看着像中间物就删”）**：

- `.nsi` 草稿可能与真机改动分叉（本仓出过“真机改了 9 个文件进了包没进 git”的事故）。
  逐份与仓库正本 `packaging/windows/installer/Estrella-Bot.nsi` diff，统计“只有 VM 侧才有的行”：
  v5 = 4 行、v2 = 5 行、v3/v4 = 3 行，内容全是**旧变体**（`.stage` 失败即 `RMDir` 的旧行为、
  已被英文替换的中文注释、v2 的 `!include version.nsh` 旧结构）⇒ 无未回搬逻辑，可删。
- 待删清单与保留清单在脚本里用**路径段级**互斥断言硬拦：任一目标落在保留项内即中止；
  正式私钥不在位也中止。
- VM 上 `Remove-Item -EA Stop` 被 tar 带过去的 AppleDouble 残名（`._.`）卡住并报
  `Could not find file`；改 `cmd /c rd /s /q` 仍剩 3 项，最后用 `-LiteralPath "\\?\C:\…"`
  前缀 + 重试清完。**Windows 删除长路径/怪名字要用 `\\?\`，不是加 `-Force` 就行。**

保留项（删后逐个复量在位）：④ `Estrella-Bot`、④b `Estrella-Bot-napcat`、`NapCat.Shell`、
③ `Win-v0.1.3.zip`、`release-v0.1.3/`、P5 正式密钥目录与其备份目录、`estrella-bridge` 本体与
VM 侧提权修复脚本。删后完整性：`release-v0.1.3/SHA256SUMS` 三条逐条 `OK`；
VM 复查 `current=0.1.3 / previous=null / health ok / versions 仅 0.1.3 / cache 0 / pending 0 / 1 个 node 进程`。

未纳入本次清理（**边界外，如实报告不动手**）：仓库内被 gitignore 的
`_archive/`（1.4 MB 旧备份）、`docs/*.png`（历史设计轮截图预览）、`test/mutations/review-*.mjs`
（其他轮的变异清单，删了会改 mutate-lint 基数）。这些不属于本安装/更新线。

### 20.2 正式私钥离线备份

现场事实（2026-10-18 实测）：无外置卷（`/Volumes` 只有 Macintosh HD）、
`tmutil destinationinfo` → **No destinations configured**、
iCloud 桌面与文稿同步关闭（`FXICloudDriveDesktop=0`，CloudDocs 无 `Desktop`）
⇒ 私钥既没有云端副本（好事：不会被误同步），也**只有 1 份**（坏事：单机单副本）。

落点：`~/Desktop/estrella-dist/update-keys/backup-2026-10-18/`

| 文件 | 作用 |
|---|---|
| `update-private-key.enc.json` | 私钥密文：AES-256-GCM，密钥由 scrypt(N=32768,r=8,p=1) 从口令派生，随机 salt/iv，authTag 内嵌 |
| `passphrase.txt` | 0600，32 字节随机口令的 base64（机器生成，不是人类密码）；**建议与密文分开保管** |
| `restore.mjs` | 零依赖恢复脚本（Node ≥ 18）；支持 `--verify` 与发布的公钥做同源性核对 |
| `README-离线保管说明.txt` | 复制到 U 盘、校验、分开保管、演练恢复的确切步骤与丢失后果 |
| `MANIFEST-SHA256.txt` | 复制后 `shasum -a 256 -c` 验字节未坏 |

反证（不能只测好路径）：正确口令 → 解出字节与 `private.pem` **逐字节一致**、指纹匹配
`sha256:20a9a6…`、`--verify` 对上 `resources/update-pubkey.pem`；
**错误口令 → exit 1** 且打印“解密失败（口令错误或密文损坏）”，不写任何文件。
私钥与口令全程不打印。

**还欠一步（只能维护者做）**：插上 U 盘后把该目录复制过去，并把口令与密文分放两处。

**订正（同日 2026-10-18 晚 · 维护者裁决）**：手上没有 U 盘，要求先把备份包放桌面。
已照做 —— 副本在 `~/Desktop/重要文件/自动更新的钥匙备份（丢了就没法推更新）/`（0700，密文与口令 0600，
5 个文件与正本**逐文件 sha256 一致**，另有 `先看这个-说明.txt` 写清性质；改名后恢复演练复跑过，
`shasum -c` 两条 OK、解出私钥与正本 `cmp` 逐字节一致）。
**再订正（同日更晚）**：维护者把这个副本目录从桌面顶层挪进 `重要文件/` 子目录（路径即上行）；
新位置复验 `shasum -c` 两条 OK、5 个文件与正本逐文件 sha256 全等，本文件与 `update/README.md`
的路径引用已同步改过。
但性质必须写清，别让下一个读到这里的人把「桌面有个备份文件夹」当成「已经备份过了」：

- 它**不是离线备份**：与正本在**同一块硬盘**上。防得住手滑误删 `update-keys/`，
  防不住硬盘坏 / 整机丢 / 重装格式化 / 勒索软件；
- 密文与口令在同一个文件夹 ⇒ 拿到这台开着的 Mac 的人等于同时拿到保险箱和密码条；
- 明文私钥仍然只有正本那 1 份（收尾全盘扫过：`~/Desktop`、`~/Documents/UTM-Share`、`/tmp`
  三处里真正含私钥本体的文件只有 `update-keys/p5-formal-2026-10-18/private.pem` 119 B/0600，
  其余命中全是代码里 `"PRIVATE KEY"` 这个检测字样和第三方测试夹具）；
- iCloud 桌面同步当前关闭（实测 `FXICloudDriveDesktop=0`、CloudDocs 无 `Desktop`）
  ⇒ 这份不会悄悄上云；**若哪天打开同步，桌面这个文件夹会跟着上传**，届时先挪走或删掉。
  真正的离线一份 + 口令分放，仍然是待办（不阻塞发布，随时可做，五分钟）。

### 20.3 Authenticode：能不能做、要谁做什么

工具现状（实测，不是推测）：VM 有 `makensis.exe`，**没有 `signtool`、没有 Windows SDK**；
Mac **没有 Homebrew、没有 `osslsigncode`**（只有 LibreSSL 命令行，没有 OpenSSL 头文件）。
⇒ 拿到证书之前，本机没有可用的签名工具链。

外部口径（微软官方文档 2026 版）：

- **EV 的“首次下载即获得 SmartScreen 信任”这一卖点在 2024 已被移除**；
  EV 与 OV 现在走同一套信誉累积。只为“跳警告”买 EV 不再成立（EV 只剩内核驱动 / WHQL /
  招标点名这三类刚需）。
- **Azure Artifact Signing（原 Trusted Signing）** 约 **$9.99/月**（基本档 5000 次签名/月，
  超出 $0.005/次；高级 $99.99/10 万），无需硬件令牌、可接流水线，但
  **地理资格限制：组织限美国/加拿大/欧盟/英国；个人开发者目前只限美国和加拿大**
  ⇒ 身处中国大陆的自然人**不符合资格**；大陆主体要走 CA 的 OV 证书。
- **OV 证书**约 **$150–300/年**（渠道报价区间更宽），CA 核验法律身份，
  2023-06 起 CA/B 论坛要求私钥存于 HSM/硬件令牌或云 HSM；
  新文件**仍会显示 SmartScreen 提示直到攒够信誉**，只是不再被标成“未知发布者”。
- 免费路线两条，都有硬前置：**Microsoft Store 的 MSIX** 通道由微软重签、全球可用、无警告
  （要换打包形态，我们现在是 NSIS EXE）；**SignPath Foundation** 给合规开源项目免费签，
  但署名是基金会而不是发布者本人，且构建要在它的流水线里跑（碰 GitHub ⇒ 属 G3/G4/G6 范畴）。
- **自签**：Windows 不信任，对外发布等于没签；本轮不做。

结论与分工：这是**预算 + 身份形态**的决定，AI 无法代办（要本人证件、企业/个人选择、付款与电话核验）。
维护者要做的是三选一：

1. **不签**（维持 P0 冻结的默认值）：成本 0，警告照旧。⚠️ 收尾实测：包内 `README.html`
   （源 `packaging/windows/launcher/README.html`）里 `SmartScreen` 与“仍要运行”字样
   **各 0 处**；VM 安装根的同一文件（10,260 B）也是 `SmartScreen`=0 / “仍要运行”=0 / “更多信息”=0
   ⇒ 目前**没有**任何面向用户的“怎么过这一步”说明。
   （⬆ 2026-10-18 快照；2026-10-25 已补：`README.html` 与 `README-installed.html`
   都加了 SmartScreen / SHA-256 说明，见下方追加裁决。）
   要补这句必须改那个源，并**整批重出** ④/④b/③/安装器/发布资产（README.html 在 payload 里，
   由 `install-commit.mjs:41` 的 `ROOT_FILES` 落到安装根；改了不重出 = 包与哈希不一致）；
   这是独立一轮的活，不在收尾里顺手做；
2. **买一张 CA 的 OV**（个人可申请的渠道存在，年均数百到千余元）：把证书形态交回给我，
   我把签名接进构建链并在 VM 上验收；
3. **走 Microsoft Store MSIX**：打包形态要改，属新阶段，不在 P0–P5 范围。

工程约束（若选 2，必须按这个顺序，否则哈希全废）：
`makensis` → **签名 + RFC3161 时间戳** → 计算 size/sha256 并写 `SHA256SUMS` →
生成 `latest.json` → 用 Ed25519 私钥签清单。签名会改变 EXE 字节，
所以 `release-check.mjs` 的 `installerSize/installerSha256` 必须在签名**之后**取。
两条路都不放松：清单验签与 Authenticode 是**两套互不替代**的机制（§19.3）。

**维护者裁决（同日 2026-10-18 晚）**：**暂不做签名**。0.1.3 以未签名形态发布/交付，
SmartScreen 那道「更多信息 → 仍要运行」由用户手点；这不影响已验收的安装、更新、回滚与数据链路
（P4/P5 全程都在未签名状态下真机跑通）。
遗留的实际缺口只有一个，且与证书无关：**包内说明没有教用户过这一步**（见上），
补它需要改 `packaging/windows/launcher/README.html` 并整批重出包与发布资产 ⇒ 另起一轮，
谁做都要按 `makensis → 签名(若届时签) → 取 size/sha256 → 出清单 → 签清单` 的顺序走。

**2026-10-25 追加裁决（最终）**：维护者明确**不签名**，P3-4 不按原判据
“签名后装机不拦”执行，改为“不签收口、风险接受”。源码侧已完成的是不依赖证书的部分：

- `README.html`（免安装 / 群包顶层）与 `README-installed.html`（安装版）都补了
  SmartScreen 的“更多信息 → 仍要运行”、用 `certutil` 核对 `SHA256SUMS.txt`，
  以及“未签名 ≠ 更新无校验（Ed25519 清单签名仍在）”的说明；
- `signing=none` 的构建回执保持；未签名产物在真实 Windows 上的基线已做可做部分
  （2026-10-25：SmartScreen 进程级拦截、Defender 0 威胁、隔离安装/卸载/AUMID 通过；
  360 / 腾讯管家未安装，未测；详见内部的 P3-4 基线验收记录）；
- 包内生效仍需按 `payload → 安装器 → SHA256SUMS → ④/④b` 重出，群包 / Release 另走 G5/G6；
- 未来若改主意：P3-5 的 CI 前置已具备，签名顺序仍是
  `makensis → 签名 + RFC3161 → size/sha256 → SHA256SUMS → latest.json → Ed25519`。

### 20.4 Win10 1809 真机验证：维护者裁决不做

2026-10-18 维护者明确“Win10 1809 真机验证不做”。§13 里该项就此**关闭**，
风险如实保留：清单字段 `minWindows=10.0.17763` 是**声明值**，没有真机证据；
Windows 7/8/8.1 与 32 位系统本就不在支持面（§3、§12）。
后续若收到 1809 现场故障，按 §18.6 的取证路径处理，而不是补一张“已通过”的表。

## 21. P6 落地记录（2026-10-18 · 协议端获取与离线放包）

维护者症状：勾选"下载 NapCat"后进度条**一直卡在最后一段**。取证结论（三条都是实测，不是推测）：

| # | 事实 | 证据 |
|---|---|---|
| 1 | NSIS 在 `nsExec` 跑外部进程期间**不推进进度条** —— 无论多久，屏幕上都是"卡死" | `.nsi` 的安装段结构 + 对照包（SnowLuma 内置、安装期零联网）秒装 |
| 2 | 协议端下载默认**勾选**，且是唯一路径 | 旧 `.nsi:73`/`:133`（本轮已改，见 §16 Errata 第 7 条） |
| 3 | 那台 Windows 11 测试机上 `gh-proxy.com` **229,064 B/s**（3,000,001 B / 13.097 s）、`ghproxy.net` **46,919 B/s**（1,173,044 B / 25.003 s，且在 25 s 处被 `--max-time` 截断，rc=28），`github.com` 与 `api.github.com` **0 字节、rc=6（DNS 直接失败）** ⇒ 35,884,742 字节的官方包按第一候选 ≈ **2.6 分钟**、按第二候选 ≈ **12.7 分钟**（**两个镜像差 5 倍**） | 探针原文见本节末尾代码块（同日 18:47 实跑；共享盘上的 `napcat-speedtest.txt` 是它的出处） |

### 21.1 做了什么

- **一等路径改成"我已经下好包"**：安装器新增自定义页 `NapCatPage`，四条来源
  `skip`（默认）/ `zip` / `folder` / `auto`（联网下载）。选路径全程走
  `nsDialogs::SelectFileDialog` / `SelectFolderDialog`，**不要求用户手打路径**。
- **离线放置引擎** `tools/lib/napcat-local.mjs`：暂存到 `<InstallRoot>\userdata\napcat.new-<ts>` →
  验启动器在位 → `overlay(..., {preserve: config})` 提交；**只复制，绝不动用户选中的原件**
  （契约 §114 用正则盯住 `rmSync/unlinkSync/renameSync(src…)`）。
- **选取安全**：盘根、`%USERPROFILE%`、桌面、`%WINDIR%`、安装根/用户根/napcat 目录及其内部、
  UNC、>240 字符一律拒绝（`pathEq` 与 `pathInside` **两条都用** —— 后者把"相等"判 false）。
- **联网下载加固**：连接超时 12s、空闲（断流）超时 20s 且**每收到一块就重新计时**、
  存活速率下限 15KB/s、单源预算 150s、总预算 300s；续传必须核 `Content-Range`；
  超时/超预算以 `DOWNLOAD_BUDGET` / `DOWNLOAD_SLOW` / `DOWNLOAD_FAILED` 明确转交，不挂死。
- **既有缺陷修掉**：手放的包只要不是 `fallbackTag` 那一版就被判"校验不过"——
  查找方向翻成**按 sha256 反查 `knownGood`**，命中才有版本，未命中写 `tag:""` 且状态 `UNVERIFIED`，
  不再冒充"已知好版本"。
- **群文件离线包**：`scripts/check-napcat-kit.mjs` 只读自检（原件字节哈希必须命中
  `napcat.json` 的 `assets[].digest` 且在 `knownGood`、体积下限、许可全文与出处文件在位），
  `--offline` 故意失败，防"拿联网当自检"。

### 21.2 门禁与反向证据

| 门禁 | 实测 |
|---|---|
| `scripts/check-wb.mjs` | **114 段全绿**（§114「NapCat 获取与离线放包」为 P6 新增） |
| `test/installer-p6.mjs` | **25/25**（环回假服务器实测正常下载、断流+回退、总预算、坏 `Content-Range`、真续传、体积不符、哈希自愈、截断；zip / folder 两条离线路径**全程零 API 请求**、用户原件字节不变） |
| `test/mutations/install-p6-1019.mjs` | **18 条 = 17 变异 + 1 对照，18/18 符合期望**，还原后工作树 == pristine |
| `check-nsi.mjs` | 四条反向证据：原样不报 / 默认改 `auto` → 点名 `"auto"` / 删默认行 → "实测 0 条" / 加第二条 → "实测 2 条（skip、auto）" |

### 21.3 Errata：一条假绿（M13 第一次跑没红）

`check-wb` 原判据写作 `!/StrCpy \$NapcatMode "skip"/.test(nsiText)` —— 问的是"全文里出现过
`skip` 没有"。`.nsi` 里这条赋值有**三处**（`.onInit` 默认值 / `/NAPCATSKIP` 分支 /
`NapCatPageLeave` 兜底），变异把**默认值那一条**改成 `auto` 之后，另外两条原地不动，判据照样点头。
⇒ **用户症状的元凶恰好是唯一没人盯的属性**。

「默认」是**位置**属性、不是内容属性：全文包含式断言永远分不清"哪一条是默认"。
修法（`check-wb` §114 ⑪ 与 `check-nsi` 同步）：取 `Function .onInit` → 首个 `${GetParameters}`
之间的窗口，要求其中**恰好 1 条** `$NapcatMode` 赋值且值为 `skip`；窗口取不到时报红而非静默通过。

⚠️ 可复用的形状：**凡断言"某处的值必须是 X"，先数这个字面量在文件里出现几次。**
≥2 次 ⇒ 全文 `test()` 等于没断言，必须换成"取作用域窗口 + 计数"。

### 21.4 构建与验收路线（本机环境事实）

`Z:`（UTM 共享盘）**单文件读取上限实测约 47.7 MiB**：`node.exe` 86,973,768 字节跨盘 robocopy
返回 `rc=9`，第一次 `makensis` 因此产出 **3,237,456 字节的假 EXE**（健康值 0.1.3 ≈ 25.6 MB）。
更坏的副作用：卡住的那次传输把桥的**用户通道串行队列**堵死 —— agent 进程内没有子进程可杀，
`exec hostname --role user` 150s 仍超时，只能从 system 通道
`Stop-Process -Id <user-agent>` + `schtasks /run /tn EstrellaBridge-User` 才恢复。

⇒ 正解（零跨盘大文件）：小文件走 `Z:`，**runtime 在 VM 本机**从
`%LOCALAPPDATA%\Programs\Estrella-Bot\runtime\node` 填进 `stage\runtime\node` 再 `makensis`。
两侧 `node.exe` 的 sha256 实测同一个值
`9c9245166b4a8e182e0b797da9c20136117ff24368eaff1fec8343a123c8db0e`（v22.23.3），
与 `installer/toolchain.json` 的 pin 一致 —— 所以本机填 runtime 不是"随手找个 node"，
是同一份钉住的字节。

⚠️ **订正（2026-10-21 · 桥已加固）**：上面「用户通道被堵死、只能从 system 通道杀进程」的处置已成历史。
桥 agent 现在把每条 `exec` 放进**独立子进程**并带超时（默认 600s，最小 5s），超时 `taskkill /T /F`
杀整棵进程树；实测连续 3 轮「超时后立即 hostname」均正常，不再需要另一条通道去救。
另：`where makensis` 在 PowerShell 里是 `Where-Object` 的别名，恒返回空 + exit 0，
**不能**用来判断 NSIS 装没装 —— 用绝对路径 `Test-Path` 或 `Get-Command`。
（详见技能 `win-mac-bridge-ops` §2b/§9；本机真实路径 `C:\Program Files (x86)\NSIS\makensis.exe`，v3.13。）

### 21.5 探针原文（第 3 行那条事实的出处，逐字节照录）

命令形态：对四个源各取 `Range: bytes=0-2999999`、`--max-time 25`。
⚠️ 探针的 `-w` 里 `curl_errcode` 这个变量名写错了（curl 报 `unknown --write-out variable`），
   所以 `err=` 列只在 curl 自己失败时才有值；`code` / `bytes` / `sec` / `Bps` 四列是有效实测。

```text
NapCat source speed probe (3 MB range, max-time 25s) 
start=Sun 10/18/2026 18:47:27.23 
--- api.github.com 
curl: unknown --write-out variable: 'curl_errcode'
code=000 bytes=0 sec=0.019325 Bps=0 err=curl_exitcode=6 
 
--- mirror gh-proxy.com 
curl: unknown --write-out variable: 'curl_errcode'
code=206 bytes=3000001 sec=13.096806 Bps=229064 err= 
--- mirror ghproxy.net 
curl: unknown --write-out variable: 'curl_errcode'
code=206 bytes=1173044 sec=25.003105 Bps=46919 err=curl_exitcode=28 
 
--- direct github.com 
curl: unknown --write-out variable: 'curl_errcode'
code=000 bytes=0 sec=0.016951 Bps=0 err=curl_exitcode=6 
 
done=Sun 10/18/2026 18:48:06.13
```

### 21.6 VM 验收（2026-10-18 · Windows 11 ARM64 10.0.26200 · non-admin 用户会话）

候选件：`Estrella-Bot-Setup-0.1.3.exe` · **25,613,131 B** ·
sha256 `a3d213ae4c8cc4139b8cab23ed0bde468df2ae9caec120782dfe7ae7320254f2` ·
payload r4（2208 文件 · `commit=47dfb7f` · `worktree=clean`）· makensis 3.13 **零警告**。

| # | 场景 | 结果（实测） |
|---|---|---|
| T1 | 全新安装 `/S`（什么都不勾） | exit 0 · **32.3s** · `napcat-status.txt` = `SKIPPED {"mode":"skip"}` · **不产生 `userdata\napcat`** |
| T2 | 全新安装 `/S /NAPCATZIP=<官方 v4.18.38 zip>` | exit 0 · **39.1s** · `OK {"tag":"v4.18.38","verification":"official-digest"}` · 686 文件 · 启动器在 `napcat\launcher-user.bat` · 全程离线 |
| T3 | 全新安装 `/S /NAPCATFOLDER="<路径含空格>"` | exit 0 · **31.4s** · `UNVERIFIED`（目录形态没有整包哈希，按设计）· 启动器在根 · **带引号 + 空格路径可用** |
| T4 | 全新安装 `/S /INSTALLNAPCAT`，慢网 | exit 0 · **183.5s** · `SLOW {"code":"DOWNLOAD_SLOW"}`，逐镜像写明：gh-proxy 单源预算用尽 / ghproxy `ETIMEDOUT` / github `EAI_AGAIN` —— **不再无限挂起** |
| T5 | 覆盖安装（同版本） | exit 0 · 38.4s · `data\reinstall-marker.txt` 与 `config.json` 均在（保留成立） |
| T6 | 默认卸载 `/S` | exit 0 · 安装目录清空 · `userdata`、`.estrellabot-user-root`、`config.json` 全保留 |
| T7 | 卸载 `/S /DELETEUSERDATA` | exit 0 · 安装目录、`userdata`、标记一起清掉；随后 `/S` 重装成功 |

仍**未**实跑：GUI 向导的鼠标点击路径（本会话无法向 Windows 注入输入；同一套逻辑已由
`/NAPCATZIP=` `/NAPCATFOLDER=` 静默路径 + `check-nsi` 静态判据覆盖）。GUI 窗口能起、
标题正确（`Estrella Bot Setup`），但截图里不可见（窗口在代理会话的桌面之外）——如实记录，不冒充"看过"。

### 21.7 Errata：VM 验收抓出的三个"能编译、能安装、但功能静默失效"

| # | 形状 | 怎么发现的 | 修法 |
|---|---|---|---|
| 1 | `nsDialogs::Select*Dialog` 的初始目录写成 `"$DOWNLOADS"` —— NSIS 3.13 **没有**这个 shell 常量 | makensis 警告 6000（两条），EXE 照出 | 改 `"$PROFILE\Downloads"`；`check-nsi` 与 §114 禁止 `$DOWNLOADS`；**M17** |
| 2 | `${GetOptions}` 实测返回 **`=value`**（带等号），`.onInit` 直接把它当路径 | `/S /NAPCATZIP=` 装完 `REFUSED`；用 `WriteINIStr` 把解析结果打进临时文件才看见 `path==C:\...` | 两个开关都先剥前导 `=`、再剥一对包裹引号；两套门禁要求 ≥2 处 strip；**M19** |
| 3 | zip/目录里套着一层包装目录时不压平：`flattenSingleDir` 只**返回**内层路径，提交时却 `rename(staging)` 整棵搬进去 | T2 装完 `userdata\napcat\NapCat.Shell\launcher-user.bat` —— 装得上、起不来 | 两条分支统一从"含启动器的那一层"`overlay` 提交；`installer-p6` 里那条**期待子目录**的旧断言正是把错行为钉住的那一条，已改成"启动器在 napcat 根" + 新增"选外层目录也要压平" |

> ⚠️ 三条的共同形状：**静默参数 / 常量名 / 目录层级**这三类东西，编译器和静态门禁都只保证
> "形状对"，不保证"语义对"；只有把真 EXE 放进真 Windows、走一遍真参数才看得见。
> 结论：`check-nsi` 再全，也不能替代 VM 上的 4 条路径实跑。

## 22. P7 落地记录（2026-10-18 深夜 · 群友测试回执五项整改）

群友测试结论：有包路（已解压目录）快且稳；无包路下载完也能进。回执五条，逐条落地：

| # | 回执 | 根因（实测/读码） | 修法 | 提交 |
|---|---|---|---|---|
| 1 | 启动先出一个**灰色空窗**，还要再双击一次 | `launch.mode=window` 走 Edge `--app` + **专用 profile**：新 profile 的首跑 UI（同步/登录卡）+ 空白页一起出现；launch-log 里 `opened=true` 但屏幕上没有可用窗 | 安装版首装默认改 `browser`（用户自己的浏览器 profile，无首跑 UI）；`window` 保留为可选设置 | `06adc97` |
| 2 | NapCat 页的 zip 按钮"没有用" | 群友实际走通的是文件夹路；zip 按钮是一条走不完的视觉承诺 | 按钮删除（维护者点名）；选到 `.zip` 时弹"请先解压"并 Abort；静默 `/NAPCATZIP=` 保留给脚本 | `69052ec` |
| 3 | 「结束本次运行」留残骸 | `apiOnekeyStop` 只停机器人/模型/容器，**面板自己**与它开的窗口没人收 | 收尾段：关窗（先校验命令行含 `--app=` 与端口）→ `server.close` → `process.exit(0)`；前端切"已退出"卡片 | `61da94a` |
| 4 | 安装器是英文 | — | MUI 双语 English+SimpChinese，`.onInit` 里 `MUI_LANGDLL_DISPLAY`（安装一开始选语言）；32 条用户可见字符串 LangString 双份 | `15a0277`+`0e9097e` |
| 5 | Mac 点图标拉不起控制台 | 陈旧单实例锁容忍窗 **5 分钟**：持锁者死后每次点击都只开空白页；且面板没起来也照开页面 | 容忍窗 45 秒 + 等不到就自己接手启动；面板没起来**不开页面**、notify 带日志路径；顺手修掉 `$( )` 里 case 的 `)` 被当替换结束括号（STALE 守卫从 2026-09-17 起恒空）；`.app` 重签 | `df8e4a9` |

### 22.1 门禁增量

- 变异 **705 → 711**（M20 默认 mode、M21/M22 真退出、M23 zip 按钮回潮、M24 删 SimpChinese、M25 锁容忍窗回 5 分钟），p7 清单 6/6 符合期望。
- `check-nsi` 的"ASCII-only"闸改为真正要防的两件事：带非 ASCII 却没有 `Unicode true`、以及 BOM。
- §114 新增：默认 `launch.mode=browser` 双向判据、zip 按钮三件套禁回潮、`/NAPCATZIP=` 静默开关必须在、SimpChinese+语言选择必须在。
- launcher 节新增四条：45 秒容忍窗 / TAKEOVER 分支 / 没起来不开页 / 禁止 `$( )` 里的 case。

### 22.2 已知未覆盖

- GUI 的鼠标点击路径仍未自动化（无法向 Windows 注入输入）；语言选择框与中文渲染以
  makensis 零警告 + 静默四路实跑为证，**没有**中文界面截图 —— 如实记录。

---

## 23. P8 落地记录（2026-10-19 · 群友真机回执「选中文后全乱码」）

### 23.1 回执与根因

| 回执 | 根因（VM 实测） | 修法 | 提交 |
|---|---|---|---|
| 选中文后**自定文案全是乱码**（MUI 自带文案正常） | `Estrella-Bot.nsi` 是 **UTF-8 无 BOM**：makensis 3.13 无 BOM 时按**构建机 ACP** 读源码（英文 Windows = CP1252），中文 LangString 以乱码烤进中文语言表；MUI 自带文案不乱因 `SimpChinese.nsh` 自带 BOM | `.nsi` 加 UTF-8 BOM；check-nsi 与 check-wb §114 判据翻转为「含非 ASCII 必须带 BOM」 | `4fc1465` |

**对照探针（C:\p8-probe，同源码有/无 BOM 各编一版，makensis 3.13 同一台构建机）**：

- string pool：无 BOM **1188 B** / 有 BOM **1136 B**，差 **52 B** = 4 B 文件名（`probe-nobom.txt` 比 `probe-bom.txt` 长 2 字 ×2B）
  + **48 B = 12 个 CJK 字被误读成 36 字 ×2B** —— 与 CP1252 单字节误读定量吻合。
- 真 exe 重编后小 **3,232 B**（25,618,045 → 25,614,813）：正确中文比乱码短，方向一致。

**⚠️ 订正（只增不减）**：P7 的 check-nsi 判据「BOM 坏（makensis 会把 EF BB BF 当指令的一部分）」
系**未经实证的猜测**，与实测真相相反；本轮翻转为「含非 ASCII 必须有 BOM」。旧表述留存在
CONTRACTS-HISTORY P7 行与本节。

**探针路上逮到的三个 NSIS 语义坑（都实测，别当猜测引用）**：

1. `.onInit` 里 `StrCpy $LANGUAGE 2052` **不能**让当次读取走中文表：.onInit 结束后 NSIS 重跑语言探测，
   且 .onInit 期间的 $( ) 读取用初始语言；Section 里改 $LANGUAGE 亦无效（文档：该变量只许在 .onInit 改）。
2. `LangString` 的数字语言 id（`2052`）在本探针里**静默不进表**（运行时回落到第一语言表且编译零警告）；
   用 `${LANG_SIMPCHINESE}` 常量才进表。真 .nsi 一直用常量，未受波及。
3. `/LANG=2052` 在本构建（MUI_LANGDLL_DISPLAY 在位）**不跳过语言对话框**；VM 上选中文改用
   `WScript.Shell.AppActivate + SendKeys`（桥自己不能注入键鼠，但 exec 里可以）。

### 23.2 门禁增量

- 变异 **711 → 714**：M26 剥 BOM（新判据）· M27 删 `Unicode true` · C1 对照；p8 清单
  `test/mutations/p8-i18n-enc-1019.mjs` 实测 **3/3**（M26/M27 BLOCKED、C1 NOT-BLOCKED）。
- mutate-lint：**81 份清单 / 714 条 / 失效 0 / 惰性 0**；check-wb **114 段**全过；check-nsi 对带 BOM 真树
  exit 0、对剥 BOM 副本 exit 1（双向实证）。
- check-nsi / §114 新判据同文：含非 ASCII 且无 UTF-8 BOM ⇒ 阻断（消息里写明构建机 ACP 机制）。

### 23.3 真机/VM 验收（r6）

- 构建：`C:\p6-build-r5`，makensis 全路径，**零警告**；2 个语言表（868 B）。
- GUI 目测（英文 Windows VM，`AppActivate + SendKeys` 选中文后逐页截图）：
  欢迎页 / 许可页 / **NapCat 自定义页全为正常中文**（含自定 LangString：
  「QQ 协议端（NapCat）」「选择已解压的文件夹…」「手上没有包 —— 现在下载」等）；
  截图存 `/tmp/p8-shot-zh2.png`、`/tmp/p8-shot-nap.png`、`/tmp/p8-shot-nap2.png`（本机留档）。
  ⇒ §22.2「没有中文界面截图」一项**本轮已覆盖**（旧行按只增不减保留）。
- 产物：`Estrella-Bot-Setup-0.1.3.exe` **25,614,813 B**，
  sha256 `c3214e6064b9e642430b289a5c978eb5a6d9c9295328aa4bf5b38291b920e86d`；
  已落 `~/Desktop/estrella-dist/群友测试-2026-10-18/`（旧 r5 移入 `superseded-r5/`，未删除），
  SHA256SUMS.txt 与 README-怎么测.txt 同步刷新。发群（G6）仍由维护者手动。
- ④/④b 不受影响：.nsi 不在 payload 白名单内，便携包无需重出。

---

## 24. P9 落地记录（2026-10-19 · 群友回执三条：排版/二选一/下载提示/详情乱码）

### 24.1 回执与修法

| # | 回执 | 修法 | 提交 |
|---|---|---|---|
| 1 | NapCat 页字太松散、不美观 | 重排：intro 30u → 选项块 34/50/66u → 下载块 94/108u → 尾注 132u（内页客户区约 144u，150u 会被裁）；两块选项各自「控件 + 路径行 + 说明」成组 | `0bddcd6` |
| 2 | 什么都不选也能点「下一步」 | 未选时 `GetDlgItem $HWNDPARENT 1` + `EnableWindow 0` 置灰；两路线 `NSD_OnChange` 互斥并同步 Next；进页先 `Call NapSyncNext`；leave 兜底 `NAP_MSG_CHOICE`；`/INSTALLNAPCAT` 等显式开关进页预勾选 | `0bddcd6` |
| 3 | 下载时看不出在下载 | mode=auto 时页眉副标题 `WM_SETTEXT` 成 `$(DL_HINT)`「正在下载 NapCat（约 34 MB）…」+ `DetailPrint` 横幅；结束恢复 `$(INST_SUB_RESTORE)` | `0bddcd6` |
| 4 | 进度条详情里一堆乱码 | 根面：nsExec 按**系统码页**解码子进程字节 ⇒ 安装链路五工具（install-commit / bootstrap / stop / lib common / lib napcat-local）输出行全改英文；ASCII 化原语 `installerAscii` 单份住 install-layout.mjs（bootstrap 须在 import common 前设环境），`.onInit` 设 `ESTRELLA_NSIS=1`；✓/✗ 记号换 `[ok]`/`[x]` | `0bddcd6` |

### 24.2 门禁增量

- 变异 **714 → 719**：M28 删置灰行 · M29 摘 sanitize · M30 输出行塞回中文 · M31 删下载页眉提示 · C1 对照；
  p9 清单 `test/mutations/p9-napcat-ux-1019.mjs` 实测 **5/5**。
- §114 与 check-nsi 同判据加牙：NapSyncNext（GetDlgItem+EnableWindow 0/1）· 两路线 NSD_OnChange ·
  Show 前 Call · DL_HINT/WinMessages/ESTRELLA_NSIS · leave 兜底 · 五工具输出行无中文 · installerAscii 单份。
- 全栈：check-wb 114 段 · mutate-lint 82 份/719/0/0 · installer p1–p6（22/19/–/22/9/25）·
  smoke 467/467 · 沙箱 210/0 · panel-boot / panel-dom exit 0。

### 24.3 本轮编译/验收坑（都已修，见 `6e51dc0` 与本节）

1. `LangString` 字符串里的 `\"` 不被 NSIS 接受（"expects 3 parameters, got 14"）⇒ 内嵌引号改用单引号界定。
2. nsDialogs 只有 `${NSD_OnChange}`，没有 `NSD_OnChanged`（"Invalid command"）。
3. **只换 .nsi 不换 stage** ⇒ 装出来的工具还是旧的，详情照旧乱码（验收一度误判修法无效）；
   stage 必须随 payload 重出（make-installer-payload → zip → 桥 put → robocopy /XD runtime 合并）。
4. makensis「Can't open output file」= 上一个安装器进程（结束页没关）还握着 exe；编译前必须 taskkill。
5. 结束页的「运行 Estrella Bot」默认勾选：验收收尾一律 taskkill，不点「完成」，避免 VM 里拉起应用。

### 24.4 VM 验收（r7）

- 构建：`C:\p6-build-r5`（stage 已随 P9 重出），makensis 零警告零错误；
  产物 25,618,188 B，sha256 `7049d1345740bfac3c45b90fc9297ae6ad01909ad9c7cad0e07e9dbd7234b33c`。
- 截图（英文 Windows VM + SendKeys 选中文）：
  ① NapCat 页未选时「下一步(N)」明显置灰（`/tmp/p9-shot-nap-grey.png`）；
  ② 下载中页眉副标题 = 「正在下载 NapCat（约 34 MB）：请稍候，不要关闭安装器…」+ 详情首行横幅
     （`/tmp/p9-shot-dlhint2.png`，该轮 stage 未换，子进程行仍旧——恰好留下前后对照）；
  ③ 换 stage 后安装中段详情：NSIS 自带行正常中文、系统消息英文、**无任何乱码**（`/tmp/p9-shot-eng.png`）；
  ④ 字节级实证：VM 上以 `ESTRELLA_NSIS=1` 直跑已安装 stop.mjs，stdout 为纯 ASCII 英文
     （`stopping app: …` / `user data root: …` / `- panel port not listening` / `[ok] app stopped`）——
     这正是 nsExec 喂给详情框的字节，任何码页下都同形。
- 交付：`~/Desktop/estrella-dist/群友测试-2026-10-18/Estrella-Bot-Setup-0.1.3.exe` 已换 r7；
  r6 移入 `superseded-r6/`（未删除）；SHA256SUMS.txt 与 README-怎么测.txt 同步。发群（G6）仍维护者手动。
- ④/④b 不受影响（.nsi 与安装器工具链不在便携包 payload 白名单内？tools/ 在 payload 内但内容仅英文文案
  变化，便携包不跑 nsExec，无乱码面；是否重出 ④ 由维护者定）。

### 24.5 r8 回滚（2026-10-19 · 维护者点名）

维护者点名：P9 四条里**还原两条**——① NapCat 页排版重排、② 未选置灰的强制二选一——
回到 P8 快照（`24b213b`）；**保留**③ 下载页眉提示与④ 详情英文化。

- `95e94b8`：.nsi 以 P8 为基重建（页面回 40/46/62/62/78/108u；删 NapSyncNext /
  NSD_OnChange / 预勾选 / leave 兜底 / NAP_MSG_CHOICE / NAP_DL_NOTE / NAP_FOOT），
  仅重新接入保留的两条（WinMessages include、ESTRELLA_NSIS、DL_HINT/DL_BANNER/
  INST_SUB_RESTORE 与页眉 WM_SETTEXT 块）。
- `4cf7c1d`：修还原脚本自伤——把 intact 的 `${…}` 二次加成 `$${…}`（makensis 警告
  7025/6030）；以 P8 基干净重拼后零警告。
- 门禁同步撤除：§114 与 check-nsi 去掉置灰/二选一判据（保留下载提示与 ASCII 化判据）；
  p9 清单撤 M28/C1（留 M29/M30/M31，3/3）；p7 M23 与 install-p6 M14 锚点回 P8 坐标。
  变异 719 → **717**；mutate-lint 82 份/717/0/0；check-wb 114 段；check-nsi exit 0。
- VM 验收（r8）：零警告零错误；截图 `/tmp/r8-shot-nap3.png` = P8 布局 + 未选时
  「下一步(N)」**可用**（还原生效的直接证据）+ 中文渲染正常。
- 产物：25,620,004 B，sha256 `040e9c1883d0b5ebe36f5394951bb23bd6ef2e7fb39bed1fd0604b54770606ee`；
  交付目录已换 r8（r7 入 `superseded-r7/`，未删除）；SUMS/README 同步。
- ⚠️ 验收坑补遗：升级安装时若 `userdata\napcat` 已存在，NapCat 页整页 Abort（看不见）；
  要截图该页必须先清 `userdata\napcat` 与 `userdata\update`。

---

## 25. P10 落地记录（2026-10-19 · 群友回执「一键启动在哪」）

### 25.1 回执与根因

群友装完在文件夹里找「一键启动」找不到；README 与错误提示在指不存在的东西；协议端没装时
控制台跌进 Docker 分支冒出「没找到 Docker Desktop」。四个根因：

| # | 根因（读码 + VM 实测） | 修法 | 提交 |
|---|---|---|---|
| 1 | 安装版 README.html 拷的是便携版文案（一键安装.bat / 2-START.bat / 解压路径在安装版里不存在） | 新增 `README-installed.html`（桌面图标→扫码→一键启动的真实链路），payload 拷它；便携版不动 | `50d13a3` |
| 2 | 桌面图标只起控制台，协议端要用户自己管 | 面板 installed 形态 listen 后 `autoStartNapcatIfInstalled()`：nativePresent 且 3001 未听才用隐藏 vbs 拉起（无黑窗/无任务栏），不 await 不拖首屏 | `50d13a3` |
| 3 | `apiNapcatRestart` 在 Windows 协议端缺失时跌进 `ensureDocker` | IS_WIN 未装 → 如实 400「协议端未安装」+ 出路；容器分支只留 macOS | `50d13a3` |
| 4 | 换码/二维码提示硬编码「先双击一键安装.bat」 | 按 `MODE === 'installed'` 分流：安装版指向安装器 / userdata\napcat | `50d13a3` |

验收途中另逮一条**存量真机 bug**：`maybeSyncModelCatalog()` 是同步永不抛的叶子，
启动路径却挂着 `.catch(() => {})` ⇒ 真机每次启动红一条「未处理 Promise 拒绝」
（沙箱回归跳过该行所以一直没吭声）。改 `setImmediate` 调用并钉进门禁 —— `807fba1`。

### 25.2 门禁

- §114 新增：payload 拷 README-installed（判**调用本体**，只 test 文件名会被注释喂绿 —— M32 实测逮到这条假牙后修正）·
  README-installed 禁三词含两词 · 自起钩子在且调 startNativeNapcat · apiNapcatRestart 区间含守卫且如实 return ·
  `MODE === 'installed'` ≥4 处 · maybeSyncModelCatalog 不许挂 .catch。
- 变异 **717 → 723**（M32–M36 + C1），p10 清单实测 **6/6**；mutate-lint 83 份/723/0/0；check-wb 114 段。
- 全栈：installer p1–p6 · smoke 467/467 · 沙箱 210/0 · panel-boot · panel-dom 全 exit 0。

### 25.3 VM 验收（r9）

- 静默装 r9（含一次「上次被 taskkill 打断的事务恢复」顺带踩过）→ 清干净进程 →
  `Invoke-Item "Estrella Bot.lnk"`（模拟双击桌面图标）→ 35 秒内：
  `PANEL=True · NAPCATPROC=1 · WEBUI6099=True`；面板日志只有「控制台已启动 / ✔ 已拉起协议端」，
  无拒绝红线；截图无黑窗、任务栏无 NapCat 项（`/tmp/p10-icon-shot.png`）。
- 装内 README.html 与仓库 `README-installed.html` **逐字节同哈希**（e27d00ad…）。
- ⚠️ 桥验收坑：`/NAPCATFOLDER="带空格路径"` 经 `cmd /c "exe" …` 会被引号拆丢（status 变 skip）——
  必须落成 ASCII+CRLF 的 .cmd 文件再跑；PS5.1 `Get-Content` 对无 BOM UTF-8 的中文 -match 不可靠，
  比对文件一律走 SHA256。
- 产物：25,617,901 B，sha256 `b237c50cbc2561b526ffc4029686f1d80f2c533c5269d2b22c380d3074692102`；
  交付目录已换 r9（r5–r8 归入 `superseded/`，未删除）；SUMS/README 同步。发群（G6）仍维护者手动。
