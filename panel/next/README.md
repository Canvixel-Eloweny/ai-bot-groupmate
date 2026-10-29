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
| `schema.js` | **整页的唯一声明处**：7 个功能域 / 30 个页面（以 schema 为准）全是数据 | 加页面、加卡片、加控件、改文案 —— **只改这里** |
| `visual-factory.html` | 工厂 → 视觉工厂的整页工具（独立单文件，二级导航承载） | 改工厂源后 rebuild 覆盖；见「工厂域」 |
| `persona-factory.html` | 工厂 → 人设工厂的整页工具（独立单文件，二级导航承载） | 改 `persona-studio/` 源后跑 `scripts/build-persona-factory.mjs` |
| `persona-entry.css` | 工厂三帧的定位与 0.22s 切换入场 | 只动 `.factory-pane`，不要重写 `.factory-host` |
| `factory-frame.js` | 工厂帧控制器：三份常驻 iframe、按 `#page[data-frame]` 显隐 / 预热 | 改工厂帧的加载/切换行为时 |
| `cursor-follow.css` / `cursor-follow.js` | 全局光标跟随层：环 26.7px + 点 5.3px，点实时跟手、环弹簧拖尾并钳 9px；静止缩环、悬停只放大并加深中性描边（全程黑白）；三个工厂 iframe 由父层同源桥接管 | 改环/点尺寸、拖尾手感、降级或工厂桥时 |
| `app.js` | 渲染器 + 路由 + 反馈 + 接口表 | 只有"要加一种新控件类型"时才改（在 `RENDER` 表里加一个函数，并把名字登记进 `schema.js` 的 `CTRL_KINDS`） |
| `style.css` | 设计令牌与组件 | 改视觉（颜色/间距/圆角/字号只从顶部令牌里取） |
| `index.html` | 页面骨架（顶栏 / 两级导航 / 主体 / 保存条 / 设置层 / 反馈） | 改全局布局 |
| `settings.js` / `settings.css` | 左下角设置层：外观 / 启动 / 关于 / 数据 | 新增设置项或改设置层布局 |
| `demo-state.js` | 离线演示快照 | 一般不用动；它只在连不上后端时兜底 |
| `splash.js` | 首屏同步启动层：在样式表之前把主题/主题色/字体偏好写到 `<html>` | 新增首屏本地偏好时 |
| `verify.mjs` | **真实浏览器自检**（零依赖，走 CDP；页面遍历 + 工厂浮层检查） | 加了新页面后跑一次 |
| `README.md` | 本文件 | — |

> ⚠️ `README.md` 与 `verify.mjs` **故意不在可下发资产名单**（`panel/lib/next-page.js` 的 `NEXT_ASSETS`）里
> —— 文档与自检脚本没有理由出现在 HTTP 面上。`GET /README.md` 是 **404**。

## 左下角设置层（2026-10-23 · P2）

顶栏的主题/字体/背景入口已全部迁到左下角齿轮 → **设置**，顶栏只留一键启动/结束运行。
四个分区：

| 分区 | 内容 | 存储 |
|---|---|---|
| 外观 | 日/夜、9 套主题色、8 套背景与流速、sans/serif | `localStorage`（`next-theme` / `next-accent` / `next-font-style` / `qqbot-bgfx`） |
| 启动 | 打开方式、开机自启、自动拉起协议端、就绪后打开界面、关闭=驻留/退出 | `config.json` 的 `launch` 段（壳/启动器读同一份） |
| 关于 | 版本/运行时/桌面壳（来自 `/api/state.appMeta`）、检查更新、GitHub 外链 | 只读 |
| 数据 | 按范围导出（大小来自 `/api/custom/export?dry=1`）、完整包、诊断包 | 只读 |

- 主题色 9 套的浅/深令牌在 `style.css` 的 `html[data-accent=...]`；色板按钮复用同一组
  令牌，不手抄第二份色值。背景仍是 `shader-bg.js` 的 `VARIANTS` 唯一来源（默认海雾）。
- `splash.js` 在 `<head>` 同步应用主题/主题色/字体，避免首屏先画默认值再跳一下。
- 关于页的仓库地址来自程序根 `package.json` 的 `homepage`（`/api/state.appMeta.repo`）；
  意见箱只开 GitHub Issues 外链，不在面板收集内容、不上传。
- 壳层关闭行为的键是 `launch.closeAction`（`tray` 默认 / `quit`）；托盘不可用时，
  `tray` 自动退化为最小化。`launch.autoProtocol=false` 会同时跳过启动自起与进程守护。
