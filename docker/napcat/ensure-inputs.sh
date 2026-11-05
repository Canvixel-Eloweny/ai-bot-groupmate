#!/usr/bin/env bash
# 源码回退构建的输入检查（2026-11-05 · 外部评估 P2）。
#
# Dockerfile 需要四样东西：entrypoint.sh / templates/ / NapCat.Shell.zip / linuxqq.deb。
# 其中 entrypoint.sh 与 templates/ 不随仓库提交（第三方许可），由 fetch-docker-assets.sh
# 拉取；两个大文件由各自的 fetch 脚本拉取。旧 bootstrap 只检查后两个 ——
# 干净检出的回退构建会先 COPY 失败，错误埋在 docker build 的几十行里。
#
# 用法：./ensure-inputs.sh [--no-fetch]
#   --no-fetch 只检查、不下载（测试/离线诊断用）
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"
NO_FETCH=0
[ "${1:-}" = "--no-fetch" ] && NO_FETCH=1

have_file() { [ -f "$1" ] && [ -s "$1" ]; }
have_tpl() { [ -d templates ] && [ -n "$(ls -A templates 2>/dev/null)" ]; }

try() {
  local script="$1" label="$2"
  if [ "$NO_FETCH" -eq 1 ]; then
    echo "  · 缺少 ${label}（--no-fetch：不下载）"
    return 1
  fi
  echo "  · 缺少 ${label}，尝试 ${script} …"
  if bash "./${script}"; then
    echo "  ✓ ${label} 已补齐"
    return 0
  fi
  echo "  ✗ ${label} 自动获取失败"
  return 1
}

if ! have_file entrypoint.sh || ! have_tpl; then
  try fetch-docker-assets.sh "entrypoint.sh / templates" || true
fi
if ! have_file NapCat.Shell.zip; then
  try fetch-napcat.sh "NapCat.Shell.zip" || true
fi
if ! have_file linuxqq.deb; then
  try fetch-linuxqq.sh "linuxqq.deb" || true
fi

missing=()
have_file entrypoint.sh || missing+=("entrypoint.sh")
have_tpl || missing+=("templates/")
have_file NapCat.Shell.zip || missing+=("NapCat.Shell.zip")
have_file linuxqq.deb || missing+=("linuxqq.deb")

if [ "${#missing[@]}" -ne 0 ]; then
  echo "✗ 源码回退构建缺少输入（已停止，未执行 docker compose build）："
  for m in "${missing[@]}"; do echo "    - ${m}"; done
  echo "  修复：在 $(pwd) 里补齐上述文件，或重跑 ./ensure-inputs.sh（需要网络）。"
  exit 1
fi

echo "✓ 源码回退构建输入齐全（entrypoint.sh / templates / NapCat.Shell.zip / linuxqq.deb）"
exit 0
