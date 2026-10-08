#!/usr/bin/env python3
"""生成 GitHub 仓库的 Social preview（1280×640）。

为什么是这张图：GitHub 的 Social preview 是**别人在群里/社交平台贴这个仓库链接时，
自动展开的那张卡片**。不设的话 GitHub 给一张灰底占位图 —— 而这个项目的门面本来
就是那套深蓝配色的鲸鱼娘，没理由让链接展开成一块灰。

配色取自项目自己的资产，不另起一套：
  · 渐变两端来自 `QQ-BOT-CONTROL.app` 的 AppIcon（采样：浅 (235,243,253) / 深 (45,59,104)）
  · 角色立绘直接用 `assets/appicon-figure.png`（带透明通道，就是 App 图标用的那张）

用法：
    ~/.workbuddy/binaries/python/envs/default/bin/python scripts/make-social-preview.py <输出.png>
"""
import sys
from PIL import Image, ImageDraw, ImageFont

W, H = 1280, 640
TOP = (22, 32, 60)        # 深端（比 AppIcon 更深一点，为了让白字压得住）
BOTTOM = (52, 71, 122)    # 亮端
ACCENT = (140, 178, 235)  # 次要文字
TITLE = (255, 255, 255)

FONT_BOLD = ['/System/Library/Fonts/Supplemental/Arial Bold.ttf',
             '/System/Library/Fonts/HelveticaNeue.ttc',
             '/System/Library/Fonts/Helvetica.ttc']
FONT_REG = ['/System/Library/Fonts/Supplemental/Arial.ttf',
            '/System/Library/Fonts/HelveticaNeue.ttc',
            '/System/Library/Fonts/Helvetica.ttc']


def pick(paths):
    for p in paths:
        try:
            ImageFont.truetype(p, 20)
            return p
        except OSError:
            continue
    raise SystemExit('找不到可用字体（试过：%s）' % ', '.join(paths))


def gradient(size, top, bottom):
    im = Image.new('RGB', size)
    d = ImageDraw.Draw(im)
    for y in range(size[1]):
        t = y / max(1, size[1] - 1)
        d.line([(0, y), (size[0], y)], fill=tuple(round(top[i] + (bottom[i] - top[i]) * t) for i in range(3)))
    return im


def glow(base, cx, cy, rx, ry, color, alpha):
    """角色身后的一团柔光 —— 没有它，深底上的角色会像贴纸。"""
    layer = Image.new('RGBA', base.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    steps = 40
    for i in range(steps, 0, -1):
        k = i / steps
        d.ellipse([cx - rx * k, cy - ry * k, cx + rx * k, cy + ry * k],
                  fill=color + (round(alpha * (1 - k) ** 1.6),))
    return Image.alpha_composite(base.convert('RGBA'), layer)


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else 'social-preview.png'
    fb, fr = pick(FONT_BOLD), pick(FONT_REG)

    canvas = gradient((W, H), TOP, BOTTOM).convert('RGBA')
    canvas = glow(canvas, cx=980, cy=330, rx=560, ry=470, color=(96, 138, 214), alpha=64)

    figure = Image.open('assets/appicon-figure.png').convert('RGBA')
    fh = 620
    fw = round(figure.width * fh / figure.height)
    figure = figure.resize((fw, fh), Image.LANCZOS)
    canvas.alpha_composite(figure, (W - fw + 34, H - fh + 8))   # 右边缘略裁，构图更满

    d = ImageDraw.Draw(canvas)
    x, y = 78, 168
    d.text((x, y), 'QQ-BOT-Creative', font=ImageFont.truetype(fb, 58), fill=TITLE)
    y += 84
    for line in ['Turn a spare QQ account', 'into an AI group member.']:
        d.text((x, y), line, font=ImageFont.truetype(fr, 30), fill=(206, 222, 248))
        y += 42
    y += 26
    d.text((x, y), 'OneBot v11  ·  OpenAI-compatible  ·  Apache-2.0',
           font=ImageFont.truetype(fr, 20), fill=ACCENT)
    # 左侧一道细竖线当版心（和 README 里那种克制的排版一个调子）
    d.rectangle([x - 26, 176, x - 22, y + 26], fill=(96, 138, 214))

    canvas.convert('RGB').save(out, 'PNG', optimize=True)
    print('已生成 %s  %dx%d  %.1f KB' % (out, W, H, __import__('os').path.getsize(out) / 1024))


if __name__ == '__main__':
    main()
