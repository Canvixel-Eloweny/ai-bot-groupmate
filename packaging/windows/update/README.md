# 更新清单与签名工具（P3 起 · P5 正式密钥）

> 公钥随程序发布；**私钥只在维护者机器上，绝不入库/入包/进对话**。
> Ed25519 清单签名保证更新完整性；它不替代 Authenticode，也不改变 SmartScreen 提示。

## 当前正式密钥（P5 · 2026-10-18）

| 项 | 值 |
|---|---|
| 公钥 | `resources/update-pubkey.pem` |
| 指纹 | `sha256:20a9a6b2f509fcedadb8544d8c41e4ef4a30e098c169fb36768fce2f73122f0d` |
| 私钥 | `~/Desktop/estrella-dist/update-keys/p5-formal-2026-10-18/private.pem`（0600，仓库外） |
| 旧 P3 验收公钥 | 同目录 `previous/update-pubkey.pem`（只归档，不再用于签名） |
| 建议轮换点 | 2027-10-18 |

- **无过渡清单**：P3/P4 的 0.1.3/0.1.4 都是本地验收构建，从未公开发布，不存在持旧公钥的公开用户；
  因此 P5 直接换正式公钥，不发布“旧私钥签名的过渡清单”。此决定见 `INSTALLER-SPEC.md` §19。
- **私钥备份**由维护者离线保管。私钥丢失 = 无法再签新的 `latest.json`，只能发布一个带新公钥的新版本。
- 公钥与 `resources/UPDATE-KEY-INFO.txt` 的指纹必须一致；安装器 payload 构建时会硬校验。

## 生成密钥（首次）

```bash
node packaging/windows/update/keygen.mjs \
  --out ~/Desktop/estrella-dist/update-keys/p3-2026-10-18 \
  --pub resources/update-pubkey.pem
```

- `--out` 必须在仓库外；脚本拒绝仓库内路径。
- 输出 `private.pem`（0600）与 `public.pem`（0644）。
- 仓库只提交 `resources/update-pubkey.pem` 与 `resources/UPDATE-KEY-INFO.txt`。

## 轮换密钥（P5 使用）

```bash
node packaging/windows/update/keygen.mjs \
  --out ~/Desktop/estrella-dist/update-keys/p5-formal-2026-10-18 \
  --purpose "P5 formal release" --rotate-before 2027-10-18 --rotate
```

- 没有 `--rotate` 时，目标公钥/说明已存在就拒绝覆盖；有 `--rotate` 才允许轮换。
- 轮换会把旧 `update-pubkey.pem` 与 `UPDATE-KEY-INFO.txt` 复制到 `<out>/previous/`，
  **不删除**旧密钥目录。
- 绝不允许覆盖 `private.pem`；新私钥必须落在新的仓库外目录。

## 生成清单

```bash
node packaging/windows/update/make-manifest.mjs \
  --exe <Estrella-Bot-Setup-0.1.4.exe> \
  --version 0.1.4 \
  --out <目录>/latest.json
```

- 生产默认 `installer.url` / `notesUrl` 指向固定 GitHub tag。
- 本地验收可加 `--installer-url http://127.0.0.1:PORT/... --notes-url http://127.0.0.1:PORT/notes --test`。
- `--min-version`、`--min-windows`、`--expires-at`、`--mirrors` 可覆盖。

### 发布“当前版本”的清单（0.1.3）

默认规则要求清单版本**严格高于** `package.json` 版本；正式发布当前版本时必须显式加
`--allow-current`。它只放行 `version == package.json.version`，更低版本仍然拒绝。

```bash
node packaging/windows/update/make-manifest.mjs \
  --exe ~/Desktop/estrella-dist/release-v0.1.3/Estrella-Bot-Setup-0.1.3.exe \
  --version 0.1.3 \
  --allow-current \
  --expires-at 2027-10-18T00:00:00.000Z \
  --out ~/Desktop/estrella-dist/release-v0.1.3/latest.json
```

## 签名与自检

```bash
node packaging/windows/update/sign-manifest.mjs \
  --manifest <目录>/latest.json \
  --key ~/Desktop/estrella-dist/update-keys/p5-formal-2026-10-18/private.pem \
  --pub resources/update-pubkey.pem \
  --out <目录>/latest.json.sig

node packaging/windows/update/verify-manifest.mjs \
  --manifest <目录>/latest.json \
  --sig <目录>/latest.json.sig \
  --pub resources/update-pubkey.pem \
  --exe <EXE>
```

- 签名覆盖 **原始字节**；不要先解析再 `JSON.stringify`。
- `sign-manifest` 写盘前会用仓库公钥自验；`verify-manifest` 再独立验一次。

