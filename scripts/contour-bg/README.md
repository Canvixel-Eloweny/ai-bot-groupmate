# 等高线背景生成器

仅开发工具，不参与面板运行时，不新增运行时依赖，不需要 ffmpeg。

浅色为**中性奶白底 + 纯黑细线**（不带暖纸/偏黄）；深色为纯黑底 + 白线。
2026-10-27 HUD 三处定位调整后浅/深两套内容都变过，客户端统一用 `?v=4` 做缓存淘汰。

## 产物

放进 `panel/next/assets/contour/`：

| 文件 | 规格 |
|---|---|
| `contour-light-standard-v2.mp4` / `contour-dark-standard-v2.mp4` | 2560×1440 · 24fps · 30s · H.264 · 约 6.5Mbps |
| `contour-light-lite-v2.mp4` / `contour-dark-lite-v2.mp4` | 1280×720 · 20fps · 30s · H.264 · 约 1.3Mbps |
| `contour-light-v2.jpg` / `contour-dark-v2.jpg` | 2560×1440 · JPEG q0.90 |

实测最终产物：标准约 24.5MB/个，低配约 4.9MB/个，海报约 0.43–0.47MB/个；全套约 59.7MB。

## 环境

- Node.js 24+（使用全局 `WebSocket` 与 `fetch`）
- Edge / Chrome / Chromium（脚本默认找 Microsoft Edge，可用 `EDGE_PATH` 覆盖）
- macOS + Swift/AVFoundation（`encode.swift`）

## 1. 视觉源

`preview.html` 是唯一视觉源；改构图、颜色、终端元素只改它。双击可实时预览：

- `?theme=light|dark`
- `?speed=0|0.5|1|2`
- `?ui=1` 显示玻璃控制台遮罩（默认关闭）
- `?t=8` 冻结到第 8 秒
- `?capture=1` 隐藏所有控件（生成视频用）
- `?legacy=1` 简洁版（最终采用）：去掉点位高程/比例尺/剖面/方位线/坐标/引导标注，保留地形、终端读数、准星、罗盘、波形
  · HUD 安全区：顶部终端基线 `top=92`（避开顶栏）；右下罗盘组右缘 `W-88`（16:10 视口 cover 左右各裁 80 后仍留 8px）

最终资产生成与自检都要带 `--legacy`；不带则是“完整辅助元素”对照版。

## 2. 自检无缝循环

```bash
node scripts/contour-bg/capture.mjs --selftest
```

期望 `loopLight=true`、`loopDark=true`、`changes=true`。原理是 `t=0` 与 `t=30` 的像素哈希一致，而 `t=0` 与 `t=1` 不同。

## 3. 海报

```bash
node scripts/contour-bg/capture.mjs --posters /tmp/contour-posters --legacy
```

## 4. 帧序列 + 编码

一次只生成一套，编码完立刻删掉 PNG，避免几 GB 临时文件堆积：

```bash
for theme in light dark; do
  for quality in standard lite; do
    if [ "$quality" = "standard" ]; then
      w=2560; h=1440; fps=24; rate=6500000
    else
      w=1280; h=720; fps=20; rate=1300000
    fi
    dir="/tmp/contour-$theme-$quality"
    node scripts/contour-bg/capture.mjs --theme "$theme" --quality "$quality" --dir "$dir" --legacy
    swift scripts/contour-bg/encode.swift \
      --input "$dir" \
      --output "panel/next/assets/contour/contour-$theme-$quality-v2.mp4" \
      --width "$w" --height "$h" --fps "$fps" --bitrate "$rate"
    rm -rf "$dir"
  done
done
# AVAssetWriter 会在输出旁留下 `*.mp4.sb-*` 临时副本，必须删掉（§163⑥ 会拦）
find panel/next/assets/contour -maxdepth 1 -name '*.sb-*' -delete
```

`encode.swift` 使用 `AVAssetWriter`，`shouldOptimizeForNetworkUse=true`，因此 `moov` 在 `mdat` 前（faststart）。无音轨。

## 5. 验收

```bash
# MP4 结构
node -e "const fs=require('fs');const b=fs.readFileSync(process.argv[1]);console.log({ftyp:b.slice(4,8).toString(),faststart:b.indexOf('moov')>0&&b.indexOf('moov')<b.indexOf('mdat')})" panel/next/assets/contour/contour-light-standard-v2.mp4
```

再用 Edge 真播一次，确认 `canPlayType('video/mp4; codecs="avc1.42E01E"')` 非空、`readyState>=3`、`currentTime` 前进、无 `error`。已实测 Edge 156：`canPlayType=probably`、`readyState=4`、1600×900、播放正常。

## 6. 命名与缓存

文件名带 `v2`；重新生成视觉后升版本号，同步改 `panel/next/contour-bg.js` 与 `panel/lib/next-page.js` 的媒体表。服务端对这批文件发长缓存，文件名不变不能覆盖；只改内容不改名时，在 `contour-bg.js` 的 `mediaUrl` 里递增 `?v=`（当前 `?v=4`，浅深两套共用）。
