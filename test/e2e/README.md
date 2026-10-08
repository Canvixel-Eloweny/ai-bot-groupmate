# test/e2e —— 真实环境端到端脚本

> 与 `test/smoke.js` 的分工：smoke 是**全 mock、离线、可反复跑**的回归，
> 断言逻辑；这里这五支脚本要**碰真实面板 / 真实浏览器 / 真实 Chromium**，
> 验的是"真的跑起来是不是也成立"。所以它们不进 `npm test`，只在需要时手动跑。

## 五支脚本

| 脚本 | 验什么 | 会不会动真机 | 怎么跑 |
|---|---|---|---|
| `real-e2e.mjs` | 打**真人面板**接口，走「改 → 落盘 → 读回来 → 还原」一整圈 | **会写**（`finally` 里整份回灌还原） | 面板在跑时：`node test/e2e/real-e2e.mjs` |
| `browser-verify.mjs` | 真实 Chromium 点一遍控制台：技能/知识包/角色卡点得动、保存给绿勾、能力开关两处同步 | 起无头浏览器，截图到 `/tmp/qqbot-shots` | `node test/e2e/browser-verify.mjs` |
| `browser-restart-verify.mjs` | 「面板旧代码自检 → 一键重启 → 页面自动回来 → 黄条消失」整条链 | **会重启面板** | 先让磁盘 `server.js` 与进程不一致（`panel.stale=true`），再跑 |
| `self-restart.mjs` | 一键重启后 pid 真的换了、stale 归位 | **会重启面板** | 面板在 8788 端口时：`node test/e2e/self-restart.mjs` |
| `check-channel.mjs` | 「推理通道」那排（智谱预设下隐藏）强制显形后量一遍 | 起 Chromium，只读 | 需要面板在跑：`node test/e2e/check-channel.mjs <标签>` |

⚠️ **S-12 第六批（2026-10-05）删掉了原先的第 6 支 `verify-fixes.mjs`**：它验的是**旧页**
（`panel/parts/` 拼装的那一份）的 `wbCustom` / `wbSave` / `lastState` 三个全局，
靠 `page-parts.js` 的 `readPage()` 拼出页面再在 jsdom 里跑。旧页三层整块删除后它无法改指
（现役页没有同名全局）。它盯的那个关切在现役页**结构上就不存在** —— 现役保存走 `S.dirty`
集合：`save()` 先 `if (!dirtyKeys()) return;`，请求失败一律 `toast('保存失败：…')`，
没有"空状态下点了没反应"那条路径。⇒ 登记为「对象删除，关切无等价物」。
`check-wb` 第 5 节的 e2e 清单已同步（6 支 → 5 支）。

## 运行前提（缺了会得到假失败，不是代码坏了）

1. **面板必须在跑**，且端口与脚本里写的一致（`real-e2e` / `self-restart` 走 `8788`，改过端口要同步改脚本）。
2. 浏览器类脚本依赖本机 Chromium 与 puppeteer-core，路径写死在脚本顶部：
   - Chromium for Testing：`/Users/<你的用户名>/Library/Caches/ms-playwright/chromium-1234/...`
   - headless shell：`/Users/<你的用户名>/Library/Caches/ms-playwright/chromium_headless_shell-1234/...`
   - puppeteer-core：`/Users/<你的用户名>/.dsh/profiles/web/node_modules/...`
   换机器/换缓存目录要改这三处。**这类路径写死不是好设计，但改动它们属于另一件事**（等 `EX-SCHEMA` 之后统一抽配置），此处如实记录。

## 为什么只留这五支

`/tmp` 下原本还有 24 个 `.mjs`，**整体搬进来是负收益**，已按下面三条过筛：

- 一次性调试产物（`dbg-*` / `repro-*` / `shot-*` / `measure*` / `cdp-probe` / `capture` / `reshoot`）：结论已经进了代码或报告，脚本本身没有再跑的价值。
- 报告排版的一次性脚本（`make-report*` / `verify33` / `audit-align` / `verify-merge`）：产物已归档，留着只会让人分不清"现在该跑哪个"。
- `napcat.mjs`（3 MB）：不是脚本，是一次抓包转储，且体积不该进仓。

`prompt-diff.mjs` **刻意不复制到这里** —— 仓库里已有 `scripts/prompt-diff.mjs`（且是比 `/tmp` 那份更完整的版本，带真机 trace 的 LCP 测量，smoke 的 T42 组用例也直接引它）。同一份语义留两处，正是本项目踩过最多次的腐烂源。
