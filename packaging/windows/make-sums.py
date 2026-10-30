#!/usr/bin/env python3
"""生成包根的 SHA256SUMS.txt。

为什么要有它（而不是"手写一份"）：
  清单是**手写的**时候，"生成清单之后又改了源码"不会报任何错 —— 只会在用户
  手上变成一份对不上、却没人发现的包。`make-zip.py` 会在封包前强制校验它，
  但**校验的是别人写好的数**；这一步负责把那个数写对。

用法：
    python3 packaging/windows/make-sums.py <pkg目录>

清单内容 = 下面 `ITEMS` 里点名的那些文件（**不含** BUILD-INFO.txt ——
它记的是"这次构建本身"，把自己的哈希写进自己等于没法自证）。
缺文件会红着退出，不会静默少一行。
"""

import hashlib
import os
import sys

# 点名制，不开通配：多带一个文件就多一处要维护的哈希，而"顺手加上"最容易
# 把不该进清单的东西（例如将来某个含本机路径的文件）也捎进去。
ITEMS = [
    # 包根：用户直接双击的那几个
    "1-SETUP.bat",
    "2-START.bat",
    "3-START-NAPCAT.bat",
    "一键安装.bat",
    "launch-hidden.vbs",
    "launch-napcat-hidden.vbs",
    # P2 安装版启动件（便携包也随 launcher/ 一起带，便于手工复用）
    "Estrella-Bot.vbs",
    "run-hidden.vbs",
    "4-DIAG.bat",
    # 2026-10-21（Win-v0.1.2 移植）：工具链入口（假 QQ / 十项自检）
    "start-fake-chat.bat",
    "7-VERIFY.bat",
    "estrella-bot.ico",
    "estrella-bot-v5.ico",
    "README.html",
    # ⚠️ 2026-10-14：README.txt 与「本版修了什么.txt」已不再随包（维护者要求：
    #    说明只保留 README.html 一份，也不再向用户展示"修了什么"清单）。
    # 内嵌运行时
    "runtime/node/node.exe",
    # 工具层
    "tools/onekey.mjs",
    "tools/setup.mjs",
    "tools/migrate.mjs",
    "tools/stop.mjs",
    "tools/install-commit.mjs",
    "tools/launcher.mjs",
    "tools/bootstrap.mjs",
    "tools/import-napcat.mjs",
    "tools/lib/install-layout.mjs",
    "tools/start.mjs",
    "tools/start-napcat.mjs",
    "tools/check-env.mjs",
    "tools/make-shortcut.mjs",
    "tools/diag.mjs",
    "tools/napcat.json",
    "tools/lib/common.mjs",
    "tools/lib/user-root-loader.mjs",
    "tools/lib/versions.mjs",
    "tools/lib/repair.mjs",
    # P6：`napcat-local.mjs` 会读用户自己选中的路径并往 userdata/napcat 落件，
    # `napcat-shape.mjs` 是"协议端长什么样"的唯一定义。点名它们的理由与上面
    # napcat-native.js 那条一样：包内这份是旧的，必须被清单挡住，而不是靠人记得。
    "tools/lib/napcat-local.mjs",
    "tools/lib/napcat-shape.mjs",
    "tools/lib/rollback.mjs",
    "tools/lib/retention.mjs",
    "tools/rollback-restore.ps1",
    "tools/lib/console.mjs",
    # 程序本体的关键件（改了这些 = 换了一份行为）
    "app/node_modules/ws/index.js",
    "app/panel/server.js",
    # ⚠️ 2026-10-14 补：`app/panel/lib/napcat-native.js` 是**面板侧拉起协议端**的唯一实现。
    #    它当时**不在**这份清单里 —— 于是"包内这个文件是旧的"既没被清单挡住，
    #    也没被 diag 的关键词探针认出来（旧版同样含 `wscript`），一路带到真机，
    #    表现为"点重启协议端没有任何反应"。它现在就住在启动链的清单里。
    "app/panel/lib/napcat-native.js",
    "app/panel/lib/runtime-state.js",
    # P3 更新协议（2026-10-18）：清单/验签/下载/状态机的关键文件
    "app/panel/lib/update-version.js",
    "app/panel/lib/update-manifest.js",
    "app/panel/lib/update-signature.js",
    "app/panel/lib/update-download.js",
    "app/panel/lib/update.js",
    "app/panel/lib/update-routes.js",
    "app/panel/lib/update-offline.js",
    "app/panel/next/schema.js",
    "app/panel/next/app.js",
    # 2026-10-21（Win-v0.1.2 移植）：假 QQ / AI 认领的运行时脚本与面板进程壳。
    "app/panel/lib/fake-session.js",
    "app/scripts/fake-qq.mjs",
    "app/scripts/adopt-card.mjs",
    "app/scripts/dev-sim.mjs",
    "app/scripts/lib/fake-host.mjs",
    "app/src/user-root.js",
    # P3-1：面板与工具层共用的端口发现模块；少了它面板启动即 import 失败。
    "app/src/panel-discovery.cjs",
    "app/src/config.js",
    "app/src/net-rules.js",
    # ⚠️ 2026-10-17（回退后重新定性）：`app/src/launch-mode.js` **仍须随包** —— 但理由变了。
    #    它不再被 Windows 启动链调用（启动链已退回"spawn + 开浏览器"），而是
    #    `app/panel/server.js` 的 `/api/panel/window` 要 import 它拿值域判据
    #    （`normalizeWinState` / `windowStatePath`）。**删了它面板会当场 import 失败**，
    #    所以它留在这份清单里。（先例：上面 `app/panel/lib/napcat-native.js` 那条。）
    "app/src/launch-mode.js",
]


def sha256_of(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main():
    if len(sys.argv) != 2:
        sys.exit("用法：make-sums.py <pkg目录>")
    pkg = sys.argv[1]
    if not os.path.isdir(pkg):
        sys.exit(f"不是目录：{pkg}")

    missing = [rel for rel in ITEMS if not os.path.exists(os.path.join(pkg, rel))]
    if missing:
        print("✗ 清单点名的文件不在包里：")
        for m in missing:
            print(f"    - {m}")
        sys.exit(1)

    lines = [
        "# Estrella Bot · Windows 综合包 —— 关键文件 SHA-256",
        "# 由 packaging/windows/make-sums.py 生成（点名制，不是通配）",
        "# 校验：python3 packaging/windows/make-zip.py 会在封包前强制比对这一份",
        "# ⚠️ BUILD-INFO.txt 刻意不在清单里 —— 它记的是构建本身，无法自证",
        "",
    ]
    for rel in ITEMS:
        lines.append(f"{sha256_of(os.path.join(pkg, rel))}  {rel}")

    out = os.path.join(pkg, "SHA256SUMS.txt")
    with open(out, "w", encoding="utf-8", newline="\n") as fh:
        fh.write("\n".join(lines) + "\n")
    print(f"已写入 {out}（{len(ITEMS)} 项）")


if __name__ == "__main__":
    main()
