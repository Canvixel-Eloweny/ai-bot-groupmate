#!/usr/bin/env python3
"""把一张方形图片做成 macOS 应用图标（.icns）。

按 Apple 的 macOS 图标规范绘制：画布 1024×1024，图形占 824×824 居中，
圆角半径 185.4，其余透明 —— 这样和系统自带图标并排时大小/圆角是一致的，
直接铺满整张画布会显得比别的图标"胖一圈"。

用法（需要 Pillow）：
    ~/.workbuddy/binaries/python/envs/default/bin/python scripts/make-appicon.py <源图> <输出.icns>

生成后建议刷新图标缓存（Finder 有时会显示旧图标）：
    touch "<目标>.app" && killall Dock
"""
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw

CANVAS = 1024          # 画布边长
ART = 824              # 图形边长（Apple 规范）
RADIUS = 185.4         # 圆角半径（Apple 规范）
SS = 4                 # 遮罩超采样倍数，用于抗锯齿

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


def build_icon(src: Path, dst: Path) -> None:
    img = Image.open(src).convert("RGB")

    # 居中方形裁切：源图不是正方形时也不会被拉变形
    side = min(img.size)
    left = (img.width - side) // 2
    top = (img.height - side) // 2
    img = img.crop((left, top, left + side, top + side))

    # 先缩到 4 倍目标尺寸再裁圆角，边缘更干净
    art = img.resize((ART * SS, ART * SS), Image.LANCZOS)
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
        subprocess.run(
            ["iconutil", "-c", "icns", str(iconset), "-o", str(dst)], check=True
        )
    print(f"✅ 已生成 {dst}")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    build_icon(Path(sys.argv[1]), Path(sys.argv[2]))
