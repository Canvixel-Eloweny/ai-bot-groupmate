#!/usr/bin/env python3
"""把 _build/pkg 打成最终分发包。

为什么不用 `zip` 命令（这是个刻意选择，不是省事）：
  ① **中文路径**：包内 app/plugins 下有 `定时文案推送` 这类中文目录名。Python 的
     zipfile 对非 ASCII 名**一定**会置上 UTF-8 标志位（general purpose bit 11），
     Windows 资源管理器认这个标志；用 Info-ZIP 在某些环境下要靠运气。
  ② **不产生垃圾**：macOS 的 `zip` 会塞进 `__MACOSX/` 与 `.DS_Store`，
     群里的人解压出来一脸问号。
  ③ **可复现**：条目排序 + 固定时间戳 ⇒ 同样的输入得到同样的输出（便于比对哈希）。

用法：python3 make-zip.py <pkg目录> <输出zip> <顶层目录名>

封印前会**强制校验** `pkg/SHA256SUMS.txt`（若存在）—— 这是踩过坑才加的一道闸：
清单是手写/半自动生成的，而"生成清单之后又改了源码"这件事**不会报任何错**，
只会让包里带着一份对不上的校验值发给用户。宁可构建失败，也不要静默发错。
"""

import hashlib
import os
import sys
import zipfile

FIXED_TIME = (2026, 10, 9, 0, 0, 0)  # 固定时间戳：让构建可复现（改的是构建日，不是"每次跑都不同"）
EXCLUDE_NAMES = {".DS_Store", "Thumbs.db", "desktop.ini"}


def sha256_of(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def verify_manifest(pkg):
    """校验 pkg/SHA256SUMS.txt。返回 (checked, problems)；没有清单时返回 (0, [])。"""
    manifest = os.path.join(pkg, "SHA256SUMS.txt")
    if not os.path.exists(manifest):
        return 0, []
    checked, problems = 0, []
    with open(manifest, encoding="utf-8") as fh:
        for raw in fh:
            line = raw.rstrip("\n")
            if not line.strip() or line.lstrip().startswith("#"):
                continue
            parts = line.split(None, 1)
            if len(parts) != 2:
                problems.append(f"清单行格式不对：{line}")
                continue
            digest, rel = parts[0], parts[1].strip()
            full = os.path.join(pkg, rel)
            if not os.path.exists(full):
                problems.append(f"清单里列了但文件不在：{rel}")
                continue
            checked += 1
            if sha256_of(full) != digest:
                problems.append(f"清单与内容对不上：{rel}")
    return checked, problems


def iter_files(root):
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if d not in EXCLUDE_NAMES)
        for name in sorted(filenames):
            if name in EXCLUDE_NAMES:
                continue
            full = os.path.join(dirpath, name)
            if os.path.islink(full):
                continue  # 软链接不进包：它指向构建机，换台机器就是死链
            yield full


def refuse_vm_bundle(pkg):
    """
    拒绝压缩「内含第三方协议端」的包（2026-10-13 立的硬闸）。

    为什么要闸：NapCat 按它自己的许可**不能随本包分发**，所以公开发的那份 zip
    **永远**是"不带协议端、首装时现下"的那一份。而为了在虚拟机上省一次下载，
    我们另存了一份内含 NapCat 的 `Estrella-Bot-napcat/`（VM 自用）。
    两份目录并排放在同一个 estrella-dist/ 里，名字只差一个后缀 ⇒
    "压缩时手滑选错目录"是一件迟早会发生、且**不会报任何错**的事
    （打出来的 zip 能解压、能装、能用，只是把不该分发出去的东西发了出去）。
    所以它必须由机器拦，不能靠人记。
    """
    nap = os.path.join(pkg, "app", "napcat")
    has_napcat = False
    if os.path.isdir(nap):
        for _dirpath, _dirnames, filenames in os.walk(nap):
            if any(n.lower().endswith((".bat", ".exe", ".cmd")) for n in filenames):
                has_napcat = True
                break
    marker = os.path.join(pkg, "VM-ONLY.txt")
    if has_napcat:
        print(f"✗ 拒绝压缩：{pkg} 的 app/napcat 里含协议端（第三方，不许随包分发）。")
        print("  要打对外分发的 zip，请用**不含** NapCat 的那一份（Estrella-Bot/）。")
        sys.exit(1)
    if os.path.exists(marker):
        print(f"✗ 拒绝压缩：{pkg} 带 VM-ONLY.txt 标记（VM 自用包，不许对外分发）。")
        sys.exit(1)


def main():
    if len(sys.argv) != 4:
        sys.exit("用法：make-zip.py <pkg目录> <输出zip> <顶层目录名>")
    pkg, out, top = sys.argv[1], sys.argv[2], sys.argv[3]

    refuse_vm_bundle(pkg)

    checked, problems = verify_manifest(pkg)
    if problems:
        print("✗ 包内 SHA256SUMS.txt 与内容对不上，拒绝打包：")
        for p in problems:
            print(f"    - {p}")
        print("  → 先重新生成 pkg/SHA256SUMS.txt，再重跑本脚本。")
        sys.exit(1)
    if checked:
        print(f"清单校验通过：{checked} 个文件与 pkg/SHA256SUMS.txt 一致")

    files = list(iter_files(pkg))
    if not files:
        sys.exit("pkg 目录是空的")

    os.makedirs(os.path.dirname(out), exist_ok=True)
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        for full in files:
            rel = os.path.relpath(full, pkg).replace(os.sep, "/")
            zi = zipfile.ZipInfo(f"{top}/{rel}", date_time=FIXED_TIME)
            zi.compress_type = zipfile.ZIP_DEFLATED
            # 0644：解压出来是普通文件，不含构建机的权限位
            zi.external_attr = 0o644 << 16
            with open(full, "rb") as fh:
                z.writestr(zi, fh.read())

    size = os.path.getsize(out)
    print(f"条目 {len(files)} 个 · 输出 {out} · {size / 1048576:.1f} MB")


if __name__ == "__main__":
    main()
