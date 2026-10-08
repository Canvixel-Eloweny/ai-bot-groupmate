#!/bin/bash
# QQ-BOT-CONTROL —— 启动逻辑（真正的入口是原生壳 Contents/MacOS/launcher，
# 它负责让 Dock 图标像别的 App 一样弹一下，再把这份脚本甩到后台继续跑）。
#
# 做的事（按顺序）：
#   1. 控制台没跑 → 起它，等就绪
#   2. **立刻**打开浏览器（先让你看到页面）
#   3. 回头看 Docker Desktop / QQ 容器（慢活，不挡你看页面）
#
# 为什么把「开浏览器」提到 Docker 前面：
#   以前是先等 Docker（最多 90 秒）再等容器（最多 60 秒）才开页面。点完图标一两分钟
#   没反应，人会以为没点着 → 再点一次 → 起出两个控制台来。
#
# 机器人本身不自动启动，在页面里点「▶ 启动机器人」。
# 这样做是有意的：开控制台 ≠ 让机器人开始说话。
#
# ⚠️⚠️ 改了**本文件**（或 .app 里的**任何**文件）之后，必须重新做一次 ad-hoc 签名：
#
#        codesign --force --sign - --identifier local.qqbot.panel QQ-BOT-CONTROL.app
#
#     不签的后果不是"提示一下"，而是启动时报 `a sealed resource is missing or invalid`
#     —— 签名把 bundle 里所有资源都纳入了封印，动一个字节封印就废了。
#     这个 .app 是**本地 ad-hoc 签名**（没有开发者证书），所以重签不需要任何凭据，
#     一条命令即可；但**必须记得做**，而这件事没有任何自动机制会提醒你。
#     自检：`codesign --verify --verbose QQ-BOT-CONTROL.app`

# ---------- 0. 项目目录 ----------
# 按 .app 自身的位置推（放在项目里时，改项目文件夹名也不会失效）；
# 推不出来（比如把 .app 单独拷到桌面/应用程序里）就回落到已知路径。
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
KNOWN_DIR="$HOME/WorkBuddy/WB/QQ-BOT-Creative"
if [ -f "$SELF_DIR/panel/server.js" ]; then
  DIR="$SELF_DIR"
else
  DIR="$KNOWN_DIR"
fi

cd "$DIR" || {
  osascript -e 'display alert "找不到项目目录" message "QQ-BOT-Creative 项目不在原来的位置了。"'
  exit 1
}

DOCKER="/Applications/Docker.app/Contents/Resources/bin/docker"
[ -x "$DOCKER" ] || DOCKER="$(command -v docker 2>/dev/null)"

# 通知走**参数**，而不是把文案插进 AppleScript 的源码串（L-01 · 2026-10-05 · 第 12 轮）。
#
# 旧写法是 `osascript -e "display notification \"$1\" …"`：它把 `$1` 拼进**一段代码**。
# 现在每一个调用点传的都是硬编码中文文案（已逐个核对：本文件里 notify 的调用点全是字面量），
# 所以**当前不可利用** —— 但哪天有人把容器挂载路径或 docker 的输出传进来，
# 它就成了一条脚本注入（`$1` 里的引号能闭合字符串、拼出任意 AppleScript）。
#
# `on run argv` 让 osascript 把文案当**数据**收下，和"参数化查询"是同一个道理：
# 数据永远不进代码通道，于是引号、反斜杠、分号都不再需要转义。
# ⚠️ 三个 `-e` 合起来是一段完整的 `on run … end run`：少任何一个，
#    osascript 收到的就不是脚本处理器，而是裸语句 —— 那样 argv 根本不会被绑定。
notify() {
  osascript -e 'on run argv' \
           -e 'display notification (item 1 of argv) with title "QQ-BOT-CONTROL"' \
           -e 'end run' "$1" >/dev/null 2>&1
}

docker_ready() {
  [ -n "$DOCKER" ] && "$DOCKER" info >/dev/null 2>&1
}

# 面板 token（B9c · AUTH-PANEL）：写路由要带它，且这个脚本自己就在调用一个写路由
# （下面的 /api/panel/restart）—— **不带的话，最先用不了的就是这一套**
# "控制台版本自检 / 一键换新代码"。
# 每一次调用都重读一遍文件：token 可能是**本次**重启后才由新进程生成的，
# 缓存早于那次的结果只会拿到空值。
panel_token() {
  [ -f "$DIR/panel/.token" ] || return 0
  tr -d '\n' < "$DIR/panel/.token" 2>/dev/null
}

# 带上 token（有就带、没有就不带 —— 兼容还没生成 token 的旧面板）
pcurl() {
  local t
  t="$(panel_token)"
  if [ -n "$t" ]; then
    curl -s --noproxy '*' -H "Authorization: Bearer $t" "$@"
  else
    curl -s --noproxy '*' "$@"
  fi
}

