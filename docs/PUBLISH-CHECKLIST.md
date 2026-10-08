# 发布到公开仓库 · 动作清单（对外拷贝里的**桩**）

> 原件不在本拷贝里 —— 它**按设计**持有真实标识符（去标识的对照表与哨兵表），
> 发布时按 `PUBLISH-CHECKLIST` 的口径整块排除。需要它请回原仓库取。

本文件存在的唯一理由：`scripts/check-wb.mjs` 第 34 节会读它（核对"清单有没有指向脚本"），
缺了它 check-wb 会 ENOENT 崩掉 —— 于是"别人 clone 下来能不能跑验收"在拷贝上验不了。
补一份**不含任何真值**的桩，验收门就能照常跑（Q45 裁决①）。

发布步骤（与原件同口径）：先跑 `node scripts/publish-audit.mjs`（退出码须为 0），
再跑 `node scripts/make-publish-copy.mjs <目标目录>` 生成拷贝 —— 它以 `git ls-files` 为准；
**不要**改用"按路径名排除"的 rsync 清单（实测漏过 `.env` 等 21 个文件）。

⚠️ 本桩的头一行是 `check-wb` 判定"这是发布拷贝而不是内部仓"的**唯一依据**
（第 22 轮加）：拷贝里按设计没有 `publish-audit.mjs` / `docs/archive/` /
`ARCHIVE.md` / `DEEP-IMPROVE.md` / `.git/hooks/`，那几条判据据此换成**反向断言**。
⚠️ 因此**头一行那串字不许改** —— 改了会让拷贝重新报 4 条假红。