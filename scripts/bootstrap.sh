#!/usr/bin/env bash
# 一键拉起 NapCat 协议端容器，并抓出 WebUI 登录地址。
# 前置：Docker Desktop 已安装且正在运行。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

IMAGE="mlikiowa/napcat-docker:latest"
# 国内可达的 Docker Hub 加速站（按实测可用性排序）。直连失败时依次回退。
MIRROR_CANDIDATES=(
  "docker.m.daocloud.io"
  "docker.1ms.run"
  "docker.xuanyuan.me"
  "docker.1panel.live"
)

bold() { printf "\033[1m%s\033[0m\n" "$1"; }
ok()   { printf "  \033[32m✓\033[0m %s\n" "$1"; }
bad()  { printf "  \033[31m✗\033[0m %s\n" "$1"; }
warn() { printf "  \033[33m!\033[0m %s\n" "$1"; }

# docker CLI 不一定在 PATH 里（Docker Desktop 装完常要重开终端）
if ! command -v docker >/dev/null 2>&1 && [ -x /Applications/Docker.app/Contents/Resources/bin/docker ]; then
  export PATH="/Applications/Docker.app/Contents/Resources/bin:$PATH"
fi

bold "1/5 检查 Docker 环境"

if ! command -v docker >/dev/null 2>&1; then
  bad "找不到 docker 命令"
  echo
  echo "  Docker Desktop 还没装。请先完成安装："
  echo "    1. 打开 https://www.docker.com/products/docker-desktop/"
  echo "    2. 下载 Apple Chip 版（Apple Silicon）"
  echo "    3. 打开 .dmg，把 Docker 拖进「应用程序」"
  echo "    4. 启动 Docker，按提示输入开机密码授权"
  echo "    5. 等菜单栏鲸鱼图标不再跳动（约 1-2 分钟）"
  echo "    6. 回来重跑本脚本"
  exit 1
fi
ok "docker 已安装：$(docker --version)"

if ! docker info >/dev/null 2>&1; then
  bad "Docker 守护进程没在跑"
  echo "  请打开「应用程序 → Docker」并等鲸鱼图标稳定，再重跑本脚本"
  exit 1
fi
ok "Docker 守护进程正常：$(docker info -f '{{.ServerVersion}}' 2>/dev/null || echo ok)"

if ! docker compose version >/dev/null 2>&1; then
  bad "docker compose 插件不可用，请升级 Docker Desktop"
  exit 1
fi
ok "docker compose 可用"

if [ "$(uname -m)" != "arm64" ]; then
  warn "本机不是 arm64，镜像会走模拟层，性能会下降"
else
  ok "架构 arm64，有镜像原生版本"
fi

bold "2/5 检查端口占用"
for p in 3000 3001 6099; do
  if lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1; then
    bad "端口 $p 已被占用"
    lsof -nP -iTCP:"$p" -sTCP:LISTEN | tail -n +2 | sed 's/^/      /'
    echo "  先关掉占用进程，或修改 docker-compose.yml 里的端口映射"
    exit 1
  fi
  ok "端口 $p 空闲"
done

# 国内直连 Docker Hub 基本必失败；免费加速站只能解析 manifest、拿不到大 layer。
# 所以是三级回退：本地已有 → 走加速站拉 → 干脆本地构建。
ensure_image() {
  if docker image inspect "$IMAGE" >/dev/null 2>&1; then
    ok "镜像已存在，跳过准备"
    return 0
  fi

  printf "  直连 Docker Hub 尝试中（国内通常超时，最多等 40 秒）…"
  if docker pull "$IMAGE" >/dev/null 2>&1; then
    echo " 成功"
    return 0
  fi
  echo " 失败"

  warn "改走国内加速站"
  for m in "${MIRROR_CANDIDATES[@]}"; do
    printf "    %-26s " "$m"
    if docker pull "$m/$IMAGE" >/dev/null 2>&1; then
      docker tag "$m/$IMAGE" "$IMAGE"
      echo "✓ 已拉取并打上标准标签"
      return 0
    fi
    echo "✗"
  done

  warn "加速站也拿不到，改走本地构建"
  echo "    底座 ubuntu:22.04 从加速站取，NapCat 和 QQ 在宿主机准备好再 COPY 进镜像"
  echo "    （这两个在国内都容易断流，先下好比在镜像里下可靠得多）"
  ensure_build_inputs || return 1
  echo "    首次构建约 1-2 分钟"
  if docker compose build napcat; then
    ok "本地构建完成，已打标签 $IMAGE"
    return 0
  fi

  bad "三级回退全部失败"
  echo
  echo "  手动排查："
  echo "    docker pull docker.m.daocloud.io/library/ubuntu:22.04    # 底座能不能拉"
  echo "    docker compose build --progress=plain napcat            # 看构建失败在哪一步"
  return 1
}

