# panel/next · 控制台前端（**唯一的一套**）

> 2026-10-02「换主」：这是**唯一**的控制台。旧的 `panel/parts/` 拼装页面已经**没有任何可达路径**
> （`GET /` 不再发它、页面上也没有任何回旧界面的入口），它的文件与它那 386 条断言还在仓库里，
> 等下一轮契约迁移时一并处理 —— 登记在**内部进度台账**里（内部件，不随公开仓库发布）。
>
> 分发面：`GET /` 发入口页，`/style.css` / `/app.js` / `/schema.js` / `/demo-state.js` 发资产
> （**与入口同层挂在根上** —— 相对路径 `./app.js` 只有在同层才解析得对）。
> 老地址 `/next*` 由面板做一次 **302 → 根**。接线 = `panel/lib/next-page.js`（名单与三道闸）
> + `panel/server.js` 的分发块 + `launcher.sh` 的开页地址。
> 契约见 `check-wb` 第 58 节「控制台的分发面」。

## 它是什么

一份**由数据驱动**的控制台前端：

| 文件 | 作用 | 什么时候要改它 |
|---|---|---|
| `schema.js` | **整页的唯一声明处**：6 个功能域 / 22 个页面 / 65 张卡（2026-10-22 B2 实测）全是数据 | 加页面、加卡片、加控件、改文案 —— **只改这里** |
| `app.js` | 渲染器 + 路由 + 反馈 + 接口表 | 只有"要加一种新控件类型"时才改（在 `RENDER` 表里加一个函数，并把名字登记进 `schema.js` 的 `CTRL_KINDS`） |
| `style.css` | 设计令牌与组件 | 改视觉（颜色/间距/圆角/字号只从顶部令牌里取） |
| `index.html` | 页面骨架（顶栏 / 两级导航 / 主体 / 保存条 / 设置层 / 反馈） | 改全局布局 |
| `settings.js` / `settings.css` | 左下角设置层：外观 / 启动 / 关于 / 数据 | 新增设置项或改设置层布局 |
| `demo-state.js` | 离线演示快照 | 一般不用动；它只在连不上后端时兜底 |
| `splash.js` | 首屏同步启动层：在样式表之前把主题/主题色/字体偏好写到 `<html>` | 新增首屏本地偏好时 |
| `verify.mjs` | **真实浏览器自检**（零依赖，走 CDP），28 条断言 | 加了新页面后跑一次 |
| `README.md` | 本文件 | — |

> ⚠️ `README.md` 与 `verify.mjs` **故意不在可下发资产名单**（`panel/lib/next-page.js` 的 `NEXT_ASSETS`）里
> —— 文档与自检脚本没有理由出现在 HTTP 面上。`GET /README.md` 是 **404**。

## 左下角设置层（2026-10-23 · P2）

顶栏的主题/字体/背景入口已全部迁到左下角齿轮 → **设置**，顶栏只留一键启动/结束运行。
四个分区：

| 分区 | 内容 | 存储 |
|---|---|---|
| 外观 | 日/夜、7 套主题色、8 套背景与流速、sans/serif | `localStorage`（`next-theme` / `next-accent` / `next-font-style` / `qqbot-bgfx`） |
| 启动 | 打开方式、开机自启、自动拉起协议端、就绪后打开界面、关闭=驻留/退出 | `config.json` 的 `launch` 段（壳/启动器读同一份） |
| 关于 | 版本/运行时/桌面壳（来自 `/api/state.appMeta`）、检查更新、GitHub 外链 | 只读 |
| 数据 | 按范围导出（大小来自 `/api/custom/export?dry=1`）、完整包、诊断包 | 只读 |

- 主题色 7 套的浅/深令牌在 `style.css` 的 `html[data-accent=...]`；色板按钮复用同一组
  令牌，不手抄第二份色值。背景仍是 `shader-bg.js` 的 `VARIANTS` 唯一来源（默认海雾）。
- `splash.js` 在 `<head>` 同步应用主题/主题色/字体，避免首屏先画默认值再跳一下。
- 关于页的仓库地址来自程序根 `package.json` 的 `homepage`（`/api/state.appMeta.repo`）；
  意见箱只开 GitHub Issues 外链，不在面板收集内容、不上传。
- 壳层关闭行为的键是 `launch.closeAction`（`tray` 默认 / `quit`）；托盘不可用时，
  `tray` 自动退化为最小化。`launch.autoProtocol=false` 会同时跳过启动自起与进程守护。
- 设置层打开时背景页设 `inert`；层级：settings 78 / gear 79 / modal 80，弹窗仍能盖住设置。
- 窄屏：≤860px 侧栏变顶部横条；≤700px 色板 4 列、≤600px 内容区仍可滚动。P2-4 在
  `test/panel-dom.mjs` 里按 1280×680 / 1024×728 / 800×560 / 600×440 四档真渲染并截图。