## 发布资产校验（P5）

```bash
node packaging/windows/update/release-check.mjs \
  --dir ~/Desktop/estrella-dist/release-v0.1.3 \
  --pub resources/update-pubkey.pem \
  --expect-version 0.1.3
```

它检查：清单原始字节验签、版本 = EXE 文件名 = 固定 tag、size/sha256、
`SHA256SUMS` 三件套、过期时间、发布目录无私钥。退出码 0/1，失败会一次列出所有问题。

发布目录应包含：

```
Estrella-Bot-Setup-0.1.3.exe
latest.json
latest.json.sig
SHA256SUMS
README-发布交接.txt
```

## 离线更新三件套（P4 · 规格 §8.8）

把同一份 `latest.json`、`latest.json.sig` 和 `Estrella-Bot-Setup-<ver>.exe` 交给用户；
用户在面板「离线更新」区三个文件一起选，点“校验离线包”。服务端仍然：
先验签 → 解析/校验清单 → 校 EXE 的 size + sha256 → 才允许“立即安装”。
离线路径不联网、不绕过任何校验；清单里的 `installer.url` 只做形状/固定 tag 校验，
不会去下载它。上传的 EXE 上限 256 MiB（Electron 载荷约 150 MiB；P1-7 实测后校准）。

## Authenticode（P5 决定 · 收尾裁决）

**维护者 2026-10-18 裁决：暂不做签名。** 0.1.3 以未签名形态发布，SmartScreen 那道
「更多信息 → 仍要运行」由用户手点。已真机验证：安装、离线升级、自动回滚、数据保留
全程都在未签名状态下跑通 ⇒ 不签不影响功能，只影响首启那一步的观感。

本轮没有代码签名证书，正式安装器**保持未签名**，SmartScreen 会显示“未知发布者”。
Ed25519 清单签名只保证更新完整性，不等于 Authenticode。不要用自签证书冒充；
证书采购与签名仍是维护者的预算决定。

选型事实（详见规格 §20.3，都是外部官方口径，不是本机推测）：
**EV 的“首次下载即得 SmartScreen 信任”在 2024 已取消**，EV 与 OV 同样要攒信誉；
**Azure Artifact Signing（约 $9.99/月）对个人开发者只开放美国/加拿大**，
组织限美/加/欧/英 ⇒ 中国大陆的自然人不符合资格，只能走 CA 的 OV（约 $150–300/年，
私钥必须在 HSM/硬件令牌或云 HSM 里）。免费路线只有 Microsoft Store 的 MSIX 通道（要换打包形态）
和 SignPath Foundation（署名是基金会、构建在它的流水线里跑，属 G3/G4/G6 范畴）。

本机与 VM 都没有可用签名工具链（VM 有 `makensis`、无 `signtool`/SDK；
Mac 无 Homebrew、无 `osslsigncode`）。若决定签，按这个顺序接进流水线，**否则哈希与清单全部作废**：

```
makensis → Authenticode 签名 + RFC3161 时间戳 → 取 size/sha256 写 SHA256SUMS
         → 生成 latest.json → 用 Ed25519 私钥签 latest.json.sig
```

## 发布顺序（维护者手动执行，G3/G4/G6）

1. 备份正式私钥（离线介质），确认 `release-v0.1.3/` 通过 `release-check`。
   备份包已就绪：`~/Desktop/estrella-dist/update-keys/backup-2026-10-18/`
   （AES-256-GCM + scrypt，含 `restore.mjs` 与恢复演练步骤）。
   维护者无 U 盘 ⇒ 同日已按裁决在桌面放第二份
   `~/Desktop/重要文件/自动更新的钥匙备份（丢了就没法推更新）/`（逐文件 sha256 与正本一致；
   同日更晚维护者把它从桌面顶层挪进 `重要文件/`，新位置已复验 `shasum -c` 与逐文件哈希全等）。
   ⚠️ 桌面那份是**同盘副本**，不是离线备份：防手滑误删，不防硬盘坏/整机丢/重装；
   密文与口令也还在同一个文件夹里。真正的离线介质 + 口令分放，列为不阻塞发布的待办。
2. 建 tag `v0.1.3`（G4，维护者指定版本号）。
3. 上传 `Estrella-Bot-Setup-0.1.3.exe`、`latest.json`、`latest.json.sig`、`SHA256SUMS`
   到 GitHub Release（G6，维护者手动执行）。
4. 验证 `https://github.com/Canvixel-Eloweny/ai-bot-groupmate/releases/latest/download/latest.json`
   可访问且版本为 0.1.3；发布后按 §11.3 再做一次新装/升级验证。