panel_up() {
  curl -s --noproxy '*' -o /dev/null --max-time 2 "http://127.0.0.1:8788/api/state" 2>/dev/null
}

# 让一个**已经在跑、但跑着旧代码**的控制台换成新代码。
#
# 为什么必须有这一步：`panel_up` 只探端口通不通，而一个活着的旧面板永远探得通 ——
# 所以"改了 panel/server.js 却没生效"能一直存在下去，表现是页面上有些按钮
# 点了毫无反应（index.html 每次请求读盘所以是新的，server.js 启动后就进内存了）。
#
# 两段式：
#   ① 先打面板自己的 /api/panel/restart —— 它是幂等的，代码没变就什么都不做。
#   ② 老到连这个接口都没有（404）→ 只能按端口找出 pid 手动换掉。
panel_refresh() {
  local r
  r="$(pcurl --max-time 5 -X POST "http://127.0.0.1:8788/api/panel/restart" 2>/dev/null)"
  case "$r" in
    *'"restarted":true'*)
      notify "控制台正在加载新代码，几秒就好…"
      # 判据用「已是最新代码」这句 —— 只有**新**进程才会这么回。
      # 不能用 restarted:false 判断：重启中的旧进程也回 restarted:false，会误判成已完成。
      for _ in $(seq 1 40); do
        sleep 0.5
        pcurl --max-time 2 -X POST "http://127.0.0.1:8788/api/panel/restart" 2>/dev/null \
          | grep -q '已是最新代码' && break
      done
      ;;
    *'"ok":true'*) : ;;   # 已经是最新代码，什么都不用做
    *)
      local pid
      pid="$(lsof -ti :8788 2>/dev/null | head -1)"
      if [ -n "$pid" ]; then
        notify "控制台版本过旧，正在重启…"
        kill "$pid" 2>/dev/null
        for _ in $(seq 1 20); do
          sleep 0.2
          lsof -ti :8788 >/dev/null 2>&1 || break
        done
        STARTOVER=1
      fi
      ;;
  esac
}

# 页面开出来之后告诉原生壳「可以让 Dock 图标消失了」—— 图标在 Dock 上停留的时长
# 就等于「从点图标到页面出来」，和别的 App 一致。
MARK_OPENED="/tmp/qqbot-control-opened"
rm -f "$MARK_OPENED"

# 打开的页面 —— **只有一套**了（2026-10-02）。
#
# 新版搬到**根**上：`http://127.0.0.1:8788/` 就是它，资产是 `/style.css`、`/app.js`…
# （必须同层挂在根上：页面里的引用是相对路径，入口在根而资产在子目录会让 `./app.js`
#  被解析到子目录去 → 404 → 白屏，而两个地址各自都是 200。
#  老地址 `/next/` 由面板做一次 302 兜底，书签不会打到 404。）
#
# ⚠️ **旧页面的文件已经删除**（2026-10-05 · S-12 第六批）：`panel/parts/` 的 16 个片段、
#    `panel/lib/page-parts.js`、`test/verify-panel.mjs`、`test/e2e/verify-fixes.mjs`
#    全部不在仓库里了。此前它们"还在磁盘上、只是运行时零引用"是**登记过的过渡态**
#    （本条曾写成"已连同 page-parts.js 一起删除"，那在当时是**不实描述**，已更正）。
#    现在收口完毕：契约先改完，文件才删 —— 顺序就是当时写下的那条前置条件。
#    「那套机制不许回到运行时」由 `check-wb` §66 继续钉着。
#
# 所以这里**不再需要**"探一探新版在不在、不在就回落旧页"那套决策：没有第二个可回落的目标了。
# 面板有没有起来由上面的 `panel_up` 负责等；真起不来也照常开这一页，
# 浏览器与页面都会把"连不上"如实显示出来，比一个静默的"什么都不开"更好懂。
PANEL_URL="http://127.0.0.1:8788/"
open_panel() {
  open "$PANEL_URL"
  touch "$MARK_OPENED"
}

# ---------- 1. 单实例锁 ----------
# 双击两下、或在 Dock 上连点两次时，两个实例会各起一个控制台：后起的抢不到端口，
# 会往日志里丢一条报错，页面也可能连到一个"半死"的服务上。
# 用 mkdir 的原子性当锁 —— 只有拿到锁的那个实例负责启动，其余的直接开页面。
LOCK="/tmp/qqbot-control.lock"
if ! mkdir "$LOCK" 2>/dev/null; then
  # 锁也可能是上次异常退出留下的：超过 5 分钟就当它已经死了
  if [ -n "$(find "$LOCK" -maxdepth 0 -mmin +5 2>/dev/null)" ]; then
    rmdir "$LOCK" 2>/dev/null
  fi
  if ! mkdir "$LOCK" 2>/dev/null; then
    # 已经有一个实例在启动中：等它就绪再开页面，绝不重复起进程
    for _ in $(seq 1 30); do
      panel_up && break
      sleep 0.3
    done
    open_panel
    exit 0
  fi
