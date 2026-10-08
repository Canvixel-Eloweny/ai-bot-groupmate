# 容器路线安装手册（**macOS 专用**）

> ⚠️ **Windows 用户不用看这份。** Windows 走**原生 NapCat、不装 Docker** ——
> 步骤在 [用户使用说明 · 第 9 节](./USER-GUIDE.zh-CN.md#9-windows-用户)。
> 这份是给 **macOS** 的：那边必须借容器绕开 NapCat 的版本白名单（理由见下）。

你选的是 Docker 路线。核心思路：**NapCat 和 QQ 都跑在 Linux 容器里，你本机的 QQ 完全不动。**

好处很直接 —— NapCat 的 macOS 版本白名单停在 build 47354（半年没更新），
而 Linux arm64 的覆盖是**当前的**（到 52892）。走容器等于绕过了整个版本匹配问题。

> 📖 这份比 [用户使用说明](./USER-GUIDE.zh-CN.md) 的 §3 更细：Docker Desktop 怎么装、
> 镜像拉不动怎么回退、日常运维、怎么回滚。**第一次装建议先看那边，卡住了回来查这里。**

---

## 第 1 步：安装 Docker Desktop（需要你手动做，约 10 分钟）

安装包要你自己去官方下（`desktop.docker.com` 在部分网络下不可达）。

1. 打开 <https://www.docker.com/products/docker-desktop/>
2. 点 **Download for Mac**，**务必选 Apple Chip 版**（Apple Silicon / arm64）
   - 直接下载地址：`https://desktop.docker.com/mac/main/arm64/Docker.dmg`
   - 体积约 600 MB – 1.5 GB
3. 打开 `.dmg`，把 **Docker** 图标拖进「应用程序」
4. 从「应用程序」启动 Docker
5. 会弹窗要求输入**开机密码**（它要装一个特权辅助进程）→ 输入
6. 首次会要求接受服务协议 → 同意
7. 等菜单栏的**鲸鱼图标不再跳动**（约 1–2 分钟）

> 如果弹「Docker.app 已被破坏」或来源警告：系统设置 → 隐私与安全性 → 仍要打开。

验证装好了：打开「终端」运行

```bash
docker --version
docker ps
```

`docker ps` 能输出一个空表格（只有表头）就说明守护进程在跑。

---

## 第 2 步：一键拉起容器

```bash
cd ~/QQ-BOT-Creative                  # 换成你实际 clone 下来的位置
bash scripts/bootstrap.sh
```

这个脚本会依次做：检查 Docker → 检查 3000/3001/6099 三个端口是否空闲 → 拉镜像 →
起容器 → 等就绪 → **把 WebUI 登录地址（带 token）打印出来**。

跑完你会看到一行类似：

```
http://127.0.0.1:6099/webui?token=xxxxxxxx
```

**这个 token 等于你机器人账号的入口，别发到任何群里。**

---

## 第 3 步：在 WebUI 里登录并开通道

浏览器打开上面那个地址（已带 token，直接进）：

1. **扫码登录你的小号。** ⚠️ 必须用小号，第三方协议端有封号风险。
   手机 QQ → 扫一扫。
2. 左侧菜单 **网络配置** → 新建 **WebSocket 服务端**
   - 端口：`3001`
   - Token 留空（桥接层默认也不带 token）
   - 保存并启用
3. 同页 → 新建 **HTTP 服务端**
   - 端口：`3000`
   - 保存并启用

---

## 第 4 步：验证通道

```bash
cd ~/QQ-BOT-Creative                  # 换成你实际 clone 下来的位置
node scripts/check-onebot.js
```

正常输出：

```
✓ 已连上协议端

  登录账号：小鱼 (123456789)

  已加入 3 个群：
    100000001   某某群
    ...

✓ 通道正常。
```

**群号就是从这一步拿到的。** 把要放行的群号填进 `config.json` 的 `allow.groups`。

如果报「8 秒内没能连上」，脚本会告诉你怎么排查（容器状态 / 日志 / 端口 / WS 是否真的建了）。

---

## 第 5 步：配模型并启动

`config.json` 是从 `config.example.json` 拷来的，**预填的是千问（阿里云 DashScope）**。

> ⚠️ **用哪家的 Key，就去哪家拿** —— 拿 A 家的 Key 喂 B 家的接口，只会得到一个
> 看不懂的 401。想用 DeepSeek / 智谱，在控制台的「大脑」页点那套预设、填它自家的 Key 即可
> （<https://platform.deepseek.com> / <https://open.bigmodel.cn>）。

最省事的做法是**在控制台的「大脑」页里填 Key**（不用命令行、不用改文件）：

```bash
cd ~/QQ-BOT-Creative                  # 换成你实际 clone 下来的位置
npm start                             # 只跑机器人；控制台另开：node panel/server.js
```

> ⚠️ **别同时用环境变量和面板填的 Key。** `config.json` 里默认设着
> `llm.apiKeyEnv = QQBOT_API_KEY`，而**环境变量的优先级更高** ——
> 一旦你 `export QQBOT_API_KEY=...`，面板里填的那把就被忽略（日志里有一行告警，页面上看不出来）。
> 二选一：要么只在面板里填（那就别 export 这个变量），要么只用环境变量（把它 export 好、
> 并且确认那个地址就是这家服务商的）。

去群里 @ 一下你的机器人（或者叫「小鱼」），应该就能收到回复了。

### 想换成本地模型

**推荐做法：在控制台的「大脑」页用「自定义模型」接一个本地推理服务。**
不用改文件、点几下就行 —— 填**接口地址 + 模型名**即可，Key 留空：

| 你本机上跑的东西 | 「自定义模型」里填什么 |
|---|---|
| Ollama | `http://127.0.0.1:11434/v1` |
| LM Studio | `http://127.0.0.1:1234/v1` |
| 局域网里另一台机器的 vLLM | `http://192.168.x.x:8000/v1` |

⚠️ 这些地址都会被认成**「本机」⇒ 不计费**（`127.0.0.1` / `localhost` / `192.168.x` /
`10.x` / `172.16–31.x` 都算），所以用量统计不会把它们当云端调用。

> **控制台上那一档叫「本机模型」的按钮，是按维护者自己机器的布局写死的**
> （它去拉起 `~/models/` 下的 MLX :8080 / QwenChat :8765 两个服务，模型文件也是本机独有）。
> **别人的机器上那一档用不了，也不需要它** —— 上面那张表才是通用做法。
> 如果你确实想复刻那套布局，去看 `panel/lib/paths.js` 里 `QWEN_SERVER` / `MLX_PY` 那几个路径。

> ⚠️ 内存现实：本机模型和 Docker 容器会互相挤内存。16 GB 的机器上两者同时跑，
> 历史上出过「容器凭空消失」（Docker 虚拟机被系统杀掉）。
> 另外 `throttle.globalConcurrency` 必须保持 `1`，两路并发会互相拖慢。

---

## 日常运维

```bash
cd ~/QQ-BOT-Creative                  # 换成你实际 clone 下来的位置
bash scripts/status.sh              # 容器 / 端口 / 桥接进程 / 当前配置 一屏看完
docker logs --tail 50 napcat        # 协议端日志
docker compose restart napcat       # 重启协议端（不会掉登录，扫码信息持久化在 ./napcat/）
```

容器设了 `restart: always`，**电脑重启后会自动拉起**，不用管。

### 让「重启容器不用重新扫码」生效：项目根目录建一个 `.env`

NapCat 的快速登录（免扫码）靠的是"拿**机器人 QQ 号**去查本地历史登录记录"。
所以那个号必须在启动时告诉它，否则它查不到、只能退回二维码 ——
**表现就是每重建一次容器就要扫一次码**。

`docker-compose.yml` 里这一项**只留占位符**（真实号不进版本控制，见维护者发布清单的排除口径，
那份清单是内部件、不随公开仓库发布），真实号写在项目根目录的 `.env` 里：

```bash
cd <项目目录>
printf 'ACCOUNT=<你的机器人QQ号>\n' > .env
chmod 600 .env                 # 里面是真实号，别对其他人可读
docker compose up -d --force-recreate   # env 是创建时写死的，**必须重建**才生效
docker logs --tail 30 napcat | grep 快速登录   # 应看到"快速登录"而不是"请扫描二维码"
```

- `.env` 已在 `.gitignore` 里（**别把它提交出去**）。
- 确认 compose 真的读到了：`docker compose config | grep ACCOUNT`。
- ⚠️ 不建 `.env` 也能用 —— 只是每次重建容器都要重新扫码。

---

## 回滚 / 卸载

```bash
cd ~/QQ-BOT-Creative                  # 换成你实际 clone 下来的位置
docker compose down                 # 停掉并删除容器
rm -rf napcat/                      # 删掉登录态和配置（等于彻底重来）
```

想连 Docker Desktop 一起卸：退出 Docker → 把「应用程序/Docker」拖到废纸篓 →
（可选）`rm -rf ~/Library/Containers/com.docker.docker ~/.docker`。

**你本机的 QQ 从头到尾没被碰过，不用做任何还原。**

---

## 国内拉不动镜像怎么办

`registry-1.docker.io` 在国内基本直连不通（报 `context deadline exceeded`）。
`bootstrap.sh` 已经内置自动回退：**先试直连 → 失败就依次试 4 个国内加速站 → 拉到后自动重新打标准标签**，
所以 `docker-compose.yml` 不用改。

实测可用的加速站（2026-09-15）：

| 加速站 | 状态 |
|---|---|
| `docker.m.daocloud.io` | ✅ 可用，含 `linux/arm64` |
| `docker.1ms.run` | 需 token 握手，未通过 manifest 探测 |
| `docker.xuanyuan.me` | 限速中 |
| `docker.1panel.live` | 拒绝代理该镜像 |

### 想一劳永逸（推荐）

在 Docker Desktop 里配好永久加速，之后所有 `docker pull` 都走它：

1. Docker Desktop → 右上角齿轮 **Settings**
2. 左侧 **Docker Engine**
3. 在 JSON 里加一行 `registry-mirrors`：

```json
{
  "builder": { "gc": { "defaultKeepStorage": "20GB", "enabled": true } },
  "experimental": false,
  "registry-mirrors": ["https://docker.m.daocloud.io"]
}
```

4. 点 **Apply & Restart**，等鲸鱼图标稳定

### 或者手动拉一次

```bash
docker pull docker.m.daocloud.io/mlikiowa/napcat-docker:latest
docker tag docker.m.daocloud.io/mlikiowa/napcat-docker:latest mlikiowa/napcat-docker:latest
```

拉完再跑 `bash scripts/bootstrap.sh`，它会跳过拉取直接起容器。

---

## 常见问题

| 现象 | 处理 |
|---|---|
| `docker: command not found` | Docker Desktop 没装好，或装完没重启终端（脚本会自动去 `/Applications/Docker.app/.../bin` 找） |
| `Cannot connect to the Docker daemon` | Docker 没启动，打开「应用程序 → Docker」等鲸鱼稳定 |
| `failed to resolve reference ... registry-1.docker.io ... context deadline exceeded` | **国内连不上 Docker Hub**。`bootstrap.sh` 已内置自动回退，见下节 |
| 端口 3000/3001/6099 被占用 | `lsof -nP -iTCP:3001 -sTCP:LISTEN` 找出占用进程；或改 `docker-compose.yml` 的端口映射 |
| 容器一直 restart | `docker logs --tail 50 napcat` 看原因；多半是挂载目录权限，重跑 `bootstrap.sh` |
| WebUI 打不开 | 用 `http://127.0.0.1:6099/webui`（本机访问，别用局域网 IP） |
| 扫码后立刻掉线 | 小号被风控。换个号，或换网络环境（别用公司/学校网） |
| **每次重启容器都要重新扫码** | 大概率是没配 `ACCOUNT`：`docker logs napcat` 里会有 `快速登录失败，未找到该 QQ 历史登录记录`。按上面「日常运维」那节建 `.env` 并 `--force-recreate` |
| 群里 @ 了没反应 | 先 `node scripts/check-onebot.js` 确认通道；再确认群号在 `allow.groups` 里；再 `docker logs` 看有没有收到事件 |
| 发本地图片失败 | 这是 macOS 原生路线的沙盒问题；**容器路线没有这个坑** |
