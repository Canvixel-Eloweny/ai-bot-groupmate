# 架构说明（面向外部读者）

> 这份文档回答一个问题：**这个仓库的结构为什么长这样**。
> 面向维护者的纪律写在 `CONTRIBUTING.md`；进度台账是**内部件，不随公开仓库发布**。

## 1. 它是什么

一个**单进程**的 QQ 群聊 AI 机器人：通过 OneBot v11 协议端（如 NapCat）连上 QQ，
把群消息喂给 OpenAI 兼容的模型，再把回复发回去。**零构建**：`node src/index.js` 即启动，
改完代码重启即生效，没有打包步骤。

```
QQ 客户端 ←→ NapCat（协议端，外部依赖） ←→ src/index.js（机器人）
                                                  ↕ HTTP
                                           模型服务（智谱 / DeepSeek / 本机）
                                                  ↕ HTTP
                                         panel/server.js（本地控制台）
```

## 2. 三层与依赖方向

```
src/                    ← 机器人本体（62 个模块）
panel/                  ← 本地控制台（HTTP 服务 + 页面）
  lib/                  ←   面板后端的基础设施（层号见下）
  parts/ · next/        ←   前端两种形态（拼装片段 / 独立静态资产）
scripts/                ← 构建与检查工具（不进运行时）
test/                   ← 四层门禁里的三层
```

`src/` 内部的依赖方向是**单向**的：基础设施（`atomic-write` / `logger` / `net-rules`）
不 import 业务，业务 import 基础设施。实测：**无循环依赖**，41 / 62 个模块是零出边叶子。

三条被契约强制的纪律：

1. **同一份语义只有一处实现。** 例如"什么算凭据"只有 `src/gate-scan.js` 的特征表一份，
   出站闸门与日志脱敏都 import 它。
2. **`panel/lib/` 下每个模块必须声明层号**（`LAYER`），层号决定它能 import 谁。
3. **`src/` 的每个导出都必须被另一个文件点名**（契约 §56），防死代码。

## 3. 消息生命周期（主链路）

```
OneBot 事件
  → src/onebot.js      flattenMessage：段 → 文本 / 图片 URL / 是否 @ 我
  → src/index.js       门禁：白名单 / 黑名单 / 睡眠 / 叫醒判定
  → src/notice.js      拍一拍、被禁言、"/安静" 之类的通知合成
  → src/brain.js       decide()：**这条消息该不该回**（10 级判据，纯函数）
  → src/context-budget.js  buildMessagesWithMeta：拼提示词，稳定段在前、必变段压到末尾
  → src/llm.js         chat()：降级链 + 400 语义降级（按响应正文点名）
  → src/brain.js       parseReply()：切分 / 剥内部标记 → src/egress.js 出站闸门
  → src/index.js       按 src/pace.js 的节奏发出（发送前复核白名单）
```

## 4. 四层门禁（改动后必须全绿）

| 层 | 入口 | 查什么 |
|---|---|---|
| L1 静态契约 | `scripts/check-wb.mjs` | 结构自洽：函数有定义、能力键两处同步、唯一入口成立…… |
| L2 行为回归 | `test/smoke.js` | 判据真跑一遍（含真进程用例） |
| L3 预设层 | `test/verify-presets.mjs` | 三套大脑预设与页面一致 |
| L4 面板层 | `test/verify-panel.mjs` | 页面在 jsdom 里真跑一遍 |
| 变异测试 | `test/mutations/` | **判据本身**能不能拦住改坏 |

## 5. 刻意不做的事（以及为什么）

- **不做热插拔**：插件只在启动时加载。热插拔会让"改了什么"与"现在生效的是什么"脱钩。
- **不做多进程/微服务**：单进程 + 串行队列足够，且省掉一整类分布式状态问题。
- **不下载图片二进制**：图片只以 URL 流转，解码交给协议端与模型服务端。
- **不做 token 级上下文预算**：按**字符**算。跨模型不精确，但零依赖、可预测。
- **不把安全边界押在流程上**：能进 `.gitignore` 的就不进版本控制，
  不依赖"发布时记得排除"。

## 6. 插件

`skills/` 与 `plugins/` 放**用户自己安装的第三方包**（不随仓库分发，见 `THIRD-PARTY-NOTICES.md`）。
宿主提供 `api`（`registerTool` / `config` / `log` / `fetch` …）与四个生命周期函数
（`setup` / `activate` / `deactivate` / `dispose`）。

⚠️ **它们不是沙箱** —— 包在进程内加载，能直接 `import fs`。见 `SECURITY.md`。