fi
trap 'rmdir "$LOCK" 2>/dev/null' EXIT

# ---------- 2. 控制台 ----------
start_panel() {
  NODE=""
  for c in "$HOME/.workbuddy/binaries/node/versions/22.22.2-3/bin/node" \
           "/usr/local/bin/node" "/opt/homebrew/bin/node"; do
    [ -x "$c" ] && NODE="$c" && break
  done
  [ -z "$NODE" ] && NODE="$(command -v node 2>/dev/null)"

  if [ -z "$NODE" ] || [ ! -x "$NODE" ]; then
    osascript -e 'display alert "找不到 Node.js" message "需要先装 Node.js 22 或更高版本。告诉我，我来装。"'
    exit 1
  fi

  nohup "$NODE" "$DIR/panel/server.js" > "$DIR/panel/panel.log" 2>&1 &
  disown 2>/dev/null || true

  for _ in $(seq 1 33); do
    panel_up && break
    sleep 0.3
  done
}

if panel_up; then
  # 已经在跑 —— 但**跑的不一定是磁盘上的代码**。先确认一次版本，
  # 需要的话换掉它。这一步是整份脚本里最容易漏、后果最隐蔽的一环：
  # 漏了它，"改了后端却点了没反应"能一直存在，而且看起来像前端做坏了。
  panel_refresh
  [ "${STARTOVER:-0}" = "1" ] && start_panel
else
  start_panel
fi

# ---------- 3. 开页面 ----------
# 到这儿就开，不再等 Docker —— 慢活留给下面几步慢慢做。
open_panel

# 启动期的活干完了，放锁：后面无论再点几下，都不会起出第二个控制台。
# （Docker 那几步是幂等的，重复执行无害，所以不需要一直占着锁。）
rmdir "$LOCK" 2>/dev/null
trap - EXIT

# ---------- 4. Docker Desktop ----------
if ! docker_ready; then
  notify "正在启动 Docker Desktop，约需 30 秒…"
  open -a Docker 2>/dev/null
  for _ in $(seq 1 90); do
    docker_ready && break
    sleep 1
  done
fi

# Docker 没起来也别把人挡在门外：
# 以前这里会弹窗并直接退出，结果控制台打不开、页面也看不到，只能干瞪眼。
# 现在照常往下走，页面顶部有「一键启动」，用户能自己重试、也能看到卡在哪一步。
if ! docker_ready; then
  notify "Docker 暂时没起来，控制台仍会打开 —— 在页面里点「一键启动」可重试"
  exit 0
fi

# ---------- 5. QQ 容器 ----------
# 先看容器挂在哪儿。Docker 把 bind 的**绝对路径**存在容器里，docker start 会原样沿用：
# 项目文件夹一旦改名/搬家，它会挂到那个已不存在的旧路径上，而且**不报错** ——
# 静静新建一个空目录。表现是「OneBot 配置和 QQ 登录态全没了、怎么扫码都登录失败」。
# 2026-09-17 真踩到过一次（qq-bot → QQ-BOT-Creative），所以这里必须查一下。
STALE="$("$DOCKER" inspect napcat --format '{{range .Mounts}}{{.Source}}{{"\n"}}{{end}}' 2>/dev/null \
          | while IFS= read -r s; do
              [ -n "$s" ] || continue
              case "$s" in "$DIR"/*) ;; *) echo "$s" ;; esac
            done)"

if [ -n "$STALE" ]; then
  notify "容器挂在旧的项目路径上，正在重建（登录态不会丢）…"
  "$DOCKER" rm -f napcat >/dev/null 2>&1
  "$DOCKER" compose -f "$DIR/docker-compose.yml" up -d >/dev/null 2>&1
fi

if ! "$DOCKER" ps --filter name=napcat --format '{{.Names}}' 2>/dev/null | grep -q napcat; then
  notify "正在拉起 QQ 容器…"
  "$DOCKER" start napcat >/dev/null 2>&1 \
    || "$DOCKER" compose -f "$DIR/docker-compose.yml" up -d >/dev/null 2>&1
  for _ in $(seq 1 60); do
    "$DOCKER" ps --filter name=napcat --format '{{.Status}}' 2>/dev/null | grep -q '^Up' && break
    sleep 1
  done
fi
