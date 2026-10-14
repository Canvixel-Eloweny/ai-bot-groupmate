#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
vbs-lint - 静态检查 VBScript 的 `Option Explicit` 合规性与 VBA 专属函数误用。

背景（2026-10-13）：生产文件 launch-napcat-hidden.vbs 从未被执行过，里面藏了
两个 VBA 式致命错误；在 `wscript //B` 下致命脚本错误 = 无对话框、无输出、
退出码仍是 0，表现为"协议端无缘无故死了"。其中一类就是
「赋值了但没 Dim 的标识符」——`On Error Resume Next` 兜不住，脚本历史上
修一次漏一次。这个检查器把这类错误变成一条可复现的命令。

用法：
    python3 vbs-lint.py <file.vbs> [more.vbs ...]
    python3 vbs-lint.py --all            # 扫描本目录 .. 下所有 .vbs
退出码：0 = 干净，1 = 发现问题（可直接用于 CI / 提交前钩子）。
"""

import re
import sys
import os

# VBScript 内置 / 全局对象与方法名，出现时不要求 Dim。
# 与 WScript.Shell / FileSystemObject 相关的是点号后的成员，不会出现在
# 赋值左侧，这里只列可能会出现在左侧或作为独立标识符的内建名。
BUILTIN = {
    # 内建常量
    "vbCrLf", "vbCr", "vbLf", "vbNullString", "vbTab", "vbBack",
    "vbTrue", "vbFalse", "vbYes", "vbNo", "vbOK", "vbCancel",
    "vbInformation", "vbExclamation", "vbCritical", "vbQuestion",
    "vbOKOnly", "vbOKCancel", "vbYesNo", "vbYesNoCancel",
    "vbHide", "vbNormalFocus", "vbMinimizedFocus", "vbMaximizedFocus",
    "vbNormalNoFocus", "vbMinimizedNoFocus",
    "vbBinaryCompare", "vbTextCompare", "vbDatabaseCompare",
    "vbObjectError", "vbNull", "vbEmpty", "vbInteger", "vbLong",
    "vbSingle", "vbDouble", "vbCurrency", "vbDate", "vbString",
    "vbObject", "vbError", "vbBoolean", "vbVariant", "vbDecimal",
    "vbByte", "vbArray",
    # 内建对象 / 函数（出现在赋值左侧的情形极少，但兜住）
    "WScript", "Err",
}

# VBA / ASP 专属、VBScript 里不存在的函数（误用即致命）。
# 只在"代码区"（去掉注释与字符串后）里出现才算问题。
VBA_ONLY = [
    "IIf", "Choose", "Switch", "Format", "DoEvents", "Environ",
    "IsMissing", "IsNull", "IsEmpty", "Nz", "Trim$", "UCase$", "LCase$",
    "Left$", "Right$", "Mid$", "Chr$", "Str$", "Val", "CVar", "CVErr",
]


def strip_comment(line):
    """去掉行首的整行注释；返回 (是否整行注释, 去掉注释的代码)。

    VBScript 的字符串里两个双引号表示一个转义引号，注释以单引号开始。
    这个函数只在引号外识别单引号注释，避免把字符串里的 ' 当注释。
    """
    out = []
    in_str = False
    i = 0
    n = len(line)
    while i < n:
        ch = line[i]
        if ch == '"':
            if in_str and i + 1 < n and line[i + 1] == '"':
                out.append('""')
                i += 2
                continue
            in_str = not in_str
            out.append(ch)
            i += 1
            continue
        if ch == "'" and not in_str:
            break
        out.append(ch)
        i += 1
    return "".join(out)


def lint(path):
    with open(path, "rb") as fh:
        raw = fh.read()

    problems = []
    text = raw.decode("utf-8", "replace")
    has_crlf = "\r\n" in text
    nonascii_lines = [
        (i + 1, ln) for i, ln in enumerate(text.splitlines())
        if any(ord(c) > 127 for c in ln)
    ]

    lines = text.splitlines()
    # 去掉 BOM 后判断 Option Explicit
    has_opt_explicit = any(
        strip_comment(ln).strip().lower() == "option explicit" for ln in lines
    )

    declared = set()
    assigned = {}   # name -> 首次赋值的行号
    vba_hits = []   # (行号, 名字)

    for idx, ln in enumerate(lines, start=1):
        code = strip_comment(ln)
        if not code.strip():
            continue
        low = code.strip().lower()

        # --- 收集 Dim 声明（含 Dim a, b, c）---
        m = re.match(r"^\s*dim\s+(.+)$", code, re.I)
        if m:
            for piece in m.group(1).split(","):
                nm = piece.strip()
                nm = re.sub(r"\(.*?\)", "", nm).strip()      # 去掉数组括号
                if nm:
                    declared.add(nm.lower())
            continue

        # --- 收集 ReDim / Const / Function / Sub 名 ---
        m = re.match(r"^\s*(redim|const)\s+(.+)$", code, re.I)
        if m:
            for piece in m.group(2).split(","):
                nm = re.sub(r"=.*", "", piece).strip()
                nm = re.sub(r"\(.*?\)", "", nm).strip()
                if nm:
                    declared.add(nm.lower())
            continue
        m = re.match(r"^\s*(function|sub)\s+([A-Za-z_]\w*)", code, re.I)
        if m:
            declared.add(m.group(2).lower())
            continue

        # --- 收集赋值：Set X = ... / X = ...  （X.Y = ... 是属性，不算）---
        # 同时覆盖行内形式：`If c Then x = ...` 与 `a = 1 : b = 2`。
        for chunk in re.split(r"\bThen\b|:", code, flags=re.I):
            m = re.match(r"\s*(?:set\s+)?([A-Za-z_]\w*)\s*=(?!=)", chunk, re.I)
            if m:
                nm = m.group(1)
                if nm.lower() not in ("if", "elseif", "exit", "end",
                                      "for", "while", "else"):
                    assigned.setdefault(nm.lower(), idx)

        # --- 找 VBA 专属函数调用 ---
        for fn in VBA_ONLY:
            if re.search(r"(?<![A-Za-z_])" + re.escape(fn) + r"\s*\(", code):
                vba_hits.append((idx, fn))

    if has_opt_explicit:
        for nm, lineno in sorted(assigned.items(), key=lambda kv: kv[1]):
            if nm in declared or nm in {b.lower() for b in BUILTIN}:
                continue
            problems.append(
                "line %-4d  赋值但未 Dim：'%s'  "
                "（Option Explicit 下致命，On Error Resume Next 兜不住）" % (lineno, nm)
            )

    for lineno, fn in vba_hits:
        problems.append(
            "line %-4d  VBA 专属函数误用：'%s'（VBScript 没有它）" % (lineno, fn)
        )

    if nonascii_lines:
        for lineno, ln in nonascii_lines[:5]:
            problems.append("line %-4d  非 ASCII 字符（中文 Windows 会乱码）：%r"
                            % (lineno, ln[:60]))
    if has_crlf:
        problems.append("文件含 CRLF 行尾（.vbs/.bat 必须 LF-only）")

    return problems


def main(argv):
    if len(argv) > 1 and argv[1] == "--all":
        here = os.path.dirname(os.path.abspath(__file__))
        root = os.path.dirname(here)
        targets = []
        for base, _dirs, files in os.walk(root):
            for fn in files:
                if fn.lower().endswith(".vbs"):
                    targets.append(os.path.join(base, fn))
        targets.sort()
    else:
        targets = argv[1:]
        if not targets:
            print(__doc__)
            return 2

    total = 0
    for path in targets:
        probs = lint(path)
        rel = os.path.relpath(path)
        if probs:
            total += len(probs)
            print("FAIL  %s" % rel)
            for p in probs:
                print("      " + p)
        else:
            print("ok    %s" % rel)

    print("-" * 60)
    if total:
        print("发现 %d 个问题，共检查 %d 个文件。" % (total, len(targets)))
        return 1
    print("全部通过，共检查 %d 个文件。" % len(targets))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
