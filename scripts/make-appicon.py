#!/usr/bin/env python3
"""把一张图片做成 macOS 应用图标（.icns）。

两种模式
--------
1) 传统模式（默认）——符合 Apple 老的 macOS 图标规范：画布 1024×1024，
   图形占 824×824 居中、圆角半径 185.4，四周留透明。和系统自带图标并排时
   大小/圆角一致，不会显得"胖一圈"。

2) 满版模式（--full-bleed）——**macOS 26 (Tahoe) 及以上必须用这个**。
   新系统的图标系统会给画布自动套一层容器，并把画布上的**透明区域填成灰色材质**。
   传统模式四周那圈留白就会被渲染成难看的一圈灰框。把美术铺满整张画布即可消除。

   满版模式下如果给了 --figure（带透明通道的角色图），会自动合成
   渐变背景 + 角色，产出一张铺满的底图，不用手工拼。

用法（需要 Pillow）：
    # macOS 26+：合成满版图标（推荐）
    python scripts/make-appicon.py --full-bleed \
        --figure assets/appicon-figure.png \
        --preview QQ-BOT-CONTROL.app/Contents/Resources/AppIcon-preview.png \
        QQ-BOT-CONTROL.app/Contents/Resources/AppIcon.icns

    # 传统模式：直接吃一张方形图
    python scripts/make-appicon.py <方形图> <输出.icns>

生成后刷新图标缓存（Finder / Dock 有时会显示旧图标）：
    touch "<目标>.app" && killall Dock
"""
import argparse
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

CANVAS = 1024          # 画布边长
ART = 824              # 传统模式图形边长（Apple 规范）
RADIUS = 185.4         # 传统模式圆角半径（Apple 规范）
SS = 4                 # 遮罩超采样倍数，用于抗锯齿

# 满版模式的背景配色（浅蓝渐变 + 顶部柔光，和封面同一套视觉）
BG_FROM = (245, 250, 255)
BG_TO = (188, 213, 250)
GLOW_CENTER = (0.50, 0.34)   # 相对坐标
GLOW_RADIUS = 0.66
GLOW_STRENGTH = 0.60

ICONSET = [
    (16, "icon_16x16.png"), (32, "icon_16x16@2x.png"),
    (32, "icon_32x32.png"), (64, "icon_32x32@2x.png"),
    (128, "icon_128x128.png"), (256, "icon_128x128@2x.png"),
    (256, "icon_256x256.png"), (512, "icon_256x256@2x.png"),
    (512, "icon_512x512.png"), (1024, "icon_512x512@2x.png"),
]


def squircle_mask(size: int, radius: float) -> Image.Image:
    """带抗锯齿的圆角矩形遮罩（超采样后缩放）。"""
    big = Image.new("L", (size * SS, size * SS), 0)
    ImageDraw.Draw(big).rounded_rectangle(
        (0, 0, size * SS - 1, size * SS - 1), radius=radius * SS, fill=255
    )
    return big.resize((size, size), Image.LANCZOS)


def center_square(img: Image.Image) -> Image.Image:
    """居中方形裁切：源图不是正方形时也不会被拉变形。"""
    side = min(img.size)
    left = (img.width - side) // 2
    top = (img.height - side) // 2
    return img.crop((left, top, left + side, top + side))


def compose_full_bleed(figure_path: Path, size: int = CANVAS) -> Image.Image:
    """渐变背景 + 顶部柔光 + 角色，铺满整张画布。"""
    y, x = np.mgrid[0:size, 0:size].astype(np.float32)

    # 斜向渐变
    t = (x + y) / (2 * (size - 1))
    c0 = np.array(BG_FROM, np.float32)
    c1 = np.array(BG_TO, np.float32)
    rgb = c0[None, None, :] * (1 - t)[..., None] + c1[None, None, :] * t[..., None]

    # 顶部柔光，做出体积感
    cx, cy = GLOW_CENTER[0] * size, GLOW_CENTER[1] * size
    d = np.sqrt((x - cx) ** 2 + (y - cy) ** 2) / (size * GLOW_RADIUS)
    g = np.clip(1.0 - d, 0.0, 1.0) ** 1.7 * GLOW_STRENGTH
    rgb = rgb * (1 - g)[..., None] + 255.0 * g[..., None]

    bg = Image.fromarray(rgb.clip(0, 255).astype(np.uint8), "RGB")

    # 角色：按画布高度等比放大后居中，两侧自然出血
    fig = Image.open(figure_path).convert("RGBA")
    scale = size / fig.height
    fig = fig.resize((max(1, round(fig.width * scale)), size), Image.LANCZOS)
    bg.paste(fig, ((size - fig.width) // 2, 0), fig)
    return bg


def build_icon(src: Image.Image, dst: Path, full_bleed: bool, preview: Path | None):
    if full_bleed:
        master = src.convert("RGBA")          # 已是 1024 满版底图
    else:
        art = src.resize((ART * SS, ART * SS), Image.LANCZOS)
        art.putalpha(squircle_mask(ART * SS, RADIUS * SS))
        art = art.resize((ART, ART), Image.LANCZOS)
        master = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
        off = (CANVAS - ART) // 2
        master.paste(art, (off, off), art)

    with tempfile.TemporaryDirectory() as tmp:
        iconset = Path(tmp) / "AppIcon.iconset"
        iconset.mkdir()
        for px, name in ICONSET:
            master.resize((px, px), Image.LANCZOS).save(iconset / name)
        subprocess.run(["iconutil", "-c", "icns", str(iconset), "-o", str(dst)],
                       check=True)

    if preview:
        master.convert("RGB").save(preview)
        print(f"✅ 预览 {preview}")
    print(f"✅ 图标 {dst}")


def main():
    ap = argparse.ArgumentParser(add_help=True)
    ap.add_argument("src", nargs="?", help="方形源图（传统模式）")
    ap.add_argument("dst", nargs="?", help="输出 .icns")
    ap.add_argument("--full-bleed", action="store_true",
                    help="铺满整张画布（macOS 26+ 必需）")
    ap.add_argument("--figure", help="透明角色图；给了就自动合成满版底图")
    ap.add_argument("--out", help="输出 .icns（等价于第二个位置参数）")
    ap.add_argument("--preview", help="另外输出一张 PNG 预览")
    a = ap.parse_args()

    dst = a.out or a.dst
    if not dst:
        sys.exit(__doc__)
    dst = Path(dst)
    preview = Path(a.preview) if a.preview else None

    if a.figure:
        src = compose_full_bleed(Path(a.figure))
        full_bleed = True
    elif a.src:
        src = center_square(Image.open(a.src).convert("RGB"))
        full_bleed = a.full_bleed
        if full_bleed:
            src = src.resize((CANVAS, CANVAS), Image.LANCZOS)
    else:
        sys.exit(__doc__)

    build_icon(src, dst, full_bleed, preview)


if __name__ == "__main__":
    main()
