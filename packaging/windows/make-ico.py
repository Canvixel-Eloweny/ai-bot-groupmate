#!/usr/bin/env python3
"""把一张方形图做成 Windows 快捷方式用的 .ico。

为什么不用 `assets/` 里现成的 PNG 直接当图标：
  Windows 的 .lnk 只认 .ico（或 exe/dll 里嵌的图标资源）。给 PNG 会静默退回
  默认程序图标 —— 表现为"快捷方式建好了，图标是白的"，而脚本一句错都不报。

为什么 ICO 里要放**多个尺寸**（16/24/32/48/64/128/256）：
  桌面图标、任务栏、资源管理器三处取的尺寸不同。只放一张 256 的话，
  16px 那档是系统硬缩放出来的，边缘会糊成一团 —— 而"糊"同样不会报错。
  256 那一档 Pillow 会以 PNG 方式存进 ICO（Vista+ 支持，且体积比 BMP 小得多）。

用法（需要 Pillow，与 scripts/make-appicon.py 同一套依赖）：
    python3 packaging/windows/make-ico.py <方形图> <输出.ico>
    python3 packaging/windows/make-ico.py --rounded <方形图> <输出.ico>
                                         └ --rounded：套 macOS 同款圆角
                                           （Apple squircle 比例 185.4/824，
                                           与 scripts/make-appicon.py 传统模式一致；
                                           2026-10-13 维护者要求：快捷图标别方方正正）
"""

import sys
from pathlib import Path

from PIL import Image, ImageDraw

SIZES = [16, 24, 32, 48, 64, 128, 256]

# macOS 同款圆角比例：Apple 规范里 824 的图形配 185.4 的圆角（见 make-appicon.py）
ROUND_RADIUS_RATIO = 185.4 / 824
_SS = 4  # 遮罩超采样倍数（抗锯齿），与 make-appicon.py 同一做法


def rounded_alpha(size: int) -> Image.Image:
    """带抗锯齿的圆角 alpha 遮罩（超采样后缩回）。"""
    big = Image.new("L", (size * _SS, size * _SS), 0)
    ImageDraw.Draw(big).rounded_rectangle(
        (0, 0, size * _SS - 1, size * _SS - 1),
        radius=round(size * ROUND_RADIUS_RATIO) * _SS, fill=255,
    )
    return big.resize((size, size), Image.LANCZOS)


def main():
    args = [a for a in sys.argv[1:]]
    rounded = "--rounded" in args
    args = [a for a in args if a != "--rounded"]
    if len(args) != 2:
        sys.exit("用法：make-ico.py [--rounded] <方形图> <输出.ico>")
    src, out = args

    img = Image.open(src)
    # ⚠️ 必须带 alpha：快捷方式图标是叠在桌面背景上的，没有透明通道会露出一圈白底。
    img = img.convert("RGBA")
    if img.width != img.height:
        side = min(img.width, img.height)
        img = img.crop(((img.width - side) // 2, (img.height - side) // 2,
                        (img.width + side) // 2, (img.height + side) // 2))

    if rounded:
        # 圆角要在**全尺寸源图**上做（先 mask 后缩尺寸），边缘才够细
        img.putalpha(rounded_alpha(img.width))

    Path(out).parent.mkdir(parents=True, exist_ok=True)
    img.save(out, format="ICO", sizes=[(s, s) for s in SIZES])
    print(f"已生成 {out}（{img.width}x{img.height} 源 · "
          f"{'圆角 ' if rounded else ''}{len(SIZES)} 档 · "
          f"{Path(out).stat().st_size / 1024:.0f}KB）")


if __name__ == "__main__":
    main()
