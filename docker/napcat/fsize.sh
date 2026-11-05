#!/usr/bin/env bash
# 可移植的文件字节数：GNU stat（Linux）与 BSD stat（macOS）参数不同。
# 用法：source ./fsize.sh; n=$(fsize path)
# 文件不存在 / 读不到 → 0（与旧实现的 `|| echo 0` 同语义）。
fsize() {
  local f="${1:-}"
  [ -f "$f" ] || { echo 0; return 0; }
  stat -c%s "$f" 2>/dev/null || stat -f%z "$f" 2>/dev/null || echo 0
}
