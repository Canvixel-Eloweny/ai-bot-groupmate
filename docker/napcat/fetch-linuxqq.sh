#!/usr/bin/env bash
# 并行分块下载 Linux QQ 安装包（arm64 deb）。
#
# 下载地址不写死：腾讯 CDN 的路径带随机 hash 且会轮换，写死的链接过几天就 404。
# 这里每次都从官方配置接口实时解析当前版本（同时打印出来，方便确认是否在
# NapCat 的 Linux 白名单内，例如 3.2.33-52892）。
#
# 注意：实测部分网络环境下腾讯 CDN 会对该文件返回 403（Server: Lego Server）。
# 脚本失败时就按 README 的说明用浏览器手动下载，放到本目录名为 linuxqq.deb。
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

CHUNKS="${QQDL_CHUNKS:-8}"
OUT="linuxqq.deb"
CFG_URL="https://cdn-go.cn/qq-web/im.qq.com_new/latest/rainbow/linuxConfig.js"

say() { printf "\033[1m%s\033[0m\n" "$1"; }

ARCH="$(uname -m)"
case "$ARCH" in
  arm64|aarch64) ARCH_TAG=arm64 ;;
  x86_64|amd64)  ARCH_TAG=amd64 ;;
  *) echo "✗ 不支持的架构: $ARCH"; exit 1 ;;
esac

CFG="$(curl -fsSL --max-time 30 "$CFG_URL" 2>/dev/null)"
if [ -z "$CFG" ]; then
  echo "✗ 取不到版本配置，检查网络"
  exit 1
fi
VER="$(printf '%s' "$CFG" | grep -oE '"version":"[^"]+"' | head -1 | cut -d'"' -f4)"
URL="$(printf '%s' "$CFG" | tr ',' '\n' | grep -oE 'https://[^"]+\.deb' | grep "$ARCH_TAG" | head -1)"

# 候选源：先试官方配置解析出的地址，被拒再退到备用路径。
# 实测（2026-09-16，本机）：配置里那条 QQNTV2 路径的 CDN 直接返回 403，
# 而同域名下一个不存在的路径返回 404 —— 说明是访问策略层的拒绝，不是链接失效，
# 改 UA / Referer / Range 都无效。同一个安装包的 QQNT/beta 路径可以正常 200 下载
# （路径形式取自 Arch AUR linuxqq PKGBUILD）。
ALT_URL="${QQDL_ALT_URL:-https://qqdl.gtimg.cn/qqfile/QQNT/9.9.35/beta/1763096b/linuxqq_3.2.33-52892_arm64.deb}"

say "Linux QQ ${VER}  ${ARCH_TAG}"
TOTAL=""; PICK=""
for cand in "$URL" "$ALT_URL"; do
  [ -z "$cand" ] && continue
  len="$(curl -sIL --max-time 30 "$cand" 2>/dev/null | grep -i '^content-length' | tail -1 | tr -dc '0-9')"
  if [ -n "$len" ]; then TOTAL="$len"; PICK="$cand"; break; fi
  echo "  · 不可用，换下一个源：$cand"
done

if [ -z "$TOTAL" ]; then
  echo "✗ 所有候选源都拿不到文件长度（多半是被 CDN 拒了，HTTP 403）。请改用浏览器手动下载。"
  exit 1
fi
URL="$PICK"
echo "  ✓ 采用：$URL"
say "大小 $((TOTAL / 1048576)) MB，分 ${CHUNKS} 段并行"

CHUNK=$(( (TOTAL + CHUNKS - 1) / CHUNKS ))
dl() {
  local start=$1 end=$2 out=$3 want try have
  want=$((end - start + 1))
  for try in 1 2 3 4 5 6 7 8 9 10; do
    have=0
    [ -f "$out" ] && have=$(stat -f%z "$out" 2>/dev/null || echo 0)
    [ "$have" -ge "$want" ] && return 0
    curl -sL -r $((start + have))-$end --connect-timeout 30 --max-time 280 "$URL" -o "$out" 2>/dev/null
    have=$(stat -f%z "$out" 2>/dev/null || echo 0)
    [ "$have" -ge "$want" ] && return 0
  done
  return 1
}

rm -f .qpart.* "${OUT}.part"
for i in $(seq 0 $((CHUNKS - 1))); do
  s=$((i * CHUNK)); e=$((s + CHUNK - 1)); [ $e -ge $TOTAL ] && e=$((TOTAL - 1))
  dl $s $e ".qpart.$i" &
done
wait

: > "${OUT}.part"
for i in $(seq 0 $((CHUNKS - 1))); do
  cat ".qpart.$i" >> "${OUT}.part" || { echo "✗ 分片 $i 缺失"; exit 1; }
done
rm -f .qpart.*

GOT=$(stat -f%z "${OUT}.part" 2>/dev/null || echo 0)
if [ "$GOT" -ne "$TOTAL" ]; then
  echo "✗ 大小不符：拿到 $GOT，期望 $TOTAL"
  exit 1
fi
mv "${OUT}.part" "$OUT"
say "✓ 下载完成（$((GOT / 1048576)) MB）→ $(pwd)/$OUT"
