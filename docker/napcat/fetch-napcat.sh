#!/usr/bin/env bash
# 并行分块下载 NapCat.Shell.zip。
#
# 为什么不用 curl 直接下：GitHub Releases 在国内单线程只有 30-50 KB/s，
# 而且经常中途断流（SSL_read: unexpected eof）。实测把文件切成 8 段并行拉，
# 28 MB 从「十几分钟还下不完」变成 1 分 49 秒。
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

VERSION="${NAPCAT_VERSION:-v4.18.28}"
CHUNKS="${NAPDL_CHUNKS:-8}"
OUT="NapCat.Shell.zip"
URL="https://github.com/NapNeko/NapCatQQ/releases/download/${VERSION}/${OUT}"

say() { printf "\033[1m%s\033[0m\n" "$1"; }

# 先取总长度
TOTAL="$(curl -sIL --max-time 30 "$URL" 2>/dev/null | grep -i '^content-length' | tail -1 | tr -dc '0-9')"
if [ -z "$TOTAL" ]; then
  echo "✗ 拿不到文件长度，检查网络或版本号（当前 $VERSION）"
  exit 1
fi
say "目标 ${OUT}  ${VERSION}  $((TOTAL / 1048576)) MB  分 ${CHUNKS} 段并行"

CHUNK=$(( (TOTAL + CHUNKS - 1) / CHUNKS ))

dl() {
  local start=$1 end=$2 out=$3
  local want=$((end - start + 1))
  local try have
  for try in 1 2 3 4 5 6 7 8 9 10; do
    have=0
    [ -f "$out" ] && have=$(stat -f%z "$out" 2>/dev/null || echo 0)
    [ "$have" -ge "$want" ] && return 0
    curl -sL -r $((start + have))-$end --connect-timeout 30 --max-time 280 \
      "$URL" -o "$out" 2>/dev/null
    have=$(stat -f%z "$out" 2>/dev/null || echo 0)
    [ "$have" -ge "$want" ] && return 0
  done
  return 1
}

rm -f .dlpart.* NapCat.Shell.zip
for i in $(seq 0 $((CHUNKS - 1))); do
  s=$((i * CHUNK))
  e=$((s + CHUNK - 1))
  [ $e -ge $TOTAL ] && e=$((TOTAL - 1))
  dl $s $e ".dlpart.$i" &
done
wait

# 合并
: > "$OUT"
for i in $(seq 0 $((CHUNKS - 1))); do
  cat ".dlpart.$i" >> "$OUT" || { echo "✗ 分片 $i 缺失"; exit 1; }
done
rm -f .dlpart.*

GOT=$(stat -f%z "$OUT" 2>/dev/null || echo 0)
if [ "$GOT" -ne "$TOTAL" ]; then
  echo "✗ 大小不符：拿到 $GOT，期望 $TOTAL"
  exit 1
fi

if command -v unzip >/dev/null 2>&1; then
  if unzip -tq "$OUT" > /dev/null 2>&1; then
    say "✓ 下载完成并通过 zip 完整性校验（$((GOT / 1048576)) MB）"
  else
    echo "✗ zip 校验失败，文件损坏"
    exit 1
  fi
else
  say "✓ 下载完成（$((GOT / 1048576)) MB，未校验）"
fi
