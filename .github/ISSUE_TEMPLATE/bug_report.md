---
name: Bug 报告
about: 机器人行为异常 / 面板不可用 / 契约报红
title: ''
labels: bug
assignees: ''
---

<!--
⚠️ 提交前请先脱敏：不要贴真实 QQ 号、群号、昵称、API Key 或完整日志的原始行。
   日志里的凭据会被 src/logger.js 自动打码，但**群号与昵称不会** —— 请自行替换。
-->

**先跑一遍四层门禁，把结果贴上来**（这能筛掉一半的报告）：

```bash
node scripts/check-wb.mjs
NODE_OPTIONS= node test/smoke.js
NODE_OPTIONS= bash test/sandbox.sh --run
node scripts/publish-audit.mjs
```

## 现象

<!-- 期望什么、实际什么。一句话说清。 -->

## 复现步骤

1.
2.
3.

**能稳定复现吗？** 每次 / 偶发 / 只出现过一次

## 环境

| 项 | 值 |
|---|---|
| 提交 | `git rev-parse --short HEAD` |
| Node | `node -v`（要求 ≥ 22.13） |
| 系统 | macOS / Linux / 其它 |
| 协议端 | NapCat 版本 |
| 主模型 | 服务商 + 模型名（**不要贴 Key**） |

## 相关日志

<!-- 贴脱敏后的片段。`src/` 的日志已自动打码凭据；群号与昵称请手工替换。 -->

```
（贴这里）
```
