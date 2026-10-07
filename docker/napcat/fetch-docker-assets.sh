#!/usr/bin/env bash
#
# 拉取 NapCat-Docker 的 `entrypoint.sh` 与 `templates/*.json`（构建前的准备步骤）。
#
# ── 为什么这两个构件**不入库**（2026-10-05 开源前审查 · S-06）──────────────
#
#   NapCat 用的是 **Limited Redistribution License**（© 2024 Mlikiowa）：
#     · 未经主作者明确许可，禁止使用、复制、修改、分发；
#     · 允许再分发，但必须附带完整许可全文与来源信息；
#     · **为再分发而做的修改，不得以公开形式发布**；
#     · 禁止商业使用。
#   而本仓库 `THIRD-PARTY-NOTICES.md` 声明的合规边界正是
#   「**不链接、不修改、不复制它的任何代码**」「不随本仓库分发任何 NapCat 的代码」。
#   ⇒ 把上游的 `entrypoint.sh` / `templates/` 提交进来，会让那份声明变成伪陈述。
#      所以它们**只在本机下载**，与 `linuxqq.deb` / `NapCat.Shell.zip` 同一性质
#      （那两个也已在 `.gitignore` 里）。
#
# ⚠️ 而这个目录里**其它文件都照常入库**：`Dockerfile` / `fetch-napcat.sh` /
#    `fetch-linuxqq.sh` / `.dockerignore` 与**本脚本**都是本项目自己写的
#    （前三个满屏中文踩坑注释，一眼可辨）。它们不承载 NapCat 的代码。
#
# ── 用法 ──────────────────────────────────────────────────────────────────
#   ./fetch-docker-assets.sh            # 缺什么下什么；已存在的**跳过**
#   ./fetch-docker-assets.sh --force    # 覆盖（先把旧文件备份成 *.bak）
#
# ⚠️ 默认**不覆盖**是刻意的：本机的 `entrypoint.sh` 通常带着你自己的改造
#    （例如中文注释、调试开关），一次误覆盖很难发现。
#
# 环境变量：
#   NAPCAT_DOCKER_REF    上游分支/标签，默认 main
#   NAPCAT_DOCKER_PROXY  前缀式加速（见下面 MIRRORS，默认直连）
#
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

REF="${NAPCAT_DOCKER_REF:-main}"
PROXY="${NAPCAT_DOCKER_PROXY:-}"
REPO="NapNeko/NapCat-Docker"
FORCE=0
[ "${1:-}" = "--force" ] && FORCE=1

say() { printf "\033[1m%s\033[0m\n" "$1"; }
die() { printf "\033[31m✗ %s\033[0m\n" "$1" >&2; exit 1; }

# 上游路径（codeload 出的是仓库快照，顶层目录名带 ref）
URL="https://codeload.github.com/${REPO}/tar.gz/refs/heads/${REF}"
# 常见的前缀式加速站。**前缀式**意味着它不改写内容、只换域名，与 apt 镜像同性质。
# 用不用由你自己判断 —— 设 NAPCAT_DOCKER_PROXY 才会生效，默认直连。
#   https://ghfast.top/
#   https://gh-proxy.com/
#   https://ghproxy.net/
[ -n "$PROXY" ] && URL="${PROXY%/}/${URL}"

# ── 已存在且非强制 → 跳过 ─────────────────────────────────────────────────
have_entry=0; have_tpl=0
[ -f entrypoint.sh ] && have_entry=1
[ -d templates ] && [ -n "$(ls -A templates 2>/dev/null)" ] && have_tpl=1

if [ "$FORCE" -eq 0 ] && [ "$have_entry" -eq 1 ] && [ "$have_tpl" -eq 1 ]; then
  say "✓ entrypoint.sh 与 templates/ 都已在位 —— 跳过（要覆盖请用 --force）"
  exit 0
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

say "拉取 ${REPO}@${REF} …（只取 entrypoint.sh 与 templates/，其余丢弃）"
curl -fsSL --connect-timeout 30 --max-time 180 "$URL" -o "$TMP/src.tgz" \
  || die "下载失败。国内直连 GitHub 慢的话可以试试前缀加速，例如：
    NAPCAT_DOCKER_PROXY=https://ghfast.top ./$(basename "${BASH_SOURCE[0]}")"

tar xzf "$TMP/src.tgz" -C "$TMP" || die "解包失败（可能拿到的不是 tarball，看看是不是被加速站拦了）"

# 顶层目录名形如 `NapCat-Docker-main`
SRC="$(find "$TMP" -maxdepth 1 -type d -name 'NapCat-Docker-*' | head -1)"
[ -n "$SRC" ] || die "解包后找不到 NapCat-Docker-* 目录"

# ⚠️ 上游是 `templates/templates/*.json`（嵌套两层），COPY 进镜像的那一层是**内层**
TPL_SRC="$SRC/templates/templates"
[ -d "$TPL_SRC" ] || TPL_SRC="$SRC/templates"
[ -d "$TPL_SRC" ] || die "上游里找不到 templates 目录（上游结构变了？）"

copy_one() {
  local src="$1" dst="$2" label="$3"
  if [ -f "$dst" ] && [ "$FORCE" -eq 0 ]; then
    say "· ${label} 已存在，跳过"
    return 0
  fi
  if [ -f "$dst" ] && [ "$FORCE" -eq 1 ]; then
    cp -f "$dst" "${dst}.bak" && say "· ${label} 旧文件已备份为 ${dst}.bak"
  fi
  cp -f "$src" "$dst" || die "写入 ${label} 失败"
  say "✓ ${label} 已就位"
}

[ -f "$SRC/entrypoint.sh" ] || die "上游里没有 entrypoint.sh（上游结构变了？）"
copy_one "$SRC/entrypoint.sh" ./entrypoint.sh "entrypoint.sh"

mkdir -p templates
n=0
for f in "$TPL_SRC"/*.json; do
  [ -f "$f" ] || continue
  b="$(basename "$f")"
  if [ -f "templates/$b" ] && [ "$FORCE" -eq 0 ]; then continue; fi
  cp -f "$f" "templates/$b" || die "写入 templates/$b 失败"
  n=$((n + 1))
done
say "✓ templates/ 已就位（本次新增/更新 ${n} 个，共 $(ls -1 templates/*.json 2>/dev/null | wc -l | tr -d ' ') 个）"

chmod +x entrypoint.sh 2>/dev/null || true
say ""
say "下一步：回到项目根目录跑 docker compose up -d 构建镜像。"
say "（另有 fetch-napcat.sh 与 fetch-linuxqq.sh 需要先跑，它们取的是 NapCat 与 QQ 本体）"