## 动效能力层（2026-10-02 · UI 升级轮）

| 文件 | 作用 |
|---|---|
| `motion.js` | 动效引擎。零依赖的 `framer-motion` 替身：运动值 / 弹簧 / 速度 / 派生变换。**语义与 framer-motion 对齐**，所以外部配方能原样搬 |
| `liquid-toggle.js` | 液态开关（双 blob metaball）。演示六条判据，见 `docs/MOTION-METHODOLOGY.md` |
| `liquid-toggle.css` | 上面两者的样式。**配色只从令牌来**，不写死色值 |
| `index.html` / `app.js` | 上面两者的**接线处**：`index.html:22` 引样式、`:129` 引脚本（**在 `app.js` 之前**）· `app.js:1751` 总闸 `LIQUID_ON` |
| `lab-liquid-toggle.html` | **动效实验室**：判据的可视化 + 实时旋钮。双击即可打开（零依赖、零构建、零服务），也可 `http://127.0.0.1:8788/lab-liquid-toggle.html` |
| `lab-motion-spec.html` | **判据实验室**（2026-10-03）：四区块 —— A 状态可视化 / B 连续映射（档位拖到 2 自动退回 `seg`）/ C 物理感（三档阻尼并排 + **面积守恒实测 =1.000**）/ D 装饰 vs 状态**反例对照**。双击即开，也可 `http://127.0.0.1:8788/lab-motion-spec.html`（面板在跑时实测 200） |

## 液态玻璃制作站（2026-10-22）

隐藏实验页 `lab-liquid-glass.html`：16 个模板、7 个可拖场景、六层显隐/拆层、
SDF 位移贴图预览、可拖 A/B 分割线、舞台缩放、预设、CSS/JS/JSON 导出。
边缘组另有内侧暗壁 / 渐变描边 / 高光形状三条光影参数，以及一张 gooey 融合演示卡
（blur + contrast，只做观感研究、不进产品）。
示例玻璃可拖动、拖角点缩放、双击复位，参数/布局/主题存在本机 localStorage。
它加载真实的 `style.css` 取产品令牌，不复制一套颜色；产品页**不** import 它。

## 顶栏 HUD 信息岛（2026-10-23）

| 文件 | 作用 |
|---|---|
| `island.js` | 顶栏状态岛：入场（欢迎展开）、信息项轮播、切换时间轴（灰圈被岛体圆角裁切）、弹层与本地设置。只依赖 `icons.js` 的 `Icons.icon` |
| `island.css` | 岛与弹层样式。玻璃材质跟随主题自动切换，**没有 HUD 核材质**；配色只从令牌来 |
| 设置入口 | 「维护 → HUD调整」：轮播项、间隔、宽高、动效倍速、重播入场、恢复默认；设置存本机 `localStorage['next-hud-island-v1']` |
| 数据面 | 全部来自 `/api/state`：`usage.today` / `bridge` / `container` / `localModel` / `memory` / `panel` / `account`。**没有发送计数字段，故不提供「今日发送」** |
配套 `glass-station.css/js` 与产品/制作站共用的 `glass-scrim.css`（弹窗渐进模糊，
三层半径可用 `--gsc-b1/2/3` 覆写，制作站弹层里可调层数/强度并下拖关闭）。
说明与提升流程见制作站内部文档（不随公开仓发布）。
新增文件名需重启面板；之后改 CSS/JS 刷新即可。

✅ **已接入产品页**（2026-10-02 落地，**2026-10-03 复核**）：液态开关接在**能力开关**那一类
（联网查询 / 识图 / 发 QQ 表情），总闸是 `app.js` 的 `LIQUID_ON`（当前 `true`）。
改 `false`、或删掉 `liquid-toggle.js` 的 script 标签 → **一行不改地退回原生开关**。
接入形状：原生 `<input type=checkbox>` 是**唯一事实源**，液态层是**纯装饰**
（`LiquidToggle.create({ onChange: null })` —— 只反映状态、不接受点击），
由 `onPageShown → mountLiquidSwitches()` **幂等重挂**（重挂前先 `destroy()` 上一批）；
禁用态的开关不挂装饰。

> ⚠️ **2026-10-03 更正**：本节原先写"产品页尚未接入任何液态控件" —— **那句是错的**，已改。
> 错因：判"没接"时用了 `grep "A\|B\|C"`（转义竖线），本机 grep **静默匹配不到**，
> 于是"没有输出"被读成了"没有引用"。**"没输出" ≠ "没引用"** —— 判据一律用 `grep -E`，
> 并且对"零命中"这种**否定性结论**，先拿一个已知存在的词做阳性对照再下结论。
>
> ⚠️ **用在少量关键的控件上，不要满页液体**：控制台主线是「安静的仪表盘」，
> 密集中文界面靠层级与留白分区，动效只用于**状态变化**，不做进入动画。
>
> 方法论与踩坑记录在 **`docs/MOTION-METHODOLOGY.md`** —— 那份比这些代码活得久。

