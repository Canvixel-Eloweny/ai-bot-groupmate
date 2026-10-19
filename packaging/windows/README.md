# Windows 便携版 —— 构建素材（第 59 轮入库）

这里放的是 **Windows 免安装包的构建素材与构建脚本**。

> **2026-10-17 方向**：Windows 主分发形态转为 NSIS EXE 安装向导（按用户安装、独立窗口、
> 用户点击更新、数据与程序分离）。本文件的便携 zip 流程保留为备用/VM/离线通道，
> 不再是主路径。冻结规格见 `INSTALLER-SPEC.md`，路径证据见 `PATH-AUDIT.md`。

## P1 数据分离（2026-10-18）

- 便携包首次运行会把旧 `app/` 里的数据**只复制**到 `userdata/`（`tools/migrate.mjs`）；
  源目录不移动、不删除，失败保留原样。
- `config.json`、`panel/` 运行态、`data/`、`plugins/`、`skills/`、`persona/`、`napcat/`
  全部在 `userdata/`；`app/` 只放程序。
- NapCat 整树（含 `config/` 与 `QQ/` 登录态）在 `userdata/napcat`；升级不碰它。
- 安装版 `versions/<ver>` + `current.json` + NSIS 留给 P2；本文件仍是便携构建手册。

## 为什么会有这个目录

它们此前**只存在于 WorkBuddy 的一个会话目录**（`win-build/final6/_build/`），
不在任何版本控制里。后果很具体：

- 那个会话目录一被清理，**就再也打不出 Windows 包了**。包里那份不会告诉你它对应哪次改动。
- 第 58 轮在 Windows 真机上改的 9 个文件就是这样：**进了包、却没进 git**，
  在工作树里躺成 9 个未提交的 `M`（第 59 轮才补提交为 `db67869`）。

入库解决的是**可重建性**。它与"要不要对外发布"是两件事 ——
⚠️ **2026-10-15 起 `packaging/` 随公开拷贝发布**（`scripts/make-publish-copy.mjs` 已不再整块排除它）；
但它仍会被 `make-app.mjs` 从包内 `app/` 剔除，不会出现在安装 payload 里。

## 目录