- 设置层打开时背景页设 `inert`；层级：settings 76 / gear 78 / modal 80 / cursor 81，弹窗仍能盖住设置。
- 窄屏：≤860px 侧栏变顶部横条；≤700px 色板 4 列、≤600px 内容区仍可滚动。P2-4 在
  `test/panel-dom.mjs` 里按 1280×680 / 1024×728 / 800×560 / 600×440 四档真渲染并截图。

## 工厂域（2026-10-28：三个工厂 + 插件管理 / Skill · 二级导航承载）

一级「工厂」下有 **五个二级页**：前三个是完整工具（frame 页），后两个是普通卡片页。

| 二级页 | 承载 |
|---|---|
| 视觉工厂 | `visual-factory.html`（frame） |
| 人设工厂 | `persona-factory.html`（frame） |
| 插件工厂 | `plugin-factory.html`（frame） |
| 插件管理 | 普通卡片页（`schema.js` 的 plugins 页：启用 / 设置 / 上限 / ZIP） |
| Skill | 普通卡片页（`schema.js` 的 skill 页：启用 / 预览 / 设置 / ZIP） |

- `schema.js` 的 `factory.subs` 顺序为 visual → persona → plugin → plugins → skill；
  前三个 `frame` 页带 `frame: '<file>'`，后两个不带；点一级「工厂」默认落视觉工厂（`S.si = 0`）。
- 三份 iframe 由 `factory-frame.js` 常驻在 `#factoryHost`，只显隐不重建；切换时新帧做
  0.22s 上浮淡入（`.factory-pane.is-enter`），`prefers-reduced-motion` 下直接落位。
  普通页没有 `data-frame` 时，`factory-frame.js` 会把三份 pane 全隐藏，不会留下 iframe 残影。
- **唯一选帧来源是 `#page[data-frame]`**：`paintPage()` 按当前 schema 子页写入/清除；
  3 秒轮询同值不写，所以不重播入场。`body.is-frame-page` 控制工厂层的显隐与页脚隐藏。
- 工厂层保持原来的全屏位置（`top: var(--h-topbar)`，铺满左右下），z-index 39；
  两级导航(40) / 顶栏(42) / 设置齿轮(79) 都在它上面。`body.is-frame-page .navrow`
  让出 pointer-events、只让 `.nav-dock-wrap` 收事件，导航因此可点、导航外空白不挡工厂。
- **预热策略**：视觉工厂仍在面板空闲时预热；人设/插件在二级页签 hover/focus
  或真正切页时装载，避免和首屏动效抢帧。
- 三个工厂都走**独立外观**（不设 `data-embed`），厂内品牌与 appbar 可见。
- 人设工厂的源在 `panel/next/persona-studio/`，改完跑 `node scripts/build-persona-factory.mjs`；
  产物 `persona-factory.html` 与 `panel/next/README.md` 一起登记进 `NEXT_ASSETS`。
- 已知视觉重叠：工厂自带顶栏会被导航遮住约 89px；按维护者要求本轮保留，
  后续单独处理（门禁只保证导航可点与页面功能可用）。
- **导航自动上收（2026-10-27）**：进入工厂、过场与 dock 停稳后，两级导航向上滑出并隐藏；
  鼠标移到顶部居中热区（`#navHotzone`，固定 150×30、紧贴玻璃顶栏 +4px，中间一个小三角）呼出；
  离开导航 2.5s 再收。尺寸用 CSS 像素，不随窗口缩放，严格小范围避免误触。
  离开工厂域立刻复位为常显。隐藏态 `navrow.inert` + `visibility:hidden`，键盘可用热区按钮呼出；
  设置层打开时热区与 nav 一起 inert。
- `test/panel-dom.mjs` 专钉：三 frame + 插件管理 / Skill 两个普通页、顶栏无圆钮、host 几何/层级、
  二级按钮与工厂都可点、3.6s 不重载不重播、切帧不重载、离开收起、重进保留；
  另钉自动上收 / 热区呼出 / 2.5s 再收 / 离开复位。普通页上导航常显（只有 frame 页会自动上收）。
  `panel/next/verify.mjs` 另有同一组断言；`§165`/`§166` 静态契约 + 两套变异兜底。

## 动效能力层（2026-10-02 · UI 升级轮）

| 文件 | 作用 |
|---|---|
| `motion.js` | 动效引擎。零依赖的 `framer-motion` 替身：运动值 / 弹簧 / 速度 / 派生变换。**语义与 framer-motion 对齐**，所以外部配方能原样搬 |
| `liquid-toggle.js` | 液态开关（双 blob metaball）。演示六条判据，见 `docs/MOTION-METHODOLOGY.md` |
| `liquid-toggle.css` | 上面两者的样式。**配色只从令牌来**，不写死色值 |
| `cursor-follow.js` / `cursor-follow.css` | 全局光标跟随层（2026-10-28）：点实时跟手、环弹簧拖尾并钳 9px、静止缩环、悬停只放大保持黑白；工厂 iframe 由 `factory-frame.js` 的 `attachFrame` 同源桥接管。动效用 `M.springStep` + 本地单 rAF，静止即归还时钟 |
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