## 改界面前先看什么 / 改完跑什么（2026-10-03）

这一节只给**入口与顺序**，不解释为什么 —— 理由都在下面两份文档里，别在这里再抄一遍。

| 你想干的事 | 先看哪份 | 改完跑什么 |
|---|---|---|
| 加页面 / 卡片 / 控件 / 改文案 | **`schema.js`**（整页唯一声明处） | `node panel/next/verify.mjs`（要面板在跑） |
| 改视觉（颜色 / 间距 / 字号 / 圆角） | **`style.css`** 顶部令牌（浅深两套**名字逐个对齐**） | `node scripts/check-wb.mjs` |
| **想加一个动效** | **先走下面四问**；判据在 `docs/MOTION-METHODOLOGY.md` §6，图解与决策版是那份交互动效规格（**已归档的内部件，不随公开仓库发布**） | 同上 + 真机跑一遍 `lab-motion-spec.html` |
| 委托我做新动效 | `docs/MOTION-BRIEF.md` 的模板（**缺旋钮值我会先问，不猜**） | — |
| 准备开源 / 发布 | 维护者的发布清单（内部件，不随公开仓库发布） | `node scripts/publish-audit.mjs`（**要 exit 0**） |

**四问（顺序不能反，任一条答「否」就停在那一档）：**

```
Q1 这里有没有「状态变化」？        否 → S0 静默（不是"少动"，是不动）
Q2 用户是不是在等一个结果？        是 → S1 + 遮罩 / toast
Q3 状态二值或有序、且用户反复拨它？ 否 → S1
Q4 位移本身承载语义吗？            是 → S2 物理（用 window.Motion，不许新写 rAF）
```

默认 **S1**。现役 S2 只有两处：`.nav1` 指示器、能力开关（液态）。

⚠️ 反过来做（先挑个好看的动效再想用在哪）是「装饰」的生成方式，它一定过不了 Q1。

## 顶部导航：连续肩线 dock（2026-10-22 改版）

一级（48px）与二级（30px）上下叠在同一只 `.nav-dock` 里。一级在上、二级在下，中间用
42×11.5 的三次贝塞尔肩线（控制点 0.618）连接；曲率从 0 到 0，不再用内凹小圆角硬拼，
也不做旧版那种左右并排的 grid。

```
.navrow        sticky · top: var(--h-topbar) · height: calc(--h-nav1 + --h-nav2) · z40
  .nav-dock-wrap  drop-shadow（轮廓阴影）
    .nav-dock    单块 clip-path（JS `paintNavDock`）+ 1px SVG 边
      .nav1      一级行（48px）
        .nav-inner  fit-content / 横向滚动 / 指示器定位基准
          .grp × 6      短标签（2 字）+ .cnt 计数
          .nav-ind      静态描边滑块（Motion）
      .nav2wrap  二级行（30px，宽度 JS 写）
        .nav2-ind   静态淡色胶囊（Motion）
        .nav2       横向滚动容器
          .sub × N  短标签（2–4 字）
```

### 尺寸与宽度
- 一级 = 一级内容 + 16；6 个域 + 计数实测 534（1440），左字到胶囊边约 30px。
- 二级 = 二级内容 + 8；**没有 300px 下限**：模型 3 页签 144、运行 4 页签 193；
  390 宽下 168 / 225（被 dock 宽度夹住）。
- 短标签在 `schema.js` 的 `NAV_SHORT`；完整名保留在 `title` / `aria-label` 与页面头。
- 切换域时 `layoutNavDock(true)` 用 380ms 过渡；`scrollNav2To()` 把选中页签带进窄条。

### 液态玻璃与层级
- 一条 dock：`body.eg-on .nav-dock` 复用 `--c-eg-noise` + `--c-eg-sat-isle` / `bright-isle`
  + `--c-eg-inset-isle`；一级/二级共用同一块玻璃。
- 二级 `::before` 是一层很薄的 bar 玻璃（消费 `--c-eg-surface-bar` / `sat-bar` / `bright-bar` /
  `inset-bar`），顶部用 mask 渐隐；层级主要由 dock 的 16px 软接缝阴影与尺寸差表达，
  不再用旧版那种重投影把两级切开。
- 一级描边滑块与二级淡色胶囊都必须是**静态元素**（`renderNav1/2` 只重建按钮）；
  坐标用 `offsetLeft`，二级要减 `.nav2` 的 `scrollLeft`。

