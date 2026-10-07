#!/usr/bin/env bash
# 看一眼整套链路的当前状态：容器、端口、桥接进程。
set -uo pipefail

bold() { printf "\033[1m%s\033[0m\n" "$1"; }

bold "容器"
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  docker ps -a --filter name=napcat --format '  状态: {{.Status}}  镜像: {{.Image}}  端口: {{.Ports}}' || true
  if [ -z "$(docker ps -q --filter name=napcat)" ]; then
    echo "  napcat 不在运行。启动：docker compose up -d"
  fi
else
  echo "  Docker 未安装或未运行"
fi

echo
bold "端口监听"
for p in 3000 3001 6099; do
  line="$(lsof -nP -iTCP:"$p" -sTCP:LISTEN 2>/dev/null | tail -n +2 | head -1)"
  if [ -n "$line" ]; then
    printf "  %-5s 已监听  %s\n" "$p" "$(echo "$line" | awk '{print $1}')"
  else
    printf "  %-5s 未监听\n" "$p"
  fi
done

echo
bold "桥接进程"
if pgrep -fl "node src/index.js" >/dev/null 2>&1; then
  pgrep -fl "node src/index.js" | sed 's/^/  /'
else
  echo "  未运行。启动：npm start"
fi

echo
bold "配置"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [ -f "$ROOT/config.json" ]; then
  echo "  config.json 存在"
  node -e '
    const c=require("'"$ROOT"'/config.json");
    console.log("  白名单群   :", (c.allow?.groups||[]).join(", ")||"(空)");
    console.log("  白名单私聊 :", (c.allow?.private||[]).join(", ")||"(空)");
    console.log("  空放行     :", c.allow?.allowAllWhenEmpty===true ? "是（危险）" : "否");
    console.log("  模型       :", c.llm?.model, "@", c.llm?.baseUrl);
  ' 2>/dev/null || echo "  config.json 解析失败"
else
  echo "  config.json 不存在，请先：cp config.example.json config.json"
fi