```
packaging/windows/
  README.md            本文件
  INSTALLER-SPEC.md    ★ P0 冻结的安装/更新架构（P1 起按它实现）
  PATH-AUDIT.md        P0 路径审计（程序根 vs 用户数据根）
  update-manifest.example.json  更新清单字段示例（占位值，不是发布文件）
  make-app.mjs         ★ 生成**包内**的 `app/`（对外拷贝 + 剔除 `app/packaging/`，见第 1 步）
  make-zip.py          打 zip（可复现：条目排序 + 固定时间戳 + 校验 SHA256SUMS）
  make-ico.py          从方形图生成 Windows 快捷方式用的 .ico（7 档尺寸）
  scan-package.mjs     对**最终产物**做真值复扫（不复制判据，复用 scripts/known-real.mjs）
  vbs-lint.py          ★ 静态检查 `launcher/*.vbs`：`Option Explicit` 下"赋值了却没 Dim"
                       与 VBA 专属函数（`IIf` 等）误用。**动过任何一个 .vbs 就跑一次** ——
                       见下面「为什么 .vbs 必须过 vbs-lint」
  launcher/            包顶层那几个文件（原样进包根）
    一键安装.bat       ★ 一条命令跑通全程（检测 → 校验 → 修复 → 打开控制台）
    1-SETUP.bat        分步版首次安装（老入口，仍在）
    2-START.bat        日常启动（老入口，仍在）
    3-START-NAPCAT.bat 只起协议端（后台、无窗口；2026-10-13 起不再有前台模式）
                       ⚠️ 扫码不在窗口里做 —— 控制台页面点「打开二维码登录」
    4-DIAG.bat        一键取证（只读）：把版本/新旧文件/端口/进程/日志尾部收进
                       diag-out\diag-<时间>.txt，并尝试复制到共享目录给对面读
    launch-hidden.vbs  无窗口拉起控制台（桌面快捷方式指向它 —— node.exe 是控制台程序，
                       从 .lnk 直接拉必闪黑框，而 .lnk 没有"隐藏窗口"这个开关）
    launch-napcat-hidden.vbs  无窗口拉起协议端（NapCat 的启动器也是控制台程序；
                       Node 的 windowsHide=CREATE_NO_WINDOW 会让它自己 AllocConsole
                       弹第二个黑窗，必须走 wscript 的隐藏控制台，2026-10-13 真机复现）
    estrella-bot.ico   桌面快捷方式图标（由 make-ico.py 从官方立绘生成，7 档）
    README.html        给 Windows 用户看的说明 —— **唯一的说明文件**
                       （维护者 2026-10-14 指定：不要 README.txt；也不要再生成
                        "本版修了什么"式的版本说明 —— 用户只需要看 README）
  tools/               包顶层 `tools/`（原样进包，`%dp0tools\` 定位）
    onekey.mjs          ★ 一键安装主流程（唯一入口）
    check-env.mjs  setup.mjs  start-napcat.mjs  start.mjs  napcat.json
    make-shortcut.mjs   桌面快捷方式（PowerShell WScript.Shell）
    lib/common.mjs      共用叶子（路径 / 下载 / 解压 / NapCat 定位 / OneBot 形状）
    lib/versions.mjs    版本探测与校验（装的是几、最新是几、够不够）
    lib/repair.mjs      自动修复（Node 运行时 / NapCat 安装与升级 / QQ 引导）
    lib/console.mjs     控制台的拉起（**无窗口**）/ 探活
```

## 为什么 .vbs 必须过 vbs-lint（2026-10-13 的教训）

`launch-napcat-hidden.vbs` 出过一个极端昂贵的故障：它**从未被执行过哪怕一次**，
里面同时藏着两个 VBA 式错误（`argErr` 赋值却没 `Dim`；两处 `IIf(...)`，
而 VBScript 没有 `IIf`）。而 `wscript //B` 下**致命脚本错误 = 无对话框、无输出、
退出码仍然是 0** —— 表现和"协议端无缘无故秒退"一模一样，于是排查方向全错。

```bash
python3 packaging/windows/vbs-lint.py --all      # 全部 .vbs
python3 packaging/windows/vbs-lint.py packaging/windows/launcher/launch-napcat-hidden.vbs
```

它查四件事：① `Option Explicit` 下"赋值了却没 `Dim`"（`On Error Resume Next` 兜不住）；
② VBA 专属函数误用（`IIf` / `Format` / `Val` …，VBScript 里没有）；
③ 非 ASCII 字符（非中文 Windows 会乱码）；④ CRLF 行尾（必须 LF-only）。
退出码 0 = 干净，可直接挂进提交前检查。

**只看"能不能跑"用 `cscript`，不要用 `wscript`**（`wscript` 会静默吞掉脚本错误）：

```bat
cscript //Nologo launch-napcat-hidden.vbs "C:\no-such\launcher.bat" - "C:\no-such\log.txt"
echo 退出码=%ERRORLEVEL%
```

期望：**不打任何错误文本**，退出码 `2`（= 参数正常、只是启动器不存在）。
这一条完全无副作用，因为它走不到真正拉起协议端的那一步。

## 包结构（打出来的 zip 长这样）

```
Win-v<版本>/
  一键安装.bat  1-SETUP.bat  2-START.bat  3-START-NAPCAT.bat  4-DIAG.bat
  launch-hidden.vbs  launch-napcat-hidden.vbs  estrella-bot.ico  README.html
  SHA256SUMS.txt          ← 构建时生成，不在这里
  BUILD-INFO.txt          ← 构建时生成：这份包对应**哪一次提交**（见第 8 步）
  app/                    ← 由下面第 1 步生成（跟踪文件）
    node_modules/ws/      ← **要手工补**，第 1 步不会带它（见第 3 步）
  tools/                  ← 来自 packaging/windows/tools/
    migrate.mjs           ← 旧便携数据 → userdata 的只复制迁移（P1）
    lib/user-root-loader.mjs ← 工具层加载 app/src/user-root.js
  runtime/node/           ← 内嵌的 Node.js 官方 Windows x64 发行版，**不入库**（见第 2 步）
  userdata/               ← **首次运行后出现**：config/panel/data/plugins/skills/persona/napcat
                            （便携模式默认根；升级只替换 app/，不碰这里）
```

（包内**不会**有 `app/packaging/` —— 那一份是构建素材，由第 1 步的 `make-app.mjs` 剔除，见第 4 步。）

⚠️ **P1 起 NapCat 在 `userdata/napcat`**（程序 + `config/` + `QQ/` 登录态 + 日志），
不再放 `app/napcat`。④b 由 `make-vm-copy.mjs` 注入到 `userdata/napcat`；
`make-zip.py` 对 `app/napcat` 与 `userdata/napcat` 两处都做硬闸。

## 数据流（2026-10-16 维护者定：**只常驻 ④b**）

```
仓库（唯一真源）
  └─ make-app.mjs ─▶ app/（对外拷贝 + 剔除 app/packaging/）
                       └─ make-vm-copy.mjs ─▶ ④b Estrella-Bot-napcat/（VM 自用，协议端注入 userdata/napcat）
                                                 ↑ 常驻的只有这一份
                                              ④  Estrella-Bot/（对外）—— **按需派生、传完就删**
                                                 ↑ make-publish-from-vm.mjs（复制 → 剪 napcat → 改回 BUILD-INFO）
```

为什么改：两份包的 `app/` **完全相同**，常驻两份 = 白占 ~113 MB。

⚠️ **不要"把 NapCat 移出去再移回来"**（维护者最初的想法，已被否）——
会碰登录态、会绕过 `make-zip.py` 的硬闸、会把「⛔ 禁止对外发布」那段说明带进对外包。
三条理由都写在 `make-publish-from-vm.mjs` 的文件头。要动就**复制**，让脚本干。

⚠️ `④` 不在时，`make-vm-copy.mjs` 的默认 `--src` 会指空 —— 先用
`make-publish-from-vm.mjs` 产一份 `④`，再 `--src` 指过去。

## 构建步骤

> ⚠️ **每一步都要在"树是干净的"状态下做**（`git status --porcelain` 为空），
> 否则打出来的包无法与任何一次提交对应 —— 第 58 轮就是从这里出的问题。

**1. `app/` ← 从仓库生成对外拷贝（并剔除构建素材）**

```bash
node packaging/windows/make-app.mjs <工作区>/pkg
```

它做两件事：① 调 `scripts/make-publish-copy.mjs` 生成 `pkg/app`（**以 `git ls-files` 为准**，
所以 `.gitignore` 的语义被自动继承，运行期数据天然不进包；不要用 rsync 按路径名排除 ——
历史清单漏过 `.env`，那是机器人真实 QQ 号）；② **剔除 `pkg/app/packaging/`**。

② 为什么需要（2026-10-15 起）：`packaging/` 已进**仓库发布面**（维护者点名"源码都上传"），
于是第 ① 步会把它一起带进 `app/`。但包里**顶层已有一份** `tools/` 与那几个 `.bat` ——
同一个 `setup.mjs` 在一个包里出现两份，"一份数据维护两遍"：`.bat` 按 `%~dp0tools\` 定位，
改一份不会改到另一份，症状是"我改了包里的 tools，重启还是旧的"。
⇒ **仓库发布面要完整，包内分发面不带重复件**，两件事由这个脚本分开。脚本结尾有自证
（包内不得再有 `app/packaging/windows/tools/setup.mjs`）。

**2. `runtime/node/` ← 内嵌运行时（不入库，每次构建重新取）**

取 Node.js 官方的 **Windows x64 zip** 发行版解压到 `pkg/runtime/node/`。
上次构建用的是 v22.23.3（npm 10.9.9）。要核当前这份的版本，在 Windows 上跑
`runtime\node\node.exe -v`；在 macOS 上可以看 `runtime/node/node_modules/npm/package.json` 的 `version` 反推。

- 版本必须满足仓库 `package.json` 的 `engines.node`。
- **校验方式不是逐行扫文本**，而是比对该发行版官方 `SHASUMS256.txt` 里的 zip 哈希。
- 为什么要内嵌：目标机器上不该（也多半没有）装 Node，而 NapCat 的启动器要 `node`。

**3. `app/node_modules/ws/` ← 唯一的运行时依赖（最容易漏的一步）**

`make-publish-copy.mjs` 只拷**被跟踪**的文件，而 `node_modules/` 在 `.gitignore` 里
⇒ **它不会带 `ws`**。而 `ws` 是机器人唯一的 npm 依赖，缺了它机器人起不来。

```
cp -R <开发仓>/node_modules/ws  pkg/app/node_modules/ws
```

版本要与 `package.json` 的 `dependencies.ws` 相符（第 59 轮构建用的是 8.21.3）。
⚠️ 这一步漏掉**不会报任何错**：包能打出来、能解压、`1-SETUP.bat` 也能跑完 ——
只有机器人真正连 QQ 时才炸。第 59 轮就是靠 `SHA256SUMS.txt` 里那条
`app/node_modules/ws/index.js` 找不到文件才发现漏了这一步的。

**4. 拼包根**

把 `packaging/windows/launcher/*` 拷到 `pkg/` 根；`packaging/windows/tools/` 拷成 `pkg/tools/`。

⚠️ 因为第 1 步的 `make-app.mjs` 会**剔除 `app/packaging/`**，包内不会出现"两份 `setup.mjs`"。
构建后可以核一下：`ls pkg/app/packaging` 应当不存在。

**5. 重算 `pkg/SHA256SUMS.txt`（41 项 · 点名制）**

```bash
python3 packaging/windows/make-sums.py <pkg目录>
```

清单点名的文件全部收在 `make-sums.py` 的 `ITEMS` 里 —— **别再手写清单**：手写清单
"生成清单之后又改了源码"不会报任何错（那个坑见上一条）。点名的文件缺一个就会红着退出；
`ITEMS` 增删或任何被点名文件的内容变化后，都要重跑一次。

（下面第 7 步再来打 zip，但**不要把这一步排到最后**：`make-zip.py` 打包前会**强制校验**
`SHA256SUMS.txt`，对不上就构建失败。宁可构建失败，也不要静默发错。）

**6. 打 zip（可复现）**

```bash
python3 packaging/windows/make-zip.py <pkg目录> <输出zip> Win-v<版本>
```

为什么不用 `zip` 命令：① 包内有中文路径（`app/plugins/定时文案推送`），Python 的 zipfile
一定会置 UTF-8 标志位；② macOS 的 `zip` 会塞 `__MACOSX/` 与 `.DS_Store`；
③ 条目排序 + 固定时间戳 ⇒ 同样的输入得到同样的输出（**也正因为如此，包内 mtime 全是固定值，
不要拿它判断新旧**）。

**7. 产物真值复扫**

```bash
node packaging/windows/scan-package.mjs <pkg目录>      # 退出码 0 = 0 命中
```

⚠️ 必须扫 **`pkg/` 或解压后的顶层目录**；直接扫 `out/`（含 `Win-v<版本>/` 前缀）
会让 `VENDOR_SKIP` 失配，误报 Node 自带 npm 文档里的 `-----BEGIN … PRIVATE KEY-----`（三处）。

**8. `BUILD-INFO.txt` ← 构建溯源（每份包一份）**

2026-10-11（"总项目与外部线路"轮）起，包根多一份 `BUILD-INFO.txt`，记：
**源提交**（短哈希 + 提交标题）、`package.json` 版本、**是否含未发布改动**、构建时间、
内嵌运行时版本与它的官方哈希比对结果、npm / `ws` 版本、清单项数、真值复扫结论。

为什么要有它（不是仪式）：本文件开头那段历史 —— **"包里的那份不会告诉你它对应哪次改动"** ——
正是第 58 轮 9 个文件"进了包却没进 git"的直接成因。`SHA256SUMS.txt` 只回答"文件有没有被改过"，
回答不了"这份包是哪棵树打的"。

⚠️ 它**不进** `SHA256SUMS.txt` 的 41 项 —— 清单**无法自证**（把自己的哈希写进自己，
被改了就看不出来）。这是刻意的，不是漏项。

## P2：NSIS 安装器构建（2026-10-18）

便携 zip 流程保留；安装器构建在 `packaging/windows/installer/`，由 Windows 上的
`makensis` 执行，macOS 负责 staging、校验、清单。规格见 `INSTALLER-SPEC.md` §6/§11/§16。

```bash
# 1) macOS：生成 payload（显式白名单 + manifest + 自校验 + 真值复扫）
node packaging/windows/installer/make-installer-payload.mjs \
  --out ~/Desktop/estrella-dist/installer-p2/build-0.1.3/stage \
  --runtime-node ~/Desktop/estrella-dist/Estrella-Bot-napcat/runtime/node

# 2) macOS：NSIS 静态体检（per-user / 版本单源 / stop→commit / 卸载默认保数据）
node packaging/windows/installer/check-nsi.mjs \
  --nsi ~/Desktop/estrella-dist/installer-p2/build-0.1.3/Estrella-Bot.nsi \
  --stage ~/Desktop/estrella-dist/installer-p2/build-0.1.3/stage

# 3) Windows VM：用便携 NSIS 编译（build 目录里已有 .nsi/version.nsh/stage）
makensis Estrella-Bot.nsi
# 产物：Estrella-Bot-Setup-0.1.3.exe
```

- `version.nsh` 由 `package.json` 生成；`.nsi` 里不写死版本/appId。
- `payload-manifest.json` 逐文件 SHA-256；`install-commit.mjs` 安装前再校验一次。
- 公开 payload **不含 NapCat/user data**；安装器组件页可选下载 NapCat。
- `uninstall.exe` 由 NSIS 生成，**不在 payload 里**。
- 运行时钉在 `installer/toolchain.json`（Node 22.23.3 + 官方 SHA-256）。
- VM 验收：NSIS 3.13（VM 上 winget 安装）编译的 0.1.3 EXE 已跑通
  “新装 → health → 运行中重装 → 默认卸载保数据 → 重装 `/DELETEUSERDATA` 删数据”；
  non-admin Startup 会话，最终 EXE SHA-256 `840287b0…ecc66d`。
- 静默安装后 `.stage-<ver>` 可能暂留，首次启动由 launcher 清理。

## 2026-10-17 起：NSIS 安装器（方向）

本文件此前记录的是便携 zip 的构建流程；P2 起安装器成为主分发形态，
但便携 zip 仍保留为备用/VM/离线通道。规格见 `INSTALLER-SPEC.md`。

## 两条踩过的坑

- **投给 Windows 的 `.ps1` 一律 ASCII-only**：PowerShell 5.1 按 ANSI 解析含中文的脚本
  ⇒ `ParserError`、**整份不执行**，而症状是"文件没被动过"。同一个坑连踩三次。
- **`.bat` 必须纯 ASCII / 零 CRLF / 无 label·括号块·for**：仓库 `.gitattributes` 禁止 CRLF，
  而这类极简 bat 在 LF 下才安全。中文说明一律交给 Node（写 UTF-8）或 README.html。

## P3：应用内更新（2026-10-18）

- 规格正本：`INSTALLER-SPEC.md` §8/§9/§11.5/§13；更新器在面板侧
  `panel/lib/update-version.js` / `update-manifest.js` / `update-signature.js` /
  `update-download.js` / `update.js` / `update-routes.js`。
- 清单/签名工具：`packaging/windows/update/`（keygen / make-manifest / sign-manifest /
  verify-manifest / README）。
- 公钥：`resources/update-pubkey.pem` 入库；**私钥只在维护者机器上，绝不入库/入包/进对话**。
  当前公钥是 P3 验收密钥，P5 正式发布前必须轮换；`resources/UPDATE-KEY-INFO.txt` 记指纹与轮换点。
- 安装器 payload 会把公钥复制到 `<InstallRoot>/resources/update-pubkey.pem`；
  便携包由 `make-app.mjs` 剔除 `app/resources/`，避免两份公钥漂移。
- 版本：`package.json` 仍是唯一版本源；清单 `version` 必须高于当前版本；
  客户端对 `version == current` 显示 up_to_date，`version < current` 仍拒绝。
- 验收：P3 用一次性 `0.1.4` 作为升级目标（临时构建，不提交/不发布；NSIS
  `VIProductVersion` 不接受预发布后缀）；最终产品版本仍为 0.1.3。

## P4：回滚 / 离线更新 / 保留策略（2026-10-18）

- 规格正本：`INSTALLER-SPEC.md` §7.2 / §8.8 / §9 / §13 / §18。
- 启动器：坏版本连续失败 2 次自动回滚；停子进程 → 交换 `runtime/node` 与
  `runtime/node.previous` → 翻 `current.json` → 写 `USER_ROOT/update/rollback.json`
  → 用上一版重启。首装无 previous 不循环重试。Windows 上“包含运行中 node.exe 的目录”
  不能当场改名（实测 EPERM），所以交换由独立计划任务
  `Estrella-Rollback-<pid>` 在启动器退出后执行（`tools/rollback-restore.ps1`）。
- 安装事务：`versions/.txn.json` 的 entries 在每个 rename **之前**落盘；断电后下一次
  安装会先恢复。`runtime` 备份名固定为 `runtime/node.previous`。
- 保留策略：健康成功后只保留 current + previous；未知目录、软链、`USER_ROOT` 一律不动。
  失败证据在清理前复制到 `USER_ROOT/update/logs/rollback-<from>-<stamp>/`。
- 离线更新：面板更新卡片里的“离线更新”区，选择 `latest.json` + `.sig` + EXE；
  先验签、再校 size+sha256，不联网；仍然只有“立即安装”才运行安装器。
- 镜像：`installer.url` 与 `installer.mirrors` 都要求固定 tag，`latest` 会被拒绝。
- 验收：`test/installer-p4.mjs`（22 项）+ `install-p4-1018` 变异（17/17）；
  Win11 VM 验收表见 `INSTALLER-SPEC.md` §18。

## P5：正式密钥轮换与 0.1.3 发布收尾（2026-10-18）

- 规格正本：`INSTALLER-SPEC.md` §11.5 / §13 / §19。
- 正式更新密钥：`resources/update-pubkey.pem`，指纹
  `sha256:20a9a6b2f509fcedadb8544d8c41e4ef4a30e098c169fb36768fce2f73122f0d`；
  私钥在 `~/Desktop/estrella-dist/update-keys/p5-formal-2026-10-18/private.pem`
  （0600，仓库外，绝不入库/入包/进对话）。
- 轮换：`keygen.mjs --rotate` 归档旧公钥/说明到 `<out>/previous/`；P3 验收密钥不再使用。
  无过渡清单：P3/P4 构建从未公开发布。
- 当前版本清单：`make-manifest.mjs --allow-current` 只放行
  `version == package.json.version`；发布 0.1.3 时使用，默认仍要求严格更高版本。
- 发布资产校验：`release-check.mjs` 校验原始字节签名、版本/tag/文件名、size+sha256、
  `SHA256SUMS`、过期时间与“目录无私钥”。发布资产在
  `~/Desktop/estrella-dist/release-v0.1.3/`。
- Authenticode：本轮无证书，安装器**未签名**；SmartScreen 会提示“未知发布者”。
  Ed25519 只保证更新完整性。证书采购/签名仍是维护者决定。
- 边界：G5（压缩 ③）已做；**G3/G4/G6 未执行**（不 push / 不 TAG / 不 Release / 不发布）。
- 最终版本固定 **0.1.3**；0.1.4 只作一次性升级验收目标，不进正式资产。
- 验收：`test/installer-p5.mjs`（9 项）；VM 新装/离线升级/恢复表见
  `INSTALLER-SPEC.md` §19。