## 顶栏 HUD 信息岛（2026-10-23，2026-10-26 全量复刻原型动效核）

| 文件 | 作用 |
|---|---|
| `island.js` | 顶栏状态岛：入场（1320/620ms，Welcome 擦入 + 遮罩交接）、信息项轮播、数字滚轮（31 格 / 420ms÷倍速 / 方向感知 / 结构复用）、full·handoff·quick·birth 四套时间轴、打断融合（captureInterrupt + blendTo）、标题 lockup（画布量宽）、五段读数 stagger、灰圈与环形入场。只依赖 `icons.js` 的 `Icons.icon` |
| `island.css` | 岛与弹层样式。玻璃材质跟随主题自动切换，另有 HUD 白 / HUD 黑两种固定底；配色只从令牌来；滚轮定宽 ghost + 上下软遮罩；切换期间禁用弧长的 CSS 过渡 |
| 设置入口 | 「维护 → HUD调整」：8 卡 / 28 滑块 / 5 分段 / 8 读数 —— 轮播项与顺序、间隔、倍速、材质、强调色、字体、灰圈、密度、几何比例（含标题圆角）、时间轴偏移、冻结/seek、重播出生/入场/切换、导出与恢复默认。默认 380×38，设置存本机 `localStorage['next-hud-island-v1']` |
| 时间轴语义 | 7 个时间轴滑块是**相对原型 T 表的偏移**：0 = 原型基准（full 1500 / handoff 1440 / quick 1000 / birth 1400），总时长 clamp 900–2400ms；旧版绝对值配置首次升级会自动归零 |
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
          .sub × N  通常短标签；persona 六页用全称
```

### 尺寸与宽度
- 一级 = 一级内容 + 16；7 个域 + 计数实测宽度以真机为准（1440），左字到胶囊边约 30px。
- 二级 = 二级内容 + 8；**没有 300px 下限**：运行 2 页签 126、发言 6 页签 277（1300+）；
  390 宽下 142 / 250（被 dock 宽度夹住）。实测见 `test/panel-dom.mjs` 的 8 档宽度断言。
- 短标签在 `schema.js` 的 `NAV_SHORT`；**persona 故意不登记**（六页用 schema 全称，与桌面原型一致）。完整名保留在 `title` / `aria-label` 与页面头。
- 切换域时 `layoutNavDock(true)` 用 380ms 过渡；`scrollNav2To()` 把选中页签带进窄条。
- dock 几何（`--h-nav*` / `--nav-*`）按 resize 记忆化，换域那一帧不再重复读 5 个
  `getComputedStyle`；行宽**不缓存**（滚动条出现会改 `.navrow` 宽而不改 `innerWidth`）。

### 切换时序（2026-10-26 / 2026-10-28）
- **同域二级切换**：只同步选中态（`syncNav2Selection`），不重建 nav1/nav2、不重启动 dock 动画。
- **换域**：nav1/nav2 与 dock 宽度动画走导航自己的时间线；页面内容双 rAF 后才落，
  3 秒轮询撞上排队时让路（`pagePaintPending` / `pagePaintSeq`）。
- **人设域的总览分段**：换域进入时先落「壳」——卡框、文案、图例、页眉全在，
  只把雷达/环形/柱/折线的 **载荷**留空（`data-psn-slot`，高度按 viewBox 的
  `aspect-ratio` 预留，落图前后逐像素同高）。等 dock 停稳（`navDockSettled` 回调，
  900ms 兜底）再回填载荷、同一刻撤掉 `#page.psn-stage`（它按住 `.psn` 下所有入场动画）
  并挂 `psn-armed`。同域二级切换与轮询不走分段。
- `S.extra.psnHtml` **只存完整趟**：轮询的逐字比较必须与 DOM 一致，否则每 3 秒重播入场。
  待回填的载荷放在 `psnChartSlots`，轮询命中 skip-redraw 时**不许**把它冲掉。
- 页级入场 `psn-page-in` **不许**带 `filter:blur(3px)`：祖先 blur 会让 10 张
  `backdrop-filter` 卡逐帧重新光栅化（换域卡顿的成因之一，§162 反向钉住）。

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
node panel/next/verify.mjs      # 完整断言 + 3 张截图 → /tmp/next-verify/
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