# 本地构建要先把两个大文件放到宿主机：NapCat 本体 + Linux QQ 安装包。
# 不在镜像里联网下的原因：GitHub 单线程 30-50 KB/s 且频繁断流，
# 腾讯 CDN 更是经常直接 403。先下好再 COPY，快且可复现。
ensure_build_inputs() {
  local dir="$ROOT/docker/napcat"
  local missing=0

  if [ ! -f "$dir/NapCat.Shell.zip" ]; then
    echo "  · 缺少 NapCat 本体，尝试并行分块下载…"
    ( cd "$dir" && ./fetch-napcat.sh ) || {
      bad "NapCat 本体没拿到"
      echo "    手动处理：cd $dir && ./fetch-napcat.sh"
      missing=1
    }
  else
    ok "NapCat 本体已就绪"
  fi

  if [ ! -f "$dir/linuxqq.deb" ]; then
    warn "缺少 Linux QQ 安装包（腾讯 CDN 常对本机返回 403）"
    echo "  · 先自动试一次并行下载…"
    if ( cd "$dir" && ./fetch-linuxqq.sh ); then
      ok "Linux QQ 安装包已就绪"
    else
      echo
      echo "    自动下载失败。请用浏览器手动下载（开着加速器一般能成功）："
      local qqurl
      qqurl="$(curl -fsSL --max-time 20 \
        https://cdn-go.cn/qq-web/im.qq.com_new/latest/rainbow/linuxConfig.js 2>/dev/null \
        | grep -oE 'https://[^"]+arm64_01\.deb' | head -1)"
      echo "      ${qqurl:-https://im.qq.com/linuxqq/ （进页面点下载）}"
      echo
      echo "    下载后把文件放到（名字必须叫 linuxqq.deb）："
      echo "      $dir/linuxqq.deb"
      echo
      echo "    然后重跑本脚本。也可以试试关掉加速器再让我重试 ——"
      echo "    腾讯 CDN 可能对境外 IP 返回 403。"
      missing=1
    fi
  else
    ok "Linux QQ 安装包已就绪"
  fi

  return $missing
}

bold "3/5 准备镜像"
echo "  镜像约 1.5 GB（内含整套 Linux QQ），首次要几分钟，别中断"
ensure_image

arch="$(docker image inspect "$IMAGE" -f '{{.Architecture}}/{{.Os}}' 2>/dev/null || echo '?')"
ok "本地镜像架构：$arch"

bold "4/5 拉起容器"
export NAPCAT_UID="$(id -u)"
export NAPCAT_GID="$(id -g)"
echo "  以 UID=$NAPCAT_UID GID=$NAPCAT_GID 运行（避免挂载目录权限问题）"

# 必须提前以当前用户身份建好挂载目录：如果让 Docker 自动创建，
# 目录会属于 root，容器内降权到 UID 501 后写不进去，表现为容器反复重启。
mkdir -p napcat/qq napcat/config
ok "挂载目录就绪：./napcat/qq  ./napcat/config"

docker compose up -d

for i in $(seq 1 40); do
  state="$(docker inspect -f '{{.State.Status}}' napcat 2>/dev/null || echo missing)"
  if [ "$state" = "running" ]; then ok "容器状态：running（等待 ${i}s）"; break; fi
  if [ "$state" = "missing" ]; then bad "容器创建失败，看日志：docker logs napcat"; exit 1; fi
  sleep 1
done
[ "$(docker inspect -f '{{.State.Status}}' napcat 2>/dev/null || echo missing)" = "running" ] \
  || { bad "容器没起来"; docker logs --tail 40 napcat; exit 1; }

bold "5/5 抓取 WebUI 登录信息"
found=""
for i in $(seq 1 30); do
  token="$(docker logs napcat 2>&1 | grep -oE 'token=[A-Za-z0-9._-]+' | tail -1 | cut -d= -f2 || true)"
  if [ -n "$token" ]; then
    found="$token"
    break
  fi
  sleep 1
done

echo
if [ -n "$found" ]; then
  ok "WebUI Token 已抓到"
  echo
  bold "  请在浏览器打开下面这个地址（已带 token，别把它发到任何群里）："
  echo "  http://127.0.0.1:6099/webui?token=$found"
else
  warn "没自动抓到 token，请手动从日志里找（找带 webui?token= 的那行）"
  echo "  docker logs napcat | grep -i webui"
fi

cat <<'EOF'

────────────────────────────────────────────────────────
接下来在 WebUI 里做三件事：

  1. 扫码登录你的小号（不要用主号）
  2. 左侧「网络配置」→ 新建 WebSocket 服务端 → 端口填 3001
  3. 同页 → 新建 HTTP 服务端 → 端口填 3000

完成后回到终端验证：

  cd QQ-BOT-Creative
  node scripts/check-onebot.js      # 探活：能不能连上 3001

然后用 Ctrl+C 停掉探活，改跑桥接：

  npm start

日常运维：
  bash scripts/status.sh            # 看容器 + 端口状态
  docker logs --tail 50 napcat      # 看协议端日志
────────────────────────────────────────────────────────
EOF