### 窄屏与触摸
- 一级/二级都只有横向滚动这一种溢出策略；`scrollNavTo` / `scrollNav2To` 把选中项带进视野。
- 720px 档：一级 48 / 选项 36 / 二级 30；`pointer:coarse` 与 `.touch`：一级 60 / 选项 44 / 二级 50。
- 吸顶只由 `.navrow` 一处负责；`.nav1` / `.nav2wrap` 不许各自 sticky。

### 契约
- N7 topbar > navrow；N8 dock / 肩线 / 内容自适应；N9 三处媒体查询同步 `--h-nav2`；
  N14 DOM 顺序 topbar → nav1 → nav2wrap。
- N8④ 反向钉住「layoutNavDock 不许出现 300px 下限」；§103 / §131 继续钉二级滑块。
- `panel/next/verify.mjs` 真读 `#navDock` 的计算样式算对比度；`test/panel-dom.mjs` 逐页遍历
  并在 8 个宽度上量「模型 / 运行」的二级宽度、dock 越界与选中可见。

## 怎么跑

**正常用法：点 Estrella Bot Console 图标。** Windows 安装版/便携包由系统分配端口，
启动器开的是 `panel/.panel.json` 里的实际根地址；下面 `127.0.0.1:8788` 是 **dev 形态**的默认地址
（`node panel/server.js` 手工起面板时）。

手动打开：

```
http://127.0.0.1:8788/                ← 控制台（面板自己发的，同源、自带 token）
http://127.0.0.1:8788/next/           ← 老地址，302 → 根（书签兼容，别存这个）
```

**为什么不需要另起一个小服务**：面板不发 CORS 头，另一个端口打开的页面连 `/api/state`
都取不到、写请求也拿不到 token。所以"能点进去"这件事唯一正确的接法就是**让面板自己发**。
改任何资产都**不需要重启面板** —— 每次请求从磁盘读，改完刷新即可。

自检：

```bash
node panel/next/verify.mjs      # 28 条断言 + 3 张截图 → /tmp/next-verify/
                                # 默认验 http://127.0.0.1:8788/（控制台的家）
                                # 其中包含**真写一次**（POST /api/logs/clear，零副作用）
                                # 换宽度复跑：--width 390 / --out /tmp/next-narrow
```

## 怎么加/删

**加一个页面**：在某个域的 `subs` 里插一项。

```js
{ id: 'my-page', label: '我的页', title: '我的页标题', desc: '一句话说明。',
  draft: true,                       // true → 底部出现「保存并生效」；false/省略 → 点一下立刻生效
  cards: [ { id: 'c1', title: '卡片标题', span: 6, ctrls: [ /* … */ ] } ] }
```

**加一个控件**（存进 `custom` 的，走草稿）：

```js
{ t: 'switch', id: 'x.on', label: '开关名', bind: 'crossSend.enabled', hint: '这里是说明。' }
```

**加一个立即生效的控件**（自己声明打到哪个接口）：

```js
{ t: 'switch', id: 'dbg', label: '详细日志', read: (s) => s.debugLog,
  save: (v) => ({ url: '/api/debug', body: { on: v } }) }
```

**删**：把那一项删掉即可，不需要动任何别的地方。

### 三条会自动报错的纪律（都写进了代码）

1. `RENDER` 表里没有的控件类型 → 页面上**当场画红框**，不静默跳过（静默跳过 = 少一个控件）。
2. 页面上每个 `data-a` 动作必须有处理者（`ACTIONS` 或 `INLINE_ACTIONS`）→ 否则 `console.error`，
   自检脚本会把它算成失败。
3. 静态标记里出现 `data-act` 这类别的属性名 → 同样报错（已实测踩过：顶栏四个按钮全静默失效）。

## 已知的边界（都是**写明的**，不是漏的）

- **三张骨架页已换成真数据**（2026-10-02 第二批）：情绪世界（`data/bot-state.json`）、
  群友档案（`data/memory/people/*.json`）、免费额度情报（`data/api-deals.json`）——
  都由 `panel/lib/bot-data.js` **直接读盘**、白名单投影。读取失败时页面给**人话**（"那个包还没被用到过"），
  **不画红** —— 数据文件不在仓库里，没数据是正常状态。
- **图库只报张数**：`data/images-lib/index.json` 的条目字段名我们没样本可核，**故意不猜**
  （猜错会得到一个永远为空的分组，而没人会想到是"面板猜错了字段名"）。
- **定时消息的「日期」「频次」已修好**（此前会被 `readCustom` 丢掉）；节假日表现在可编辑。
  两处的契约都升级成"**经 readCustom 往返之后仍在**"。
- 写操作需要 token：面板发页面时会注入。拿不到时页面顶部有明确提示（读仍正常）。
- **改 `panel/server.js` / `panel/lib/*.js` / `src/*.js` 要重启面板或机器人**（那是后端代码）；
  改本目录里的任何**资产**（`schema.js` / `app.js` / `style.css` / `index.html`）**不用重启**，刷新即可。
